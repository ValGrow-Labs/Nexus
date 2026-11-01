/**
 * The runner's git (B2a Task 11): the ONE resolved absolute git binary (src/main/gitBinary.ts; never a `git` inside the
 * repository, never one found through a relative PATH entry), launched from the data home with the repository named by
 * `-C <repo>`, with fixed argv only and the config that keeps a repository's own settings from starting anything:
 * `-c core.fsmonitor=false -c core.hooksPath=<a folder that does not exist>`. A commit is used only after it is
 * validated as 40 lowercase hex characters; the only path ever named is the fixed `nexus.app.json`. Nothing here writes
 * the repository: `git archive` streams a tree out, the snapshot reads refs and status (GIT_OPTIONAL_LOCKS=0, so status
 * never takes the index lock).
 *
 * Filter drivers (B2a final review B1): `archive` smudges and `status` cleans content through any `filter.<name>.*`
 * configured in ANY scope (Git for Windows' system config ships `filter.lfs.*`; git-lfs reaches the network with the
 * user's credentials). Before those two calls the configured names are read (`git config --name-only --get-regexp`,
 * read-only) and every one is switched off with `-c filter.<n>.{smudge,clean,process}= -c filter.<n>.required=false`;
 * `GIT_LFS_SKIP_SMUDGE=1` is in every git call's environment. An LFS-tracked file therefore stages as its pointer text.
 * `archive` also runs with `core.autocrlf=false` and `core.eol=lf`: the checkout a Linux container receives has the
 * committed line endings (a Windows default of autocrlf would rewrite them), so a lockfile hashes in the container as it
 * hashes at the commit.
 *
 * Repository config that starts programs (B2a stabilization security review, verified with git 2.55):
 * - `archive` expands `export-subst` files, and a `$Format:%G?$` placeholder there verifies the commit's signature by
 *   running `gpg.program` (or `gpg.ssh.program` / `gpg.x509.program`) from the repository's own config. Every archive
 *   therefore names all three as the resolved git binary itself (`inertSignatureArgs`): git refuses gpg's options and
 *   exits, the placeholder expands to `N`, and no program of the repository's choosing runs.
 * - `status` recurses into submodules, and a submodule's OWN config can name a filter driver the superproject's
 *   neutralisation never saw (its names are read from the superproject). The snapshot's status therefore runs with
 *   `--ignore-submodules=all` (the staged archive never contains submodule content anyway).
 *
 * The snapshot also records the lockfile at the commit (final batch item 1): the first of `LOCKFILE_PATHS` present as a
 * blob, streamed with `cat-file blob` (raw bytes, no filter, no textconv) and hashed here; only `{ path, sha256 }` leaves.
 */
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  FILTER_CONFIG_ARGV, filterDriverNames, gitResolver, insideFolder, isGitBinary, neutralizeFilterArgs, resolveGitBinary, SAFE_GIT_CONFIG
} from '../main/gitBinary';
import { runGit, toolEnv, type RunResult } from './proc';
import type { RunnerFs } from './types';

export const COMMIT_RE = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 60_000;
const SMALL = 64 * 1024;

export const SNAPSHOT_ARGV = Object.freeze({
  commit: Object.freeze(['rev-parse', '--verify', 'HEAD^{commit}']),
  branch: Object.freeze(['symbolic-ref', '--short', '-q', 'HEAD']),
  status: Object.freeze(['status', '--porcelain=v1', '-z', '--ignore-submodules=all']),
  tree: Object.freeze(['rev-parse', 'HEAD^{tree}'])
});
export const APP_MANIFEST_PATH = 'nexus.app.json';
/** The lockfiles a snapshot records, in order (the first present wins): npm's, then pip's hash-pinned requirements. */
export const LOCKFILE_PATHS: readonly ('package-lock.json' | 'requirements.txt')[] = Object.freeze(['package-lock.json', 'requirements.txt'] as const);
/** A lockfile larger than this is not hashed (the snapshot records none; an install is then refused `lockfile_missing`). */
export const LOCKFILE_MAX_BYTES = 64 * 2 ** 20;
/** The package list a snapshot records beside the lockfile (live preview phase 2): npm's `package.json`, read only up to this size. */
export const MANIFEST_PATH = 'package.json';
export const MANIFEST_MAX_BYTES = 1024 * 1024;
/** The config every `git archive` adds: the committed line endings, whatever the user's autocrlf / eol defaults are. */
export const ARCHIVE_EOL_CONFIG: readonly string[] = Object.freeze(['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']);

