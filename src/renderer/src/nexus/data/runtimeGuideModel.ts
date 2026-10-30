// Pure: the first-run guide "Choose your AI helper" (step 2 of "Your first build"), from what main last read (#51's runtimes) and the picker's rows.
// No React, so tests load it directly. It is shown while NO runtime permission is granted, in the execution setup sheet; the agent
// panel points to it with one sentence and one button.
//
// Rules this file keeps:
// - free first: free online AI, then a model on this computer, then a plan the person already pays for. Nexus works for anyone
//   without any paid plan, so the paid path is the last way and says it is optional;
// - no vendor, provider or address is named in this code: the provider labels come from the probe's providers list, the program's
//   own label from the probe's label; the words about how to get a key never name a website;
// - every state is one plain sentence (never a reason code); a way ends in an action only when there is one to take: "Add my key"
//   (opens Settings at the access keys) while a key is needed, the existing use/pick action once the AI service is ready;
// - words: AI helper, AI service, access key, Free online AI / AI on this computer / Your own plan (the glossary's names).
import type { AgentConsentView, AgentRuntimeOptionView } from '@shared/nexus/ipc';
import { LOCAL_MODEL_KIND } from '@shared/nexus/localModel';
import { HOSTED_MODEL_KIND } from '@shared/nexus/hostedModel';
import { AGENT_REASON_TEXT } from './errorCopy';
import { KEYS_PATH, LOCAL_PROBLEM_TEXT, type RuntimeChoice } from './executionModel';
import { termName } from './glossary';

export const GUIDE_TITLE = 'Choose your AI helper';
export const GUIDE_LEAD = 'Nexus needs an AI service to do the work. Pick one way below. The first two are free, and you do not need a paid plan.';
export const GUIDE_READING = 'Nexus is looking at what is available on this computer.';
export const GUIDE_NONE_YET = 'Nothing is chosen yet, so your AI helper will not work until you choose.';

export type GuideWayId = 'hosted' | 'local' | 'program';
export type GuideWayState = 'ready' | 'needs_key' | 'key_rejected' | 'server_down' | 'no_model' | 'model_problem' | 'not_installed' | 'not_signed_in'
  | 'unsupported' | 'unchecked';

/** What a way's button does: add a key (opens Settings), or use the runtime (the picker's grant action; `choice` null means the default runtime). */
export interface GuideAction { op: 'add-key' | 'use'; label: string; disabled: boolean }

export interface GuideWay {
  id: GuideWayId;
  /** The runtime kind this way stands for (null while the probe has not reported it). */
  kind: string | null;
  title: string;
  free: boolean;
  /** What this way is, in plain words. */
  lead: string;
  /** What it costs, in one plain line. */
  cost: string;
  /** "Is this safe?": where the key and the requests go (a closed fold); null when there is nothing to add. */
  safety: string | null;
  state: GuideWayState;
  /** The status word (never colour alone). */
  word: string;
  /** One sentence about this computer, from the probe. */
  status: string;
  /** What to do, in order, when it is not ready (empty when ready). */
  steps: string[];
  /** The providers the probe lists (the hosted way only): labels, in the probe's order. */
  providers: string[];
  /** The picker's row for this runtime (its provider and model controls), when the picker lists it. */
  choice: RuntimeChoice | null;
  /** The button the way ends in, or null when there is nothing to press yet. */
  action: GuideAction | null;
  /** True when the picker's provider and model lists belong on this way (a key is saved / the server lists models). */
  controls: boolean;
  /** A second, quieter button (the hosted way once a key is saved: add or change one). */
  secondary: GuideAction | null;
}

export interface RuntimeGuide { title: string; lead: string; note: string; ways: GuideWay[] }

const ADD_KEY = 'Add my key';

/**
 * True while the guide is the thing to show: a permission is not live. With one granted the sheet shows the picker as before. When agent
 * work is not in place at all (state `off`) there is nothing to choose, so no guide.
 */
