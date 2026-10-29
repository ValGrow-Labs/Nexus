import type { ChangeKind } from '../project/spineModel';

const ORDER: { kind: ChangeKind; title: string }[] = [
  { kind: 'modified', title: 'Modified' }, { kind: 'added', title: 'Added' }, { kind: 'renamed', title: 'Renamed' },
  { kind: 'deleted', title: 'Deleted' }, { kind: 'untracked', title: 'New, not tracked' }
];

export const REVIEW_PHASE_NOTE = 'You can review these changes here. Changes in your own files are not accepted or discarded from Nexus: commit or revert them in Files or your own git tools. An agent’s change is accepted and merged on its own change set, not here.';

export function groupChanges(changed: { path: string; kind: ChangeKind }[]) {
  return ORDER.map(({ kind, title }) => ({ kind, title, paths: changed.filter((c) => c.kind === kind).map((c) => c.path).sort() }))
    .filter((g) => g.paths.length > 0);
}
