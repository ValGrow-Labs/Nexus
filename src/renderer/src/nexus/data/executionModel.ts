// Pure: whether jobs can run on this computer, and the execution setup sheet, from
// what main last observed (HealthView, #23) and from how the execution channels
// answered. No React, so tests load it directly. Every number shown here comes
// from the HealthView or an approval; nothing is estimated in the renderer.
import type { AgentConsentView, AgentRuntimeOptionView, AgentRuntimeProblem, AgentSetupView, EventView, HealthView, NexusResult } from '@shared/nexus/ipc';
import { LOCAL_MODEL_KIND } from '@shared/nexus/localModel';
import { HOSTED_MODEL_KIND } from '@shared/nexus/hostedModel';
import { GIB, MIN_DOCKER_CPUS, MIN_DOCKER_MEMORY } from '@shared/nexus/resourceGate';
import { AGENT_DEFAULTS } from '@shared/nexus/agentPolicy';
import { AGENT_REASON_TEXT, agentOffText, agentsNotice, errorCopy, executionNotice, unavailableNotice } from './errorCopy';
import { termHelp, termName } from './glossary';

/**
 * Sizes in GB as Windows Explorer shows them (binary: 1 GB = 2^30 bytes), which is also how the resource gate
 * counts. Rounded down to one decimal, so free space is never overstated; a whole number has no decimal.
 */
export function gb(bytes: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const v = Math.floor((bytes / GIB) * 10) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} GB`;
}

/**
 * A size in the unit that reads best (bytes, KB, MB or GB; binary, as `gb`), with one decimal below 100 when it is
 * not whole: an image of 71.5 MB never reads "0 GB". A size that is not a known non-negative number reads "unknown".
 */
export function sizeLabel(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  const [v, unit] = bytes >= GIB ? [bytes / GIB, 'GB'] : bytes >= 2 ** 20 ? [bytes / 2 ** 20, 'MB'] : [bytes / 1024, 'KB'];
  const r = v < 100 ? Math.round(v * 10) / 10 : Math.round(v);
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} ${unit}`;
}

// ---------- availability ----------

export type SetupProblemId = 'docker_missing' | 'docker_stopped' | 'docker_memory_low' | 'docker_cpus_low' | 'disk_low' | 'image_missing'
  | 'image_mismatch' | 'runner_unavailable' | 'git_missing' | 'probe_unreadable';

/**
 * - unknown: health not read yet (or a passing failure: `retry`);
 * - platform_off: the whole platform is off (its notice already says why);
 * - execution_off: execution itself is off (held migration, not turned on in this build, not connected);
 * - setup: execution is on, but jobs cannot run on this computer (Docker, images, the runner, or free disk below the
 *   lease floor, where no job is started);
 * - ready: jobs can run. An advisory may remain: free disk below 30 GB (only image preparation and the execution
 *   checks need that; jobs still run above the lease floor) or below the recommended 40 GB.
 */
export type ExecAvailability =
  | { kind: 'unknown'; text: string | null; retry: boolean; checking?: boolean }
  | { kind: 'platform_off'; text: string }
  | { kind: 'execution_off'; subReason: string; text: string }
  | { kind: 'setup'; problems: SetupProblemId[]; profiles: string[]; text: string }
  | { kind: 'ready'; advisories: string[] };

const PROBLEM_ORDER: SetupProblemId[] = ['disk_low', 'docker_missing', 'docker_stopped', 'docker_memory_low', 'docker_cpus_low',
  'image_missing', 'image_mismatch', 'runner_unavailable', 'git_missing', 'probe_unreadable'];

const PROBLEM_LINE: Record<SetupProblemId, string> = {
  disk_low: 'there is not enough free space on your disk',
  docker_missing: 'Docker is not installed',
  docker_stopped: 'Docker is not running',
  docker_memory_low: 'Docker needs more memory',
  docker_cpus_low: 'Docker needs more processors',
  image_missing: 'a safe-space kit is not ready',
  image_mismatch: 'a safe-space kit is not the version Nexus expects',
  runner_unavailable: 'the part of Nexus that runs tasks is not running',
  git_missing: 'Git is not installed',
  probe_unreadable: 'this computer could not be checked'
};

/** True when free disk is known and below the floor under which main starts no task. */
export function diskBelowFloor(d: HealthView['disk']): boolean {
  return typeof d.dataHomeFreeBytes === 'number' && typeof d.leaseFloorBytes === 'number' && d.dataHomeFreeBytes < d.leaseFloorBytes;
}

/** The advisory below the 30 GB gate: tasks run, but safe-space kits cannot be prepared and the checks cannot run. */
export function diskGateAdvisory(d: HealthView['disk']): string | null {
  if (d.gate !== 'below_required' || typeof d.dataHomeFreeBytes !== 'number') return null;
  return diskLine(d);
}

/** The blocking problems of a HealthView, in the gate's order (advisories are not problems). */
export function setupProblems(h: HealthView): { problems: SetupProblemId[]; profiles: string[] } {
  const found = new Set<SetupProblemId>();
  const profiles: string[] = [];
  for (const p of h.problems ?? []) {
    const [id, profile] = p.split(':');
    if (id === 'images_unreadable') found.add('probe_unreadable');
    else if ((PROBLEM_ORDER as string[]).includes(id)) found.add(id as SetupProblemId);
    if ((id === 'image_missing' || id === 'image_mismatch') && profile && !profiles.includes(profile)) profiles.push(profile);
  }
  if (h.docker.state === 'stopped') found.add('docker_stopped');
  if (h.docker.state === 'missing') found.add('docker_missing');
  // B2a final review C2 (ruled): the 30 GB gate holds image preparation and the execution checks only; jobs run above
  // the lease floor. Main's gate lists `disk_low` below 30 GB, so that id alone is not a blocking problem here: free
  // disk blocks jobs only below the floor (main's #24 then answers `setup:disk_low`, and no job is leased).
  found.delete('disk_low');
  if (diskBelowFloor(h.disk)) found.add('disk_low');
  if (!h.runner.attached) found.add('runner_unavailable');
  return { problems: PROBLEM_ORDER.filter((p) => found.has(p)), profiles };
}

