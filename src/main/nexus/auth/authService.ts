/**
 * Authorization: principal -> scope -> authorize(action).
 *
 * - The principal is re-resolved from `principals` on every call. The caller's
 *   object only names an id; its kind must match the stored kind, otherwise the
 *   caller is treated as unknown. A caller cannot raise itself to 'system'.
 * - Roles come from `memberships` rows that match the scope:
 *     platform  -> the platform '*' row;
 *     workspace -> platform + that workspace's row;
 *     project   -> platform + that project's row (+ the workspace's row when the
 *                  scope names the workspace the project is acting in).
 *   An unrecognised scope matches nothing (fail closed).
 * - `authorize()` is a pure read. `require()` additionally audits a denial: one
 *   `denied` activity row, redacted, written in its OWN IMMEDIATE transaction
 *   (appendActivityRow opens one when no transaction is active), then throws
 *   PlatformError('denied'). Services call require() BEFORE opening their own
 *   transaction. If a denial happens while a transaction is open anyway, the row is
 *   not written into it (a rollback would lose it): it is queued and written once
 *   the transaction has ended (bounded retries, then a logged warning), and the
 *   error's detail says `audited: 'deferred'`.
 * - A workspace grant applies to a project scope only while the project has an
 *   ACTIVE project_workspaces row for that workspace.
 * - Agents (B2b) act only through a capability token: `decide()` keeps answering
 *   `agent_requires_token`, and `authorizeWithToken(claims, action, scope)` is the
 *   one agent path. It trusts only the token's jti: the grant (caps, tools, inputs,
 *   principal, job) is read back from the stored `capability_tokens` row, so a
 *   claims object widened in memory widens nothing. It is the intersection of
 *   - the token itself: known, not revoked, not expired, issued to the agent of its
 *     session (a stored, enabled `agent:<sessionId>` principal);
 *   - the action: one an agent may take at all (policy AGENT_ACTION_CAPABILITIES);
 *   - the job: still `running` or `awaiting_approval`, in the scope's project;
 *   - `decide()` for the user the token acts on behalf of, in the job's project and workspace;
 *   - the domain's ceiling and the token's own grant: the capability (from the tool
 *     when one is named), with every scope given (recipe, kind, code edit path) inside
 *     both, and a named version among the turn's inputs or its job's own outputs.
 *   Every refusal writes exactly one `auth.denied` activity row (actor kind 'agent',
 *   the requested action and the reason in its details); no row ever holds the token.
 */
import type Database from 'better-sqlite3';
import type {
  AuthDecision, PlatformAction, Principal, PrincipalId, PrincipalKind, Role, ScopeRef, TokenAuthDecision, TokenDenyReason, TokenScope
} from '../../../shared/nexus/platform';
import type { CapabilityClaims, TokenCapability } from '../../../shared/nexus/tokens';
import { AGENT_SUBJECT_RE } from '../../../shared/nexus/tokens';
import { MCP_TOOLS } from '../../../shared/nexus/mcpTools';
import { pathInScope } from '../../../shared/nexus/changeSet';
import { getDomain } from '../../../shared/nexus/domains/index';
import { PlatformError } from '../errors';
import { appendActivityRow, type NewActivity } from '../activity/writer';
import { AGENT_ACTION_CAPABILITIES, agentMayTake, decide, TOOL_ACTIONS } from './policy';
import { PrincipalResolver } from './principals';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Every id-like string written to a denial row is truncated to this many characters. */
export const MAX_AUDIT_ID_CHARS = 128;
/** A denial raised inside a caller's transaction is written later; this many attempts, then give up. */
export const DEFERRED_AUDIT_ATTEMPTS = 5;

/** What a denial row records besides the principal. Untrusted: auditDenial caps and fixes it. */
export interface DenialAudit {
  action: string; reason: string; scope?: ScopeRef; needed?: Role;
  projectId?: string | null; workspaceId?: string | null; artifactId?: string | null; versionId?: string | null;
  jobId?: string | null; sessionId?: string | null; onBehalfOf?: string | null; attemptN?: number | null;
  entityType?: string | null; entityId?: string | null; details?: unknown;
}

export class AuthService {
  private readonly principals: PrincipalResolver;
  private readonly log: (line: string) => void;

