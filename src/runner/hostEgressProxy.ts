/**
 * The host egress proxy for the agent process (B2b Task 12, D-B2, F14).
 *
 * The agent runtime runs on the host under the runner; its own traffic (and only that) goes through this loopback proxy.
 * The proxy is B2a's `infra/images/sde-node/egress-proxy.js` itself, loaded from the image build contexts the runner
 * already has (`<resources>/images` packaged, the repository's `infra/images` in development): no copy and no image
 * change, so `contextSha256` and every B2a image pin hold. Its exported `serve(allow, { log, lookup })` makes the server;
 * this file only listens on 127.0.0.1:0 and turns each decision line into an `egress` progress event.
 *
 * Policy (all of it the proxy's own): HTTPS CONNECT only, the exact allow-listed name and port, the TLS ClientHello must
 * name the same host, the name is resolved by the proxy once and refused if any address is not globally routable, and
 * it connects to the very address it checked.
 *
 * The allow list:
 * - production: the adapter's `egressHosts` (main takes them from the runtime probe, never from the renderer), bound to
 *   the live consent: their canonical hash must equal the consent's `hosts_sha256`, else the start is refused with
 *   `consent_mismatch` and the turn fails `failed: consent_mismatch`;
 * - deny-all (an empty list): health probes before consent; every request is refused.
 * Every entry is built here with no pinned address; `lookup` is a test seam (production passes none, so the proxy uses
 * its own DNS lookup and private-address rule).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as path from 'node:path';
import { parseEgressLine, type EgressHost } from '../shared/nexus/egressPolicy';
import { EGRESS_EVENT_MAX, type ProgressEvent } from '../shared/nexus/runnerProtocol';

/** The only address the proxy listens on. */
export const HOST_PROXY_BIND = '127.0.0.1' as const;
/** The proxy's own entry limit. */
export const HOST_PROXY_MAX_HOSTS = 16;

export type EgressEvent = Extract<ProgressEvent, { t: 'egress' }>;
/** The proxy's resolver signature (a test seam only). */
export type ProxyLookup = (host: string, cb: (err: Error | null, addresses: string[]) => void) => void;

/**
 * Why the proxy did not start. `consent_mismatch`: the allow list is not the one the live consent granted.
 * `allow_invalid`: an entry is not an exact DNS name and port. `proxy_unavailable`: the proxy file is missing or not the
 * proxy. `listen_failed`: 127.0.0.1:0 could not be bound.
 */
export type HostEgressFailure = 'consent_mismatch' | 'allow_invalid' | 'proxy_unavailable' | 'listen_failed';
export class HostEgressProxyError extends Error {
  readonly code: HostEgressFailure;
  constructor(code: HostEgressFailure, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'HostEgressProxyError';
    this.code = code;
  }
}

export interface HostEgressProxyOptions {
  /** The adapter's `egressHosts`; an empty list is deny-all. */
  allow: readonly EgressHost[];
  /** The live consent's `hosts_sha256`; required (and must match) unless `allow` is empty. */
  consentHostsSha256?: string | null;
  /** One `egress` event per decision, at most EGRESS_EVENT_MAX per proxy (one proxy per turn attempt). */
  onDecision: (e: EgressEvent) => void;
  /** The image build contexts (the runner's `imagesDir`); defaults to where the runner entry finds them. */
  imagesDir?: string;
  /** TESTS ONLY: a fake resolver. Production never passes one (HE6). */
  lookup?: ProxyLookup;
}

export interface HostEgressProxy {
  /** `http://127.0.0.1:<port>`, for the agent process's proxy settings. */
  readonly url: string;
  readonly port: number;
  /** Decisions seen, and those not reported as events (over EGRESS_EVENT_MAX). */
  readonly decisions: number;
  readonly dropped: number;
  /** Stops listening and ends every open client connection. Idempotent. */
  close(): Promise<void>;
}

interface ProxyEntry { host: string; port: number; pin: null }
interface ProxyModule {
  serve: (allow: ProxyEntry[], o: { log: (line: string) => void; lookup?: ProxyLookup }) => net.Server;
  normalizeHost: (h: string) => string | null;
}

/** Where the runner entry finds the image build contexts (mirrors src/runner/index.ts). */
export function defaultImagesDir(): string {
  const packaged = __dirname.includes('app.asar');
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath;
  return packaged && resources ? path.join(resources, 'images') : path.resolve(__dirname, '..', '..', 'infra', 'images');
}

/** B2a's proxy file inside the image build contexts. */
export function hostProxyModulePath(imagesDir: string): string {
  return path.join(path.resolve(imagesDir), 'sde-node', 'egress-proxy.js');
}

