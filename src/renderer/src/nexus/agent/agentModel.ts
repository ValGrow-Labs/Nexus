// Pure: the AI helper panel, the conversation log and the intent line's route, from what main says (#23's `agent` row, #43 sessions,
// #44 session detail, #26 jobs). No React, so tests load it directly. Rules this file keeps:
// - every refusal is one plain sentence from errorCopy (never a reason code, a git message or a sha);
// - no host, model or engine name: the setup sheet's own row is the only place that carries the adapter's label and the hosts;
// - usage and cost are labelled "reported by the AI service", or "estimated" when Nexus charged the cap; never a percentage;
// - what the AI helper writes is for reading only, never proof; a request with no change reads "The AI helper made no changes";
// - words for people: AI helper, conversation, request, step, safe copy (the glossary); never turn, session, runtime or tool call.
import type {
  AgentSetupView, AgentStartArgs, AgentUsageView, HealthView, JobView, SessionDetailView, SessionView
} from '@shared/nexus/ipc';
import { AGENT_REASON_TEXT, ROLLBACK_OWED_TEXT, agentOffText, agentsNotice, errorCopy } from '../data/errorCopy';
import { LOCAL_MODEL_KIND } from '@shared/nexus/localModel';
import { HOSTED_MODEL_KIND } from '@shared/nexus/hostedModel';
import { LOCAL_PROBLEM_TEXT, noticeFor, type ExecAvailability } from '../data/executionModel';
import { agentTurnHeadline, agentTurnNext, waitPhaseText, WAIT_PHASE_NEXT } from '../runs/jobRunModel';
import { kindLabel, statusLabel } from '../project/artifactModel';
import { GUIDE_TITLE } from '../data/runtimeGuideModel';
import { GLOSSARY } from '../data/glossary';
import { BUTTON_LABEL } from '../project/changeSetModel';

/** The one sentence for missing permission (F24): no host is named outside the setup sheet's consent row. */
export const CONSENT_MISSING_TEXT = AGENT_REASON_TEXT.consent_missing;
/** Said in the panel while no AI service is chosen: one sentence and one button that opens the first-run guide (no engine, provider or program is named). */
export const CHOOSE_RUNTIME_TEXT = 'Nexus needs an AI service to do the work. Choose a free online one, one on your computer, or your own plan.';
export const CHOOSE_RUNTIME_BUTTON = GUIDE_TITLE;
export const USAGE_LABEL = 'reported by the AI service';
export const USAGE_ESTIMATED_LABEL = 'estimated by Nexus: the AI service did not report one';
export const DISPLAY_ONLY_NOTE = 'What the AI helper wrote is shown for reading only. It is not proof: only the checks and Nexus’s own records are.';
export const ISOLATION_NOTE = `The AI helper works in a ${GLOSSARY.safeCopy.name}. Your real files change only when you press “${GLOSSARY.addToProject.name}”.`;
export const MAX_MESSAGE_CHARS = 8000;
/** Said under the panel when the cached check of the program for your own plan is older than main keeps it: the send itself checks again. */
export const SIGNIN_UNCONFIRMED_TEXT = 'Nexus could not confirm that the program for your own plan is signed in.';
export const RECHECK_ON_SEND_TEXT = 'Nexus will check the AI helper again when you send.';
/** The one line under the AI helper's work while it runs: the person is never kept waiting at this screen. */
export const KEEP_USING_TEXT = 'You can keep using Nexus.';
/** What happens when the AI helper stops, for any reason. */
export const WHEN_IT_STOPS_TEXT = 'When it stops, you will see here what it did and what to do next.';

/** A short stable key for a message (FNV-1a): the pending-intent key never stores the message text itself. */
export function messageKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${text.length}.${h.toString(36)}`;
}

/** Whole US dollars and cents from a cent count ("$0.42"). Not a number the records do not hold: callers pass stored cents. */
export function money(cents: number): string {
  const c = Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0;
  return `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One request's usage as a sentence (its steps and its cost); every cost carries its label. Null when the request recorded none. */
