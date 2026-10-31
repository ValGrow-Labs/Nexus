// Pure: a persisted job (JobView, #26/#27) as a run strip and one plain sentence.
// The stages come from main's headline only; a job never reads "Completed" when
// the checks on what it made failed, and no percentage is ever shown (main
// reports no step counts in B2a, so there is nothing to compute one from).
// Words for people: a job is a "task", an agent turn is a "request" to the AI helper, and the reason a task ended comes from a
// plain table keyed by its error CODE (CODE_WORDS, CODE_NEXT). The message main stored with the error is never shown.
import type { JobHeadline, JobView } from '@shared/nexus/ipc';
import type { JobState } from '@shared/nexus/platform';
import { getUserAction } from '@shared/nexus/actions';
import { DOMAINS } from '@shared/nexus/domains';
import { blockingValidatorsFor } from '@shared/nexus/validators';
import { waitsOnUserAction } from '@shared/nexus/stepState';
import { plainSentence } from '../project/evidenceModel';
import { AGENT_REASON_TEXT, SETUP_TEXT } from '../data/errorCopy';
import { GLOSSARY } from '../data/glossary';

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
  /** One plain next step for the person (what to do, or what happens by itself), or null when there is nothing to do or say. */
  next: string | null;
  /** Reason codes cut out of the headline (`tests_failed`): never visible text, kept for a title attribute. */
  codes: string[];
}

