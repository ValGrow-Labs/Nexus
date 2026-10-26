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
  invalid: 'That request could not be accepted. Check the values and send it again.',
  conflict: 'Something changed in the meantime, so nothing was saved. Reload and try again.',
  immutable: 'That record is final and cannot be changed.',
  cycle: 'That link would make a version depend on itself, so it was not added.',
  not_owner: 'Only the workspace that owns this artifact can change it.',
  not_participating: 'This project does not take part in that workspace.',
  participation_inactive: 'This project no longer takes part in that workspace, so it cannot take new work there.',
  input_not_granted: 'That version is not available as an input here.',
  storage_unavailable: 'The stored content could not be read.',
  illegal_transition: 'That step is not possible from the current status.',
  platform_unavailable: 'Workspace data is not available right now.',
  unavailable: 'That cannot run on this computer right now. Check the setup notes for what it needs.',
  too_large: 'That is more than can be shown at once. Ask for a smaller page.',
  internal: 'The request could not be completed. Try again.'
};

/** Why the whole platform is off (the reason of a platform_unavailable answer). */
const UNAVAILABLE_WHY: Record<string, string> = {
  held: 'the database upgrade is held',
  migration_failed: 'the database upgrade did not complete',
  newer_schema: 'the database was upgraded by a newer version of the app',
  shape_mismatch: 'the database does not have the expected layout',
  startup_failed: 'the workspace database could not be read',
  not_open: 'the database is not open'
};
export const UNAVAILABLE_REASONS: readonly string[] = Object.freeze(Object.keys(UNAVAILABLE_WHY));

/** Why handoffs alone are off (the sub-reason of handoffs_unavailable). */
const HANDOFFS_WHY: Record<string, string> = {
  held: 'the database upgrade that adds them is held',
  auto_held: 'the database upgrade that adds them was held after an earlier problem',
  backup_failed: 'the backup before the database upgrade that adds them failed',
  failed: 'the database upgrade that adds them did not complete',
  shape: 'the handoff tables do not have the expected layout'
};
export const HANDOFFS_SUB_REASONS: readonly string[] = Object.freeze(Object.keys(HANDOFFS_WHY));

/** Service reasons a refusal may carry, with a sentence a person can act on. */
/** The sentence per service reason. Every key main also words (REASON_MESSAGES in nexusIpc/envelope.ts) reads the same. */
export const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  bad_request: 'That request could not be accepted. Check the values and send it again.',
  not_a_repository: 'The project folder is not a git repository.',
  not_a_commit: 'That commit was not found in the project repository.',
  project_folder_unavailable: 'The project folder is not available, so nothing was read.',
  kind_mismatch: 'That artifact holds a different kind of content.',
  secret_in_metadata: 'The name or details look like they hold a secret, so nothing was saved.',
  file_not_found: 'That file was not found in the project folder.',
  path_refused: 'That file cannot be saved. Paths outside the project folder are refused, and so are files with several '
    + 'hard links (as pnpm stores and some backup tools create them).',
  too_large: 'That file is too large to save as an artifact.',
  not_text: 'That file is not plain text, so it cannot be saved as a text artifact.',
  secret_in_content: 'That file looks like it holds a secret, so it was not saved.',
  sensitive_name: 'Files of that kind (keys, credentials, environment files, anything under .git) are never saved.',
  produced_by_job: 'A draft made by a job or an agent session is finished by the engine, not marked ready by hand.'
});
export const SERVICE_REASONS: readonly string[] = Object.freeze(Object.keys(REASON_TEXT));

export const BUSY_TEXT = 'The database is busy. Try again in a moment.';

/** The notice shown while screens fall back to the domain grouping. */
export function unavailableNotice(reason: string | null | undefined): string {
  const why = reason ? UNAVAILABLE_WHY[reason] : undefined;
  return why
    ? `Workspace data is not available because ${why}. Projects are grouped by their detected domain until it runs.`
    : 'Workspace data is not available. Projects are grouped by their detected domain until it is available.';
}

/** The note shown where handoffs would be. */
export function handoffsNotice(subReason: string | null | undefined): string {
  const why = subReason ? HANDOFFS_WHY[subReason] : undefined;
  return why ? `Handoffs are not available because ${why}.` : 'Handoffs are not available on this database.';
}

// ---------- B2a: execution (jobs, checks, dev deployments) ----------

