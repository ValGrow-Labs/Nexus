// Pure: how artifacts and their versions read on the Spine and in the artifact
// Passport. Labels, the actions the platform would allow on a version, and the
// Passport view built from what the nexus:* read channels returned, and how the
// Passport's version actions move through confirmation, pending and result.
// No React, so tests load it directly. Nothing here invents a row: every value
// comes from an IPC answer or from the project's own git log.
import type { VersionStatus } from '@shared/nexus/platform';
import type {
  ArtifactDetail, ArtifactSummaryView, ArtifactView, LineageNodeView, LineageView, NexusFail, NexusResult, VersionContent, VersionView
} from '@shared/nexus/ipc';
import { getDomain } from '@shared/nexus/domains';
import { blockingValidatorsFor } from '@shared/nexus/validators';
import { errorCopy } from '../data/errorCopy';

const KIND_LABEL: Record<string, string> = {
  git_commit: 'Commit', text_file: 'Text file', handoff_receipt: 'Received',
  // B2a kinds that the plain words would misname.
  repository: 'Repository snapshot', problem_statement: 'Problem statement', diagnostic_report: 'Diagnostic report'
};

/** "Commit", "Text file", "Received"; any other kind reads as its words ("change_set" → "Change set"). */
export function kindLabel(kind: string): string {
  const known = KIND_LABEL[kind];
  if (known) return known;
  const words = kind.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Artifact';
}

/** A kind in its workspace's own words (the registry's vocabulary: a DA problem statement is a "Business question"). */
export function kindLabelIn(kind: string, workspaceId: string | null | undefined): string {
  const v = workspaceId ? getDomain(workspaceId)?.vocabulary[kind] : undefined;
  return v ? v.singular : kindLabel(kind);
}

/** True when versions of this kind are checked before they leave draft (their validation state means something). */
export const kindIsChecked = (kind: string): boolean => blockingValidatorsFor(kind).length > 0;

const STATUS_LABEL: Record<VersionStatus, string> = { draft: 'draft', candidate: 'ready', active: 'active', failed: 'failed', deprecated: 'deprecated' };

/** Status is always said in words, never by colour alone. */
export function statusLabel(status: VersionStatus): string {
  return STATUS_LABEL[status] ?? status;
}

/** "derived_from" → "derived from". */
export function relationLabel(relation: string): string {
  return relation.replace(/_/g, ' ');
}

// ---------- version actions (the rules) ----------

export type VersionAction =
  | { kind: 'markReady'; versionId: string }
  | { kind: 'discard'; versionId: string }
  | { kind: 'promote'; versionId: string; expectedCurrentVersionId: string | null }
  | { kind: 'rollback'; versionId: string; expectedCurrentVersionId: string | null }
  | { kind: 'handoff'; versionId: string };

type ActionVersion = Pick<VersionView, 'id' | 'status' | 'producedByEngine' | 'promotedAt'>;
type ActionArtifact = Pick<ArtifactView, 'status' | 'ownerScope' | 'currentVersionId'> & Partial<Pick<ArtifactView, 'kind'>>;

/**
 * Only the actions the platform would allow on this version. A frozen owner (its
 * participation is not active), an archived artifact or a project-owned one
 * offers no write action. Promote and roll back carry the artifact's current
 * version as the compare-and-set value.
 */
export function actionsFor(version: ActionVersion, artifact: ActionArtifact, ownerActive: boolean): VersionAction[] {
  if (!ownerActive || artifact.status !== 'active' || artifact.ownerScope !== 'participation') return [];
  // B2b: a change made by the agent becomes current only by Accept (it puts the change on the Nexus branch first), never by a
  // bare "Make current", which would skip the review and the branch.
  if (artifact.kind === 'change_set' && (version.status === 'candidate' || version.status === 'deprecated')) {
    return version.status === 'candidate' ? [{ kind: 'discard', versionId: version.id }] : [];
  }
  const id = version.id;
  const expected = artifact.currentVersionId ?? null;
  switch (version.status) {
    case 'draft':
      return version.producedByEngine ? [{ kind: 'discard', versionId: id }] : [{ kind: 'markReady', versionId: id }, { kind: 'discard', versionId: id }];
    case 'candidate':
      return [{ kind: 'promote', versionId: id, expectedCurrentVersionId: expected }, { kind: 'discard', versionId: id }];
    case 'active':
      return [{ kind: 'handoff', versionId: id }];
    case 'deprecated':
      return version.promotedAt !== null ? [{ kind: 'rollback', versionId: id, expectedCurrentVersionId: expected }] : [];
    default:
      return [];
  }
}

