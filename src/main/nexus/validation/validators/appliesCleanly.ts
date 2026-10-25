/**
 * `git.applies_cleanly` v1 (change_set, candidate, blocking; run by the child job `changeset.merge_check`). Pure: the
 * runner's `merge-tree --write-tree` of the change's head onto the current integration head either writes a merged
 * tree (clean) or answers a conflict; main records only whether it was clean, never the tree content (B2a §38.2: at
 * accept time a later conflict is re-checked by the SAME function and recorded advisory on a version that is no
 * longer a draft — Task 9).
 */
import { COMMIT_RE, errored, failed, passed, type ValidatorOutcome } from '../normalized';

export const ID = 'git.applies_cleanly';
export const VERSION = '1';

export interface AppliesCleanlyFacts { head: string; integrationHead: string; clean: boolean }

export function run(f: AppliesCleanlyFacts): ValidatorOutcome {
  if (!f || typeof f.head !== 'string' || !COMMIT_RE.test(f.head) || typeof f.integrationHead !== 'string' || !COMMIT_RE.test(f.integrationHead)
    || typeof f.clean !== 'boolean') {
    return errored('parser_contract', 'Checks could not run: the merge-check facts were not usable.');
  }
  const evidence = [{ type: 'git' as const, commit: f.head, check: 'merge_tree_clean' as const, detail: f.clean ? 'merges cleanly' : 'conflict' }];
  if (!f.clean) return failed('merge_conflict', 'The change does not merge onto the current integration head without a conflict.', evidence);
  return passed('The change merges cleanly onto the current integration head.', evidence);
}