/** Where execution stands, from the platform view and the last #23 answer (null while unread). */
export function availabilityFrom(platform: { unavailable: { reason: string | null } | null }, health: NexusResult<HealthView> | null): ExecAvailability {
  if (platform.unavailable) return { kind: 'platform_off', text: unavailableNotice(platform.unavailable.reason) };
  if (!health) return { kind: 'unknown', text: null, retry: false };
  if (!health.ok) {
    const c = errorCopy(health.code, health.reason, health.subReason);
    if (c.kind === 'execution_unavailable') return { kind: 'execution_off', subReason: health.subReason ?? 'not_enabled', text: c.text };
    if (c.kind === 'unavailable') return { kind: 'platform_off', text: c.text };
    return { kind: 'unknown', text: c.text, retry: c.retry };
  }
  const h = health.data;
  if (!h.db.execution) {
    const sub = h.db.subReason ?? 'not_enabled';
    return { kind: 'execution_off', subReason: sub, text: executionNotice(sub) };
  }
  if (!h.registry.valid) return { kind: 'execution_off', subReason: 'registry_invalid', text: executionNotice('registry_invalid') };
  // Before main's first probe every fact is unknown: nothing may read as ready.
  if (h.checkedAt === null) return { kind: 'unknown', text: NOT_CHECKED, retry: false, checking: true };
  const { problems, profiles } = setupProblems(h);
  if (problems.length > 0) {
    const first = PROBLEM_LINE[problems[0]];
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
    return { kind: 'setup', problems, profiles, text: `Tasks cannot start yet: ${first}${more}. Press “${termName('getReady')}” to see what to do.` };
  }
  if (h.docker.state === 'unknown' || h.disk.gate === 'unknown' || h.disk.dataHomeFreeBytes === null) {
    return { kind: 'unknown', text: NOT_CHECKED, retry: false, checking: true };
  }
  const below = diskGateAdvisory(h.disk);
  const advisories = below ? [below]
    : h.disk.gate === 'below_recommended' && h.disk.dataHomeFreeBytes !== null
      ? [`You have ${gb(h.disk.dataHomeFreeBytes)} free. ${gb(h.disk.recommendedBytes)} is better.`] : [];
  return { kind: 'ready', advisories };
}

export const NOT_CHECKED = `Nexus has not checked this computer yet, so tasks cannot start. Press “${termName('getReady')}” to check it.`;

/** The one-line notice (ExecutionNotice): null when jobs can run and nothing needs saying. */
export function noticeFor(a: ExecAvailability): { text: string; setup: boolean } | null {
  switch (a.kind) {
    case 'ready': return a.advisories.length ? { text: a.advisories[0], setup: true } : null;
    case 'unknown': return a.text ? { text: a.text, setup: a.checking === true } : null;
    case 'platform_off': return null; // the platform notice already says it
    case 'execution_off': return { text: a.text, setup: a.subReason !== 'unreachable' };
    case 'setup': return { text: a.text, setup: true };
  }
}

// ---------- the setup sheet ----------

export type SetupState = 'ok' | 'problem' | 'advisory' | 'unknown' | 'off';
/** One row: a label, a status word (never colour alone), the facts, and what to do. */
export interface SetupRow {
  id: string; label: string; state: SetupState; word: string; text: string; action: string | null;
  /** For a safe-space kit row: the profile a "Prepare" button would ask for; null when that cannot be offered now. */
  prepare: { profile: string; label: string } | null;
  /** B2b, the agent's permission row only: Grant or Revoke (#51). */
  consent?: { op: 'grant' | 'revoke'; label: string };
  /** Plain extra detail for a "More details" fold (the permission row's other limits); null or absent when there is none. */
  more?: string | null;
}

const WORD: Record<SetupState, string> = { ok: 'Ready', problem: 'Needs attention', advisory: 'Works, but more space is better', unknown: 'Not checked', off: 'Not available' };
const row = (id: string, label: string, state: SetupState, text: string, action: string | null = null,
  prepare: SetupRow['prepare'] = null): SetupRow => ({ id, label, state, word: WORD[state], text, action, prepare });

/** What each safe-space kit is for, in words a person knows (the profile ids stay in code and are never shown). */
const KIT_FOR: Readonly<Record<string, string>> = Object.freeze({
  'sde-node': 'JavaScript (Node) projects', 'sde-python': 'Python projects', 'nexus-fwd': 'trying your app', 'ml-python': 'machine learning projects'
});
/** "Safe-space kit for Python projects" (a row label). An unknown profile reads "Safe-space kit", never its id. */
export const PROFILE_LABEL: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  Object.entries(KIT_FOR).map(([id, what]) => [id, `Safe-space kit for ${what}`])));
/** "Prepare the safe-space kit for Python projects" (an approval's title). */
export const kitTitle = (profile: string | null | undefined): string => (profile && KIT_FOR[profile] ? `Prepare the safe-space kit for ${KIT_FOR[profile]}` : 'Prepare a safe-space kit');

/** "Prepare this kit (about 0.6 GB)" when an approval stated the size, else "Prepare this kit". */
export function prepareLabel(estimatedBytes: number | null | undefined, again = false): string {
  const base = again ? 'Prepare this kit again' : 'Prepare this kit';
  return typeof estimatedBytes === 'number' && Number.isFinite(estimatedBytes) && estimatedBytes > 0 ? `${base} (about ${gb(estimatedBytes)})` : base;
}

/** The one button that asks for every kit that is not ready (each kit still waits for its own answer). */
export const PREPARE_ALL_LABEL = 'Prepare the safe-space kits';

/** The GPU line: always said, never offered. */
export function gpuLine(g: HealthView['gpu']): string {
  if (!g.detected) return 'No GPU (graphics chip) found. Nexus does not need one.';
  return g.model ? `GPU (graphics chip) found: ${g.model}. Nexus does not use it yet.` : 'A GPU (graphics chip) was found. Nexus does not use it yet.';
}

export function diskLine(d: HealthView['disk']): string {
  const need = `Getting the safe-space kits ready and running checks needs ${gb(d.requiredBytes)} (${gb(d.recommendedBytes)} is better).`;
  return d.dataHomeFreeBytes === null ? `Nexus could not measure your free space. ${need}` : `You have ${gb(d.dataHomeFreeBytes)} free. ${need}`;
}

