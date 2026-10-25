// Shared platform types (types only) used by the B0b core services: activity,
// authorization, participation, artifacts, lineage, jobs and agent sessions.
// Nothing here has a runtime value, so main and renderer can both import it.

export type PrincipalId = string; export type ProjectId = string; export type WorkspaceId = string;
export type ParticipationId = string; export type ArtifactId = string; export type VersionId = string;
export type JobId = string; export type ActivityId = string;
export type PrincipalKind = 'user' | 'agent' | 'system';
export interface Principal { id: PrincipalId; kind: PrincipalKind; displayName: string }
export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type ScopeRef = { type: 'platform' } | { type: 'workspace'; workspaceId: WorkspaceId } | { type: 'project'; projectId: ProjectId; workspaceId?: WorkspaceId };
export type PlatformAction =
  | 'project.read' | 'workspace.read' | 'participation.attach' | 'participation.withdraw'
  | 'artifact.read' | 'artifact.create' | 'artifact.archive'
  | 'version.register' | 'version.update_draft' | 'version.discard' | 'version.promote' | 'version.finalize'
  | 'lineage.read' | 'lineage.write'
  | 'job.read' | 'job.create' | 'job.cancel' | 'job.transition'
  | 'session.read' | 'session.open' | 'session.cancel' | 'session.transition'
  | 'activity.read' | 'system.reconcile'
  | 'handoff.read' | 'handoff.send' | 'handoff.respond' | 'handoff.withdraw'
  | 'blob.gc'
  // B2a execution: approvals, deployments, revalidation, health, and the system-only execution writes.
  | 'approval.read' | 'approval.respond' | 'approval.create' | 'deployment.stop' | 'deployment.transition'
  | 'version.revalidate' | 'platform.health' | 'exec.ingest'
  // B2b agents: start a turn (member), a user's review decision and change-set accept (member, users only), the
  // dialog-confirmed merge and the runtime consent (owner), and the capability-token mint (system only).
  | 'agent.start' | 'review.decide' | 'changeset.accept' | 'repo.merge' | 'agent.consent' | 'token.mint';
export type AuthDenyReason = 'unknown_principal' | 'disabled_principal' | 'no_membership' | 'role' | 'agent_requires_token' | 'system_only'
  // B2b: an action only a stored user may take (the system principal and agents never may).
  | 'user_only';
export type AuthDecision = { allowed: true; role: Role | 'system' } | { allowed: false; reason: AuthDenyReason; needed?: Role };
/**
 * B2b: what an agent's capability token is checked against on one call (AuthService.authorizeWithToken). Every field
 * but the project is optional; each one given must be inside the token's grant and the domain's ceiling.
 */
export interface TokenScope {
  projectId: ProjectId;
  /** A version the call reads or names as an input: one of the turn's inputs, or an output of the turn's job (or its child jobs). */
  versionId?: VersionId;
  /** A recipe the call requests. */
  recipeId?: string;
  /** An artifact kind the call registers. */
  kind?: string;
  /** A worktree path the call edits (checked against the code edit scope). */
  path?: string;
  /** The MCP tool the call came through (it must be in the token's tool list, and it decides the capability). */
  tool?: string;
}
/** Why a token call was refused: a verification failure, or a failed check of the intersection. */
export type TokenDenyReason = 'malformed' | 'bad_signature' | 'unknown' | 'expired' | 'revoked'
  | 'not_agent' | 'agent_forbidden' | 'job_ended' | 'user_denied' | 'ceiling' | 'no_capability' | 'tool_not_granted' | 'out_of_scope';
export type TokenAuthDecision = { allowed: true } | { allowed: false; reason: TokenDenyReason };
export type ParticipationStatus = 'active' | 'withdrawn' | 'complete';
export interface ProjectWorkspace { id: ParticipationId; projectId: ProjectId; workspaceId: WorkspaceId; status: ParticipationStatus;
  isPrimary: boolean; objective: string | null; source: 'backfill' | 'legacy_domain' | 'user'; createdBy: PrincipalId; createdAt: number; updatedAt: number }
