/**
 * Execution wiring (B2a Task 11): starts the runner host and connects it to the execution core, in main.
 *
 * - The runner is attached with the platform's own boot id (`platform.bootId`, the one phase A re-owned for).
 * - At every runner `ready` (app start and every runner restart) main sends `reconcile.list` (built from
 *   `exec.reconcileCandidates()`, which records nothing) and calls `exec.reconcileList()` only once the send succeeded
 *   (that call records the request for the reconcile bound: a request that never left is never waited for).
 * - A mid-session runner restart (B2a close): the host's port reads `crashed`/`starting` until the new runner says
 *   `ready`, and the reconcile request at that `ready` stays outstanding until its `reconcile.result`. The core holds
 *   lease expiry for the attempts the old runner held over that whole span, and moves their leases by the downtime when
 *   the answer reaches `recoverPhaseB` (bounded by the reconcile bound; ended at once when the host is `unavailable`).
 *   The ready handler below must therefore call `exec.reconcileList()` synchronously, before any tick can run.
 * - The runner's `reconcile.result` goes to `exec.recoverPhaseB(system, platform.bootId, result)` (the core's own
 *   `onRunnerMessage` never sees it). Phase B's removal list is handed to the runner (`reconcile.remove`; it removes
 *   only resources labelled with this install's `nexus.home` and a `nexus.attempt`) and recorded once
 *   (`exec.orphan_removed`). Resources of this install naming an unknown attempt are logged and left in place.
 * - Once per app start, after the first phase B and before the scheduler's first tick: `exec.recoverBlobStore(system)`.
 *   A mid-session runner restart runs phase B again, never the blob store pass. When the scheduler already ticks (it
 *   started without a reconcile: the runner was unavailable or 2 minutes passed), the pass is skipped for this app start:
 *   it holds the blob store's exclusive lock, and leases and ingests must not wait for it.
 * - The scheduler: `exec.tick` every 1 s once started (it also runs the 30 s approval expiry sweep and the 60 s probe
 *   refresh). It starts after that first phase B, or, when the runner never reconciles (it is unavailable, or 2 minutes
 *   pass), without it (the reconcile bound then ends what phase A left).
 * - The renderer hint push (the hint channel, Task 13): `{ lastSeq }` after runner messages and ticks, coalesced to at most 4 per second, only when
 *   the newest event changed. Each coalesced hint goes to every live target `hintTargets()` names, through
 *   `sendNexusHint` (src/main/nexusIpc/registerNexusIpc.ts, the one place the push is sent), carrying `{ lastSeq }` only.
 * - Log and object reads for the IPC layer: async `fs/promises`, confined to the data home. `execIpcPort` (Task 13) is
 *   what the nexus:* channels #28 (logs), #34 (previews) and #41 (blob GC) call: each authorizes through the platform
 *   first (ExecQueries / BlobIndex), then reads only the stored location (a log path from the attempt row, an object by
 *   its sha256), confined immediately before the read; text is redacted again and paged at MAX_LOG_PAGE (256 KiB).
 *   Fix round 1: a log page holds whole frames only (its start snapped back to a frame start, each frame cleaned as a
 *   unit: host paths cut to their basename, redacted again); a preview's text is redacted WHOLE before it is paged, its
 *   cuts snapped to a code point; preview rows page by a row cursor (`fromRow` / `nextRow`).
 * - Quit (`stop`, bounded at 5 s): live dev deployments are stopped (`stopAllForQuit`), then the runner is told to shut
 *   down (it stops services and leaves tool containers running, so the next start adopts them).
 */
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { NexusPlatform } from '../nexus/platform';
import type { RunnerPort } from '../nexus/exec/runnerPort';
import type { Principal } from '../../shared/nexus/platform';
import { redactSecretText, scrubHostPaths } from '../nexus/activity/redact';
import { PlatformError } from '../nexus/errors';
import { PREVIEW_MAX_OBJECT_BYTES, type PreviewPartId, type PreviewRow } from '../nexus/exec/execQueries';
import { sendNexusHint, type HintTarget } from '../nexusIpc/registerNexusIpc';
import { resolveDataHome, satisfiesLogPathCheck, type DataHome } from './dataHome';
import type { MergeConfirmInfo } from '../nexus/repo/acceptService';
import { startRunnerHost, type ForkRunner, type HostTimers, type RunnerHost } from './runnerHost';

