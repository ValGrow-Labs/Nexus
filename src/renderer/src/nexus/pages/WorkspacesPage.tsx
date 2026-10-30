import type { DomainId } from '@shared/domain';
import { useStore } from '@/store/store';
import { provenanceStyle } from '../ui/ProvenanceMark';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { useShellActions } from '../shellActions';
import { buildWorkspaceIndex } from './workspaceIndex';
import { useParticipationIndex } from '../data/useParticipations';
import { PlatformNotice } from '../components/PlatformNotice';
import type { WorkspaceId } from '../workspaces/types';
import { useDomains } from '../data/useExecution';
import { isDomainOnly, railFor } from '../workspaces/lifecycleModel';
import { plainView } from '../workspaces/plainDomainCopy';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What the count means: a project joins the workspace that fits what Nexus finds in it; projects added by hand are counted too. */
function projectsTitle(r: { hasDomain: boolean; attached: number }): string | undefined {
  const attached = r.attached > 0 ? `${plural(r.attached, 'project')} added by hand` : '';
  if (r.hasDomain) return `Projects join this workspace by what Nexus finds in them${attached ? `; ${attached} included` : ''}`;
  return attached ? `${attached[0].toUpperCase()}${attached.slice(1)}` : undefined;
}

/** Workspaces as an index: one row per kind of work, with its real projects
 *  and what is planned. Click a row to open it. */
export function WorkspacesPage() {
  const projects = useStore((s) => s.projects);
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  const actions = useShellActions();
  const idx = buildWorkspaceIndex(projects, useParticipationIndex());
  // Workspaces that do not exist yet (data science): listed apart, worded so they never read as available.
  const later = useDomains().list.filter((d) => isDomainOnly(d.id));

  const open = (id: WorkspaceId) => {
    setLast(id);
    navigate({ name: 'workspace', id });
  };

  return (
    <div className="nx-page nx-wsx">
      <header className="nx-wsx__head">
        <div className="nx-wsx__title">
          <h1 tabIndex={-1}>Workspaces</h1>
          <p>
            {plural(idx.rows.length, 'workspace')} · {plural(idx.totalProjects, 'project')}
            {idx.unassigned > 0 && <> · <button type="button" className="nx-wsx__link" onClick={() => navigate({ name: 'projects' })}>{idx.unassigned} unassigned</button></>}
          </p>
        </div>
        <button type="button" className="nx-wsx__new" onClick={() => actions.openNewProject()}>New project</button>
      </header>
      <PlatformNotice />

      <ul className="nx-wsx__list" aria-label="Workspaces">
        {idx.rows.map((r) => (
          <li key={r.id} className="nx-wsx__row" style={provenanceStyle(r.ws.hueSlot)}>
            <button type="button" className="nx-wsx__open" onClick={() => open(r.id)} aria-label={`Open ${r.ws.name}`}>
              <span className="nx-wsx__name">
                <i aria-hidden="true" />
                <b>{r.ws.name}</b>
                <small>{r.ws.tagline}</small>
              </span>
              <span className="nx-wsx__desc">{r.ws.description}</span>
              <span className="nx-wsx__projects" title={projectsTitle(r)}>
                {r.count > 0 ? (
                  <>
                    <b>{plural(r.count, 'project')}</b>
                    <small>{r.recent.map((p) => p.name).join(', ')}{r.count > r.recent.length ? ', …' : ''}</small>
                  </>
                ) : (
                  <>
                    <b className="is-empty">No projects yet</b>
                    <small>{r.hasDomain ? 'New projects of this kind land here' : 'Nothing joins this workspace by itself yet'}</small>
                  </>
                )}
              </span>
              <span className="nx-wsx__planned">
                {r.ws.plannedModules.length > 0 && <><small>Coming later</small>{r.ws.plannedModules.join(' · ')}</>}
              </span>
              <span className="nx-wsx__chev" aria-hidden="true">→</span>
            </button>
            <button type="button" className="nx-wsx__add" onClick={() => actions.openNewProject(r.ws.defaultDomainId as DomainId | undefined)}
              aria-label={`New ${r.ws.label} project`} title={`New ${r.ws.label} project`}>+</button>
          </li>
        ))}
      </ul>
      {later.length > 0 && (
        <section className="nx-wsx__later" aria-labelledby="nx-wsx-later">
          <h2 id="nx-wsx-later" className="nx-wsx__later-title">Coming later</h2>
          <ul className="nx-wsx__later-list">
            {later.map((raw) => {
              const d = plainView(raw);
              return (
                <li key={d.id}>
                  <button type="button" className="nx-wsx__link" onClick={() => navigate({ name: 'workspace', id: d.id })}
                    aria-label={`${d.label}: ${railFor(d).availability ?? 'not available yet'}. See what it will do`}>{d.label}</button>
                  {' '}<span className="nx-muted">{railFor(d).availability ?? 'Not available yet'}. You can read what it will do, but nothing works yet.</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
