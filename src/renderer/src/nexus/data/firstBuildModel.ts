// Pure: "Your first build", the three steps a new person does before the AI helper can build for them, from what the setup sheet already knows
// (the availability, the sheet's rows, whether a permission is live, whether Nexus waits for an answer). No React, so tests load it directly.
//
// Rules this file keeps:
// - three steps, in order: 1 Get this computer ready, 2 Choose your AI helper, 3 Save a starting point. Each says Done, Next or Waiting
//   with one plain line, and the FIRST step that is not done is the only one that asks the person to do something;
// - nothing is claimed that is not known: Git is "no problem found" (Nexus is only told when Git is missing), and step 3 is never "done"
//   here (a starting point belongs to one project, so the sheet cannot know);
// - no number, id or engineering word: the exact numbers stay in the sheet's rows behind "More details".
import type { SetupRow } from './executionModel';
import { PREPARE_ALL_LABEL, type ExecAvailability } from './executionModel';
import { GUIDE_TITLE } from './runtimeGuideModel';
import { termName } from './glossary';

export type StepState = 'done' | 'next' | 'waiting';
export type StepId = 'computer' | 'helper' | 'starting-point';
export type ItemState = 'ok' | 'problem' | 'unknown' | 'advisory';
export type ItemId = 'git' | 'docker' | 'space' | 'kits' | 'runner';

export interface ChecklistItem {
  id: ItemId;
  label: string;
  state: ItemState;
  /** The status word (never colour alone). */
  word: string;
  /** What this thing is, in one plain line. */
  what: string;
  /** Where it stands and what to click or do. */
  line: string;
}

export interface ChecklistStep {
  id: StepId;
  number: 1 | 2 | 3;
  title: string;
  state: StepState;
  word: 'Done' | 'Next' | 'Waiting';
  line: string;
  /** More words for the step (step 3 explains the starting point and the hidden Nexus notes), or null. */
  help: string | null;
  /** Step 1 only: what is checked on this computer. */
  items: ChecklistItem[];
  /** The one button of the step, only on the first step that is not done; null when there is none. */
  action: { op: 'prepare-kits'; label: string } | null;
}

export interface FirstBuild { title: string; lead: string; steps: ChecklistStep[]; current: StepId | null }

export interface FirstBuildInput {
  availability: ExecAvailability;
  /** The sheet's computer rows (docker, memory, cpus, disk, image:*, git, runner); agent rows are ignored. */
  rows: readonly SetupRow[];
  /** True while a permission is live (an AI service is in use). */
  helperReady: boolean;
  /** The label of the AI service in use, from the probe (shown on the sheet only), or null. */
  helperLabel?: string | null;
  /** When AI helper work is not in place at all: the one sentence that says so. */
  helperOff?: string | null;
  /** True while Nexus waits for an answer about keeping hidden Nexus notes in a project. */
  startingPointWaiting?: boolean;
}

export const FIRST_BUILD_TITLE = 'Your first build';
export const STEP_TITLES: Readonly<Record<StepId, string>> = Object.freeze({
  computer: termName('getReady'), helper: GUIDE_TITLE, 'starting-point': 'Save a starting point'
});
const WORD: Record<StepState, ChecklistStep['word']> = { done: 'Done', next: 'Next', waiting: 'Waiting' };

export const STARTING_POINT_LINE = `Nexus saves how your project looks right now, as a ${termName('startingPoint')}, so it can compare later.`;
export const STARTING_POINT_HELP = `To do this it keeps ${termName('hiddenNotes')} in your project: a small hidden area. Your files and your main version are never changed. `
  + 'You do this once for each project. Your AI helper tells you when a project needs it.';

const ITEM_WORD: Record<ItemState, string> = { ok: 'Ready', problem: 'Needs attention', unknown: 'Not checked', advisory: 'Works, but could be better' };
const item = (id: ItemId, label: string, state: ItemState, what: string, line: string, word?: string): ChecklistItem =>
  ({ id, label, state, word: word ?? ITEM_WORD[state], what, line });
const say = (r: SetupRow): string => (r.action ? `${r.text} ${r.action}` : r.text);