export function usageLine(u: AgentUsageView | null): string | null {
  if (!u) return null;
  const steps = count(u.toolCalls, 'step', 'steps');
  if (u.estimated) {
    return `${steps}; cost about ${money(u.costUsdCents ?? 0)} (${USAGE_ESTIMATED_LABEL})`;
  }
  const cost = u.costUsdCents === null ? 'no cost reported' : `cost ${money(u.costUsdCents)}`;
  return `${steps}, ${cost} (${USAGE_LABEL})`;
}

/** Today's usage on the setup row and the panel. */
export function usageTodayLine(u: AgentSetupView['usageToday'], service?: string | null): string {
  const who = service ? `AI service: ${service}. ` : '';
  const zero = service && u.turns > 0 && u.usdCents === 0 ? ' $0.00 means the AI service did not report a cost.' : '';
  if (u.turns === 0 && u.usdCents === 0) return 'No request to the AI helper has started today.';
  return `${who}Today: ${count(u.turns, 'request', 'requests')} started, cost ${u.estimated ? `about ${money(u.usdCents)} (${USAGE_ESTIMATED_LABEL})` : `${money(u.usdCents)} (${USAGE_LABEL})`}.${zero}`;
}

// ---------- the time a request has been running ----------

/** "just started", "40 seconds", "3 minutes", "1 hour 5 minutes": for a line a person reads once in a while, not a clock. */
export function elapsedText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'a moment';
  const s = Math.floor(ms / 1000);
  if (s < 10) return 'a few seconds';
  if (s < 60) return `${Math.floor(s / 10) * 10} seconds`;
  const m = Math.floor(s / 60);
  if (m < 60) return count(m, 'minute', 'minutes');
  const h = Math.floor(m / 60); const r = m % 60;
  return r === 0 ? count(h, 'hour', 'hours') : `${count(h, 'hour', 'hours')} ${count(r, 'minute', 'minutes')}`;
}

// ---------- what the AI helper said and what it is doing ----------

/** The AI helper's last reply in a conversation, as plain text (whitespace folded, at most 600 characters), or null when it said nothing. */
export function replyOf(d: Pick<SessionDetailView, 'messages'> | null | undefined): string | null {
  const m = d ? [...d.messages].reverse().find((x) => x.from === 'agent' && x.text.trim() !== '') : undefined;
  if (!m) return null;
  const t = m.text.split(/[\t\n\r ]+/).join(' ').trim();
  return t.length > 600 ? `${t.slice(0, 599)}…` : t;
}
/** The first words of a reply for the one-line idle summary. */
export const shortReply = (r: string | null, n = 80): string | null => (r === null ? null : r.length > n ? `${r.slice(0, n - 1).trimEnd()}…` : r);

/** What the AI helper is doing now, in plain words, from its latest step (and the start of its latest message when it has one). */
export function liveStepLine(d: Pick<SessionDetailView, 'toolCalls' | 'messages'> | null | undefined): string | null {
  if (!d) return null;
  const c = d.toolCalls.length > 0 ? d.toolCalls[d.toolCalls.length - 1] : null;
  const step = c ? toolLabel(c.tool) : null;
  const said = shortReply(replyOf(d), 100);
  if (!step && !said) return null;
  return [step ? `${step}.` : null, said ? `It said: “${said}”` : null].filter(Boolean).join(' ');
}

// ---------- the panel ----------

const SESSION_WORD: Record<SessionView['status'], string> = {
  open: 'Ready for your next message', running: 'Working', awaiting_approval: 'Waiting for you', completed: 'Ended', failed: 'Stopped: it could not go on',
  cancelled: 'Stopped', timed_out: 'Ran out of time', interrupted: 'Stopped early'
};

const SESSION_WHY: Partial<Record<SessionView['status'], string>> = {
  interrupted: 'Stopped early: Nexus was closed or restarted while the AI helper was working.', failed: 'It could not go on after a problem.',
  timed_out: 'It ran past its time limit.', cancelled: 'You or Nexus stopped it.'
};

