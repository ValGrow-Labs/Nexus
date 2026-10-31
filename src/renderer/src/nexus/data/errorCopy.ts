// Pure: the plain sentence a person sees for a nexus:* failure, and whether
// trying again can help. No raw code or reason ever reaches the screen.
import type { NexusErrorCode } from '@shared/nexus/ipc';

export interface ErrorCopy {
  text: string;
  /** True when the same request may succeed if sent again (a held lock, an unexpected failure). */
  retry: boolean;
  /**
   * - unavailable: the platform is off; screens fall back to the domain grouping and hide writes.
   * - handoffs_unavailable: only handoffs are off.
   * - busy / internal: a passing failure; show "try again", never the degraded mode.
   * - refused: the request itself was refused.
   */
  kind: 'unavailable' | 'handoffs_unavailable' | 'execution_unavailable' | 'busy' | 'internal' | 'refused';
}

/** Every error code a nexus:* channel can answer with. */
export const NEXUS_ERROR_CODES: readonly NexusErrorCode[] = Object.freeze([
  'denied', 'not_found', 'invalid', 'conflict', 'immutable', 'cycle', 'not_owner', 'not_participating',
  'participation_inactive', 'input_not_granted', 'storage_unavailable', 'illegal_transition', 'platform_unavailable', 'unavailable', 'too_large',
  'internal'
] as NexusErrorCode[]);

const CODE_TEXT: Record<NexusErrorCode, string> = {
  denied: 'You do not have permission to do that here.',
  not_found: 'That item no longer exists. It may have been removed.',
  invalid: 'Nexus could not accept that. Check what you entered and try again.',
  conflict: 'Something else changed first, so nothing was saved. Reload and try again.',
  immutable: 'That item is final and cannot be changed.',
  cycle: 'That link would make an item depend on itself, so it was not added.',
  not_owner: 'Only the workspace that owns this saved item can change it.',
  not_participating: 'This project does not take part in that workspace.',
  participation_inactive: 'This project no longer takes part in that workspace, so it cannot take new work there.',
  input_not_granted: 'That saved item cannot be used here.',
  storage_unavailable: 'Nexus could not open the saved content.',
  illegal_transition: 'That cannot be done at this stage.',
  platform_unavailable: 'Nexus cannot reach its saved information right now. Try restarting the app.',
  unavailable: 'This cannot run on this computer yet. Open “Get this computer ready” to see what is missing.',
  too_large: 'That is too much to show at once. Try asking for less.',
  internal: 'The request could not be completed. Try again.'
};

/** Why the whole platform is off (the reason of a platform_unavailable answer). */
const UNAVAILABLE_WHY: Record<string, string> = {
  held: 'an update to it is on hold',
  migration_failed: 'an update to it did not finish',
  newer_schema: 'a newer version of the app has already updated it',
  shape_mismatch: 'it is not set up the way this version expects',
  startup_failed: 'Nexus could not read it',
  not_open: 'it is not open'
};
export const UNAVAILABLE_REASONS: readonly string[] = Object.freeze(Object.keys(UNAVAILABLE_WHY));

/** Why handoffs alone are off (the sub-reason of handoffs_unavailable). */
const HANDOFFS_WHY: Record<string, string> = {
  held: 'the update that adds them is on hold',
  auto_held: 'the update that adds them was put on hold after an earlier problem',
  backup_failed: 'the backup before the update that adds them failed',
  failed: 'the update that adds them did not finish',
  shape: "Nexus's saved information for them is not set up the way this version expects"
};
export const HANDOFFS_SUB_REASONS: readonly string[] = Object.freeze(Object.keys(HANDOFFS_WHY));

