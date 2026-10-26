/**
 * The agent runtime probe (B2b Task 14): what the runner reports in `probe.result.runtimes`.
 *
 * For each adapter it asks `describe()` for the hosts its process needs, starts a loopback proxy and runs the adapter's
 * `health` and `setup` THROUGH that proxy:
 * - before any consent exists the proxy is DENY-ALL (an empty allow list: every request is refused), so checking the
 *   engine can never reach the network;
 * - only after a live consent, and only when main's consent hash equals the hash of the adapter's own host list, the proxy
 *   is the allow-list proxy bound to that consent (the same rule a turn uses). Anything else stays deny-all.
 * The engine is never run when no proxy could be started. The raw output of the engine's own status never leaves the
 * adapter (it answers `yes|no|unknown`); the entries carry only the health, the display label, the flags verdict and
 * the hosts. The result is kept for a few seconds per consent state, so a burst of probes costs one engine run.
 *
 * Production passes its adapters from the runner entry; a RunnerCore built without `runtimeProbe` reports none (tests
 * therefore never run an engine unless they hand one in).
 */
import type { RuntimeSetup } from '../../shared/nexus/runnerProtocol';
import type { RuntimeHealth, RuntimeKind } from '../../shared/nexus/runtime';
import { hostsSha256, startHostEgressProxy, type HostEgressProxy } from '../hostEgressProxy';

/**
 * What the prober needs of an adapter. `check` answers health and setup from ONE look at the engine (one version run, one flag
 * run, one status run); an adapter without it is asked for `health` and `setup` separately.
 */
export interface RuntimeProbeAdapter {
  readonly kind: RuntimeKind;
  describe(): Promise<{ egressHosts: { host: string; port: number }[] }>;
  health(o: { proxyUrl?: string }): Promise<RuntimeHealth>;
  setup(o: { proxyUrl?: string }): Promise<RuntimeSetup>;
  check?(o: { proxyUrl?: string }): Promise<{ health: RuntimeHealth; setup: RuntimeSetup }>;
}
export interface RuntimeProbeEntry { kind: RuntimeKind; health: RuntimeHealth; setup?: RuntimeSetup }

export const RUNTIME_PROBE_TTL_MS = 10_000;
export const RUNTIME_PROBE_TIMEOUT_MS = 25_000;

export interface RuntimeProberDeps {
  adapters: () => readonly RuntimeProbeAdapter[];
  now: () => number;
  /** The host proxy starter (default: the real one; tests pass a recording one). */
  startProxy?: typeof startHostEgressProxy;
  imagesDir?: string;
  log?: (line: string) => void;
  timeoutMs?: number;
  ttlMs?: number;
}

const failed = (kind: RuntimeKind, detail: string): RuntimeProbeEntry => ({ kind, health: { ok: false, reason: 'error', detail } });

export class RuntimeProber {
  private last: { key: string; at: number; entries: RuntimeProbeEntry[] } | null = null;
  /** The engine check in flight (single-flight: a second refresh for the same consent state joins it; another waits for it). */
  private running: { key: string; done: Promise<RuntimeProbeEntry[]> } | null = null;
  constructor(private readonly deps: RuntimeProberDeps) {}

  /** `consentHostsSha256`: main's live consent hash, or null/undefined before consent. */
  async probe(consentHostsSha256?: string | null): Promise<RuntimeProbeEntry[]> {
    const key = typeof consentHostsSha256 === 'string' && /^[0-9a-f]{64}$/.test(consentHostsSha256) ? consentHostsSha256 : '';
    for (;;) {
      const adapters = this.deps.adapters();
      if (adapters.length === 0) return [];
      const now = this.deps.now();
      if (this.last && this.last.key === key && now >= this.last.at && now - this.last.at < (this.deps.ttlMs ?? RUNTIME_PROBE_TTL_MS)) return this.last.entries;
      if (this.running) {
        if (this.running.key === key) return this.running.done;
        // A check for another consent state is running: the engine is never run twice at once; look again when it ends.
        try { await this.running.done; } catch { /* the loop looks again */ }
        continue;
      }
      const done = (async () => {
        const entries: RuntimeProbeEntry[] = [];
        for (const a of adapters) entries.push(await this.one(a, key));
        this.last = { key, at: this.deps.now(), entries };
        return entries;
      })();
      const slot = { key, done };
      this.running = slot;
      try { return await done; } finally { if (this.running === slot) this.running = null; }
    }
  }

  private async one(a: RuntimeProbeAdapter, consent: string): Promise<RuntimeProbeEntry> {
    const limit = this.deps.timeoutMs ?? RUNTIME_PROBE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const held: { proxy: HostEgressProxy | null } = { proxy: null };
    const timeout = new Promise<RuntimeProbeEntry>((resolve) => {
      timer = setTimeout(() => {
        // A check that does not answer: its proxy is closed at once (nothing may stay open for a hung engine), the entry says so.
        const p = held.proxy; held.proxy = null;
        if (p) void p.close().catch(() => undefined);
        resolve(failed(a.kind, 'the runtime check timed out'));
      }, limit);
      (timer as { unref?: () => void }).unref?.();
    });
    try { return await Promise.race([this.run(a, consent, held), timeout]); } finally { if (timer) clearTimeout(timer); }
  }

  private async run(a: RuntimeProbeAdapter, consent: string, held: { proxy: HostEgressProxy | null }): Promise<RuntimeProbeEntry> {
    let proxy: HostEgressProxy | null = null;
    try {
      let hosts: { host: string; port: number }[] = [];
      try { hosts = (await a.describe()).egressHosts; } catch { return failed(a.kind, 'the runtime did not describe itself'); }
      // The allow list only for the exact hosts the live consent granted; every other case is deny-all.
      let allow: { host: string; port: number }[] = [];
      try { if (consent !== '' && hosts.length > 0 && hostsSha256(hosts) === consent) allow = hosts; } catch { allow = []; }
      try {
        proxy = await (this.deps.startProxy ?? startHostEgressProxy)({ allow, ...(allow.length > 0 ? { consentHostsSha256: consent } : {}),
          onDecision: () => undefined, ...(this.deps.imagesDir !== undefined ? { imagesDir: this.deps.imagesDir } : {}) });
      } catch {
        // Never run the engine without a proxy of ours.
        return failed(a.kind, 'the runtime could not be checked: no egress proxy could be started');
      }
      held.proxy = proxy;
      const proxyUrl = proxy.url;
      if (typeof a.check === 'function') {
        const c = await a.check({ proxyUrl });
        return { kind: a.kind, health: c.health, setup: c.setup };
      }
      const health = await a.health({ proxyUrl });
      let setup: RuntimeSetup | undefined;
      try { setup = await a.setup({ proxyUrl }); } catch { setup = undefined; }
      return { kind: a.kind, health, ...(setup ? { setup } : {}) };
    } catch {
      return failed(a.kind, 'the runtime check failed');
    } finally {
      if (proxy) { try { await proxy.close(); } catch { /* closed */ } }
    }
  }
}
