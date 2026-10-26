/**
 * Service results -> the views the renderer receives (src/shared/nexus/ipc.ts).
 *
 * Each view is built field by field from an explicit list, so a column added to a
 * service type never leaks by default. Lists never carry storage or content; only
 * `versionDetail` returns content, and then only the commit of a git version, the
 * path and text of a saved text file, or the handoff a receipt answers. Principal ids
 * (created_by, actor ids, on_behalf_of) are not sent; activity carries the actor kind.
 */
import type {
  ActivityEntry, ApprovalStatus, Artifact, ArtifactEdge, ArtifactSummary, ArtifactVersion, DeploymentStatus, Handoff, HandoffDetail, LineageNode,
  PrincipalKind, ProjectWorkspace, VersionStatus
} from '../../shared/nexus/platform';
import type {
  AcceptResultView, ActionAvailabilityView, ActivityDetailsView, ActivityView, AgentSetupView, ApprovalView, ArtifactSummaryView, ArtifactView, BlobGcView,
  ChangeSetAcceptView, DeploymentView, DiskGate, DomainSpecView, EdgeView, EventView, HandoffDetailView, HandoffSummaryView, HealthView, JobDetailView, JobView,
  LineageNodeView, LogPageView, MergeView as MergeViewOut, ParticipationView, PreviewView, RepoStatusView, ReviewResultView, ReviewView as ReviewViewOut,
  SessionDetailView, SessionView, ValidationResultView, VersionContent, VersionDetail, VersionView
} from '../../shared/nexus/ipc';
import type { DomainSpec } from '../../shared/nexus/domainSpec';
import { DELIVERED_SUB_PHASE, isAtOrBefore, isExecutableEndToEnd } from '../../shared/nexus/domainSpec';
import { RECOMMENDED_FREE_BYTES, REQUIRED_FREE_BYTES } from '../../shared/nexus/resourceGate';
import type { ExecJob, HealthSnapshot, JobDetail } from '../nexus/exec/executionService';
import type { JobEvent } from '../nexus/exec/events';
import type { ActionAvailability, ValidatorSummary } from '../nexus/exec/execQueries';
import type { ApprovalView as ServiceApprovalView } from '../nexus/approvals/approvalService';
import type { DeploymentView as ServiceDeploymentView } from '../nexus/deployments/deploymentService';
import type { GcPage, LogPage, PreviewPage } from '../nexusExec/execWiring';
import type { AcceptStatus, AcceptView, MergeView as ServiceMergeView } from '../nexus/repo/acceptService';
import type { ReviewView as ServiceReviewView } from '../nexus/review/reviewService';
import { redactSecretText } from '../nexus/activity/redact';
import { SYSTEM_ID as SYSTEM_PRINCIPAL } from '../nexus/auth/principals';
import { EXECUTION_SUB_REASONS, scrubMessage } from './envelope';

export function participationView(r: ProjectWorkspace): ParticipationView {
  return { id: r.id, projectId: r.projectId, workspaceId: r.workspaceId, status: r.status, isPrimary: r.isPrimary,
    objective: r.objective, source: r.source, createdAt: r.createdAt, updatedAt: r.updatedAt };
}

export function artifactView(a: Artifact): ArtifactView {
  return { id: a.id, projectId: a.projectId, kind: a.kind, name: a.name, description: a.description, ownerScope: a.ownerScope,
    ownerParticipationId: a.ownerParticipationId, ownerWorkspaceId: a.ownerWorkspaceId, status: a.status,
    currentVersionId: a.currentVersionId, createdAt: a.createdAt, updatedAt: a.updatedAt };
}

export function summaryView(s: ArtifactSummary): ArtifactSummaryView {
  return { artifact: artifactView(s.artifact), versionCount: s.versionCount,
    latest: s.latest ? { id: s.latest.id, versionNo: s.latest.versionNo, status: s.latest.status } : null,
    current: s.current ? { id: s.current.id, versionNo: s.current.versionNo } : null };
}