const STAGES: { id: JobStageId; label: string }[] = [
  { id: 'queued', label: 'Waiting' }, { id: 'provisioning', label: 'Safe space' }, { id: 'running', label: 'Running' },
  { id: 'collecting', label: 'Saving results' }, { id: 'validating', label: 'Checking' }, { id: 'result', label: 'Result' }
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

export const QUEUED_TEXT = 'Waiting to start. It starts as soon as there is room';
const WAITING: Partial<Record<JobHeadline, string>> = {
  queued: QUEUED_TEXT,
  'waiting:runner': 'Waiting: the part of Nexus that runs tasks is not running yet',
  'waiting:docker': 'Waiting: Docker is not running',
  'waiting:image': 'Waiting: the safe-space kit has not been downloaded yet',
  'waiting:disk': 'Waiting: there is not enough free space on your disk',
  'waiting:slots': 'Waiting: other tasks are using all the room',
  'waiting:memory': 'Waiting: Docker is using all of its memory for other tasks',
  'waiting:git': 'Waiting: Git is not available',
  'waiting:retry': 'Waiting to try again after a short problem'
};
/** What to do (or what happens by itself) while a task waits, by what it waits for. */
const WAITING_NEXT: Partial<Record<JobHeadline, string>> = {
  queued: 'Nothing to do. It starts by itself.',
  'waiting:runner': 'Nothing to do yet. If this stays, restart Nexus.',
  'waiting:docker': 'Start Docker Desktop. The task carries on by itself.',
  'waiting:image': `Open “${GLOSSARY.getReady.name}” to download it.`,
  'waiting:disk': 'Free some space on your disk. The task carries on by itself.',
  'waiting:slots': 'Nothing to do. It starts when another task finishes.',
  'waiting:memory': 'Nothing to do. It starts when another task finishes.',
  'waiting:git': 'Install Git, a free program. The task carries on by itself.',
  'waiting:retry': 'Nothing to do. Nexus tries again by itself.'
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
  tests: 'Tests ran', discover: 'The tests were found', build: 'The build ran', deps: 'The add-ons your project needs were installed', snapshot: 'Nexus saved a starting point',
  assemble: 'The app was put together', preview: 'The test run of your app started', diagnose: 'The search for what went wrong ran', check: 'The check ran', other: 'The task ended'
};

/**
 * Plain words for the CODE a task or request ended with (never the message main stored with it: that is its own technical text
 * and is not shown). One sentence for what happened, in CODE_WORDS; one plain next step in CODE_NEXT (a code with no entry in
 * CODE_NEXT has nothing for the person to do). A code this build does not know reads the generic pair (UNKNOWN_WORDS).
 * The setup and git sentences are the ones the error tables already say, so a person reads the same words everywhere.
 */
const GET_READY = `“${GLOSSARY.getReady.name}”`;
export const CODE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  // The runner and the queue.
  runner_lost: 'Nexus lost contact with the part of the app that runs tasks, so this task stopped',
  not_sent: 'Nexus could not hand this task to the part of the app that runs it',
  limits_not_applied: 'Nexus could not set safe limits for this task, so it did not start',
  bad_plan: 'Nexus could not set this task up',
  busy: 'Nexus was busy with other tasks, so this one did not start',
  unknown_attempt: 'Nexus lost track of this try',
  input_changed: 'A saved item this task uses changed after the task was chosen',
  timeout: 'Nexus waited too long for an answer',
  timed_out: 'It ran for longer than its time limit, so Nexus stopped it',
  interrupted: 'Nexus stopped while this task was running',
  cancelled: 'It was stopped before it finished',
  stopped: 'It was stopped before it was ready',
  // The safe space and its command.
  container_vanished: 'The safe space disappeared while the task was running',
  oom: 'It ran out of memory, so Nexus stopped it',
  nonzero_exit: 'The command it ran ended with an error',
  outputs_missing: 'The task ended, but it did not make what was expected',
  exited: 'Your app stopped before it was ready',
  exit_not_reported: 'Nexus closed while your app was running, so it could not tell how the run ended',
  probe_failed: 'Your app did not answer in time',
  start_window_unobserved: 'Nexus was closed or stalled while your app was starting, so it could not tell if the app started',
  build_failed: 'Nexus could not build the safe-space kit',
  // Saving the results.
  no_evidence: 'The task ended, but Nexus could not save its results',
  ingest_error: 'Nexus could not save the results of this task',
  ingest_unavailable: 'This version of Nexus cannot save the results of tasks',
  constraint: 'Nexus could not save the results of this task',
  unreadable_output_entry: 'One of the files the task made could not be read',
  symlink: 'The task made a shortcut to another place, which Nexus does not save',
  hardlink: 'The task made a shared link to a file, which Nexus does not save',
  special_file: 'The task made a file of a kind Nexus does not save',
  bad_name: 'The task made a file with a name Nexus cannot save',
  file_locked: 'A file the task made was still in use, so Nexus could not read it',
  too_many_files: 'The task made too many files to save',
  output_too_large: 'The task made a file that is too large to save',
  workspace_too_large: 'The task made more files than Nexus can save',
  secret_in_report: 'What the task made looked like it holds a password or secret key, so Nexus did not save it',
  secret_in_output: 'What the task made looked like it holds a password or secret key, so Nexus did not save it',
  // Your OK and the internet.
  network_not_approved: 'Nexus did not have your OK to use the internet for this task',
  approvals_unavailable: 'Asking for your OK is not available in this version of Nexus, so the task could not start',
  approval_stale: 'The OK you gave ran out before the task could start',
  approval_expired: 'Nobody answered the question in time, so the task did not run',
  approval_denied: 'You said no, so the task did not run',
  deployment_refused: 'Nexus could not start the test run of your app',
  not_in_this_build: 'Test runs of your app are not available in this version of Nexus',
  // Needs from this computer: the same sentences as the setup table.
  docker_missing: SETUP_TEXT.docker_missing,
  docker_stopped: SETUP_TEXT.docker_stopped,
  image_missing: SETUP_TEXT.image_missing,
  image_mismatch: SETUP_TEXT.image_mismatch,
  disk_low: SETUP_TEXT.disk_low,
  git_missing: SETUP_TEXT.git_missing,
  // The AI helper's own endings.
  runtime_error: 'The AI helper stopped without finishing',
  runtime_auth: 'The AI helper could not sign in',
  runtime_protocol: 'The AI helper stopped after an answer Nexus could not read',
  limit: 'The AI helper stopped at one of its limits (time, number of steps, size of the job or cost)',
  session_ended: 'The conversation ended before this request could start',
  agents_unavailable: AGENT_REASON_TEXT.agents_unavailable.replace(/\.$/, ''),
  consent_revoked: 'You took back the internet permission, so the AI helper was stopped',
  hosted_key_missing: 'The access key was deleted, so the AI helper was stopped',
  worktree_guard: 'The AI helper tried to change something outside its safe copy, so it was stopped. Nothing was kept',
  proxy_failed: 'The AI helper’s link to the internet could not start',
  denied: 'The AI helper was stopped because you said no to what it asked',
  expired: 'The AI helper was stopped because what it asked was not answered in time',
  // The git write failures a task can end with (main words these too; the same sentences).
  bad_task: 'Nexus stopped this step because its own instructions were not in the right form',
  repo_layout_unsupported: 'This project’s history is not kept in a normal folder, so Nexus cannot make a safe copy of the project',
  repo_empty: 'This project has no saved versions yet',
  branch_missing: 'Your project’s main version, the one Nexus works from, is no longer there',
  worktree_tampered: 'The link between the AI helper’s safe copy and your project was changed, so Nexus stopped and saved nothing',
  worktree_conflict: 'Nexus could not give the AI helper’s safe copy the name it expected, so it stopped',
  link_or_gitlink: 'The changes include a shortcut to another place, or a whole project inside your project, which Nexus does not save',
  unknown_commit: 'A saved version that Nexus recorded is no longer in your project',
  git_failed: 'Git could not finish the work. Nothing was changed',
  symlink_in_worktree: 'The AI helper’s safe copy holds a shortcut to another place, so Nexus stopped and saved nothing',
  nested_repo: 'The AI helper’s safe copy holds a project inside the project, so Nexus stopped and saved nothing',
  worktree_too_large: 'The AI helper’s safe copy is larger than Nexus allows (about 8 GB), so nothing was saved',
  file_too_large: 'A file in the AI helper’s safe copy is larger than Nexus allows (about 50 MB), so nothing was saved'
});

