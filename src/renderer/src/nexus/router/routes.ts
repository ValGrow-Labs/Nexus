import { getWorkspace } from '../workspaces/registry';
import type { WorkspaceId } from '../workspaces/types';
import { getDomain } from '@shared/nexus/domains';
import { isDomainOnly } from '../workspaces/lifecycleModel';
import { plainDomainLabel } from '../workspaces/plainDomainCopy';

/** A registry domain with no workspace (Data Scientist in B2a): `#/w/<id>` opens its honest domain page. */
export type DomainPageId = string;

export const PROJECT_TOOLS = ['bench', 'changes', 'completion', 'runs', 'try'] as const;
export type ProjectTool = (typeof PROJECT_TOOLS)[number];

export type Route =
  | { name: 'home' }
  | { name: 'welcome' }
  | { name: 'workspaces' }
  | { name: 'workspace'; id: WorkspaceId | DomainPageId }
  | { name: 'projects' }
  | { name: 'project'; id: string; tool: ProjectTool }
  | { name: 'artifacts'; id?: string }
  | { name: 'handoffs'; id?: string }
  | { name: 'deployments' }
  | { name: 'agents' }
  | { name: 'not-found'; path: string };

const SIMPLE = ['welcome', 'workspaces', 'projects', 'artifacts', 'handoffs', 'deployments', 'agents'] as const;

/** Pages with an optional record id: `#/artifacts/<id>`, `#/handoffs/<id>`. */
const WITH_ID = ['artifacts', 'handoffs'] as const;

/** The platform id shape (the ULID `newId` produces). Anything else in the address is not found. */
export const PLATFORM_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isPlatformId(id: unknown): id is string {
  return typeof id === 'string' && PLATFORM_ID_RE.test(id);
}

function decode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

export function parseHash(hash: string): Route {
  let path = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\/+$/, '');
  if (path === '') return { name: 'home' };
  const parts = path.slice(1).split('/');
  const notFound: Route = { name: 'not-found', path };
  if (parts.length === 1) {
    // The old environment picker (#/browse) is gone: an old link opens the Workspaces list instead of dead-ending.
    if (parts[0] === 'browse') return { name: 'workspaces' };
    const head = parts[0] as (typeof SIMPLE)[number];
    return (SIMPLE as readonly string[]).includes(head) ? ({ name: head } as Route) : notFound;
  }
  if (parts.length === 2 || parts.length === 3) {
    const id = decode(parts[1]);
    if (!id) return notFound;
    if ((WITH_ID as readonly string[]).includes(parts[0]) && parts.length === 2) {
      return isPlatformId(id) ? ({ name: parts[0], id } as Route) : notFound;
    }
    if (parts[0] === 'w' && parts.length === 2) {
      // A workspace, or a registry domain that has no workspace yet (its page draws the rail; nothing is written).
      return getWorkspace(id) ? { name: 'workspace', id: id as WorkspaceId } : isDomainOnly(id) ? { name: 'workspace', id } : notFound;
    }
    if (parts[0] === 'p') {
      // The old plan tool's links ('#/p/<id>/plan') open Completion.
      const tool = (parts[2] === 'plan' ? 'completion' : parts[2] ?? 'bench') as ProjectTool;
      return (PROJECT_TOOLS as readonly string[]).includes(tool) ? { name: 'project', id, tool } : notFound;
    }
  }
  return notFound;
}

export function formatRoute(r: Route): string {
  switch (r.name) {
    case 'home': return '#/';
    case 'workspace': return `#/w/${encodeURIComponent(r.id)}`;
    case 'project': return r.tool === 'bench' ? `#/p/${encodeURIComponent(r.id)}` : `#/p/${encodeURIComponent(r.id)}/${r.tool}`;
    case 'artifacts':
    case 'handoffs': return r.id !== undefined ? `#/${r.name}/${encodeURIComponent(r.id)}` : `#/${r.name}`;
    case 'not-found': return `#${r.path}`;
    default: return `#/${r.name}`;
  }
}

const TITLES: Record<string, string> = {
  home: 'Home', welcome: 'Welcome', browse: 'Choose a workspace', workspaces: 'Workspaces', projects: 'Projects', project: 'Project',
  artifacts: 'Saved items', handoffs: 'Handoffs', deployments: 'Publishing', agents: 'Agents', 'not-found': 'Page not found'
};

const TOOL_TITLES: Record<ProjectTool, string> = { bench: 'Project', changes: 'Suggested changes', completion: 'Checklist', runs: 'Tasks', try: 'Try it' };

export function routeTitle(r: Route): string {
  if (r.name === 'workspace') {
    const ws = getWorkspace(r.id);
    return ws ? `${ws.label} workspace` : plainDomainLabel(r.id) ?? getDomain(r.id)?.label ?? r.id;
  }
  if (r.name === 'project') return TOOL_TITLES[r.tool];
  if (r.name === 'artifacts' && r.id !== undefined) return 'Saved item';
  if (r.name === 'handoffs' && r.id !== undefined) return 'Handoff';
  return TITLES[r.name];
}

export function routesEqual(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}
