// The one place the renderer calls the nexus:* preload methods. Every call answers
// a NexusResult; a rejected invoke or a malformed answer becomes
// { ok: false, code: 'internal' }, so callers never need a try/catch. No React.
import type {
  ActionAvailabilityView, ActionsQuery, ApprovalDecisionArg, ApprovalView, ApprovalsListFilter, BlobGcArgs, BlobGcView, DeploymentView,
  DeploymentsListFilter, DomainSpecView, EventsPageView, EventsQuery, HealthView, ImageProfileArg, InlineSaveView, JobDetailView, JobLogsQuery,
  JobStartArgs, JobStartView, JobView, JobsListFilter, LogPageView, NexusHint, PreviewQuery, PreviewView, SaveInlineArgs, ValidationResultView,
  ActivityPage, ActivityView, ArtifactDetail, ArtifactSummaryView, ArtifactsListFilter, HandoffDetailView, HandoffSummaryView,
  HandoffsListFilter, LineageQuery, LineageView, LinkSourcesView, NexusFail, NexusResult, ParticipationView, SaveCommitArgs,
  SaveResultView, SaveTextFileArgs, SendHandoffArgs, SendHandoffView, VersionDetail, VersionView,
  AcceptResultView, AgentConsentArgs, AgentSetupView, AgentStartArgs, AgentStartResultView, MergeView, RepoMergeArgs, RepoStatusView,
  ReviewDecideArgs, ReviewResultView, SessionDetailView, SessionView, SessionsListFilter
} from '@shared/nexus/ipc';

const INTERNAL: NexusFail = { ok: false, code: 'internal', message: 'The request could not be completed.' };

async function call<T>(run: () => Promise<NexusResult<T>>): Promise<NexusResult<T>> {
  try {
    const r = await run();
    if (r && typeof r === 'object' && (r.ok === true || (r.ok === false && typeof r.code === 'string'))) return r;
    return INTERNAL;
  } catch {
    return INTERNAL;
  }
}

/**
 * B2a execution channels (#22-#41). Until main registers them (the deferred index.ts edit) the invoke rejects with
 * "no handler"; that is not a passing failure but "execution is not connected", so the screen shows the honest
 * notice instead of "try again". The sub-reason `unreachable` is the renderer's own word for it.
 */
export const EXECUTION_UNREACHABLE: NexusFail = {
  ok: false, code: 'platform_unavailable', reason: 'execution_unavailable', subReason: 'unreachable', message: 'Execution did not answer.'
};

async function execCall<T>(run: () => Promise<NexusResult<T>>): Promise<NexusResult<T>> {
  try {
    const r = await run();
    if (r && typeof r === 'object' && (r.ok === true || (r.ok === false && typeof r.code === 'string'))) return r;
    return INTERNAL;
  } catch {
    return EXECUTION_UNREACHABLE;
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID minted once per user intent (main refuses a second job for the same intent). */
export function newIntentId(at: number = Date.now()): string {
  let t = Math.max(0, Math.floor(at));
  let time = '';
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] & 31];
  return time + rand;
}

/** A dev deployment's loopback address, exactly `http://127.0.0.1:<port>`; anything else is refused before any call. */
export const LOOPBACK_URL_RE = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

/** Opens a dev deployment's address in the browser (main's allow-list checks it again). Never throws. */
export async function openLoopbackUrl(url: string): Promise<{ ok: boolean }> {
  const m = LOOPBACK_URL_RE.exec(url);
  if (!m || Number(m[1]) > 65535) return { ok: false };
  try {
    const r = await window.cth.openExternal(url);
    return { ok: !!r && r.ok === true };
  } catch {
    return { ok: false };
  }
}

