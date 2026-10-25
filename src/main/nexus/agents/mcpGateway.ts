/**
 * The MCP gateway (B2b): the one place an agent turn's tool call is verified, authorized, run and audited. The
 * runner never decides anything; it only relays `mcp.call` from its loopback server (Task 6) and this gateway answers
 * with `mcp.reply`'s value (ExecutionService routes the message and sends the reply; see executionService.ts).
 *
 * `call(raw)` runs, in order:
 *  1. Verify the token (`TokenService.verify`); a failure is audited by its verification code and refused.
 *  2. `parseToolArgs` against the tool's own schema. An unrecognised tool is refused with no audit row (it never
 *     named one of ours); a recognised tool with bad arguments is refused WITH one `mcp.call` activity row (MG7):
 *     this is the one denial that `AuthService.authorizeWithToken` never sees and so never audits itself.
 *  3. `AuthService.authorizeWithToken(claims, action, scope)`. Every tool but `job_request` is authorized through its
 *     own single capability (`scope.tool` set): this also checks the tool is in the token's granted list (TK7) and
 *     writes the one `auth.denied` row on any refusal. `job_request` is authorized at the action level instead
 *     (`scope.tool` left unset): the SDE ceiling covers its three allowed recipes under two different capabilities
 *     (`job.request` for the tests recipe, `approval.request` for the two installs, Task 4's own design), so the
 *     gateway checks the token's granted-tool list for `job_request` itself first (not audited: equivalent to an
 *     unrecognised tool from the caller's side).
 *  4. The per-turn tool-call cap (`BudgetService.caps().toolCalls`; MCP calls only, counted here in memory per job —
 *     the runtime's own stream tool calls are Task 10's). Reaching it answers `limit` and is still recorded (step 5).
 *  5. One service call, dispatched by tool.
 *  6. One `mcp.call` activity row (`argsSummary` redacted, at most 200 characters) and one `attempt.progress` event
 *     `{t:'tool', tool, ok}`, together in one transaction.
 *
 * `sandbox_exec` never runs anything itself: it records a pending exec (`{execId, argvSha256, argvCount, cwd}`, an
 * `attempt.progress` event) against the CALLING job's own live attempt and replies with a grant the runner executes
 * in that attempt's own container. Every call's reply is remembered per (token, `callId`) (a retry never re-runs the
 * service call, re-audits or re-counts; MG13: a retried `sandbox_exec` gets the same grant, never a second one) until
 * the turn's tokens are revoked or expire. `onExecDone` records the reported exit, byte counts and `stdoutSha256`; an unknown or mismatched
 * `execId` is refused (the caller, ExecutionService, logs one line and never writes anything for it — F1).
 */
import { createHash, randomBytes } from 'node:crypto';
import { open as openFile } from 'node:fs/promises';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { Principal, TokenScope } from '../../../shared/nexus/platform';
import type { CapabilityClaims } from '../../../shared/nexus/tokens';
import { parseToolArgs, type McpToolName } from '../../../shared/nexus/mcpTools';
import type { McpReplyResult, RunnerToMain } from '../../../shared/nexus/runnerProtocol';
import { SANDBOX_EXEC_MAX_TIMEOUT_MS } from '../../../shared/nexus/mcpTools';
import { TOOL_ACTIONS } from '../auth/policy';
import { getDomain } from '../../../shared/nexus/domains/index';
import type { AuthService } from '../auth/authService';
import type { TokenService } from './tokenService';
import type { BudgetService } from './budgetService';
import type { ArtifactService } from '../artifact/artifactService';
import type { JobService } from '../jobs/jobService';
import type { ExecutionService, ExecDataHome } from '../exec/executionService';
import type { ExecQueries } from '../exec/execQueries';
import { liveAttemptOf, type AttemptRow } from '../exec/attempts';
import { appendJobEventTx } from '../exec/events';
import { appendActivityRow } from '../activity/writer';
import { containsSecret, redactText } from '../activity/redact';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';

const MAX_ARGS_SUMMARY_CHARS = 200;
/** A sandbox_exec id the gateway mints (opId-shaped: `[A-Za-z0-9_-]{1,64}`). */
const execIdFor = (callId: string, now: number): string =>
  `ex_${createHash('sha256').update(`${callId}:${now}:${randomBytes(8).toString('hex')}`).digest('hex').slice(0, 24)}`;