const DOCKER_SETTINGS = 'Open Docker Desktop and go to Settings > Resources.';

/**
 * The sheet's rows. `estimates` holds the size a kit-preparation approval stated per profile (the only source of
 * that number); `pending` the profiles that already wait for an answer (their approval row is shown instead).
 */
export function setupSheet(h: HealthView, ctx: { estimates?: ReadonlyMap<string, number>; pending?: ReadonlySet<string>;
  /** The destinations the AI helper's permission covers, from #51 (shown on the permission row and nowhere else). */
  hosts?: readonly string[] | null } = {}): SetupRow[] {
  const rows: SetupRow[] = [];
  const d = h.docker;
  const dockerFacts = [d.version ? `version ${d.version}` : null, typeof d.cpus === 'number' ? `${d.cpus} processors` : null,
    typeof d.memoryBytes === 'number' ? `${gb(d.memoryBytes)} of memory` : null, d.os ? d.os : null].filter((x) => x !== null).join(', ');
  if (d.state === 'running') rows.push(row('docker', 'Docker', 'ok', dockerFacts ? `Docker is running (${dockerFacts}).` : 'Docker is running.'));
  else if (d.state === 'stopped') rows.push(row('docker', 'Docker', 'problem', 'Docker is not running.', 'Open Docker Desktop and wait until it says it is running. Then press Check again.'));
  else if (d.state === 'missing') rows.push(row('docker', 'Docker', 'problem', 'Docker is not installed. It is a free program.', 'Install Docker Desktop, open it, then press Check again.'));
  else rows.push(row('docker', 'Docker', 'unknown', 'Nexus has not checked Docker yet.', 'Press Check again in a moment.'));
  if (d.state === 'running') {
    if (typeof d.memoryBytes !== 'number' || d.memoryBytes < MIN_DOCKER_MEMORY) {
      rows.push(row('memory', 'Memory for Docker', 'problem', typeof d.memoryBytes === 'number'
        ? `Docker has ${gb(d.memoryBytes)} of memory. Nexus needs ${gb(MIN_DOCKER_MEMORY)}.` : `Nexus could not read how much memory Docker has. It needs ${gb(MIN_DOCKER_MEMORY)}.`,
      `${DOCKER_SETTINGS} Set memory to ${gb(MIN_DOCKER_MEMORY)}, then press Check again.`));
    } else rows.push(row('memory', 'Memory for Docker', 'ok', `Docker has ${gb(d.memoryBytes)} of memory. Nexus needs ${gb(MIN_DOCKER_MEMORY)}.`));
    if (typeof d.cpus !== 'number' || d.cpus < MIN_DOCKER_CPUS) {
      rows.push(row('cpus', 'Processors for Docker', 'problem', typeof d.cpus === 'number' ? `Docker has ${d.cpus} ${d.cpus === 1 ? 'processor' : 'processors'}. Nexus needs ${MIN_DOCKER_CPUS}.`
        : `Nexus could not read how many processors Docker has. It needs ${MIN_DOCKER_CPUS}.`, `${DOCKER_SETTINGS} Give Docker more processors, then press Check again.`));
    } else rows.push(row('cpus', 'Processors for Docker', 'ok', `Docker has ${d.cpus} processors. Nexus needs ${MIN_DOCKER_CPUS}.`));
  }
  const disk = h.disk;
  const FREE_UP = 'Free up space on the drive where Nexus keeps its files. Nexus never deletes anything itself.';
  if (disk.dataHomeFreeBytes === null) {
    rows.push(row('disk', 'Space on your disk', 'unknown', diskLine(disk), `${FREE_UP} Then press Check again.`));
  } else if (diskBelowFloor(disk)) {
    rows.push(row('disk', 'Space on your disk', 'problem', `${diskLine(disk)} Below ${gb(disk.leaseFloorBytes)}, no task can start.`, `${FREE_UP} Then press Check again.`));
  } else if (disk.gate === 'below_required') {
    // Ruled (final review C2): an advisory, not a blocker. Tasks run; only the safe-space kits and the checks wait.
    rows.push({ ...row('disk', 'Space on your disk', 'advisory', diskLine(disk),
      `Tasks can still run while there is room for their results. ${FREE_UP} Then you can prepare the safe-space kits.`),
    word: 'Tasks run; kits cannot be prepared' });
  } else if (disk.gate === 'below_recommended') {
    rows.push(row('disk', 'Space on your disk', 'advisory', diskLine(disk), 'Tasks can run. More free space keeps large builds from waiting.'));
  } else rows.push(row('disk', 'Space on your disk', 'ok', diskLine(disk)));
  // A kit can be prepared only while Docker runs and the disk passes the gate (main refuses it otherwise).
  const canPrepare = d.state === 'running' && disk.gate !== 'below_required' && disk.dataHomeFreeBytes !== null;
  for (const img of h.images) {
    const label = PROFILE_LABEL[img.profile] ?? 'Safe-space kit';
    if (img.present && img.matches) {
      rows.push(row(`image:${img.profile}`, label, 'ok', typeof img.sizeBytes === 'number' ? `Ready (${sizeLabel(img.sizeBytes)} on your disk).` : 'Ready.'));
      continue;
    }
    const again = img.present && !img.matches;
    const text = again ? 'Downloaded, but it is not the version Nexus expects.' : 'Not downloaded yet.';
    if (ctx.pending?.has(img.profile)) {
      rows.push(row(`image:${img.profile}`, label, 'problem', text, 'Waiting for your answer below.'));
    } else if (canPrepare) {
      rows.push(row(`image:${img.profile}`, label, 'problem', text, 'Nexus downloads it once, after you allow it.',
        { profile: img.profile, label: prepareLabel(ctx.estimates?.get(img.profile), again) }));
    } else {
      rows.push(row(`image:${img.profile}`, label, 'problem', text, d.state !== 'running'
        ? 'You can prepare it once Docker is running.'
        : disk.dataHomeFreeBytes === null ? 'You can prepare it once Nexus has measured your free space.'
          : `You can prepare it once you have ${gb(disk.requiredBytes)} free.`));
    }
  }
  // HealthView has no git field: Git is shown only when main reported it missing (never claimed as ready).
  if ((h.problems ?? []).includes('git_missing')) rows.push(row('git', 'Git', 'problem', 'Git is not installed. It is a free program that keeps the history of your project.', 'Install Git, then restart Nexus.'));
  rows.push(h.runner.attached
    ? row('runner', 'The part of Nexus that runs tasks', 'ok', h.runner.restarts > 0 ? `Running (it restarted ${h.runner.restarts} times).` : 'Running.')
    : row('runner', 'The part of Nexus that runs tasks', 'problem', 'Not running.', 'Restart Nexus. This part starts with the app.'));
  if (h.agent) rows.push(...agentSetupRows(h.agent, { hosts: ctx.hosts ?? null, offText: h.db.subReason ? agentsNotice(h.db.subReason) : undefined }));
  rows.push(row('gpu', 'Graphics chip (GPU)', 'ok', gpuLine(h.gpu)));
  // The GPU line is a fact, not a requirement: it is never a problem and never offered.
  rows[rows.length - 1].word = h.gpu.detected ? 'Not used' : 'Not needed';
  return rows;
}