const HOST_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** One allow entry as `host:port` (lower case), or null when it is not an exact DNS name and port. */
function hostKey(e: unknown): string | null {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return null;
  const keys = Object.keys(e);
  if (keys.length !== 2 || !keys.includes('host') || !keys.includes('port')) return null;
  const { host, port } = e as { host: unknown; port: unknown };
  if (typeof host !== 'string' || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const h = host.toLowerCase();
  if (h.length > 253 || !HOST_RE.test(h) || net.isIP(h) !== 0 || /^[0-9]+$/.test(h.slice(h.lastIndexOf('.') + 1))) return null;
  return `${h}:${port}`;
}

/**
 * The canonical text of a host list: the sorted, de-duplicated `host:port` entries (lower case) as a JSON array, e.g.
 * `["a.example.com:443"]`. This is the consent's `hosts_json`; `hosts_sha256` is the sha256 (hex) of its UTF-8 bytes.
 * Throws on an entry that is not an exact DNS name and port.
 */
export function canonicalHostsJson(hosts: readonly EgressHost[]): string {
  if (!Array.isArray(hosts)) throw new HostEgressProxyError('allow_invalid', 'the host list is not a list');
  const keys = hosts.map((e) => {
    const k = hostKey(e);
    if (!k) throw new HostEgressProxyError('allow_invalid', 'a host entry is not an exact DNS name and port');
    return k;
  });
  return JSON.stringify([...new Set(keys)].sort());
}

/** The consent hash of a host list (sha256 hex of `canonicalHostsJson`). */
export function hostsSha256(hosts: readonly EgressHost[]): string {
  return createHash('sha256').update(canonicalHostsJson(hosts), 'utf8').digest('hex');
}

function loadProxy(imagesDir: string): ProxyModule {
  const file = hostProxyModulePath(imagesDir);
  if (!fs.existsSync(file)) throw new HostEgressProxyError('proxy_unavailable', 'the egress proxy file is missing');
  let mod: Partial<ProxyModule>;
  try { mod = createRequire(file)(file) as Partial<ProxyModule>; } catch {
    throw new HostEgressProxyError('proxy_unavailable', 'the egress proxy file did not load');
  }
  if (typeof mod?.serve !== 'function' || typeof mod.normalizeHost !== 'function') {
    throw new HostEgressProxyError('proxy_unavailable', 'the egress proxy file is not the Nexus proxy');
  }
  return mod as ProxyModule;
}

/** Starts the proxy for one turn attempt (or a deny-all health probe). */
export async function startHostEgressProxy(o: HostEgressProxyOptions): Promise<HostEgressProxy> {
  const allow = o.allow;
  if (!Array.isArray(allow) || allow.length > HOST_PROXY_MAX_HOSTS) {
    throw new HostEgressProxyError('allow_invalid', `the allow list is not a list of at most ${HOST_PROXY_MAX_HOSTS} hosts`);
  }
  const canonical = canonicalHostsJson(allow);
  if (allow.length > 0) {
    const want = createHash('sha256').update(canonical, 'utf8').digest('hex');
    if (typeof o.consentHostsSha256 !== 'string' || o.consentHostsSha256 !== want) {
      throw new HostEgressProxyError('consent_mismatch', 'the hosts are not the ones the live consent granted');
    }
  }
  const mod = loadProxy(o.imagesDir ?? defaultImagesDir());
  // The entries the proxy compares against: exact names (the proxy's own normalizer must agree), never a pinned address.
  const entries: ProxyEntry[] = (JSON.parse(canonical) as string[]).map((k) => {
    const i = k.lastIndexOf(':');
    const host = k.slice(0, i);
    if (mod.normalizeHost(host) !== host) throw new HostEgressProxyError('allow_invalid', 'a host is not an exact DNS name');
    return { host, port: Number(k.slice(i + 1)), pin: null };
  });

  let decisions = 0;
  let dropped = 0;
  const log = (line: string): void => {
    const d = parseEgressLine(String(line).trim());
    if (!d) return;
    decisions++;
    if (decisions > EGRESS_EVENT_MAX) { dropped++; return; }
    try { o.onDecision({ t: 'egress', decision: d.decision, host: d.host, port: d.port, reason: d.reason, at: Date.now() }); } catch { /* the caller's problem */ }
  };
  const server = mod.serve(entries, { log, lookup: o.lookup });
  const sockets = new Set<net.Socket>();
  server.on('connection', (s: net.Socket) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });

  const port = await new Promise<number>((resolve, reject) => {
    const fail = (e: Error): void => reject(new HostEgressProxyError('listen_failed', e.message));
    server.once('error', fail);
    server.listen(0, HOST_PROXY_BIND, () => {
      server.off('error', fail);
      const a = server.address();
      if (a && typeof a === 'object' && a.address === HOST_PROXY_BIND) resolve(a.port);
      else { server.close(); reject(new HostEgressProxyError('listen_failed', 'the proxy is not bound to loopback')); }
    });
  });
  server.on('error', () => { /* after listening: a client error never ends the proxy */ });

  let closing: Promise<void> | null = null;
  return {
    url: `http://${HOST_PROXY_BIND}:${port}`,
    port,
    get decisions() { return decisions; },
    get dropped() { return dropped; },
    close(): Promise<void> {
      if (!closing) {
        closing = new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const s of sockets) s.destroy();
        });
      }
      return closing;
    }
  };
}
