/**
 * The Nexus data home: `<userData>/nexus`. Every host path the execution core uses is derived
 * here, in main, from ids main owns; the renderer never names one.
 *
 *   objects/<2 hex>/<62 hex>     content-addressed blobs; objects/tmp/ for in-flight writes
 *   logs/jobs/<jobId>/<n>.log    attempt logs (the stored `job_attempts.log_path` is this relative form)
 *   logs/images/<buildId>.log    image build logs
 *   work/<jobId>/<n>/{in,out}    attempt staging
 *   wt/<session id, lowercase>   B2b: one locked git worktree per agent session (written by git, through the runner)
 *   jobs/<jobId>/                B2b: per-job files main writes (an agent turn's context); never blob GC's
 *
 * Confinement (`confineToDataHome`) reuses B1's segment rules (`relSegments`, applied with the
 * Windows rules on every platform): a relative path is refused when it is empty, absolute
 * (POSIX, drive letter, UNC, `\\?\`), holds NUL or a `..` segment, names an alternate data stream
 * (`:`), ends a segment in a dot or a space, or names a reserved device. Each existing step is
 * then checked with lstat: any link (a symlink or a junction) is refused, wherever it points, and
 * the real path of every step must stay under the real data home (fsRoots.isUnderRoot). The data
 * home itself must not be a link. A final non-directory step with more than one hard link is
 * refused (B1's rule for sources and outputs).
 *
 * Every absolute path main hands out (`objectPath`, `attemptWorkDir`) is confined first, and
 * `ensure()` creates the layout one folder at a time, refusing a link or non-directory at any
 * step, so nothing is created outside the data home.
 *
 * Async only (fs.promises): no synchronous file-system call here (the main posture ratchet).
 */
import { lstat, mkdir, open, readdir, realpath, statfs, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { isUnderRoot } from '../fsRoots';
import { relSegments } from '../nexusIpc/sources';
import { PlatformError } from '../nexus/errors';

export const DATA_HOME_DIR = 'nexus';
/** The DDL bound on `job_attempts.log_path` and `image_builds.log_path`. */
export const MAX_LOG_PATH_CHARS = 200;
export const MAX_ATTEMPT_N = 1_000_000;
const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export interface DataHome {
  /** Absolute `<userData>/nexus`. */
  readonly root: string;
  readonly objectsDir: string;
  /** In-flight object writes; renamed into place once hashed. Recovery sweeps it. */
  readonly objectsTmpDir: string;
  readonly logsDir: string;
  readonly workDir: string;
  /** B2b: `<root>/wt`, the session worktrees (one per session, F23). Blob GC never lists anything under it. */
  readonly worktreesDir: string;
  /** B2b: `<root>/jobs`, per-job files main writes. Blob GC never lists anything under it. */
  readonly jobsDir: string;
  /** RELATIVE folder of a session's worktree: `wt/<sessionId lowercased>` (the v10 trigger's naming). */
  worktreeRel(sessionId: string): string;
  /** Absolute, confined folder of a session's worktree, or null when refused (it may not exist yet). */
  worktreePath(sessionId: string): Promise<string | null>;
  /** RELATIVE folder of one job's own files: `jobs/<jobId>`. */
  jobRel(jobId: string): string;
  /** RELATIVE path of a blob's bytes (`objects/<2>/<62>`). */
  objectRel(sha256: string): string;
  /** Absolute, confined path of a blob's bytes, or null when confinement refuses it. */
  objectPath(sha256: string): Promise<string | null>;
  /** RELATIVE staging folder of one attempt (`work/<jobId>/<n>`). */
  attemptWorkRel(jobId: string, n: number): string;
  /** Absolute, confined staging folder of one attempt (`in/` and `out/` live under it), or null when refused. */
  attemptWorkDir(jobId: string, n: number): Promise<string | null>;
  /** RELATIVE log path of one attempt, as stored in `job_attempts.log_path` (forward slashes). */
  attemptLogPath(jobId: string, n: number): string;
  /** RELATIVE log path of one image build, as stored in `image_builds.log_path`. */
  imageLogPath(buildId: string): string;
  /**
   * The absolute, confined location of `rel` under the data home, or null when it is refused.
   * TOCTOU: the answer holds only at the moment it is computed. Callers confine immediately before
   * each use and never cache the result; folders a container can write (`work/<job>/<n>/out`) are
   * re-checked by the runner's own lstat walk when it reads them.
   */
  confineToDataHome(rel: string): Promise<string | null>;
  /** Free bytes for an unprivileged writer at `dir` (default: the data home), or null when unknown. */
  freeBytesAt(dir?: string): Promise<number | null>;
  /** Create the layout (idempotent). Refuses a data home that is a link. */
  ensure(): Promise<void>;
  /**
   * Restart recovery's blob store hygiene: every `objects/<2 hex>/<62 hex>` regular file with its lstat facts, at most
   * `limit` (links, folders and other names are never listed and never followed).
   */
  listObjectFiles(limit: number): Promise<{ objects: ObjectFileFact[]; truncated: boolean }>;
  /** Removes the regular files in `objects/tmp` last modified before `cutoffMs`, each confined first (links and folders stay). */
  sweepObjectsTmp(cutoffMs: number): Promise<{ removed: number; failed: number }>;
  /** The confined object delete (`deleteObjectFiles`): a link, a hard link or a path outside is refused and reported. */
  deleteObjects(shas: readonly string[]): Promise<{ failed: string[] }>;
  /**
   * A small stored object's bytes (B2a Task 13 fix round 1: an install's `lock.sha256`), read through its confined path
   * (`objectPath`: a link or a path leaving the data home is refused): null when it is not there or not a plain file,
   * `'too_large'` when it holds more than `maxBytes`. The caller re-checks the sha256.
   */
  readObjectBytes(sha256: string, maxBytes: number): Promise<Buffer | 'too_large' | null>;
}

/** One object file as the hygiene pass sees it (never its bytes). */
export interface ObjectFileFact { sha256: string; mtimeMs: number; nlink: number }

function checkId(id: unknown, field: string): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new PlatformError('invalid', `${field} is not a plain id`, { field });
  return id;
}
function checkN(n: unknown): number {
  if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > MAX_ATTEMPT_N) throw new PlatformError('invalid', 'attempt number out of range', { field: 'n' });
  return n as number;
}

