/**
 * Redaction for activity details. Every `details_json` written to the activity
 * log is the output of `redactDetails`, so the log never stores secrets or
 * contents:
 * - keys that name a secret (token, password, api key, dsn, signature, ...) lose their value;
 * - every string goes through the crash-log redactor (`redactForLog`), which strips
 *   secret-shaped values (provider keys, bearer tokens, URL credentials, long hex),
 *   plus two extra passes here: URL user names and `sig=` / `signature=` values;
 * - long strings and binaries become size markers, never the bytes themselves;
 * - depth, array length, key count and total size are capped, so the output is
 *   bounded, fast to produce and always JSON-serialisable (cycles end at the depth cap).
 *
 * Integrity hashes are evidence, not secrets: a hex digest (optionally `git:`-prefixed)
 * under one of the known hash keys (`HASH_KEYS`) is kept as is. Under any other key
 * the same hex is redacted, and a non-digest value under a hash key is redacted as usual.
 */
import { keyValueAtRun, redactForLog, SCHEME_AT_RUN } from '../../crashLog';

export const REDACTED = '[redacted]';
export const MAX_STRING = 512; export const MAX_DEPTH = 4; export const MAX_ARRAY = 50; export const MAX_KEYS = 50;
/** Upper bound on the UTF-8 size of the stored details JSON. */
export const MAX_DETAILS_BYTES = 16384;

const TRUNCATED = '[truncated]';
const SECRET_KEY = new RegExp([
  'secret', 'token', 'passw', 'pwd', 'passphrase', 'api[-_ ]?key', 'authorization', 'cookie', 'credential',
  'private[-_ ]?key', 'session[-_ ]?key', 'access[-_ ]?key', 'auth[-_ ]?(?:token|header)', '^auth$', 'signature', 'dsn',
  'conn(?:ection)?[-_ ]?str(?:ing)?'
].join('|'), 'i');
/** Known non-secret integrity hash fields (controller ruling, Task 5). */
const HASH_KEYS: ReadonlySet<string> = new Set(['backupSha256', 'sha256', 'contentHash', 'content_hash', 'stdoutSha256', 'argvSha256']);
const HEX_DIGEST = /^(?:git:)?[0-9a-f]{40,128}$/i;
/** Exact keys whose NUMERIC values are token usage counts (never a credential). */
const TOKEN_COUNT_KEYS: ReadonlySet<string> = new Set([
  'tokensUsed', 'inputTokens', 'outputTokens', 'totalTokens', 'maxTokens',
  'cacheReadTokens', 'cacheCreationTokens', 'tokenCount', 'tokenLimit'
]);
/**
 * A URL user name (`scheme://user@`) and a `sig` / `signature` value, in their linear-time forms (fix round 2; see
 * crashLog's SCHEME_AT_RUN): the old `\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@` and
 * `\b((?:[a-z0-9]+[_-])*(?:sig|signature))(["']?)(\s*[:=]\s*)(value)`, exactly, with the skipped text written back.
 */
const URL_USER = new RegExp(SCHEME_AT_RUN + String.raw`[^\s/@]+@`, 'gi');
const URL_USER_TO = '$1$2[redacted]@';
const SIGNATURE_PAIR = keyValueAtRun('sig|signature');
const DROP = Symbol('drop');
type Out = unknown | typeof DROP;

/** Remaining output budget, in (approximate) bytes, for one redactDetails call. */
interface Budget { left: number }

/**
 * The secret passes of redactDetails for one string, with NO length cap: the
 * crash-log redactor plus URL user names and sig/signature values. Used where a
 * value must be kept whole (job errors) or checked for secrets (job params).
 */
export function redactText(s: string): string {
  return redactForLog(s)
    .replace(URL_USER, URL_USER_TO)
    .replace(SIGNATURE_PAIR, (_m, skip, lead, k, q, sep, vq) => `${skip}${lead}${k}${q}${sep}${vq ? `${vq}${REDACTED}${vq}` : REDACTED}`);
}

function redactString(s: string): string {
  if (s.length > MAX_STRING) return `[omitted: ${s.length} chars]`;
  return redactText(s);
}

/** Any PEM private-key header, terminated or not. */
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
/** A private-key header with no END line after it: everything from it to the end of the string. */
const UNTERMINATED_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/;

