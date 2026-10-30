// Pure: how handoffs read on the Handoffs page, in the artifact Passport and in
// the send sheet. The list views (inbox and sent per workspace), the detail with
// its subjects shown by reference, which answer each side may give, how an
// answer moves through confirmation, pending and result, and the send sheet's
// choices and checks. No React, so tests load it directly. Nothing here invents a
// row: every value comes from a nexus:* answer or the renderer's workspace
// registry. No principal or participation id is ever put into a view.
import type { HandoffStatus } from '@shared/nexus/platform';
import type {
  ArtifactDetail, ArtifactSummaryView, HandoffDetailView, HandoffSubjectView, HandoffSummaryView, HandoffsListFilter, NexusFail,
  NexusResult, SendHandoffArgs, VersionDetail
} from '@shared/nexus/ipc';
import { errorCopy } from '../data/errorCopy';
import { kindLabel, statusLabel } from '../project/artifactModel';
import { isPlatformId } from '../router/routes';
import { WORKSPACES } from '../workspaces/registry';
import { activeWorkspacesOf, viewOf, type ParticipationIndex } from '../workspaces/participation';

/** The page lead, said once. */
export const HANDOFFS_LEAD = 'A handoff passes a saved item to another workspace in the same project.';

// ---------- status ----------

export const HANDOFF_STATUSES: readonly HandoffStatus[] = Object.freeze(['sent', 'accepted', 'declined', 'withdrawn'] as HandoffStatus[]);

const STATUS_TEXT: Record<HandoffStatus, string> = {
  sent: 'Sent, waiting for an answer',
  accepted: 'Accepted',
  declined: 'Declined',
  withdrawn: 'Taken back'
};

/** Status is always said in words, never by colour alone; an unknown status reads as its words. */
export function handoffStatusLabel(status: string): string {
  if (Object.prototype.hasOwnProperty.call(STATUS_TEXT, status)) return STATUS_TEXT[status as HandoffStatus];
  const words = typeof status === 'string' ? status.replace(/[^A-Za-z0-9]+/g, ' ').trim() : '';
  return words ? words[0].toUpperCase() + words.slice(1) : 'Unknown status';
}

/** The short form for a filter option. */
export function handoffStatusOption(status: HandoffStatus): string {
  return status === 'sent' ? 'Waiting for an answer' : STATUS_TEXT[status];
}

// ---------- the list view ----------

export type HandoffBox = 'inbox' | 'sent' | 'all';
export const HANDOFF_BOXES: readonly HandoffBox[] = Object.freeze(['inbox', 'sent', 'all'] as HandoffBox[]);
export const BOX_LABEL: Record<HandoffBox, string> = { inbox: 'Received', sent: 'Sent', all: 'All' };

export interface HandoffView {
  box: HandoffBox;
  /** '' for every workspace. */
  workspaceId: string;
  /** '' for every status. */
  status: '' | HandoffStatus;
}

export const DEFAULT_HANDOFF_VIEW: HandoffView = Object.freeze({ box: 'inbox', workspaceId: '', status: '' }) as HandoffView;

export const HANDOFF_PAGE = 100;
export const HANDOFF_LIST_MAX = 500;
const WORKSPACE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function clampLimit(n: number): number {
  return Number.isInteger(n) && n >= 1 ? Math.min(n, HANDOFF_LIST_MAX) : HANDOFF_PAGE;
}

export function nextHandoffLimit(limit: number): number {
  return Math.min(clampLimit(limit) + HANDOFF_PAGE, HANDOFF_LIST_MAX);
}

/** The nexus:handoffs:list argument: only the keys the view sets, only in the shape main accepts. */
export function handoffListRequest(v: HandoffView, limit: number): HandoffsListFilter {
  const out: HandoffsListFilter = { box: HANDOFF_BOXES.includes(v.box) ? v.box : 'inbox', limit: clampLimit(limit) };
  if (v.workspaceId && WORKSPACE_ID_RE.test(v.workspaceId)) out.workspaceId = v.workspaceId;
  if (v.status && HANDOFF_STATUSES.includes(v.status)) out.status = v.status;
  return out;
}

export function handoffViewKey(v: HandoffView): string {
  return `${v.box}|${v.workspaceId}|${v.status}`;
}

/** Inbox and sent of one workspace. */
export interface WorkspaceBoxes { inbox: HandoffSummaryView[]; sent: HandoffSummaryView[] }

/**
 * Inbox and sent, per workspace: a handoff is in the inbox of the workspace it was sent to and in the sent
 * box of the workspace it came from, nowhere else. The input order is kept inside each box.
 */