// ---------- the project's artifact summaries ----------

export interface ArtifactsState {
  artifacts: ArtifactSummaryView[];
  /** True once an answer arrived (success or not). */
  loaded: boolean;
  /** A passing failure worth a sentence; null on success and while the platform is off (its notice says so). */
  error: string | null;
  /** True when sending the same read again may help (a busy database, an unexpected failure). */
  retry: boolean;
  /** True when the project has more artifacts than nexus:artifacts:byProject returns (its 1000-row cap). */
  truncated: boolean;
}

export const NO_ARTIFACTS: ArtifactsState = { artifacts: [], loaded: false, error: null, retry: false, truncated: false };

/**
 * The Spine's note when the project has more artifacts than the read returns. The read is capped at 1000
 * artifacts in creation order (oldest first), so the note says which ones are shown.
 */
export const SPINE_TRUNCATED_TEXT = 'Only the first 1000 artifacts of this project are shown, oldest first.';

/** The next state after a nexus:artifacts:byProject answer. */
export function nextArtifacts(prev: ArtifactsState, r: NexusResult<ArtifactSummaryView[]>): ArtifactsState {
  if (r.ok) return { artifacts: Array.isArray(r.data) ? r.data : [], loaded: true, error: null, retry: false, truncated: r.truncated === true };
  const copy = errorCopy(r.code, r.reason, r.subReason);
  // The platform is off: there is nothing to show, and the platform notice explains why.
  if (copy.kind === 'unavailable') return { artifacts: [], loaded: true, error: null, retry: false, truncated: false };
  // The project is gone or unreadable: show nothing rather than stale nodes.
  if (r.code === 'not_found' || r.code === 'denied') return { artifacts: [], loaded: true, error: copy.text, retry: false, truncated: false };
  // A passing failure: keep what was last read, and whether it was capped.
  return { artifacts: prev.artifacts, loaded: true, error: copy.text, retry: copy.retry, truncated: prev.truncated };
}

// ---------- the artifact Passport (read-only) ----------

export interface PassportVersionRow {
  id: string;
  versionNo: number;
  /** "draft", "ready", "active", ... */
  status: string;
  current: boolean;
  /** The version the Spine node shows. */
  shown: boolean;
  /** What the version holds: "Commit <full sha>", "File <path>", "Received through a handoff"; null while unknown. */
  content: string | null;
  /** A git version's subject, only when the project's own git log knows that commit. */
  subject: string | null;
}

export interface PassportLink { versionId: string; label: string; relation: string; status: string }

export interface ArtifactPassportView {
  title: string;
  kind: string;
  rows: { label: string; value: string }[];
  versions: PassportVersionRow[];
  upstream: PassportLink[] | null;
  downstream: PassportLink[] | null;
  upstreamTruncated: boolean;
  downstreamTruncated: boolean;
}

export interface ArtifactPassportInput {
  detail: ArtifactDetail;
  /** The version the Spine node shows (current, else latest). */
  shownVersionId: string | null;
  /** Owner workspace as shown: its label, and whether the participation is still active. */
  owner: { label: string; active: boolean } | null;
  contents: ReadonlyMap<string, VersionContent>;
  /** sha → subject, from the project's own git log only (the allow-list for commit subjects). */
  subjects: ReadonlyMap<string, string>;
  /** artifactId → name, from the project's artifact summaries. */
  names: ReadonlyMap<string, string>;
  up: LineageView | null;
  down: LineageView | null;
}