/** Whether a relative log path satisfies the DDL CHECK on `log_path` (mirrors it; the database stays the authority). */
export function satisfiesLogPathCheck(p: string): boolean {
  return typeof p === 'string' && p.length <= MAX_LOG_PATH_CHARS && !p.startsWith('/') && !p.includes(':') && !p.includes('..') && !p.includes('\\');
}

function relLog(parts: string[]): string {
  const rel = parts.join('/');
  // Belt and braces: the result must be a confinable relative path AND satisfy the DDL CHECK.
  if (!satisfiesLogPathCheck(rel) || relSegments(rel, 'win32') === null) throw new PlatformError('invalid', 'the log path is not storable', { field: 'log_path' });
  return rel;
}

const errCode = (e: unknown): string => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '');

export async function freeBytesAt(dir: string): Promise<number | null> {
  if (typeof dir !== 'string' || !dir || dir.includes('\0') || !path.isAbsolute(dir)) return null;
  let cur = path.resolve(dir);
  for (;;) {
    try {
      const s = await statfs(cur);
      const free = Number(s.bavail) * Number(s.bsize);
      return Number.isFinite(free) && free >= 0 ? free : null;
    } catch (e) {
      const parent = path.dirname(cur);
      if (errCode(e) !== 'ENOENT' || parent === cur) return null;
      cur = parent;                                   // a folder not created yet: measure the volume it will live on
    }
  }
}

/** Confine `rel` under `root` (see the module comment). Exported for tests on temp folders. */
export async function confineUnder(root: string, rel: string): Promise<string | null> {
  const parts = relSegments(rel, 'win32');
  if (!parts || typeof root !== 'string' || !root || root.includes('\0') || !path.isAbsolute(root)) return null;
  let realRoot: string;
  try {
    if ((await lstat(root)).isSymbolicLink()) return null;
    realRoot = await realpath(root);
  } catch { return null; }
  let cur = realRoot;
  for (let k = 0; k < parts.length; k++) {
    const next = path.join(cur, parts[k]);
    let st;
    try { st = await lstat(next); } catch (e) {
      // Not there yet: the rest is a tail to be created under a confined, link-free parent.
      if (errCode(e) === 'ENOENT') return path.join(cur, ...parts.slice(k));
      return null;
    }
    if (st.isSymbolicLink()) return null;             // a symlink or a junction, wherever it points
    if (k < parts.length - 1 && !st.isDirectory()) return null;
    if (!st.isDirectory() && st.nlink > 1) return null;   // a hard link: a second name for bytes that may live elsewhere
    let real: string;
    try { real = await realpath(next); } catch { return null; }
    if (!isUnderRoot(realRoot, real)) return null;
    cur = real;
  }
  return cur;
}

