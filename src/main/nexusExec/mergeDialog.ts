/**
 * The "Add to my project" confirmation window (B2b Task 14, D-B6): the one thing that may confirm a merge into the user's
 * branch. main hands `confirmMergeWith` Electron's own `dialog.showMessageBox` (index.ts) as `mergeDialog` of `startExecution`,
 * which exposes it as `ExecutionHandle.confirmMerge`: the only `confirm` the accept service ever receives.
 *
 * The window says what will happen in plain words: your project's main version (the branch), the newest saved version it moves
 * to (a short id in brackets), and the kept changes being added (from the service's own records: titles and short ids, redacted
 * and cut, never raw AI text beyond a short title). SECURITY: the buttons are `['Cancel', 'Add to my project']`; INDEX 0 is Cancel
 * and is both the default and the escape button, INDEX 1 (`MERGE_CONFIRM_INDEX`) is the only one that confirms. Only the words
 * changed; tests pin the indices. It states that only unsaved edits to files the project already tracks stop the merge (a new
 * file does not). Pure apart from the `show` it is given, so a test can drive it without Electron.
 */
import { redactSecretText } from '../nexus/activity/redact';
import type { MergeConfirmInfo } from '../nexus/repo/acceptService';

export const MERGE_BUTTONS = ['Cancel', 'Add to my project'] as const;
export const MERGE_CONFIRM_INDEX = 1;
const MAX_LISTED = 10;
const MAX_TITLE = 100;
/** A title is the AI helper's own text: it is always shown inside `Title from the AI helper: "..."`, so it cannot pass for Nexus's own wording. */

export interface MergeDialogOptions {
  type: 'question'; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: true;
}

/** One line of display text: control characters and line breaks become spaces, secret-shaped values are redacted, then it is cut. */
function line(s: unknown, max: number): string {
  const flat = [...redactSecretText(typeof s === 'string' ? s : '')].map((ch) => { const c = ch.charCodeAt(0); return c < 32 || c === 127 || c === 0x2028 || c === 0x2029 ? ' ' : ch; }).join('').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
const short = (sha: unknown): string => (typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 8) : '?');

export function mergeDialogOptions(info: MergeConfirmInfo): MergeDialogOptions {
  // "N kept changes" counts the CHANGES listed below it (one accepted change set is one change however many commits it adds to the
  // integration ref: its own and the accept commit). `commitCount` only stands in when no change is listed.
  const count = info.accepted.length > 0 ? info.accepted.length : Number.isSafeInteger(info.commitCount) && info.commitCount >= 0 ? info.commitCount : 0;
  const branch = line(info.branch, 80);
  const listed = info.accepted.slice(0, MAX_LISTED).map((a) => `• Title from the AI helper: "${line(a.title, MAX_TITLE) || 'Suggested change'}" [${short(a.mergeCommit)}]`);
  const more = info.accepted.length > MAX_LISTED ? [`… and ${info.accepted.length - MAX_LISTED} more`] : [];
  const detail = [
    `Your project's main version, "${branch}", is at the saved version [${short(info.from)}]. It will be updated to the newest saved version [${short(info.to)}].`,
    'The files in your project will change to match the kept changes. New files you have not saved, and your other versions, are not touched.',
    '',
    count === 1 ? '1 kept change:' : `${count} kept changes:`,
    ...listed, ...more,
    '',
    'Before it starts, Nexus checks that you have no unsaved edits to your project\'s existing files. If you do, nothing is added until you save or undo them. New files do not get in the way.',
    '',
    'Press Cancel to leave your project exactly as it is.'
  ].join('\n');
  return { type: 'question', title: 'Add to my project', message: `Add ${count === 1 ? '1 kept change' : `${count} kept changes`} to your project's main version, "${branch}"?`,
    detail, buttons: [...MERGE_BUTTONS], defaultId: 0, cancelId: 0, noLink: true };
}

/** A window a dialog can be parented to (an Electron BrowserWindow has this). */
export interface DialogParent { isDestroyed(): boolean }

/**
 * `confirmMergeWith` on a live parent window. With no window (none focused, no main window, or a destroyed one) nothing is shown
 * and the answer is false: the merge fails closed, never through a parent-less dialog the user may not see.
 */
export async function confirmMergeOn<W extends DialogParent>(parent: W | null | undefined, show: (parent: W, o: MergeDialogOptions) => Promise<{ response: number }>,
  info: MergeConfirmInfo): Promise<boolean> {
  try { if (!parent || parent.isDestroyed()) return false; } catch { return false; }
  return confirmMergeWith((o) => show(parent, o), info);
}

/** Shows the dialog through `show`; true only when the user pressed "Add to my project" (index 1). A closed dialog, Escape or a throw is a cancel. */
export async function confirmMergeWith(show: (o: MergeDialogOptions) => Promise<{ response: number }>, info: MergeConfirmInfo): Promise<boolean> {
  try {
    const r = await show(mergeDialogOptions(info));
    return r?.response === MERGE_CONFIRM_INDEX;
  } catch {
    return false;
  }
}