/** Service reasons a refusal may carry, with a sentence a person can act on. */
/** The sentence per service reason. Every key main also words (REASON_MESSAGES in nexusIpc/envelope.ts) reads the same. */
export const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  bad_request: 'Nexus could not accept that. Check what you entered and try again.',
  not_a_repository: "This project's folder is not tracked with git yet. Nexus needs git, a free tool that remembers changes, to read it.",
  not_a_commit: "That saved version was not found in this project's history.",
  project_folder_unavailable: "Nexus cannot open this project's folder, so nothing was read. Check that the folder is still there.",
  kind_mismatch: 'That saved item holds a different kind of content.',
  secret_in_metadata: 'The name or details look like they contain a password or secret key, so nothing was saved.',
  file_not_found: "That file was not found in this project's folder.",
  path_refused: 'That file cannot be saved. It is outside the project folder, or it is a linked file that is also stored under '
    + 'other names (some backup and package tools make these).',
  too_large: 'That file is too large to save.',
  not_text: 'Only plain text files can be saved here, and that file is not one.',
  secret_in_content: 'That file looks like it contains a password or secret key, so it was not saved.',
  sensitive_name: 'Nexus never saves files that usually hold secrets, such as keys, passwords and environment settings files, '
    + "or anything inside a project's hidden git folder.",
  produced_by_job: 'This item is made by a task or the AI helper, and Nexus finishes it itself. You cannot mark it ready by hand.'
});
export const SERVICE_REASONS: readonly string[] = Object.freeze(Object.keys(REASON_TEXT));

export const BUSY_TEXT = 'Nexus is busy right now. Try again in a moment.';

/** The notice shown while screens fall back to grouping projects by their kind of work. */
export function unavailableNotice(reason: string | null | undefined): string {
  const why = reason ? UNAVAILABLE_WHY[reason] : undefined;
  const next = reason === 'newer_schema' ? 'Update this app to its newest version.' : 'Try restarting the app.';
  return why
    ? `Some of Nexus's saved information is not ready because ${why}. Projects are grouped by their kind of work for now. ${next}`
    : "Some of Nexus's saved information is not ready. Projects are grouped by their kind of work for now. Try restarting the app.";
}

/** The note shown where handoffs would be. */
export function handoffsNotice(subReason: string | null | undefined): string {
  const why = subReason ? HANDOFFS_WHY[subReason] : undefined;
  return why ? `Handoffs are not available because ${why}.` : 'Handoffs are not available on this computer right now.';
}

// ---------- B2a: execution (jobs, checks, dev deployments) ----------

/**
 * Why execution alone is off (the sub-reason of execution_unavailable). `unreachable` is the renderer's own: an
 * execution channel that is not registered in main (a rejected call) answers it, so the screen says so plainly.
 */
const EXECUTION_WHY: Record<string, string> = {
  held: 'the update that adds it is on hold',
  auto_held: 'the update that adds it was put on hold after an earlier problem',
  backup_failed: 'the backup before the update that adds it failed',
  failed: 'the update that adds it did not finish',
  shape: "Nexus's saved information for it is not set up the way this version expects",
  not_enabled: 'it is not turned on in this version of the app',
  v8_unavailable: 'an earlier update that it depends on is not in place',
  registry_invalid: "Nexus's own start-up check of the kinds of work failed",
  not_started: 'the part of Nexus that runs tasks has not started',
  unreachable: 'it did not answer, so it is not connected in this version of the app'
};
export const EXECUTION_SUB_REASONS: readonly string[] = Object.freeze(Object.keys(EXECUTION_WHY));

/** The one line shown where tasks, checks and test runs would be. */
export function executionNotice(subReason: string | null | undefined): string {
  const why = subReason ? EXECUTION_WHY[subReason] : undefined;
  return why
    ? `Running tasks is not available because ${why}. Saved items, handoffs and activity still work.`
    : 'Running tasks is not available right now. Saved items, handoffs and activity still work.';
}

/**
 * B2b: the sentence for each reason an agent, review, accept or merge flow refuses with (main's AGENT_REASON_MESSAGES in
 * nexusIpc/envelope.ts, word for word: a test compares them). Kept apart from REASON_TEXT, which mirrors REASON_MESSAGES.
 * No reason code, git message, path or sha is ever shown, and no git word (branch, fast-forward, working tree, refs): the
 * plain-words glossary (data/glossary.ts) names things. `tree_dirty` says "New files do not block this" because new,
 * untracked files never block a merge. The last three are the renderer's own (main words them in its message, which is not shown).
 */
