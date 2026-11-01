/**
 * The data home as the runner sees it (B2a Task 11). Main owns every path (src/main/nexusExec/dataHome.ts) and sends
 * the root in `hello`; the runner re-derives the attempt folders from ids and refuses any plan path that is not exactly
 * the expected one under the root (defense in depth). Every folder the runner writes is checked step by step with
 * lstat: a link (symlink or junction) at any step is refused.
 *
 *   objects/<2 hex>/<62 hex>, objects/tmp/   content-addressed blobs
 *   logs/jobs/<jobId>/<n>.log                attempt logs (JSONL)
 *   logs/images/<buildId>.log                image build logs
 *   work/<jobId>/<n>/{in,out}                staging; plus `plan.json` and `exit.json` beside them
 *   datasets/<projectId>/files               a Machine learning project's data (main writes it); bound read-only at /data
 */
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import type { RunnerFs } from './types';

const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export class HomePaths {
  readonly root: string;
  constructor(root: string) {
    if (typeof root !== 'string' || root.length === 0 || root.includes('\0') || !path.isAbsolute(root)) throw new Error('the data home must be an absolute path');
    this.root = path.resolve(root);
  }
  get objectsDir(): string { return path.join(this.root, 'objects'); }
  get objectsTmpDir(): string { return path.join(this.root, 'objects', 'tmp'); }
  get workRoot(): string { return path.join(this.root, 'work'); }
  objectPath(sha: string): string {
    if (!SHA_RE.test(sha)) throw new Error('not a lowercase sha256');
    return path.join(this.root, 'objects', sha.slice(0, 2), sha.slice(2));
  }
  workDir(jobId: string, n: number): string {
    if (!ID_RE.test(jobId) || !Number.isSafeInteger(n) || n < 1) throw new Error('bad attempt folder ids');
    return path.join(this.root, 'work', jobId, String(n));
  }
  logPath(jobId: string, n: number): string {
    if (!ID_RE.test(jobId) || !Number.isSafeInteger(n) || n < 1) throw new Error('bad attempt log ids');
    return path.join(this.root, 'logs', 'jobs', jobId, `${n}.log`);
  }
  /** The one folder a `/data` mount may bind: `<root>/datasets/<projectId>/files` (main's DatasetService writes it; the sandbox only reads). */
  datasetsDir(projectId: string): string {
    if (!ID_RE.test(projectId)) throw new Error('bad project id');
    return path.join(this.root, 'datasets', projectId, 'files');
  }
  imageLogPath(buildId: string): string {
    if (!ID_RE.test(buildId)) throw new Error('bad build id');
    return path.join(this.root, 'logs', 'images', `${buildId}.log`);
  }
  /** Whether `p` is exactly this path (main resolved it the same way). */
  same(p: string, expected: string): boolean {
    if (typeof p !== 'string' || p.includes('\0') || !path.isAbsolute(p)) return false;
    const a = path.resolve(p); const b = path.resolve(expected);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  /** `{ jobId, n }` of an attempt log path under this home (`logs/jobs/<jobId>/<n>.log`), or null. */
  parseLogPath(p: string): { jobId: string; n: number } | null {
    if (typeof p !== 'string' || p.includes('\0') || !path.isAbsolute(p)) return null;
    const rel = path.relative(this.root, path.resolve(p));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const parts = rel.split(/[\\/]/);
    if (parts.length !== 4 || parts[0] !== 'logs' || parts[1] !== 'jobs' || !ID_RE.test(parts[2])) return null;
    const m = /^([1-9][0-9]{0,6})\.log$/.exec(parts[3]);
    return m ? { jobId: parts[2], n: Number(m[1]) } : null;
  }
}

const errCode = (e: unknown): string => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '');

/**
 * Creates `dir` (under `root`) one folder at a time, refusing a link or a non-folder at any existing step. Returns
 * false when refused. Never follows a link.
 */
