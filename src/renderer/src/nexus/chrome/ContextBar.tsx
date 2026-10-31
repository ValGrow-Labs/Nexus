import { Fragment } from 'react';
import { useStore } from '@/store/store';
import { useAppTheme, toggleAppTheme } from '@/design/theme';
import { UpdateBadge } from '@/components/UpdateBadge';
import { Icon } from '../icons';
import { useRoute } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { pathSegments } from './navItems';
import { useParticipationIndex } from '../data/useParticipations';
import { NexusMenu } from './NexusMenu';
import { PathSwitcher } from './PathSwitcher';
import { RunsIndicator } from '../runs/RunsIndicator';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/** The single context bar: Nexus menu, the path to where you are, search and
 *  theme. The bar is the window's drag region; every control opts out. */
export function ContextBar() {
  const route = useRoute();
  const projects = useStore((s) => s.projects);
  const theme = useAppTheme();
  const setPaletteOpen = useNexusUi((s) => s.setPaletteOpen);
  const idx = useParticipationIndex();
  const segments = pathSegments(route, projects, idx);
  const wsId = segments.find((s) => s.kind === 'workspace')?.id;

  return (
    <header className={`nx-bar cth-titlebar-drag${IS_MAC ? ' nx-bar--mac' : ''}`}>
      <NexusMenu />
      {segments.length > 0 && (
        <nav className="nx-path" aria-label="Location">
          {segments.map((s) => (
            <Fragment key={`${s.kind}:${s.id}`}>
              <span className="nx-path__sep" aria-hidden="true">/</span>
              <PathSwitcher segment={s} workspaceId={s.kind === 'project' ? wsId : undefined} projects={projects} idx={idx}
                tool={route.name === 'project' ? route.tool : undefined} />
            </Fragment>
          ))}
        </nav>
      )}
      <span className="nx-bar__spacer" />
      <RunsIndicator />
      <span className="nx-bar__version cth-titlebar-nodrag"><UpdateBadge /></span>
      <button type="button" className="nx-btn nx-btn--quiet nx-bar__search cth-titlebar-nodrag" onClick={() => setPaletteOpen(true)} aria-label="Search projects, workspaces and pages">
        <Icon name="search" size={15} />
        <span className="nx-bar__search-text">Search</span>
      </button>
      <button
        type="button"
        className="nx-btn nx-btn--quiet nx-iconbtn cth-titlebar-nodrag"
        onClick={() => { const next = toggleAppTheme(); void window.cth.updateConfig({ terminalTheme: next }); }}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
      </button>
    </header>
  );
}
