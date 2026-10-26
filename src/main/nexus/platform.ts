/**
 * The Nexus platform composition root. It wires the core services onto the one
 * better-sqlite3 connection that PersistStore opened at schema v7. It grows task by
 * task; it holds principal resolution, authorization, the activity read API,
 * workspaces and project participation, project-scoped access checks, artifacts
 * with their versions, the version-level lineage DAG, durable jobs, agent
 * sessions and, at schema v8, handoffs (null below v8 or when v8 is held or
 * failed). At schema v9, with `execution` on, it also composes the execution core
 * (ExecutionService, its runner attached later by main) and the one BlobIndex, the
 * validation framework and ingest, and (B2a Task 9) the approval service (once-only
 * egress and image approvals, image builds), dev deployments and snapshot requests,
 * each late-bound to the execution core.
 *
 * Restart recovery at startup is chosen by the database FILE's schema version, never by the enableV9 flag: a v9 file
 * (user_version 9, or execution records present) runs the execution core's phase A (B2a Task 10, exec/recovery.ts;
 * in hold mode while execution is off), because B1's `jobs.recoverAfterRestart` would end jobs whose attempts are
 * still live, which the v9 backstop refuses (and which would interrupt adoptable work). v7/v8 files run B1's routine
 * unchanged. The platform's `bootId` is the boot id phase A re-owns for; main attaches the runner with the same one.
 *
 * The domain registry is checked at startup (B2a Task 13, registryImpl.ts): the registry's own soundness and its
 * agreement with what main implements. A problem keeps execution off (`registry_invalid`); nothing throws, and the
 * B1 services and the read-only channels keep working.
 *
 * Agents (B2b): with `opts.agents` on, execution available and the v10 shape in place, the platform also composes the
 * capability tokens (TokenService: one key per platform, i.e. per main boot) and the runtime consent with its spend and
 * rate guards (BudgetService). Startup revokes every live agent token (`restart`), and so does every runner `ready`
 * (`runner_restart`, F9): the runner's port is wrapped when it is attached, so the revocation runs before the execution
 * core sees the `ready` (and before any later message of the new runner).
 *
 * B2b Task 10 also composes the change-set registration (ChangeSetService, behind the `changeset_register` tool), the
 * session worktrees (WorktreeService) and the AgentService: turns, sessions and the scheduler's agent guards. The
 * AgentService is the `TurnStarter` of reviews unless a caller passes its own, and its runtime health comes from an
 * injectable cache (`opts.runtimeHealth`; Task 14 fills it from the runner's probe).
 *
 * No IPC is registered here. Callers in main pass a Principal resolved through
 * `principals`; the renderer never supplies identity.
 */
import type Database from 'better-sqlite3';
import { ActivityService } from './activity/activityService';
import { ArtifactService } from './artifact/artifactService';
import { AuthService } from './auth/authService';
import { HandoffService } from './handoff/handoffService';
import { JobService } from './jobs/jobService';
import { BlobIndex } from './blobs/blobIndex';
import { ExecutionService, type ExecDataHome, type EgressApprovalPort, type IngestPort } from './exec/executionService';
import type { PhaseAReport } from './exec/recovery';
import { newId } from './db/ids';
import { IngestService } from './exec/ingest';
import { ApprovalService, type ImageContext } from './approvals/approvalService';
import { DeploymentService } from './deployments/deploymentService';
import { RepoService } from './repo/repoService';
import { ValidationService, type ResolveCommit } from './validation/validationService';
import type { ArtifactValidatorHooks } from './artifact/artifactService';
import type { SandboxProfile } from '../../shared/nexus/execution';
import { PrincipalResolver } from './auth/principals';
import { LineageService } from './lineage/lineageService';
import { ProjectAccess } from './project/projectAccess';
import { v8ShapeProblem } from './db/schemaV8';
import { v9ShapeProblem } from './db/schemaV9';
import { SessionService } from './sessions/sessionService';
import { WorkspaceService } from './workspace/workspaceService';
import { ExecQueries } from './exec/execQueries';
import { registryProblems } from './registryImpl';
import { v10ShapeProblem } from './db/schemaV10';
import { TokenService } from './agents/tokenService';
import { BudgetService, hostsSha256 } from './agents/budgetService';
import { RuntimeHealthCache, type AgentRuntimeProbe } from './agents/runtimeHealth';
import { ContextResolver } from './agents/contextResolver';
import { Skills } from './agents/skills';
import { McpGateway } from './agents/mcpGateway';
import { AgentService, type RuntimeHealthProvider } from './agents/agentService';
import { WorktreeService } from './repo/worktreeService';
import { ChangeSetService } from './repo/changeSetService';
import type { RunnerPort } from './exec/runnerPort';
import { parseRunnerMessage } from '../../shared/nexus/runnerProtocol';
import { PlatformError } from './errors';
import { GitRead } from './repo/gitRead';
import { AcceptService } from './repo/acceptService';
import { ReviewService, type TurnStarter } from './review/reviewService';