export interface SessionRowView {
  id: string;
  word: string;
  /** What the live request is doing or waiting for, from its job ("Waiting for your internet permission"); null when none is live. */
  turn: string | null;
  /** How many requests the conversation has had ("2 requests"). */
  turns: string;
  /** One plain line for a conversation that ended early or badly (why); null otherwise. */
  why: string | null;
  live: boolean;
  canSend: boolean;
  canStop: boolean;
  canEnd: boolean;
}

/** Said in the panel while a request waits for the OK to keep Nexus's notes in the project (the OK itself is answered right there). */
export const REPO_APPROVAL_WAIT_TEXT = `The AI helper is waiting for your OK. Nexus wants to keep ${GLOSSARY.hiddenNotes.name} in a small hidden area of your project. Your files and your ${GLOSSARY.mainVersion.name} are never changed.`;

/** The newest request when it failed: its sentence, and whether saving a starting point is the way forward. */
export interface PanelFailure { text: string; snapshot: boolean }

/** How the newest request ended, in one place: a short title, what happened in plain words, and one next step. */
export interface PanelEnding {
  tone: 'handed_in' | 'no_change' | 'failed' | 'stopped';
  title: string;
  text: string;
  /** One next step; null when the sentence above already says what to do. */
  next: string | null;
  /** What the AI helper said back (plain text, bounded) when the request ended with an answer and no changes; null otherwise. */
  reply?: string | null;
  /** True when "Save a starting point" is the way forward (a button next to the sentence). */
  snapshot: boolean;
}

/** While the AI helper works: what it is doing now, how long, that you can leave, and what happens next. */
export interface PanelProgress {
  now: string;
  /** "Working for 2 minutes" or "Waiting for 30 seconds"; null when the time is not known. */
  running: string | null;
  keepUsing: string;
  next: string;
  /** The same four parts as one short paragraph. */
  line: string;
}

/** When the AI helper cannot go on without you. */
export interface PanelWaiting { title: string; text: string; next: string }

export interface AgentPanelView {
  /** off: AI helper work is not available at all; setup: something must be done first; ready: a message can be sent. */
  kind: 'off' | 'setup' | 'ready';
  lead: string;
  /** Sentences, in order, each an unmet prerequisite (never a disabled button without a reason). */
  blockers: string[];
  canAsk: boolean;
  /** True when "Get this computer ready" is the way forward. */
  setup: boolean;
  /** True when no AI service is allowed yet: the way forward is the guide "Choose your AI helper" (the one button), not a list of program problems. */
  chooseRuntime: boolean;
  /** "Working" while a request runs, "Waiting for you" while one asks for an OK; null otherwise. */
  working: 'Working' | 'Waiting for you' | null;
  /** The plain progress line of the live request (what it is doing, for how long, that you can keep using Nexus, what happens next); null when none runs. */
  progress: PanelProgress | null;
  /** The plain "waiting for you" state of the live request; null when it does not wait for you. */
  waiting: PanelWaiting | null;
  /** How the newest request ended (done, no change, failed or stopped) with its reason and one next step; null while one is live or none ran. */
  ending: PanelEnding | null;
  /** A line under the panel that is not a blocker (the check is stale and the send will redo it). */
  note: string | null;
  /** The sentence for a failed read of the conversations that is not "AI helper work is off" (a busy database, an unexpected failure). */
  readError: string | null;
  /** The newest request, when it failed (shown with its reason; a failed request that is not the newest is history). */
  failure: PanelFailure | null;
  sessions: SessionRowView[];
  usageToday: string | null;
}

type PanelJob = Pick<JobView, 'state' | 'phase' | 'headline' | 'outcome' | 'cancelRequested'> & Partial<Pick<JobView, 'createdAt' | 'startedAt' | 'error'>>;

export interface AgentPanelInput {
  health: HealthView | null;
  availability: ExecAvailability;
  /** Null while unread. */
  sessions: readonly SessionView[] | null;
  /** What the newest conversation's AI helper last said (see replyOf), for the ending of the newest request. */
  reply?: string | null;
  /** The failure of the sessions read, if it failed. */
  sessionsFail: { code: string; reason?: string; subReason?: string } | null;
  /** The live request jobs by id (for the waiting reason, the progress line and how the newest one ended). */
  jobs?: ReadonlyMap<string, PanelJob>;
  /** The time now in ms (for "working for 2 minutes"); the clock when left out. */
  now?: number;
}