export function versionView(v: ArtifactVersion): VersionView {
  return { id: v.id, artifactId: v.artifactId, versionNo: v.versionNo, projectId: v.projectId, participationId: v.participationId,
    status: v.status, draftFlag: v.draftFlag, storageKind: v.storage.kind, contentHash: v.contentHash,
    validationState: v.validationState, producedByEngine: v.producedByJobId !== null || v.producedBySessionId !== null,
    producedByAction: v.producedByAction, createdAt: v.createdAt, statusChangedAt: v.statusChangedAt, promotedAt: v.promotedAt };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The content a version holds, by an exact shape only; anything else is 'none'. */
export function versionContent(kind: string, v: ArtifactVersion): VersionContent {
  const s = v.storage;
  if (s.kind === 'git' && typeof s.commit === 'string') return { type: 'git', commit: s.commit };
  if (s.kind === 'inline' && isObj(s.json)) {
    const j = s.json;
    if (kind === 'text_file' && typeof j.path === 'string' && typeof j.text === 'string') return { type: 'text', path: j.path, text: j.text };
    if (kind === 'handoff_receipt' && typeof j.handoffId === 'string') return { type: 'receipt', handoffId: j.handoffId };
  }
  return { type: 'none' };
}

export function versionDetail(kind: string, v: ArtifactVersion, latest?: LatestReview): VersionDetail {
  return { ...versionViewOfKind(kind, v, latest), content: versionContent(kind, v) };
}

/** The newest review of a version as the service reads it (decision and when). */
export type LatestReview = { decision: 'approve' | 'request_changes' | 'reject'; decidedAt: number } | undefined;

/**
 * `versionView`, plus (change sets only) `latestReview`: the newest review's decision and ISO time, or null when none.
 * Any other kind is the plain view with no such field.
 */
export function versionViewOfKind(kind: string, v: ArtifactVersion, latest?: LatestReview): VersionView {
  const view = versionView(v);
  if (kind !== 'change_set') return view;
  return { ...view, latestReview: latest && Number.isFinite(latest.decidedAt) ? { decision: latest.decision, decidedAt: new Date(latest.decidedAt).toISOString() } : null };
}

export function lineageNodeView(n: LineageNode): LineageNodeView {
  return { versionId: n.versionId, artifactId: n.artifactId, kind: n.kind, versionNo: n.versionNo, status: n.status, depth: n.depth, relation: n.relation };
}

export function edgeView(e: ArtifactEdge): EdgeView {
  return { id: e.id, fromVersionId: e.fromVersionId, toVersionId: e.toVersionId, relation: e.relation, source: e.source, createdAt: e.createdAt };
}

export function handoffSummaryView(h: Handoff): HandoffSummaryView {
  return { id: h.id, projectId: h.projectId, fromParticipationId: h.fromParticipationId, fromWorkspaceId: h.fromWorkspaceId,
    toParticipationId: h.toParticipationId, toWorkspaceId: h.toWorkspaceId, title: h.title, note: h.note, subjectCount: h.subjectCount,
    status: h.status, respondedAt: h.respondedAt, responseNote: h.responseNote, receiptVersionId: h.receiptVersionId,
    createdAt: h.createdAt, updatedAt: h.updatedAt, statusChangedAt: h.statusChangedAt };
}

export function handoffDetailView(h: HandoffDetail): HandoffDetailView {
  return { ...handoffSummaryView(h), subjects: h.subjects.map((s) => ({ versionId: s.versionId, position: s.position,
    contentHash: s.contentHash, artifactId: s.artifactId, artifactName: s.artifactName, kind: s.kind, versionNo: s.versionNo,
    status: s.status, newerVersionNo: s.newerVersionNo })) };
}

/**
 * The activity detail keys the renderer may see, each a small scalar. Everything else (backup files, filters,
 * error payloads, ungranted inputs, change lists) is dropped.
 */
export const ACTIVITY_DETAIL_KEYS: readonly string[] = Object.freeze([
  'from', 'to', 'kind', 'versionNo', 'storageKind', 'relation', 'source', 'toVersionId', 'subjects', 'toWorkspaceId',
  'receiptVersionId', 'withNote', 'reactivated', 'previous', 'rollback', 'workspaceId', 'result', 'inputs', 'edges',
  // B2a (final review C1): what the execution rows' sentences read. Each is a scalar main writes from a fixed set
  // (an approval's reason and decision, an image build's or a failed recovery's status, a deployment stop's job
  // effect, a recovery decision) or a count (`requested`); like every key here it is scrubbed and capped.
  'reason', 'decision', 'status', 'job', 'requested',
  // B2b Task 14: the consent row's `op` (grant or revoke) and whether a job's worktree was reused (a flag, never a path).
  'op', 'reused'
]);
const MAX_DETAIL_STRING = 64;

export function activityDetails(d: Record<string, unknown>): ActivityDetailsView {
  const out: ActivityDetailsView = {};
  if (!isObj(d)) return out;
  for (const k of ACTIVITY_DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
    const v = d[k];
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = scrubMessage(v).slice(0, MAX_DETAIL_STRING);
  }
  return out;
}

export function activityView(e: ActivityEntry): ActivityView {
  return { seq: e.seq, ts: e.ts, action: e.action, status: e.status, actorKind: e.actorKind,
    onBehalfOfUser: e.onBehalfOf !== null && e.onBehalfOf !== e.actorId, entityType: e.entityType, entityId: e.entityId,
    projectId: e.projectId, workspaceId: e.workspaceId, artifactId: e.artifactId, versionId: e.versionId, details: activityDetails(e.details) };
}

// ---------- B2a Task 13: the execution views (channels #22-#41) ----------
// Field by field, as above. Never sent: principal ids (requested_by, on_behalf_of, decided_by), params, raw metadata,
// sandbox or environment records, container ids, host ports other than a live deployment's loopback URL, log or object
// locations, env values. Image ids are shortened to `sha256:` + 12 hex. Every free text is scrubbed (absolute paths cut
// to their basename, secrets redacted, one line) and capped.

const MAX_VIEW_TEXT = 300;
const MAX_EVIDENCE_ITEMS = 40;
const text = (s: unknown, max = MAX_VIEW_TEXT): string => scrubMessage(typeof s === 'string' ? s : '').slice(0, max);
const textOrNull = (s: unknown, max = MAX_VIEW_TEXT): string | null => (typeof s === 'string' ? text(s, max) : null);
const num = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const LABEL = /^[a-z][a-z0-9_.:-]{0,63}$/;
const label = (s: unknown): string | null => (typeof s === 'string' && LABEL.test(s) ? s : null);

/** `sha256:<64 hex>` -> `sha256:<12 hex>`; anything else -> null (never a repository name, a tag or a host). */
export function shortImageId(id: unknown): string | null {
  return typeof id === 'string' && /^sha256:[0-9a-f]{64}$/.test(id) ? `sha256:${id.slice(7, 19)}` : null;
}

export function domainView(d: DomainSpec): DomainSpecView {
  const vocabulary: DomainSpecView['vocabulary'] = {};
  for (const [k, v] of Object.entries(d.vocabulary)) if (v) vocabulary[k] = { singular: v.singular, plural: v.plural };
  return {
    id: d.id, label: d.label, shortLabel: d.shortLabel, description: d.description, tier: d.tier, hueSlot: d.hueSlot, icon: d.icon, order: d.order,
    statusNote: d.statusNote, vocabulary,
    lifecycle: d.lifecycle.map((s) => ({
      id: s.id, label: s.label, status: s.status, scopeNote: s.scopeNote ?? null, subPhase: s.subPhase,
      delivered: s.status !== 'FUTURE' && isAtOrBefore(s.subPhase, DELIVERED_SUB_PHASE),
      consumes: [...s.consumes], produces: [...s.produces], prerequisites: [...s.prerequisites],
      actions: s.via.flatMap((v) => ('userAction' in v ? [v.userAction] : []))
    })),
    modules: d.modules.map((m) => ({ id: m.id, label: m.label, kinds: [...m.kinds], subPhase: m.subPhase })),
    availableFromSubPhase: d.participationFromSubPhase, currentSubPhase: DELIVERED_SUB_PHASE, executableEndToEnd: isExecutableEndToEnd(d)
  };
}

const gateProblem = (p: { id: string; profile?: unknown }): string => (typeof p.profile === 'string' ? `${p.id}:${p.profile}` : p.id);

/** The agent setup row before anything is known (the default of `healthView`, and what a build without agents shows). */
export const UNKNOWN_AGENT: AgentSetupView = Object.freeze({
  state: 'unknown', label: null, version: null, signedIn: 'unknown', flagsOk: null,
  consent: Object.freeze({ live: false, caps: null, hostsCount: 0, grantedAt: null }),
  usageToday: Object.freeze({ usdCents: 0, turns: 0, estimated: false })
}) as AgentSetupView;

export function healthView(h: HealthSnapshot, platform: { handoffs: boolean; execution: boolean; registry: { valid: boolean; problems: number };
  subReason: string | null }, agent: AgentSetupView = UNKNOWN_AGENT): HealthView {
  const gate = h.gate;
  const free = h.disk.freeBytes;
  const diskGate: DiskGate = free === null ? 'unknown' : free < REQUIRED_FREE_BYTES ? 'below_required' : free < RECOMMENDED_FREE_BYTES ? 'below_recommended' : 'ok';
  return {
    // The sub-reason through the same allow-list as the availability envelope (fix round 1): never echoed raw.
    db: { version: num(h.schemaVersion), platform: true, handoffs: platform.handoffs, execution: platform.execution,
      ...(platform.subReason ? { subReason: EXECUTION_SUB_REASONS.includes(platform.subReason) ? platform.subReason : 'not_enabled' } : {}) },
    registry: { valid: platform.registry.valid, problems: platform.registry.problems },
    runner: { state: label(h.runner.state) ?? 'unknown', attached: h.runner.attached, restarts: h.runner.faults },
    docker: { state: h.docker.state,
      ...(typeof h.docker.version === 'string' ? { version: text(h.docker.version, 40) } : {}),
      ...(typeof h.docker.os === 'string' ? { os: text(h.docker.os, 80) } : {}),
      ...(typeof h.docker.wsl2 === 'boolean' ? { wsl2: h.docker.wsl2 } : {}),
      ...(num(h.docker.cpus) !== null ? { cpus: h.docker.cpus } : {}),
      ...(num(h.docker.memoryBytes) !== null ? { memoryBytes: h.docker.memoryBytes } : {}) },
    images: h.images.map((i) => ({ profile: i.profile, present: i.present, matches: i.matches,
      ...(num(i.sizeBytes) !== null ? { sizeBytes: i.sizeBytes } : {}),
      ...(shortImageId(i.imageId) ? { imageIdShort: shortImageId(i.imageId)! } : {}) })),
    disk: { dataHomeFreeBytes: free, requiredBytes: REQUIRED_FREE_BYTES, recommendedBytes: RECOMMENDED_FREE_BYTES, leaseFloorBytes: h.disk.leaseFloorBytes, gate: diskGate },
    problems: gate ? gate.problems.map(gateProblem) : [],
    gpu: { detected: h.gpu?.detected === true, ...(typeof h.gpu?.model === 'string' ? { model: text(h.gpu.model, 80) } : {}), supported: false },
    checkedAt: h.checkedAt,
    agent
  };
}

export function actionView(a: ActionAvailability): ActionAvailabilityView {
  return { actionId: a.actionId, label: a.label, stepId: a.stepId, available: a.available, reason: a.reason,
    inputs: a.inputs.map((s) => ({ slot: s.slot, kinds: [...s.kinds], min: s.min, max: s.max })), needsApproval: a.needsApproval };
}

const kindOf = (principalId: unknown): PrincipalKind =>
  principalId === SYSTEM_PRINCIPAL ? 'system' : typeof principalId === 'string' && /^agent[:.]/.test(principalId) ? 'agent' : 'user';
const errorView = (e: unknown): { code: string; message: string } | null => {
  if (!isObj(e) || typeof e.code !== 'string') return null;
  return { code: label(e.code) ?? 'error', message: text(e.message) };
};

export function jobView(j: ExecJob): JobView {
  return {
    id: j.id, kind: j.kind, projectId: j.projectId, workspaceId: j.workspaceId, actionId: label(j.actionId), recipeId: label(j.recipeId),
    state: j.state, phase: label(j.phase), headline: j.headline, outcome: label(j.outcome), error: errorView(j.error),
    attempts: j.attempts, retryOf: j.retryOf, parentJobId: j.parentJobId, requestedByKind: kindOf(j.requestedBy),
    inputs: j.inputs.map((x) => ({ versionId: x.versionId, slot: x.role, contentHash: x.contentHash })),
    createdAt: j.createdAt, updatedAt: j.updatedAt, startedAt: j.startedAt, finishedAt: j.finishedAt, nextAttemptAt: j.nextAttemptAt,
    cancelRequested: j.cancelRequestedAt !== null
  };
}

export function jobDetailView(d: JobDetail): JobDetailView {
  return {
    ...jobView(d),
    attemptHistory: d.attemptHistory.map((a) => ({
      // The attempt row's id (a ULID): no principal, path or host fact; a log range in a diagnostic report names it.
      id: a.id, n: a.n, state: a.state, outcome: label(a.outcome), exitCode: a.exitCode, signal: label(a.signal), oomKilled: a.oomKilled,
      network: label(a.network), preflight: a.preflight ? { ok: a.preflight.ok, problems: a.preflight.problems.slice(0, 20).map((x) => text(x, 120)) } : null,
      imageIdShort: shortImageId(a.imageId), profile: label(a.profile), error: errorView(a.error),
      createdAt: a.createdAt, startedAt: a.startedAt, finishedAt: a.finishedAt
    })),
    outputs: d.outputs.map((o) => ({ versionId: o.versionId, status: o.status as VersionStatus })),
    approvals: d.approvals.map((a) => ({ id: a.id, status: a.status as ApprovalStatus, reason: label(a.reason) ?? 'approval', expiresAt: a.expiresAt })),
    deployment: d.deployment ? { id: d.deployment.id, status: d.deployment.status as DeploymentStatus } : null
  };
}

export function eventView(e: JobEvent): EventView {
  return { seq: e.seq, ts: e.ts, type: label(e.type) ?? 'event', summary: text(e.summary), projectId: e.projectId, jobId: e.jobId, attemptN: e.attemptN };
}

/** Evidence items as typed facts: names, counts and hashes; never a host path (a `file` item keeps its relative name). */
function evidenceView(ev: unknown): ValidationResultView['evidence'] {
  if (!Array.isArray(ev)) return [];
  const out: ValidationResultView['evidence'] = [];
  // `case` items are the per-case table of a test result, paged by #34 (junit_summary); they are not listed here.
  for (const e of ev.filter((x) => !(isObj(x) && x.type === 'case')).slice(0, MAX_EVIDENCE_ITEMS)) {
    if (!isObj(e) || typeof e.type !== 'string') continue;
    const t = label(e.type) ?? 'fact';
    const name = typeof e.name === 'string' ? e.name : typeof e.label === 'string' ? e.label : typeof e.field === 'string' ? e.field
      : typeof e.path === 'string' ? e.path : typeof e.validator === 'string' ? e.validator : null;
    let value: string | number | boolean | null = null;
    if (typeof e.value === 'number' || typeof e.value === 'boolean') value = e.value;
    else if (typeof e.value === 'string') value = text(e.value, 120);
    else if (t === 'junit') value = `${num(e.passed) ?? 0}/${num(e.total) ?? 0} passed, ${num(e.failed) ?? 0} failed, ${num(e.errored) ?? 0} errored`;
    else if (t === 'exit') value = num(e.code);
    else if (t === 'http') value = num(e.status);
    else if (typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256)) value = `sha256:${e.sha256.slice(0, 12)}`;
    else if (typeof e.commit === 'string' && /^[0-9a-f]{40}$/.test(e.commit)) value = e.commit.slice(0, 12);
    out.push({ type: t, name: name === null ? null : text(name, 120), value });
  }
  return out;
}