export const TICK_MS = 1_000;
export const HINT_MIN_INTERVAL_MS = 250;
export const STARTUP_RECONCILE_WAIT_MS = 2 * 60_000;
export const STOP_BUDGET_MS = 5_000;
export const MAX_LOG_PAGE = 262_144;
export const MAX_OBJECT_PAGE = 2 ** 20;
/** A preview page: at most MAX_LOG_PAGE bytes of text, or this many rows (also bounded by the page's bytes). */
export const PREVIEW_ROWS_PER_PAGE = 200;
/**
 * Fix round 2: a text preview's whole-content redaction is done ONCE per content, keyed by the sha256 of the raw bytes
 * (content is immutable and content-addressed), and kept in a small LRU bounded by both counts, so paging through one
 * text never redacts it again. Adversarial 4 MiB text cost seconds per page before.
 */
export const PREVIEW_CACHE_ENTRIES = 4;
export const PREVIEW_CACHE_BYTES = 16 * 2 ** 20;
const MAX_ROW_NAME = 512;

export interface WiringTimers extends HostTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}
const REAL: WiringTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as NodeJS.Timeout)
};

export interface LogPage { text: string; nextOffset: number; eof: boolean; truncatedMiddle: boolean }
/**
 * A preview page. Text (`content`): page `page` of `maxBytes` of the REDACTED text, its cuts snapped back to a UTF-8
 * code point (so a page holds at most `maxBytes` + 3 bytes, never a split character); `nextPage`. Rows (`manifest`, `discovery`, `junit_summary`): a row cursor (fix round 1), `fromRow` and
 * `nextRow` (the first row not returned, or null): a byte cap that ends a page early never skips a row.
 */
export interface PreviewPage {
  part: PreviewPartId; versionId: string; text: string | null; rows: PreviewRow[] | null;
  page: number | null; nextPage: number | null; fromRow: number | null; nextRow: number | null; totalRows: number | null; totalBytes: number | null;
}
export interface GcPage { candidates: number; bytes: number; candidatesHash: string; removed: number; fileDeleteFailed: number }

/** What the nexus:* IPC layer reads through main's execution wiring (the data home lives here). Each call authorizes first. */
export interface ExecIpcPort {
  logs(p: Principal, jobId: string, q: { attempt: number; fromOffset: number; maxBytes: number }): Promise<LogPage>;
  preview(p: Principal, versionId: string, q: { part: PreviewPartId; page?: number; fromRow?: number; maxBytes: number }): Promise<PreviewPage>;
  blobsGc(p: Principal, q: { apply: false } | { apply: true; expectedCandidatesHash: string }): Promise<GcPage>;
}

export interface ExecutionHandle extends ExecIpcPort {
  readonly host: RunnerHost;
  readonly dataHome: DataHome;
  /** True once the scheduler ticks. */
  ticking(): boolean;
  /** The renderer hint payloads, at most 4 per second. */
  onHint(fn: (h: { lastSeq: number }) => void): () => void;
  /** A page of an attempt log (`logs/jobs/<jobId>/<n>.log`, as stored), redacted again; whole frames only. */
  readLog(logRel: string, q: { fromOffset: number; maxBytes: number }): Promise<LogPage | null>;
  /** A page of a stored object's bytes (previews), or null when it is not there. */
  readObject(sha256: string, q: { offset: number; maxBytes: number }): Promise<{ bytes: Buffer; nextOffset: number; eof: boolean } | null>;
  /**
   * The "Merge accepted work" dialog (B2b Task 9): main's own confirmation of the commits to be merged, handed to
   * `AcceptService.mergeAccepted` as its `confirm`. True only when the user said yes in the dialog; with no dialog wired,
   * or when it throws, it answers false (a merge is never confirmed on the user's behalf).
   */
  confirmMerge(info: MergeConfirmInfo): Promise<boolean>;
  /**
   * B2b Task 14: one scheduler pass soon (deferred out of the caller's own work, so never inside its transaction): called when
   * a service queued a job (an accept, a merge, an agent turn), so it does not wait for the next 1 s tick. Only once the
   * scheduler ticks (never before the first reconcile); a no-op after `stop`.
   */
  tickSoon(): void;
  /** App quit, bounded at 5 s. */
  stop(): Promise<void>;
}

