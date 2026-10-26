// Pure: a persisted job (JobView, #26/#27) as a run strip and one plain sentence.
// The stages come from main's headline only; a job never reads "Completed" when
// the checks on what it made failed, and no percentage is ever shown (main
// reports no step counts in B2a, so there is nothing to compute one from).
import type { JobHeadline, JobView } from '@shared/nexus/ipc';
import type { JobState } from '@shared/nexus/platform';
import { getUserAction } from '@shared/nexus/actions';
import { DOMAINS } from '@shared/nexus/domains';
import { blockingValidatorsFor } from '@shared/nexus/validators';
import { waitsOnUserAction } from '@shared/nexus/stepState';
import { plainSentence } from '../project/evidenceModel';

export type JobStageId = 'queued' | 'provisioning' | 'running' | 'collecting' | 'validating' | 'result';
export type JobStageState = 'done' | 'active' | 'waiting' | 'pending' | 'stopped';
export interface JobStage { id: JobStageId; label: string; state: JobStageState }
export type JobResult = 'passed' | 'failed' | 'could_not_run' | 'failed_run' | 'cancelled' | 'timed_out' | 'interrupted' | null;

export interface JobRunView {
  id: string;
  title: string;
  /** One plain sentence; never "Completed", never a percentage. */
  headline: string;
  /** The status in one or two words (status is always text, never colour alone). */
  word: string;
  stages: JobStage[];
  result: JobResult;
  live: boolean;
  canCancel: boolean;
  canRetry: boolean;
  /** True while the job waits for the person (an approval). */
  needsYou: boolean;
  /** Reason codes cut out of the headline (`tests_failed`): never visible text, kept for a title attribute. */
  codes: string[];
}

const STAGES: { id: JobStageId; label: string }[] = [
  { id: 'queued', label: 'Queued' }, { id: 'provisioning', label: 'Sandbox' }, { id: 'running', label: 'Running' },
  { id: 'collecting', label: 'Collecting' }, { id: 'validating', label: 'Checking' }, { id: 'result', label: 'Result' }
];

export const STAGE_STATE_TEXT: Readonly<Record<JobStageState, string>> = Object.freeze({
  done: 'done', active: 'in progress', waiting: 'waiting', pending: 'not started', stopped: 'stopped here'
});

const LIVE_STATES: readonly JobState[] = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];
const RETRY_STATES: readonly JobState[] = ['failed', 'timed_out', 'cancelled', 'interrupted'];

/** Cancel only while the job is live (and not already asked to stop). */
export const canCancelJob = (j: Pick<JobView, 'state' | 'cancelRequested'>): boolean => LIVE_STATES.includes(j.state) && !j.cancelRequested;
/** Retry only after a failure, a timeout, a cancel or an interruption; a run whose checks failed is run again from its action. */
export const canRetryJob = (j: Pick<JobView, 'state'>): boolean => RETRY_STATES.includes(j.state);

const WAITING: Partial<Record<JobHeadline, string>> = {
  queued: 'Queued; it starts when a slot is free',
  'waiting:runner': 'Waiting: the execution runner is not running',
  'waiting:docker': 'Waiting: Docker is not running',
  'waiting:image': 'Waiting: the sandbox image is not prepared',
  'waiting:disk': 'Waiting: there is not enough free disk',
  'waiting:slots': 'Waiting: other runs are using every slot',
  'waiting:memory': 'Waiting: Docker memory is in use by other containers',
  'waiting:git': 'Waiting: git is not available',
  'waiting:retry': 'Waiting to try again after a passing fault'
};

type Flavour = 'tests' | 'discover' | 'build' | 'deps' | 'snapshot' | 'assemble' | 'preview' | 'diagnose' | 'check' | 'other';
function flavourOf(j: Pick<JobView, 'actionId' | 'recipeId' | 'kind'>): Flavour {
  const a = j.actionId ?? ''; const r = j.recipeId ?? '';
  if (a === 'sde.tests.run' || r === 'sde.test.node' || r === 'sde.test.pytest') return 'tests';
  if (a === 'sde.tests.discover' || r === 'sde.test.discover') return 'discover';
  if (a === 'sde.build.run' || r.startsWith('sde.build.')) return 'build';
  if (a === 'sde.deps.install' || r.startsWith('sde.deps.')) return 'deps';
  if (a === 'sde.repository.snapshot' || r === 'repo.snapshot') return 'snapshot';
  if (a === 'sde.app.assemble' || r === 'sde.app.assemble') return 'assemble';
  if (a === 'sde.preview.start' || r === 'sde.preview.start') return 'preview';
  if (a === 'sde.diagnose' || r === 'sde.diagnose') return 'diagnose';
  if (j.kind === 'validate') return 'check';
  return 'other';
}

