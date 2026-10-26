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
import { isLockfilePath } from '../shared/nexus/changeSet';
import { PRIVATE_KEY_HEADER, hasProviderKey, looksSecret } from '../shared/nexus/secretShape';
import { GIT_DIFF_MAX_BYTES_PER_SIDE } from '../shared/nexus/execution';
import { redactSecretText } from '../main/nexus/activity/redact';

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
/**
 * THE preview's patch: the one argv (and, below, the one text transform) behind the diff the user reviews. gitRead's
 * `diff` read runs exactly this and `previewText` over its output (acceptService then applies redactSecretText once more);
 * collect runs the same argv and judges completeness on the same text, so what is decided is what is shown. Change it in
 * one place only.
 */
export const PREVIEW_DIFF_ARGS: readonly string[] = Object.freeze(['diff', ...SAFE_DIFF_ARGS, '--no-renames']);
/** A surrogate half with no partner (a valid astral character is a PAIR and is kept). */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** What the preview does to the raw patch text before it leaves the runner. */
export function previewText(raw: string): string { return redactSecretText(raw).replace(LONE_SURROGATE_RE, '\uFFFD'); }
/**
 * How many lines of the preview's text differ from the raw patch once the preview's own transforms have run (the runner's
 * `previewText`, then acceptService's second redactSecretText). 0 = the user sees every character of the change. The redactors
 * work on the WHOLE text (a quoted value, a private-key block and an unterminated key run across newlines), so this is judged
 * on the whole patch, context and removed lines included, never line by line. A count of changed lines only, never text.
 */
export function previewHiddenLines(raw: string): number {
  const seen = redactSecretText(previewText(raw));
  if (seen === raw) return 0;
  const a = raw.split(String.fromCharCode(10)); const b = seen.split(String.fromCharCode(10));
  let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return Math.max(1, a.length - pre - suf, b.length - pre - suf);
}
/**
 * Characters that make a patch read differently from how it runs, or that the review pane shows as nothing (Trojan Source):
 * bidi controls (U+202A-202E, U+2066-2069, U+200E/F, U+061C), zero-width and invisible characters (U+200B-200D, U+2060-2064,
 * U+FEFF, U+180E), the Unicode line and paragraph separators (U+2028/9) and the C0/C1 control characters (U+0000-001F, U+007F-009F)
 * except tab, line feed and carriage return (an ESC sequence, a form feed, a backspace). Two exceptions, nothing else: a ZERO WIDTH
 * JOINER between two emoji (a family or a flag sequence) and a byte-order mark as the very first character of a file's first line.
 */
const UNSAFE_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const EMOJI_BEFORE_RE = /[\p{Extended_Pictographic}\u{FE0F}\p{Emoji_Modifier}]$/u;
const EMOJI_AFTER_RE = /^\p{Extended_Pictographic}/u;
const HUNK_HEAD_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/**
 * How many characters of the preview's text are unsafe to show as they are (see UNSAFE_CHAR_RE). The whole patch is judged,
 * context and removed lines included, because the user reads them all. A COUNT only: never the characters or their line.
 */
export function previewUnsafeChars(raw: string): number {
  let count = 0;
  let bomAt = -1;                                              // the one place a BOM is the file's own: after the marker of line 1
  for (const line of raw.split('\n')) {
    const bomHere = bomAt; bomAt = -1;
    const head = HUNK_HEAD_RE.exec(line);
    if (head && Number(head[1]) <= 1 && Number(head[2]) <= 1) bomAt = 1;
    UNSAFE_CHAR_RE.lastIndex = 0;
    for (let m = UNSAFE_CHAR_RE.exec(line); m !== null; m = UNSAFE_CHAR_RE.exec(line)) {
      const ch = m[0]; const at = m.index;
      if (ch === '\u200D' && EMOJI_BEFORE_RE.test(line.slice(Math.max(0, at - 4), at)) && EMOJI_AFTER_RE.test(line.slice(at + 1, at + 5))) continue;
      if (ch === '\uFEFF' && at === bomHere) continue;
      count++;
    }
  }
  return count;
}
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
  | 'git_failed' | 'integration_diverged' | 'base_moved' | GuardRefusal;
