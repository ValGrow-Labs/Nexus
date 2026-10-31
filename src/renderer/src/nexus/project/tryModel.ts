import type { JobView } from '@shared/nexus/ipc';
import { logLines } from '../runs/logModel';

/**
 * "Try it" in plain words: the state of one try run (a suggested change run in the safe space), its output lines, and how long it took.
 * Pure: the component reads the job and the log and asks this what to say. No ids, no hashes, no vendor words.
 */

export type TryState = 'idle' | 'setup' | 'starting' | 'running' | 'done' | 'failed' | 'timeout' | 'stopped' | 'interrupted' | 'could_not_run';

export interface TryView {
  state: TryState;
  /** One plain sentence. */
  headline: string;
  /** A second line (why, or what to do); null when the headline says it all. */
  detail: string | null;
  /** True while the run is waiting or running: Stop is offered and the buttons are off. */
  live: boolean;
  canStop: boolean;
  /** The run has ended (in any way): its output is complete. */
  ended: boolean;
}

export const TRY_INTRO = 'Run the suggested changes in the safe space: a locked box with no internet. Your real files are not touched, and nothing runs until you press a button.';
export const TRY_SETUP_TEXT = 'The safe space is not ready on this computer yet. Open “Get this computer ready”, then try again.';
export const TRY_NO_BUTTONS = 'Nexus did not find a test or a program to run in these changes. You can still run your own command below.';
export const TRY_NO_OUTPUT = 'It printed nothing.';
export const TRY_OWN_SUMMARY = 'Try your own command';
export const TRY_OWN_HINT = 'It runs in the safe space with no internet. Write it the way you would type it in a terminal.';
export const TRY_OWN_EXAMPLE = 'node -e "console.log(require(\'./src\').isPrime(7))"';

/** "3 seconds", "1 minute 5 seconds": how long a run took. */
export function tryDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 1) return 'under a second';
  if (s < 60) return s === 1 ? '1 second' : `${s} seconds`;
  const m = Math.floor(s / 60); const r = s % 60;
  const mm = m === 1 ? '1 minute' : `${m} minutes`;
  return r === 0 ? mm : `${mm} ${r === 1 ? '1 second' : `${r} seconds`}`;
}

type TryJob = Pick<JobView, 'state' | 'headline' | 'outcome' | 'startedAt' | 'finishedAt' | 'createdAt' | 'cancelRequested'>;

/**
 * What to say now. `setup`: the safe space is not ready (health says so) and nothing is running. `exitCode`: the newest attempt's exit
 * (null when not known). A run that waits for the safe space (no Docker, no kit) says so rather than "starting".
 */
export function tryView(i: { job: TryJob | null; exitCode: number | null; setup: boolean; now: number }): TryView {
  const j = i.job;
  const view = (state: TryState, headline: string, detail: string | null = null, o: { live?: boolean; canStop?: boolean } = {}): TryView =>
    ({ state, headline, detail, live: o.live ?? false, canStop: o.canStop ?? false, ended: !(o.live ?? false) && state !== 'idle' && state !== 'setup' });
  if (!j) return i.setup ? view('setup', TRY_SETUP_TEXT) : view('idle', 'Nothing has been run yet.');
  const took = tryDuration((j.finishedAt ?? i.now) - (j.startedAt ?? j.createdAt));
  const stopping = j.cancelRequested;
  switch (j.state) {
    case 'queued': case 'leased': case 'retry_scheduled':
      if (j.headline === 'waiting:docker' || j.headline === 'waiting:image' || j.headline === 'waiting:disk' || j.headline === 'waiting:runner') {
        return view('setup', TRY_SETUP_TEXT, null, { live: true, canStop: true });
      }
      return view('starting', stopping ? 'Stopping…' : 'Getting the safe space ready…', null, { live: true, canStop: true });
    case 'running': case 'awaiting_approval':
      return view('running', stopping ? 'Stopping…' : 'Running in the safe space…', took ? `Running for ${took}.` : null, { live: true, canStop: true });
    case 'completed': case 'partial':
      return view('done', 'It ran and finished fine.', took ? `It took ${took}.` : null);
    case 'timed_out':
      return view('timeout', 'It took too long, so Nexus stopped it.', took ? `It ran for ${took}.` : null);
    case 'cancelled':
      return view('stopped', 'You stopped it.', took ? `It ran for ${took} first.` : null);
    case 'interrupted':
      return view('interrupted', 'It stopped early because Nexus was closed or restarted while it ran.', 'Press the button again to run it again.');
    case 'failed': {
      if (j.outcome === 'nonzero_exit') {
        return view('failed', 'It stopped with an error.', [took ? `It ran for ${took}.` : null, i.exitCode !== null ? `Its exit code was ${i.exitCode}.` : null].filter(Boolean).join(' ') || null);
      }
      if (j.outcome === 'oom') return view('failed', 'It used more memory than the safe space allows, so it was stopped.', null);
      return view('could_not_run', 'Nexus could not run it in the safe space.', 'Check “Get this computer ready”, then try again.');
    }
    default:
      return view('could_not_run', 'Nexus could not run it in the safe space.', 'Check “Get this computer ready”, then try again.');
  }
}

export interface TryOutLine { key: string; stream: 'stdout' | 'stderr'; text: string }

/** The output lines of the log text read so far: what the program printed (standard output) and what it complained about (errors). Nexus's own notes are left out. */
export function tryOutput(text: string): { lines: TryOutLine[]; cutMiddle: boolean } {
  const lines: TryOutLine[] = [];
  let cutMiddle = false;
  logLines(text).forEach((l, n) => {
    if (l.kind !== 'frame') return;
    if (l.truncatedMiddle) cutMiddle = true;
    if (l.stream === 'nexus') return;
    // A frame holds the text of one write, which may end in a line break: keep the text, drop the break.
    const t = l.text.replace(/\r?\n$/, '');
    lines.push({ key: `l${n}`, stream: l.stream, text: t });
  });
  return { lines, cutMiddle };
}

/** The most output lines the panel draws at once (the log reader pages the rest; the panel says the output was cut). */
export const TRY_MAX_LINES = 400;