const RAN: Record<Flavour, string> = {
  tests: 'Tests ran', discover: 'Tests were listed', build: 'The build ran', deps: 'Dependencies were installed', snapshot: 'The snapshot was taken',
  assemble: 'The application was assembled', preview: 'The dev deployment started', diagnose: 'The diagnosis ran', check: 'The check ran', other: 'The run ended'
};

/** Plain words for error codes whose main-side message is a bare label (B2a final fix round). */
export const CODE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  unreadable_output_entry: 'An output could not be read',
  start_window_unobserved: 'The app was closed or stalled while it started; start it again'
});

/** A reason from a record (a check summary, an error message): lower-cased first letter, no trailing full stop, and
 *  no reason code ("(tests_failed)" is cut out and kept in `codes`). */
function clause(reason: string | null | undefined, codes: string[] = []): string {
  const plain = plainSentence(reason);
  codes.push(...plain.codes);
  const t = plain.text.replace(/\.+$/, '');
  if (!t) return '';
  return `: ${t[0].toLowerCase()}${t.slice(1)}`;
}

/** The checks that gate leaving draft for what an action produces (the kinds of the step whose `via` names it). */
export function expectedChecksFor(actionId: string | null): string[] {
  if (!actionId) return [];
  const kinds = new Set<string>();
  for (const d of DOMAINS) for (const s of d.lifecycle) if (s.via.some((v) => 'userAction' in v && v.userAction === actionId)) s.produces.forEach((k) => kinds.add(k));
  return [...new Set([...kinds].flatMap((k) => blockingValidatorsFor(k).map((v) => v.id)))];
}

/**
 * The same rule as the rail's `awaiting_check` (stepState), for a job whose outputs are still being checked: true when
 * every check its draft outputs still lack runs only on something the user starts (a dev deployment), none failed,
 * and nothing that could run it is live (a dev deployment of those versions, or a job starting one).
 */
export function awaitingUserCheck(i: {
  expected: readonly string[];
  /** Per draft output version: its blocking results (#32), only validators that have a row. */
  outputs: readonly (readonly { validatorId: string; blocking: boolean; status: 'passed' | 'failed' | 'error' | 'skipped' | null }[])[];
  liveDeployments: number;
}): boolean {
  if (i.outputs.length === 0 || i.liveDeployments > 0) return false;
  return i.outputs.every((rows) => {
    const status = (id: string) => rows.find((r) => r.blocking && r.validatorId === id)?.status ?? null;
    if (i.expected.some((id) => status(id) === 'failed' || status(id) === 'error')) return false;
    return waitsOnUserAction(i.expected.filter((id) => status(id) !== 'passed'));
  });
}

/** The actions that start a dev deployment (the via of a step done by a healthy deployment record). */
export const DEPLOYMENT_ACTIONS: readonly string[] = Object.freeze(DOMAINS.flatMap((d) => d.lifecycle
  .filter((s) => 'record' in s.doneWhen && s.doneWhen.record === 'deployment_healthy')
  .flatMap((s) => s.via.flatMap((v) => ('userAction' in v ? [v.userAction] : [])))));

/** One application version, and the build it was assembled from (its `assembled_from` source; null when not read). */
export interface PreviewSubject { versionId: string; buildVersionId: string | null }
export interface LivePreview { status: 'starting' | 'healthy' | 'unhealthy'; startedAt: number }

const LIVE_DEPLOYMENT_STATUSES = new Set(['starting', 'healthy', 'unhealthy']);

/**
 * The live dev deployments of ONE application version, counted per version (never the project's): its own live
 * deployment rows, plus each live preview job that has no deployment row yet and runs that version's build (a preview
 * job's input is the build; its deployment row, which names the version, exists only once it is leased). Such a job
 * reads "starting". A deployment of another version, or a job whose row names another version, is never counted.
 */
