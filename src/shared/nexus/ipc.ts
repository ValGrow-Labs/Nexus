// The nexus:* IPC contract (types only): the result envelope, its error codes, and every
// view and request shape the preload exposes. Nothing here has a runtime value, so the
// preload imports it with `import type` and main and renderer share one definition.
//
// Identity never crosses this boundary from the renderer: no request shape names a
// principal, an actor, a role or a folder. Main resolves the principal on every call.
import type {
  ActivityStatus, AgentSessionStatus, ApprovalStatus, ArtifactId, DeploymentStatus, HandoffId, HandoffStatus, JobId, JobKind, JobState,
  LineageRelation, ParticipationId, ParticipationStatus, PlatformErrorCode, PrincipalKind, ProjectId, SessionId, VersionId, VersionStatus,
  WorkspaceId
} from './platform';
import type { DomainTier, StepStatus, SubPhase } from './domainSpec';

/** Why the whole platform is unavailable (every channel answers platform_unavailable with this reason). */
export type PlatformUnavailableReason = 'held' | 'migration_failed' | 'newer_schema' | 'shape_mismatch' | 'startup_failed' | 'not_open';
/** Why handoffs alone are off while the platform is up (the sub-reason of 'handoffs_unavailable'). */
export type HandoffsUnavailableSubReason = 'held' | 'auto_held' | 'backup_failed' | 'failed' | 'shape';
/**
 * Why execution (schema v9) is off while the platform is up: the sub-reason of 'execution_unavailable' (B2a). The
 * store's reasons (as for handoffs), plus: execution not turned on in this build (`not_enabled`), v8 not in place
 * (`v8_unavailable`), the domain registry failed its startup check (`registry_invalid`), and the execution wiring not
 * started in main (`not_started`: the runner host and the data home readers do not exist yet).
 */
export type ExecutionUnavailableSubReason = 'held' | 'auto_held' | 'backup_failed' | 'failed' | 'shape' | 'not_enabled'
  | 'v8_unavailable' | 'registry_invalid' | 'not_started';
/**
 * The `reason` of a platform_unavailable answer. 'busy': another writer held the database lock past the busy
 * timeout; nothing was written and the same request may be sent again. 'execution_unavailable' (B2a): the channel
 * needs schema v9 execution, which is off (with its sub-reason); the B1 channels and #22/#23 still answer.
 */
export type UnavailableReason = PlatformUnavailableReason | 'handoffs_unavailable' | 'execution_unavailable' | 'agents_unavailable' | 'busy';
/**
 * Why the agents part (schema v10) is off while the platform is up: the sub-reason of 'agents_unavailable' (B2b). The same
 * words as the execution sub-reasons (`not_enabled` while v10 is not turned on; execution's own reason while execution is off).
 */
export type AgentsUnavailableSubReason = ExecutionUnavailableSubReason;

export type NexusErrorCode = PlatformErrorCode | 'internal';

/** The keys a failure's `detail` may carry; everything else is dropped in main. */
export type NexusErrorDetailKey = 'currentVersionId' | 'handoffId' | 'versionId' | 'participationId' | 'liveJobs'
  | 'liveSessions' | 'openHandoffs' | 'existingId' | 'limit'
  // B2a Task 13: the records a refusal names, and the numbers of a setup:* answer (the disk gate).
  | 'jobId' | 'approvalId' | 'deploymentId' | 'setup' | 'freeBytes' | 'requiredBytes'
  // B2b Task 14: a refused accept names the integration head it found (`current`, 40 hex) and says when its rollback is still owed.
  | 'current' | 'rollbackOwed';

export type NexusOk<T> = { ok: true; data: T; truncated?: boolean };
export type NexusFail = {
  ok: false; code: NexusErrorCode; message: string;
  /** A machine-readable refinement: an unavailable reason, 'bad_request', or a service reason such as 'path_refused'. */
  reason?: string;
  /** With reason 'handoffs_unavailable': why v8 is not in place; with 'execution_unavailable': why execution is off. */
  subReason?: string;
  /** With reason 'bad_request': the request field that was refused. */
  field?: string;
  detail?: Partial<Record<NexusErrorDetailKey, string | number | boolean | null>>;
};
/**
 * Every nexus:* channel answers with this; it never rejects. `truncated` is set on list
 * answers: true when more rows exist than were returned (a service cap or the limit).
 */
