// Pure: a workspace's lifecycle in plain words. The registry (src/shared/nexus/domains) keeps its own sentences, which main and the
// docs quote, so they are never edited for the screen: this table is what a person reads instead. It changes WORDS only, never an
// id, a step order or a status, and it never says more than the registry proves (the AI helper is still "new, off by default" and
// only tried with a script). Phase codes (B2c, B3...) are never shown: say "coming later".
import type { DomainSpecView } from '@shared/nexus/ipc';
import { getWorkspace } from './registry';

interface PlainDomain {
  /** Used when the domain has no workspace in the renderer registry (Data Scientist). */
  label?: string;
  description?: string;
  statusNote?: string;
  steps?: Record<string, { label?: string; note?: string }>;
  modules?: Record<string, string>;
}

/** Said wherever the AI helper's work is described as part of what works now (the same claim as the registry's AGENT_NEW_NOTE). */
const HELPER_NEW = 'The AI helper is new and off by default. It has only been tried with a practice run that follows a script, not yet with a real AI on this computer.';
const HELPER_SCOPE = 'The AI helper changes files in a safe copy of your project and runs every command in a safe space with no internet. '
  + `It is kept to that copy by Nexus's rules, not by your computer's system. ${HELPER_NEW}`;

const COPY: Readonly<Record<string, PlainDomain>> = Object.freeze({
  sde: {
    description: 'Turn what you need into code that is tested, built and running, with proof for each claim: saved versions, test results, build records and app checks.',
    statusNote: 'You can write what you need, save a starting point, run tests, build, make an app and try it on this computer, and look for problems. '
      + 'The AI helper can draft what you need and suggest changes in a safe copy of your project. You read its changes, keep them, and add them to your project. '
      + HELPER_NEW,
    steps: {
      requirement: { note: 'You write it in Nexus, or the AI helper drafts it for you to read.' },
      repository: { label: 'Starting point' },
      code: { label: 'Your code', note: 'Tasks run on saved versions of your code. Changes you have not saved are not included.' },
      'ai-implementation': { label: 'Suggested changes', note: HELPER_SCOPE },
      tests: { note: 'Works with the common JavaScript and Python test tools. Tests run on a saved version of your code, so changes you have not saved are not included.' },
      review: { label: 'Your review', note: `Keeping suggested changes saves them in Nexus's copy, never in your files. Adding them to your project is a step you confirm. ${HELPER_NEW}` },
      application: { label: 'App', note: 'Your project needs a small settings file called nexus.app.json.' },
      'dev-deployment': { label: 'Test run of your app', note: 'It runs only on this computer, so nobody else can reach it. Running it anywhere else is not available yet.' },
      diagnostics: { label: 'Problem report' },
      iteration: { label: 'Improve the changes', note: HELPER_SCOPE }
    },
    modules: {
      requirements: 'Requirements', repository: 'Starting points', changes: 'Suggested changes', tests: 'Tests', builds: 'Builds', applications: 'Apps',
      'dev-deployments': 'Test runs of your app', diagnostics: 'Problem reports', sessions: 'AI helper conversations'
    }
  },
  qa: {
    statusNote: 'You can see the testing steps so you know what is coming. None of them works yet. Testing workflows are coming later.'
  },
  data: {
    description: 'Answer a business question with queries you can repeat over saved data, and share the answer.',
    statusNote: 'You can write business questions now. Data sources, queries, analyses, charts and reports are coming later.',
    steps: { 'business-question': { note: 'You write it in Nexus. The rest of this workflow is coming later.' } }
  },
  ml: {
    description: 'Turn data and a problem into a checked model that is packaged, served and watched, with a record of every run you can repeat.',
    statusNote: 'You can write problem statements now. Datasets, training, evaluation, packaging and serving are coming later.',
    steps: { problem: { note: 'You write it in Nexus. The rest of this workflow is coming later.' } }
  },
  dl: {
    description: 'Train, compare, export, speed up and serve neural networks, with saved versions and proof that the results match.',
    statusNote: 'You can write problem statements now. Training, saved versions, export and serving are coming later.',
    steps: { problem: { note: 'You write it in Nexus. The rest of this workflow is coming later.' } }
  },
  'data-scientist': {
    label: 'Data science',
    description: 'Find out what is true in the data and what a simple model can predict, in a way you can repeat, and pass the results on to machine learning.',
    statusNote: 'You can read its steps, but none of them works yet. A project can take part in data science work later.'
  }
});

/** The registry's own "not a supported workflow" sentence, said plainly. */
const REGISTRY_ONLY_NOTE = 'Not yet a supported workflow.';
const REGISTRY_ONLY_PLAIN = 'Not available yet.';

/** The name a person reads for a domain (its workspace's name, or its table label); null when this file has no name for it. */
export function plainDomainLabel(id: string): string | null {
  return getWorkspace(id)?.name ?? COPY[id]?.label ?? null;
}

/**
 * The domain as a person reads it. The name is the workspace's own name (Software, Machine learning, ...); a domain without a workspace
 * uses its table label. Anything the table does not cover keeps the registry's words.
 */
export function plainView(view: DomainSpecView): DomainSpecView {
  const c = COPY[view.id];
  const ws = getWorkspace(view.id);
  const statusNote = c?.statusNote ?? (view.statusNote === REGISTRY_ONLY_NOTE ? REGISTRY_ONLY_PLAIN : view.statusNote);
  const label = ws ? ws.name : c?.label ?? view.label;
  if (!c && label === view.label && statusNote === view.statusNote) return view;
  return {
    ...view, label, description: c?.description ?? view.description, statusNote,
    lifecycle: view.lifecycle.map((s) => {
      const p = c?.steps?.[s.id];
      return p ? { ...s, label: p.label ?? s.label, scopeNote: p.note ?? s.scopeNote } : s;
    }),
    modules: view.modules.map((m) => (c?.modules?.[m.id] ? { ...m, label: c.modules[m.id] } : m))
  };
}