const asUser = (claims: CapabilityClaims): Principal => ({ id: claims.onBehalfOf, kind: 'user', displayName: '' });
/** The most bytes of a log file `job_logs` reads back to the agent in one call. */
const JOB_LOGS_READ_MAX_BYTES = 64 * 1024;

interface PendingExec { jobId: string; attemptId: string; attemptN: number; projectId: string; issuedAt: number }

export interface McpGatewayDeps {
  auth: AuthService;
  tokens: TokenService;
  budget: BudgetService;
  artifacts: ArtifactService;
  jobs: JobService;
  exec: ExecutionService;
  queries: ExecQueries;
  /** main's own data home (the same object ExecutionService was built with): blob reads and attempt log reads. */
  dataHome: ExecDataHome | null;
  system: Principal;
  now: () => number;
  log?: (line: string) => void;
}

const ok = (value: unknown): McpReplyResult => ({ ok: true, value });
const fail = (code: string, message: string): McpReplyResult => ({ ok: false, code, message });

export class McpGateway {
  private readonly log: (line: string) => void;
  /**
   * `<jti>:<callId>` -> the reply decided for it, as a promise (a retry that arrives while the first is still running
   * shares it). Every tool is idempotent on a retried callId of the same token: the service call never runs twice, no
   * second `mcp.call` row is written, the per-turn budget is counted once, and a `sandbox_exec` grant is never
   * re-minted (MG13). Keyed by the token too, so a callId never answers for another turn. Entries are dropped when
   * the turn's tokens are revoked (`evictJob`) and, as a backstop, once their token has expired.
   */
  private readonly repliedCalls = new Map<string, { reply: Promise<McpReplyResult>; jobId: string; exp: number }>();
  /** `execId` -> what main is waiting for from `agent.exec.done`. */
  private readonly pendingExecs = new Map<string, PendingExec>();
  /** `jobId` -> MCP calls counted against the turn's tool-call cap so far (in memory; a restart starts a fresh turn). */
  private readonly callCounts = new Map<string, number>();

  constructor(private readonly db: Database.Database, private readonly deps: McpGatewayDeps) {
    this.log = deps.log ?? (() => {});
  }

  async call(raw: Extract<RunnerToMain, { op: 'mcp.call' }>): Promise<McpReplyResult> {
    const now = this.deps.now();
    this.sweepExpired(now);
    const v = this.deps.tokens.verify(raw.bearer, now);
    if (!v.ok) {
      const c = v.claims;
      this.deps.auth.auditTokenRefusal(v.code, raw.tool, { tool: raw.tool },
        c ? { sub: c.sub, jobId: c.jobId, sessionId: c.sessionId, projectId: c.projectId, workspaceId: c.workspaceId } : null);
      return fail(v.code, `the token is ${v.code}`);
    }
    const claims = v.claims;
    const key = `${claims.jti}:${raw.callId}`;
    const prior = this.repliedCalls.get(key);
    if (prior) return prior.reply;
    const reply = this.decide(raw, claims, now);
    this.repliedCalls.set(key, { reply, jobId: claims.jobId, exp: claims.exp });
    // A call that threw is not remembered (its retry may succeed); the caller still sees the rejection.
    reply.catch(() => { if (this.repliedCalls.get(key)?.reply === reply) this.repliedCalls.delete(key); });
    return reply;
  }

  /** Drops what the gateway keeps in memory for a turn: its retried-call replies, its call count and its pending execs. */
  evictJob(jobId: string): void {
    for (const [k, e] of this.repliedCalls) if (e.jobId === jobId) this.repliedCalls.delete(k);
    this.callCounts.delete(jobId);
    for (const [id, p] of this.pendingExecs) if (p.jobId === jobId) this.pendingExecs.delete(id);
  }

  /** Every turn's tokens were revoked at once (a restart, a new runner): nothing is kept. */
  evictAll(): void { this.repliedCalls.clear(); this.callCounts.clear(); this.pendingExecs.clear(); }

