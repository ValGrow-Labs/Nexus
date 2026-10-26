// The protocol between main and the runner utilityProcess (over a MessagePort).
// The runner holds no authority: every RunnerToMain message is a report that
// main validates here first (exact keys, types and bounds), then against its
// own state (known attempt, lease owner = current boot, monotonic seq).
// Anything that does not parse is dropped. Pure; no I/O.

import {
  GIT_DIFF_MAX_BYTES_PER_SIDE, IMAGE_VERSIONS_RE, OUTPUT_ERROR_CODES, PARSER_IDS, SANDBOX_PROFILE_IDS,
  type AttemptPlan, type ExitInfo, type GitReadTask, type ImageStatus, type OutputErrorCode, type ParsedOutput, type PreflightObserved,
  type SandboxProbe, type SandboxProfile, type SandboxProfileId, type StagedOutput
} from './execution';
import type { RuntimeEvent, RuntimeHealth, RuntimeKind } from './runtime';
import { EGRESS_HOST_RE, EGRESS_REASONS, type EgressReason } from './egressPolicy';
import { TOKEN_MAX_BYTES, TOKEN_RE } from './tokens';
import { SANDBOX_EXEC_MAX_TIMEOUT_MS } from './mcpTools';

// ----- main → runner (main builds these; the runner trusts their origin, not their paths' safety) -----

export type CancelReason = 'user' | 'timeout' | 'parent' | 'shutdown';

export type MainToRunner =
  /** `home`: this install's `nexus.home` (homeLabel.ts of `dataHome`; '' without a data home), for every resource label. */
  | { op: 'hello'; bootId: string; dataHome: string; home: string; profiles: SandboxProfile[] }
  /**
   * The sandbox probe (Docker, images, disk). The agent runtime is checked ONLY when `runtimes: true` is present, and main
   * sets it only on an explicit refresh of the runtime check (the setup sheet opened, a consent change, a start with a stale
   * answer) and only while agents are on: the scheduler's own periodic probe never carries it, so the user's engine is never
   * run on a timer. The runner answers the sandbox probe first (`runtimes: []`) and, when asked, sends a second `probe.result`
   * with the same sandbox facts plus the runtimes.
   * `consentHostsSha256` (with `runtimes`): the hash of the live consent's hosts, when one exists. The runner then runs the
   * runtime's health under its allow-list proxy (only when the hash is the adapter's own host list); without it, under the
   * deny-all proxy: nothing the engine does can leave the machine before the user's permission exists.
   */
  | { op: 'probe'; runtimes?: true; consentHostsSha256?: string }
  | { op: 'attempt.start'; attemptId: string; plan: AttemptPlan }
  | { op: 'attempt.cancel'; attemptId: string; graceMs: number; reason: CancelReason }
  | { op: 'attempt.adopt'; attemptId: string; containerId: string; logPath: string }      // recovery
  | { op: 'attempt.release'; attemptId: string }                                         // sent only after ingest commits
  | { op: 'reconcile.list'; attempts: { attemptId: string; containerId: string; kind: 'tool' | 'service' }[] }
  | { op: 'image.build.start'; buildId: string; profile: SandboxProfileId; approvalId: string; contextSha256: string }
  | { op: 'image.build.cancel'; buildId: string }
  | { op: 'blob.verify'; sha256: string }
  | { op: 'gc.scan'; scanId: string; olderThanMs: number }
  | { op: 'gc.apply'; scanId: string; objects: string[]; workDirs: { jobId: string; attemptN: number }[] }
  /**
   * Restart recovery (B2a Task 11): stop (-t 10) and remove each listed resource, by id only (PhaseBReport.remove). The
   * runner removes only a resource whose labels carry this install's `nexus.home` and a `nexus.attempt`.
   */
  | { op: 'reconcile.remove'; resources: { kind: 'container' | 'volume' | 'network'; id: string }[] }
  /** App quit: the runner stops its dev deployments' containers, leaves tool containers running (adoptable) and exits. */
  | { op: 'shutdown' }
  /**
   * B2b: main's answer to one relayed MCP call (`mcp.call` with the same `callId`). For `sandbox_exec` the value is
   * `{ grant: SandboxExecGrant }`: the runner runs exactly that argv in the turn's container and returns the redacted,
   * capped output to the agent only (main gets `agent.exec.done`: counts and a hash, never the text). The runner acts
   * on the first reply for a `callId` only and ignores any later one.
   */
  | { op: 'mcp.reply'; callId: string; result: McpReplyResult }
  /** B2b: a bounded git read (status, or a diff between two recorded commits); answered by `git.read.result`. */
  | { op: 'git.read'; reqId: string; task: GitReadTask }
  /** B2b: end every live agent process tree this runner started (app quit, a cancel of everything). */
  | { op: 'agent.shutdownTrees' };

/** One command main granted to an agent turn: run in the turn's own container, never on the host. */
export interface SandboxExecGrant { execId: string; argv: string[]; cwd: string; timeoutMs: number }
export type McpReplyResult = { ok: true; value: unknown } | { ok: false; code: string; message: string };
/** The reply that grants a `sandbox_exec`: the value always carries an argv array. */
export type SandboxExecReply = { op: 'mcp.reply'; callId: string; result: { ok: true; value: { grant: SandboxExecGrant } } };

