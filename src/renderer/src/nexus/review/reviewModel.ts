import type { ChangeKind } from '../project/spineModel';

const ORDER: { kind: ChangeKind; title: string }[] = [
  { kind: 'modified', title: 'Edited files' }, { kind: 'added', title: 'New files' }, { kind: 'renamed', title: 'Renamed files' },
  { kind: 'deleted', title: 'Removed files' }, { kind: 'untracked', title: 'New files not saved yet' }
];

export const REVIEW_PHASE_NOTE = 'These are changes in your own files. You can read them here, but Nexus cannot keep or undo them: save them or undo them in Files or your own Git tools. The AI helper’s suggested changes are decided on above, with “Looks good”, “Keep these changes” and “Add to my project”.';

export function groupChanges(changed: { path: string; kind: ChangeKind }[]) {
  return ORDER.map(({ kind, title }) => ({ kind, title, paths: changed.filter((c) => c.kind === kind).map((c) => c.path).sort() }))
    .filter((g) => g.paths.length > 0);
}
