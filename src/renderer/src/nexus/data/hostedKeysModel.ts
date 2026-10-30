// Pure: what the Settings block "Access keys" shows, from the key IPC's answer (booleans and fixed sentences only). No React, so
// tests load it directly. Provider ids and labels come from the runner's probe (main passes them on); nothing here names a provider, and
// no address is given: the explanation says to create a free key on the AI service's own website. A key is typed into a write-only field
// and is never shown again: a row says only "Saved", "Not set" or "Refused" (Nexus did not accept the key you pasted).
import { isApiKeyShape } from '@shared/nexus/hostedModel';
import { KEYS_PATH } from './executionModel';
import { termHelp } from './glossary';

export { KEYS_PATH };
export const KEYS_TITLE = 'Access keys';
/** What an access key is, and how to get a free one (text only: no address is given here). */
export const KEYS_INTRO = `${termHelp('accessKey')} A free online AI service gives you one for free. It takes a few minutes to get one:`;
/** The steps, in order, for a person who has never made a key. */
export const KEYS_STEPS = [
  'Open the website of an AI service that gives free access keys, and sign up for free.',
  'Look for a page called “API keys” or “Access keys”, and create a key. Copy it.',
  'Paste it into the box below and press Save. Nexus keeps it locked on this computer and never shows it again.'
];
/** What a key is for and where it goes: said once under the title. */
export const KEYS_SAFETY = 'Your key is kept locked on this computer, is never shown again, and is sent only to the AI service it belongs to. Deleting it stops your AI helper from using that service.';
/** The list is not there yet (the AI services come from Nexus's own check of this computer). */
export const KEYS_WAITING = 'Nexus is still reading the list of AI services. Open “Get this computer ready”, press Check again, then come back here.';
export const KEYS_UNAVAILABLE = 'Access keys are not available on this computer right now.';
export const KEY_SAVED_NOTE = 'The key was saved.';
export const KEY_DELETED_NOTE = 'The key was deleted.';
export const KEY_SHAPE_TEXT = 'That does not look like an access key. Paste the key exactly as the AI service shows it (letters, digits and symbols, no spaces).';

export type KeyWord = 'Saved' | 'Not set' | 'Refused';

export interface KeyRow {
  id: string; label: string; present: boolean;
  /** The status word: never colour alone. "Refused": Nexus did not accept the key you pasted (the reason is `refusal`). */
  word: KeyWord;
  /** One plain line that says what the word means and what to do. */
  line: string;
  /** The write-only field's hint. */
  placeholder: string;
  /** What the person typed (trimmed), or null when nothing yet. */
  draft: string | null;
  /** The reason the draft cannot be saved, or null when it can (or nothing was typed). */
  problem: string | null;
  /** The reason the last attempt to save was refused, or null. */
  refusal: string | null;
  canSave: boolean;
  canDelete: boolean;
}

const LINE: Record<KeyWord, string> = {
  'Not set': 'No key yet. Paste one below and press Save.',
  Saved: 'Saved on this computer. Paste a new key below to replace it.',
  Refused: 'Not saved. Check the key and try again.'
};

/**
 * The rows from the IPC's list answer and the drafts typed so far (by provider id). `refused` holds the sentence of the last refused save per
 * provider (the word is then "Refused" until a key is saved; a key already saved stays "Saved" and the refusal is shown beside it).
 * Empty when the list is not usable.
 */
export function keyRows(list: { ok: boolean; providers?: readonly { id: string; label: string; present: boolean }[] } | null | undefined,
  drafts: Readonly<Record<string, string>> = {}, refused: Readonly<Record<string, string>> = {}): KeyRow[] {
  if (!list || list.ok !== true || !Array.isArray(list.providers)) return [];
  return list.providers.map((p) => {
    const typed = (drafts[p.id] ?? '').trim();
    const draft = typed === '' ? null : typed;
    const shapeOk = draft !== null && isApiKeyShape(draft);
    const present = p.present === true;
    const refusal = typeof refused[p.id] === 'string' && refused[p.id] !== '' ? refused[p.id] : null;
    const word: KeyWord = present ? 'Saved' : refusal !== null ? 'Refused' : 'Not set';
    return { id: p.id, label: p.label, present, word, line: LINE[word],
      placeholder: present ? 'Saved. Paste a new key to replace it' : 'Paste your key here', draft,
      problem: draft !== null && !shapeOk ? KEY_SHAPE_TEXT : null, refusal, canSave: shapeOk, canDelete: present };
  });
}

/** The line under the section when the list is not a usable list: waiting for the AI services, or not available. */
export function keysNotice(list: { ok: boolean; reason?: string; message?: string } | null | undefined): string | null {
  if (!list) return KEYS_WAITING;
  if (list.ok === true) return null;
  return list.reason === 'providers_unknown' ? KEYS_WAITING : typeof list.message === 'string' && list.message !== '' ? list.message : KEYS_UNAVAILABLE;
}
