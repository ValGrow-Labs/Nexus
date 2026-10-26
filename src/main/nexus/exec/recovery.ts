/**
 * Restart recovery (B2a Task 10: the plan's R.2, adapted; constraints 9, 10 and 13).
 *
 * SQLite is the only authority. What the runner reports at reconcile (a container's state, its exit from `docker
 * inspect`, the staged `/out`, the labelled Docker resources) only INFORMS a decision; none of it is stored as state.
 * No recovery decision ever completes a job or makes a version a candidate: a job completes only through ingest (an
 * exit the runner reports with its outputs, committed with the attempt's success), and a version becomes a candidate
 * only through the finalize rule over recorded validator results.
 *
 * Every decision is ONE small IMMEDIATE transaction. It moves the attempt and the job through the execution core's own
 * helpers (so each move keeps its own `job.transition` / `attempt.transition` rows), always ends a live attempt BEFORE
 * its job moves (the v9 backstop trigger), never moves the attempt count back, and writes exactly ONE `exec.recover`
 * activity row and exactly ONE `job_events` row of type `recovery`. A decision that throws rolls back alone, is logged
 * and counted; recovery never throws past its authorization check, so platform startup always reaches `ready`.
 *
 * Phase A (`recoverPhaseA`): platform startup, database only, no runner. Every `leased`, `running` and
 * `awaiting_approval` job:
 *   - no live attempt (an agent run, a B0b job): B1's rule (JobService.recoverJobTx): leased -> queued, else interrupted;
 *   - waiting for approval: a pending, unexpired approval (or one already consumed by this attempt, waiting for the
 *     scheduler) keeps waiting and its attempt is re-owned by this boot; an expired one expires now and the job fails
 *     `denied` (attempt failed); anything else interrupts the job;
 *   - an engine attempt (snapshot, assemble, diagnose; the work lived in the dead runner): abandoned; a leased job goes
 *     back to queued, a running one to retry_scheduled when its recipe is idempotent with attempts left, else interrupted;
 *     a B2b git recipe follows its stated `recovery` class (`interrupted`: interrupted even with attempts left; `requeue`:
 *     retried, idempotently: a `repo.worktree` keeps the refs and the worktree an earlier attempt made);
 *   - a check main executes (a validate job without a recipe): abandoned; leased -> queued; running -> interrupted and the
 *     same check queued again as a new job (the v7 state table has no running -> queued); the version stays a draft;
 *   - a container attempt whose container was never recorded (never provisioned): abandoned; a leased tool job goes
 *     back to queued (nothing ran; the count is kept, so the next lease is n + 1), a dev deployment or a running job to
 *     retry_scheduled or interrupted;
 *   - an attempt with a recorded container: left for phase B (`pending`; its job reads `waiting:runner`).
 *   B2b Task 9 (accept reconcile, its own block after the jobs): a `changeset.accept` job that ended (interrupted, failed, timed out,
 *   cancelled) without an accept row, whose `accept.prepared` event exists and that did not end on a git refusal, gets one
 *   `changeset.accept_rollback { from: new, to: old }` (idempotent by key). An accept is never retried and never merged later.
 *   B2b Task 10 (agent turns, its own block beside the accept reconcile): an `agent.run` job with a live attempt is decided there,
 *   never by the generic rules above: the attempt is `abandoned`, the job `interrupted` and its session `interrupted`, its token
 *   revoked (`restart`); the worktree is kept as it is. The turn's container is no longer a live attempt's, so phase B's orphan
 *   removal takes it. A turn still `queued` is left alone by recovery; it runs after the restart unless its conversation had
 *   been running (the restart interrupts the session): then the scheduler cancels it `session_ended` (no resurrection).
 *   Then pending approvals past `expires_at` that no waiting job holds (image preparation) expire, and image builds left
 *   `running` are `interrupted` (RC17: a leftover row would block `requestImage` until its deadline).
 *   Hold mode: on a v9 database whose execution is off (v9 not enabled, held, or its shape failed), only jobs WITHOUT a
 *   live attempt are recovered, by B1's rule and its rows alone (no v9 table is written); jobs with a live attempt are
 *   left exactly as they are (`pending`) for the next start with execution on. B1's whole-table routine is never used
 *   on a v9 file: it would end jobs whose attempts are live, which the v9 backstop refuses.
 *
 * Phase B (`recoverPhaseB`): at every runner `ready`, with the runner's `reconcile.result` for `reconcileList()`.
 * Every live attempt with a recorded container that this process is not ingesting right now:
 *   - a DURABLE exit (job phase `collecting`, or an `attempt.output` event for (job, n)): its outputs live under the data
 *     home (`work/<job>/<n>/out`, kept until `attempt.release`), never in Docker, so it is adopted for finalization
 *     WHATEVER the container's or Docker's state; the runner re-hashes `/out` without Docker and reports the exit again;
 *   - otherwise, by the container's state (an attempt the runner did not report, or reported without its recorded
 *     container id or with another one, is `missing`; Docker not running makes every one `missing`, reason
 *     `docker_unavailable_at_recovery`):
 *     - running: adopted (lease_owner := this boot, one fresh LEASE_MS), `attempt.adopt` sent; heartbeats, events and
 *       the exit are then accepted from this boot's runner and the job finishes normally; a dev deployment keeps its
 *       status and its probes resume (one that had already been stopped is told `attempt.cancel`);
 *     - exited: when inspect and the staged outputs show the attempt cannot pass (OOM, a non-zero exit of a non-test
 *       recipe, a missing contract output, all exactly as `exitFailure`), it fails now and its container is released;
 *       otherwise it is adopted for finalization (as a durable exit) and ingested from the runner's re-reported exit,
 *       exactly as a live exit (idempotent by (job, output path); never completed without ingest);
 *     - created (never started) or missing: abandoned; a tool job goes to retry_scheduled when idempotent with attempts
 *       left, else interrupted; a dev deployment's job is interrupted and its deployment stopped (`recovery`), except
 *       one whose deployment was already stopped before the restart (its job waited for the exit): that job fails
 *       `exit_not_reported`. A created container is released (the runner removes it).
 *   Approval waits still owned by another boot are re-owned (phase A ran with another boot id).
 *   Then `orphanDecisions`: the labelled resources to stop and remove.
 *
 * The reconcile bound (`failUnreconciled`, from the scheduler; `reconcileBoundDue` says when): an attempt phase A left
 * for phase B that no phase B adopted or decided fails `runner_lost` (retried only when idempotent) and its container is
 * told `attempt.cancel`, unless its exit is durable: that one keeps waiting for finalization. The bound counts
 * RECONCILE_BOUND_MS (10 minutes) from the LATER of phase A and the FIRST reconcile request after it (`reconcileList`;
 * later requests never move it, so a crash-looping runner cannot postpone it); while a request is outstanding (no phase
 * B since it), it waits up to RECONCILE_WAIT_CAP_MS (5 minutes) more: at most 15 minutes from the first request.
 *
 * A mid-session runner restart (B2a close, user decision 2026-10-21; `runnerOutageHoldEnded` says when the hold ends):
 * while the runner is known to be restarting (main's port is not attached or not `ready`, or a reconcile requested
 * since it went away has had no phase B), main does not expire the leases of the attempts this boot held when it went
 * away. When the answer comes, those leases move by the downtime BEFORE phase B decides (an adopted attempt then gets
 * its one fresh lease; one phase B leaves alone, such as a start whose container was never recorded, keeps only what
 * was left of its lease). The hold is bounded like the reconcile bound: RECONCILE_BOUND_MS from the later of the outage
 * start and the first reconcile request during it, plus up to RECONCILE_WAIT_CAP_MS while that request is outstanding,
 * so at most the first request + 15 minutes. At the bound, or once the runner is `unavailable` (supervision gave up),
 * the hold ends without an extension and the sweep fails those attempts `runner_lost`. A runner that is `ready` again
 * without a reconcile request ends the hold with the extension (no answer is coming; its heartbeats decide).
 *
 * Leases and stall history (carried decision 8): the old process's in-memory stall record is gone at a restart, so
 * every attempt recovery adopts or re-owns gets exactly ONE fresh LEASE_MS from the recovery's `now`, and the wall
 * clock of an adopted running attempt counts the downtime (only approval waits are excluded). An adopted attempt that
 * is not heard from (no heartbeat, no exit) within that lease fails `runner_lost` in the scheduler's sweep (retried only
 * when idempotent); one adopted for finalization is exempt from its wall clock (it already exited) but not its lease.
 *
 * Orphans (`orphanDecisions`, pure; B2a Task 10 fix round 1, superseding the plan's "no live attempt of this
 * database"): a resource is listed for removal ONLY when it carries this install's `nexus.home` label AND a
 * `nexus.attempt` label naming an attempt of this database that is no longer live. Never listed: a resource of another
 * install (another data home on the same Docker daemon), an unlabelled resource or one labelled only with other keys
 * (a user's `nexus.note`), a dependency cache volume (`nexus-deps-*`, shared across attempts), and any resource of a
 * live attempt (whatever its owner: SQLite says it may still run; a failed decision leaves it live, so it is kept). A
 * resource of this install whose attempt id is unknown to this database is never removed: it is reported (`unknown`,
 * one `exec.recover` row and a log line).
 *
 * Blob store hygiene (`recoverBlobStore`, async, under the blob store's EXCLUSIVE lock, so no ingest and no GC runs
 * meanwhile; it never rejects past its authorization check): `objects/tmp` files older than 24 h are removed;
 * unindexed `objects/<2>/<62>` files older than 24 h are removed only while no attempt is live (GC's own rule: a landing
 * object is never raced). A GC whose last `started` row has no closing row is finished, and closed by the sweep's row
 * (`finishedGc`), when the only unindexed objects left are ones whose delete was refused (counted as `leftover`; none
 * younger than 24 h may remain). A file that cannot be deleted, and an INDEXED object with a second hard link (a writable
 * second name for stored bytes), is reported on every pass: a `blob.gc` row `failed` with `fileDeleteFailed`,
 * `hardLinked`, `hardLinkedIndexed` and `leftover`, and a log line.
 */
