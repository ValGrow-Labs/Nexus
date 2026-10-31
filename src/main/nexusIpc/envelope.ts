/**
 * The nexus:* result envelope. Every handler answers `ok(data)` or `fail(e)`; nothing
 * a handler throws reaches the renderer as a rejection.
 *
 * - RequestError (validate.ts) -> 'invalid', reason 'bad_request', with the field.
 * - PlatformError -> its code. The message is scrubbed (absolute paths cut to their
 *   basename, secrets redacted, one line, at most 300 characters); a known service
 *   reason (detail.reason) is lifted to `reason` and, for user-facing refusals such as
 *   'path_refused', the message is replaced by a plain sentence. `detail` keeps only
 *   allow-listed keys with scalar values.
 * - PlatformError 'platform_unavailable' -> a fixed message and a reason, never the
 *   service text: 'busy' for a held lock (detail.sqliteCode SQLITE_BUSY* or
 *   SQLITE_LOCKED*), 'handoffs_unavailable' (with its sub-reason) when v8 is off,
 *   'execution_unavailable' (B2a, with its sub-reason) when a service says execution is
 *   off, otherwise 'startup_failed'.
 * - PlatformError 'unavailable' (B2a): an action this machine cannot run now. Its
 *   `setup:<id>` reason is kept (the renderer explains it) and `detail.setup` names the id;
 *   the message is a fixed sentence per setup id.
 * - Anything else -> 'internal' with a fixed message, plus ONE log line naming the
 *   channel, the error's name and its code. No stack, no path, no SQLite text.
 */
import type { NexusErrorCode, NexusErrorDetailKey, NexusFail, NexusOk } from '../../shared/nexus/ipc';
import { redactSecretText } from '../nexus/activity/redact';
import { PlatformError } from '../nexus/errors';
import { RequestError } from './validate';

export const MAX_MESSAGE_CHARS = 300;
export const INTERNAL_MESSAGE = 'The request could not be completed.';
const MAX_SCRUB_INPUT = 4000;
const MAX_DETAIL_STRING = 128;

export const DETAIL_KEYS: readonly NexusErrorDetailKey[] = Object.freeze([
  'currentVersionId', 'handoffId', 'versionId', 'participationId', 'liveJobs', 'liveSessions', 'openHandoffs', 'existingId', 'limit',
  // B2a Task 13: the records a refusal names and the disk gate's numbers.
  'jobId', 'approvalId', 'deploymentId', 'setup', 'freeBytes', 'requiredBytes',
  // B2b Task 14: the integration head a refused accept found, and whether its rollback is still owed.
  'current', 'rollbackOwed'
] as NexusErrorDetailKey[]);

/**
 * Why execution is off (the sub-reason of 'execution_unavailable'): the store's reasons, `not_enabled`,
 * `v8_unavailable`, `registry_invalid` (the startup registry check failed) and `not_started` (main's execution wiring
 * is not running). Anything else a service names is reported as `not_enabled`.
 */
export const EXECUTION_SUB_REASONS: readonly string[] = Object.freeze([
  'held', 'auto_held', 'backup_failed', 'failed', 'shape', 'not_enabled', 'v8_unavailable', 'registry_invalid', 'not_started'
]);
export const EXECUTION_UNAVAILABLE_MESSAGE = 'Running tasks is not available right now.';
/** B2b: the same sub-reasons say why the agents part (schema v10) is off. */
export const AGENTS_SUB_REASONS: readonly string[] = EXECUTION_SUB_REASONS;
export const AGENTS_UNAVAILABLE_MESSAGE = 'The AI helper is not available on this computer right now.';

/** The fixed sentence of each setup:* answer (an action this machine cannot run now). */
export const SETUP_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  docker_missing: 'Docker, a free program, is not installed, so this cannot run on this computer yet. Install Docker Desktop, then try again.',
  docker_stopped: 'Docker is not running. Start Docker Desktop and try again.',
  docker_memory_low: 'Docker does not have enough memory for this. Open Docker Desktop, give it more memory in its settings, then try again.',
  image_missing: 'The safe-space kit this needs has not been downloaded yet. Open “Get this computer ready” to download it.',
  image_mismatch: 'The safe-space kit on this computer is not the version Nexus expects. Download it again in “Get this computer ready”.',
  disk_low: 'There is not enough free space on your disk for this. Free some space, then try again.',
  runner_unavailable: 'The part of Nexus that runs tasks is not available right now. Try again in a moment.',
  git_missing: 'Git, a free program, is not installed, so this cannot run on this computer yet. Install it, then try again.'
});
const SETUP_RE = /^setup:([a-z][a-z0-9_]{0,31})$/;