/** At most one hint per HINT_MIN_INTERVAL_MS, carrying the newest seq, and only when it changed. */
export function hintCoalescer(o: { lastSeq: () => number; emit: (h: { lastSeq: number }) => void; now: () => number; timers: HostTimers }): { poke(): void; cancel(): void } {
  let pending: unknown = null;
  let lastEmitAt = -Infinity;
  let lastSent: number | null = null;
  const fire = (): void => {
    pending = null;
    let seq: number;
    try { seq = o.lastSeq(); } catch { return; }
    if (seq === lastSent) return;
    lastSent = seq; lastEmitAt = o.now();
    try { o.emit({ lastSeq: seq }); } catch { /* a listener's problem */ }
  };
  return {
    poke(): void {
      if (pending !== null) return;
      const wait = Math.max(0, HINT_MIN_INTERVAL_MS - (o.now() - lastEmitAt));
      pending = o.timers.setTimeout(fire, wait);
    },
    cancel(): void { if (pending !== null) { o.timers.clearTimeout(pending); pending = null; } }
  };
}

const isReconcileResult = (raw: unknown): boolean => (raw as { op?: unknown } | null)?.op === 'reconcile.result';

type HomeReads = Pick<DataHome, 'confineToDataHome' | 'objectPath' | 'deleteObjects'> & { readonly root?: string };

/** The host locations a read scrubs out of a page: the data home and userData, as configured and as real paths. */
async function hostRoots(home: HomeReads): Promise<string[]> {
  const root = typeof home.root === 'string' && home.root.length > 0 ? home.root : null;
  if (!root) return [];
  const out = [root, path.dirname(root)];
  for (const p of [root, path.dirname(root)]) { try { out.push(await realpath(p)); } catch { /* not there */ } }
  return out;
}

const isPlainObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** One stored text value as a reader receives it: host paths cut to their basename, then redacted again. */
const cleanText = (s: string, roots: readonly string[]): string => redactSecretText(scrubHostPaths(s, roots));

/**
 * One WHOLE log frame (a JSON line), cleaned as a unit (fix round 1): each string value of the frame has its host paths
 * cut to their basename and is redacted again, the frame is re-serialized; a line that is not a JSON object is cleaned as
 * text. A token can never be reassembled from two reads: the reader never starts or ends inside a frame.
 */
function cleanFrame(line: string, roots: readonly string[]): { text: string; truncatedMiddle: boolean } {
  const eol = line.endsWith('\n') ? '\n' : '';
  const body = eol ? line.slice(0, -1) : line;
  let parsed: unknown = null;
  try { parsed = JSON.parse(body) as unknown; } catch { parsed = null; }
  if (!isPlainObj(parsed)) return { text: cleanText(body, roots) + eol, truncatedMiddle: false };
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(parsed)) {
    out[cleanText(k, roots)] = typeof v === 'string' ? cleanText(v, roots)
      : v === null || typeof v === 'number' || typeof v === 'boolean' ? v : cleanText(JSON.stringify(v) ?? '', roots);
  }
  return { text: JSON.stringify(out) + eol, truncatedMiddle: parsed.truncatedMiddle === true };
}

/**
 * One page of a stored attempt log: `refused` when the stored path fails the log path rule or confinement (a link, a
 * hard link, a path leaving the data home), `missing` when nothing was written yet, `malformed` when a line is longer
 * than a page (the runner writes frames of at most MAX_LINE_CHARS characters; such a line is not one of its frames).
 *
 * Fix round 1: WHOLE FRAMES only, at both ends. `fromOffset` is snapped back to the start of the frame holding it, a page
 * holds at least one frame (a frame longer than `maxBytes` comes whole, never cut: frames end on a newline, so no UTF-8
 * character is split either), and each frame is cleaned as a unit (cleanFrame: host paths cut, redacted again).
 * `nextOffset` is always a frame start. An unterminated last line (the runner mid-write) comes whole as the end.
 */
