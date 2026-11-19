// The REST v3 surface: the API root and meta, the viewer, repositories, branches, git refs,
// commits, contents, labels, issues with comments, and pull requests with their file diffs and
// merges. Every answer is JSON with a request id; every error is GitHub's {"message": ...} body.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  objectId, parseCommit, parseTree,
} from './git.ts';
import { forge, type RepoRec } from './store.ts';
import {
  commentJson, issueJson, labelJson, mergePull, pullFiles, pullJson, repoJson,
} from './domain.ts';

let requestSeq = 0;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  requestSeq += 1;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `FORGE-${requestSeq.toString(16).toUpperCase().padStart(6, '0')}`,
    ...headers,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse): void {
  requestSeq += 1;
  res.writeHead(204, { 'x-github-request-id': `FORGE-${requestSeq.toString(16).toUpperCase().padStart(6, '0')}` });
  res.end();
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, each percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyMalformed: boolean;
  rawBody: Buffer;
  host: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function pagination(query: URLSearchParams): { page: number; perPage: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { page, perPage };
}

/** Slice a list for one page and set the Link header when more pages follow. */
function paginate<T>(res: ServerResponse, req: RestRequest, path: string, items: readonly T[]): T[] {
  const { page, perPage } = pagination(req.query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  if (page < totalPages) {
    const base = `http://${req.host}${path}`;
    const next = `${base}?page=${page + 1}&per_page=${perPage}`;
    const last = `${base}?page=${totalPages}&per_page=${perPage}`;
    res.setHeader('link', `<${next}>; rel="next", <${last}>; rel="last"`);
  }
  return slice;
}

/** Resolve a ref-ish value (branch name, tag name, full ref, or sha) to a commit oid. */
export function resolveCommit(rec: RepoRec, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') {
    return forge.headTip(rec);
  }
  const candidates = [
    ref,
    `refs/heads/${ref}`,
    `refs/tags/${ref}`,
    ref.startsWith('refs/') ? ref : '',
  ];
  for (const candidate of candidates) {
    if (candidate === '') continue;
    const oid = rec.refs.get(candidate);
    if (oid !== undefined) {
      // Peel tags to the commit they name.
      let current = oid;
      for (let depth = 0; depth < 8; depth += 1) {
        const object = rec.objects.get(current);
        if (object === undefined) return null;
        if (object.type === 'commit') return current;
        if (object.type !== 'tag') return null;
        const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
        if (match === null) return null;
        current = match[1] as string;
      }
      return null;
    }
  }
  const object = rec.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  if (object !== undefined && object.type === 'tag') {
    const peeled = resolveCommit(rec, object.data.toString('utf8').match(/^object ([0-9a-f]{40})/m)?.[1] ?? '');
    return peeled;
  }
  return null;
}

/** Walk a commit's tree to the entry at `path` ('' is the root). */
function treeEntryAt(rec: RepoRec, commitOid: string, path: string): { type: 'file' | 'dir'; oid: string; mode: string } | null {
  const commitObject = rec.objects.get(commitOid);
  if (commitObject === undefined || commitObject.type !== 'commit') return null;
  let treeOid = parseCommit(commitObject.data).tree;
  if (path === '') return { type: 'dir', oid: treeOid, mode: '40000' };
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const tree = rec.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) {
      return entry.mode === '40000'
        ? { type: 'dir', oid: entry.oid, mode: entry.mode }
        : { type: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

// ---------------------------------------------------------------- route handlers

function handleRoot(res: ServerResponse): void {
  sendJson(res, 200, {
    current_user_url: '/api/v3/user',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    rate_limit_url: '/api/v3/rate_limit',
  }, { 'x-oauth-scopes': 'repo, read:org' });
}

function handleMeta(res: ServerResponse): void {
  sendJson(res, 200, {
    installed_version: '1.0.0',
    hooks_address: '127.0.0.1',
    importer_address: '127.0.0.1',
    github_address: '127.0.0.1',
  });
}

function handleUser(res: ServerResponse): void {
  sendJson(res, 200, {
    login: VIEWER.login,
    id: VIEWER.id,
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
  });
}

const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function handleCreateRepo(req: RestRequest, res: ServerResponse): void {
  const body = asRecord(req.body);
  const name = stringField(body, 'name');
  if (name === undefined || name === '' || !REPO_NAME_PATTERN.test(name) || name === '.' || name === '..') {
    unprocessable(res, 'name is invalid');
    return;
  }
  if (forge.repo(VIEWER.login, name) !== null) {
    unprocessable(res, 'name already exists on this account');
    return;
  }
  const description = stringField(body, 'description') ?? '';
  const isPrivate = body.private === true;
  const defaultBranch = stringField(body, 'default_branch') ?? 'main';
  const rec = forge.createRepo(name, description, isPrivate, defaultBranch);
  // auto_init is not part of the suite, but a caller asking for it gets a born default branch.
  if (body.auto_init === true) {
    const tree = forge.putObject(rec, 'tree', Buffer.alloc(0));
    const commit = forge.authorCommit(rec, tree, [], 'Initial commit');
    rec.refs.set(`refs/heads/${rec.defaultBranch}`, commit);
  }
  sendJson(res, 201, repoJson(rec));
}

function handleListUserRepos(req: RestRequest, res: ServerResponse): void {
  const all = forge.viewerRepos().map((rec) => repoJson(rec));
  const page = paginate(res, req, '/api/v3/user/repos', all);
  sendJson(res, 200, page);
}

function withRepo(req: RestRequest, res: ServerResponse, fn: (rec: RepoRec) => void): void {
  const owner = req.segments[1] as string;
  const name = req.segments[2] as string;
  const rec = forge.repo(owner, name);
  if (rec === null) { notFound(res); return; }
  fn(rec);
}

function handleGetRepo(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => sendJson(res, 200, repoJson(rec)));
}

function handlePatchRepo(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const body = asRecord(req.body);
    const description = stringField(body, 'description');
    if (description !== undefined) rec.description = description;
    const newName = stringField(body, 'name');
    if (newName !== undefined && newName !== rec.name && REPO_NAME_PATTERN.test(newName)) {
      forge.deleteRepo(rec);
      rec.name = newName;
      forge.repos.set(`${rec.owner}/${rec.name}`, rec);
    }
    if (typeof body.private === 'boolean') rec.isPrivate = body.private;
    const defaultBranch = stringField(body, 'default_branch');
    if (defaultBranch !== undefined && defaultBranch !== '') rec.defaultBranch = defaultBranch;
    sendJson(res, 200, repoJson(rec));
  });
}

