/**
 * The host file tools the local-model runtime offers its model (`read_file`, `write_file`, `list_files`, `delete_file`),
 * confined to the turn's own worktree (R5). The model's FILE tools run on the host, in the runner process, not in the
 * container, so every path is judged here before any file is touched:
 *
 * - a path is relative, with forward slashes (a backslash is read as a slash): no `..`, no absolute path, no drive letter or
 *   colon (an NTFS stream included), no UNC path (it starts with a separator), no control character, no Windows device name,
 *   no trailing dot or space, no `<>"|?*`;
 * - never a sensitive path (`isSensitivePath`: `.git` in any spelling, `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`,
 *   `.pypirc`), a `.claude*` entry (the agent CLI's own per-worktree folder) or a Nexus control entry (`.nexus*`, `nexus.*`);
 * - every component of the path, from the root down, is `lstat`ed and none may be a symlink, a junction or any other link
 *   (Node reports a junction as a symbolic link); a file with more than one name (a hard link) and anything that is not a
 *   plain file or folder is refused. A link is never followed, opened or listed;
 * - sizes are capped (a file read, a file written, all bytes written in a turn, a listing); a file with a NUL byte is binary
 *   and neither read nor written;
 * - a write goes to a temporary sibling opened with `wx` (never through a link) and is renamed over the target after the
 *   target is looked at again, so a reader never sees half a file.
 *
 * The tools cannot make the worktree safe against another writer (the container shares it read-write): the worktree guard
 * the runner runs after every `sandbox_exec` and before the collect is the backstop, and this module re-checks each path at
 * the moment of use. A result never holds an absolute path, and the model's file contents are never logged or echoed in an
 * event (`summarize` names a write by its path and size only).
 */
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { isSensitivePath } from '../../../shared/nexus/changeSet';
import type { ChatTool } from './client';

export const FILE_TOOL_NAMES: readonly string[] = Object.freeze(['read_file', 'write_file', 'list_files', 'delete_file']);

export interface FileToolLimits {
  /** The most bytes `read_file` returns (a larger file is refused, never cut). */
  readMaxBytes: number;
  /** The most bytes of one `write_file`. */
  writeMaxBytes: number;
  /** The most bytes all `write_file` calls of one turn may write. */
  writeTotalBytes: number;
  /** The most entries one `list_files` returns, and how deep it goes. */
  listMaxEntries: number;
  listMaxDepth: number;
}
export const DEFAULT_FILE_LIMITS: Readonly<FileToolLimits> = Object.freeze({
  readMaxBytes: 256 * 1024, writeMaxBytes: 256 * 1024, writeTotalBytes: 8 * 1024 * 1024, listMaxEntries: 400, listMaxDepth: 8
});

export interface FileToolResult { ok: boolean; text: string }

const obj = (properties: Record<string, unknown>, required: string[]): unknown => ({ type: 'object', properties, required, additionalProperties: false });
const P = { type: 'string', description: 'A path inside the project, relative, with forward slashes (for example src/app.js). Never absolute, never ..' };

/** The tools as the model's server takes them. */
export const FILE_TOOL_DEFS: readonly ChatTool[] = Object.freeze([
  { type: 'function', function: { name: 'read_file', description: 'Read one text file of the project and return its content.', parameters: obj({ path: P }, ['path']) } },
  { type: 'function', function: { name: 'write_file', description: 'Create or replace one text file of the project with the given full content (parent folders are created).',
    parameters: obj({ path: P, content: { type: 'string', description: 'The whole new content of the file.' } }, ['path', 'content']) } },
  { type: 'function', function: { name: 'list_files', description: 'List the files and folders of the project (or of one folder of it).',
    parameters: obj({ path: { ...P, description: 'A folder, relative; leave out for the project root.' }, recursive: { type: 'boolean', description: 'Also list inside sub-folders (default true).' } }, []) } },
  { type: 'function', function: { name: 'delete_file', description: 'Delete one file of the project.', parameters: obj({ path: P }, ['path']) } }
] as ChatTool[]);

const DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const BAD_CHARS_RE = /[<>"|?*\x00-\x1f\x7f]/;
const CONTROL_ENTRY_RE = /^(?:\.claude|\.nexus|nexus\.)/i;
const SKIP_DESCEND = new Set(['node_modules']);

type Checked = { ok: true; segs: string[] } | { ok: false; why: string };

/** Judges a path as the model wrote it. Pure: no file is looked at. */
export function checkRelPath(raw: unknown): Checked {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, why: 'a path is required' };
  if (raw.length > 512) return { ok: false, why: 'the path is too long' };
  if (BAD_CHARS_RE.test(raw)) return { ok: false, why: 'the path has a character that is not allowed' };
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/')) return { ok: false, why: 'absolute paths are not allowed; use a path relative to the project' };
  if (/^[A-Za-z]:/.test(p)) return { ok: false, why: 'drive letters are not allowed; use a path relative to the project' };
  if (p.includes(':')) return { ok: false, why: 'a colon is not allowed in a path' };
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  for (const s of segs) {
    if (s === '..') return { ok: false, why: 'a path may not go up (..)' };
    if (s.length > 255) return { ok: false, why: 'a name in the path is too long' };
    if (/[. ]$/.test(s)) return { ok: false, why: 'a name may not end in a dot or a space' };
    if (DEVICE_RE.test(s)) return { ok: false, why: 'that name is reserved' };
    if (CONTROL_ENTRY_RE.test(s)) return { ok: false, why: 'that path is reserved' };
  }
  if (segs.length > 0 && isSensitivePath(segs.join('/'))) return { ok: false, why: 'that path is not allowed (a repository, key or secret file)' };
  return { ok: true, segs };
}

const fail = (text: string): FileToolResult => ({ ok: false, text });
const ok = (text: string): FileToolResult => ({ ok: true, text });
const shown = (s: string): string => s.slice(0, 120);

type Probe = { kind: 'missing' } | { kind: 'dir' } | { kind: 'file'; size: number } | { kind: 'refused'; why: string };

export class FileTools {
  private written = 0;
  constructor(private readonly root: string, private readonly limits: FileToolLimits = DEFAULT_FILE_LIMITS) {}

  /** What an event may say about a call: names the path (and a write's size) and never the content. */
  summarize(name: string, args: unknown): string {
    const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
    const p = typeof a.path === 'string' ? shown(a.path) : '';
    if (name === 'write_file') return `${p} (${typeof a.content === 'string' ? Buffer.byteLength(a.content, 'utf8') : 0} bytes)`;
    return p;
  }

  async run(name: string, args: Record<string, unknown>): Promise<FileToolResult> {
    try {
      if (!(await this.rootOk())) return fail('the project folder is not available');
      switch (name) {
        case 'read_file': return await this.read(args);
        case 'write_file': return await this.write(args);
        case 'list_files': return await this.list(args);
        case 'delete_file': return await this.remove(args);
        default: return fail('unknown file tool');
      }
    } catch {
      return fail('the file operation failed');
    }
  }

  /** Whether a path the model may use holds anything now (a path the tools would refuse counts as present: it is not for the model to create). */
  async exists(rel: string): Promise<boolean> {
    try {
      const c = checkRelPath(rel);
      if (!c.ok || c.segs.length === 0) return true;
      const ch = await this.chain(c.segs, false);
      if (!ch.ok) return !ch.missing;
      return (await this.probe(path.join(ch.parent, c.segs[c.segs.length - 1]))).kind !== 'missing';
    } catch { return true; }
  }

  private async rootOk(): Promise<boolean> {
    if (!path.isAbsolute(this.root)) return false;
    try { const st = await fsp.lstat(this.root); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
  }

  /** One entry looked at with `lstat`: a link, a hard-linked file or anything odd is `refused`; nothing is followed. */
  private async probe(abs: string): Promise<Probe> {
    let st: Awaited<ReturnType<typeof fsp.lstat>>;
    try { st = await fsp.lstat(abs); } catch (e) { return (e as { code?: string })?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'refused', why: 'the path could not be read' }; }
    if (st.isSymbolicLink()) return { kind: 'refused', why: 'links are not followed' };
    if (st.isDirectory()) return { kind: 'dir' };
    if (st.isFile()) return st.nlink > 1 ? { kind: 'refused', why: 'a file with more than one name is not allowed' } : { kind: 'file', size: st.size };
    return { kind: 'refused', why: 'that is not a plain file or folder' };
  }

