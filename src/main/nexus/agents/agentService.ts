/**
 * Agent turns in main (B2b Task 10): sessions, the start and scheduling guards, the turn's plan, usage caps and settlement.
 *
 * Two faces:
 *
 * - The user's: `start`, `continueWith` (the `TurnStarter` of ReviewService), `end`, `cancel`, `list` and `get`. The actor
 *   is always a stored USER (the system, an agent and a token are refused); participation checks apply. `start` checks, in
 *   order: availability, the runtime's health from the CACHE (an injectable provider: Task 14 plugs the runner's probe in),
 *   the consent and budget guards (`startGuard`), the live consent's hash, and one turn per session. It opens or reuses
 *   the session and creates the `agent.run` job (priority 1; `params_json { message, skillId }`; the focus versions as
 *   `job_inputs` rows; `limits_json` from the consent caps). A turn never runs here: the execution core leases it.
 * - The execution core's (`AgentTurnPort`): the scheduler guards (`waiting:runtime`, `waiting:consent`, `waiting:budget`,
 *   `waiting:rate`, and `waiting:slots` while another turn runs), the async preparation (worktree, `context.md`,
 *   `skills.md`), the lease transaction's work (the token minted by `TokenService.mintTx`, the AgentPlan with the live
 *   consent's hosts and hash, the token's tools, the caps, the redacted `sandbox_json` / `environment_json`), the usage
 *   caps, the settlement of an exit and the revocation of the turn's tokens on every path that leaves its attempt.
 *
 * Rules that hold here and nowhere else:
 * - The credential is never read, copied or stored by Nexus: the plan names `runtime-owned`. The token appears only in the
 *   plan the core hands the runner over its MessagePort; it is in no row, event, log, view or error.
 * - `egress.consentHostsSha256` is the live consent row's recorded `hosts_sha256`, re-checked against the canonical hash of
 *   the same row's hosts; a mismatch refuses the start and fails a leased turn `consent_mismatch`. `egress.allow` is the
 *   consent's hosts, which came from the adapter's own `egressHosts`.
 * - A turn's end settles from evidence: `run.completed` with at least one registered version is `completed`; none is
 *   `partial` with outcome `no_change`; `run.failed` and an exit without a result fail it; the exit alone never completes it.
 * - Usage events only raise `usage_json` (monotonic). A cap reached (tokens, cost, the day's remaining budget, tool calls)
 *   ends the turn `failed: limit`.
 */
import { open as openFile } from 'node:fs/promises';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { AgentSession, AgentSessionStatus, Job, JobState, Principal } from '../../../shared/nexus/platform';
import type {
  AgentUsageView, SessionDetailView, SessionMessageView, SessionToolCallView, SessionTurnView, SessionView
} from '../../../shared/nexus/ipc';
import type { RuntimeEvent, RuntimeHealth } from '../../../shared/nexus/runtime';
import { isMonotonicUsage, turnLimitReached } from '../../../shared/nexus/agentPolicy';
import { MCP_TOOLS } from '../../../shared/nexus/mcpTools';
import { SKILLS } from '../../../shared/nexus/capabilities';
import { isAtOrBefore } from '../../../shared/nexus/domainSpec';
import { getDomain } from '../../../shared/nexus/domains/index';
import type { TokenCapability } from '../../../shared/nexus/tokens';
import type { SandboxProfileId } from '../../../shared/nexus/execution';
import { containsSecret, redactText } from '../activity/redact';
import { ensureAgentPrincipalTx, type AuthService } from '../auth/authService';
import { requireStoredUser, type PrincipalResolver } from '../auth/principals';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { agentEnvironmentRecord, agentSandboxRecord, buildAgentPlan } from '../exec/planBuilder';
import { agentTurnGuard, type AgentWaitReason } from '../exec/scheduler';
import { appendJobEventTx } from '../exec/events';
import type { AgentLease, AgentLeaseCtx, AgentPrepare, AgentPrepared, AgentSettlement, AgentTurnPort, ExecDataHome, ExecutionService } from '../exec/executionService';
import type { AttemptRow } from '../exec/attempts';
import { type JobService, type JobRow, requireActiveParticipation } from '../jobs/jobService';
import { ProjectAccess } from '../project/projectAccess';
import type { SessionService } from '../sessions/sessionService';
import type { WorktreeService } from '../repo/worktreeService';
import { hostsSha256, type BudgetService, type EgressHost, type LiveConsent } from './budgetService';
import type { ContextResolver } from './contextResolver';
import type { Skills } from './skills';
import type { TokenService } from './tokenService';
import { TOKEN_DEFAULT_TTL_MS } from './tokenService';

export const MAX_MESSAGE_CHARS = 8000;
export const MAX_FOCUS_VERSIONS = 20;
/** The turn a review that asked for changes starts says only this; the reviewer's comment reaches the agent through its context file. */
export const REVIEW_TURN_MESSAGE = 'Address the changes requested in the review of your change set.';
/** The capabilities a turn's token holds: the ones its MCP tools need, each as the domain ceiling lists it (never wider). */
export const TURN_GRANT: readonly string[] = Object.freeze(['code.read', 'code.edit', 'git.commit', 'sandbox.exec', 'artifact.read',
  'artifact.register', 'job.request', 'review.request', 'approval.request']);
const LIVE_STATES: readonly JobState[] = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];
const HOLDING_STATES: readonly JobState[] = ['leased', 'running', 'awaiting_approval'];
const LOG_READ_MAX_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 200;

/** What the cache knows of the one agent runtime (Task 14 fills it from the runner's probe). */
export interface RuntimeHealthEntry {
  kind: string;
  health: RuntimeHealth;
  /** The adapter's pinned flag set, hashed (recorded in `sandbox_json`); null when the cache does not know it. */
  flagsSha256?: string | null;
}
export type RuntimeHealthProvider = () => RuntimeHealthEntry | null;