// ----- runner → main (reports; parsed by `parseRunnerMessage`) -----

export type RefusalReason =
  | 'docker_missing' | 'docker_stopped' | 'image_missing' | 'image_mismatch' | 'disk_low'
  | 'network_not_approved' | 'bad_plan' | 'busy' | 'unknown_attempt'
  /** An input copied from the blob store did not re-hash to its sha256 (or was missing): nothing was created. */
  | 'input_changed'
  /** The plan needs git (a checkout to stage, or a git engine) and no git binary is installed: a setup refusal (the job waits). */
  | 'git_missing';
export const REFUSAL_REASONS: readonly RefusalReason[] = ['docker_missing', 'docker_stopped', 'image_missing', 'image_mismatch',
  'disk_low', 'network_not_approved', 'bad_plan', 'busy', 'unknown_attempt', 'input_changed', 'git_missing'];

/**
 * Why the runner ended a container itself: `timeout` (its own wall-clock backstop) or `cancelled` (main's
 * `attempt.cancel`). Absent when the container exited on its own.
 */
export type ExitReason = 'timeout' | 'cancelled';
export const EXIT_REASONS: readonly ExitReason[] = ['timeout', 'cancelled'];

export type AttemptPhase = 'staging' | 'creating' | 'preflight' | 'starting' | 'running' | 'collecting' | 'hashing' | 'parsing' | 'cleanup';
export const ATTEMPT_PHASES: readonly AttemptPhase[] =
  ['staging', 'creating', 'preflight', 'starting', 'running', 'collecting', 'hashing', 'parsing', 'cleanup'];

/** Progress facts from the runner. No percentages: only what was observed. */
export type ProgressEvent =
  | { t: 'phase'; phase: AttemptPhase; at: number }
  | { t: 'guard'; guard: 'output_too_large' | 'workspace_too_large'; bytes: number; limitBytes: number; at: number }
  /**
   * One decision of an approved install's Nexus egress proxy (B2a stabilization, constraint 5): the host the request
   * named (never a path, query string or header), its port, and why. At most EGRESS_EVENT_MAX per attempt.
   */
  | { t: 'egress'; decision: 'allowed' | 'refused'; host: string; port: number; reason: EgressReason; at: number }
  /**
   * B2b: a `changeset.accept` is about to move the integration ref from `old` to `new` (reported, durably recorded by
   * main, before the `update-ref`): recovery rolls an unfinished accept back from it, never forward.
   */
  | { t: 'accept.prepared'; old: string; new: string; at: number };

/** The most egress decisions one attempt reports as events (the rest are in its log only). */
export const EGRESS_EVENT_MAX = 200;

/** A preflight report as carried over the wire: the runner may omit observed fields it could not read. */
export interface ReportedPreflight { ok: boolean; observed: Partial<PreflightObserved>; problems: string[] }

export type ContainerState = 'running' | 'exited' | 'created' | 'missing';

export interface ReconciledAttempt {
  attemptId: string; container: ContainerState; containerId?: string; exit?: ExitInfo; staged?: StagedOutput[];
}
export interface LabelledResource { kind: 'container' | 'volume' | 'network'; id: string; labels: Record<string, string> }

export type ImageBuildOutcome = 'succeeded' | 'failed' | 'cancelled';

/**
 * What a runtime's probe found about its setup (B2b), parsed inside the adapter: whether the engine's own login is
 * signed in (never the identity), whether every pinned flag is present, its display label (the setup row only) and
 * the hosts its process needs.
 */
export interface RuntimeSetup {
  signedIn: 'yes' | 'no' | 'unknown'; flagsOk: boolean; label: string; egressHosts: { host: string; port: number }[];
}

/** What a bounded git read found. A diff's `patch` is capped at 1 MiB per side (`truncated` when cut). */
export type GitReadResult =
  | { ok: true; read: 'status'; branch: string; head: string | null; dirty: boolean; integrationHead: string | null;
      /** Commits on the integration ref that are not on the branch. */
      acceptedNotMerged: number;
      /** True when the branch can fast-forward to the integration head. */
      fastForward: boolean }
  | { ok: true; read: 'diff'; base: string; head: string; patch: string; bytes: number; truncated: boolean }
  | { ok: false; code: GitReadErrorCode; message: string };
export type GitReadErrorCode = 'git_missing' | 'not_a_repository' | 'unknown_ref' | 'too_large' | 'error';
export const GIT_READ_ERROR_CODES: readonly GitReadErrorCode[] = ['git_missing', 'not_a_repository', 'unknown_ref', 'too_large', 'error'];