export function partitionByWorkspace(rows: readonly HandoffSummaryView[]): Map<string, WorkspaceBoxes> {
  const out = new Map<string, WorkspaceBoxes>();
  const boxes = (ws: string): WorkspaceBoxes => {
    let b = out.get(ws);
    if (!b) { b = { inbox: [], sent: [] }; out.set(ws, b); }
    return b;
  };
  for (const h of rows) {
    boxes(h.toWorkspaceId).inbox.push(h);
    boxes(h.fromWorkspaceId).sent.push(h);
  }
  return out;
}

export interface HandoffGroup {
  /** The workspace the group is the inbox or sent box of; null for the single "All" group. */
  workspaceId: string | null;
  title: string;
  hueSlot: number | null;
  rows: HandoffSummaryView[];
}

const WS_ORDER = new Map<string, number>(WORKSPACES.map((w, i) => [w.id, i]));
const wsRank = (id: string): number => WS_ORDER.get(id) ?? WORKSPACES.length;

/**
 * The list as shown: the inbox grouped by the receiving workspace ("To Quality"), sent grouped by the
 * sending workspace ("From Engineering"), All as one group. A chosen workspace keeps only its own group.
 * Groups follow registry order; unknown workspace ids come last, by id.
 */
export function handoffGroups(rows: readonly HandoffSummaryView[], view: Pick<HandoffView, 'box' | 'workspaceId'>): HandoffGroup[] {
  if (view.box === 'all') {
    const kept = view.workspaceId ? rows.filter((h) => h.toWorkspaceId === view.workspaceId || h.fromWorkspaceId === view.workspaceId) : [...rows];
    return kept.length ? [{ workspaceId: null, title: 'All handoffs', hueSlot: null, rows: kept }] : [];
  }
  const parts = partitionByWorkspace(rows);
  const ids = [...parts.keys()].filter((id) => !view.workspaceId || id === view.workspaceId)
    .sort((a, b) => wsRank(a) - wsRank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const groups: HandoffGroup[] = [];
  for (const id of ids) {
    const b = parts.get(id)!;
    const list = view.box === 'inbox' ? b.inbox : b.sent;
    if (list.length === 0) continue;
    const v = viewOf(id);
    groups.push({ workspaceId: id, title: `${view.box === 'inbox' ? 'To' : 'From'} ${v.label}`, hueSlot: v.hueSlot, rows: list });
  }
  return groups;
}

export const REMOVED_PROJECT = 'Removed project';

export interface HandoffRowView {
  id: string;
  title: string;
  fromLabel: string;
  toLabel: string;
  fromHue: number | null;
  toHue: number | null;
  /** The project's name; "Removed project" once the project list is read and lacks it; '' before. */
  project: string;
  status: string;
  open: boolean;
  /** "1 version", "3 versions". */
  subjects: string;
  changedAt: number;
}

export function versionsCount(n: number): string {
  return `${n} ${n === 1 ? 'version' : 'versions'}`;
}

/** One list row. Only allow-listed fields: no participation or principal id. */
export function handoffRow(h: HandoffSummaryView, projectNames: ReadonlyMap<string, string>, projectsRead = true): HandoffRowView {
  const from = viewOf(h.fromWorkspaceId);
  const to = viewOf(h.toWorkspaceId);
  const name = projectNames.get(h.projectId);
  return {
    id: h.id, title: h.title, fromLabel: from.label, toLabel: to.label, fromHue: from.hueSlot, toHue: to.hueSlot,
    project: name ?? (projectsRead ? REMOVED_PROJECT : ''), status: handoffStatusLabel(h.status), open: h.status === 'sent',
    subjects: versionsCount(h.subjectCount), changedAt: h.statusChangedAt
  };
}

// ---------- the list read ----------

export interface HandoffListState {
  key: string;
  rows: HandoffSummaryView[];
  loaded: boolean;
  loading: boolean;
  truncated: boolean;
  /** The whole platform is off: nothing can be listed; the platform notice says why. */
  unavailable: boolean;
  /** Handoffs alone are off (schema v8 not in place): the errorCopy sentence with its sub-reason. */
  handoffsOff: string | null;
  error: string | null;
  retry: boolean;
}

export const NO_HANDOFF_LIST: HandoffListState = {
  key: '', rows: [], loaded: false, loading: false, truncated: false, unavailable: false, handoffsOff: null, error: null, retry: false
};

export function startHandoffListRead(prev: HandoffListState, key: string): HandoffListState {
  if (prev.key !== key) return { ...NO_HANDOFF_LIST, key, loading: true };
  return { ...prev, loading: true };
}

/** The next state after a nexus:handoffs:list answer for `key`. An answer for another key changes nothing. */
export function nextHandoffList(prev: HandoffListState, key: string, r: NexusResult<HandoffSummaryView[]>): HandoffListState {
  if (prev.key !== key) return prev;
  if (r.ok) {
    return { ...NO_HANDOFF_LIST, key, rows: Array.isArray(r.data) ? r.data : [], loaded: true, truncated: r.truncated === true };
  }
  const copy = errorCopy(r.code, r.reason, r.subReason);
  if (copy.kind === 'handoffs_unavailable') return { ...NO_HANDOFF_LIST, key, loaded: true, handoffsOff: copy.text };
  if (copy.kind === 'unavailable') return { ...NO_HANDOFF_LIST, key, loaded: true, unavailable: true };
  // A passing failure keeps the rows, but never a stale "handoffs are off" or "unavailable" flag.
  if (copy.retry) return { ...prev, handoffsOff: null, unavailable: false, loaded: true, loading: false, error: copy.text, retry: true };
  return { ...NO_HANDOFF_LIST, key, loaded: true, error: copy.text };
}

export type HandoffListNotice =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'handoffs-off'; text: string }
  | { kind: 'error'; text: string; retry: boolean }
  | { kind: 'empty' }
  | { kind: 'no-match' }
  | null;

