/**
 * The agent setup row (`AgentSetupView`) as #23 (health) and #51 (consent) show it, built from main's own records: the runtime
 * health cache (the runner's probe), the live consent and today's usage. Never waits on the runner or the engine.
 *
 * What it never holds: the hosts (only how many the permission grants: they belong to the setup sheet's consent row, F24), a
 * model id, a credential, a path or a principal. The engine's display name (`label`) is the adapter's own and is shown on the
 * setup row only. A cached health older than its TTL reads as unknown.
 */
import type { AgentConsentView, AgentRuntimeOptionView, AgentRuntimeProblem, AgentSetupState, AgentSetupView } from '../../shared/nexus/ipc';
import { LOCAL_MODEL_KIND, type LocalModelReason } from '../../shared/nexus/localModel';
import type { NexusPlatform } from '../nexus/platform';
import type { RuntimeCacheEntry } from '../nexus/agents/runtimeHealth';
import { scrubMessage } from './envelope';
import { UNKNOWN_AGENT } from './dto';

const STATE_OF: Record<string, AgentSetupState> = {
  not_installed: 'not_installed', not_authenticated: 'not_signed_in', version_unsupported: 'version_unsupported', error: 'unavailable'
};
const PROBLEM_OF: Record<LocalModelReason, AgentRuntimeProblem | null> = {
  local_model_not_chosen: 'model_not_chosen', local_model_endpoint: 'address_not_local', local_model_missing: 'model_missing',
  local_model_no_tools: 'model_no_tools', local_model_server_down: null
};
const stateOf = (e: RuntimeCacheEntry): AgentSetupState => (e.health.ok ? 'ready' : (STATE_OF[e.health.reason] ?? 'unavailable'));

/** One runtime of the probe, as the picker lists it. The model list and its problem are only for the runtime that serves models. */
function optionOf(nx: NexusPlatform, e: RuntimeCacheEntry, live: { runtimeKind: string } | null): AgentRuntimeOptionView {
  const base: AgentRuntimeOptionView = { kind: e.kind, label: e.setup ? scrubMessage(e.setup.label).slice(0, 64) : null,
    version: e.health.ok ? scrubMessage(e.health.version).slice(0, 40) : null, state: stateOf(e), signedIn: e.setup?.signedIn ?? 'unknown',
    selected: live !== null && live.runtimeKind === e.kind, models: null, model: null, problem: null,
    hosts: (e.setup?.egressHosts ?? []).slice(0, 8).map((h) => scrubMessage(`${h.host}:${h.port}`).slice(0, 260)) };
  if (e.kind !== LOCAL_MODEL_KIND || !nx.agents) return base;
  const models = (e.setup?.models ?? []).slice(0, 64).map((m) => ({ name: scrubMessage(m.name).slice(0, 128), tools: m.tools === true }));
  // The chosen model only counts for the runtime the live permission names; any other row shows the settings' default.
  const st = nx.agents.localModelState((e.setup?.egressHosts ?? []).map((h) => ({ host: h.host, port: h.port })), e.setup?.models);
  // The adapter reports `version_unsupported` when the server has no model that can use tools (the chosen one, or any): that is the
  // "cannot use tools" problem, not an unsupported program version.
  const noTools = !e.health.ok && e.health.reason === 'version_unsupported';
  return { ...base, models, model: st.model, problem: noTools ? 'model_no_tools' : st.reason === null ? null : PROBLEM_OF[st.reason] };
}

/**
 * #51's view: the setup row plus the destinations, in the consent row only. The live consent's hosts, else the hosts the fresh
 * probe entry reported (what a grant would cover); none while the agents are off or nothing was probed. The only place a host
 * is ever put into a view.
 */
export function agentConsentView(nx: NexusPlatform): AgentConsentView {
  const base = agentSetupView(nx);
  let hosts: string[] = [];
  if (nx.agentsAvailable && nx.budget) {
    const live = nx.budget.live();
    const probed = nx.agentProbe?.cache.egressHosts() ?? null;
    hosts = live ? [...live.hosts] : (probed ?? []).map((h) => `${h.host}:${h.port}`);
  }
  const live = nx.agentsAvailable && nx.budget ? nx.budget.live() : null;
  const runtimes = nx.agentsAvailable && nx.budget && nx.agentProbe ? nx.agentProbe.cache.all().map((e) => optionOf(nx, e, live)) : [];
  return { ...base, consent: { ...base.consent, hosts: hosts.map((h) => scrubMessage(h).slice(0, 260)).slice(0, 16) },
    ...(runtimes.length > 1 || runtimes.some((r) => r.models !== null) ? { runtimes } : {}) };
}

/** Main's reason agent work is off (`agentsUnavailableReason`'s vocabulary, then execution's) as the view's four words. */
export function offReasonOf(reason: string | null | undefined): NonNullable<AgentSetupView['offReason']> {
  if (reason === undefined || reason === null || reason === 'not_enabled') return 'build';
  if (reason === 'held' || reason === 'auto_held' || reason === 'backup_failed') return 'held';
  if (reason === 'failed' || reason === 'shape') return 'database';
  return 'execution';
}

/** `offReason`: main's reason for agent work being off (only read when it is off). */
export function agentSetupView(nx: NexusPlatform, offReason?: string | null): AgentSetupView {
  if (!nx.agentsAvailable || !nx.budget) {
    return { ...UNKNOWN_AGENT, state: 'off', offReason: offReasonOf(offReason), consent: { live: false, caps: null, hostsCount: 0, grantedAt: null }, usageToday: { usdCents: 0, turns: 0, estimated: false } };
  }
  const live = nx.budget.live();
  // The row is about the live permission's runtime (the default one when none): its own cache entry, else the default entry.
  const entry = (live ? nx.agentProbe?.cache.fresh(live.runtimeKind) ?? null : null) ?? nx.agentProbe?.cache.fresh() ?? null;
  const usage = nx.budget.usageToday();
  const state: AgentSetupState = !entry ? 'unknown' : entry.health.ok ? 'ready' : (STATE_OF[entry.health.reason] ?? 'unavailable');
  const caps = live ? { turnUsdCents: live.caps.turnUsdCents, dayUsdCents: live.caps.dayUsdCents, turnsPerHour: live.caps.turnsPerHour,
    concurrentTurns: live.caps.concurrentTurns, turnTokens: live.caps.turnTokens, toolCalls: live.caps.toolCalls, wallClockMs: live.caps.wallClockMs,
    childJobs: live.caps.childJobs } : null;
  const optionRow = entry && entry.kind === LOCAL_MODEL_KIND ? optionOf(nx, entry, live) : null;
  return {
    state,
    // Only the local-model runtime's row says which runtime it is about, and why its chosen model cannot be used (every other row is as before).
    ...(optionRow ? { kind: LOCAL_MODEL_KIND, ...(optionRow.problem !== null ? { problem: optionRow.problem } : {}) } : {}),
    label: entry?.setup ? scrubMessage(entry.setup.label).slice(0, 64) : null,
    version: entry && entry.health.ok ? scrubMessage(entry.health.version).slice(0, 40) : null,
    signedIn: entry?.setup?.signedIn ?? 'unknown',
    flagsOk: entry?.setup ? entry.setup.flagsOk : null,
    consent: { live: live !== null, caps, hostsCount: live ? live.hosts.length : 0, grantedAt: live ? live.grantedAt : null },
    usageToday: { usdCents: usage.usdCents, turns: usage.turns, estimated: usage.estimated }
  };
}
