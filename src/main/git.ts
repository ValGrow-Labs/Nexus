import { spawn } from 'node:child_process';
import { lstat, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { safeJoin } from './fs';
import {
  configEnv, FILTER_CONFIG_ARGV, FILTER_SAFE_ENV, filterDriverNames, gitResolver, inertSignatureConfig, insideFolder, isGitBinary, NO_DIFF_DRIVERS,
  neutralizeFilterArgs, resolveGitBinary, SAFE_GIT_CONFIG
} from './gitBinary';

/** The subcommands main runs that convert repository content through filter drivers (status cleans work-tree files). */
const FILTERING_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'archive']);

/**
 * The git binary, resolved to an absolute path (src/main/gitBinary.ts): never `spawn('git', ..., { cwd: repo })`, which
 * on Windows runs a `git.exe` planted in the repository. Main's own working folder is no rule (an app started from `C:\`
 * or the home folder still finds git); a found binary is kept, a miss is asked again on the next call.
 */
const git = gitResolver(() => resolveGitBinary({ stat }));
export function gitBinary(): Promise<string | null> {
  return git.get();
}

/**
 * Run git on the repository at `cwd` with `args`. Returns stdout text or an error (`gitMissing` when no git binary is
 * installed). The resolved binary runs with its own folder as the working folder and `-C <cwd>`, so nothing in `cwd` is
 * ever launched; a binary inside `cwd` is refused. Every call also carries `inertSignatureConfig` (B2a close) as
 * command-scope config in its environment (`configEnv`; the argv is unchanged): a repository's `log.showSignature` and
 * `gpg.*program` never run a program (the legacy `git:*` channels reach a Nexus project folder when it is opened). Calls
 * that can produce a diff pass NO_DIFF_DRIVERS; status ignores dirty submodule work trees (a submodule's own config could
 * name a filter driver the superproject's neutralisation never saw).
 */
async function runGit(cwd: string, args: string[], timeoutMs = 8000): Promise<{
  ok: true; stdout: string;
} | { ok: false; error: string; gitMissing?: true }> {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0') || !path.isAbsolute(cwd)) return { ok: false, error: 'the folder is not an absolute path' };
  const bin = await gitBinary();
  if (!bin || !isGitBinary(bin)) return { ok: false, error: 'git is not installed', gitMissing: true };
  if (insideFolder(bin, cwd)) return { ok: false, error: 'git resolves inside the repository; refused' };
  // A call that converts repository content (status cleans the work tree's files) runs no filter driver (B2a final
  // review B1): every configured one is switched off, read first with the read-only config query.
  let env: NodeJS.ProcessEnv = { ...process.env, ...configEnv(inertSignatureConfig(bin)) };
  if (FILTERING_SUBCOMMANDS.has(args[0])) {
    const names = await runGit(cwd, [...FILTER_CONFIG_ARGV], timeoutMs);
    // Exit 1 with nothing printed: no filter is configured.
    const list = names.ok ? filterDriverNames(names.stdout) : names.error === 'git exited 1' ? [] : null;
    if (list === null) return names.ok ? { ok: false, error: 'a configured filter driver name is refused' } : names;
    args = [...neutralizeFilterArgs(list), ...args];
    env = { ...env, ...FILTER_SAFE_ENV };
  }
  return new Promise((resolve) => {
    const proc = spawn(bin, ['-C', cwd, ...SAFE_GIT_CONFIG, ...args], { cwd: path.dirname(bin), windowsHide: true, shell: false, env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // The binary is gone (uninstalled while the app runs): git is missing, and it is resolved again next time.
      if (e.code === 'ENOENT') { git.forget(); resolve({ ok: false, error: 'git is not installed', gitMissing: true }); return; }
      resolve({ ok: false, error: e.message });
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, error: stderr.trim() || `git exited ${code}` });
    });
  });
}