/**
 * redactText plus one extra rule: a private-key header whose END line is missing
 * (for example cut off by an earlier truncation) is redacted through to the end of
 * the string. For stored error messages only. Deliberately NOT part of redactText
 * or redactDetails: activity hashes depend on redactDetails' exact output.
 */
export function redactSecretText(s: string): string {
  return redactText(redactLongTokens(s)).replace(UNTERMINATED_PRIVATE_KEY, REDACTED);
}

/**
 * ReDoS bound. Several redactor patterns (the key=value pass and the URL credential pass in redactForLog, and
 * URL_USER and SIGNATURE_PAIR here) are anchored on a word boundary and then scan the rest of a run of token
 * characters (letters, digits, `+ . _ -`). Their cost is (word boundaries in a run) x (run length), so a
 * 64 KiB run like `x-x-x-...` takes seconds, and the main process with it. Word boundaries inside a run come
 * only from `+ . -` (`_` is a word character). So a run holding LONG_TOKEN_SEPARATORS or more of `+ . -`,
 * and a letter or digit, is treated as secret-shaped: containsSecret answers true before any regex runs, and
 * redactSecretText redacts the run before its regex passes. Every other run has fewer than about
 * 2 x LONG_TOKEN_SEPARATORS boundaries, which bounds the regex cost linearly in the string length.
 *
 * Measured on 64 KiB (V8's regex interpreter, which V8 falls back to after it flushes compiled regex code):
 * one `x-x-...` run took 5 s compiled; runs of 2,047 characters took 4 to 10 s per pattern; runs just under
 * this bound take about 40 ms compiled. With the interpreter forced (--regexp-interpret-all), an adversarial
 * 64 KiB input reached 3.4 s in containsSecret and 1.7 s in redactSecretText: 127 separators in a scheme or
 * key chain followed by a long separator-free tail, because the scan after a boundary can run past the end of
 * the run. V8 was not observed to fall back on its own in normal use. A long run WITHOUT separators
 * (`yyyy...`, `xxxx...`) has no inner boundary, is linear, and is not affected: the B0b tests pin such
 * params and error messages as stored exactly. redactText and redactDetails are deliberately unchanged:
 * activity hashes depend on their exact output, and redactDetails already caps every string at MAX_STRING.
 *
 * Fix round 2: those four patterns now run in linear time (crashLog's SCHEME_AT_RUN and keyValueAtRun: each run is tried
 * once, from its start), with exactly the old output, so text just under this bound no longer costs seconds either
 * (4 MiB of 127-separator runs: 2 to 7 s before, under 100 ms after). The bound itself is unchanged: what
 * containsSecret and redactSecretText answer depends on it.
 */
export const LONG_TOKEN_SEPARATORS = 128;

/** 0: not a token character; 1: `_`; 2: a letter or digit; 3: `+ . -` (each makes word boundaries). */
function tokenClass(c: number): 0 | 1 | 2 | 3 {
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 2;
  if (c === 95) return 1;
  return c === 43 || c === 46 || c === 45 ? 3 : 0;
}

/**
 * The [start, end) spans of every such run in `s`, by one forward scan. (A regex for the same runs would
 * itself rescan each run from every position, which is quadratic again.)
 */
function longTokenSpans(s: string, firstOnly: boolean): [number, number][] {
  const spans: [number, number][] = [];
  if (s.length < LONG_TOKEN_SEPARATORS) return spans;
  let start = -1; let alnum = false; let seps = 0;
  for (let i = 0; i <= s.length; i++) {
    const k = i < s.length ? tokenClass(s.charCodeAt(i)) : 0;
    if (k !== 0) {
      if (start < 0) { start = i; alnum = false; seps = 0; }
      if (k === 2) alnum = true; else if (k === 3) seps++;
      continue;
    }
    if (start >= 0 && alnum && seps >= LONG_TOKEN_SEPARATORS) {
      spans.push([start, i]);
      if (firstOnly) return spans;
    }
    start = -1;
  }
  return spans;
}

/** True when `s` holds a run of token characters with LONG_TOKEN_SEPARATORS or more `+ . -` and a letter or digit. Linear time. */
export function hasLongToken(s: string): boolean {
  return longTokenSpans(s, true).length > 0;
}