function handleDeleteRepo(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    forge.deleteRepo(rec);
    sendNoContent(res);
  });
}

function handleListBranches(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const branches: Array<Record<string, unknown>> = [];
    for (const [ref, oid] of rec.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    branches.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
    sendJson(res, 200, branches);
  });
}

function handleGetBranch(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const branch = req.segments.slice(4).join('/');
    const tip = forge.branchTip(rec, branch);
    if (tip === null) { notFound(res); return; }
    sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
  });
}

function handleCreateRef(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const body = asRecord(req.body);
    const ref = stringField(body, 'ref');
    const sha = stringField(body, 'sha');
    if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
      unprocessable(res, 'ref and sha are required');
      return;
    }
    if (!rec.objects.has(sha)) {
      unprocessable(res, 'sha does not name an object in this repository');
      return;
    }
    if (rec.refs.has(ref)) {
      unprocessable(res, 'Reference already exists');
      return;
    }
    rec.refs.set(ref, sha);
    const object = rec.objects.get(sha);
    sendJson(res, 201, { ref, object: { sha, type: object?.type ?? 'commit' } });
  });
}

function handleGetRef(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const rest = req.segments.slice(5).join('/');
    const ref = rest.startsWith('refs/') ? rest : `refs/${rest}`;
    const oid = rec.refs.get(ref);
    if (oid === undefined) { notFound(res); return; }
    const object = rec.objects.get(oid);
    sendJson(res, 200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
  });
}