export const EMPTY_TITLE = 'No handoffs yet';
export const EMPTY_BODY: Record<HandoffBox, string> = {
  inbox: 'Nothing has been sent to a workspace yet. Open a saved item, choose a version that is ready or in use, and press "Send to another workspace".',
  sent: 'No workspace has sent anything yet. Open a saved item, choose a version that is ready or in use, and press "Send to another workspace".',
  all: 'Nothing has been sent yet. Open a saved item, choose a version that is ready or in use, and press "Send to another workspace".'
};
export const NO_MATCH_TEXT = 'No handoffs match this view.';
export const UNAVAILABLE_LIST_TEXT = 'Nexus cannot read its saved information right now, so handoffs cannot be listed. Restart the app to try again.';

export function handoffListNotice(s: HandoffListState, v: HandoffView): HandoffListNotice {
  if (!s.loaded) return { kind: 'loading' };
  if (s.handoffsOff !== null) return { kind: 'handoffs-off', text: s.handoffsOff };
  if (s.unavailable) return { kind: 'unavailable' };
  if (s.error !== null && s.rows.length === 0) return { kind: 'error', text: s.error, retry: s.retry };
  if (handoffGroups(s.rows, v).length === 0) return v.workspaceId || v.status ? { kind: 'no-match' } : { kind: 'empty' };
  return null;
}

export function staleHandoffError(s: HandoffListState): { text: string; retry: boolean } | null {
  return s.error !== null && s.rows.length > 0 ? { text: s.error, retry: s.retry } : null;
}

export function handoffPaging(s: Pick<HandoffListState, 'loaded' | 'truncated'>, limit: number): 'more' | 'capped' | null {
  if (!s.loaded || !s.truncated) return null;
  return clampLimit(limit) < HANDOFF_LIST_MAX ? 'more' : 'capped';
}

export const CAPPED_TEXT = `Only ${HANDOFF_LIST_MAX} handoffs are listed, open ones first. Choose a workspace or a status to find others.`;

// ---------- the detail read ----------

export interface HandoffDetailState {
  id: string;
  status: 'loading' | 'ready' | 'missing' | 'unavailable' | 'error';
  detail: HandoffDetailView | null;
  /** With 'unavailable': the sentence to show (handoffs off, with the sub-reason, or the whole platform off). */
  notice: string | null;
  error: string | null;
  retry: boolean;
}

export function handoffDetailLoading(id: string): HandoffDetailState {
  return { id, status: 'loading', detail: null, notice: null, error: null, retry: false };
}

export const MISSING_TITLE = 'Handoff not found';
export const MISSING_BODY = 'We cannot find this handoff. It may have been removed, or the link may be wrong.';
export const UNAVAILABLE_DETAIL_TEXT = 'Nexus cannot read its saved information right now, so this handoff cannot be shown. Restart the app to try again.';

function isDetail(d: unknown, id: string): d is HandoffDetailView {
  const x = d as HandoffDetailView | null;
  return !!x && typeof x === 'object' && x.id === id && Array.isArray(x.subjects) && typeof x.status === 'string';
}

