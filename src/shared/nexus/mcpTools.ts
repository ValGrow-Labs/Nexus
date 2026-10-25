// The MCP tools Nexus serves to an agent turn (B2b), as data. The runner's
// loopback server lists them and forwards every call to main; main verifies the
// token, checks the tool is in the token's claims, parses the arguments here,
// authorizes the capability and runs one service call. Tool names use
// underscores: model tool names allow `[a-zA-Z0-9_-]` only.
//
// Absent on purpose: promote, discard, review decisions, accepting or merging a
// change, answering an approval, signing, handoffs, any secret or credential
// tool and any network tool. Pure; no I/O.

import type { CapabilityId, ParamField } from './domainSpec';
import { deepFreeze } from './freeze';

export type McpToolName =
  | 'context_get' | 'artifact_list' | 'artifact_read' | 'validations_get' | 'job_status' | 'job_logs'
  | 'sandbox_exec' | 'job_request' | 'changeset_register' | 'requirement_draft' | 'review_request';

/**
 * One argument field: the action parameter fields (bounded strings, integers, booleans), plus bounded lists and
 * closed objects, which an agent's arguments need (an argv, a requirement's criteria).
 */
export type McpArgField =
  | ParamField
  | { type: 'array'; items: McpArgField; maxItems: number; minItems?: number }
  | { type: 'object'; properties: Readonly<Record<string, McpArgField>>; required: readonly string[] };

/** A tool's argument schema: a closed object, like an action's ParamsSchema (which it extends with lists and objects). */
export interface McpArgsSchema {
  type: 'object';
  properties: Readonly<Record<string, McpArgField>>;
  required: readonly string[];
  additionalProperties: false;
}

export interface McpToolDef {
  name: McpToolName;
  /** The capability the token must grant (always within the SDE ceiling in B2b). */
  capability: CapabilityId;
  args: McpArgsSchema;
  /** True when a call changes a record or the worktree. */
  mutates: boolean;
  /** The most bytes of the serialized result returned to the agent. */
  resultMaxBytes: number;
}

const KIB = 1024;
const ULID = '^[0-9A-HJKMNP-TV-Z]{26}$';
const KIND = '^[a-z][a-z0-9_]{0,63}$';
const id = { type: 'string', maxLength: 26, pattern: ULID } as const;
const schema = (properties: Record<string, McpArgField>, required: string[] = []): McpArgsSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });

/** The most bytes of one artifact read and of one log page. */
export const ARTIFACT_READ_MAX_BYTES = 256 * KIB;
export const JOB_LOGS_MAX_BYTES = 64 * KIB;
/** The most bytes of stdout and of stderr a `sandbox_exec` returns to the agent (each, redacted). */
export const SANDBOX_EXEC_OUTPUT_MAX_BYTES = 64 * KIB;
/** The longest a single `sandbox_exec` may run (never more than the turn's remaining wall clock). */
export const SANDBOX_EXEC_MAX_TIMEOUT_MS = 30 * 60_000;
/** The recipes `job_request` may ask for in B2b (installs go through approval A1). */
export const JOB_REQUEST_RECIPES: readonly string[] = deepFreeze(['sde.deps.node', 'sde.deps.python', 'sde.test.discover']);