function contentText(c: VersionContent | undefined): string | null {
  if (!c) return null;
  if (c.type === 'git') return `Commit ${c.commit}`;
  if (c.type === 'text') return `File ${c.path}`;
  if (c.type === 'receipt') return 'Received through a handoff';
  return null;
}

function linkOf(n: LineageNodeView, names: ReadonlyMap<string, string>): PassportLink {
  const name = names.get(n.artifactId);
  const label = name ? `${kindLabel(n.kind)} ${name}, version ${n.versionNo}` : `${kindLabel(n.kind)}, version ${n.versionNo}`;
  return { versionId: n.versionId, label, relation: relationLabel(n.relation), status: statusLabel(n.status) };
}

/** Which version a Spine node stands for: the current one, else the latest. */
export function shownVersionOf(s: Pick<ArtifactSummaryView, 'current' | 'latest'>): { id: string; versionNo: number; status: VersionStatus; isCurrent: boolean } | null {
  if (s.current) return { id: s.current.id, versionNo: s.current.versionNo, status: 'active', isCurrent: true };
  if (s.latest) return { id: s.latest.id, versionNo: s.latest.versionNo, status: s.latest.status, isCurrent: false };
  return null;
}

/**
 * The read-only Passport for one artifact. Only allow-listed fields are copied:
 * no principal, actor or participation id ever reaches the view.
 */
export function artifactPassportView(i: ArtifactPassportInput): ArtifactPassportView {
  const a = i.detail.artifact;
  const versions = [...i.detail.versions].sort((x, y) => y.versionNo - x.versionNo);
  const current = versions.find((v) => v.id === a.currentVersionId) ?? null;
  const rows: { label: string; value: string }[] = [{ label: 'Kind', value: kindLabel(a.kind) }];
  if (i.owner) rows.push({ label: 'Workspace', value: i.owner.active ? i.owner.label : `${i.owner.label} (withdrawn)` });
  rows.push({ label: 'Current version', value: current ? `Version ${current.versionNo}` : 'None yet' });
  rows.push({ label: 'Versions', value: String(versions.length) });
  if (a.status === 'archived') rows.push({ label: 'Status', value: 'Archived' });
  if (a.description) rows.push({ label: 'Description', value: a.description });
  return {
    title: a.name,
    kind: kindLabel(a.kind),
    rows,
    versions: versions.map((v) => {
      const c = i.contents.get(v.id);
      const subject = c && c.type === 'git' ? i.subjects.get(c.commit) ?? null : null;
      return { id: v.id, versionNo: v.versionNo, status: statusLabel(v.status), current: v.id === a.currentVersionId, shown: v.id === i.shownVersionId, content: contentText(c), subject };
    }),
    upstream: i.up ? i.up.nodes.map((n) => linkOf(n, i.names)) : null,
    downstream: i.down ? i.down.nodes.map((n) => linkOf(n, i.names)) : null,
    upstreamTruncated: !!i.up?.truncated,
    downstreamTruncated: !!i.down?.truncated
  };
}

// ---------- version actions in the Passport (confirmation, pending, result) ----------

/** The writes the artifact Passport sends. 'link' adds a source to the shown version. */
export type PassportActionKind = 'markReady' | 'promote' | 'rollback' | 'discard' | 'link';

/** Discard and roll back change what a person relies on, so they ask first. */
export function needsConfirm(kind: PassportActionKind): kind is 'discard' | 'rollback' {
  return kind === 'discard' || kind === 'rollback';
}

export interface ActionState {
  /** The one action in flight; every action button is disabled while it is set. */
  pending: { kind: PassportActionKind; versionId: string } | null;
  /** The destructive action waiting for the person's confirmation. */
  confirming: { kind: 'discard' | 'rollback'; versionId: string } | null;
  /** The failure sentence (the role="alert" line). */
  error: string | null;
  /** The success sentence (the role="status" line). */
  announce: string | null;
}

export const IDLE_ACTIONS: ActionState = { pending: null, confirming: null, error: null, announce: null };

/** Ask to confirm a discard or a roll back. Ignored while an action is running. */
export function askActionConfirm(s: ActionState, kind: 'discard' | 'rollback', versionId: string): ActionState {
  return s.pending ? s : { pending: null, confirming: { kind, versionId }, error: null, announce: null };
}

