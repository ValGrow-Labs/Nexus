import type { Project } from '@shared/project';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { UNASSIGNED_LABEL } from '../workspaces/mapping';
import { activeWorkspacesOf, primaryViewOf, viewOf, type ParticipationIndex } from '../workspaces/participation';
import { Badge } from '../ui/Badge';
import { relativeTime } from '../data/selectors';
import { RepoHealthBar } from './RepoHealthBar';

/** `role`: on a workspace page, how the project takes part there ("Added" is tagged). */
export function ProjectRow({ project, idx, role, onOpen }: { project: Project; idx: ParticipationIndex; role?: 'primary' | 'attached'; onOpen: () => void }) {
  const ws = primaryViewOf(idx, project.id);
  const others = activeWorkspacesOf(idx, project.id).filter((x) => !x.row.isPrimary).map((x) => viewOf(x.row.workspaceId).label);
  return (
    <button type="button" className="nx-row nx-focusable" onClick={onOpen}>
      <ProvenanceMark slot={ws?.hueSlot ?? null} size={10} />
      <span className="nx-row__main">
        <span className="nx-row__title">{project.name}{role === 'attached' && <span className="nx-attached-tag"><Badge>Added</Badge></span>}</span>
        <span className="nx-row__meta">{ws ? ws.label : UNASSIGNED_LABEL}{others.length > 0 && <span title={`Also in ${others.join(', ')}`}> +{others.length}</span>} · <span className="nx-id">{project.rootPath}</span></span>
      </span>
      <span className="nx-row__side">
        <span className="nx-row__time nx-id">Updated {relativeTime(project.updatedAt, Date.now())}</span>
        <RepoHealthBar project={project} />
      </span>
    </button>
  );
}