export type NexusResult<T> = NexusOk<T> | NexusFail;

// ---------- views (what main sends) ----------

export interface ParticipationView {
  id: ParticipationId; projectId: ProjectId; workspaceId: WorkspaceId; status: ParticipationStatus; isPrimary: boolean;
  objective: string | null; source: 'backfill' | 'legacy_domain' | 'user'; createdAt: number; updatedAt: number;
}
export interface ArtifactView {
  id: ArtifactId; projectId: ProjectId; kind: string; name: string; description: string | null;
  ownerScope: 'participation' | 'project'; ownerParticipationId: ParticipationId | null; ownerWorkspaceId: WorkspaceId | null;
  status: 'active' | 'archived'; currentVersionId: VersionId | null; createdAt: number; updatedAt: number;
}
export interface ArtifactSummaryView {
  artifact: ArtifactView; versionCount: number;
  latest: { id: VersionId; versionNo: number; status: VersionStatus } | null;
  current: { id: VersionId; versionNo: number } | null;
}
/** A version without its content or storage. */
export interface VersionView {
  id: VersionId; artifactId: ArtifactId; versionNo: number; projectId: ProjectId; participationId: ParticipationId | null;
  status: VersionStatus; draftFlag: 'cancelled_partial' | null; storageKind: 'git' | 'blob' | 'tree' | 'external' | 'inline';
  contentHash: string; validationState: 'pending' | 'passed' | 'failed' | 'error';
  /** True when a job or an agent session produced the draft (mark ready is then the engine's, not the user's). */
  producedByEngine: boolean; producedByAction: string | null;
  createdAt: number; statusChangedAt: number; promotedAt: number | null;
  /**
   * B2b: for a `change_set` version only (the field is absent for every other kind): the newest review's decision and when it was
   * made (ISO time), or null when it was never reviewed. No comment text, no reviewer id. Accept is offered only for `approve`.
   */
  latestReview?: { decision: ReviewDecision; decidedAt: string } | null;
  /**
   * B2b A1, change sets only (absent for every other kind): whether Nexus's own preview shows the WHOLE change. Only an explicit
   * `true` is complete (a version with no record of it is not); `previewReason` says why not, as a closed code. An approval is
   * refused (`preview_incomplete`) unless this is true; asking for changes and rejecting never are.
   */
  previewComplete?: boolean;
  previewReason?: 'hidden_lines' | 'too_large' | 'truncated' | 'binary_file' | 'unknown' | null;
}
/** What a version holds: the commit of a git version, the text of a saved text file, a receipt's handoff. */
export type VersionContent =
  | { type: 'git'; commit: string }
  | { type: 'text'; path: string; text: string }
  | { type: 'receipt'; handoffId: HandoffId }
  | { type: 'none' };
export interface VersionDetail extends VersionView { content: VersionContent }
export interface ArtifactDetail { artifact: ArtifactView; versions: VersionView[] }
export interface LineageNodeView {
  versionId: VersionId; artifactId: ArtifactId; kind: string; versionNo: number; status: VersionStatus; depth: number; relation: LineageRelation;
}
export interface LineageView { nodes: LineageNodeView[]; truncated: boolean }
export interface EdgeView {
  id: string; fromVersionId: VersionId; toVersionId: VersionId; relation: LineageRelation;
  source: 'job_input' | 'ingest' | 'user_action' | 'handoff_convert'; createdAt: number;
}
export interface HandoffSummaryView {
  id: HandoffId; projectId: ProjectId; fromParticipationId: ParticipationId; fromWorkspaceId: WorkspaceId;
  toParticipationId: ParticipationId; toWorkspaceId: WorkspaceId; title: string; note: string | null; subjectCount: number;
  status: HandoffStatus; respondedAt: number | null; responseNote: string | null; receiptVersionId: VersionId | null;
  createdAt: number; updatedAt: number; statusChangedAt: number;
}
export interface HandoffSubjectView {
  versionId: VersionId; position: number; contentHash: string; artifactId: ArtifactId; artifactName: string; kind: string;
  versionNo: number; status: VersionStatus; newerVersionNo: number | null;
}
export interface HandoffDetailView extends HandoffSummaryView { subjects: HandoffSubjectView[] }
/** Activity details reduced to an allow-list of small scalar values. */
export type ActivityDetailsView = Record<string, string | number | boolean | null>;
export interface ActivityView {
  seq: number; ts: number; action: string; status: ActivityStatus; actorKind: PrincipalKind;
  /** True when the system acted on the user's behalf (for example mark ready). */
  onBehalfOfUser: boolean;
  entityType: string; entityId: string | null; projectId: ProjectId | null; workspaceId: WorkspaceId | null;
  artifactId: ArtifactId | null; versionId: VersionId | null; details: ActivityDetailsView;
}
export interface SaveResultView { artifact: ArtifactView; version: VersionView; created: boolean }
export interface LinkSourcesView { edges: EdgeView[]; created: number }
export interface SendHandoffView { handoff: HandoffDetailView; created: boolean }