function runtimeBlocker(a: AgentSetupView): string | null {
  // The local-model runtime words its own server and model problems.
  if (a.kind === LOCAL_MODEL_KIND) {
    if (a.state === 'not_installed') return AGENT_REASON_TEXT.local_model_server_down;
    if (a.state === 'version_unsupported') return AGENT_REASON_TEXT.local_model_no_tools;
    if (a.state === 'ready' && a.problem) return LOCAL_PROBLEM_TEXT[a.problem];
  }
  // The hosted runtime: a provider and model not chosen, a model it does not offer, no saved key, or a key the provider did not accept.
  if (a.kind === HOSTED_MODEL_KIND && a.state === 'ready' && a.problem) return LOCAL_PROBLEM_TEXT[a.problem];
  switch (a.state) {
    case 'ready': return null;
    case 'not_installed': return AGENT_REASON_TEXT.runtime_not_installed;
    case 'not_signed_in': return AGENT_REASON_TEXT.runtime_not_authenticated;
    case 'version_unsupported': return AGENT_REASON_TEXT.runtime_version_unsupported;
    case 'unavailable': return AGENT_REASON_TEXT.runtime_error;
    default: return AGENT_REASON_TEXT.runtime_unknown;
  }
}

/** A conversation a new message may continue: `open`, or `running` with no live request (main keeps it `running` after a request ends). */
export function continuable(s: Pick<SessionView, 'status' | 'liveJobId'>): boolean {
  return s.status === 'open' || (s.status === 'running' && s.liveJobId === null);
}
/** The newest conversation a message continues, or null (start a new one). */
export function continuableSession(sessions: readonly SessionView[] | null | undefined): SessionView | null {
  return [...(sessions ?? [])].filter(continuable).sort((x, y) => y.updatedAt - x.updatedAt)[0] ?? null;
}

const LIVE_JOB_STATES: readonly string[] = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];
/** The waits that only the person can end: the AI service is not allowed or checked yet, or a question is open. */
const WAITS_ON_YOU: readonly string[] = ['waiting:runtime', 'waiting:consent', 'waiting:approval'];
const askedForOk = (j: Pick<JobView, 'state' | 'headline'>): boolean => j.state === 'awaiting_approval' || (j.state === 'running' && j.headline === 'waiting_for_approval');

/** What a live request is doing now, how long it has been at it, that you can keep using Nexus, and what happens next. */
export function agentProgress(j: PanelJob, now: number): PanelProgress {
  const since = typeof j.startedAt === 'number' ? j.startedAt : typeof j.createdAt === 'number' ? j.createdAt : null;
  const waiting = j.state === 'queued' || j.state === 'retry_scheduled';
  const running = since === null ? null : `${waiting ? 'Waiting' : 'Working'} for ${elapsedText(now - since)}`;
  const nowText = agentTurnHeadline(j);
  const next = waiting || j.state === 'leased'
    ? agentTurnNext(j) ?? WHEN_IT_STOPS_TEXT
    : WHEN_IT_STOPS_TEXT;
  const line = [`${nowText}.`, running ? `${running}.` : null, KEEP_USING_TEXT, `Next: ${next.charAt(0).toLowerCase()}${next.slice(1)}`].filter(Boolean).join(' ');
  return { now: nowText, running, keepUsing: KEEP_USING_TEXT, next, line };
}

/** The "waiting for you" state of a live request (an OK to answer, or the AI service not yet allowed), or null. */
export function agentWaiting(j: PanelJob): PanelWaiting | null {
  if (askedForOk(j)) return { title: 'Waiting for you', text: 'The AI helper needs your OK before it can go on.', next: 'Answer the question on this page. The AI helper carries on by itself after that.' };
  if ((j.state === 'queued' || j.state === 'retry_scheduled') && typeof j.phase === 'string' && WAITS_ON_YOU.includes(j.phase)) {
    return { title: 'Waiting for you', text: `${waitPhaseText(j.phase)}.`, next: WAIT_PHASE_NEXT[j.phase] ?? 'Open “Get this computer ready”.' };
  }
  return null;
}