/** Replaces every such run with REDACTED. Linear time. */
function redactLongTokens(s: string): string {
  const spans = longTokenSpans(s, false);
  if (spans.length === 0) return s;
  let out = ''; let at = 0;
  for (const [a, b] of spans) { out += s.slice(at, a) + REDACTED; at = b; }
  return out + s.slice(at);
}

/**
 * True when redaction would change `v` because of a SECRET, ignoring every size,
 * depth and key-count cap: a key that names a secret (numeric token counts and hex
 * digests under hash keys excepted, as in redactDetails), or a key or string value
 * that redactText would alter, or any string holding a private-key header
 * (terminated or not), or a key or string holding a run of token characters with
 * LONG_TOKEN_SEPARATORS or more `+ . -` (checked first, so the regex passes never
 * see one). Meant for exact JSON (cycles are not followed twice).
 */
export function containsSecret(v: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === 'string') { if (hasLongToken(x) || PRIVATE_KEY_HEADER.test(x) || redactText(x) !== x) return true; continue; }
    if (typeof x !== 'object' || x === null || seen.has(x)) continue;
    seen.add(x);
    if (Array.isArray(x)) { for (const item of x) stack.push(item); continue; }
    for (const key of Object.keys(x)) {
      const raw = (x as Record<string, unknown>)[key];
      if (TOKEN_COUNT_KEYS.has(key) && typeof raw === 'number') continue;
      if (HASH_KEYS.has(key) && typeof raw === 'string' && HEX_DIGEST.test(raw)) continue;
      if (hasLongToken(key) || SECRET_KEY.test(key) || redactText(key) !== key) return true;
      stack.push(raw);
    }
  }
  return false;
}

function isBinary(v: object): number | null {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v.length;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  return null;
}

/** Charge a leaf's size; once the budget is gone every further value is a marker. */
function charge(b: Budget, v: unknown): unknown {
  const size = typeof v === 'string' ? v.length + 3 : 8;
  if (b.left <= 0) return TRUNCATED;
  b.left -= size;
  return v;
}

function walk(v: unknown, depth: number, b: Budget): Out {
  switch (typeof v) {
    case 'string': return charge(b, redactString(v));
    case 'number': return charge(b, Number.isFinite(v) ? v : null);
    case 'boolean': return charge(b, v);
    case 'bigint': return charge(b, redactString(String(v)));
    case 'undefined': case 'function': case 'symbol': return DROP;
    default: break;
  }
  if (v === null) return charge(b, null);
  if (b.left <= 0) return TRUNCATED;
  const obj = v as object;
  const bytes = isBinary(obj);
  if (bytes !== null) return charge(b, `[binary: ${bytes} bytes]`);
  if (obj instanceof Date) return charge(b, Number.isNaN(obj.getTime()) ? null : obj.toISOString());
  if (depth >= MAX_DEPTH) return charge(b, TRUNCATED);
  if (Array.isArray(obj)) return walkArray(obj, depth, b);
  if (obj instanceof Error) {
    return walkObject({ name: String(obj.name), message: String(obj.message) }, depth, b);
  }
  return walkObject(obj as Record<string, unknown>, depth, b);
}

function walkArray(arr: unknown[], depth: number, b: Budget): unknown[] {
  const out: unknown[] = [];
  const n = Math.min(arr.length, MAX_ARRAY);
  b.left -= 2;
  let i = 0;
  for (; i < n && b.left > 0; i++) {
    let item: Out;
    try { item = walk(arr[i], depth + 1, b); } catch { item = REDACTED; }
    out.push(item === DROP ? null : item);
  }
  if (arr.length > i) out.push(TRUNCATED);
  return out;
}

/** Own, enumerable data property, so `__proto__` is kept as a key; colliding names get a suffix. */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  let name = key;
  for (let n = 2; Object.prototype.hasOwnProperty.call(out, name); n++) name = `${key}~${n}`;
  Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
}

