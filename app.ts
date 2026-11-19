// The forge's HTTP surface, wired together: the health probe, git smart HTTP, REST v3, GraphQL
// v4 and the MCP endpoint, all behind the one bearer token the harness hands the entry. app.ts is
// the server; main.ts (the starter's, unchanged) owns the entry <-> env lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { forge } from './store.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleRest, sendJson, type RestRequest } from './rest.ts';
import { executeGraphQL, type GraphQLRequest } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The token every API call must carry. Unset means a local run: auth is then disabled. */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authorized(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer ${EXPECTED_TOKEN}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;

  // The env's boot check: no token, always available.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const owner = decodeSegment(gitMatch[1] as string);
    const name = decodeSegment(gitMatch[2] as string);
    const rec = forge.repo(owner, name);
    if (rec === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const endpoint = gitMatch[3] as string;
    if (endpoint === 'info/refs' && method === 'GET') {
      infoRefs(req, res, rec, url.searchParams.get('service'));
      return;
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      uploadPack(res, rec, await readBody(req));
      return;
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      receivePack(res, rec, await readBody(req));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    let body: unknown = {};
    let bodyMalformed = false;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        bodyMalformed = true;
      }
    }
    const restRequest: RestRequest = {
      method,
      segments: path === '/api/v3' || path === '/api/v3/' ? [] : path.slice('/api/v3/'.length).split('/').map(decodeSegment),
      query: url.searchParams,
      body,
      bodyMalformed,
      rawBody,
      host: req.headers.host ?? 'forge.invalid',
    };
    handleRest(restRequest, res, path);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const rawBody = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((item) => executeGraphQL((item ?? {}) as GraphQLRequest));
      const text = `${JSON.stringify(results)}\n`;
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
      res.end(text);
      return;
    }
    const envelope = executeGraphQL((parsed ?? {}) as GraphQLRequest);
    const text = `${JSON.stringify(envelope)}\n`;
    res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    if (method === 'POST') {
      const rawBody = await readBody(req);
      const outcome = handleMcp(rawBody);
      if (outcome.empty === true) {
        res.writeHead(202);
        res.end();
        return;
      }
      const text = `${JSON.stringify(outcome.body)}\n`;
      res.writeHead(outcome.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
      res.end(text);
      return;
    }
    if (method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  // Everything else is GitHub's 404.
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}
