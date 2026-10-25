/**
 * The runner's git WRITES (B2b Task 7): the six engine recipes that run as system child jobs. This is Nexus's first write
 * into the user's `.git`, allowed only after the project's A3 approval (main checks it before it queues anything), and
 * only into what A3 names: refs under `refs/nexus/*` (D-B13), the worktree entry `.git/worktrees/<name>`, new objects in
 * `.git/objects`, and a locked worktree under the Nexus data folder (`<dataHome>/wt/<session>`). Nothing here touches the
 * user's branch, index or files, except `repo.ff`: the dialog-confirmed fast-forward of "Merge accepted work".
 *
 * Every call keeps B2a's hardening (src/runner/git.ts): the ONE resolved absolute git binary (src/main/gitBinary.ts),
 * launched from the data home through `runGit`, the repository named by `-C` (`gitPrefix`: `core.fsmonitor=false` and a
 * hooks folder that does not exist), every configured filter driver switched off (`neutralizeFilterArgs`) with
 * `GIT_LFS_SKIP_SMUDGE=1` (`toolEnv`), and every signature program the git binary itself (`inertSignatureArgs`). On top:
 * - GIT_WRITE_CONFIG: no signing, no symlinks (a link in a commit checks out as a plain file), long paths, no automatic
 *   gc or maintenance (they would rewrite the user's object store), no submodule recursion, no `file://` transport;
 * - GIT_EOL_CONFIG (`core.autocrlf=false`, `core.eol=lf`, as B2a's `ARCHIVE_EOL_CONFIG`): passed only on `run()` calls
 *   marked `eol: true` — the session worktree's checkout (`worktree add`) and its stage (`collect`'s `add -A`). A
 *   Windows default of autocrlf would otherwise check the session worktree out with CRLF for a Linux container, and a
 *   collect would then commit bytes the agent never wrote. It is never passed on a call that reads or writes the
 *   user's own checked-out repository (`fastForward`'s status/merge-ff-only, `gitRead`'s status): forcing it there
 *   would compare or check out the user's tracked files against the user's own `core.autocrlf` setting, which can
 *   make an untouched CRLF file look "modified" (a spurious `tree_dirty`) or write LF-only files into their tree.
 * - every configured merge driver switched off (`merge.<name>.driver=`): `merge-tree` runs a repository's merge driver
 *   program otherwise (verified with git 2.55); an attribute naming one then answers a conflict, never a program;
 * - `--ignore-submodules=all` on status and diff, `--no-ext-diff --no-textconv` on every diff.
 * A command that works in a session worktree (`collect`) names the worktree's git folder and work tree explicitly
 * (`--git-dir`, `--work-tree`), after checking the worktree's `.git` pointer file names exactly the git folder main
 * derived; any other content is `worktree_tampered` and nothing is committed. Worktrees are created with
 * `worktree add --detach` and locked with `worktree lock --reason "Nexus session"`.
 *
 * Results are facts for main to re-validate (`git-facts`); a failure is `{ ok: false, code }` from GIT_FAILURE_CODES
 * only (main words it as a sentence). No file name, branch content or git error text is ever a fact.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  FILTER_CONFIG_ARGV, filterDriverNames, gitResolver, insideFolder, isGitBinary, neutralizeFilterArgs, resolveGitBinary
} from '../main/gitBinary';
import { gitPrefix, inertSignatureArgs, COMMIT_RE } from './git';
import { runGit, toolEnv, type RunResult } from './proc';
import { walk, type GuardFs, type GuardRefusal } from './worktreeGuard';

export const GIT_WRITE_CONFIG: readonly string[] = Object.freeze([
  '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.symlinks=false', '-c', 'core.longpaths=true',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false', '-c', 'protocol.file.allow=never'
]);
/** Only on a call marked `eol: true` (session-worktree checkout and stage); see the header comment. */
export const GIT_EOL_CONFIG: readonly string[] = Object.freeze(['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']);
/** Read-only: every configured `merge.*` key, one per line (exit 1 with no output when there is none). */
export const MERGE_CONFIG_ARGV: readonly string[] = Object.freeze(['config', '--name-only', '--get-regexp', '^merge\\.']);
/** Diff options on every diff Nexus runs: no external diff driver, no textconv, no submodule content. */
export const SAFE_DIFF_ARGS: readonly string[] = Object.freeze(['--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-color']);
/** D-B8: the agent's commits, and accept merges. */
export const AGENT_IDENTITY = Object.freeze({ name: 'Nexus agent', email: 'agent@nexus.invalid' });
export const ACCEPT_IDENTITY = Object.freeze({ name: 'Nexus', email: 'agent@nexus.invalid' });
export const WORKTREE_LOCK_REASON = 'Nexus session';
/** The most changed paths a collect reports. */
export const COLLECT_MAX_PATHS = 5000;
const ZERO = '0'.repeat(40);
const GIT_TIMEOUT_MS = 60_000;
const SMALL = 64 * 1024;