const ENDING_TITLE = { handed_in: 'Changes ready to look over', no_change: 'No changes', failed: 'Did not work', stopped: 'Stopped' } as const;
/** How a request that is no longer live ended, with its reason in plain words and one next step. */
export function agentEnding(j: PanelJob, reply: string | null = null): PanelEnding | null {
  if (LIVE_JOB_STATES.includes(j.state)) return null;
  const text = agentTurnHeadline(j);
  const next = agentTurnNext(j);
  if (j.state === 'failed') {
    return { tone: 'failed', title: ENDING_TITLE.failed, text: `${text}.`, next, snapshot: j.outcome === 'branch_unknown' || j.error?.code === 'branch_unknown' };
  }
  if (j.state === 'completed' && j.outcome !== 'no_change') return { tone: 'handed_in', title: ENDING_TITLE.handed_in, text: `${text}.`, next, snapshot: false };
  // A request that only answered is not a failure: it says so, and shows the answer.
  if ((j.state === 'completed' || j.state === 'partial') && j.outcome === 'no_change') {
    return { tone: 'no_change', title: reply ? 'The AI helper replied' : ENDING_TITLE.no_change, text: 'The AI helper answered but did not suggest changes.', reply,
      next: 'Ask again, or describe a change you want.', snapshot: false };
  }
  return { tone: 'stopped', title: j.state === 'partial' || j.state === 'interrupted' ? 'Stopped early' : j.state === 'timed_out' ? 'Ran out of time' : ENDING_TITLE.stopped, text: `${text}.`, next, snapshot: false };
}

