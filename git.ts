// The git object model and the smart-HTTP plumbing: SHA-1 addressed objects, tree/commit/tag
// parsing and building, packfile read (with delta resolution) and write (delta-free), pkt-line
// framing, and the reachability walks the fetch negotiation is built from. Pure functions over
// Buffers; the per-repository store lives in store.ts.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_TO_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Readonly<Record<number, GitObjectType | undefined>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a (type, payload) pair: sha1 of "<type> <size>\0" + payload. */
export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'latin1');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex digits of total length + payload. Payloads above the cap are rejected. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > 0xffff) throw new Error(`pkt-line too long: ${total}`);
  const head = Buffer.from(total.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, body]);
}

export function pktText(text: string): Buffer {
  return pktLine(Buffer.from(text, 'utf8'));
}

export const PKT_FLUSH = Buffer.from('0000', 'latin1');
export const PKT_DELIM = Buffer.from('0001', 'latin1');
export const PKT_RESPONSE_END = Buffer.from('0002', 'latin1');

export interface PktReader {
  /** The next packet's payload, 'flush' / 'delim' / 'response-end' markers, or null at stream end. */
  next(): Buffer | 'flush' | 'delim' | 'response-end' | null;
  /** Everything not yet consumed (the packfile bytes after the command section). */
  rest(): Buffer;
}