  /** The backstop: a token that expired can no longer call, so what is kept for its turn goes too (at most once a second). */
  private lastSweepAt = 0;
  private sweepExpired(now: number): void {
    if (now - this.lastSweepAt < 1000 && now >= this.lastSweepAt) return;
    this.lastSweepAt = now;
    const gone = new Set<string>();
    for (const [k, e] of this.repliedCalls) if (e.exp <= now) { this.repliedCalls.delete(k); gone.add(e.jobId); }
    for (const id of gone) {
      if (![...this.repliedCalls.values()].some((e) => e.jobId === id)) { this.callCounts.delete(id); }
    }
  }

  /** The pipeline of one call after its token verified (steps 2 to 6 of the header). */
  private async decide(raw: Extract<RunnerToMain, { op: 'mcp.call' }>, claims: CapabilityClaims, now: number): Promise<McpReplyResult> {
    const parsed = parseToolArgs(raw.tool, raw.args);
    if (!parsed.ok) {
      const result = fail(parsed.code, parsed.code === 'bad_args' ? `bad argument: ${parsed.field ?? '/'}` : 'unknown tool');
      // bad_args is the one denial authorizeWithToken never sees: it gets its own audit row (MG7). An unknown tool is
      // never one of ours and is not recorded (as a free-text tool is not, TK7).
      if (parsed.code === 'bad_args') this.recordCall(claims, raw.tool, raw.args, result, now);
      return result;
    }
    const args = parsed.args;
    const tool = raw.tool as McpToolName;

    if (tool === 'job_request' && !claims.mcpTools.includes('job_request')) return fail('tool_not_granted', 'unknown tool');

    const action = TOOL_ACTIONS[tool];
    const scope = this.scopeFor(tool, claims, args);
    const authz = this.deps.auth.authorizeWithToken(claims, action, scope);
    if (!authz.allowed) return fail(authz.reason, `the call is refused: ${authz.reason}`);

    // job_status and job_logs name a job: it must be this turn's own job or one of its child jobs (a token reaches no
    // other job, not even one of the same project).
    if ((tool === 'job_status' || tool === 'job_logs') && !this.jobInTurn(claims, args.jobId as string)) {
      this.deps.auth.auditDenial({ id: claims.sub, kind: 'agent', displayName: '' }, {
        action: 'auth.denied', reason: 'out_of_scope', entityType: 'auth', jobId: claims.jobId, sessionId: claims.sessionId,
        onBehalfOf: claims.onBehalfOf, projectId: claims.projectId, workspaceId: claims.workspaceId, details: { requested: 'job.read', tool, field: 'jobId' } });
      return fail('out_of_scope', 'the call is refused: out_of_scope');
    }

    const used = (this.callCounts.get(claims.jobId) ?? 0) + 1;
    const cap = this.deps.budget.caps().toolCalls;
    if (used > cap) {
      const result = fail('limit', "the turn's tool-call cap is reached");
      this.recordCall(claims, tool, args, result, now);
      return result;
    }
    this.callCounts.set(claims.jobId, used);

    let result: McpReplyResult;
    try {
      result = await this.run(tool, raw.callId, claims, args, now);
    } catch (e) {
      result = fail(e instanceof PlatformError ? e.code : 'error', e instanceof Error ? e.message.slice(0, 200) : 'the call failed');
    }
    this.recordCall(claims, tool, args, result, now);
    return result;
  }

  /** Whether `jobId` is the turn's own job or a child of it, in the token's project (an unknown id is simply not in the turn). */
  private jobInTurn(claims: CapabilityClaims, jobId: string): boolean {
    const j = this.db.prepare('SELECT id, project_id, parent_job_id FROM jobs WHERE id = ?').get(jobId) as
      { id: string; project_id: string; parent_job_id: string | null } | undefined;
    return !!j && j.project_id === claims.projectId && (j.id === claims.jobId || j.parent_job_id === claims.jobId);
  }

  /** `agent.exec.done`: records the exit, counts and hash. Returns false for an unknown or mismatched execId (F1). */
  onExecDone(m: Extract<RunnerToMain, { op: 'agent.exec.done' }>): boolean {
    const pending = this.pendingExecs.get(m.execId);
    if (!pending || pending.attemptId !== m.attemptId) return false;
    this.pendingExecs.delete(m.execId);
    const now = this.deps.now();
    immediateTx(this.db, () => {
      appendJobEventTx(this.db, {
        type: 'attempt.progress', projectId: pending.projectId, jobId: pending.jobId, attemptN: pending.attemptN,
        summary: `attempt ${pending.attemptN}: sandbox exec done (exit ${m.exit.code ?? 'none'})`,
        data: { t: 'exec.done', execId: m.execId, exit: m.exit, stdoutBytes: m.stdoutBytes, stderrBytes: m.stderrBytes,
          stdoutSha256: m.stdoutSha256, truncated: m.truncated }
      }, now);
    });
    return true;
  }