export function cancelActionConfirm(s: ActionState): ActionState {
  return s.pending ? s : { ...s, confirming: null };
}

/**
 * Start an action; null while another one is running (no double submit). A
 * destructive action starts only from its own open confirmation.
 */
export function beginAction(s: ActionState, kind: PassportActionKind, versionId: string): ActionState | null {
  if (s.pending) return null;
  if (needsConfirm(kind) && (!s.confirming || s.confirming.kind !== kind || s.confirming.versionId !== versionId)) return null;
  return { pending: { kind, versionId }, confirming: s.confirming, error: null, announce: null };
}

/** Any answer ends the action: the buttons come back and the confirmation closes. */
export function actionSucceeded(_s: ActionState, announce: string): ActionState {
  return { pending: null, confirming: null, error: null, announce };
}

export function actionFailed(_s: ActionState, error: string): ActionState {
  return { pending: null, confirming: null, error, announce: null };
}

/** A promote or roll back lost its compare-and-set: another version was made current first. */
export const PROMOTE_CONFLICT_TEXT = 'The current version changed; the list is refreshed';
/** A link that would make a loop. */
export const LINK_CYCLE_TEXT = 'That version already depends on this one, so it cannot also be its source. Nothing was linked.';
/** A source the service refused as a draft or as another project's version. */
export const LINK_INVALID_TEXT = 'That version cannot be a source here: it is still a draft or belongs to another project. Nothing was linked.';

/** The sentence for a failed Passport action. */
export function actionFailureText(kind: PassportActionKind, r: Pick<NexusFail, 'code' | 'reason' | 'subReason'>): string {
  if ((kind === 'promote' || kind === 'rollback') && r.code === 'conflict') return PROMOTE_CONFLICT_TEXT;
  if (kind === 'link' && r.code === 'cycle') return LINK_CYCLE_TEXT;
  if (kind === 'link' && r.code === 'invalid' && !r.reason) return LINK_INVALID_TEXT;
  return errorCopy(r.code, r.reason, r.subReason).text;
}

/**
 * Whether what the Passport shows may be stale after this failure, so every
 * reader loads again (rev). A refusal that changed nothing and says nothing
 * about the shown data (a cycle, a bad request, a busy database) keeps the
 * screen as it is.
 */
export function shouldReloadAfterAction(r: Pick<NexusFail, 'code' | 'reason'>): boolean {
  switch (r.code) {
    case 'conflict': case 'not_found': case 'illegal_transition': case 'participation_inactive': return true;
    case 'invalid': return r.reason !== 'bad_request' && r.reason !== 'produced_by_job';
    case 'platform_unavailable': return r.reason !== 'busy' && r.reason !== 'handoffs_unavailable';
    default: return false;
  }
}

const ACTION_TEXT: Record<PassportActionKind, { idle: string; pending: string }> = {
  markReady: { idle: 'Mark ready', pending: 'Marking ready…' },
  promote: { idle: 'Make current', pending: 'Making current…' },
  rollback: { idle: 'Roll back', pending: 'Rolling back…' },
  discard: { idle: 'Discard', pending: 'Discarding…' },
  link: { idle: 'Link a source…', pending: 'Linking…' }
};

/** A button's words, idle or while its own action runs. */
export function actionLabel(kind: PassportActionKind, pending: boolean): string {
  return pending ? ACTION_TEXT[kind].pending : ACTION_TEXT[kind].idle;
}

/** The status line while an action runs; focus rests on it so it never falls to the page. */
export function actionPendingText(kind: PassportActionKind, versionNo: number): string {
  switch (kind) {
    case 'markReady': return `Marking version ${versionNo} ready…`;
    case 'promote': return `Making version ${versionNo} current…`;
    case 'rollback': return `Rolling back to version ${versionNo}…`;
    case 'discard': return `Discarding version ${versionNo}…`;
    case 'link': return `Linking a source to version ${versionNo}…`;
  }
}