export type RunnerToMain =
  /**
   * `mcpUrl` (B2b): the runner's loopback MCP endpoint, `http://127.0.0.1:<port>/mcp`; null while the runner serves
   * none (no data home, or before its server started): main then treats agent turns as unavailable.
   */
  | { op: 'ready'; bootId: string; mcpUrl: string | null }
  | { op: 'probe.result'; probe: SandboxProbe; images: ImageStatus[]; freeBytes: number | null;
      runtimes: { kind: RuntimeKind; health: RuntimeHealth; setup?: RuntimeSetup }[] }
  /**
   * B2b: one MCP call of an agent turn, relayed from the loopback server. `bearer` is the token the agent presented
   * (at most 128 bytes and TOKEN_RE-shaped; never logged); `args` is a bounded deep copy (depth 8, 64 keys, 64 KiB).
   */
  | { op: 'mcp.call'; callId: string; bearer: string; tool: string; args: unknown }
  /** B2b: a granted `sandbox_exec` finished. Counts and a hash only: the output text went to the agent alone. */
  | { op: 'agent.exec.done'; attemptId: string; execId: string; exit: ExitInfo; stdoutBytes: number; stderrBytes: number;
      stdoutSha256: string; truncated: boolean }
  /** B2b: one event of an agent turn's runtime (display text at most 4 KiB per event; longer text is chunked). */
  | { op: 'attempt.runtime'; attemptId: string; seq: number; event: RuntimeEvent }
  /** B2b: the answer to `git.read`. */
  | { op: 'git.read.result'; reqId: string; result: GitReadResult }
  | { op: 'attempt.provisioned'; attemptId: string; containerId?: string; imageDigest?: string; preflight?: ReportedPreflight;
      /** A dev deployment's forwarder: the loopback port the runner chose from the ephemeral range 49152-65535 (only with a container). */
      hostPort?: number }
  | { op: 'attempt.refused'; attemptId: string; reason: RefusalReason; detail?: string }
  | { op: 'attempt.event'; attemptId: string; seq: number; event: ProgressEvent }
  | { op: 'attempt.heartbeat'; attemptId: string; at: number; logBytes: number; outBytes: number; container?: 'running' | 'exited' | 'missing' }
  | { op: 'attempt.exited'; attemptId: string; exit: ExitInfo; outputs: StagedOutput[]; parsed: ParsedOutput[]; logBytes: number;
      outputError?: OutputErrorCode;
      /** The `/out` entry an `outputError` names (relative, redacted and escaped by the runner; text only). */
      outputErrorEntry?: string;
      reason?: ExitReason }
  | { op: 'reconcile.result'; docker: 'running' | 'stopped' | 'missing'; attempts: ReconciledAttempt[]; labelled: LabelledResource[] }
  | { op: 'service.health'; attemptId: string; at: number; status: number | null; ms: number | null; bodySha256?: string;
      container: 'running' | 'exited' | 'missing' }
  | { op: 'image.build.progress'; buildId: string; at: number; phase: string; bytes?: number }
  | { op: 'image.build.done'; buildId: string; outcome: ImageBuildOutcome; imageId?: string; sizeBytes?: number; error?: string }
  | { op: 'blob.verified'; sha256: string; ok: boolean }
  | { op: 'gc.result'; scanId: string; objects: { sha256: string; bytes: number }[];
      workDirs: { jobId: string; attemptN: number; mtime: number }[]; truncated: boolean }
  | { op: 'fault'; message: string;
      /**
       * A failure of one attempt before it started (e.g. `docker create`), or `docker_error` for a running attempt whose
       * container is still there but whose exit Docker cannot report: both fields together, never one alone.
       */
      attemptId?: string; failureClass?: AttemptFailureClass };

export type RunnerOp = RunnerToMain['op'];

/**
 * Why an attempt failed before it started, as the runner classified Docker's answer or its own file system's
 * (`disk_full`: no space, Docker's or the data home's; `io_error`: another file system failure while staging).
 */
export type AttemptFailureClass = 'disk_full' | 'docker_resources' | 'docker_error' | 'io_error';
export const ATTEMPT_FAILURE_CLASSES: readonly AttemptFailureClass[] = ['disk_full', 'docker_resources', 'docker_error', 'io_error'];

// ----- bounds -----

/** The ephemeral range (IANA dynamic ports) a dev deployment's forwarder port is picked from by the runner. */
export const EPHEMERAL_PORT_MIN = 49152;
export const EPHEMERAL_PORT_MAX = 65535;

export const MAX_STRING_BYTES = 4096;
export const MAX_ARRAY_ITEMS = 20_000;
export const MAX_NORMALIZED_DEPTH = 16;
export const MAX_NORMALIZED_NODES = 500_000;
export const MAX_RECORD_KEYS = 256;

// ----- a small validating copier: each check returns a fresh value or NO -----

const NO: unique symbol = Symbol('invalid');
type NoT = typeof NO;
type Check<T> = (x: unknown) => T | NoT;

function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
    if (n > MAX_STRING_BYTES) return n;
  }
  return n;
}

