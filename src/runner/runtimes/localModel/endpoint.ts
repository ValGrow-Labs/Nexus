/**
 * The local-model runtime's destination rule (R2): the ONLY place it may ever connect is a loopback address, on the
 * consented port. This module decides that, once, for every request the adapter makes (a turn's chat calls and the probe's
 * reads alike):
 *
 * - the host must be literally `127.0.0.1`, `::1` (also written `[::1]`) or `localhost`; any other name is refused WITHOUT
 *   being resolved (no DNS lookup is made for it), and a numeric address that is not one of those two is refused as well;
 * - `localhost` is resolved here, and every address it resolves to must be loopback (127.0.0.0/8 or ::1); the connection is
 *   then made to the very address that was checked (the request never names the host again), so a resolver that changes its
 *   answer between the check and the connect cannot redirect it;
 * - the port is an integer in 1..65535 and, for a turn, must be one the consent granted (`consentedHosts`).
 *
 * It opens nothing itself. The `lookup` argument is a test seam (production passes none: `dns.lookup`).
 */
import * as dns from 'node:dns';
import * as net from 'node:net';

/** The server's default address: the one a user grants once in the setup sheet. */
export const DEFAULT_ENDPOINT: Readonly<{ host: string; port: number }> = Object.freeze({ host: '127.0.0.1', port: 11434 });

/** The fixed sentences a refused endpoint is reported with (never the host that was given, never a resolver error). */
export const ENDPOINT_NOT_LOOPBACK = 'the local model endpoint must be a loopback address';
export const ENDPOINT_NOT_CONSENTED = 'the local model endpoint is not the one that was granted';

export type LookupFn = (host: string, cb: (err: Error | null, addresses: { address: string; family: number }[]) => void) => void;

const defaultLookup: LookupFn = (host, cb) => { dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => cb(err, addrs ?? [])); };

/** Whether an IP literal is loopback: any 127.x.x.x, or ::1 (also its long spelling). */
export function isLoopbackAddress(addr: string): boolean {
  if (net.isIPv4(addr)) return addr.startsWith('127.');
  if (net.isIPv6(addr)) {
    // ::1 in any spelling: eight groups, the last 1, all others 0 (no IPv4-mapped forms: they are refused).
    const parts = expandV6(addr);
    return parts !== null && parts.slice(0, 7).every((g) => g === 0) && parts[7] === 1;
  }
  return false;
}

function expandV6(a: string): number[] | null {
  if (a.includes('.') || a.includes('%')) return null;
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 2 && fill < 1)) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** The host as written, lower-cased and unbracketed (`[::1]` -> `::1`). */
export function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

export type Target = { ok: true; address: string; family: 4 | 6; port: number; hostHeader: string } | { ok: false; reason: 'not_loopback' | 'not_consented' };

/**
 * Where a request may go: the checked loopback address and the port, or a refusal. `consented`: the hosts the live consent
 * granted (for a turn); when given, the endpoint must be one of them (the same name, or any loopback spelling of it on the
 * same port). The probe passes none: it only ever reads from the default or the endpoint it was built with.
 */
export async function resolveTarget(endpoint: { host: unknown; port: unknown }, o: { consented?: readonly { host: string; port: number }[]; lookup?: LookupFn } = {}): Promise<Target> {
  const { host, port } = endpoint;
  if (typeof host !== 'string' || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'not_loopback' };
  const h = normalizeHost(host);
  if (h.length === 0 || h.length > 255) return { ok: false, reason: 'not_loopback' };
  let address: string;
  if (net.isIP(h) !== 0) {
    if (!isLoopbackAddress(h)) return { ok: false, reason: 'not_loopback' };
    address = h;
  } else if (h === 'localhost') {
    let addrs: { address: string; family: number }[];
    try { addrs = await new Promise((resolve, reject) => { (o.lookup ?? defaultLookup)(h, (err, a) => (err ? reject(err) : resolve(a))); }); }
    catch { return { ok: false, reason: 'not_loopback' }; }
    // Every answer must be loopback: one other address is enough to refuse (a name that can lead anywhere else is not loopback).
    if (!Array.isArray(addrs) || addrs.length === 0 || !addrs.every((a) => a && typeof a.address === 'string' && isLoopbackAddress(a.address))) {
      return { ok: false, reason: 'not_loopback' };
    }
    address = addrs[0].address;
  } else {
    return { ok: false, reason: 'not_loopback' };
  }
  if (o.consented && !o.consented.some((c) => c.port === port && isLoopbackName(c.host))) return { ok: false, reason: 'not_consented' };
  const family = net.isIPv6(address) ? 6 : 4;
  return { ok: true, address, family, port, hostHeader: family === 6 ? `[${address}]:${port}` : `${address}:${port}` };
}

/** The three names a loopback endpoint may carry. */
function isLoopbackName(host: string): boolean {
  const h = normalizeHost(host);
  return h === 'localhost' || (net.isIP(h) !== 0 && isLoopbackAddress(h));
}

/** The loopback form of an MCP URL, or null: `http://127.0.0.1:<port>/...` only (the bearer is never sent anywhere else). */
export function loopbackMcpUrl(url: unknown): URL | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' || u.username !== '' || u.password !== '' || u.hostname !== '127.0.0.1' || u.port === '') return null;
  return u;
}
