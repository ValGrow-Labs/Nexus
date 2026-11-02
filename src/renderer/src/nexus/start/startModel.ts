import { buildContextHeader } from '../assistant/context';
import { WORKSPACES } from '../workspaces/registry';

/** The Start flow, on one screen: describe what you want, see which
 *  environment and project it goes to, then hand it to the lead agent.
 *  Pure: no React, no window, testable in node. */

/** Words that point at an environment. Matching is on word starts, so
 *  "dashboards" hits "dashboard". Weights favour specific terms over
 *  generic ones ("model" alone is weaker than "train" + "model"). */
const SIGNALS: Record<string, [string, number][]> = {
  sde: [['web', 2], ['app', 2], ['api', 3], ['rest', 2], ['backend', 3], ['frontend', 2], ['website', 3], ['service', 2], ['code', 2], ['bug', 2], ['refactor', 3], ['repo', 2], ['cli', 2], ['automat', 2], ['script', 2], ['mobile', 2], ['game', 2]],
  ml: [['model', 2], ['train', 2], ['classif', 3], ['predict', 3], ['dataset', 2], ['regression', 3], ['ml', 3], ['machine', 2], ['ai', 2], ['llm', 3], ['embedding', 3], ['recommend', 3], ['experiment', 2]],
  dl: [['neural', 3], ['cnn', 4], ['transformer', 3], ['vision', 3], ['image', 2], ['fine', 2], ['tune', 2], ['checkpoint', 3], ['gpu', 3], ['deep', 3], ['segment', 3], ['detect', 2], ['pytorch', 3]],
  data: [['data', 2], ['dashboard', 4], ['analy', 3], ['sql', 3], ['query', 3], ['report', 2], ['chart', 3], ['metric', 2], ['sales', 2], ['etl', 3], ['warehouse', 3], ['spreadsheet', 3], ['insight', 3]],
  research: [['research', 4], ['paper', 4], ['study', 3], ['literature', 4], ['survey', 3], ['hypothes', 4], ['review', 2], ['notes', 2], ['investigat', 3]],
  qa: [['test', 3], ['qa', 4], ['e2e', 4], ['end', 1], ['quality', 3], ['regression', 1], ['coverage', 3], ['bug', 1], ['playwright', 4], ['cypress', 4]],
  uiux: [['design', 3], ['ui', 3], ['ux', 3], ['prototype', 4], ['figma', 4], ['wireframe', 4], ['landing', 3], ['mockup', 4], ['layout', 2], ['brand', 2]],
  devops: [['deploy', 4], ['pipeline', 3], ['ci', 3], ['cd', 2], ['docker', 4], ['kubernetes', 4], ['k8s', 4], ['infra', 3], ['monitor', 3], ['cloud', 2], ['terraform', 4], ['server', 2], ['devops', 4]]
};

export interface Detection { id: string | null; confidence: 'strong' | 'weak' | 'none'; matched: string[] }

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Pick the environment a request belongs to, or none. Never invents a
 *  workspace: only ids present in the registry are returned. */
export function detectEnvironment(text: string): Detection {
  const ws = words(text);
  if (!ws.length) return { id: null, confidence: 'none', matched: [] };
  let best: { id: string; score: number; matched: string[] } | null = null;
  for (const w of WORKSPACES) {
    const signals = SIGNALS[w.id] ?? [];
    let score = 0; const matched: string[] = [];
    for (const word of ws) {
      for (const [stem, weight] of signals) {
        if (word.startsWith(stem)) { score += weight; matched.push(word); break; }
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { id: w.id, score, matched };
  }
  if (!best) return { id: null, confidence: 'none', matched: [] };
  return { id: best.id, confidence: best.score >= 4 ? 'strong' : 'weak', matched: best.matched };
}

/** Popular ideas under the box. Each fills a request that detects to the
 *  environment it names (checked by a test). */
export const IDEAS = [
  { label: 'Web app', prompt: 'Build a web app with a login page and a dashboard', expect: 'sde' },
  { label: 'AI project', prompt: 'Train a model to classify support emails', expect: 'ml' },
  { label: 'Data analysis', prompt: 'Analyze sales data and build a dashboard', expect: 'data' },
  { label: 'Research', prompt: 'Write a literature review on vector databases', expect: 'research' },
  { label: 'Automation', prompt: 'Set up a CI pipeline that deploys on every merge', expect: 'devops' },
  { label: 'UI design', prompt: 'Design a landing page prototype for our product', expect: 'uiux' }
] as const;

/** The same, in plain words, for people who said they are not technical.
 *  Each still detects to the environment it names (checked by a test). */
export const PLAIN_IDEAS = [
  { label: 'A website', prompt: 'A website for my small business', expect: 'sde' },
  { label: 'Sales dashboard', prompt: 'A dashboard of my monthly sales', expect: 'data' },
  { label: 'Customer forecast', prompt: 'Predict which customers will come back', expect: 'ml' },
  { label: 'Competitor research', prompt: 'Research what our competitors charge', expect: 'research' },
  { label: 'Landing page', prompt: 'Design a landing page for our product', expect: 'uiux' },
  { label: 'Check my app', prompt: 'Test our app before we launch', expect: 'qa' }
] as const;

/** The message the lead agent receives: the person's words, unchanged,
 *  under a one-line header naming the environment and project folder. */
export function buildStartRequest(input: { text: string; workspaceLabel: string; project: { name: string; rootPath: string } }) {
  return {
    text: input.text.trim(),
    contextHeader: buildContextHeader({ workspace: input.workspaceLabel, project: input.project, page: 'Start' }) ?? ''
  };
}

/** The environment the request goes to: the person's own pick when they
 *  made one, otherwise whatever the words detect (or none). Never returns
 *  an id that is not in the registry. */
export function chosenEnvironment(text: string, pickedId: string | null): string | null {
  if (pickedId) return WORKSPACES.some((w) => w.id === pickedId) ? pickedId : null;
  return detectEnvironment(text).id;
}

/** The workspaces that are delivered today. A request that matches another one is carried over to Software, unchanged. */
export const DELIVERED_WORKSPACES: readonly string[] = ['sde', 'ml'];

/** Where the work really starts: the matched workspace when it is delivered, otherwise Software, with one plain line saying so. */
export function startTarget(envId: string | null, envName: string | null): { workspaceId: string; note: string | null } {
  if (!envId) return { workspaceId: 'sde', note: null };
  if (DELIVERED_WORKSPACES.includes(envId)) return { workspaceId: envId, note: null };
  return { workspaceId: 'sde', note: `${envName ?? 'That kind of'} projects are coming later. Nexus will start this as a Software project.` };
}

/** The kind of project a new folder becomes: a Machine learning project when the work starts there (it gets data upload and results), otherwise Software. */
export function startDomainId(workspaceId: string): 'ai-ml' | 'software-engineering' {
  return workspaceId === 'ml' ? 'ai-ml' : 'software-engineering';
}

/**
 * Why Start cannot run yet, or null when it can: only the two things Start really needs, a request and a project (or a folder for
 * a new one). Nothing else blocks it: not the environment (a request that matches none starts in Software), and never whether
 * the old lead agent is running (the request goes to the AI helper of the project).
 */
export function startBlocker(input: { text: string; hasProject: boolean }): string | null {
  if (!input.text.trim()) return 'Type what you want.';
  if (!input.hasProject) return 'Choose a project or a folder.';
  return null;
}
