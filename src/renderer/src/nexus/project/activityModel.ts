// Pure: the project's recent activity (nexus:activity:byProject) as plain
// sentences. Each row becomes who acted ("You", "Nexus", "Nexus, for you", "The AI helper"),
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
  'reused',
  // B2b Task 14: the consent row's `op` (grant or revoke), read only as one of those two words.
  'op'
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
  // The hosted-model runtime: a provider key was saved or deleted (the provider's id and the operation only; never the key).
  'hosted.key',
  // B2b Task 7: a job's git worktree was prepared (never the worktree's own path, which is never in details).
  'repo.worktree',
  // B2b Task 9: a user's review decision, an accepted change set (or an accept that was rolled back), the undo of an
  // accept that did not finish, and "Add to my project" (the merge) (never a path, a sha or a comment: only the decision word).
  'review.decide', 'changeset.accept', 'changeset.rollback', 'repo.merge',
  // B2b Task 5 (sentences added in Task 9's fix round): an agent tool call, and context left out of a turn for looking like a secret.
  'mcp.call', 'context_redacted',
  // B2b Task 5: the gateway's one refusal row for a turn permission that did not cover a call (words, never the call).
  'auth.denied',
  // B2b B6: the integration ref was moved forward to the user's own commits (commit ids only in its details).
  'repo.integration_resync'
]);

/** Plain words for an action a person may be refused (every platform action). */
const ACTION_WORDS: Record<string, string> = {
  'project.read': 'read the project',
  'workspace.read': 'read a workspace',
  'participation.attach': 'add the project to a workspace',
  'participation.withdraw': 'remove the project from a workspace',
  'artifact.read': 'read a saved item',
  'artifact.create': 'create a saved item',
  'artifact.archive': 'archive a saved item',
  'version.register': 'save a version',
  'version.update_draft': 'change a draft',
  'version.discard': 'discard a version',
  'version.promote': 'put a version in use',
  'version.finalize': 'mark a version as ready',
  'lineage.read': 'read what versions were made from',
  'lineage.write': 'link versions',
  'job.read': 'read a task',
  'job.create': 'start a task',
  'job.cancel': 'stop a task',
  'job.transition': 'move a task on',
  'job.recover': 'pick a task up again',
  'session.read': 'read an AI helper conversation',
  'session.open': 'start an AI helper conversation',
  'session.cancel': 'stop an AI helper conversation',
  'session.transition': 'move an AI helper conversation on',
  'session.recover': 'pick an AI helper conversation up again',
  'activity.read': 'read the activity',
  'system.reconcile': 'check the records',
  'handoff.read': 'read a handoff',
  'handoff.send': 'send a handoff',
  'handoff.respond': 'answer a handoff',
  'handoff.withdraw': 'take back a handoff',
  'handoff.accept': 'accept a handoff',
  'handoff.decline': 'decline a handoff',
  'db.migrated': "update Nexus's saved information",
  'workspace.catalog_ensured': 'update the workspace list',
  'project_workspace.primary_synced': 'set the main workspace',
  'blob.gc': 'clean up unused saved files',
  'approval.read': 'read the requests for your OK',
  'approval.respond': 'answer a request for your OK',
  'approval.withdraw': 'take back a request for your OK',
  'approval.request': 'ask for your OK',
  'approval.expire': 'let a request for your OK run out',
  'image_build.start': 'start preparing a safe-space kit',
  'image_build.finish': 'prepare a safe-space kit',
  'deployment.start': 'start a test run of your app',
  'deployment.transition': 'update a test run of your app',
  'deployment.stop': 'stop a test run of your app',
  'exec.recover': 'pick work up again after a restart',
  'exec.orphan_removed': 'remove leftover safe-space items',
  'version.revalidate': 'run the checks again',
  'platform.health': 'check how Nexus is doing',
  // B2b Task 4.
  'agent.start': 'start a request to the AI helper',
  'review.decide': 'decide on suggested changes',
  'changeset.accept': 'keep suggested changes',
  'repo.merge': 'add kept changes to your project',
  'repo.worktree': "prepare the AI helper's safe copy of your project",
  'changeset.rollback': 'undo a keep step that was cut off',
  'mcp.call': 'use a tool',
  'repo.integration_resync': "bring Nexus's saved copy up to your latest saved versions",
  'context_redacted': "leave part of what the AI helper is shown out",
  'agent.consent': "change the AI helper's internet permission",
  'hosted.key': 'change an access key',
  'token.mint': "give the AI helper permission for a request",
  'token.revoke': "end the AI helper's permission for a request",
  'auth.denied': 'act with its permission for a request'
};