// ---------- the agent's rows (B2b) ----------
// The adapter's own label and the destinations of the permission are shown HERE and nowhere else in the renderer: every other
// agent view says "the agent" and "your network permission".

/**
 * Said on the permission row: two short sentences about your own AI program (Your own plan). The honest limits of those two sentences
 * are in AGENT_STATE_DETAILS, one click away under "More details". No claim here is stronger than what the code does.
 */
export const AGENT_STATE_DISCLOSURE = 'Your AI program runs on this computer as you, and keeps its own sign-in and settings in your user folder. '
  + 'Its online requests go through Nexus, which allows only the address you approve, and every command it runs goes into a safe space with no internet.';
export const AGENT_STATE_DETAILS = 'Nexus never reads, copies or stores your sign-in. The address rule is a setting the program follows, not a firewall. '
  + 'Which files it may touch is the program’s own rule, not a wall your computer enforces.';

const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,120}[a-z0-9])?:[0-9]{1,5}$/i;
/** The destinations of a #51 answer (`consent.hosts`), kept only when they read as host:port; null when none do. */
export function consentHostsOf(view: Pick<AgentConsentView, 'consent'> | null | undefined): string[] | null {
  const hosts = view && Array.isArray(view.consent?.hosts) ? view.consent.hosts.filter((x) => typeof x === 'string' && HOST_RE.test(x)).slice(0, 8) : [];
  return hosts.length > 0 ? hosts : null;
}

/** The longest the sheet keeps looking for the destination after an answer that has none yet (each look comes after the probe had time to land). */
export const CONSENT_REREAD_LIMIT = 3;
const CONSENT_REREAD_BASE_MS = 1_500;
/**
 * #51 `get` never waits: with a stale cache it answers at once with no destination while the probe runs. So an answer that is not
 * granted, has no destination and is not a settled "cannot be granted" (no program, not signed in, unsupported) is asked again, a
 * bounded number of times, each a little later. Null: nothing more to wait for.
 */
export function consentRereadDelay(view: Pick<AgentConsentView, 'state' | 'consent'> | null, attempt: number): number | null {
  if (!view || attempt >= CONSENT_REREAD_LIMIT) return null;
  if (view.consent.live || consentHostsOf(view) !== null) return null;
  if (view.state === 'not_installed' || view.state === 'not_signed_in' || view.state === 'version_unsupported') return null;
  return CONSENT_REREAD_BASE_MS * (attempt + 1);
}

type Caps = { turnUsdCents: number; dayUsdCents: number; turnsPerHour: number; concurrentTurns: number; turnTokens: number; toolCalls: number;
  wallClockMs: number; childJobs: number };
const dollars = (cents: number): string => `$${Math.floor(cents / 100)}.${String(Math.round(cents) % 100).padStart(2, '0')}`;
/** The two limits a person cares about, in plain words: "up to $2.00 per request, $10.00 per day". */
const capsText = (c: Caps): string => `up to ${dollars(c.turnUsdCents)} per request, ${dollars(c.dayUsdCents)} per day`;
/** Every other limit, in plain words, for the "More details" fold. */
const capsMore = (c: Caps): string => `Other limits: ${c.turnsPerHour} requests an hour and ${c.concurrentTurns} at a time. `
  + `Each request is also limited to about ${Math.round(c.turnTokens / 1000)}k tokens (a way of counting text), ${c.toolCalls} uses of tools, `
  + `${Math.max(1, Math.round(c.wallClockMs / 60_000))} minutes and ${c.childJobs} extra tasks.`;

/** Said on the permission row of the AI that runs on this computer: two short sentences. The honest limit is in LOCAL_MODEL_DETAILS. */
export const LOCAL_MODEL_DISCLOSURE = 'The AI runs on your own computer, and Nexus sends nothing to another computer. '
  + 'Every command it runs goes into a safe space with no internet, and it can change files only in its own safe copy of your project.';
export const LOCAL_MODEL_DETAILS = 'Which files it may touch is a rule in Nexus’s own file tools, not a wall your computer enforces.';

/** Said under the guide, before anything is allowed: what pressing "Use this AI service" gives, in plain words, with the two limits. */
export const PERMISSION_NOTE = `${termHelp('internetPermission')} Pressing “Use this AI service” gives it. Limits: ${capsText(AGENT_DEFAULTS)}.`;

/** The sentence for why a chosen local model cannot be used (the fixed sentences main words for the same reasons). */
export const LOCAL_PROBLEM_TEXT: Readonly<Record<AgentRuntimeProblem, string>> = Object.freeze({
  model_not_chosen: AGENT_REASON_TEXT.local_model_not_chosen,
  address_not_local: AGENT_REASON_TEXT.local_model_endpoint,
  model_missing: AGENT_REASON_TEXT.local_model_missing,
  model_no_tools: AGENT_REASON_TEXT.local_model_no_tools,
  // The runtime that offers hosted providers words its own problems the same way.
  provider_not_chosen: AGENT_REASON_TEXT.hosted_provider_not_chosen,
  key_missing: AGENT_REASON_TEXT.hosted_key_missing,
  key_rejected: AGENT_REASON_TEXT.hosted_key_rejected,
  model_unavailable: AGENT_REASON_TEXT.hosted_model_unavailable
});

