// The one card at the top of the project page: what is happening, and the one thing to do next, in plain words.
import type { AgentPanelView } from '../agent/agentModel';
import { CHOOSE_RUNTIME_BUTTON } from '../agent/agentModel';
import { GLOSSARY } from '../data/glossary';

export type NextStepAction = { kind: 'setup' | 'review'; label: string };
export interface NextStep {
  tone: 'ready' | 'working' | 'waiting' | 'review' | 'setup' | 'problem';
  title: string;
  text: string;
  /** The one button, or null when there is nothing for the person to press. */
  action: NextStepAction | null;
}

const lower = (s: string): string => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

/**
 * One card, in this order: waiting for your OK, working, suggested changes to look over, the AI helper not ready or not
 * available, a request that did not work out, and otherwise "ready: ask below". It never says a request is working when the
 * panel has no live request (the panel reads that from the live jobs only).
 */
export function nextStep(i: { panel: AgentPanelView; reviewReady: number; repoApprovalWaiting: boolean }): NextStep {
  const p = i.panel;
  if (i.repoApprovalWaiting || p.waiting) {
    return { tone: 'waiting', title: 'Waiting for you', text: 'The AI helper needs your OK before it can go on. Answer the question just below; it carries on by itself after that.', action: null };
  }
  if (p.progress) {
    return { tone: 'working', title: 'The AI helper is working on your request', text: `${p.progress.running ? `${p.progress.running}. ` : ''}You can keep using Nexus. Next: ${lower(p.progress.next)}`, action: null };
  }
  if (i.reviewReady > 0) {
    return { tone: 'review', title: i.reviewReady === 1 ? 'Suggested changes are ready to look over' : `${i.reviewReady} sets of suggested changes are ready to look over`,
      text: `They were made in a ${GLOSSARY.safeCopy.name}. Look them over, then add them to your project if you like them.`, action: { kind: 'review', label: 'Look over the suggested changes' } };
  }
  if (p.kind === 'off') return { tone: 'problem', title: 'The AI helper is not available', text: p.lead, action: null };
  if (p.kind === 'setup') {
    return { tone: 'setup', title: p.chooseRuntime ? 'Choose the AI service first' : 'The AI helper is not ready yet', text: p.blockers[0] ?? p.lead,
      action: { kind: 'setup', label: p.chooseRuntime ? CHOOSE_RUNTIME_BUTTON : GLOSSARY.getReady.name } };
  }
  if (p.ending && p.ending.tone === 'failed') {
    return { tone: 'problem', title: p.ending.title, text: `${p.ending.text}${p.ending.next ? ` Next: ${lower(p.ending.next)}` : ''}`, action: null };
  }
  return { tone: 'ready', title: 'Your project is ready', text: 'Ask the AI helper for what you want in the box below.', action: null };
}
