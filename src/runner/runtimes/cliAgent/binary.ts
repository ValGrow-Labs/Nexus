/**
 * What the adapter knows about the engine's own executable (B2b Task 13): where it is, what a healthy one looks like
 * (its version and the flags the pinned argv relies on), and how to read its `auth status` answer.
 *
 * The values here are the ones Task 0's probe recorded (`task0-probe-report.json`, pinned again by CR1 and CR8): the
 * version line `2.1.x`, and the nineteen flags `--help` must list. `--safe-mode` is NOT among them (D-B15: it silently
 * drops the Nexus MCP server). `--append-system-prompt-file` is optional: its absence moves the skills to the stdin
 * preamble.
 *
 * Nothing here runs a program. The raw `auth status` text is parsed to one of three words and never kept (F17).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The engine versions this adapter was probed against (`^2\.1\.\d+`, D-B5). */
export const SUPPORTED_VERSION_RE = /^2\.1\.\d+/;

/** The flags the pinned argv relies on (Task 0, P1). */
export const PINNED_FLAGS: readonly string[] = Object.freeze([
  '-p', '--output-format', '--verbose', '--input-format', '--restricted', '--strict-mcp-config',
  '--mcp-config', '--settings', '--setting-sources', '--tools', '--allowedTools', '--disallowedTools',
  '--permission-mode', '--permission-prompts', '--no-session-persistence', '--disable-slash-commands',
  '--no-chrome', '--max-budget-usd', '--append-system-prompt'
]);
/** Optional: the skills bundle goes through this file when the build names it, else on stdin. */
export const SKILLS_FILE_FLAG = '--append-system-prompt-file';

/** The native executable's file name for a platform (never a `.cmd`, `.bat`, `.ps1` or other shim). */
export function agentBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'claude.exe' : 'claude';
}

/** True for an absolute path to the native executable by its file name only (the way `isTaskkillBinary` checks taskkill). */
export function isAgentBinary(bin: unknown, platform: NodeJS.Platform = process.platform): bin is string {
  if (typeof bin !== 'string' || bin.length === 0 || bin.includes('\0')) return false;
  const mod = platform === 'win32' ? path.win32 : path.posix;
  if (!mod.isAbsolute(bin)) return false;
  const base = mod.basename(bin);
  return (platform === 'win32' ? base.toLowerCase() : base) === agentBinaryName(platform);
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** A test seam: whether a path is a file. */
  isFile?: (p: string) => boolean;
}

const fileExists = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * The native executable, or null. Looks along PATH, then the engine's own per-user install folder (`~/.local/bin`).
 * Only the native executable by its exact name is returned: a shim next to it is never picked.
 */
export function resolveAgentCli(o: ResolveOptions = {}): string | null {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const isFile = o.isFile ?? fileExists;
  const name = agentBinaryName(platform);
  const mod = platform === 'win32' ? path.win32 : path.posix;
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const home = env.USERPROFILE ?? env.HOME;
  if (home) dirs.push(mod.join(home, '.local', 'bin'));
  for (const dir of dirs) {
    const candidate = mod.join(dir, name);
    if (isAgentBinary(candidate, platform) && isFile(candidate)) return candidate;
  }
  return null;
}

/** `2.1.309 (Claude Code)` -> `2.1.309`; anything else null. */
export function parseVersion(text: string): string | null {
  const m = /^\s*(\d+\.\d+\.\d+)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * Which pinned flags `--help` lists. An option line starts with whitespace then a dash; aliases are comma-separated.
 * `--append-system-prompt-file` counts when listed or named as `--append-system-prompt[-file]`.
 */
export function helpFlagsOf(helpText: string): Record<string, boolean> {
  const listed = new Set<string>();
  for (const line of String(helpText ?? '').split(/\r?\n/)) {
    const m = /^\s{1,8}(-[^<[]*?)(?:\s{2,}|\s<|\s\[|$)/.exec(line);
    if (!m) continue;
    for (const part of m[1].split(',')) {
      const f = part.trim().split(/\s+/)[0];
      if (/^--?[A-Za-z]/.test(f)) listed.add(f);
    }
  }
  const out: Record<string, boolean> = {};
  for (const f of PINNED_FLAGS) out[f] = listed.has(f);
  out[SKILLS_FILE_FLAG] = listed.has(SKILLS_FILE_FLAG) || /--append-system-prompt(?:\[-file\]|-file(?![\w-]))/.test(String(helpText ?? ''));
  return out;
}

/** The pinned flags missing from `--help`. */
export function missingFlags(helpText: string): string[] {
  const found = helpFlagsOf(helpText);
  return PINNED_FLAGS.filter((f) => !found[f]);
}

/**
 * The adapter's parse of `auth status --json`: 'yes' | 'no' | 'unknown'. JSON with a boolean `loggedIn` decides;
 * anything else (no JSON, a network error, a timeout) is 'unknown'. Nothing else of the output is read or kept.
 */
export function parseSignedIn(stdout: string): 'yes' | 'no' | 'unknown' {
  const text = String(stdout ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return 'unknown';
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as { loggedIn?: unknown };
    if (v && typeof v.loggedIn === 'boolean') return v.loggedIn ? 'yes' : 'no';
  } catch { /* fallthrough */ }
  return 'unknown';
}