// ---------- B2a execution views (channels #22-#41) ----------
// The same rules as above: built field by field in main (nexusIpc/dto.ts); no principal id, no host path, no raw
// metadata, no env value; strings scrubbed and capped; image ids shortened to `sha256:` + 12 hex characters.

/** One lifecycle step of a domain: its position, status in this build and what it needs. Never a result. */
export interface LifecycleStepView {
  id: string; label: string; status: StepStatus;
  /** For PARTIAL the scope limit; for FUTURE why it is not in this build. */
  scopeNote: string | null;
  subPhase: SubPhase;
  /** True when the step is REAL or PARTIAL and delivered in this build's sub-phase. */
  delivered: boolean;
  consumes: string[]; produces: string[]; prerequisites: string[];
  /** The user actions that work toward the step (ids; their availability is #24). */
  actions: string[];
}
export interface DomainSpecView {
  id: string; label: string; shortLabel: string; description: string; tier: DomainTier; hueSlot: number; icon: string; order: number;
  statusNote: string;
  /** Kind words in the domain's own language. */
  vocabulary: Record<string, { singular: string; plural: string }>;
  lifecycle: LifecycleStepView[];
  modules: { id: string; label: string; kinds: string[]; subPhase: SubPhase }[];
  /** The sub-phase from which a project can take part in the domain. */
  availableFromSubPhase: SubPhase;
  /** The delivered sub-phase (DELIVERED_SUB_PHASE): what this build has proven end to end. Every claim the rail
   *  derives from it (future, delivered, the summary) is a delivery claim; it is not the registry's CURRENT_SUB_PHASE. */
  currentSubPhase: SubPhase;
  /** True only when every step of every completion rule runs in this build (never claimed otherwise). */
  executableEndToEnd: boolean;
}
export type DiskGate = 'ok' | 'below_recommended' | 'below_required' | 'unknown';
/** #23's optional argument: `{ probe: true }` also asks main for a fresh probe of this computer (the setup sheet's
 *  "Check again"; rate-limited in main, never waited for: the answer is still main's cache). */
export interface HealthQuery { probe: true }
/** The execution setup as main last observed it (cached; reading it never waits on Docker or the runner). */
export interface HealthView {
  db: { version: number | null; platform: boolean; handoffs: boolean; execution: boolean; subReason?: string };
  /** The domain registry's startup check: when it fails, execution stays off (`registry_invalid`). */
  registry: { valid: boolean; problems: number };
  runner: { state: string; attached: boolean; restarts: number };
  docker: { state: 'unknown' | 'missing' | 'stopped' | 'running'; version?: string; os?: string; wsl2?: boolean; cpus?: number; memoryBytes?: number };
  images: { profile: string; present: boolean; matches: boolean; sizeBytes?: number; imageIdShort?: string }[];
  disk: { dataHomeFreeBytes: number | null; requiredBytes: number; recommendedBytes: number; leaseFloorBytes: number; gate: DiskGate };
  /** The gate's problems as ids (`disk_low`, `docker_stopped`, `image_missing:sde-node`, ...), advisory ones included. */
  problems: string[];
  gpu: { detected: boolean; model?: string; supported: false };
  checkedAt: number | null;
  /** B2b: the agent setup row, from main's cache (hosts are never in it; its label is for the setup row only). */
  agent: AgentSetupView;
}
/**
 * An action as the user may see it now. `reason` when not available: `planned` (a later sub-phase), `future` (its
 * step is FUTURE), `setup:<id>` (this machine: Docker, an image, the disk gate, the runner), `permission`,
 * `blocked_by_step:<stepId>` (an input the step produces is missing), `not_applicable` (the version given is not an
 * input it takes, or there is nothing for it to act on), `agents_unavailable` (B2b: an agent flow while the agents part
 * of the platform is off).
 */
