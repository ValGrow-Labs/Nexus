import { useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import { WORKSPACES } from '../workspaces/registry';
import { activeWorkspacesOf, primaryViewOf } from '../workspaces/participation';
import { useParticipationIndex } from '../data/useParticipations';
import { recentProjects } from '../data/selectors';
import { useProjectsLoader } from '../data/useProjects';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ProjectRow } from '../components/ProjectRow';
import { LoadError, RowsSkeleton } from '../components/LoadStates';
import { PlatformNotice } from '../components/PlatformNotice';

export function ProjectsPage() {
  const projects = useStore((s) => s.projects);
  const { status, error, refresh } = useProjectsLoader();
  const actions = useShellActions();
  const [q, setQ] = useState('');
  const [ws, setWs] = useState<string>('all');
  const idx = useParticipationIndex();
  // A workspace matches any ACTIVE participation; "Unassigned" means the project is in no workspace yet.
  const shown = useMemo(() => recentProjects(projects, projects.length).filter((p) => {
    if (ws === 'unassigned' && primaryViewOf(idx, p.id) !== null) return false;
    if (ws !== 'all' && ws !== 'unassigned' && !activeWorkspacesOf(idx, p.id).some((x) => x.row.workspaceId === ws)) return false;
    const needle = q.trim().toLowerCase();
    return !needle || p.name.toLowerCase().includes(needle) || p.rootPath.toLowerCase().includes(needle);
  }), [projects, q, ws, idx]);

  return (
    <div className="nx-page">
      <header className="nx-pagehead">
        <h1 tabIndex={-1}>Projects</h1>
        <div className="nx-pagehead__actions">
          <Button icon="import" onClick={actions.openImport}>Import a folder</Button>
          <Button variant="primary" icon="plus" onClick={() => actions.openNewProject()}>New project</Button>
        </div>
      </header>
      <PlatformNotice />
      {projects.length > 0 && (
        <div className="nx-toolbar">
          <input className="nx-input nx-focusable" type="search" placeholder="Search by name or folder" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" />
          <select className="nx-input nx-focusable" value={ws} onChange={(e) => setWs(e.target.value)} aria-label="Workspace">
            <option value="all">All workspaces</option>
            {WORKSPACES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            <option value="unassigned">Unassigned</option>
          </select>
          <Button variant="quiet" onClick={actions.openProjectManager}>Manage projects</Button>
        </div>
      )}
      {status === 'error' && projects.length === 0 ? <LoadError error={error} onRetry={refresh} />
        : status === 'loading' && projects.length === 0 ? <RowsSkeleton />
        : projects.length === 0 ? (
          <EmptyState level={2} icon="projects" title="You have no projects yet" body="A project is a folder with your work in it. Press New project to start a fresh one, or import a folder you already have. The AI helper works on a safe copy of it."
            actions={<><Button variant="primary" icon="plus" onClick={() => actions.openNewProject()}>New project</Button><Button icon="import" onClick={actions.openImport}>Import a folder</Button></>} />
        ) : shown.length === 0 ? (
          <p className="nx-muted" role="status">No projects match your search. Clear the search or choose "All workspaces".</p>
        ) : (
          <div className="nx-rows">{shown.map((p) => <ProjectRow key={p.id} project={p} idx={idx} onOpen={() => navigate({ name: 'project', id: p.id, tool: 'bench' })} />)}</div>
        )}
    </div>
  );
}
