// Pure: whether jobs can run on this computer, and the execution setup sheet, from
// what main last observed (HealthView, #23) and from how the execution channels
// answered. No React, so tests load it directly. Every number shown here comes
// from the HealthView or an approval; nothing is estimated in the renderer.
import type { AgentConsentView, AgentSetupView, EventView, HealthView, NexusResult } from '@shared/nexus/ipc';
import { GIB, MIN_DOCKER_CPUS, MIN_DOCKER_MEMORY } from '@shared/nexus/resourceGate';
import { AGENT_DEFAULTS } from '@shared/nexus/agentPolicy';
import { errorCopy, executionNotice, unavailableNotice } from './errorCopy';

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
  disk_low: 'there is not enough free disk for the output of a job',
  docker_missing: 'Docker is not installed',
  docker_stopped: 'Docker is not running',
  docker_memory_low: 'Docker has too little memory',
  docker_cpus_low: 'Docker has too few CPUs',
  image_missing: 'a sandbox image is not prepared',
  image_mismatch: 'a sandbox image does not match the pinned version',
  runner_unavailable: 'the execution runner is not running',
  git_missing: 'git is not installed',
  probe_unreadable: 'this computer could not be checked'
};

/** True when free disk is known and below the floor under which main starts no job. */
export function diskBelowFloor(d: HealthView['disk']): boolean {
  return typeof d.dataHomeFreeBytes === 'number' && typeof d.leaseFloorBytes === 'number' && d.dataHomeFreeBytes < d.leaseFloorBytes;
}

/** The advisory below the 30 GB gate: jobs run, but images cannot be prepared and the execution checks cannot run. */
export function diskGateAdvisory(d: HealthView['disk']): string | null {
  if (d.gate !== 'below_required' || typeof d.dataHomeFreeBytes !== 'number') return null;
  return `${diskLine(d)}.`;
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
    return { kind: 'setup', problems, profiles, text: `Jobs cannot run on this computer yet: ${first}${more}. Open the setup to see what to do.` };
  }
  if (h.docker.state === 'unknown' || h.disk.gate === 'unknown' || h.disk.dataHomeFreeBytes === null) {
    return { kind: 'unknown', text: NOT_CHECKED, retry: false, checking: true };
  }
  const below = diskGateAdvisory(h.disk);
  const advisories = below ? [below]
    : h.disk.gate === 'below_recommended' && h.disk.dataHomeFreeBytes !== null
      ? [`Free disk is ${gb(h.disk.dataHomeFreeBytes)}; ${gb(h.disk.recommendedBytes)} is recommended.`] : [];
  return { kind: 'ready', advisories };
}

export const NOT_CHECKED = 'This computer has not been checked yet, so jobs cannot start. Open the setup to check it.';

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

export type SetupState = 'ok' | 'problem' | 'advisory' | 'unknown';
/** One row: a label, a status word (never colour alone), the facts, and what to do. */
export interface SetupRow {
  id: string; label: string; state: SetupState; word: string; text: string; action: string | null;
  /** For an image row: the profile a "Prepare image" button would ask for; null when that cannot be offered now. */
  prepare: { profile: string; label: string } | null;
  /** B2b, the agent's permission row only: Grant or Revoke (#51). */
  consent?: { op: 'grant' | 'revoke'; label: string };
}

const WORD: Record<SetupState, string> = { ok: 'Ready', problem: 'Needs attention', advisory: 'Works, below the recommendation', unknown: 'Not checked' };
const row = (id: string, label: string, state: SetupState, text: string, action: string | null = null,
  prepare: SetupRow['prepare'] = null): SetupRow => ({ id, label, state, word: WORD[state], text, action, prepare });

export const PROFILE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'sde-node': 'Node sandbox image', 'sde-python': 'Python sandbox image', 'nexus-fwd': 'Dev deployment forwarder image'
});

/** "Prepare image (≈ 0.6 GB)" when an approval stated the size, else "Prepare image". */
export function prepareLabel(estimatedBytes: number | null | undefined, again = false): string {
  const base = again ? 'Prepare image again' : 'Prepare image';
  return typeof estimatedBytes === 'number' && Number.isFinite(estimatedBytes) && estimatedBytes > 0 ? `${base} (≈ ${gb(estimatedBytes)})` : base;
}