export interface ActionAvailabilityView {
  actionId: string; label: string; stepId: string | null; available: boolean; reason: string | null;
  /** The input slots the action takes (kinds by id; the version picker offers candidate or active versions). */
  inputs: { slot: string; kinds: string[]; min: number; max: number }[];
  /** True when the action needs the network once (an approval is asked before anything is downloaded). */
  needsApproval: boolean;
}
export type JobHeadline =
  | 'queued' | 'waiting:runner' | 'waiting:docker' | 'waiting:image' | 'waiting:disk' | 'waiting:slots' | 'waiting:memory'
  | 'waiting:git' | 'waiting:retry' | 'provisioning' | 'running' | 'waiting_for_approval' | 'collecting' | 'validating'
  | 'checks_passed' | 'checks_failed' | 'checks_could_not_run' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
/** A job without its params, principals or host facts. `headline` is never a bare "completed" for a run whose checks failed. */
export interface JobView {
  id: JobId; kind: JobKind; projectId: ProjectId; workspaceId: WorkspaceId; actionId: string | null; recipeId: string | null;
  state: JobState; phase: string | null; headline: JobHeadline; outcome: string | null; error: { code: string; message: string } | null;
  attempts: number; retryOf: JobId | null; parentJobId: JobId | null;
  /** Who asked: the user, or the system on the user's behalf (a check, a recovery); never an id. */
  requestedByKind: PrincipalKind;
  inputs: { versionId: VersionId; slot: string; contentHash: string }[];
  createdAt: number; updatedAt: number; startedAt: number | null; finishedAt: number | null; nextAttemptAt: number | null;
  cancelRequested: boolean;
}
export interface AttemptSummaryView {
  /** The attempt's own id (B2a final review): a diagnostic report's log range names it, so a link opens exactly that attempt. */
  id: string;
  n: number; state: string; outcome: string | null; exitCode: number | null; signal: string | null; oomKilled: boolean | null;
  /** The network mode the attempt ran with (`none`, `egress-approved`, `service-internal`, `not-applicable`). */
  network: string | null;
  preflight: { ok: boolean; problems: string[] } | null;
  /** The sandbox image, shortened (`sha256:` + 12 hex). */
  imageIdShort: string | null; profile: string | null;
  error: { code: string; message: string } | null;
  createdAt: number; startedAt: number | null; finishedAt: number | null;
}
export interface JobDetailView extends JobView {
  attemptHistory: AttemptSummaryView[];
  outputs: { versionId: VersionId; status: VersionStatus }[];
  approvals: { id: string; status: ApprovalStatus; reason: string; expiresAt: number }[];
  deployment: { id: string; status: DeploymentStatus } | null;
}
export interface EventView {
  seq: number; ts: number; type: string; summary: string; projectId: ProjectId | null; jobId: JobId | null; attemptN: number | null;
}
export interface EventsPageView { events: EventView[]; lastSeq: number }
/**
 * One validator on a version. `status` is the LATEST BLOCKING row's (what the version's state reads); `latestRun` is
 * the newest advisory result (a user's run on a candidate, a deduplicated output): a run result, never the status.
 */