  // ---------- authorization scope ----------

  private scopeFor(tool: McpToolName, claims: CapabilityClaims, args: Record<string, unknown>): TokenScope {
    if (tool === 'job_request') {
      const recipeId = args.recipeId as string;
      // The SDE ceiling covers job_request's three allowed recipes under two different capabilities: the tests
      // recipe under job.request itself, the two installs under approval.request (Task 4's own design, confirmed by
      // its own fixture test). Pass `tool` only when the recipe is actually inside job.request's own scope; otherwise
      // authorize at the action level, so approval.request's scope is tried too.
      const jobRequestCap = getDomain(claims.workspaceId)?.capabilities.find((c) => c.id === 'job.request');
      const coveredByJobRequest = !!jobRequestCap?.scope?.recipes?.includes(recipeId);
      return coveredByJobRequest ? { projectId: claims.projectId, tool, recipeId } : { projectId: claims.projectId, recipeId };
    }
    const scope: TokenScope = { projectId: claims.projectId, tool };
    if (tool === 'artifact_read' || tool === 'validations_get' || tool === 'review_request') scope.versionId = args.versionId as string;
    if (tool === 'requirement_draft') scope.kind = 'requirement';
    if (tool === 'changeset_register') scope.kind = 'change_set';
    return scope;
  }

  // ---------- the one service call per tool ----------

  private async run(tool: McpToolName, callId: string, claims: CapabilityClaims, args: Record<string, unknown>, now: number): Promise<McpReplyResult> {
    switch (tool) {
      case 'context_get': return this.toolContextGet(claims);
      case 'artifact_list': return this.toolArtifactList(claims, args);
      case 'artifact_read': return this.toolArtifactRead(claims, args);
      case 'validations_get': return this.toolValidationsGet(claims, args);
      case 'job_status': return this.toolJobStatus(claims, args);
      case 'job_logs': return this.toolJobLogs(claims, args);
      case 'sandbox_exec': return this.toolSandboxExec(claims, args, callId, now);
      case 'job_request': return this.toolJobRequest(claims, args, callId, now);
      case 'requirement_draft': return this.toolRequirementDraft(claims, args, now);
      case 'review_request': return this.toolReviewRequest(claims, args, now);
      case 'changeset_register': return fail('not_in_this_build', 'change-set registration arrives in a later phase');
      default: return fail('unknown_tool', 'unknown tool');
    }
  }

  private toolContextGet(claims: CapabilityClaims): McpReplyResult {
    const row = this.db.prepare('SELECT context_hash FROM jobs WHERE id = ?').get(claims.jobId) as { context_hash: string | null } | undefined;
    if (!row || row.context_hash === null) return fail('not_found', 'no context has been written for this turn yet');
    return ok({ path: `jobs/${claims.jobId}/agent/context.md`, sha256: row.context_hash });
  }

  private toolArtifactList(claims: CapabilityClaims, args: Record<string, unknown>): McpReplyResult {
    const list = this.deps.artifacts.listByProject(asUser(claims), claims.projectId,
      { kind: args.kind as string | undefined, limit: args.limit as number | undefined });
    return ok({ artifacts: list.map((a) => ({ id: a.id, kind: a.kind, name: a.name, status: a.status, currentVersionId: a.currentVersionId })) });
  }

