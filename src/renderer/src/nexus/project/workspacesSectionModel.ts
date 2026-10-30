// Pure: what the project page's Workspaces section shows and how its two write
// actions (add to a workspace, remove from one) move through pending,
// success and failure. No React, so tests load it directly.
import type { NexusFail } from '@shared/nexus/ipc';
import { activeWorkspacesOf, attachChoices, viewOf, type ParticipationIndex } from '../workspaces/participation';
import { errorCopy } from '../data/errorCopy';

export interface SectionRow {
  participationId: string;
  workspaceId: string;
  label: string;
  hueSlot: number | null;
  isPrimary: boolean;
  /** Only a non-primary participation, and only while the database is the authority. */
  canWithdraw: boolean;
}

export interface AttachOption { workspaceId: string; label: string; hueSlot: number | null }

/** The project's active participations, primary first. Withdraw is offered on no primary row, ever. */
export function sectionRows(idx: ParticipationIndex, projectId: string, canWrite: boolean): SectionRow[] {
  const writable = canWrite && idx.mode === 'db';
  return activeWorkspacesOf(idx, projectId).map(({ row }) => {
    const v = viewOf(row.workspaceId);
    return { participationId: row.id, workspaceId: row.workspaceId, label: v.label, hueSlot: v.hueSlot, isPrimary: row.isPrimary, canWithdraw: writable && !row.isPrimary };
  });
}

/** Catalogue workspaces the project is not actively in (nor complete in); none while writes are off. */
export function attachOptions(idx: ParticipationIndex, projectId: string, canWrite: boolean): AttachOption[] {
  if (!canWrite || idx.mode !== 'db') return [];
  return attachChoices(idx, projectId).map((w) => ({ workspaceId: w.id, label: w.label, hueSlot: w.hueSlot }));
}

export type Pending = { kind: 'attach'; workspaceId: string } | { kind: 'withdraw'; participationId: string };

export interface SectionState {
  pending: Pending | null;
  /** The participation whose withdraw is waiting for the person's confirmation. */
  confirming: string | null;
  /** The failure sentence (shown in the role="alert" line). */
  error: string | null;
  /** The success sentence (shown in the role="status" line). */
  announce: string | null;
}

export const IDLE: SectionState = { pending: null, confirming: null, error: null, announce: null };

/** Ask to confirm a withdraw. Ignored while an action is running. */
export function askConfirm(s: SectionState, participationId: string): SectionState {
  return s.pending ? s : { ...s, confirming: participationId, error: null, announce: null };
}

export function cancelConfirm(s: SectionState): SectionState {
  return s.pending ? s : { ...s, confirming: null };
}

/** Start an action; null while another one is still running (no double submit). */
export function begin(s: SectionState, p: Pending): SectionState | null {
  if (s.pending) return null;
  return { pending: p, confirming: p.kind === 'withdraw' ? p.participationId : null, error: null, announce: null };
}

export function succeeded(_s: SectionState, announce: string): SectionState {
  return { pending: null, confirming: null, error: null, announce };
}

export function failed(_s: SectionState, error: string): SectionState {
  return { pending: null, confirming: null, error, announce: null };
}

export const addedMessage = (label: string): string => `Added to ${label}`;
export const withdrawnMessage = (label: string): string => `Removed from ${label}`;
/** The status line while an action runs; focus rests on it so it never falls to the page. */
export const addingMessage = (label: string): string => `Adding to ${label}…`;
export const withdrawingMessage = (label: string): string => `Removing from ${label}…`;
export const confirmQuestion = (label: string): string => `Remove this project from ${label}? Its saved items stay readable, but they will not get new versions.`;

export const OPEN_HANDOFFS_TEXT = 'Answer or take back its open handoffs first.';
export const LIVE_WORK_TEXT = 'Finish or stop its running tasks and AI helper conversations first.';
export const PRIMARY_TEXT = 'The main workspace is chosen from what Nexus finds in the project, so it cannot be removed.';

const positive = (v: unknown): boolean => typeof v === 'number' && v > 0;

/** The sentence for a failed attach. */
export function attachFailureText(r: NexusFail): string {
  return errorCopy(r.code, r.reason, r.subReason).text;
}

/** The sentence for a failed withdraw: what blocks it, said plainly. */
export function withdrawFailureText(r: NexusFail): string {
  if (r.code === 'conflict' && positive(r.detail?.openHandoffs)) return OPEN_HANDOFFS_TEXT;
  if (r.code === 'conflict' && (positive(r.detail?.liveJobs) || positive(r.detail?.liveSessions))) return LIVE_WORK_TEXT;
  if (r.code === 'invalid' && !r.reason) return PRIMARY_TEXT;
  return errorCopy(r.code, r.reason, r.subReason).text;
}

/** Whether the shown participations may be stale after this failure, so they should be read again. */
export function shouldReload(r: NexusFail): boolean {
  if (r.code === 'not_found') return true;
  if (r.code === 'conflict') return !positive(r.detail?.openHandoffs) && !positive(r.detail?.liveJobs) && !positive(r.detail?.liveSessions);
  return r.code === 'platform_unavailable' && r.reason !== 'busy' && r.reason !== 'handoffs_unavailable';
}