export type GitFailureCode =
  | 'git_missing' | 'bad_task' | 'repo_layout_unsupported' | 'repo_empty' | 'branch_missing' | 'worktree_tampered' | 'worktree_conflict'
  | 'link_or_gitlink' | 'ref_moved' | 'unknown_commit' | 'merge_conflict' | 'tree_dirty' | 'branch_mismatch' | 'not_fast_forward'
  | 'git_failed' | GuardRefusal;
export const GIT_FAILURE_CODES: readonly GitFailureCode[] = Object.freeze([
  'git_missing', 'bad_task', 'repo_layout_unsupported', 'repo_empty', 'branch_missing', 'worktree_tampered', 'worktree_conflict',
  'link_or_gitlink', 'ref_moved', 'unknown_commit', 'merge_conflict', 'tree_dirty', 'branch_mismatch', 'not_fast_forward', 'git_failed',
  'symlink_in_worktree', 'nested_repo', 'worktree_too_large', 'file_too_large'
] as GitFailureCode[]);

export class GitFailure extends Error {
  readonly code: GitFailureCode;
  constructor(code: GitFailureCode, message: string) { super(message); this.name = 'GitFailure'; this.code = code; }
}

/** A branch name git accepts (check-ref-format's rules, conservatively): what `refs/nexus/accepted/<branch>` may hold. */
export const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\/\.)(?!\.)(?!.*\.lock(?:\/|$))(?!.*[/.]$)[A-Za-z0-9._/-]{1,200}$/;
/** A lowercased session id (a ULID), the worktree's folder name and the session ref's last segment. */
export const SESSION_NAME_RE = /^[0-9a-z]{26}$/;

export interface Neutral { args: readonly string[] }

/**
 * The hardened git launcher the write and read engines share (the runner's B2a launcher's rules, see the header). One
 * instance per data home; the resolved binary is kept, a miss asked again (`gitResolver`).
 */
export class HardenedGit {
  private readonly resolver: ReturnType<typeof gitResolver>;
  constructor(private readonly o: { cwd: string; resolve?: () => Promise<string | null> }) {
    this.resolver = gitResolver(o.resolve ?? (() => resolveGitBinary(fsp)));
  }

  /** A folder under the data home that never exists: git finds no hooks there. */
  get hooksDir(): string { return path.join(this.o.cwd, '.nexus-no-git-hooks'); }

  async available(): Promise<boolean> {
    const bin = await this.resolver.get();
    return !!bin && isGitBinary(bin);
  }

  private async bin(): Promise<string> {
    const bin = await this.resolver.get();
    if (!bin || !isGitBinary(bin)) throw new GitFailure('git_missing', 'git is not installed');
    return bin;
  }

  /**
   * The `-c` pairs that switch off every filter driver and merge driver the repository's config (any scope) names, and
   * point every signature program at git itself. Read once per engine task; an unreadable name refuses the task.
   */
  async neutral(repoPath: string, signal?: AbortSignal): Promise<Neutral> {
    const bin = await this.bin();
    const f = await this.run(repoPath, FILTER_CONFIG_ARGV, { signal, neutral: { args: [] } });
    const filters = f.code === 0 && !f.truncated ? filterDriverNames(f.stdout) : f.code === 1 && f.stdoutBytes === 0 ? [] : null;
    const m = await this.run(repoPath, MERGE_CONFIG_ARGV, { signal, neutral: { args: [] } });
    const merges = m.code === 0 && !m.truncated ? mergeDriverNames(m.stdout) : m.code === 1 && m.stdoutBytes === 0 ? [] : null;
    if (filters === null || merges === null) throw new GitFailure('git_failed', 'the configured drivers could not be read; refused');
    return { args: [...neutralizeFilterArgs(filters), ...merges.flatMap((n) => ['-c', `merge.${n}.driver=`]), ...inertSignatureArgs(bin)] };
  }