/** A plain data object: Object.prototype or null prototype, only own data properties. */
function plainKeys(x: unknown): string[] | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) return null;
  if (Object.getOwnPropertySymbols(x).length > 0) return null;
  const keys = Object.getOwnPropertyNames(x);
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(x, k);
    if (!d || !('value' in d) || !d.enumerable) return null;
  }
  return keys;
}
function plainArray(x: unknown): unknown[] | null {
  if (!Array.isArray(x) || Object.getPrototypeOf(x) !== Array.prototype) return null;
  if (x.length > MAX_ARRAY_ITEMS) return null;
  const own = Object.getOwnPropertyNames(x);
  if (own.length !== x.length + 1) return null;                 // indices + length: no holes, no extra props
  for (let i = 0; i < x.length; i++) {
    const d = Object.getOwnPropertyDescriptor(x, i);
    if (!d || !('value' in d)) return null;
  }
  return x;
}
function setProp(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** No NUL and no lone surrogate (text that cannot round-trip through UTF-8). */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length || (s.charCodeAt(i + 1) & 0xfc00) !== 0xdc00) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
const str = (opts: { min?: number; re?: RegExp } = {}): Check<string> => (x) =>
  typeof x === 'string' && x.length >= (opts.min ?? 0) && utf8Bytes(x) <= MAX_STRING_BYTES && wellFormed(x)
    && (!opts.re || opts.re.test(x)) ? x : NO;
const oneOf = <T extends string>(values: readonly T[]): Check<T> => (x) => (typeof x === 'string' && (values as readonly string[]).includes(x) ? x as T : NO);
const lit = <T>(v: T): Check<T> => (x) => (x === v ? v : NO);
const bool: Check<boolean> = (x) => (typeof x === 'boolean' ? x : NO);
/** A non-negative safe integer (counts, byte sizes, timestamps, seq). */
const count: Check<number> = (x) => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : NO);
const intIn = (lo: number, hi: number): Check<number> => (x) => (typeof x === 'number' && Number.isSafeInteger(x) && x >= lo && x <= hi ? x : NO);
const nullable = <T>(c: Check<T>): Check<T | null> => (x) => (x === null ? null : c(x));
function arr<T>(c: Check<T>): Check<T[]> {
  return (x) => {
    const a = plainArray(x); if (!a) return NO;
    const out: T[] = [];
    for (const item of a) { const v = c(item); if (v === NO) return NO; out.push(v); }
    return out;
  };
}
function obj<T>(req: { [k: string]: Check<unknown> }, opt: { [k: string]: Check<unknown> } = {}): Check<T> {
  return (x) => {
    const keys = plainKeys(x); if (!keys) return NO;
    const src = x as Record<string, unknown>;
    for (const k of keys) if (!Object.prototype.hasOwnProperty.call(req, k) && !Object.prototype.hasOwnProperty.call(opt, k)) return NO;
    const out: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(req)) {
      if (!keys.includes(k)) return NO;
      const v = c(src[k]); if (v === NO) return NO; setProp(out, k, v);
    }
    for (const [k, c] of Object.entries(opt)) {
      if (!keys.includes(k)) continue;
      const v = c(src[k]); if (v === NO) return NO; setProp(out, k, v);
    }
    return out as T;
  };
}

// ----- shapes -----

/** ULID: 26 Crockford base32 characters (no I, L, O, U). */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** A git object id: SHA-1 (40 hex) or SHA-256 (64 hex). */
const COMMIT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** The runner's loopback MCP endpoint. */
export const MCP_URL_RE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/mcp$/;
/**
 * A relay id: the runner mints `callId` (one per relayed MCP call); main mints `execId` (inside the `sandbox_exec`
 * grant) and `reqId` (for `git.read`). The runner answers each `callId` once: it ignores a second `mcp.reply` for a
 * `callId` it has already answered (or never sent).
 */
const OP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A tool name as a model may send it (`[a-zA-Z0-9_-]`). */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A runtime's own reference (a run, a tool call, an approval). */
const RUNTIME_REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** A container path under `/workspace`: no empty, `.` or `..` segment, no backslash. */
const WORKSPACE_PATH_RE = /^\/workspace(?:\/(?!\.{1,2}(?:\/|$))[^/\\\u0000]+)*$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const LABEL_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RUNTIME_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const ulid = str({ re: ULID_RE });
const sha256 = str({ re: SHA256_RE });
const text = str();
const nonEmpty = str({ min: 1 });

const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/**
 * A relative output path that is safe on Windows and POSIX: forward slashes only; no empty segment;
 * no `:` (drives, NTFS streams), backslash or control character; no Windows device name (CON, NUL,
 * COM1, LPT1, … with or without an extension); no segment ending in `.` or a space (so no `.`/`..`).
 */
const relPath: Check<string> = (x) => {
  const s = str({ min: 1 })(x);
  if (s === NO) return NO;
  if (/[\x00-\x1f\x7f:\\]/.test(s) || s.startsWith('/')) return NO;
  return s.split('/').every((seg) => seg !== '' && !RESERVED_NAME.test(seg) && !/[. ]$/.test(seg)) ? s : NO;
};

const labels: Check<Record<string, string>> = (x) => {
  const keys = plainKeys(x); if (!keys || keys.length > MAX_RECORD_KEYS) return NO;
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (!LABEL_KEY_RE.test(k)) return NO;
    const v = text((x as Record<string, unknown>)[k]); if (v === NO) return NO;
    setProp(out, k, v);
  }
  return out;
};