/** Plain sentences for the service reasons a person can act on. Keyed by detail.reason. */
export const REASON_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  path_refused: 'That file cannot be saved. It is outside the project folder, or it is a linked file that is also stored under other names (some backup and package tools make these).',
  file_not_found: "That file was not found in this project's folder.",
  too_large: 'That file is too large to save.',
  not_text: 'Only plain text files can be saved here, and that file is not one.',
  secret_in_content: 'That file looks like it contains a password or secret key, so it was not saved.',
  sensitive_name: "Nexus never saves files that usually hold secrets, such as keys, passwords and environment settings files, or anything inside a project's hidden git folder.",
  project_folder_unavailable: "Nexus cannot open this project's folder, so nothing was read. Check that the folder is still there.",
  not_a_repository: "This project's folder is not tracked with git yet. Nexus needs git, a free tool that remembers changes, to read it.",
  not_a_commit: "That saved version was not found in this project's history.",
  kind_mismatch: 'That saved item holds a different kind of content.',
  secret_in_metadata: 'The name or details look like they contain a password or secret key, so nothing was saved.',
  produced_by_job: 'This item is made by a task or the AI helper, and Nexus finishes it itself. You cannot mark it ready by hand.'
});


/**
 * B2b Task 14: what a refused agent, review, accept or merge flow says (one plain sentence per reason; never a git message, a path or
 * a sha). Kept apart from REASON_MESSAGES, which the renderer mirrors word for word (REASON_TEXT): the renderer's copy of these
 * arrives with its own task, and `fail` reads both.
 */
export const AGENT_REASON_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  agents_unavailable: AGENTS_UNAVAILABLE_MESSAGE,
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
  git_missing: 'Git, a free program Nexus needs, is not installed on this computer. Install it, then try again.'
});

export function ok<T>(data: T, truncated?: boolean): NexusOk<T> {
  return truncated === undefined ? { ok: true, data } : { ok: true, data, truncated };
}

const lastSegment = (p: string): string => {
  const parts = p.split(/[\\/]+/).filter((x) => x.length > 0);
  return parts.length ? parts[parts.length - 1] : '';
};

/**
 * One safe line of text: absolute paths (drive letter, UNC, POSIX) are cut to their basename, secret-shaped
 * values are redacted, whitespace runs (newlines too) become one space, and the result is at most 300 characters.
 */