export interface GitBranchInfo {
  current: string | null;
  detached: boolean;
}
export interface GitStatusEntry {
  path: string;
  index: string;   // staged status char
  worktree: string; // unstaged status char
}
export interface GitStatus {
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: string[];
}
export interface GitCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  time: number; // unix seconds
  refs: string[]; // branch/tag refs
}
export interface GitAheadBehind {
  ahead: number;
  behind: number;
  upstream: string | null;
}

export async function getBranch(cwd: string): Promise<GitBranchInfo | { error: string }> {
  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ok) return { error: head.error };
  const name = head.stdout.trim();
  if (name === 'HEAD') return { current: null, detached: true };
  return { current: name, detached: false };
}

export async function getStatus(cwd: string): Promise<GitStatus | { error: string }> {
  // --ignore-submodules=dirty (B2a close): a submodule's commit change still shows; its work tree (and the filter drivers
  // its own config names) is never read.
  const res = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty']);
  if (!res.ok) return { error: res.error };
  const entries: GitStatusEntry[] = [];
  const untracked: string[] = [];
  const tokens = res.stdout.split('\0').filter(Boolean);
  for (const token of tokens) {
    if (token.length < 3) continue;
    const index = token[0];
    const worktree = token[1];
    const path = token.slice(3);
    if (index === '?' && worktree === '?') untracked.push(path);
    else entries.push({ path, index, worktree });
  }
  return {
    staged: entries.filter(e => e.index !== ' ' && e.index !== '?'),
    unstaged: entries.filter(e => e.worktree !== ' ' && e.worktree !== '?'),
    untracked
  };
}

export async function getLog(cwd: string, n: number): Promise<GitCommit[] | { error: string }> {
  const sep = '\x1e';   // record separator
  const fsep = '\x1f';  // field separator
  const fmt = ['%H', '%P', '%s', '%an', '%at', '%D'].join(fsep) + sep;
  const res = await runGit(cwd, ['log', '--no-show-signature', '--all', `--max-count=${n}`, `--pretty=format:${fmt}`]);
  if (!res.ok) return { error: res.error };
  const out: GitCommit[] = [];
  for (const rec of res.stdout.split(sep)) {
    if (!rec.trim()) continue;
    const [sha, parents, subject, author, atime, refs] = rec.split(fsep);
    if (!sha) continue;
    out.push({
      sha,
      shortSha: sha.slice(0, 7),
      parents: parents.split(' ').filter(Boolean),
      subject: subject ?? '',
      author: author ?? '',
      time: parseInt(atime, 10) || 0,
      refs: (refs ?? '').split(', ').map(s => s.trim()).filter(Boolean)
    });
  }
  return out;
}

