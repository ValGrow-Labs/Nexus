/**
 * Capability tokens (B2b): one opaque bearer per agent turn, minted inside the lease transaction and checked on every
 * MCP call.
 *
 * - The raw token is `<jti>.<mac>`: a 22-character base64url id (16 random bytes) and the 43-character base64url
 *   HMAC-SHA256 of that id under a 32-byte key. The key is made once per TokenService, i.e. once per main boot. It
 *   lives in a private field of this instance only: it is never exported, logged, written or sent anywhere. A new boot
 *   (a new key) makes every earlier token fail its signature.
 * - The claims live in `capability_tokens` (schema v10), keyed by the jti. The token text and its MAC are never
 *   stored, logged, put in an activity row or a view, or returned by anything but `mintTx`.
 * - `mintTx(system, claims)` runs inside the caller's transaction (the execution core's lease transaction): the job is
 *   an `agent.run` job of the session that was just leased (or runs), the subject is the session's agent principal,
 *   the grant stays inside the domain's ceiling (capabilities, their recipe and kind lists, and every path exclusion
 *   of the ceiling), the tools are MCP tools whose capability is granted, and the inputs are versions of the project.
 * - `verify(raw, now)`: the shape (TOKEN_RE, bounded first), a constant-time MAC compare, then the row (its parsed
 *   claims cached in memory per jti; revocation is read fresh every time). The codes are `malformed`,
 *   `bad_signature`, `unknown`, `expired` and `revoked`; an expired or revoked token also returns its stored claims so
 *   the refusal can be audited against its job.
 * - `revokeForJob` (the job ended, its session was cancelled, a cap was reached) and `revokeLiveAgentTokens` (platform
 *   startup: `restart`; every runner `ready`: `runner_restart`) record the revocation once per row; each call that
 *   revoked something writes one `token.revoke` activity row holding counts only.
 */
import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Principal } from '../../../shared/nexus/platform';
import type { CapabilityClaims, TokenCapability } from '../../../shared/nexus/tokens';
import { AGENT_SUBJECT_RE, isTokenShape, JTI_RE } from '../../../shared/nexus/tokens';
import { MCP_TOOLS } from '../../../shared/nexus/mcpTools';
import { AGENT_DEFAULTS } from '../../../shared/nexus/agentPolicy';
import { getDomain } from '../../../shared/nexus/domains/index';
import type { AuthService } from '../auth/authService';
import { appendActivityRow } from '../activity/writer';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';

const PLATFORM = { type: 'platform' } as const;
/** A token outlives its turn's wall clock by this much at most (the job's end revokes it first). */
export const TOKEN_GRACE_MS = 5 * 60_000;
/** The default lifetime: the D-B4 wall clock plus the grace. */
export const TOKEN_DEFAULT_TTL_MS = AGENT_DEFAULTS.wallClockMs + TOKEN_GRACE_MS;
/** The most input versions one token names (the turn's focus versions and its context). */
export const TOKEN_MAX_INPUTS = 64;

export type TokenVerifyCode = 'malformed' | 'bad_signature' | 'unknown' | 'expired' | 'revoked';
export type TokenVerifyResult = { ok: true; claims: CapabilityClaims } | { ok: false; code: TokenVerifyCode; claims?: CapabilityClaims };
export type TokenRevokeReason = 'job_ended' | 'session_cancelled' | 'restart' | 'runner_restart' | 'budget';

/** What the lease transaction asks for; the service adds the jti, the subject, the user and the times. */
export interface MintClaims {
  jobId: string;
  sessionId: string;
  caps: TokenCapability[];
  inputs: string[];
  mcpTools: string[];
  maxChildJobs?: number;
  /** The token's lifetime from now (default TOKEN_DEFAULT_TTL_MS, at most that). */
  ttlMs?: number;
}