/** The next detail state after a nexus:handoff:get (or an answer action) for `id`. Another id changes nothing. */
export function nextHandoffDetail(prev: HandoffDetailState, id: string, r: NexusResult<HandoffDetailView>): HandoffDetailState {
  if (prev.id !== id) return prev;
  if (r.ok) {
    if (!isDetail(r.data, id)) return { ...prev, status: prev.detail ? 'ready' : 'error', error: errorCopy('internal').text, retry: true };
    return { id, status: 'ready', detail: r.data, notice: null, error: null, retry: false };
  }
  if (r.code === 'not_found') return { id, status: 'missing', detail: null, notice: null, error: null, retry: false };
  const copy = errorCopy(r.code, r.reason, r.subReason);
  if (copy.kind === 'handoffs_unavailable') return { id, status: 'unavailable', detail: null, notice: copy.text, error: null, retry: false };
  if (copy.kind === 'unavailable') return { id, status: 'unavailable', detail: null, notice: UNAVAILABLE_DETAIL_TEXT, error: null, retry: false };
  if (copy.retry && prev.detail) return { ...prev, status: 'ready', error: copy.text, retry: true };
  return { id, status: 'error', detail: null, notice: null, error: copy.text, retry: copy.retry };
}

// ---------- subjects, by reference ----------

/** How many characters of a content hash are shown. */
export const HASH_PREFIX = 12;

/** "git:0a1b2c3d4e5f" for a commit, "9f86d081884c" for inline content: a prefix, never the content. */
export function hashPrefix(hash: string): string {
  if (typeof hash !== 'string') return '';
  const i = hash.indexOf(':');
  return i > 0 && i < 12 ? `${hash.slice(0, i + 1)}${hash.slice(i + 1, i + 1 + HASH_PREFIX)}` : hash.slice(0, HASH_PREFIX);
}

/** "A newer version exists" only when the artifact has a version after the one sent. */
export function newerVersionText(s: Pick<HandoffSubjectView, 'versionNo' | 'newerVersionNo'>): string | null {
  return typeof s.newerVersionNo === 'number' && s.newerVersionNo > s.versionNo ? `There is a newer version (version ${s.newerVersionNo}).` : null;
}

export interface SubjectRowView {
  versionId: string;
  artifactId: string;
  /** "Commit API notes". */
  label: string;
  /** "Version 2". */
  version: string;
  hash: string;
  /** The version's status now, in words. */
  status: string;
  newer: string | null;
}

export function subjectRows(subjects: readonly HandoffSubjectView[]): SubjectRowView[] {
  return [...subjects].sort((a, b) => a.position - b.position).map((s) => ({
    versionId: s.versionId, artifactId: s.artifactId, label: `${kindLabel(s.kind)} ${s.artifactName}`, version: `Version ${s.versionNo}`,
    hash: hashPrefix(s.contentHash), status: statusLabel(s.status), newer: newerVersionText(s)
  }));
}

export interface HandoffDetailRows {
  title: string;
  status: string;
  open: boolean;
  fromLabel: string;
  toLabel: string;
  fromHue: number | null;
  toHue: number | null;
  note: string | null;
  responseNote: string | null;
  sentAt: number;
  respondedAt: number | null;
  subjects: SubjectRowView[];
}

/** The detail as shown: labels from the registry, status in words, subjects by reference. */
export function handoffDetailRows(h: HandoffDetailView): HandoffDetailRows {
  const from = viewOf(h.fromWorkspaceId);
  const to = viewOf(h.toWorkspaceId);
  return {
    title: h.title, status: handoffStatusLabel(h.status), open: h.status === 'sent',
    fromLabel: from.label, toLabel: to.label, fromHue: from.hueSlot, toHue: to.hueSlot,
    note: h.note || null, responseNote: h.responseNote || null, sentAt: h.createdAt, respondedAt: h.respondedAt,
    subjects: subjectRows(h.subjects)
  };
}

/** The receipt's artifact id, from the nexus:version:get answer for the receipt version; null when unknown. */
export function receiptArtifactId(receiptVersionId: string | null, r: NexusResult<VersionDetail> | null): string | null {
  if (!receiptVersionId || !r || !r.ok || !r.data || r.data.id !== receiptVersionId) return null;
  return isPlatformId(r.data.artifactId) ? r.data.artifactId : null;
}

export function receiptText(toLabel: string): string {
  return `Accepting added a received item to ${toLabel}. It points to these versions and does not copy them.`;
}

// ---------- answers: who may give which ----------

export type HandoffSide = 'receiving' | 'sending';
export type HandoffActionKind = 'accept' | 'decline' | 'withdraw';

/** The receiving side may accept or decline a handoff that waits; the sending side may withdraw it. Nothing else. */
export function handoffActionsFor(side: HandoffSide, status: string): HandoffActionKind[] {
  if (status !== 'sent') return [];
  return side === 'receiving' ? ['accept', 'decline'] : side === 'sending' ? ['withdraw'] : [];
}

/**
 * Which side the person stands on while viewing: the inbox is the receiving side, Sent the sending side, and a
 * chosen workspace is the side it is on. "All" with no workspace stands on both. A hint for the buttons only;
 * the services decide.
 */