  /**
   * One git call. `repoPath` is named with `-C`; `worktree` adds the explicit `--git-dir` / `--work-tree` (callers check
   * the pointer file first). `neutral` is required: a call never runs without the driver switches.
   */
  async run(repoPath: string, argv: readonly string[], o: { neutral: Neutral; signal?: AbortSignal; maxStdout?: number; timeoutMs?: number;
    worktree?: { gitDir: string; workTree: string }; identity?: { name: string; email: string }; eol?: boolean }): Promise<RunResult> {
    if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath) || repoPath.includes('\0')) throw new GitFailure('bad_task', 'the folder is not an absolute path');
    const bin = await this.bin();
    if (insideFolder(bin, repoPath) || insideFolder(bin, this.o.cwd) || (o.worktree && insideFolder(bin, o.worktree.workTree))) {
      throw new GitFailure('git_failed', 'git resolves inside the repository; refused');
    }
    const wt = o.worktree ? [`--git-dir=${o.worktree.gitDir}`, `--work-tree=${o.worktree.workTree}`] : [];
    const env = toolEnv();
    if (o.identity) {
      env.GIT_AUTHOR_NAME = o.identity.name; env.GIT_AUTHOR_EMAIL = o.identity.email;
      env.GIT_COMMITTER_NAME = o.identity.name; env.GIT_COMMITTER_EMAIL = o.identity.email;
    }
    const r = await runGit(bin, [...gitPrefix(repoPath, this.hooksDir), ...GIT_WRITE_CONFIG, ...(o.eol ? GIT_EOL_CONFIG : []), ...o.neutral.args, ...wt, ...argv],
      { cwd: this.o.cwd, env, timeoutMs: o.timeoutMs ?? GIT_TIMEOUT_MS, maxStdout: o.maxStdout ?? SMALL, maxStderr: 4096, signal: o.signal });
    if (r.error === 'ENOENT') { this.resolver.forget(); throw new GitFailure('git_missing', 'git is not installed'); }
    if (r.error) throw new GitFailure('git_failed', `git could not run (${r.error})`);
    return r;
  }
}

/**
 * The merge driver names in `git config --name-only --get-regexp "^merge\."` output (`merge.<name>.<key>`; keys without
 * a subsection such as `merge.conflictstyle` name no driver). Null when a name cannot be passed back as `-c <key>=`.
 */