const WORKSPACE_SHAPE = /^[a-z][a-z0-9-]{1,31}$/;
const KIND_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/** What a refusal says about an action this build has no words for: never its internal name. */
export const UNKNOWN_ACTION_WORDS = 'an action this version of Nexus does not know';

/** Plain words for an action; an unknown one never shows its internal name. */
export function actionWords(action: string): string {
  return Object.prototype.hasOwnProperty.call(ACTION_WORDS, action) ? ACTION_WORDS[action] : UNKNOWN_ACTION_WORDS;
}

/** The sentence for a row whose action this build has no words for: it claims nothing about what happened. */
export const UNKNOWN_ACTION_SENTENCE = 'Something was recorded that this version of Nexus has no words for';

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
  /** "You", "Nexus", "Nexus, for you", "The AI helper". */
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
  if (row.actorKind === 'agent') return 'The AI helper';
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

/** Task states and AI helper conversation statuses, in words. */
const JOB_STATE_WORDS: Record<string, string> = {
  queued: 'queued', leased: 'picked up', running: 'started running', awaiting_approval: 'is waiting for your OK',
  // B2a final review: a task's state "completed" means it ran and its results were collected; whether its checks
  // passed is a separate fact (a run whose tests failed is still a completed task), so the sentence never says more.
  retry_scheduled: 'will be tried again', completed: 'ran; its checks give the result', partial: 'ran in part', failed: 'failed',
  cancelled: 'was stopped', timed_out: 'took too long and was stopped', interrupted: 'was interrupted', open: 'started'
};

function stateMove(subject: string, to: unknown): string {
  const words = typeof to === 'string' && Object.prototype.hasOwnProperty.call(JOB_STATE_WORDS, to) ? JOB_STATE_WORDS[to] : null;
  return words ? `${subject} ${words}` : `${subject} changed`;
}

/** Why a test run of your app ended, in words (the `reason` of a `deployment.transition` row). */
const DEPLOYMENT_FAILED_WORDS: Record<string, string> = {
  probe_failed: 'Test run of your app failed: it did not answer the app check within 60 seconds',
  exited: 'Test run of your app failed: the app stopped running',
  start_timeout: 'Test run of your app failed: it did not start in time',
  refused: 'Test run of your app failed: it could not be started on this computer',
  preflight_failed: 'Test run of your app failed: its safe space did not pass the safety checks',
  runner_lost: 'Test run of your app failed: the program that ran it stopped',
  exit_not_reported: 'Test run of your app failed: Nexus never heard that it had stopped'
};
const DEPLOYMENT_STOPPED_WORDS: Record<string, string> = {
  idle: 'Test run of your app stopped after its 2 hours were up',
  app_quit: 'Test run of your app stopped when Nexus was closed',
  recovery: 'Test run of your app stopped after a restart',
  cancel: 'Test run of your app stopped with its task',
  user: 'Test run of your app stopped'
};
const IMAGE_BUILD_WORDS: Record<string, string> = {
  succeeded: 'Safe-space kit prepared',
  interrupted: 'Preparing the safe-space kit was interrupted',
  failed: 'Preparing the safe-space kit failed',
  cancelled: 'Preparing the safe-space kit was stopped'
};
/** What restart recovery decided (the `decision` of an `exec.recover` row). Never a completion: recovery completes nothing. */
const RECOVER_WORDS: Record<string, string> = {
  requeue: 'Task queued again after a restart: it had not started yet',
  retry: 'Task will be tried again: a restart cut it off',
  interrupt: 'Task interrupted by a restart',
  reown: 'Task still waits for your OK after a restart',
  expire: 'The request for your OK ran out while the app was closed; the task did not run',
  adopt: 'Running task picked up again after a restart',
  finalize: 'Task stopped while the app was closed; its result is being checked',
  exit_lost: 'Test run of your app failed after a restart: Nexus never heard that it had stopped',
  unreconciled: 'Task failed: Nexus did not pick it up again within 10 minutes of a restart',
  unknown_resources: 'Safe-space items from a task Nexus does not know were found after a restart and left alone',
  image_interrupted: 'Preparing a safe-space kit was interrupted by a restart',
  orphans: 'Leftover safe-space items from before a restart were found and set to be removed',
  accept_rollback: 'A "Keep these changes" step that was cut off when the app stopped is being undone; it is never tried again'
};
/** A task restart recovery failed from what its stopped safe space showed (the `status` of a `fail` decision). */
const RECOVER_FAIL_WORDS: Record<string, string> = {
  oom: 'Task failed: it ran out of memory while the app was closed',
  nonzero_exit: 'Task failed: it stopped with an error while the app was closed',
  invalid_output: 'Task failed: it stopped while the app was closed without the results it needs'
};
/** An `exec.recover` row whose decision this build does not know: neutral, never "recovered". */
export const RECOVER_NEUTRAL = 'After a restart, Nexus recorded what to do with a task';
const pick = (table: Record<string, string>, key: unknown): string | null =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;

