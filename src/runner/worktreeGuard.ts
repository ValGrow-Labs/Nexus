/**
 * The worktree guard (B2b Task 7, F12): an lstat walk of a session worktree that never follows a link and never reads a
 * file. It runs after every agent exec (Task 11) and before every collect (Task 8), so whatever the agent's tools or the
 * container planted through the read-write bind mount is refused before Nexus's own git looks at the tree.
 *
 * Refusals (the first one found, in walk order):
 * - `symlink_in_worktree`: a symlink, a junction or another reparse point that Node reports as a link, a hard link to a
 *   file (a second name for bytes that may live outside the worktree), or anything that is neither a plain file nor a
 *   folder (a FIFO, a socket, a device). Its target is never resolved, opened or read.
 * - `nested_repo`: a `.git` entry (file or folder, any case, also its 8.3 short name `GIT~<n>` and a trailing dot or
 *   space) anywhere other than the root's own `.git` FILE (a linked worktree's pointer). A nested repository's config can
 *   name programs git would run (an fsmonitor, a filter), so its presence alone refuses the tree.
 * - `worktree_too_large`: more than `maxTotalBytes` in all, more than MAX_ENTRIES entries, or deeper than MAX_DEPTH.
 * - `file_too_large`: one file larger than `maxFileBytes`.
 *
 * The root itself must be a real folder (not a link) whose `.git` is a plain file; a root `.git` folder (a full clone in
 * the worktree's place) is `nested_repo`.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export const GUARD_MAX_TOTAL_BYTES = 8 * 2 ** 30;
export const GUARD_MAX_FILE_BYTES = 50 * 2 ** 20;
/** The most entries one walk visits, and the deepest folder it descends into. */
export const GUARD_MAX_ENTRIES = 500_000;
export const GUARD_MAX_DEPTH = 128;

export type GuardRefusal = 'symlink_in_worktree' | 'nested_repo' | 'worktree_too_large' | 'file_too_large';
export const GUARD_REFUSALS: readonly GuardRefusal[] = Object.freeze(['symlink_in_worktree', 'nested_repo', 'worktree_too_large', 'file_too_large']);

export type GuardResult =
  | { ok: true; files: number; bytes: number }
  | { ok: false; code: GuardRefusal; /** The offending entry, relative to the root, forward slashes (never its target). */ entry: string };

interface StatLike {
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; nlink: number;
}
export interface GuardFs {
  lstat(p: string): Promise<StatLike>;
  readdir(p: string): Promise<string[]>;
}

/** Whether a file name is a `.git` in any spelling Windows resolves to it. */
export function isGitName(name: string): boolean {
  return /^(?:\.git|git~\d+)[. ]*$/i.test(name);
}

/**
 * Walks `root` (see the module header). `fs` defaults to node:fs/promises; tests may pass another with the same shape.
 * Never throws for what it finds: an entry that cannot be read refuses the tree as `symlink_in_worktree` (fail closed).
 */
export async function walk(root: string, o: { maxTotalBytes?: number; maxFileBytes?: number; fs?: GuardFs } = {}): Promise<GuardResult> {
  const maxTotal = o.maxTotalBytes ?? GUARD_MAX_TOTAL_BYTES;
  const maxFile = o.maxFileBytes ?? GUARD_MAX_FILE_BYTES;
  const fs: GuardFs = o.fs ?? fsp;
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0') || !path.isAbsolute(root)) {
    return { ok: false, code: 'symlink_in_worktree', entry: '' };
  }
  let st: StatLike;
  try { st = await fs.lstat(root); } catch { return { ok: false, code: 'symlink_in_worktree', entry: '' }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, code: 'symlink_in_worktree', entry: '' };
  let files = 0; let bytes = 0; let entries = 0;
  const stack: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: '', depth: 0 }];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = await fs.readdir(dir.abs); } catch { return { ok: false, code: 'symlink_in_worktree', entry: dir.rel }; }
    names.sort();
    for (const name of names) {
      const rel = dir.rel === '' ? name : `${dir.rel}/${name}`;
      if (++entries > GUARD_MAX_ENTRIES) return { ok: false, code: 'worktree_too_large', entry: rel };
      const abs = path.join(dir.abs, name);
      let s: StatLike;
      try { s = await fs.lstat(abs); } catch { return { ok: false, code: 'symlink_in_worktree', entry: rel }; }
      if (s.isSymbolicLink()) return { ok: false, code: 'symlink_in_worktree', entry: rel };
      if (isGitName(name)) {
        // The root's own pointer file is the one `.git` allowed; anything else named .git is a nested repository.
        if (dir.rel === '' && name === '.git' && s.isFile() && s.nlink <= 1) continue;
        return { ok: false, code: 'nested_repo', entry: rel };
      }
      if (s.isDirectory()) {
        if (dir.depth + 1 > GUARD_MAX_DEPTH) return { ok: false, code: 'worktree_too_large', entry: rel };
        stack.push({ abs, rel, depth: dir.depth + 1 });
        continue;
      }
      if (!s.isFile() || s.nlink > 1) return { ok: false, code: 'symlink_in_worktree', entry: rel };
      if (s.size > maxFile) return { ok: false, code: 'file_too_large', entry: rel };
      bytes += s.size; files++;
      if (bytes > maxTotal) return { ok: false, code: 'worktree_too_large', entry: rel };
    }
  }
  return { ok: true, files, bytes };
}