/** The one plain next step for a code. A code that is not here has nothing for the person to do beyond what its sentence says. */
export const CODE_NEXT: Readonly<Record<string, string>> = Object.freeze({
  runner_lost: 'Press Retry.',
  not_sent: 'Press Retry.',
  limits_not_applied: `Open ${GET_READY}, check again, then press Retry.`,
  bad_plan: 'Press Retry. If it fails again, contact support.',
  busy: 'Wait a moment, then press Retry.',
  unknown_attempt: 'Press Retry.',
  input_changed: 'Start the task again.',
  timeout: 'Press Retry.',
  timed_out: 'Press Retry, or ask for something smaller.',
  interrupted: 'Press Retry.',
  cancelled: 'Press Retry to run it again.',
  stopped: 'Start the test run again.',
  container_vanished: 'Check that Docker is still running, then press Retry.',
  oom: `Close other programs or give Docker more memory in ${GET_READY}, then press Retry.`,
  nonzero_exit: 'Open the log to see what went wrong, then press Retry.',
  outputs_missing: 'Open the log to see what went wrong, then press Retry.',
  exited: 'Open the log to see why, then start it again.',
  exit_not_reported: 'Start the test run again.',
  probe_failed: 'Open the log to see why, then start it again.',
  start_window_unobserved: 'Start the test run again.',
  build_failed: `Check your internet connection, then try again in ${GET_READY}.`,
  no_evidence: 'Press Retry.',
  ingest_error: 'Press Retry.',
  ingest_unavailable: 'Update Nexus, or contact support.',
  constraint: 'Press Retry.',
  unreadable_output_entry: 'Press Retry. If it fails again, open the log to see what the task made.',
  symlink: 'Change the task so it does not make shortcuts, then run it again.',
  hardlink: 'Change the task so it does not make shared links, then run it again.',
  special_file: 'Change the task so it only makes normal files, then run it again.',
  bad_name: 'Change the task so it uses plain file names, then run it again.',
  file_locked: 'Press Retry.',
  too_many_files: 'Change the task so it makes fewer files, then run it again.',
  output_too_large: 'Change the task so it makes smaller files, then run it again.',
  workspace_too_large: 'Change the task so it makes fewer files, then run it again.',
  secret_in_report: 'Take the secret out of what the task makes, then run it again.',
  secret_in_output: 'Take the secret out of what the task makes, then run it again.',
  network_not_approved: 'Start the task again and say yes when Nexus asks.',
  approvals_unavailable: 'Update Nexus, or contact support.',
  approval_stale: 'Start the task again and say yes again.',
  approval_expired: 'Start the task again and answer when Nexus asks.',
  approval_denied: 'Start the task again if you change your mind.',
  deployment_refused: 'Try again.',
  runtime_error: 'Ask the AI helper again.',
  not_in_this_build: 'Update Nexus to use this, or contact support.',
  repo_layout_unsupported: 'Ask a developer to look at how this project is stored.',
  worktree_tampered: 'Try again.',
  worktree_conflict: 'Try again.',
  link_or_gitlink: 'Take those shortcuts out of the changes, then ask again.',
  symlink_in_worktree: 'Ask again without shortcuts to other places.',
  nested_repo: 'Ask again without a project inside the project.',
  agents_unavailable: `Open ${GET_READY} to see why.`,
  runtime_auth: `Open ${GET_READY} and check it.`,
  runtime_protocol: `Ask again. If it keeps happening, choose another AI service in ${GET_READY}.`,
  limit: 'Ask for something smaller, or try again later.',
  session_ended: 'Start a new conversation.',
  consent_revoked: `Allow it again in ${GET_READY}, then ask again.`,
  hosted_key_missing: 'Add your access key in Settings, then ask again.',
  worktree_guard: 'Ask again, or ask for something different.',
  proxy_failed: `Try again in ${GET_READY}.`,
  denied: 'Ask again if you change your mind.',
  expired: 'Ask again, and answer when it asks.',
  bad_task: 'Press Retry. If it fails again, contact support.',
  repo_empty: 'Save a first version of your project in Git, then ask again.',
  branch_missing: 'Save a new starting point, then ask again.',
  unknown_commit: 'Ask the AI helper to do the work again.',
  git_failed: 'Try again.',
  worktree_too_large: 'Ask for something smaller.',
  file_too_large: 'Ask for something smaller.'
});