export async function getBranches(cwd: string): Promise<{
  local: string[]; remote: string[]; current: string | null;
} | { error: string }> {
  const res = await runGit(cwd, ['branch', '-a', '--format=%(HEAD)\x1f%(refname:short)']);
  if (!res.ok) return { error: res.error };
  let current: string | null = null;
  const local: string[] = [];
  const remote: string[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    const [head, name] = line.split('\x1f');
    if (!name) continue;
    if (head.trim() === '*') current = name;
    if (name.startsWith('remotes/')) remote.push(name.replace(/^remotes\//, ''));
    else local.push(name);
  }
  return { local, remote, current };
}

export async function getAheadBehind(cwd: string): Promise<GitAheadBehind | { error: string }> {
  const up = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.ok) return { ahead: 0, behind: 0, upstream: null };
  const upstream = up.stdout.trim();
  const ab = await runGit(cwd, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
  if (!ab.ok) return { error: ab.error };
  const [ahead, behind] = ab.stdout.trim().split('\t').map(n => parseInt(n, 10) || 0);
  return { ahead, behind, upstream };
}

/** Best-effort detect: is `cwd` actually a git repo? */
export async function isRepo(cwd: string): Promise<boolean> {
  return (await repositoryCheck(cwd)) === true;
}

/**
 * Nexus's repository check (RepoService's `isRepository`): true for a folder inside a git work tree, false for one that
 * is not, and 'git_missing' when no git binary is installed, so a snapshot request answers `unavailable:
 * setup:git_missing` instead of `not_a_repository`.
 */
export async function repositoryCheck(cwd: string): Promise<boolean | 'git_missing'> {
  const res = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!res.ok) return res.gitMissing === true ? 'git_missing' : false;
  return res.stdout.trim() === 'true';
}

const MAX_DIFF_BYTES = 2 * 1024 * 1024; // 2 MB — keep the diff view responsive

/** A file's two sides for a working-tree-vs-HEAD diff. `head` is the committed
 *  version ('' for a new/untracked file); `working` is the on-disk version ('' for
 *  a file deleted from the working tree). The renderer feeds these straight into
 *  Monaco's DiffEditor (original = head, modified = working). */
export interface GitDiff {
  ok: true;
  path: string;            // resolved absolute path (display only)
  relPath: string;
  head: string;
  working: string;
  headExists: boolean;     // file is tracked at HEAD
  workingExists: boolean;  // file is present in the working tree
  isBinary: boolean;       // either side is binary → not text-diffable
}

/**
 * Diff a single file: its committed (HEAD) content vs its current working-tree
 * content. `relPath` MUST be repo-root-relative and is path-validated against
 * `cwd` with the shared fs guard (no escaping the workspace). All git/fs access
 * stays in the main process — the renderer only ever receives the two text sides.
 */
export async function getDiff(
  cwd: string, relPath: string
): Promise<GitDiff | { ok: false; error: string }> {
  const abs = safeJoin(cwd, relPath);
  if (!abs) return { ok: false, error: 'path escapes repository root' };

  // HEAD side: `git show HEAD:<path>` — errors (untracked / new file) → no head version.
  let head = '';
  let headExists = false;
  const show = await runGit(cwd, ['show', ...NO_DIFF_DRIVERS, `HEAD:${relPath}`]);
  if (show.ok) { head = show.stdout; headExists = true; }

  // Working side: read the on-disk file. ENOENT → deleted from the working tree.
  let working = '';
  let workingExists = false;
  let workingBinary = false;
  try {
    const s = await stat(abs);
    if (s.size > MAX_DIFF_BYTES) {
      return { ok: false, error: `file too large to diff (${(s.size / 1048576).toFixed(1)} MB)` };
    }
    const buf = await readFile(abs);
    workingExists = true;
    if (buf.includes(0)) workingBinary = true;
    else working = buf.toString('utf8');
  } catch {
    workingExists = false;
  }

  const isBinary = workingBinary || head.includes('\0');
  return {
    ok: true,
    path: abs,
    relPath,
    head: isBinary ? '' : head,
    working: isBinary ? '' : working,
    headExists,
    workingExists,
    isBinary
  };
}

/** The MAIN working tree of the repository `cwd` belongs to.
 *
 *  For a normal checkout that's just the repo root. For a linked worktree it is
 *  the original repo, NOT the worktree directory — an isolated agent's cwd is
 *  `<harnessHome>/worktrees/<agent-id>`, whose basename is the agent id and says
 *  nothing about which project it's working on. `--git-common-dir` resolves to
 *  the shared `.git` of the main checkout from anywhere in the worktree family.
 *  Returns null when `cwd` isn't a git repo (or git is unavailable). */
export async function mainRepoRoot(cwd: string): Promise<string | null> {
  const res = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!res.ok) return null;
  const gitDir = res.stdout.trim();
  if (!gitDir) return null;
  // `<repo>/.git` → `<repo>`. A bare repo has no working tree to name, so its
  // own path is the best answer we have.
  const stripped = gitDir.replace(/[\\/]\.git[\\/]?$/, '');
  return stripped || gitDir;
}

/** The top-level folder of the working tree `cwd` is in, or null. */
export async function repoToplevel(cwd: string): Promise<string | null> {
  const res = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!res.ok) return null;
  const top = res.stdout.trim();
  return top || null;
}