/**
 * Why execution alone is off (the sub-reason of execution_unavailable). `unreachable` is the renderer's own: an
 * execution channel that is not registered in main (a rejected call) answers it, so the screen says so plainly.
 */
const EXECUTION_WHY: Record<string, string> = {
  held: 'the database upgrade that adds it is held',
  auto_held: 'the database upgrade that adds it was held after an earlier problem',
  backup_failed: 'the backup before the database upgrade that adds it failed',
  failed: 'the database upgrade that adds it did not complete',
  shape: 'its tables do not have the expected layout',
  not_enabled: 'it is not turned on in this build of the app',
  v8_unavailable: 'the database upgrade it builds on is not in place',
  registry_invalid: 'the domain registry failed its startup check',
  not_started: 'the execution runner has not started',
  unreachable: 'it did not answer, so it is not connected in this build of the app'
};
export const EXECUTION_SUB_REASONS: readonly string[] = Object.freeze(Object.keys(EXECUTION_WHY));

/** The one line shown where jobs, checks and dev deployments would be. */
export function executionNotice(subReason: string | null | undefined): string {
  const why = subReason ? EXECUTION_WHY[subReason] : undefined;
  return why
    ? `Running jobs is not available because ${why}. Artifacts, handoffs and activity still work.`
    : 'Running jobs is not available right now. Artifacts, handoffs and activity still work.';
}

/**
 * B2b: the sentence for each reason an agent, review, accept or merge flow refuses with (main's AGENT_REASON_MESSAGES in
 * nexusIpc/envelope.ts, word for word: a test compares them). Kept apart from REASON_TEXT, which mirrors REASON_MESSAGES.
 * No reason code, git message, path or sha is ever shown; `tree_dirty` says "tracked files" because untracked files never
 * block a merge. The last three are the renderer's own (main words them in its message, which is not shown).
 */
export const AGENT_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  agents_unavailable: 'Agent work is not available on this database.',
  runtime_unknown: 'The agent has not been checked on this computer yet. Open Setup and check again.',
  runtime_not_installed: 'The agent program is not installed on this computer.',
  runtime_not_authenticated: 'The agent program is not signed in. Sign in with it, then check again in Setup.',
  runtime_version_unsupported: 'The installed agent program is not a version Nexus supports.',
  runtime_error: 'The agent could not be checked. Open Setup and check again.',
  runtime_mismatch: 'The agent program installed is not the one that was given permission.',
  consent_missing: 'Agent turns need your network permission. Open Setup to grant it.',
  consent_mismatch: 'The permission on record does not match what the agent needs. Revoke it and grant it again in Setup.',
  consent_live: 'A permission is already granted. Revoke it first to change it.',
  budget_exhausted: 'The agent has used its budget for today.',
  rate_limited: 'The agent has started too many turns this hour. Try again later.',
  turn_running: 'The agent is still working on the last message.',
  session_ended: 'That conversation has ended. Start a new one.',
  no_turn: 'No agent turn is running in that conversation.',
  secret_in_message: 'The message looks like it holds a secret, so nothing was started.',
  message_too_long: 'The message is too long.',
  unknown_skill: 'That skill is not available.',
  secret_in_comment: 'The comment looks like it holds a secret, so nothing was recorded.',
  comment_required: 'Say what should change: this decision needs a comment.',
  comment_too_long: 'The comment is too long.',
  not_a_change_set: 'Only a change made by the agent can be reviewed or accepted.',
  not_candidate: 'This change is no longer waiting for a decision.',
  not_approved: 'This change has no approving review yet.',
  change_set_not_promotable: 'A change set is accepted through review, not made current directly.',
  ref_moved: 'The accepted branch moved while you were deciding, so nothing was accepted. Look at the change again.',
  merge_conflict: 'The change does not merge cleanly onto the accepted work, so it was not accepted.',
  accept_rolled_back: 'The accept could not be recorded, so the accepted branch was put back as it was. The change is still waiting for you.',
  integration_unexpected: 'The accepted work is not what Nexus recorded (it was changed outside Nexus, or an earlier accept did not finish), so nothing was done.',
  tree_dirty: 'Your working tree has uncommitted changes to tracked files, so nothing was merged. New, untracked files do not block a merge.',
  branch_mismatch: 'Another branch is checked out than the one the accepted work is for, so nothing was merged.',
  not_fast_forward: 'Your branch has moved on, so the accepted work is no longer a fast-forward. Nothing was merged.',
  nothing_to_merge: 'Your branch already has all the accepted work.',
  integration_diverged: 'Your branch and the accepted work have both moved on, so Nexus cannot start from your latest code. Merge the accepted work in your own tools, then ask again.',
  preview_incomplete: "Part of this change is hidden or too large to show here, so it can't be approved from Nexus. Review it in your own tools, or ask the agent to rewrite it.",
  not_cancellable: 'Nexus is recording this step, so it cannot be stopped from here. It finishes on its own.',
  cancelled: 'The merge was cancelled; nothing was changed.',
  accept_pending: 'The accept is still running. Ask again in a moment.',
  merge_pending: 'The merge is still running. Ask again in a moment.',
  no_such_part: 'There is nothing of that kind to show for this item.',
  no_commit: 'This change does not record the commits needed to show it.',
  runner_unavailable: 'The part of Nexus that reads your repository is not available right now.',
  branch_unknown: "Nexus has not recorded the repository's branch yet. Take a repository snapshot first.",
  git_missing: 'Git is not installed on this computer.',
  // The renderer's own.
  no_session: 'That change was not made in an agent conversation, so there is no agent to ask for changes.',
  intent_mismatch: 'That click belongs to another decision. Try again.',
  intent_required: 'The request could not be accepted. Try again.'
});
export const AGENT_REASONS: readonly string[] = Object.freeze(Object.keys(AGENT_REASON_TEXT));
/** An accept whose undo could not be queued: said once, after the refusal's own sentence. */
export const ROLLBACK_OWED_TEXT = 'Nexus still owes an undo of the accepted branch and will not accept or merge anything until it is done.';