/** The sentence for a succeeded (or started) row of a known action; null for an unknown action. */
function sentence(row: ActivityView, ctx: ActivityContext): string | null {
  const name = artifactName(row, ctx);
  switch (row.action) {
    case 'artifact.create': {
      const kind = detail(row, 'kind');
      const label = typeof kind === 'string' && KIND_SHAPE.test(kind) ? kindLabel(kind) : 'Saved item';
      return name ? `${label} ${name} created` : `${label} created`;
    }
    case 'artifact.archive': return name ? `${name} archived` : 'A saved item archived';
    case 'version.register': return `${versionPhrase(row, ctx)} saved`;
    case 'version.update_draft': return `${versionPhrase(row, ctx)} updated as a draft`;
    case 'version.finalize': {
      const to = detail(row, 'to');
      if (to === 'candidate') return `${versionPhrase(row, ctx)} marked as ready`;
      if (to === 'failed') return `${versionPhrase(row, ctx)} did not pass its checks`;
      return `${versionPhrase(row, ctx)} updated`;
    }
    case 'version.promote':
      return detail(row, 'rollback') === true ? `${versionPhrase(row, ctx)} is in use again (went back)` : `${versionPhrase(row, ctx)} is now in use`;
    case 'version.discard': return `${versionPhrase(row, ctx)} discarded`;
    case 'version.revalidate': return `Checks run again on ${versionPhrase(row, ctx).replace(/^[VA]/, (c) => c.toLowerCase())}`;
    case 'lineage.write':
      return detail(row, 'source') === 'handoff_convert'
        ? `${versionPhrase(row, ctx)} linked to the version it was made from`
        : `Added what ${versionPhrase(row, ctx).replace(/^[VA]/, (c) => c.toLowerCase())} was made from`;
    case 'participation.attach': {
      const ws = workspacePhrase(row.workspaceId, ctx);
      const again = detail(row, 'reactivated') === true ? ' again' : '';
      return ws ? `Project added to ${ws}${again}` : `Project added to a workspace${again}`;
    }
    case 'participation.withdraw': {
      const ws = workspacePhrase(row.workspaceId, ctx);
      return ws ? `Project removed from ${ws}` : 'Project removed from a workspace';
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
    case 'handoff.withdraw': return 'Handoff taken back';
    case 'job.create': return 'Task created';
    case 'job.cancel': return 'Task stopped';
    case 'job.recover': return 'Task picked up again after a restart';
    case 'job.transition': return stateMove('Task', detail(row, 'to'));
    case 'session.open': return 'AI helper conversation started';
    case 'session.cancel': return 'AI helper conversation stopped';
    case 'session.recover': return 'AI helper conversation picked up again after a restart';
    case 'session.transition': return stateMove('AI helper conversation', detail(row, 'to'));
    case 'db.migrated': return "Nexus updated its saved information";
    case 'workspace.catalog_ensured': return 'Workspace list updated';
    case 'blob.gc': return row.status === 'started' ? 'Cleaning up unused saved files started' : 'Unused saved files cleaned up';
    case 'approval.withdraw': return 'Request for your OK taken back: the task was stopped';
    case 'approval.request': {
      const reason = detail(row, 'reason');
      if (reason === 'egress.deps') return 'Asked for your OK: download the add-ons your project needs';
      if (reason === 'image.prepare') return 'Asked for your OK: prepare a safe-space kit';
      if (reason === 'repo.write_refs') return 'Asked for your OK: keep hidden Nexus notes in your project';
      return 'Asked for your OK';
    }
    case 'approval.respond': {
      const decision = detail(row, 'decision');
      const reason = detail(row, 'reason');
      if (decision === 'deny') return 'The request for your OK was turned down';
      if (decision === 'once') {
        if (reason === 'egress.deps') return 'Allowed once: download the add-ons your project needs';
        if (reason === 'image.prepare') return 'Allowed once: prepare a safe-space kit';
        if (reason === 'repo.write_refs') return 'Allowed once: Nexus may keep hidden Nexus notes in your project';
        return 'Allowed once';
      }
      return 'The request for your OK was answered';
    }
    case 'approval.expire': return 'The request for your OK ran out: it was not answered within 15 minutes';
    case 'image_build.start': return 'Preparing a safe-space kit started';
    case 'image_build.finish': return pick(IMAGE_BUILD_WORDS, detail(row, 'status')) ?? 'Preparing a safe-space kit ended';
    case 'deployment.start': return 'Test run of your app started. Only this computer can reach it';
    case 'deployment.transition': {
      const to = detail(row, 'to');
      const reason = detail(row, 'reason');
      if (to === 'healthy') return 'Your app answered the app check';
      if (to === 'unhealthy') return 'Your app stopped answering the app check';
      if (to === 'stopped') return pick(DEPLOYMENT_STOPPED_WORDS, reason) ?? 'Test run of your app stopped';
      if (to === 'failed') return pick(DEPLOYMENT_FAILED_WORDS, reason) ?? 'Test run of your app failed';
      return 'Test run of your app changed';
    }
    case 'deployment.stop':
      return detail(row, 'job') === 'completes_on_exit' ? 'Test run of your app stopped; its task ends once the app has stopped' : 'Test run of your app stopped';
    case 'exec.orphan_removed': {
      // Main hands the list to the runner; the row records the request, never a confirmed removal.
      const n = detail(row, 'requested');
      return typeof n === 'number' && Number.isSafeInteger(n) && n > 0
        ? `Asked Nexus to clean up ${n} leftover safe-space item${n === 1 ? '' : 's'} from tasks that ended`
        : 'Asked Nexus to clean up leftover safe-space items from tasks that ended';
    }
    case 'exec.recover': {
      // Each decision in its own words: a failure reads as a failure, an interruption as interrupted. Without a
      // decision this build knows, the sentence claims nothing about the outcome.
      const decision = detail(row, 'decision');
      if (decision === 'fail') return pick(RECOVER_FAIL_WORDS, detail(row, 'status')) ?? 'Task failed: it stopped while the app was closed';
      return pick(RECOVER_WORDS, decision) ?? RECOVER_NEUTRAL;
    }
    case 'agent.consent': {
      const op = detail(row, 'op');
      if (op === 'revoke') return "The AI helper's internet permission was taken back";
      if (op === 'grant') return 'The AI helper was given internet permission, with spending limits';
      return "The AI helper's internet permission was changed";
    }
    case 'hosted.key': return detail(row, 'op') === 'delete' ? 'An access key for an AI service was deleted' : 'An access key for an AI service was saved';
    case 'auth.denied': return 'The AI helper asked for something its permission does not cover, so it was refused';
    case 'token.mint': return 'The AI helper was given permission for one request';
    case 'token.revoke': return "The AI helper's permission for that request ended";
    case 'repo.worktree':
      return detail(row, 'reused') === true ? "The AI helper's task reused its safe copy of your project"
        : "A safe copy of your project was prepared for the AI helper's task";
    case 'review.decide': {
      const d = detail(row, 'decision');
      if (d === 'approve') return 'The suggested changes were marked "Looks good"';
      if (d === 'request_changes') return 'Different changes were asked for';
      if (d === 'reject') return 'The suggested changes were turned down';
      return 'A decision was recorded';
    }
    case 'mcp.call': return "The AI helper used one of Nexus's tools";
    case 'repo.integration_resync': return "Nexus's saved copy was brought up to your latest saved versions, so new work starts from them";
    case 'context_redacted': return 'Part of what the AI helper was shown was left out because it looked like a secret';
    case 'changeset.accept': return "The suggested changes were kept. They wait in Nexus's saved copy until you add them to your project";
    case 'changeset.rollback': return "A \"Keep these changes\" step was cut off and has been undone; Nexus's saved copy is back as it was";
    case 'repo.merge': return 'The kept changes were added to your project';
    case 'project_workspace.primary_synced': {
      const ws = workspacePhrase(detail(row, 'workspaceId'), ctx);
      return ws ? `Main workspace set to ${ws}, from what Nexus found in the project` : 'Main workspace set from what Nexus found in the project';
    }
    default: return null;
  }
}

/** What a row says happened. A refusal or failure names the action in words; an unknown action says it has no words for it. */
export function activityText(row: ActivityView, ctx: ActivityContext): string {
  if (row.action === 'auth.denied') return sentence(row, ctx) ?? 'A request was refused';
  if (row.status === 'denied') return `Refused: ${actionWords(row.action)}`;
  if (row.status === 'failed') return `Failed: ${actionWords(row.action)}`;
  if (row.status === 'cancelled') return `Cancelled: ${actionWords(row.action)}`;
  return sentence(row, ctx) ?? UNKNOWN_ACTION_SENTENCE;
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
  if (!s.loaded) return { kind: 'loading', text: 'Reading what happened…', retry: false };
  if (s.rows.length === 0 && !s.error) return { kind: 'empty', text: 'Nothing has happened in this project yet. What you and Nexus do will be listed here.', retry: false };
  return null;
}
