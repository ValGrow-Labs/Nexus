// Change-set rules (B2b): which repository paths an agent's change may touch,
// which names are sensitive at any depth (never collected, never shown to the
// agent), and which files are lockfiles (left out of the advisory entropy notes).
// A change set is the agent's work committed by Nexus on `refs/nexus/job/<lowercased session>`;
// main records these facts in its metadata. Pure; no I/O.

import { deepFreeze } from './freeze';

/** What a change set version records (its storage is the head commit; the integration ref is `refs/nexus/accepted/<branch>`). */
export interface ChangeSetMeta {
  /** The merge base with the integration ref when collected, and the commit Nexus wrote. */
  base: string;
  head: string;
  /** `refs/nexus/job/<lowercased session>` and `refs/nexus/accepted/<branch>`. */
  ref: string;
  integrationRef: string;
  branch: string;
  diffstat: { files: number; insertions: number; deletions: number };
  /** The path scope it was collected under (the domain ceiling's `code.edit` scope, possibly narrowed). */
  scope: string[];
  sessionId: string;
  jobId: string;
  /** The message the agent gave (redacted, at most 2000 characters). */
  message: string;
}

/** The refs Nexus writes, only under `refs/nexus/*` (D-B13). */
export const NEXUS_REF_PREFIX = 'refs/nexus/';
/**
 * A session's job ref and worktree folder, both named after the LOWERCASED session id (session ids are uppercase
 * ULIDs; a ref and a folder name are case-folded on Windows). Exactly what schema v10's `tr_worktrees_insert` accepts
 * for a new worktree: `rel_path = 'wt/' || lower(session_id)` and `ref = 'refs/nexus/job/' || lower(session_id)`.
 */
export const jobRefFor = (sessionId: string): string => `refs/nexus/job/${sessionId.toLowerCase()}`;
/** The worktree folder, relative to the project's Nexus data folder: `wt/<lowercased session id>`. */
export const worktreeRelPathFor = (sessionId: string): string => `wt/${sessionId.toLowerCase()}`;
export const integrationRefFor = (branch: string): string => `refs/nexus/accepted/${branch}`;

/**
 * Sensitive names, case-insensitively at any depth: a `.git` directory or file (also its 8.3 short name `GIT~1`, a
 * trailing dot or space, and an NTFS stream such as `::$DATA`), `.env*`, `*.pem`, `id_rsa*`, `*.key`, `.npmrc` and
 * `.pypirc`. Paths are matched with forward slashes.
 */
export const SENSITIVE_PATH_RE = new RegExp([
  '(?:^|/)(?:\\.git|git~\\d+)[. ]*(?:/|:|$)',     // .git, .GIT, .git., GIT~1, a/.git/config, .git::$DATA
  '::?\\$[a-z_]+',                                // an NTFS stream or attribute: x::$DATA, x:$DATA
  '(?:^|/)\\.env[^/]*$',                          // .env, .env.local
  '\\.pem[. ]*(?:/|$)',                           // *.pem
  '(?:^|/)id_rsa[^/]*$',                          // id_rsa, id_rsa.pub
  '\\.key[. ]*(?:/|$)',                           // *.key
  '(?:^|/)\\.npmrc[. ]*$',
  '(?:^|/)\\.pypirc[. ]*$'
].join('|'), 'i');

/** Lockfiles: their integrity hashes look like high-entropy strings, so the advisory entropy notes leave them out. */
export const LOCKFILE_NAMES: readonly string[] = deepFreeze(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'pdm.lock', 'cargo.lock', 'composer.lock', 'gemfile.lock', 'go.sum']);

const norm = (p: string): string => p.replace(/\\/g, '/');

export function isSensitivePath(path: string): boolean {
  return typeof path === 'string' && SENSITIVE_PATH_RE.test(norm(path));
}

export function isLockfilePath(path: string): boolean {
  if (typeof path !== 'string') return false;
  const base = norm(path).split('/').pop() ?? '';
  return LOCKFILE_NAMES.includes(base.toLowerCase());
}

/**
 * A repository-relative path that is safe to name: forward slashes, no empty, `.` or `..` segment, not absolute, no
 * drive or stream (`:`), no backslash, no control character.
 */
export function isSafeRelPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) return false;
  if (/[\x00-\x1f\x7f\\:]/.test(path) || path.startsWith('/')) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** One glob pattern as a RegExp: `**` any number of segments, `*` within a segment, `?` one character. Case-insensitive. */
function globRe(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/';
        re += slash ? '(?:[^/]+/)*' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * True when a change may touch `path` under `scope` (patterns such as `['**', '!.git/**']`): the path is a safe
 * relative path, is not sensitive, matches at least one positive pattern and no `!` pattern.
 */
export function pathInScope(path: string, scope: readonly string[]): boolean {
  if (!isSafeRelPath(path) || isSensitivePath(path) || !Array.isArray(scope)) return false;
  let included = false;
  for (const raw of scope) {
    if (typeof raw !== 'string' || raw.length === 0) return false;
    const negated = raw.startsWith('!');
    const re = globRe(negated ? raw.slice(1) : raw);
    if (negated) {
      // A negated directory pattern also excludes the directory itself (`!.git/**` excludes `.git`).
      if (re.test(path) || (raw.endsWith('/**') && globRe(raw.slice(1, -3)).test(path))) return false;
    } else if (re.test(path)) included = true;
  }
  return included;
}