const STATUS = new Set(['passed', 'failed', 'error', 'skipped']);
const statusOf = (s: unknown): 'passed' | 'failed' | 'error' | 'skipped' => (typeof s === 'string' && STATUS.has(s) ? s as 'passed' : 'error');

export function validationView(v: ValidatorSummary): ValidationResultView {
  const b = v.latestBlocking;
  return {
    validatorId: v.validatorId, blocking: v.blocking,
    status: b ? statusOf(b.status) : null, summary: b ? text(b.summary, 500) : null, finishedAt: b ? b.finishedAt : null,
    evidence: b ? evidenceView(b.evidence) : [],
    latestRun: v.latestRun ? { status: statusOf(v.latestRun.status), summary: text(v.latestRun.summary, 500), finishedAt: v.latestRun.finishedAt } : null,
    history: v.history
  };
}

export function previewView(p: PreviewPage): PreviewView {
  return { part: p.part, versionId: p.versionId, text: p.text,
    rows: p.rows ? p.rows.map((r) => ({ name: text(r.name, 512), detail: textOrNull(r.detail, 512), bytes: r.bytes, outcome: textOrNull(r.outcome, 64) })) : null,
    page: p.page, nextPage: p.nextPage, fromRow: p.fromRow, nextRow: p.nextRow, totalRows: p.totalRows, totalBytes: p.totalBytes };
}

