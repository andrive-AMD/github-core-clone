// The MCP endpoint: streamable HTTP carrying JSON-RPC 2.0. Discovery answers the modern era
// (server/discover with supportedVersions), tools/list is a fixed catalogue, and tools/call runs
// the six canonical GitHub tools against the same store the REST surface serves — so an object
// created here is the same object REST reads, with the same ids.

import { VIEWER } from './scenario.ts';
import { forge, type RepoRec } from './store.ts';
import { issueJson, mergePull, pullJson, repoJson } from './domain.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpOutcome {
  status: number;
  body: unknown;
  /** True when the response is intentionally empty (a notification acknowledgement). */
  empty?: boolean;
}

function rpcError(id: unknown, code: number, message: string): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function toolSuccess(id: unknown, value: unknown): McpOutcome {
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  });
}

function toolFailure(id: unknown, message: string): McpOutcome {
  return rpcResult(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function repoArg(args: Record<string, unknown>): RepoRec | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return forge.repo(owner, repo);
}

function callTool(id: unknown, name: string, args: Record<string, unknown>): McpOutcome {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return rpcError(id, -32602, `Tool ${name} not found`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null) {
      return rpcError(id, -32602, `Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.repo(VIEWER.login, repoName) !== null) return toolFailure(id, `repository ${repoName} already exists`);
      const rec = forge.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
        'main',
      );
      return toolSuccess(id, repoJson(rec));
    }
    case 'get_repo': {
      const rec = repoArg(args);
      if (rec === null) return toolFailure(id, 'repository not found');
      return toolSuccess(id, repoJson(rec));
    }
    case 'create_issue': {
      const rec = repoArg(args);
      if (rec === null) return toolFailure(id, 'repository not found');
      const number = rec.nextNumber;
      rec.nextNumber += 1;
      const issue = {
        id: forge.nextIssueId(),
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [],
      };
      rec.issues.set(number, issue);
      return toolSuccess(id, issueJson(rec, issue));
    }
    case 'list_issues': {
      const rec = repoArg(args);
      if (rec === null) return toolFailure(id, 'repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...rec.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return toolSuccess(id, issues.map((issue) => issueJson(rec, issue)));
    }
    case 'create_pull_request': {
      const rec = repoArg(args);
      if (rec === null) return toolFailure(id, 'repository not found');
      const head = String(args.head).split(':').pop() as string;
      const base = String(args.base).split(':').pop() as string;
      const headTip = forge.branchTip(rec, head);
      const baseTip = forge.branchTip(rec, base);
      if (headTip === null || baseTip === null) return toolFailure(id, 'head or base branch does not exist');
      if (headTip === baseTip) return toolFailure(id, 'No commits between base and head');
      const number = rec.nextNumber;
      rec.nextNumber += 1;
      const pull = {
        id: forge.nextPullId(),
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      rec.pulls.set(number, pull);
      return toolSuccess(id, pullJson(rec, pull));
    }
    case 'merge_pull_request': {
      const rec = repoArg(args);
      if (rec === null) return toolFailure(id, 'repository not found');
      const pull = rec.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolFailure(id, 'pull request not found');
      const outcome = mergePull(rec, pull, 'squash');
      if (!outcome.ok) return toolFailure(id, `merge failed: ${outcome.reason}`);
      return toolSuccess(id, pullJson(rec, pull));
    }
    default:
      return rpcError(id, -32602, `Tool ${name} not found`);
  }
}

/**
 * Handle one MCP HTTP request body. Returns the HTTP status and JSON body to answer with;
 * a non-JSON body is the protocol's parse error (-32700) at HTTP 400.
 */
export function handleMcp(rawBody: Buffer): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  if (id === undefined) {
    // A notification: acknowledged with an empty 202, never a body.
    return { status: 202, body: null, empty: true };
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const params = typeof request.params === 'object' && request.params !== null ? (request.params as Record<string, unknown>) : {};
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const legacy = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
      return rpcResult(id, {
        protocolVersion: legacy.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = typeof request.params === 'object' && request.params !== null ? (request.params as Record<string, unknown>) : {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};
      return callTool(id, name, args);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