export function agentPanelModel(i: AgentPanelInput): AgentPanelView {
  const empty: Omit<AgentPanelView, 'kind' | 'lead' | 'blockers' | 'canAsk' | 'setup'> = { chooseRuntime: false, working: null, progress: null, waiting: null, ending: null, sessions: [], usageToday: null, note: null, readError: null, failure: null };
  // AI helper work off (the part is not in place): one sentence, no setup to offer.
  if (i.sessionsFail) {
    const c = errorCopy(i.sessionsFail.code, i.sessionsFail.reason, i.sessionsFail.subReason);
    if (c.kind === 'execution_unavailable' || c.kind === 'unavailable') return { kind: 'off', lead: c.text, blockers: [], canAsk: false, setup: false, ...empty };
  }
  let readError: string | null = null;
  if (i.sessionsFail) readError = errorCopy(i.sessionsFail.code, i.sessionsFail.reason, i.sessionsFail.subReason).text;
  if (i.availability.kind === 'platform_off' || i.availability.kind === 'execution_off') {
    return { kind: 'off', lead: i.availability.text, blockers: [], canAsk: false, setup: false, ...empty };
  }
  // AI helper work is not in place in this build or on this database: one sentence, nothing to check and nothing to allow.
  if (i.health?.agent?.state === 'off') return { kind: 'off', lead: agentOffText(i.health.agent.offReason, i.health.db.subReason ? agentsNotice(i.health.db.subReason) : undefined), blockers: [], canAsk: false, setup: false, ...empty };
  const blockers: string[] = [];
  const exec = noticeFor(i.availability);
  if (i.availability.kind !== 'ready' && exec) blockers.push(exec.text);
  const a = i.health?.agent ?? null;
  // The cached check of the program is older than main keeps it (state `unknown`) while a permission is live: the program was
  // checked before, and #42 checks it again by itself when you send, so the panel asks rather than blocks.
  const staleButAskable = a !== null && a.state === 'unknown' && a.consent.live;
  // No AI service allowed yet: whatever the default program's state, the first thing to do is choose one (the guide).
  // Nothing is said about a program that may not even be wanted, and nothing assumes one paid plan.
  const chooseRuntime = a !== null && !a.consent.live;
  if (!a) blockers.push(AGENT_REASON_TEXT.runtime_unknown);
  else if (chooseRuntime) blockers.push(CHOOSE_RUNTIME_TEXT);
  else {
    const rt = staleButAskable ? null : runtimeBlocker(a);
    if (rt) blockers.push(rt);
    else if (a.consent.caps && a.consent.caps.dayUsdCents > 0 && a.usageToday.usdCents >= a.consent.caps.dayUsdCents) blockers.push(AGENT_REASON_TEXT.budget_exhausted);
  }
  const rows: SessionRowView[] = [...(i.sessions ?? [])].sort((x, y) => y.updatedAt - x.updatedAt).map((s) => {
    const job = s.liveJobId ? i.jobs?.get(s.liveJobId) ?? null : null;
    const turn = job ? agentTurnHeadline(job) : s.liveJobId ? 'The AI helper is working' : null;
    // Main never moves a session from `running` back to `open`: after a request ends it stays `running` with no live request. Whether it is
    // working is whether a request is live; a session with none is ready for the next message (a new request on it is allowed).
    const idle = continuable(s);
    const live = (s.status === 'running' && s.liveJobId !== null) || s.status === 'awaiting_approval';
    // A request the guards hold is waiting, not working.
    const waiting = job && (job.state === 'queued' || job.state === 'retry_scheduled' || job.state === 'leased') && waitPhaseText(job.phase) !== null;
    return {
      id: s.id, word: waiting ? 'Waiting' : idle ? SESSION_WORD.open : SESSION_WORD[s.status] ?? 'Status unknown', turn,
      turns: count(s.turns, 'request', 'requests'), why: SESSION_WHY[s.status] ?? null, live, canSend: idle, canStop: live, canEnd: idle
    };
  });
  const ss = i.sessions ?? [];
  const working = rows.some((r) => r.live && r.word === 'Working') ? 'Working'
    : ss.some((s) => s.status === 'awaiting_approval') ? 'Waiting for you' : null;
  const canAsk = blockers.length === 0;
  const jobs = i.jobs ? [...i.jobs.values()] : [];
  const newest = jobs.filter((j) => typeof j.createdAt === 'number').sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0))[0];
  const failure: PanelFailure | null = newest && newest.state === 'failed'
    ? { text: agentTurnHeadline(newest), snapshot: newest.outcome === 'branch_unknown' || newest.error?.code === 'branch_unknown' } : null;
  // The live request (the newest that is still going): its progress line, or the plain "waiting for you" card.
  const live = jobs.filter((j) => LIVE_JOB_STATES.includes(j.state)).sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0))[0];
  const now = i.now ?? Date.now();
  const waitingForYou = live ? agentWaiting(live) : null;
  const progress = live && !waitingForYou ? agentProgress(live, now) : null;
  const ending = newest && !live ? agentEnding(newest, i.reply ?? null) : null;
  return {
    kind: canAsk ? 'ready' : 'setup',
    lead: canAsk ? ISOLATION_NOTE : blockers[0],
    blockers, canAsk, setup: !canAsk, chooseRuntime, working, progress, waiting: waitingForYou, ending, sessions: rows,
    usageToday: a && a.consent.live ? usageTodayLine(a.usageToday, a.label ?? null) : null,
    note: canAsk && staleButAskable ? RECHECK_ON_SEND_TEXT : canAsk && a !== null && a.state === 'ready' && a.signedIn !== 'yes' && a.kind !== HOSTED_MODEL_KIND ? SIGNIN_UNCONFIRMED_TEXT : null, readError, failure
  };
}

// ---------- starting a request ----------

/** The #42 request for a message, or the problem with it. Ids and the text only: never a path, host or command. */
export function startArgs(i: { projectId: string; workspaceId: string; sessionId: string | null; message: string; intentId: string }):
  { args: AgentStartArgs } | { problem: string } {
  const message = i.message.trim();
  if (!message) return { problem: 'Write a message for the AI helper first.' };
  if (message.length > MAX_MESSAGE_CHARS) return { problem: AGENT_REASON_TEXT.message_too_long };
  return { args: { projectId: i.projectId, workspaceId: i.workspaceId, sessionId: i.sessionId, focusVersionIds: [], message, intentId: i.intentId } };
}

