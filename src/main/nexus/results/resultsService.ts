/**
 * The results of a Machine learning project (phase 3: results). No database schema change: the files live in the data home
 * (src/shared/nexus/results.ts has the layout and the rules) and were written by sandboxed code, so every one is untrusted.
 *
 * - list: the project's results folder, FLAT (its top-level entries only; at most RESULTS_SCAN_MAX are looked at). Each entry is lstat'ed:
 *   a link (symbolic or junction), a second hard link, a folder or anything that is not a regular file, a name that is not plain
 *   (isPlainResultName) or a kind Nexus does not keep is LEFT OUT (counted, never named). A kept file is opened once, never through a link
 *   (O_NOFOLLOW where the platform has it, O_NONBLOCK so a FIFO swapped in cannot hang main), the handle must be the very file lstat saw
 *   (device, file id, link count), and its first bytes decide its kind with its extension (classifyResult: a fake PNG is never a chart).
 *   Newest first, at most RESULTS_MAX_LISTED. Each result has an id main derives from its name; the answer never holds a location.
 * - read: a shown report's text (at most REPORT_READ_MAX_BYTES, every control and invisible character removed: inert text) or a shown
 *   chart's bytes as a `data:image/png;base64,` URL (at most CHART_SHOW_MAX_BYTES, its PNG header checked again on the bytes read).
 * - save: main's own Save window (the `pickSavePath` port; the renderer never sends or receives a location) names where a copy goes. A place
 *   inside the data home is refused. The copy is written next to it under a temporary name (`wx`), its size checked against the source
 *   handle's, then renamed over the chosen name (the window itself asked before replacing a file) and checked again.
 * - remove: Nexus's copy of one result, after confirming it is a plain file directly inside this project's results folder (the data
 *   home's own confinement, then lstat). clear: every top-level entry of the folder (a link is removed, never followed).
 * - usage: the count and the bytes of the folder for the AI helper's context (no file opened).
 * An id that is not in the fresh listing is refused: nothing is ever read, saved or removed by a name the renderer sent.
 */
import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import type { Principal } from '../../../shared/nexus/platform';
import { decodeText } from '../../../shared/nexus/datasets';
import {
  CHART_SHOW_MAX_BYTES, REPORT_READ_MAX_BYTES, RESULT_ID_RE, RESULT_MAX_BYTES, RESULT_REASON_MESSAGES, RESULT_SNIFF_BYTES, RESULTS_MAX_LISTED,
  RESULTS_SCAN_MAX, classifyResult, cleanReportText, isPlainResultName, isShowablePng, overResultsLimit, resultsFilesRel, type ResultKind
} from '../../../shared/nexus/results';
import { PlatformError } from '../errors';
import { isMachineLearningProject } from '../exec/sandboxProfile';
import type { ProjectAccess } from '../project/projectAccess';

/** The data home surface the service needs: its root and the confinement of a relative path (links refused at every existing step). */
export interface ResultsDataHome { readonly root: string; confineToDataHome(rel: string): Promise<string | null> }
export interface ResultsServiceDeps { dataHome: ResultsDataHome; projects: ProjectAccess; now: () => number; log?: (line: string) => void }
/** Main's own Save window: the chosen location for a copy named `defaultName`, or null when the person closed it. */
export type PickSavePath = (defaultName: string) => Promise<string | null>;

/** One result as main lists it. `name` is plain by construction (isPlainResultName), so it may be shown. */
export interface ResultEntry { id: string; name: string; kind: ResultKind; bytes: number; modifiedAt: number; shown: boolean; tooBig: boolean }
export interface ResultsList {
  applies: boolean; results: ResultEntry[];
  /** Entries left out (a link, a folder, a name that is not plain, a kind Nexus does not keep, a file that changed while it was read). */
  skipped: number;
  /** Plain results beyond RESULTS_MAX_LISTED (the oldest), not listed. */
  more: number;
  totalBytes: number; overLimit: boolean;
}
export type ResultContent = { id: string; kind: 'report'; text: string; truncated: boolean } | { id: string; kind: 'chart'; dataUrl: string };

const NOFOLLOW: number = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const NONBLOCK: number = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0;
const CHUNK = 1024 * 1024;
const refuse = (reason: string, code: 'invalid' | 'not_found' | 'conflict' = 'invalid'): never => {
  throw new PlatformError(code, RESULT_REASON_MESSAGES[reason] ?? 'Nexus could not do that.', { reason });
};
const errCode = (e: unknown): string => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '');