export function mergeDriverNames(stdout: string): string[] | null {
  const out: string[] = [];
  for (const raw of String(stdout).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    if (!line.toLowerCase().startsWith('merge.')) return null;
    const last = line.lastIndexOf('.');
    if (last <= 'merge.'.length - 1) continue;
    const name = line.slice('merge.'.length, last);
    if (name === '') continue;
    if (/[=\u0000-\u001f\u007f]/.test(name)) return null;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

const norm = (p: string): string => {
  const s = path.resolve(p.trim()).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

/** The repository's own git folder: `<repo>/.git` must be a real folder (a repository whose `.git` is a file is not supported). */
export async function commonGitDir(repoPath: string, fs: Pick<typeof fsp, 'lstat'> = fsp): Promise<string> {
  const dir = path.join(repoPath, '.git');
  let st;
  try { st = await fs.lstat(dir); } catch { throw new GitFailure('repo_layout_unsupported', 'the project folder has no .git folder'); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new GitFailure('repo_layout_unsupported', 'the project folder\'s .git is not a folder');
  return dir;
}

/**
 * Checks a session worktree's `.git` pointer: a plain file (not a link, one name) of at most 4 KiB whose only content is
 * `gitdir: <gitDir>` naming exactly `expectedGitDir`, which must itself be a real folder. Anything else is
 * `worktree_tampered`. Reads only that small file.
 */
export async function verifyWorktreePointer(worktreePath: string, expectedGitDir: string, fs: Pick<typeof fsp, 'lstat' | 'readFile'> = fsp): Promise<void> {
  const tampered = (why: string): never => { throw new GitFailure('worktree_tampered', `the worktree's git pointer was changed (${why})`); };
  let st;
  try { st = await fs.lstat(path.join(worktreePath, '.git')); } catch { return tampered('missing'); }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1 || st.size > 4096) tampered('not a plain file');
  const text = (await fs.readFile(path.join(worktreePath, '.git'), 'utf8')).replace(/^﻿/, '');
  const m = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(text);
  if (!m) return tampered('not a pointer');
  if (norm(m[1]) !== norm(expectedGitDir)) tampered('another git folder');
  let g;
  try { g = await fs.lstat(expectedGitDir); } catch { return tampered('the git folder is gone'); }
  if (g.isSymbolicLink() || !g.isDirectory()) tampered('the git folder is not a folder');
}

/** The commit a ref names, or null when it does not exist. */
async function resolveRef(g: HardenedGit, repo: string, n: Neutral, ref: string, signal?: AbortSignal): Promise<string | null> {
  const r = await g.run(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { neutral: n, signal });
  const sha = r.stdout.trim();
  return r.code === 0 && COMMIT_RE.test(sha) ? sha : null;
}

function must(r: RunResult, what: string): RunResult {
  if (r.code !== 0) throw new GitFailure('git_failed', `${what} failed`);
  return r;
}

function shaOut(r: RunResult, what: string): string {
  const sha = must(r, what).stdout.trim().split(/\r?\n/)[0] ?? '';
  if (!COMMIT_RE.test(sha)) throw new GitFailure('git_failed', `${what} did not answer an object id`);
  return sha;
}

async function updateRefCas(g: HardenedGit, repo: string, n: Neutral, ref: string, next: string, old: string, signal?: AbortSignal): Promise<boolean> {
  const r = await g.run(repo, ['update-ref', '-m', 'nexus', ref, next, old], { neutral: n, signal });
  return r.code === 0;
}

function isNexusRef(ref: string, kind: 'job' | 'accepted'): boolean {
  const pre = kind === 'job' ? 'refs/nexus/job/' : 'refs/nexus/accepted/';
  return typeof ref === 'string' && ref.startsWith(pre) && BRANCH_RE.test(ref.slice(pre.length));
}

/** The worktree's folder name, checked: `<dataRoot>/wt/<session>` exactly. */
export function worktreeName(dataRoot: string, worktreePath: string): string {
  if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath)) throw new GitFailure('bad_task', 'the worktree is not an absolute path');
  const name = path.basename(worktreePath);
  if (!SESSION_NAME_RE.test(name) || norm(path.dirname(worktreePath)) !== norm(path.join(dataRoot, 'wt'))) {
    throw new GitFailure('bad_task', 'the worktree is not a session folder of this data home');
  }
  return name;
}

// ---------- repo.worktree ----------

export interface WorktreeFacts {
  ok: true; integrationHead: string; integrationCreated: boolean; ref: string; base: string; worktree: string; locked: true; reused: boolean;
}

/**
 * `repo.worktree`: the integration ref at the branch head when absent (CAS on absence), the session ref at the
 * integration head when absent, then a detached worktree at the session ref, locked. Idempotent: a ref that exists is
 * kept, a worktree that exists (with the exact pointer) is reused, a lock that exists stays.
 */
export async function ensureWorktree(g: HardenedGit, t: { repoPath: string; worktreePath: string; ref: string; integrationRef: string; branch: string },
  o: { dataRoot: string; signal?: AbortSignal; fs?: typeof fsp }): Promise<WorktreeFacts> {
  const fs = o.fs ?? fsp;
  if (!BRANCH_RE.test(t.branch) || t.integrationRef !== `refs/nexus/accepted/${t.branch}` || !isNexusRef(t.ref, 'job')) {
    throw new GitFailure('bad_task', 'the refs are not Nexus refs of this branch');
  }
  const name = worktreeName(o.dataRoot, t.worktreePath);
  if (t.ref !== `refs/nexus/job/${name}`) throw new GitFailure('bad_task', 'the session ref is not the worktree\'s');
  const common = await commonGitDir(t.repoPath, fs);
  const gitDir = path.join(common, 'worktrees', name);
  const n = await g.neutral(t.repoPath, o.signal);
  const repo = t.repoPath;
  // The branch head; an unborn HEAD with no branch at all is an empty repository.
  const head = await resolveRef(g, repo, n, `refs/heads/${t.branch}`, o.signal);
  if (!head) {
    const any = await g.run(repo, ['for-each-ref', '--count=1', '--format=%(objectname)', 'refs/heads'], { neutral: n, signal: o.signal });
    if (any.code === 0 && any.stdout.trim() === '') throw new GitFailure('repo_empty', 'the repository has no commits yet');
    throw new GitFailure('branch_missing', 'the branch is not in the repository');
  }
  let integrationHead = await resolveRef(g, repo, n, t.integrationRef, o.signal);
  let integrationCreated = false;
  if (!integrationHead) {
    integrationCreated = await updateRefCas(g, repo, n, t.integrationRef, head, ZERO, o.signal);
    integrationHead = await resolveRef(g, repo, n, t.integrationRef, o.signal);
    if (!integrationHead) throw new GitFailure('git_failed', 'the integration ref could not be created');
  }
  let base = await resolveRef(g, repo, n, t.ref, o.signal);
  if (!base) {
    await updateRefCas(g, repo, n, t.ref, integrationHead, ZERO, o.signal);
    base = await resolveRef(g, repo, n, t.ref, o.signal);
    if (!base) throw new GitFailure('git_failed', 'the session ref could not be created');
  }
  let exists = false;
  try {
    const st = await fs.lstat(t.worktreePath);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new GitFailure('worktree_tampered', 'the worktree folder is not a folder');
    exists = true;
  } catch (e) { if (e instanceof GitFailure) throw e; }
  let adminExists = false;
  try { adminExists = (await fs.lstat(gitDir)).isDirectory(); } catch { adminExists = false; }
  let reused = false;
  if (exists) {
    await verifyWorktreePointer(t.worktreePath, gitDir, fs);
    reused = true;
  } else {
    // A registered entry whose folder is gone (an interrupted earlier attempt, or a removed folder) is ours by name:
    // `add -f -f` replaces it; a fresh session adds a new one.
    const argv = ['worktree', 'add', ...(adminExists ? ['-f', '-f'] : []), '--detach', t.worktreePath, base];
    const add = await g.run(repo, argv, { neutral: n, signal: o.signal, timeoutMs: 10 * GIT_TIMEOUT_MS, eol: true });
    if (add.code !== 0) throw new GitFailure('git_failed', 'the worktree could not be added');
    try { await verifyWorktreePointer(t.worktreePath, gitDir, fs); } catch { throw new GitFailure('worktree_conflict', 'git named the worktree entry differently'); }
  }
  if (!(await isLocked(g, repo, n, t.worktreePath, o.signal))) {
    const lock = await g.run(repo, ['worktree', 'lock', '--reason', WORKTREE_LOCK_REASON, t.worktreePath], { neutral: n, signal: o.signal });
    if (lock.code !== 0 && !(await isLocked(g, repo, n, t.worktreePath, o.signal))) throw new GitFailure('git_failed', 'the worktree could not be locked');
  }
  return { ok: true, integrationHead, integrationCreated, ref: t.ref, base, worktree: `wt/${name}`, locked: true, reused };
}

/** Whether `git worktree list --porcelain` shows the worktree at `p` locked. */
export async function isLocked(g: HardenedGit, repo: string, n: Neutral, p: string, signal?: AbortSignal): Promise<boolean> {
  const r = must(await g.run(repo, ['worktree', 'list', '--porcelain'], { neutral: n, signal, maxStdout: 4 * 2 ** 20 }), 'worktree list');
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const wt = lines.find((l) => l.startsWith('worktree '));
    if (wt && norm(wt.slice('worktree '.length)) === norm(p)) return lines.some((l) => l === 'locked' || l.startsWith('locked '));
  }
  return false;
}