  /**
   * The folder chain above the last segment, each part `lstat`ed from the root down. `create`: a missing folder is made (one at a
   * time, then looked at again). Returns the absolute path of the last segment's parent, or why not.
   */
  private async chain(segs: string[], create: boolean): Promise<{ ok: true; parent: string } | { ok: false; why: string; missing?: boolean }> {
    let cur = this.root;
    for (const s of segs.slice(0, -1)) {
      cur = path.join(cur, s);
      let pr = await this.probe(cur);
      if (pr.kind === 'missing') {
        if (!create) return { ok: false, why: 'no such folder', missing: true };
        try { await fsp.mkdir(cur); } catch (e) { if ((e as { code?: string })?.code !== 'EEXIST') return { ok: false, why: 'the folder could not be created' }; }
        pr = await this.probe(cur);
      }
      if (pr.kind === 'refused') return { ok: false, why: pr.why };
      if (pr.kind !== 'dir') return { ok: false, why: 'a part of the path is a file, not a folder' };
    }
    return { ok: true, parent: cur };
  }

  private async read(a: Record<string, unknown>): Promise<FileToolResult> {
    const c = checkRelPath(a.path);
    if (!c.ok) return fail(c.why);
    if (c.segs.length === 0) return fail('a file path is required');
    const ch = await this.chain(c.segs, false);
    if (!ch.ok) return fail(ch.missing ? 'no such file' : ch.why);
    const abs = path.join(ch.parent, c.segs[c.segs.length - 1]);
    const pr = await this.probe(abs);
    if (pr.kind === 'missing') return fail('no such file');
    if (pr.kind === 'refused') return fail(pr.why);
    if (pr.kind === 'dir') return fail('that is a folder, not a file');
    if (pr.size > this.limits.readMaxBytes) return fail(`the file is too large to read (the limit is ${this.limits.readMaxBytes} bytes)`);
    const fh = await fsp.open(abs, 'r');
    try {
      // The handle is looked at again: it must still be the plain, small file that was checked.
      const st = await fh.stat();
      if (!st.isFile() || st.nlink > 1 || st.size > this.limits.readMaxBytes) return fail('the file could not be read');
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(buf, 0, st.size, 0);
      const data = buf.subarray(0, bytesRead);
      if (data.includes(0)) return fail('the file is binary; only text files can be read');
      return ok(data.toString('utf8'));
    } finally { await fh.close().catch(() => undefined); }
  }