/** The things checked on this computer, in plain words (the exact numbers stay in the rows). */
export function computerItems(rows: readonly SetupRow[]): ChecklistItem[] {
  const get = (id: string): SetupRow | undefined => rows.find((r) => r.id === id);
  const items: ChecklistItem[] = [];
  const git = get('git');
  items.push(git
    ? item('git', 'Git', 'problem', 'A free program that keeps the history of your project.', say(git))
    : item('git', 'Git', 'ok', 'A free program that keeps the history of your project.', 'Nexus has not found a problem with Git.', 'No problem found'));
  const docker = get('docker');
  if (docker) {
    const bad = [docker, get('memory'), get('cpus')].find((r) => r && r.state !== 'ok');
    items.push(bad
      ? item('docker', termName('docker'), bad.state === 'unknown' ? 'unknown' : 'problem', 'A free program that makes safe spaces, where code can run without touching anything else.', say(bad))
      : item('docker', termName('docker'), 'ok', 'A free program that makes safe spaces, where code can run without touching anything else.', 'Docker is running and has enough memory.'));
  }
  const disk = get('disk');
  if (disk) {
    items.push(disk.state === 'ok'
      ? item('space', 'Space on your disk', 'ok', 'Nexus needs room for the safe-space kits and for its own work.', 'You have enough free space.')
      : item('space', 'Space on your disk', disk.state === 'unknown' ? 'unknown' : disk.state === 'advisory' ? 'advisory' : 'problem',
        'Nexus needs room for the safe-space kits and for its own work.', say(disk), disk.state === 'advisory' ? disk.word : undefined));
  }
  const kits = rows.filter((r) => r.id.startsWith('image:'));
  const what = 'Downloads that make a safe space for your project. You only need them once.';
  if (kits.length > 0) {
    const bad = kits.filter((r) => r.state !== 'ok');
    if (bad.length === 0) items.push(item('kits', 'Safe-space kits', 'ok', what, kits.length === 1 ? 'The safe-space kit is ready.' : `All ${kits.length} safe-space kits are ready.`));
    else {
      const ask = bad.some((r) => r.prepare !== null);
      const waiting = bad.every((r) => r.action === 'Waiting for your answer below.');
      const head = `${bad.length} of ${kits.length} ${kits.length === 1 ? 'kit is' : 'kits are'} not ready.`;
      items.push(item('kits', 'Safe-space kits', 'problem', what, ask ? `${head} Press “${PREPARE_ALL_LABEL}”. Nexus asks you before each download.`
        : waiting ? `${head} Waiting for your answer below.` : `${head} ${bad[0].action ?? ''}`.trim()));
    }
  } else if (docker) {
    items.push(item('kits', 'Safe-space kits', 'unknown', what, 'Nexus has not listed the kits yet. Press Check again in a moment.'));
  }
  const runner = get('runner');
  if (runner && runner.state !== 'ok') items.push(item('runner', 'The part of Nexus that runs tasks', 'problem', 'It starts with the app.', say(runner)));
  return items;
}

/** The three steps. The first one that is not done is the only one with something to press. */
export function firstBuild(input: FirstBuildInput): FirstBuild {
  const a = input.availability;
  const items = a.kind === 'setup' || a.kind === 'ready' ? computerItems(input.rows) : [];
  const done1 = a.kind === 'ready';
  const done2 = input.helperReady && !input.helperOff;
  let line1: string;
  if (done1) line1 = `This computer is ready.${a.kind === 'ready' && a.advisories.length > 0 ? ` ${a.advisories[0]}` : ''}`;
  else if (a.kind === 'setup') {
    const n = items.filter((i) => i.state === 'problem' || i.state === 'unknown').length;
    line1 = n === 0 ? 'Nexus is still checking this computer. Press Check again in a moment.' : `${n === 1 ? '1 thing needs' : `${n} things need`} your attention.`;
  } else if (a.kind === 'unknown') line1 = a.text ?? 'Nexus is looking at this computer.';
  else line1 = 'text' in a ? a.text : 'Nexus cannot check this computer right now.';
  const hasKits = input.rows.some((r) => r.prepare !== null);
  const states: StepState[] = [];
  states[0] = done1 ? 'done' : 'next';
  states[1] = done2 ? 'done' : states[0] === 'next' ? 'waiting' : input.helperOff ? 'waiting' : 'next';
  states[2] = states[0] === 'done' && states[1] === 'done' ? 'next' : 'waiting';
  const firstOpen = states.findIndex((s) => s === 'next');
  const waitingFor = (n: number): string => `Finish step ${n} first.`;
  const line2 = done2 ? (input.helperLabel ? `Your AI helper uses ${input.helperLabel}.` : 'Your AI helper is set up.')
    : input.helperOff ? input.helperOff
      : states[1] === 'waiting' ? `${waitingFor(1)} You can read your choices now.` : 'Choose one of the three ways below. The first two are free.';
  const line3 = states[2] === 'waiting' ? waitingFor(states[0] !== 'done' ? 1 : 2)
    : input.startingPointWaiting ? `Nexus is waiting for your answer about keeping ${termName('hiddenNotes')} in your project.` : STARTING_POINT_LINE;
  const mk = (id: StepId, number: 1 | 2 | 3, state: StepState, line: string, extra: Partial<ChecklistStep> = {}): ChecklistStep => ({
    id, number, title: STEP_TITLES[id], state, word: WORD[state], line, help: null, items: [], action: null, ...extra });
  const steps: ChecklistStep[] = [
    mk('computer', 1, states[0], line1, { items, action: states[0] === 'next' && hasKits ? { op: 'prepare-kits', label: PREPARE_ALL_LABEL } : null }),
    mk('helper', 2, states[1], line2),
    mk('starting-point', 3, states[2], line3, { help: states[2] === 'next' ? STARTING_POINT_HELP : null })
  ];
  const current = firstOpen < 0 ? null : steps[firstOpen].id;
  const lead = states[0] === 'done' && states[1] === 'done'
    ? 'Your computer and your AI helper are ready. Open a project and ask for something to build.'
    : `Nexus needs three things before your AI helper can build for you. Do step ${firstOpen < 0 ? 1 : firstOpen + 1} now. The steps after it wait.`;
  return { title: FIRST_BUILD_TITLE, lead, steps, current };
}