const exitInfo = obj<ExitInfo>({ code: nullable(intIn(-(2 ** 31), 2 ** 32)), oomKilled: bool, finishedAt: count },
  { signal: str({ min: 1, re: /^[A-Z0-9_+-]{1,32}$/ }) });

const stagedOutput = obj<StagedOutput>({ relPath, sha256, bytes: count, mediaType: str({ re: MEDIA_TYPE_RE }) });

/** Any JSON-like value within bounds, deep-copied. No functions, symbols, NaN/Infinity, class instances or `__proto__` keys. */
function boundedJson(x: unknown): unknown | NoT {
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown | NoT => {
    if (++nodes > MAX_NORMALIZED_NODES || depth > MAX_NORMALIZED_DEPTH) return NO;
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NO;
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) {
      const a = plainArray(v); if (!a) return NO;
      const out: unknown[] = [];
      for (const item of a) { const c = walk(item, depth + 1); if (c === NO) return NO; out.push(c); }
      return out;
    }
    const keys = plainKeys(v); if (!keys || keys.length > MAX_RECORD_KEYS) return NO;
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (k === '__proto__' || text(k) === NO) return NO;
      const c = walk((v as Record<string, unknown>)[k], depth + 1); if (c === NO) return NO;
      setProp(out, k, c);
    }
    return out;
  };
  return walk(x, 0);
}

const parsedOutput = obj<ParsedOutput>({ parser: oneOf(PARSER_IDS), sourceSha256: sha256, normalized: boundedJson });

const runtimeHealth: Check<RuntimeHealth> = (x) => {
  const ok = obj<RuntimeHealth>({ ok: lit(true), version: text })(x);
  if (ok !== NO) return ok;
  return obj<RuntimeHealth>({ ok: lit(false), reason: oneOf(['not_installed', 'not_authenticated', 'version_unsupported', 'error'] as const), detail: text })(x);
};
const runtimeKind: Check<RuntimeKind> = (x) => (typeof x === 'string' && RUNTIME_KIND_RE.test(x) ? x as RuntimeKind : NO);

const probe = obj<SandboxProbe>(
  { docker: oneOf(['missing', 'stopped', 'running'] as const),
    gpu: obj({ detected: bool, usableInContainers: lit(false) }, { model: text }) },
  { version: text, os: text, wsl2: bool, cpus: count, memoryBytes: count });

const imageStatus = obj<ImageStatus>({ profile: oneOf(SANDBOX_PROFILE_IDS), present: bool, digestMatches: bool },
  { sizeBytes: count, imageId: str({ re: DIGEST_RE }), contextSha256: sha256,
    versions: (x) => (typeof x === 'string' && x.length <= 300 ? str({ re: IMAGE_VERSIONS_RE })(x) : NO) });

const observed = obj<Partial<PreflightObserved>>({}, {
  nanoCpus: count, memory: intIn(-1, Number.MAX_SAFE_INTEGER), memorySwap: intIn(-1, Number.MAX_SAFE_INTEGER),
  pidsLimit: intIn(-1, Number.MAX_SAFE_INTEGER), networkMode: text, readonlyRootfs: bool,
  capDrop: arr(text), capAdd: arr(text), privileged: bool, user: text, securityOpt: arr(text),
  mounts: arr(obj({ dst: text, rw: bool, type: text })), portBindings: arr(text), tmpfs: arr(text), devices: arr(text)
});
const OBSERVED_KEYS: (keyof PreflightObserved)[] = ['nanoCpus', 'memory', 'memorySwap', 'pidsLimit', 'networkMode', 'readonlyRootfs',
  'capDrop', 'capAdd', 'privileged', 'user', 'securityOpt', 'mounts', 'portBindings', 'tmpfs', 'devices'];
const preflight: Check<ReportedPreflight> = (x) => {
  const r = obj<ReportedPreflight>({ ok: bool, observed, problems: arr(text) })(x);
  if (r === NO) return NO;
  if (r.ok !== (r.problems.length === 0)) return NO;              // ok is exactly "no problems"
  if (r.ok && !OBSERVED_KEYS.every((k) => Object.prototype.hasOwnProperty.call(r.observed, k))) return NO;   // a pass shows all it saw
  return r;
};
/**
 * A container exists only with its preflight report, and a report exists only for a container. A published host port
 * (a dev deployment's forwarder, from the ephemeral range 49152-65535) is reported only with a container.
 */
const provisioned: Check<RunnerToMain> = (x) => {
  const m = obj<Extract<RunnerToMain, { op: 'attempt.provisioned' }>>({ op: lit('attempt.provisioned'), attemptId: ulid },
    { containerId: str({ re: CONTAINER_ID_RE }), imageDigest: str({ re: DIGEST_RE }), preflight, hostPort: intIn(EPHEMERAL_PORT_MIN, EPHEMERAL_PORT_MAX) })(x);
  if (m === NO) return NO;
  if (m.hostPort !== undefined && m.containerId === undefined) return NO;
  return (m.containerId === undefined) === (m.preflight === undefined) ? m : NO;
};