export interface ValidationResultView {
  validatorId: string; blocking: boolean;
  status: 'passed' | 'failed' | 'error' | 'skipped' | null;
  summary: string | null; finishedAt: number | null;
  /** The evidence of the latest blocking row: typed facts only (counts, hashes, names), each string capped. */
  evidence: { type: string; name: string | null; value: string | number | boolean | null }[];
  /** The newest advisory result, if any (a run result; it never sets `status`). */
  latestRun: { status: 'passed' | 'failed' | 'error' | 'skipped'; summary: string; finishedAt: number } | null;
  /** Every row recorded for this validator on the version, blocking and advisory. */
  history: number;
}
export type PreviewPart = 'content' | 'manifest' | 'discovery' | 'junit_summary' | 'diff';
export interface PreviewView {
  part: PreviewPart; versionId: VersionId;
  /**
   * `diff` (B2b, change sets only): the patch between the change set's recorded base and head, redacted whole and paged like
   * `content`; a diff larger than 1 MiB per side answers `too_large`.
   * A page of text (redacted whole, then paged: `page` / `nextPage`; a cut never splits a character), or of rows
   * (manifest files, discovered tests, the JUnit table: counts, then failed cases, then errored ones) paged by a row
   * cursor: `fromRow` / `nextRow` (the first row not returned; null at the end).
   */
  text: string | null;
  rows: { name: string; detail: string | null; bytes: number | null; outcome: string | null }[] | null;
  page: number | null; nextPage: number | null; fromRow: number | null; nextRow: number | null; totalRows: number | null; totalBytes: number | null;
}
export interface LogPageView { text: string; nextOffset: number; eof: boolean; truncatedMiddle: boolean }
export interface DeploymentView {
  id: string; projectId: ProjectId; subjectVersionId: VersionId; jobId: JobId; status: DeploymentStatus; stopReason: string | null;
  /** `http://127.0.0.1:<port><healthPath>` while live, else null. */
  url: string | null; bindAddress: string; hostPort: number | null; healthPath: string | null;
  lastProbe: { at: number; status: number | null; ms: number | null } | null; probes: number;
  startedAt: number; stoppedAt: number | null; endsAt: number;
}
export interface ApprovalView {
  id: string; projectId: ProjectId | null; jobId: JobId | null; reason: string; summary: string; status: ApprovalStatus;
  /** Exactly what is asked: the recipe or image profile, the registries, the hashes it is bound to, the size. */
  request: { recipeId?: string; profile?: string; registries?: string[]; lockfileSha256?: string; contextSha256?: string;
    baseDigest?: string; estimatedBytes?: number; freeBytesNow?: number | null };
  requestedAt: number; expiresAt: number; decidedAt: number | null; decision: 'once' | 'deny' | null; consumedAt: number | null;
  imageBuild: { id: string; status: string; imageIdShort: string | null; sizeBytes: number | null; error: string | null } | null;
}
export interface JobStartView { job: JobView; created: boolean }
export interface InlineSaveView { artifact: ArtifactView; version: VersionView; created: boolean }
export interface BlobGcView {
  /** Blobs no version references any more (dry run: what would go; apply: what went). */
  candidates: number; bytes: number; candidatesHash: string; removed: number;
  /** Object files that could not be removed (reported, never retried blind). */
  fileDeleteFailed: number;
}

// ---------- B2b agent views (channels #42-#51) ----------
// Built field by field in main, like the B2a views. No view carries a host, a model id, a token, a path (no worktree,
// config folder or repository folder), a pid, a container id or a principal id. Display text is redacted and capped.
// The engine's display name appears only in AgentSetupView.label (the setup row, D-B9); every other view says "the
// agent". Usage and cost are what the runtime reported, or `estimated` when Nexus charged the cap.

