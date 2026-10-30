// WorkspacePage.tsx
import { useEffect } from 'react';
import { useStore } from '@/store/store';
import type { WorkspaceId } from '../workspaces/types';
import { getWorkspace } from '../workspaces/registry';
import { workspaceTabs } from '../workspaces/mapping';
import { projectsInWorkspace } from '../workspaces/participation';
import { useParticipationIndex } from '../data/useParticipations';
import { usePlatform, selectCanWrite } from '../data/platformStore';
import { recentProjects } from '../data/selectors';
import { useProjectsLoader } from '../data/useProjects';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { useNexusUi } from '../state/uiStore';
import { ProvenanceMark, provenanceStyle } from '../ui/ProvenanceMark';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ProjectRow } from '../components/ProjectRow';
import { LoadError, RowsSkeleton } from '../components/LoadStates';
import { PlatformNotice } from '../components/PlatformNotice';
import { useDomains } from '../data/useExecution';
import { railFor } from '../workspaces/lifecycleModel';
import { LifecycleRail } from '../workspaces/LifecycleRail';
import type { DomainPageId } from '../router/routes';
import { DomainPage } from './DomainPage';

/** `#/w/<id>`: a workspace, or a registry domain with no workspace yet (its domain page: the rail, nothing else). */
export function WorkspacePage({ id }: { id: WorkspaceId | DomainPageId }) {
  const ws = getWorkspace(id);
  return ws ? <WorkspaceView id={ws.id} /> : <DomainPage id={id} />;
}

function WorkspaceView({ id }: { id: WorkspaceId }) {
  const ws = getWorkspace(id)!; // WorkspacePage checked it
  const projects = useStore((s) => s.projects);
  const { status, error, refresh } = useProjectsLoader();
  const actions = useShellActions();
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  useEffect(() => { setLast(id); }, [id, setLast]);
  const idx = useParticipationIndex();
  // Attaching from a project's own page exists only while the database is the authority.
  const canWrite = usePlatform(selectCanWrite);
  const addHint = canWrite ? ` A project can also be added to ${ws.label} from its own page.` : '';
  // Primary projects first, then attached ones; each newest first.
  const here = projectsInWorkspace(idx, projects, id);
  const roleOf = new Map(here.map((x) => [x.project.id, x.role]));
  const mine = [
    ...recentProjects(here.filter((x) => x.role === 'primary').map((x) => x.project), Infinity),
    ...recentProjects(here.filter((x) => x.role === 'attached').map((x) => x.project), Infinity)
  ];
  const unmappable = ws.domainIds.length === 0;
  const tabs = workspaceTabs(ws);
  const planned = tabs.filter((t) => !t.available);
  // The workspace's steps and parts in its own words (the registry); the old coming-later list only without one.
  const domain = useDomains().list.find((d) => d.id === id) ?? null;
  const rail = domain ? railFor(domain) : null;
  return (
    <div className="nx-page">
      <header className="nx-pagehead">
        <div className="nx-pagehead__text">
          <h1 tabIndex={-1}><ProvenanceMark slot={ws.hueSlot} size={12} /> {ws.name}</h1>
          <p className="nx-lead">{ws.description}</p>
        </div>
        <div className="nx-pagehead__actions">
          <Button icon="import" onClick={actions.openImport}>Import a folder</Button>
          <Button variant="primary" icon="plus" onClick={() => actions.openNewProject(ws.defaultDomainId)}>New project</Button>
        </div>
      </header>
      <PlatformNotice />
      <div className="nx-wstabs nx-prov" style={provenanceStyle(ws.hueSlot)}>
        <div role="tablist" aria-label={`${ws.label} workspace`} className="nx-wstabs__list">
          <button type="button" role="tab" id="ws-tab-projects" aria-selected="true" aria-controls="ws-panel-projects" className="nx-wstab nx-focusable">Projects</button>
        </div>
        {!rail && planned.length > 0 && (
          <>
            <p id="ws-planned-note" className="nx-visually-hidden">These open once this workspace has saved items.</p>
            <div className="nx-wstabs__planned">
              {planned.map((t) => (
                <span key={t.id} className="nx-wstab nx-wstab--planned" aria-describedby="ws-planned-note">
                  {t.label} <span className="nx-wstab__note">Coming later</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      {rail && <LifecycleRail rail={rail} />}
      <section role="tabpanel" id="ws-panel-projects" aria-labelledby="ws-tab-projects">
        {status === 'error' && projects.length === 0 ? <LoadError error={error} onRetry={refresh} />
          : status === 'loading' && projects.length === 0 ? <RowsSkeleton count={3} />
          : mine.length > 0 ? <div className="nx-rows">{mine.map((p) => <ProjectRow key={p.id} project={p} idx={idx} role={roleOf.get(p.id)} onOpen={() => navigate({ name: 'project', id: p.id, tool: 'bench' })} />)}</div>
          : unmappable ? (
            <EmptyState level={2} icon={ws.icon} title={`No projects in ${ws.label} yet`}
              body={<>Nexus puts a new project in a workspace by what it finds in the project, and nothing lands in {ws.label} by itself yet.{addHint}</>}
              actions={<Button onClick={() => navigate({ name: 'projects' })}>See all projects</Button>} />
          ) : (
            <EmptyState level={2} icon={ws.icon} title={`No projects in ${ws.label} yet`} body={`Press New project to start one here, or import a folder you already have. It joins this workspace when it fits.${addHint}`}
              actions={<><Button variant="primary" icon="plus" onClick={() => actions.openNewProject(ws.defaultDomainId)}>New project</Button><Button icon="import" onClick={actions.openImport}>Import a folder</Button></>} />
          )}
      </section>
    </div>
  );
}
