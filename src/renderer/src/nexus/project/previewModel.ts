import type { DeploymentView } from '@shared/nexus/ipc';

/**
 * The preview in plain words, and the pure chain that gets an app running: save a starting point, build, get it ready, start it. Every step is one of the
 * existing user actions (the same jobs and checks as pressing them one by one); the press of "Preview" is the OK for all four. No ids, no hashes,
 * no vendor words. The orchestration takes its client as a parameter so a test can play it.
 */

export type PreviewStep = 'snapshot' | 'deps' | 'build' | 'assemble' | 'start';

export const PREVIEW_TITLE = 'Preview';
export const PREVIEW_INTRO = 'Run your app in the safe space and see it here. It runs on this computer only, with no internet, and stops by itself after two hours.';
export const PREVIEW_LIMITS = 'It runs the version you last added to your project. The app needs its own start file (nexus.app.json) and a build step; the AI helper writes them when you ask for an app. If the app uses add-ons (packages), Nexus asks you once to download them from the package website, and only from there; the app itself still has no internet.';
/** What the person sees while Nexus waits for the answer to the download question. */
export const PREVIEW_DEPS_WAITING = 'Waiting for your answer: the app lists add-ons (packages) it needs. Nexus can download them for this one step, from the package website only, and does not run them while they are installed.';
export const PREVIEW_EMBED_LABEL = 'The running app (this is your app, not Nexus)';
export const PREVIEW_NOT_ANSWERING = 'The app is not answering right now. Try Reload, or Stop and Preview again.';
export const PREVIEW_ASK_HELPER_DEPS = 'The add-ons (packages) in this app could not be downloaded. Check the package names and versions in package.json (use real packages from the public package website, none that need an install script to run), and keep the list short.';
export const PREVIEW_ASK_HELPER = 'Make this app runnable in Nexus: add a nexus.app.json, a build step that writes its files to dist, a start command, and a /health page. The app must listen on port 3000 on all addresses and use no outside internet.';

const STEP_WORDS: Readonly<Record<PreviewStep, string>> = Object.freeze({
  snapshot: 'Saving a starting point…', deps: 'Getting the add-ons your app needs…', build: 'Building your app in the safe space…', assemble: 'Getting it ready to run…', start: 'Starting your app…'
});
export const stepWords = (s: PreviewStep): string => STEP_WORDS[s];
export const PREVIEW_STEPS: readonly PreviewStep[] = Object.freeze(['snapshot', 'deps', 'build', 'assemble', 'start']);

/** What a step that did not work says, plainly, and whether the fix is to ask the AI helper to make the app runnable. */
export function stepFailure(step: PreviewStep, why: string | null): { text: string; askHelper: boolean; askKind?: 'deps' } {
  if (step === 'deps') {
    // `why` is the error code of the download job.
    if (why === 'denied' || why === 'approval_denied') return { text: 'You did not allow the download, so the app cannot run yet. Press Preview again when you are ready.', askHelper: false };
    if (why === 'approval_expired' || why === 'approval_stale') return { text: 'The question about the download was not answered in time, so nothing was downloaded. Press Preview again.', askHelper: false };
    return { text: 'The download did not finish. A package name or version may be wrong, or the package website could not be reached. Nothing in your project was changed.', askHelper: true, askKind: 'deps' };
  }
  if (step === 'assemble') {
    return { text: 'Nexus could not get the app ready to run. It looks for a nexus.app.json at the top of your project.' + (why ? ` ${why}` : ''), askHelper: true };
  }
  if (step === 'build') return { text: 'The build did not work, so the app cannot run yet.' + (why ? ` ${why}` : ''), askHelper: true };
  if (step === 'start') return { text: 'The app did not start, or it never answered its health page.' + (why ? ` ${why}` : ''), askHelper: true };
  return { text: 'Nexus could not save a starting point.' + (why ? ` ${why}` : ''), askHelper: false };
}

/** The word for a deployment's state on the preview panel. */
export function deploymentWord(d: Pick<DeploymentView, 'status' | 'stopReason'>): string {
  switch (d.status) {
    case 'starting': return 'Starting…';
    case 'healthy': return 'Running';
    case 'unhealthy': return 'Not answering';
    case 'stopped': return d.stopReason === 'idle' ? 'Stopped (two hours passed)' : d.stopReason === 'app_quit' ? 'Stopped (Nexus was closed)' : 'Stopped';
    case 'failed': return 'The app stopped by itself';
    default: return 'Stopped';
  }
}

export const isLive = (d: Pick<DeploymentView, 'status'>): boolean => d.status === 'starting' || d.status === 'healthy' || d.status === 'unhealthy';