/** Derive a safe `agent/<id>` branch name from a worktree path's basename. */
function agentBranchFor(wtPath: string): string {
  const base = wtPath.split(/[\\/]/).filter(Boolean).pop() ?? 'agent';
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  return `agent/${slug}`;
}

/** Provision an isolated git worktree for an agent at `wtPath`, branching off
 *  `baseBranch`. Tries to create a fresh `agent/<id>` branch first; if that
 *  branch already exists, falls back to checking out `baseBranch` directly. */
export async function addWorktree(
  cwd: string, wtPath: string, baseBranch: string
): Promise<{ ok: boolean; error?: string }> {
  const branch = agentBranchFor(wtPath);
  const fresh = await runGit(cwd, ['worktree', 'add', wtPath, '-b', branch, baseBranch]);
  if (fresh.ok) return { ok: true };
  // Branch likely already exists (or the path is taken) — retry without -b.
  const fallback = await runGit(cwd, ['worktree', 'add', wtPath, baseBranch]);
  if (fallback.ok) return { ok: true };
  return { ok: false, error: fallback.error };
}

/** Best-effort removal of an agent's worktree. Forced so a dirty tree doesn't
 *  block teardown; failures are surfaced but callers may ignore them. */
export async function removeWorktree(
  cwd: string, wtPath: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await runGit(cwd, ['worktree', 'remove', '--force', wtPath]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.error };
}

/** Does this worktree hold work that must NOT be auto-discarded? `keep` is true if
 *  the working tree is dirty (uncommitted/untracked changes) OR the branch has
 *  commits the base branch doesn't (un-integrated / would-be-PR commits). Ephemeral
 *  workers never push, so "commits ahead of base" is the local proxy for "un-pushed
 *  / open PR" work. Fails SAFE: any git query we can't run is treated as "there
 *  might be work" → keep, so an uncertain state never triggers an auto-remove. */
export async function worktreeHasUnintegratedWork(
  wtPath: string, baseBranch: string
): Promise<{ keep: boolean; detail: string; branch: string; dirty: boolean; ahead: number }> {
  const br = await getBranch(wtPath);
  const branch = 'current' in br && br.current ? br.current : '(detached)';
  // Uncommitted or untracked changes?
  const status = await runGit(wtPath, ['status', '--porcelain']);
  const dirty = status.ok ? status.stdout.trim().length > 0 : true; // unknown → assume dirty
  // Commits on HEAD not reachable from the base branch?
  let ahead = 0;
  let aheadKnown = true;
  const rl = await runGit(wtPath, ['rev-list', '--count', `${baseBranch}..HEAD`]);
  if (rl.ok) {
    const n = parseInt(rl.stdout.trim(), 10);
    ahead = Number.isFinite(n) ? n : 0;
  } else {
    aheadKnown = false; // unknown → assume there is work
  }
  const keep = dirty || ahead > 0 || !aheadKnown;
  const detail = `dirty=${dirty}, commitsAheadOf(${baseBranch})=${aheadKnown ? ahead : 'unknown'}`;
  return { keep, detail, branch, dirty, ahead };
}

/** Is this preserved worker worktree SAFE to garbage-collect — i.e. is its work
 *  fully integrated (or empty) with nothing uncommitted to lose? Used by the
 *  ephemeral-worker GC sweep, which must NEVER discard un-integrated work.
 *
 *  Returns `gc: true` ONLY when BOTH:
 *    (1) the working tree is clean (no uncommitted/untracked changes), AND
 *    (2) the worker's content is already in `baseBranch` — proven by EITHER
 *        commitsAheadOf(base) === 0 (HEAD reachable from base: fast-forward /
 *        plain merge, robust even after base advances) OR `git diff base HEAD`
 *        being empty (base's tree equals HEAD's tree: catches a SQUASH merge,
 *        which leaves the original commits unreachable so the ahead-count alone
 *        would never clear).
 *
 *  Fails SAFE in every other case: a dirty tree, un-integrated commits, OR any
 *  git query we can't run all yield `gc: false` (keep the worktree). This is the
 *  stronger sibling of `worktreeHasUnintegratedWork` — that gate decides whether
 *  to PRESERVE at teardown; this one decides whether a preserved worktree may now
 *  be reclaimed. */