export function sidesFor(h: Pick<HandoffSummaryView, 'fromWorkspaceId' | 'toWorkspaceId'>, view: Pick<HandoffView, 'box' | 'workspaceId'>): HandoffSide[] {
  const ws = view.workspaceId;
  if (view.box === 'inbox') return !ws || ws === h.toWorkspaceId ? ['receiving'] : [];
  if (view.box === 'sent') return !ws || ws === h.fromWorkspaceId ? ['sending'] : [];
  if (ws) return ws === h.toWorkspaceId ? ['receiving'] : ws === h.fromWorkspaceId ? ['sending'] : [];
  return ['receiving', 'sending'];
}

/** The answers shown on the detail: only while platform writes are on, only for the sides being viewed. */
export function detailActions(h: Pick<HandoffSummaryView, 'fromWorkspaceId' | 'toWorkspaceId' | 'status'>, view: Pick<HandoffView, 'box' | 'workspaceId'>, canWrite: boolean): HandoffActionKind[] {
  if (!canWrite) return [];
  return sidesFor(h, view).flatMap((side) => handoffActionsFor(side, h.status));
}

/** Where the answers come from, said once above them. */
export function sideText(sides: readonly HandoffSide[], fromLabel: string, toLabel: string): string | null {
  if (sides.length === 2) return `You can answer for ${toLabel} or take it back for ${fromLabel}.`;
  if (sides[0] === 'receiving') return `Answering for ${toLabel}, the workspace that gets it.`;
  if (sides[0] === 'sending') return `Acting for ${fromLabel}, the workspace that sent it.`;
  return null;
}

// ---------- answers: confirmation, pending, result ----------

export const NOTE_MAX = 2000;

/** The platform's note rule: at most 2,000 characters, no NUL. */
export function validNote(note: string): boolean {
  return typeof note === 'string' && note.length <= NOTE_MAX && !note.includes('\u0000');
}

export interface HandoffActionState {
  pending: HandoffActionKind | null;
  /** Decline and withdraw ask first. */
  confirming: 'decline' | 'withdraw' | null;
  /** The decline note being written (optional). */
  note: string;
  error: string | null;
  announce: string | null;
}

export const IDLE_HANDOFF_ACTIONS: HandoffActionState = { pending: null, confirming: null, note: '', error: null, announce: null };

export function needsHandoffConfirm(kind: HandoffActionKind): kind is 'decline' | 'withdraw' {
  return kind === 'decline' || kind === 'withdraw';
}

export function askHandoffConfirm(s: HandoffActionState, kind: 'decline' | 'withdraw'): HandoffActionState {
  return s.pending ? s : { pending: null, confirming: kind, note: '', error: null, announce: null };
}

export function cancelHandoffConfirm(s: HandoffActionState): HandoffActionState {
  return s.pending ? s : { ...s, confirming: null, note: '' };
}

export function setDeclineNote(s: HandoffActionState, note: string): HandoffActionState {
  return s.pending ? s : { ...s, note };
}

/** Start an answer; null while another runs, when a confirming answer was not confirmed, or with a bad note. */
export function beginHandoffAction(s: HandoffActionState, kind: HandoffActionKind): HandoffActionState | null {
  if (s.pending) return null;
  if (needsHandoffConfirm(kind) && s.confirming !== kind) return null;
  if (kind === 'decline' && !validNote(s.note)) return null;
  return { ...s, pending: kind, error: null, announce: null };
}

export function handoffActionSucceeded(_s: HandoffActionState, announce: string): HandoffActionState {
  return { ...IDLE_HANDOFF_ACTIONS, announce };
}

export function handoffActionFailed(_s: HandoffActionState, error: string): HandoffActionState {
  return { ...IDLE_HANDOFF_ACTIONS, error };
}

/** The note sent with a decline: trimmed, and left out when empty. */
export function declineNoteArg(note: string): string | undefined {
  const t = note.trim();
  return t ? t : undefined;
}

const ACTION_TEXT: Record<HandoffActionKind, { idle: string; pending: string }> = {
  accept: { idle: 'Accept', pending: 'Accepting…' },
  decline: { idle: 'Decline', pending: 'Declining…' },
  withdraw: { idle: 'Take back', pending: 'Taking back…' }
};

export function handoffActionLabel(kind: HandoffActionKind, pending: boolean): string {
  return pending ? ACTION_TEXT[kind].pending : ACTION_TEXT[kind].idle;
}

export function handoffPendingText(kind: HandoffActionKind): string {
  switch (kind) {
    case 'accept': return 'Accepting the handoff…';
    case 'decline': return 'Declining the handoff…';
    case 'withdraw': return 'Taking the handoff back…';
  }
}

