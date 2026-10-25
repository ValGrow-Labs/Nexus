/**
 * `sec.entropy_notes` v1 (change_set, register, ADVISORY: `blocking: false` in validators.ts, so this never gates a
 * version — F15). Pure. Lists the `entropyHits` the collect reported (`looksSecret` over added lines outside a
 * lockfile, computed in the runner) for the reviewer; a lockfile's integrity hashes are already excluded by the
 * collect itself (`isLockfilePath`), so a change that only touches `package-lock.json` records nothing here.
 */
import { COMMIT_RE, errored, passed, failed, type ValidatorOutcome } from '../normalized';

export const ID = 'sec.entropy_notes';
export const VERSION = '1';
export const MAX_LISTED = 100;

export interface EntropyHit { path: string; line: number; rule: 'high_entropy' }
export interface SecretEntropyNotesFacts { head: string; entropyHits: EntropyHit[] }

const isHit = (x: unknown): x is EntropyHit => !!x && typeof x === 'object'
  && typeof (x as EntropyHit).path === 'string' && Number.isSafeInteger((x as EntropyHit).line) && (x as EntropyHit).line >= 1
  && (x as EntropyHit).rule === 'high_entropy';

export function run(f: SecretEntropyNotesFacts): ValidatorOutcome {
  if (!f || typeof f.head !== 'string' || !COMMIT_RE.test(f.head) || !Array.isArray(f.entropyHits) || !f.entropyHits.every(isHit)) {
    return errored('parser_contract', 'Checks could not run: the entropy note facts were not usable.');
  }
  const evidence = f.entropyHits.slice(0, MAX_LISTED).map((h) => ({ type: 'location' as const, path: h.path, line: h.line, rule: h.rule }));
  if (f.entropyHits.length > 0) {
    // Advisory: a note for the reviewer, never a gate (F15). Recorded as `failed` only so it reads as a flag in the
    // Folio; `blocking: false` on this validator keeps it out of the finalize rule entirely.
    return failed('entropy_hits', `${f.entropyHits.length} added line(s) outside a lockfile look high-entropy; review before accepting.`, evidence);
  }
  return passed('No high-entropy line outside a lockfile.', evidence);
}
