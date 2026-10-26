/**
 * The one request validator every nexus:* handler uses. The renderer sends ids and
 * small values only; each is checked here against a fixed shape before any service
 * runs. A refusal is a RequestError (field + why), which the envelope turns into
 * { ok: false, code: 'invalid', reason: 'bad_request', field }.
 *
 * - Objects are plain objects with an exact key set: an unknown key is refused, and
 *   so is an own `__proto__`, `constructor` or `prototype` key. Values are read from
 *   their own data descriptors; an accessor (getter or setter) is refused, never run.
 *   No schema has a key for a principal, an actor, a role or a folder; the only
 *   path-like field is `relPath`, which the source port confines again with realpath.
 * - Strings have length caps and patterns; numbers are finite integers in range;
 *   arrays hold unique entries within their bounds.
 * Pure: no I/O and no service access.
 *
 * B2a Task 13 adds the execution request shapes: an intent is a ULID the renderer mints once per user intent; job
 * inputs are `{ versionId, slot }` (a slot names the action's input, never a principal's standing); the jobs filter
 * uses `jobKind`; an action's params are checked against that action's own closed schema (src/shared/nexus/actions.ts):
 * a key naming an execution setting (a network, ports, an image, an argv, an environment, a command, a mount, an
 * identity) is a bad request, and any other breach of the schema (an unknown parameter, a value with a separator,
 * `..`, a drive, a stream name or a trailing dot) is `bad_params`.
 */
import { USER_ACTIONS } from '../../shared/nexus/actions';
import type { ParamField } from '../../shared/nexus/domainSpec';
import { JOB_STATES } from '../nexus/jobs/jobRules';

export class RequestError extends Error {
  /** `bad_request` (the shape) or `bad_params` (an action's own parameter schema). */
  readonly reason: 'bad_request' | 'bad_params';
  constructor(readonly field: string, readonly why: string, reason: 'bad_request' | 'bad_params' = 'bad_request') {
    super(`${field} ${why}`);
    this.name = 'RequestError';
    this.reason = reason;
  }
}

/** The ULID shape newId produces (Crockford base32, upper case). */
const PLATFORM_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WORKSPACE_ID = /^[a-z][a-z0-9-]{1,31}$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** The artifact kind registry's identifier shape (an artifact kind, never a principal kind). */
const ARTIFACT_KIND = /^[a-z][a-z0-9_.-]{1,39}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1F\x7F]/;
const MAX_REL_PATH = 1024;
const MAX_TITLE = 200;
const MAX_NOTE = 2000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** An action id (`sde.tests.run`), a slot (`repository`), a validator or recipe label. */
const ACTION_ID = /^[a-z][a-z0-9_.-]{1,63}$/;
const SLOT = /^[a-z][a-z0-9_]{0,31}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SKILL_ID = /^[a-z][a-z0-9_.-]{1,63}$/;
/** A branch name's shape only (the accept service applies the strict git rule to what it records). */
const BRANCH_SHAPE = /^[A-Za-z0-9._/-]{1,200}$/;
/** The most job inputs a start takes (the core's MAX_START_INPUTS) and the params / inline content budgets. */
export const MAX_JOB_INPUTS = 64;
export const MAX_PARAMS_BYTES = 8 * 1024;
export const MAX_INLINE_CONTENT_BYTES = 32 * 1024;
const MAX_PARAM_KEYS = 32;
const MAX_CONTENT_DEPTH = 8;
const MAX_CONTENT_NODES = 4000;
/**
 * Parameter names that would choose how or where something runs (S8): never accepted from the renderer, whatever the
 * action. Main picks the network, the image, the argv, the environment and every mount itself.
 */
