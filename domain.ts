// Shared domain logic the REST, GraphQL and MCP surfaces all speak in: object serializers (one
// shape everywhere, so ids agree across surfaces), the pull-request file diff, and merging.

import { VIEWER } from './scenario.ts';
import {
  buildTreeFromFlat, flattenTree, isAncestor, mergeBase, parseCommit,
} from './git.ts';
import { forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';

// ---------------------------------------------------------------- serializers

export function repoJson(rec: RepoRec): Record<string, unknown> {
  return {
    id: rec.dbId,
    name: rec.name,
    full_name: `${rec.owner}/${rec.name}`,
    owner: { login: rec.owner, id: VIEWER.id, type: 'User' },
    private: rec.isPrivate,
    description: rec.description,
    default_branch: rec.defaultBranch,
    html_url: `https://forge.invalid/${rec.owner}/${rec.name}`,
    clone_url: `https://forge.invalid/${rec.owner}/${rec.name}.git`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function labelJson(rec: RepoRec, name: string): Record<string, unknown> {
  const label = rec.labels.get(name);
  return { name, color: label?.color ?? '000000', description: label?.description ?? null };
}

export function issueJson(rec: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(rec, name)),
    comments: issue.comments.length,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function commentJson(rec: RepoRec, comment: { id: number; body: string }): Record<string, unknown> {
  void rec;
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function pullJson(rec: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = forge.branchTip(rec, pull.headRef);
  const baseSha = forge.branchTip(rec, pull.baseRef);
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${rec.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${rec.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------- global ids (GraphQL)

export function repoGlobalId(rec: RepoRec): string {
  return Buffer.from(`010:Repository${rec.dbId}`, 'utf8').toString('base64');
}

export function issueGlobalId(rec: RepoRec, issue: IssueRec): string {
  return Buffer.from(`011:Issue${rec.dbId}:${issue.number}`, 'utf8').toString('base64');
}

export function pullGlobalId(rec: RepoRec, pull: PullRec): string {
  return Buffer.from(`012:PullRequest${rec.dbId}:${pull.number}`, 'utf8').toString('base64');
}

export function commentGlobalId(id: number): string {
  return Buffer.from(`013:IssueComment${id}`, 'utf8').toString('base64');
}

export function userGlobalId(): string {
  return Buffer.from(`014:User${VIEWER.id}`, 'utf8').toString('base64');
}

export interface DecodedId {
  kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment' | 'User';
  dbId?: number;
  number?: number;
  raw: string;
}

export function decodeGlobalId(id: string): DecodedId | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  let match = /^010:Repository(\d+)$/.exec(text);
  if (match) return { kind: 'Repository', dbId: Number(match[1]), raw: text };
  match = /^011:Issue(\d+):(\d+)$/.exec(text);
  if (match) return { kind: 'Issue', dbId: Number(match[1]), number: Number(match[2]), raw: text };
  match = /^012:PullRequest(\d+):(\d+)$/.exec(text);
  if (match) return { kind: 'PullRequest', dbId: Number(match[1]), number: Number(match[2]), raw: text };
  match = /^013:IssueComment(\d+)$/.exec(text);
  if (match) return { kind: 'IssueComment', number: Number(match[1]), raw: text };
  match = /^014:User(\d+)$/.exec(text);
  if (match) return { kind: 'User', number: Number(match[1]), raw: text };
  return null;
}

export function repoByDbId(dbId: number): RepoRec | null {
  for (const rec of forge.repos.values()) if (rec.dbId === dbId) return rec;
  return null;
}

// ---------------------------------------------------------------- pull request diff and merge

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

/** Crude but honest line accounting: lines only in the new text are additions, and vice versa. */
function diffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const remaining = new Map<string, number>();
  for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of remaining.values()) deletions += count;
  return { additions, deletions };
}

function treeFlatAt(rec: RepoRec, commitOid: string | null): Map<string, { oid: string; mode: string }> {
  if (commitOid === null) return new Map();
  const object = rec.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(rec.objects, parseCommit(object.data).tree);
}

function blobText(rec: RepoRec, oid: string): string {
  const object = rec.objects.get(oid);
  return object !== undefined && object.type === 'blob' ? object.data.toString('utf8') : '';
}

/** The current head/base tips and their merge base for a pull request. */
export function pullCommits(rec: RepoRec, pull: PullRec): { head: string | null; base: string | null; base0: string | null } {
  const head = forge.branchTip(rec, pull.headRef);
  const base = forge.branchTip(rec, pull.baseRef);
  const base0 = head !== null && base !== null ? mergeBase(rec.objects, head, base) : null;
  return { head, base, base0 };
}

/** The three-dot file diff of a pull request (merge base -> head), as the REST files view. */
export function pullFiles(rec: RepoRec, pull: PullRec): FileChange[] {
  const { head, base0 } = pullCommits(rec, pull);
  const fromFlat = treeFlatAt(rec, base0);
  const toFlat = treeFlatAt(rec, head);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from !== undefined && to === undefined) {
      const deletions = lineCount(blobText(rec, from.oid));
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (from === undefined && to !== undefined) {
      const additions = lineCount(blobText(rec, to.oid));
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (from !== undefined && to !== undefined && from.oid !== to.oid) {
      const { additions, deletions } = diffCounts(blobText(rec, from.oid), blobText(rec, to.oid));
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/**
 * Whether merging `pull` into its base would conflict: a path the head changed relative to the
 * merge base that the base also changed (to something different) since the merge base.
 */
export function pullConflicts(rec: RepoRec, pull: PullRec): boolean {
  const { head, base, base0 } = pullCommits(rec, pull);
  if (head === null || base === null || base0 === null) return false;
  const mbFlat = treeFlatAt(rec, base0);
  const headFlat = treeFlatAt(rec, head);
  const baseFlat = treeFlatAt(rec, base);
  const paths = new Set<string>([...mbFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const mb = mbFlat.get(path)?.oid;
    const headOid = headFlat.get(path)?.oid;
    if (mb === headOid) continue; // the head did not change this path
    const baseOid = baseFlat.get(path)?.oid;
    if (baseOid !== mb && baseOid !== headOid) return true;
  }
  return false;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'already-merged' | 'not-open' | 'missing' };

/**
 * Merge a pull request into its base branch. 'squash' lands one commit with the head's changes;
 * 'merge' lands a two-parent merge commit. The pull request closes as merged either way.
 */
export function mergePull(rec: RepoRec, pull: PullRec, method: 'squash' | 'merge'): MergeOutcome {
  if (pull.state !== 'open') return { ok: false, reason: pull.merged ? 'already-merged' : 'not-open' };
  const { head, base, base0 } = pullCommits(rec, pull);
  if (head === null || base === null || base0 === null) return { ok: false, reason: 'missing' };
  if (isAncestor(rec.objects, head, base)) return { ok: false, reason: 'already-merged' };
  if (pullConflicts(rec, pull)) return { ok: false, reason: 'conflict' };
  const mbFlat = treeFlatAt(rec, base0);
  const headFlat = treeFlatAt(rec, head);
  const resultFlat = treeFlatAt(rec, base);
  const paths = new Set<string>([...mbFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const mb = mbFlat.get(path)?.oid;
    const headEntry = headFlat.get(path);
    if (mb === headEntry?.oid) continue;
    if (headEntry === undefined) resultFlat.delete(path);
    else resultFlat.set(path, headEntry);
  }
  const tree = buildTreeFromFlat(rec.objects, resultFlat);
  const parents = method === 'merge' ? [base, head] : [base];
  const message = method === 'merge'
    ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`
    : `${pull.title} (#${pull.number})`;
  const sha = forge.authorCommit(rec, tree, parents, message);
  rec.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}