export interface NexusPlatform {
  principals: PrincipalResolver;
  auth: AuthService;
  activity: ActivityService;
  workspaces: WorkspaceService;
  projects: ProjectAccess;
  artifacts: ArtifactService;
  lineage: LineageService;
  jobs: JobService;
  sessions: SessionService;
  /** Handoffs between participations (schema v8); null when v8 is held, failed or not in place. */
  handoffs: HandoffService | null;
  /** True exactly when `handoffs` is built: the store is at v8 with its shape checked. */
  handoffsAvailable: boolean;
  /**
   * True when the caller (main) turned execution on (`opts.execution`, from PersistStore.executionAvailable),
   * handoffs are built and the v9 shape checks. False by default.
   */
  executionAvailable: boolean;
  /**
   * The execution core. Always built; while `executionAvailable` is false every user-facing method refuses
   * with platform_unavailable (reason `not_enabled` or the store's sub-reason) and it never touches a v9
   * table. The runner is attached later by main (null until the runner host exists).
   */
  exec: ExecutionService;
  /** The one blob index of this platform (ingest and GC share it and its lock); null unless execution is available. */
  blobs: BlobIndex | null;
  /** Validator results, the finalize rule and the validate jobs (schema v9); null unless execution is available. */
  validation: ValidationService | null;
  /** Once-only approvals (egress, image preparation) and image builds (schema v9); null unless execution is available. */
  approvals: ApprovalService | null;
  /** Local dev deployments (schema v9); null unless execution is available. */
  deployments: DeploymentService | null;
  /** Repository snapshot requests and the app manifest contract; null unless execution is available. */
  repo: RepoService | null;
  /** The execution reads of the IPC layer (actions, logs, previews, checks); null unless execution is available. */
  queries: ExecQueries | null;
  /** The domain registry's startup check (problems count; execution is off when it is not valid). */
  registry: { valid: boolean; problems: number };
  /** This process's boot id: restart recovery re-owns for it, and main attaches the runner with it (B2a Task 10/11). */
  bootId: string;
  /** B2b: true when the agent services are built (`opts.agents`, execution available, the v10 shape in place). */
  agentsAvailable: boolean;
  /** B2b: capability tokens (mint in the lease transaction, verify, revoke); null unless agents are available. */
  tokens: TokenService | null;
  /** B2b: the runtime consent, today's usage and the start guards; null unless agents are available. */
  budget: BudgetService | null;
  /** B2b Task 5: the MCP gateway (token/tool/scope/cap verification, one service call, audit); null unless agents are available. */
  mcpGateway: McpGateway | null;
  /** B2b Task 5: writes the turn's context file; null unless agents are available. */
  contextResolver: ContextResolver | null;
  /** B2b Task 5: writes the turn's skill bundle; null unless agents are available. */
  skills: Skills | null;
  /** B2b Task 9: the bounded git reads through the runner (status, diff); null unless execution is available. */
  gitRead: GitRead | null;
  /** B2b Task 10: agent turns (sessions, the start guards, the plan, usage caps); also the `TurnStarter` of reviews. Null unless agents are available. */
  agents: AgentService | null;
  /** B2b Task 7/10: the session worktrees and the once-per-project repository-write approval; null unless agents are available. */
  worktrees: WorktreeService | null;
  /** B2b Task 8/10: change-set registration behind the `changeset_register` tool; null unless agents are available. */
  changeSets: ChangeSetService | null;
  /** B2b Task 9: user review decisions on change-set candidates; null unless agents are available. */
  reviews: ReviewService | null;
  /** B2b Task 9: accept (merge-tree, CAS, rollback), the integration-ref status and "Merge accepted work"; null unless agents are available. */
  accepts: AcceptService | null;
  /** B2b Task 14: the cached health of the agent runtime (from the runner's probe) and the refresh trigger; null unless agents are available. */
  agentProbe: AgentRuntimeProbe | null;
  startup(): NexusStartupReport;
}