export const AGENT_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  agents_unavailable: 'The AI helper is not available on this computer right now.',
  runtime_unknown: 'The AI helper has not been checked on this computer yet. Open “Get this computer ready” and check again.',
  runtime_not_installed: 'The program for your own plan is not installed on this computer. Install it, then check again.',
  runtime_not_authenticated: 'The program for your own plan is not signed in. Sign in with it, then check again in “Get this computer ready”.',
  runtime_version_unsupported: 'The installed program for your own plan is a version Nexus does not support. Install a supported version, then check again.',
  runtime_error: 'Nexus could not check the AI helper. Open “Get this computer ready” and check again.',
  runtime_mismatch: 'The program for your own plan has changed since you allowed it. Take the internet permission back and allow it again in “Get this computer ready”.',
  local_model_not_chosen: 'No AI model is chosen yet. Pick one from the list under AI on this computer.',
  local_model_endpoint: 'The address for AI on this computer does not point to this computer, or it is not the one you allowed. Check it in “Get this computer ready”.',
  local_model_missing: 'The AI model you chose is not installed on this computer. Choose another one in “Get this computer ready”.',
  local_model_no_tools: 'The AI model you chose cannot take actions such as reading and changing files, which the AI helper needs. Choose another model in “Get this computer ready”.',
  local_model_server_down: 'The program that runs AI on this computer is not running. Start it, then check again in “Get this computer ready”.',
  hosted_provider_not_chosen: 'No online AI service is chosen yet. Choose a service and a model under Free online AI.',
  hosted_key_missing: 'Add your access key in Settings first.',
  hosted_key_rejected: 'The AI service did not accept your access key. Check it in Settings and enter it again.',
  hosted_rate_limited: 'The AI service is asking for fewer requests right now. Wait a minute, then send your message again.',
  hosted_quota_exhausted: 'The free allowance with this AI service is used up for now. Try again later or choose another AI service.',
  hosted_model_unavailable: 'The model you chose is not available from this AI service. Choose another model in “Get this computer ready”.',
  bad_provider: 'That AI service does not offer that choice.',
  turn_live: 'The AI helper is working on a request. Stop it or wait for it to finish before you switch the AI service.',
  bad_model: 'That AI service does not take a model choice.',
  consent_missing: 'The AI helper needs your internet permission before it can work. Open “Get this computer ready” to allow it.',
  consent_mismatch: 'Your internet permission no longer matches what the AI helper needs. Take it back and allow it again in “Get this computer ready”.',
  consent_live: 'An internet permission is already allowed. Take it back first if you want to change it.',
  budget_exhausted: 'The AI helper has used up its limit for today. Try again later.',
  rate_limited: 'The AI helper has started too many requests this hour. Try again later.',
  turn_running: 'The AI helper is still working on your last message. Wait for it to finish.',
  session_ended: 'That conversation has ended. Start a new one.',
  no_turn: 'The AI helper is not working on anything in that conversation.',
  secret_in_message: 'The message looks like it contains a password or secret key, so nothing was started. Remove it and try again.',
  message_too_long: 'The message is too long. Shorten it and try again.',
  try_busy: 'Something is already running in the safe space for this project. Wait for it to finish, or stop it.',
  try_command: 'Nexus could not read that command. Check the quotes and try again.',
  try_secret: 'The command looks like it contains a password or secret key, so nothing was run. Remove it and try again.',
  try_nothing: 'This change has nothing to run that way. Try your own command instead.',
  try_no_commit: 'This project has no saved version to try yet. Set it up first, then try again.',
  unknown_skill: 'That skill is not available.',
  secret_in_comment: 'The comment looks like it contains a password or secret key, so nothing was saved. Remove it and try again.',
  comment_required: 'Say what should change. This choice needs a comment.',
  comment_too_long: 'The comment is too long. Shorten it and try again.',
  not_a_change_set: 'Only suggested changes from the AI helper can be looked over and kept.',
  not_candidate: 'These suggested changes are no longer waiting for your decision.',
  not_approved: 'You have not marked these suggested changes “Looks good” yet.',
  change_set_not_promotable: 'Suggested changes cannot be set as the current version directly. Look them over and keep them instead.',
  ref_moved: 'Something changed in Nexus while you were deciding, so nothing was kept. Open the suggested changes and look again.',
  merge_conflict: 'These changes do not fit together with the changes you kept earlier, so they were not kept.',
  accept_rolled_back: 'Keeping the changes did not finish, so Nexus put its saved copy back the way it was. The suggested changes are still waiting for you. Try again.',
  integration_unexpected: "Nexus's saved copy is not what Nexus recorded. It may have been changed outside Nexus, or an earlier step did not finish. Nothing was done, to keep your work safe.",
  tree_dirty: "Some of your project's files have changes that are not saved in its history yet, so nothing was added. Save or undo those changes, then try again. New files do not block this.",
  branch_mismatch: 'Your project is switched to a different version than the one these changes were made for, so nothing was added.',
  not_fast_forward: 'Your project has changed since the AI helper started, so these changes cannot be added cleanly. Nothing was added.',
  nothing_to_merge: 'Your project already has all the changes you kept.',
  base_moved: 'Your project changed after the AI helper started. Ask the AI helper to do the work again on your latest project.',
  integration_diverged: "Your project and Nexus's saved copy have both changed in different ways, so the AI helper cannot start from your latest project. Nothing was changed. The safe next step is to ask a developer to bring the two together, then ask again.",
  preview_incomplete: 'Part of these changes is hidden or too large to show here, so you cannot mark them “Looks good” in Nexus. Ask the AI helper to make them again in a simpler way.',
  not_cancellable: 'Nexus is saving this step, so it cannot be stopped now. It will finish on its own.',
  cancelled: 'You cancelled, so nothing was added to your project.',
  accept_pending: 'Nexus is still keeping these changes. Try again in a moment.',
  merge_pending: 'Nexus is still adding these changes to your project. Try again in a moment.',
  no_such_part: 'There is nothing of that kind to show for this item.',
  no_commit: 'Nexus did not save what it needs to show these changes.',
  runner_unavailable: 'The part of Nexus that reads your project is not available right now. Try again in a moment.',
  branch_unknown: 'Nexus has not saved a starting point for this project yet. Save one first.',
  git_missing: 'Git, a free program Nexus needs, is not installed on this computer. Install it, then try again.',
  // The renderer's own.
  no_session: 'These changes did not come from a conversation with the AI helper, so there is no helper to ask for new changes.',
  intent_mismatch: 'That button belongs to a different choice, so nothing was done. Try again.',
  intent_required: 'Nexus could not accept that. Try again.'
});
export const AGENT_REASONS: readonly string[] = Object.freeze(Object.keys(AGENT_REASON_TEXT));
/** An accept whose undo could not be queued: said once, after the refusal's own sentence. */
export const ROLLBACK_OWED_TEXT = 'Nexus still has to undo a step that did not finish. Until that is done, it will not keep or add any changes.';