  constructor(private readonly db: Database.Database, private readonly deps: { now: () => number; log?: (line: string) => void }) {
    this.principals = new PrincipalResolver(db);
    this.log = deps.log ?? (() => {});
  }

  rolesFor(principalId: PrincipalId, scope: ScopeRef): Role[] {
    if (!isStr(principalId) || !scope || typeof scope !== 'object') return [];
    const clauses: string[] = ["(scope_type = 'platform' AND scope_id = '*')"];
    const args: string[] = [principalId];
    if (scope.type === 'platform') {
      // platform row only
    } else if (scope.type === 'workspace' && isStr(scope.workspaceId)) {
      clauses.push("(scope_type = 'workspace' AND scope_id = ?)"); args.push(scope.workspaceId);
    } else if (scope.type === 'project' && isStr(scope.projectId)) {
      clauses.push("(scope_type = 'project' AND scope_id = ?)"); args.push(scope.projectId);
      // A workspace grant reaches a project only while the project actively participates in that workspace.
      if (isStr(scope.workspaceId)) {
        clauses.push(`(scope_type = 'workspace' AND scope_id = ? AND EXISTS (SELECT 1 FROM project_workspaces pw
          WHERE pw.project_id = ? AND pw.workspace_id = ? AND pw.status = 'active'))`);
        args.push(scope.workspaceId, scope.projectId, scope.workspaceId);
      }
    } else {
      return [];
    }
    const rows = this.db.prepare(`SELECT role FROM memberships WHERE principal_id = ? AND (${clauses.join(' OR ')})`)
      .all(...args) as { role: Role }[];
    return rows.map((r) => r.role);
  }

  authorize(p: Principal, action: PlatformAction, scope: ScopeRef): AuthDecision {
    return this.evaluate(p, action, scope).decision;
  }

  private evaluate(p: Principal, action: PlatformAction, scope: ScopeRef) {
    const stored = isStr(p?.id) ? this.principals.get(p.id) : null;
    // The stored record is the identity; a mismatched kind is not that principal.
    const principal = stored && stored.kind === p.kind ? stored : null;
    const decision = decide({
      principal,
      disabled: principal ? principal.disabledAt !== null : false,
      roles: principal ? this.rolesFor(principal.id, scope) : [],
      action
    });
    return { decision, stored };
  }

  require(p: Principal, action: PlatformAction, scope: ScopeRef, audit?: Partial<NewActivity>): Role | 'system' {
    const { decision: d } = this.evaluate(p, action, scope);
    if (d.allowed) return d.role;
    const audited = this.auditDenial(p, {
      onBehalfOf: audit?.onBehalfOf, sessionId: audit?.sessionId, jobId: audit?.jobId, attemptN: audit?.attemptN,
      artifactId: audit?.artifactId, versionId: audit?.versionId, entityId: audit?.entityId, entityType: audit?.entityType,
      projectId: audit?.projectId, workspaceId: audit?.workspaceId, details: audit?.details,
      action, scope, reason: d.reason, needed: d.needed
    });
    throw new PlatformError('denied', `${String(action)} denied: ${d.reason}`, { reason: d.reason, needed: d.needed, audited });
  }

  // ---------- B2b: agents act only through a capability token ----------

  /**
   * The one authorization path for an agent (see the file header). `claims` comes from TokenService.verify; only its
   * jti (and the subject it names) is trusted, the grant is re-read from the stored row. Never throws; a refusal is
   * audited once (`auth.denied`) and returned.
   */
  authorizeWithToken(claims: CapabilityClaims, action: PlatformAction, scope: TokenScope): TokenAuthDecision {
    let r: ReturnType<AuthService['evaluateToken']>;
    try { r = this.evaluateToken(claims, action, scope); } catch {
      r = { allowed: false, reason: 'unknown', ctx: { sub: 'agent:unknown', jobId: null, sessionId: null, projectId: null, workspaceId: null, onBehalfOf: null } };
    }
    if (r.allowed) return { allowed: true };
    this.auditTokenDenial(r.reason, action, scope, r.ctx, r.detail);
    return { allowed: false, reason: r.reason };
  }