function walkObject(obj: Record<string, unknown>, depth: number, b: Budget): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  b.left -= 2;
  let seen = 0;
  for (const key of keys.slice(0, MAX_KEYS)) {
    if (b.left <= 0) break;
    seen++;
    const safeKey = key.length > MAX_STRING ? `[omitted key: ${key.length} chars]` : redactForLog(key).replace(URL_USER, URL_USER_TO);
    // Token COUNTS are audit data, not credentials: keep them only as plain numbers.
    if (TOKEN_COUNT_KEYS.has(key) && typeof obj[key] === 'number' && Number.isFinite(obj[key])) {
      b.left -= safeKey.length + 3 + String(obj[key]).length; put(out, safeKey, obj[key] as number); continue;
    }
    if (SECRET_KEY.test(key)) { b.left -= safeKey.length + 3; put(out, safeKey, charge(b, REDACTED)); continue; }
    let item: Out;
    try {
      const raw = obj[key];
      item = HASH_KEYS.has(key) && typeof raw === 'string' && HEX_DIGEST.test(raw) ? charge(b, raw) : walk(raw, depth + 1, b);
    } catch {
      item = REDACTED;
    }
    if (item !== DROP) { b.left -= safeKey.length + 3; put(out, safeKey, item); }
  }
  if (keys.length > seen) put(out, '__truncated', TRUNCATED);
  return out;
}

function capped(out: Record<string, unknown>): Record<string, unknown> {
  const bytes = Buffer.byteLength(JSON.stringify(out) ?? '{}', 'utf8');
  return bytes > MAX_DETAILS_BYTES ? { omitted: `[details too large: ${bytes} bytes]` } : out;
}

// ---------- host paths (B2a Task 13 fix round 1) ----------

/** The last segment of a path whose separators are `/` or any run of backslashes (JSON-escaped text included). */
function lastPathSegment(p: string): string {
  const parts = p.split(/[\\/]+/).filter((x) => x.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}
const NOT_PATH = String.raw`\s'"${'`'}<>|:`;
/**
 * The longest backslash run a host path shape needs: a JSON-escaped `\\` (a UNC or long-path prefix) is four. Fix round
 * 2: every backslash run in these patterns is bounded by it, and scrubHostPaths first collapses each longer run to
 * exactly this many, so no pattern rescans a long run from each of its positions. The unbounded `\\+` / `\\{2,}` made
 * one 16 K-backslash frame cost about 0.3 s, and 64 K about 25 s, on the main thread.
 */
const MAX_BACKSLASH_RUN = 4;
const LONG_BACKSLASH_RUN = new RegExp(String.raw`\\{${MAX_BACKSLASH_RUN + 1},}`, 'g');
const COLLAPSED_RUN = '\\'.repeat(MAX_BACKSLASH_RUN);
const BACKSLASHES = String.raw`\\{1,${MAX_BACKSLASH_RUN}}`;
/** One separator: `/` or a run of one to four backslashes (a JSON-escaped backslash is two). */
const SEP = `(?:${BACKSLASHES}|/)`;
/**
 * The rest of a path after a separator: segments that a separator ends may hold single spaces between words
 * (`John Smith\`, `Local Storage\`, `Application Support/`); the last segment ends at whitespace, a quote or a colon.
 */
const PATH_TAIL = String.raw`(?:[^\\/${NOT_PATH}]+(?: +[^\\/${NOT_PATH}]+)*${SEP})*[^${NOT_PATH}]*`;
/** A long-path prefix (`\\?\`, `\\.\`), single or JSON-escaped. */
const LONG_PREFIX = `${BACKSLASHES}[?.]${BACKSLASHES}`;
/** Long-path prefixes, then a drive or UNC path. */
const LONG_PREFIX_PATH = new RegExp(LONG_PREFIX + String.raw`(?:[A-Za-z]:${SEP})?` + PATH_TAIL, 'g');
/** A UNC path (`\\server\share\...`), single or JSON-escaped. */
const UNC_PATH = new RegExp(String.raw`\\{2,${MAX_BACKSLASH_RUN}}[^\\/\s'"]+${SEP}` + PATH_TAIL, 'g');
/** A drive-absolute path (`C:\...`, `C:/...`). */
// Never a one-letter URL scheme (`x://...`, final batch item 5): that is a URL, and its user information is redacted
// before any path is cut (scrubHostPaths), so a path cut can never leave its credentials behind.
const DRIVE_PATH = new RegExp(String.raw`\b[A-Za-z]:(?!\/\/)${SEP}` + PATH_TAIL, 'g');
/**
 * A host POSIX path: a user's home (`/Users/<name>`, `/home/<name>` but not the sandbox's own `/home/nexus`), Docker
 * Desktop's host mounts (`/run/desktop/mnt/host/...`, `/host_mnt/...`, `/mnt/<drive>/...`), macOS temp folders, or
 * (fix round 2) Git Bash's form of a Windows home (`/c/Users/<name>`, `/d/home/<name>`).
 * Container paths (`/workspace`, `/out`, `/in`) are kept.
 */
// Also behind extra leading slashes (`//Users/<name>`, final batch item 6).
const HOST_POSIX_PATH = new RegExp(String.raw`(^|[\s'"(=,;\[:])(\/{0,3}(?:/Users/|/home/(?!nexus(?:/|\b))|/run/desktop/|/host_mnt/|/mnt/[A-Za-z]/|/[A-Za-z]/(?:[Uu]sers|[Hh]ome)/|/private/var/|/var/folders/)`
  + PATH_TAIL + ')', 'g');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);

