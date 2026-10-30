import type { DomainId } from '@shared/domain';
import type { WorkspaceConfig } from './types';
import { WORKSPACE_PLAIN_NAMES } from '../data/glossary';

export { WORKSPACE_IDS } from './types';
export type { WorkspaceConfig, WorkspaceId } from './types';

/** Adding a workspace = adding an entry here (and an icon name if new).
 *  Launcher, grid, palette, filters and mapping all read this list. */
const ENTRIES: WorkspaceConfig[] = [
  {
    id: 'sde', label: WORKSPACE_PLAIN_NAMES.sde, name: WORKSPACE_PLAIN_NAMES.sde, tagline: 'Code · Apps · Builds',
    description: 'Write and test code, and build apps and services, with your AI helper.',
    icon: 'sde', hueSlot: 0,
    domainIds: ['software-engineering', 'web-app-dev', 'mobile-dev', 'game-dev', 'embedded-systems', 'robotics-iot', 'blockchain-web3', 'automation-rpa'],
    defaultDomainId: 'software-engineering', order: 1,
    plannedModules: ['Starting points', 'Services', 'Builds']
  },
  {
    id: 'ml', label: WORKSPACE_PLAIN_NAMES.ml, name: WORKSPACE_PLAIN_NAMES.ml, tagline: 'Data · Models · Use',
    description: 'Prepare data, train and check machine learning models, and get them ready to use.',
    icon: 'ml', hueSlot: 1, domainIds: ['ai-ml'], defaultDomainId: 'ai-ml',
    order: 2, plannedModules: ['Datasets', 'Experiments', 'Models']
  },
  {
    id: 'dl', label: WORKSPACE_PLAIN_NAMES.dl, name: WORKSPACE_PLAIN_NAMES.dl, tagline: 'Training · Comparing',
    description: 'Train deep learning models, compare your tries and keep the best saved versions.',
    icon: 'dl', hueSlot: 2, domainIds: ['computer-vision'], defaultDomainId: 'computer-vision',
    order: 3, plannedModules: ['Training runs', 'Saved versions', 'Results']
  },
  {
    id: 'data', label: 'Data Analytics', name: 'Data Analytics', tagline: 'Dashboards · Insights',
    description: 'Ask questions of your data, build dashboards and turn what you learn into reports.',
    icon: 'data', hueSlot: 3, domainIds: ['data-analytics', 'data-science', 'gis-geospatial'], defaultDomainId: 'data-analytics',
    order: 4, plannedModules: ['Data sources', 'Queries', 'Dashboards']
  },
  {
    id: 'research', label: 'Research', name: 'Research', tagline: 'Explore · Innovate',
    description: 'Investigate ideas, run studies and write up findings.',
    icon: 'research', hueSlot: 4, domainIds: ['research-scientific'], defaultDomainId: 'research-scientific',
    order: 5, plannedModules: ['Notes', 'Studies', 'Papers']
  },
  {
    id: 'qa', label: WORKSPACE_PLAIN_NAMES.qa, name: WORKSPACE_PLAIN_NAMES.qa, tagline: 'Plan · Test · Report',
    description: 'Plan and run tests, and keep track of quality across your projects.',
    icon: 'qa', hueSlot: 5, domainIds: [],
    order: 6, plannedModules: ['Test plans', 'Test runs', 'Reports']
  },
  {
    id: 'uiux', label: 'UI / UX', name: 'UI / UX Design', tagline: 'Design · Prototype',
    description: 'Design screens, build prototypes and keep your designs consistent.',
    icon: 'uiux', hueSlot: 6, domainIds: [],
    order: 7, plannedModules: ['Designs', 'Prototypes', 'Style guides']
  },
  {
    id: 'devops', label: 'DevOps', name: 'DevOps', tagline: 'Publish · Watch',
    description: 'Publish your apps, keep them running and watch how they are doing.',
    icon: 'devops', hueSlot: 7, domainIds: ['devops-cloud'], defaultDomainId: 'devops-cloud',
    order: 8, plannedModules: ['Places to run', 'Publishing steps', 'Watching']
  }
];

export const WORKSPACES: WorkspaceConfig[] = [...ENTRIES].sort((a, b) => a.order - b.order);

/** Domains deliberately without a workspace in phase A. Their projects show
 *  as "Unassigned" — listed, never hidden. */
export const UNMAPPED_DOMAINS: DomainId[] = ['cybersecurity'];

export function getWorkspace(id: string): WorkspaceConfig | null {
  return WORKSPACES.find((w) => w.id === id) ?? null;
}
