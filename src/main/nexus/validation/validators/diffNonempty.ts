/**
 * `git.diff_nonempty` v1 (change_set, register, blocking). Pure. Judged on the base..head diffstat: no file changed
 * between the base and the head fails; a collect that committed nothing new (`changed: false`) fails only when a change
 * set is already registered for that head.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../db/canonical';
import { COMMIT_RE, errored, failed, passed, type ValidatorOutcome } from '../normalized';

export const ID = 'git.diff_nonempty';
export const VERSION = '1';

export interface DiffNonemptyFacts {
  base: string;
  head: string;
  changed: boolean;
  /** A change set is already registered for this head (so an unchanged collect adds nothing new). */
  headRegistered?: boolean;
  diffstat: { files: number; insertions: number; deletions: number };
}

export function run(f: DiffNonemptyFacts): ValidatorOutcome {
  if (!f || typeof f.head !== 'string' || !COMMIT_RE.test(f.head) || typeof f.base !== 'string' || !COMMIT_RE.test(f.base)) {
    return errored('parser_contract', 'Checks could not run: the collected commits were not usable.');
  }
  const d = f.diffstat ?? { files: 0, insertions: 0, deletions: 0 };
  const sha = createHash('sha256').update(canonicalJson({ base: f.base, head: f.head, diffstat: d })).digest('hex');
  const evidence = [
    { type: 'git' as const, commit: f.head, check: 'diff_nonempty' as const, detail: `${d.files} file(s), +${d.insertions}/-${d.deletions}` },
    { type: 'number' as const, name: 'files', value: d.files, bound: { op: '>=' as const, value: 1 }, source: { blobSha256: sha, pointer: '/diffstat/files' } }
  ];
  if (d.files === 0) return failed('empty_diff', 'The change has no file change between its base and its head.', evidence);
  // `changed: false` is "this collect committed nothing new", which is also what a collect whose ingest was lost looks
  // like on the next register: the base..head diff holds the work. It fails only when that head is already registered.
  if (!f.changed && f.headRegistered === true) return failed('no_new_change', 'Nothing changed since the change set already registered for this head.', evidence);
  return passed(`${d.files} file(s) changed.`, evidence);
}