// ---------- changeset.collect ----------

export interface CollectFacts {
  ok: true; changed: boolean; parent: string; head: string; tree: string; base: string; ref: string;
  diffstat: { files: number; insertions: number; deletions: number }; paths: string[]; pathsTruncated: boolean;
}

/**
 * `:(glob)` pathspecs of a change-set scope (`!x` excludes); an empty scope is the whole tree. Every entry must be a
 * relative pattern: no magic prefix (`:`), no root or UNC path (`/`, `\`), no drive letter (`C:/x`, `c:\x`, and the
 * drive-relative `C:x`), no `..`, no NUL or line break.
 */
export function scopePathspecs(scope: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of scope) {
    if (typeof s !== 'string' || s.length === 0 || s.length > 512 || /[\0\r\n]/.test(s) || /^!?[:/\\]/.test(s) || /^!?[A-Za-z]:/.test(s)
      || s.includes('..')) {
      throw new GitFailure('bad_task', 'a scope entry is not a relative pattern');
    }
    out.push(s.startsWith('!') ? `:(glob,exclude)${s.slice(1)}` : `:(glob)${s}`);
  }
  if (!out.some((p) => !p.startsWith(':(glob,exclude)'))) out.unshift(':(glob)**');
  return out;
}

/**
 * `changeset.collect`: the worktree pointer checked, the tree guarded (links, nested repositories, sizes), the paths in
 * scope staged, links and gitlinks in the index refused, the tree committed as the agent on the session ref (CAS from
 * its current head) and the worktree's HEAD moved with it; then the merge base with the integration ref and the
 * diffstat. Nothing is committed on any refusal.
 */