export const nexusClient = {
  participationsList: (): Promise<NexusResult<ParticipationView[]>> => call(() => window.cth.nexusParticipationsList()),
  participationAttach: (projectId: string, workspaceId: string): Promise<NexusResult<ParticipationView>> =>
    call(() => window.cth.nexusParticipationAttach(projectId, workspaceId)),
  participationWithdraw: (participationId: string): Promise<NexusResult<ParticipationView>> =>
    call(() => window.cth.nexusParticipationWithdraw(participationId)),
  artifactsList: (filter?: ArtifactsListFilter): Promise<NexusResult<ArtifactSummaryView[]>> => call(() => window.cth.nexusArtifactsList(filter)),
  artifactsByProject: (projectId: string): Promise<NexusResult<ArtifactSummaryView[]>> => call(() => window.cth.nexusArtifactsByProject(projectId)),
  artifactGet: (artifactId: string): Promise<NexusResult<ArtifactDetail>> => call(() => window.cth.nexusArtifactGet(artifactId)),
  versionGet: (versionId: string): Promise<NexusResult<VersionDetail>> => call(() => window.cth.nexusVersionGet(versionId)),
  lineageGet: (versionId: string, query: LineageQuery): Promise<NexusResult<LineageView>> => call(() => window.cth.nexusLineageGet(versionId, query)),
  artifactSaveCommit: (args: SaveCommitArgs): Promise<NexusResult<SaveResultView>> => call(() => window.cth.nexusArtifactSaveCommit(args)),
  artifactSaveTextFile: (args: SaveTextFileArgs): Promise<NexusResult<SaveResultView>> => call(() => window.cth.nexusArtifactSaveTextFile(args)),
  versionMarkReady: (versionId: string): Promise<NexusResult<VersionView>> => call(() => window.cth.nexusVersionMarkReady(versionId)),
  versionPromote: (versionId: string, expectedCurrentVersionId: string | null): Promise<NexusResult<VersionView>> =>
    call(() => window.cth.nexusVersionPromote(versionId, expectedCurrentVersionId)),
  versionDiscard: (versionId: string): Promise<NexusResult<VersionView>> => call(() => window.cth.nexusVersionDiscard(versionId)),
  versionLinkSources: (versionId: string, sourceVersionIds: string[]): Promise<NexusResult<LinkSourcesView>> =>
    call(() => window.cth.nexusVersionLinkSources(versionId, sourceVersionIds)),
  handoffsList: (filter?: HandoffsListFilter): Promise<NexusResult<HandoffSummaryView[]>> => call(() => window.cth.nexusHandoffsList(filter)),
  handoffGet: (handoffId: string): Promise<NexusResult<HandoffDetailView>> => call(() => window.cth.nexusHandoffGet(handoffId)),
  handoffSend: (args: SendHandoffArgs): Promise<NexusResult<SendHandoffView>> => call(() => window.cth.nexusHandoffSend(args)),
  handoffAccept: (handoffId: string): Promise<NexusResult<HandoffDetailView>> => call(() => window.cth.nexusHandoffAccept(handoffId)),
  handoffDecline: (handoffId: string, note?: string): Promise<NexusResult<HandoffDetailView>> => call(() => window.cth.nexusHandoffDecline(handoffId, note)),
  handoffWithdraw: (handoffId: string): Promise<NexusResult<HandoffDetailView>> => call(() => window.cth.nexusHandoffWithdraw(handoffId)),
  activityByProject: (projectId: string, page?: ActivityPage): Promise<NexusResult<ActivityView[]>> =>
    call(() => window.cth.nexusActivityByProject(projectId, page)),
  // ---------- B2a execution (#22-#41) ----------
  domainsList: (): Promise<NexusResult<DomainSpecView[]>> => execCall(() => window.cth.nexusDomainsList()),
  platformHealth: (): Promise<NexusResult<HealthView>> => execCall(() => window.cth.nexusPlatformHealth()),
  /** #23 with `{ probe: true }`: also asks main to probe this computer again now (rate-limited there; not waited for). */
  platformHealthProbe: (): Promise<NexusResult<HealthView>> => execCall(() => window.cth.nexusPlatformHealth({ probe: true })),
  actionsAvailable: (q: ActionsQuery): Promise<NexusResult<ActionAvailabilityView[]>> => execCall(() => window.cth.nexusActionsAvailable(q)),
  jobStart: (args: JobStartArgs): Promise<NexusResult<JobStartView>> => execCall(() => window.cth.nexusJobStart(args)),
  jobsList: (filter?: JobsListFilter): Promise<NexusResult<JobView[]>> => execCall(() => window.cth.nexusJobsList(filter)),
  jobGet: (jobId: string): Promise<NexusResult<JobDetailView>> => execCall(() => window.cth.nexusJobGet(jobId)),
  jobLogs: (jobId: string, q: JobLogsQuery): Promise<NexusResult<LogPageView>> => execCall(() => window.cth.nexusJobLogs(jobId, q)),
  jobCancel: (jobId: string): Promise<NexusResult<JobView>> => execCall(() => window.cth.nexusJobCancel(jobId)),
  jobRetry: (jobId: string, intentId: string): Promise<NexusResult<{ job: JobView }>> => execCall(() => window.cth.nexusJobRetry(jobId, intentId)),
  eventsSince: (q: EventsQuery): Promise<NexusResult<EventsPageView>> => execCall(() => window.cth.nexusEventsSince(q)),
  versionValidations: (versionId: string): Promise<NexusResult<ValidationResultView[]>> => execCall(() => window.cth.nexusVersionValidations(versionId)),
  versionRevalidate: (versionId: string, intentId: string): Promise<NexusResult<{ jobs: JobView[] }>> =>
    execCall(() => window.cth.nexusVersionRevalidate(versionId, intentId)),
  versionPreview: (versionId: string, q: PreviewQuery): Promise<NexusResult<PreviewView>> => execCall(() => window.cth.nexusVersionPreview(versionId, q)),
  artifactSaveInline: (args: SaveInlineArgs): Promise<NexusResult<InlineSaveView>> => execCall(() => window.cth.nexusArtifactSaveInline(args)),
  deploymentsList: (filter?: DeploymentsListFilter): Promise<NexusResult<DeploymentView[]>> => execCall(() => window.cth.nexusDeploymentsList(filter)),
  deploymentStop: (deploymentId: string): Promise<NexusResult<DeploymentView>> => execCall(() => window.cth.nexusDeploymentStop(deploymentId)),
  approvalsList: (filter?: ApprovalsListFilter): Promise<NexusResult<ApprovalView[]>> => execCall(() => window.cth.nexusApprovalsList(filter)),
  approvalRespond: (approvalId: string, decision: ApprovalDecisionArg): Promise<NexusResult<ApprovalView>> =>
    execCall(() => window.cth.nexusApprovalRespond(approvalId, decision)),
  setupPrepareImage: (profile: ImageProfileArg, intentId: string): Promise<NexusResult<{ approval: ApprovalView; created: boolean }>> =>
    execCall(() => window.cth.nexusSetupPrepareImage(profile, intentId)),
  blobsGc: (args: BlobGcArgs): Promise<NexusResult<BlobGcView>> => execCall(() => window.cth.nexusBlobsGc(args)),
  // ---------- B2b agent flow (#42-#51): ids, enums and small values only; the answers carry no host, path or token ----------
  agentStart: (args: AgentStartArgs): Promise<NexusResult<AgentStartResultView>> => execCall(() => window.cth.nexusAgentStart(args)),
  sessionsList: (filter: SessionsListFilter): Promise<NexusResult<SessionView[]>> => execCall(() => window.cth.nexusSessionsList(filter)),
  sessionGet: (sessionId: string): Promise<NexusResult<SessionDetailView>> => execCall(() => window.cth.nexusSessionGet(sessionId)),
  sessionEnd: (sessionId: string): Promise<NexusResult<SessionView>> => execCall(() => window.cth.nexusSessionEnd(sessionId)),
  sessionCancel: (sessionId: string): Promise<NexusResult<SessionView>> => execCall(() => window.cth.nexusSessionCancel(sessionId)),
  reviewDecide: (versionId: string, args: ReviewDecideArgs, intentId: string): Promise<NexusResult<ReviewResultView>> =>
    execCall(() => window.cth.nexusReviewDecide(versionId, args, intentId)),
  changeSetAccept: (versionId: string, expectedIntegrationHead: string): Promise<NexusResult<AcceptResultView>> =>
    execCall(() => window.cth.nexusChangeSetAccept(versionId, expectedIntegrationHead)),
  repoStatus: (projectId: string): Promise<NexusResult<RepoStatusView>> => execCall(() => window.cth.nexusRepoStatus(projectId)),
  /** #50: main shows the real confirmation dialog; this only asks. The answer is the result sentence's source. */
  repoMergeAccepted: (projectId: string, args: RepoMergeArgs): Promise<NexusResult<MergeView>> =>
    execCall(() => window.cth.nexusRepoMergeAccepted(projectId, args)),
  agentConsent: (args: AgentConsentArgs): Promise<NexusResult<AgentSetupView>> => execCall(() => window.cth.nexusAgentConsent(args)),
  /** The nexus:hint push (the newest event seq only). Returns an unsubscribe; a no-op when the preload has none. */
  onHint: (cb: (hint: NexusHint) => void): (() => void) => {
    try {
      const sub = window.cth.onNexusHint;
      return typeof sub === 'function' ? sub(cb) : () => undefined;
    } catch {
      return () => undefined;
    }
  }
};

export type NexusClient = typeof nexusClient;
