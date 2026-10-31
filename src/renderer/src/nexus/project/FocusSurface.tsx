import type { Project } from '@shared/project';
import type { ProjectTool } from '../router/routes';
import type { GitState, SpineNode } from './spineModel';
import { SourceView } from './SourceView';
import { CompletionPlaceholder } from './CompletionPlaceholder';
import { ReviewSurface } from '../review/ReviewSurface';
import { ProjectRuns } from '../runs/ProjectRuns';
import { ProjectTry } from './ProjectTry';

export function FocusSurface({ tool, project, node, git, onRetryGit, tryChange = null }: {
  tool: ProjectTool; project: Project; node: SpineNode; git: GitState; onRetryGit: () => void;
  /** The newest suggested change waiting for a decision (Try it can run it too); null when none. */
  tryChange?: { versionId: string; name: string } | null;
}) {
  if (tool === 'completion') return <CompletionPlaceholder project={project} />;
  if (tool === 'changes') return <ReviewSurface root={project.rootPath} git={git} refresh={onRetryGit} />;
  if (tool === 'runs') return <ProjectRuns projectId={project.id} />;
  if (tool === 'try') return <ProjectTry projectId={project.id} change={tryChange} />;
  return <SourceView project={project} node={node} git={git} onRetry={onRetryGit} />;
}