export async function ensureDirUnder(fs: RunnerFs, root: string, dir: string): Promise<boolean> {
  const rel = path.relative(root, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    const st = await fs.lstat(root);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  } catch (e) {
    if (errCode(e) !== 'ENOENT') return false;
    await fs.mkdir(root, { recursive: true });
  }
  let cur = root;
  for (const seg of rel === '' ? [] : rel.split(/[\\/]/)) {
    cur = path.join(cur, seg);
    try {
      const st = await fs.lstat(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch (e) {
      if (errCode(e) !== 'ENOENT') return false;
      // A folder that cannot be made (no space, no access) is a file system failure, thrown for the caller to report.
      try { await fs.mkdir(cur); } catch (e2) { if (errCode(e2) !== 'EEXIST') throw e2; }
      const st = await fs.lstat(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    }
  }
  return true;
}

/** Whether every existing step from `root` down to `p` is a plain folder (the last may be a file), with no link. */
export async function noLinkUnder(fs: RunnerFs, root: string, p: string): Promise<boolean> {
  const rel = path.relative(root, p);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let cur = root;
  const segs = rel.split(/[\\/]/);
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try { st = await fs.lstat(cur); } catch (e) { return errCode(e) === 'ENOENT'; }
    if (st.isSymbolicLink()) return false;
    if (i < segs.length - 1 && !st.isDirectory()) return false;
  }
  return true;
}

export { errCode };

/** O_NOFOLLOW where the platform has one (POSIX: opening a final-component link fails); 0 on Windows (no such flag). */
export const NOFOLLOW: number = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

export type PlainRead = { ok: true; bytes: Buffer } | { ok: false; why: 'missing' | 'link' | 'hardlink' | 'not_a_file' | 'too_large' | 'changed' };

/**
 * Reads a file a container could have written (a file under `/out`), never through a link (B2a Task 12 fix round 1):
 * lstat first (a symlink, a junction, a second hard link or anything but a regular file is refused, and so is a file
 * over `maxBytes`), then the open (O_NOFOLLOW where the platform has it), re-checked on the open handle (device, inode,
 * size and link count must still be the lstat's): a swap between the check and the open is refused. Never throws for
 * a refusal; an I/O error other than ENOENT is thrown.
 */
export async function readPlainFile(fs: RunnerFs, p: string, maxBytes: number): Promise<PlainRead> {
  // BigInt stats (final batch item 8): an NTFS file id can exceed 2^53, where Number ids of two files may compare equal.
  let st;
  try { st = await fs.lstat(p, { bigint: true }); } catch (e) { if (errCode(e) === 'ENOENT') return { ok: false, why: 'missing' }; throw e; }
  if (st.isSymbolicLink()) return { ok: false, why: 'link' };
  if (!st.isFile()) return { ok: false, why: 'not_a_file' };
  if (st.nlink > 1n) return { ok: false, why: 'hardlink' };
  if (st.size > BigInt(maxBytes)) return { ok: false, why: 'too_large' };
  const size = Number(st.size);
  let fh;
  try { fh = await fs.open(p, fsConstants.O_RDONLY | NOFOLLOW); } catch (e) {
    const c = errCode(e);
    if (c === 'ELOOP' || c === 'EMLINK') return { ok: false, why: 'link' };
    if (c === 'ENOENT') return { ok: false, why: 'missing' };
    throw e;
  }
  try {
    const s2 = await fh.stat({ bigint: true });
    if (!s2.isFile() || s2.ino !== st.ino || s2.dev !== st.dev || s2.size !== st.size || s2.nlink !== st.nlink) return { ok: false, why: 'changed' };
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    if (got !== size) return { ok: false, why: 'changed' };
    return { ok: true, bytes: buf };
  } finally { await fh.close(); }
}

/** What stands at `p`: nothing, a plain single-link regular file, or anything else (a link, a junction, a hard link, a folder, ...). */
export async function plainFileOrAbsent(fs: RunnerFs, p: string): Promise<'absent' | 'plain' | 'other'> {
  let st;
  try { st = await fs.lstat(p); } catch (e) { if (errCode(e) === 'ENOENT') return 'absent'; throw e; }
  return !st.isSymbolicLink() && st.isFile() && st.nlink === 1 ? 'plain' : 'other';
}
