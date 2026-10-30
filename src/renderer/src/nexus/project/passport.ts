import type { SpineNode } from './spineModel';
import { UNASSIGNED_LABEL } from '../workspaces/mapping';
import { primaryViewOf, type ParticipationIndex } from '../workspaces/participation';
import { repoHealth } from '../data/selectors';
import { kindLabel } from './artifactModel';

export type PassportProject = { id: string; name: string; rootPath: string; domainId: string; detectedLanguages: { language: string }[]; frameworks: string[]; health: unknown };
export type PassportSection = { title: string; rows: { label: string; value: string }[] };
export type PassportAction = 'ask' | 'files' | 'terminal' | 'refresh';

export const RELATIONSHIPS_NOTE = 'What your items were made from, what uses them and what you have sent to other workspaces will show up here once this project has saved items.';

export function passportFor(input: { project: PassportProject; idx: ParticipationIndex; node: SpineNode; commits: { shortSha: string; subject: string; time: number }[];
  /** True once the project has any artifact: the relationships note then gives way to the real records. */
  hasArtifacts?: boolean }) {
  const { project, node } = input;
  const ws = primaryViewOf(input.idx, project.id);
  const identity: PassportSection = { title: 'About this project', rows: [
    { label: 'Location', value: project.rootPath },
    { label: 'Workspace', value: ws ? ws.label : UNASSIGNED_LABEL }
  ] };
  const langs = project.detectedLanguages.map((l) => l.language).filter(Boolean);
  if (langs.length) identity.rows.push({ label: 'Languages', value: langs.slice(0, 4).join(', ') });
  if (project.frameworks.length) identity.rows.push({ label: 'Frameworks', value: project.frameworks.slice(0, 4).join(', ') });
  const sections = [identity];
  const h = repoHealth({ health: project.health });
  if (h !== null) sections.push({ title: 'Health', rows: [{ label: 'Project health', value: `${h} of 100` }] });
  const kind = node.kind === 'changes' ? 'Changes not saved yet' : node.kind === 'artifact' ? kindLabel(node.artifactKind) : node.vcs === 'git' ? 'Your project' : 'Folder';
  const versions = node.kind === 'source' && node.vcs === 'git' ? input.commits.map((c, i) => ({ id: c.shortSha, label: c.subject, current: i === 0 })) : [];
  return { title: project.name, kind, sections, versions, relationshipsNote: input.hasArtifacts ? null : RELATIONSHIPS_NOTE, actions: ['ask', 'files', 'terminal', 'refresh'] as PassportAction[] };
}