export async function worktreeIsGcSafe(
  wtPath: string, baseBranch: string
): Promise<{ gc: boolean; detail: string }> {
  // (1) Clean tree?
  const status = await runGit(wtPath, ['status', '--porcelain']);
  if (!status.ok) return { gc: false, detail: 'status query failed' };
  if (status.stdout.trim().length > 0) return { gc: false, detail: 'working tree dirty' };
  // (2a) HEAD fully reachable from base (ahead == 0)?
  const rl = await runGit(wtPath, ['rev-list', '--count', `${baseBranch}..HEAD`]);
  if (rl.ok) {
    const n = parseInt(rl.stdout.trim(), 10);
    if (Number.isFinite(n) && n === 0) return { gc: true, detail: `clean + 0 commits ahead of ${baseBranch}` };
  }
  // (2b) base tree identical to HEAD tree (squash-merge / equivalent content)?
  // `git diff --quiet <base> HEAD` → exit 0 (ok) means NO differences.
  const diff = await runGit(wtPath, ['diff', ...NO_DIFF_DRIVERS, '--quiet', baseBranch, 'HEAD']);
  if (diff.ok) return { gc: true, detail: `clean + tree identical to ${baseBranch} (integrated/squashed)` };
  // Either there are real un-integrated commits, or a query failed → keep.
  return { gc: false, detail: `clean but content not yet in ${baseBranch}` };
}

// ─── v0.3.4: history / compare / checkout plumbing (git visualization) ───────

/** Renderer-supplied revs/refs are untrusted strings. Allow the conservative
 *  charset git refs actually use, refuse leading '-' (option injection), and
 *  always pass '--' before any path arguments at call sites. */
export function isSafeRev(rev: string): boolean {
  return rev.length > 0 && rev.length <= 256 && !rev.startsWith('-') && /^[0-9A-Za-z._/^~@{}-]+$/.test(rev);
}

/** Full-history DAG page for the commit graph. Same record shape as getLog but
 *  topologically ordered (the graph layout assumes it) and pageable. Run this
 *  against mainRepoRoot(cwd) so every agent worktree branch appears. */
export async function getLogGraph(cwd: string, n: number, skip = 0): Promise<GitCommit[] | { error: string }> {
  const sep = '\x1e';
  const fsep = '\x1f';
  const fmt = ['%H', '%P', '%s', '%an', '%at', '%D'].join(fsep) + sep;
  const res = await runGit(cwd, [
    'log', '--no-show-signature', '--all', '--topo-order', `--max-count=${n}`, ...(skip > 0 ? [`--skip=${skip}`] : []),
    `--pretty=format:${fmt}`
  ], 15000);
  if (!res.ok) return { error: res.error };
  const out: GitCommit[] = [];
  for (const rec of res.stdout.split(sep)) {
    if (!rec.trim()) continue;
    const [sha, parents, subject, author, atime, refs] = rec.split(fsep);
    if (!sha) continue;
    out.push({
      sha: sha.trim(),
      shortSha: sha.trim().slice(0, 7),
      parents: (parents ?? '').split(' ').filter(Boolean),
      subject: subject ?? '',
      author: author ?? '',
      time: parseInt(atime, 10) || 0,
      refs: (refs ?? '').split(', ').map(s => s.trim()).filter(Boolean)
    });
  }
  return out;
}

export interface GitCommitFile {
  path: string;
  status: string;      // A/M/D/R/C/T…
  oldPath?: string;    // for renames/copies
}

/** Parse `-z --name-status` output shared by diff-tree and diff. Records are
 *  STATUS\0path\0 — with renames/copies STATUS<score>\0old\0new\0. */
