// Agent capability tokens (B2b): the claims main records for one agent turn, and
// the shape of the raw token the agent's MCP client presents. The raw token is
// opaque: `<jti>.<mac>`, a 22-character base64url id and a 43-character base64url
// HMAC-SHA256 of that id under a key that lives only in main's memory for one
// boot. The claims are never inside the token; main records them in its own
// table (`capability_tokens`, schema v10) by `jti`, through claimsRowParts below,
// and rebuilds them from that row and its session. The token travels to the runner
// only over the MessagePort, is never in argv, a log, the model context, a
// database row or a view. Pure; no I/O.

import { createHash } from 'node:crypto';
import type { DomainSpec } from './domainSpec';

/** The raw token: `<jti 22 b64url>.<mac 43 b64url>`. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
/** The token id alone (16 random bytes in base64url). */
export const JTI_RE = /^[A-Za-z0-9_-]{22}$/;
/** The most bytes a presented bearer may have before it is even matched against TOKEN_RE. */
export const TOKEN_MAX_BYTES = 128;
/** The principal a token is issued to: `agent:<sessionId>`. */
export const AGENT_SUBJECT_RE = /^agent:[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * One capability a token grants: the domain ceiling's entry (its id and optional scope), intersected with the turn.
 * A token never holds a capability its domain's ceiling does not list.
 */
export type TokenCapability = DomainSpec['capabilities'][number];

export interface CapabilityClaims {
  jti: string;
  sub: `agent:${string}`;
  /** The agent always acts for the local user; it never acts for itself. */
  onBehalfOf: 'user:local';
  projectId: string;
  workspaceId: string;
  participationId: string;
  jobId: string;
  sessionId: string;
  caps: TokenCapability[];
  /** The version ids the turn was given as inputs (it may also read its own outputs). */
  inputs: string[];
  /** The MCP tool names the turn may call (a subset of MCP_TOOLS). */
  mcpTools: string[];
  maxChildJobs: number;
  /** Issued at and expiry, in ms since the epoch. */
  iat: number;
  exp: number;
}

/** True when `raw` has the shape of a token (bounded first, then TOKEN_RE). It says nothing about validity. */
export function isTokenShape(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length <= TOKEN_MAX_BYTES && TOKEN_RE.test(raw);
}

/**
 * The `capability_tokens` row (schema v10) for a set of claims: the one mapping main writes and reads back.
 * - `caps_json` is the JSON text of `{ caps, maxChildJobs }` (JSON.stringify, keys in that order; each cap as the
 *   domain ceiling lists it). The v10 CHECK requires a JSON object of at most 8 KiB, so the array is never the column.
 * - `caps_sha256` is the sha256 (lowercase hex) of exactly that text.
 * - `inputs_json` holds `inputs`, `tools_json` holds `mcpTools` (JSON arrays).
 * - `issued_at` and `expires_at` are `iat` and `exp` (ms since the epoch; exp after iat).
 * - `principal_id` is `sub` (`agent:<sessionId>`), `on_behalf_of` the user the turn acts for.
 * - The project, workspace and participation are not columns: main derives them from the token's job and session
 *   (the claims' copies must agree with those rows when main rebuilds the claims).
 * Throws a TypeError on claims that cannot be a v10 row (never a partial row). Pure: no I/O, no clock.
 */
export interface ClaimsRowParts {
  jti: string; job_id: string; session_id: string; principal_id: string; on_behalf_of: string;
  caps_json: string; inputs_json: string; tools_json: string; caps_sha256: string;
  issued_at: number; expires_at: number;
}
export function claimsRowParts(claims: CapabilityClaims): ClaimsRowParts {
  const c = claims;
  if (!c || typeof c !== 'object') throw new TypeError('claims must be an object');
  if (typeof c.jti !== 'string' || !JTI_RE.test(c.jti)) throw new TypeError('jti is not a token id');
  if (typeof c.sessionId !== 'string' || c.sub !== `agent:${c.sessionId}` || !AGENT_SUBJECT_RE.test(c.sub)) {
    throw new TypeError('sub is the agent of the session');
  }
  if (typeof c.jobId !== 'string' || c.jobId.length === 0) throw new TypeError('a token names its job');
  if (!Array.isArray(c.caps) || !Array.isArray(c.inputs) || !Array.isArray(c.mcpTools)) throw new TypeError('caps, inputs and mcpTools are lists');
  if (!Number.isSafeInteger(c.maxChildJobs) || c.maxChildJobs < 0) throw new TypeError('maxChildJobs is a whole number');
  if (!Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp) || c.exp <= c.iat) throw new TypeError('exp is after iat');
  const caps_json = JSON.stringify({ caps: c.caps, maxChildJobs: c.maxChildJobs });
  const inputs_json = JSON.stringify(c.inputs);
  const tools_json = JSON.stringify(c.mcpTools);
  // The v10 length CHECKs, so a caller never meets them first.
  if (caps_json.length > 8192 || inputs_json.length > 8192 || tools_json.length > 2048) throw new TypeError('claims are over the row bounds');
  return {
    jti: c.jti, job_id: c.jobId, session_id: c.sessionId, principal_id: c.sub, on_behalf_of: c.onBehalfOf,
    caps_json, inputs_json, tools_json, caps_sha256: createHash('sha256').update(caps_json).digest('hex'),
    issued_at: c.iat, expires_at: c.exp
  };
}