/**
 * Said on the permission row of Free online AI: two short sentences. The provider names and addresses are the probe's own (the row names
 * the addresses it would cover); no provider is named here. The honest limits are in HOSTED_MODEL_DETAILS.
 */
export const HOSTED_MODEL_DISCLOSURE = 'Your AI helper’s requests go over the internet to the AI service you chose, and Nexus allows only that service’s addresses. '
  + 'Your access key stays locked on this computer, is never shown again, and is sent only to that service.';
export const HOSTED_MODEL_DETAILS = 'Every command the AI helper runs goes into a safe space with no internet. '
  + 'Which files it may touch is a rule in Nexus’s own file tools, not a wall your computer enforces.';

/** Where the keys are kept in Settings: said in full wherever a person is sent there. */
export const KEYS_PATH = 'Settings > Agents & Models > access keys';

/** How to get a key, said where a key is missing and in Settings. No address is given here: the person finds the AI service's own website. */
export const KEY_HELP_TEXT = `To get a free access key, open the website of the AI service, sign up for free, and create a key there. Then open ${KEYS_PATH} and paste it. `
  + 'Nexus keeps it locked on this computer and never shows it again.';

/** The hosted runtime's program row for the states it words itself; null leaves the generic row to speak. */
function hostedProgramRow(a: Pick<AgentSetupView, 'state' | 'problem'>, label: string): SetupRow | null {
  if (a.state !== 'ready') return null;
  if (a.problem === 'key_missing' || a.problem === 'key_rejected') return row('agent', label, 'problem', LOCAL_PROBLEM_TEXT[a.problem], `Open ${KEYS_PATH}, add your key, then press Check again.`);
  if (a.problem) return row('agent', label, 'problem', LOCAL_PROBLEM_TEXT[a.problem], 'Choose an AI service and a model in the list below, then press Check again.');
  return row('agent', label, 'ok', 'An AI service, a model and your access key are set up.');
}

/** The local-model runtime's program row for the states it words itself; null leaves the generic row to speak. */
function localProgramRow(a: Pick<AgentSetupView, 'state' | 'problem'>, label: string, version: string): SetupRow | null {
  if (a.state === 'not_installed') return row('agent', label, 'problem', AGENT_REASON_TEXT.local_model_server_down, 'Start the program, then press Check again.');
  // The local runtime reports "unsupported" when the server has no model that can use tools: said as that, not as a program version.
  if (a.state === 'version_unsupported') return row('agent', label, 'problem', LOCAL_PROBLEM_TEXT.model_no_tools, 'Choose a model in the list below, then press Check again.');
  if (a.state !== 'ready') return null;
  if (a.problem) return row('agent', label, 'problem', LOCAL_PROBLEM_TEXT[a.problem], 'Choose a model in the list below, then press Check again.');
  return row('agent', label, 'ok', `The program that runs AI on this computer is working, and the chosen model can use tools${version}.`);
}