function commitJson(rec: RepoRec, oid: string): Record<string, unknown> {
  const object = rec.objects.get(oid);
  const commit = object !== undefined && object.type === 'commit'
    ? parseCommit(object.data)
    : { tree: '', parents: [] as readonly string[], authorLine: '', committerLine: '', message: '', authorTime: 0 };
  const identity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: '', email: '', date: '2025-01-01T00:00:00Z' };
    return {
      name: match[1] as string,
      email: match[2] as string,
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  };
  return {
    sha: oid,
    commit: {
      author: identity(commit.authorLine),
      committer: identity(commit.committerLine),
      message: commit.message,
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER.login },
    committer: { login: VIEWER.login },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function handleListCommits(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const start = resolveCommit(rec, req.query.get('sha'));
    if (start === null) { sendJson(res, 200, []); return; }
    // Newest first: a breadth walk by generation, first parents before side branches.
    const order: string[] = [];
    const seen = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = [{ oid: start, depth: 0 }];
    const staged: Array<{ oid: string; depth: number; seq: number }> = [];
    let seq = 0;
    while (queue.length > 0) {
      const { oid, depth } = queue.shift() as { oid: string; depth: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      staged.push({ oid, depth, seq });
      seq += 1;
      const object = rec.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
    }
    staged.sort((a, b) => (a.depth - b.depth) || (a.seq - b.seq));
    for (const entry of staged) order.push(entry.oid);
    const all = order.map((oid) => commitJson(rec, oid));
    sendJson(res, 200, paginate(res, req, `/api/v3/repos/${rec.owner}/${rec.name}/commits`, all));
  });
}

// ---------------------------------------------------------------- contents

function handleGetContents(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const path = req.segments.slice(4).join('/');
    const commit = resolveCommit(rec, req.query.get('ref'));
    if (commit === null) { notFound(res); return; }
    const entry = treeEntryAt(rec, commit, path);
    if (entry === null) { notFound(res); return; }
    if (entry.type === 'file') {
      const object = rec.objects.get(entry.oid);
      const data = object !== undefined && object.type === 'blob' ? object.data : Buffer.alloc(0);
      const name = path.split('/').pop() as string;
      sendJson(res, 200, {
        type: 'file',
        name,
        path,
        sha: entry.oid,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      });
      return;
    }
    const tree = rec.objects.get(entry.oid);
    if (tree === undefined || tree.type !== 'tree') { notFound(res); return; }
    const entries = parseTree(tree.data).map((child) => {
      const childPath = path === '' ? child.name : `${path}/${child.name}`;
      const childObject = rec.objects.get(child.oid);
      return {
        type: child.mode === '40000' ? 'dir' : 'file',
        name: child.name,
        path: childPath,
        sha: child.oid,
        size: child.mode === '40000' ? 0 : (childObject !== undefined && childObject.type === 'blob' ? childObject.data.length : 0),
      };
    });
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    sendJson(res, 200, entries);
  });
}

function handlePutContents(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const path = req.segments.slice(4).join('/');
    if (path === '') { unprocessable(res, 'path is required'); return; }
    const body = asRecord(req.body);
    const message = stringField(body, 'message') ?? '';
    const content64 = stringField(body, 'content');
    if (content64 === undefined) { unprocessable(res, 'content is required'); return; }
    const content = Buffer.from(content64.replace(/\s+/g, ''), 'base64');
    const branch = stringField(body, 'branch') ?? rec.defaultBranch;
    const tip = forge.branchTip(rec, branch) ?? forge.headTip(rec);
    const existing = tip === null ? null : treeEntryAt(rec, tip, path);
    const suppliedSha = stringField(body, 'sha');
    if (existing !== null && existing.type === 'dir') {
      unprocessable(res, 'a directory exists at this path');
      return;
    }
    if (existing !== null) {
      if (suppliedSha === undefined) {
        unprocessable(res, 'sha is required to update an existing file');
        return;
      }
      if (suppliedSha !== existing.oid) {
        sendJson(res, 409, { message: 'sha does not match the current file' });
        return;
      }
    } else if (suppliedSha !== undefined) {
      notFound(res);
      return;
    }
    const commit = forge.commitFileChange(rec, branch, path, content, message);
    const blobOid = objectId('blob', content);
    sendJson(res, existing !== null ? 200 : 201, {
      content: {
        type: 'file',
        name: path.split('/').pop() as string,
        path,
        sha: blobOid,
        size: content.length,
        encoding: 'base64',
      },
      commit: { sha: commit },
    });
  });
}