  private async toolArtifactRead(claims: CapabilityClaims, args: Record<string, unknown>): Promise<McpReplyResult> {
    const version = this.deps.artifacts.getVersion(asUser(claims), args.versionId as string);
    const maxBytes = typeof args.maxBytes === 'number' ? args.maxBytes : 256 * 1024;
    const s = version.storage;
    if (s.kind === 'inline') return ok({ encoding: 'json', content: s.json });
    if (s.kind === 'git') return ok({ encoding: 'text', content: `commit ${s.commit}${s.ref ? ` ref ${s.ref}` : ''}` });
    if (s.kind === 'blob') {
      if (!this.deps.dataHome?.readObjectBytes) return fail('storage_unavailable', 'no data home is configured to read stored content');
      const bytes = await this.deps.dataHome.readObjectBytes(s.sha256, Math.min(maxBytes, s.bytes));
      if (bytes === null) return fail('not_found', 'the stored content is missing');
      if (bytes === 'too_large') return fail('too_large', 'the stored content is larger than the requested maxBytes');
      const isText = s.mediaType.startsWith('text/') || s.mediaType === 'application/json';
      return ok(isText ? { encoding: 'text', content: bytes.toString('utf8') } : { encoding: 'base64', content: bytes.toString('base64') });
    }
    // A tree's per-file content (the `path` argument) arrives with the recipes that produce trees (later tasks).
    return fail('storage_unavailable', `a ${s.kind} version has nothing to read here`);
  }

  private toolValidationsGet(claims: CapabilityClaims, args: Record<string, unknown>): McpReplyResult {
    const summaries = this.deps.queries.validationsFor(asUser(claims), args.versionId as string);
    return ok({ validators: summaries });
  }

  private toolJobStatus(claims: CapabilityClaims, args: Record<string, unknown>): McpReplyResult {
    const detail = this.deps.exec.get(asUser(claims), args.jobId as string);
    return ok({ id: detail.id, state: detail.state, headline: detail.headline, outcome: detail.outcome, attempts: detail.attempts });
  }

  private async toolJobLogs(claims: CapabilityClaims, args: Record<string, unknown>): Promise<McpReplyResult> {
    const jobId = args.jobId as string;
    const latest = this.db.prepare('SELECT MAX(n) AS n FROM job_attempts WHERE job_id = ?').get(jobId) as { n: number | null };
    if (latest.n === null) return ok({ text: '', bytes: 0, truncated: false });
    const { logRel, logBytes } = this.deps.queries.attemptLog(asUser(claims), jobId, latest.n);
    if (!logRel || !this.deps.dataHome) return ok({ text: '', bytes: 0, truncated: false });
    const fromOffset = typeof args.fromOffset === 'number' ? args.fromOffset : 0;
    const maxBytes = typeof args.maxBytes === 'number' ? args.maxBytes : JOB_LOGS_READ_MAX_BYTES;
    // logRel is a main-written relative path (attemptLogPath), never attacker-controlled.
    const abs = path.join(this.deps.dataHome.root, ...logRel.split('/'));
    let text = ''; let truncated = false;
    try {
      const fh = await openFile(abs, 'r');
      try {
        const toRead = Math.max(0, Math.min(maxBytes, logBytes - fromOffset));
        if (toRead > 0) {
          const buf = Buffer.alloc(toRead);
          const { bytesRead } = await fh.read(buf, 0, toRead, fromOffset);
          text = buf.subarray(0, bytesRead).toString('utf8');
          truncated = fromOffset + bytesRead < logBytes;
        }
      } finally { await fh.close(); }
    } catch { /* the log is not on disk (not yet written, or GC'd): an empty page, never a throw */ }
    return ok({ text: redactText(text), bytes: logBytes, truncated });
  }

  private toolSandboxExec(claims: CapabilityClaims, args: Record<string, unknown>, callId: string, now: number): McpReplyResult {
    const attempt: AttemptRow | null = liveAttemptOf(this.db, claims.jobId);
    if (!attempt) return fail('no_attempt', "there is no live attempt for this turn's job");
    const argv = (args.argv as string[]).slice();
    const cwd = args.cwd as string;
    const requested = args.timeoutMs as number;
    const remaining = Math.max(1000, claims.exp - now);
    const timeoutMs = Math.min(requested, remaining, SANDBOX_EXEC_MAX_TIMEOUT_MS);
    const execId = execIdFor(callId, now);
    const argvSha256 = createHash('sha256').update(JSON.stringify(argv)).digest('hex');
    immediateTx(this.db, () => {
      appendJobEventTx(this.db, {
        type: 'attempt.progress', projectId: claims.projectId, jobId: claims.jobId, attemptN: attempt.n,
        summary: `attempt ${attempt.n}: sandbox exec pending`,
        data: { t: 'exec.pending', execId, argvSha256, argvCount: argv.length, cwd }
      }, now);
    });
    this.pendingExecs.set(execId, { jobId: claims.jobId, attemptId: attempt.id, attemptN: attempt.n, projectId: claims.projectId, issuedAt: now });
    return ok({ grant: { execId, argv, cwd, timeoutMs } });
  }