/** The request box sends to this project's AI helper (#42) only on a software project and only when the AI helper can take a message now;
 *  every other route, workspace, or state keeps the lead AI helper behaviour. */
export function intentRoute(i: { routeName: string; primaryWorkspaceId: string | null; canAsk: boolean }): 'agent' | 'legacy' {
  return i.routeName === 'project' && i.primaryWorkspaceId === 'sde' && i.canAsk ? 'agent' : 'legacy';
}

/** What the lead AI helper is doing, as the request box needs it (the assistant port's status, without its types). */
export interface LeadHelperState { state: 'unavailable' | 'starting' | 'ready'; reason?: string; deliveryPaused?: boolean }

/** The words of the request box for each of its two modes: ONE plain line that says who gets your message and what happens next. */
export interface IntentWords {
  /** A short label next to the box naming who receives the message. */
  label: string;
  /** The one line under the box. */
  explain: string;
  placeholder: string;
  button: string;
  ariaLabel: string;
  /** The hover text of the "you are looking at" chip. */
  chipTitle: (chip: string) => string;
  /** The words after a send: who got it. */
  sentLead: (continued: boolean) => string;
  followLabel: string;
}

export function intentWords(i: { mode: 'agent' | 'legacy'; lead: LeadHelperState; onSoftwareProject: boolean; note?: string | null; replyHint?: string | null }): IntentWords {
  if (i.mode === 'agent') {
    return {
      label: 'AI helper for this project',
      explain: `Your message goes to the AI helper for this project. It works in a ${GLOSSARY.safeCopy.name}, and your real files change only when you press “${GLOSSARY.addToProject.name}”. You can follow it in the AI helper panel on the project page.${i.note ? ` ${i.note}` : ''}`,
      placeholder: 'Describe the change you want',
      button: 'Ask the AI helper',
      ariaLabel: 'Ask this project’s AI helper',
      chipTitle: (chip) => `You are looking at: ${chip}. The AI helper is told your message and which project this is, not this selection.`,
      sentLead: (continued) => (continued ? 'Sent to the AI helper in your open conversation.' : 'Sent to the AI helper in a new conversation.'),
      followLabel: 'See how it is going in the AI helper panel'
    };
  }
  const l = i.lead;
  const state = l.state === 'unavailable' ? (l.reason ?? 'The lead AI helper is not running. Open Agents to start it.')
    : l.state === 'starting' ? 'The lead AI helper is starting. Your requests wait until it is ready.'
      : l.deliveryPaused ? 'The lead AI helper is ready, but sending is paused in Agents.'
        : 'Your message goes to the lead AI helper, which passes the work on to others.';
  const projectNote = i.onSoftwareProject ? ' This project’s own AI helper is not ready yet, so the lead AI helper gets it. To set it up, open “Get this computer ready”.' : '';
  return {
    label: 'Lead AI helper',
    explain: `${state}${projectNote}${i.replyHint ? ` ${i.replyHint}` : ''}`,
    placeholder: 'Ask the lead AI helper to plan, build or fix something',
    button: 'Ask the lead AI helper',
    ariaLabel: 'Ask the lead AI helper',
    chipTitle: (chip) => `Sent with context: ${chip}`,
    sentLead: () => 'Sent to the lead AI helper.',
    followLabel: 'See it in Runs'
  };
}

// ---------- failures ----------

export interface AgentFailure {
  code: string; reason?: string | null; subReason?: string | null;
  detail?: Partial<Record<string, string | number | boolean | null>>;
}

/** One next step after a refusal that would otherwise leave the person stuck (main's sentence says what happened, this says what to do). */
export const NEXT_STEP: Readonly<Record<string, string>> = Object.freeze({
  not_fast_forward: 'Ask the AI helper to do the work again on your latest project.',
  integration_unexpected: 'Ask a developer to look at it before you try again.',
  merge_conflict: `Press “${BUTTON_LABEL.request_changes}” so the AI helper redoes the work on top of the changes you kept.`,
  branch_mismatch: 'Switch your project back to the version it was on, then try again.'
});