/** The generic pair for a code this build has no words for: honest (it says it does not know) and still gives a way forward. */
export const UNKNOWN_WORDS = Object.freeze({
  text: 'Something went wrong while this ran',
  next: `Press Retry. If it fails again, open ${GET_READY} to check this computer, or contact support.`
});

/** The plain sentence and next step for an error code. Never the message stored with the error. */
export function codeWords(code: string | null | undefined): { text: string; next: string | null; known: boolean } {
  const known = typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODE_WORDS, code);
  if (!known) return { text: UNKNOWN_WORDS.text, next: UNKNOWN_WORDS.next, known: false };
  const next = Object.prototype.hasOwnProperty.call(CODE_NEXT, code as string) ? CODE_NEXT[code as string] : null;
  return { text: CODE_WORDS[code as string], next, known: true };
}

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
export const READY_TO_CHECK = 'Ready to check: start a test run of your app';

/** The title: the action's words from the registry, else the check or the job kind. */
export function jobTitle(j: Pick<JobView, 'actionId' | 'recipeId' | 'kind'>): string {
  const a = j.actionId ? getUserAction(j.actionId) : null;
  if (a) return a.label;
  if (j.kind === 'agent.run') return 'Request to the AI helper';
  if (j.kind === 'validate') return 'Check';
  if (j.kind === 'ingest') return 'Save the results';
  const r = j.recipeId ? RECIPE_TITLE[j.recipeId] : undefined;
  return r ?? j.recipeId ?? 'Run';
}

/** B2b: the plain title of the tasks the AI helper flow starts for itself (a raw recipe id is never a title). */
const RECIPE_TITLE: Readonly<Record<string, string>> = Object.freeze({
  'repo.worktree': `Get the AI helper’s ${GLOSSARY.safeCopy.name} ready`, 'changeset.collect': 'Collect what the AI helper changed',
  'changeset.merge_check': 'Check that the changes fit your project', 'changeset.accept': `${GLOSSARY.keepChanges.name}`,
  'changeset.accept_rollback': 'Undo a step that did not finish', 'repo.ff': `${GLOSSARY.addToProject.name}`
});

/**
 * B2b: why a queued job waits when main holds it with a reason in `phase` (`waiting:consent`, ...): the headline alone says
 * only "queued". No host, model or number: the setup sheet holds those.
 */