export interface TokenServiceDeps {
  auth: AuthService;
  now: () => number;
  /** Tests may pass a fixed source; default node:crypto. */
  randomBytes?: (n: number) => Buffer;
}

interface TokenRow {
  jti: string; job_id: string; session_id: string; principal_id: string; on_behalf_of: string; caps_json: string;
  inputs_json: string; tools_json: string; issued_at: number; expires_at: number; revoked_at: number | null;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export class TokenService {
  readonly #mac: (jti: string) => Buffer;
  readonly #random: (n: number) => Buffer;
  /** Parsed claims per jti (claims are immutable once minted; revocation is read fresh). */
  readonly #claims = new Map<string, CapabilityClaims>();
  /** Told after a revocation commits: the job whose tokens were revoked, or null when every live token was (restart, new runner). */
  readonly #revokeListeners: ((jobId: string | null) => void)[] = [];

  constructor(private readonly db: Database.Database, private readonly deps: TokenServiceDeps) {
    this.#random = deps.randomBytes ?? ((n) => nodeRandomBytes(n));
    const key = this.#random(32);
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new PlatformError('invalid', 'the token key must be 32 bytes');
    // The key is captured here and nowhere else: not a property, not exported, never logged.
    this.#mac = (jti) => createHmac('sha256', key).update(jti, 'utf8').digest();
  }

  /**
   * Inside the caller's transaction: records the claims and returns the raw token `jti.mac`. The caller hands the
   * token to the runner over the MessagePort only; nothing else may keep it.
   */
  mintTx(system: Principal, c: MintClaims): string {
    if (!this.db.inTransaction) throw new PlatformError('platform_unavailable', 'mintTx runs inside the lease transaction');
    this.deps.auth.require(system, 'token.mint', PLATFORM, { entityType: 'capability_token' });
    if (!c || typeof c !== 'object') throw new PlatformError('invalid', 'claims must be an object');
    if (!isStr(c.jobId) || !isStr(c.sessionId)) throw new PlatformError('invalid', 'a token names its job and session');
    const job = this.db.prepare(`SELECT id, kind, state, project_id, workspace_id, participation_id, session_id, on_behalf_of FROM jobs WHERE id = ?`)
      .get(c.jobId) as { id: string; kind: string; state: string; project_id: string; workspace_id: string; participation_id: string | null;
        session_id: string | null; on_behalf_of: string } | undefined;
    if (!job) throw new PlatformError('not_found', 'job not found');
    if (job.kind !== 'agent.run' || job.session_id !== c.sessionId) throw new PlatformError('invalid', 'a token is minted for an agent turn of its session');
    if (job.state !== 'leased' && job.state !== 'running') throw new PlatformError('invalid', 'a token is minted when the turn is leased', { state: job.state });
    if (job.participation_id === null) throw new PlatformError('invalid', 'the turn has no participation');
    const sub = `agent:${c.sessionId}` as const;
    if (!AGENT_SUBJECT_RE.test(sub)) throw new PlatformError('invalid', 'a session id is a ULID');
    const caps = this.checkCaps(job.workspace_id, c.caps);
    const mcpTools = this.checkTools(c.mcpTools, caps);
    const inputs = this.checkInputs(job.project_id, c.inputs);
    const maxChildJobs = c.maxChildJobs === undefined ? AGENT_DEFAULTS.childJobs : c.maxChildJobs;
    if (!Number.isSafeInteger(maxChildJobs) || maxChildJobs < 0 || maxChildJobs > AGENT_DEFAULTS.childJobs) {
      throw new PlatformError('invalid', `maxChildJobs is 0..${AGENT_DEFAULTS.childJobs}`);
    }
    const ttl = c.ttlMs === undefined ? TOKEN_DEFAULT_TTL_MS : c.ttlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > TOKEN_DEFAULT_TTL_MS) throw new PlatformError('invalid', 'ttlMs is out of range');
    const now = this.deps.now();
    const jti = this.#random(16).toString('base64url');
    if (!JTI_RE.test(jti)) throw new PlatformError('invalid', 'the token id source is broken');
    // The row's caps_json is an object (the v10 CHECK): the grant and the child-job budget, the same mapping as tokens.ts claimsRowParts.
    const capsJson = JSON.stringify({ caps, maxChildJobs });
    this.db.prepare(`INSERT INTO capability_tokens (jti, job_id, session_id, principal_id, on_behalf_of, caps_json, inputs_json, tools_json,
        caps_sha256, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(jti, job.id, c.sessionId, sub, job.on_behalf_of, capsJson, JSON.stringify(inputs), JSON.stringify(mcpTools),
        createHash('sha256').update(capsJson).digest('hex'), now, now + ttl);
    appendActivityRow(this.db, { actorKind: 'system', actorId: system.id, onBehalfOf: job.on_behalf_of, sessionId: c.sessionId, jobId: job.id,
      projectId: job.project_id, workspaceId: job.workspace_id, entityType: 'capability_token', entityId: job.id, action: 'token.mint',
      status: 'succeeded', details: { caps: caps.length, tools: mcpTools.length, inputs: inputs.length, maxChildJobs, expiresAt: now + ttl } }, now);
    return `${jti}.${this.#mac(jti).toString('base64url')}`;
  }

  /** Checks a presented bearer. Never throws; never logs it. */
  verify(raw: unknown, now: number = this.deps.now()): TokenVerifyResult {
    if (!isTokenShape(raw)) return { ok: false, code: 'malformed' };
    const dot = raw.indexOf('.');
    const jti = raw.slice(0, dot);
    const presented = Buffer.from(raw.slice(dot + 1), 'utf8');
    const expected = Buffer.from(this.#mac(jti).toString('base64url'), 'utf8');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { ok: false, code: 'bad_signature' };
    let claims: CapabilityClaims | null;
    let revoked: boolean;
    try {
      const state = this.db.prepare('SELECT revoked_at FROM capability_tokens WHERE jti = ?').get(jti) as { revoked_at: number | null } | undefined;
      if (!state) return { ok: false, code: 'unknown' };
      revoked = state.revoked_at !== null;
      claims = this.claimsOf(jti);
    } catch {
      return { ok: false, code: 'unknown' };
    }
    if (!claims) return { ok: false, code: 'unknown' };
    if (revoked) return { ok: false, code: 'revoked', claims };
    if (!(claims.exp > now)) return { ok: false, code: 'expired', claims };
    return { ok: true, claims };
  }

  /** B2b Task 5: `fn(jobId)` runs after a revocation of one job's tokens (or `fn(null)` after every live token's); it never throws out. */
  onRevoked(fn: (jobId: string | null) => void): void { this.#revokeListeners.push(fn); }

  private notifyRevoked(jobId: string | null): void {
    for (const fn of this.#revokeListeners) { try { fn(jobId); } catch { /* a listener never breaks a revocation */ } }
  }

  /** Revokes the live tokens of one job (its end, its session's cancel, a cap reached). Works inside or outside a transaction. */
  revokeForJob(system: Principal, jobId: string, reason: TokenRevokeReason): number {
    this.requireSystem(system);
    if (!isStr(jobId)) throw new PlatformError('invalid', 'jobId is required');
    if (!['job_ended', 'session_cancelled', 'restart', 'runner_restart', 'budget'].includes(reason)) throw new PlatformError('invalid', 'unknown revoke reason');
    const now = this.deps.now();
    const count = immediateTx(this.db, () => {
      const rows = this.db.prepare(`SELECT t.jti, j.project_id, j.workspace_id, t.session_id FROM capability_tokens t JOIN jobs j ON j.id = t.job_id
        WHERE t.job_id = ? AND t.revoked_at IS NULL`).all(jobId) as { jti: string; project_id: string; workspace_id: string; session_id: string }[];
      if (rows.length === 0) return 0;
      const n = this.db.prepare('UPDATE capability_tokens SET revoked_at = MAX(?, issued_at), revoke_reason = ? WHERE job_id = ? AND revoked_at IS NULL')
        .run(now, reason, jobId).changes;
      appendActivityRow(this.db, { actorKind: 'system', actorId: system.id, jobId, sessionId: rows[0].session_id, projectId: rows[0].project_id,
        workspaceId: rows[0].workspace_id, entityType: 'capability_token', entityId: jobId, action: 'token.revoke', status: 'succeeded',
        details: { reason, count: n } }, now);
      return n;
    });
    this.notifyRevoked(jobId);
    return count;
  }

  /**
   * Revokes every live (unrevoked, unexpired) agent token: at platform startup (`restart`: the key is new anyway) and at
   * every runner `ready` (`runner_restart`: a new runner process has a new MCP server; a token of the old one must not
   * reach it, F9). Returns how many rows it revoked.
   */
  revokeLiveAgentTokens(system: Principal, reason: 'restart' | 'runner_restart'): number {
    this.requireSystem(system);
    if (reason !== 'restart' && reason !== 'runner_restart') throw new PlatformError('invalid', 'unknown revoke reason');
    const now = this.deps.now();
    const count = immediateTx(this.db, () => {
      const n = this.db.prepare('UPDATE capability_tokens SET revoked_at = MAX(?, issued_at), revoke_reason = ? WHERE revoked_at IS NULL AND expires_at > ?')
        .run(now, reason, now).changes;
      if (n > 0) {
        appendActivityRow(this.db, { actorKind: 'system', actorId: system.id, entityType: 'capability_token', action: 'token.revoke',
          status: 'succeeded', details: { reason, count: n } }, now);
      }
      return n;
    });
    this.notifyRevoked(null);
    return count;
  }

  // ---------- helpers ----------

  private requireSystem(system: Principal): void {
    this.deps.auth.require(system, 'token.mint', PLATFORM, { entityType: 'capability_token' });
  }

  /** The stored claims of a jti, parsed once and cached (the claim columns are immutable by trigger). */
  private claimsOf(jti: string): CapabilityClaims | null {
    const cached = this.#claims.get(jti);
    if (cached) return cached;
    const r = this.db.prepare(`SELECT t.*, j.project_id, j.workspace_id, j.participation_id FROM capability_tokens t JOIN jobs j ON j.id = t.job_id
      WHERE t.jti = ?`).get(jti) as (TokenRow & { project_id: string; workspace_id: string; participation_id: string | null }) | undefined;
    if (!r) return null;
    const grant = JSON.parse(r.caps_json) as { caps: TokenCapability[]; maxChildJobs: number };
    const claims: CapabilityClaims = Object.freeze({
      jti: r.jti, sub: r.principal_id as `agent:${string}`, onBehalfOf: r.on_behalf_of as 'user:local', projectId: r.project_id,
      workspaceId: r.workspace_id, participationId: r.participation_id ?? '', jobId: r.job_id, sessionId: r.session_id,
      caps: grant.caps, inputs: JSON.parse(r.inputs_json) as string[], mcpTools: JSON.parse(r.tools_json) as string[],
      maxChildJobs: grant.maxChildJobs, iat: r.issued_at, exp: r.expires_at
    });
    this.#claims.set(jti, claims);
    return claims;
  }

  /** Each capability is in the domain's ceiling, once; its recipe and kind lists are subsets; its paths keep every ceiling exclusion. */
  private checkCaps(workspaceId: string, caps: unknown): TokenCapability[] {
    const ceiling = getDomain(workspaceId)?.capabilities ?? [];
    if (!Array.isArray(caps) || caps.length === 0 || caps.length > 64) throw new PlatformError('invalid', 'caps must be a non-empty list');
    const seen = new Set<string>();
    const out: TokenCapability[] = [];
    for (const raw of caps as unknown[]) {
      const c = raw as TokenCapability;
      if (!c || typeof c !== 'object' || !isStr(c.id)) throw new PlatformError('invalid', 'a capability names its id');
      const ceil = ceiling.find((x) => x.id === c.id);
      if (!ceil) throw new PlatformError('invalid', 'a capability is outside the domain ceiling', { capability: c.id });
      if (seen.has(c.id)) throw new PlatformError('invalid', 'a capability is listed twice', { capability: c.id });
      seen.add(c.id);
      const scope = c.scope === undefined ? ceil.scope : c.scope;
      const subset = (mine: readonly string[] | undefined, theirs: readonly string[] | undefined): boolean =>
        theirs === undefined ? mine === undefined : Array.isArray(mine) && mine.every((x) => typeof x === 'string' && theirs.includes(x));
      if (scope !== undefined && (typeof scope !== 'object' || scope === null)) throw new PlatformError('invalid', 'a capability scope is an object');
      if (!subset(scope?.recipes, ceil.scope?.recipes) || !subset(scope?.kinds, ceil.scope?.kinds)) {
        throw new PlatformError('invalid', 'a capability scope is wider than the ceiling', { capability: c.id });
      }
      if (ceil.scope?.paths !== undefined) {
        const mine = scope?.paths;
        const exclusions = ceil.scope.paths.filter((p) => p.startsWith('!'));
        if (!Array.isArray(mine) || mine.length === 0 || mine.some((p) => typeof p !== 'string' || p.length === 0 || p.length > 200)
          || !exclusions.every((x) => mine.includes(x))) {
          throw new PlatformError('invalid', 'a path scope keeps every exclusion of the ceiling', { capability: c.id });
        }
      } else if (scope?.paths !== undefined) {
        throw new PlatformError('invalid', 'a capability scope is wider than the ceiling', { capability: c.id });
      }
      const s: NonNullable<TokenCapability['scope']> = {};
      if (scope?.paths) s.paths = [...scope.paths];
      if (scope?.recipes) s.recipes = [...scope.recipes];
      if (scope?.kinds) s.kinds = [...scope.kinds];
      out.push(Object.keys(s).length > 0 ? { id: c.id, scope: s } : { id: c.id });
    }
    return out;
  }

  /** Each tool is an MCP tool, once, and its capability is granted. */
  private checkTools(tools: unknown, caps: TokenCapability[]): string[] {
    if (!Array.isArray(tools) || tools.length > MCP_TOOLS.length) throw new PlatformError('invalid', 'mcpTools must be a list of MCP tools');
    const out: string[] = [];
    for (const t of tools as unknown[]) {
      const def = MCP_TOOLS.find((d) => d.name === t);
      if (!def || out.includes(def.name)) throw new PlatformError('invalid', 'mcpTools names an unknown or repeated tool');
      if (!caps.some((c) => c.id === def.capability)) throw new PlatformError('invalid', 'a tool needs a capability the token does not grant', { tool: def.name });
      out.push(def.name);
    }
    return out;
  }

  /** Each input is a version of the project, once. */
  private checkInputs(projectId: string, inputs: unknown): string[] {
    if (!Array.isArray(inputs) || inputs.length > TOKEN_MAX_INPUTS) throw new PlatformError('invalid', `inputs must be a list of at most ${TOKEN_MAX_INPUTS} versions`);
    const out: string[] = [];
    const stmt = this.db.prepare('SELECT project_id FROM artifact_versions WHERE id = ?');
    for (const v of inputs as unknown[]) {
      if (!isStr(v) || v.length > 128 || out.includes(v)) throw new PlatformError('invalid', 'an input is a version id, once');
      const r = stmt.get(v) as { project_id: string } | undefined;
      if (!r || r.project_id !== projectId) throw new PlatformError('invalid', 'an input is a version of the turn\'s project');
      out.push(v);
    }
    return out;
  }
}