export interface Artifact { id: ArtifactId; projectId: ProjectId; kind: string; name: string; description: string | null;
  ownerScope: 'participation' | 'project'; ownerParticipationId: ParticipationId | null; ownerWorkspaceId: WorkspaceId | null;
  createdBy: PrincipalId; status: 'active' | 'archived'; currentVersionId: VersionId | null; metadata: Record<string, unknown>;
  createdAt: number; updatedAt: number }
export type VersionStatus = 'draft' | 'candidate' | 'active' | 'failed' | 'deprecated';
/** One artifact with its version count, its newest version and its current (active) version. */
export interface ArtifactSummary { artifact: Artifact; versionCount: number;
  latest: { id: VersionId; versionNo: number; status: VersionStatus } | null;
  current: { id: VersionId; versionNo: number } | null }
export type StorageRef =
  | { kind: 'git'; commit: string; ref?: string; paths?: string[] }
  | { kind: 'blob'; sha256: string; bytes: number; mediaType: string }
  | { kind: 'tree'; manifestSha256: string; files: number; bytes: number }
  | { kind: 'external'; uri: string; manifestSha256: string; bytes?: number }
  | { kind: 'inline'; json: unknown };
export interface VersionInput { versionId: VersionId; role: string }
export interface ArtifactVersion { id: VersionId; artifactId: ArtifactId; versionNo: number; projectId: ProjectId;
  participationId: ParticipationId | null; status: VersionStatus; draftFlag: 'cancelled_partial' | null; storage: StorageRef;
  contentHash: string; inputs: VersionInput[]; ioContract: unknown | null; metadata: unknown;
  validationState: 'pending' | 'passed' | 'failed' | 'error'; producedByJobId: JobId | null;
  producedBySessionId: SessionId | null; producedByAction: string | null;
  actorId: PrincipalId; onBehalfOf: PrincipalId; createdAt: number; statusChangedAt: number;
  promotedBy: PrincipalId | null; promotedAt: number | null; clientKey: string | null }
export type SessionId = string;
// 32 relations: the brief's eight ∪ architecture L.1. Vocabulary only in B0b (planned_phase is documentation).
export type LineageRelation =
  | 'derived_from' | 'trained_on' | 'evaluated_on' | 'implements' | 'serves' | 'built_from' | 'deployed_as' | 'depends_on'
  | 'contains' | 'extracted_from' | 'queried_from' | 'visualizes' | 'cites' | 'analyzes' | 'tested_on' | 'run_of'
  | 'produced_by' | 'resumed_from' | 'selected_from' | 'evaluates' | 'packages' | 'exported_from' | 'fixes'
  | 'assembled_from' | 'tests' | 'executes' | 'found_in' | 'evidenced_by' | 'verified_by' | 'summarizes'
  | 'recommends' | 'based_on'
  // Schema v9 (D12): vocabulary only in B2a; first written in the phase named by each row.
  | 'covers' | 'transformed_by' | 'configured_by' | 'monitors';
export type EdgeSource = 'job_input' | 'ingest' | 'user_action' | 'handoff_convert';
export interface ArtifactEdge { id: string; fromVersionId: VersionId; toVersionId: VersionId; relation: LineageRelation;
  source: EdgeSource; jobId: JobId | null; createdBy: PrincipalId; createdAt: number }
export interface LineageNode { versionId: VersionId; artifactId: ArtifactId; kind: string; versionNo: number; status: VersionStatus; depth: number; relation: LineageRelation }
export type JobKind = 'agent.run' | 'tool.run' | 'validate' | 'ingest';
// The brief's nine plus leased and retry_scheduled (M1, user decision). Architecture "succeeded" = 'completed'.
export type JobState = 'queued' | 'leased' | 'running' | 'awaiting_approval' | 'retry_scheduled'
  | 'completed' | 'partial' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export interface JobError { code: string; message: string }
