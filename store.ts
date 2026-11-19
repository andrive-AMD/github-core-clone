// The forge's state: repositories with their own object stores, refs, labels, issues, pull
// requests and comments — all in memory, all owned by the scenario's viewer. Ids and timestamps
// come from deterministic counters (never the wall clock), so a run's state is reproducible.

import { SCENARIO_EPOCH_SEC, VIEWER } from './scenario.ts';
import {
  buildCommit, buildTreeFromFlat, flattenTree, objectId, parseCommit,
  type GitObject,
} from './git.ts';

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  issueNumber: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface RepoRec {
  /** Forge-wide sequential id (the REST `id` and GraphQL `databaseId`). */
  dbId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber: number;
  /** Deterministic clock for commits this forge authors in this repository. */
  commitSeq: number;
  createdSeq: number;
}

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private issueSeq = 0;
  private pullSeq = 0;
  private commentSeq = 0;
  private clockSeq = 0;

  /** A deterministic ISO timestamp from the forge's logical clock. */
  nowIso(): string {
    this.clockSeq += 1;
    return new Date((SCENARIO_EPOCH_SEC + this.clockSeq) * 1000).toISOString();
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Look up a repository. Only the viewer's repositories exist; any other owner is a 404. */
  repo(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch: string): RepoRec {
    this.repoSeq += 1;
    const rec: RepoRec = {
      dbId: this.repoSeq,
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch: defaultBranch === '' ? 'main' : defaultBranch,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      commitSeq: 0,
      createdSeq: this.repoSeq,
    };
    this.repos.set(this.key(rec.owner, rec.name), rec);
    return rec;
  }

  deleteRepo(rec: RepoRec): void {
    this.repos.delete(this.key(rec.owner, rec.name));
  }

  viewerRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextPullId(): number {
    this.pullSeq += 1;
    return this.pullSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  /** Store an object in a repository (idempotent) and return its id. */
  putObject(repo: RepoRec, type: GitObject['type'], data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The oid a branch name (no refs/ prefix) points at, or null. */
  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The oid HEAD resolves to (the default branch's tip), or null when unborn. */
  headTip(repo: RepoRec): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /**
   * Author a commit in a repository as the viewer, with a deterministic timestamp, and return
   * its oid. The message is stored verbatim.
   */
  authorCommit(repo: RepoRec, tree: string, parents: readonly string[], message: string): string {
    repo.commitSeq += 1;
    const stamp = `${SCENARIO_EPOCH_SEC + repo.commitSeq} +0000`;
    const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp}`;
    const data = buildCommit({ tree, parents, author: identity, committer: identity, message });
    return this.putObject(repo, 'commit', data);
  }

  /**
   * Set (or delete) the file at `path` on `branch`, building a fresh commit on the branch tip.
   * A missing branch is born from the default branch's tip (or unborn, on an empty repository) —
   * the semantics the contents API promises. Returns the new commit oid.
   */
  commitFileChange(repo: RepoRec, branch: string, path: string, content: Buffer | null, message: string): string {
    let tip = this.branchTip(repo, branch);
    if (tip === null) {
      tip = this.headTip(repo);
      if (tip !== null) repo.refs.set(`refs/heads/${branch}`, tip);
    }
    let flat = new Map<string, { oid: string; mode: string }>();
    if (tip !== null) {
      const commitObject = repo.objects.get(tip);
      if (commitObject !== undefined && commitObject.type === 'commit') {
        flat = flattenTree(repo.objects, parseCommit(commitObject.data).tree);
      }
    }
    if (content === null) flat.delete(path);
    else flat.set(path, { oid: this.putObject(repo, 'blob', content), mode: '100644' });
    const tree = buildTreeFromFlat(repo.objects, flat);
    const parents = tip === null ? [] : [tip];
    const commit = this.authorCommit(repo, tree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return commit;
  }
}

/** The one forge instance for the process. */
export const forge = new Forge();