  private async write(a: Record<string, unknown>): Promise<FileToolResult> {
    const c = checkRelPath(a.path);
    if (!c.ok) return fail(c.why);
    if (c.segs.length === 0) return fail('a file path is required');
    if (typeof a.content !== 'string') return fail('content must be a string with the whole file');
    const bytes = Buffer.byteLength(a.content, 'utf8');
    if (bytes > this.limits.writeMaxBytes) return fail(`the content is too large (the limit is ${this.limits.writeMaxBytes} bytes per file)`);
    if (this.written + bytes > this.limits.writeTotalBytes) return fail('this turn has written as much as it may');
    if (a.content.includes('\0')) return fail('the content has a NUL character; only text files can be written');
    const ch = await this.chain(c.segs, true);
    if (!ch.ok) return fail(ch.why);
    const abs = path.join(ch.parent, c.segs[c.segs.length - 1]);
    const before = await this.probe(abs);
    if (before.kind === 'refused') return fail(before.why);
    if (before.kind === 'dir') return fail('that is a folder, not a file');
    // A rewrite with the very same content changes nothing: said plainly, so a model that keeps "fixing" the wrong file sees it.
    if (before.kind === 'file' && before.size === bytes) {
      const same = await fsp.readFile(abs, 'utf8').then((t) => t === a.content, () => false);
      if (same) return fail('nothing changed: this file already has exactly this content. The error is somewhere else (another file, or this content must differ).');
    }
    const tmp = path.join(ch.parent, `.write-${randomBytes(6).toString('hex')}.tmp`);
    let fh: Awaited<ReturnType<typeof fsp.open>> | null = null;
    try {
      fh = await fsp.open(tmp, 'wx');
      await fh.writeFile(a.content, 'utf8');
      await fh.close();
      fh = null;
      // The target is looked at once more right before it is replaced: a link planted meanwhile is never written through.
      const after = await this.probe(abs);
      if (after.kind === 'refused') return fail(after.why);
      if (after.kind === 'dir') return fail('that is a folder, not a file');
      await fsp.rename(tmp, abs);
      this.written += bytes;
      return ok(`wrote ${c.segs.join('/')} (${bytes} bytes)`);
    } finally {
      if (fh) await fh.close().catch(() => undefined);
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private async list(a: Record<string, unknown>): Promise<FileToolResult> {
    const c = a.path === undefined || a.path === '' || a.path === '.' ? { ok: true as const, segs: [] as string[] } : checkRelPath(a.path);
    if (!c.ok) return fail(c.why);
    const recursive = a.recursive !== false;
    let dir = this.root;
    if (c.segs.length > 0) {
      const ch = await this.chain(c.segs, false);
      if (!ch.ok) return fail(ch.missing ? 'no such folder' : ch.why);
      dir = path.join(ch.parent, c.segs[c.segs.length - 1]);
      const pr = await this.probe(dir);
      if (pr.kind === 'missing') return fail('no such folder');
      if (pr.kind === 'refused') return fail(pr.why);
      if (pr.kind !== 'dir') return fail('that is a file, not a folder');
    }
    const lines: string[] = [];
    let truncated = false;
    const queue: { abs: string; rel: string; depth: number }[] = [{ abs: dir, rel: c.segs.join('/'), depth: 0 }];
    while (queue.length > 0 && !truncated) {
      const cur = queue.shift()!;
      let names: string[];
      try { names = (await fsp.readdir(cur.abs)).sort(); } catch { continue; }
      for (const name of names) {
        const rel = cur.rel === '' ? name : `${cur.rel}/${name}`;
        // What the file tools would refuse is not shown.
        if (CONTROL_ENTRY_RE.test(name) || isSensitivePath(rel) || /^\.write-[0-9a-f]+\.tmp$/.test(name)) continue;
        const pr = await this.probe(path.join(cur.abs, name));
        if (pr.kind === 'refused' || pr.kind === 'missing') continue;
        if (lines.length >= this.limits.listMaxEntries) { truncated = true; break; }
        if (pr.kind === 'dir') {
          lines.push(`${rel}/`);
          if (recursive && cur.depth + 1 < this.limits.listMaxDepth && !SKIP_DESCEND.has(name)) queue.push({ abs: path.join(cur.abs, name), rel, depth: cur.depth + 1 });
        } else lines.push(`${rel} (${pr.size} bytes)`);
      }
    }
    if (lines.length === 0) return ok('(empty)');
    return ok(`${lines.join('\n')}${truncated ? `\n... (the listing stops at ${this.limits.listMaxEntries} entries)` : ''}`);
  }

  private async remove(a: Record<string, unknown>): Promise<FileToolResult> {
    const c = checkRelPath(a.path);
    if (!c.ok) return fail(c.why);
    if (c.segs.length === 0) return fail('a file path is required');
    const ch = await this.chain(c.segs, false);
    if (!ch.ok) return fail(ch.missing ? 'no such file' : ch.why);
    const abs = path.join(ch.parent, c.segs[c.segs.length - 1]);
    const pr = await this.probe(abs);
    if (pr.kind === 'missing') return fail('no such file');
    if (pr.kind === 'refused') return fail(pr.why);
    if (pr.kind === 'dir') return fail('only files can be deleted, not folders');
    await fsp.unlink(abs);
    return ok(`deleted ${c.segs.join('/')}`);
  }
}