export function livePreviewsOf(subject: PreviewSubject,
  deployments: readonly { jobId: string; subjectVersionId: string; status: string; startedAt: number }[],
  jobs: readonly Pick<JobView, 'id' | 'state' | 'actionId' | 'inputs' | 'createdAt'>[]): LivePreview[] {
  const out: LivePreview[] = deployments
    .filter((d) => d.subjectVersionId === subject.versionId && LIVE_DEPLOYMENT_STATUSES.has(d.status))
    .map((d) => ({ status: d.status as LivePreview['status'], startedAt: d.startedAt }));
  if (subject.buildVersionId) {
    const withRow = new Set(deployments.map((d) => d.jobId));
    for (const j of jobs) {
      if (!LIVE_STATES.includes(j.state) || j.actionId === null || !DEPLOYMENT_ACTIONS.includes(j.actionId) || withRow.has(j.id)) continue;
      if (j.inputs.some((x) => x.versionId === subject.buildVersionId)) out.push({ status: 'starting', startedAt: j.createdAt });
    }
  }
  return out;
}

/** The rail's words for a draft that waits for a preview. */
export const READY_TO_CHECK = 'Ready to check — start a preview';

/** The title: the action's words from the registry, else the check or the job kind. */
export function jobTitle(j: Pick<JobView, 'actionId' | 'recipeId' | 'kind'>): string {
  const a = j.actionId ? getUserAction(j.actionId) : null;
  if (a) return a.label;
  if (j.kind === 'agent.run') return 'Agent turn';
  if (j.kind === 'validate') return 'Check';
  if (j.kind === 'ingest') return 'Collect outputs';
  const r = j.recipeId ? RECIPE_TITLE[j.recipeId] : undefined;
  return r ?? j.recipeId ?? 'Run';
}

/** B2b: the plain title of the jobs the agent flow starts for itself (a raw recipe id is never a title). */
const RECIPE_TITLE: Readonly<Record<string, string>> = Object.freeze({
  'repo.worktree': 'Prepare the agent’s working copy', 'changeset.collect': 'Collect the change', 'changeset.merge_check': 'Check the change merges',
  'changeset.accept': 'Accept the change', 'changeset.accept_rollback': 'Undo an accept that did not finish', 'repo.ff': 'Merge accepted work'
});

/**
 * B2b: why a queued job waits when main holds it with a reason in `phase` (`waiting:consent`, ...): the headline alone says
 * only "queued". No host, model or number: the setup sheet holds those.
 */
export const WAIT_PHASE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'waiting:runtime': 'Waiting for the agent to be checked on this computer',
  'waiting:consent': 'Waiting for your network permission',
  'waiting:budget': 'Waiting for budget',
  'waiting:rate': 'Waiting: too many agent turns this hour',
  'waiting:approval': 'Waiting for your approval',
  'waiting:worktree': 'Waiting for the working copy to be prepared',
  'waiting:slots': 'Waiting for a free slot',
  'waiting:gc': 'Waiting: stored files are being cleaned up'
});
/** The sentence for a waiting phase, or null (not a phase this build words). */
export const waitPhaseText = (phase: string | null | undefined): string | null =>
  typeof phase === 'string' && Object.prototype.hasOwnProperty.call(WAIT_PHASE_TEXT, phase) ? WAIT_PHASE_TEXT[phase] : null;

/**
 * B2b: how an agent turn reads. A turn is not a run of checks: `partial` with outcome `no_change` is "The agent made no
 * change" (never done), and an ended turn says only that the agent ended it, never that its work is right (the change's
 * own checks say that). `error.message` is never shown: it is runtime text.
 */
