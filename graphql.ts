// The GraphQL v4 surface: a small self-contained parser and executor covering exactly the
// schema the suite exercises — viewer, repository, node, issues and pull requests with cursor
// connections, the five mutations, and the introspection the checks read. Unknown fields answer
// with a GraphQL errors array naming the field, as GitHub does.

import { VIEWER } from './scenario.ts';
import { forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import {
  commentGlobalId, decodeGlobalId, issueGlobalId, issueJson, mergePull, pullFiles, pullConflicts,
  pullGlobalId, pullJson, repoByDbId, repoGlobalId, userGlobalId,
} from './domain.ts';

// ---------------------------------------------------------------- lexer and parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: 'spread' }); i += 3; continue; }
    if ('!$():=@[]{}|&='.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'u') { value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)); j += 6; }
          else if (esc === 'n') { value += '\n'; j += 2; }
          else if (esc === 't') { value += '\t'; j += 2; }
          else if (esc === 'r') { value += '\r'; j += 2; }
          else if (esc === 'b') { value += '\b'; j += 2; }
          else if (esc === 'f') { value += '\f'; j += 2; }
          else { value += esc; j += 2; }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      const value = Number(text);
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value } : { kind: 'int', value });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

interface ValueNode { kind: string; value?: unknown; fields?: Array<{ name: string; value: ValueNode }>; items?: ValueNode[] }
interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };
interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}
interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) { this.pos += 1; return true; }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation or fragment');
      if (token.value === 'query' || token.value === 'mutation') {
        const type = token.value;
        this.pos += 1;
        let name: string | null = null;
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.kind === 'name') { name = nextToken.value; this.pos += 1; }
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.pos += 1;
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected `on` in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    for (;;) {
      if (this.skipPunct(')')) return;
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.expectPunct('(');
        for (;;) {
          if (this.skipPunct(')')) break;
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      if (this.skipPunct('}')) return selections;
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.pos += 1;
      const nextToken = this.peek();
      if (nextToken !== undefined && nextToken.kind === 'name' && nextToken.value === 'on') {
        this.pos += 1;
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.expectPunct('(');
      for (;;) {
        if (this.skipPunct(')')) break;
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int' || token.kind === 'float') return { kind: 'number', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', value: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      for (;;) {
        if (this.skipPunct(']')) break;
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        if (this.skipPunct('}')) break;
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.value as string];
    case 'list': return (node.items ?? []).map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) out[field.name] = valueOf(field.value, variables);
      return out;
    }
    default: return node.value;
  }
}

// ---------------------------------------------------------------- typed values

type GqlValue =
  | { __type: 'User' }
  | { __type: 'Repository'; rec: RepoRec }
  | { __type: 'Ref'; rec: RepoRec }
  | { __type: 'Issue'; rec: RepoRec; issue: IssueRec }
  | { __type: 'PullRequest'; rec: RepoRec; pull: PullRec }
  | { __type: 'IssueComment'; rec: RepoRec; issue: IssueRec; comment: { id: number; body: string } }
  | { __type: 'IssueConnection'; rec: RepoRec; nodes: IssueRec[]; hasNextPage: boolean; endCursor: string | null; totalCount: number }
  | { __type: 'PullRequestConnection'; rec: RepoRec; nodes: PullRec[]; hasNextPage: boolean; endCursor: string | null; totalCount: number }
  | { __type: 'FileConnection'; files: Array<{ path: string; additions: number; deletions: number }> }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'Payload'; fields: Record<string, GqlValue | null> }
  | { __type: 'CommentEdge'; node: GqlValue }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string }
  | { __type: '__Schema' };

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'prefix'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files',
    'author', 'mergedAt', 'mergeCommit', 'createdAt', 'updatedAt', 'url', 'repository',
  ],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

class FieldFailure extends Error {}