/**
 * Text that may name host paths (a runner `nexus` log frame, a Docker error), with every host path cut to its basename:
 * each of `roots` (the data home, its real path, userData) wherever it appears, with either separator, any case, behind a
 * `\\?\` prefix or JSON-escaped; then any long-prefix, UNC or drive-absolute path, and host POSIX homes and mounts.
 * Never throws; text without such a path is returned unchanged.
 */
export function scrubHostPaths(text: string, roots: readonly (string | null | undefined)[] = []): string {
  if (typeof text !== 'string' || text.length === 0) return typeof text === 'string' ? text : '';
  try {
    // Fix round 2: no backslash run longer than any path shape needs (linear time; see MAX_BACKSLASH_RUN).
    // Final batch item 5: URL user information first (`x://u:p@h` was cut as a drive path and its credentials survived).
    let s = text.replace(LONG_BACKSLASH_RUN, COLLAPSED_RUN).replace(URL_USER, URL_USER_TO);
    const known = [...new Set(roots.filter((r): r is string => typeof r === 'string' && r.length >= 3))].sort((a, b) => b.length - a.length);
    for (const root of known) {
      const parts = root.split(/[\\/]+/).filter((x) => x.length > 0).map(escapeRe);
      if (parts.length === 0) continue;
      // A bounded lead (fix round 2): `[\\/]+` rescanned a long run of slashes from each of its positions.
      const lead = /^[\\/]/.test(root) && !/^[A-Za-z]:/.test(root) ? String.raw`[\\/]{1,${MAX_BACKSLASH_RUN}}` : '';
      // The root literally (spaces included, either separator, any case), then the rest of the path, if any.
      const re = new RegExp(`(?:${LONG_PREFIX})?` + lead + parts.join(String.raw`[\\/]+`) + `(?:${SEP}${PATH_TAIL})?`, 'gi');
      s = s.replace(re, (m) => lastPathSegment(m));
    }
    s = s.replace(LONG_PREFIX_PATH, (m) => lastPathSegment(m));
    s = s.replace(DRIVE_PATH, (m) => lastPathSegment(m.replace(/^[A-Za-z]:/, '')));
    s = s.replace(UNC_PATH, (m) => lastPathSegment(m));
    s = s.replace(HOST_POSIX_PATH, (_m, pre: string, p: string) => `${pre}${lastPathSegment(p)}`);
    return s;
  } catch {
    return '[text omitted: it could not be checked for host paths]';
  }
}

/** The only shape that may be stored in `activity.details_json`. Never throws. */
export function redactDetails(value: unknown): Record<string, unknown> {
  try {
    if (value === null || value === undefined) return {};
    const b: Budget = { left: MAX_DETAILS_BYTES - 1024 };   // margin for markers and JSON punctuation the estimate misses
    if (typeof value === 'object' && !Array.isArray(value) && isBinary(value) === null && !(value instanceof Date)) {
      return capped(walk(value, 0, b) as Record<string, unknown>);
    }
    const v = walk(value, 1, b);
    return v === DROP ? {} : capped({ value: v });
  } catch {
    return { value: '[unredactable details omitted]' };
  }
}