export const WAIT_PHASE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'waiting:runtime': 'Waiting for the AI helper to be checked on this computer',
  'waiting:consent': 'Waiting for your internet permission',
  'waiting:budget': 'Waiting: the AI helper has used its limit for today',
  'waiting:rate': 'Waiting: too many requests this hour',
  'waiting:approval': 'Waiting for your OK',
  'waiting:worktree': `Waiting for the ${GLOSSARY.safeCopy.name} to be ready`,
  'waiting:slots': 'Waiting for room to start',
  'waiting:gc': 'Waiting: Nexus is tidying up stored files'
});
/** What to do, or what happens by itself, while a request waits for each reason. */
export const WAIT_PHASE_NEXT: Readonly<Record<string, string>> = Object.freeze({
  'waiting:runtime': `Open “${GLOSSARY.getReady.name}” and check again.`,
  'waiting:consent': `Open “${GLOSSARY.getReady.name}” and allow it. The request starts by itself after that.`,
  'waiting:budget': 'Nothing to do. It starts again tomorrow.',
  'waiting:rate': 'Nothing to do. It starts when the hour is up.',
  'waiting:approval': 'Answer the question on this page.',
  'waiting:worktree': 'Nothing to do. It starts by itself.',
  'waiting:slots': 'Nothing to do. It starts when another task finishes.',
  'waiting:gc': 'Nothing to do. It starts by itself.'
});
/** The sentence for a waiting phase, or null (not a phase this build words). */
export const waitPhaseText = (phase: string | null | undefined): string | null =>
  typeof phase === 'string' && Object.prototype.hasOwnProperty.call(WAIT_PHASE_TEXT, phase) ? WAIT_PHASE_TEXT[phase] : null;

/**
 * B2b: how a request to the AI helper (an agent turn) reads. A request is not a run of checks: `partial` with outcome
 * `no_change` is "The AI helper made no changes" (never done), and an ended request says only that the AI helper handed in its
 * suggested changes, never that they are right (the checks on the changes say that). `error.message` is never shown: it is
 * the runtime's own text. The reason a request failed is a plain sentence by its outcome or error CODE.
 */
export const AGENT_NO_CHANGE = 'The AI helper made no changes';
/** The sentence for a request that failed: the fixed sentence of the reason (which already says what to do), else the plain words for its code. */
function failedText(outcome: string | null, code: string | null | undefined): { text: string; stepInside: boolean } | null {
  const own = (k: string | null | undefined): { text: string; stepInside: boolean } | null => {
    if (typeof k !== 'string') return null;
    if (Object.prototype.hasOwnProperty.call(AGENT_REASON_TEXT, k)) return { text: AGENT_REASON_TEXT[k].replace(/\.$/, ''), stepInside: true };
    if (Object.prototype.hasOwnProperty.call(CODE_WORDS, k)) return { text: CODE_WORDS[k].replace(/\.$/, ''), stepInside: false };
    return null;
  };
  // A request that ran and then failed in the AI service is not "could not check the AI helper" (that sentence is for the setup check,
  // and its advice, "check again", does not help here).
  if (outcome === 'runtime_error') return { text: AGENT_STOPPED_PARTWAY, stepInside: false };
  return own(outcome) ?? own(code);
}
export const AGENT_STOPPED_PARTWAY = 'The AI service stopped partway through your request';
export const AGENT_STOPPED_PARTWAY_NEXT = 'Ask again. If it keeps happening, choose another AI model in Settings.';
type TurnLike = Pick<JobView, 'state' | 'outcome' | 'phase' | 'headline' | 'cancelRequested'> & Partial<Pick<JobView, 'error'>>;
export function agentTurnHeadline(j: TurnLike): string {
  switch (j.state) {
    case 'queued': case 'retry_scheduled': return waitPhaseText(j.phase) ?? (j.headline === 'queued' ? QUEUED_TEXT : WAITING[j.headline] ?? 'Waiting to start');
    case 'leased': return 'Getting the AI helper’s safe space ready';
    case 'awaiting_approval': return 'Waiting for your OK';
    case 'running': return j.headline === 'waiting_for_approval' ? 'Waiting for your OK' : j.cancelRequested ? 'Stopping: you asked it to stop' : 'The AI helper is working on your request';
    case 'completed': return j.outcome === 'no_change' ? AGENT_NO_CHANGE : 'The AI helper handed in its suggested changes';
    // Only the recorded outcome `no_change` says the AI helper changed nothing; a partial request without it says only that it stopped early.
    case 'partial': return j.outcome === 'no_change' ? AGENT_NO_CHANGE : 'The AI helper stopped early. Nexus did not keep a record of what it changed';
    case 'failed': return failedText(j.outcome, j.error?.code)?.text ?? 'The request did not work';
    case 'cancelled': return 'The request was stopped';
    case 'timed_out': return 'The AI helper ran out of time and was stopped';
    case 'interrupted': return 'The AI helper was stopped early';
    default: return `Status: ${String(j.state).replace(/_/g, ' ')}`;
  }
}