export function guideShown(view: Pick<AgentConsentView, 'consent'> & Partial<Pick<AgentConsentView, 'state'>> | null | undefined): boolean {
  return !view || (view.consent.live !== true && view.state !== 'off');
}

const HOSTED_STEPS = [
  'Open the website of an AI service that gives free access keys, and sign up for free.',
  'Create an access key there and copy it.',
  `Press “Add my key”. Settings opens at ${KEYS_PATH}. Paste the key there and press Save.`,
  'Come back here, pick the AI service and a model, then press “Use this AI service”.'
];
/** The program's own name is the probe's label, e.g. "Local model (Name)": Nexus code never spells a vendor, so the name inside the
 *  brackets (else the whole label) is what the steps call the program. No label read yet: the generic words. */
function programName(label: string | null | undefined): string | null {
  const text = typeof label === 'string' ? label.trim() : '';
  if (text === '') return null;
  return /\(([^()]+)\)\s*$/.exec(text)?.[1]?.trim() || text;
}
function localSteps(label: string | null | undefined): string[] {
  const name = programName(label);
  return [
    name ? `Install ${name}, a free program that runs AI models on this computer.` : 'Install a free program that runs AI models on this computer.',
    name ? `Start ${name}.` : 'Start it.',
    'Download a model that can use tools. Look for the word “tools” in the model’s description.',
    'Press Check again.'
  ];
}
const LOCAL_MODEL_STEPS = [
  'Download a model that can use tools into the program that runs AI models.',
  'Press Check again.'
];

const NO_MODEL_TEXT = 'The program that runs AI on this computer is working, but it has no model yet.';
const PICK_MODEL_TEXT = 'The program that runs AI on this computer is working. Pick a model from the list below.';
const HOSTED_READY_TEXT = 'Your access key is saved. Pick an AI service and a model below, then press the button.';
const HOSTED_NEEDS_KEY_TEXT = 'You have not added an access key yet.';
const HOSTED_SAFETY = 'Your access key stays locked on this computer and goes only to the AI service it belongs to. Your AI helper’s requests are sent over the internet to that service.';

function hostedWay(opt: AgentRuntimeOptionView | undefined, choice: RuntimeChoice | null): GuideWay {
  const base = { id: 'hosted' as const, title: `${termName('freeOnlineAi')} (needs a free access key)`, free: true,
    lead: 'A free AI service on the internet. You create an access key for it yourself, which takes a few minutes.',
    cost: 'Free. The service may limit how much you can use.', safety: HOSTED_SAFETY,
    choice, secondary: null as GuideAction | null, controls: false };
  const providers = opt && Array.isArray(opt.providers) ? opt.providers : [];
  const labels = providers.map((p) => p.label);
  if (!opt || providers.length === 0) {
    return { ...base, kind: opt?.kind ?? null, state: 'unchecked', word: 'Not checked', providers: labels, steps: [],
      status: 'Nexus has not read the list of free AI services yet. Press Check again in a moment.', action: null };
  }
  if (opt.state !== 'ready') {
    return { ...base, kind: opt.kind, state: 'unchecked', word: 'Not checked', providers: labels, steps: [],
      status: choice ? choice.text : AGENT_REASON_TEXT.runtime_error, action: null };
  }
  const anyKey = providers.some((p) => p.keyPresent === true);
  if (opt.problem === 'key_rejected') {
    return { ...base, kind: opt.kind, state: 'key_rejected', word: 'Key refused', providers: labels, status: AGENT_REASON_TEXT.hosted_key_rejected, steps: [],
      action: { op: 'add-key', label: 'Enter my key again', disabled: false } };
  }
  if (!anyKey) {
    return { ...base, kind: opt.kind, state: 'needs_key', word: 'Needs an access key', providers: labels, status: HOSTED_NEEDS_KEY_TEXT, steps: HOSTED_STEPS,
      action: { op: 'add-key', label: ADD_KEY, disabled: false } };
  }
  const usable = choice !== null && choice.action !== null && choice.action.disabled !== true;
  if (usable) {
    return { ...base, kind: opt.kind, state: 'ready', word: 'Ready', providers: labels, status: HOSTED_READY_TEXT, steps: [],
      controls: true, action: { op: 'use', label: choice!.action!.label, disabled: false }, secondary: { op: 'add-key', label: 'Add or change my key', disabled: false } };
  }
  // A key is saved, but not for the provider that is picked (or no model is picked): say which providers have one; the provider list is in the option.
  const keyed = providers.filter((p) => p.keyPresent === true).map((p) => p.label);
  return { ...base, kind: opt.kind, state: 'needs_key', word: 'Needs an access key', providers: labels, steps: [], controls: true,
    status: `Your access key is saved for ${keyed.join(' and ')}. Pick ${keyed.length === 1 ? 'that service' : 'one of them'} below, or add a key for the one you want.`,
    action: { op: 'add-key', label: ADD_KEY, disabled: false } };
}

