// Pure: the project's recent activity (nexus:activity:byProject) as plain
// sentences. Each row becomes who acted ("You", "Nexus", "Nexus, for you"),
// what happened in words, and when. No principal id, no raw details: a sentence
// reads only the allow-listed detail keys below, and only values of the
// expected shape. No React, so tests load it directly.
import type { ActivityView, ArtifactSummaryView, NexusResult } from '@shared/nexus/ipc';
import { errorCopy } from '../data/errorCopy';
import { relativeTime } from '../data/selectors';
import { kindLabel } from './artifactModel';

/** How many rows one read asks for (the channel allows up to 50). */
export const ACTIVITY_PAGE = 20;

/** The only detail keys a sentence ever reads. Everything else in `details` is never looked at. */
export const ACTIVITY_DETAIL_ALLOW: readonly string[] = Object.freeze([
  'versionNo', 'to', 'rollback', 'source', 'reactivated', 'subjects', 'toWorkspaceId', 'withNote', 'kind', 'workspaceId',
  // B2a Task 9: approvals, image builds and dev deployments (each read only as one of a fixed set of values).
  'reason', 'decision', 'status', 'job',
  // B2a Task 11: how many leftover sandbox resources main asked the runner to remove (a count).
  'requested',
  // B2b Task 7: whether a job's worktree was freshly created or an existing one was reused (a flag, never a path).
  'reused'
]);

/** Every action the platform services write to the activity log. */
export const ACTIVITY_ACTIONS: readonly string[] = Object.freeze([
  'artifact.create', 'artifact.archive',
  'version.register', 'version.update_draft', 'version.finalize', 'version.promote', 'version.discard',
  // B2a Task 13 fix round 1: a user's Revalidate, recorded with its intent (IPC #33).
  'version.revalidate',
  'lineage.write',
  'participation.attach', 'participation.withdraw',
  'handoff.send', 'handoff.accept', 'handoff.decline', 'handoff.withdraw',
  'job.create', 'job.cancel', 'job.recover', 'job.transition',
  'session.open', 'session.cancel', 'session.recover', 'session.transition',
  'db.migrated', 'workspace.catalog_ensured', 'project_workspace.primary_synced',
  'blob.gc', 'approval.withdraw',
  'approval.request', 'approval.respond', 'approval.expire', 'image_build.start', 'image_build.finish',
  'deployment.start', 'deployment.transition', 'deployment.stop',
  // B2a Task 10: restart recovery's decisions.
  'exec.recover',
  // B2a Task 11: leftover sandbox resources of ended runs, handed to the runner for removal after a restart.
  'exec.orphan_removed',
  // B2b Task 4: the agent's network permission, and its per-turn capability tokens (counts only, never the token).
  'agent.consent', 'token.mint', 'token.revoke',
  // B2b Task 7: a job's git worktree was prepared (never the worktree's own path, which is never in details).
  'repo.worktree'
]);