/** The sentence for a refused AI helper, review, keep or add call, with its next step where there is one. A refusal that left an undo owed says so after. */
export function agentFailText(r: AgentFailure): string {
  const base = errorCopy(r.code, r.reason, r.subReason).text;
  const step = r.reason && Object.prototype.hasOwnProperty.call(NEXT_STEP, r.reason) ? ` ${NEXT_STEP[r.reason]}` : '';
  return r.detail && r.detail.rollbackOwed === true ? `${base}${step} ${ROLLBACK_OWED_TEXT}` : `${base}${step}`;
}

// ---------- the conversation log ----------

export interface SessionLogView {
  /** Said once above the messages: they are for reading only. */
  note: string;
  messages: { key: string; author: string; text: string; when: string }[];
  /** The requests of this conversation, each with how it ended, its steps and cost, and its next step. */
  turns: { key: string; headline: string; next: string | null; usage: string | null; when: string }[];
  /** The steps the AI helper took, in plain words ("Reading a file"), with whether each worked. */
  toolCalls: { key: string; tool: string; outcome: string }[];
  versions: { key: string; versionId: string; kind: string; status: string }[];
}

/** Plain words for each step the AI helper can take (a raw tool id is never shown): the ones Nexus serves, its file steps and the names other programs use. */
const NEXUS_TOOL_LABEL: Readonly<Record<string, string>> = Object.freeze({
  context_get: 'Reading the details of your request', artifact_list: 'Looking through the project’s saved items', artifact_read: 'Reading a saved item',
  validations_get: 'Reading the results of the checks', job_status: 'Checking how a task is going', job_logs: 'Reading what a task wrote down',
  sandbox_exec: 'Running a command in the safe space', job_request: 'Asking Nexus to run a task',
  changeset_register: 'Saving the suggested changes', requirement_draft: 'Writing down what is needed', review_request: 'Sending the suggested changes for review',
  read_file: 'Reading a file', write_file: 'Writing a file', list_files: 'Looking at the project’s files', delete_file: 'Deleting a file',
  Read: 'Reading a file', Write: 'Writing a file', Edit: 'Writing a file', MultiEdit: 'Writing a file', Glob: 'Looking at the project’s files', LS: 'Looking at the project’s files',
  Grep: 'Searching the project’s files', Bash: 'Running a command'
});
/** One step as the log shows it, in plain words (any `mcp__<server>__` prefix removed). A step this build has no words for reads "A step". */
export function toolLabel(tool: string): string {
  const bare = tool.replace(/^mcp__[A-Za-z0-9-]+__/, '');
  return Object.prototype.hasOwnProperty.call(NEXUS_TOOL_LABEL, bare) ? NEXUS_TOOL_LABEL[bare] : 'A step';
}
const clock = (t: number): string => (Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

/** The log of one conversation. What the AI helper wrote is for reading only; a step shows its plain description and whether it worked, never its arguments. */
export function sessionLogModel(d: SessionDetailView): SessionLogView {
  return {
    note: DISPLAY_ONLY_NOTE,
    messages: d.messages.map((m) => ({ key: String(m.seq), author: m.from === 'agent' ? 'AI helper (for reading only)' : 'You', text: m.text, when: clock(m.ts) })),
    turns: d.turnHistory.map((t) => {
      const j = { state: t.state, outcome: t.outcome, phase: null, headline: t.headline, cancelRequested: false, error: t.error ?? null } as const;
      return { key: t.jobId, headline: agentTurnHeadline(j), next: agentTurnNext(j), usage: usageLine(t.usage), when: clock(t.createdAt) };
    }),
    toolCalls: d.toolCalls.map((c) => ({
      key: String(c.seq), tool: toolLabel(c.tool),
      outcome: c.ok === null ? 'Result not recorded' : c.ok ? 'Worked' : 'Did not work'
    })),
    versions: d.versions.map((v) => ({ key: v.versionId, versionId: v.versionId, kind: kindLabel(v.kind), status: statusLabel(v.status) }))
  };
}
