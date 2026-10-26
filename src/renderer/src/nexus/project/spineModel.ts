import type { VersionStatus } from '@shared/nexus/platform';
import type { ArtifactSummaryView } from '@shared/nexus/ipc';
import { UNASSIGNED_LABEL } from '../workspaces/mapping';
import { viewOf, type ParticipationIndex, type ParticipationRow } from '../workspaces/participation';
import { kindIsChecked, kindLabel, shownVersionOf, statusLabel } from './artifactModel';
import { applicationPreview, checksWord, type PreviewDeployment } from './evidenceModel';
import { livePreviewsOf } from '../runs/jobRunModel';
import type { JobView } from '@shared/nexus/ipc';
import type { RailRecords } from '../workspaces/lifecycleModel';

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
export type GitState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; isRepo: boolean; branch: string | null; head: { sha: string; shortSha: string; subject: string; time: number } | null; changed: { path: string; kind: ChangeKind }[];
      /** Set when a branch or log read failed, so null means "unknown", not "none". */
      unknown?: { branch?: boolean; head?: boolean } };

export type SourceNode = { kind: 'source'; id: 'source'; vcs: 'git' | 'none' | 'unknown' | 'error'; branch: string | null; head: { shortSha: string; subject: string } | null };
export type ChangesNode = { kind: 'changes'; id: 'changes'; fileCount: number };
export type ArtifactNode = {
  kind: 'artifact'; id: `artifact:${string}`; artifactId: string;
  artifactKind: string; name: string; versionNo: number; status: VersionStatus; isCurrent: boolean;
};
export type SpineNode = SourceNode | ChangesNode | ArtifactNode;

/** One artifact summary as nexus:artifacts:byProject returns it. */
export type ArtifactSummary = ArtifactSummaryView;

/** `muted` is set only on a group whose participation is no longer active but still owns artifacts. */
export type SpineGroup = { workspaceId: string; label: string; hueSlot: number | null; nodes: SpineNode[]; muted?: 'withdrawn' | 'complete' };

const groupOf = (row: ParticipationRow): SpineGroup => {
  const v = viewOf(row.workspaceId);
  return { workspaceId: v.id, label: v.label, hueSlot: v.hueSlot, nodes: [] };
};

/** Only real data becomes a node; the spine never shows placeholders.
 *  - One group per active participation, primary first, then registry order. Without a
 *    primary, an Unassigned group leads. Source and changes stay in the lead group.
 *  - Artifact nodes come only from real versions (the current one, else the latest),
 *    in creation order, in their owner workspace's group. An archived artifact is not shown.
 *  - A participation that is no longer active but owns artifacts gives a muted group. */
export function buildSpine(input: { idx: ParticipationIndex; projectId: string; git: GitState; artifacts: ArtifactSummary[] }): SpineGroup[] {
  const rows = input.idx.byProject.get(input.projectId) ?? [];
  const activeRows = rows.filter((r) => r.status === 'active');
  const primary = activeRows.find((r) => r.isPrimary) ?? null;
  const lead: SpineGroup = primary ? groupOf(primary) : { workspaceId: 'unassigned', label: UNASSIGNED_LABEL, hueSlot: null, nodes: [] };
  const groups: SpineGroup[] = [lead];
  const byRow = new Map<ParticipationRow, SpineGroup>();
  if (primary) byRow.set(primary, lead);
  for (const r of activeRows) {
    if (r === primary) continue;
    const g = groupOf(r);
    groups.push(g);
    byRow.set(r, g);
  }
  const group = lead;
  const g = input.git;
  if (g.status !== 'ready') {
    group.nodes.push({ kind: 'source', id: 'source', vcs: g.status === 'error' ? 'error' : 'unknown', branch: null, head: null });
  } else if (!g.isRepo) {
    group.nodes.push({ kind: 'source', id: 'source', vcs: 'none', branch: null, head: null });
  } else {
    group.nodes.push({ kind: 'source', id: 'source', vcs: 'git', branch: g.branch, head: g.head ? { shortSha: g.head.shortSha, subject: g.head.subject } : null });
    if (g.changed.length > 0) group.nodes.push({ kind: 'changes', id: 'changes', fileCount: g.changed.length });
  }
  const inactive = new Map<ParticipationRow, SpineGroup>();
  const ownerRow = (a: ArtifactSummary['artifact']): ParticipationRow | null =>
    rows.find((r) => r.id === a.ownerParticipationId)
    ?? (a.ownerWorkspaceId ? activeRows.find((r) => r.workspaceId === a.ownerWorkspaceId) ?? rows.find((r) => r.workspaceId === a.ownerWorkspaceId) : undefined)
    ?? null;
  const ordered = [...(input.artifacts ?? [])].filter((s) => s.artifact.status === 'active')
    .sort((x, y) => x.artifact.createdAt - y.artifact.createdAt || (x.artifact.id < y.artifact.id ? -1 : x.artifact.id > y.artifact.id ? 1 : 0));
  for (const s of ordered) {
    const v = shownVersionOf(s);
    if (!v) continue;
    const row = ownerRow(s.artifact);
    let target = row ? byRow.get(row) : lead;
    if (!target && row) {
      target = inactive.get(row);
      if (!target) { target = { ...groupOf(row), muted: row.status === 'complete' ? 'complete' : 'withdrawn' }; inactive.set(row, target); }
    }
    (target ?? lead).nodes.push({
      kind: 'artifact', id: `artifact:${s.artifact.id}`, artifactId: s.artifact.id, artifactKind: s.artifact.kind,
      name: s.artifact.name, versionNo: v.versionNo, status: v.status, isCurrent: v.isCurrent
    });
  }
  // Muted groups follow the active ones, in the participation order.
  for (const r of rows) { const m = inactive.get(r); if (m) groups.push(m); }
  return groups;
}