  /**
   * Records the one `auth.denied` row of a token that did not verify (malformed, bad signature, unknown, expired or
   * revoked). The caller passes what it trusts: for a token that failed its signature nothing in it is trusted, so the
   * actor is `agent:unknown`. Never receives or writes the token text.
   */
  auditTokenRefusal(code: TokenDenyReason, action: string, scope?: Partial<TokenScope>,
    known?: { sub?: string; jobId?: string; sessionId?: string; projectId?: string; workspaceId?: string } | null): boolean | 'deferred' {
    return this.auditTokenDenial(code, action, scope ?? {}, {
      sub: typeof known?.sub === 'string' && AGENT_SUBJECT_RE.test(known.sub) ? known.sub : 'agent:unknown', jobId: known?.jobId ?? null,
      sessionId: known?.sessionId ?? null, projectId: known?.projectId ?? null, workspaceId: known?.workspaceId ?? null, onBehalfOf: null
    });
  }

  /**
   * Verify, then authorize: what the MCP gateway runs for each call. A token that does not verify is refused with its
   * verification code (one audit row); one that does goes through `authorizeWithToken`. The raw token is only handed to
   * the verifier; it never reaches an audit row, a log or the result.
   */
  authorizeBearer(tokens: TokenVerifier, raw: unknown, action: PlatformAction, scope: TokenScope):
    { allowed: true; claims: CapabilityClaims } | { allowed: false; reason: TokenDenyReason } {
    const v = tokens.verify(raw, this.deps.now());
    if (!v.ok) {
      // Expired and revoked tokens passed their signature: their stored subject and job are known and may be recorded.
      const c = v.claims;
      this.auditTokenRefusal(v.code, action, scope, c ? { sub: c.sub, jobId: c.jobId, sessionId: c.sessionId, projectId: c.projectId,
        workspaceId: c.workspaceId } : null);
      return { allowed: false, reason: v.code };
    }
    const d = this.authorizeWithToken(v.claims, action, scope);
    return d.allowed ? { allowed: true, claims: v.claims } : d;
  }

