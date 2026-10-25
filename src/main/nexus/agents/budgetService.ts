/**
 * The agent runtime's consent and its spend and rate guards (B2b, D-B2 and D-B4).
 *
 * - Consent. `grant(user, { runtimeKind, hosts, caps })` records the user's once-only network permission for the agent
 *   runtime, with its caps. Only a stored user who owns the platform may (`agent.consent`); the system and agents never
 *   consent. The hosts are what the runtime's own probe reports (`describe().egressHosts`), never what the renderer
 *   sends: the caller passes them from the probe cache. The caps go through `clampCaps`, so a grant can only lower the
 *   D-B4 ceilings (the v10 CHECKs refuse anything above them as well). One consent is live at a time: a grant while one
 *   is live is a `conflict` (revoke first). The grant is immutable and its revocation is recorded once.
 * - The hosts' record is the rule the runner's allow-list proxy binds to (hostEgressProxy canonicalHostsJson /
 *   hostsSha256): `hosts_json` is the JSON array of `host:port` strings, lowercased, de-duplicated and sorted, and
 *   `hosts_sha256` the sha256 hex of that UTF-8 text. Any other rule makes every turn fail `consent_mismatch`.
 * - Usage. `usageToday()` sums `job_attempts.usage_json` of `agent.run` attempts created since local midnight. Cost is
 *   what the runtime reported (US cents); an attempt that ended without a reported cost is charged at the turn cap and
 *   flagged `estimated` (a live attempt counts what it reported so far). Nothing the renderer says is ever read.
 * - Guards. `startGuard(projectId)` answers `consent_missing`, then (budgetDecision) `budget_exhausted`, `rate_limited`
 *   or `busy`; `dayRemainingCents()` is the day cap minus today's usage, never below 0.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Principal } from '../../../shared/nexus/platform';
import { AGENT_DEFAULTS, budgetDecision, clampCaps, dayRemainingCents, type AgentCaps } from '../../../shared/nexus/agentPolicy';
import type { AuthService } from '../auth/authService';
import { PrincipalResolver, requireStoredUser } from '../auth/principals';
import { appendActivityRow } from '../activity/writer';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';

const PLATFORM = { type: 'platform' } as const;
const HOUR_MS = 60 * 60_000;
const LIVE_JOB_STATES = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;

export interface EgressHost { host: string; port: number }

/**
 * The consent's host record: the JSON array of `host:port` strings, lowercased, de-duplicated and sorted. The same
 * rule as the runner's allow-list proxy (canonicalHostsJson); refuses a host or port that is not one.
 */
export function canonicalHostsJson(hosts: readonly EgressHost[]): string {
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > 16) throw new PlatformError('invalid', 'hosts must be a non-empty list');
  const set = new Set<string>();
  for (const h of hosts) {
    const host = typeof h?.host === 'string' ? h.host.toLowerCase() : '';
    if (host.length > 253 || !HOST_RE.test(host)) throw new PlatformError('invalid', 'a host is a DNS name');
    if (!Number.isSafeInteger(h.port) || h.port < 1 || h.port > 65535) throw new PlatformError('invalid', 'a port is 1..65535');
    set.add(`${host}:${h.port}`);
  }
  return JSON.stringify([...set].sort());
}

/** The sha256 hex of the canonical host record's UTF-8 text. */
export function hostsSha256(hosts: readonly EgressHost[]): string {
  return createHash('sha256').update(canonicalHostsJson(hosts), 'utf8').digest('hex');
}

export interface LiveConsent {
  id: string; runtimeKind: string; hosts: string[]; hostsSha256: string; caps: AgentCaps; grantedBy: string; grantedAt: number;
}
export interface UsageToday { usdCents: number; turns: number; estimated: boolean }
export type StartGuardReason = 'consent_missing' | 'budget_exhausted' | 'rate_limited' | 'busy';
export type StartGuard =
  | { ok: true; caps: AgentCaps; dayRemainingUsdCents: number; turnBudgetUsdCents: number }
  | { ok: false; reason: StartGuardReason; dayRemainingUsdCents: number };

interface ConsentRow {
  id: string; runtime_kind: string; hosts_json: string; hosts_sha256: string; turn_usd_cents: number; day_usd_cents: number;
  turns_per_hour: number; concurrent_turns: number; turn_tokens: number; tool_calls: number; granted_by: string; granted_at: number;
}