const ISO = '2025-01-01T00:00:00Z';

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function issueState(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---------------------------------------------------------------- field resolution

type Args = Record<string, unknown>;

function resolveField(typeName: string, parent: GqlValue | null, field: string, args: Args): unknown {
  if (field === '__typename') return typeName;
  switch (typeName) {
    case 'Query': return resolveQuery(field, args);
    case 'Mutation': return resolveMutation(field, args);
    case 'User': {
      if (field === 'id') return userGlobalId();
      if (field === 'login') return VIEWER.login;
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      break;
    }
    case 'Repository': {
      const rec = (parent as { rec: RepoRec }).rec;
      switch (field) {
        case 'id': return repoGlobalId(rec);
        case 'databaseId': return rec.dbId;
        case 'name': return rec.name;
        case 'nameWithOwner': return `${rec.owner}/${rec.name}`;
        case 'owner': return { __type: 'User' } as GqlValue;
        case 'description': return rec.description;
        case 'isPrivate': return rec.isPrivate;
        case 'defaultBranchRef': return { __type: 'Ref', rec } as GqlValue;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'createdAt': case 'updatedAt': return ISO;
        case 'url': return `https://forge.invalid/${rec.owner}/${rec.name}`;
        case 'issue': {
          const issue = rec.issues.get(Number(args.number));
          return issue === undefined ? null : ({ __type: 'Issue', rec, issue } as GqlValue);
        }
        case 'issues': return issuesConnection(rec, args);
        case 'pullRequest': {
          const pull = rec.pulls.get(Number(args.number));
          return pull === undefined ? null : ({ __type: 'PullRequest', rec, pull } as GqlValue);
        }
        case 'pullRequests': return pullsConnection(rec, args);
        default: break;
      }
      break;
    }
    case 'Ref': {
      const rec = (parent as { rec: RepoRec }).rec;
      if (field === 'name') return rec.defaultBranch;
      if (field === 'prefix') return 'refs/heads/';
      break;
    }
    case 'Issue': {
      const { rec, issue } = parent as { rec: RepoRec; issue: IssueRec };
      switch (field) {
        case 'id': return issueGlobalId(rec, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issueState(issue);
        case 'body': return issue.body;
        case 'author': return { __type: 'User' } as GqlValue;
        case 'createdAt': case 'updatedAt': return ISO;
        case 'url': return `https://forge.invalid/${rec.owner}/${rec.name}/issues/${issue.number}`;
        case 'repository': return { __type: 'Repository', rec } as GqlValue;
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const { rec, pull } = parent as { rec: RepoRec; pull: PullRec };
      switch (field) {
        case 'id': return pullGlobalId(rec, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return pullConflicts(rec, pull) ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergedAt': return pull.mergedAt;
        case 'author': return { __type: 'User' } as GqlValue;
        case 'createdAt': case 'updatedAt': return ISO;
        case 'url': return `https://forge.invalid/${rec.owner}/${rec.name}/pull/${pull.number}`;
        case 'repository': return { __type: 'Repository', rec } as GqlValue;
        case 'files': {
          const all = pullFiles(rec, pull).map((change) => ({ path: change.filename, additions: change.additions, deletions: change.deletions }));
          const first = typeof args.first === 'number' ? args.first : all.length;
          return { __type: 'FileConnection', files: all.slice(0, first) } as GqlValue;
        }
        default: break;
      }
      break;
    }
    case 'IssueComment': {
      const { comment } = parent as { comment: { id: number; body: string } };
      if (field === 'id') return commentGlobalId(comment.id);
      if (field === 'body') return comment.body;
      if (field === 'author') return { __type: 'User' } as GqlValue;
      if (field === 'createdAt' || field === 'updatedAt') return ISO;
      break;
    }
    case 'IssueConnection': case 'PullRequestConnection': {
      const conn = parent as { nodes: Array<IssueRec | PullRec>; hasNextPage: boolean; endCursor: string | null; totalCount: number; rec: RepoRec };
      if (field === 'nodes') {
        return conn.nodes.map((node) => ('headRef' in node
          ? { __type: 'PullRequest', rec: conn.rec, pull: node as PullRec }
          : { __type: 'Issue', rec: conn.rec, issue: node as IssueRec }) as GqlValue);
      }
      if (field === 'pageInfo') return { __type: 'PageInfo', hasNextPage: conn.hasNextPage, endCursor: conn.endCursor } as GqlValue;
      if (field === 'totalCount') return conn.totalCount;
      break;
    }
    case 'FileConnection': {
      const conn = parent as { files: Array<{ path: string; additions: number; deletions: number }> };
      if (field === 'nodes') return conn.files.map((file) => ({ __type: 'PullRequestChangedFile', ...file }) as unknown as GqlValue);
      if (field === 'totalCount') return conn.files.length;
      if (field === 'pageInfo') return { __type: 'PageInfo', hasNextPage: false, endCursor: null } as GqlValue;
      break;
    }
    case 'PullRequestChangedFile': {
      const file = parent as unknown as { path: string; additions: number; deletions: number };
      if (field === 'path') return file.path;
      if (field === 'additions') return file.additions;
      if (field === 'deletions') return file.deletions;
      if (field === 'changeType') return 'MODIFIED';
      break;
    }
    case 'PageInfo': {
      const info = parent as { hasNextPage: boolean; endCursor: string | null };
      if (field === 'hasNextPage') return info.hasNextPage;
      if (field === 'hasPreviousPage') return false;
      if (field === 'endCursor') return info.endCursor;
      if (field === 'startCursor') return info.endCursor;
      break;
    }
    case 'Payload': {
      const payload = parent as { fields: Record<string, GqlValue | null> };
      if (field in payload.fields) return payload.fields[field];
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'CommentEdge': {
      const edge = parent as { node: GqlValue };
      if (field === 'node') return edge.node;
      if (field === 'cursor') return cursorFor(0);
      break;
    }
    case '__Type': {
      const type = parent as { name: string };
      if (field === 'name') return type.name;
      if (field === 'kind') return ENUM_VALUES[type.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field === 'description') return null;
      if (field === 'fields') {
        const names = TYPE_FIELDS[type.name];
        return names === undefined ? null : names.map((name) => ({ __type: '__Field', name }) as GqlValue);
      }
      if (field === 'enumValues') {
        const values = ENUM_VALUES[type.name];
        return values === undefined ? null : values.map((name) => ({ __type: '__EnumValue', name }) as GqlValue);
      }
      break;
    }
    case '__Field': case '__EnumValue': {
      const item = parent as { name: string };
      if (field === 'name') return item.name;
      if (field === 'description') return null;
      break;
    }
    case '__Schema': {
      if (field === 'queryType') return { __type: '__Type', name: 'Query' } as GqlValue;
      if (field === 'mutationType') return { __type: '__Type', name: 'Mutation' } as GqlValue;
      break;
    }
    default: break;
  }
  throw new FieldFailure(`Field '${field}' doesn't exist on type '${typeName}'`);
}

function resolveQuery(field: string, args: Args): unknown {
  switch (field) {
    case 'viewer': return { __type: 'User' } as GqlValue;
    case 'repository': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const rec = forge.repo(owner, name);
      return rec === null ? null : ({ __type: 'Repository', rec } as GqlValue);
    }
    case 'node': {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const rec = repoByDbId(decoded.dbId as number);
        return rec === null ? null : ({ __type: 'Repository', rec } as GqlValue);
      }
      if (decoded.kind === 'Issue') {
        const rec = repoByDbId(decoded.dbId as number);
        const issue = rec?.issues.get(decoded.number as number);
        return rec !== null && rec !== undefined && issue !== undefined ? ({ __type: 'Issue', rec, issue } as GqlValue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const rec = repoByDbId(decoded.dbId as number);
        const pull = rec?.pulls.get(decoded.number as number);
        return rec !== null && rec !== undefined && pull !== undefined ? ({ __type: 'PullRequest', rec, pull } as GqlValue) : null;
      }
      if (decoded.kind === 'User') return { __type: 'User' } as GqlValue;
      return null;
    }
    case '__type': {
      const name = typeof args.name === 'string' ? args.name : '';
      if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
      return { __type: '__Type', name } as GqlValue;
    }
    case '__schema': return { __type: '__Schema' } as GqlValue;
    default: break;
  }
  throw new FieldFailure(`Field '${field}' doesn't exist on type 'Query'`);
}

function inputOf(args: Args): Record<string, unknown> {
  const input = args.input;
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function resolveMutation(field: string, args: Args): unknown {
  const input = inputOf(args);
  switch (field) {
    case 'createIssue': {
      const decoded = decodeGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      const rec = decoded !== null && decoded.kind === 'Repository' ? repoByDbId(decoded.dbId as number) : null;
      if (rec === null) throw new FieldFailure('repository not found for createIssue');
      const title = typeof input.title === 'string' ? input.title : '';
      const number = rec.nextNumber;
      rec.nextNumber += 1;
      const issue: IssueRec = {
        id: forge.nextIssueId(),
        number,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
      };
      rec.issues.set(number, issue);
      return { __type: 'Payload', fields: { issue: { __type: 'Issue', rec, issue } } } as GqlValue;
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(typeof input.issueId === 'string' ? input.issueId : '');
      const rec = decoded !== null && decoded.kind === 'Issue' ? repoByDbId(decoded.dbId as number) : null;
      const issue = rec?.issues.get(decoded?.number as number);
      if (rec === null || rec === undefined || issue === undefined) throw new FieldFailure('issue not found for closeIssue');
      issue.state = 'closed';
      return { __type: 'Payload', fields: { issue: { __type: 'Issue', rec, issue } } } as GqlValue;
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      const rec = decoded !== null && decoded.kind === 'Repository' ? repoByDbId(decoded.dbId as number) : null;
      if (rec === null) throw new FieldFailure('repository not found for createPullRequest');
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headTip = forge.branchTip(rec, headRef);
      const baseTip = forge.branchTip(rec, baseRef);
      if (headTip === null || baseTip === null) throw new FieldFailure('head or base branch does not exist');
      if (headTip === baseTip) throw new FieldFailure('No commits between base and head');
      const number = rec.nextNumber;
      rec.nextNumber += 1;
      const pull: PullRec = {
        id: forge.nextPullId(),
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef,
        baseRef,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      rec.pulls.set(number, pull);
      return { __type: 'Payload', fields: { pullRequest: { __type: 'PullRequest', rec, pull } } } as GqlValue;
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
      const rec = decoded !== null && decoded.kind === 'PullRequest' ? repoByDbId(decoded.dbId as number) : null;
      const pull = rec?.pulls.get(decoded?.number as number);
      if (rec === null || rec === undefined || pull === undefined) throw new FieldFailure('pull request not found for mergePullRequest');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      const outcome = mergePull(rec, pull, method === 'MERGE' ? 'merge' : 'squash');
      if (!outcome.ok) throw new FieldFailure(`merge failed: ${outcome.reason}`);
      return { __type: 'Payload', fields: { pullRequest: { __type: 'PullRequest', rec, pull } } } as GqlValue;
    }
    case 'addComment': {
      const decoded = decodeGlobalId(typeof input.subjectId === 'string' ? input.subjectId : '');
      const rec = decoded !== null && decoded.kind === 'Issue' ? repoByDbId(decoded.dbId as number) : null;
      const issue = rec?.issues.get(decoded?.number as number);
      if (rec === null || rec === undefined || issue === undefined) throw new FieldFailure('subject not found for addComment');
      const comment = { id: forge.nextCommentId(), body: typeof input.body === 'string' ? input.body : '', issueNumber: issue.number };
      issue.comments.push(comment);
      const node = { __type: 'IssueComment', rec, issue, comment } as GqlValue;
      return { __type: 'Payload', fields: { commentEdge: { __type: 'CommentEdge', node }, subject: { __type: 'Issue', rec, issue } } } as GqlValue;
    }
    default: break;
  }
  throw new FieldFailure(`Field '${field}' doesn't exist on type 'Mutation'`);
}

// ---------------------------------------------------------------- connections

function pageSlice<T extends { number: number }>(items: T[], args: Args): { nodes: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (typeof args.after === 'string') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) {
        const index = items.findIndex((item) => item.number === Number(match[1]));
        if (index >= 0) start = index + 1;
      }
    } catch { /* an undecodable cursor starts from the beginning */ }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const nodes = items.slice(start, start + first);
  const hasNextPage = start + nodes.length < items.length;
  const endCursor = nodes.length > 0 ? cursorFor((nodes[nodes.length - 1] as T).number) : (typeof args.after === 'string' ? args.after : null);
  return { nodes, hasNextPage, endCursor };
}

function issuesConnection(rec: RepoRec, args: Args): GqlValue {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : ['OPEN'];
  let issues = [...rec.issues.values()].filter((issue) => states.includes(issueState(issue)));
  const orderBy = typeof args.orderBy === 'object' && args.orderBy !== null ? (args.orderBy as Record<string, unknown>) : {};
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const page = pageSlice(issues, args);
  return {
    __type: 'IssueConnection', rec, nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor, totalCount: issues.length,
  } as GqlValue;
}

function pullsConnection(rec: RepoRec, args: Args): GqlValue {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : ['OPEN'];
  let pulls = [...rec.pulls.values()].filter((pull) => states.includes(pullState(pull)));
  pulls.sort((a, b) => a.number - b.number);
  const page = pageSlice(pulls, args);
  return {
    __type: 'PullRequestConnection', rec, nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor, totalCount: pulls.length,
  } as GqlValue;
}

// ---------------------------------------------------------------- execution

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

function typeNameOf(value: unknown, hint: string | null): string {
  if (typeof value === 'object' && value !== null && '__type' in value) {
    return (value as { __type: string }).__type;
  }
  return hint ?? 'Query';
}

function executeSelectionSet(
  typeName: string,
  parent: unknown,
  selections: SelectionNode[],
  ctx: ExecContext,
  out: Record<string, unknown>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        executeSelectionSet(typeName, parent, selection.selection, ctx, out);
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typeName) {
        executeSelectionSet(typeName, parent, fragment.selection, ctx, out);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args: Args = {};
    for (const arg of selection.args) args[arg.name] = valueOf(arg.value, ctx.variables);
    let value: unknown;
    try {
      value = resolveField(typeName, parent as GqlValue | null, selection.name, args);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    if (selection.selection !== null && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        out[key] = value.map((item) => {
          if (typeof item === 'object' && item !== null && '__type' in item) {
            const child: Record<string, unknown> = {};
            executeSelectionSet(typeNameOf(item, null), item, selection.selection as SelectionNode[], ctx, child);
            return child;
          }
          return item;
        });
      } else if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
        const child: Record<string, unknown> = {};
        executeSelectionSet(typeNameOf(value, null), value, selection.selection, ctx, child);
        out[key] = child;
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value === undefined ? null : value;
    }
  }
}

export interface GraphQLRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

/** Execute one GraphQL request document; returns the response envelope. */
export function executeGraphQL(request: GraphQLRequest): Record<string, unknown> {
  if (typeof request.query !== 'string' || request.query === '') {
    return { errors: [{ message: 'a query document is required' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation = operationName !== null
    ? document.operations.find((op) => op.name === operationName) ?? document.operations[0]
    : document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const variables = typeof request.variables === 'object' && request.variables !== null
    ? (request.variables as Record<string, unknown>)
    : {};
  const ctx: ExecContext = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  executeSelectionSet(rootType, null, operation.selection, ctx, data);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

// Re-exported so app.ts can serialize REST-identical shapes if it ever needs them.
export { issueJson, pullJson };