/** What one startup pass did; every count is 0 on a clean restart. */
export interface NexusStartupReport {
  catalogAdded: number;
  primaries: { set: number; cleared: number };
  sessions: { interrupted: number };
  jobs: { interrupted: number; requeued: number };
  /** On a v9 database only (the key is absent below v9): what restart recovery's phase A did. */
  execution?: PhaseAReport;
  /** With agents available only (the key is absent otherwise): the live agent tokens revoked at startup. */
  agents?: { tokensRevoked: number };
}

export interface NexusPlatformOptions {
  now?: () => number; log?: (line: string) => void; handoffs?: boolean; execution?: boolean;
  /** Why execution is off, as PersistStore says (`held`, `auto_held`, `backup_failed`, `failed`, `shape`); default `not_enabled`. */
  executionUnavailableReason?: string | null;
  /** Execution wiring (main): the data home, the pinned sandbox profiles, the project-folder acceptance. */
  dataHome?: ExecDataHome | null;
  profiles?: readonly SandboxProfile[];
  acceptFsRoot?: ((root: string) => string | null) | null;
  /**
   * The egress approval port of the execution core: omitted, the platform's own ApprovalService (which also expires
   * approvals on the scheduler's cadence); null, none (egress recipes are refused); an object, that port (tests).
   */
  approvals?: EgressApprovalPort | null;
  /** The build context of each profile image (B2a Task 12, from infra/images); without it image preparation is refused. */
  imageContexts?: ((profileId: string) => ImageContext | null) | null;
  /**
   * main's own async git repository check (src/main/git.ts repositoryCheck: true, false, or 'git_missing' when no git is
   * installed); without it snapshot requests are unavailable.
   */
  isRepository?: ((root: string) => Promise<boolean | 'git_missing'>) | null;
  /** The ingest of runner outputs: omitted, the platform's own (Task 8); null, none (exits then fail ingest_unavailable). */
  ingest?: IngestPort | null;
  /** main's own async commit resolution in the project folder (src/main/git.ts resolveCommit), for git.head_resolves. */
  resolveCommit?: ResolveCommit | null;
  /** Tests only: fault injection inside the ingest transaction. */
  ingestFaults?: { afterRows?: (recipeId: string) => void } | null;
  /** The Nexus app version recorded in each attempt's environment. */
  appVersion?: string | null;
  /** Main's own look for git (default: resolveGitBinary over the file system); a job waiting for git leases once it answers. */
  findGit?: (() => Promise<string | null>) | null;
  /** This process's boot id (a ULID); default: a new one. */
  bootId?: string;
  /** Tests only: the registry check's problems (default: registryImpl's startup check). */
  registryProblems?: () => string[];
  /** B2b: turn the agent services on (main: PersistStore.agentsAvailable); they need execution and the v10 shape too. Default off. */
  agents?: boolean;
  /** Tests only: the token key and id source (default node:crypto). */
  randomBytes?: (n: number) => Buffer;
  /** B2b Task 5: the app's `resources` folder (a skill's file is `<dir>/skills/<id>/SKILL.md`); null, Skills.write refuses. */
  skillsResourcesDir?: string | null;
  /**
   * B2b Task 9: starts the next agent turn for a review that asked for changes. Omitted, it is the platform's own AgentService
   * (Task 10) when agents are available, else a stub that answers `agents_unavailable`, so a request for changes records
   * nothing. A test may pass its own.
   */
  turns?: TurnStarter;
  /**
   * B2b Task 10: the cached health of the agent runtime (Task 14 plugs the runner's probe in). Omitted, it is unknown: a turn
   * is refused at start and a queued one waits `waiting:runtime`.
   */
  runtimeHealth?: RuntimeHealthProvider;
  /**
   * B2b Task 14: called after a job was queued by the agent, worktree, accept or merge services (main: a deferred scheduler
   * tick, so the job does not wait for the next 1 s tick). Never called inside a transaction's own work.
   */
  onQueued?: () => void;
  /** Tests only: how long a cached runtime health stays fresh (default 5 minutes). */
  runtimeHealthTtlMs?: number;
}