export const MCP_TOOLS: readonly McpToolDef[] = deepFreeze([
  { name: 'context_get', capability: 'artifact.read', args: schema({}), mutates: false, resultMaxBytes: 64 * KIB },
  { name: 'artifact_list', capability: 'artifact.read', mutates: false, resultMaxBytes: 64 * KIB,
    args: schema({ kind: { type: 'string', maxLength: 64, pattern: KIND }, limit: { type: 'integer', minimum: 1, maximum: 100 } }) },
  { name: 'artifact_read', capability: 'artifact.read', mutates: false, resultMaxBytes: ARTIFACT_READ_MAX_BYTES + 16 * KIB,
    args: schema({ versionId: id, path: { type: 'string', maxLength: 1024 },
      maxBytes: { type: 'integer', minimum: 1, maximum: ARTIFACT_READ_MAX_BYTES } }, ['versionId']) },
  { name: 'validations_get', capability: 'artifact.read', mutates: false, resultMaxBytes: 64 * KIB,
    args: schema({ versionId: id }, ['versionId']) },
  { name: 'job_status', capability: 'artifact.read', mutates: false, resultMaxBytes: 16 * KIB,
    args: schema({ jobId: id }, ['jobId']) },
  { name: 'job_logs', capability: 'artifact.read', mutates: false, resultMaxBytes: JOB_LOGS_MAX_BYTES + 4 * KIB,
    args: schema({ jobId: id, fromOffset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      maxBytes: { type: 'integer', minimum: 1, maximum: JOB_LOGS_MAX_BYTES } }, ['jobId']) },
  { name: 'sandbox_exec', capability: 'sandbox.exec', mutates: true, resultMaxBytes: 2 * SANDBOX_EXEC_OUTPUT_MAX_BYTES + 4 * KIB,
    args: schema({
      argv: { type: 'array', items: { type: 'string', maxLength: 4096 }, minItems: 1, maxItems: 256 },
      // `/workspace` or a path below it: no empty, `.` or `..` segment, no backslash or NUL.
      cwd: { type: 'string', maxLength: 1024, pattern: '^/workspace(?:/(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000]+)*$' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: SANDBOX_EXEC_MAX_TIMEOUT_MS }
    }, ['argv', 'timeoutMs']) },
  { name: 'job_request', capability: 'job.request', mutates: true, resultMaxBytes: 4 * KIB,
    args: schema({
      recipeId: { type: 'string', maxLength: 64, enum: JOB_REQUEST_RECIPES },
      inputs: { type: 'array', items: id, maxItems: 20 }
    }, ['recipeId']) },
  // B2b Task 8 (the change-set register contract supersedes the earlier `message`-only placeholder).
  { name: 'changeset_register', capability: 'artifact.register', mutates: true, resultMaxBytes: 16 * KIB,
    args: schema({
      title: { type: 'string', maxLength: 200 },
      summary: { type: 'string', maxLength: 4000 },
      requirementVersionIds: { type: 'array', items: id, maxItems: 5 },
      reviseArtifactId: id,
      clientKey: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_-]{1,64}$' }
    }, ['title', 'summary', 'clientKey']) },
  { name: 'requirement_draft', capability: 'artifact.register', mutates: true, resultMaxBytes: 8 * KIB,
    args: schema({
      title: { type: 'string', maxLength: 200 },
      body: { type: 'string', maxLength: 32 * KIB },
      criteria: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['id', 'text'],
        properties: { id: { type: 'string', maxLength: 32, pattern: '^[A-Za-z0-9_.-]{1,32}$' }, text: { type: 'string', maxLength: 2000 } } } },
      clientKey: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_-]{1,64}$' }
    }, ['title', 'criteria', 'clientKey']) },
  { name: 'review_request', capability: 'review.request', mutates: true, resultMaxBytes: 4 * KIB,
    args: schema({ versionId: id, note: { type: 'string', maxLength: 2000 } }, ['versionId']) }
]);

export const MCP_TOOL_NAMES: readonly McpToolName[] = deepFreeze(MCP_TOOLS.map((t) => t.name));

export function getMcpTool(name: string): McpToolDef | null {
  return MCP_TOOLS.find((t) => t.name === name) ?? null;
}

export type ToolArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; code: 'unknown_tool' | 'bad_args'; field: string | null };

const isPlainObject = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

/** Returns a fresh copy of `x` when it fits `f`, or the path of the first field that does not. */
function check(f: McpArgField, x: unknown, at: string): { v: unknown } | { bad: string } {
  switch (f.type) {
    case 'string':
      if (typeof x !== 'string' || x.length > f.maxLength) return { bad: at };
      if (f.pattern !== undefined && !new RegExp(f.pattern, 'u').test(x)) return { bad: at };
      if (f.enum !== undefined && !f.enum.includes(x)) return { bad: at };
      return { v: x };
    case 'integer':
      return typeof x === 'number' && Number.isSafeInteger(x) && x >= f.minimum && x <= f.maximum ? { v: x } : { bad: at };
    case 'boolean':
      return typeof x === 'boolean' ? { v: x } : { bad: at };
    case 'array': {
      if (!Array.isArray(x) || x.length > f.maxItems || x.length < (f.minItems ?? 0)) return { bad: at };
      const out: unknown[] = [];
      for (let i = 0; i < x.length; i++) {
        const r = check(f.items, x[i], `${at}/${i}`);
        if ('bad' in r) return r;
        out.push(r.v);
      }
      return { v: out };
    }
    case 'object':
      return checkObject(f.properties, f.required, x, at);
  }
}

function checkObject(properties: Readonly<Record<string, McpArgField>>, required: readonly string[], x: unknown, at: string):
  { v: Record<string, unknown> } | { bad: string } {
  if (!isPlainObject(x)) return { bad: at || '/' };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(x)) if (!Object.prototype.hasOwnProperty.call(properties, k)) return { bad: `${at}/${k.slice(0, 64)}` };
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(x, k)) return { bad: `${at}/${k}` };
  for (const [k, f] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(x, k)) continue;
    const r = check(f, x[k], `${at}/${k}`);
    if ('bad' in r) return r;
    Object.defineProperty(out, k, { value: r.v, enumerable: true, writable: true, configurable: true });
  }
  return { v: out };
}

/**
 * Parses one call's arguments against its tool's schema (after the runner protocol's bounded copy). Returns a fresh
 * copy, or `unknown_tool` / `bad_args` with the path of the first field refused. Never throws.
 */
export function parseToolArgs(tool: string, args: unknown): ToolArgsResult {
  const def = getMcpTool(tool);
  if (!def) return { ok: false, code: 'unknown_tool', field: null };
  try {
    const r = checkObject(def.args.properties, def.args.required, args, '');
    return 'bad' in r ? { ok: false, code: 'bad_args', field: r.bad } : { ok: true, args: r.v };
  } catch {
    return { ok: false, code: 'bad_args', field: null };
  }
}
