/**
 * Authentic Nexus Workspace Definitions & Procedural Emblems
 * Faithfully mirrors src/renderer/src/nexus/workspaces/registry.ts
 * and src/renderer/src/nexus/launcher/emblems.ts
 */

export const BASE_HUE = 265;
export const GOLDEN_ANGLE = 137.508;

export function provenanceHue(slot: number): number {
  const h = (BASE_HUE + slot * GOLDEN_ANGLE) % 360;
  return Math.round(h * 10) / 10;
}

export const EMBLEM_POINTS = 72;
export const EMBLEM_VIEW = 100;
const C = EMBLEM_VIEW / 2;
const R = 36;

type Radius = (t: number) => number;

const superellipse = (n: number): Radius => (t) =>
  1 / Math.pow(Math.pow(Math.abs(Math.cos(t)), n) + Math.pow(Math.abs(Math.sin(t)), n), 1 / n);

const polygon = (sides: number, rot = 0): Radius => (t) => {
  const seg = (2 * Math.PI) / sides;
  const a = ((t - rot) % seg + seg) % seg - seg / 2;
  return Math.cos(Math.PI / sides) / Math.cos(a);
};

const SHAPES: Record<string, Radius> = {
  sde: (t) => 0.92 * superellipse(4)(t),
  ml: (t) => 0.8 + 0.16 * Math.cos(6 * t),
  dl: (t) => 0.96 * polygon(3, -Math.PI / 2)(t),
  data: (t) => 0.66 + 0.3 * Math.max(0, Math.cos(5 * (t + Math.PI / 2))),
  research: (t) => 0.82 + 0.12 * Math.cos(2 * t),
  qa: polygon(6),
  uiux: (t) => 0.84 + 0.08 * Math.sin(3 * t) + 0.05 * Math.cos(5 * t + 1),
  devops: (t) => 0.5 + 0.46 * Math.pow(Math.abs(Math.cos(2 * t)), 3),
  generic: () => 0.9
};

const fmt = (n: number) => String(Math.round(n * 10) / 10);

export function emblemPath(id: string): string {
  const r = SHAPES[id] ?? SHAPES.generic;
  const pts: string[] = [];
  for (let i = 0; i < EMBLEM_POINTS; i++) {
    const t = (i / EMBLEM_POINTS) * 2 * Math.PI - Math.PI / 2;
    const k = Math.min(1.25, Math.max(0.2, r(t)));
    pts.push(`${fmt(C + R * k * Math.cos(t))} ${fmt(C + R * k * Math.sin(t))}`);
  }
  return `M ${pts[0]} ${pts.slice(1).map((p) => `L ${p}`).join(' ')} Z`;
}

export interface WorkspaceItem {
  id: string;
  label: string;
  name: string;
  tagline: string;
  description: string;
  hueSlot: number;
  hue: number;
  domains: string[];
  plannedModules: string[];
  emblemD: string;
  sampleCommands: string[];
}

export const WORKSPACES: WorkspaceItem[] = [
  {
    id: 'sde',
    label: 'SDE',
    name: 'Software Engineering',
    tagline: 'Code · APIs · Build',
    description: 'Write, review and ship code, services and APIs with your agents.',
    hueSlot: 0,
    hue: provenanceHue(0), // 265.0
    domains: ['software-engineering', 'web-app-dev', 'mobile-dev', 'game-dev', 'embedded-systems', 'robotics-iot', 'blockchain-web3', 'automation-rpa'],
    plannedModules: ['Repositories', 'APIs', 'Builds'],
    emblemD: emblemPath('sde'),
    sampleCommands: ['nexus route api-gateway', 'claude test --all', 'nexus diff inspect']
  },
  {
    id: 'ml',
    label: 'ML',
    name: 'Machine Learning',
    tagline: 'Datasets · Models · Deploy',
    description: 'Prepare data, train and evaluate models, and get them ready to serve.',
    hueSlot: 1,
    hue: provenanceHue(1), // 42.5
    domains: ['ai-ml'],
    plannedModules: ['Datasets', 'Experiments', 'Models'],
    emblemD: emblemPath('ml'),
    sampleCommands: ['nexus eval classification-v2', 'python evaluate.py', 'nexus model register']
  },
  {
    id: 'dl',
    label: 'DL',
    name: 'Deep Learning',
    tagline: 'Training · Experiments',
    description: 'Run training jobs, compare experiments and manage checkpoints.',
    hueSlot: 2,
    hue: provenanceHue(2), // 180.0
    domains: ['computer-vision'],
    plannedModules: ['Training runs', 'Checkpoints', 'Evaluations'],
    emblemD: emblemPath('dl'),
    sampleCommands: ['nexus job run torch-train', 'nexus checkpoint sync', 'nexus loss curve']
  },
  {
    id: 'data',
    label: 'Data',
    name: 'Data Analytics',
    tagline: 'Dashboards · Insights',
    description: 'Query data, build dashboards and turn analysis into reports.',
    hueSlot: 3,
    hue: provenanceHue(3), // 317.5
    domains: ['data-analytics', 'data-science', 'gis-geospatial'],
    plannedModules: ['Data sources', 'Queries', 'Dashboards'],
    emblemD: emblemPath('data'),
    sampleCommands: ['duckdb query warehouse.parquet', 'nexus sql explain', 'nexus chart export']
  },
  {
    id: 'research',
    label: 'Research',
    name: 'Research',
    tagline: 'Explore · Innovate',
    description: 'Investigate ideas, run studies and write up findings.',
    hueSlot: 4,
    hue: provenanceHue(4), // 95.0
    domains: ['research-scientific'],
    plannedModules: ['Notes', 'Studies', 'Papers'],
    emblemD: emblemPath('research'),
    sampleCommands: ['nexus note capture', 'arxiv search "attention"', 'nexus bibtex sync']
  },
  {
    id: 'qa',
    label: 'QA',
    name: 'Quality Assurance',
    tagline: 'Test · Automate',
    description: 'Plan and automate tests, and track quality across projects.',
    hueSlot: 5,
    hue: provenanceHue(5), // 232.5
    domains: ['qa-automation'],
    plannedModules: ['Test plans', 'Test runs', 'Reports'],
    emblemD: emblemPath('qa'),
    sampleCommands: ['playwright test --headed', 'nexus junit ingest', 'nexus coverage matrix']
  },
  {
    id: 'uiux',
    label: 'UI / UX',
    name: 'UI / UX Design',
    tagline: 'Design · Prototype',
    description: 'Design interfaces, build prototypes and maintain design systems.',
    hueSlot: 6,
    hue: provenanceHue(6), // 10.0
    domains: ['design-systems'],
    plannedModules: ['Designs', 'Prototypes', 'Design systems'],
    emblemD: emblemPath('uiux'),
    sampleCommands: ['nexus tokens extract', 'figma inspect component', 'nexus story preview']
  },
  {
    id: 'devops',
    label: 'DevOps',
    name: 'DevOps',
    tagline: 'Deploy · Monitor',
    description: 'Manage environments, pipelines and the services you run.',
    hueSlot: 7,
    hue: provenanceHue(7), // 147.5
    domains: ['devops-cloud'],
    plannedModules: ['Environments', 'Pipelines', 'Monitoring'],
    emblemD: emblemPath('devops'),
    sampleCommands: ['docker compose up -d', 'terraform plan', 'nexus health check']
  }
];