/** What the chain needs from the world; the component gives the real client, a test a fake. */
export interface ChainClient {
  /** Starts one action as the user; returns the job's id, or the sentence why it was refused. */
  start(step: PreviewStep, actionId: string, inputs: { versionId: string; slot: string }[]): Promise<{ ok: true; jobId: string } | { ok: false; text: string; skip?: boolean }>;
  /** Waits for the job to end; `outputs` are the versions it made. */
  waitJob(jobId: string): Promise<{ state: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted' | 'partial'; outputs: string[]; why: string | null; code?: string | null }>;
  /** Waits until the version has left draft (its checks ran); returns its status. */
  waitVersion(versionId: string): Promise<string>;
  /** The project's newest version of a kind (a repeated step that made nothing new, because the files did not change, still has its version). */
  latestOf(kind: 'repository' | 'build' | 'application'): Promise<string | null>;
  /** Stops every live deployment of the project (one preview per project). */
  stopLive(): Promise<void>;
  /** Waits for the deployment of this start job to be running (answering) or to end. */
  waitDeployment(jobId: string): Promise<{ id: string; ok: boolean; why: string | null }>;
}

export type ChainResult =
  | { ok: true; deploymentId: string }
  | { ok: false; step: PreviewStep; text: string; askHelper: boolean; askKind?: 'deps' };

/**
 * snapshot -> build -> assemble -> start, each step from the one before. Stops at the first step that did not work, with plain words and the step.
 * `onStep` says which step is under way. A live preview of the project is stopped first.
 */
export async function runPreviewChain(client: ChainClient, onStep: (s: PreviewStep) => void): Promise<ChainResult> {
  const fail = (step: PreviewStep, why: string | null, text?: string): ChainResult => {
    const f = stepFailure(step, why);
    return { ok: false, step, text: text ?? f.text, askHelper: f.askHelper, ...(f.askKind ? { askKind: f.askKind } : {}) };
  };
  await client.stopLive();
  const run = async (step: PreviewStep, actionId: string, inputs: { versionId: string; slot: string }[]):
    Promise<{ ok: true; jobId: string; out: string | null } | { ok: false; result: ChainResult }> => {
    if (step !== 'deps') onStep(step);
    const s = await client.start(step, actionId, inputs);
    // The add-ons step has nothing to do when the app lists none, or they are already installed: it is skipped without a word.
    if (!s.ok && step === 'deps' && s.skip === true) return { ok: true, jobId: '', out: inputs[0]?.versionId ?? null };
    if (!s.ok) return { ok: false, result: fail(step, null, s.text) };
    if (step === 'deps') onStep(step);
    if (step === 'start') return { ok: true, jobId: s.jobId, out: null };
    const w = await client.waitJob(s.jobId);
    if (w.state !== 'completed') return { ok: false, result: fail(step, step === 'deps' ? (w.code ?? null) : w.why) };
    // The add-ons step makes no version: the next step builds from the repository version it was given.
    if (step === 'deps') return { ok: true, jobId: s.jobId, out: inputs[0]?.versionId ?? null };
    // A step that made nothing new (the same files as last time) leaves the version it made then: that one is the input of the next step.
    const made = w.outputs[0] ?? await client.latestOf(step === 'snapshot' ? 'repository' : step === 'build' ? 'build' : 'application');
    if (made === null) return { ok: false, result: fail(step, w.why) };
    // The application stays a draft until its health check passes: a draft may be previewed, so only the repository and the build wait for their checks.
    if (step === 'assemble') return { ok: true, jobId: s.jobId, out: made };
    const status = await client.waitVersion(made);
    if (status !== 'candidate' && status !== 'active') return { ok: false, result: fail(step, step === 'build' ? 'Its checks did not pass.' : null) };
    return { ok: true, jobId: s.jobId, out: made };
  };
  const snap = await run('snapshot', 'sde.repository.snapshot', []);
  if (!snap.ok) return snap.result;
  const deps = await run('deps', 'sde.deps.prepare', [{ versionId: snap.out!, slot: 'repository' }]);
  if (!deps.ok) return deps.result;
  const build = await run('build', 'sde.build.run', [{ versionId: snap.out!, slot: 'repository' }]);
  if (!build.ok) return build.result;
  const app = await run('assemble', 'sde.app.assemble', [{ versionId: build.out!, slot: 'build' }]);
  if (!app.ok) return app.result;
  const start = await run('start', 'sde.preview.start', [{ versionId: app.out!, slot: 'application' }]);
  if (!start.ok) return start.result;
  const dep = await client.waitDeployment(start.jobId);
  if (!dep.ok) return fail('start', dep.why);
  return { ok: true, deploymentId: dep.id };
}

/** "Stops by itself in 1 hour 20 minutes": the visible countdown of the fixed two hour limit. */
export function countdownText(endsAt: number, now: number): string {
  const ms = endsAt - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'Stopping now';
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `Stops by itself in ${min} ${min === 1 ? 'minute' : 'minutes'}`;
  const h = Math.floor(min / 60); const m = min % 60;
  return `Stops by itself in ${h} ${h === 1 ? 'hour' : 'hours'}${m ? ` ${m} ${m === 1 ? 'minute' : 'minutes'}` : ''}`;
}