export function logPageView(l: LogPage): LogPageView {
  return { text: l.text, nextOffset: l.nextOffset, eof: l.eof, truncatedMiddle: l.truncatedMiddle };
}

export function deploymentView(d: ServiceDeploymentView): DeploymentView {
  return { id: d.id, projectId: d.projectId, subjectVersionId: d.subjectVersionId, jobId: d.jobId, status: d.status, stopReason: label(d.stopReason),
    // Only a live loopback URL: the service builds it from 127.0.0.1, the port and the manifest's validated health path.
    url: typeof d.url === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9/_.-]{0,200}$/.test(d.url) ? d.url : null,
    bindAddress: d.bindAddress === '127.0.0.1' ? '127.0.0.1' : 'loopback', hostPort: d.hostPort,
    healthPath: typeof d.healthPath === 'string' && /^\/[A-Za-z0-9/_.-]{0,200}$/.test(d.healthPath) ? d.healthPath : null,
    lastProbe: d.lastProbe ? { at: d.lastProbe.at, status: d.lastProbe.status, ms: d.lastProbe.ms } : null, probes: d.probes,
    startedAt: d.startedAt, stoppedAt: d.stoppedAt, endsAt: d.endsAt };
}

export function approvalView(a: ServiceApprovalView): ApprovalView {
  const r = a.request;
  const request: ApprovalView['request'] = {};
  if (label(r.recipeId)) request.recipeId = r.recipeId;
  const profile = label(r.profile) ?? label(r.profileId);
  if (profile) request.profile = profile;
  if (Array.isArray(r.registries)) request.registries = r.registries.slice(0, 8).map((x) => text(x, 120));
  for (const k of ['lockfileSha256', 'contextSha256'] as const) if (typeof r[k] === 'string' && /^[0-9a-f]{64}$/.test(r[k]!)) request[k] = r[k];
  if (typeof r.baseDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(r.baseDigest)) request.baseDigest = r.baseDigest;
  if (num(r.estimatedBytes) !== null) request.estimatedBytes = r.estimatedBytes;
  if (r.freeBytesNow === null || num(r.freeBytesNow) !== null) request.freeBytesNow = r.freeBytesNow ?? null;
  const b = a.imageBuild;
  return {
    id: a.id, projectId: a.projectId, jobId: a.jobId, reason: label(a.reason) ?? 'approval', summary: text(a.summary, 500), status: a.status, request,
    requestedAt: a.requestedAt, expiresAt: a.expiresAt, decidedAt: a.decidedAt, decision: a.decision === 'once' || a.decision === 'deny' ? a.decision : null,
    consumedAt: a.consumedAt,
    imageBuild: b ? { id: b.id, status: label(b.status) ?? 'unknown', imageIdShort: shortImageId(b.imageId), sizeBytes: num(b.sizeBytes),
      error: b.error ? label(b.error.code) : null } : null
  };
}