/** One turn's usage as reported by the agent runtime (cost in US cents; null when it reported none). */
export interface AgentUsageView {
  inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number;
  costUsdCents: number | null; toolCalls: number;
  /** True when the cost is Nexus's charge at the turn cap (the runtime reported none). */
  estimated: boolean;
}
export interface SessionView {
  id: SessionId; projectId: ProjectId; workspaceId: WorkspaceId; status: AgentSessionStatus;
  turns: number;
  /** The turn job running now, if any. */
  liveJobId: JobId | null;
  createdAt: number; updatedAt: number;
}
export interface SessionTurnView {
  jobId: JobId; state: JobState; headline: JobHeadline; outcome: string | null; error: { code: string; message: string } | null;
  usage: AgentUsageView | null;
  createdAt: number; startedAt: number | null; finishedAt: number | null;
}
/** A message of the session log: display only, never evidence. */
export interface SessionMessageView { seq: number; ts: number; from: 'user' | 'agent'; text: string; displayOnly: true }
/** A tool call of a turn: its name and result size, never its arguments or result text. */
export interface SessionToolCallView { seq: number; ts: number; jobId: JobId; tool: string; ok: boolean | null; resultBytes: number | null }
export interface SessionDetailView extends SessionView {
  turnHistory: SessionTurnView[];
  messages: SessionMessageView[];
  toolCalls: SessionToolCallView[];
  /** The versions the session's turns registered. */
  versions: { versionId: VersionId; kind: string; status: VersionStatus }[];
  approvals: { id: string; status: ApprovalStatus; reason: string; expiresAt: number }[];
}
export type ReviewDecision = 'approve' | 'request_changes' | 'reject';
export interface ReviewView {
  id: string; versionId: VersionId; decision: ReviewDecision;
  /** The reviewer's comment (redacted); required for request_changes and reject. */
  comment: string | null;
  /** Reviews are made by people only. */
  reviewerKind: 'user';
  createdAt: number;
  /** The agent turn a request_changes started, if any. */
  jobId: JobId | null;
}
/** A change merged into the integration ref (`refs/nexus/accepted/<branch>`): commits and a ref name, never a folder. */
export interface ChangeSetAcceptView {
  versionId: VersionId; integrationRef: string; refBefore: string; refAfter: string; mergeCommit: string; acceptedAt: number;
}
export interface RepoStatusView {
  projectId: ProjectId;
  /** The checked-out branch, its head and whether the working tree has uncommitted changes (null when unknown). */
  branch: string | null; head: string | null; dirty: boolean | null;
  integrationRef: string | null;
  /** The integration ref's head: the commit #48 expects and #50 shows (equal to the newest accept's commit once something was accepted). */
  acceptedHead: string | null;
  /** Accepted commits not yet on the branch. */
  acceptedNotMerged: number;
  /** True when "Merge accepted work" can fast-forward now. */
  canFastForward: boolean;
  /** Why it cannot (`tree_dirty`, `branch_mismatch`, `not_fast_forward`, `nothing_to_merge`, `git_missing`, ...), or null. */
  reason: string | null;
  checkedAt: number | null;
}
export interface MergeView { projectId: ProjectId; branch: string; before: string; after: string; mergedAt: number }
/** `off`: agent work is not in place in this build or on this database (nothing to check or set up); `unavailable`: the program could not be checked. */
export type AgentSetupState = 'ready' | 'not_installed' | 'not_signed_in' | 'version_unsupported' | 'unavailable' | 'unknown' | 'off';
/** The agent setup row (#23's `agent` and #51). */
export interface AgentSetupView {
  state: AgentSetupState;
  /**
   * Only with state `off`: why agent work is not in place, in the words of main's own reasons: `build` (not turned on in this
   * build), `database` (the newer database format is not applied), `held` (that upgrade is on hold), `execution` (running jobs is
   * not available). Absent or null otherwise; an older answer without it reads as `build`.
   */
  offReason?: 'build' | 'database' | 'held' | 'execution' | null;
  /** The engine's display name: shown on the setup row only. */
  label: string | null;
  version: string | null;
  signedIn: 'yes' | 'no' | 'unknown';
  /** False when a flag Nexus pins is missing from the installed version (it then reads as unsupported). */
  flagsOk: boolean | null;
  /** The live network permission: its caps and how many destinations it grants (the destinations are not in a view). */
  consent: { live: boolean; caps: { turnUsdCents: number; dayUsdCents: number; turnsPerHour: number; concurrentTurns: number;
    turnTokens: number; toolCalls: number; wallClockMs: number; childJobs: number } | null; hostsCount: number; grantedAt: number | null };
  /** Today's usage: cost in US cents (reported, or estimated at the cap where none was reported) and turns started. */
  usageToday: { usdCents: number; turns: number; estimated: boolean };
}
/**
 * #51's answer (get, grant and revoke): the setup row plus, in its consent row ONLY, the destinations the permission covers
 * (F24). `hosts` are `host:port` strings: the live consent's own, or, with none, the ones the runtime's probe reported (what a
 * grant would cover). No other view carries them: #23's `agent` keeps `hostsCount` and nothing else.
 * `get` never waits for the runtime check: on a first open (or with a stale answer) it returns `hosts: []` (and `state: 'unknown'`)
 * while it asks for the check in the background, so a caller re-fetches once the check has landed (a moment later, or after #23's
 * "Check again"). With a fresh answer, `hosts` is filled BEFORE any consent exists, so the Grant button can name the destination.
 */
export interface AgentConsentView extends AgentSetupView {
  consent: AgentSetupView['consent'] & { hosts: string[] };
}

// ---------- requests (what the renderer sends: ids and small values only) ----------