export async function readLogPage(home: HomeReads, logRel: string, q: { fromOffset: number; maxBytes: number }):
  Promise<LogPage | 'refused' | 'missing' | 'malformed'> {
  if (typeof logRel !== 'string' || !logRel.startsWith('logs/jobs/') || !satisfiesLogPathCheck(logRel)) return 'refused';
  const from = Number.isSafeInteger(q?.fromOffset) && q.fromOffset >= 0 ? q.fromOffset : 0;
  const max = Number.isSafeInteger(q?.maxBytes) && q.maxBytes > 0 ? Math.min(q.maxBytes, MAX_LOG_PAGE) : MAX_LOG_PAGE;
  const abs = await home.confineToDataHome(logRel);
  if (!abs) return 'refused';
  let fh;
  try { fh = await open(abs, 'r'); } catch { return 'missing'; }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return 'refused';
    const size = st.size;
    if (from >= size) return { text: '', nextOffset: size, eof: true, truncatedMiddle: false };
    // 1. Back to the start of the frame holding `from` (the byte after the newline before it).
    let start = 0;
    if (from > 0) {
      const lookFrom = Math.max(0, from - MAX_LOG_PAGE);
      const back = Buffer.alloc(from - lookFrom);
      const { bytesRead } = await fh.read(back, 0, back.length, lookFrom);
      const nl = back.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (nl >= 0) start = lookFrom + nl + 1;
      else if (lookFrom > 0) return 'malformed';
    }
    // 2. Whole frames from there: at least one, then every next one that still fits in `maxBytes`.
    const buf = Buffer.alloc(Math.min(MAX_LOG_PAGE, size - start));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const chunk = buf.subarray(0, bytesRead);
    const frames: string[] = [];
    let used = 0;
    while (used < chunk.length) {
      const nl = chunk.indexOf(0x0a, used);
      let end: number;
      if (nl >= 0) end = nl + 1;
      else if (start + chunk.length >= size) end = chunk.length;          // the unterminated last line
      else if (frames.length === 0) return 'malformed';                  // a line longer than a page
      else break;
      if (frames.length > 0 && end > max) break;
      frames.push(chunk.subarray(used, end).toString('utf8'));
      used = end;
    }
    const roots = await hostRoots(home);
    let truncatedMiddle = false;
    const text = frames.map((f) => { const c = cleanFrame(f, roots); if (c.truncatedMiddle) truncatedMiddle = true; return c.text; }).join('');
    const next = start + used;
    return { text, nextOffset: next, eof: next >= size, truncatedMiddle };
  } finally { await fh.close(); }
}

/**
 * A stored object's whole bytes (at most `maxBytes`; previews), or null when it is not there or confinement refuses it,
 * `'too_large'` when it is larger.
 */
async function readWholeObject(home: HomeReads, sha256: string, maxBytes: number): Promise<Buffer | 'too_large' | null> {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const abs = await home.objectPath(sha256);
  if (!abs) return null;
  let fh;
  try { fh = await open(abs, 'r'); } catch { return null; }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    if (st.size > maxBytes) return 'too_large';
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

/** `x` moved back to the start of the UTF-8 code point it falls in (a cut never splits a character). */
export function snapToCodePoint(buf: Buffer, x: number): number {
  let i = Math.max(0, Math.min(x, buf.length));
  while (i > 0 && i < buf.length && (buf[i] & 0xc0) === 0x80) i--;
  return i;
}

/** One page of a stored object's bytes, or null when it is not there or confinement refuses it. */
export async function readObjectPage(home: HomeReads, sha256: string, q: { offset: number; maxBytes: number }):
  Promise<{ bytes: Buffer; nextOffset: number; eof: boolean; size: number } | null> {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const abs = await home.objectPath(sha256);
  if (!abs) return null;
  const off = Number.isSafeInteger(q?.offset) && q.offset >= 0 ? q.offset : 0;
  const max = Number.isSafeInteger(q?.maxBytes) && q.maxBytes > 0 ? Math.min(q.maxBytes, MAX_OBJECT_PAGE) : MAX_OBJECT_PAGE;
  let fh;
  try { fh = await open(abs, 'r'); } catch { return null; }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const size = st.size;
    if (off >= size) return { bytes: Buffer.alloc(0), nextOffset: size, eof: true, size };
    const buf = Buffer.alloc(Math.min(max, size - off));
    const { bytesRead } = await fh.read(buf, 0, buf.length, off);
    return { bytes: buf.subarray(0, bytesRead), nextOffset: off + bytesRead, eof: off + bytesRead >= size, size };
  } finally { await fh.close(); }
}

const execOff = (p: NexusPlatform): never => {
  throw new PlatformError('platform_unavailable', 'execution is not available', { reason: 'execution_unavailable', subReason: p.exec.unavailableReason ?? 'not_enabled' });
};
const rowOf = (r: PreviewRow): PreviewRow => ({
  name: redactSecretText(String(r.name)).slice(0, MAX_ROW_NAME), detail: r.detail === null ? null : redactSecretText(String(r.detail)).slice(0, MAX_ROW_NAME),
  bytes: typeof r.bytes === 'number' && Number.isFinite(r.bytes) ? r.bytes : null, outcome: r.outcome === null ? null : String(r.outcome).slice(0, 64)
});