const progressEvent: Check<ProgressEvent> = (x) => {
  const p = obj<ProgressEvent>({ t: lit('phase'), phase: oneOf(ATTEMPT_PHASES), at: count })(x);
  if (p !== NO) return p;
  const g = obj<ProgressEvent>({ t: lit('guard'), guard: oneOf(['output_too_large', 'workspace_too_large'] as const),
    bytes: count, limitBytes: count, at: count })(x);
  if (g !== NO) return g;
  const a = obj<ProgressEvent>({ t: lit('accept.prepared'), old: commit, new: commit, at: count })(x);
  if (a !== NO) return a;
  const e = obj<Extract<ProgressEvent, { t: 'egress' }>>({ t: lit('egress'), decision: oneOf(['allowed', 'refused'] as const),
    host: str({ re: EGRESS_HOST_RE }), port: intIn(0, 65535), reason: oneOf(EGRESS_REASONS), at: count })(x);
  if (e === NO) return NO;
  return (e.decision === 'allowed') === (e.reason === 'allowed') ? e : NO;
};

// ----- B2b: agent turns, the MCP relay and git reads -----

/** The bounds of an MCP call's arguments: nesting depth, keys per object, items per list, total serialized bytes. */
export const MCP_ARGS_MAX_DEPTH = 8;
export const MCP_ARGS_MAX_KEYS = 64;
export const MCP_ARGS_MAX_ITEMS = 1024;
export const MCP_ARGS_MAX_BYTES = 64 * 1024;
/** The most UTF-8 bytes of display text one `message.delta` carries; longer text is sent as several (chunkText). */
export const MESSAGE_DELTA_MAX_BYTES = MAX_STRING_BYTES;
/** The most hosts a runtime's setup names, and the most bytes of a diff read's patch (both sides). */
export const RUNTIME_SETUP_MAX_HOSTS = 8;
export const GIT_DIFF_MAX_PATCH_BYTES = 2 * GIT_DIFF_MAX_BYTES_PER_SIDE;

/** UTF-8 length, counting stops once past `limit` (the result is then > limit). */
function utf8Len(s: string, limit: number): number {
  let n = 0;
  for (let i = 0; i < s.length && n <= limit; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * The bounded deep copy of an MCP call's arguments: JSON-like data only (no function, symbol, NaN or Infinity, class
 * instance, accessor, hole or `__proto__` key), at most 8 levels of objects and lists, 64 keys per object, 1024 items
 * per list and 64 KiB in all (counted as serialized JSON, roughly). A fresh copy, or NO.
 */
function boundedArgs(x: unknown): unknown | NoT {
  let bytes = 0;
  const add = (n: number): boolean => (bytes += n) <= MCP_ARGS_MAX_BYTES;
  const walk = (v: unknown, depth: number): unknown | NoT => {
    if (v === null) return add(4) ? null : NO;
    if (typeof v === 'boolean') return add(5) ? v : NO;
    if (typeof v === 'number') return Number.isFinite(v) && add(String(v).length) ? v : NO;
    if (typeof v === 'string') return wellFormed(v) && add(utf8Len(v, MCP_ARGS_MAX_BYTES) + 2) ? v : NO;
    const d = depth + 1;
    if (d > MCP_ARGS_MAX_DEPTH) return NO;
    if (Array.isArray(v)) {
      const a = plainArray(v); if (!a || a.length > MCP_ARGS_MAX_ITEMS || !add(2 + a.length)) return NO;
      const out: unknown[] = [];
      for (const item of a) { const c = walk(item, d); if (c === NO) return NO; out.push(c); }
      return out;
    }
    const keys = plainKeys(v); if (!keys || keys.length > MCP_ARGS_MAX_KEYS || !add(2)) return NO;
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (k === '__proto__' || !wellFormed(k) || !add(utf8Len(k, MCP_ARGS_MAX_BYTES) + 4)) return NO;
      const c = walk((v as Record<string, unknown>)[k], d); if (c === NO) return NO;
      setProp(out, k, c);
    }
    return out;
  };
  return walk(x, 0);
}

const commit = str({ re: COMMIT_RE });
const opId = str({ re: OP_ID_RE });
const runtimeRef = str({ re: RUNTIME_REF_RE });
/** The presented bearer: bounded first (at most 128 bytes), then the token shape. Its value is never logged. */
const bearer: Check<string> = (x) => (typeof x === 'string' && x.length <= TOKEN_MAX_BYTES && TOKEN_RE.test(x) ? x : NO);
const mcpUrl: Check<string> = (x) => {
  const s = str({ re: MCP_URL_RE })(x);
  if (s === NO) return NO;
  return Number(MCP_URL_RE.exec(s)![1]) <= 65535 ? s : NO;
};
function arrMax<T>(c: Check<T>, max: number, min = 0): Check<T[]> {
  return (x) => (Array.isArray(x) && x.length <= max && x.length >= min ? arr(c)(x) : NO);
}