/**
 * `git_missing`: no git binary is installed (staging refuses the attempt `git_missing`: the job waits, never fails);
 * `refused`: the resolved binary is inside the repository or the data home; `failed`: anything else.
 */
export type GitErrorKind = 'git_missing' | 'refused' | 'failed';
export class GitError extends Error {
  readonly kind: GitErrorKind;
  constructor(message: string, kind: GitErrorKind = 'failed') { super(message); this.name = 'GitError'; this.kind = kind; }
}

export function archiveArgv(commit: string): string[] {
  if (!COMMIT_RE.test(commit)) throw new GitError('the commit is not a full sha');
  return ['archive', '--format=tar', commit];
}

export function appManifestArgv(commit: string): { size: string[]; show: string[] } {
  if (!COMMIT_RE.test(commit)) throw new GitError('the commit is not a full sha');
  return { size: ['cat-file', '-s', `${commit}:${APP_MANIFEST_PATH}`], show: ['show', `${commit}:${APP_MANIFEST_PATH}`] };
}

export interface SnapshotFacts {
  commit: string; branch: string | null; dirty: boolean; tree: string;
  /** The lockfile at the commit (final batch item 1), or null when none of LOCKFILE_PATHS is a blob there. */
  lockfile: { path: (typeof LOCKFILE_PATHS)[number]; sha256: string } | null;
  /** The npm package list at the commit (hash, and how many add-ons it names), or null when there is none or it is not plain JSON. */
  manifest: { path: typeof MANIFEST_PATH; sha256: string; dependencies: number } | null;
}

export function lockfileArgv(commit: string, rel: (typeof LOCKFILE_PATHS)[number]): { size: string[]; blob: string[] } {
  if (!COMMIT_RE.test(commit)) throw new GitError('the commit is not a full sha');
  if (!LOCKFILE_PATHS.includes(rel)) throw new GitError('not a lockfile path');
  return { size: ['cat-file', '-s', `${commit}:${rel}`], blob: ['cat-file', 'blob', `${commit}:${rel}`] };
}

export function manifestArgv(commit: string): { size: string[]; show: string[] } {
  if (!COMMIT_RE.test(commit)) throw new GitError('the commit is not a full sha');
  return { size: ['cat-file', '-s', `${commit}:${MANIFEST_PATH}`], show: ['cat-file', 'blob', `${commit}:${MANIFEST_PATH}`] };
}

/** How many add-ons a package list names (dependencies, devDependencies, optionalDependencies): a count only, never a name. */
export function countDependencies(json: unknown): number {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return 0;
  let n = 0;
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const v = (json as Record<string, unknown>)[k];
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) n += Object.keys(v).length;
  }
  return n;
}

/**
 * `-c gpg.program=<git> -c gpg.ssh.program=<git> -c gpg.x509.program=<git>`: a signature check git might run (an
 * `export-subst` `%G` placeholder during `archive`) runs the resolved git binary, which refuses gpg's options, instead
 * of a program named by the repository's config.
 */
export function inertSignatureArgs(gitBin: string): string[] {
  return ['-c', `gpg.program=${gitBin}`, '-c', `gpg.ssh.program=${gitBin}`, '-c', `gpg.x509.program=${gitBin}`];
}

/** The options every runner git call starts with (before the subcommand). */
export function gitPrefix(repoPath: string, hooksDir: string): string[] {
  return ['-C', repoPath, ...SAFE_GIT_CONFIG, '-c', `core.hooksPath=${hooksDir}`];
}

export class GitRunner {
  private readonly resolver: ReturnType<typeof gitResolver>;

  /**
   * `cwd`: the neutral working folder (the data home). `resolve`: the binary resolver (tests may inject one); the default
   * is `resolveGitBinary` with no working-folder rule (a runner started from `C:\` or the home folder still finds git).
   * Either way a found binary is kept and a miss is asked again on the next attempt (`gitResolver`).
   */
  constructor(private readonly o: { cwd: string; resolve?: () => Promise<string | null> }) {
    this.resolver = gitResolver(o.resolve ?? (() => resolveGitBinary(fsp)));
  }

  /** A folder under the data home that never exists: git finds no hooks there. */
  get hooksDir(): string { return path.join(this.o.cwd, '.nexus-no-git-hooks'); }

  binary(): Promise<string | null> {
    return this.resolver.get();
  }