function localWay(opt: AgentRuntimeOptionView | undefined, choice: RuntimeChoice | null): GuideWay {
  const base = { id: 'local' as const, title: `${termName('aiOnThisComputer')} (free, private)`, free: true,
    lead: 'Runs an AI on your own computer, so nothing leaves it. It needs a free program that runs AI models, and at least one model that can use tools. '
      + 'Bigger models build better but need a faster computer.',
    cost: 'Free. It can be slow on an older computer.', safety: null as string | null,
    providers: [] as string[], choice, secondary: null as GuideAction | null, controls: false };
  if (!opt) {
    return { ...base, kind: null, state: 'unchecked', word: 'Not checked', steps: [], action: null,
      status: 'Nexus has not found out whether a program that runs AI is available here. Press Check again in a moment.' };
  }
  if (opt.state === 'not_installed') {
    return { ...base, kind: opt.kind, state: 'server_down', word: 'Not running', status: AGENT_REASON_TEXT.local_model_server_down, steps: localSteps(opt.label), action: null };
  }
  if (opt.state === 'version_unsupported') {
    return { ...base, kind: opt.kind, state: 'model_problem', word: 'Needs a model', status: LOCAL_PROBLEM_TEXT.model_no_tools, steps: LOCAL_MODEL_STEPS, action: null };
  }
  if (opt.state !== 'ready') {
    return { ...base, kind: opt.kind, state: 'unchecked', word: 'Not checked', steps: [], action: null, status: choice ? choice.text : AGENT_REASON_TEXT.runtime_error };
  }
  if (Array.isArray(opt.models) && opt.models.length === 0) {
    return { ...base, kind: opt.kind, state: 'no_model', word: 'Needs a model', status: NO_MODEL_TEXT, steps: LOCAL_MODEL_STEPS, action: null };
  }
  if (choice !== null && choice.action !== null && choice.action.disabled !== true) {
    return { ...base, kind: opt.kind, state: 'ready', word: 'Ready', status: 'The program that runs AI on this computer is working, and the chosen model can use tools.', steps: [], controls: true,
      action: { op: 'use', label: choice.action.label, disabled: false } };
  }
  if (opt.problem === 'model_not_chosen' || (opt.problem === null && choice !== null && choice.model === null)) {
    return { ...base, kind: opt.kind, state: 'model_problem', word: 'Pick a model', status: PICK_MODEL_TEXT, steps: [], controls: true, action: null };
  }
  return { ...base, kind: opt.kind, state: 'model_problem', word: 'Needs a model', status: opt.problem ? LOCAL_PROBLEM_TEXT[opt.problem] : AGENT_REASON_TEXT.runtime_unknown,
    steps: LOCAL_MODEL_STEPS, action: null };
}