const runtimeSetup = obj<RuntimeSetup>({ signedIn: oneOf(['yes', 'no', 'unknown'] as const), flagsOk: bool,
  label: str({ min: 1, re: /^[^\x00-\x1f\x7f]{1,64}$/ }),
  egressHosts: arrMax(obj({ host: str({ re: EGRESS_HOST_RE }), port: intIn(1, 65535) }), RUNTIME_SETUP_MAX_HOSTS) });

const RUNTIME_EVENT_CHECKS: Check<RuntimeEvent>[] = [
  obj({ t: lit('run.started'), runRef: runtimeRef, at: count }),
  obj({ t: lit('message.delta'), text: str({ min: 1 }) }),             // at most 4 KiB (MESSAGE_DELTA_MAX_BYTES)
  obj({ t: lit('tool.started'), callId: runtimeRef, tool: runtimeRef, argsSummary: text }),
  obj({ t: lit('tool.completed'), callId: runtimeRef, ok: bool, resultBytes: count }),
  obj({ t: lit('approval.requested'), approvalRef: runtimeRef, summary: text }),
  obj({ t: lit('usage'), inputTokens: count, outputTokens: count, cacheCreationTokens: count, cacheReadTokens: count,
    costUsdCents: nullable(count), toolCalls: count, estimated: bool }),
  obj({ t: lit('run.completed'), at: count, stopReason: nonEmpty }),
  obj({ t: lit('run.failed'), at: count, code: oneOf(['runtime_error', 'auth', 'limit', 'protocol'] as const), message: text }),
  obj({ t: lit('run.cancelled'), at: count })
];
const runtimeEvent: Check<RuntimeEvent> = (x) => {
  for (const c of RUNTIME_EVENT_CHECKS) { const v = c(x); if (v !== NO) return v; }
  return NO;
};

/** A diff read's patch: well-formed text of at most 2 MiB (UTF-8). */
const patchText: Check<string> = (x) =>
  (typeof x === 'string' && x.length <= GIT_DIFF_MAX_PATCH_BYTES && wellFormed(x) && utf8Len(x, GIT_DIFF_MAX_PATCH_BYTES) <= GIT_DIFF_MAX_PATCH_BYTES ? x : NO);
const gitReadResult: Check<GitReadResult> = (x) => {
  const s = obj<GitReadResult>({ ok: lit(true), read: lit('status'), branch: nonEmpty, head: nullable(commit), dirty: bool,
    integrationHead: nullable(commit), acceptedNotMerged: count, fastForward: bool })(x);
  if (s !== NO) return s;
  const d = obj<GitReadResult>({ ok: lit(true), read: lit('diff'), base: commit, head: commit, patch: patchText, bytes: count, truncated: bool })(x);
  if (d !== NO) return d;
  return obj<GitReadResult>({ ok: lit(false), code: oneOf(GIT_READ_ERROR_CODES), message: text })(x);
};

const execGrant = obj<SandboxExecGrant>({ execId: opId, argv: arrMax(text, 256, 1), cwd: str({ re: WORKSPACE_PATH_RE }),
  timeoutMs: intIn(1, SANDBOX_EXEC_MAX_TIMEOUT_MS) });

/**
 * Checks the value of a `sandbox_exec` reply before the runner runs it (defense in depth: main built it): `{ grant }`
 * with an id, a non-empty argv array (never a shell string), a cwd under `/workspace` and a bounded timeout. A fresh
 * copy, or null.
 */
export function parseExecGrant(value: unknown): SandboxExecGrant | null {
  try {
    const v = obj<{ grant: SandboxExecGrant }>({ grant: execGrant })(value);
    return v === NO ? null : v.grant;
  } catch {
    return null;
  }
}

/** Splits display text into pieces of at most `maxBytes` UTF-8 bytes, never inside a character. */
export function chunkText(textIn: string, maxBytes: number = MESSAGE_DELTA_MAX_BYTES): string[] {
  const out: string[] = [];
  let cur = ''; let n = 0;
  for (const ch of textIn) {
    const b = utf8Len(ch, 4);
    if (n + b > maxBytes && cur) { out.push(cur); cur = ''; n = 0; }
    cur += ch; n += b;
  }
  if (cur) out.push(cur);
  return out;
}

const reconciled = obj<ReconciledAttempt>({ attemptId: ulid, container: oneOf(['running', 'exited', 'created', 'missing'] as const) },
  { containerId: str({ re: CONTAINER_ID_RE }), exit: exitInfo, staged: arr(stagedOutput) });
const labelled = obj<LabelledResource>({ kind: oneOf(['container', 'volume', 'network'] as const), id: str({ re: RESOURCE_ID_RE }), labels });
const liveState = oneOf(['running', 'exited', 'missing'] as const);

const imageBuildDone: Check<RunnerToMain> = (x) => {
  const m = obj<Extract<RunnerToMain, { op: 'image.build.done' }>>(
    { op: lit('image.build.done'), buildId: ulid, outcome: oneOf(['succeeded', 'failed', 'cancelled'] as const) },
    { imageId: str({ re: DIGEST_RE }), sizeBytes: count, error: nonEmpty })(x);
  if (m === NO) return NO;
  if (m.outcome === 'succeeded') return m.imageId !== undefined && m.sizeBytes !== undefined && m.error === undefined ? m : NO;
  if (m.imageId !== undefined || m.sizeBytes !== undefined) return NO;
  return m.outcome === 'failed' ? (m.error !== undefined ? m : NO) : m;
};

