import type { NexusIconName } from '../iconNames';

export interface QuickAction {
  id: 'new-project' | 'analyze-dataset';
  title: string; description: string; icon: NexusIconName;
  kind: 'new-project' | 'prefill';
  prefill?: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'new-project', title: 'Create a new project', description: 'Set up a folder your AI helpers work in', icon: 'sde', kind: 'new-project' },
  { id: 'analyze-dataset', title: 'Analyze a dataset', description: 'Ask the lead AI helper to explore your data', icon: 'dataset', kind: 'prefill',
    prefill: 'Analyze the dataset at <path in this project>: summarize its columns, data quality issues and the most interesting patterns, and save the notebook or script you use.' },
];

export interface Suggestion { id: string; label: string; icon: NexusIconName; prompt: string }

export const SUGGESTIONS: Suggestion[] = [
  { id: 'train', label: 'Train a model on the latest dataset', icon: 'ml', prompt: 'Train a model on the latest dataset in this project, report the evaluation metrics, and save the training script and model file.' },
  { id: 'api', label: "Let other programs use this project's model", icon: 'sde', prompt: "Create an HTTP API endpoint that loads this project's model and returns predictions. Include a sample request and a test." },
  { id: 'landing', label: 'Design a landing page', icon: 'uiux', prompt: 'Design and build a simple landing page for this project. Keep it in a separate folder and explain how to run it.' },
  { id: 'tests', label: 'Run the tests and fix failures', icon: 'qa', prompt: "Run this project's test suite, fix any failures you find, and summarize what you changed." },
  { id: 'readme', label: 'Write or update the project guide', icon: 'research', prompt: 'Read this project and write or update its README: what it does, how to set it up, how to run and test it.' },
  { id: 'review', label: 'Review recent changes', icon: 'sde', prompt: 'Review the most recent changes in this repository and list concrete bugs or risks, most severe first.' }
];
