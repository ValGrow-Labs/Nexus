// Agent spend and rate policy (B2b): the ceilings the user approved (D-B4), the
// clamp every grant goes through, and the start decision. Cost is in US cents
// and is what the agent runtime reported (an estimate); a turn whose cost was
// never reported is charged at the turn cap and flagged `estimated`. Pure; no I/O.

import type { AgentUsage } from './runtime';
import { deepFreeze } from './freeze';

export interface AgentCaps {
  /** The most one turn may cost. */
  turnUsdCents: number;
  /** The most all turns may cost in one local day. */
  dayUsdCents: number;
  /** The most turns started in any 60 minutes. */
  turnsPerHour: number;
  /** The most turns live at once. */
  concurrentTurns: number;
  /** The most capped tokens (input + output + cache creation) one turn may use. */
  turnTokens: number;
  /** The most tool calls (MCP calls and the runtime's own tool calls) in one turn. */
  toolCalls: number;
  /** The longest one turn may run. */
  wallClockMs: number;
  /** The most child jobs one turn may request. */
  childJobs: number;
}

/** D-B4: $2 per turn, $10 per day, 6 turns per hour, 1 concurrent turn, 400k tokens, 200 tool calls, 30 minutes, 20 child jobs. */
export const AGENT_DEFAULTS: Readonly<AgentCaps> = deepFreeze({
  turnUsdCents: 200,
  dayUsdCents: 1000,
  turnsPerHour: 6,
  concurrentTurns: 1,
  turnTokens: 400_000,
  toolCalls: 200,
  wallClockMs: 30 * 60_000,
  childJobs: 20
});

export const AGENT_CAP_KEYS: readonly (keyof AgentCaps)[] = deepFreeze(Object.keys(AGENT_DEFAULTS) as (keyof AgentCaps)[]);

/** Thrown by clampCaps for a requested value below 1 (a cap of 0 or less is refused, never stored: the v10 CHECKs
 *  require 1 or more). `code` is `invalid`, like a refused request; `field` names the cap. */
export class CapsRefused extends RangeError {
  readonly code = 'invalid' as const;
  readonly field: keyof AgentCaps;
  constructor(field: keyof AgentCaps) {
    super(`${field} must be at least 1`);
    this.name = 'CapsRefused';
    this.field = field;
  }
}

/**
 * A grant's caps: each requested value when it is a safe integer of 1 or more, never above the ceiling; a missing or
 * malformed value (not a safe integer) takes the ceiling; a safe integer below 1 is refused (CapsRefused), never
 * stored. The turn cap is then lowered to the day cap when it is above it. Grants may only lower caps, and every
 * output satisfies the runtime_consents CHECK ranges of schema v10 (1..ceiling, turn <= day).
 */
export function clampCaps(requested: Partial<Record<keyof AgentCaps, unknown>> | null | undefined,
  defaults: Readonly<AgentCaps> = AGENT_DEFAULTS): AgentCaps {
  const out = {} as AgentCaps;
  for (const k of AGENT_CAP_KEYS) {
    const ceiling = defaults[k];
    const v = requested && typeof requested === 'object' ? (requested as Record<string, unknown>)[k] : undefined;
    if (typeof v === 'number' && Number.isSafeInteger(v) && v < 1) throw new CapsRefused(k);
    out[k] = typeof v === 'number' && Number.isSafeInteger(v) ? Math.min(v, ceiling) : ceiling;
  }
  out.turnUsdCents = Math.min(out.turnUsdCents, out.dayUsdCents);
  return out;
}

/** What has been used, as recorded by main (never what the renderer says). */
export interface UsageNow {
  /** The live turn's cost so far (0 before a start). */
  turnUsdCents: number;
  /** Today's cost: every agent attempt since local midnight, an unreported cost counted at the turn cap. */
  dayUsdCents: number;
  /** Turns started in the last 60 minutes. */
  turnsLastHour: number;
  /** Turns live now. */
  liveTurns: number;
}

export type BudgetDecision =
  | { ok: true; dayRemainingUsdCents: number; turnBudgetUsdCents: number }
  | { ok: false; reason: 'budget_exhausted' | 'rate_limited' | 'busy'; dayRemainingUsdCents: number };

/** The day cap minus today's usage, never below 0. */
export function dayRemainingCents(dayUsdCents: number, caps: Pick<AgentCaps, 'dayUsdCents'>): number {
  const used = Number.isFinite(dayUsdCents) && dayUsdCents > 0 ? dayUsdCents : 0;
  return Math.max(0, caps.dayUsdCents - used);
}

/**
 * Whether a turn may start (or continue) now. At a cap is refused, one below is allowed. In order: the spend caps
 * (`budget_exhausted`: the day cap reached, or the live turn at its own cap), the hourly rate (`rate_limited`), then
 * concurrency (`busy`). On success, the most this turn may still spend: min(turn cap - turn so far, day remaining).
 */
export function budgetDecision(i: { usage: UsageNow; caps: AgentCaps }): BudgetDecision {
  const { usage: u, caps } = i;
  const n = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);
  const dayRemainingUsdCents = dayRemainingCents(u.dayUsdCents, caps);
  if (dayRemainingUsdCents <= 0 || n(u.turnUsdCents) >= caps.turnUsdCents) return { ok: false, reason: 'budget_exhausted', dayRemainingUsdCents };
  if (n(u.turnsLastHour) >= caps.turnsPerHour) return { ok: false, reason: 'rate_limited', dayRemainingUsdCents };
  if (n(u.liveTurns) >= caps.concurrentTurns) return { ok: false, reason: 'busy', dayRemainingUsdCents };
  return { ok: true, dayRemainingUsdCents, turnBudgetUsdCents: Math.min(caps.turnUsdCents - n(u.turnUsdCents), dayRemainingUsdCents) };
}

/** The tokens a turn is capped on: input + output + cache creation. Cache reads are reported but not capped (F10). */
export function cappedTokens(u: Pick<AgentUsage, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens'>): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens;
}

/** The cost a turn is charged: what the runtime reported, or the turn cap when it reported none (then `estimated`). */
export function chargedCents(u: Pick<AgentUsage, 'costUsdCents'>, caps: Pick<AgentCaps, 'turnUsdCents'>): { usdCents: number; estimated: boolean } {
  return u.costUsdCents === null ? { usdCents: caps.turnUsdCents, estimated: true } : { usdCents: u.costUsdCents, estimated: false };
}

/** The first per-turn cap a usage report reaches, or null. Reaching a cap ends the turn (`failed: limit`). */
export function turnLimitReached(u: AgentUsage, caps: Pick<AgentCaps, 'turnTokens' | 'turnUsdCents' | 'toolCalls'>):
  'tokens' | 'usd' | 'tool_calls' | null {
  if (cappedTokens(u) >= caps.turnTokens) return 'tokens';
  if (u.costUsdCents !== null && u.costUsdCents >= caps.turnUsdCents) return 'usd';
  if (u.toolCalls >= caps.toolCalls) return 'tool_calls';
  return null;
}

/** Usage reports are monotonic within a turn: no counter goes down, and a reported cost never disappears. */
export function isMonotonicUsage(prev: AgentUsage | null, next: AgentUsage): boolean {
  if (prev === null) return true;
  const counters: (keyof AgentUsage)[] = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'toolCalls'];
  if (counters.some((k) => (next[k] as number) < (prev[k] as number))) return false;
  if (prev.costUsdCents !== null && (next.costUsdCents === null || next.costUsdCents < prev.costUsdCents)) return false;
  return true;
}