import type Database from 'better-sqlite3';
import type { JobState, Principal, ScopeRef } from '../../../shared/nexus/platform';
import type { ExitInfo, ParsedOutput, StagedOutput } from '../../../shared/nexus/execution';
import { MAX_ARRAY_ITEMS, parseRunnerMessage, type LabelledResource, type MainToRunner, type ReconciledAttempt } from '../../../shared/nexus/runnerProtocol';
import { getRecipe, type RecipeDef } from '../../../shared/nexus/recipes';
import { getKind } from '../../../shared/nexus/kinds';
import type { AuthService } from '../auth/authService';
import { appendActivityRow } from '../activity/writer';
import type { BlobIndex } from '../blobs/blobIndex';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { redactedErrorJson, type JobRow, type JobService } from '../jobs/jobService';
import { adoptAttemptTx, attemptRow, liveAttemptOf, transitionAttemptTx, type AttemptRow } from './attempts';
import { appendJobEventTx } from './events';
import { endedAcceptJobIds, enqueueAcceptRollbackTx, rollbackNeeded } from '../repo/acceptRollback';

/**
 * The runner's side of restart recovery: what B2a Task 11 (the runner host, `src/runner/reconcile.ts`, the main-side
 * wiring) must implement. Main relies on every line; a runner that breaks one loses work to `runner_lost`, never
 * completes anything falsely.
 */
export const RUNNER_RECOVERY_CONTRACT: readonly string[] = Object.freeze([
  'Boot id: main attaches the runner with platform.bootId (the boot id phase A re-owned for), never a fresh one.',
  'Install label: `hello` carries `home`, this install\'s `nexus.home` (src/shared/nexus/homeLabel.ts of the data home: '
    + 'resolved, and on Windows lowercased and without a `\\\\?\\` prefix). The runner uses that value, or the same shared '
    + 'function, for every label it writes and every list it filters; it never derives its own.',
  'Reconcile request: main calls exec.reconcileList() exactly when it sends `reconcile.list` (that call records the request). '
    + 'The reconcile bound counts its 10 minutes from the later of phase A and the FIRST request after phase A (later requests '
    + 'never move it), and while a request has had no phase B it waits up to 5 more minutes for the answer: at most 15 minutes '
    + 'from the first request; recoverPhaseB ends the outstanding request.',
  'At every runner `ready` (app start and every runner restart) main sends `reconcile.list` = exec.reconcileList(); the '
    + 'runner answers one `reconcile.result`, which main routes to exec.recoverPhaseB(system, platform.bootId, result) '
    + '(ExecutionService.onRunnerMessage does not handle `reconcile.result` itself).',
  '`reconcile.result.attempts[i].containerId` is the id of the container found under the attempt\'s labels; an entry '
    + 'without it, or with another id than main recorded, counts as `missing`.',
  '`reconcile.result.attempts[i].staged` is the COMPLETE list of `/out` (re-hashed) or is omitted; it is never truncated. '
    + 'Main drops a list over 20,000 entries for that attempt only (the attempt is then adopted to re-report).',
  '`reconcile.result.labelled` lists every container, volume and network with a `nexus.home` label equal to this '
    + 'install\'s (the `home` of `hello`); main decides what to remove and never removes a resource '
    + 'without this install\'s `nexus.home` and a `nexus.attempt` of an ended attempt of its database.',
  'Every container, volume and network the runner creates for an attempt carries the plan\'s labels: containers their '
    + 'spec labels, volumes and networks `plan.resourceLabels` (`nexus.job`, `nexus.attempt`, `nexus.boot`, '
    + '`nexus.project`, `nexus.home`).',
  'Removal needs a new MainToRunner op, `reconcile.remove { resources: { kind, id }[] }` (from PhaseBReport.remove): '
    + 'stop (-t 10) and remove each, by id only; main then records `exec.orphan_removed`.',
  '`attempt.adopt` of a RUNNING container: reattach its log, resume heartbeats (and a service\'s probe loop); its exit '
    + 'is reported as usual.',
  '`attempt.adopt` of an attempt whose exit is durable or whose container exited (also with the container gone or '
    + 'Docker down): re-hash `<dataHome>/work/<job>/<n>/out` from the data home (no Docker needed), re-run the '
    + 'parsers and report `attempt.exited` again, with the exit recorded at collect time (keep it beside /out, e.g. '
    + '`work/<job>/<n>/exit.json`, so no Docker is needed). Within one LEASE_MS (60 s) of the adoption, or heartbeat '
    + 'meanwhile; never report `container: \'missing\'` in a heartbeat of an attempt being finalized (use `exited`).',
  'The runner deletes nothing of an attempt (container, /out, workspace volume) before main sends `attempt.release`.',
  'exec.recoverBlobStore(system) runs once per app start: after phase B and before the scheduler\'s first tick. Not at a '
    + 'mid-session runner restart: the scheduler is running then, and the pass holds the blob store\'s exclusive lock '
    + '(leases and ingests would wait); what a dead runner left in objects/tmp is swept at the next app start.',
  'A mid-session runner restart holds lease expiry: while main\'s port is not `ready`, or a reconcile requested since the '
    + 'runner went away has had no phase B, the attempts this boot held keep their leases; at the answer they move by the '
    + 'downtime before phase B decides. The hold ends at the reconcile bound (at most the first request + 15 minutes) or '
    + 'when the runner is `unavailable`, and those attempts then fail `runner_lost` in the sweep.',
  'If no phase B adopts or decides an attempt phase A left pending within the reconcile bound, it fails `runner_lost` '
    + '(a durable exit keeps waiting for finalization) and main sends `attempt.cancel` (grace 10 s, reason `timeout`) '
    + 'when a runner is attached: the runner stops that container and keeps its scratch; the next phase B lists it '
    + 'for removal (its attempt has ended).'
]);

/** The activity action of every recovery decision. */
export const RECOVER_ACTION = 'exec.recover';
/** Unindexed object files and `objects/tmp` files are swept only once they are older than this. */
export const STALE_OBJECT_MS = 24 * 60 * 60 * 1000;
/** The most object files one hygiene pass looks at. */
export const MAX_SWEEP_OBJECTS = 100_000;
/** An attempt phase A left for phase B that no phase B reconciled within this long fails `runner_lost`. */
export const RECONCILE_BOUND_MS = 10 * 60_000;
/** How much longer the bound waits while a reconcile request has had no phase B. */
export const RECONCILE_WAIT_CAP_MS = 5 * 60_000;
const CANCEL_GRACE_MS = 10_000;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PLATFORM: ScopeRef = { type: 'platform' };
const LIVE_JOB_STATES: readonly JobState[] = ['leased', 'running', 'awaiting_approval'];

/** The runner's reconcile answer (the `reconcile.result` message without its op). */
export interface ReconcileResult {
  attempts: ReconciledAttempt[];
  labelled: LabelledResource[];
  docker: 'running' | 'stopped' | 'missing';
}

export type RecoveryDecision =
  | 'requeue' | 'retry' | 'interrupt' | 'reown' | 'expire' | 'adopt' | 'finalize' | 'fail' | 'exit_lost' | 'image_interrupted'
  | 'orphans' | 'unknown_resources' | 'unreconciled' | 'accept_rollback';

export interface PhaseAReport {
  /** Execution is off on this v9 database: only jobs without a live attempt were recovered (B1's rule). */
  held: boolean;
  /** Jobs that will run again (queued, or retry_scheduled). */
  requeued: number;
  /** Jobs interrupted, plus image builds interrupted. */
  interrupted: number;
  /** Approvals expired (a waiting job fails `denied`). */
  expired: number;
  /** Live attempts left for phase B, and approval waits that keep waiting. */
  pending: number;
  /** The jobs alone, for the `platform ready` line. */
  jobs: { interrupted: number; requeued: number };
  decisions: number;
  errors: number;
}

export interface OrphanRemoval { kind: LabelledResource['kind']; id: string; reason: 'attempt_ended' }
export interface OrphanReport {
  /** This install's resources of ended attempts of this database: stop and remove. */
  remove: OrphanRemoval[];
  /** This install's resources naming an attempt this database does not know: never removed, reported. */
  unknown: { kind: LabelledResource['kind']; id: string }[];
}

export interface PhaseBReport {
  adopted: number;
  /** Exited attempts finalized: adopted for their re-reported exit (durable exits included), or failed from inspect. */
  finalized: number;
  requeued: number;
  interrupted: number;
  /** Jobs failed by phase B for a lost outcome (a stopped dev deployment whose exit was never reported). */
  failed: number;
  reowned: number;
  decisions: number;
  errors: number;
  /** Labelled resources to stop and remove (the runner applies the list: `reconcile.remove`). */
  remove: OrphanRemoval[];
  /** This install's labelled resources whose attempt this database does not know (never removed). */
  unknown: { kind: LabelledResource['kind']; id: string }[];
}

export interface BlobSweepReport {
  ran: boolean;
  /** Why it did not run or stopped: `not_available`, `busy` (an ingest or a GC holds the store) or `error`. */
  reason: string | null;
  tmpRemoved: number;
  tmpFailed: number;
  objectsRemoved: number;
  objectsFailed: number;
  /** Unindexed objects older than 24 h with a second hard link (their delete is refused). */
  hardLinked: number;
  /** Indexed objects with a second hard link: stored bytes with a writable second name, surfaced. */
  hardLinkedIndexed: number;
  /** Unindexed objects were not swept because an attempt is live. */
  objectsDeferred: boolean;
  /** Unindexed objects older than 24 h whose delete was refused: what remains of a GC run that is closed anyway. */
  leftover: number;
  /** A blob.gc run left `started` was finished (only refused deletes remain, counted as `leftover`) and closed. */
  finishedGc: boolean;
}

