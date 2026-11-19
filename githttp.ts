// Git smart HTTP: the ref advertisements, protocol-v2 ls-refs and fetch, the v0 fetch fallback,
// and receive-pack with report-status. Everything is served from the repository's in-memory
// object store; pushes store their objects first and then validate each ref update.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_FLUSH, ZERO_OID, depthClosure, fullClosure, haveClosure, isAncestor, isOid, objectId,
  parseCommit, peelToCommit, pktReader, pktText, readPack, writePack,
  type GitObject,
} from './git.ts';
import { forge, type RepoRec } from './store.ts';

const AGENT = 'makefun-forge/1.0';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendNotFound(res: ServerResponse): void {
  send(res, 404, 'application/json; charset=utf-8', Buffer.from('{"message":"Not Found"}\n'));
}

/** All refs in advertisement order: branches, then tags, then anything else, each name-sorted. */
function sortedRefs(repo: RepoRec): Array<{ ref: string; oid: string }> {
  const out: Array<{ ref: string; oid: string }> = [];
  for (const [ref, oid] of repo.refs) out.push({ ref, oid });
  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return out;
}

function capabilitiesLine(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): string {
  if (service === 'git-receive-pack') {
    return `report-status delete-refs side-band-64k ofs-delta quiet agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  }
  return `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
}

/** GET info/refs for both services, answering v2 for upload-pack when the client asks for it. */
export function infoRefs(req: IncomingMessage, res: ServerResponse, repo: RepoRec, service: string | null): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('missing or unknown service\n'));
    return;
  }
  const protocol = req.headers['git-protocol'];
  if (service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2')) {
    const lines = [
      pktText('version 2\n'),
      pktText(`agent=${AGENT}\n`),
      pktText('ls-refs\n'),
      pktText('fetch=shallow\n'),
      pktText('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    send(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(lines));
    return;
  }
  const caps = capabilitiesLine(repo, service);
  const parts: Buffer[] = [pktText(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headTip = forge.headTip(repo);
  let first = true;
  const refLine = (oid: string, name: string): Buffer => {
    const suffix = first ? `\0${caps}` : '';
    first = false;
    return pktText(`${oid} ${name}${suffix}\n`);
  };
  if (refs.length === 0) {
    parts.push(pktText(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    if (headTip !== null) parts.push(refLine(headTip, 'HEAD'));
    for (const { ref, oid } of refs) {
      parts.push(refLine(oid, ref));
      if (ref.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo.objects, oid);
        if (peeled !== null && peeled !== oid) parts.push(pktText(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  const contentType = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  send(res, 200, contentType, Buffer.concat(parts));
}

// ---------------------------------------------------------------- ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function runLsRefs(repo: RepoRec, args: LsRefsArgs): Buffer {
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = forge.headTip(repo);
  if (headTip !== null) {
    if (matches('HEAD')) {
      const suffix = args.symrefs ? ` symref-target:${headRef}` : '';
      lines.push(pktText(`${headTip} HEAD${suffix}\n`));
    }
  } else if (args.unborn && matches('HEAD')) {
    const suffix = args.symrefs ? ` symref-target:${headRef}` : '';
    lines.push(pktText(`unborn HEAD${suffix}\n`));
  }
  for (const { ref, oid } of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let suffix = '';
    if (args.peel && ref.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled !== null) suffix = ` peeled:${peeled}`;
    }
    lines.push(pktText(`${oid} ${ref}${suffix}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
  sideband: boolean;
}

interface FetchPlan {
  send: string[];
  shallowLines: string[];
}

/** Work out which objects a fetch must carry and which shallow lines it must announce. */
function planFetch(repo: RepoRec, request: FetchRequest): FetchPlan {
  const store = repo.objects;
  const clientShallow = new Set(request.shallow);
  const haveSet = haveClosure(store, request.haves, clientShallow);
  if (request.deepen !== null) {
    const depth = depthClosure(store, request.wants, request.deepen);
    const send: string[] = [];
    for (const oid of depth.objects) if (!haveSet.has(oid)) send.push(oid);
    const shallowLines: string[] = [];
    for (const oid of depth.boundary) if (!haveSet.has(oid)) shallowLines.push(`shallow ${oid}`);
    for (const oid of clientShallow) {
      if (depth.commits.has(oid) && !depth.boundary.has(oid)) shallowLines.push(`unshallow ${oid}`);
    }
    return { send, shallowLines };
  }
  const wanted = fullClosure(store, request.wants);
  const send: string[] = [];
  for (const oid of wanted) if (!haveSet.has(oid)) send.push(oid);
  return { send, shallowLines: [] };
}

/** Wrap pack bytes in side-band-64k packets (band 1), chunked, with a trailing flush. */
function sidebandWrap(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32_768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    const head = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'latin1');
    parts.push(head, payload);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A fetch answered the v2 way: optional shallow-info section, then the packfile section. */
function fetchV2(repo: RepoRec, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (plan.shallowLines.length > 0) {
    parts.push(pktText('shallow-info\n'));
    for (const line of plan.shallowLines) parts.push(pktText(`${line}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktText('packfile\n'));
  const pack = writePack(repo.objects, plan.send);
  parts.push(sidebandWrap(pack));
  return Buffer.concat(parts);
}

/** A fetch answered the v0 way: shallow lines, NAK, then the pack in side-band packets. */
function fetchV0(repo: RepoRec, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  for (const line of plan.shallowLines) parts.push(pktText(`${line}\n`));
  parts.push(pktText('NAK\n'));
  const pack = writePack(repo.objects, plan.send);
  if (request.sideband) parts.push(sidebandWrap(pack));
  else parts.push(pack);
  return Buffer.concat(parts);
}

/** POST git-upload-pack: dispatches between the v2 commands and the v0 negotiation. */
export function uploadPack(res: ServerResponse, repo: RepoRec, body: Buffer): void {
  let reader;
  try {
    reader = pktReader(body);
  } catch {
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('invalid pkt-line stream\n'));
    return;
  }
  try {
    const first = reader.next();
    if (first === null || first === 'flush' || first === 'delim' || first === 'response-end') {
      send(res, 400, 'text/plain; charset=utf-8', Buffer.from('empty upload-pack request\n'));
      return;
    }
    const firstText = first.toString('utf8').replace(/\n$/, '');
    if (firstText.startsWith('command=')) {
      const command = firstText.slice('command='.length).split(' ')[0] as string;
      // Capability lines run until the delimiter.
      for (;;) {
        const packet = reader.next();
        if (packet === 'delim' || packet === null || packet === 'flush') break;
      }
      if (command === 'ls-refs') {
        const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (;;) {
          const packet = reader.next();
          if (packet === null || packet === 'flush') break;
          const line = packet.toString('utf8').replace(/\n$/, '');
          if (line === 'peel') args.peel = true;
          else if (line === 'symrefs') args.symrefs = true;
          else if (line === 'unborn') args.unborn = true;
          else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
        }
        send(res, 200, 'application/x-git-upload-pack-result', runLsRefs(repo, args));
        return;
      }
      if (command === 'fetch') {
        const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, done: false, sideband: true };
        for (;;) {
          const packet = reader.next();
          if (packet === null || packet === 'flush') break;
          const line = packet.toString('utf8').replace(/\n$/, '');
          if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
          else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
          else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
          else if (line.startsWith('deepen ')) request.deepen = Number(line.slice(7).trim());
          else if (line === 'done') request.done = true;
        }
        if (!request.done) {
          // Negotiation round: acknowledge the haves we know, or NAK when there is no common base.
          const parts: Buffer[] = [pktText('acknowledgments\n')];
          let acked = false;
          for (const have of request.haves) {
            if (repo.objects.has(have)) { parts.push(pktText(`ACK ${have}\n`)); acked = true; }
          }
          if (!acked) parts.push(pktText('NAK\n'));
          parts.push(PKT_FLUSH);
          send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
          return;
        }
        send(res, 200, 'application/x-git-upload-pack-result', fetchV2(repo, request));
        return;
      }
      send(res, 400, 'text/plain; charset=utf-8', Buffer.from(`unknown command ${command}\n`));
      return;
    }
    // v0: the first line is a want line.
    const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, done: false, sideband: false };
    const consumeWantLine = (line: string): void => {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        request.wants.push((space >= 0 ? rest.slice(0, space) : rest).trim());
        if (rest.includes('side-band-64k')) request.sideband = true;
      } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.deepen = Number(line.slice(7).trim());
    };
    consumeWantLine(firstText);
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet === 'flush') break;
      consumeWantLine(packet.toString('utf8').replace(/\n$/, ''));
    }
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet === 'flush') break;
      const line = packet.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line === 'done') request.done = true;
    }
    send(res, 200, 'application/x-git-upload-pack-result', fetchV0(repo, request));
  } catch {
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed upload-pack request\n'));
  }
}