/** The one plain next step after (or during) a request: what to do, or what happens by itself. Null when the sentence already says it. */
export function agentTurnNext(j: TurnLike): string | null {
  switch (j.state) {
    case 'queued': case 'retry_scheduled': return (typeof j.phase === 'string' && WAIT_PHASE_NEXT[j.phase]) || WAITING_NEXT[j.headline] || 'Nothing to do. It starts by itself.';
    case 'leased': return 'Nothing to do. It starts by itself.';
    case 'awaiting_approval': return 'Answer the question on this page.';
    case 'running': return j.headline === 'waiting_for_approval' ? 'Answer the question on this page.' : 'Nothing to do. You can keep using Nexus.';
    case 'completed': return j.outcome === 'no_change' ? 'Ask again and say more about what you want.'
      : `Look over the suggested changes. Press “${GLOSSARY.looksGood.name}” if you are happy with them.`;
    case 'partial': return j.outcome === 'no_change' ? 'Ask again and say more about what you want.' : 'Ask the AI helper again.';
    case 'failed': {
      const f = failedText(j.outcome, j.error?.code);
      if (f?.stepInside) return null;
      if (j.outcome === 'runtime_error') return AGENT_STOPPED_PARTWAY_NEXT;
      const k = [j.outcome, j.error?.code].find((x): x is string => typeof x === 'string' && Object.prototype.hasOwnProperty.call(CODE_NEXT, x));
      return k ? CODE_NEXT[k] : 'Ask the AI helper again.';
    }
    case 'cancelled': return 'Ask again when you are ready.';
    case 'timed_out': return CODE_NEXT.limit;
    case 'interrupted': return 'Ask the AI helper again.';
    default: return null;
  }
}

function agentTurnRun(j: JobView): JobRunView {
  const live = LIVE_STATES.includes(j.state);
  const word = j.state === 'completed' ? (j.outcome === 'no_change' ? 'No changes' : 'Changes ready to look over') : j.state === 'partial' ? (j.outcome === 'no_change' ? 'No changes' : 'Stopped early')
    : j.state === 'failed' ? 'Failed' : j.state === 'cancelled' ? 'Stopped' : j.state === 'timed_out' ? 'Ran out of time' : j.state === 'interrupted' ? 'Stopped early'
      : j.state === 'awaiting_approval' || j.headline === 'waiting_for_approval' ? 'Waiting for you' : j.state === 'running' ? 'Working'
        : j.state === 'leased' ? 'Getting ready' : 'Waiting';
  const result: JobResult = j.state === 'failed' ? 'failed_run' : j.state === 'cancelled' ? 'cancelled' : j.state === 'timed_out' ? 'timed_out' : j.state === 'interrupted' ? 'interrupted' : null;
  return { id: j.id, title: jobTitle(j), headline: agentTurnHeadline(j), word,
    // A request is not a run of checks: it has no safe space, saving and checking ladder to show, so no stage is claimed.
    stages: [], result, live, canCancel: canCancelJob(j), canRetry: false,
    needsYou: j.state === 'awaiting_approval' || j.headline === 'waiting_for_approval', next: agentTurnNext(j), codes: [] };
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
  timed_out: 'Ran out of time', interrupted: 'Stopped early'
};

/**
 * The run view of a job. `reason` is a sourced sentence when the caller has one (the first failed check's summary of
 * an output, or the job's own error); without it the headline stops at what the headline itself knows.
 */