  private toolJobRequest(claims: CapabilityClaims, args: Record<string, unknown>, callId: string, now: number): McpReplyResult {
    void now;
    const childCount = (this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE parent_job_id = ?').get(claims.jobId) as { n: number }).n;
    if (childCount >= claims.maxChildJobs) return fail('limit', 'the turn has reached its child-job limit');
    // Through the execution core's own start path (not a bare JobService.create): the job is written with its
    // capability and limits, so the scheduler leases it; an install then waits for the user's A1 approval at lease.
    const { job: created } = this.deps.exec.startForAgent(asUser(claims), {
      projectId: claims.projectId, workspaceId: claims.workspaceId, recipeId: args.recipeId as string,
      inputVersionIds: Array.isArray(args.inputs) ? (args.inputs as string[]) : [], intentId: `mcp:${callId}`,
      parentJobId: claims.jobId, sessionId: claims.sessionId
    });
    return ok({ jobId: created.id, state: created.state });
  }

  private toolRequirementDraft(claims: CapabilityClaims, args: Record<string, unknown>, now: number): McpReplyResult {
    void now;
    const content: Record<string, unknown> = { title: args.title, criteria: args.criteria };
    if (typeof args.body === 'string') content.body = args.body;
    const { version, created } = this.deps.artifacts.saveInline(asUser(claims), {
      projectId: claims.projectId, workspaceId: claims.workspaceId, kind: 'requirement', target: { name: args.title as string }, content
    });
    const finalized = created && version.status === 'draft'
      ? this.deps.artifacts.finalize(this.deps.system, version.id, 'candidate') : version;
    return ok({ versionId: finalized.id, status: finalized.status, created });
  }

  private toolReviewRequest(claims: CapabilityClaims, args: Record<string, unknown>, now: number): McpReplyResult {
    const versionId = args.versionId as string;
    const note = typeof args.note === 'string' ? args.note : null;
    if (note !== null && containsSecret(note)) throw new PlatformError('invalid', 'the note holds a secret-shaped value', { reason: 'secret_in_metadata' });
    immediateTx(this.db, () => {
      appendJobEventTx(this.db, {
        type: 'approval', projectId: claims.projectId, jobId: claims.jobId, summary: 'the agent asked for review of its work',
        data: { t: 'review_requested', versionId, note, needsYou: true }
      }, now);
    });
    return ok({ versionId, requested: true });
  }

  // ---------- audit ----------

  private summarize(args: unknown): string {
    if (containsSecret(args)) return '[redacted: secret-shaped argument]';
    let text: string;
    try { text = JSON.stringify(args) ?? ''; } catch { text = '[unserializable]'; }
    const redacted = redactText(text);
    return redacted.length > MAX_ARGS_SUMMARY_CHARS ? `${redacted.slice(0, MAX_ARGS_SUMMARY_CHARS - 1)}…` : redacted;
  }

  private recordCall(claims: CapabilityClaims, tool: string, args: unknown, result: McpReplyResult, now: number): void {
    const argsSummary = this.summarize(args);
    immediateTx(this.db, () => {
      appendActivityRow(this.db, {
        actorKind: 'agent', actorId: claims.sub, onBehalfOf: claims.onBehalfOf, sessionId: claims.sessionId, jobId: claims.jobId,
        projectId: claims.projectId, workspaceId: claims.workspaceId, entityType: 'mcp_call', entityId: null,
        // 'denied' is reserved for authorizeWithToken's own auth.denied rows; this row's failures (bad_args, limit, a
        // service error) are recorded as 'failed'.
        action: 'mcp.call', status: result.ok ? 'succeeded' : 'failed',
        details: result.ok ? { tool, argsSummary } : { tool, argsSummary, code: result.code }
      }, now);
      appendJobEventTx(this.db, {
        type: 'attempt.progress', projectId: claims.projectId, jobId: claims.jobId,
        summary: `agent called ${tool}${result.ok ? '' : ` (${result.code})`}`,
        data: { t: 'tool', tool, ok: result.ok, ...(result.ok ? {} : { code: result.code }) }
      }, now);
    });
  }
}
