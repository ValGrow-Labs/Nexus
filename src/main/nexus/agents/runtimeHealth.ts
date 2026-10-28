/**
 * The cached health of the agent runtime (B2b Task 14): what the runner's `probe.result.runtimes` last said, with its age.
 *
 * - It is a CACHE: nothing here waits on the runner or the engine. The platform records each `probe.result` into it (the
 *   runner probes every minute and on "Check again") and clears it when a runner attaches or says `ready` (a new runner is
 *   unknown until its own probe).
 * - It is bounded in AGE: an entry older than the TTL is treated as unknown by everything that gates on it (`healthEntry`,
 *   `egressHosts`, the setup row), so a stale `ok` can never pass a start. A refresh is asked for on setup open, on a
 *   consent change and before a start when the entry is stale (the callers use `AgentRuntimeProbe.refresh`/`whenFresh`).
 * - The hosts come from the adapter's own `describe()` as reported in its setup; the renderer never supplies them.
 * - The raw output of the engine's own status never gets here: the adapter reports `signedIn` as `yes|no|unknown`.
 */
import type { RuntimeSetup } from '../../../shared/nexus/runnerProtocol';
import type { RuntimeHealth } from '../../../shared/nexus/runtime';
import type { RuntimeModelInfo } from '../../../shared/nexus/localModel';

/** The longest a cached health stays usable (the runner probes every minute; five minutes of silence is a dead runner). */
export const RUNTIME_HEALTH_TTL_MS = 5 * 60_000;

export interface RuntimeCacheEntry { kind: string; health: RuntimeHealth; setup: RuntimeSetup | null; at: number }
/** What AgentService's provider returns: the health of the runtime plus the hosts its adapter reported. */
export interface RuntimeHealthEntryOut {
  kind: string; health: RuntimeHealth; flagsSha256: string | null;
  egressHosts?: { host: string; port: number }[];
  /** The models the runtime's probe listed (a runtime that offers a choice of models); absent otherwise. */
  models?: RuntimeModelInfo[];
}

/** The most runtimes one probe records (the runner reports one per adapter; a handful at most). */
export const RUNTIME_CACHE_MAX = 8;

export class RuntimeHealthCache {
  /** Every runtime the last probe reported, in the runner's order (the first is the default one), all recorded at the same time. */
  private entries: RuntimeCacheEntry[] = [];
  /** When a probe result was last recorded (even one that reported no runtime), for `whenRecorded`. */
  private lastRecordedAt: number | null = null;
  private waiters: { since: number; resolve: (ok: boolean) => void; timer: unknown }[] = [];
  constructor(private readonly deps: { now: () => number; ttlMs?: number }) {}

  /**
   * Records a probe's runtimes, one entry per kind (the first is the default agent runtime, what every caller that names no
   * kind reads); an empty list records nothing known.
   */
  record(runtimes: readonly { kind: string; health: RuntimeHealth; setup?: RuntimeSetup }[]): void {
    const at = this.deps.now();
    const seen = new Set<string>();
    this.entries = [];
    for (const r of runtimes) {
      if (seen.has(r.kind) || this.entries.length >= RUNTIME_CACHE_MAX) continue;
      seen.add(r.kind);
      this.entries.push({ kind: r.kind, health: r.health, setup: r.setup ?? null, at });
    }
    this.lastRecordedAt = at;
    for (const w of [...this.waiters]) if (at >= w.since) this.settle(w, true);
  }

  clear(): void { this.entries = []; }

  private ttl(): number { return this.deps.ttlMs ?? RUNTIME_HEALTH_TTL_MS; }

  /**
   * The entry while it is fresh; null when none was recorded or it is older than the TTL (or its clock moved back). With a `kind`,
   * that runtime's entry only (null when the probe did not report it); without, the first one (the default agent runtime).
   */
  fresh(kind?: string): RuntimeCacheEntry | null {
    const e = kind === undefined ? this.entries[0] : this.entries.find((x) => x.kind === kind);
    if (!e) return null;
    const age = this.deps.now() - e.at;
    return age >= 0 && age < this.ttl() ? e : null;
  }

  /** Every fresh entry, in the runner's order (empty when none was recorded or they are stale). */
  all(): RuntimeCacheEntry[] {
    const first = this.fresh();
    return first ? [...this.entries] : [];
  }

  /** True when no fresh entry exists (a start should ask for a refresh first). */
  isStale(): boolean { return this.fresh() === null; }

  /**
   * The gate's view: the health and the adapter's hosts, only while fresh. With a `kind` it is that runtime's entry, and, when the
   * probe did not report that kind, the default entry (so a permission for a kind the runner no longer reports reads as a mismatch).
   */
  healthEntry(kind?: string | null): RuntimeHealthEntryOut | null {
    const e = (typeof kind === 'string' ? this.fresh(kind) : null) ?? this.fresh();
    if (!e) return null;
    return { kind: e.kind, health: e.health, flagsSha256: null,
      ...(e.setup ? { egressHosts: e.setup.egressHosts.map((h) => ({ host: h.host, port: h.port })) } : {}),
      ...(e.setup?.models ? { models: e.setup.models.map((m) => ({ name: m.name, tools: m.tools })) } : {}) };
  }

  /** The hosts the adapter reported (the given runtime's, else the default one's), while fresh; null otherwise. Used for a consent grant. */
  egressHosts(kind?: string): { host: string; port: number }[] | null {
    const e = this.fresh(kind);
    return e?.setup ? e.setup.egressHosts.map((h) => ({ host: h.host, port: h.port })) : null;
  }

  /** Resolves true once a probe is recorded at or after `since` (a clock reading), false after `timeoutMs`. */
  whenRecorded(since: number, timeoutMs: number): Promise<boolean> {
    if (this.lastRecordedAt !== null && this.lastRecordedAt >= since) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const w = { since, resolve, timer: null as unknown };
      w.timer = setTimeout(() => this.settle(w, false), Math.max(1, timeoutMs));
      this.waiters.push(w);
    });
  }

  private settle(w: { resolve: (ok: boolean) => void; timer: unknown }, ok: boolean): void {
    this.waiters = this.waiters.filter((x) => x !== w);
    clearTimeout(w.timer as ReturnType<typeof setTimeout>);
    w.resolve(ok);
  }
}

/** What the platform exposes of the runtime probe (null unless agents are available). */
export interface AgentRuntimeProbe {
  cache: RuntimeHealthCache;
  /** Asks the runner for a fresh probe now (not rate limited; it carries the live consent's hash). False when it was not sent. */
  refresh(): boolean;
  /** `refresh`, then waits (at most `timeoutMs`) for the answer to be recorded; true when it was. Never throws. */
  refreshAndWait(timeoutMs: number): Promise<boolean>;
}