/** The data home's object files (DataHome implements it; src/main/nexusExec/dataHome.ts). */
export interface BlobStoreFiles {
  listObjectFiles(limit: number): Promise<{ objects: { sha256: string; mtimeMs: number; nlink: number }[]; truncated: boolean }>;
  sweepObjectsTmp(cutoffMs: number): Promise<{ removed: number; failed: number }>;
  deleteObjects(shas: readonly string[]): Promise<{ failed: readonly string[] }>;
}

/** What recovery needs from the execution core (ExecutionService builds it over its own helpers). */
export interface RecoveryHost {
  readonly db: Database.Database;
  readonly auth: AuthService;
  readonly jobs: JobService;
  readonly available: boolean;
  readonly log: (line: string) => void;
  readonly blobs: BlobIndex | null;
  readonly files: BlobStoreFiles | null;
  /** This install's `nexus.home` label (src/shared/nexus/homeLabel.ts of the data home); null without a data home (nothing is removed). */
  readonly home: string | null;
  /** The validation framework's replacement of an interrupted main check (null without validation). */
  readonly requeueCheckTx: ((system: Principal, jobId: string) => string[]) | null;
  moveJobTx(id: string, to: JobState, now: number, d?: { outcome?: string; error?: { code: string; message: string } }, expect?: JobState): void;
  /** The core's one failure-and-retry rule (ExecutionService.failJobTx). Returns the job's end state. */
  failJobTx(id: string, outcome: string, error: { code: string; message: string }, now: number,
    o?: { retry?: 'by_code' | 'always'; otherwise?: 'failed' | 'interrupted' }): 'failed' | 'retry_scheduled' | 'interrupted';
  setPhaseTx(id: string, phase: string | null, now: number): void;
  endAwaitingTx(jobId: string, error: { code: string; message: string }, now: number): void;
  send(msg: MainToRunner): boolean;
  /** Whether this process is ingesting the attempt's exit right now (its in-memory `collecting` set). */
  isCollecting(attemptId: string): boolean;
  /** The log path `attempt.adopt` carries (under the data home). */
  logPathOf(a: AttemptRow): string;
  /** An attempt adopted for finalization: it already exited, so its wall clock no longer runs (its lease still does). */
  awaitExit(attemptId: string): void;
  /**
   * B2b Task 10, inside a decision's transaction: the agent turn's token is revoked (`restart` or `runner_restart`) and its
   * session, if it was running, is interrupted (a session of a turn that never ran stays open). Null without agents.
   */
  readonly interruptAgentTurnTx: ((system: Principal, jobId: string, now: number, reason: 'restart' | 'runner_restart') => void) | null;
}

/** Why a decision was taken, in words (the attempt's and the job's error message). */
const REASON_TEXT: Record<string, string> = {
  no_live_attempt: 'the app restarted; nothing was running for this job',
  never_started: 'the app restarted before the attempt started',
  engine_lost: 'the app restarted while the work ran in the runner',
  check_restarted: 'the app restarted while the check ran',
  no_recipe: 'the app restarted; the job has nothing to run again',
  approval_missing: 'the app restarted; the job has no approval to wait for',
  approval_expired: 'the approval was not answered in time',
  approval_denied: 'the approval was denied',
  container_created: 'the app restarted before the container started',
  container_missing: 'the container was gone after the app restarted',
  container_running: 'the container was still running after the app restarted',
  container_exited: 'the container exited while the app was closed',
  exit_durable: 'the exit was recorded before the restart; its outputs are collected again',
  docker_unavailable_at_recovery: 'Docker was not running when the app restarted',
  unreconciled: 'the runner did not reconcile the attempt within 10 minutes of the restart',
  restarted: 'the app restarted while the image was being built',
  agent_restart: 'the app restarted while the agent worked; its working copy is kept',
  agent_runner_lost: 'the sandbox runner restarted while the agent worked; its working copy is kept'
};
/**
 * The sentence of each git write refusal (B2b Task 7; src/runner/gitWrite.ts GIT_FAILURE_CODES). The job's error is the
 * code and this sentence: shown as it is, never as a raw code.
 */