export function jobRun(j: JobView, o: { reason?: string | null; awaitingCheck?: boolean } = {}): JobRunView {
  if (j.kind === 'agent.run') return agentTurnRun(j);
  const h = j.headline;
  const f = flavourOf(j);
  // The reason a task ended is the plain words for its error CODE; the message stored with the error is never shown.
  const why = codeWords(j.error ? j.error.code : null);
  const ended = (lead: string): string => (j.error ? `${lead}: ${why.text.replace(/\.$/, '')}` : lead);
  const codes: string[] = [];
  // Its outputs wait only for a check the user starts (awaitingUserCheck): nothing is checking, it waits for a test run.
  const awaiting = h === 'validating' && o.awaitingCheck === true;
  const base = stagesFor(h, j.startedAt !== null);
  const stages = awaiting ? base.stages.map((s) => (s.id === 'validating' ? { ...s, state: 'waiting' as const } : s)) : base.stages;
  const result = base.result;
  let headline: string;
  let next: string | null = null;
  if (h === 'queued' && waitPhaseText(j.phase)) { headline = waitPhaseText(j.phase)!; next = WAIT_PHASE_NEXT[j.phase as string] ?? null; }
  else if (WAITING[h]) { headline = WAITING[h]!; next = WAITING_NEXT[h] ?? null; }
  else if (h === 'waiting_for_approval') { headline = f === 'deps' ? 'Waiting for your OK to download the add-ons your project needs' : 'Waiting for your OK'; next = 'Say yes or no to the question about it.'; }
  else if (h === 'provisioning') { headline = 'Getting the safe space ready'; next = 'Nothing to do. It carries on by itself.'; }
  else if (h === 'running') { headline = j.cancelRequested ? 'Stopping: you asked it to stop' : 'Running'; next = j.cancelRequested ? null : 'Nothing to do. You can keep using Nexus.'; }
  else if (h === 'collecting') { headline = 'Saving the results'; next = 'Nothing to do. It carries on by itself.'; }
  else if (awaiting) { headline = `${RAN[f]}; ${READY_TO_CHECK[0].toLowerCase()}${READY_TO_CHECK.slice(1)}`; next = 'Start a test run of your app so the last checks can run.'; }
  else if (h === 'validating') { headline = `${RAN[f]}; checking the results`; next = 'Nothing to do. It carries on by itself.'; }
  else if (h === 'checks_passed') headline = `${RAN[f]}; checks passed`;
  else if (h === 'checks_failed') { headline = `${RAN[f]}; checks failed${clause(o.reason, codes)}`; next = 'Open the log to see what went wrong, then run it again.'; }
  else if (h === 'checks_could_not_run') { headline = `${RAN[f]}; checks could not run${clause(o.reason, codes)}`; next = 'Open the log to see why, then run it again.'; }
  else if (h === 'cancelled') { headline = 'Cancelled'; next = CODE_NEXT.cancelled; }
  else if (h === 'timed_out') { headline = j.error ? `Stopped: ${why.text.replace(/\.$/, '')}` : 'Stopped: it ran for longer than its time limit'; next = j.error ? why.next : CODE_NEXT.timed_out; }
  else if (h === 'interrupted') { headline = 'Stopped: Nexus closed while it ran'; next = CODE_NEXT.interrupted; }
  else if (h === 'failed') { headline = ended('Failed'); next = j.error ? why.next : UNKNOWN_WORDS.next; }
  // A headline this build does not know (a newer main): neutral words, never a verdict.
  else headline = `Status: ${String(j.state).replace(/_/g, ' ')}`;
  const live = LIVE_STATES.includes(j.state);
  const known = KNOWN.has(h);
  const word = result ? RESULT_WORD[result] : h === 'waiting_for_approval' ? 'Waiting for you' : awaiting ? 'Ready to check' : h === 'validating' ? 'Checking'
    : !known ? 'Status unknown' : live ? (h.startsWith('waiting') || h === 'queued' ? 'Waiting' : 'In progress') : 'Ended';
  return {
    id: j.id, title: jobTitle(j), headline, word, stages, result, live,
    canCancel: canCancelJob(j), canRetry: canRetryJob(j), needsYou: h === 'waiting_for_approval', next, codes
  };
}