export const GIT_FAILURE_CODES: readonly GitFailureCode[] = Object.freeze([
  'git_missing', 'bad_task', 'repo_layout_unsupported', 'repo_empty', 'branch_missing', 'worktree_tampered', 'worktree_conflict',
  'link_or_gitlink', 'ref_moved', 'unknown_commit', 'merge_conflict', 'tree_dirty', 'branch_mismatch', 'not_fast_forward', 'git_failed',
  'integration_diverged', 'base_moved', 'symlink_in_worktree', 'nested_repo', 'worktree_too_large', 'file_too_large'
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
  /**
   * B2b B6: the integration ref was moved forward to (or found already moved forward to) a commit on the user's branch, from the
   * head main recorded (`integrationBefore`). `integrationHead` is then the new head; main records it as the new baseline
   * (activity row `repo.integration_resync`) in the same ingest. Absent from an older runner: no resync.
   */
  integrationResynced?: boolean; integrationBefore?: string | null;
  /** The resync was a REWRITE (the branch head does not descend from the old ref: the user amended, rebased or reset); main allowed it. */
  integrationRewrite?: boolean;
  /** The user's branch head the task saw. */
  branchHead?: string;
}

/**
 * `repo.worktree`: the integration ref at the branch head when absent (CAS on absence), the session ref at the
 * integration head when absent, then a detached worktree at the session ref, locked. Idempotent: a ref that exists is
 * kept, a worktree that exists (with the exact pointer) is reused, a lock that exists stays.
 *
 * RESYNC (B2b B6). The integration ref is made once; the user then commits on their own branch, and a stale ref would start every
 * later session from old code and make "Merge accepted work" impossible. So, when the ref exists:
 * - it is an ANCESTOR of the branch head (the branch already holds everything accepted: every accept is on the ref's history),
 *   and `t.expectedIntegrationHead` (the head main RECORDED: the newest accept's, resync's or initial one) is where the ref is:
 *   it is moved forward to the branch head by compare-and-swap, and reported (`integrationResynced`, `integrationBefore`);
 * - the ref is not where main recorded it, but the recorded head is its ancestor and it is itself on the branch: an earlier
 *   attempt of this job moved it and died before main recorded it; it is reported again (no write), so main records it now;
 * - the branch head is an ancestor of the ref (accepted work still waits to be merged): nothing is touched;
 * - neither is an ancestor of the other (`integration_diverged`): nothing is touched and the task refuses, so the turn says so
 *   instead of starting from code that is not the user's. EXCEPT a REWRITE: when main says nothing was accepted after the recorded
 *   head (`t.allowRewrite`), the user's amend, rebase or reset is theirs to make, so the ref is moved to the new branch head by the
 *   same compare-and-swap from the recorded value and reported (`integrationRewrite`).
 * The ref only ever moves forward along the user's own history; it never takes an accept's or an agent's commit.
 */
export async function ensureWorktree(g: HardenedGit, t: { repoPath: string; worktreePath: string; ref: string; integrationRef: string; branch: string;
  expectedIntegrationHead?: string | null; allowRewrite?: boolean },
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
  let integrationResynced = false;
  let integrationBefore: string | null = null;
  let integrationRewrite = false;
  if (!integrationCreated) {
    const isAncestor = async (a: string, b: string): Promise<boolean> => {
      const r = await g.run(repo, ['merge-base', '--is-ancestor', a, b], { neutral: n, signal: o.signal });
      if (r.code !== 0 && r.code !== 1) throw new GitFailure('git_failed', 'git could not compare the integration ref with the branch');
      return r.code === 0;
    };
    const expected = typeof t.expectedIntegrationHead === 'string' && COMMIT_RE.test(t.expectedIntegrationHead) ? t.expectedIntegrationHead : null;
    // Main allows a REWRITE only when nothing was accepted after the recorded head (it computes that from its own records, never from
    // the agent): then the branch head may replace the ref even when it does not descend from it (the user amended, rebased or reset).
    const allowRewrite = t.allowRewrite === true && expected !== null;
    const same = integrationHead === head;
    if (same) {
      // The ref is the branch head. If main's record is older, an earlier attempt moved it and died before the record: report it again.
      if (expected !== null && integrationHead !== expected) {
        if (await isAncestor(expected, integrationHead)) { integrationBefore = expected; integrationResynced = true; }
        else if (allowRewrite) { integrationBefore = expected; integrationResynced = true; integrationRewrite = true; }
      }
    } else if (expected !== null && integrationHead === expected) {
      const forward = await isAncestor(integrationHead, head);
      if (forward || allowRewrite) {
        if (await updateRefCas(g, repo, n, t.integrationRef, head, integrationHead, o.signal)) {
          integrationBefore = integrationHead; integrationHead = head; integrationResynced = true; integrationRewrite = !forward;
        } else {
          const again = await resolveRef(g, repo, n, t.integrationRef, o.signal);
          if (!again) throw new GitFailure('git_failed', 'the integration ref disappeared');
          integrationHead = again;
        }
      } else if (!(await isAncestor(head, integrationHead))) {
        throw new GitFailure('integration_diverged', 'the integration ref and the branch have both moved on');
      }
      // else: the ref is ahead of the branch (accepted work waits to be merged): nothing is touched.
    } else if (await isAncestor(integrationHead, head)) {
      // Not where main recorded it, but on the branch: moved forward from the recorded head by an earlier attempt that died first.
      if (expected !== null && await isAncestor(expected, integrationHead)) { integrationBefore = expected; integrationResynced = true; }
    } else if (!(await isAncestor(head, integrationHead))) {
      throw new GitFailure('integration_diverged', 'the integration ref and the branch have both moved on');
    }
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
  return { ok: true, integrationHead, integrationCreated, ref: t.ref, base, worktree: `wt/${name}`, locked: true, reused, branchHead: head,
    ...(integrationResynced ? { integrationResynced: true, integrationBefore, ...(integrationRewrite ? { integrationRewrite: true } : {}) } : {}) };
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
  /** An added line holding a provider key or a private-key header (`diffLineSecret`): path and line only, never the text. */
  secretHits: { path: string; line: number; rule: 'provider_key' | 'private_key' }[];
  /** Advisory: an added line outside a lockfile that looks high-entropy (`looksSecret`): path and line only. */
  entropyHits: { path: string; line: number; rule: 'high_entropy' }[];
  /**
   * The patch the scan reads was cut at its stdout cap, so the scan did not see every added line: `sec.secret_scan`
   * must FAIL on it (a secret past the cut would otherwise pass), never pass.
   */
  scanTruncated: boolean;
  /**
   * Whether the user can review the WHOLE change in Nexus's own diff preview (A1). Counts and a closed code only, never
   * line text: `hidden_lines` = lines of the preview's text (context and removed lines too, multi-line spans included) that
   * its own redaction alters (the user would see `[redacted]`, yet sec.secret_scan does not block them; `hiddenLines` counts
   * the changed lines), `too_large` = the preview's patch would exceed its cap, `binary_file` = the preview shows a file
   * only as "Binary files differ" (the scan reads it as text, the user cannot), `unsafe_characters` = the preview's text holds characters
   * that read differently from how they run or show as nothing (bidi controls, zero-width characters, control characters;
   * `unsafeChars` counts them), `truncated` = the secret scan itself was cut. Main stores it in the version's metadata; absent counts as NOT complete.
   */
  preview: { complete: boolean; reason?: 'hidden_lines' | 'too_large' | 'truncated' | 'binary_file' | 'unsafe_characters'; hiddenLines: number; unsafeChars: number; patchBytes: number };
}
/** The most hits of each kind a collect reports (the count itself, and every `location` evidence item, stay bounded). */
export const COLLECT_MAX_HITS = 500;
/** The most patch text a collect scans (past it, `scanTruncated`). */
export const COLLECT_PATCH_MAX_BYTES = 16 * 2 ** 20;
/**
 * Pathspecs every collect appends, whatever scope main supplied: the agent CLI writes its own settings under
 * `<worktree>/.claude/` (Task 0), which must never be staged or committed.
 */
export const COLLECT_ALWAYS_EXCLUDE: readonly string[] = Object.freeze([
  ':(glob,icase,exclude).claude', ':(glob,icase,exclude).claude/**', ':(glob,icase,exclude)**/.claude', ':(glob,icase,exclude)**/.claude/**'
]);

/**
 * Scans a zero-context unified diff (`git diff -U0`) for added lines, classifying each by `diffLineSecret` (blocking)
 * and, outside a lockfile, `looksSecret` (advisory). Only the path and the 1-based line number of a hit are kept: the
 * line's text is read here and discarded; it is never returned, logged or stored (D-B14).
 */
export function scanAddedLines(patch: string): { secretHits: CollectFacts['secretHits']; entropyHits: CollectFacts['entropyHits'] } {
  const secretHits: CollectFacts['secretHits'] = [];
  const entropyHits: CollectFacts['entropyHits'] = [];
  let currentPath: string | null = null;
  let newLine = 0;
  // Counts left in the current hunk (`@@ -a,b +c,d @@`): while either is positive EVERY line is hunk content, so an
  // added line whose text starts `++` (the diff line `+++...`) or `@@` is scanned as content, never read as a header.
  let oldLeft = 0; let newLeft = 0;
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) continue;                                  // "\ No newline at end of file"
      if (line.startsWith('-') && oldLeft > 0) { oldLeft--; continue; }
      if (line.startsWith('+') && newLeft > 0) {
        newLeft--;
        const text = line.slice(1);
        const at = newLine++;
        const path = currentPath;
        if (!path) continue;
        const priv = PRIVATE_KEY_HEADER.test(text);
        if (priv || hasProviderKey(text)) {
          if (secretHits.length < COLLECT_MAX_HITS) secretHits.push({ path, line: at, rule: priv ? 'private_key' : 'provider_key' });
        }
        if (!isLockfilePath(path) && looksSecret(text)) {
          if (entropyHits.length < COLLECT_MAX_HITS) entropyHits.push({ path, line: at, rule: 'high_entropy' });
        }
        continue;
      }
      oldLeft = 0; newLeft = 0;                                               // malformed: leave the hunk, read it as a header
    }
    if (line.startsWith('+++ ')) {
      currentPath = patchPath(line.slice(4), 'b/');
      continue;
    }
    if (line.startsWith('@@ ')) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) { oldLeft = m[1] === undefined ? 1 : Number(m[1]); newLeft = m[3] === undefined ? 1 : Number(m[3]); newLine = Number(m[2]); }
    }
  }
  return { secretHits, entropyHits };
}