function programWay(opt: AgentRuntimeOptionView | undefined, choice: RuntimeChoice | null): GuideWay {
  const base = { id: 'program' as const, title: `${termName('yourOwnPlan')} (optional)`, free: false,
    lead: 'If you already pay for an AI assistant and are signed in to it on this computer, Nexus can use it. '
      + 'Nexus never installs it and never signs in for you. Skip this if you do not have one: the two free ways above work without it.',
    cost: 'Uses the plan you already pay for.', safety: null as string | null,
    providers: [] as string[], choice, secondary: null as GuideAction | null, controls: false };
  if (!opt) {
    return { ...base, kind: null, state: 'unchecked', word: 'Not checked', steps: [], action: null,
      status: 'Nexus has not checked for your AI assistant yet. Press Check again in a moment.' };
  }
  const label = typeof opt.label === 'string' && opt.label !== '' ? opt.label : 'Your AI assistant';
  switch (opt.state) {
    case 'ready':
      if (opt.signedIn === 'yes') {
        return { ...base, kind: opt.kind, state: 'ready', word: 'Ready', status: `${label} is installed and signed in.`, steps: [],
          action: { op: 'use', label: choice && choice.action ? choice.action.label : 'Use this AI service', disabled: choice !== null && choice.action !== null && choice.action.disabled === true } };
      }
      return { ...base, kind: opt.kind, state: 'not_signed_in', word: 'Not confirmed', steps: ['Sign in with it yourself, then press Check again.'], action: null,
        status: `${label} is installed, but Nexus could not confirm that it is signed in.` };
    case 'not_installed':
      return { ...base, kind: opt.kind, state: 'not_installed', word: 'Not installed', status: `${label} is not installed on this computer.`, steps: [], action: null };
    case 'not_signed_in':
      return { ...base, kind: opt.kind, state: 'not_signed_in', word: 'Not signed in', status: `${label} is installed but not signed in.`,
        steps: ['Sign in with it yourself, then press Check again.'], action: null };
    case 'version_unsupported':
      return { ...base, kind: opt.kind, state: 'unsupported', word: 'Not supported', status: `The installed ${label} is not a version Nexus supports.`, steps: [], action: null };
    default:
      return { ...base, kind: opt.kind, state: 'unchecked', word: 'Not checked', status: `Nexus could not check ${label} just now. Press Check again.`, steps: [], action: null };
  }
}

/**
 * The guide, or null when a permission is live (the picker is shown instead). `choices` are the picker's rows (`runtimeChoices`): the
 * way's provider/model controls and the grant action come from them. The ways are always the same three, free first; a runtime the
 * probe has not reported gives a way that says it is not checked yet.
 */
export function runtimeGuide(view: Pick<AgentConsentView, 'consent' | 'runtimes'> & Partial<Pick<AgentConsentView, 'state'>> | null | undefined, choices: readonly RuntimeChoice[] = []): RuntimeGuide | null {
  if (!guideShown(view)) return null;
  const list = view && Array.isArray(view.runtimes) ? view.runtimes : [];
  const opt = (pred: (o: AgentRuntimeOptionView) => boolean): AgentRuntimeOptionView | undefined => list.find(pred);
  const choiceOf = (o: AgentRuntimeOptionView | undefined): RuntimeChoice | null => (o ? choices.find((c) => c.kind === o.kind) ?? null : null);
  const hosted = opt((o) => o.kind === HOSTED_MODEL_KIND);
  const local = opt((o) => o.kind === LOCAL_MODEL_KIND);
  const program = opt((o) => o.kind !== HOSTED_MODEL_KIND && o.kind !== LOCAL_MODEL_KIND);
  return {
    title: GUIDE_TITLE,
    lead: GUIDE_LEAD,
    note: view ? GUIDE_NONE_YET : GUIDE_READING,
    ways: [hostedWay(hosted, choiceOf(hosted)), localWay(local, choiceOf(local)), programWay(program, choiceOf(program))]
  };
}
