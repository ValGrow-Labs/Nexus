import type { NexusIconName } from '../iconNames';
import type { Route } from '../router/routes';
import type { ShellActions } from '../shellActions';
import { getWorkspace } from '../workspaces/registry';
import { UNASSIGNED_LABEL } from '../workspaces/mapping';
import { primaryViewOf, type ParticipationIndex } from '../workspaces/participation';

export interface NavItem { id: string; label: string; icon: NexusIconName; route?: Route; action?: keyof ShellActions; planned?: boolean }

export const MENU_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: 'Go to', items: [
    { id: 'home', label: 'Home', icon: 'home', route: { name: 'home' } },
    { id: 'workspaces', label: 'Workspaces', icon: 'workspaces', route: { name: 'workspaces' } },
    { id: 'projects', label: 'Projects', icon: 'projects', route: { name: 'projects' } },
    { id: 'artifacts', label: 'Saved items', icon: 'artifacts', route: { name: 'artifacts' } },
    { id: 'handoffs', label: 'Handoffs', icon: 'handoffs', route: { name: 'handoffs' } },
    { id: 'agents', label: 'Agents', icon: 'agents', route: { name: 'agents' } }
  ] },
  { label: 'Coming later', items: [
    { id: 'deployments', label: 'Publishing', icon: 'deployments', route: { name: 'deployments' }, planned: true }
  ] },
  { label: 'App', items: [
    { id: 'welcome', label: 'Welcome', icon: 'help', route: { name: 'welcome' } },
    { id: 'files', label: 'Files', icon: 'files', action: 'openIde' },
    { id: 'integrations', label: 'Integrations', icon: 'integrations', action: 'openSettings' },
    { id: 'settings', label: 'Settings', icon: 'settings', action: 'openSettings' }
  ] }
];

export type PathSegment = { kind: 'workspace' | 'project'; id: string; label: string; hueSlot: number | null };
type P = { id: string; name: string };

/** The project segment follows the project's primary workspace; no primary is Unassigned. */
export function pathSegments(r: Route, projects: P[], idx: ParticipationIndex): PathSegment[] {
  if (r.name === 'workspace') {
    const w = getWorkspace(r.id);
    return w ? [{ kind: 'workspace', id: w.id, label: w.label, hueSlot: w.hueSlot }] : [];
  }
  if (r.name === 'project') {
    const p = projects.find((x) => x.id === r.id);
    if (!p) return [];
    const w = primaryViewOf(idx, p.id);
    const ws: PathSegment = w ? { kind: 'workspace', id: w.id, label: w.label, hueSlot: w.hueSlot } : { kind: 'workspace', id: 'unassigned', label: UNASSIGNED_LABEL, hueSlot: null };
    return [ws, { kind: 'project', id: p.id, label: p.name, hueSlot: null }];
  }
  return [];
}