export async function collect(g: HardenedGit, t: { repoPath: string; worktreePath: string; gitDir: string; ref: string; integrationRef: string;
  scope: string[]; message: string; maxFileBytes: number; maxTotalBytes: number },
  o: { dataRoot: string; signal?: AbortSignal; fs?: typeof fsp; guardFs?: GuardFs }): Promise<CollectFacts> {
  const fs = o.fs ?? fsp;
  const name = worktreeName(o.dataRoot, t.worktreePath);
  if (t.ref !== `refs/nexus/job/${name}` || !isNexusRef(t.integrationRef, 'accepted') || typeof t.message !== 'string' || t.message.length === 0
    || t.message.length > 8192 || t.message.includes('\0')) throw new GitFailure('bad_task', 'the collect task is malformed');
  const common = await commonGitDir(t.repoPath, fs);
  const gitDir = path.join(common, 'worktrees', name);
  if (norm(t.gitDir) !== norm(gitDir)) throw new GitFailure('bad_task', 'the git folder is not the worktree\'s');
  await verifyWorktreePointer(t.worktreePath, gitDir, fs);
  const guard = await walk(t.worktreePath, { maxFileBytes: t.maxFileBytes, maxTotalBytes: t.maxTotalBytes, fs: o.guardFs });
  if (!guard.ok) throw new GitFailure(guard.code, 'the worktree guard refused the tree');
  const n = await g.neutral(t.repoPath, o.signal);
  const wt = { gitDir, workTree: t.worktreePath };
  const repo = t.repoPath;
  const parent = await resolveRef(g, repo, n, t.ref, o.signal);
  if (!parent) throw new GitFailure('ref_moved', 'the session ref is gone');
  const add = await g.run(t.worktreePath, ['add', '-A', '--', ...scopePathspecs(t.scope)], { neutral: n, worktree: wt, signal: o.signal, timeoutMs: 10 * GIT_TIMEOUT_MS, eol: true });
  // A scope that matches no file stages nothing (git answers 128 "did not match any files"); any other failure stops.
  if (add.code !== 0 && !/did not match any files/.test(add.stderr)) throw new GitFailure('git_failed', 'add failed');
  const ls = must(await g.run(t.worktreePath, ['ls-files', '-s', '-z'], { neutral: n, worktree: wt, signal: o.signal, maxStdout: 64 * 2 ** 20 }), 'ls-files');
  if (ls.truncated) throw new GitFailure('worktree_too_large', 'the index is too large');
  for (const entry of ls.stdout.split('\0')) {
    if (entry.startsWith('120000 ') || entry.startsWith('160000 ')) throw new GitFailure('link_or_gitlink', 'the index holds a link or a gitlink');
  }
  // The guard runs again right before the tree is written: nothing planted between the walk and the add is committed.
  const again = await walk(t.worktreePath, { maxFileBytes: t.maxFileBytes, maxTotalBytes: t.maxTotalBytes, fs: o.guardFs });
  if (!again.ok) throw new GitFailure(again.code, 'the worktree guard refused the tree');
  const tree = shaOut(await g.run(t.worktreePath, ['write-tree'], { neutral: n, worktree: wt, signal: o.signal }), 'write-tree');
  const parentTree = shaOut(await g.run(repo, ['rev-parse', `${parent}^{tree}`], { neutral: n, signal: o.signal }), 'rev-parse');
  let head = parent;
  const changed = tree !== parentTree;
  if (changed) {
    head = shaOut(await g.run(repo, ['commit-tree', tree, '-p', parent, '-m', t.message], { neutral: n, signal: o.signal, identity: AGENT_IDENTITY }), 'commit-tree');
    if (!(await updateRefCas(g, repo, n, t.ref, head, parent, o.signal))) throw new GitFailure('ref_moved', 'the session ref moved');
    must(await g.run(t.worktreePath, ['update-ref', '--no-deref', 'HEAD', head], { neutral: n, worktree: wt, signal: o.signal }), 'update-ref HEAD');
  }
  const integration = await resolveRef(g, repo, n, t.integrationRef, o.signal);
  if (!integration) throw new GitFailure('ref_moved', 'the integration ref is gone');
  const base = shaOut(await g.run(repo, ['merge-base', integration, head], { neutral: n, signal: o.signal }), 'merge-base');
  const ns = must(await g.run(repo, ['diff', ...SAFE_DIFF_ARGS, '--no-renames', '--numstat', '-z', base, head], { neutral: n, signal: o.signal, maxStdout: 8 * 2 ** 20 }), 'diff');
  const diffstat = { files: 0, insertions: 0, deletions: 0 };
  const paths: string[] = [];
  let pathsTruncated = ns.truncated;
  for (const rec of ns.stdout.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
    if (!m) continue;
    diffstat.files++;
    diffstat.insertions += m[1] === '-' ? 0 : Number(m[1]);
    diffstat.deletions += m[2] === '-' ? 0 : Number(m[2]);
    if (paths.length < COLLECT_MAX_PATHS) paths.push(m[3]); else pathsTruncated = true;
  }
  return { ok: true, changed, parent, head, tree, base, ref: t.ref, diffstat, paths, pathsTruncated };
}