export function handoffConfirmText(kind: 'decline' | 'withdraw', fromLabel: string, toLabel: string): string {
  return kind === 'decline'
    ? `Decline this handoff from ${fromLabel}? Nothing is added to ${toLabel}, and the answer is final.`
    : `Take this handoff back from ${toLabel}? It can no longer be accepted, and this is final.`;
}

export function handoffDoneText(kind: HandoffActionKind, toLabel: string): string {
  switch (kind) {
    case 'accept': return `Accepted. A received item was added to ${toLabel}.`;
    case 'decline': return 'Declined. The sender sees the answer.';
    case 'withdraw': return 'Taken back. It can no longer be accepted.';
  }
}

/** The handoff was answered or withdrawn in the meantime. */
export const ALREADY_ANSWERED_TEXT = 'This handoff was already answered or taken back. It is shown the way it is now.';

export function handoffFailureText(r: Pick<NexusFail, 'code' | 'reason' | 'subReason'>): string {
  if (r.code === 'illegal_transition') return ALREADY_ANSWERED_TEXT;
  return errorCopy(r.code, r.reason, r.subReason).text;
}

/** Whether what is shown may be stale after a failed answer or send, so every reader loads again. */
export function shouldReloadAfterHandoffAction(r: Pick<NexusFail, 'code' | 'reason'>): boolean {
  switch (r.code) {
    case 'conflict': case 'not_found': case 'illegal_transition': case 'participation_inactive': return true;
    case 'platform_unavailable': return r.reason !== 'busy';
    default: return false;
  }
}

// ---------- the send sheet ----------

/** Most versions one handoff carries (the service's MAX_SUBJECTS). */
export const SEND_MAX_SUBJECTS = 20;
export const TITLE_MAX = 200;
/** How many of the sender's artifacts the sheet reads for versions (most recently changed first). */
export const SUBJECT_CANDIDATE_ARTIFACTS = 30;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** What the send sheet opens with: the version in view and the artifact (and owner participation) it belongs to. */
export interface HandoffStart {
  projectId: string;
  ownerParticipationId: string;
  artifactId: string;
  artifactName: string;
  versionId: string;
  versionNo: number;
}

/**
 * Whether a "Hand off…" control renders: platform writes on, handoffs known to be on, the version allows it, and
 * the project has at least one other active participation to receive it (`hasReceiver`, from `toChoices`).
 */
export function canHandOff(allowed: readonly { kind: string }[], canWrite: boolean, handoffsAvailable: boolean | null, hasReceiver: boolean): boolean {
  return canWrite && handoffsAvailable === true && hasReceiver && allowed.some((a) => a.kind === 'handoff');
}

export interface ParticipationChoice { participationId: string; workspaceId: string; label: string; hueSlot: number | null }

function choiceOf(row: { id: string; workspaceId: string }): ParticipationChoice {
  const v = viewOf(row.workspaceId);
  return { participationId: row.id, workspaceId: row.workspaceId, label: v.label, hueSlot: v.hueSlot };
}

/** From: the owner participation of the chosen versions, only while it is active and the index is the database's. */
export function fromChoice(idx: ParticipationIndex, projectId: string, ownerParticipationId: string | null): ParticipationChoice | null {
  if (idx.mode !== 'db' || !ownerParticipationId) return null;
  const row = activeWorkspacesOf(idx, projectId).map((x) => x.row).find((r) => r.id === ownerParticipationId);
  return row ? choiceOf(row) : null;
}

/** To: every OTHER active participation of the same project, primary first, then registry order. */
export function toChoices(idx: ParticipationIndex, projectId: string, fromParticipationId: string): ParticipationChoice[] {
  if (idx.mode !== 'db') return [];
  return activeWorkspacesOf(idx, projectId).map((x) => x.row)
    .filter((r) => r.id !== fromParticipationId && r.projectId === projectId)
    .map(choiceOf);
}

/** Whether a send from this participation has anyone to go to: the same `toChoices` the send sheet offers. */
export function hasReceiver(idx: ParticipationIndex, projectId: string, fromParticipationId: string): boolean {
  return toChoices(idx, projectId, fromParticipationId).length > 0;
}

/** The sender's artifacts whose versions the sheet reads: owned by the sending participation, not archived, with versions. */
export function subjectArtifactIds(summaries: readonly ArtifactSummaryView[], projectId: string, fromParticipationId: string): { ids: string[]; capped: boolean } {
  const own = summaries.filter((s) => s.artifact.projectId === projectId && s.artifact.status === 'active'
    && s.artifact.ownerScope === 'participation' && s.artifact.ownerParticipationId === fromParticipationId && s.versionCount > 0)
    .sort((a, b) => b.artifact.updatedAt - a.artifact.updatedAt);
  return { ids: own.slice(0, SUBJECT_CANDIDATE_ARTIFACTS).map((s) => s.artifact.id), capped: own.length > SUBJECT_CANDIDATE_ARTIFACTS };
}