export interface AgentServiceDeps {
  auth: AuthService;
  principals: PrincipalResolver;
  jobs: JobService;
  sessions: SessionService;
  tokens: TokenService;
  budget: BudgetService;
  contextResolver: ContextResolver;
  skills: Skills;
  worktrees: WorktreeService;
  exec: ExecutionService;
  system: Principal;
  now: () => number;
  log?: (line: string) => void;
  /** The cached health of the agent runtime; default: unknown (a turn then waits `waiting:runtime`, and `start` refuses). */
  runtimeHealth?: RuntimeHealthProvider;
  dataHome: ExecDataHome | null;
  /** Called after a turn was queued: the scheduler's next tick leases it. */
  onQueued?: () => void;
}

export interface StartInput {
  projectId: string; workspaceId: string; sessionId: string | null; skillId?: string;
  focusVersionIds: string[]; message: string; intentId: string;
}

interface SessionRow {
  id: string; project_id: string; workspace_id: string; participation_id: string; principal_id: string; status: AgentSessionStatus;
  context_version_id: string | null; created_at: number; updated_at: number;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parseJson = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };
const refuse = (code: 'unavailable' | 'conflict' | 'invalid', message: string, reason: string): never => { throw new PlatformError(code, message, { reason }); };

/** The sentences a runtime problem is told in (never a raw code to a person; the reason is the machine-readable part). */
const RUNTIME_PROBLEMS: Record<string, string> = {
  runtime_unknown: 'the agent runtime has not been checked yet',
  runtime_not_installed: 'the agent runtime is not installed',
  runtime_not_authenticated: 'the agent runtime is not signed in',
  runtime_version_unsupported: 'the installed agent runtime is not a supported version',
  runtime_error: 'the agent runtime could not be checked',
  runtime_mismatch: 'the agent runtime is not the one that was given permission'
};

export class AgentService implements AgentTurnPort {
  private readonly access: ProjectAccess;
  private readonly log: (line: string) => void;
  private readonly runtimeHealth: RuntimeHealthProvider;

