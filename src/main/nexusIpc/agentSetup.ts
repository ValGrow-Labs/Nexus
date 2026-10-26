/**
 * The agent setup row (`AgentSetupView`) as #23 (health) and #51 (consent) show it, built from main's own records: the runtime
 * health cache (the runner's probe), the live consent and today's usage. Never waits on the runner or the engine.
 *
 * What it never holds: the hosts (only how many the permission grants: they belong to the setup sheet's consent row, F24), a
 * model id, a credential, a path or a principal. The engine's display name (`label`) is the adapter's own and is shown on the
 * setup row only. A cached health older than its TTL reads as unknown.
 */
import type { AgentSetupState, AgentSetupView } from '../../shared/nexus/ipc';
import type { NexusPlatform } from '../nexus/platform';
import { scrubMessage } from './envelope';
import { UNKNOWN_AGENT } from './dto';

const STATE_OF: Record<string, AgentSetupState> = {
  not_installed: 'not_installed', not_authenticated: 'not_signed_in', version_unsupported: 'version_unsupported', error: 'unavailable'
};

export function agentSetupView(nx: NexusPlatform): AgentSetupView {
  if (!nx.agentsAvailable || !nx.budget) {
    return { ...UNKNOWN_AGENT, state: 'unavailable', consent: { live: false, caps: null, hostsCount: 0, grantedAt: null }, usageToday: { usdCents: 0, turns: 0, estimated: false } };
  }
  const entry = nx.agentProbe?.cache.fresh() ?? null;
  const live = nx.budget.live();
  const usage = nx.budget.usageToday();
  const state: AgentSetupState = !entry ? 'unknown' : entry.health.ok ? 'ready' : (STATE_OF[entry.health.reason] ?? 'unavailable');
  const caps = live ? { turnUsdCents: live.caps.turnUsdCents, dayUsdCents: live.caps.dayUsdCents, turnsPerHour: live.caps.turnsPerHour,
    concurrentTurns: live.caps.concurrentTurns, turnTokens: live.caps.turnTokens, toolCalls: live.caps.toolCalls, wallClockMs: live.caps.wallClockMs,
    childJobs: live.caps.childJobs } : null;
  return {
    state,
    label: entry?.setup ? scrubMessage(entry.setup.label).slice(0, 64) : null,
    version: entry && entry.health.ok ? scrubMessage(entry.health.version).slice(0, 40) : null,
    signedIn: entry?.setup?.signedIn ?? 'unknown',
    flagsOk: entry?.setup ? entry.setup.flagsOk : null,
    consent: { live: live !== null, caps, hostsCount: live ? live.hosts.length : 0, grantedAt: live ? live.grantedAt : null },
    usageToday: { usdCents: usage.usdCents, turns: usage.turns, estimated: usage.estimated }
  };
}
