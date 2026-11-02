import { useEffect, useRef } from 'react';
import type { HarnessConfig } from '@/store/config';
import { useRoute } from '../router/useRoute';
import { formatRoute, routeTitle } from '../router/routes';
import { AgentsPage } from '../agents/AgentsPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { WorkspacesPage } from '../pages/WorkspacesPage';
import { WorkspacePage } from '../pages/WorkspacePage';
import { ProjectsPage } from '../pages/ProjectsPage';
import { ProjectBench } from '../project/ProjectBench';
import { PlannedPage } from '../pages/PlannedPage';
import { ArtifactsPage } from '../pages/ArtifactsPage';
import { HandoffsPage } from '../pages/HandoffsPage';
import { WelcomePage } from '../pages/WelcomePage';
import { StartPage } from '../start/StartPage';
import { useNexusUi } from '../state/uiStore';

export function RouteView({ config }: { config: HarnessConfig }) {
  const route = useRoute();
  const welcomed = useNexusUi((s) => s.welcomed);
  const introSeen = useNexusUi((s) => s.introSeen);
  const audience = useNexusUi((s) => s.audience);
  const key = formatRoute(route);
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    mainRef.current?.scrollTo?.({ top: 0 });
    mainRef.current?.querySelector<HTMLElement>('h1')?.focus?.();
    document.title = `${routeTitle(route)} · Nexus`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, welcomed]);
  let page;
  switch (route.name) {
    case 'agents': page = <AgentsPage config={config} />; break;
    case 'not-found': page = <NotFoundPage />; break;
    case 'workspaces': page = <WorkspacesPage />; break;
    case 'workspace': page = <WorkspacePage id={route.id} />; break;
    case 'projects': page = <ProjectsPage />; break;
    case 'project': page = <ProjectBench key={route.id} id={route.id} tool={route.tool} />; break;
    case 'artifacts': page = <ArtifactsPage id={route.id ?? null} />; break;
    case 'handoffs': page = <HandoffsPage id={route.id ?? null} />; break;
    case 'deployments': page = <PlannedPage which="deployments" />; break;
    // Until Get started is pressed once, Home is the Welcome intro.
    case 'home': page = welcomed ? <StartPage /> : <WelcomePage startAt={introSeen ? (audience ? 'work' : 'about') : 'intro'} />; break;
    case 'welcome': page = <WelcomePage />; break;
  }
  return <main ref={mainRef} className={`nx-main${route.name === 'agents' || route.name === 'project' ? ' nx-main--flush' : ''}`} id="nx-main" tabIndex={-1}>{page}</main>;
}