export const GIT_FAILURE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  git_missing: 'Git is not installed on this computer.',
  bad_task: 'Nexus refused the git work: its plan was malformed.',
  repo_layout_unsupported: 'This project folder is not a plain git repository (its .git is not a folder), so Nexus cannot make a worktree for it.',
  repo_empty: 'The repository has no commits yet. Make a first commit, then ask again.',
  branch_missing: 'The branch Nexus works from is no longer in the repository. Take a new repository snapshot, then ask again.',
  worktree_tampered: 'The link from the session worktree to the repository was changed, so Nexus stopped and committed nothing.',
  worktree_conflict: 'Git could not give the session worktree its expected name, so Nexus stopped.',
  link_or_gitlink: 'The change holds a symbolic link or a nested repository entry, which Nexus does not commit.',
  ref_moved: 'A Nexus ref moved while the work ran, so nothing was changed. Try again.',
  unknown_commit: 'A commit Nexus recorded is no longer in the repository.',
  merge_conflict: 'The change does not merge cleanly onto the accepted work.',
  tree_dirty: 'Your working tree has uncommitted changes or an operation in progress, so nothing was merged.',
  branch_mismatch: 'Another branch is checked out than the one the accepted work is for, so nothing was merged.',
  not_fast_forward: 'Your branch has moved on, so the accepted work is no longer a fast-forward. Nothing was merged.',
  integration_diverged: 'Your branch and the accepted work have both moved on, so Nexus cannot start from your latest code. Merge the accepted work in your own tools, then ask again.',
  git_failed: 'Git could not complete the work; nothing was changed.',
  symlink_in_worktree: 'The session worktree holds a symbolic link or junction, so Nexus stopped and committed nothing.',
  nested_repo: 'The session worktree holds a nested git repository, so Nexus stopped and committed nothing.',
  worktree_too_large: 'The session worktree is larger than Nexus allows (8 GiB), so nothing was committed.',
  file_too_large: 'A file in the session worktree is larger than Nexus allows (50 MiB), so nothing was committed.'
});
const reasonError = (reason: string): { code: string; message: string } => ({ code: reason, message: REASON_TEXT[reason] ?? 'the app restarted' });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const codeOf = (e: unknown): string => (e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error');

/** A contract path a recipe's output must hold (`dir/**` any file below, `dir/*.ext` one level). */
export function contractMet(required: readonly string[], outputs: readonly StagedOutput[], parsed: readonly ParsedOutput[], engine: boolean): boolean {
  if (engine) {
    const facts = parsed.map((p) => p.normalized).find((n) => isObj(n));
    return !!facts && required.every((k) => Object.prototype.hasOwnProperty.call(facts, k));
  }
  const paths = outputs.map((o) => o.relPath);
  return required.every((req) => {
    if (req.endsWith('/**')) { const dir = req.slice(0, -2); return paths.some((p) => p.startsWith(dir) && p.length > dir.length); }
    const star = req.indexOf('*');
    if (star >= 0) {
      const pre = req.slice(0, star); const post = req.slice(star + 1);
      return paths.some((p) => p.startsWith(pre) && p.endsWith(post) && !p.slice(pre.length, p.length - post.length).includes('/'));
    }
    return paths.includes(req);
  });
}

/**
 * Why an exit cannot be ingested, or null (the execution core's rule for every exit, live or recovered): outputs the
 * runner refused, an OOM kill, a non-zero exit of a recipe without a test report, or a missing contract output (a tree
 * output is judged by its validators instead).
 */
const SIGNAL_NAMES: Readonly<Record<number, string>> = Object.freeze({ 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 6: 'SIGABRT', 7: 'SIGBUS',
  8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM' });

/**
 * The exit as a sentence a reader can act on (fix round 1, item 15): `exit 137 (SIGKILL), OOMKilled false`. A code above
 * 128 is a death by signal (128 + n); a reported signal name is used as given. Never a secret: numbers and fixed names.
 */
export function exitDetail(exit: { code: number | null; signal?: string | null; oomKilled: boolean }): string {
  const code = exit.code === null ? 'no exit code' : `exit ${exit.code}`;
  const sig = typeof exit.signal === 'string' && /^SIG[A-Z0-9]{1,10}$/.test(exit.signal) ? exit.signal
    : exit.code !== null && exit.code > 128 && exit.code < 160 ? (SIGNAL_NAMES[exit.code - 128] ?? `signal ${exit.code - 128}`) : null;
  return `${code}${sig ? ` (${sig})` : ''}, OOMKilled ${exit.oomKilled ? 'true' : 'false'}`;
}

export function exitFailure(recipe: RecipeDef, exit: { code: number | null; signal?: string | null; oomKilled: boolean }, outputs: readonly StagedOutput[],
  parsed: readonly ParsedOutput[], outputError?: string | null): { outcome: string; error: { code: string; message: string } } | null {
  const tests = recipe.parsers.includes('junit');
  // B2b: a git write the runner refused reports its code as a fact; main words it (never git's text, never a bare code).
  if (recipe.executor === 'engine' && exit.code !== 0 && !exit.oomKilled && !outputError) {
    const f = parsed.find((p) => p.parser === 'git-facts')?.normalized;
    if (isObj(f) && f.ok === false && typeof f.code === 'string' && Object.prototype.hasOwnProperty.call(GIT_FAILURE_TEXT, f.code)) {
      return { outcome: 'failed', error: { code: f.code, message: GIT_FAILURE_TEXT[f.code] } };
    }
  }
  const treeOutput = recipe.produces.some((k) => getKind(k)?.storage.includes('tree'));
  if (outputError) return { outcome: 'invalid_output', error: { code: outputError, message: `the outputs were refused: ${outputError}` } };
  if (exit.oomKilled) return { outcome: 'oom', error: { code: 'oom', message: `the container ran out of memory (${exitDetail(exit)})` } };
  // An outside kill (docker kill: exit 137, not OOM) stays nonzero_exit, with the signal and the OOM flag in the error.
  if (!tests && exit.code !== 0) return { outcome: 'nonzero_exit', error: { code: 'nonzero_exit', message: exitDetail(exit) } };
  if (!treeOutput && !contractMet(recipe.outputContract.required, outputs, parsed, recipe.executor === 'engine')) {
    return { outcome: 'invalid_output', error: { code: 'outputs_missing', message: `required outputs missing: ${recipe.outputContract.required.join(', ')}` } };
  }
  return null;
}

/**
 * The labelled resources to stop and remove, and the ones of this install whose attempt is unknown (see the module
 * header). Pure. `liveAttempts`: every live attempt id of this database, AFTER phase B's decisions; `knownAttempts`:
 * the attempt ids among the labels that this database holds; `home`: this install's `nexus.home` (null: none).
 */
export function orphanDecisions(reconcile: { labelled: readonly LabelledResource[] },
  ctx: { home: string | null; liveAttempts: ReadonlySet<string>; knownAttempts: ReadonlySet<string> }): OrphanReport {
  const out: OrphanReport = { remove: [], unknown: [] };
  if (ctx.home === null) return out;
  const seen = new Set<string>();
  const kinds: readonly string[] = ['container', 'volume', 'network'];
  for (const r of (Array.isArray(reconcile?.labelled) ? reconcile.labelled : []) as LabelledResource[]) {
    if (!isObj(r) || !isObj(r.labels) || typeof r.id !== 'string' || !kinds.includes(r.kind)) continue;
    const labels = r.labels as Record<string, unknown>;
    // Only this install's own resources: another data home, an unlabelled one or a user's `nexus.*` label never qualify.
    if (labels['nexus.home'] !== ctx.home) continue;
    const attempt = typeof labels['nexus.attempt'] === 'string' && labels['nexus.attempt'].length > 0 ? labels['nexus.attempt'] : null;
    if (attempt === null) continue;
    // A dependency cache is shared by later attempts (written once by an approved install): never an orphan here.
    if (r.kind === 'volume' && (r.id.startsWith('nexus-deps-') || labels['nexus.kind'] === 'deps')) continue;
    // SQLite says a live attempt may still run (adopted, waiting, or its decision failed): its resources stay.
    if (ctx.liveAttempts.has(attempt)) continue;
    const key = `${r.kind}\u0000${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!ctx.knownAttempts.has(attempt)) out.unknown.push({ kind: r.kind, id: r.id });
    else out.remove.push({ kind: r.kind, id: r.id, reason: 'attempt_ended' });
  }
  return out;
}

/**
 * Whether the reconcile bound is due at `now`: RECONCILE_BOUND_MS after the later of phase A (`recoveredAt`) and the FIRST
 * reconcile request after phase A (`requestedAt`; the caller records it once and never moves it), plus up to
 * RECONCILE_WAIT_CAP_MS more while a request is outstanding (no phase B since it). Pure.
 */
export function reconcileBoundDue(s: { recoveredAt: number; requestedAt: number | null; outstanding: boolean }, now: number): boolean {
  const deadline = Math.max(s.recoveredAt, s.requestedAt ?? s.recoveredAt) + RECONCILE_BOUND_MS;
  if (now < deadline) return false;
  return !(s.outstanding && s.requestedAt !== null && now < deadline + RECONCILE_WAIT_CAP_MS);
}

/**
 * Whether a mid-session runner restart's lease hold has ended at `now` (B2a close): the reconcile bound, anchored at the
 * outage start (`since`, when the runner was last seen live) and the FIRST reconcile request during the outage, waiting
 * up to RECONCILE_WAIT_CAP_MS more while that request has had no answer. At most the first request + 15 minutes. Pure.
 */
export function runnerOutageHoldEnded(o: { since: number; requestedAt: number | null; answered: boolean }, now: number): boolean {
  return reconcileBoundDue({ recoveredAt: o.since, requestedAt: o.requestedAt, outstanding: o.requestedAt !== null && !o.answered }, now);
}

/** Whether an attempt's exit is durable: its job collects outputs, or the exit's `attempt.output` event was written. */
export function durableExit(db: Database.Database, j: { id: string; phase: string | null }, a: { n: number }): boolean {
  if (j.phase === 'collecting') return true;
  return db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND attempt_n = ? AND type = 'attempt.output' LIMIT 1").get(j.id, a.n) !== undefined;
}

// ---------- internals ----------

interface Counters {
  requeued: number; interrupted: number; expired: number; pending: number; reowned: number; adopted: number; finalized: number;
  failed: number; jobsRequeued: number; jobsInterrupted: number; decisions: number; errors: number;
}
type Count = 'requeued' | 'interrupted' | 'expired' | 'pending' | 'adopted' | 'finalized' | 'failed' | 'reowned' | 'images';
interface Outcome { decision: RecoveryDecision | null; count: Count | null; after?: () => void }

const counters = (): Counters => ({ requeued: 0, interrupted: 0, expired: 0, pending: 0, reowned: 0, adopted: 0, finalized: 0,
  failed: 0, jobsRequeued: 0, jobsInterrupted: 0, decisions: 0, errors: 0 });

function tally(c: Counters, o: Outcome): void {
  if (o.decision !== null) c.decisions++;
  switch (o.count) {
    case 'requeued': c.requeued++; c.jobsRequeued++; break;
    case 'interrupted': c.interrupted++; c.jobsInterrupted++; break;
    case 'images': c.interrupted++; break;
    case 'expired': c.expired++; break;
    case 'pending': c.pending++; break;
    case 'reowned': c.reowned++; c.pending++; break;
    case 'adopted': c.adopted++; break;
    case 'finalized': c.finalized++; break;
    case 'failed': c.failed++; break;
    default: break;
  }
}

/** One decision: its own IMMEDIATE transaction; its sends after commit; a throw rolls back that decision only. */
function decide(host: RecoveryHost, c: Counters, what: string, fn: () => Outcome | null): boolean {
  let o: Outcome | null;
  try {
    o = immediateTx(host.db, fn);
  } catch (e) {
    c.errors++;
    host.log(`[nexus] execution recovery: a decision about ${what} was not applied (${codeOf(e)}); it is left as it was`);
    return false;
  }
  if (!o) return true;
  tally(c, o);
  if (o.after) { try { o.after(); } catch { /* a send that fails is the runner's to retry (lease expiry) */ } }
  return true;
}

function requireSystem(host: RecoveryHost, system: Principal, op: string): void {
  // Authorized and audited like B1's recovery: a user, an agent or a forged principal is denied.
  host.auth.require(system, 'job.transition', PLATFORM, { entityType: 'job', details: { op } });
  if (system?.kind !== 'system') throw new PlatformError('denied', 'restart recovery is performed by the system', { reason: 'system_only' });
}

function checkBoot(bootId: string): void {
  if (typeof bootId !== 'string' || !ULID_RE.test(bootId)) throw new PlatformError('invalid', 'bootId must be a ULID');
}

const jobRow = (db: Database.Database, id: string): JobRow | null =>
  (db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null;

interface DecisionRecord {
  decision: RecoveryDecision; reason: string; summary: string;
  job?: JobRow | null; attemptN?: number | null;
  /** Without a job: the entity the decision is about (an approval or an image build). */
  entity?: { type: string; id: string; onBehalfOf: string | null; projectId: string | null } | null;
  approvalId?: string | null; imageBuildId?: string | null;
  data?: Record<string, unknown>;
  /** False when the decision's `recovery` event was already written (adoptAttemptTx writes it). */
  event?: boolean;
}

/** The decision's one `exec.recover` activity row and (unless written already) its one `recovery` event. */
function recordTx(host: RecoveryHost, system: Principal, d: DecisionRecord, now: number): void {
  const j = d.job ? jobRow(host.db, d.job.id) : null;
  const projectId = j ? j.project_id : d.entity?.projectId ?? null;
  const details = { decision: d.decision, reason: d.reason, ...(j ? { to: j.state } : {}), ...(d.data ?? {}) };
  appendActivityRow(host.db, { actorKind: system.kind, actorId: system.id, onBehalfOf: j ? j.on_behalf_of : d.entity?.onBehalfOf ?? null,
    sessionId: j?.session_id ?? null, jobId: j?.id ?? null, attemptN: d.attemptN ?? null, projectId, workspaceId: j?.workspace_id ?? null,
    entityType: j ? 'job' : d.entity?.type ?? 'execution', entityId: j ? j.id : d.entity?.id ?? null, action: RECOVER_ACTION,
    status: 'succeeded', details }, now);
  if (d.event === false) return;
  appendJobEventTx(host.db, { type: 'recovery', summary: d.summary, projectId, jobId: j?.id ?? null, attemptN: j ? d.attemptN ?? null : null,
    approvalId: d.approvalId ?? null, imageBuildId: d.imageBuildId ?? null, data: { decision: d.decision, reason: d.reason, ...(d.data ?? {}) } }, now);
}

function abandonTx(host: RecoveryHost, j: JobRow, a: AttemptRow, reason: string, now: number): void {
  transitionAttemptTx(host.db, a, 'abandoned', now, j.project_id, { outcome: reason, error: reasonError(reason) });
}

function interruptTx(host: RecoveryHost, system: Principal, j: JobRow, a: AttemptRow, reason: string, now: number, data?: Record<string, unknown>): Outcome {
  abandonTx(host, j, a, reason, now);
  host.moveJobTx(j.id, 'interrupted', now, { outcome: 'interrupted', error: reasonError(reason) });
  host.setPhaseTx(j.id, null, now);
  recordTx(host, system, { decision: 'interrupt', reason, job: j, attemptN: a.n, summary: `job interrupted: ${REASON_TEXT[reason] ?? reason}`, data }, now);
  return { decision: 'interrupt', count: 'interrupted' };
}

/** A leased job whose attempt never ran: the attempt is abandoned and the job waits again (or is interrupted: no resurrection). */
function requeueTx(host: RecoveryHost, system: Principal, j: JobRow, a: AttemptRow, reason: string, now: number): Outcome {
  if (j.state !== 'leased' || !host.jobs.runnableAgain(j)) return interruptTx(host, system, j, a, reason, now);
  abandonTx(host, j, a, reason, now);
  host.moveJobTx(j.id, 'queued', now, undefined, 'leased');
  host.setPhaseTx(j.id, null, now);
  recordTx(host, system, { decision: 'requeue', reason, job: j, attemptN: a.n, summary: `job queued again: ${REASON_TEXT[reason] ?? reason}` }, now);
  return { decision: 'requeue', count: 'requeued' };
}

/**
 * A job whose attempt is lost: the core's own failure rule (failJobTx), told that a lost attempt is retryable: retried
 * when idempotent with attempts left and runnable again, else interrupted.
 */
function retryOrInterruptTx(host: RecoveryHost, system: Principal, j: JobRow, a: AttemptRow, reason: string, now: number,
  data?: Record<string, unknown>): Outcome {
  abandonTx(host, j, a, reason, now);
  const end = host.failJobTx(j.id, 'interrupted', reasonError(reason), now, { retry: 'always', otherwise: 'interrupted' });
  if (end !== 'retry_scheduled') host.setPhaseTx(j.id, null, now);
  const retried = end === 'retry_scheduled';
  recordTx(host, system, { decision: retried ? 'retry' : 'interrupt', reason, job: j, attemptN: a.n,
    summary: `${retried ? 'job will be tried again' : 'job interrupted'}: ${REASON_TEXT[reason] ?? reason}`, data }, now);
  return retried ? { decision: 'retry', count: 'requeued' } : { decision: 'interrupt', count: 'interrupted' };
}

/** Re-own a live attempt for this boot (no write when it is already this boot's). */
function reownTx(host: RecoveryHost, system: Principal, bootId: string, j: JobRow, a: AttemptRow, reason: string, now: number): Outcome {
  if (a.lease_owner === bootId) return { decision: null, count: 'pending' };
  adoptAttemptTx(host.db, a, bootId, now, j.project_id, { summary: `attempt ${a.n} re-owned: the job still waits for approval`,
    data: { decision: 'reown', reason } });
  recordTx(host, system, { decision: 'reown', reason, job: j, attemptN: a.n, summary: '', event: false }, now);
  return { decision: 'reown', count: 'reowned' };
}

interface ApprovalLite { id: string; project_id: string | null; job_id: string | null; status: string; expires_at: number; on_behalf_of: string;
  consumed_by_job_id: string | null; consumed_by_attempt_n: number | null }

function approvalWaitTx(host: RecoveryHost, system: Principal, bootId: string, j: JobRow, a: AttemptRow, now: number): Outcome {
  const ap = host.db.prepare(`SELECT id, project_id, job_id, status, expires_at, on_behalf_of, consumed_by_job_id, consumed_by_attempt_n FROM approvals
    WHERE job_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1`).get(j.id) as ApprovalLite | undefined;
  if (ap && ap.status === 'pending' && ap.expires_at > now) return reownTx(host, system, bootId, j, a, 'approval_pending', now);
  // Consent given, start waiting for the scheduler's caps (it starts it, or fails it approval_stale after 15 minutes).
  if (ap && ap.status === 'approved' && ap.consumed_by_job_id === j.id && ap.consumed_by_attempt_n === a.n) {
    return reownTx(host, system, bootId, j, a, 'approval_consumed', now);
  }
  if (ap && (ap.status === 'pending' || ap.status === 'expired' || ap.status === 'denied')) {
    const reason = ap.status === 'denied' ? 'approval_denied' : 'approval_expired';
    if (ap.status === 'pending') {
      host.db.prepare("UPDATE approvals SET status = 'expired', status_changed_at = ? WHERE id = ? AND status = 'pending'").run(now, ap.id);
    }
    // The waiting job fails `denied`, its starting attempt first (nothing was sent to the runner; nothing is retried).
    host.endAwaitingTx(j.id, reasonError(reason), now);
    recordTx(host, system, { decision: 'expire', reason, job: j, attemptN: a.n, approvalId: ap.id,
      summary: reason === 'approval_denied' ? 'the job ends: its approval was denied' : 'approval expired while the app was closed; the job did not run',
      data: { approvalId: ap.id } }, now);
    return { decision: 'expire', count: 'expired' };
  }
  return interruptTx(host, system, j, a, 'approval_missing', now);
}

/** A check main executes (a validate job without a recipe). */
function mainCheckTx(host: RecoveryHost, system: Principal, j: JobRow, a: AttemptRow, now: number): Outcome {
  if (j.state === 'leased') return requeueTx(host, system, j, a, 'check_restarted', now);
  abandonTx(host, j, a, 'check_restarted', now);
  host.moveJobTx(j.id, 'interrupted', now, { outcome: 'interrupted', error: reasonError('check_restarted') });
  host.setPhaseTx(j.id, null, now);
  const ids = host.requeueCheckTx ? host.requeueCheckTx(system, j.id) : [];
  const requeued = ids.length > 0;
  recordTx(host, system, { decision: requeued ? 'requeue' : 'interrupt', reason: 'check_restarted', job: j, attemptN: a.n,
    summary: requeued ? 'check queued again: the app restarted while it ran' : 'check interrupted: the app restarted while it ran',
    data: { replacedBy: ids[0] ?? null } }, now);
  return requeued ? { decision: 'requeue', count: 'requeued' } : { decision: 'interrupt', count: 'interrupted' };
}

function phaseAJobTx(host: RecoveryHost, system: Principal, bootId: string, jobId: string, now: number): Outcome | null {
  const j = jobRow(host.db, jobId);
  if (!j || !LIVE_JOB_STATES.includes(j.state)) return null;
  // An agent turn is decided by its own block (agentTurnRecoveryTx, beside the accept reconcile), never by these rules.
  if (j.kind === 'agent.run') return null;
  const a = liveAttemptOf(host.db, j.id);
  if (!a) {
    const r = host.jobs.recoverJobTx(system, j.id, now);
    if (!r) return null;
    const decision = r === 'requeued' ? 'requeue' : 'interrupt';
    recordTx(host, system, { decision, reason: 'no_live_attempt', job: j, summary: r === 'requeued' ? 'job queued again after a restart' : 'job interrupted by a restart' }, now);
    return { decision, count: r };
  }
  if (j.state === 'awaiting_approval') return approvalWaitTx(host, system, bootId, j, a, now);
  const recipe = j.recipe_id ? getRecipe(j.recipe_id) : null;
  if (!recipe) return j.kind === 'validate' ? mainCheckTx(host, system, j, a, now) : interruptTx(host, system, j, a, 'no_recipe', now);
  if (recipe.executor === 'engine') {
    if (j.state === 'leased') return requeueTx(host, system, j, a, 'engine_lost', now);
    // B2b: a recipe that states its recovery class follows it. `interrupted` work (a collect, an accept, a fast-forward)
    // is never repeated blind; `requeue` work (a worktree, a merge check, a rollback) runs again, idempotently.
    if (recipe.recovery === 'interrupted') return interruptTx(host, system, j, a, 'engine_lost', now);
    return retryOrInterruptTx(host, system, j, a, 'engine_lost', now);
  }
  // A container is recorded once its preflight passed: what happened to it is phase B's to learn from the runner.
  if (a.container_id !== null) return { decision: null, count: 'pending' };
  if (j.state === 'leased' && recipe.executor !== 'service') return requeueTx(host, system, j, a, 'never_started', now);
  // A dev deployment is never requeued (its one deployment row would wait as `starting`); a running job cannot go back to queued.
  return retryOrInterruptTx(host, system, j, a, 'never_started', now);
}

interface ApprovalRowLite extends ApprovalLite { reason: string }

function expireApprovalTx(host: RecoveryHost, system: Principal, approvalId: string, now: number): Outcome | null {
  const ap = host.db.prepare(`SELECT id, project_id, job_id, status, expires_at, on_behalf_of, consumed_by_job_id, consumed_by_attempt_n, reason
    FROM approvals WHERE id = ?`).get(approvalId) as ApprovalRowLite | undefined;
  if (!ap || ap.status !== 'pending' || ap.expires_at > now) return null;
  host.db.prepare("UPDATE approvals SET status = 'expired', status_changed_at = ? WHERE id = ? AND status = 'pending'").run(now, ap.id);
  const j = ap.job_id ? jobRow(host.db, ap.job_id) : null;
  if (j && j.state === 'awaiting_approval') host.endAwaitingTx(j.id, reasonError('approval_expired'), now);
  recordTx(host, system, { decision: 'expire', reason: 'approval_expired', job: j, attemptN: null, approvalId: ap.id,
    entity: { type: 'approval', id: ap.id, onBehalfOf: ap.on_behalf_of, projectId: ap.project_id },
    summary: `approval expired while the app was closed (${ap.reason})`, data: { approvalId: ap.id } }, now);
  return { decision: 'expire', count: 'expired' };
}

function interruptBuildTx(host: RecoveryHost, system: Principal, buildId: string, now: number): Outcome | null {
  const b = host.db.prepare('SELECT id, status, approval_id, requested_by, profile_id FROM image_builds WHERE id = ?').get(buildId) as
    { id: string; status: string; approval_id: string; requested_by: string; profile_id: string } | undefined;
  if (!b || b.status !== 'running') return null;
  host.db.prepare("UPDATE image_builds SET status = 'interrupted', error_json = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .run(redactedErrorJson(reasonError('restarted')), now, b.id);
  recordTx(host, system, { decision: 'image_interrupted', reason: 'restarted', entity: { type: 'image_build', id: b.id, onBehalfOf: b.requested_by, projectId: null },
    imageBuildId: b.id, approvalId: b.approval_id, summary: `image build of ${b.profile_id} interrupted by a restart`,
    data: { buildId: b.id, profileId: b.profile_id, status: 'interrupted' } }, now);
  return { decision: 'image_interrupted', count: 'images' };
}

// ---------- phase A ----------

/** Phase A (see the module header). System only; never throws past its authorization check. */
export function recoverPhaseA(host: RecoveryHost, system: Principal, bootId: string, now: number): PhaseAReport {
  requireSystem(host, system, 'recover_phase_a');
  checkBoot(bootId);
  const c = counters();
  const db = host.db;
  const ids = (db.prepare(`SELECT id FROM jobs WHERE state IN ('leased','running','awaiting_approval') ORDER BY created_at, rowid`).all() as
    { id: string }[]).map((r) => r.id);
  if (!host.available) {
    // Hold mode: no v9 table is written; a job with a live attempt (or any job, when the attempts cannot be read) stays.
    let live: Set<string> | null = null;
    try {
      live = new Set((db.prepare("SELECT DISTINCT job_id FROM job_attempts WHERE state IN ('starting','running')").all() as { job_id: string }[])
        .map((r) => r.job_id));
    } catch { live = null; }
    for (const id of ids) {
      if (live === null || live.has(id)) { c.pending++; continue; }
      decide(host, c, 'a job', () => {
        const r = host.jobs.recoverJobTx(system, id, now);
        return r ? { decision: r === 'requeued' ? 'requeue' : 'interrupt', count: r } : null;
      });
    }
    return report(c, true);
  }
  for (const id of ids) decide(host, c, 'a job', () => phaseAJobTx(host, system, bootId, id, now));
  // Pending approvals past their time that no waiting job held (image preparation; any other leftover).
  const due = db.prepare("SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at, id").all(now) as { id: string }[];
  for (const { id } of due) decide(host, c, 'an approval', () => expireApprovalTx(host, system, id, now));
  // B2b Task 9, accept reconcile (a clearly separate block): an accept job that ended without an accept row, whose
  // `accept.prepared` was reported, is answered with `changeset.accept_rollback { from: new, to: old }`, never retried.
  for (const id of endedAcceptJobIds(db)) decide(host, c, 'an accept', () => acceptReconcileTx(host, system, id, now));
  // B2b Task 10, agent turns (a clearly separate block, beside the accept reconcile, not interleaved with it): a live agent
  // attempt is abandoned, its job and session are interrupted and its token revoked (`restart`); the worktree is kept.
  for (const id of liveAgentTurnIds(db)) decide(host, c, 'an agent turn', () => agentTurnRecoveryTx(host, system, id, now));
  // A `docker build` client dies with the runner: a build left running can never report.
  const builds = db.prepare("SELECT id FROM image_builds WHERE status = 'running' ORDER BY started_at, id").all() as { id: string }[];
  for (const { id } of builds) decide(host, c, 'an image build', () => interruptBuildTx(host, system, id, now));
  return report(c, false);
}

/** B2b Task 9: one ended accept job's rollback (see the module header). Null when nothing is owed. */
function acceptReconcileTx(host: RecoveryHost, system: Principal, jobId: string, now: number): Outcome | null {
  const n = rollbackNeeded(host.db, jobId);
  if (!n) return null;
  const rollbackJob = enqueueAcceptRollbackTx(host.db, host.jobs, system, now, { jobId: n.job.id, projectId: n.job.project_id,
    workspaceId: n.job.workspace_id, branch: n.branch, versionId: n.versionId, move: n.move });
  recordTx(host, system, { decision: 'accept_rollback', reason: 'accept_unfinished', job: jobRow(host.db, n.job.id), attemptN: null,
    summary: 'an accept that did not finish is rolled back; it is never retried or merged later', data: { rollbackJob } }, now);
  return { decision: 'accept_rollback', count: null };
}

/** The agent turn jobs that are leased, running or waiting for approval: the ones a restart cuts off. */
function liveAgentTurnIds(db: Database.Database): string[] {
  return (db.prepare("SELECT id FROM jobs WHERE kind = 'agent.run' AND state IN ('leased','running','awaiting_approval') ORDER BY created_at, rowid").all() as
    { id: string }[]).map((r) => r.id);
}

/**
 * B2b Task 10: one agent turn cut off by a restart. Its attempt is abandoned (its runner, its container and its runtime
 * process died with the app), the job and its session are interrupted and its token is revoked (`restart`). The worktree is
 * kept exactly as it is: a new message opens a new session on it. The turn's container is no longer a live attempt's, so
 * phase B removes it as an orphan of an ended attempt. Never completed, never retried.
 */
function agentTurnRecoveryTx(host: RecoveryHost, system: Principal, jobId: string, now: number): Outcome | null {
  const j = jobRow(host.db, jobId);
  if (!j || j.kind !== 'agent.run' || !LIVE_JOB_STATES.includes(j.state)) return null;
  const a = liveAttemptOf(host.db, j.id);
  if (!a) {
    // No attempt (a turn is leased together with its attempt, so this is a damaged row): B1's rule for a job without one.
    const r = host.jobs.recoverJobTx(system, j.id, now);
    if (!r) return null;
    const decision = r === 'requeued' ? 'requeue' : 'interrupt';
    if (host.interruptAgentTurnTx && r === 'interrupted') host.interruptAgentTurnTx(system, j.id, now, 'restart');
    recordTx(host, system, { decision, reason: 'no_live_attempt', job: j, summary: r === 'requeued' ? 'job queued again after a restart' : 'job interrupted by a restart' }, now);
    return { decision, count: r };
  }
  return agentTurnCutOffTx(host, system, j, a, 'agent_restart', 'restart', now);
}

/** The attempt is abandoned, the job interrupted, the token revoked and a running session interrupted (shared with phase B's runner restart). */
function agentTurnCutOffTx(host: RecoveryHost, system: Principal, j: JobRow, a: AttemptRow, reason: 'agent_restart' | 'agent_runner_lost',
  revoke: 'restart' | 'runner_restart', now: number): Outcome {
  abandonTx(host, j, a, reason, now);
  // The token first, with the reason of this decision (the job's end would revoke it as `job_ended`).
  if (host.interruptAgentTurnTx) host.interruptAgentTurnTx(system, j.id, now, revoke);
  host.moveJobTx(j.id, 'interrupted', now, { outcome: 'interrupted', error: reasonError(reason) });
  host.setPhaseTx(j.id, null, now);
  recordTx(host, system, { decision: 'interrupt', reason, job: j, attemptN: a.n, summary: `job interrupted: ${REASON_TEXT[reason]}` }, now);
  return { decision: 'interrupt', count: 'interrupted' };
}

function report(c: Counters, held: boolean): PhaseAReport {
  return { held, requeued: c.requeued, interrupted: c.interrupted, expired: c.expired, pending: c.pending,
    jobs: { interrupted: c.jobsInterrupted, requeued: c.jobsRequeued }, decisions: c.decisions, errors: c.errors };
}

// ---------- phase B ----------

/** The `reconcile.list` main sends at runner `ready`: every live attempt whose container is recorded. */
export function reconcileList(db: Database.Database): { attemptId: string; containerId: string; kind: 'tool' | 'service' }[] {
  const rows = db.prepare(`SELECT a.id, a.container_id, j.recipe_id FROM job_attempts a JOIN jobs j ON j.id = a.job_id
    WHERE a.state IN ('starting','running') AND a.container_id IS NOT NULL ORDER BY a.created_at, a.id`).all() as
    { id: string; container_id: string; recipe_id: string | null }[];
  return rows.map((r) => ({ attemptId: r.id, containerId: r.container_id,
    kind: getRecipe(r.recipe_id ?? '')?.executor === 'service' ? 'service' as const : 'tool' as const }));
}

/** Adopted for finalization: the runner re-hashes `/out` and reports the exit again; it is ingested like a live one. */
function finalizeTx(host: RecoveryHost, system: Principal, bootId: string, j: JobRow, a: AttemptRow, reason: string, now: number,
  data: Record<string, unknown>, service: boolean): Outcome {
  adoptAttemptTx(host.db, a, bootId, now, j.project_id, { summary: `attempt ${a.n} exited while the app was closed; collecting its outputs`,
    data: { decision: 'finalize', reason, ...data } });
  if (!service) host.setPhaseTx(j.id, 'collecting', now);
  recordTx(host, system, { decision: 'finalize', reason, job: j, attemptN: a.n, summary: '', event: false, data }, now);
  const msg: MainToRunner = { op: 'attempt.adopt', attemptId: a.id, containerId: a.container_id!, logPath: host.logPathOf(a) };
  return { decision: 'finalize', count: 'finalized', after: () => { host.awaitExit(a.id); host.send(msg); } };
}

/**
 * A dev deployment stopped before the restart (the user, its lifetime, the app quitting) whose job waited for the exit,
 * and whose containers are gone: the job fails `exit_not_reported`, as the deployment pass ends it when no exit arrives
 * in time. Never completed: the exit that would have completed it was never observed. The deployment keeps its end.
 */
function exitLostTx(host: RecoveryHost, system: Principal, j: JobRow, a: AttemptRow, reason: string, now: number, short: string): Outcome {
  abandonTx(host, j, a, reason, now);
  const error = { code: 'exit_not_reported', message: 'the dev deployment was stopped before the restart and its exit was never reported' };
  host.moveJobTx(j.id, 'failed', now, { outcome: 'exit_not_reported', error });
  host.setPhaseTx(j.id, null, now);
  recordTx(host, system, { decision: 'exit_lost', reason, job: j, attemptN: a.n, summary: 'the stopped dev deployment\'s exit was never reported',
    data: { container: short } }, now);
  return { decision: 'exit_lost', count: 'failed' };
}

function phaseBContainerTx(host: RecoveryHost, system: Principal, bootId: string, attemptId: string, entry: ReconciledAttempt | undefined,
  dockerDown: boolean, now: number): Outcome | null {
  const db = host.db;
  const a = attemptRow(db, attemptId);
  if (!a || (a.state !== 'starting' && a.state !== 'running') || a.container_id === null) return null;
  // This process is ingesting its exit right now (a runner restart mid-ingest): the ingest decides, not recovery.
  if (host.isCollecting(a.id)) return null;
  const j = jobRow(db, a.job_id)!;
  // B2b Task 10: an agent turn cannot be adopted (its runtime process lived in the runner that restarted): it is cut off like
  // an app restart does, and its container, now an orphan of an ended attempt, is removed with the other leftovers.
  if (j.kind === 'agent.run') {
    const o = agentTurnCutOffTx(host, system, j, a, 'agent_runner_lost', 'runner_restart', now);
    return { ...o, after: () => { host.send({ op: 'attempt.release', attemptId: a.id }); } };
  }
  const recipe = j.recipe_id ? getRecipe(j.recipe_id) : null;
  const service = recipe?.executor === 'service';
  const short = a.container_id.slice(0, 12);
  // A durable exit: its outputs live under the data home, not in Docker. Adopted for finalization whatever Docker says.
  if (!service && durableExit(db, j, a)) {
    return finalizeTx(host, system, bootId, j, a, 'exit_durable', now, { container: short, docker: dockerDown ? 'down' : 'running' }, false);
  }
  // The runner's word informs the decision only: an unreported attempt, or an entry without the recorded container id or
  // with another one, is missing.
  const sameContainer = entry?.containerId === a.container_id;
  const state = dockerDown || !entry || !sameContainer ? 'missing' : entry.container;
  const reason = dockerDown ? 'docker_unavailable_at_recovery' : `container_${state}`;
  if (state === 'running') {
    adoptAttemptTx(db, a, bootId, now, j.project_id, { summary: `attempt ${a.n} adopted: its container is still running`,
      data: { decision: 'adopt', reason, container: short } });
    recordTx(host, system, { decision: 'adopt', reason, job: j, attemptN: a.n, summary: '', event: false, data: { container: short } }, now);
    const msgs: MainToRunner[] = [{ op: 'attempt.adopt', attemptId: a.id, containerId: a.container_id, logPath: host.logPathOf(a) }];
    // A dev deployment stopped before the restart (its job waited for the exit): the runner stops what still runs.
    const dep = service ? db.prepare('SELECT status FROM deployments WHERE job_id = ?').get(j.id) as { status: string } | undefined : undefined;
    if (dep && (dep.status === 'stopped' || dep.status === 'failed')) msgs.push({ op: 'attempt.cancel', attemptId: a.id, graceMs: CANCEL_GRACE_MS, reason: 'timeout' });
    return { decision: 'adopt', count: 'adopted', after: () => { for (const m of msgs) host.send(m); } };
  }
  if (state === 'exited') {
    const exit: ExitInfo | undefined = entry?.exit;
    if (!service && recipe && exit && entry?.staged) {
      // Judged now from inspect and the staged list when they already show the attempt cannot pass; never ingested.
      const fail = exitFailure(recipe, exit, entry.staged, [], null);
      if (fail) {
        transitionAttemptTx(db, a, 'failed', now, j.project_id, { exit: { code: exit.code, signal: exit.signal, oomKilled: exit.oomKilled },
          outcome: fail.outcome, error: fail.error });
        host.failJobTx(j.id, fail.outcome, fail.error, now);
        // `status` names the failure for the activity sentence (oom, nonzero_exit, invalid_output).
        recordTx(host, system, { decision: 'fail', reason, job: j, attemptN: a.n, summary: `exited while the app was closed; ${fail.error.message}`,
          data: { status: fail.outcome, exit: exit.code, oomKilled: exit.oomKilled, staged: entry.staged.length } }, now);
        return { decision: 'fail', count: 'finalized', after: () => { host.send({ op: 'attempt.release', attemptId: a.id }); } };
      }
    }
    return finalizeTx(host, system, bootId, j, a, reason, now, { container: short, exit: exit ? exit.code : null, oomKilled: exit ? exit.oomKilled : null,
      staged: entry?.staged ? entry.staged.length : null }, service);
  }
  // created (never started) or missing.
  let out: Outcome;
  if (service) {
    const dep = db.prepare('SELECT status FROM deployments WHERE job_id = ?').get(j.id) as { status: string } | undefined;
    // A dev deployment already stopped before the restart (its job waited for the exit): that exit will never come.
    out = dep && (dep.status === 'stopped' || dep.status === 'failed') ? exitLostTx(host, system, j, a, reason, now, short)
      : interruptTx(host, system, j, a, reason, now, { container: short });
  } else {
    out = retryOrInterruptTx(host, system, j, a, reason, now, { container: short });
  }
  if (state === 'created') out.after = () => { host.send({ op: 'attempt.release', attemptId: a.id }); };
  return out;
}

function phaseBApprovalWaitTx(host: RecoveryHost, system: Principal, bootId: string, attemptId: string, now: number): Outcome | null {
  const a = attemptRow(host.db, attemptId);
  if (!a || (a.state !== 'starting' && a.state !== 'running') || a.lease_owner === bootId) return null;
  const j = jobRow(host.db, a.job_id);
  if (!j || j.state !== 'awaiting_approval') return null;
  const o = reownTx(host, system, bootId, j, a, 'approval_pending', now);
  return o.decision ? o : null;
}

/** The attempt ids among `ids` that this database holds. */
function knownAttemptIds(db: Database.Database, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500);
    for (const r of db.prepare(`SELECT id FROM job_attempts WHERE id IN (${part.map(() => '?').join(', ')})`).all(...part) as { id: string }[]) out.add(r.id);
  }
  return out;
}

/** Phase B (see the module header). System only; needs execution. Never throws past its checks. */
export function recoverPhaseB(host: RecoveryHost, system: Principal, bootId: string, reconcile: ReconcileResult, now: number): PhaseBReport {
  requireSystem(host, system, 'recover_phase_b');
  checkBoot(bootId);
  if (!host.available) throw new PlatformError('platform_unavailable', 'execution is not available on this database', { reason: 'not_enabled' });
  // A staged list over the protocol's array bound is dropped for its attempt only (that attempt is adopted to report its
  // exit again); everything else is validated as the runner's own message (exact keys, shapes and bounds).
  const rawAttempts: unknown = isObj(reconcile) ? reconcile.attempts : undefined;
  let stagedDropped = 0;
  const attempts = Array.isArray(rawAttempts) ? rawAttempts.map((x: unknown) => {
    if (isObj(x) && Array.isArray(x.staged) && x.staged.length > MAX_ARRAY_ITEMS) {
      stagedDropped++;
      const { staged: _dropped, ...rest } = x;
      return rest;
    }
    return x;
  }) : rawAttempts;
  const parsed = isObj(reconcile)
    ? parseRunnerMessage({ op: 'reconcile.result', docker: reconcile.docker, attempts, labelled: reconcile.labelled }) : null;
  if (!parsed || parsed.op !== 'reconcile.result') throw new PlatformError('invalid', 'the reconcile result is malformed', { reason: 'bad_reconcile' });
  if (stagedDropped > 0) host.log(`[nexus] execution recovery: ${stagedDropped} staged list(s) over ${MAX_ARRAY_ITEMS} entries ignored; those attempts report their exit again`);
  const c = counters();
  const db = host.db;
  const dockerDown = parsed.docker !== 'running';
  const byId = new Map(parsed.attempts.map((x) => [x.attemptId, x]));
  const live = db.prepare(`SELECT id, container_id FROM job_attempts WHERE state IN ('starting','running') ORDER BY created_at, id`).all() as
    { id: string; container_id: string | null }[];
  for (const a of live) {
    if (a.container_id !== null) decide(host, c, 'an attempt', () => phaseBContainerTx(host, system, bootId, a.id, byId.get(a.id), dockerDown, now));
    else decide(host, c, 'an approval wait', () => phaseBApprovalWaitTx(host, system, bootId, a.id, now));
  }
  // After the decisions: an attempt still live (adopted, waiting, or whose decision failed) keeps every resource.
  const liveAfter = new Set((db.prepare("SELECT id FROM job_attempts WHERE state IN ('starting','running')").all() as { id: string }[]).map((r) => r.id));
  const labelledAttempts = parsed.labelled.map((r) => r.labels['nexus.attempt']).filter((x): x is string => typeof x === 'string' && x.length > 0);
  const orphans = orphanDecisions(parsed, { home: host.home, liveAttempts: liveAfter, knownAttempts: knownAttemptIds(db, labelledAttempts) });
  const n = (list: readonly { kind: string }[], k: string): number => list.filter((r) => r.kind === k).length;
  if (orphans.remove.length > 0) {
    decide(host, c, 'the leftover resources', () => {
      recordTx(host, system, { decision: 'orphans', reason: 'attempt_ended', summary: '', event: false,
        data: { containers: n(orphans.remove, 'container'), volumes: n(orphans.remove, 'volume'), networks: n(orphans.remove, 'network') } }, now);
      return { decision: 'orphans', count: null };
    });
  }
  if (orphans.unknown.length > 0) {
    // Never removed: this install's label, but an attempt this database does not know (a restored or replaced database).
    host.log(`[nexus] execution recovery: ${orphans.unknown.length} labelled resource(s) of this install name an attempt this database does not know; left in place`);
    decide(host, c, 'the unknown resources', () => {
      recordTx(host, system, { decision: 'unknown_resources', reason: 'attempt_unknown', summary: '', event: false,
        data: { containers: n(orphans.unknown, 'container'), volumes: n(orphans.unknown, 'volume'), networks: n(orphans.unknown, 'network') } }, now);
      return { decision: 'unknown_resources', count: null };
    });
  }
  host.log(`[nexus] execution recovery at runner ready: adopted=${c.adopted} finalized=${c.finalized} requeued=${c.requeued} `
    + `interrupted=${c.interrupted} failed=${c.failed} reowned=${c.reowned} orphans=${orphans.remove.length} unknown=${orphans.unknown.length} `
    + `docker=${parsed.docker}${c.errors ? ` errors=${c.errors}` : ''}`);
  return { adopted: c.adopted, finalized: c.finalized, requeued: c.requeued, interrupted: c.interrupted, failed: c.failed, reowned: c.reowned,
    decisions: c.decisions, errors: c.errors, remove: orphans.remove, unknown: orphans.unknown };
}

// ---------- the reconcile bound ----------

/**
 * The scheduler's pass once RECONCILE_BOUND_MS have passed since phase A: every live attempt with a recorded container
 * that is owned by none of `owners` (this process's boot ids) was never adopted or decided by a phase B. It fails
 * `runner_lost` (the core's failure rule: retried only when idempotent), one decision each, unless its exit is durable:
 * that one keeps waiting for finalization. Returns how many failed and how many still wait. Never throws.
 */
export function failUnreconciled(host: RecoveryHost, system: Principal, owners: readonly string[], now: number): { failed: number; waiting: number } {
  const c = counters();
  let rows: { id: string; lease_owner: string }[];
  try {
    rows = host.db.prepare("SELECT id, lease_owner FROM job_attempts WHERE state IN ('starting','running') AND container_id IS NOT NULL ORDER BY created_at, id")
      .all() as { id: string; lease_owner: string }[];
  } catch { return { failed: 0, waiting: 0 }; }
  for (const r of rows) {
    if (owners.includes(r.lease_owner)) continue;
    decide(host, c, 'an unreconciled attempt', () => {
      const a = attemptRow(host.db, r.id);
      if (!a || (a.state !== 'starting' && a.state !== 'running') || owners.includes(a.lease_owner) || host.isCollecting(a.id)) return null;
      const j = jobRow(host.db, a.job_id)!;
      if (durableExit(host.db, j, a)) return { decision: null, count: 'pending' };
      const error = reasonError('unreconciled');
      transitionAttemptTx(host.db, a, 'failed', now, j.project_id, { outcome: 'runner_lost', error: { code: 'runner_lost', message: error.message } });
      host.failJobTx(j.id, 'infra_error', { code: 'runner_lost', message: error.message }, now);
      recordTx(host, system, { decision: 'unreconciled', reason: 'unreconciled', job: j, attemptN: a.n,
        summary: 'the runner did not pick the attempt up again within 10 minutes of the restart' }, now);
      // Its container may still run: once this has committed, an attached runner is told to stop it (no-op without one).
      return { decision: 'unreconciled', count: 'failed',
        after: () => { host.send({ op: 'attempt.cancel', attemptId: a.id, graceMs: CANCEL_GRACE_MS, reason: 'timeout' }); } };
    });
  }
  return { failed: c.failed, waiting: c.pending };
}

// ---------- blob store hygiene ----------

/**
 * Whether the latest `started` blob.gc row has no closing row: a GC whose process stopped before it recorded its file
 * delete. A GC's own row closes it; a hygiene row (`recovered`) closes it only when it finished it (`finishedGc`).
 */
function unfinishedGc(db: Database.Database): boolean {
  const s = db.prepare("SELECT seq FROM activity WHERE action = 'blob.gc' AND status = 'started' ORDER BY seq DESC LIMIT 1").get() as { seq: number } | undefined;
  if (!s) return false;
  return !db.prepare(`SELECT 1 FROM activity WHERE action = 'blob.gc' AND seq > ? AND status <> 'started'
    AND (json_extract(details_json, '$.recovered') IS NOT 1 OR json_extract(details_json, '$.finishedGc') = 1) LIMIT 1`).get(s.seq);
}

function indexedShas(db: Database.Database, shas: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < shas.length; i += 500) {
    const part = shas.slice(i, i + 500);
    for (const r of db.prepare(`SELECT sha256 FROM blobs WHERE sha256 IN (${part.map(() => '?').join(', ')})`).all(...part) as { sha256: string }[]) out.add(r.sha256);
  }
  return out;
}

async function sweep(host: RecoveryHost, files: BlobStoreFiles, now: number, out: BlobSweepReport): Promise<void> {
  const db = host.db;
  const cutoff = now - STALE_OBJECT_MS;
  try {
    const tmp = await files.sweepObjectsTmp(cutoff);
    out.tmpRemoved = tmp.removed; out.tmpFailed = tmp.failed;
  } catch { out.tmpFailed++; }
  const open = unfinishedGc(db);
  const listed = await files.listObjectFiles(MAX_SWEEP_OBJECTS);
  const indexed = indexedShas(db, listed.objects.map((o) => o.sha256));
  // Stored bytes with a second (writable) name are surfaced whatever their age; they are never deleted here.
  out.hardLinkedIndexed = listed.objects.filter((o) => indexed.has(o.sha256) && o.nlink > 1).length;
  const liveAttempts = (db.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE state IN ('starting','running')").get() as { n: number }).n;
  if (liveAttempts > 0) { out.objectsDeferred = true; return; }
  const unindexed = listed.objects.filter((o) => !indexed.has(o.sha256));
  const old = unindexed.filter((o) => o.mtimeMs < cutoff);
  out.hardLinked = old.filter((o) => o.nlink > 1).length;
  if (old.length > 0) {
    let failed: readonly string[];
    try { failed = (await files.deleteObjects(old.map((o) => o.sha256))).failed; } catch { failed = old.map((o) => o.sha256); }
    out.objectsFailed = failed.length;
    out.objectsRemoved = old.length - failed.length;
  }
  // A GC run is finished when nothing it may have left could still go: every unindexed object was old enough to be tried
  // (none younger than 24 h remains). Deletes that were refused (a hard link, a link) are its `leftover`: the run closes,
  // and they are reported failed on every pass.
  out.leftover = out.objectsFailed;
  out.finishedGc = open && !listed.truncated && unindexed.length === old.length;
}

/** Blob store hygiene (see the module header). System only. Resolves with what it did; never rejects past its checks. */
export async function recoverBlobStore(host: RecoveryHost, system: Principal, now: number): Promise<BlobSweepReport> {
  requireSystem(host, system, 'recover_blob_store');
  const none: BlobSweepReport = { ran: false, reason: null, tmpRemoved: 0, tmpFailed: 0, objectsRemoved: 0, objectsFailed: 0, hardLinked: 0,
    hardLinkedIndexed: 0, objectsDeferred: false, leftover: 0, finishedGc: false };
  const files = host.files; const blobs = host.blobs;
  if (!host.available || !files || !blobs) return { ...none, reason: 'not_available' };
  const release = blobs.lock.tryExclusive();
  if (!release) return { ...none, reason: 'busy' };
  const out: BlobSweepReport = { ...none, ran: true };
  try {
    try {
      await sweep(host, files, now, out);
    } catch (e) {
      out.reason = 'error';
      host.log(`[nexus] blob store hygiene stopped (${codeOf(e)}); it runs again at the next start`);
    }
    const problems = out.objectsFailed + out.tmpFailed + out.hardLinkedIndexed;
    if (out.tmpRemoved > 0 || out.objectsRemoved > 0 || problems > 0 || out.finishedGc) {
      try {
        immediateTx(host.db, () => appendActivityRow(host.db, { actorKind: system.kind, actorId: system.id, entityType: 'blob', action: 'blob.gc',
          status: problems > 0 ? 'failed' : 'succeeded',
          details: { recovered: true, removed: out.objectsRemoved, fileDeleteFailed: out.objectsFailed + out.tmpFailed, hardLinked: out.hardLinked,
            hardLinkedIndexed: out.hardLinkedIndexed, tmpRemoved: out.tmpRemoved, objectsDeferred: out.objectsDeferred, leftover: out.leftover,
            finishedGc: out.finishedGc } }, now));
      } catch (e) {
        host.log(`[nexus] blob store hygiene: its activity row was not recorded (${codeOf(e)})`);
      }
    }
    host.log(`[nexus] blob store hygiene: tmpRemoved=${out.tmpRemoved} objectsRemoved=${out.objectsRemoved} `
      + `fileDeleteFailed=${out.objectsFailed + out.tmpFailed} hardLinked=${out.hardLinked} hardLinkedIndexed=${out.hardLinkedIndexed} leftover=${out.leftover}`
      + `${out.objectsDeferred ? ' objects=deferred (attempts live)' : ''}${out.finishedGc ? ' unfinishedGc=finished' : ''}`);
    return out;
  } finally {
    release();
  }
}
