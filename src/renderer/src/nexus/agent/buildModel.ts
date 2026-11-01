import type { AgentPanelView, ChatItem } from './agentModel';

/** One step the AI helper took, in plain words. `now` is the step it is on right now. */
export interface BuildStep { key: string; text: string; now: boolean }

/**
 * The building page, as plain data: the request as the heading, what the AI helper is doing, how long, its steps so far, and the one
 * thing to do next (stop it while it works; look at the changes when they are ready; go back when it ended without any).
 */
export interface BuildView {
  state: 'starting' | 'building' | 'waiting' | 'ready' | 'ended';
  /** "Building: add a function that squares a number". */
  heading: string;
  /** One plain sentence about now. */
  status: string;
  /** "Working for 2 minutes" (or "Waiting for 30 seconds"); null when not running or the time is not known. */
  elapsed: string | null;
  steps: BuildStep[];
  /** What the AI helper said back at the end, when it said something (plain text). */
  said: string | null;
  canStop: boolean;
  /** The one big button after the work: look at the suggested changes, or go back to the project. Null while it works. */
  button: { kind: 'review' | 'back'; label: string } | null;
  /** A second line (what to do next, or why it ended). */
  next: string | null;
}

export const BUILD_REVIEW_LABEL = 'Look at the suggested changes';
export const BUILD_BACK_LABEL = 'Back to the project';
export const BUILD_BLOCKED_LABEL = 'Look at what it made';
export const BUILD_BLOCKED_STATUS = 'The AI helper made changes, but they did not pass the checks.';
export const BUILD_BLOCKED_NEXT = 'Look at what it made to see what failed, or ask the AI helper to fix it.';
const HEADING_CHARS = 90;

/** The request's words cut at a word edge so the heading stays one line. */
export function requestHeading(text: string | null | undefined): string {
  const t = (text ?? '').split(/[\t\n\r ]+/).join(' ').trim();
  if (!t) return 'Building your request';
  if (t.length <= HEADING_CHARS) return `Building: ${t}`;
  const cut = t.slice(0, HEADING_CHARS - 1);
  const edge = cut.lastIndexOf(' ');
  return `Building: ${(edge > 40 ? cut.slice(0, edge) : cut).trimEnd()}…`;
}

export interface BuildInput {
  panel: AgentPanelView;
  /** The conversation as chat lines, oldest first (chatItems). */
  items: readonly ChatItem[];
  /** What the AI helper is doing now (liveStepLine); null when unknown. */
  liveLine: string | null;
  /** How many suggested changes wait for a decision. */
  reviewReady: number;
  /** A request the Home page's Start handed over is being started or about to be sent (its words); null otherwise. */
  starting: string | null;
  /** A handed-over request that could not start (its words and why); null otherwise. */
  startFailed: { text: string; error: string } | null;
  /** A request was seen running on this page: only then is its end shown here (an older request never takes the page over). */
  sawLive: boolean;
  /** The person closed the ended view. */
  dismissed: boolean;
  /** A suggested change this request made whose checks failed (it is kept as Blocked): the request did change things. */
  blockedChange?: { name: string } | null;
}

/** What the building page shows, or null when the page should show the project as usual. */
export function buildView(i: BuildInput): BuildView | null {
  const lastYou = (() => { for (let n = i.items.length - 1; n >= 0; n--) if (i.items[n].kind === 'you') return n; return -1; })();
  const since = i.items.slice(lastYou + 1);
  const youText = lastYou >= 0 ? i.items[lastYou].text : null;
  const stepTexts = since.filter((x) => x.kind === 'steps').flatMap((x) => x.text.split(' · '));
  const said = [...since].reverse().find((x) => x.kind === 'helper')?.text ?? null;
  const live = i.panel.progress !== null || i.panel.waiting !== null;
  const stepsOf = (withNow: boolean): BuildStep[] => {
    const done = stepTexts.map((t, n) => ({ key: `s${n}`, text: t, now: false }));
    const live = i.liveLine && withNow ? i.liveLine : null;
    // The step the AI helper is on is shown as "now" once, never also as a finished step.
    const rest = live ? done.filter((d) => `${d.text}…` !== live) : done;
    return live ? [...rest.slice(-7), { key: 'now', text: live.replace(/…$/, ''), now: true }] : rest.slice(-8);
  };
  if (live) {
    const waiting = i.panel.waiting;
    if (waiting) {
      return { state: 'waiting', heading: requestHeading(youText), status: waiting.text, elapsed: null, steps: stepsOf(false), said: null, canStop: i.panel.sessions.some((s) => s.canStop), button: null, next: waiting.next };
    }
    const p = i.panel.progress!;
    return { state: 'building', heading: requestHeading(youText), status: p.now.endsWith('.') ? p.now : `${p.now}.`, elapsed: p.running, steps: stepsOf(true), said: null, canStop: i.panel.sessions.some((s) => s.canStop), button: null, next: null };
  }
  if (i.starting !== null) {
    return { state: 'starting', heading: requestHeading(i.starting), status: 'Starting. The AI helper is getting your request.', elapsed: null, steps: [], said: null, canStop: false, button: null, next: null };
  }
  if (i.startFailed && !i.dismissed) {
    return { state: 'ended', heading: requestHeading(i.startFailed.text), status: 'The AI helper could not start.', elapsed: null, steps: [], said: null, canStop: false, button: { kind: 'back', label: BUILD_BACK_LABEL }, next: i.startFailed.error };
  }
  if (!i.sawLive || i.dismissed) return null;
  const end = i.panel.ending;
  // The request made changes whose checks did not pass (a blocked change): never "ready". Its own words ("registered successfully, ready for review") are not shown then.
  if (end && (end.tone === 'no_change' || end.tone === 'handed_in') && i.blockedChange) {
    return { state: 'ended', heading: requestHeading(youText), status: BUILD_BLOCKED_STATUS, elapsed: null, steps: stepsOf(false), said: end.tone === 'no_change' ? end.reply ?? null : null, canStop: false, button: { kind: 'review', label: BUILD_BLOCKED_LABEL }, next: BUILD_BLOCKED_NEXT };
  }
  if (end && end.tone === 'handed_in') {
    return { state: 'ready', heading: 'Your changes are ready', status: 'The AI helper finished. Look over what it changed before anything touches your files.', elapsed: null, steps: stepsOf(false), said, canStop: false, button: { kind: 'review', label: BUILD_REVIEW_LABEL }, next: null };
  }
  if (end) {
    const status = end.tone === 'failed' ? 'It did not work.' : end.tone === 'no_change' ? 'The AI helper finished without suggesting changes.'
      : end.title === 'Ran out of time' ? 'It ran out of time.' : end.title === 'Stopped early' ? 'It stopped early.' : 'It was stopped.';
    // A request that only answered says so in its status line; the sentence for the others says what happened.
    const next = (end.tone === 'no_change' ? [end.next] : [end.text, end.next]).filter(Boolean).join(' ') || null;
    return { state: 'ended', heading: requestHeading(youText), status, elapsed: null, steps: stepsOf(false), said: end.reply ?? null, canStop: false, button: { kind: 'back', label: BUILD_BACK_LABEL }, next };
  }
  if (i.reviewReady > 0) {
    return { state: 'ready', heading: 'Your changes are ready', status: 'The AI helper finished. Look over what it changed before anything touches your files.', elapsed: null, steps: stepsOf(false), said, canStop: false, button: { kind: 'review', label: BUILD_REVIEW_LABEL }, next: null };
  }
  return null;
}