/** Agent work is not turned on: no check or setup can change it (so no "check again" advice). */
export const AGENT_OFF_TEXT = 'Agent work is not available because it is not turned on in this build.';

/** Agent work off: the same sub-reasons as execution say why. */
export function agentsNotice(subReason: string | null | undefined): string {
  if (subReason === 'not_enabled') return AGENT_OFF_TEXT;
  const why = subReason ? EXECUTION_WHY[subReason] : undefined;
  return why ? `Agent work is not available because ${why}.` : AGENT_REASON_TEXT.agents_unavailable;
}

/** The setup sentences (main's SETUP_MESSAGES in nexusIpc/envelope.ts, word for word). */
export const SETUP_TEXT: Readonly<Record<string, string>> = Object.freeze({
  docker_missing: 'Docker is not installed, so this cannot run on this computer yet.',
  docker_stopped: 'Docker is not running. Start Docker Desktop and try again.',
  docker_memory_low: 'Docker has too little memory for this. Give Docker more memory in its settings.',
  image_missing: 'A sandbox image this needs is not prepared yet.',
  image_mismatch: 'A sandbox image this needs does not match the pinned version. Prepare it again.',
  disk_low: 'There is not enough free disk space for this.',
  runner_unavailable: 'The execution runner is not available right now.',
  git_missing: 'Git is not installed, so this cannot run on this computer yet.'
});

/** Sentences for the B2a refusal reasons a person can act on (kept apart from REASON_TEXT, which mirrors main). */
export const EXEC_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  queue_full: 'Too many runs are waiting already. Try again when some have finished.',
  input_not_allowed: 'That version cannot be an input here: it is still a draft, of another kind or of another project.',
  secret_in_params: 'A value looks like it holds a secret, so nothing was started.',
  kind_not_authorable: 'That kind of artifact cannot be written by hand.',
  bad_content: 'Some fields are missing or too long. Check them and save again.',
  kind_not_in_domain: 'This workspace does not write that kind of artifact.',
  unknown_action: 'That action does not exist in this release.',
  action_not_in_domain: 'That action does not belong to this workspace.',
  deployment_live: 'A dev deployment of this application version is already starting or running. Stop it before you start another.'
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
  return { text: byReason ?? byCode ?? 'The request was refused.', retry: false, kind: 'refused' };
}

/** The sentence for a failed execution request: a setup:* refusal names its setup step; anything else is errorCopy's. */
export function execFailText(r: { code: string; reason?: string | null; subReason?: string | null }): string {
  if (r.code === 'unavailable' && typeof r.reason === 'string' && r.reason.startsWith('setup:')) return setupText(r.reason);
  return errorCopy(r.code, r.reason, r.subReason).text;
}