/** The confirmation question for a destructive action. */
export function confirmText(kind: 'discard' | 'rollback', versionNo: number, currentNo: number | null): string {
  if (kind === 'discard') return `Discard version ${versionNo}? It stays in the history as discarded and can no longer be made ready or current.`;
  return currentNo !== null
    ? `Make version ${versionNo} current again? Version ${currentNo} stops being current.`
    : `Make version ${versionNo} current again?`;
}

/** The sentence after a successful action. */
export function actionDoneText(kind: PassportActionKind, versionNo: number, o: { created?: number; sourceLabel?: string } = {}): string {
  switch (kind) {
    case 'markReady': return `Version ${versionNo} is ready.`;
    case 'promote': return `Version ${versionNo} is now current.`;
    case 'rollback': return `Rolled back: version ${versionNo} is current again.`;
    case 'discard': return `Version ${versionNo} was discarded.`;
    case 'link': {
      const what = o.sourceLabel ?? 'That version';
      return o.created === 0 ? `${what} was already a source of version ${versionNo}.` : `${what} is now a source of version ${versionNo}.`;
    }
  }
}

type PassportVersionAction = Exclude<VersionAction, { kind: 'handoff' }>;

/**
 * The Passport's actions on one version: exactly what actionsFor allows, only
 * while platform writes are on. Hand off is left to the handoff sheet.
 */
export function passportActionsFor(version: ActionVersion, artifact: ActionArtifact, ownerActive: boolean, canWrite: boolean): PassportVersionAction[] {
  if (!canWrite) return [];
  return actionsFor(version, artifact, ownerActive).filter((a): a is PassportVersionAction => a.kind !== 'handoff');
}

/** Whether sources may be linked to a version of this artifact: the same writability rule as every version action. */
export function canLinkSources(artifact: ActionArtifact, ownerActive: boolean, canWrite: boolean): boolean {
  return canWrite && ownerActive && artifact.status === 'active' && artifact.ownerScope === 'participation';
}

// ---------- link sources: the versions a person may pick ----------

export interface SourceChoice { versionId: string; label: string; status: string }

/** How many other artifacts the picker reads (most recently changed first); more are left out, and the picker says so. */
export const LINK_CANDIDATE_ARTIFACTS = 30;

/** The other artifacts whose versions the picker reads: not archived, with versions, most recently changed first, capped. */
export function candidateArtifactIds(selfArtifactId: string, summaries: readonly ArtifactSummaryView[]): { ids: string[]; capped: boolean } {
  const others = summaries.filter((s) => s.artifact.id !== selfArtifactId && s.artifact.status === 'active' && s.versionCount > 0)
    .sort((x, y) => y.artifact.updatedAt - x.artifact.updatedAt);
  return { ids: others.slice(0, LINK_CANDIDATE_ARTIFACTS).map((s) => s.artifact.id), capped: others.length > LINK_CANDIDATE_ARTIFACTS };
}

/**
 * The versions a person may link as sources: versions the platform returned for
 * this project, out of draft (ready or active), of another artifact that is not
 * archived, and not already linked. Never an id typed by hand.
 */
export function sourceChoices(selfArtifactId: string, projectId: string, details: readonly ArtifactDetail[], alreadyLinked: ReadonlySet<string>): SourceChoice[] {
  const out: (SourceChoice & { name: string; versionNo: number })[] = [];
  for (const d of details) {
    const a = d.artifact;
    if (a.id === selfArtifactId || a.status !== 'active' || a.projectId !== projectId) continue;
    for (const v of d.versions) {
      if (v.artifactId !== a.id || v.projectId !== projectId) continue;
      if (v.status !== 'candidate' && v.status !== 'active') continue;
      if (alreadyLinked.has(v.id)) continue;
      out.push({ versionId: v.id, label: `${kindLabel(a.kind)} ${a.name}, version ${v.versionNo}`, status: statusLabel(v.status), name: a.name, versionNo: v.versionNo });
    }
  }
  out.sort((x, y) => x.name.localeCompare(y.name) || y.versionNo - x.versionNo);
  return out.map(({ versionId, label, status }) => ({ versionId, label, status }));
}