const EXECUTION_SETTING_KEY = /^(network|networks|net|ports?|publish|expose|image|images|digest|argv|args|arguments|command|cmd|entrypoint|env|environment|exec|shell|script|mounts?|volumes?|binds?|devices?|privileged|cap_?add|capabilities|security_?opt|user|uid|gid|principal|principalid|actor|actorid|role|token|secrets?|egress|registry|registries|host|hostname|url|proxy)$/i;
export const JOB_KINDS_ACCEPTED = ['agent.run', 'tool.run', 'validate', 'ingest'] as const;
export const DEPLOYMENT_STATUSES_ACCEPTED = ['starting', 'healthy', 'unhealthy', 'stopped', 'failed'] as const;
export const APPROVAL_STATUSES_ACCEPTED = ['pending', 'approved', 'denied', 'expired', 'withdrawn'] as const;
export const IMAGE_PROFILES_ACCEPTED = ['sde-node', 'sde-python', 'nexus-fwd'] as const;
export const PREVIEW_PARTS = ['content', 'manifest', 'discovery', 'junit_summary', 'diff'] as const;
/** B2b: the agent session statuses a list may filter by, the message and comment bounds, and the cap names of a consent grant. */
export const SESSION_STATUSES_ACCEPTED = ['open', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'] as const;
export const MAX_AGENT_MESSAGE_CHARS = 8000;
export const MAX_REVIEW_COMMENT_CHARS = 4000;
export const MAX_FOCUS_VERSIONS = 20;
export const CONSENT_CAP_KEYS = ['turnUsdCents', 'dayUsdCents', 'turnsPerHour', 'concurrentTurns', 'turnTokens', 'toolCalls'] as const;
export const INLINE_KINDS_ACCEPTED = ['requirement', 'problem_statement'] as const;

const isPlain = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

/**
 * Runs a read of a renderer value (fix round 1): anything other than a RequestError it throws (a Proxy's trap, an exotic
 * object) is a bad request of `field`, never an `internal` answer.
 */
function guarded<T>(field: string, read: () => T): T {
  try { return read(); } catch (e) {
    if (e instanceof RequestError) throw e;
    throw new RequestError(field, 'could not be read');
  }
}

/**
 * The elements of a plain array of at most `max` entries, each read from its own data descriptor (fix round 1: an
 * element getter or setter is refused, never run; a hole is refused).
 */
function plainElements(x: unknown, f: string, min: number, max: number, why: string): unknown[] {
  return guarded(f, () => {
    if (!Array.isArray(x) || Object.getPrototypeOf(x) !== Array.prototype) throw new RequestError(f, why);
    const len = Object.getOwnPropertyDescriptor(x, 'length')?.value;
    if (typeof len !== 'number' || len < min || len > max) throw new RequestError(f, why);
    const out: unknown[] = [];
    for (let i = 0; i < len; i++) {
      const d = Object.getOwnPropertyDescriptor(x, i);
      if (!d || d.get !== undefined || d.set !== undefined || !('value' in d)) throw new RequestError(f, 'must hold plain values');
      out.push(d.value);
    }
    return out;
  });
}

function str(x: unknown, f: string): string {
  if (typeof x !== 'string') throw new RequestError(f, 'must be a string');
  return x;
}
function pattern(x: unknown, f: string, re: RegExp, max: number): string {
  const s = str(x, f);
  if (s.length === 0 || s.length > max || !re.test(s)) throw new RequestError(f, 'is not a valid id');
  return s;
}

export const V = {
  /** An artifact, version, participation or handoff id. */
  platformId(x: unknown, f: string): string { return pattern(x, f, PLATFORM_ID, 26); },
  projectId(x: unknown): string { return pattern(x, 'projectId', PROJECT_ID, 64); },
  workspaceId(x: unknown): string { return pattern(x, 'workspaceId', WORKSPACE_ID, 32); },
  commit(x: unknown): string {
    const s = str(x, 'commit');
    if (!COMMIT.test(s)) throw new RequestError('commit', 'must be a full 40-character commit id');
    return s;
  },
  /** An artifact kind filter. */
  artifactKind(x: unknown, f: string): string {
    const s = str(x, f);
    if (!ARTIFACT_KIND.test(s)) throw new RequestError(f, 'is not a valid artifact kind');
    return s;
  },
  /**
   * A path relative to the project folder. Rejected: empty, too long, NUL, absolute (POSIX, drive letter or UNC),
   * any '..' segment. Backslashes become '/'. The source port confines it again with realpath.
   */
  relPath(x: unknown): string {
    const s = str(x, 'relPath');
    if (s.length === 0 || s.length > MAX_REL_PATH) throw new RequestError('relPath', `must be 1 to ${MAX_REL_PATH} characters`);
    if (s.includes('\0')) throw new RequestError('relPath', 'must not contain NUL');
    const n = s.replace(/\\/g, '/');
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) throw new RequestError('relPath', 'must be relative to the project folder');
    if (n.split('/').some((seg) => seg === '..')) throw new RequestError('relPath', 'must stay inside the project folder');
    return n;
  },
  /** A title or a name: trimmed, 1 to 200 characters, no control characters. */
  title(x: unknown, f: string): string {
    const s = str(x, f).trim();
    if (s.length === 0 || s.length > MAX_TITLE) throw new RequestError(f, `must be 1 to ${MAX_TITLE} characters`);
    if (CONTROL.test(s)) throw new RequestError(f, 'must not contain control characters');
    return s;
  },
  /** An optional note: 0 to 2000 characters, no NUL. */
  note(x: unknown): string | undefined {
    if (x === undefined) return undefined;
    const s = str(x, 'note');
    if (s.length > MAX_NOTE) throw new RequestError('note', `must be at most ${MAX_NOTE} characters`);
    if (s.includes('\0')) throw new RequestError('note', 'must not contain NUL');
    return s;
  },
  /** 1..max unique platform ids. */
  idList(x: unknown, f: string, max: number): string[] {
    const out = plainElements(x, f, 1, max, `must list 1 to ${max} ids`).map((v, i) => V.platformId(v, `${f}[${i}]`));
    if (new Set(out).size !== out.length) throw new RequestError(f, 'must not repeat an id');
    return out;
  },
  /** Either `{ artifactId }` (append to that artifact) or `{ name }` (a new artifact), never both. */
  saveTarget(x: unknown): { artifactId: string } | { name: string } {
    const o = V.object(x, ['artifactId', 'name'] as const, ['artifactId', 'name'] as const);
    if ((o.artifactId === undefined) === (o.name === undefined)) throw new RequestError('target', 'names either an artifactId or a name');
    return o.artifactId !== undefined ? { artifactId: V.platformId(o.artifactId, 'artifactId') } : { name: V.title(o.name, 'name') };
  },
  /** A version id or null (the expected current version of a promote); undefined is refused. */
  idOrNull(x: unknown, f: string): string | null {
    return x === null ? null : V.platformId(x, f);
  },
  /**
   * A plain object with exactly these keys: every key not in `optional` is required, and an unknown key
   * is refused. Returns a null-prototype copy holding only the declared keys.
   */
  object<K extends string>(x: unknown, keys: readonly K[], optional: readonly K[] = []): Record<K, unknown> {
    return guarded('request', () => V.objectRead(x, keys, optional));
  },
  /** V.object's reads (run guarded: a Proxy's trap answers bad_request). */
  objectRead<K extends string>(x: unknown, keys: readonly K[], optional: readonly K[]): Record<K, unknown> {
    if (!isPlain(x)) throw new RequestError('request', 'must be an object');
    const own = Reflect.ownKeys(x);
    for (const k of own) {
      if (typeof k !== 'string' || FORBIDDEN_KEYS.has(k)) throw new RequestError('request', 'has a forbidden key');
      // An unknown key is named back only when it is a plain identifier, so nothing hostile is echoed.
      if (!(keys as readonly string[]).includes(k)) throw new RequestError(/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) ? k : 'request', 'is not an accepted field');
    }
    const out = Object.create(null) as Record<K, unknown>;
    for (const k of keys) {
      // Each value is read from its own data descriptor: a getter or setter (code that would run on read) is refused.
      const d = Object.getOwnPropertyDescriptor(x, k);
      if (d && (d.get !== undefined || d.set !== undefined || !('value' in d))) throw new RequestError(k, 'must be a plain value');
      const v = d ? d.value : undefined;
      if (v === undefined && !optional.includes(k)) throw new RequestError(k, 'is required');
      out[k] = v;
    }
    return out;
  },
  enumOf<T extends string>(x: unknown, f: string, values: readonly T[]): T {
    if (typeof x !== 'string' || !(values as readonly string[]).includes(x)) throw new RequestError(f, `must be one of ${values.join(', ')}`);
    return x as T;
  },
  int(x: unknown, f: string, min: number, max: number): number {
    if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < min || x > max) throw new RequestError(f, `must be an integer from ${min} to ${max}`);
    return x;
  },
  /** The positional arguments of a channel: at most `n`; trailing undefined arguments are ignored. */
  arity(args: readonly unknown[], n: number): void {
    for (let i = n; i < args.length; i++) if (args[i] !== undefined) throw new RequestError('arguments', `takes at most ${n}`);
  },

  // ---------- B2a Task 13: the execution request shapes ----------

  /** A user intent: a ULID the renderer minted once (re-sent on reload, never a second job). */
  intentId(x: unknown, f = 'intentId'): string { return pattern(x, f, PLATFORM_ID, 26); },
  actionId(x: unknown): string {
    const s = str(x, 'actionId');
    if (!ACTION_ID.test(s)) throw new RequestError('actionId', 'is not a valid action id');
    return s;
  },
  slot(x: unknown, f: string): string {
    const s = str(x, f);
    if (!SLOT.test(s)) throw new RequestError(f, 'is not a valid input slot');
    return s;
  },
  sha256(x: unknown, f: string): string {
    const s = str(x, f);
    if (!SHA256.test(s)) throw new RequestError(f, 'must be a lowercase sha256');
    return s;
  },
  jobKind(x: unknown): string { return V.enumOf(x, 'jobKind', JOB_KINDS_ACCEPTED); },
  /** 1..11 unique job states. */
  jobStates(x: unknown): string[] {
    const out = plainElements(x, 'states', 1, JOB_STATES.length, `must list 1 to ${JOB_STATES.length} job states`)
      .map((v, i) => V.enumOf(v, `states[${i}]`, JOB_STATES));
    if (new Set(out).size !== out.length) throw new RequestError('states', 'must not repeat a state');
    return out;
  },
  /** 0..max unique platform ids (an empty list is allowed). */
  idListOrEmpty(x: unknown, f: string, max: number): string[] {
    const out = plainElements(x, f, 0, max, `must list at most ${max} ids`).map((v, i) => V.platformId(v, `${f}[${i}]`));
    if (new Set(out).size !== out.length) throw new RequestError(f, 'must not repeat an id');
    return out;
  },
  /** A message to the agent: 1..8000 characters with some visible text; line breaks and tabs allowed, no other control character. */
  agentMessage(x: unknown): string {
    const s = str(x, 'message');
    if (s.trim().length === 0 || s.length > MAX_AGENT_MESSAGE_CHARS) throw new RequestError('message', `must be 1 to ${MAX_AGENT_MESSAGE_CHARS} characters`);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(s)) throw new RequestError('message', 'must not contain control characters');
    return s;
  },
  /** A review comment: at most 4000 characters, no NUL (the review service decides whether one is required). */
  reviewComment(x: unknown): string | undefined {
    if (x === undefined) return undefined;
    const s = str(x, 'comment');
    if (s.length > MAX_REVIEW_COMMENT_CHARS) throw new RequestError('comment', `must be at most ${MAX_REVIEW_COMMENT_CHARS} characters`);
    if (s.includes('\0')) throw new RequestError('comment', 'must not contain NUL');
    return s;
  },
  skillId(x: unknown): string {
    const s = str(x, 'skillId');
    if (!SKILL_ID.test(s)) throw new RequestError('skillId', 'is not a valid skill id');
    return s;
  },
  branchName(x: unknown): string {
    const s = str(x, 'branch');
    if (!BRANCH_SHAPE.test(s)) throw new RequestError('branch', 'is not a valid branch name');
    return s;
  },
  /** A full commit id (40 lowercase hex) under a field name of the caller's choosing. */
  commitId(x: unknown, f: string): string {
    const s = str(x, f);
    if (!COMMIT.test(s)) throw new RequestError(f, 'must be a full 40-character commit id');
    return s;
  },
  /** 1..8 unique session statuses. */
  sessionStatuses(x: unknown): (typeof SESSION_STATUSES_ACCEPTED)[number][] {
    const out = plainElements(x, 'statuses', 1, SESSION_STATUSES_ACCEPTED.length, `must list 1 to ${SESSION_STATUSES_ACCEPTED.length} session statuses`)
      .map((v, i) => V.enumOf(v, `statuses[${i}]`, SESSION_STATUSES_ACCEPTED));
    if (new Set(out).size !== out.length) throw new RequestError('statuses', 'must not repeat a status');
    return out;
  },
  /**
   * The caps of a consent grant: only the six the consent stores, each a whole number of 1 or more (a larger one is lowered to
   * the D-B4 ceiling by the service, never refused). There is no key for a destination: a host is never the renderer's to choose.
   */
  consentCaps(x: unknown): Partial<Record<(typeof CONSENT_CAP_KEYS)[number], number>> {
    const o = V.object(x, CONSENT_CAP_KEYS, CONSENT_CAP_KEYS);
    const out: Partial<Record<(typeof CONSENT_CAP_KEYS)[number], number>> = {};
    for (const k of CONSENT_CAP_KEYS) if (o[k] !== undefined) out[k] = V.int(o[k], k, 1, Number.MAX_SAFE_INTEGER);
    return out;
  },
  /** An approval answer: once or deny. 'always' does not exist (every approval is for one attempt). */
  decision(x: unknown): 'once' | 'deny' { return V.enumOf(x, 'decision', ['once', 'deny'] as const); },
  imageProfile(x: unknown): string { return V.enumOf(x, 'profileId', IMAGE_PROFILES_ACCEPTED); },
  /** The two kinds a user writes inline (a requirement, a problem statement); every other kind is refused here. */
  userAuthorableKind(x: unknown, f: string): string { return V.enumOf(x, f, INLINE_KINDS_ACCEPTED); },
  /** 0..64 job inputs, each exactly `{ versionId, slot }`, no pair twice. */
  jobInputs(x: unknown): { versionId: string; slot: string }[] {
    const out = plainElements(x, 'inputs', 0, MAX_JOB_INPUTS, `must list 0 to ${MAX_JOB_INPUTS} inputs`).map((v, i) => {
      const o = V.object(v, ['versionId', 'slot'] as const);
      return { versionId: V.platformId(o.versionId, `inputs[${i}].versionId`), slot: V.slot(o.slot, `inputs[${i}].slot`) };
    });
    if (new Set(out.map((i) => `${i.slot}\u0000${i.versionId}`)).size !== out.length) throw new RequestError('inputs', 'must not repeat an input');
    return out;
  },
  /**
   * An action's params: a plain object of at most 32 scalar values and 8 KiB, each read from its own data descriptor.
   * A key naming an execution setting is a bad request; then, for a known action, its own closed schema is applied
   * (an unknown action's params must be empty: the service refuses the action itself).
   */
  actionParams(actionId: string, x: unknown): Record<string, string | number | boolean> {
    return guarded('params', () => V.actionParamsRead(actionId, x));
  },
  /** V.actionParams' reads (run guarded: a Proxy's trap answers bad_request). */
  actionParamsRead(actionId: string, x: unknown): Record<string, string | number | boolean> {
    const raw = x === undefined ? {} : x;
    if (!isPlain(raw)) throw new RequestError('params', 'must be an object');
    const keys = Reflect.ownKeys(raw);
    if (keys.length > MAX_PARAM_KEYS) throw new RequestError('params', `holds at most ${MAX_PARAM_KEYS} values`);
    const out = Object.create(null) as Record<string, string | number | boolean>;
    for (const k of keys) {
      if (typeof k !== 'string' || FORBIDDEN_KEYS.has(k)) throw new RequestError('params', 'has a forbidden key');
      if (EXECUTION_SETTING_KEY.test(k)) throw new RequestError('params', 'names an execution setting the renderer never chooses');
      const d = Object.getOwnPropertyDescriptor(raw, k)!;
      if (d.get !== undefined || d.set !== undefined || !('value' in d)) throw new RequestError('params', 'must hold plain values');
      const v = d.value;
      if (typeof v === 'string') { if (v.length > 1024) throw new RequestError('params', 'holds a value that is too long'); }
      else if (typeof v === 'number') { if (!Number.isFinite(v)) throw new RequestError('params', 'holds a number that is not finite'); }
      else if (typeof v !== 'boolean') throw new RequestError('params', 'must hold strings, numbers or booleans');
      out[k] = v;
    }
    if (JSON.stringify(out).length > MAX_PARAMS_BYTES) throw new RequestError('params', `must be at most ${MAX_PARAMS_BYTES} bytes`);
    const action = USER_ACTIONS.find((a) => a.id === actionId);
    if (!action) {
      if (Object.keys(out).length > 0) throw new RequestError('params', 'are not accepted for an unknown action', 'bad_params');
      return out;
    }
    const schema = action.params;
    for (const k of Object.keys(out)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, k)) throw new RequestError('params', 'has a parameter this action does not take', 'bad_params');
    }
    for (const r of schema.required) if (!(r in out)) throw new RequestError('params', `needs ${/^[a-zA-Z]{1,32}$/.test(r) ? r : 'a value'}`, 'bad_params');
    for (const [k, def] of Object.entries(schema.properties) as [string, ParamField][]) {
      if (!(k in out)) continue;
      if (!paramFits(def, out[k])) throw new RequestError('params', 'holds a value this action does not accept', 'bad_params');
    }
    return out;
  },
  /** A requirement's or problem statement's content: plain JSON (objects, arrays, scalars), at most 32 KiB, depth 8. */
  inlineContent(x: unknown): Record<string, unknown> {
    return guarded('content', () => V.inlineContentRead(x));
  },
  /** V.inlineContent's reads (run guarded). */
  inlineContentRead(x: unknown): Record<string, unknown> {
    if (!isPlain(x)) throw new RequestError('content', 'must be an object');
    let nodes = 0;
    const copy = (v: unknown, depth: number): unknown => {
      if (++nodes > MAX_CONTENT_NODES) throw new RequestError('content', 'is too large');
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
      if (typeof v === 'number') { if (!Number.isFinite(v)) throw new RequestError('content', 'holds a number that is not finite'); return v; }
      if (depth >= MAX_CONTENT_DEPTH) throw new RequestError('content', 'is nested too deeply');
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype) throw new RequestError('content', 'must be plain JSON');
        return v.map((y, i) => {
          const d = Object.getOwnPropertyDescriptor(v, i);
          if (!d || d.get !== undefined || d.set !== undefined) throw new RequestError('content', 'must hold plain values');
          return copy(d.value, depth + 1);
        });
      }
      if (!isPlain(v)) throw new RequestError('content', 'must be plain JSON');
      const o = Object.create(null) as Record<string, unknown>;
      for (const k of Reflect.ownKeys(v)) {
        if (typeof k !== 'string' || FORBIDDEN_KEYS.has(k)) throw new RequestError('content', 'has a forbidden key');
        const d = Object.getOwnPropertyDescriptor(v, k)!;
        if (d.get !== undefined || d.set !== undefined || !('value' in d)) throw new RequestError('content', 'must hold plain values');
        if (d.value === undefined) continue;
        o[k] = copy(d.value, depth + 1);
      }
      return o;
    };
    const out = copy(x, 0) as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_INLINE_CONTENT_BYTES) throw new RequestError('content', `must be at most ${MAX_INLINE_CONTENT_BYTES} bytes`);
    // A plain object again (the service's schema check reads it as ordinary JSON).
    return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
  }
};

/** One parameter value against its field: bounded strings with no separator, `..`, NUL, drive or stream name. */
function paramFits(def: ParamField, v: unknown): boolean {
  if (def.type === 'boolean') return typeof v === 'boolean';
  if (def.type === 'integer') return typeof v === 'number' && Number.isSafeInteger(v) && v >= def.minimum && v <= def.maximum;
  if (typeof v !== 'string' || v.length === 0 || v.length > def.maxLength) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F\/\\:]/.test(v) || v.includes('..') || /[. ]$/.test(v)) return false;
  if (def.pattern !== undefined && !new RegExp(def.pattern).test(v)) return false;
  if (def.enum !== undefined && !def.enum.includes(v)) return false;
  return true;
}