/** A strict pkt-line reader: a non-hex length prefix is an error (the malformed-body check). */
export function pktReader(buf: Buffer): PktReader {
  let offset = 0;
  return {
    next() {
      if (offset >= buf.length) return null;
      if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
      const head = buf.toString('latin1', offset, offset + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length: ${JSON.stringify(head)}`);
      const length = parseInt(head, 16);
      if (length === 0) { offset += 4; return 'flush'; }
      if (length === 1) { offset += 4; return 'delim'; }
      if (length === 2) { offset += 4; return 'response-end'; }
      if (length === 3) { offset += 4; return 'delim'; }
      if (length < 4 || offset + length > buf.length) throw new Error(`pkt-line length ${length} out of range`);
      const payload = buf.subarray(offset + 4, offset + length);
      offset += length;
      return payload;
    },
    rest() {
      return buf.subarray(offset);
    },
  };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree entry');
    const mode = data.toString('latin1', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry');
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: bytewise by name, directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {oid, mode}. Paths use '/'. */
export function flattenTree(store: ReadonlyMap<string, GitObject>, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Rebuild nested trees from a flattened path map; returns the root tree oid (storing as it goes). */
export function buildTreeFromFlat(store: Map<string, GitObject>, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let next = node.dirs.get(part);
      if (next === undefined) { next = { files: new Map(), dirs: new Map() }; node.dirs.set(part, next); }
      node = next;
    }
    node.files.set(parts[parts.length - 1] as string, value);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: emit(dir) });
    const data = buildTree(entries);
    const oid = objectId('tree', data);
    if (!store.has(oid)) store.set(oid, { type: 'tree', data });
    return oid;
  };
  return emit(root);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly authorLine: string;
  readonly committerLine: string;
  readonly message: string;
  /** Author timestamp (seconds), 0 when unparsable. */
  readonly authorTime: number;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  const timeMatch = / (\d+) [+-]\d{4}$/.exec(authorLine);
  return { tree, parents, authorLine, committerLine, message, authorTime: timeMatch ? Number(timeMatch[1]) : 0 };
}

export function buildCommit(args: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${args.tree}`];
  for (const parent of args.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${args.author}`);
  lines.push(`committer ${args.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${args.message}`, 'utf8');
}

/** The commit a tag points at (following nested tags), or null. */
export function peelToCommit(store: ReadonlyMap<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1] as string;
  }
  return null;
}

/** The immediate target of an object (a tag's target), or null for non-tags. */
export function tagTarget(store: ReadonlyMap<string, GitObject>, oid: string): string | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
  return match === null ? null : (match[1] as string);
}

// ---------------------------------------------------------------- ancestry and reachability

/** All commits reachable from `tip` (inclusive), following parents. */
export function commitAncestors(store: ReadonlyMap<string, GitObject>, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ReadonlyMap<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** A merge base of two commits: a common ancestor with the least combined distance, or null. */
export function mergeBase(store: ReadonlyMap<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = commitAncestors(store, a);
  if (ancestorsOfA.has(b)) return b;
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [{ oid: b, depth: 0 }];
  let best: { oid: string; depth: number } | null = null;
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) { best = { oid, depth }; break; }
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return best === null ? null : best.oid;
}

/** Every object reachable from the given roots (commits walk to trees, blobs and parents). */
export function fullClosure(store: ReadonlyMap<string, GitObject>, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = roots.slice();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = tagTarget(store, oid);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

/**
 * The client's have-closure: everything reachable from `haves`, except that a commit the client
 * marks shallow contributes itself and its tree but not its parents.
 */
export function haveClosure(store: ReadonlyMap<string, GitObject>, haves: readonly string[], shallow: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = haves.slice();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!shallow.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = tagTarget(store, oid);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

export interface DepthResult {
  /** Every object to send. */
  readonly objects: Set<string>;
  /** Included commits that have at least one parent not included: the new shallow boundary. */
  readonly boundary: Set<string>;
  /** Included commits (for unshallow bookkeeping). */
  readonly commits: Set<string>;
}

/**
 * Depth-limited closure: commits within `depth` generations of the wants (a want is generation 1),
 * with those commits' full trees and blobs. Tags named as wants are included with their target.
 */
export function depthClosure(store: ReadonlyMap<string, GitObject>, wants: readonly string[], depth: number): DepthResult {
  const distance = new Map<string, number>();
  const extra = new Set<string>(); // tags and their targets' wrapper objects
  const queue: Array<{ oid: string; gen: number }> = [];
  const pushCommit = (oid: string, gen: number): void => {
    const known = distance.get(oid);
    if (known === undefined || gen < known) {
      distance.set(oid, gen);
      queue.push({ oid, gen });
    }
  };
  for (const want of wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') pushCommit(want, 0);
    else if (object.type === 'tag') {
      extra.add(want);
      const target = peelToCommit(store, want);
      if (target !== null) pushCommit(target, 0);
    } else {
      extra.add(want);
    }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if ((distance.get(oid) as number) !== gen) continue;
    if (gen + 1 >= depth) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) pushCommit(parent, gen + 1);
  }
  const commits = new Set<string>();
  for (const [oid, gen] of distance) if (gen < depth) commits.add(oid);
  const objects = new Set<string>(extra);
  const boundary = new Set<string>();
  for (const oid of commits) {
    objects.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    // The commit's whole tree.
    const treeStack = [commit.tree];
    while (treeStack.length > 0) {
      const treeOid = treeStack.pop() as string;
      if (objects.has(treeOid)) continue;
      const tree = store.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') continue;
      objects.add(treeOid);
      for (const entry of parseTree(tree.data)) {
        if (entry.mode === '40000') treeStack.push(entry.oid);
        else objects.add(entry.oid);
      }
    }
    if (commit.parents.some((parent) => !commits.has(parent))) boundary.add(oid);
  }
  return { objects, boundary, commits };
}

// ---------------------------------------------------------------- packfiles

function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_TO_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 packfile holding the given objects, delta-free, in the order given. */
export function writePack(store: ReadonlyMap<string, GitObject>, oids: readonly string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of oids) {
    const object = store.get(oid);
    if (object === undefined) continue;
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate the zlib stream starting at `offset`; returns the data and the offset just past it. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta (base -> result) as produced by OFS_DELTA / REF_DELTA entries. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset] as number;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) if (opcode & (1 << bit)) { copyOffset += (delta[offset] as number) * 2 ** (8 * bit); offset += 1; }
      for (let bit = 0; bit < 3; bit += 1) if (opcode & (0x10 << bit)) { copySize += (delta[offset] as number) * 2 ** (8 * bit); offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode > 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta result size mismatch');
  return out;
}

export interface UnpackedPack {
  /** Every resolved object in the pack, by id. */
  readonly objects: Map<string, GitObject>;
}

/**
 * Read a packfile into resolved objects. Delta bases may come from the pack itself or from
 * `lookup` (the repository's existing store, for thin packs). The trailer checksum is verified.
 */
export function readPack(buf: Buffer, lookup: (oid: string) => GitObject | undefined): UnpackedPack {
  if (buf.length < 12 + 20) throw new Error('pack too short');
  if (buf.toString('latin1', 0, 4) !== 'PACK') throw new Error('pack signature missing');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const digest = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const raw = new Map<string, GitObject>();
  const pending: Array<{ resolve: () => GitObject }> = [];
  let offset = 12;
  const entriesStart: number[] = [];
  for (let i = 0; i < count; i += 1) {
    entriesStart.push(offset);
    let byte = buf[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset back to the base entry's start.
      let back = buf[offset] as number;
      offset += 1;
      let baseOffset = back & 0x7f;
      while (back & 0x80) {
        back = buf[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (back & 0x7f);
      }
      const { data: delta, next } = inflateAt(buf, offset);
      offset = next;
      const baseEntryStart = (entriesStart[entriesStart.length - 1] as number) - baseOffset;
      pending.push({
        resolve: () => {
          const base = resolveByStart(baseEntryStart);
          return { type: base.type, data: applyDelta(base.data, delta) };
        },
      });
      void size;
    } else if (typeCode === 7) {
      // REF_DELTA: a 20-byte base object id.
      const baseOid = buf.toString('hex', offset, offset + 20);
      offset += 20;
      const { data: delta, next } = inflateAt(buf, offset);
      offset = next;
      pending.push({
        resolve: () => {
          const base = raw.get(baseOid) ?? lookup(baseOid);
          if (base === undefined) throw new Error(`delta base ${baseOid} not found`);
          return { type: base.type, data: applyDelta(base.data, delta) };
        },
      });
      void size;
    } else {
      const type = CODE_TO_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next } = inflateAt(buf, offset);
      offset = next;
      if (data.length !== size) throw new Error('pack entry size mismatch');
      raw.set(objectId(type, data), { type, data });
      pending.push({ resolve: () => ({ type, data }) });
    }
  }
  // Resolve delta entries (their bases are always earlier entries or pre-existing objects).
  const byStart = new Map<number, GitObject>();
  const resolveByStart = (start: number): GitObject => {
    const cached = byStart.get(start);
    if (cached !== undefined) return cached;
    const index = entriesStart.indexOf(start);
    if (index < 0) throw new Error('ofs-delta base not in pack');
    const object = (pending[index] as { resolve: () => GitObject }).resolve();
    byStart.set(start, object);
    raw.set(objectId(object.type, object.data), object);
    return object;
  };
  for (let i = 0; i < pending.length; i += 1) {
    const start = entriesStart[i] as number;
    if (!byStart.has(start)) resolveByStart(start);
  }
  return { objects: raw };
}