function handleDeleteContents(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const path = req.segments.slice(4).join('/');
    const body = asRecord(req.body);
    const message = stringField(body, 'message') ?? '';
    const branch = stringField(body, 'branch') ?? rec.defaultBranch;
    const tip = forge.branchTip(rec, branch);
    if (tip === null) { notFound(res); return; }
    const existing = treeEntryAt(rec, tip, path);
    if (existing === null || existing.type !== 'file') { notFound(res); return; }
    const suppliedSha = stringField(body, 'sha');
    if (suppliedSha !== undefined && suppliedSha !== existing.oid) {
      sendJson(res, 409, { message: 'sha does not match the current file' });
      return;
    }
    const commit = forge.commitFileChange(rec, branch, path, null, message);
    sendJson(res, 200, { content: null, commit: { sha: commit } });
  });
}

// ---------------------------------------------------------------- labels and issues

function handleCreateLabel(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const body = asRecord(req.body);
    const name = stringField(body, 'name');
    if (name === undefined || name === '') { unprocessable(res, 'name is required'); return; }
    if (rec.labels.has(name)) { unprocessable(res, 'name already exists'); return; }
    const color = (stringField(body, 'color') ?? '000000').replace(/^#/, '');
    const description = stringField(body, 'description') ?? null;
    rec.labels.set(name, { name, color, description });
    sendJson(res, 201, labelJson(rec, name));
  });
}

function handleListLabels(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    sendJson(res, 200, [...rec.labels.keys()].map((name) => labelJson(rec, name)));
  });
}

function parseLabelNames(body: Record<string, unknown>): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string') {
      names.push((item as Record<string, unknown>).name as string);
    } else return null;
  }
  return names;
}

function handleCreateIssue(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const body = asRecord(req.body);
    const title = stringField(body, 'title');
    if (title === undefined) { unprocessable(res, 'title is required'); return; }
    const labels = parseLabelNames(body);
    if (labels === null) { unprocessable(res, 'labels are invalid'); return; }
    for (const name of labels) {
      if (!rec.labels.has(name)) { unprocessable(res, `label '${name}' does not exist`); return; }
    }
    const number = rec.nextNumber;
    rec.nextNumber += 1;
    const issue = {
      id: forge.nextIssueId(),
      number,
      title,
      body: stringField(body, 'body') ?? '',
      state: 'open' as const,
      labels,
      comments: [],
    };
    rec.issues.set(number, issue);
    sendJson(res, 201, issueJson(rec, issue));
  });
}

function handleListIssues(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const state = req.query.get('state') ?? 'open';
    let issues = [...rec.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    const sort = req.query.get('sort') ?? 'created';
    const direction = req.query.get('direction') ?? 'desc';
    if (sort === 'created') {
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    }
    const all = issues.map((issue) => issueJson(rec, issue));
    sendJson(res, 200, paginate(res, req, `/api/v3/repos/${rec.owner}/${rec.name}/issues`, all));
  });
}

function handleGetIssue(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const number = Number(req.segments[4]);
    const issue = rec.issues.get(number);
    if (issue === undefined) { notFound(res); return; }
    sendJson(res, 200, issueJson(rec, issue));
  });
}