/** The AI helper's setup rows: the service or program (its label from the adapter), the internet permission, and today's use. */
export function agentSetupRows(a: AgentSetupView, o: { hosts?: readonly string[] | null; fmt?: (t: number) => string; offText?: string } = {}): SetupRow[] {
  const fmt = o.fmt ?? ((t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  // AI helper work is not in place: one row, one sentence. Nothing to check, nothing to allow, no "check again".
  if (a.state === 'off') return [row('agent', 'AI helper', 'off', agentOffText(a.offReason, o.offText))];
  const rows: SetupRow[] = [];
  const label = a.label ?? 'AI helper';
  const version = a.version ? ` (version ${a.version})` : '';
  const local = a.kind === LOCAL_MODEL_KIND;
  const hosted = a.kind === HOSTED_MODEL_KIND;
  const localRow = local ? localProgramRow(a, label, version) : hosted ? hostedProgramRow(a, label) : null;
  if (localRow) rows.push(localRow);
  else switch (a.state) {
    case 'ready':
      // `ready` only means the program answered and did not say it is signed out: a sign-in that could not be read is said so.
      if (a.signedIn === 'yes') rows.push(row('agent', label, 'ok', `Your AI program is installed and signed in${version}.`));
      else rows.push(row('agent', label, 'unknown', `Your AI program is installed${version}. Nexus could not confirm that you are signed in.`,
        'Press Check again in a moment. Nexus never signs in for you.'));
      break;
    case 'not_installed':
      rows.push(row('agent', label, 'problem', 'Your AI program is not installed on this computer.', 'Install it, then press Check again.')); break;
    case 'not_signed_in':
      rows.push(row('agent', label, 'problem', 'Your AI program is not signed in. Sign in with it yourself, then press Check again.', 'Nexus never signs in for you.')); break;
    case 'version_unsupported':
      rows.push(row('agent', label, 'problem', `The installed AI program is not a version Nexus supports${version}.`,
        'Install a supported version, then press Check again.')); break;
    case 'unavailable':
      rows.push(row('agent', label, 'unknown', 'Nexus could not check your AI program. Press Check again.', 'Press Check again in a moment.')); break;
    default:
      rows.push(row('agent', label, 'unknown', 'Nexus has not checked your AI program on this computer yet.', 'Press Check again in a moment.'));
  }
  const hosts = o.hosts && o.hosts.length > 0 ? o.hosts : null;
  const dest = hosts ? hosts.join(', ') : a.consent.hostsCount === 1 ? 'one online address' : `${a.consent.hostsCount} online addresses`;
  const disclosure = local ? LOCAL_MODEL_DISCLOSURE : hosted ? HOSTED_MODEL_DISCLOSURE : AGENT_STATE_DISCLOSURE;
  const details = local ? LOCAL_MODEL_DETAILS : hosted ? HOSTED_MODEL_DETAILS : AGENT_STATE_DETAILS;
  const reach = local ? 'Your AI helper may use the AI on this computer only at' : 'Your AI helper may reach only';
  const PERMISSION = termName('internetPermission').replace(/^./, (ch) => ch.toUpperCase());
  if (a.consent.live) {
    const c = a.consent.caps;
    const caps = c ? ` Limits: ${capsText(c)}.` : '';
    const when = a.consent.grantedAt !== null ? ` at ${fmt(a.consent.grantedAt)}` : '';
    rows.push({ ...row('agent-consent', PERMISSION, 'ok', `Allowed${when}. ${reach} ${dest}.${caps}`, disclosure),
      consent: { op: 'revoke', label: 'Take permission back' }, more: [details, c ? capsMore(c) : null].filter((x) => x !== null).join(' ') });
  } else if (a.state === 'ready' && hosts) {
    rows.push({ ...row('agent-consent', PERMISSION, 'problem', `Not allowed yet. ${local ? 'Giving permission lets Nexus use the AI on this computer only at' : 'Giving permission lets your AI helper reach only'} ${dest}. `
      + `Your AI helper needs it. Limits: ${capsText(AGENT_DEFAULTS)}.`, disclosure),
    consent: { op: 'grant', label: 'Give permission' }, more: `${details} ${capsMore(AGENT_DEFAULTS)}` });
  } else if (a.state === 'ready') {
    rows.push({ ...row('agent-consent', PERMISSION, 'problem', 'Not allowed yet. Nexus will show the address here once it has read it from your AI program.',
      `${disclosure} Press Check again to read it.`), more: details });
  } else {
    rows.push({ ...row('agent-consent', PERMISSION, 'problem', 'Not allowed yet. You can allow it once your AI helper is ready.', disclosure), more: details });
  }
  const u = a.usageToday;
  const usage = u.turns === 0 && u.usdCents === 0 ? 'No request has started today.'
    : `${u.turns} ${u.turns === 1 ? 'request' : 'requests'} started today, costing ${u.estimated ? `about ${dollars(u.usdCents)} (Nexus’s own estimate: the AI service did not report a cost)`
      : `${dollars(u.usdCents)} (reported by the AI service)`}.`;
  rows.push(row('agent-usage', 'AI helper use today', 'ok', usage));
  rows[rows.length - 1].word = 'Today';
  return rows;
}

// ---------- the runtime picker (B2b: the agent program, or the local model) ----------

export interface RuntimeChoice {
  kind: string; label: string; selected: boolean; state: SetupState; word: string; text: string;
  /** The destinations a permission for this runtime covers (the picker row names them before anything is granted). */
  destination: string | null;
  /** Only the runtime that serves models: its choices (a model that cannot use tools is listed, but cannot be picked). */
  models: { name: string; label: string; disabled: boolean }[] | null;
  /** The model in force or preselected (a name from `models`, or from the chosen provider's `providers` entry), null when none. */
  model: string | null;
  /**
   * Only the runtime that offers hosted providers: its providers, each with its models (the chosen provider's list is the model dropdown's),
   * the provider in force or preselected, and what a missing or rejected key needs (a sentence, with the provider's label; the button
   * opens Settings). `models` is null for such a runtime: the model list is the chosen provider's.
   */
  providers?: ProviderChoice[] | null;
  provider?: string | null;
  keyHelp?: { text: string; settings: boolean } | null;
  /** What the row's button does: use this runtime when no permission is live, switch to it when another is; null for the one in use. */
  action: { op: 'grant' | 'switch'; label: string; disabled: boolean } | null;
}

/** One provider of the hosted runtime as the picker lists it: its models (one that cannot use tools is listed, but cannot be picked) and whether a key is saved. */
export interface ProviderChoice { id: string; label: string; keyPresent: boolean; destination: string | null; models: { name: string; label: string; disabled: boolean }[] }

const runtimeWord = (o: AgentRuntimeOptionView): { word: string; text: string; ok: boolean } => {
  const local = o.kind === LOCAL_MODEL_KIND;
  switch (o.state) {
    case 'ready':
      if (local) return o.problem ? { word: 'Needs attention', text: LOCAL_PROBLEM_TEXT[o.problem], ok: false }
        : { word: 'Ready', text: 'The program that runs AI on this computer is working, and the chosen model can use tools.', ok: o.model !== null };
      return o.signedIn === 'yes' ? { word: 'Ready', text: 'Your AI program is installed and signed in.', ok: true }
        : { word: 'Not checked', text: 'Your AI program is installed. Nexus could not confirm that you are signed in.', ok: false };
    case 'not_installed': return { word: 'Needs attention', text: local ? AGENT_REASON_TEXT.local_model_server_down : AGENT_REASON_TEXT.runtime_not_installed, ok: false };
    case 'not_signed_in': return { word: 'Needs attention', text: AGENT_REASON_TEXT.runtime_not_authenticated, ok: false };
    case 'version_unsupported': return { word: 'Needs attention', text: local ? LOCAL_PROBLEM_TEXT.model_no_tools : AGENT_REASON_TEXT.runtime_version_unsupported, ok: false };
    case 'unavailable': return { word: 'Not checked', text: AGENT_REASON_TEXT.runtime_error, ok: false };
    default: return { word: 'Not checked', text: AGENT_REASON_TEXT.runtime_unknown, ok: false };
  }
};

/**
 * What the person last picked in the setup sheet, for this session only (never stored): the runtime that was in use and the model
 * chosen per runtime. Closing the sheet or revoking the permission does not forget it, so the picker comes back as it was left
 * and "Use this runtime" grants that same runtime and model again.
 */
const memory: { kind: string | null; models: Record<string, string>; providers: Record<string, string> } = { kind: null, models: {}, providers: {} };
export const runtimeMemory = {
  models: (): Record<string, string> => ({ ...memory.models }),
  /** The provider picked per runtime (only a runtime that offers providers). */
  providers: (): Record<string, string> => ({ ...memory.providers }),
  kind: (): string | null => memory.kind,
  rememberModel(kind: string, model: string): void { memory.models[kind] = model; },
  rememberProvider(kind: string, provider: string): void { memory.providers[kind] = provider; },
  /** The runtime in use (with its model, when it serves models). */
  rememberInUse(kind: string, model: string | null): void { memory.kind = kind; if (model) memory.models[kind] = model; },
  clear(): void { memory.kind = null; memory.models = {}; memory.providers = {}; }
};

/**
 * A permission change answers before the probe has refilled its cache, so the answer may list fewer runtimes than the sheet already
 * showed (a revoke left only the local model's row for many seconds). The runtimes the answer leaves out keep their last row, no
 * longer in use; the next read of #51 (the sheet re-asks) replaces them all with the probe's own.
 */
export function keepRuntimes(prev: AgentConsentView | null | undefined, next: AgentConsentView): AgentConsentView {
  const before = prev && Array.isArray(prev.runtimes) ? prev.runtimes : [];
  if (before.length === 0 || !Array.isArray(next.runtimes)) return next;
  const have = new Set(next.runtimes.map((r) => r.kind));
  const kept = before.filter((r) => !have.has(r.kind)).map((r) => ({ ...r, selected: false }));
  return kept.length === 0 ? next : { ...next, runtimes: [...next.runtimes, ...kept].sort((a, b) => before.findIndex((r) => r.kind === a.kind) - before.findIndex((r) => r.kind === b.kind)) };
}

/** How long to wait before reading #51 again when an answer lists fewer runtimes than the sheet showed (the probe is still refilling), and how many times. */
export const SHRUNK_REREAD_MS = 3_000;
export const SHRUNK_REREAD_LIMIT = 6;
/** Null: nothing to wait for (the answer lists every runtime already shown, or the tries are used up). */
export function shrunkRereadDelay(prev: Pick<AgentConsentView, 'runtimes'> | null | undefined, next: Pick<AgentConsentView, 'runtimes'>, attempt: number): number | null {
  if (attempt >= SHRUNK_REREAD_LIMIT || !prev || !Array.isArray(prev.runtimes) || !Array.isArray(next.runtimes)) return null;
  const have = new Set(next.runtimes.map((r) => r.kind));
  return prev.runtimes.some((r) => !have.has(r.kind)) ? SHRUNK_REREAD_MS : null;
}

/** The runtime in use in a #51 answer, for the memory: its kind and model. Null when no permission is live. */
export function runtimeInUse(view: Pick<AgentConsentView, 'runtimes' | 'consent'> | null | undefined): { kind: string; model: string | null; provider?: string | null } | null {
  if (!view || !view.consent.live || !Array.isArray(view.runtimes)) return null;
  const r = view.runtimes.find((o) => o.selected);
  // The provider is named only for a runtime that offers providers (every other answer keeps its two keys).
  return r ? { kind: r.kind, model: r.model ?? null, ...(Array.isArray(r.providers) ? { provider: r.provider ?? null } : {}) } : null;
}

/**
 * The hosted runtime's picker row. The provider is the one picked in this sheet, else the one in force, else the first provider that has
 * a model able to use tools (the probe's own order); the model is the picked one when that provider lists it (and it can use tools), else
 * the one in force for that provider, else that provider's first model able to use tools. Usable once the provider has a saved key.
 */
function hostedChoice(o: AgentRuntimeOptionView, live: boolean, chosen: Readonly<Record<string, string>>, chosenProviders: Readonly<Record<string, string>>, lastKind: string | null): RuntimeChoice {
  const providers: ProviderChoice[] = (o.providers ?? []).map((p) => ({ id: p.id, label: p.label, keyPresent: p.keyPresent === true,
    destination: p.hosts.length > 0 ? p.hosts.join(', ') : null,
    models: p.models.map((m) => ({ name: m.name, label: m.tools ? m.name : `${m.name} (cannot use tools)`, disabled: !m.tools })) }));
  const usableModels = (p: ProviderChoice | undefined): string[] => (p ? p.models.filter((m) => !m.disabled).map((m) => m.name) : []);
  const byId = (id: string | undefined | null): ProviderChoice | undefined => (typeof id === 'string' ? providers.find((p) => p.id === id) : undefined);
  const provider = byId(chosenProviders[o.kind]) ?? byId(o.provider) ?? providers.find((p) => usableModels(p).length > 0);
  const pickedModel = chosen[o.kind];
  const model = !provider ? null
    : pickedModel !== undefined && usableModels(provider).includes(pickedModel) ? pickedModel
      : o.model !== null && o.provider === provider.id && usableModels(provider).includes(o.model) ? o.model : usableModels(provider)[0] ?? null;
  const hasKey = provider?.keyPresent === true;
  const rejected = o.selected && o.problem === 'key_rejected';
  const destination = o.hosts.length > 0 ? o.hosts.join(', ') : null;
  const usable = o.state === 'ready' && provider !== undefined && model !== null && hasKey && !rejected;
  const keyHelp = o.state === 'ready' && provider !== undefined && (!hasKey || rejected)
    ? { text: rejected ? AGENT_REASON_TEXT.hosted_key_rejected : `${AGENT_REASON_TEXT.hosted_key_missing} ${KEY_HELP_TEXT}`, settings: true } : null;
  const w: { word: string; text: string; ok: boolean } = o.state !== 'ready' ? runtimeWord(o)
    : !provider || model === null ? { word: 'Needs attention', text: AGENT_REASON_TEXT.hosted_provider_not_chosen, ok: false }
      : rejected ? { word: 'Needs attention', text: AGENT_REASON_TEXT.hosted_key_rejected, ok: false }
        : !hasKey ? { word: 'Needs attention', text: AGENT_REASON_TEXT.hosted_key_missing, ok: false }
          : o.selected && o.problem !== null ? { word: 'Needs attention', text: LOCAL_PROBLEM_TEXT[o.problem], ok: false }
            : { word: 'Ready', text: 'An AI service, a model and your access key are set up.', ok: true };
  const text = o.selected ? (w.ok ? w.text : `In use. ${w.text}`) : !live && lastKind === o.kind ? `${w.text} It was in use before the permission was taken back.` : w.text;
  return { kind: o.kind, label: o.label ?? 'AI service', selected: o.selected, state: usable || (o.selected && w.ok) ? 'ok' : w.word === 'Not checked' ? 'unknown' : 'problem',
    word: o.selected && w.ok ? 'In use' : w.word, text, destination, models: null, model, providers, provider: provider?.id ?? null, keyHelp,
    action: o.selected ? null : { op: live ? 'switch' : 'grant', label: live ? 'Switch to this AI service' : 'Use this AI service', disabled: !usable } };
}

/**
 * With the runtime picker shown and no permission live, the permission row has no Grant button: it describes the default runtime,
 * so granting there would silently use the program instead of the runtime the person picked. Each runtime's own row grants its own.
 */
export function pickerPermissionRows(rows: readonly SetupRow[], o: { picker: boolean; live: boolean }): SetupRow[] {
  if (!o.picker || o.live) return [...rows];
  return rows.map((r) => {
    if (r.id !== 'agent-consent' || !r.consent || r.consent.op !== 'grant') return r;
    const { consent: _grant, ...rest } = r;
    return { ...rest, text: 'Not allowed yet. Your AI helper needs it. Press “Use this AI service” on a service below to allow it; the address it reaches is shown on that service’s row.' };
  });
}

/**
 * The picker's rows from #51's runtimes. Empty unless the probe reported more than one runtime (or one that serves models): with a
 * single runtime the sheet is as it always was. `chosen`: the model the person picked per runtime in the open sheet.
 */
export function runtimeChoices(view: Pick<AgentConsentView, 'runtimes' | 'consent'> | null | undefined, chosen: Readonly<Record<string, string>> = {}, lastKind: string | null = null,
  chosenProviders: Readonly<Record<string, string>> = {}): RuntimeChoice[] {
  const list = view && Array.isArray(view.runtimes) ? view.runtimes : [];
  if (list.length === 0 || (list.length < 2 && list.every((r) => r.models === null && !Array.isArray(r.providers)))) return [];
  const live = view!.consent.live;
  return list.map((o): RuntimeChoice => {
    if (o.kind === HOSTED_MODEL_KIND && Array.isArray(o.providers)) return hostedChoice(o, live, chosen, chosenProviders, lastKind);
    const w = runtimeWord(o);
    const models = o.models ? o.models.map((m) => ({ name: m.name, label: m.tools ? m.name : `${m.name} (cannot use tools)`, disabled: !m.tools })) : null;
    const pick = chosen[o.kind];
    const model = models ? (pick !== undefined && models.some((m) => m.name === pick && !m.disabled) ? pick : o.model) : null;
    const destination = o.hosts.length > 0 ? o.hosts.join(', ') : null;
    // A runtime that serves models is usable once the server is up, its address is on this computer and a model that can use tools is picked.
    const picked = models !== null && model !== null && models.some((m) => m.name === model && !m.disabled);
    const serverOk = o.state === 'ready' && o.problem !== 'address_not_local';
    const usable = models === null ? w.ok : serverOk && picked;
    const text = models !== null && !o.selected && serverOk && picked ? 'The program that runs AI on this computer is working, and the chosen model can use tools.' : w.text;
    return { kind: o.kind, label: o.label ?? 'AI service', selected: o.selected, state: usable || (o.selected && w.ok) ? 'ok' : w.word === 'Not checked' ? 'unknown' : 'problem', word: o.selected && w.ok ? 'In use' : usable && !w.ok ? 'Ready' : w.word,
      // The word says "In use" once: the text repeats it only when the program has a problem the word does not show.
      text: o.selected ? (w.ok ? w.text : `In use. ${w.text}`) : !live && lastKind === o.kind ? `${text} It was in use before the permission was taken back.` : text, destination, models, model,
      action: o.selected ? null : { op: live ? 'switch' : 'grant', label: live ? 'Switch to this AI service' : 'Use this AI service', disabled: !usable } };
  });
}

/** The sheet's lead line: "Jobs can run" only when execution is ready AND every row is fine. */
export function setupLead(a: ExecAvailability, rows: readonly SetupRow[]): string | null {
  if (a.kind === 'setup') return 'Tasks can run only once everything below is ready. Nexus changes nothing on this computer by itself.';
  // The AI helper's rows (B2b) are about its requests, not about whether tasks can run: they never hold this line back.
  const jobRows = rows.filter((r) => !r.id.startsWith('agent'));
  if (a.kind === 'ready' && jobRows.length > 0 && jobRows.every((r) => r.state === 'ok' || r.state === 'advisory')) return 'Tasks can run on this computer.';
  if (a.kind === 'unknown' && a.checking) return NOT_CHECKED;
  return null;
}

/** "Checked at 14:05", or that it was never checked. */
export function checkedLine(checkedAt: number | null, fmt: (t: number) => string = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })): string {
  return checkedAt === null ? 'Nexus has not checked this computer yet.' : `Checked at ${fmt(checkedAt)}.`;
}