function parseNameStatusZ(stdout: string): GitCommitFile[] {
  const tokens = stdout.split('\0').filter((t) => t.length > 0);
  const files: GitCommitFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!/^[A-Z]/.test(status)) continue; // skip stray commit ids
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const oldPath = tokens[i + 1];
      const path = tokens[i + 2];
      i += 2;
      if (path) files.push({ path, status: kind, oldPath });
    } else {
      const path = tokens[i + 1];
      i += 1;
      if (path) files.push({ path, status: kind });
    }
  }
  return files;
}

/** Files touched by one commit (rename-aware). */
export async function getCommitFiles(cwd: string, sha: string): Promise<GitCommitFile[] | { error: string }> {
  if (!isSafeRev(sha)) return { error: 'invalid revision' };
  const res = await runGit(cwd, ['diff-tree', ...NO_DIFF_DRIVERS, '--no-commit-id', '-r', '--root', '-z', '-M', '--name-status', sha, '--']);
  if (!res.ok) return { error: res.error };
  return parseNameStatusZ(res.stdout);
}

const MAX_SHOW_BYTES = 2 * 1024 * 1024; // match getDiff's cap

/** One side of a rev-pinned diff: the file's content at `rev` ('' + exists:false
 *  when the path doesn't exist there — e.g. an added file's parent side). */
export async function getFileAtRev(cwd: string, rev: string, relPath: string): Promise<
  { ok: true; exists: boolean; isBinary: boolean; content: string } | { ok: false; error: string }
> {
  if (!isSafeRev(rev)) return { ok: false, error: 'invalid revision' };
  if (!safeJoin(cwd, relPath)) return { ok: false, error: 'path escapes repository root' };
  const size = await runGit(cwd, ['cat-file', '-s', `${rev}:${relPath}`]);
  if (!size.ok) return { ok: true, exists: false, isBinary: false, content: '' };
  if ((parseInt(size.stdout.trim(), 10) || 0) > MAX_SHOW_BYTES) {
    return { ok: false, error: 'file too large to diff (>2 MB)' };
  }
  const res = await runGit(cwd, ['show', ...NO_DIFF_DRIVERS, `${rev}:${relPath}`]);
  if (!res.ok) return { ok: true, exists: false, isBinary: false, content: '' };
  if (res.stdout.includes('\0')) return { ok: true, exists: true, isBinary: true, content: '' };
  return { ok: true, exists: true, isBinary: false, content: res.stdout };
}

export interface GitCompare {
  ahead: number;        // commits in head, not base
  behind: number;       // commits in base, not head
  mergeBase: string | null;
  files: GitCommitFile[];
}

/** Compare two refs. mode 'three' (default, PR-style): what head adds since the
 *  merge base. mode 'two': the literal state difference base→head. */
export async function compareRefs(cwd: string, base: string, head: string, mode: 'two' | 'three'): Promise<GitCompare | { error: string }> {
  if (!isSafeRev(base) || !isSafeRev(head)) return { error: 'invalid revision' };
  const counts = await runGit(cwd, ['rev-list', '--left-right', '--count', `${base}...${head}`]);
  if (!counts.ok) return { error: counts.error };
  const [behind, ahead] = counts.stdout.trim().split('\t').map((x) => parseInt(x, 10) || 0);
  const mb = await runGit(cwd, ['merge-base', base, head]);
  const mergeBase = mb.ok ? mb.stdout.trim() : null;
  const diffArgs = mode === 'three'
    ? ['diff', ...NO_DIFF_DRIVERS, '-z', '-M', '--name-status', `${base}...${head}`, '--']
    : ['diff', ...NO_DIFF_DRIVERS, '-z', '-M', '--name-status', base, head, '--'];
  const res = await runGit(cwd, diffArgs, 15000);
  if (!res.ok) return { error: res.error };
  return { ahead, behind, mergeBase, files: parseNameStatusZ(res.stdout) };
}