/** Agent work is not turned on: no check or setup can change it (so no "check again" advice). */
export const AGENT_OFF_TEXT = 'The AI helper is not available because it is not turned on in this version of the app.';

/** Why agent work is off, from the setup view's `offReason`. An older answer without it reads as the build (what it always said). */
export const AGENT_OFF_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  build: AGENT_OFF_TEXT,
  database: "The AI helper needs an update to Nexus's saved information, and that update has not been applied on this computer yet.",
  held: 'The AI helper is paused on this computer because an update it needs is on hold.',
  execution: 'The AI helper needs to run tasks, and that is not available right now.'
});
/** The one sentence for agent work being off. `executionText`: the execution-unavailable sentence, used for the `execution` reason. */
export function agentOffText(reason: string | null | undefined, executionText?: string): string {
  if (reason === 'execution' && executionText) return executionText;
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(AGENT_OFF_REASON_TEXT, reason) ? AGENT_OFF_REASON_TEXT[reason] : AGENT_OFF_TEXT;
}
/** An agent flow action unavailable because agent work is off (its view has no reason, so the sentence does not name one). */
export const AGENT_ACTION_OFF_TEXT = 'The AI helper is not available on this computer right now. Open “Get this computer ready” to see why.';

/** Agent work off: the same sub-reasons as execution say why. */
export function agentsNotice(subReason: string | null | undefined): string {
  if (subReason === 'not_enabled') return AGENT_OFF_TEXT;
  const why = subReason ? EXECUTION_WHY[subReason] : undefined;
  return why ? `The AI helper is not available because ${why}.` : AGENT_REASON_TEXT.agents_unavailable;
}