export const AGENT_NO_CHANGE = 'The agent made no change';
const AGENT_FAIL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  runtime_auth: 'The agent could not sign in. Open Setup to check it',
  limit: 'The agent stopped at one of its limits (time, tokens, tool calls or budget)',
  runtime_protocol: 'The agent stopped after an answer Nexus could not read',
  runtime_error: 'The agent ended without a result'
});
export function agentTurnHeadline(j: Pick<JobView, 'state' | 'outcome' | 'phase' | 'headline' | 'cancelRequested'>): string {
  switch (j.state) {
    case 'queued': case 'retry_scheduled': return waitPhaseText(j.phase) ?? (j.headline === 'queued' ? 'Queued; it starts when a slot is free' : WAITING[j.headline] ?? 'Waiting to start');
    case 'leased': return 'Preparing the agent’s sandbox';
    case 'awaiting_approval': return 'Waiting for your approval';
    case 'running': return j.headline === 'waiting_for_approval' ? 'Waiting for your approval' : j.cancelRequested ? 'Stopping: cancel requested' : 'The agent is working';
    case 'completed': return j.outcome === 'no_change' ? AGENT_NO_CHANGE : 'The agent ended its turn and registered its work';
    case 'partial': return j.outcome === 'no_change' || j.outcome === null ? AGENT_NO_CHANGE : 'The agent’s turn ended in part';
    case 'failed': return (j.outcome && AGENT_FAIL_TEXT[j.outcome]) || 'The agent’s turn failed';
    case 'cancelled': return 'The agent’s turn was cancelled';
    case 'timed_out': return 'The agent ran past its time limit';
    case 'interrupted': return 'The agent was stopped before it ended its turn';
    default: return `Status: ${String(j.state).replace(/_/g, ' ')}`;
  }
}

function agentTurnRun(j: JobView): JobRunView {
  const ended = j.state === 'completed' || j.state === 'partial';
  const base = ended ? { stages: STAGES.map((s) => ({ ...s, state: 'done' as JobStageState })), result: null as JobResult } : stagesFor(j.headline, j.startedAt !== null);
  const live = LIVE_STATES.includes(j.state);
  const word = j.state === 'completed' ? 'Turn ended' : j.state === 'partial' ? (j.outcome === 'no_change' || j.outcome === null ? 'No change' : 'Ended in part')
    : j.state === 'failed' ? 'Failed' : j.state === 'cancelled' ? 'Cancelled' : j.state === 'timed_out' ? 'Timed out' : j.state === 'interrupted' ? 'Interrupted'
      : j.state === 'awaiting_approval' || j.headline === 'waiting_for_approval' ? 'Waiting for you' : j.state === 'running' ? 'Working'
        : j.state === 'leased' ? 'In progress' : 'Waiting';
  const result: JobResult = j.state === 'failed' ? 'failed_run' : j.state === 'cancelled' ? 'cancelled' : j.state === 'timed_out' ? 'timed_out' : j.state === 'interrupted' ? 'interrupted' : base.result;
  return { id: j.id, title: jobTitle(j), headline: agentTurnHeadline(j), word, stages: base.stages, result, live, canCancel: canCancelJob(j), canRetry: false,
    needsYou: j.state === 'awaiting_approval' || j.headline === 'waiting_for_approval', codes: [] };
}

function stagesFor(h: JobHeadline, started: boolean): { stages: JobStage[]; result: JobResult } {
  const at = (active: JobStageId, state: JobStageState, result: JobResult = null): { stages: JobStage[]; result: JobResult } => {
    const i = STAGES.findIndex((s) => s.id === active);
    return { stages: STAGES.map((s, k) => ({ ...s, state: k < i ? 'done' : k === i ? state : 'pending' })), result };
  };
  const all = (result: JobResult): { stages: JobStage[]; result: JobResult } =>
    ({ stages: STAGES.map((s) => ({ ...s, state: s.id === 'result' ? 'stopped' : 'done' })), result });
  switch (h) {
    case 'queued': return at('queued', 'active');
    case 'provisioning': return at('provisioning', 'active');
    case 'running': return at('running', 'active');
    case 'waiting_for_approval': return at('running', 'waiting');
    case 'collecting': return at('collecting', 'active');
    case 'validating': return at('validating', 'active');
    case 'checks_passed': return { stages: STAGES.map((s) => ({ ...s, state: 'done' })), result: 'passed' };
    case 'checks_failed': return all('failed');
    case 'checks_could_not_run': return all('could_not_run');
    case 'failed': case 'cancelled': case 'timed_out': case 'interrupted': {
      const result: JobResult = h === 'failed' ? 'failed_run' : h;
      return at(started ? 'running' : 'queued', 'stopped', result);
    }
    default: return at('queued', 'waiting'); // waiting:* (before the sandbox exists)
  }
}