/** Plain words for an action a person may be refused (every platform action). */
const ACTION_WORDS: Record<string, string> = {
  'project.read': 'read the project',
  'workspace.read': 'read a workspace',
  'participation.attach': 'add the project to a workspace',
  'participation.withdraw': 'withdraw the project from a workspace',
  'artifact.read': 'read an artifact',
  'artifact.create': 'create an artifact',
  'artifact.archive': 'archive an artifact',
  'version.register': 'save a version',
  'version.update_draft': 'change a draft',
  'version.discard': 'discard a version',
  'version.promote': 'make a version current',
  'version.finalize': 'mark a version ready',
  'lineage.read': 'read links between versions',
  'lineage.write': 'link versions',
  'job.read': 'read a job',
  'job.create': 'start a job',
  'job.cancel': 'stop a job',
  'job.transition': 'move a job on',
  'job.recover': 'recover a job',
  'session.read': 'read an agent session',
  'session.open': 'open an agent session',
  'session.cancel': 'stop an agent session',
  'session.transition': 'move an agent session on',
  'session.recover': 'recover an agent session',
  'activity.read': 'read the activity',
  'system.reconcile': 'reconcile the records',
  'handoff.read': 'read a handoff',
  'handoff.send': 'send a handoff',
  'handoff.respond': 'answer a handoff',
  'handoff.withdraw': 'withdraw a handoff',
  'handoff.accept': 'accept a handoff',
  'handoff.decline': 'decline a handoff',
  'db.migrated': 'upgrade the database',
  'workspace.catalog_ensured': 'update the workspace list',
  'project_workspace.primary_synced': 'set the main workspace',
  'blob.gc': 'clean up unused stored files',
  'approval.read': 'read approvals',
  'approval.respond': 'answer an approval',
  'approval.withdraw': 'withdraw an approval',
  'approval.request': 'ask for an approval',
  'approval.expire': 'let an approval request expire',
  'image_build.start': 'start preparing a sandbox image',
  'image_build.finish': 'prepare a sandbox image',
  'deployment.start': 'start a dev deployment',
  'deployment.transition': 'update a dev deployment',
  'deployment.stop': 'stop a dev deployment',
  'exec.recover': 'recover work after a restart',
  'exec.orphan_removed': 'remove leftover sandbox resources',
  'version.revalidate': 'run the checks again',
  'platform.health': 'read the platform health',
  // B2b Task 4.
  'agent.start': 'start an agent turn',
  'review.decide': 'decide a review',
  'changeset.accept': 'accept a change set',
  'repo.merge': 'merge accepted work',
  'repo.worktree': "prepare the agent's working copy",
  'agent.consent': "change the agent's network permission",
  'token.mint': "issue the agent's turn permission",
  'token.revoke': "end the agent's turn permission",
  'auth.denied': 'act with its turn permission'
};

const ACTION_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const WORKSPACE_SHAPE = /^[a-z][a-z0-9-]{1,31}$/;
const KIND_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/** An action as it may appear on screen: its own dotted name only, never other text. */
function safeAction(action: unknown): string {
  return typeof action === 'string' && action.length <= 64 && ACTION_SHAPE.test(action) ? action : 'an action';
}

/** Plain words for an action; an unknown one reads as its own dotted name. */
export function actionWords(action: string): string {
  return Object.prototype.hasOwnProperty.call(ACTION_WORDS, action) ? ACTION_WORDS[action] : safeAction(action);
}