export function scrubMessage(text: string): string {
  let s = typeof text === 'string' ? text.slice(0, MAX_SCRUB_INPUT) : '';
  s = s.replace(/(?:\b[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s'"`<>|]*/g, (m) => lastSegment(m.replace(/^[A-Za-z]:/, '')));
  s = s.replace(/(^|[\s'"`(=,;\[])(\/[^\s'"`<>|]+)/g, (_m, pre: string, p: string) => `${pre}${lastSegment(p)}`);
  s = redactSecretText(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS - 1)}…` : s;
}

const REASON_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** The SQLite result codes of a held lock (immediateTx's detail.sqliteCode). */
const SQLITE_BUSY_RE = /^SQLITE_(BUSY|LOCKED)(_|$)/;
export const BUSY_MESSAGE = 'Nexus is busy right now. Try again in a moment.';

function safeDetail(d: Record<string, unknown> | undefined): NexusFail['detail'] {
  if (!d || typeof d !== 'object') return undefined;
  const out: NonNullable<NexusFail['detail']> = {};
  let n = 0;
  for (const k of DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
    const v = d[k];
    if (v === null) out[k] = null;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = scrubMessage(v).slice(0, MAX_DETAIL_STRING);
    else continue;
    n++;
  }
  return n > 0 ? out : undefined;
}

const safeToken = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v : fallback;

/** The failure answer for anything a handler threw. Never throws itself. */
export function fail(e: unknown, channel: string, log: (l: string) => void): NexusFail {
  try {
    if (e instanceof RequestError) {
      return { ok: false, code: 'invalid', message: scrubMessage(`Invalid request: ${e.field} ${e.why}.`), reason: e.reason === 'bad_params' ? 'bad_params' : 'bad_request', field: e.field };
    }
    if (e instanceof PlatformError) {
      const raw = e.detail && typeof e.detail === 'object' ? e.detail : undefined;
      // 'platform_unavailable' from a service never carries its own text (it may name a principal or a table):
      // a fixed message and a reason. Handoffs off keeps its reason and sub-reason; a lock is 'busy'; anything
      // else (a seeded row missing, a shape problem found late) is 'startup_failed'.
      if (e.code === 'platform_unavailable') {
        if (raw && raw.reason === 'handoffs_unavailable') return unavailable('handoffs_unavailable', typeof raw.subReason === 'string' ? raw.subReason : null);
        // A B2a service found execution off (the core, approvals, deployments or snapshots without the execution core).
        if (raw && raw.reason === 'execution_unavailable') return unavailable('execution_unavailable', typeof raw.subReason === 'string' ? raw.subReason : null);
        if (raw && raw.reason === 'not_enabled') return unavailable('execution_unavailable', 'not_enabled');
        // B2b: a service found the agents part off.
        if (raw && raw.reason === 'agents_unavailable') return unavailable('agents_unavailable', typeof raw.subReason === 'string' ? raw.subReason : null);
        const busy = raw !== undefined && typeof raw.sqliteCode === 'string' && SQLITE_BUSY_RE.test(raw.sqliteCode);
        return busy
          ? { ok: false, code: 'platform_unavailable', message: BUSY_MESSAGE, reason: 'busy' }
          : unavailable('startup_failed');
      }
      // An action this machine cannot run now: the setup id is kept as the reason and in detail.setup, with its sentence.
      const setup = e.code === 'unavailable' && raw && typeof raw.reason === 'string' ? SETUP_RE.exec(raw.reason) : null;
      if (setup) {
        const out: NexusFail = { ok: false, code: 'unavailable', reason: `setup:${setup[1]}`,
          message: Object.prototype.hasOwnProperty.call(SETUP_MESSAGES, setup[1]) ? SETUP_MESSAGES[setup[1]] : 'This cannot run on this computer yet.' };
        const detail = safeDetail({ ...raw, setup: setup[1] });
        if (detail) out.detail = detail;
        return out;
      }
      const reason = raw && typeof raw.reason === 'string' && REASON_RE.test(raw.reason) ? raw.reason : undefined;
      const known = reason === undefined ? undefined : Object.prototype.hasOwnProperty.call(REASON_MESSAGES, reason) ? REASON_MESSAGES[reason]
        : Object.prototype.hasOwnProperty.call(AGENT_REASON_MESSAGES, reason) ? AGENT_REASON_MESSAGES[reason] : undefined;
      const out: NexusFail = { ok: false, code: e.code as NexusErrorCode, message: known ?? (scrubMessage(e.message) || 'Nexus could not do that.') };
      if (reason !== undefined) out.reason = reason;
      const detail = safeDetail(raw);
      if (detail) out.detail = detail;
      return out;
    }
  } catch { /* fall through to internal */ }
  const name = safeToken(e instanceof Error ? e.name : typeof e, 'unknown');
  const code = safeToken(e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined, 'none');
  try { log(`[nexus-ipc] ${channel} failed error=${name} code=${code}`); } catch { /* logging never breaks the answer */ }
  return { ok: false, code: 'internal', message: INTERNAL_MESSAGE };
}

/**
 * The answer of every channel while the platform (or, for handoff channels, v8; for the execution channels #24-#41,
 * schema v9 execution) is not in place.
 */
export function unavailable(reason: string, subReason?: string | null): NexusFail {
  if (reason === 'execution_unavailable') {
    const sub = typeof subReason === 'string' && EXECUTION_SUB_REASONS.includes(subReason) ? subReason : 'not_enabled';
    return { ok: false, code: 'platform_unavailable', message: EXECUTION_UNAVAILABLE_MESSAGE, reason, subReason: sub };
  }
  if (reason === 'agents_unavailable') {
    const sub = typeof subReason === 'string' && AGENTS_SUB_REASONS.includes(subReason) ? subReason : 'not_enabled';
    return { ok: false, code: 'platform_unavailable', message: AGENTS_UNAVAILABLE_MESSAGE, reason, subReason: sub };
  }
  const out: NexusFail = reason === 'handoffs_unavailable'
    ? { ok: false, code: 'platform_unavailable', message: 'Handoffs are not available on this computer right now.', reason }
    : { ok: false, code: 'platform_unavailable', message: "Some of Nexus's saved information is not available right now.", reason };
  if (reason === 'handoffs_unavailable' && typeof subReason === 'string' && REASON_RE.test(subReason)) out.subReason = subReason;
  return out;
}