/** What the line under the spine says about artifacts:
 *  - loading: before the first answer (a neutral line, never the placeholder);
 *  - error: the read failed (the errorCopy sentence, with "Try again" when a retry can help);
 *  - empty: the read succeeded and the project has no artifact node (the placeholder);
 *  - null: artifact nodes are on the spine. */
export type SpineLine = { kind: 'loading' } | { kind: 'error'; text: string; retry: boolean } | { kind: 'empty' } | null;

export function spineLine(a: { loaded: boolean; error: string | null; retry: boolean }, groups: SpineGroup[]): SpineLine {
  if (a.error) return { kind: 'error', text: a.error, retry: a.retry };
  if (!a.loaded) return { kind: 'loading' };
  return hasArtifactNodes(groups) ? null : { kind: 'empty' };
}

/** True when any artifact node is on the spine (the placeholder line shows only while there is none). */
export function hasArtifactNodes(groups: SpineGroup[]): boolean {
  return groups.some((g) => g.nodes.some((n) => n.kind === 'artifact'));
}

export function nodeLabel(n: SpineNode): string {
  if (n.kind === 'artifact') return `${kindLabel(n.artifactKind)} ${n.name}, version ${n.versionNo}, ${statusLabel(n.status)}`;
  if (n.kind === 'changes') return `Uncommitted changes, ${n.fileCount} ${n.fileCount === 1 ? 'file' : 'files'}`;
  if (n.vcs === 'none') return 'Project folder, not a git repository';
  if (n.vcs === 'error') return 'Project folder, git status unavailable';
  if (n.vcs === 'unknown') return 'Project folder, reading git status';
  const parts = ['Repository'];
  if (n.branch) parts.push(`branch ${n.branch}`);
  if (n.head) parts.push(`last commit ${n.head.shortSha} ${n.head.subject}`);
  return parts.join(', ');
}

export function tabStopId(nodeIds: string[], selectedId: string): string | null {
  if (nodeIds.length === 0) return null;
  return nodeIds.includes(selectedId) ? selectedId : nodeIds[0];
}

export function kindOf(index: string, worktree: string): ChangeKind {
  const c = (index.trim() || worktree.trim())[0];
  return c === 'A' ? 'added' : c === 'D' ? 'deleted' : c === 'R' ? 'renamed' : 'modified';
}

// ---------- B2a: the checks word of each artifact node ----------

/** The shown versions whose checks the Spine reads (kinds that are checked before they leave draft), capped. */
export const SPINE_CHECK_READS = 40;
export function checkedVersionIds(artifacts: readonly ArtifactSummary[]): { nodeId: string; versionId: string; status: VersionStatus }[] {
  const out: { nodeId: string; versionId: string; status: VersionStatus }[] = [];
  for (const s of artifacts) {
    if (s.artifact.status !== 'active' || !kindIsChecked(s.artifact.kind)) continue;
    const v = shownVersionOf(s);
    if (v) out.push({ nodeId: `artifact:${s.artifact.id}`, versionId: v.id, status: v.status });
  }
  return out.slice(0, SPINE_CHECK_READS);
}

/**
 * Which of the wanted versions to read again after a change: a version not read yet, one whose status changed since
 * it was read, and every draft (its checks are what is still moving). A candidate or active version's blocking
 * results do not change without its status changing, so it is not read again (a finished job costs a few reads, not
 * one per node).
 */
export function versionsToRead<T extends { versionId: string; status: VersionStatus }>(wanted: readonly T[], readAt: ReadonlyMap<string, VersionStatus>): T[] {
  return wanted.filter((w) => w.status === 'draft' || readAt.get(w.versionId) !== w.status);
}

/** Node id -> its checks word, from the versions read (validation state and status); a node without one is left out. */
export function spineChecks(reads: readonly { nodeId: string; validationState: 'pending' | 'passed' | 'failed' | 'error'; status: VersionStatus }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of reads) { const w = checksWord(r.validationState, r.status); if (w) m.set(r.nodeId, w); }
  return m;
}

/**
 * The checks words with each draft application node said from its records (B2a stabilization): its health check runs
 * only on a dev deployment, so a draft with none reads "Ready to check — start a preview", one whose deployment is starting reads
 * "Checking: …", and one nothing can be said about (checks or deployments unread) has no word, never "Checking…".
 */