  /** Whether a usable git binary is installed (a git engine asks before it reports anything). */
  async available(): Promise<boolean> {
    const bin = await this.binary();
    return !!bin && isGitBinary(bin);
  }

  private async exec(repoPath: string, argv: readonly string[], o: { signal?: AbortSignal; maxStdout?: number; timeoutMs?: number;
    onStdout?: (b: Buffer) => void | Promise<unknown>; filters?: boolean; inertSignatures?: boolean } = {}): Promise<RunResult> {
    if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath) || repoPath.includes('\0')) throw new GitError('the project folder is not an absolute path');
    const bin = await this.binary();
    if (!bin || !isGitBinary(bin)) throw new GitError('git is not installed', 'git_missing');
    if (insideFolder(bin, repoPath) || insideFolder(bin, this.o.cwd)) throw new GitError('git resolves inside the repository; refused', 'refused');
    // A content-converting call (archive, status): every configured filter driver is switched off first (B1).
    let neutral: string[] = [];
    if (o.filters === true) {
      const c = await this.exec(repoPath, FILTER_CONFIG_ARGV, { signal: o.signal });
      // Exit 1 with no output: no filter is configured anywhere.
      const names = c.code === 0 && !c.truncated ? filterDriverNames(c.stdout) : c.code === 1 && c.stdoutBytes === 0 ? [] : null;
      if (names === null) throw new GitError('the configured filter drivers could not be read; refused', 'refused');
      neutral = neutralizeFilterArgs(names);
    }
    if (o.inertSignatures === true) neutral = [...neutral, ...inertSignatureArgs(bin)];
    const r = await runGit(bin, [...gitPrefix(repoPath, this.hooksDir), ...neutral, ...argv], { cwd: this.o.cwd, env: toolEnv(),
      timeoutMs: o.timeoutMs ?? GIT_TIMEOUT_MS, maxStdout: o.maxStdout ?? SMALL, maxStderr: 4096, signal: o.signal, onStdout: o.onStdout });
    if (r.error === 'ENOENT') {
      // The binary is gone (uninstalled while the runner runs): git is missing; it is resolved again next time.
      this.resolver.forget();
      throw new GitError('git is not installed', 'git_missing');
    }
    if (r.error) throw new GitError(`git could not run (${r.error})`);
    return r;
  }

  /**
   * `git archive --format=tar <commit>` into `dest` (created exclusively), hashed while written. Returns the tar's
   * sha256 and size. Refuses a commit that is not 40 hex characters before anything is spawned.
   */
  async archiveTo(fs: RunnerFs, repoPath: string, commit: string, dest: string, o: { signal?: AbortSignal; maxBytes: number }):
    Promise<{ sha256: string; bytes: number }> {
    const argv = archiveArgv(commit);
    const fh = await fs.open(dest, 'wx');
    const h = createHash('sha256');
    let bytes = 0; let overflow = false;
    let writes: Promise<unknown> = Promise.resolve();
    let r: RunResult;
    try {
      r = await this.exec(repoPath, [...ARCHIVE_EOL_CONFIG, ...argv], { signal: o.signal, maxStdout: 0, timeoutMs: 10 * GIT_TIMEOUT_MS, filters: true,
        inertSignatures: true,
        onStdout: (chunk) => {
          if (overflow) return;
          bytes += chunk.length;
          if (bytes > o.maxBytes) { overflow = true; return; }
          h.update(chunk);
          const copy = Buffer.from(chunk);
          writes = writes.then(() => fh.write(copy));
          return writes;
        } });
      await writes;
    } finally { await fh.close(); }
    if (overflow) throw new GitError('the checkout is larger than the staging limit');
    if (r.code !== 0) throw new GitError('git archive failed: the commit is not in this repository');
    return { sha256: h.digest('hex'), bytes };
  }

  /**
   * `repo.snapshot`: HEAD's commit and tree, the short branch name (null when detached), and whether the work tree is
   * dirty. The dirty flag comes from the LENGTH of `status --porcelain=v1 -z` only: no file name leaves the runner.
   */
  async snapshot(repoPath: string, signal?: AbortSignal): Promise<SnapshotFacts> {
    const c = await this.exec(repoPath, SNAPSHOT_ARGV.commit, { signal });
    const commit = c.stdout.trim();
    if (c.code !== 0 || !COMMIT_RE.test(commit)) throw new GitError('HEAD does not resolve to a commit');
    const b = await this.exec(repoPath, SNAPSHOT_ARGV.branch, { signal });
    const branchText = b.stdout.trim();
    const branch = b.code === 0 && branchText.length > 0 && branchText.length <= 255 && !/[\0\s]/.test(branchText) ? branchText : null;
    // Only the length is read; the names in the output are never kept or sent.
    const s = await this.exec(repoPath, SNAPSHOT_ARGV.status, { signal, maxStdout: 0, filters: true });
    if (s.code !== 0) throw new GitError('git status failed');
    const t = await this.exec(repoPath, SNAPSHOT_ARGV.tree, { signal });
    const tree = t.stdout.trim();
    if (t.code !== 0 || !COMMIT_RE.test(tree)) throw new GitError('HEAD has no tree');
    const lockfile = await this.lockfileAt(repoPath, commit, signal);
    const manifest = await this.manifestAt(repoPath, commit, signal);
    return { commit, branch, dirty: s.stdoutBytes > 0, tree, lockfile, manifest };
  }

  /**
   * The first of LOCKFILE_PATHS that is a blob at `commit`, hashed while streamed (`cat-file blob`: the raw committed
   * bytes). Its size is asked first; one over LOCKFILE_MAX_BYTES, or whose streamed size differs, is not recorded.
   */
  async lockfileAt(repoPath: string, commit: string, signal?: AbortSignal): Promise<SnapshotFacts['lockfile']> {
    for (const rel of LOCKFILE_PATHS) {
      const argv = lockfileArgv(commit, rel);
      const size = await this.exec(repoPath, argv.size, { signal });
      const n = Number(size.stdout.trim());
      if (size.code !== 0 || !Number.isSafeInteger(n) || n < 0) continue;
      if (n > LOCKFILE_MAX_BYTES) return null;
      const h = createHash('sha256');
      let bytes = 0;
      const blob = await this.exec(repoPath, argv.blob, { signal, maxStdout: 0, timeoutMs: 5 * GIT_TIMEOUT_MS,
        onStdout: (chunk) => { bytes += chunk.length; if (bytes <= LOCKFILE_MAX_BYTES) h.update(chunk); } });
      if (blob.code !== 0) continue;                       // a tree or something else at that path: not a lockfile
      if (bytes !== n) return null;
      return { path: rel, sha256: h.digest('hex') };
    }
    return null;
  }

  /**
   * The npm package list (`package.json`) at `commit`: hashed as committed, and the number of add-ons it names. A missing file, one over
   * MANIFEST_MAX_BYTES, or text that is not a JSON object is recorded as none (the snapshot never fails for it).
   */
  async manifestAt(repoPath: string, commit: string, signal?: AbortSignal): Promise<SnapshotFacts['manifest']> {
    const argv = manifestArgv(commit);
    const size = await this.exec(repoPath, argv.size, { signal });
    const n = Number(size.stdout.trim());
    if (size.code !== 0 || !Number.isSafeInteger(n) || n < 0 || n > MANIFEST_MAX_BYTES) return null;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const show = await this.exec(repoPath, argv.show, { signal, maxStdout: 0, onStdout: (chunk) => { bytes += chunk.length; if (bytes <= MANIFEST_MAX_BYTES) chunks.push(Buffer.from(chunk)); } });
    if (show.code !== 0 || bytes !== n) return null;
    const raw = Buffer.concat(chunks);
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { return null; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return { path: MANIFEST_PATH, sha256: createHash('sha256').update(raw).digest('hex'), dependencies: countDependencies(parsed) };
  }

  /**
   * `sde.app.assemble`: the text of `nexus.app.json` at `commit`, and nothing else. Its size is asked first; a file over
   * `maxBytes` is refused without being read.
   */
  async readAppManifest(repoPath: string, commit: string, maxBytes: number, signal?: AbortSignal):
    Promise<{ ok: true; text: Buffer } | { ok: false; reason: 'missing' | 'too_large' }> {
    const argv = appManifestArgv(commit);
    const size = await this.exec(repoPath, argv.size, { signal });
    const n = Number(size.stdout.trim());
    if (size.code !== 0 || !Number.isSafeInteger(n)) return { ok: false, reason: 'missing' };
    if (n > maxBytes) return { ok: false, reason: 'too_large' };
    const show = await this.exec(repoPath, argv.show, { signal, maxStdout: maxBytes + 1 });
    if (show.code !== 0) return { ok: false, reason: 'missing' };
    if (show.stdoutBytes > maxBytes) return { ok: false, reason: 'too_large' };
    return { ok: true, text: Buffer.from(show.stdout, 'utf8') };
  }
}