export interface SubjectChoice {
  versionId: string;
  artifactId: string;
  /** "Commit API notes, version 2". */
  label: string;
  /** "ready", "active". */
  status: string;
  hash: string;
}

/**
 * The versions that may be sent: what the platform returned for the sender's own artifacts, out of draft
 * (ready or active), of an artifact that is not archived. Sorted by name, newest version first.
 */
export function subjectChoices(details: readonly ArtifactDetail[], projectId: string, fromParticipationId: string): SubjectChoice[] {
  const out: (SubjectChoice & { name: string; versionNo: number })[] = [];
  const seen = new Set<string>();
  for (const d of details) {
    const a = d.artifact;
    if (a.projectId !== projectId || a.status !== 'active' || a.ownerScope !== 'participation' || a.ownerParticipationId !== fromParticipationId) continue;
    for (const v of d.versions) {
      if (v.artifactId !== a.id || v.projectId !== projectId) continue;
      if (v.status !== 'candidate' && v.status !== 'active') continue;
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push({ versionId: v.id, artifactId: a.id, label: `${kindLabel(a.kind)} ${a.name}, version ${v.versionNo}`, status: statusLabel(v.status),
        hash: hashPrefix(v.contentHash), name: a.name, versionNo: v.versionNo });
    }
  }
  out.sort((x, y) => x.name.localeCompare(y.name) || y.versionNo - x.versionNo);
  return out.map(({ versionId, artifactId, label, status, hash }) => ({ versionId, artifactId, label, status, hash }));
}

export interface SendState {
  toParticipationId: string | null;
  /** Chosen versions, in the order they were picked. */
  versionIds: string[];
  title: string;
  note: string;
  pending: boolean;
  error: string | null;
  /** Set once the handoff was sent. */
  sent: { handoffId: string; toLabel: string; created: boolean } | null;
}