export function withApplicationWords(words: ReadonlyMap<string, string>, artifacts: readonly ArtifactSummary[],
  validators: ReadonlyMap<string, ValidatorStatuses> | null,
  deployments: readonly (PreviewDeployment & { subjectVersionId: string; jobId?: string })[] | null,
  /** Live jobs and each application version's build: a preview job not yet leased counts for its own version only. */
  pending: { jobs: readonly Pick<JobView, 'id' | 'state' | 'actionId' | 'inputs' | 'createdAt'>[]; builds: ReadonlyMap<string, string> } | null = null): Map<string, string> {
  const out = new Map(words);
  for (const s of artifacts) {
    if (s.artifact.status !== 'active' || s.artifact.kind !== 'application') continue;
    const v = shownVersionOf(s);
    if (!v || v.status !== 'draft') continue;
    const nodeId = `artifact:${s.artifact.id}`;
    const own = deployments ? deployments.filter((d) => d.subjectVersionId === v.id).map((d) => ({ status: d.status, startedAt: d.startedAt })) : null;
    const notLeased = own && deployments && pending && pending.builds.get(v.id)
      ? livePreviewsOf({ versionId: v.id, buildVersionId: pending.builds.get(v.id)! },
        deployments.map((d) => ({ jobId: d.jobId ?? '', subjectVersionId: d.subjectVersionId, status: d.status, startedAt: d.startedAt })), pending.jobs)
        .filter((x) => !own.some((o) => o.status === x.status && o.startedAt === x.startedAt))
      : [];
    const p = applicationPreview({ status: v.status, validators: validators?.get(v.id) ?? null, deployments: own ? [...own, ...notLeased] : null });
    if (p && p.state !== 'draft') out.set(nodeId, p.word);
    else if (out.get(nodeId) === 'Checking…') out.delete(nodeId);
  }
  return out;
}

// ---------- B2a Task 15: the records behind each group's lifecycle rail ----------

export type ValidatorStatuses = Readonly<Record<string, 'passed' | 'failed' | 'error' | 'skipped'>>;

/** The shown application draft versions (the ones whose preview state the rail and the Spine read), at most `cap`. */
export function applicationDrafts(artifacts: readonly ArtifactSummary[], cap = 4): string[] {
  const out: string[] = [];
  for (const s of artifacts) {
    if (s.artifact.status !== 'active' || s.artifact.kind !== 'application') continue;
    const v = shownVersionOf(s);
    if (v && v.status === 'draft') out.push(v.id);
  }
  return out.slice(0, cap);
}

/** A project-owned artifact (a repository snapshot): no participation owns it, so it is a record of every group's rail. */
export const projectOwned = (a: Pick<ArtifactSummary['artifact'], 'ownerWorkspaceId' | 'ownerParticipationId'>): boolean =>
  !a.ownerWorkspaceId && !a.ownerParticipationId;

/**
 * The records of one participation group: the shown versions of the artifacts it owns and of the project-owned ones
 * (a repository snapshot is the project's, and the SDE Repository step is done on it), each with the latest blocking
 * result per validator (read with #32), the live jobs' actions and whether a dev deployment answers. Null while the
 * checks could not be read: the rail then claims no state at all.
 */
export function railRecordsFor(i: {
  workspaceId: string; artifacts: readonly ArtifactSummary[]; checks: ReadonlyMap<string, ValidatorStatuses> | null;
  liveActions: readonly string[]; deploymentHealthy: boolean; participating: boolean;
}): RailRecords | null {
  if (!i.checks) return null;
  const versions: RailRecords['versions'] = [];
  for (const s of i.artifacts) {
    if (s.artifact.status !== 'active' || !(s.artifact.ownerWorkspaceId === i.workspaceId || projectOwned(s.artifact))) continue;
    const v = shownVersionOf(s);
    if (!v) continue;
    // A checked kind whose version was not read (past SPINE_CHECK_READS) has no known results: it is marked unread,
    // so its step claims no state, never "In progress" from an empty list. An unchecked kind has no checks to read.
    const read = i.checks.get(v.id);
    if (read) versions.push({ kind: s.artifact.kind, status: v.status, validators: read });
    else if (kindIsChecked(s.artifact.kind)) versions.push({ kind: s.artifact.kind, status: v.status, validators: {}, unread: true });
    else versions.push({ kind: s.artifact.kind, status: v.status, validators: {} });
  }
  // The iteration record: a change set with a second or later version that passed its checks (a version past candidate means every
  // blocking change-set check passed). One change set alone is never an iteration.
  const changeRevised = i.artifacts.some((s) => s.artifact.kind === 'change_set' && s.artifact.status === 'active'
    && (s.artifact.ownerWorkspaceId === i.workspaceId || projectOwned(s.artifact))
    && ((s.latest !== null && s.latest.versionNo >= 2 && (s.latest.status === 'candidate' || s.latest.status === 'active'))
      || (s.current !== null && s.current.versionNo >= 2)));
  return { versions, liveActions: i.liveActions, participation: i.participating, deploymentHealthy: i.deploymentHealthy, changeRevised };
}