  constructor(private readonly db: Database.Database, private readonly deps: AgentServiceDeps) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
    this.log = deps.log ?? (() => {});
    this.runtimeHealth = deps.runtimeHealth ?? (() => null);
  }

  // ======================================================================================================
  // The user's methods
  // ======================================================================================================

  /** Starts a turn (see the module header). Idempotent by `intentId`: a re-sent intent answers the same session and job. */
  start(user: Principal, i: StartInput): { session: AgentSession; job: Job } {
    requireStoredUser(this.deps.principals, this.deps.auth, user, 'agent.start', 'agent_session', 'only you can start an agent turn');
    if (!isObj(i)) throw new PlatformError('invalid', 'input must be an object');
    if (!isStr(i.projectId) || !isStr(i.workspaceId)) throw new PlatformError('invalid', 'projectId and workspaceId are required');
    const pw = requireActiveParticipation(this.access, this.db, user, i.projectId, i.workspaceId, 'agent.start');
    const intent = typeof i.intentId === 'string' && i.intentId.length >= 1 && i.intentId.length <= 128 ? i.intentId : refuse('invalid', 'intentId is required', 'intent_required');
    const message = this.checkMessage(i.message);
    const focus = this.checkFocus(user, pw.project_id, i.focusVersionIds);
    const skillId = this.checkSkill(pw.workspace_id, i.skillId);
    const sessionId = i.sessionId === null || i.sessionId === undefined ? null : isStr(i.sessionId) ? i.sessionId : refuse('invalid', 'sessionId must be an id', 'bad_session');
    // A re-sent intent answers what it made (before any guard: the turn already exists).
    const prior = this.db.prepare('SELECT id, session_id FROM jobs WHERE idempotency_key = ?').get(`agent.turn:${intent}`) as { id: string; session_id: string } | undefined;
    if (prior) return { session: this.deps.sessions.get(user, prior.session_id), job: this.deps.jobs.get(user, prior.id) };

    // 1. Availability, 2. the runtime's cached health, 3. consent and budget.
    this.requireAvailable();
    const consent = this.requireReady(pw.project_id);
    // 4. One turn per session; an interrupted session's worktree is continued by a new session.
    let reuseFrom: string | null = null;
    let session: SessionRow | null = null;
    if (sessionId !== null) {
      session = this.sessionRow(sessionId);
      if (!session) { this.deps.auth.require(user, 'session.read', { type: 'platform' }); throw new PlatformError('not_found', 'session not found'); }
      if (session.project_id !== pw.project_id || session.workspace_id !== pw.workspace_id || session.participation_id !== pw.id) {
        throw new PlatformError('invalid', 'the session belongs to another project or workspace');
      }
      this.access.require(user, session.project_id, 'agent.start', { workspaceId: pw.workspace_id });
      if (session.status === 'interrupted') { reuseFrom = session.id; session = null; }
      else if (['completed', 'failed', 'cancelled', 'timed_out'].includes(session.status)) refuse('conflict', 'that conversation has ended; start a new one', 'session_ended');
      else if (this.liveTurnOf(session.id)) refuse('conflict', 'the agent is still working on the last message', 'turn_running');
    }
    return this.createTurn(user, { pw, session, reuseFrom, intent, message, skillId, focus, runtimeKind: consent.runtimeKind, inputs: focus.map((versionId) => ({ versionId, role: 'focus' })) });
  }

  /**
   * `TurnStarter` (ReviewService): continues the session of a change set whose review asked for changes. It runs INSIDE the
   * review's transaction, so it never awaits and writes nothing outside it; a refusal rolls the review back with it. The
   * reviewing user is the turn's requester; the reviewed version is the turn's `review` input and the review's id is in
   * its params. Idempotent per review id.
   */
  continueWith(user: Principal, sessionId: string, reviewId: string): { job: { id: string } } {
    const stored = user && typeof user.id === 'string' ? this.deps.principals.get(user.id) : null;
    if (!stored || stored.kind !== 'user' || user.kind !== 'user' || stored.disabledAt !== null) {
      throw new PlatformError('denied', 'a turn is continued by a user', { reason: 'user_only' });
    }
    if (!isStr(sessionId) || !isStr(reviewId)) throw new PlatformError('invalid', 'a session and a review are required');
    const review = this.db.prepare('SELECT id, version_id, principal_id, decision FROM reviews WHERE id = ?').get(reviewId) as
      { id: string; version_id: string; principal_id: string; decision: string } | undefined;
    if (!review || review.decision !== 'request_changes' || review.principal_id !== user.id) {
      throw new PlatformError('invalid', 'the review did not ask for changes', { reason: 'bad_review' });
    }
    const key = `agent.review:${review.id}`;
    const prior = this.db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(key) as { id: string } | undefined;
    if (prior) return { job: { id: prior.id } };
    this.requireAvailable();
    const old = this.sessionRow(sessionId);
    if (!old) throw new PlatformError('not_found', 'session not found');
    const pw = this.db.prepare('SELECT id, project_id, workspace_id, status FROM project_workspaces WHERE id = ?').get(old.participation_id) as
      { id: string; project_id: string; workspace_id: string; status: string } | undefined;
    if (!pw || pw.status !== 'active') throw new PlatformError('participation_inactive', 'the participation is no longer active');
    const consent = this.requireReady(pw.project_id);
    let session: SessionRow | null = old;
    let reuseFrom: string | null = null;
    if (['interrupted', 'completed', 'failed', 'cancelled', 'timed_out'].includes(old.status)) {
      // The conversation ended: the change continues in a new session (on the same worktree when it was interrupted).
      session = null;
      if (old.status === 'interrupted') reuseFrom = old.id;
    } else if (this.liveTurnOf(old.id)) refuse('conflict', 'the agent is still working on the last message', 'turn_running');
    const { job } = this.createTurn(user, { pw, session, reuseFrom, intent: `review:${review.id}`, key, message: REVIEW_TURN_MESSAGE, skillId: null, focus: [],
      runtimeKind: consent.runtimeKind, inputs: [{ versionId: review.version_id, role: 'review' }], params: { reviewId: review.id } });
    return { job: { id: job.id } };
  }

  /** Cancels the session's live turn (children first, its attempt, its container, its token). The conversation stays open. */
  cancel(user: Principal, sessionId: string): Job {
    requireStoredUser(this.deps.principals, this.deps.auth, user, 'job.cancel', 'agent_session', 'only you can cancel an agent turn');
    const s = this.sessionRow(sessionId);
    if (!s) { this.deps.auth.require(user, 'job.cancel', { type: 'platform' }); throw new PlatformError('not_found', 'session not found'); }
    const live = this.liveTurnOf(s.id);
    if (!live) { this.access.require(user, s.project_id, 'job.cancel', { workspaceId: this.workspaceOf(s) }); refuse('conflict', 'no turn is running', 'no_turn'); }
    this.deps.exec.cancel(user, live!.id);
    return this.deps.jobs.get(user, live!.id);
  }

  /** Ends the conversation: a live turn is cancelled first; the session is then completed (or cancelled when no turn ever ran). */
  end(user: Principal, sessionId: string): AgentSession {
    requireStoredUser(this.deps.principals, this.deps.auth, user, 'session.cancel', 'agent_session', 'only you can end an agent conversation');
    const s = this.sessionRow(sessionId);
    if (!s) { this.deps.auth.require(user, 'session.cancel', { type: 'platform' }); throw new PlatformError('not_found', 'session not found'); }
    this.access.require(user, s.project_id, 'session.cancel', { workspaceId: this.workspaceOf(s) });
    if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(s.status)) return this.deps.sessions.get(user, s.id);
    const live = this.liveTurnOf(s.id);
    if (live) this.deps.exec.cancel(user, live.id);
    const cur = this.sessionRow(s.id)!;
    if (cur.status === 'running') return this.deps.sessions.transition(this.deps.system, s.id, 'completed');
    return this.deps.sessions.cancel(user, s.id);
  }

  /** The project's agent conversations, newest first. */
  list(user: Principal, projectId: string, o?: { limit?: number }): SessionView[] {
    const sessions = this.deps.sessions.listByProject(user, projectId, { limit: o?.limit });
    const out: SessionView[] = [];
    for (const s of sessions) {
      const turns = (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE session_id = ? AND kind = 'agent.run'").get(s.id) as { n: number }).n;
      if (turns === 0) continue;
      out.push(this.viewOf(s, turns));
    }
    return out;
  }

  /** One conversation: its turns, its display-only messages (from the redacted log frames), tool calls, versions and approvals. */
  async get(user: Principal, sessionId: string): Promise<SessionDetailView> {
    const s = this.deps.sessions.get(user, sessionId);
    const jobs = (this.db.prepare("SELECT * FROM jobs WHERE session_id = ? AND kind = 'agent.run' ORDER BY created_at, rowid").all(s.id) as JobRow[]);
    const turnHistory: SessionTurnView[] = [];
    const messages: SessionMessageView[] = [];
    const toolCalls: SessionToolCallView[] = [];
    let seq = 0;
    for (const j of jobs) {
      const d = this.deps.exec.get(user, j.id);
      const latest = this.db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1').get(j.id) as AttemptRow | undefined;
      turnHistory.push({ jobId: j.id, state: d.state, headline: d.headline, outcome: d.outcome, error: d.error, usage: usageViewOf(latest?.usage_json ?? null),
        createdAt: d.createdAt, startedAt: d.startedAt, finishedAt: d.finishedAt });
      const params = parseJson(j.params_json);
      if (isObj(params) && typeof params.message === 'string') messages.push({ seq: ++seq, ts: j.created_at, from: 'user', text: params.message, displayOnly: true });
      for (const a of this.db.prepare('SELECT n, log_path FROM job_attempts WHERE job_id = ? ORDER BY n').all(j.id) as { n: number; log_path: string | null }[]) {
        for (const f of await this.logMessages(a.log_path)) messages.push({ seq: ++seq, ts: f.ts, from: 'agent', text: f.text, displayOnly: true });
      }
      for (const e of this.db.prepare(`SELECT seq, ts, data_json FROM job_events WHERE job_id = ? AND type = 'attempt.progress' ORDER BY seq`).all(j.id) as
        { seq: number; ts: number; data_json: string }[]) {
        const data = parseJson(e.data_json);
        if (isObj(data) && (data.t === 'tool' || data.t === 'runtime.tool') && typeof data.tool === 'string') {
          toolCalls.push({ seq: e.seq, ts: e.ts, jobId: j.id, tool: data.tool, ok: typeof data.ok === 'boolean' ? data.ok : null, resultBytes: null });
        }
      }
    }
    const versions: SessionDetailView['versions'] = [];
    for (const j of jobs) for (const v of this.registeredVersions(j.id)) if (!versions.some((x) => x.versionId === v.versionId)) versions.push(v);
    const approvals = (this.db.prepare(`SELECT id, status, reason, expires_at FROM approvals WHERE session_id = ?
        OR job_id IN (SELECT id FROM jobs WHERE session_id = ?) ORDER BY requested_at`).all(s.id, s.id) as
      { id: string; status: string; reason: string; expires_at: number }[]).map((a) => ({ id: a.id, status: a.status as SessionDetailView['approvals'][number]['status'],
      reason: a.reason, expiresAt: a.expires_at }));
    const live = jobs.find((j) => (LIVE_STATES as readonly string[]).includes(j.state));
    return { ...this.viewOf(s, jobs.length), liveJobId: live?.id ?? null, turnHistory, messages, toolCalls, versions, approvals };
  }

  // ======================================================================================================
  // Starting a turn
  // ======================================================================================================

  private checkMessage(m: unknown): string {
    if (typeof m !== 'string' || m.trim().length === 0) return refuse('invalid', 'a message is required', 'message_required');
    if (m.length > MAX_MESSAGE_CHARS) return refuse('invalid', `a message is at most ${MAX_MESSAGE_CHARS} characters`, 'message_too_long');
    if (containsSecret(m)) return refuse('invalid', 'the message holds a secret-shaped value; nothing was started', 'secret_in_message');
    return m;
  }

  private checkFocus(user: Principal, projectId: string, raw: unknown): string[] {
    const list = raw === undefined ? [] : raw;
    if (!Array.isArray(list) || list.length > MAX_FOCUS_VERSIONS) return refuse('invalid', `at most ${MAX_FOCUS_VERSIONS} focus versions`, 'too_many_focus');
    const seen = new Set<string>();
    for (const v of list) {
      if (!isStr(v) || v.length > 128 || seen.has(v)) return refuse('invalid', 'a focus version is an id, once', 'bad_focus');
      seen.add(v);
      // Readable by the caller in its owner's workspace ('denied', audited), before anything is written.
      this.access.requireVersionReadable(user, v, projectId, 'focus');
    }
    return [...seen];
  }

  private checkSkill(workspaceId: string, skillId: unknown): string | null {
    if (skillId === undefined || skillId === null) return null;
    const def = typeof skillId === 'string' ? SKILLS.find((s) => s.id === skillId) : undefined;
    if (!def || def.domain !== workspaceId || !isAtOrBefore(def.availableFrom)) return refuse('invalid', 'unknown skill', 'unknown_skill');
    return def.id;
  }

  /** Whether agents are available at all (the services are composed only then; execution must be on as well). */
  private requireAvailable(): void {
    if (!this.deps.exec.available) refuse('unavailable', 'agent turns are not available', 'agents_unavailable');
  }

  /**
   * The runtime's cached health, then the consent and budget guards, then the live consent's hash. Returns the live
   * consent. `busy` is not a refusal here (another conversation's turn runs; this one waits `waiting:slots`).
   */
  private requireReady(projectId: string): LiveConsent {
    const p = this.runtimeProblem(null);
    if (p !== null) refuse('unavailable', RUNTIME_PROBLEMS[p] ?? 'the agent runtime is not ready', p);
    const g = this.deps.budget.startGuard(projectId);
    if (!g.ok && g.reason !== 'busy') {
      const text = g.reason === 'consent_missing' ? 'the agent has not been given permission yet'
        : g.reason === 'budget_exhausted' ? 'the agent has used its budget for today' : 'the agent has started too many turns this hour';
      refuse('unavailable', text, g.reason);
    }
    const consent = this.deps.budget.live();
    if (!consent) return refuse('unavailable', 'the agent has not been given permission yet', 'consent_missing');
    const p2 = this.runtimeProblem(consent.runtimeKind);
    if (p2 !== null) refuse('unavailable', RUNTIME_PROBLEMS[p2] ?? 'the agent runtime is not ready', p2);
    this.consentHostsOrThrow(consent);
    return consent;
  }

  /** Why the cached runtime health says no (a reason word), or null. `kind`: the consent's runtime, when known. */
  private runtimeProblem(kind: string | null): string | null {
    let h: RuntimeHealthEntry | null = null;
    try { h = this.runtimeHealth(); } catch { h = null; }
    if (!h) return 'runtime_unknown';
    if (!h.health.ok) return `runtime_${h.health.reason}`;
    if (kind !== null && h.kind !== kind) return 'runtime_mismatch';
    return null;
  }

  /** The live consent's hosts as `{host, port}`, after checking its recorded hash against the canonical hash of those hosts. */
  private consentHostsOrThrow(c: LiveConsent): EgressHost[] {
    const hosts: EgressHost[] = [];
    for (const h of c.hosts) {
      const m = /^(.+):(\d{1,5})$/.exec(h);
      if (!m) return refuse('conflict', 'the permission on record is damaged', 'consent_mismatch');
      hosts.push({ host: m[1], port: Number(m[2]) });
    }
    let canonical = '';
    try { canonical = hostsSha256(hosts); } catch { canonical = ''; }
    if (canonical === '' || canonical !== c.hostsSha256) refuse('conflict', 'the permission on record does not match its hosts; nothing was started', 'consent_mismatch');
    return hosts;
  }

  /** Opens or reuses the session and creates the turn's job, in one transaction (a savepoint of the caller's, inside a review). */
  private createTurn(user: Principal, o: {
    pw: { id: string; project_id: string; workspace_id: string }; session: SessionRow | null; reuseFrom: string | null; intent: string; key?: string;
    message: string; skillId: string | null; focus: string[]; runtimeKind: string; inputs: { versionId: string; role: string }[]; params?: Record<string, unknown>;
  }): { session: AgentSession; job: Job } {
    const now = this.deps.now();
    const caps = this.deps.budget.caps();
    const key = o.key ?? `agent.turn:${o.intent}`;
    const created = immediateTx(this.db, (): { sessionId: string; jobId: string } => {
      let sessionId = o.session?.id ?? null;
      if (sessionId === null) {
        const opened = this.deps.sessions.open(user, { projectId: o.pw.project_id, workspaceId: o.pw.workspace_id, idempotencyKey: `agent.session:${o.intent}`,
          runtime: { kind: o.runtimeKind } });
        sessionId = opened.session.id;
        ensureAgentPrincipalTx(this.db, sessionId, now);
      }
      const params: Record<string, unknown> = { message: o.message, ...(o.skillId ? { skillId: o.skillId } : {}), ...(o.reuseFrom ? { reuseFrom: o.reuseFrom } : {}), ...(o.params ?? {}) };
      const res = this.deps.jobs.createTx(user, { kind: 'agent.run', projectId: o.pw.project_id, workspaceId: o.pw.workspace_id, sessionId, idempotencyKey: key,
        priority: 1, params, inputs: o.inputs });
      if (res.created) {
        const limits = { cpus: 1, memoryMb: 1024, pids: 512, wallClockMs: caps.wallClockMs, tmpfsMb: 512, turnTokens: caps.turnTokens, turnUsdCents: caps.turnUsdCents,
          toolCalls: caps.toolCalls };
        this.db.prepare('UPDATE jobs SET limits_json = ?, phase = NULL WHERE id = ?').run(JSON.stringify(limits), res.job.id);
        appendJobEventTx(this.db, { type: 'job.transition', summary: 'job queued: an agent turn', projectId: o.pw.project_id, jobId: res.job.id,
          data: { from: null, to: 'queued', kind: 'agent.run' } }, now);
      }
      return { sessionId, jobId: res.job.id };
    });
    this.deps.onQueued?.();
    if (this.db.inTransaction) {
      // Inside the review's transaction: no authorization read may be audited later; the rows are what the caller needs.
      return { session: this.sessionAsAgentSession(created.sessionId), job: this.deps.jobs.toJob(this.deps.jobs.row(created.jobId)!) };
    }
    return { session: this.deps.sessions.get(user, created.sessionId), job: this.deps.jobs.get(user, created.jobId) };
  }

  // ======================================================================================================
  // The execution core's port
  // ======================================================================================================

  /** A turn of a session that has ended can never run. */
  sessionEnded(j: JobRow): boolean {
    const s = j.session_id ? this.sessionRow(j.session_id) : null;
    return !s || ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(s.status);
  }

  /** The scheduler's guard for a queued turn (see `agentTurnGuard`): policy first, then the container guards. */
  guard(j: JobRow, i: { runnerReady: boolean; profile: SandboxProfileId | null; probe: Parameters<typeof agentTurnGuard>[2]; live: Parameters<typeof agentTurnGuard>[3];
    caps: Parameters<typeof agentTurnGuard>[4]; preparing: number }): AgentWaitReason | null {
    const consent = this.deps.budget.live();
    const runtimeOk = this.runtimeProblem(consent ? consent.runtimeKind : null) === null;
    let guard: 'ok' | 'consent_missing' | 'budget_exhausted' | 'rate_limited' = 'ok';
    try {
      const g = this.deps.budget.startGuard(j.project_id, { excludeJobId: j.id });
      if (!g.ok && g.reason !== 'busy') guard = g.reason;
    } catch { guard = 'consent_missing'; }
    // A damaged consent record never lets a turn start (it would fail `consent_mismatch` at lease anyway).
    if (consent && guard === 'ok') {
      try { this.consentHostsOrThrow(consent); } catch { guard = 'consent_missing'; }
    }
    const holding = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'agent.run' AND id <> ? AND state IN (${HOLDING_STATES.map(() => '?').join(', ')})`)
      .get(j.id, ...HOLDING_STATES) as { n: number }).n;
    return agentTurnGuard({ runnerReady: i.runnerReady, runtimeOk, guard, liveTurns: holding + i.preparing, concurrentTurns: this.deps.budget.caps().concurrentTurns },
      i.profile, i.probe, i.live, i.caps);
  }

  /** The part of the lease that waits on files and on the worktree: the worktree, the context file and the skills. */
  async prepare(j: JobRow): Promise<AgentPrepare> {
    const sys = this.deps.system;
    if (!j.session_id) return { failed: { code: 'session_missing', message: 'the turn has no session' } };
    const params = parseJson(j.params_json);
    const reuseFrom = isObj(params) && typeof params.reuseFrom === 'string' && params.reuseFrom.length > 0 ? params.reuseFrom : null;
    const ensured = this.deps.worktrees.ensure(sys, j.session_id, j.id, reuseFrom ? { reuseFrom } : undefined);
    if ('waiting' in ensured) return { wait: ensured.waiting === 'approval' ? 'waiting:approval' : 'waiting:worktree' };
    if ('failed' in ensured) return { failed: { code: ensured.failed.slice(0, 32), message: `the agent's working copy could not be prepared (${ensured.failed})`.slice(0, 200) } };
    const relPath = `wt/${path.basename(ensured.ready.path)}`;
    const ctx = await this.deps.contextResolver.resolve({ id: j.id, projectId: j.project_id, workspaceId: j.workspace_id, sessionId: j.session_id });
    const domain = getDomain(j.workspace_id);
    const wanted = isObj(params) && typeof params.skillId === 'string' ? [params.skillId] : domain && domain.skills.length > 0 ? [domain.skills[0]] : [];
    let skills: AgentPrepared['skills'] = [];
    try {
      skills = (await this.deps.skills.write({ id: j.id, workspaceId: j.workspace_id }, wanted)).map((s) => ({ id: s.id, version: s.version, sha256: s.sha256 }));
    } catch (e) {
      // No skills folder (a build without its resources): the turn runs with its context alone; the skill is a hint, never a grant.
      this.log(`[nexus] agents: no skills written for a turn (${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'})`);
    }
    return { ready: { worktree: { relPath, gitDir: ensured.ready.gitDir, ref: ensured.ready.ref, base: ensured.ready.base }, contextSha256: ctx.sha256, skills } };
  }

  /** Inside the lease transaction: the token is minted, the plan built, the records redacted. */
  planTx(j: JobRow, attempt: { id: string; n: number }, p: AgentPrepared, c: AgentLeaseCtx): AgentLease {
    const consent = this.deps.budget.live();
    if (!consent) return { failed: { code: 'consent_missing', message: 'the agent has not been given permission' } };
    let hosts: EgressHost[];
    try { hosts = this.consentHostsOrThrow(consent); } catch { return { failed: { code: 'consent_mismatch', message: 'the permission on record does not match its hosts' } }; }
    if (!j.session_id) return { failed: { code: 'session_missing', message: 'the turn has no session' } };
    const health = (() => { try { return this.runtimeHealth(); } catch { return null; } })();
    const domain = getDomain(j.workspace_id);
    const ceiling = domain?.capabilities ?? [];
    const caps: TokenCapability[] = TURN_GRANT.map((id) => ceiling.find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x)
      .map((x) => (x.scope ? { id: x.id, scope: Object.fromEntries(Object.entries(x.scope).filter(([k]) => k !== 'note')) } : { id: x.id }) as TokenCapability);
    const mcpTools = MCP_TOOLS.filter((t) => caps.some((x) => x.id === t.capability)).map((t) => t.name);
    const dayRemaining = this.deps.budget.dayRemainingCents();
    if (dayRemaining <= 0) return { failed: { code: 'budget_exhausted', message: 'the agent has used its budget for today' } };
    const token = this.deps.tokens.mintTx(this.deps.system, { jobId: j.id, sessionId: j.session_id, caps, inputs: this.tokenInputs(j), mcpTools,
      maxChildJobs: consent.caps.childJobs, ttlMs: Math.min(TOKEN_DEFAULT_TTL_MS, consent.caps.wallClockMs + 5 * 60_000) });
    const plan = buildAgentPlan({
      job: { id: j.id, projectId: j.project_id }, attempt, bootId: c.bootId, dataHomeRoot: c.dataHomeRoot, workRel: c.workRel, logRel: c.logRel,
      profile: c.profile, imageId: c.imageId, worktree: p.worktree,
      runtime: { kind: consent.runtimeKind, token, sessionId: j.session_id, idempotencyKey: `${j.id}:${attempt.n}`, domainId: j.workspace_id,
        skills: p.skills, context: { hash: p.contextSha256 }, message: this.messageOf(j), mcpUrl: c.mcpUrl, model: { provider: 'runtime-owned', model: 'default' } },
      egress: { allow: hosts, consentHostsSha256: consent.hostsSha256 },
      caps: { turnTokens: consent.caps.turnTokens, turnUsdCents: consent.caps.turnUsdCents, dayRemainingUsdCents: dayRemaining, toolCalls: consent.caps.toolCalls },
      wallClockMs: consent.caps.wallClockMs, mcpTools
    });
    const adapterVersion = health && health.health.ok ? health.health.version : null;
    return {
      plan,
      sandbox: agentSandboxRecord(plan, { adapterVersion, flagsSha256: health?.flagsSha256 ?? null }),
      environment: agentEnvironmentRecord(plan, { runtimeVersion: adapterVersion, nexusVersion: c.nexusVersion, dockerVersion: c.dockerVersion, runnerBootId: c.bootId })
    };
  }

  /** The versions the token names as its inputs: the turn's focus (and review) versions, the session's context, the repository. */
  private tokenInputs(j: JobRow): string[] {
    const out: string[] = [];
    const add = (id: string | null | undefined): void => { if (typeof id === 'string' && id.length > 0 && !out.includes(id)) out.push(id); };
    for (const r of this.db.prepare('SELECT version_id FROM job_inputs WHERE job_id = ? ORDER BY rowid').all(j.id) as { version_id: string }[]) add(r.version_id);
    const ctx = j.session_id ? this.db.prepare('SELECT context_version_id FROM agent_sessions WHERE id = ?').get(j.session_id) as { context_version_id: string | null } | undefined : undefined;
    add(ctx?.context_version_id);
    const repo = this.db.prepare(`SELECT v.id FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id WHERE a.project_id = ? AND a.kind = 'repository'
      AND a.status = 'active' AND v.status IN ('candidate','active') ORDER BY (v.id = a.current_version_id) DESC, v.version_no DESC LIMIT 1`).get(j.project_id) as { id: string } | undefined;
    add(repo?.id);
    return out.slice(0, 64);
  }

  /** The turn's message, from its own params (never logged, never in a record). */
  private messageOf(j: JobRow): string {
    const params = parseJson(j.params_json);
    return isObj(params) && typeof params.message === 'string' ? params.message : '';
  }

  /** Inside the provisioned transaction: the session of the turn runs. */
  provisionedTx(j: JobRow, now: number): void {
    void now;
    if (!j.session_id) return;
    const s = this.sessionRow(j.session_id);
    if (s && s.status === 'open') this.deps.sessions.transition(this.deps.system, s.id, 'running');
  }

  /** Usage is recorded monotonically; a cap reached answers `limit`. Tool starts are recorded by name only. */
  runtimeEvent(a: AttemptRow, j: JobRow, ev: RuntimeEvent, now: number): { limit: string | null } {
    switch (ev.t) {
      case 'run.started': {
        const ref = typeof ev.runRef === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(ev.runRef) ? ev.runRef : null;
        immediateTx(this.db, () => {
          if (ref !== null) this.db.prepare("UPDATE job_attempts SET runtime_ref = ? WHERE id = ? AND state = 'running'").run(ref, a.id);
          appendJobEventTx(this.db, { type: 'attempt.progress', summary: `attempt ${a.n}: the agent started`, projectId: j.project_id, jobId: j.id, attemptN: a.n,
            data: { t: 'runtime.started' } }, now);
        });
        return { limit: null };
      }
      case 'tool.started': {
        const tool = typeof ev.tool === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(ev.tool) ? ev.tool : 'tool';
        immediateTx(this.db, () => appendJobEventTx(this.db, { type: 'attempt.progress', summary: `attempt ${a.n}: the agent used ${tool}`.slice(0, 200),
          projectId: j.project_id, jobId: j.id, attemptN: a.n, data: { t: 'runtime.tool', tool } }, now));
        return { limit: null };
      }
      case 'usage': return this.usage(a, ev);
      default: return { limit: null };
    }
  }

  private usage(a: AttemptRow, ev: Extract<RuntimeEvent, { t: 'usage' }>): { limit: string | null } {
    const next = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheCreationTokens: ev.cacheCreationTokens, cacheReadTokens: ev.cacheReadTokens,
      costUsdCents: ev.costUsdCents, toolCalls: ev.toolCalls, estimated: ev.estimated };
    const counters = [next.inputTokens, next.outputTokens, next.cacheCreationTokens, next.cacheReadTokens, next.toolCalls];
    if (counters.some((n) => !Number.isSafeInteger(n) || n < 0) || (next.costUsdCents !== null && (!Number.isFinite(next.costUsdCents) || next.costUsdCents < 0))
      || typeof next.estimated !== 'boolean') return { limit: null };
    const fresh = this.db.prepare('SELECT usage_json FROM job_attempts WHERE id = ?').get(a.id) as { usage_json: string | null } | undefined;
    const prevRaw = parseJson(fresh?.usage_json ?? null);
    const prev = isObj(prevRaw) && typeof prevRaw.inputTokens === 'number' ? prevRaw as unknown as typeof next : null;
    // Monotonic: a report that lowers any counter, or drops a reported cost, is ignored (the stored usage stays the highest seen).
    if (!isMonotonicUsage(prev, next)) return { limit: null };
    const stored = { ...next, costUsdCents: next.costUsdCents === null ? null : Math.ceil(next.costUsdCents) };
    this.db.prepare("UPDATE job_attempts SET usage_json = ? WHERE id = ? AND state = 'running'").run(JSON.stringify(stored), a.id);
    const turn = this.turnCapsOf(a);
    if (!turn) return { limit: null };
    const hit = turnLimitReached(stored, turn);
    if (hit === 'tokens') return { limit: 'token' };
    if (hit === 'usd') return { limit: 'cost' };
    if (hit === 'tool_calls') return { limit: 'tool-call' };
    if (stored.costUsdCents !== null && stored.costUsdCents >= turn.dayRemainingUsdCents) return { limit: 'daily budget' };
    return { limit: null };
  }

  /** The turn's caps as the lease recorded them in `sandbox_json.turn`. */
  private turnCapsOf(a: AttemptRow): { turnTokens: number; turnUsdCents: number; toolCalls: number; dayRemainingUsdCents: number } | null {
    const sb = parseJson(a.sandbox_json);
    const t = isObj(sb) && isObj(sb.turn) ? sb.turn : null;
    if (!t) return null;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const tokens = num(t.tokens); const usd = num(t.usdCents); const calls = num(t.toolCalls); const day = num(t.dayRemainingUsdCents);
    return tokens === null || usd === null || calls === null || day === null ? null : { turnTokens: tokens, turnUsdCents: usd, toolCalls: calls, dayRemainingUsdCents: day };
  }

  /** How an exited turn ends (see the module header). */
  settle(a: AttemptRow, j: JobRow, terminal: RuntimeEvent | null, exit: { code: number | null }): AgentSettlement {
    if (terminal && terminal.t === 'run.completed' && exit.code === 0) {
      return this.registeredCount(j.id) > 0
        ? { attempt: 'succeeded', job: 'completed', outcome: 'completed' }
        : { attempt: 'succeeded', job: 'partial', outcome: 'no_change' };
    }
    if (terminal && terminal.t === 'run.failed') {
      const outcome = terminal.code === 'auth' ? 'runtime_auth' : terminal.code === 'limit' ? 'limit' : terminal.code === 'protocol' ? 'runtime_protocol' : failureWord(terminal.message);
      return { attempt: 'failed', job: 'failed', outcome, sessionFailed: outcome === 'runtime_auth',
        error: { code: outcome, message: redactText(String(terminal.message ?? '')).slice(0, 300) || outcome } };
    }
    if (terminal && terminal.t === 'run.cancelled') {
      return { attempt: 'cancelled', job: 'interrupted', outcome: 'interrupted', error: { code: 'interrupted', message: 'the agent was stopped before it finished' } };
    }
    void a;
    return { attempt: 'failed', job: 'failed', outcome: 'runtime_error', error: { code: 'runtime_error', message: 'the agent runtime ended without a result' } };
  }

  /** Inside the transaction that ends a turn's job (or sends it back to the queue): its tokens are revoked. */
  turnLeftTx(after: JobRow, now: number): void {
    void now;
    try { this.deps.tokens.revokeForJob(this.deps.system, after.id, 'job_ended'); } catch (e) {
      // A revocation that failed must never keep a turn alive: the expiry and the next runner `ready` still bound the token.
      this.log(`[nexus] agents: a turn's token was not revoked at its end (${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'})`);
      throw e;
    }
  }

  /** Restart recovery: the token is revoked with the decision's reason and a running session is interrupted (an open one stays open). */
  interruptTurnTx(system: Principal, jobId: string, now: number, reason: 'restart' | 'runner_restart'): void {
    void now;
    this.deps.tokens.revokeForJob(system, jobId, reason);
    const j = this.deps.jobs.row(jobId);
    const s = j?.session_id ? this.sessionRow(j.session_id) : null;
    if (s && (s.status === 'running' || s.status === 'awaiting_approval')) this.deps.sessions.transition(system, s.id, 'interrupted');
  }

  /** `run.failed{auth}`: the session becomes `failed`. */
  sessionFailedTx(after: JobRow, error: { code: string; message: string }): void {
    if (!after.session_id) return;
    const s = this.sessionRow(after.session_id);
    if (!s || ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(s.status)) return;
    this.deps.sessions.transition(this.deps.system, s.id, 'failed', { error });
  }

  // ======================================================================================================
  // Reads
  // ======================================================================================================

  /** The versions a turn registered: those its own job or its child jobs produced. */
  registeredVersions(jobId: string): { versionId: string; kind: string; status: SessionDetailView['versions'][number]['status'] }[] {
    return (this.db.prepare(`SELECT v.id AS id, a.kind AS kind, v.status AS status FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE v.produced_by_job_id = ? OR v.produced_by_job_id IN (SELECT id FROM jobs WHERE parent_job_id = ?) ORDER BY v.created_at, v.id`).all(jobId, jobId) as
      { id: string; kind: string; status: string }[]).map((r) => ({ versionId: r.id, kind: r.kind, status: r.status as SessionDetailView['versions'][number]['status'] }));
  }

  /** How many versions the turn registered: its produced versions, plus the requirement drafts it saved through its token. */
  registeredCount(jobId: string): number {
    const produced = this.registeredVersions(jobId).length;
    const drafts = (this.db.prepare(`SELECT COUNT(*) AS n FROM activity WHERE job_id = ? AND action = 'mcp.call' AND status = 'succeeded'
      AND json_extract(details_json, '$.tool') = 'requirement_draft'`).get(jobId) as { n: number }).n;
    return produced + drafts;
  }

  private sessionRow(id: unknown): SessionRow | null {
    if (!isStr(id)) return null;
    return (this.db.prepare(`SELECT id, project_id, workspace_id, participation_id, principal_id, status, context_version_id, created_at, updated_at
      FROM agent_sessions WHERE id = ?`).get(id) as SessionRow | undefined) ?? null;
  }

  private workspaceOf(s: SessionRow): string | undefined {
    const r = this.db.prepare('SELECT workspace_id FROM project_workspaces WHERE id = ?').get(s.participation_id) as { workspace_id: string } | undefined;
    return r?.workspace_id;
  }

  /** The session's live turn (a non-terminal `agent.run` job), if any. */
  private liveTurnOf(sessionId: string): JobRow | null {
    return (this.db.prepare(`SELECT * FROM jobs WHERE session_id = ? AND kind = 'agent.run' AND state IN (${LIVE_STATES.map(() => '?').join(', ')})
      ORDER BY created_at DESC LIMIT 1`).get(sessionId, ...LIVE_STATES) as JobRow | undefined) ?? null;
  }

  private viewOf(s: AgentSession, turns: number): SessionView {
    const live = this.liveTurnOf(s.id);
    return { id: s.id, projectId: s.projectId, workspaceId: s.workspaceId, status: s.status, turns, liveJobId: live?.id ?? null, createdAt: s.createdAt, updatedAt: s.updatedAt };
  }

  /** A session as the platform type, read without authorization (inside a transaction that already authorized the caller). */
  private sessionAsAgentSession(id: string): AgentSession {
    const r = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as Record<string, unknown>;
    return { id: r.id as string, projectId: r.project_id as string, workspaceId: r.workspace_id as string, participationId: r.participation_id as string,
      contextVersionId: (r.context_version_id as string | null) ?? null, principalId: r.principal_id as string, idempotencyKey: r.idempotency_key as string,
      status: r.status as AgentSessionStatus, runtimeKind: (r.runtime_kind as string | null) ?? null, runtimeRef: (r.runtime_ref as string | null) ?? null,
      cancelRequestedAt: (r.cancel_requested_at as number | null) ?? null, cancelRequestedBy: (r.cancel_requested_by as string | null) ?? null, error: null,
      createdAt: r.created_at as number, updatedAt: r.updated_at as number, statusChangedAt: r.status_changed_at as number, endedAt: (r.ended_at as number | null) ?? null };
  }

  /**
   * The agent's display-only lines of one attempt, from its redacted log (`message: ...` frames, each already cut to 200
   * characters by the runner). Bounded; a log that is missing or unreadable gives none.
   */
  private async logMessages(logRel: string | null): Promise<{ ts: number; text: string }[]> {
    if (!logRel || !this.deps.dataHome) return [];
    const abs = path.join(this.deps.dataHome.root, ...logRel.split('/'));
    const out: { ts: number; text: string }[] = [];
    try {
      const fh = await openFile(abs, 'r');
      try {
        const st = await fh.stat();
        const len = Math.min(st.size, LOG_READ_MAX_BYTES);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, 0);
        for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
          if (!line.startsWith('{')) continue;
          let f: unknown;
          try { f = JSON.parse(line); } catch { continue; }
          if (isObj(f) && f.stream === 'nexus' && typeof f.text === 'string' && f.text.startsWith('message: ') && typeof f.ts === 'number') {
            out.push({ ts: f.ts, text: redactText(f.text.slice('message: '.length)).slice(0, 4000) });
          }
        }
      } finally { await fh.close(); }
    } catch { /* the log is not on disk: no lines */ }
    return out.slice(0, MAX_MESSAGES);
  }
}

/** `failed: <word> (...)` from the runner's own failure messages (`worktree_guard`, `consent_mismatch`, `proxy_failed`), else `runtime_error`. */
function failureWord(message: unknown): string {
  const m = typeof message === 'string' ? /^failed: ([a-z][a-z0-9_]{0,30})/.exec(message) : null;
  return m ? m[1] : 'runtime_error';
}

function usageViewOf(text: string | null): AgentUsageView | null {
  const u = parseJson(text);
  if (!isObj(u) || typeof u.inputTokens !== 'number') return null;
  return { inputTokens: u.inputTokens, outputTokens: Number(u.outputTokens) || 0, cacheCreationTokens: Number(u.cacheCreationTokens) || 0,
    cacheReadTokens: Number(u.cacheReadTokens) || 0, costUsdCents: typeof u.costUsdCents === 'number' ? u.costUsdCents : null,
    toolCalls: Number(u.toolCalls) || 0, estimated: u.estimated === true };
}