  private evaluateToken(claims: CapabilityClaims, action: PlatformAction, scope: TokenScope):
    { allowed: true } | { allowed: false; reason: TokenDenyReason; ctx: TokenAuditContext; detail?: Record<string, unknown> } {
    const ctx: TokenAuditContext = { sub: 'agent:unknown', jobId: null, sessionId: null, projectId: null, workspaceId: null, onBehalfOf: null };
    const no = (reason: TokenDenyReason, detail?: Record<string, unknown>) => ({ allowed: false as const, reason, ctx, detail });
    const c = claims && typeof claims === 'object' ? claims : null;
    const sub = typeof c?.sub === 'string' ? c.sub : '';
    // The subject is the agent of the token's session, and it is a stored, enabled agent principal.
    if (!c || !AGENT_SUBJECT_RE.test(sub) || sub !== `agent:${String(c.sessionId)}`) return no('not_agent');
    const principal = this.principals.get(sub);
    if (!principal || principal.kind !== 'agent' || principal.disabledAt !== null) return no('not_agent');
    ctx.sub = sub;
    if (typeof c.jti !== 'string') return no('unknown');
    // The grant is the stored row's: a claims object widened in memory widens nothing.
    const row = this.db.prepare(`SELECT jti, job_id, session_id, principal_id, on_behalf_of, caps_json, inputs_json, tools_json,
        expires_at, revoked_at FROM capability_tokens WHERE jti = ?`).get(c.jti) as TokenRow | undefined;
    if (!row || row.principal_id !== sub || row.job_id !== c.jobId || row.session_id !== c.sessionId) return no('unknown');
    ctx.jobId = row.job_id; ctx.sessionId = row.session_id; ctx.onBehalfOf = row.on_behalf_of;
    const job = this.db.prepare('SELECT state, kind, project_id, workspace_id, session_id FROM jobs WHERE id = ?').get(row.job_id) as
      { state: string; kind: string; project_id: string; workspace_id: string; session_id: string | null } | undefined;
    if (job) { ctx.projectId = job.project_id; ctx.workspaceId = job.workspace_id; }
    if (row.revoked_at !== null) return no('revoked');
    if (row.expires_at <= this.deps.now()) return no('expired');
    if (!agentMayTake(action)) return no('agent_forbidden');
    if (!job || job.kind !== 'agent.run' || job.session_id !== row.session_id) return no('unknown');
    if (job.state !== 'running' && job.state !== 'awaiting_approval') return no('job_ended', { jobState: job.state });
    if (!scope || typeof scope !== 'object' || scope.projectId !== job.project_id) return no('out_of_scope', { field: 'projectId' });
    // decide() for the user the agent acts for, in the job's project and workspace.
    const user = this.evaluate({ id: row.on_behalf_of, kind: 'user', displayName: '' }, action,
      { type: 'project', projectId: job.project_id, workspaceId: job.workspace_id }).decision;
    if (!user.allowed) return no('user_denied', { userReason: user.reason });
    const grant = parseJsonSafe(row.caps_json) as { caps?: unknown } | null;
    const tokenCaps = Array.isArray(grant?.caps) ? (grant!.caps as TokenCapability[]) : [];
    const ceiling = getDomain(job.workspace_id)?.capabilities ?? [];
    // The capability: the tool's when the call names one (the tool must be granted, and authorized as its own action).
    let needed: readonly string[];
    if (scope.tool !== undefined) {
      const tools = parseJsonSafe(row.tools_json);
      const def = MCP_TOOLS.find((t) => t.name === scope.tool);
      if (!def || !Array.isArray(tools) || !tools.includes(scope.tool)) return no('tool_not_granted');
      if (TOOL_ACTIONS[def.name] !== action) return no('agent_forbidden');
      needed = [def.capability];
    } else {
      needed = AGENT_ACTION_CAPABILITIES[action] ?? [];
    }
    let reason: TokenDenyReason = 'ceiling';
    let covered = false;
    for (const id of needed) {
      const ceil = ceiling.find((x) => x.id === id);
      if (!ceil) continue;
      const tok = tokenCaps.find((x) => x && x.id === id);
      if (!tok) { if (reason === 'ceiling') reason = 'no_capability'; continue; }
      if (!withinScope(ceil, tok, scope)) { reason = 'out_of_scope'; continue; }
      covered = true;
      break;
    }
    if (!covered) return no(reason, reason === 'out_of_scope' ? { field: scopeField(scope) } : undefined);
    // A code edit path is inside the code edit scope of both the ceiling and the token.
    if (scope.path !== undefined) {
      const ceil = ceiling.find((x) => x.id === 'code.edit');
      const tok = tokenCaps.find((x) => x && x.id === 'code.edit');
      if (!ceil) return no('ceiling');
      if (!tok) return no('no_capability');
      if (typeof scope.path !== 'string' || !inPaths(scope.path, ceil.scope?.paths) || !inPaths(scope.path, tok.scope?.paths)) {
        return no('out_of_scope', { field: 'path' });
      }
    }
    // A named version: one of the turn's inputs, or an output of the turn's job or its child jobs, in its project.
    if (scope.versionId !== undefined) {
      const inputs = parseJsonSafe(row.inputs_json);
      const v = typeof scope.versionId === 'string' ? this.db.prepare('SELECT project_id, produced_by_job_id FROM artifact_versions WHERE id = ?')
        .get(scope.versionId) as { project_id: string; produced_by_job_id: string | null } | undefined : undefined;
      const own = !!v && v.produced_by_job_id !== null && (v.produced_by_job_id === row.job_id
        || this.db.prepare('SELECT 1 FROM jobs WHERE id = ? AND parent_job_id = ?').get(v.produced_by_job_id, row.job_id) !== undefined);
      const given = Array.isArray(inputs) && inputs.includes(scope.versionId);
      if (!v || v.project_id !== job.project_id || !(given || own)) return no('out_of_scope', { field: 'versionId' });
    }
    return { allowed: true };
  }

  private auditTokenDenial(reason: TokenDenyReason, action: string, scope: Partial<TokenScope>, ctx: TokenAuditContext,
    detail?: Record<string, unknown>): boolean | 'deferred' {
    const details: Record<string, unknown> = { requested: String(action ?? '').slice(0, MAX_AUDIT_ID_CHARS) };
    // Only a known tool name is recorded (never free text from the call).
    if (typeof scope?.tool === 'string' && MCP_TOOLS.some((t) => t.name === scope.tool)) details.tool = scope.tool;
    if (detail) for (const [k, v] of Object.entries(detail)) if (v !== undefined) details[k] = v;
    return this.auditDenial({ id: ctx.sub, kind: 'agent', displayName: '' }, {
      action: 'auth.denied', reason, entityType: 'auth', jobId: ctx.jobId, sessionId: ctx.sessionId, onBehalfOf: ctx.onBehalfOf,
      projectId: ctx.projectId ?? (typeof scope?.projectId === 'string' ? scope.projectId : null), workspaceId: ctx.workspaceId,
      versionId: typeof scope?.versionId === 'string' ? scope.versionId : null, details
    });
  }