const KNOWN = new Set<string>(['queued', 'waiting:runner', 'waiting:docker', 'waiting:image', 'waiting:disk', 'waiting:slots', 'waiting:memory',
  'waiting:git', 'waiting:retry', 'provisioning', 'running', 'waiting_for_approval', 'collecting', 'validating', 'checks_passed', 'checks_failed',
  'checks_could_not_run', 'failed', 'cancelled', 'timed_out', 'interrupted']);

const RESULT_WORD: Record<Exclude<JobResult, null>, string> = {
  passed: 'Checks passed', failed: 'Checks failed', could_not_run: 'Checks could not run', failed_run: 'Failed', cancelled: 'Cancelled',
  timed_out: 'Timed out', interrupted: 'Interrupted'
};

/**
 * The run view of a job. `reason` is a sourced sentence when the caller has one (the first failed check's summary of
 * an output, or the job's own error); without it the headline stops at what the headline itself knows.
 */
export function jobRun(j: JobView, o: { reason?: string | null; awaitingCheck?: boolean } = {}): JobRunView {
  if (j.kind === 'agent.run') return agentTurnRun(j);
  const h = j.headline;
  const f = flavourOf(j);
  const reason = o.reason ?? (j.error ? CODE_WORDS[j.error.code] ?? j.error.message : null);
  const codes: string[] = [];
  // Its outputs wait only for a check the user starts (awaitingUserCheck): nothing is checking, it waits for a preview.
  const awaiting = h === 'validating' && o.awaitingCheck === true;
  const base = stagesFor(h, j.startedAt !== null);
  const stages = awaiting ? base.stages.map((s) => (s.id === 'validating' ? { ...s, state: 'waiting' as const } : s)) : base.stages;
  const result = base.result;
  let headline: string;
  if (h === 'queued' && waitPhaseText(j.phase)) headline = waitPhaseText(j.phase)!;
  else if (WAITING[h]) headline = WAITING[h]!;
  else if (h === 'waiting_for_approval') headline = f === 'deps' ? 'Waiting for your approval to download dependencies' : 'Waiting for your approval';
  else if (h === 'provisioning') headline = 'Preparing the sandbox';
  else if (h === 'running') headline = j.cancelRequested ? 'Stopping: cancel requested' : 'Running';
  else if (h === 'collecting') headline = 'Collecting the outputs';
  else if (awaiting) headline = `${RAN[f]}; ${READY_TO_CHECK[0].toLowerCase()}${READY_TO_CHECK.slice(1)}`;
  else if (h === 'validating') headline = `${RAN[f]}; checking the results`;
  else if (h === 'checks_passed') headline = `${RAN[f]}; checks passed`;
  else if (h === 'checks_failed') headline = `${RAN[f]}; checks failed${clause(o.reason, codes)}`;
  else if (h === 'checks_could_not_run') headline = `${RAN[f]}; checks could not run${clause(o.reason, codes)}`;
  else if (h === 'cancelled') headline = 'Cancelled';
  else if (h === 'timed_out') headline = `Stopped: it ran past its time limit${clause(reason, codes)}`;
  else if (h === 'interrupted') headline = 'Interrupted: the app stopped while it ran';
  else if (h === 'failed') headline = `Failed${clause(reason, codes)}`;
  // A headline this build does not know (a newer main): neutral words, never a verdict.
  else headline = `Status: ${String(j.state).replace(/_/g, ' ')}`;
  const live = LIVE_STATES.includes(j.state);
  const known = KNOWN.has(h);
  const word = result ? RESULT_WORD[result] : h === 'waiting_for_approval' ? 'Waiting for you' : awaiting ? 'Ready to check' : h === 'validating' ? 'Checking'
    : !known ? 'Status unknown' : live ? (h.startsWith('waiting') || h === 'queued' ? 'Waiting' : 'In progress') : 'Ended';
  return {
    id: j.id, title: jobTitle(j), headline, word, stages, result, live,
    canCancel: canCancelJob(j), canRetry: canRetryJob(j), needsYou: h === 'waiting_for_approval', codes
  };
}