/** The GPU line: always said, never offered. */
export function gpuLine(g: HealthView['gpu']): string {
  if (!g.detected) return 'No GPU detected';
  return g.model ? `GPU detected (${g.model}), not supported in this release` : 'GPU detected, not supported in this release';
}

export function diskLine(d: HealthView['disk']): string {
  const need = `preparing images and the execution checks need ${gb(d.requiredBytes)} (${gb(d.recommendedBytes)} recommended)`;
  return d.dataHomeFreeBytes === null ? `Free disk could not be measured; ${need}` : `Free disk is ${gb(d.dataHomeFreeBytes)}; ${need}`;
}

/**
 * The sheet's rows. `estimates` holds the size an image-preparation approval stated per profile (the only source of
 * that number); `pending` the profiles that already wait for an answer (their approval row is shown instead).
 */
export function setupSheet(h: HealthView, ctx: { estimates?: ReadonlyMap<string, number>; pending?: ReadonlySet<string>;
  /** The destinations the agent's permission covers, from #51 (shown on the permission row and nowhere else). */
  hosts?: readonly string[] | null } = {}): SetupRow[] {
  const rows: SetupRow[] = [];
  const d = h.docker;
  const dockerFacts = [d.version ? `version ${d.version}` : null, typeof d.cpus === 'number' ? `${d.cpus} CPUs` : null,
    typeof d.memoryBytes === 'number' ? `${gb(d.memoryBytes)} memory` : null, d.os ? d.os : null].filter((x) => x !== null).join(', ');
  if (d.state === 'running') rows.push(row('docker', 'Docker', 'ok', dockerFacts ? `Docker is running (${dockerFacts}).` : 'Docker is running.'));
  else if (d.state === 'stopped') rows.push(row('docker', 'Docker', 'problem', 'Docker is not running.', 'Start Docker Desktop, then check again.'));
  else if (d.state === 'missing') rows.push(row('docker', 'Docker', 'problem', 'Docker is not installed.', 'Install Docker Desktop, start it, then check again.'));
  else rows.push(row('docker', 'Docker', 'unknown', 'Docker has not been checked yet.', 'Check again in a moment.'));
  if (d.state === 'running') {
    if (typeof d.memoryBytes !== 'number' || d.memoryBytes < MIN_DOCKER_MEMORY) {
      rows.push(row('memory', 'Docker memory', 'problem', typeof d.memoryBytes === 'number'
        ? `Docker has ${gb(d.memoryBytes)} of memory; execution needs ${gb(MIN_DOCKER_MEMORY)}.` : `Docker memory could not be read; execution needs ${gb(MIN_DOCKER_MEMORY)}.`,
      'Give Docker more memory in Docker Desktop settings, then check again.'));
    } else rows.push(row('memory', 'Docker memory', 'ok', `Docker has ${gb(d.memoryBytes)} of memory; execution needs ${gb(MIN_DOCKER_MEMORY)}.`));
    if (typeof d.cpus !== 'number' || d.cpus < MIN_DOCKER_CPUS) {
      rows.push(row('cpus', 'Docker CPUs', 'problem', typeof d.cpus === 'number' ? `Docker has ${d.cpus} CPU; execution needs ${MIN_DOCKER_CPUS}.`
        : `Docker CPUs could not be read; execution needs ${MIN_DOCKER_CPUS}.`, 'Give Docker more CPUs in Docker Desktop settings, then check again.'));
    } else rows.push(row('cpus', 'Docker CPUs', 'ok', `Docker has ${d.cpus} CPUs; execution needs ${MIN_DOCKER_CPUS}.`));
  }
  const disk = h.disk;
  const FREE_UP = 'Free up space on the drive that holds the app data (Nexus deletes nothing itself), then check again.';
  if (disk.dataHomeFreeBytes === null) {
    rows.push(row('disk', 'Free disk', 'unknown', diskLine(disk), FREE_UP));
  } else if (diskBelowFloor(disk)) {
    rows.push(row('disk', 'Free disk', 'problem', `${diskLine(disk)}; below ${gb(disk.leaseFloorBytes)} no job starts`, FREE_UP));
  } else if (disk.gate === 'below_required') {
    // Ruled (final review C2): an advisory, not a blocker. Jobs run; only image preparation and the execution checks wait.
    rows.push({ ...row('disk', 'Free disk', 'advisory', diskLine(disk),
      `Jobs can run while there is room for their output. ${FREE_UP.replace(', then check again.', ' to prepare images.')}`),
    word: 'Jobs run; images cannot be prepared' });
  } else if (disk.gate === 'below_recommended') {
    rows.push(row('disk', 'Free disk', 'advisory', diskLine(disk), 'Jobs can run. Freeing more space keeps large builds from waiting.'));
  } else rows.push(row('disk', 'Free disk', 'ok', diskLine(disk)));
  // An image can be prepared only while Docker runs and the disk passes the gate (main refuses it otherwise).
  const canPrepare = d.state === 'running' && disk.gate !== 'below_required' && disk.dataHomeFreeBytes !== null;
  for (const img of h.images) {
    const label = PROFILE_LABEL[img.profile] ?? `Sandbox image ${img.profile}`;
    if (img.present && img.matches) {
      const facts = [img.imageIdShort ?? null, typeof img.sizeBytes === 'number' ? sizeLabel(img.sizeBytes) : null].filter((x) => x !== null).join(', ');
      rows.push(row(`image:${img.profile}`, label, 'ok', facts ? `Prepared (${facts}).` : 'Prepared.'));
      continue;
    }
    const again = img.present && !img.matches;
    const text = again ? 'Prepared, but it does not match the pinned version.' : 'Not prepared yet.';
    if (ctx.pending?.has(img.profile)) {
      rows.push(row(`image:${img.profile}`, label, 'problem', text, 'Waiting for your answer below.'));
    } else if (canPrepare) {
      rows.push(row(`image:${img.profile}`, label, 'problem', text, 'Preparing downloads its pinned base once, after you approve it.',
        { profile: img.profile, label: prepareLabel(ctx.estimates?.get(img.profile), again) }));
    } else {
      rows.push(row(`image:${img.profile}`, label, 'problem', text, d.state !== 'running'
        ? 'It can be prepared once Docker is running.'
        : disk.dataHomeFreeBytes === null ? 'It can be prepared once free disk has been measured.'
          : `It can be prepared once the disk has ${gb(disk.requiredBytes)} free.`));
    }
  }
  // HealthView has no git field: git is shown only when main reported it missing (never claimed as ready).
  if ((h.problems ?? []).includes('git_missing')) rows.push(row('git', 'Git', 'problem', 'Git is not installed.', 'Install Git, then restart the app.'));
  rows.push(h.runner.attached
    ? row('runner', 'Execution runner', 'ok', h.runner.restarts > 0 ? `Running (restarted ${h.runner.restarts} times).` : 'Running.')
    : row('runner', 'Execution runner', 'problem', 'Not running.', 'Restart the app; the runner starts with it.'));
  if (h.agent) rows.push(...agentSetupRows(h.agent, { hosts: ctx.hosts ?? null }));
  rows.push(row('gpu', 'GPU', 'ok', gpuLine(h.gpu)));
  // The GPU line is a fact, not a requirement: it is never a problem and never offered.
  rows[rows.length - 1].word = h.gpu.detected ? 'Not used' : 'Not needed';
  return rows;
}