export interface ArtifactsListFilter {
  projectId?: ProjectId; workspaceId?: WorkspaceId; kind?: string; status?: 'active' | 'archived'; limit?: number;
}
export interface LineageQuery { direction: 'up' | 'down'; depth?: number }
export interface HandoffsListFilter {
  projectId?: ProjectId; workspaceId?: WorkspaceId; box?: 'inbox' | 'sent' | 'all'; status?: HandoffStatus; limit?: number;
}
export interface ActivityPage { beforeSeq?: number; limit?: number }
export type SaveTargetArg = { artifactId: ArtifactId } | { name: string };
export interface SaveCommitArgs { projectId: ProjectId; workspaceId: WorkspaceId; commit: string; target: SaveTargetArg }
export interface SaveTextFileArgs { projectId: ProjectId; workspaceId: WorkspaceId; relPath: string; target: SaveTargetArg }
export interface SendHandoffArgs {
  projectId: ProjectId; fromParticipationId: ParticipationId; toParticipationId: ParticipationId;
  versionIds: VersionId[]; title: string; note?: string;
}

// ---------- B2a requests (channels #22-#41): ids, enums and bounded values; never a folder, a command, a network,
// an image, an environment or an identity. `intentId` is a ULID the renderer mints once per user intent.
export interface ActionsQuery { projectId: ProjectId; workspaceId: WorkspaceId; versionId?: VersionId }
export interface JobStartArgs {
  projectId: ProjectId; workspaceId: WorkspaceId; actionId: string;
  inputs: { versionId: VersionId; slot: string }[];
  /** The action's own parameters (its closed schema; at most 8 KiB). */
  params: Record<string, string | number | boolean>;
  intentId: string;
}
export interface JobsListFilter { projectId?: ProjectId; workspaceId?: WorkspaceId; states?: JobState[]; jobKind?: JobKind; limit?: number }
export interface JobLogsQuery { attempt: number; fromOffset: number; maxBytes: number }
export interface EventsQuery { sinceSeq: number; projectId?: ProjectId; limit?: number }
/** `page` for the text parts (`content`, `diff`), `fromRow` for the row parts; never both. */
export interface PreviewQuery { part: PreviewPart; page?: number; fromRow?: number; maxBytes: number }
export interface SaveInlineArgs {
  projectId: ProjectId; workspaceId: WorkspaceId; kind: 'requirement' | 'problem_statement'; target: SaveTargetArg;
  /** The structured content (at most 32 KiB); its schema is checked in main. */
  content: Record<string, unknown>;
}
export interface DeploymentsListFilter { projectId?: ProjectId; status?: DeploymentStatus }
export interface ApprovalsListFilter { projectId?: ProjectId; status?: ApprovalStatus }
export type ApprovalDecisionArg = 'once' | 'deny';
export type ImageProfileArg = 'sde-node' | 'sde-python' | 'nexus-fwd';
export type BlobGcArgs = { apply: false } | { apply: true; expectedCandidatesHash: string };
/** The nexus:hint push: only the newest event seq (pull #31 for what changed). */
export interface NexusHint { lastSeq: number }

// ---------- B2b requests (channels #42-#51): ids, enums and bounded values; the renderer never names a host, a model, a
// principal or a location. Hosts of the agent's network permission come from main's runtime probe.
export interface AgentStartArgs {
  projectId: ProjectId; workspaceId: WorkspaceId; sessionId: SessionId | null; skillId?: string;
  focusVersionIds: VersionId[]; message: string; intentId: string;
}
export interface SessionsListFilter { projectId: ProjectId; statuses?: AgentSessionStatus[] }
export interface ReviewDecideArgs { decision: ReviewDecision; comment?: string }
export interface RepoMergeArgs { branch: string; expectedAcceptedHead: string }
/** The caps a grant may ask for: each is clamped to the D-B4 ceiling in main (a larger value is lowered, never refused). */
export interface AgentConsentCaps {
  turnUsdCents?: number; dayUsdCents?: number; turnsPerHour?: number; concurrentTurns?: number; turnTokens?: number; toolCalls?: number;
}
export type AgentConsentArgs = { op: 'get' } | { op: 'revoke' } | { op: 'grant'; caps?: AgentConsentCaps };
export interface AgentStartResultView { session: SessionView; job: JobView }
export interface ReviewResultView { review: ReviewView; job: JobView | null }
export interface AcceptResultView { version: VersionView; accept: ChangeSetAcceptView }