export function gcView(g: GcPage): BlobGcView {
  return { candidates: g.candidates, bytes: g.bytes, candidatesHash: /^[0-9a-f]{64}$/.test(g.candidatesHash) ? g.candidatesHash : '', removed: g.removed,
    fileDeleteFailed: g.fileDeleteFailed };
}

// ---------- B2b Task 14: the agent views (channels #42-#51) ----------
// Field by field again. Never sent: a principal id (acceptedBy, mergedBy, reviewer ids), a token, a path, a host, a worktree, a
// job id of the runner's own, an engine word. Text a person wrote (a review comment) is redacted and capped; commits and refs
// are ids Nexus itself recorded.

/** A session as the list shows it, from a detail (the detail's lists are not sent here). */
export function sessionViewOf(d: SessionView): SessionView {
  return { id: d.id, projectId: d.projectId, workspaceId: d.workspaceId, status: d.status, turns: d.turns, liveJobId: d.liveJobId, createdAt: d.createdAt, updatedAt: d.updatedAt };
}

const COMMIT = /^[0-9a-f]{40}$/;
const commitOrNull = (c: unknown): string | null => (typeof c === 'string' && COMMIT.test(c) ? c : null);

export function sessionDetailView(d: SessionDetailView): SessionDetailView {
  return { ...sessionViewOf(d),
    turnHistory: d.turnHistory.map((t) => ({ jobId: t.jobId, state: t.state, headline: t.headline, outcome: label(t.outcome), error: errorView(t.error), usage: t.usage,
      createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt })),
    // Display-only lines the agent wrote: redacted again, never evidence.
    messages: d.messages.map((m) => ({ seq: m.seq, ts: m.ts, from: m.from === 'user' ? 'user' : 'agent', text: redactSecretText(String(m.text)).slice(0, 4000), displayOnly: true })),
    toolCalls: d.toolCalls.map((t) => ({ seq: t.seq, ts: t.ts, jobId: t.jobId, tool: label(t.tool) ?? 'tool', ok: t.ok, resultBytes: t.resultBytes })),
    versions: d.versions.map((v) => ({ versionId: v.versionId, kind: label(v.kind) ?? 'artifact', status: v.status })),
    approvals: d.approvals.map((a) => ({ id: a.id, status: a.status, reason: label(a.reason) ?? 'approval', expiresAt: a.expiresAt })) };
}