  /**
   * Records one denied activity row for a principal. require() uses it, and so do
   * refusals decided outside authorize() (for example a job input that was not
   * granted). It never trusts its input:
   * - the actor is the STORED principal: a known id with a mismatched kind is
   *   recorded with its stored kind and id, and the claim goes in
   *   `details.claimedKind`. An unknown principal is recorded as 'agent' when it
   *   claims 'agent' and as 'user' otherwise (an unknown caller is never recorded
   *   as 'system'), with its id capped. Whenever the claimed kind differs from the
   *   recorded one, the claim goes in `details.claimedKind`;
   * - every id-like field, the action and the reason are capped at
   *   MAX_AUDIT_ID_CHARS (the claimed kind at 32), and `details.truncated` is true
   *   when any of them was shortened. A scope's project and workspace win over the
   *   explicit fields;
   * - `reason`, `needed`, `claimedKind` and `truncated` are fixed fields that caller
   *   details cannot override; status is always 'denied'.
   * The row is written now in its own IMMEDIATE transaction, or, when a transaction
   * is open, queued and written once it has ended, so a rollback cannot lose it.
   * Returns true (written), 'deferred' (queued) or false (the write failed). Never throws.
   */
  auditDenial(p: Principal, a: DenialAudit): boolean | 'deferred' {
    const stored = isStr(p?.id) ? this.principals.get(p.id) : null;
    let truncated = false;
    const cut = (v: string, max = MAX_AUDIT_ID_CHARS): string => { if (v.length > max) truncated = true; return v.slice(0, max); };
    const cap = (v: unknown): string | null => (isStr(v) ? cut(v) : null);
    const action = cut(String(a?.action ?? ''));
    const reason = cut(String(a?.reason ?? 'denied'));
    const extra = a?.details && typeof a.details === 'object' && !Array.isArray(a.details) ? a.details as Record<string, unknown> : {};
    const details: Record<string, unknown> = { ...extra, reason };
    delete details.claimedKind; delete details.truncated;
    if (a?.needed) details.needed = a.needed; else delete details.needed;
    // A known id is recorded with its STORED kind. An unknown id is recorded as 'agent' when it claims 'agent' and as
    // 'user' otherwise, so an unknown caller is never recorded as 'system'. A claim that differs goes alongside.
    const actorKind: PrincipalKind = stored !== null ? stored.kind : p?.kind === 'agent' ? 'agent' : 'user';
    if (p?.kind !== actorKind) details.claimedKind = typeof p?.kind === 'string' ? cut(p.kind, 32) : String(p?.kind);
    const scope = a?.scope;
    const row: NewActivity = {
      onBehalfOf: cap(a?.onBehalfOf), sessionId: cap(a?.sessionId), jobId: cap(a?.jobId),
      attemptN: typeof a?.attemptN === 'number' && Number.isInteger(a.attemptN) ? a.attemptN : null,
      artifactId: cap(a?.artifactId), versionId: cap(a?.versionId), entityId: cap(a?.entityId),
      entityType: cap(a?.entityType) ?? (action.split('.')[0] || 'platform').slice(0, MAX_AUDIT_ID_CHARS),
      workspaceId: cap((scope ? scopeWorkspace(scope) : null) ?? a?.workspaceId),
      projectId: cap((scope ? scopeProject(scope) : null) ?? a?.projectId),
      // Fixed fields last: the caller cannot rewrite who acted, what was asked, or the outcome.
      actorKind,
      actorId: stored !== null ? stored.id : cap(p?.id) ?? cut(String(p?.id ?? '')),
      action, status: 'denied', details
    };
    if (truncated) details.truncated = true;
    if (this.db.inTransaction) {
      // Writing now would put the row in the caller's transaction, which may roll back. Write it after.
      this.log(`[nexus] denial audit deferred until the open transaction ends: ${action} (${reason})`);
      const ts = this.deps.now();
      queueMicrotask(() => this.writeDeferred(row, ts, 1));
      return 'deferred';
    }
    try { appendActivityRow(this.db, row, this.deps.now()); return true; } catch { return false; }   // the denial stands either way
  }