export interface GitWorktreeInfo { path: string; head: string; branch: string | null }

export async function listWorktrees(cwd: string): Promise<GitWorktreeInfo[] | { error: string }> {
  const res = await runGit(cwd, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return { error: res.error };
  const out: GitWorktreeInfo[] = [];
  let cur: Partial<GitWorktreeInfo> = {};
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { if (cur.path) out.push(cur as GitWorktreeInfo); cur = { path: line.slice(9), head: '', branch: null }; }
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  if (cur.path) out.push(cur as GitWorktreeInfo);
  return out;
}

/** Guarded checkout (v0.3.4). FAIL-SAFE philosophy like worktreeHasUnintegratedWork:
 *  any doubt → refuse. Guards here cover the repo itself; the IPC layer adds the
 *  "no agent actively working in this tree" guard (it owns the pty registry). */
export async function checkoutRef(cwd: string, ref: string, detach: boolean): Promise<{ ok: true; detached: boolean } | { ok: false; error: string }> {
  if (!isSafeRev(ref)) return { ok: false, error: 'invalid revision' };
  const st = await getStatus(cwd);
  if ('error' in st) return { ok: false, error: `could not verify a clean tree: ${st.error}` };
  const dirty = st.staged.length + st.unstaged.length;
  if (dirty > 0) {
    return { ok: false, error: `working tree has ${dirty} uncommitted change${dirty === 1 ? '' : 's'} — commit or stash first` };
  }
  const res = await runGit(cwd, detach ? ['switch', '--detach', ref] : ['switch', ref], 15000);
  if (!res.ok) {
    // A branch held by another worktree: name the holder instead of raw stderr.
    if (/already checked out|already used by worktree/i.test(res.error)) {
      const wts = await listWorktrees(cwd);
      const holder = Array.isArray(wts) ? wts.find((w) => w.branch === ref.replace(/^refs\/heads\//, '')) : undefined;
      return { ok: false, error: holder ? `'${ref}' is checked out in another worktree: ${holder.path}` : res.error };
    }
    return { ok: false, error: res.error };
  }
  return { ok: true, detached: detach };
}

/** A commit resolved by git in a known folder: the full sha, its subject and commit time (unix ms). */
export interface ResolvedCommit { commit: string; subject: string; committedAt: number }
const COMMIT_ISH = /^[0-9a-fA-F]{4,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Resolve `sha` to a commit OF THE REPOSITORY AT `cwd`, through git itself:
 * `rev-parse --verify --quiet <sha>^{commit}` then `show -s` on the full sha
 * git returned (never on the caller's text). `sha` must be hex (4 to 40
 * characters), so it can never be read as an option, a ref name or a range.
 * `cwd` must already be a folder main accepted (acceptFsRoot); renderer
 * strings are untrusted. Errors: 'not_a_repository' when git finds no
 * repository at `cwd`, 'not_a_commit' for anything else.
 *
 * Ruling (B1 Task 5 review): git discovers the repository from `cwd` upwards, so a
 * project registered at a sub-folder of a repository (a monorepo package) resolves
 * commits of that PARENT repository. This is allowed on purpose. An annotated tag's
 * sha is peeled to its commit by `^{commit}`; a tree or blob sha is 'not_a_commit'.
 */
export async function resolveCommit(cwd: string, sha: string): Promise<ResolvedCommit | { error: 'not_a_repository' | 'not_a_commit' }> {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) return { error: 'not_a_repository' };
  const classify = async (): Promise<{ error: 'not_a_repository' | 'not_a_commit' }> => {
    const repo = await runGit(cwd, ['rev-parse', '--git-dir']);
    return { error: repo.ok ? 'not_a_commit' : 'not_a_repository' };
  };
  if (typeof sha !== 'string' || !COMMIT_ISH.test(sha)) return classify();
  const parsed = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (!parsed.ok) return classify();
  const full = parsed.stdout.trim().toLowerCase();
  if (!FULL_SHA.test(full)) return { error: 'not_a_commit' };
  // --no-show-signature (B2a stabilization security review): a repository's `log.showSignature=true` would otherwise
  // make `show` verify a signed commit by running the `gpg.program` its own config names (verified with git 2.55).
  const shown = await runGit(cwd, ['show', '-s', '--no-show-signature', '--format=%H%x00%ct%x00%s', full]);
  if (!shown.ok) return { error: 'not_a_commit' };
  const [h, ct, ...rest] = shown.stdout.replace(/\r?\n$/, '').split('\0');
  if ((h ?? '').trim().toLowerCase() !== full) return { error: 'not_a_commit' };
  const seconds = Number.parseInt(ct ?? '', 10);
  return { commit: full, subject: rest.join(' ').trim(), committedAt: Number.isFinite(seconds) ? seconds * 1000 : 0 };
}

/**
 * The commit the project folder's checked-out version points at now (HEAD), as a full sha, or null (no repository, or no commit yet). One fixed
 * argv through runGit; nothing from a caller. "Try it" runs this version when the person tries the project as it stands.
 */
export async function resolveHead(cwd: string): Promise<string | null> {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) return null;
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!r.ok) return null;
  const full = r.stdout.trim().toLowerCase();
  return FULL_SHA.test(full) ? full : null;
}

/** What `initRepository` answers: the repository was set up on branch main, or why not (a plain reason; never git's own text). */
export type InitRepositoryResult = { ok: true; branch: 'main' } | { ok: false; reason: 'not_absolute' | 'not_a_folder' | 'is_link' | 'already_a_repository' | 'git_missing' | 'failed' };

/**
 * Set up git in a NEW folder: `git init` with an empty template (no hooks are copied from the user's templates), branch main, and ONE
 * empty first commit "Start of this project". The folder must be a real folder (not a link) that is not already a repository, nor inside
 * one. The identity is repository-local and only when the user has none (name "Nexus", email "nexus@localhost.invalid"); no global or
 * system config is ever written. Fixed argv through runGit (no shell, no hooks, no filters, no signing). The caller has already checked that
 * the folder is a registered project's root.
 */
export async function initRepository(cwd: string): Promise<InitRepositoryResult> {
  if (typeof cwd !== 'string' || !cwd || cwd.includes(' ') || !path.isAbsolute(cwd)) return { ok: false, reason: 'not_absolute' };
  let st;
  try { st = await lstat(cwd); } catch { return { ok: false, reason: 'not_a_folder' }; }
  if (st.isSymbolicLink()) return { ok: false, reason: 'is_link' };
  if (!st.isDirectory()) return { ok: false, reason: 'not_a_folder' };
  let hasDotGit = true;
  try { await lstat(path.join(cwd, '.git')); } catch { hasDotGit = false; }
  if (hasDotGit) return { ok: false, reason: 'already_a_repository' };
  const inside = await repositoryCheck(cwd);
  if (inside === 'git_missing') return { ok: false, reason: 'git_missing' };
  if (inside === true) return { ok: false, reason: 'already_a_repository' };
  const init = await runGit(cwd, ['init', '--template=']);
  if (!init.ok) return { ok: false, reason: init.gitMissing === true ? 'git_missing' : 'failed' };
  const head = await runGit(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  if (!head.ok) return { ok: false, reason: 'failed' };
  const name = await runGit(cwd, ['config', 'user.name']);
  const email = await runGit(cwd, ['config', 'user.email']);
  const identity = name.ok && name.stdout.trim() && email.ok && email.stdout.trim() ? [] : ['-c', 'user.name=Nexus', '-c', 'user.email=nexus@localhost.invalid'];
  const commit = await runGit(cwd, [...identity, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--no-verify', '-m', 'Start of this project']);
  if (!commit.ok) return { ok: false, reason: 'failed' };
  return { ok: true, branch: 'main' };
}