/**
 * The IPC port over a platform and its data home (main's handle uses it; tests build it over a test data home). Every
 * method authorizes through the platform first and never reads a location the renderer named.
 */
export function execIpcPort(platform: NexusPlatform, home: HomeReads, opts: { redact?: (s: string) => string } = {}): ExecIpcPort {
  const redact = opts.redact ?? redactSecretText;
  /** Redacted preview text by the sha256 of its raw bytes, least recently used first (PREVIEW_CACHE_*). */
  const redacted = new Map<string, Buffer>();
  let redactedBytes = 0;
  const redactOnce = (raw: Buffer): Buffer => {
    const key = createHash('sha256').update(raw).digest('hex');
    const hit = redacted.get(key);
    if (hit) { redacted.delete(key); redacted.set(key, hit); return hit; }
    const out = Buffer.from(redact(raw.toString('utf8')), 'utf8');
    if (out.length <= PREVIEW_CACHE_BYTES) {
      redacted.set(key, out); redactedBytes += out.length;
      for (const [k, v] of redacted) {
        if (redacted.size <= PREVIEW_CACHE_ENTRIES && redactedBytes <= PREVIEW_CACHE_BYTES) break;
        redacted.delete(k); redactedBytes -= v.length;
      }
    }
    return out;
  };
  return {
    async logs(p, jobId, q) {
      const queries = platform.queries ?? execOff(platform);
      const ref = queries.attemptLog(p, jobId, q.attempt);
      if (ref.logRel === null) return { text: '', nextOffset: 0, eof: true, truncatedMiddle: false };
      const page = await readLogPage(home, ref.logRel, q);
      if (page === 'refused') throw new PlatformError('storage_unavailable', 'the stored log location was refused', { jobId, reason: 'log_refused' });
      if (page === 'malformed') throw new PlatformError('storage_unavailable', 'the stored log is not in the log format', { jobId, reason: 'log_malformed' });
      if (page === 'missing') return { text: '', nextOffset: 0, eof: true, truncatedMiddle: false };
      return page;
    },
    async preview(p, versionId, q) {
      const queries = platform.queries ?? execOff(platform);
      const max = Number.isSafeInteger(q.maxBytes) && q.maxBytes > 0 ? Math.min(q.maxBytes, MAX_LOG_PAGE) : MAX_LOG_PAGE;
      const base = { part: q.part, versionId };
      const textPage = (raw: Buffer): PreviewPage => {
        const page = Number.isSafeInteger(q.page) && q.page! >= 0 ? q.page! : 0;
        // The WHOLE content is redacted first, then paged (fix round 1): a cut can never split a secret into two pages that
        // each pass the redactor. It is redacted once per content (fix round 2: redactOnce), so later pages cost a hash.
        const all = redactOnce(raw);
        const total = all.length;
        // Fixed page boundaries, each snapped back to a code point (a character is never split between two pages).
        const s = snapToCodePoint(all, Math.min(page * max, total));
        const e = snapToCodePoint(all, Math.min((page + 1) * max, total));
        return { ...base, text: all.subarray(s, Math.max(s, e)).toString('utf8'), rows: null, page, nextPage: (page + 1) * max < total ? page + 1 : null,
          fromRow: null, nextRow: null, totalRows: null, totalBytes: total };
      };
      if (q.part === 'diff') {
        // B2b Task 14 (F19): a change set's patch between its RECORDED base and head, by the runner's bounded git read (1 MiB per
        // side), only through the accept service (which refuses every other kind); the renderer names no commit.
        const accepts = platform.accepts ?? (() => { throw new PlatformError('invalid', 'there is no diff to preview', { reason: 'no_such_part' }); })();
        const d = await accepts.diff(p, versionId);
        return textPage(Buffer.from(d.patch, 'utf8'));
      }
      const src = queries.previewSource(p, versionId, q.part);
      if (src.type === 'rows') {
        // A row cursor (fix round 1): the next page starts at the first row this one did not return.
        const from = Number.isSafeInteger(q.fromRow) && q.fromRow! >= 0 ? q.fromRow! : 0;
        const rows: PreviewRow[] = [];
        let used = 0;
        for (let i = from; i < src.rows.length && rows.length < PREVIEW_ROWS_PER_PAGE; i++) {
          const r = rowOf(src.rows[i]);
          used += Buffer.byteLength(JSON.stringify(r), 'utf8');
          if (used > max && rows.length > 0) break;
          rows.push(r);
        }
        const end = Math.min(from, src.rows.length) + rows.length;
        return { ...base, text: null, rows, page: null, nextPage: null, fromRow: from, nextRow: end < src.rows.length ? end : null,
          totalRows: src.rows.length, totalBytes: null };
      }
      // Text is at most PREVIEW_MAX_OBJECT_BYTES.
      let raw: Buffer;
      if (src.type === 'text') raw = Buffer.from(src.text, 'utf8');
      else {
        const r = await readWholeObject(home, src.sha256, PREVIEW_MAX_OBJECT_BYTES);
        if (r === 'too_large') throw new PlatformError('too_large', 'the stored content is too large to preview', { versionId });
        if (!r) throw new PlatformError('storage_unavailable', 'the stored content could not be read', { versionId });
        if (r.includes(0)) throw new PlatformError('invalid', 'the stored content is not text', { reason: 'binary_content' });
        raw = r;
      }
      return textPage(raw);
    },
    async blobsGc(p, q) {
      const blobs = platform.blobs ?? execOff(platform);
      if (!q.apply) {
        const d = blobs.gcDryRun(p);
        return { candidates: d.candidates.length, bytes: d.totalBytes, candidatesHash: d.candidatesHash, removed: 0, fileDeleteFailed: 0 };
      }
      // The sizes of what the apply may remove (authorized like the apply: a denial is audited once and nothing runs).
      const sizes = new Map(blobs.gcDryRun(p).candidates.map((c) => [c.sha256, c.bytes]));
      const r = await blobs.gcApply(p, q.expectedCandidatesHash, (shas) => home.deleteObjects(shas));
      // Fix round 1: the bytes actually freed, the files of the removed rows that were deleted (a failed delete frees none).
      const failed = new Set(r.fileDeleteFailed);
      const freed = r.removedShas.reduce((n, s) => n + (failed.has(s) ? 0 : (sizes.get(s) ?? 0)), 0);
      return { candidates: r.removedShas.length, bytes: freed, candidatesHash: q.expectedCandidatesHash, removed: r.removedShas.length - r.fileDeleteFailed.length,
        fileDeleteFailed: r.fileDeleteFailed.length };
    }
  };
}