/** A `---`/`+++` header's path: git's C-style quoting undone, a trailing tab (a name with a space) dropped, the prefix removed; null for /dev/null. */
const UNREADABLE_PATH = '(unreadable path)';
function patchPath(rest: string, prefix: string): string | null {
  let p = rest.replace(/\t.*$/, '');
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    const bytes: number[] = [];
    const chars = [...p.slice(1, -1)];                       // by code point: a non-BMP character is one unit, never split
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
      const n = chars[++i];
      // A trailing backslash is malformed: the path is unreadable, and an unreadable path is still attributed (never dropped),
      // so a hit under it is reported rather than silently skipped.
      if (n === undefined) return UNREADABLE_PATH;
      if (n >= '0' && n <= '7') { let o = n; while (o.length < 3 && chars[i + 1] !== undefined && chars[i + 1] >= '0' && chars[i + 1] <= '7') o += chars[++i]; bytes.push(parseInt(o, 8) & 0xff); }
      else bytes.push(({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
    }
    p = Buffer.from(bytes).toString('utf8');
  }
  if (p === '/dev/null') return null;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

const isExcludeSpec = (s: string): boolean => s.startsWith(':(glob,exclude)') || s.startsWith(':(glob,icase,exclude)');

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
  o: { dataRoot: string; signal?: AbortSignal; fs?: typeof fsp; guardFs?: GuardFs; /** Tests only: a smaller patch cap. */ patchMaxBytes?: number }): Promise<CollectFacts> {
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
  // One `add -A` per positive scope entry, each carrying EVERY exclude: a single call with several entries stages
  // NOTHING when any one of them matches no file (git answers 128 "did not match any files" for the whole call), which
  // silently dropped the work in the entries that did match. An entry that matches nothing stages nothing (tolerated);
  // any other failure stops. `-A` keeps its meaning per entry (new, modified and deleted paths under it).
  const specs = scopePathspecs(t.scope);
  const excludes = [...specs.filter(isExcludeSpec), ...COLLECT_ALWAYS_EXCLUDE];
  for (const spec of specs.filter((s) => !isExcludeSpec(s))) {
    const add = await g.run(t.worktreePath, ['add', '-A', '--', spec, ...excludes], { neutral: n, worktree: wt, signal: o.signal, timeoutMs: 10 * GIT_TIMEOUT_MS, eol: true });
    if (add.code !== 0 && !/did not match any files/.test(add.stderr)) throw new GitFailure('git_failed', 'add failed');
  }
  const ls = must(await g.run(t.worktreePath, ['ls-files', '-s', '-z'], { neutral: n, worktree: wt, signal: o.signal, maxStdout: 64 * 2 ** 20 }), 'ls-files');
  if (ls.truncated) throw new GitFailure('worktree_too_large', 'the index is too large');
  for (const entry of ls.stdout.split('\0')) {
    if (entry.startsWith('120000 ') || entry.startsWith('160000 ')) throw new GitFailure('link_or_gitlink', 'the index holds a link or a gitlink');
  }
  // The guard runs again right before the tree is written: nothing planted between the walk and the add is committed.
  const again = await walk(t.worktreePath, { maxFileBytes: t.maxFileBytes, maxTotalBytes: t.maxTotalBytes, fs: o.guardFs });
  if (!again.ok) throw new GitFailure(again.code, 'the worktree guard refused the tree');
  const tree = shaOut(await g.run(t.worktreePath, ['write-tree'], { neutral: n, worktree: wt, signal: o.signal }), 'write-tree');
  // The merge base is the same before and after the commit below (the new commit's only new ancestor is itself), so it is read here,
  // and a change that touches a gitlink in ANY way is refused BEFORE anything is committed. The index scan above sees only the gitlinks
  // that are still there: an agent that removes an uninitialized submodule's empty folder stages its DELETION (or swaps it for a
  // file), the entry is gone from `ls-files`, and every `--ignore-submodules=all` diff below omits it: the user would approve a
  // change that silently removes their submodule. The raw tree diff has no such option: a 160000 mode on either side is a gitlink.
  const integration = await resolveRef(g, repo, n, t.integrationRef, o.signal);
  if (!integration) throw new GitFailure('ref_moved', 'the integration ref is gone');
  const base = shaOut(await g.run(repo, ['merge-base', integration, parent], { neutral: n, signal: o.signal }), 'merge-base');
  const raw = must(await g.run(repo, ['diff-tree', '-r', '--raw', '--no-renames', '--no-ext-diff', '-z', base, tree], { neutral: n, signal: o.signal, maxStdout: 8 * 2 ** 20 }), 'diff-tree');
  if (/(?:^|\0):(?:160000 |\d{6} 160000 )/.test(raw.stdout)) throw new GitFailure('link_or_gitlink', 'the change adds, removes or changes a gitlink');
  if (raw.truncated) throw new GitFailure('worktree_too_large', 'the change touches too many paths to check for gitlinks');
  const parentTree = shaOut(await g.run(repo, ['rev-parse', `${parent}^{tree}`], { neutral: n, signal: o.signal }), 'rev-parse');
  let head = parent;
  const changed = tree !== parentTree;
  if (changed) {
    head = shaOut(await g.run(repo, ['commit-tree', tree, '-p', parent, '-m', t.message], { neutral: n, signal: o.signal, identity: AGENT_IDENTITY }), 'commit-tree');
    if (!(await updateRefCas(g, repo, n, t.ref, head, parent, o.signal))) throw new GitFailure('ref_moved', 'the session ref moved');
    must(await g.run(t.worktreePath, ['update-ref', '--no-deref', 'HEAD', head], { neutral: n, worktree: wt, signal: o.signal }), 'update-ref HEAD');
  }
  const ns = must(await g.run(repo, ['diff', ...SAFE_DIFF_ARGS, '--no-renames', '--numstat', '-z', base, head], { neutral: n, signal: o.signal, maxStdout: 8 * 2 ** 20 }), 'diff');
  const diffstat = { files: 0, insertions: 0, deletions: 0 };
  const paths: string[] = [];
  let pathsTruncated = ns.truncated;
  let binaryFiles = 0;
  for (const rec of ns.stdout.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
    if (!m) continue;
    // Without --text, git reports a file it treats as binary (a NUL byte, a -diff/binary attribute) as `-	-`: the preview
    // shows it only as "Binary files differ".
    if (m[1] === '-' && m[2] === '-') binaryFiles++;
    diffstat.files++;
    diffstat.insertions += m[1] === '-' ? 0 : Number(m[1]);
    diffstat.deletions += m[2] === '-' ? 0 : Number(m[2]);
    if (paths.length < COLLECT_MAX_PATHS) paths.push(m[3]); else pathsTruncated = true;
  }
  // F29/D-B14: a zero-context patch of the same base..head, scanned for secret- and entropy-shaped added lines. The
  // patch text is read only here, inside this function, and discarded; `scanAddedLines` returns path:line only.
  const patch = must(await g.run(repo, ['-c', 'core.quotePath=false', 'diff', ...SAFE_DIFF_ARGS, '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--text', '-U0', base, head],
    { neutral: n, signal: o.signal, maxStdout: o.patchMaxBytes ?? COLLECT_PATCH_MAX_BYTES }), 'diff -U0');
  const { secretHits, entropyHits } = scanAddedLines(patch.stdout);
  // The preview's own patch: PREVIEW_DIFF_ARGS (what gitRead runs: default context, at most 2 x GIT_DIFF_MAX_BYTES_PER_SIDE).
  // Larger than that the user is shown only "too large". A failed read is not a verdict either: incomplete.
  const previewMax = GIT_DIFF_MAX_BYTES_PER_SIDE * 2;
  const pd = await g.run(repo, [...PREVIEW_DIFF_ARGS, base, head], { neutral: n, signal: o.signal, maxStdout: previewMax + 4 });
  const previewTooLarge = pd.code !== 0 || pd.truncated || pd.stdoutBytes > previewMax || ns.truncated;
  const scanTruncated = patch.truncated === true;
  // Completeness is decided on the preview's OWN text (the whole patch, as the user is shown it), never on the scan's lines.
  const binaryInPreview = binaryFiles > 0 || (pd.code === 0 && /^Binary files .* differ$/m.test(pd.stdout));
  const hiddenLines = pd.code === 0 && !previewTooLarge ? previewHiddenLines(pd.stdout) : 0;
  const unsafeChars = pd.code === 0 && !previewTooLarge ? previewUnsafeChars(pd.stdout) : 0;
  const reason = scanTruncated || pd.code !== 0 ? 'truncated' as const : previewTooLarge ? 'too_large' as const
    : binaryInPreview ? 'binary_file' as const : unsafeChars > 0 ? 'unsafe_characters' as const : hiddenLines > 0 ? 'hidden_lines' as const : undefined;
  const preview: CollectFacts['preview'] = { complete: reason === undefined, ...(reason ? { reason } : {}), hiddenLines, unsafeChars, patchBytes: pd.code === 0 ? pd.stdoutBytes : 0 };
  // `--text` renders every file as text, overriding a NUL byte and any `-diff`/`binary` attribute: otherwise such a file
  // is "Binary files differ" and never scanned, and a secret could hide in it. The cost is that a huge real binary now
  // fills the patch cap; that is the same fail-closed outcome (scanTruncated -> sec.secret_scan fails scan_truncated).
  // A patch cut at the cap was not fully scanned: reported, so main fails the secret scan (never passes it).
  return { ok: true, changed, parent, head, tree, base, ref: t.ref, diffstat, paths, pathsTruncated, secretHits, entropyHits, scanTruncated, preview };
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
 *
 * `t.base` is the commit the change was made on (the version's recorded `metadata.base`, from main): the change the user reviewed is
 * `base..head`. It must be an ancestor of `expectedOld`, else (`base_moved`) the user's branch was amended or reset since, the merge
 * would also bring in older commits of `head`'s history that the preview never showed, and nothing is merged.
 */
export async function accept(g: HardenedGit, t: { repoPath: string; integrationRef: string; expectedOld: string; head: string; message: string; base?: string },
  o: { signal?: AbortSignal; onPrepared: (p: { old: string; new: string }) => Promise<void> | void }): Promise<{ ok: true; old: string; new: string; mergeCommit: string; tree: string }> {
  if (!isNexusRef(t.integrationRef, 'accepted') || !COMMIT_RE.test(t.expectedOld) || typeof t.message !== 'string' || t.message.length === 0
    || t.message.length > 8192 || t.message.includes('\0')) throw new GitFailure('bad_task', 'the accept task is malformed');
  const n = await g.neutral(t.repoPath, o.signal);
  await requireCommit(g, t.repoPath, n, t.head, o.signal);
  const cur = await resolveRef(g, t.repoPath, n, t.integrationRef, o.signal);
  if (cur !== t.expectedOld) throw new GitFailure('ref_moved', 'the integration ref moved');
  if (t.base !== undefined) {
    if (!COMMIT_RE.test(t.base)) throw new GitFailure('bad_task', 'the accept task is malformed');
    const anc = await g.run(t.repoPath, ['merge-base', '--is-ancestor', t.base, t.expectedOld], { neutral: n, signal: o.signal });
    if (anc.code === 1) throw new GitFailure('base_moved', 'the ground the change was made on has moved');
    if (anc.code !== 0) throw new GitFailure('unknown_commit', "the change's base is not in the repository");
  }
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