// ---------- changeset.merge_check, changeset.accept, changeset.accept_rollback ----------

/** `merge-tree --write-tree` of `head` onto `onto`: the merged tree, or null on a conflict. Writes objects, never a ref. */
async function mergeTree(g: HardenedGit, repo: string, n: Neutral, onto: string, head: string, signal?: AbortSignal): Promise<string | null> {
  const r = await g.run(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', onto, head], { neutral: n, signal, timeoutMs: 5 * GIT_TIMEOUT_MS });
  if (r.code === 1) return null;
  return shaOut(r, 'merge-tree');
}

async function requireCommit(g: HardenedGit, repo: string, n: Neutral, sha: string, signal?: AbortSignal): Promise<void> {
  if (!COMMIT_RE.test(sha)) throw new GitFailure('bad_task', 'not a full commit id');
  const r = await g.run(repo, ['cat-file', '-e', `${sha}^{commit}`], { neutral: n, signal });
  if (r.code !== 0) throw new GitFailure('unknown_commit', 'the commit is not in the repository');
}

export async function mergeCheck(g: HardenedGit, t: { repoPath: string; integrationRef: string; head: string }, o: { signal?: AbortSignal } = {}):
  Promise<{ ok: true; clean: boolean; tree: string | null; integrationHead: string }> {
  if (!isNexusRef(t.integrationRef, 'accepted')) throw new GitFailure('bad_task', 'the integration ref is not a Nexus ref');
  const n = await g.neutral(t.repoPath, o.signal);
  await requireCommit(g, t.repoPath, n, t.head, o.signal);
  const integrationHead = await resolveRef(g, t.repoPath, n, t.integrationRef, o.signal);
  if (!integrationHead) throw new GitFailure('ref_moved', 'the integration ref is gone');
  const tree = await mergeTree(g, t.repoPath, n, integrationHead, t.head, o.signal);
  return { ok: true, clean: tree !== null, tree, integrationHead };
}

/**
 * `changeset.accept`: the integration ref must still be `expectedOld` (else `ref_moved`); the merged tree (a conflict is
 * `merge_conflict`) is committed as Nexus with both parents; `onPrepared({ old, new })` is reported BEFORE the CAS
 * `update-ref` (main records it durably; recovery rolls an unfinished accept back from it).
 */
export async function accept(g: HardenedGit, t: { repoPath: string; integrationRef: string; expectedOld: string; head: string; message: string },
  o: { signal?: AbortSignal; onPrepared: (p: { old: string; new: string }) => Promise<void> | void }): Promise<{ ok: true; old: string; new: string; mergeCommit: string; tree: string }> {
  if (!isNexusRef(t.integrationRef, 'accepted') || !COMMIT_RE.test(t.expectedOld) || typeof t.message !== 'string' || t.message.length === 0
    || t.message.length > 8192 || t.message.includes('\0')) throw new GitFailure('bad_task', 'the accept task is malformed');
  const n = await g.neutral(t.repoPath, o.signal);
  await requireCommit(g, t.repoPath, n, t.head, o.signal);
  const cur = await resolveRef(g, t.repoPath, n, t.integrationRef, o.signal);
  if (cur !== t.expectedOld) throw new GitFailure('ref_moved', 'the integration ref moved');
  const tree = await mergeTree(g, t.repoPath, n, t.expectedOld, t.head, o.signal);
  if (!tree) throw new GitFailure('merge_conflict', 'the change does not merge cleanly');
  const merge = shaOut(await g.run(t.repoPath, ['commit-tree', tree, '-p', t.expectedOld, '-p', t.head, '-m', t.message],
    { neutral: n, signal: o.signal, identity: ACCEPT_IDENTITY }), 'commit-tree');
  await o.onPrepared({ old: t.expectedOld, new: merge });
  if (!(await updateRefCas(g, t.repoPath, n, t.integrationRef, merge, t.expectedOld, o.signal))) throw new GitFailure('ref_moved', 'the integration ref moved');
  return { ok: true, old: t.expectedOld, new: merge, mergeCommit: merge, tree };
}

/** `changeset.accept_rollback`: the integration ref back from `from` to `to` by CAS; already at `to` is done. */
export async function rollback(g: HardenedGit, t: { repoPath: string; integrationRef: string; from: string; to: string }, o: { signal?: AbortSignal } = {}):
  Promise<{ ok: true; from: string; to: string; already: boolean }> {
  if (!isNexusRef(t.integrationRef, 'accepted') || !COMMIT_RE.test(t.from) || !COMMIT_RE.test(t.to)) throw new GitFailure('bad_task', 'the rollback task is malformed');
  const n = await g.neutral(t.repoPath, o.signal);
  const cur = await resolveRef(g, t.repoPath, n, t.integrationRef, o.signal);
  if (cur === t.to) return { ok: true, from: t.from, to: t.to, already: true };
  if (cur !== t.from) throw new GitFailure('ref_moved', 'the integration ref is neither the accepted nor the earlier head');
  await requireCommit(g, t.repoPath, n, t.to, o.signal);
  if (!(await updateRefCas(g, t.repoPath, n, t.integrationRef, t.to, t.from, o.signal))) throw new GitFailure('ref_moved', 'the integration ref moved');
  return { ok: true, from: t.from, to: t.to, already: false };
}

// ---------- repo.ff ----------

/**
 * `repo.ff`: the user's checked-out branch must be `branch`, the tree clean (tracked files; no merge, rebase or
 * cherry-pick in progress) and `sha` a fast-forward of HEAD; then `merge --ff-only <sha>`. Any refusal changes nothing.
 */
export async function fastForward(g: HardenedGit, t: { repoPath: string; branch: string; sha: string }, o: { signal?: AbortSignal; fs?: typeof fsp } = {}):
  Promise<{ ok: true; before: string; after: string; branch: string }> {
  const fs = o.fs ?? fsp;
  if (!BRANCH_RE.test(t.branch) || !COMMIT_RE.test(t.sha)) throw new GitFailure('bad_task', 'the fast-forward task is malformed');
  const common = await commonGitDir(t.repoPath, fs);
  const n = await g.neutral(t.repoPath, o.signal);
  const repo = t.repoPath;
  const b = await g.run(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { neutral: n, signal: o.signal });
  if (b.code !== 0 || b.stdout.trim() !== t.branch) throw new GitFailure('branch_mismatch', 'another branch is checked out');
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    try { await fs.lstat(path.join(common, marker)); throw new GitFailure('tree_dirty', 'an operation is in progress in the repository'); } catch (e) { if (e instanceof GitFailure) throw e; }
  }
  const s = must(await g.run(repo, ['status', '--porcelain=v1', '-z', '--ignore-submodules=all', '--untracked-files=no'], { neutral: n, signal: o.signal, maxStdout: 0 }), 'status');
  if (s.stdoutBytes > 0) throw new GitFailure('tree_dirty', 'the working tree has uncommitted changes');
  await requireCommit(g, repo, n, t.sha, o.signal);
  const before = shaOut(await g.run(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], { neutral: n, signal: o.signal }), 'rev-parse');
  const anc = await g.run(repo, ['merge-base', '--is-ancestor', before, t.sha], { neutral: n, signal: o.signal });
  if (anc.code === 1) throw new GitFailure('not_fast_forward', 'the accepted work is not a fast-forward of the branch');
  must(anc, 'merge-base');
  must(await g.run(repo, ['merge', '--ff-only', '--no-edit', '--no-stat', t.sha], { neutral: n, signal: o.signal, timeoutMs: 10 * GIT_TIMEOUT_MS }), 'merge');
  const after = shaOut(await g.run(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], { neutral: n, signal: o.signal }), 'rev-parse');
  if (after !== t.sha) throw new GitFailure('git_failed', 'the branch did not land on the confirmed commit');
  return { ok: true, before, after, branch: t.branch };
}