/** The start of the local day that holds `now` (ms). */
export function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class BudgetService {
  private readonly principals: PrincipalResolver;

  constructor(private readonly db: Database.Database, private readonly deps: { auth: AuthService; now: () => number }) {
    this.principals = new PrincipalResolver(db);
  }

  grant(user: Principal, i: { runtimeKind: string; hosts: EgressHost[]; caps?: Partial<Record<keyof AgentCaps, unknown>> | null }): LiveConsent {
    this.requireConsenter(user);
    if (!i || typeof i !== 'object') throw new PlatformError('invalid', 'input must be an object');
    if (typeof i.runtimeKind !== 'string' || !/^[a-z][a-z0-9_.-]{0,31}$/.test(i.runtimeKind)) throw new PlatformError('invalid', 'runtimeKind is a runtime kind');
    const hostsJson = canonicalHostsJson(i.hosts);
    const sha = createHash('sha256').update(hostsJson, 'utf8').digest('hex');
    let caps: AgentCaps;
    try { caps = clampCaps(i.caps ?? null); } catch (e) {
      // A requested cap below 1 is refused, never stored (the v10 CHECKs require 1 or more).
      const field = (e as { field?: unknown })?.field;
      throw new PlatformError('invalid', 'a cap must be at least 1', { field: typeof field === 'string' ? field : 'caps' });
    }
    // The turn cap never exceeds the day cap (the table requires it); concurrency is one turn (D-B4).
    caps.turnUsdCents = Math.min(caps.turnUsdCents, caps.dayUsdCents);
    for (const k of ['turnUsdCents', 'dayUsdCents', 'turnsPerHour', 'concurrentTurns', 'turnTokens', 'toolCalls'] as const) {
      if (caps[k] < 1) throw new PlatformError('invalid', `${k} must be at least 1`, { field: k });
    }
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      if (this.liveRow()) throw new PlatformError('conflict', 'a consent is already live; revoke it first', { reason: 'consent_live' });
      const id = newId(now);
      this.db.prepare(`INSERT INTO runtime_consents (id, runtime_kind, hosts_json, hosts_sha256, turn_usd_cents, day_usd_cents, turns_per_hour,
          concurrent_turns, turn_tokens, tool_calls, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, i.runtimeKind, hostsJson, sha, caps.turnUsdCents, caps.dayUsdCents, caps.turnsPerHour, caps.concurrentTurns,
          caps.turnTokens, caps.toolCalls, user.id, now);
      appendActivityRow(this.db, { actorKind: 'user', actorId: user.id, onBehalfOf: user.id, entityType: 'runtime_consent', entityId: id,
        action: 'agent.consent', status: 'succeeded', details: { op: 'grant', runtimeKind: i.runtimeKind, hostsCount: JSON.parse(hostsJson).length,
          turnUsdCents: caps.turnUsdCents, dayUsdCents: caps.dayUsdCents, turnsPerHour: caps.turnsPerHour, turnTokens: caps.turnTokens,
          toolCalls: caps.toolCalls } }, now);
      return this.toLive(this.liveRow()!);
    });
  }

  /** Revokes the live consent, once. Returns false when none is live. */
  revoke(user: Principal): boolean {
    this.requireConsenter(user);
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const live = this.liveRow();
      if (!live) return false;
      this.db.prepare('UPDATE runtime_consents SET revoked_at = MAX(?, granted_at), revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(now, user.id, live.id);
      appendActivityRow(this.db, { actorKind: 'user', actorId: user.id, onBehalfOf: user.id, entityType: 'runtime_consent', entityId: live.id,
        action: 'agent.consent', status: 'succeeded', details: { op: 'revoke', runtimeKind: live.runtime_kind } }, now);
      return true;
    });
  }

  /** The live consent (hosts included: for the setup sheet's consent row and the proxy's binding only), or null. */
  live(): LiveConsent | null {
    const r = this.liveRow();
    return r ? this.toLive(r) : null;
  }

  /** The caps in force: the live consent's, else the D-B4 ceilings. */
  caps(): AgentCaps {
    return this.live()?.caps ?? { ...AGENT_DEFAULTS };
  }

  /** Today's agent usage, from recorded attempts only (see the file header). */
  usageToday(): UsageToday {
    const now = this.deps.now();
    const turnCap = this.caps().turnUsdCents;
    const rows = this.db.prepare(`SELECT a.state, a.usage_json FROM job_attempts a JOIN jobs j ON j.id = a.job_id
      WHERE j.kind = 'agent.run' AND a.created_at >= ? AND a.created_at <= ?`).all(localMidnight(now), now) as { state: string; usage_json: string | null }[];
    let usdCents = 0; let estimated = false;
    for (const r of rows) {
      const u = parseUsage(r.usage_json);
      const live = r.state === 'starting' || r.state === 'running';
      if (u.cost !== null) { usdCents += u.cost; if (u.estimated) estimated = true; }
      else if (!live) { usdCents += turnCap; estimated = true; }
    }
    return { usdCents, turns: rows.length, estimated };
  }

  dayRemainingCents(): number {
    return dayRemainingCents(this.usageToday().usdCents, this.caps());
  }

  /**
   * Whether a turn may start now. `excludeJobId` leaves the turn being leased out of the live and hourly counts (the
   * scheduler's own check of a queued turn).
   */
  startGuard(projectId: string, o?: { excludeJobId?: string }): StartGuard {
    if (typeof projectId !== 'string' || projectId.length === 0) throw new PlatformError('invalid', 'projectId is required');
    const consent = this.live();
    const usage = this.usageToday();
    if (!consent) return { ok: false, reason: 'consent_missing', dayRemainingUsdCents: dayRemainingCents(usage.usdCents, AGENT_DEFAULTS) };
    const now = this.deps.now();
    const ex = o?.excludeJobId ?? '';
    // A turn started in the last hour: an agent.run job created then, except one that ended without ever running.
    const turnsLastHour = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'agent.run' AND created_at > ? AND id <> ?
      AND NOT (attempts = 0 AND state NOT IN (${LIVE_JOB_STATES.map(() => '?').join(', ')}))`)
      .get(now - HOUR_MS, ex, ...LIVE_JOB_STATES) as { n: number }).n;
    const liveTurns = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'agent.run' AND id <> ?
      AND state IN (${LIVE_JOB_STATES.map(() => '?').join(', ')})`).get(ex, ...LIVE_JOB_STATES) as { n: number }).n;
    const d = budgetDecision({ usage: { turnUsdCents: 0, dayUsdCents: usage.usdCents, turnsLastHour, liveTurns }, caps: consent.caps });
    return d.ok ? { ok: true, caps: consent.caps, dayRemainingUsdCents: d.dayRemainingUsdCents, turnBudgetUsdCents: d.turnBudgetUsdCents }
      : { ok: false, reason: d.reason, dayRemainingUsdCents: d.dayRemainingUsdCents };
  }

  // ---------- helpers ----------

  private requireConsenter(user: Principal): void {
    requireStoredUser(this.principals, this.deps.auth, user, 'agent.consent', 'runtime_consent', 'only you can grant or revoke the agent\'s network permission');
    this.deps.auth.require(user, 'agent.consent', PLATFORM, { entityType: 'runtime_consent' });
  }

  private liveRow(): ConsentRow | null {
    return (this.db.prepare('SELECT * FROM runtime_consents WHERE revoked_at IS NULL').get() as ConsentRow | undefined) ?? null;
  }

  private toLive(r: ConsentRow): LiveConsent {
    return {
      id: r.id, runtimeKind: r.runtime_kind, hosts: JSON.parse(r.hosts_json) as string[], hostsSha256: r.hosts_sha256, grantedBy: r.granted_by,
      grantedAt: r.granted_at,
      caps: { turnUsdCents: r.turn_usd_cents, dayUsdCents: r.day_usd_cents, turnsPerHour: r.turns_per_hour, concurrentTurns: r.concurrent_turns,
        turnTokens: r.turn_tokens, toolCalls: r.tool_calls, wallClockMs: AGENT_DEFAULTS.wallClockMs, childJobs: AGENT_DEFAULTS.childJobs }
    };
  }
}

/** A recorded usage: its reported cost (non-negative integer cents) or null, and whether the runtime called it an estimate. */
function parseUsage(text: string | null): { cost: number | null; estimated: boolean } {
  if (typeof text !== 'string') return { cost: null, estimated: false };
  try {
    const u = JSON.parse(text) as { costUsdCents?: unknown; estimated?: unknown };
    const c = u?.costUsdCents;
    return { cost: typeof c === 'number' && Number.isFinite(c) && c >= 0 ? Math.ceil(c) : null, estimated: u?.estimated === true };
  } catch {
    return { cost: null, estimated: false };
  }
}