export interface JobRetryPolicy { idempotent: boolean; maxAttempts: number; backoffMs: number[] }
export interface Job { id: JobId; kind: JobKind; projectId: ProjectId; workspaceId: WorkspaceId; participationId: ParticipationId | null;
  sessionId: SessionId | null; parentJobId: JobId | null; retryOf: JobId | null; idempotencyKey: string;
  requestedBy: PrincipalId; onBehalfOf: PrincipalId;
  state: JobState; outcome: string | null; error: JobError | null; priority: 0 | 1 | 2; params: unknown;
  retry: JobRetryPolicy; attempts: number;
  runtimeKind: string | null; runtimeRef: string | null; inputs: (VersionInput & { contentHash: string })[];
  createdAt: number; updatedAt: number; stateChangedAt: number; startedAt: number | null; finishedAt: number | null; cancelRequestedAt: number | null }
export type AgentSessionStatus = 'open' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export interface AgentSession { id: SessionId; projectId: ProjectId; workspaceId: WorkspaceId; participationId: ParticipationId;
  contextVersionId: VersionId | null; principalId: PrincipalId; idempotencyKey: string; status: AgentSessionStatus;
  runtimeKind: string | null; runtimeRef: string | null; cancelRequestedAt: number | null; cancelRequestedBy: PrincipalId | null;
  error: JobError | null; createdAt: number; updatedAt: number; statusChangedAt: number; endedAt: number | null }
export type ActivityStatus = 'started' | 'succeeded' | 'failed' | 'denied' | 'cancelled';
export interface ActivityEntry { seq: number; id: ActivityId; ts: number; actorKind: PrincipalKind; actorId: PrincipalId;
  onBehalfOf: PrincipalId | null; sessionId: SessionId | null; jobId: JobId | null; attemptN: number | null; workspaceId: WorkspaceId | null;
  projectId: ProjectId | null; artifactId: ArtifactId | null; versionId: VersionId | null; entityType: string; entityId: string | null; action: string;
  status: ActivityStatus; details: Record<string, unknown>; prevHash: string; hash: string }
export type PlatformErrorCode = 'denied' | 'not_found' | 'invalid' | 'conflict' | 'immutable' | 'cycle' | 'not_owner'
  | 'not_participating' | 'participation_inactive' | 'input_not_granted' | 'storage_unavailable' | 'illegal_transition' | 'platform_unavailable'
  // B2a: an action that cannot run on this machine now (a setup:* reason, or a product limit such as secrets for dev deployments).
  | 'unavailable'
  // B2a Task 13: a preview or page larger than a reader may take at once (the request names a smaller page).
  | 'too_large';
// Execution (schema v9): the vocabularies seeded in attempt_states, approval_states and deployment_states.
export type AttemptState = 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'abandoned';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'withdrawn';
export type DeploymentStatus = 'starting' | 'healthy' | 'unhealthy' | 'stopped' | 'failed';
// Handoffs (schema v8): artifact versions sent by reference between two participations of one project.
export type HandoffId = string;
export type HandoffStatus = 'sent' | 'accepted' | 'declined' | 'withdrawn';
export interface Handoff { id: HandoffId; projectId: ProjectId;
  fromParticipationId: ParticipationId; fromWorkspaceId: WorkspaceId; toParticipationId: ParticipationId; toWorkspaceId: WorkspaceId;
  title: string; note: string | null; subjectCount: number; status: HandoffStatus; createdBy: PrincipalId;
  respondedBy: PrincipalId | null; respondedAt: number | null; responseNote: string | null; receiptVersionId: VersionId | null;
  createdAt: number; updatedAt: number; statusChangedAt: number }
/** One version a handoff carries, by reference; contentHash is evidence of what was sent, never the content. */
export interface HandoffSubject { handoffId: HandoffId; versionId: VersionId; position: number; contentHash: string }
/** A row of a handoff list. */
export type HandoffSummary = Handoff;
/** A handoff with its subjects joined to their versions and artifacts. */
export interface HandoffDetail extends Handoff {
  subjects: (HandoffSubject & { artifactId: ArtifactId; artifactName: string; kind: string; versionNo: number;
    status: VersionStatus; newerVersionNo: number | null })[] }