/** The setup sentences (main's SETUP_MESSAGES in nexusIpc/envelope.ts, word for word). */
export const SETUP_TEXT: Readonly<Record<string, string>> = Object.freeze({
  docker_missing: 'Docker, a free program, is not installed, so this cannot run on this computer yet. Install Docker Desktop, then try again.',
  docker_stopped: 'Docker is not running. Start Docker Desktop and try again.',
  docker_memory_low: 'Docker does not have enough memory for this. Open Docker Desktop, give it more memory in its settings, then try again.',
  image_missing: 'The safe-space kit this needs has not been downloaded yet. Open “Get this computer ready” to download it.',
  image_mismatch: 'The safe-space kit on this computer is not the version Nexus expects. Download it again in “Get this computer ready”.',
  disk_low: 'There is not enough free space on your disk for this. Free some space, then try again.',
  runner_unavailable: 'The part of Nexus that runs tasks is not available right now. Try again in a moment.',
  git_missing: 'Git, a free program, is not installed, so this cannot run on this computer yet. Install it, then try again.'
});

/** Sentences for the B2a refusal reasons a person can act on (kept apart from REASON_TEXT, which mirrors main). */
export const EXEC_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  queue_full: 'Too many tasks are waiting already. Try again when some have finished.',
  input_not_allowed: 'That saved item cannot be used here. It may still be a draft, be a different kind of item, or belong to another project.',
  secret_in_params: 'A value looks like a password or secret key, so nothing was started.',
  kind_not_authorable: 'That kind of saved item cannot be written by hand.',
  bad_content: 'Some fields are missing or too long. Check them and save again.',
  kind_not_in_domain: 'This workspace does not write that kind of saved item.',
  unknown_action: 'Nexus does not have that action in this version.',
  action_not_in_domain: 'That action does not belong to this workspace.',
  deployment_live: 'A test run of this app is already starting or running. Stop it before you start another.'
});

/** The sentence for a setup:* reason (or the generic unavailable sentence). */
export function setupText(reason: string | null | undefined): string {
  const id = typeof reason === 'string' && reason.startsWith('setup:') ? reason.slice(6) : reason ?? '';
  return Object.prototype.hasOwnProperty.call(SETUP_TEXT, id) ? SETUP_TEXT[id] : CODE_TEXT.unavailable;
}

export function errorCopy(code: string, reason?: string | null, subReason?: string | null): ErrorCopy {
  if (code === 'platform_unavailable') {
    if (reason === 'busy') return { text: BUSY_TEXT, retry: true, kind: 'busy' };
    if (reason === 'handoffs_unavailable') return { text: handoffsNotice(subReason), retry: false, kind: 'handoffs_unavailable' };
    if (reason === 'execution_unavailable') return { text: executionNotice(subReason), retry: false, kind: 'execution_unavailable' };
    if (reason === 'agents_unavailable') return { text: agentsNotice(subReason), retry: false, kind: 'execution_unavailable' };
  }
  if (code === 'platform_unavailable') {
    return { text: unavailableNotice(reason), retry: false, kind: 'unavailable' };
  }
  if (code === 'internal') return { text: CODE_TEXT.internal, retry: true, kind: 'internal' };
  const byReason = reason && Object.prototype.hasOwnProperty.call(AGENT_REASON_TEXT, reason) ? AGENT_REASON_TEXT[reason]
    : reason ? REASON_TEXT[reason] ?? EXEC_REASON_TEXT[reason] : undefined;
  const byCode = Object.prototype.hasOwnProperty.call(CODE_TEXT, code) ? CODE_TEXT[code as NexusErrorCode] : undefined;
  return { text: byReason ?? byCode ?? 'Nexus could not do that.', retry: false, kind: 'refused' };
}

/** The sentence for a failed execution request: a setup:* refusal names its setup step; anything else is errorCopy's. */
export function execFailText(r: { code: string; reason?: string | null; subReason?: string | null }): string {
  if (r.code === 'unavailable' && typeof r.reason === 'string' && r.reason.startsWith('setup:')) return setupText(r.reason);
  return errorCopy(r.code, r.reason, r.subReason).text;
}