/** "API notes, version 2": a title the person can change. */
export function defaultHandoffTitle(name: string, versionNo: number): string {
  const clean = String(name).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${clean}, version ${versionNo}`.slice(0, TITLE_MAX).trim();
}

/** The opening state: the first other workspace, the version in view preselected, a title after it. */
export function initialSendState(to: readonly ParticipationChoice[], preselectVersionId: string | null, title: string): SendState {
  return {
    toParticipationId: to[0]?.participationId ?? null, versionIds: preselectVersionId ? [preselectVersionId] : [],
    title, note: '', pending: false, error: null, sent: null
  };
}

/** The chosen versions the sheet actually offers, in pick order, without duplicates: what is counted and sent. */
export function offeredIds(versionIds: readonly string[], subjects: readonly Pick<SubjectChoice, 'versionId'>[]): string[] {
  const offered = new Set(subjects.map((c) => c.versionId));
  return [...new Set(versionIds.filter((id) => offered.has(id)))];
}

/** Once the choices are read, a chosen version that is not offered is dropped, so the count and the request agree. */
export function keepOffered(s: SendState, subjects: readonly Pick<SubjectChoice, 'versionId'>[]): SendState {
  if (s.pending || s.sent) return s;
  const kept = offeredIds(s.versionIds, subjects);
  return kept.length === s.versionIds.length ? s : { ...s, versionIds: kept };
}

/** Pick or unpick a version; never more than SEND_MAX_SUBJECTS; nothing changes while sending or once sent. */
export function toggleSubject(s: SendState, versionId: string): SendState {
  if (s.pending || s.sent) return s;
  if (s.versionIds.includes(versionId)) return { ...s, versionIds: s.versionIds.filter((x) => x !== versionId), error: null };
  if (s.versionIds.length >= SEND_MAX_SUBJECTS) return s;
  return { ...s, versionIds: [...s.versionIds, versionId], error: null };
}

/** The platform's title rule: trimmed, 1 to 200 characters, no control characters. */
export function validTitle(title: string): boolean {
  const t = typeof title === 'string' ? title.trim() : '';
  return t.length >= 1 && t.length <= TITLE_MAX && !CONTROL.test(t);
}

/** Why Send is not possible yet, in words; null when the request can be sent. */
export function sendBlocker(s: SendState, subjects: readonly SubjectChoice[], to: readonly ParticipationChoice[]): string | null {
  if (to.length === 0) return 'This project is not in any other workspace, so there is nowhere to send this. Add the project to another workspace first.';
  if (!s.toParticipationId || !to.some((c) => c.participationId === s.toParticipationId)) return 'Choose the workspace to send this to.';
  const chosen = offeredIds(s.versionIds, subjects);
  if (chosen.length === 0) return 'Choose at least one version to send.';
  if (chosen.length > SEND_MAX_SUBJECTS) return `A handoff can hold at most ${SEND_MAX_SUBJECTS} versions.`;
  if (!validTitle(s.title)) return `Give the handoff a title of 1 to ${TITLE_MAX} characters.`;
  if (!validNote(s.note)) return `The note can be at most ${NOTE_MAX} characters.`;
  return null;
}

/**
 * The nexus:handoff:send argument, or null while something is missing. Only versions the sheet offered are
 * sent (never an id typed by hand), in the order picked, without duplicates.
 */
export function buildSendRequest(projectId: string, fromParticipationId: string, s: SendState, subjects: readonly SubjectChoice[], to: readonly ParticipationChoice[]): SendHandoffArgs | null {
  if (sendBlocker(s, subjects, to) !== null || !s.toParticipationId) return null;
  const versionIds = offeredIds(s.versionIds, subjects);
  const args: SendHandoffArgs = { projectId, fromParticipationId, toParticipationId: s.toParticipationId, versionIds, title: s.title.trim() };
  const note = s.note.trim();
  if (note) args.note = note;
  return args;
}

/** Start sending; null while a send runs, once sent, or without a request. */
export function beginSend(s: SendState, hasRequest: boolean): SendState | null {
  if (s.pending || s.sent || !hasRequest) return null;
  return { ...s, pending: true, error: null };
}

export function sendFailed(s: SendState, error: string): SendState {
  return { ...s, pending: false, error };
}

export function sendSucceeded(s: SendState, sent: SendState['sent']): SendState {
  return { ...s, pending: false, error: null, sent };
}

/** The sentence after a send. `created` false: the same handoff had already been sent, so it is shown again. */
export function sentText(toLabel: string, created: boolean): string {
  return created ? `Handoff sent to ${toLabel}.` : `This handoff was already sent to ${toLabel}; nothing new was sent.`;
}

export function sendFailureText(r: Pick<NexusFail, 'code' | 'reason' | 'subReason'>): string {
  return errorCopy(r.code, r.reason, r.subReason).text;
}

// ---------- the artifact Passport: handoffs carrying its versions ----------

/** How many of the project's handoffs the Passport reads (open first, then newest). */
export const PASSPORT_HANDOFF_READS = 20;

export interface CarryingRow {
  id: string;
  title: string;
  /** "Engineering to Quality". */
  route: string;
  status: string;
  /** "version 2", "versions 1 and 3". */
  versions: string;
}

/** The Passport's handoffs line after a failed list read: always a sentence, never "no handoffs". */
export const CARRYING_UNAVAILABLE_TEXT = 'Nexus cannot read its saved information right now, so handoffs cannot be listed.';
export function carryingFailureText(r: Pick<NexusFail, 'code' | 'reason' | 'subReason'>): string {
  const copy = errorCopy(r.code, r.reason, r.subReason);
  return copy.kind === 'unavailable' ? CARRYING_UNAVAILABLE_TEXT : copy.text;
}

/**
 * Which handoff details to read again: those never read, and those whose status (or anything else) changed since
 * the last read, judged by the list row's statusChangedAt and updatedAt. A handoff's subjects never change.
 */
export function detailIdsToRead(list: readonly Pick<HandoffSummaryView, 'id' | 'statusChangedAt' | 'updatedAt'>[], cache: ReadonlyMap<string, Pick<HandoffDetailView, 'statusChangedAt' | 'updatedAt'>>): string[] {
  return list.filter((h) => {
    const c = cache.get(h.id);
    return !c || c.statusChangedAt !== h.statusChangedAt || c.updatedAt !== h.updatedAt;
  }).map((h) => h.id);
}

function versionsList(nos: number[]): string {
  const sorted = [...new Set(nos)].sort((a, b) => a - b);
  if (sorted.length === 1) return `version ${sorted[0]}`;
  return `versions ${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`;
}

/** The handoffs that carry any version of this artifact, in the order read. */
export function handoffsCarrying(details: readonly HandoffDetailView[], artifactId: string): CarryingRow[] {
  const out: CarryingRow[] = [];
  for (const h of details) {
    const mine = h.subjects.filter((s) => s.artifactId === artifactId);
    if (mine.length === 0) continue;
    out.push({
      id: h.id, title: h.title, route: `${viewOf(h.fromWorkspaceId).label} to ${viewOf(h.toWorkspaceId).label}`,
      status: handoffStatusLabel(h.status), versions: versionsList(mine.map((s) => s.versionNo))
    });
  }
  return out;
}