function handlePatchIssue(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const number = Number(req.segments[4]);
    const issue = rec.issues.get(number);
    if (issue === undefined) { notFound(res); return; }
    const body = asRecord(req.body);
    const state = stringField(body, 'state');
    if (state === 'open' || state === 'closed') issue.state = state;
    const title = stringField(body, 'title');
    if (title !== undefined) issue.title = title;
    const text = stringField(body, 'body');
    if (text !== undefined) issue.body = text;
    if (body.labels !== undefined) {
      const labels = parseLabelNames(body);
      if (labels === null) { unprocessable(res, 'labels are invalid'); return; }
      for (const name of labels) {
        if (!rec.labels.has(name)) { unprocessable(res, `label '${name}' does not exist`); return; }
      }
      issue.labels = labels;
    }
    sendJson(res, 200, issueJson(rec, issue));
  });
}

function handleCreateComment(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const number = Number(req.segments[4]);
    const issue = rec.issues.get(number);
    if (issue === undefined) { notFound(res); return; }
    const body = asRecord(req.body);
    const text = stringField(body, 'body');
    if (text === undefined) { unprocessable(res, 'body is required'); return; }
    const comment = { id: forge.nextCommentId(), body: text, issueNumber: number };
    issue.comments.push(comment);
    sendJson(res, 201, commentJson(rec, comment));
  });
}

function handleListComments(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const number = Number(req.segments[4]);
    const issue = rec.issues.get(number);
    if (issue === undefined) { notFound(res); return; }
    sendJson(res, 200, issue.comments.map((comment) => commentJson(rec, comment)));
  });
}

// ---------------------------------------------------------------- pull requests

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function handleCreatePull(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const body = asRecord(req.body);
    const title = stringField(body, 'title');
    const headRaw = stringField(body, 'head');
    const baseRaw = stringField(body, 'base');
    if (title === undefined || headRaw === undefined || baseRaw === undefined) {
      unprocessable(res, 'title, head and base are required');
      return;
    }
    const head = stripOwnerPrefix(headRaw);
    const base = stripOwnerPrefix(baseRaw);
    const headTip = forge.branchTip(rec, head);
    const baseTip = forge.branchTip(rec, base);
    if (headTip === null || baseTip === null) {
      unprocessable(res, 'head or base branch does not exist');
      return;
    }
    if (headTip === baseTip) {
      unprocessable(res, 'No commits between base and head');
      return;
    }
    for (const pull of rec.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
        unprocessable(res, 'A pull request already exists for this branch');
        return;
      }
    }
    const number = rec.nextNumber;
    rec.nextNumber += 1;
    const pull = {
      id: forge.nextPullId(),
      number,
      title,
      body: stringField(body, 'body') ?? '',
      state: 'open' as const,
      headRef: head,
      baseRef: base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    rec.pulls.set(number, pull);
    sendJson(res, 201, pullJson(rec, pull));
  });
}

function handleListPulls(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const state = req.query.get('state') ?? 'open';
    let pulls = [...rec.pulls.values()];
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    pulls.sort((a, b) => a.number - b.number);
    const all = pulls.map((pull) => pullJson(rec, pull));
    sendJson(res, 200, paginate(res, req, `/api/v3/repos/${rec.owner}/${rec.name}/pulls`, all));
  });
}

function handleGetPull(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const number = Number(req.segments[4]);
    const pull = rec.pulls.get(number);
    if (pull === undefined) { notFound(res); return; }
    sendJson(res, 200, pullJson(rec, pull));
  });
}

function handlePullFiles(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const number = Number(req.segments[4]);
    const pull = rec.pulls.get(number);
    if (pull === undefined) { notFound(res); return; }
    const files = pullFiles(rec, pull).map((change) => ({
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
    }));
    sendJson(res, 200, files);
  });
}

function handleMergePull(req: RestRequest, res: ServerResponse): void {
  withRepo(req, res, (rec) => {
    const number = Number(req.segments[4]);
    const pull = rec.pulls.get(number);
    if (pull === undefined) { notFound(res); return; }
    const body = asRecord(req.body);
    const method = stringField(body, 'merge_method') ?? 'merge';
    const outcome = mergePull(rec, pull, method === 'squash' ? 'squash' : 'merge');
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') {
        sendJson(res, 405, { message: 'Pull Request is not mergeable: merge conflict' });
      } else if (outcome.reason === 'already-merged') {
        sendJson(res, 405, { message: 'Pull Request has already been merged' });
      } else {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      }
      return;
    }
    sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  });
}

