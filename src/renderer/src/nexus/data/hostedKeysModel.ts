// Pure: what the Settings section "AI provider keys" shows, from the key IPC's answer (booleans and fixed sentences only). No React, so
// tests load it directly. Provider ids and labels come from the runner's probe (main passes them on); nothing here names a provider, and
// no address is given: the explanation says to create a free key in the provider's own console. A key is typed into a write-only field and
// is never shown again: a row says only "Saved" or "Not set".
import { isApiKeyShape } from '@shared/nexus/hostedModel';
import { KEY_HELP_TEXT } from './executionModel';

export const KEYS_TITLE = 'AI provider keys';
export const KEYS_INTRO = 'Nexus agents can work with a free hosted model. Add a key for the provider you want to use, then choose that provider and a model in the agent setup. '
  + KEY_HELP_TEXT;
/** What a key is for and where it goes: said once under the title. */
export const KEYS_SAFETY = 'A key is stored encrypted on this computer, is never shown again, and is sent only to the provider it belongs to. Deleting it stops agent turns that use it.';
/** The list is not there yet (the providers come from Nexus's own check of this computer). */
export const KEYS_WAITING = 'Nexus is still reading the list of providers. Open the agent setup and check again, then come back here.';
export const KEYS_UNAVAILABLE = 'Provider keys are not available on this computer right now.';
export const KEY_SAVED_NOTE = 'The key was saved.';
export const KEY_DELETED_NOTE = 'The key was deleted.';
export const KEY_SHAPE_TEXT = 'That does not look like an API key. Paste the key exactly as the provider shows it (letters, digits and symbols, no spaces).';

export interface KeyRow {
  id: string; label: string; present: boolean;
  /** The status word: never colour alone. */
  word: 'Saved' | 'Not set';
  /** The write-only field's hint. */
  placeholder: string;
  /** What the person typed (trimmed), or null when nothing yet. */
  draft: string | null;
  /** The reason the draft cannot be saved, or null when it can (or nothing was typed). */
  problem: string | null;
  canSave: boolean;
  canDelete: boolean;
}

/** The rows from the IPC's list answer and the drafts typed so far (by provider id). Empty when the list is not usable. */
export function keyRows(list: { ok: boolean; providers?: readonly { id: string; label: string; present: boolean }[] } | null | undefined,
  drafts: Readonly<Record<string, string>> = {}): KeyRow[] {
  if (!list || list.ok !== true || !Array.isArray(list.providers)) return [];
  return list.providers.map((p) => {
    const typed = (drafts[p.id] ?? '').trim();
    const draft = typed === '' ? null : typed;
    const shapeOk = draft !== null && isApiKeyShape(draft);
    return { id: p.id, label: p.label, present: p.present === true, word: p.present === true ? 'Saved' : 'Not set',
      placeholder: p.present === true ? 'Saved. Paste a new key to replace it' : 'Paste your key', draft,
      problem: draft !== null && !shapeOk ? KEY_SHAPE_TEXT : null, canSave: shapeOk, canDelete: p.present === true };
  });
}

/** The line under the section when the list is not a usable list: waiting for the providers, or not available. */
export function keysNotice(list: { ok: boolean; reason?: string; message?: string } | null | undefined): string | null {
  if (!list) return KEYS_WAITING;
  if (list.ok === true) return null;
  return list.reason === 'providers_unknown' ? KEYS_WAITING : typeof list.message === 'string' && list.message !== '' ? list.message : KEYS_UNAVAILABLE;
}