/**
 * Whether the database FILE holds schema v9 (its user_version, or the execution records' table): restart recovery
 * then takes the execution path, whatever this process's enableV9 flag says.
 */
export function isV9File(db: Database.Database): boolean {
  try {
    if ((db.pragma('user_version', { simple: true }) as number) >= 9) return true;
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_attempts'").get() !== undefined;
  } catch {
    return false;
  }
}

export function createNexusPlatform(db: Database.Database, opts?: NexusPlatformOptions): NexusPlatform {
  const now = opts?.now ?? Date.now;
  const log = opts?.log ?? (() => {});
  // The caller (main) may turn handoffs off; they are on only when the v8 shape also checks, so a forced `true` on a
  // bad shape never builds a refusing service that would block workspace withdraw.
  const handoffsOn = (opts?.handoffs ?? true) && v8ShapeProblem(db, true) === null;
  const principals = new PrincipalResolver(db);
  const auth = new AuthService(db, { now, log });
  const activity = new ActivityService(db, { auth });
  // Late-bound: the withdraw guard counts open handoffs once the handoff service exists (never below v8).
  let handoffs: HandoffService | null = null;
  const workspaces = new WorkspaceService(db, { auth, now, log, openHandoffs: (id) => handoffs?.openCountFor(id) ?? 0 });
  const projects = new ProjectAccess(db, { auth });
  // Late-bound: inline saves record their register validators once the validation service exists (v9).
  const artifactHooks: ArtifactValidatorHooks = {};
  const artifacts = new ArtifactService(db, { auth, now, validators: artifactHooks });
  const lineage = new LineageService(db, { auth, now });
  const jobs = new JobService(db, { auth, now });
  const sessions = new SessionService(db, { auth, jobs, now });
  if (handoffsOn) handoffs = new HandoffService(db, { auth, principals, artifacts, now });
  else log('[nexus] handoffs unavailable: schema v8 not in place');
  const handoffsAvailable = handoffs !== null;
  // Execution is off unless the caller turns it on (v9 stays off until verified); like handoffs, a forced `true`
  // counts only when the v9 shape also checks. Nothing executes yet: this flag is read by later services.
  // The registry is checked at startup: an unsound registry (or one that disagrees with main) keeps execution off.
  let problems: string[];
  try { problems = (opts?.registryProblems ?? registryProblems)(); } catch { problems = ['the registry check could not run']; }
  if (!Array.isArray(problems)) problems = ['the registry check could not run'];
  const registryValid = problems.length === 0;
  if (!registryValid) log(`[nexus] domain registry check failed: ${problems.length} problem(s); execution is off (first: ${String(problems[0]).slice(0, 160)})`);
  const shapeOk = (opts?.execution ?? false) && handoffsAvailable && v9ShapeProblem(db, true) === null;
  const executionAvailable = shapeOk && registryValid;
  const unavailableReason = executionAvailable ? null
    : !(opts?.execution ?? false) ? (opts?.executionUnavailableReason ?? 'not_enabled')
      : !handoffsAvailable ? 'v8_unavailable' : !shapeOk ? 'shape' : 'registry_invalid';
  // Exactly one BlobIndex per platform, shared by ingest and GC (one lock); built only with execution.
  const blobs = executionAvailable ? new BlobIndex(db, { auth, now }) : null;
  const validation = executionAvailable ? new ValidationService(db, { auth, artifacts, jobs, now, log, blobs,
    resolveCommit: opts?.resolveCommit ?? null, acceptFsRoot: opts?.acceptFsRoot ?? null, appVersion: opts?.appVersion ?? null }) : null;
  if (validation) artifactHooks.recordInlineRegisterTx = (versionId, kind, content) => validation.recordInlineRegisterTx(versionId, kind, content);
  const ingest: IngestPort | null = opts?.ingest !== undefined ? opts.ingest
    : validation ? new IngestService(db, { artifacts, validation, jobs, blobs, now, resolveCommit: opts?.resolveCommit ?? null, faults: opts?.ingestFaults ?? null,
      // An install's lock.sha256 is read back from the blob store through the data home (fix round 1).
      objects: typeof opts?.dataHome?.readObjectBytes === 'function' ? { readObjectBytes: (sha, max) => opts.dataHome!.readObjectBytes!(sha, max) } : null })
      : null;
  // Task 9: approvals and image builds, dev deployments, snapshot requests. Each is late-bound to the execution core.
  const approvals = executionAvailable ? new ApprovalService(db, { auth, now, log, imageContext: opts?.imageContexts ?? null }) : null;
  const deployments = executionAvailable && validation ? new DeploymentService(db, { auth, now, log, validation }) : null;
  const repo = executionAvailable ? new RepoService(db, { auth, now, log, acceptFsRoot: opts?.acceptFsRoot ?? null,
    isRepository: opts?.isRepository ?? null }) : null;
  const exec = new ExecutionService(db, {
    auth, jobs, now, log, available: executionAvailable, unavailableReason, blobs,
    dataHome: opts?.dataHome ?? null, profiles: opts?.profiles ?? [], acceptFsRoot: opts?.acceptFsRoot ?? null,
    approvals: opts?.approvals !== undefined ? opts.approvals : approvals, images: approvals, deployments,
    // With main's repository check wired in, a snapshot starts only through RepoService (which runs it first).
    snapshotsNeedRepositoryCheck: !!opts?.isRepository,
    ingest, validation, appVersion: opts?.appVersion ?? null, findGit: opts?.findGit ?? null
  });
  validation?.setSender((msg) => exec.sendToRunner(msg));
  // B2b Task 14: the agent flow actions of #24 answer by whether the agent services are composed (decided below).
  let agentsOn = false;
  const queries = executionAvailable ? new ExecQueries(db, { auth, artifacts, exec, agentsAvailable: () => agentsOn }) : null;
  approvals?.bindExecution(exec);
  deployments?.bindExecution(exec);
  repo?.bindExecution(exec);
  if (executionAvailable) log('[nexus] execution core ready: runner not attached');
  const bootId = opts?.bootId ?? newId(now());
  // B2b: the agent services, only with execution on and the exact v10 shape (agents stay off by default).
  const agentsAvailable = (opts?.agents ?? false) && executionAvailable && v10ShapeProblem(db, true) === null;
  agentsOn = agentsAvailable;
  if ((opts?.agents ?? false) && !agentsAvailable) log('[nexus] agents unavailable: execution or the schema v10 shape is not in place');
  const tokens = agentsAvailable ? new TokenService(db, { auth, now, randomBytes: opts?.randomBytes }) : null;
  const budget = agentsAvailable ? new BudgetService(db, { auth, now }) : null;
  // B2b Task 5: the context file, the skill bundle and the MCP gateway. The gateway needs ExecQueries (built just
  // above, from `exec`) and so is bound into the execution core AFTER construction (bindMcpGateway), the same way
  // `validation.setSender` reaches back into it from the other side.
  const contextResolver = agentsAvailable ? new ContextResolver(db, { dataHome: opts?.dataHome ?? null, now, system: principals.system() }) : null;
  const skills = agentsAvailable ? new Skills({ dataHome: opts?.dataHome ?? null, resourcesDir: opts?.skillsResourcesDir ?? null }) : null;
  // B2b Task 10: change-set registration (the `changeset_register` tool), the session worktrees and the agent service itself.
  const changeSets = agentsAvailable ? new ChangeSetService(db, { jobs, system: principals.system(), now }) : null;
  const mcpGateway = agentsAvailable && tokens && budget && queries
    ? new McpGateway(db, { auth, tokens, budget, artifacts, jobs, changeSets, exec, queries, dataHome: opts?.dataHome ?? null,
      system: principals.system(), now, log })
    : null;
  exec.bindMcpGateway(mcpGateway);
  const worktrees = agentsAvailable ? new WorktreeService(db, { jobs, now, dataHomeRoot: opts?.dataHome?.root ?? '', acceptFsRoot: opts?.acceptFsRoot ?? null,
    onQueued: opts?.onQueued }) : null;
  // B2b Task 14: the runtime health cache the runner's probe fills; it feeds AgentService's gate unless a test passes its own provider.
  const runtimeCache = agentsAvailable ? new RuntimeHealthCache({ now, ttlMs: opts?.runtimeHealthTtlMs }) : null;
  const agents = agentsAvailable && tokens && budget && contextResolver && skills && worktrees
    ? new AgentService(db, { auth, principals, jobs, sessions, tokens, budget, contextResolver, skills, worktrees, exec, system: principals.system(), now, log,
      runtimeHealth: opts?.runtimeHealth ?? (runtimeCache ? () => runtimeCache.healthEntry() : undefined), dataHome: opts?.dataHome ?? null, onQueued: opts?.onQueued })
    : null;
  exec.bindAgents(agents);
  // B2b Task 9: the git reads (status for the accept service, diffs for the viewer) go through the runner; its answers are
  // routed to them below, at the runner port. Built with execution: a read writes nothing and runs as no job.
  const gitRead = executionAvailable ? new GitRead({ send: (m) => exec.sendToRunner(m), now }) : null;
  const turns: TurnStarter = opts?.turns ?? agents ?? {
    continueWith(): never { throw new PlatformError('unavailable', 'agents are not available yet', { reason: 'agents_unavailable' }); }
  };
  const reviews = agentsAvailable ? new ReviewService(db, { auth, principals, turns, now }) : null;
  const accepts = agentsAvailable && validation
    ? new AcceptService(db, { auth, principals, artifacts, jobs, validation, gitRead, system: principals.system(), now, acceptFsRoot: opts?.acceptFsRoot ?? null,
      onQueued: opts?.onQueued, log: (line) => log(line) })
    : null;
  // What the gateway keeps in memory for a turn (retried-call replies, call count, pending execs) goes with its tokens.
  if (tokens && mcpGateway) tokens.onRevoked((jobId) => { if (jobId === null) mcpGateway.evictAll(); else mcpGateway.evictJob(jobId); });
  // B2b Task 14: the runtime probe. The live consent's hash rides on every `probe` main sends (only a hash that verifies against
  // its own hosts), so the runner checks the engine under the allow-list proxy only after a live consent. Each `probe.result`
  // fills the health cache; a newly attached runner is unknown until its own probe answers (and an entry never outlives its TTL).
  let probePort: RunnerPort | null = null;
  const consentHash = (): string | null => {
    try {
      const c = budget?.live();
      if (!c || c.hosts.length === 0) return null;
      const hosts = c.hosts.map((h) => { const m = /^(.+):(\d{1,5})$/.exec(h); if (!m) throw new Error('bad host'); return { host: m[1], port: Number(m[2]) }; });
      return hostsSha256(hosts) === c.hostsSha256 ? c.hostsSha256 : null;
    } catch { return null; }
  };
  const agentProbe: AgentRuntimeProbe | null = runtimeCache ? {
    cache: runtimeCache,
    refresh(): boolean {
      if (!probePort) return false;
      try { probePort.send({ op: 'probe' }); return true; } catch { return false; }
    },
    async refreshAndWait(timeoutMs: number): Promise<boolean> {
      const since = now();
      if (!this.refresh()) return false;
      try { return await runtimeCache.whenRecorded(since, timeoutMs); } catch { return false; }
    }
  } : null;
  if (tokens || gitRead || runtimeCache) {
    // Every runner `ready` is a new runner process (it answers the one `hello` of its port): its MCP server is new, and
    // no token of an earlier runner may reach it. The revocation runs before the execution core sees the message.
    const attach = exec.attachRunner.bind(exec);
    exec.attachRunner = (port: RunnerPort | null, boot: string): void => {
      if (!port) { probePort = null; runtimeCache?.clear(); attach(port, boot); return; }
      runtimeCache?.clear();
      const wrapped: RunnerPort = {
        state: () => port.state(),
        send: (m) => {
          if (m.op === 'probe' && runtimeCache) { const h = consentHash(); port.send(h ? { op: 'probe', consentHostsSha256: h } : { op: 'probe' }); return; }
          port.send(m);
        },
        onMessage: (fn) => port.onMessage((raw) => {
          const op = (raw as { op?: unknown } | null)?.op;
          if (op === 'probe.result' && runtimeCache) {
            const m = parseRunnerMessage(raw);
            if (m && m.op === 'probe.result') runtimeCache.record(m.runtimes);
          }
          // B2b Task 9: a `git.read.result` answers a waiting read; the execution core never sees it.
          if (op === 'git.read.result' && gitRead) {
            const m = parseRunnerMessage(raw);
            if (m && m.op === 'git.read.result') gitRead.handle({ reqId: m.reqId, result: m.result });
            return;
          }
          if (op === 'ready' && gitRead) gitRead.failAll('the runner restarted before it answered');
          if (op === 'ready' && tokens) {
            try {
              const n = tokens.revokeLiveAgentTokens(principals.system(), 'runner_restart');
              if (n > 0) log(`[nexus] agent tokens revoked at runner ready: ${n}`);
            } catch (e) { log(`[nexus] agent tokens not revoked at runner ready (${(e as { code?: string })?.code ?? (e as Error)?.name ?? 'error'})`); }
          }
          fn(raw);
        })
      };
      probePort = wrapped;
      attach(wrapped, boot);
    };
  }
  return {
    principals, auth, activity, workspaces, projects, artifacts, lineage, jobs, sessions, handoffs, handoffsAvailable, executionAvailable,
    exec, blobs, validation, approvals, deployments, repo, queries, registry: { valid: registryValid, problems: problems.length }, bootId,
    agentsAvailable, tokens, budget, mcpGateway, contextResolver, skills, gitRead, agents, worktrees, changeSets, reviews, accepts, agentProbe,
    startup(): NexusStartupReport {
      // The seeded principals must resolve; a missing one throws platform_unavailable.
      principals.localUser();
      const system = principals.system();
      const added = workspaces.ensureCatalog(system);
      // Repairs a primary whose in-save sync failed and rows written by an older build.
      const r = workspaces.reconcileLegacyPrimaries(system);
      // No agent runtime is attached across a restart: sessions first, then the jobs.
      const s = sessions.recoverAfterRestart(system);
      // B2b: the key is new with this boot, so no earlier token verifies; their rows are revoked as well (`restart`).
      const tokensRevoked = tokens ? tokens.revokeLiveAgentTokens(system, 'restart') : null;
      // By the FILE's schema version: v9 runs restart recovery's phase A (hold mode while execution is off); v7/v8 B1's routine.
      const x = isV9File(db) ? exec.recoverPhaseA(system, bootId, now()) : null;
      const j = x ? x.jobs : jobs.recoverAfterRestart(system);
      log(`[nexus] platform ready: principals ok, workspaces added=${added}, primaries set=${r.set} cleared=${r.cleared}, `
        + `sessions interrupted=${s.interrupted}, jobs interrupted=${j.interrupted} requeued=${j.requeued}`);
      if (x) {
        log(`[nexus] execution recovery: adopted=0 finalized=0 requeued=${x.requeued} interrupted=${x.interrupted} expired=${x.expired} pending=${x.pending}`);
        if (x.held) log(`[nexus] execution recovery held: execution is off (${unavailableReason ?? 'not_enabled'}); jobs with a live attempt are left for the next start with execution on`);
        if (x.errors > 0) log(`[nexus] execution recovery: ${x.errors} decision(s) not applied; those jobs are left as they were`);
      }
      return {
        catalogAdded: added,
        primaries: { set: r.set, cleared: r.cleared },
        sessions: { interrupted: s.interrupted },
        jobs: { interrupted: j.interrupted, requeued: j.requeued },
        ...(x ? { execution: x } : {}),
        ...(tokensRevoked !== null ? { agents: { tokensRevoked } } : {})
      };
    }
  };
}