const msg = (req: { [k: string]: Check<unknown> }, opt: { [k: string]: Check<unknown> } = {}): Check<RunnerToMain> =>
  obj<RunnerToMain>(req, opt);

const PARSERS: Record<RunnerOp, Check<RunnerToMain>> = {
  'ready': msg({ op: lit('ready'), bootId: ulid, mcpUrl: nullable(mcpUrl) }),
  'probe.result': msg({ op: lit('probe.result'), probe, images: arr(imageStatus), freeBytes: nullable(count),
    runtimes: arr(obj({ kind: runtimeKind, health: runtimeHealth }, { setup: runtimeSetup })) }),
  'mcp.call': msg({ op: lit('mcp.call'), callId: opId, bearer, tool: str({ re: TOOL_NAME_RE }), args: boundedArgs }),
  'agent.exec.done': msg({ op: lit('agent.exec.done'), attemptId: ulid, execId: opId, exit: exitInfo, stdoutBytes: count,
    stderrBytes: count, stdoutSha256: sha256, truncated: bool }),
  'attempt.runtime': msg({ op: lit('attempt.runtime'), attemptId: ulid, seq: count, event: runtimeEvent }),
  'git.read.result': msg({ op: lit('git.read.result'), reqId: opId, result: gitReadResult }),
  'attempt.provisioned': provisioned,
  'attempt.refused': msg({ op: lit('attempt.refused'), attemptId: ulid, reason: oneOf(REFUSAL_REASONS) }, { detail: text }),
  'attempt.event': msg({ op: lit('attempt.event'), attemptId: ulid, seq: count, event: progressEvent }),
  'attempt.heartbeat': msg({ op: lit('attempt.heartbeat'), attemptId: ulid, at: count, logBytes: count, outBytes: count },
    { container: liveState }),
  'attempt.exited': (x) => {
    const m = msg({ op: lit('attempt.exited'), attemptId: ulid, exit: exitInfo, outputs: arr(stagedOutput),
      parsed: arr(parsedOutput), logBytes: count }, { outputError: oneOf(OUTPUT_ERROR_CODES), outputErrorEntry: nonEmpty,
      reason: oneOf(EXIT_REASONS) })(x);
    if (m === NO) return NO;
    // An entry is named only with the refusal it explains.
    const e = m as Extract<RunnerToMain, { op: 'attempt.exited' }>;
    return e.outputErrorEntry !== undefined && e.outputError === undefined ? NO : m;
  },
  'reconcile.result': msg({ op: lit('reconcile.result'), docker: oneOf(['running', 'stopped', 'missing'] as const),
    attempts: arr(reconciled), labelled: arr(labelled) }),
  'service.health': msg({ op: lit('service.health'), attemptId: ulid, at: count, status: nullable(intIn(100, 599)),
    ms: nullable(count), container: liveState }, { bodySha256: sha256 }),
  'image.build.progress': msg({ op: lit('image.build.progress'), buildId: ulid, at: count, phase: nonEmpty }, { bytes: count }),
  'image.build.done': imageBuildDone,
  'blob.verified': msg({ op: lit('blob.verified'), sha256, ok: bool }),
  'gc.result': msg({ op: lit('gc.result'), scanId: ulid, objects: arr(obj({ sha256, bytes: count })),
    workDirs: arr(obj({ jobId: ulid, attemptN: intIn(1, Number.MAX_SAFE_INTEGER), mtime: count })), truncated: bool }),
  'fault': (x) => {
    const m = msg({ op: lit('fault'), message: text }, { attemptId: ulid, failureClass: oneOf(ATTEMPT_FAILURE_CLASSES) })(x);
    if (m === NO) return NO;
    const f = m as Extract<RunnerToMain, { op: 'fault' }>;
    return (f.attemptId === undefined) === (f.failureClass === undefined) ? m : NO;
  }
};

export const RUNNER_OPS: readonly RunnerOp[] = Object.keys(PARSERS) as RunnerOp[];

/**
 * Validates one message from the runner. Returns a fresh copy on success (never
 * the input object) and `null` for anything else: an unknown op, a missing or
 * extra key, an inherited or accessor property, a string over 4 KiB (UTF-8), an
 * array over 20,000 items, an id that is not ULID-shaped, or a count that is not
 * a non-negative safe integer.
 */
export function parseRunnerMessage(raw: unknown): RunnerToMain | null {
  try {
    const keys = plainKeys(raw);
    if (!keys || !keys.includes('op')) return null;
    const op = (raw as { op: unknown }).op;
    if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(PARSERS, op)) return null;
    const v = PARSERS[op as RunnerOp](raw);
    return v === NO ? null : v;
  } catch {
    return null;                                                    // e.g. a proxy that throws: never trusted
  }
}