// ---------- the agent's rows (B2b) ----------
// The adapter's own label and the destinations of the permission are shown HERE and nowhere else in the renderer: every other
// agent view says "the agent" and "your network permission".

/** Said once, on the permission row: what the installed agent program keeps, what Nexus never touches, and what is policy. */
export const AGENT_STATE_DISCLOSURE = 'The installed agent program keeps its own state files (its sign-in, settings and log files) in your own user folder. '
  + 'Nexus never reads, copies or stores the sign-in, and the agent can reach only the destination you grant here. '
  + 'The agent runs in a sandbox with no other network; which files it may touch is a rule of the agent program, not an operating-system wall.';

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

const capsText = (c: { turnUsdCents: number; dayUsdCents: number; turnsPerHour: number; concurrentTurns: number; toolCalls: number }): string =>
  `up to ${dollars(c.turnUsdCents)} per turn and ${dollars(c.dayUsdCents)} per day, ${c.turnsPerHour} turns an hour, ${c.concurrentTurns} at a time, ${c.toolCalls} tool calls per turn`;
const dollars = (cents: number): string => `$${Math.floor(cents / 100)}.${String(Math.round(cents) % 100).padStart(2, '0')}`;

/** The agent's setup rows: the program (its label from the adapter), the network permission, and today's usage. */
export function agentSetupRows(a: AgentSetupView, o: { hosts?: readonly string[] | null; fmt?: (t: number) => string } = {}): SetupRow[] {
  const fmt = o.fmt ?? ((t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const rows: SetupRow[] = [];
  const label = a.label ?? 'Agent';
  switch (a.state) {
    case 'ready':
      rows.push(row('agent', label, 'ok', `The agent program is installed and signed in${a.version ? ` (version ${a.version})` : ''}.`)); break;
    case 'not_installed':
      rows.push(row('agent', label, 'problem', 'The agent program is not installed on this computer.', 'Install it, then check again.')); break;
    case 'not_signed_in':
      rows.push(row('agent', label, 'problem', 'The agent program is not signed in. Sign in with it, then check again in Setup.', 'Nexus never signs in for you.')); break;
    case 'version_unsupported':
      rows.push(row('agent', label, 'problem', `The installed agent program is not a version Nexus supports${a.version ? ` (version ${a.version})` : ''}.`,
        'Install a supported version, then check again.')); break;
    case 'unavailable':
      rows.push(row('agent', label, 'unknown', 'The agent could not be checked. Open Setup and check again.', 'Check again in a moment.')); break;
    default:
      rows.push(row('agent', label, 'unknown', 'The agent has not been checked on this computer yet.', 'Check again in a moment.'));
  }
  const hosts = o.hosts && o.hosts.length > 0 ? o.hosts : null;
  const dest = hosts ? `only ${hosts.join(', ')}` : a.consent.hostsCount === 1 ? 'one network destination' : `${a.consent.hostsCount} network destinations`;
  if (a.consent.live) {
    const c = a.consent.caps;
    const caps = c ? ` Limits: ${capsText(c)}.` : '';
    const when = a.consent.grantedAt !== null ? ` at ${fmt(a.consent.grantedAt)}` : '';
    rows.push({ ...row('agent-consent', 'Agent network permission', 'ok', `Granted${when}. The agent may reach ${dest}, and nothing else.${caps}`, AGENT_STATE_DISCLOSURE),
      consent: { op: 'revoke', label: 'Revoke permission' } });
  } else if (a.state === 'ready' && hosts) {
    rows.push({ ...row('agent-consent', 'Agent network permission', 'problem', `Not granted. Granting lets the agent reach ${dest}, and nothing else. Agent turns need it. Limits if you grant it: ${capsText(AGENT_DEFAULTS)}.`, AGENT_STATE_DISCLOSURE),
      consent: { op: 'grant', label: 'Grant permission' } });
  } else if (a.state === 'ready') {
    rows.push(row('agent-consent', 'Agent network permission', 'problem', 'Not granted. The destination to grant is shown here once Nexus has read it from the agent program.',
      `${AGENT_STATE_DISCLOSURE} Check again to read it.`));
  } else {
    rows.push(row('agent-consent', 'Agent network permission', 'problem', 'Not granted. It can be granted once the agent program is ready.', AGENT_STATE_DISCLOSURE));
  }
  const u = a.usageToday;
  const usage = u.turns === 0 && u.usdCents === 0 ? 'No agent turn has started today.'
    : `${u.turns} ${u.turns === 1 ? 'turn' : 'turns'} started, cost ${u.estimated ? `about ${dollars(u.usdCents)} (estimated by Nexus: the runtime did not report one)`
      : `${dollars(u.usdCents)} (reported by the agent runtime)`}.`;
  rows.push(row('agent-usage', 'Agent use today', 'ok', usage));
  rows[rows.length - 1].word = 'Today';
  return rows;
}

/** The sheet's lead line: "Jobs can run" only when execution is ready AND every row is fine. */
export function setupLead(a: ExecAvailability, rows: readonly SetupRow[]): string | null {
  if (a.kind === 'setup') return 'Jobs run only once every row below is ready. Nothing here is changed for you.';
  // The agent's rows (B2b) are about agent turns, not about whether jobs can run: they never hold this line back.
  const jobRows = rows.filter((r) => !r.id.startsWith('agent'));
  if (a.kind === 'ready' && jobRows.length > 0 && jobRows.every((r) => r.state === 'ok' || r.state === 'advisory')) return 'Jobs can run on this computer.';
  if (a.kind === 'unknown' && a.checking) return NOT_CHECKED;
  return null;
}

/** "Checked at 14:05", or that it was never checked. */
export function checkedLine(checkedAt: number | null, fmt: (t: number) => string = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })): string {
  return checkedAt === null ? 'This computer has not been checked yet.' : `Checked at ${fmt(checkedAt)}.`;
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