/** The id of a result: the first 32 hex characters of a sha256 over its name (stable while the file keeps its name). */
export function resultIdOf(name: string): string {
  return createHash('sha256').update(`nexus-result\0${name}`, 'utf8').digest('hex').slice(0, 32);
}

/** Whether `p` is the folder `root` or inside it (case-insensitive on Windows). */
function isInside(root: string, p: string): boolean {
  const norm = (x: string): string => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
  const r = path.relative(norm(root), norm(p));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

interface Scanned { name: string; bytes: number; mtimeMs: number }

export class ResultsService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly db: Database.Database, private readonly deps: ResultsServiceDeps) {}

  /** The project's results as the person sees them (`applies` false for any project that is not a Machine learning project). */
  async list(p: Principal, projectId: string): Promise<ResultsList> {
    this.deps.projects.require(p, projectId, 'project.read');
    if (!isMachineLearningProject(this.db, projectId)) return { applies: false, results: [], skipped: 0, more: 0, totalBytes: 0, overLimit: false };
    return this.listOf(projectId);
  }

  /** A shown report's inert text, or a shown chart as a bounded PNG data URL. */
  async read(p: Principal, projectId: string, resultId: string): Promise<ResultContent> {
    this.deps.projects.require(p, projectId, 'project.read');
    const { entry, file } = await this.find(projectId, resultId);
    if (!entry.shown) return refuse('results_not_shown');
    if (entry.kind === 'report') {
      const bytes = await this.readPlain(file, REPORT_READ_MAX_BYTES, Number.MAX_SAFE_INTEGER);
      return { id: entry.id, kind: 'report', text: cleanReportText(decodeText(bytes)), truncated: entry.bytes > REPORT_READ_MAX_BYTES };
    }
    if (entry.kind === 'chart') {
      const bytes = await this.readPlain(file, CHART_SHOW_MAX_BYTES, CHART_SHOW_MAX_BYTES);
      // The header again, on the very bytes that will be shown.
      if (!isShowablePng(bytes)) return refuse('results_not_shown');
      return { id: entry.id, kind: 'chart', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
    }
    return refuse('results_not_shown');
  }

  /** Copies one result to a place the person picks in main's own Save window. `{ cancelled: true }` when the window was closed. */
  async save(p: Principal, projectId: string, resultId: string, pick: PickSavePath): Promise<{ cancelled: true } | { saved: true; name: string }> {
    this.deps.projects.require(p, projectId, 'project.read');
    const { entry, file } = await this.find(projectId, resultId);
    if (entry.tooBig) return refuse('results_too_big');
    let target: string | null;
    try { target = await pick(entry.name); } catch { return refuse('results_no_window'); }
    if (target === null || target === undefined) return { cancelled: true };
    if (typeof target !== 'string' || target.length === 0 || target.length > 4096 || target.includes('\0') || !path.isAbsolute(target)) return refuse('results_save_failed');
    target = path.resolve(target);
    // Never into Nexus's own data home (its records, the projects' data, other results), also through a linked folder.
    const root = this.deps.dataHome.root;
    let realRoot = root;
    try { realRoot = await realpath(root); } catch { /* not there yet */ }
    let realDir: string;
    try { realDir = await realpath(path.dirname(target)); } catch { return refuse('results_save_failed'); }
    if (isInside(root, target) || isInside(realRoot, target) || isInside(root, realDir) || isInside(realRoot, realDir)) return refuse('results_save_inside');
    const dest = path.join(realDir, path.basename(target));
    const tmp = path.join(realDir, `.${randomBytes(6).toString('hex')}.nexus-save.part`);
    const src = await this.openPlain(file);
    let out: Awaited<ReturnType<typeof open>> | null = null;
    let renamed = false;
    try {
      const size = src.size;
      if (size > RESULT_MAX_BYTES) return refuse('results_too_big');
      try { out = await open(tmp, 'wx'); } catch { return refuse('results_save_failed'); }
      const buf = Buffer.alloc(CHUNK);
      let total = 0;
      for (;;) {
        let n: number;
        try { n = (await src.fh.read(buf, 0, CHUNK, total)).bytesRead; } catch { return refuse('results_changed'); }
        if (n === 0) break;
        if (total + n > size) return refuse('results_changed');
        try { await out.write(buf, 0, n); } catch { return refuse('results_save_failed'); }
        total += n;
      }
      if (total !== size) return refuse('results_changed');
      await out.close(); out = null;
      try { await rename(tmp, dest); renamed = true; } catch { return refuse('results_save_failed'); }
      let st;
      try { st = await stat(dest); } catch { return refuse('results_save_failed'); }
      if (!st.isFile() || st.size !== size) return refuse('results_save_failed');
      return { saved: true, name: entry.name };
    } finally {
      try { await out?.close(); } catch { /* closed */ }
      try { await src.fh.close(); } catch { /* closed */ }
      if (!renamed) { try { await unlink(tmp); } catch { /* never made, or gone */ } }
    }
  }

  /** Removes Nexus's copy of one result (a plain file directly inside this project's results folder). */
  async remove(p: Principal, projectId: string, resultId: string): Promise<{ removed: true }> {
    this.deps.projects.require(p, projectId, 'artifact.create');
    return this.locked(projectId, async () => {
      const { entry, file } = await this.find(projectId, resultId);
      // Confined by the data home's own rules (no link on the way, no device name, no `..`), and exactly this folder's child.
      const confined = await this.deps.dataHome.confineToDataHome(`${resultsFilesRel(projectId)}/${entry.name}`);
      if (!confined || path.resolve(confined) !== path.resolve(file)) return refuse('results_not_found', 'not_found');
      let st;
      try { st = await lstat(file); } catch { return refuse('results_not_found', 'not_found'); }
      if (st.isSymbolicLink() || !st.isFile()) return refuse('results_not_found', 'not_found');
      try { await unlink(file); } catch (e) {
        const c = errCode(e);
        if (c === 'EBUSY' || c === 'EPERM' || c === 'EACCES') return refuse('results_in_use', 'conflict');
        if (c !== 'ENOENT') throw e;
      }
      return { removed: true as const };
    });
  }

  /** Removes every top-level entry of the project's results folder (a link is removed itself, never followed). */
  async clear(p: Principal, projectId: string): Promise<{ cleared: number; failed: number }> {
    this.deps.projects.require(p, projectId, 'artifact.create');
    if (!isMachineLearningProject(this.db, projectId)) return refuse('results_not_ml');
    return this.locked(projectId, async () => {
      const dir = await this.filesDir(projectId);
      if (!dir) return { cleared: 0, failed: 0 };
      let cleared = 0; let failed = 0;
      const d = await opendir(dir);
      const names: string[] = [];
      try { for await (const e of d) { names.push(e.name); if (names.length >= RESULTS_SCAN_MAX) break; } } finally { try { await d.close(); } catch { /* closed */ } }
      for (const name of names) {
        const full = path.join(dir, name);
        if (path.dirname(full) !== dir) { failed++; continue; }
        try {
          const st = await lstat(full);
          if (st.isDirectory() && !st.isSymbolicLink()) await rm(full, { recursive: true, force: true });
          else await unlink(full);
          cleared++;
        } catch { failed++; }
      }
      return { cleared, failed };
    });
  }

  /** Main's own read for the AI helper's context: how many plain results there are and their bytes (no file is opened). */
  async usage(projectId: string): Promise<{ files: number; totalBytes: number; overLimit: boolean }> {
    try {
      const s = await this.scan(projectId);
      return { files: s.kept.length, totalBytes: s.totalBytes, overLimit: overResultsLimit(s.totalBytes) };
    } catch { return { files: 0, totalBytes: 0, overLimit: false }; }
  }

  // ---------- internals ----------

  private async locked<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(projectId, tail);
    try { return await run; } finally { if (this.locks.get(projectId) === tail) this.locks.delete(projectId); }
  }

  /** `results/<projectId>/files`, confined (no link on the way) and a real folder; null when it does not exist. Never created here. */
  private async filesDir(projectId: string): Promise<string | null> {
    let rel: string;
    try { rel = resultsFilesRel(projectId); } catch { return refuse('results_not_found', 'not_found'); }
    const abs = await this.deps.dataHome.confineToDataHome(rel);
    if (!abs) return null;
    try { const st = await lstat(abs); return st.isDirectory() && !st.isSymbolicLink() ? path.resolve(abs) : null; } catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; }
  }

  /** The folder's top-level plain regular files (lstat only), the left-out count and the bytes of every regular file. */
  private async scan(projectId: string): Promise<{ dir: string | null; kept: Scanned[]; skipped: number; totalBytes: number }> {
    const dir = await this.filesDir(projectId);
    if (!dir) return { dir: null, kept: [], skipped: 0, totalBytes: 0 };
    const kept: Scanned[] = [];
    let skipped = 0; let totalBytes = 0; let seen = 0;
    const d = await opendir(dir);
    try {
      for await (const e of d) {
        if (++seen > RESULTS_SCAN_MAX) { skipped++; continue; }
        let st;
        try { st = await lstat(path.join(dir, e.name)); } catch { skipped++; continue; }
        if (st.isFile() && !st.isSymbolicLink()) totalBytes += st.size;
        if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1 || !isPlainResultName(e.name)) { skipped++; continue; }
        kept.push({ name: e.name, bytes: st.size, mtimeMs: st.mtimeMs });
      }
    } finally { try { await d.close(); } catch { /* closed */ } }
    return { dir, kept, skipped, totalBytes };
  }

  private async listOf(projectId: string): Promise<ResultsList> {
    const s = await this.scan(projectId);
    if (!s.dir) return { applies: true, results: [], skipped: 0, more: 0, totalBytes: 0, overLimit: false };
    const sorted = [...s.kept].sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const top = sorted.slice(0, RESULTS_MAX_LISTED);
    let skipped = s.skipped;
    const results: ResultEntry[] = [];
    for (const f of top) {
      let head: Buffer;
      try { head = await this.readPlain(path.join(s.dir, f.name), Math.min(f.bytes, RESULT_SNIFF_BYTES), Number.MAX_SAFE_INTEGER); } catch { skipped++; continue; }
      const c = classifyResult(f.name, head, f.bytes);
      results.push({ id: resultIdOf(f.name), name: f.name, kind: c.kind, bytes: f.bytes, modifiedAt: Math.round(f.mtimeMs), shown: c.shown, tooBig: f.bytes > RESULT_MAX_BYTES });
    }
    return { applies: true, results, skipped, more: sorted.length - top.length, totalBytes: s.totalBytes, overLimit: overResultsLimit(s.totalBytes) };
  }

  /** The listed result with this id (a fresh listing; an id it does not hold is refused) and its absolute path. */
  private async find(projectId: string, resultId: string): Promise<{ entry: ResultEntry; file: string }> {
    if (!isMachineLearningProject(this.db, projectId)) return refuse('results_not_ml');
    if (typeof resultId !== 'string' || !RESULT_ID_RE.test(resultId)) return refuse('results_not_found', 'not_found');
    const l = await this.listOf(projectId);
    const entry = l.results.find((r) => r.id === resultId);
    const dir = await this.filesDir(projectId);
    if (!entry || !dir) return refuse('results_not_found', 'not_found');
    const file = path.join(dir, entry.name);
    if (path.dirname(file) !== dir) return refuse('results_not_found', 'not_found');
    return { entry, file };
  }

  /** Opens a plain file the sandbox may have written: lstat, open without following a link (and without blocking), the same file checked. */
  private async openPlain(file: string): Promise<{ fh: Awaited<ReturnType<typeof open>>; size: number }> {
    let st;
    try { st = await lstat(file, { bigint: true }); } catch { return refuse('results_not_found', 'not_found'); }
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1n) return refuse('results_not_found', 'not_found');
    let fh;
    try { fh = await open(file, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK); } catch { return refuse('results_not_found', 'not_found'); }
    try {
      const s2 = await fh.stat({ bigint: true });
      if (!s2.isFile() || s2.dev !== st.dev || s2.ino !== st.ino || s2.nlink !== st.nlink) { await fh.close(); return refuse('results_changed'); }
      return { fh, size: Number(s2.size) };
    } catch (e) {
      try { await fh.close(); } catch { /* closed */ }
      throw e;
    }
  }

  /** At most `want` bytes from the start of a plain file; refused when the file is larger than `maxSize`. */
  private async readPlain(file: string, want: number, maxSize: number): Promise<Buffer> {
    const { fh, size } = await this.openPlain(file);
    try {
      if (size > maxSize) return refuse('results_not_shown');
      const buf = Buffer.alloc(Math.max(0, Math.min(want, size)));
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    } finally { try { await fh.close(); } catch { /* closed */ } }
  }
}
