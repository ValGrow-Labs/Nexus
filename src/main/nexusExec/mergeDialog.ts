/**
 * The "Merge accepted work" confirmation dialog (B2b Task 14, D-B6): the one thing that may confirm a merge into the user's
 * branch. main hands `confirmMergeWith` Electron's own `dialog.showMessageBox` (index.ts) as `mergeDialog` of `startExecution`,
 * which exposes it as `ExecutionHandle.confirmMerge`: the only `confirm` the accept service ever receives.
 *
 * The dialog says what will happen: the branch, how far it moves, and the accepted changes being merged (from the service's own
 * records: titles and short commit ids, redacted and cut, never raw agent text beyond a short title). Cancel is the default and
 * the escape button; the merge happens only for the "Merge" button. It states that only tracked files are checked (a new,
 * untracked file does not block a merge). Pure apart from the `show` it is given, so a test can drive it without Electron.
 */
import { redactSecretText } from '../nexus/activity/redact';
import type { MergeConfirmInfo } from '../nexus/repo/acceptService';

export const MERGE_BUTTONS = ['Cancel', 'Merge'] as const;
export const MERGE_CONFIRM_INDEX = 1;
const MAX_LISTED = 10;
const MAX_TITLE = 100;

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
  const count = Number.isSafeInteger(info.commitCount) && info.commitCount >= 0 ? info.commitCount : info.accepted.length;
  const branch = line(info.branch, 80);
  const listed = info.accepted.slice(0, MAX_LISTED).map((a) => `• ${line(a.title, MAX_TITLE) || 'Agent change'} (${short(a.mergeCommit)})`);
  const more = info.accepted.length > MAX_LISTED ? [`… and ${info.accepted.length - MAX_LISTED} more`] : [];
  const detail = [
    `Your branch "${branch}" will move from ${short(info.from)} to ${short(info.to)} by fast-forward. Nothing else in your folder is touched.`,
    '',
    count === 1 ? '1 accepted change:' : `${count} accepted changes:`,
    ...listed, ...more,
    '',
    'Only changes to files git already tracks are checked: a new, untracked file does not block this merge, but uncommitted changes to tracked files do.'
  ].join('\n');
  return { type: 'question', title: 'Merge accepted work', message: `Merge ${count === 1 ? '1 accepted change' : `${count} accepted changes`} into "${branch}"?`,
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

/** Shows the dialog through `show`; true only when the user pressed "Merge". A closed dialog, Escape or a throw is a cancel. */
export async function confirmMergeWith(show: (o: MergeDialogOptions) => Promise<{ response: number }>, info: MergeConfirmInfo): Promise<boolean> {
  try {
    const r = await show(mergeDialogOptions(info));
    return r?.response === MERGE_CONFIRM_INDEX;
  } catch {
    return false;
  }
}
