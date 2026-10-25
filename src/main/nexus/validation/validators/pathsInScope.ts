/**
 * `git.paths_in_scope` v1 (change_set, register, blocking). Pure. Fails when any path the collect reported is outside
 * the path scope, is not a plain relative path, or has a sensitive name (`.git`, `.env`, a key or a credentials
 * file): `pathInScope` (src/shared/nexus/changeSet.ts) judges each one. A truncated path list (more than the collect's
 * cap) cannot be fully judged, so the check errors rather than passing on a partial view.
 */
import { pathInScope } from '../../../../shared/nexus/changeSet';
import { COMMIT_RE, errored, failed, passed, type ValidatorOutcome } from '../normalized';

export const ID = 'git.paths_in_scope';
export const VERSION = '1';
/** The most offending paths named in the evidence (never the secret text; paths are not secrets). */
export const MAX_NAMED = 20;
/** A `.claude` path segment at any depth (case-insensitive: the folder name is case-folded on Windows). */
export const AGENT_CONFIG_SEGMENT_RE = /(?:^|\/)\.claude[. ]*(?:\/|$)/i;

export interface PathsInScopeFacts {
  head: string;
  paths: string[];
  pathsTruncated: boolean;
  scope: string[];
}

export function run(f: PathsInScopeFacts): ValidatorOutcome {
  if (!f || typeof f.head !== 'string' || !COMMIT_RE.test(f.head) || !Array.isArray(f.paths) || !Array.isArray(f.scope)) {
    return errored('parser_contract', 'Checks could not run: the collected paths were not usable.');
  }
  if (f.pathsTruncated) {
    return errored('paths_truncated', 'Checks could not run: the change touches more paths than the collect recorded; scope could not be fully judged.',
      [{ type: 'git', commit: f.head, check: 'paths_in_scope', detail: 'truncated' }]);
  }
  // The agent CLI's own per-worktree settings folder (`.claude/`): never part of a change, whatever the scope says.
  const bad = f.paths.filter((p) => !pathInScope(p, f.scope) || AGENT_CONFIG_SEGMENT_RE.test(p.replace(/\\/g, '/')));
  const detail = bad.length === 0 ? 'every path is in scope' : `${bad.length} path(s) out of scope, e.g. ${bad.slice(0, MAX_NAMED).join(', ')}`;
  const evidence = [{ type: 'git' as const, commit: f.head, check: 'paths_in_scope' as const, detail: detail.slice(0, 200) }];
  if (bad.length > 0) return failed('out_of_scope', `${bad.length} changed path(s) are outside the path scope.`, evidence);
  return passed('Every changed path is in scope.', evidence);
}