// ---------- hints: which lists to read again ----------

export type ExecList = 'jobs' | 'approvals' | 'deployments' | 'validations' | 'health' | 'artifacts';

const FINISHED = /-> (completed|partial|failed|cancelled|timed_out|interrupted)\b/;

/** The lists a page of events touches; every other list is left alone (a hint storm re-reads only these). */
export function affectedLists(events: readonly Pick<EventView, 'type' | 'summary'>[]): Set<ExecList> {
  const out = new Set<ExecList>();
  for (const e of events) {
    switch (e.type) {
      case 'job.transition':
        out.add('jobs');
        // A finished job may have ingested outputs: the artifact list (and the actions that need them) change.
        if (FINISHED.test(e.summary)) { out.add('artifacts'); out.add('validations'); }
        break;
      case 'attempt.transition': case 'attempt.provisioned': case 'attempt.progress': case 'attempt.output':
      case 'attempt.heartbeat_gap':
        out.add('jobs'); break;
      // A preflight or a recovery pass re-probes this computer: the setup facts may have changed too.
      case 'preflight': case 'recovery': out.add('jobs'); out.add('health'); break;
      case 'approval': out.add('approvals'); out.add('jobs'); break;
      case 'image_build': out.add('approvals'); out.add('health'); break;
      case 'deployment': out.add('deployments'); out.add('artifacts'); break;
      case 'validation': out.add('validations'); out.add('artifacts'); break;
      default: out.add('jobs');
    }
  }
  return out;
}