export async function startExecution(o: { platform: NexusPlatform; userData: string; log: (line: string) => void;
  fork?: ForkRunner; timers?: WiringTimers; now?: () => number;
  /** The renderers the nexus:hint push goes to (main: its live web contents), read at each hint. */
  hintTargets?: () => readonly (HintTarget | null | undefined)[];
  /** B2b Task 9: main's native dialog for "Merge accepted work" (index.ts); omitted, every merge answers cancelled. */
  mergeDialog?: (info: MergeConfirmInfo) => Promise<boolean> }): Promise<ExecutionHandle | null> {
  const p = o.platform;
  const log = o.log;
  if (!p.executionAvailable) { log('[nexus] execution not started: execution is not available on this database'); return null; }
  const timers = o.timers ?? REAL;
  const now = o.now ?? Date.now;
  const dataHome = resolveDataHome(o.userData);
  await dataHome.ensure();
  const exec = p.exec;
  const system = p.principals.system();
  const host = startRunnerHost({ fork: o.fork, log, timers, now });
  const hintListeners = new Set<(h: { lastSeq: number }) => void>();
  const hint = hintCoalescer({ lastSeq: () => exec.lastEventSeq(), now, timers,
    emit: (h) => {
      for (const f of [...hintListeners]) { try { f(h); } catch { /* listener */ } }
      let targets: readonly (HintTarget | null | undefined)[] = [];
      try { targets = o.hintTargets?.() ?? []; } catch { targets = []; }
      for (const t of targets) if (t) sendNexusHint(t, h.lastSeq);
    } });
  const port = execIpcPort(p, dataHome);
  const startedAt = now();
  let firstPhaseB = true;
  let ticking = false;
  let stopped = false;

  const startTicking = (why: string): void => {
    if (ticking || stopped) return;
    ticking = true;
    log(`[nexus] execution scheduler started (${why})`);
  };

  const onReconcile = async (raw: unknown): Promise<void> => {
    const r = raw as { docker?: unknown; attempts?: unknown; labelled?: unknown };
    let report: ReturnType<typeof exec.recoverPhaseB> | null = null;
    try {
      report = exec.recoverPhaseB(system, p.bootId, { docker: r.docker as 'running', attempts: r.attempts as never, labelled: r.labelled as never });
    } catch (e) {
      log(`[nexus] execution recovery at runner ready was not applied: ${(e as { code?: string })?.code ?? (e as Error)?.name ?? 'error'}`);
    }
    if (report && report.remove.length > 0) {
      try {
        host.port.send({ op: 'reconcile.remove', resources: report.remove.map((x) => ({ kind: x.kind, id: x.id })) });
        exec.recordOrphanRemoval(system, report.remove);
      } catch (e) { log(`[nexus] leftover sandbox resources were not handed to the runner (${(e as Error)?.name ?? 'error'})`); }
    }
    if (report && report.unknown.length > 0) log(`[nexus] ${report.unknown.length} labelled sandbox resource(s) name an attempt this database does not know; left in place`);
    if (firstPhaseB && !stopped) {
      firstPhaseB = false;
      if (ticking) {
        // The scheduler already ticks (it started without a reconcile): no blob store pass this app start.
        log('[nexus] blob store hygiene skipped: the scheduler started before the first reconcile');
      } else {
        // Once per app start, after phase B and before the first tick.
        try { await exec.recoverBlobStore(system); } catch (e) { log(`[nexus] blob store hygiene did not run (${(e as Error)?.name ?? 'error'})`); }
        startTicking('after restart recovery');
      }
    }
    hint.poke();
  };

  host.port.onMessage((raw) => {
    if (stopped) return;
    const op = (raw as { op?: unknown } | null)?.op;
    if (op === 'ready') {
      // The request is recorded (reconcileList) only once it was sent.
      let sent = false;
      try { host.port.send({ op: 'reconcile.list', attempts: exec.reconcileCandidates() }); sent = true; } catch (e) {
        log(`[nexus] reconcile request not sent (${(e as Error)?.name ?? 'error'})`);
      }
      if (sent) exec.reconcileList();
    } else if (op === 'reconcile.result') {
      void onReconcile(raw);
      return;
    }
    hint.poke();
  });

  // The core's port: every runner message except the reconcile answer (routed above).
  const execPort: RunnerPort = {
    state: () => host.port.state(),
    send: (m) => host.port.send(m),
    onMessage: (fn) => host.port.onMessage((raw) => { if (!isReconcileResult(raw)) fn(raw); })
  };
  exec.attachRunner(execPort, p.bootId);

  const interval = timers.setInterval(() => {
    if (stopped) return;
    if (!ticking) {
      if (host.state() === 'unavailable') startTicking('the runner is unavailable');
      else if (now() - startedAt >= STARTUP_RECONCILE_WAIT_MS) startTicking('the runner did not reconcile in time');
      if (!ticking) return;
    }
    exec.tick(now());
    hint.poke();
  }, TICK_MS);

  return {
    host, dataHome,
    ticking: () => ticking,
    onHint(fn) { hintListeners.add(fn); return () => { hintListeners.delete(fn); }; },
    async readLog(logRel, q) {
      const page = await readLogPage(dataHome, logRel, q);
      return page === 'refused' || page === 'missing' || page === 'malformed' ? null : page;
    },
    async readObject(sha256, q) {
      const r = await readObjectPage(dataHome, sha256, q);
      return r ? { bytes: r.bytes, nextOffset: r.nextOffset, eof: r.eof } : null;
    },
    logs: port.logs, preview: port.preview, blobsGc: port.blobsGc,
    async confirmMerge(info) {
      if (!o.mergeDialog) return false;
      try { return (await o.mergeDialog(info)) === true; } catch (e) { log(`[nexus] the merge dialog failed (${(e as Error)?.name ?? 'error'}); nothing was merged`); return false; }
    },
    tickSoon() {
      if (!ticking || stopped) return;
      timers.setTimeout(() => { if (ticking && !stopped) { exec.tick(now()); hint.poke(); } }, 0);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(interval);
      hint.cancel();
      try { p.deployments?.stopAllForQuit(); } catch (e) { log(`[nexus] dev deployments were not stopped for quit (${(e as Error)?.name ?? 'error'})`); }
      // host.stop is bounded at STOP_BUDGET_MS (it kills the runner after that).
      await host.stop();
    }
  };
}