/** One allow-listed detail value. A key outside the allow-list is never read. */
function detail(row: ActivityView, key: string): unknown {
  if (!ACTIVITY_DETAIL_ALLOW.includes(key)) return undefined;
  const d = row.details;
  if (!d || typeof d !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
}

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

export interface ActivityContext {
  /** artifactId → name, from the project's artifact summaries. */
  names: ReadonlyMap<string, string>;
  /** versionId → version number, from the summaries and the rows themselves. */
  versionNos: ReadonlyMap<string, number>;
  /** A workspace's label from the renderer registry (falls back to its id). */
  workspaceLabel: (workspaceId: string) => string;
  now: number;
}

export interface ActivityLine {
  key: string;
  /** "You", "Nexus", "Nexus, for you", "An agent". */
  actor: string;
  /** What happened, as a sentence. */
  text: string;
  /** "just now", "5m ago", "Mar 3". */
  when: string;
  /** ISO time for the <time> element. */
  at: string;
}

/** Who acted, in words. The principal id is never shown. */
export function actorText(row: Pick<ActivityView, 'actorKind' | 'onBehalfOfUser'>): string {
  if (row.actorKind === 'user') return 'You';
  if (row.actorKind === 'system') return row.onBehalfOfUser ? 'Nexus, for you' : 'Nexus';
  if (row.actorKind === 'agent') return 'An agent';
  return 'Someone';
}

function artifactName(row: ActivityView, ctx: ActivityContext): string | null {
  return row.artifactId ? ctx.names.get(row.artifactId) ?? null : null;
}

/** "Version 2 of API notes", "A version of API notes", "Version 2", "A version". */
function versionPhrase(row: ActivityView, ctx: ActivityContext): string {
  const name = artifactName(row, ctx);
  const no = posInt(detail(row, 'versionNo')) ?? (row.versionId ? ctx.versionNos.get(row.versionId) ?? null : null);
  if (no !== null) return name ? `Version ${no} of ${name}` : `Version ${no}`;
  return name ? `A version of ${name}` : 'A version';
}

function workspacePhrase(id: unknown, ctx: ActivityContext): string | null {
  return typeof id === 'string' && WORKSPACE_SHAPE.test(id) ? ctx.workspaceLabel(id) : null;
}

/** Job states and agent session statuses, in words. */
const JOB_STATE_WORDS: Record<string, string> = {
  queued: 'queued', leased: 'picked up', running: 'started running', awaiting_approval: 'is waiting for approval',
  // B2a final review: a job's state "completed" means it ran and its outputs were collected; whether its checks
  // passed is a separate fact (a run whose tests failed is still a completed job), so the sentence never says more.
  retry_scheduled: 'will be tried again', completed: 'ran; its checks give the result', partial: 'ran in part', failed: 'failed',
  cancelled: 'was stopped', timed_out: 'timed out', interrupted: 'was interrupted', open: 'opened'
};

function stateMove(subject: string, to: unknown): string {
  const words = typeof to === 'string' && Object.prototype.hasOwnProperty.call(JOB_STATE_WORDS, to) ? JOB_STATE_WORDS[to] : null;
  return words ? `${subject} ${words}` : `${subject} changed status`;
}

/** Why a dev deployment ended, in words (the `reason` of a `deployment.transition` row). */
const DEPLOYMENT_FAILED_WORDS: Record<string, string> = {
  probe_failed: 'Dev deployment failed: it did not answer its health check within 60 seconds',
  exited: 'Dev deployment failed: the app stopped running',
  start_timeout: 'Dev deployment failed: it did not start in time',
  refused: 'Dev deployment failed: it could not be started on this computer',
  preflight_failed: 'Dev deployment failed: its sandbox did not pass the safety checks',
  runner_lost: 'Dev deployment failed: the process that ran it stopped',
  exit_not_reported: 'Dev deployment failed: its exit was never reported'
};
const DEPLOYMENT_STOPPED_WORDS: Record<string, string> = {
  idle: 'Dev deployment stopped at the end of its 2-hour lifetime',
  app_quit: 'Dev deployment stopped when the app quit',
  recovery: 'Dev deployment stopped after a restart',
  cancel: 'Dev deployment stopped with its job',
  user: 'Dev deployment stopped'
};
const IMAGE_BUILD_WORDS: Record<string, string> = {
  succeeded: 'Sandbox image prepared',
  interrupted: 'Sandbox image preparation was interrupted',
  failed: 'Sandbox image preparation failed',
  cancelled: 'Sandbox image preparation stopped'
};
/** What restart recovery decided (the `decision` of an `exec.recover` row). Never a completion: recovery completes nothing. */
const RECOVER_WORDS: Record<string, string> = {
  requeue: 'Job queued again after a restart: it had not started yet',
  retry: 'Job will be tried again: it was cut off by a restart',
  interrupt: 'Job interrupted by a restart',
  reown: 'Job still waits for approval after a restart',
  expire: 'Approval ran out while the app was closed; the job did not run',
  adopt: 'Running job picked up again after a restart',
  finalize: 'Job stopped while the app was closed; its result is being checked',
  exit_lost: 'Dev deployment\'s job failed after a restart: its exit was never reported',
  unreconciled: 'Job failed: the sandbox runner did not pick it up again within 10 minutes of a restart',
  unknown_resources: 'Sandbox resources naming a job this app does not know were found after a restart and left in place',
  image_interrupted: 'Sandbox image preparation was interrupted by a restart',
  orphans: 'Leftover sandbox resources from before a restart were found and set for removal'
};
/** A job restart recovery failed from what its stopped container showed (the `status` of a `fail` decision). */
const RECOVER_FAIL_WORDS: Record<string, string> = {
  oom: 'Job failed: it ran out of memory while the app was closed',
  nonzero_exit: 'Job failed: it exited with an error while the app was closed',
  invalid_output: 'Job failed: it stopped while the app was closed without the outputs it needs'
};
/** An `exec.recover` row whose decision this build does not know: neutral, never "recovered". */
export const RECOVER_NEUTRAL = 'Restart recovery recorded a decision';
const pick = (table: Record<string, string>, key: unknown): string | null =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;

/** The sentence for a succeeded (or started) row of a known action; null for an unknown action. */
function sentence(row: ActivityView, ctx: ActivityContext): string | null {
  const name = artifactName(row, ctx);
  switch (row.action) {
    case 'artifact.create': {
      const kind = detail(row, 'kind');
      const label = typeof kind === 'string' && KIND_SHAPE.test(kind) ? kindLabel(kind) : 'Artifact';
      return name ? `${label} ${name} created` : `${label} created`;
    }
    case 'artifact.archive': return name ? `${name} archived` : 'An artifact archived';
    case 'version.register': return `${versionPhrase(row, ctx)} saved`;
    case 'version.update_draft': return `${versionPhrase(row, ctx)} updated as a draft`;
    case 'version.finalize': {
      const to = detail(row, 'to');
      if (to === 'candidate') return `${versionPhrase(row, ctx)} marked ready`;
      if (to === 'failed') return `${versionPhrase(row, ctx)} did not pass its checks`;
      return `${versionPhrase(row, ctx)} finished`;
    }
    case 'version.promote':
      return detail(row, 'rollback') === true ? `${versionPhrase(row, ctx)} made current again (roll back)` : `${versionPhrase(row, ctx)} made current`;
    case 'version.discard': return `${versionPhrase(row, ctx)} discarded`;
    case 'version.revalidate': return `Checks run again on ${versionPhrase(row, ctx).replace(/^[VA]/, (c) => c.toLowerCase())}`;
    case 'lineage.write':
      return detail(row, 'source') === 'handoff_convert'
        ? `${versionPhrase(row, ctx)} linked to a version it received`
        : `Source linked to ${versionPhrase(row, ctx).replace(/^[VA]/, (c) => c.toLowerCase())}`;
    case 'participation.attach': {
      const ws = workspacePhrase(row.workspaceId, ctx);
      const again = detail(row, 'reactivated') === true ? ' again' : '';
      return ws ? `Project added to ${ws}${again}` : `Project added to a workspace${again}`;
    }
    case 'participation.withdraw': {
      const ws = workspacePhrase(row.workspaceId, ctx);
      return ws ? `Project withdrawn from ${ws}` : 'Project withdrawn from a workspace';
    }
    case 'handoff.send': {
      const ws = workspacePhrase(detail(row, 'toWorkspaceId'), ctx);
      const n = posInt(detail(row, 'subjects'));
      const what = n === null ? 'Handoff' : n === 1 ? 'Handoff of 1 version' : `Handoff of ${n} versions`;
      return ws ? `${what} sent to ${ws}` : `${what} sent`;
    }
    case 'handoff.accept': {
      const ws = workspacePhrase(row.workspaceId, ctx);
      return ws ? `Handoff accepted in ${ws}` : 'Handoff accepted';
    }
    case 'handoff.decline': return detail(row, 'withNote') === true ? 'Handoff declined, with a note' : 'Handoff declined';
    case 'handoff.withdraw': return 'Handoff withdrawn';
    case 'job.create': return 'Job created';
    case 'job.cancel': return 'Job stopped';
    case 'job.recover': return 'Job recovered after a restart';
    case 'job.transition': return stateMove('Job', detail(row, 'to'));
    case 'session.open': return 'Agent session opened';
    case 'session.cancel': return 'Agent session stopped';
    case 'session.recover': return 'Agent session recovered after a restart';
    case 'session.transition': return stateMove('Agent session', detail(row, 'to'));
    case 'db.migrated': return 'Database upgraded';
    case 'workspace.catalog_ensured': return 'Workspace list updated';
    case 'blob.gc': return row.status === 'started' ? 'Clean-up of unused stored files started' : 'Unused stored files cleaned up';
    case 'approval.withdraw': return 'Approval request withdrawn: the job was stopped';
    case 'approval.request': {
      const reason = detail(row, 'reason');
      if (reason === 'egress.deps') return 'Approval asked: network access for one dependency install';
      if (reason === 'image.prepare') return 'Approval asked: prepare a sandbox image';
      return 'Approval asked';
    }
    case 'approval.respond': {
      const decision = detail(row, 'decision');
      const reason = detail(row, 'reason');
      if (decision === 'deny') return 'Approval denied';
      if (decision === 'once') {
        if (reason === 'egress.deps') return 'Network access approved once, for one dependency install';
        if (reason === 'image.prepare') return 'Sandbox image preparation approved once';
        return 'Approved once';
      }
      return 'Approval answered';
    }
    case 'approval.expire': return 'Approval request expired: it was not answered within 15 minutes';
    case 'image_build.start': return 'Sandbox image preparation started';
    case 'image_build.finish': return pick(IMAGE_BUILD_WORDS, detail(row, 'status')) ?? 'Sandbox image preparation ended';
    case 'deployment.start': return 'Dev deployment started, reachable from this computer only';
    case 'deployment.transition': {
      const to = detail(row, 'to');
      const reason = detail(row, 'reason');
      if (to === 'healthy') return 'Dev deployment answered its health check';
      if (to === 'unhealthy') return 'Dev deployment stopped answering its health check';
      if (to === 'stopped') return pick(DEPLOYMENT_STOPPED_WORDS, reason) ?? 'Dev deployment stopped';
      if (to === 'failed') return pick(DEPLOYMENT_FAILED_WORDS, reason) ?? 'Dev deployment failed';
      return 'Dev deployment changed status';
    }
    case 'deployment.stop':
      return detail(row, 'job') === 'completes_on_exit' ? 'Dev deployment stopped; its job finishes when the app has exited' : 'Dev deployment stopped';
    case 'exec.orphan_removed': {
      // Main hands the list to the runner; the row records the request, never a confirmed removal.
      const n = detail(row, 'requested');
      return typeof n === 'number' && Number.isSafeInteger(n) && n > 0
        ? `Asked the sandbox runner to remove ${n} leftover sandbox resource${n === 1 ? '' : 's'} of ended runs`
        : 'Asked the sandbox runner to remove leftover sandbox resources of ended runs';
    }
    case 'exec.recover': {
      // Each decision in its own words: a failure reads as a failure, an interruption as interrupted. Without a
      // decision this build knows, the sentence claims nothing about the outcome.
      const decision = detail(row, 'decision');
      if (decision === 'fail') return pick(RECOVER_FAIL_WORDS, detail(row, 'status')) ?? 'Job failed: it stopped while the app was closed';
      return pick(RECOVER_WORDS, decision) ?? RECOVER_NEUTRAL;
    }
    case 'agent.consent':
      return detail(row, 'op') === 'revoke' ? "The agent's network permission was revoked" : 'The agent was given network permission, with spend limits';
    case 'token.mint': return 'The agent was given a permission for one turn';
    case 'token.revoke': return "The agent's turn permission ended";
    case 'repo.worktree':
      return detail(row, 'reused') === true ? "The agent's job reused its working copy of the repository"
        : "A working copy of the repository was prepared for the agent's job";
    case 'project_workspace.primary_synced': {
      const ws = workspacePhrase(detail(row, 'workspaceId'), ctx);
      return ws ? `Main workspace set to ${ws}, from the project's domain` : "Main workspace set from the project's domain";
    }
    default: return null;
  }
}

/** What a row says happened. A refusal or failure names the action in words; an unknown action says only its name. */
export function activityText(row: ActivityView, ctx: ActivityContext): string {
  if (row.status === 'denied') return `Refused: ${actionWords(row.action)}`;
  if (row.status === 'failed') return `Failed: ${actionWords(row.action)}`;
  if (row.status === 'cancelled') return `Cancelled: ${actionWords(row.action)}`;
  return sentence(row, ctx) ?? `Recorded ${safeAction(row.action)}`;
}

export function activityLine(row: ActivityView, ctx: ActivityContext): ActivityLine {
  const ts = typeof row.ts === 'number' && Number.isFinite(row.ts) ? row.ts : NaN;
  return {
    key: String(row.seq),
    actor: actorText(row),
    text: activityText(row, ctx),
    when: Number.isFinite(ts) ? relativeTime(ts, ctx.now) : '',
    at: Number.isFinite(ts) ? new Date(ts).toISOString() : ''
  };
}

/** versionId → number: from the summaries (latest, current) and from each saved-version row's own number. */
export function versionNumbers(rows: readonly ActivityView[], summaries: readonly ArtifactSummaryView[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of summaries) {
    if (s.latest) out.set(s.latest.id, s.latest.versionNo);
    if (s.current) out.set(s.current.id, s.current.versionNo);
  }
  for (const r of rows) {
    const no = r.action === 'version.register' ? posInt(detail(r, 'versionNo')) : null;
    if (no !== null && r.versionId && !out.has(r.versionId)) out.set(r.versionId, no);
  }
  return out;
}

// ---------- the read state (first page, older pages, failures) ----------

export interface ActivityState {
  rows: ActivityView[];
  /** True once an answer arrived (success or not). */
  loaded: boolean;
  /** True when older rows exist than were read. */
  truncated: boolean;
  /** A passing failure worth a sentence. */
  error: string | null;
  /** True when sending the same read again may help. */
  retry: boolean;
  /** The platform is off: the section shows nothing (the platform notice explains). */
  unavailable: boolean;
  /** An older page is being read. */
  loadingMore: boolean;
}

export const NO_ACTIVITY: ActivityState = { rows: [], loaded: false, truncated: false, error: null, retry: false, unavailable: false, loadingMore: false };

/** The next state after a nexus:activity:byProject answer: 'first' replaces, 'more' appends an older page. */
export function nextActivity(prev: ActivityState, r: NexusResult<ActivityView[]>, page: 'first' | 'more'): ActivityState {
  if (r.ok) {
    const data = Array.isArray(r.data) ? r.data : [];
    const rows = page === 'first' ? data : [...prev.rows, ...data.filter((d) => !prev.rows.some((p) => p.seq === d.seq))];
    return { rows, loaded: true, truncated: r.truncated === true, error: null, retry: false, unavailable: false, loadingMore: false };
  }
  const copy = errorCopy(r.code, r.reason, r.subReason);
  if (copy.kind === 'unavailable') return { ...NO_ACTIVITY, loaded: true, unavailable: true };
  if (r.code === 'not_found' || r.code === 'denied') return { ...NO_ACTIVITY, loaded: true, error: copy.text };
  // A passing failure: keep what was read and offer to try again.
  return { ...prev, loaded: true, error: copy.text, retry: copy.retry, unavailable: false, loadingMore: false };
}

/** The `beforeSeq` of the next older page; null when there is none to ask for. */
export function olderPageCursor(s: ActivityState): number | null {
  if (!s.truncated || s.rows.length === 0) return null;
  const seqs = s.rows.map((r) => r.seq).filter((n) => Number.isInteger(n) && n > 0);
  return seqs.length ? Math.min(...seqs) : null;
}

/** The one line the section shows instead of rows; null when rows are shown. */
export function activityNotice(s: ActivityState): { kind: 'loading' | 'empty' | 'error'; text: string; retry: boolean } | null {
  if (s.error && s.rows.length === 0) return { kind: 'error', text: s.error, retry: s.retry };
  if (!s.loaded) return { kind: 'loading', text: 'Reading activity…', retry: false };
  if (s.rows.length === 0 && !s.error) return { kind: 'empty', text: 'Nothing has been recorded for this project yet.', retry: false };
  return null;
}