export function reviewViewOf(r: ServiceReviewView, jobId: string | null): ReviewViewOut {
  return { id: r.id, versionId: r.versionId, decision: r.decision, comment: r.comment === null ? null : redactSecretText(r.comment).slice(0, 4000),
    reviewerKind: 'user', createdAt: r.createdAt, jobId };
}

export function reviewResultView(r: ServiceReviewView, job: JobView | null): ReviewResultView {
  return { review: reviewViewOf(r, job ? job.id : null), job };
}

export function changeSetAcceptView(a: AcceptView): ChangeSetAcceptView {
  return { versionId: a.versionId, integrationRef: a.integrationRef, refBefore: a.refBefore, refAfter: a.refAfter, mergeCommit: a.mergeCommit, acceptedAt: a.acceptedAt };
}

export function acceptResultView(version: VersionView, a: AcceptView): AcceptResultView {
  return { version, accept: changeSetAcceptView(a) };
}

/** Why "Merge accepted work" cannot run now, in the order the merge itself refuses (null when it can). */
export function mergeBlockReason(s: AcceptStatus): string | null {
  if (!s.integrationConsistent) return 'integration_unexpected';
  if (s.lastAcceptedHead === null || s.acceptedNotMerged === 0 || s.head === s.integrationHead) return 'nothing_to_merge';
  if (s.checkedOutBranch !== s.branch) return 'branch_mismatch';
  if (!s.userTreeClean) return 'tree_dirty';
  if (!s.fastForward) return 'not_fast_forward';
  return null;
}

export function repoStatusView(projectId: string, s: AcceptStatus, checkedAt: number): RepoStatusView {
  const reason = mergeBlockReason(s);
  return { projectId, branch: s.checkedOutBranch, head: commitOrNull(s.head), dirty: !s.userTreeClean, integrationRef: s.integrationRef,
    acceptedHead: commitOrNull(s.integrationHead), acceptedNotMerged: s.acceptedNotMerged, canFastForward: reason === null, reason, checkedAt };
}

/** A status the repository could not give (git missing, the runner away, no branch recorded yet): a view that says why, never an error. */
export function repoStatusUnavailable(projectId: string, reason: string, checkedAt: number): RepoStatusView {
  return { projectId, branch: null, head: null, dirty: null, integrationRef: null, acceptedHead: null, acceptedNotMerged: 0, canFastForward: false,
    reason: label(reason) ?? 'error', checkedAt };
}

export function mergeView(m: ServiceMergeView): MergeViewOut {
  return { projectId: m.projectId, branch: text(m.branch, 200), before: commitOrNull(m.before) ?? '', after: commitOrNull(m.after) ?? '', mergedAt: m.mergedAt };
}