  private writeDeferred(row: NewActivity, ts: number, attempt: number): void {
    if (this.db.inTransaction || !this.db.open) {
      if (attempt >= DEFERRED_AUDIT_ATTEMPTS || !this.db.open) {
        this.log(`[nexus] warning: denial audit dropped after ${attempt} attempt(s): ${row.action}`);
        return;
      }
      setTimeout(() => this.writeDeferred(row, ts, attempt + 1), 10 * attempt);
      return;
    }
    try { appendActivityRow(this.db, row, ts); } catch (e) {
      this.log(`[nexus] warning: deferred denial audit failed: ${row.action} (${(e as { code?: string })?.code ?? 'error'})`);
    }
  }
}

function scopeProject(s: ScopeRef): string | null {
  return s && s.type === 'project' && isStr(s.projectId) ? s.projectId : null;
}
function scopeWorkspace(s: ScopeRef): string | null {
  if (!s) return null;
  if (s.type === 'workspace' && isStr(s.workspaceId)) return s.workspaceId;
  if (s.type === 'project' && isStr(s.workspaceId)) return s.workspaceId;
  return null;
}

/** What `authorizeBearer` needs of the token service. */
export interface TokenVerifier {
  verify(raw: unknown, now: number): { ok: true; claims: CapabilityClaims } | { ok: false; code: TokenDenyReason; claims?: CapabilityClaims };
}

interface TokenRow {
  jti: string; job_id: string; session_id: string; principal_id: string; on_behalf_of: string;
  caps_json: string; inputs_json: string; tools_json: string; expires_at: number; revoked_at: number | null;
}
interface TokenAuditContext {
  sub: string; jobId: string | null; sessionId: string | null; projectId: string | null; workspaceId: string | null; onBehalfOf: string | null;
}

function parseJsonSafe(text: string | null | undefined): unknown {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** A path list scope: the path is inside it (pathInScope refuses unsafe and sensitive paths). No list: no path is. */
function inPaths(path: string, paths: readonly string[] | undefined): boolean {
  return Array.isArray(paths) && paths.length > 0 && pathInScope(path, paths);
}

/** The recipe and kind a call names are inside the scope lists of both the ceiling entry and the token's entry. */
function withinScope(ceil: TokenCapability, tok: TokenCapability, scope: TokenScope): boolean {
  const listed = (v: string, list: readonly string[] | undefined) => Array.isArray(list) && list.includes(v);
  if (scope.recipeId !== undefined && !(typeof scope.recipeId === 'string' && listed(scope.recipeId, ceil.scope?.recipes)
    && listed(scope.recipeId, tok.scope?.recipes))) return false;
  if (scope.kind !== undefined && !(typeof scope.kind === 'string' && listed(scope.kind, ceil.scope?.kinds) && listed(scope.kind, tok.scope?.kinds))) {
    return false;
  }
  return true;
}

function scopeField(scope: TokenScope): string | undefined {
  return scope.recipeId !== undefined ? 'recipeId' : scope.kind !== undefined ? 'kind' : undefined;
}

/** The display name of every agent principal (D-B9: no engine name outside the setup row). */
export const AGENT_DISPLAY_NAME = 'the agent';

/**
 * Inside the session-open transaction: the session's agent principal `agent:<sessionId>` (kind 'agent', no
 * membership: it acts only through a token, on behalf of the user). Idempotent; never changes an existing row.
 */
export function ensureAgentPrincipalTx(db: Database.Database, sessionId: string, now: number): string {
  if (!db.inTransaction) throw new PlatformError('platform_unavailable', 'ensureAgentPrincipalTx needs an open transaction');
  const id = `agent:${sessionId}`;
  if (!AGENT_SUBJECT_RE.test(id)) throw new PlatformError('invalid', 'a session id is a ULID');
  const r = db.prepare('SELECT kind FROM principals WHERE id = ?').get(id) as { kind: string } | undefined;
  if (r) {
    if (r.kind !== 'agent') throw new PlatformError('conflict', 'that principal id is taken by another kind');
    return id;
  }
  db.prepare("INSERT INTO principals (id, kind, display_name, disabled_at, created_at) VALUES (?, 'agent', ?, NULL, ?)").run(id, AGENT_DISPLAY_NAME, now);
  return id;
}
