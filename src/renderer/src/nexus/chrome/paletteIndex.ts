import type { Route } from '../router/routes';
import type { Section as SettingsSection } from '@/components/SettingsModal';
import { WORKSPACES } from '../workspaces/registry';
import { recentProjects } from '../data/selectors';

export type PaletteEntry = {
  id: string;
  group: 'Pages' | 'Workspaces' | 'Projects' | 'Actions';
  label: string;
  hint?: string;
  route?: Route;
  action?: 'newProject' | 'openIde' | 'openSettings' | 'openSemanticMemory';
  /** With action 'openSettings': the Settings section to open on. */
  settingsSection?: SettingsSection;
};

type P = { id: string; name: string; rootPath: string; domainId: string; updatedAt: number };

const PAGES: PaletteEntry[] = [
  { id: 'page:home', group: 'Pages', label: 'Home', route: { name: 'home' } },
  { id: 'page:workspaces', group: 'Pages', label: 'Workspaces', route: { name: 'workspaces' } },
  { id: 'page:projects', group: 'Pages', label: 'Projects', route: { name: 'projects' } },
  { id: 'page:agents', group: 'Pages', label: 'Agents', hint: 'your lead AI helper and terminals', route: { name: 'agents' } },
  { id: 'page:artifacts', group: 'Pages', label: 'Saved items', hint: 'saved versions and files', route: { name: 'artifacts' } },
  { id: 'page:handoffs', group: 'Pages', label: 'Handoffs', hint: 'items passed to another workspace', route: { name: 'handoffs' } },
  { id: 'page:deployments', group: 'Pages', label: 'Publishing', hint: 'coming later', route: { name: 'deployments' } }
];

const ACTIONS: PaletteEntry[] = [
  { id: 'act:new', group: 'Actions', label: 'New project', action: 'newProject' },
  { id: 'act:ide', group: 'Actions', label: 'Open your project\'s files', action: 'openIde' },
  { id: 'act:settings', group: 'Actions', label: 'Open Settings', action: 'openSettings' },
  { id: 'act:settings-memory', group: 'Actions', label: 'Open settings: Memory & Knowledge', hint: 'semantic memory setup', action: 'openSettings', settingsSection: 'Memory & Knowledge' },
  { id: 'act:semantic-memory', group: 'Actions', label: 'Agents: Semantic memory', hint: 'how the AI helpers remember things', action: 'openSemanticMemory' }
];

export function buildPaletteIndex(projects: P[]): PaletteEntry[] {
  const ws: PaletteEntry[] = WORKSPACES.map((w) => ({ id: `ws:${w.id}`, group: 'Workspaces', label: w.name, hint: w.tagline, route: { name: 'workspace', id: w.id } }));
  const pr: PaletteEntry[] = recentProjects(projects, projects.length).map((p) => ({ id: `project:${p.id}`, group: 'Projects', label: p.name, hint: p.rootPath, route: { name: 'project', id: p.id, tool: 'bench' } }));
  return [...PAGES, ...ws, ...pr, ...ACTIONS];
}

export function searchPalette(entries: PaletteEntry[], q: string): PaletteEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    const projects = entries.filter((e) => e.group === 'Projects').slice(0, 5);
    return [...entries.filter((e) => e.group === 'Pages' || e.group === 'Workspaces'), ...projects];
  }
  // The short code of a workspace (sde, ml, dl, qa) still finds it, though people read its plain name.
  return entries.filter((e) => e.label.toLowerCase().includes(needle) || (e.hint ?? '').toLowerCase().includes(needle)
    || (e.group === 'Workspaces' && e.id === `ws:${needle}`));
}