// ---------------------------------------------------------------- receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: unpack, validate each ref update, report per-ref status. */
export function receivePack(res: ServerResponse, repo: RepoRec, body: Buffer): void {
  let reader;
  try {
    reader = pktReader(body);
  } catch {
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('invalid pkt-line stream\n'));
    return;
  }
  const commands: RefCommand[] = [];
  let reportStatus = false;
  let sideband = false;
  try {
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet === 'flush') break;
      let line = packet.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1);
        if (caps.includes('report-status')) reportStatus = true;
        if (caps.includes('side-band-64k')) sideband = true;
        line = line.slice(0, nul);
      }
      const parts = line.split(' ');
      if (parts.length >= 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
      }
    }
  } catch {
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed receive-pack request\n'));
    return;
  }
  const packBytes = reader.rest();
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const unpacked = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of unpacked.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: `reference is at ${current} but expected ${command.oldOid}` });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && !command.ref.startsWith('refs/tags/')) {
      const oldCommit = peelToCommit(repo.objects, command.oldOid);
      const newCommit = peelToCommit(repo.objects, command.newOid);
      if (oldCommit !== null && newCommit !== null && !isAncestor(repo.objects, oldCommit, newCommit)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }
  if (!reportStatus) {
    send(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportLines: Buffer[] = [pktText(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    reportLines.push(pktText(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  reportLines.push(PKT_FLUSH);
  const report = Buffer.concat(reportLines);
  if (sideband) {
    const payload = Buffer.concat([Buffer.from([1]), report]);
    const head = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'latin1');
    send(res, 200, 'application/x-git-receive-pack-result', Buffer.concat([head, payload, PKT_FLUSH]));
  } else {
    send(res, 200, 'application/x-git-receive-pack-result', report);
  }
}

export { sendNotFound };
export type { GitObject };
