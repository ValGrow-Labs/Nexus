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

/** The longest a cached health stays usable (the runner probes every minute; five minutes of silence is a dead runner). */
export const RUNTIME_HEALTH_TTL_MS = 5 * 60_000;

export interface RuntimeCacheEntry { kind: string; health: RuntimeHealth; setup: RuntimeSetup | null; at: number }
/** What AgentService's provider returns: the health of the runtime plus the hosts its adapter reported. */
export interface RuntimeHealthEntryOut {
  kind: string; health: RuntimeHealth; flagsSha256: string | null;
  egressHosts?: { host: string; port: number }[];
}

export class RuntimeHealthCache {
  private entry: RuntimeCacheEntry | null = null;
  /** When a probe result was last recorded (even one that reported no runtime), for `whenRecorded`. */
  private lastRecordedAt: number | null = null;
  private waiters: { since: number; resolve: (ok: boolean) => void; timer: unknown }[] = [];
  constructor(private readonly deps: { now: () => number; ttlMs?: number }) {}

  /** Records a probe's runtimes (the first one is THE agent runtime); an empty list records nothing known. */
  record(runtimes: readonly { kind: string; health: RuntimeHealth; setup?: RuntimeSetup }[]): void {
    const r = runtimes[0];
    const at = this.deps.now();
    this.entry = r ? { kind: r.kind, health: r.health, setup: r.setup ?? null, at } : null;
    this.lastRecordedAt = at;
    for (const w of [...this.waiters]) if (at >= w.since) this.settle(w, true);
  }

  clear(): void { this.entry = null; }

  private ttl(): number { return this.deps.ttlMs ?? RUNTIME_HEALTH_TTL_MS; }

  /** The entry while it is fresh; null when none was recorded or it is older than the TTL (or its clock moved back). */
  fresh(): RuntimeCacheEntry | null {
    const e = this.entry;
    if (!e) return null;
    const age = this.deps.now() - e.at;
    return age >= 0 && age < this.ttl() ? e : null;
  }

  /** True when no fresh entry exists (a start should ask for a refresh first). */
  isStale(): boolean { return this.fresh() === null; }

  /** The gate's view: the health and the adapter's hosts, only while fresh. */
  healthEntry(): RuntimeHealthEntryOut | null {
    const e = this.fresh();
    if (!e) return null;
    return { kind: e.kind, health: e.health, flagsSha256: null, ...(e.setup ? { egressHosts: e.setup.egressHosts.map((h) => ({ host: h.host, port: h.port })) } : {}) };
  }

  /** The hosts the adapter reported, while fresh; null otherwise. Used for a consent grant, never shown. */
  egressHosts(): { host: string; port: number }[] | null {
    const e = this.fresh();
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