const LAYOUT: readonly (readonly string[])[] = Object.freeze([['objects', 'tmp'], ['logs', 'jobs'], ['logs', 'images'], ['work'], ['wt'], ['jobs']]);

/** A session id as a worktree folder name: lowercased (`tr_worktrees_insert` requires `wt/<lower(session_id)>`). */
export function worktreeRelFor(sessionId: string): string {
  return `wt/${checkId(sessionId, 'sessionId').toLowerCase()}`;
}

function objectRel(sha256: string): string {
  if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) throw new PlatformError('invalid', 'not a lowercase sha256', { field: 'sha256' });
  return `objects/${sha256.slice(0, 2)}/${sha256.slice(2)}`;
}
function attemptWorkRel(jobId: string, n: number): string {
  return `work/${checkId(jobId, 'jobId')}/${checkN(n)}`;
}

/**
 * The GC file delete (BlobIndex.gcApply's `deleteObjects`): each object is confined immediately before
 * its unlink. A path that confinement refuses (a link, a hard link, outside) or an unlink that fails is
 * reported in `failed`; a file already gone counts as deleted.
 */
export async function deleteObjectFiles(home: DataHome, shas: readonly string[]): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (const sha of shas) {
    let p: string | null;
    try { p = await home.objectPath(sha); } catch { p = null; }
    if (!p) { failed.push(sha); continue; }
    try { await unlink(p); } catch (e) { if (errCode(e) !== 'ENOENT') failed.push(sha); }
  }
  return { failed };
}

const HEX2_RE = /^[0-9a-f]{2}$/;
const HEX62_RE = /^[0-9a-f]{62}$/;

/** See DataHome.listObjectFiles. The objects folder itself must confine (not a link). */
export async function listObjectFiles(root: string, limit: number): Promise<{ objects: ObjectFileFact[]; truncated: boolean }> {
  const objects: ObjectFileFact[] = [];
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  const dir = await confineUnder(root, 'objects');
  if (!dir || max === 0) return { objects, truncated: false };
  let shards;
  try { shards = await readdir(dir, { withFileTypes: true }); } catch { return { objects, truncated: false }; }
  for (const s of shards) {
    // A junction or symlink reports as a link, never as a folder: it is skipped, never followed.
    if (!HEX2_RE.test(s.name) || !s.isDirectory()) continue;
    const sub = path.join(dir, s.name);
    let files;
    try { files = await readdir(sub, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!HEX62_RE.test(f.name) || !f.isFile()) continue;
      let st;
      try { st = await lstat(path.join(sub, f.name)); } catch { continue; }
      if (!st.isFile()) continue;
      objects.push({ sha256: `${s.name}${f.name}`, mtimeMs: st.mtimeMs, nlink: st.nlink });
      if (objects.length >= max) return { objects, truncated: true };
    }
  }
  return { objects, truncated: false };
}

/** See DataHome.sweepObjectsTmp. */
export async function sweepObjectsTmp(root: string, cutoffMs: number): Promise<{ removed: number; failed: number }> {
  let removed = 0; let failed = 0;
  const dir = await confineUnder(root, 'objects/tmp');
  if (!dir) return { removed, failed };
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return { removed, failed }; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    // Confined immediately before the unlink: a name confinement refuses, or a hard link, is reported, never deleted.
    const p = await confineUnder(root, `objects/tmp/${e.name}`);
    if (!p) { failed++; continue; }
    let st;
    try { st = await lstat(p); } catch { continue; }
    if (!st.isFile() || st.mtimeMs >= cutoffMs) continue;
    try { await unlink(p); removed++; } catch (err) { if (errCode(err) !== 'ENOENT') failed++; }
  }
  return { removed, failed };
}

