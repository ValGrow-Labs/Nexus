// The one card at the top of the project page: what is happening, and the one thing to do next, in plain words.
import type { AgentPanelView } from '../agent/agentModel';
import { CHOOSE_RUNTIME_BUTTON } from '../agent/agentModel';
import { GLOSSARY } from '../data/glossary';

export type NextStepAction = { kind: 'setup' | 'review' | 'recheck'; label: string };
export interface NextStep {
  tone: 'ready' | 'working' | 'waiting' | 'review' | 'setup' | 'problem';
  title: string;
  text: string;
  /** The one button, or null when there is nothing for the person to press. */
  action: NextStepAction | null;
  /** A quiet second button (the way to the setup sheet next to "Check again"), or null. */
  secondary?: NextStepAction | null;
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
    const first = p.blockers[0] ?? p.lead;
    // The state is said once, short, with one sentence of what to do; the blocker's own long sentence is not repeated anywhere.
    if (/Docker is not running/i.test(first)) {
      return { tone: 'setup', title: 'Not ready: Docker is not running', text: 'Open Docker Desktop and wait until it says it is running, then press “Check again”.',
        action: { kind: 'recheck', label: 'Check again' }, secondary: { kind: 'setup', label: GLOSSARY.getReady.name } };
    }
    if (p.chooseRuntime) return { tone: 'setup', title: 'Choose the AI service first', text: first, action: { kind: 'setup', label: CHOOSE_RUNTIME_BUTTON } };
    return { tone: 'setup', title: 'Not ready yet', text: first, action: { kind: 'recheck', label: 'Check again' }, secondary: { kind: 'setup', label: GLOSSARY.getReady.name } };
  }
  if (p.ending && p.ending.tone === 'failed') {
    return { tone: 'problem', title: p.ending.title, text: `${p.ending.text}${p.ending.next ? ` Next: ${lower(p.ending.next)}` : ''}`, action: null };
  }
  return { tone: 'ready', title: 'Your project is ready', text: 'Ask the AI helper for what you want in the box below.', action: null };
}

export type TailButton = { kind: 'setup' | 'review' | 'recheck' | 'stop' | 'snapshot'; label: string };
/** The one inline message at the end of the dock's chat (a blocker, a question, suggested changes, a problem), with its one button; null when there is none. */
export interface DockTail { text: string; button: TailButton | null }
export function dockTail(i: { panel: AgentPanelView; reviewReady: number; repoApprovalWaiting: boolean; canStop: boolean; liveLine: string | null }): DockTail | null {
  const p = i.panel;
  if (i.repoApprovalWaiting) return { text: 'I need your OK to go on.', button: null };
  if (p.waiting) return { text: 'I need you to get things ready first.', button: { kind: 'setup', label: GLOSSARY.getReady.name } };
  if (p.progress) return { text: i.liveLine ?? 'Working on it…', button: i.canStop ? { kind: 'stop', label: 'Stop' } : null };
  if (i.reviewReady > 0) return { text: 'Suggested changes are ready.', button: { kind: 'review', label: 'Look them over' } };
  if (p.kind === 'off') return { text: 'The AI helper is not available here.', button: null };
  if (p.kind === 'setup') {
    const first = p.blockers[0] ?? p.lead;
    if (/Docker is not running/i.test(first)) return { text: 'Docker is not running. Open Docker Desktop, then press “Check again”.', button: { kind: 'recheck', label: 'Check again' } };
    if (p.chooseRuntime) return { text: 'Choose an AI service first.', button: { kind: 'setup', label: CHOOSE_RUNTIME_BUTTON } };
    return { text: 'Not ready yet.', button: { kind: 'recheck', label: 'Check again' } };
  }
  if (p.ending && p.ending.tone === 'failed') return { text: `${p.ending.text}`, button: p.ending.snapshot ? { kind: 'snapshot', label: 'Save a starting point' } : null };
  return null;
}
