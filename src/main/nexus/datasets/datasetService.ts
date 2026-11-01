/**
 * The data a person adds to a Machine learning project (phase 2: upload and delivery). No database schema change: everything lives in
 * the data home (src/shared/nexus/datasets.ts has the layout and the rules).
 *
 * - add: main's own file window (the `pick` port; the renderer never sends or receives a location) names one file. It is refused, each
 *   with one plain sentence, when its extension is not allowed, it is a link or a shortcut (lstat: never followed), not a plain file,
 *   empty, over 200 MB, or would take the project past 20 files or 1 GB. It is opened ONCE; the open handle must be the very file lstat
 *   saw (same device and file id), and every byte is read through it: copied in a stream (never whole in memory) into a copy in progress,
 *   hashed (sha256) and, for delimited text, its rows counted on the way. The start (and for Parquet the end) must be what the extension
 *   says. Only then is the copy renamed into the project's files folder under a name main makes, and the manifest written (a temp file,
 *   then a rename). The person's file is only ever read.
 * - remove: Nexus's copy and its record go; the person's original was never Nexus's to touch.
 * - list: the records (never a location), whether the project is a Machine learning project (the sandbox's own rule,
 *   `isMachineLearningProject`), and whether the manifest was damaged (it then reads as empty, and the next write clears the old copies).
 * - records: the same records for main itself (the AI helper's context block); a damaged manifest is no data.
 * One add at a time (a second is refused `dataset_busy`); writes to one project's folder are serialised.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Principal } from '../../../shared/nexus/platform';
import {
  DATASET_MAX_BYTES, DATASET_REASON_MESSAGES, DATASETS_MAX_PER_PROJECT, DATASETS_MAX_TOTAL_BYTES, DELIMITED_EXTENSIONS, MANIFEST_MAX_BYTES,
  ROW_COUNT_MAX_MS, RowCounter, SNIFF_BYTES, datasetsProjectRel, delimiterOf, displayNameOf, extensionOf, firstLineOf, isShortcutName, manifestText,
  parseHeader, parseManifest, safeFileName, sniffOk, type DatasetRecord
} from '../../../shared/nexus/datasets';
import { newId } from '../db/ids';
import { PlatformError } from '../errors';
import { isMachineLearningProject } from '../exec/sandboxProfile';
import type { ProjectAccess } from '../project/projectAccess';

/** The data home surface the service needs: confinement of a relative path (links refused at every existing step). */
export interface DatasetDataHome { readonly root: string; confineToDataHome(rel: string): Promise<string | null> }
export interface DatasetServiceDeps {
  dataHome: DatasetDataHome; projects: ProjectAccess; now: () => number; log?: (line: string) => void;
  /** Whether the AI service in use runs on this computer (the live permission's runtime); false when unknown. */
  aiOnThisComputer?: () => boolean;
}
/** Main's file window: the chosen file's location, or null when the person closed it. Never called with anything from the renderer. */
export type PickFile = () => Promise<string | null>;
export interface DatasetList { applies: boolean; datasets: DatasetRecord[]; damaged: boolean; aiOnThisComputer: boolean }

const CHUNK = 1024 * 1024;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const refuse = (reason: keyof typeof DATASET_REASON_MESSAGES | string, code: 'invalid' | 'not_found' | 'conflict' = 'invalid'): never => {
  throw new PlatformError(code, DATASET_REASON_MESSAGES[reason] ?? 'Nexus could not do that.', { reason });
};
const errCode = (e: unknown): string => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '');