export function resolveDataHome(userData: string): DataHome {
  if (typeof userData !== 'string' || !userData || userData.includes('\0') || !path.isAbsolute(userData)) {
    throw new PlatformError('invalid', 'userData must be an absolute path');
  }
  const root = path.join(path.resolve(userData), DATA_HOME_DIR);
  const objectsDir = path.join(root, 'objects');
  const objectsTmpDir = path.join(objectsDir, 'tmp');
  const logsDir = path.join(root, 'logs');
  const workDir = path.join(root, 'work');
  const worktreesDir = path.join(root, 'wt');
  const jobsDir = path.join(root, 'jobs');
  const home: DataHome = Object.freeze({
    root, objectsDir, objectsTmpDir, logsDir, workDir, worktreesDir, jobsDir,
    worktreeRel: worktreeRelFor,
    worktreePath(sessionId: string): Promise<string | null> { return confineUnder(root, worktreeRelFor(sessionId)); },
    jobRel(jobId: string): string { return `jobs/${checkId(jobId, 'jobId')}`; },
    objectRel,
    objectPath(sha256: string): Promise<string | null> { return confineUnder(root, objectRel(sha256)); },
    attemptWorkRel,
    attemptWorkDir(jobId: string, n: number): Promise<string | null> { return confineUnder(root, attemptWorkRel(jobId, n)); },
    attemptLogPath(jobId: string, n: number): string {
      return relLog(['logs', 'jobs', checkId(jobId, 'jobId'), `${checkN(n)}.log`]);
    },
    imageLogPath(buildId: string): string {
      return relLog(['logs', 'images', `${checkId(buildId, 'buildId')}.log`]);
    },
    confineToDataHome(rel: string): Promise<string | null> { return confineUnder(root, rel); },
    freeBytesAt(dir?: string): Promise<number | null> { return freeBytesAt(dir ?? root); },
    listObjectFiles(limit: number) { return listObjectFiles(root, limit); },
    sweepObjectsTmp(cutoffMs: number) { return sweepObjectsTmp(root, cutoffMs); },
    deleteObjects(shas: readonly string[]): Promise<{ failed: string[] }> { return deleteObjectFiles(home, shas); },
    async readObjectBytes(sha256: string, maxBytes: number): Promise<Buffer | 'too_large' | null> {
      if (typeof sha256 !== 'string' || !SHA_RE.test(sha256) || !Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
      const abs = await confineUnder(root, objectRel(sha256));
      if (!abs) return null;
      let fh;
      try { fh = await open(abs, 'r'); } catch { return null; }
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.nlink > 1) return null;
        if (st.size > maxBytes) return 'too_large';
        const buf = Buffer.alloc(st.size);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return buf.subarray(0, bytesRead);
      } finally { await fh.close(); }
    },
    async ensure(): Promise<void> {
      const refuse = (why: string): never => { throw new PlatformError('invalid', `the data home layout is refused: ${why}`); };
      // The root first, before anything is created: an existing link or non-directory is refused.
      try {
        const st = await lstat(root);
        if (st.isSymbolicLink() || !st.isDirectory()) refuse('the data home is a link or not a folder');
      } catch (e) {
        if (e instanceof PlatformError) throw e;
        if (errCode(e) !== 'ENOENT') throw e;
        await mkdir(path.dirname(root), { recursive: true });
        await mkdir(root);
      }
      const realRoot = await realpath(root);
      // One folder at a time, never recursive: a link or a file at any step stops the walk before it writes through it.
      for (const rel of LAYOUT) {
        let cur = root;
        for (const seg of rel) {
          cur = path.join(cur, seg);
          let st;
          try { st = await lstat(cur); } catch (e) {
            if (errCode(e) !== 'ENOENT') throw e;
            await mkdir(cur);
            st = await lstat(cur);
          }
          if (st.isSymbolicLink() || !st.isDirectory()) refuse(`${rel.join('/')} is a link or not a folder`);
          if (!isUnderRoot(realRoot, await realpath(cur))) refuse(`${rel.join('/')} leaves the data home`);
        }
      }
    }
  });
  return home;
}