// ---------------------------------------------------------------- dispatch

/** Route one REST request. `path` is the full pathname (starting /api/v3). */
export function handleRest(req: RestRequest, res: ServerResponse, path: string): void {
  if (req.bodyMalformed) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const seg = req.segments;
  const method = req.method;
  if (seg.length === 0) {
    if (method === 'GET') { handleRoot(res); return; }
    notFound(res);
    return;
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method === 'GET') { handleMeta(res); return; }
    notFound(res);
    return;
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method === 'GET') { handleUser(res); return; }
    notFound(res);
    return;
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'POST') { handleCreateRepo(req, res); return; }
    if (method === 'GET') { handleListUserRepos(req, res); return; }
    notFound(res);
    return;
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const resource = seg[3];
    if (seg.length === 3) {
      if (method === 'GET') { handleGetRepo(req, res); return; }
      if (method === 'PATCH') { handlePatchRepo(req, res); return; }
      if (method === 'DELETE') { handleDeleteRepo(req, res); return; }
      notFound(res);
      return;
    }
    if (resource === 'branches' && seg.length === 4 && method === 'GET') { handleListBranches(req, res); return; }
    if (resource === 'branches' && seg.length >= 5 && method === 'GET') { handleGetBranch(req, res); return; }
    if (resource === 'git' && seg[4] === 'refs' && seg.length === 5 && method === 'POST') { handleCreateRef(req, res); return; }
    if (resource === 'git' && seg[4] === 'refs' && seg.length >= 6 && method === 'GET') { handleGetRef(req, res); return; }
    if (resource === 'commits' && seg.length === 4 && method === 'GET') { handleListCommits(req, res); return; }
    if (resource === 'contents' && seg.length >= 4) {
      if (method === 'GET') { handleGetContents(req, res); return; }
      if (method === 'PUT') { handlePutContents(req, res); return; }
      if (method === 'DELETE') { handleDeleteContents(req, res); return; }
      notFound(res);
      return;
    }
    if (resource === 'labels' && seg.length === 4) {
      if (method === 'POST') { handleCreateLabel(req, res); return; }
      if (method === 'GET') { handleListLabels(req, res); return; }
      notFound(res);
      return;
    }
    if (resource === 'issues' && seg.length === 4) {
      if (method === 'POST') { handleCreateIssue(req, res); return; }
      if (method === 'GET') { handleListIssues(req, res); return; }
      notFound(res);
      return;
    }
    if (resource === 'issues' && seg.length === 5) {
      if (method === 'GET') { handleGetIssue(req, res); return; }
      if (method === 'PATCH') { handlePatchIssue(req, res); return; }
      notFound(res);
      return;
    }
    if (resource === 'issues' && seg.length === 6 && seg[5] === 'comments') {
      if (method === 'POST') { handleCreateComment(req, res); return; }
      if (method === 'GET') { handleListComments(req, res); return; }
      notFound(res);
      return;
    }
    if (resource === 'pulls' && seg.length === 4) {
      if (method === 'POST') { handleCreatePull(req, res); return; }
      if (method === 'GET') { handleListPulls(req, res); return; }
      notFound(res);
      return;
    }
    if (resource === 'pulls' && seg.length === 5) {
      if (method === 'GET') { handleGetPull(req, res); return; }
      notFound(res);
      return;
    }
    if (resource === 'pulls' && seg.length === 6 && seg[5] === 'files' && method === 'GET') { handlePullFiles(req, res); return; }
    if (resource === 'pulls' && seg.length === 6 && seg[5] === 'merge' && method === 'PUT') { handleMergePull(req, res); return; }
    notFound(res);
    return;
  }
  void path;
  notFound(res);
}