export class DatasetService {
  private adding = false;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly db: Database.Database, private readonly deps: DatasetServiceDeps) {}

  /** The project's data as the person sees it (`applies` false for any project that is not a Machine learning project). */
  async list(p: Principal, projectId: string): Promise<DatasetList> {
    this.deps.projects.require(p, projectId, 'project.read');
    const ai = this.aiLocal();
    if (!isMachineLearningProject(this.db, projectId)) return { applies: false, datasets: [], damaged: false, aiOnThisComputer: ai };
    const m = await this.readManifest(projectId);
    return { applies: true, datasets: m.datasets, damaged: m.damaged, aiOnThisComputer: ai };
  }

  /** Main's own read for the AI helper's context: the project's records (none when the manifest is damaged or unreadable). */
  async records(projectId: string): Promise<DatasetRecord[]> {
    try { const m = await this.readManifest(projectId); return m.damaged ? [] : m.datasets; } catch { return []; }
  }

  /** Adds one file the person picks in main's own window. `{ cancelled: true }` when the window was closed without a choice. */
  async add(p: Principal, projectId: string, pick: PickFile): Promise<{ cancelled: true } | { added: DatasetRecord }> {
    this.deps.projects.require(p, projectId, 'artifact.create');
    if (!isMachineLearningProject(this.db, projectId)) refuse('dataset_not_ml');
    if (this.adding) refuse('dataset_busy', 'conflict');
    this.adding = true;
    try {
      // The caps first, before a window opens for nothing.
      const before = await this.readManifest(projectId);
      if (!before.damaged && before.datasets.length >= DATASETS_MAX_PER_PROJECT) refuse('dataset_too_many');
      let chosen: string | null;
      try { chosen = await pick(); } catch { return refuse('dataset_no_window'); }
      if (chosen === null || chosen === undefined) return { cancelled: true };
      if (typeof chosen !== 'string' || chosen.length === 0 || chosen.includes('\0') || !path.isAbsolute(chosen)) return refuse('dataset_unreadable');
      return { added: await this.copyIn(projectId, chosen) };
    } finally {
      this.adding = false;
    }
  }

  /** Removes Nexus's copy of one dataset and its record. The person's original file is never touched (Nexus never held it). */
  async remove(p: Principal, projectId: string, datasetId: string): Promise<{ removed: true }> {
    this.deps.projects.require(p, projectId, 'artifact.create');
    if (typeof datasetId !== 'string' || !ULID_RE.test(datasetId)) refuse('dataset_not_found', 'not_found');
    return this.locked(projectId, async () => {
      const m = await this.readManifest(projectId);
      const r = m.damaged ? undefined : m.datasets.find((d) => d.id === datasetId);
      if (!r) return refuse('dataset_not_found', 'not_found');
      const files = await this.dir(projectId, 'files', false);
      if (files) {
        try { await unlink(path.join(files, r.file)); } catch (e) {
          const c = errCode(e);
          if (c === 'EBUSY' || c === 'EPERM' || c === 'EACCES') return refuse('dataset_in_use', 'conflict');
          if (c !== 'ENOENT') throw e;
        }
      }
      await this.writeManifest(projectId, m.datasets.filter((d) => d.id !== datasetId));
      return { removed: true as const };
    });
  }

  // ---------- internals ----------

  private aiLocal(): boolean { try { return this.deps.aiOnThisComputer?.() === true; } catch { return false; } }

  /** Serialises the writes of one project's folder. */
  private async locked<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(projectId, tail);
    try { return await run; } finally { if (this.locks.get(projectId) === tail) this.locks.delete(projectId); }
  }

  /** `datasets/<projectId>[/sub]`, confined (no link on the way); created when `create`. Null when it does not exist (and not created). */
  private async dir(projectId: string, sub: 'files' | 'tmp' | null, create: boolean): Promise<string | null> {
    let rel: string;
    try { rel = sub ? `${datasetsProjectRel(projectId)}/${sub}` : datasetsProjectRel(projectId); } catch { return refuse('dataset_not_found', 'not_found'); }
    // The data home itself is main's (normally made at startup); a write makes it when it is missing. Confinement then refuses a link.
    if (create) await mkdir(this.deps.dataHome.root, { recursive: true });
    let abs = await this.deps.dataHome.confineToDataHome(rel);
    // A read finds nothing where confinement refuses (no data home yet, or a link on the way): nothing is read through it.
    if (!abs) return create ? refuse('dataset_store') : null;
    if (create) {
      await mkdir(abs, { recursive: true });
      // Again after creating: a link planted on the way is refused, never written through.
      abs = await this.deps.dataHome.confineToDataHome(rel);
      if (!abs) return refuse('dataset_store');
      const st = await lstat(abs);
      if (!st.isDirectory() || st.isSymbolicLink()) return refuse('dataset_store');
      return abs;
    }
    try { const st = await lstat(abs); return st.isDirectory() && !st.isSymbolicLink() ? abs : null; } catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; }
  }

  private async readManifest(projectId: string): Promise<{ datasets: DatasetRecord[]; damaged: boolean }> {
    const dir = await this.dir(projectId, null, false);
    if (!dir) return { datasets: [], damaged: false };
    const file = path.join(dir, 'manifest.json');
    let st;
    try { st = await lstat(file); } catch (e) { if (errCode(e) === 'ENOENT') return { datasets: [], damaged: false }; return { datasets: [], damaged: true }; }
    if (!st.isFile() || st.isSymbolicLink() || st.size > MANIFEST_MAX_BYTES) return { datasets: [], damaged: true };
    try { return parseManifest(await readFile(file, 'utf8')); } catch { return { datasets: [], damaged: true }; }
  }

  /** Writes the manifest (a temp file, then a rename over it), then clears every copy in files/ the manifest does not name. */
  private async writeManifest(projectId: string, datasets: readonly DatasetRecord[]): Promise<void> {
    const dir = await this.dir(projectId, null, true);
    const tmp = path.join(dir!, `manifest.${newId(this.deps.now())}.tmp`);
    try {
      await writeFile(tmp, manifestText(datasets), { encoding: 'utf8', flag: 'wx' });
      await rename(tmp, path.join(dir!, 'manifest.json'));
    } catch (e) {
      try { await unlink(tmp); } catch { /* gone already */ }
      throw e;
    }
    const files = await this.dir(projectId, 'files', false);
    if (!files) return;
    const named = new Set(datasets.map((d) => d.file.toLowerCase()));
    for (const e of await readdir(files, { withFileTypes: true })) {
      if (named.has(e.name.toLowerCase()) || !(e.isFile() || e.isSymbolicLink())) continue;
      try { await unlink(path.join(files, e.name)); } catch { this.deps.log?.('[nexus] datasets: an old copy could not be cleared yet'); }
    }
  }

  /** Copies the chosen file in (see the module header). */
  private async copyIn(projectId: string, source: string): Promise<DatasetRecord> {
    const base = path.basename(source);
    if (isShortcutName(base)) return refuse('dataset_link');
    const ext = extensionOf(base);
    if (!ext) return refuse('dataset_type');
    let st;
    try { st = await lstat(source, { bigint: true }); } catch { return refuse('dataset_unreadable'); }
    if (st.isSymbolicLink()) return refuse('dataset_link');
    if (!st.isFile()) return refuse('dataset_not_file');
    if (st.size === 0n) return refuse('dataset_empty');
    if (st.size > BigInt(DATASET_MAX_BYTES)) return refuse('dataset_too_big');
    const size = Number(st.size);
    const tmpDir = await this.dir(projectId, 'tmp', true);
    // One add runs at a time: any copy in progress left here is from an earlier run that did not finish.
    for (const e of await readdir(tmpDir!, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.part')) { try { await unlink(path.join(tmpDir!, e.name)); } catch { /* next time */ } }
    const id = newId(this.deps.now());
    const tmp = path.join(tmpDir!, `${id}.part`);
    let src;
    try { src = await open(source, 'r'); } catch { return refuse('dataset_unreadable'); }
    let out: Awaited<ReturnType<typeof open>> | null = null;
    let renamed = false;
    try {
      const fst = await src.stat({ bigint: true });
      // The handle must be the very file lstat saw: a file swapped for a link (or another file) in between is refused.
      if (!fst.isFile() || fst.dev !== st.dev || (st.ino !== 0n && fst.ino !== st.ino)) return refuse('dataset_link');
      if (fst.size > BigInt(DATASET_MAX_BYTES)) return refuse('dataset_too_big');
      out = await open(tmp, 'wx');
      const hash = createHash('sha256');
      const delimited = DELIMITED_EXTENSIONS.includes(ext);
      const head = Buffer.alloc(Math.min(SNIFF_BYTES, size));
      let headLen = 0;
      const tail = Buffer.alloc(4); let tailLen = 0;
      const buf = Buffer.alloc(CHUNK);
      let counter: RowCounter | null = null;
      const pending: Buffer[] = [];
      let total = 0;
      for (;;) {
        let n: number;
        try { n = (await src.read(buf, 0, CHUNK, total)).bytesRead; } catch { return refuse('dataset_unreadable'); }
        if (n === 0) break;
        if (total + n > DATASET_MAX_BYTES) return refuse('dataset_too_big');
        const chunk = buf.subarray(0, n);
        hash.update(chunk);
        if (headLen < head.length) { const k = Math.min(head.length - headLen, n); chunk.copy(head, headLen, 0, k); headLen += k; }
        if (n >= 4) { chunk.copy(tail, 0, n - 4, n); tailLen = 4; } else { const keep = Buffer.concat([tail.subarray(0, tailLen), chunk]).subarray(-4); keep.copy(tail); tailLen = keep.length; }
        if (delimited) {
          // The delimiter is read from the header line, so counting starts once the header is known (bytes before are kept a moment).
          if (!counter) {
            pending.push(Buffer.from(chunk));
            const line = firstLineOf(head.subarray(0, headLen), headLen >= size);
            if (line !== null || headLen >= head.length) {
              counter = new RowCounter(delimiterOf(ext, line ?? '') ?? ',', Date.now() + ROW_COUNT_MAX_MS);
              for (const c of pending.splice(0)) counter.push(c);
            }
          } else counter.push(chunk);
        }
        try { await out.write(chunk, 0, n); } catch { return refuse('dataset_store'); }
        total += n;
      }
      if (total === 0) return refuse('dataset_empty');
      await out.close(); out = null;
      if (!sniffOk(ext, head.subarray(0, headLen), tailLen >= 4 ? tail.subarray(0, tailLen) : null, total)) return refuse('dataset_content');
      let columns: string[] | null = null;
      let rows: number | null = null;
      if (delimited) {
        const line = firstLineOf(head.subarray(0, headLen), headLen >= total);
        const delim = line === null ? null : delimiterOf(ext, line);
        if (line !== null && delim !== null) {
          columns = parseHeader(line, delim);
          if (!counter) { counter = new RowCounter(delim, Date.now() + ROW_COUNT_MAX_MS); for (const c of pending.splice(0)) counter.push(c); }
          rows = counter.rows();
        }
      }
      const record = { id, name: displayNameOf(base, ext), file: '', ext, bytes: total, sha256: hash.digest('hex'), addedAt: this.deps.now(), columns, rows };
      return await this.locked(projectId, async () => {
        const m = await this.readManifest(projectId);
        const kept = m.damaged ? [] : m.datasets;
        if (kept.length >= DATASETS_MAX_PER_PROJECT) return refuse('dataset_too_many');
        if (kept.reduce((s, d) => s + d.bytes, 0) + total > DATASETS_MAX_TOTAL_BYTES) return refuse('dataset_total');
        const files = await this.dir(projectId, 'files', true);
        const taken = new Set([...kept.map((d) => d.file.toLowerCase()), ...(await readdir(files!)).map((n) => n.toLowerCase())]);
        const rec: DatasetRecord = { ...record, file: safeFileName(record.name, ext, taken) };
        try { await rename(tmp, path.join(files!, rec.file)); renamed = true; } catch { return refuse('dataset_store'); }
        try { await this.writeManifest(projectId, [...kept, rec]); } catch (e) {
          try { await unlink(path.join(files!, rec.file)); } catch { /* cleared by the next write */ }
          this.deps.log?.(`[nexus] datasets: the record could not be written (${errCode(e) || 'error'})`);
          return refuse('dataset_store');
        }
        return rec;
      });
    } finally {
      try { await out?.close(); } catch { /* closed */ }
      try { await src.close(); } catch { /* closed */ }
      if (!renamed) { try { await unlink(tmp); } catch { /* never made, or gone */ } }
    }
  }
}
