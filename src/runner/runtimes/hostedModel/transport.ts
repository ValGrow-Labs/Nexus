/**
 * The hosted-model runtime's HTTPS transport (ruling H2). One JSON POST to one provider host, and nothing else:
 *
 * - the URL is checked first, every time: `https:` only, no user info, a DNS name (never an IP literal), and exactly one of the hosts
 *   the caller allows (the chosen provider's host and port, from the preset table); anything else is refused BEFORE any connection
 *   is made (`bad_target`);
 * - the connection goes THROUGH the turn's host egress proxy (the one bound to the live consent: CONNECT tunnel, allow-list, decisions
 *   recorded): a manual `CONNECT host:443` to the loopback proxy URL, then TLS over the tunnel with the provider's own name as SNI and
 *   full certificate and host-name verification. Without a proxy URL nothing is ever sent (`no_proxy`); there is no direct path;
 * - no redirect is followed (any 3xx is a failure), no connection is kept alive, every request has a timeout and every answer a size
 *   cap, and the caller's `AbortSignal` destroys the connection at once;
 * - the API key is only ever the value of the one auth header the caller names (client.ts builds it); it is never in the URL or the
 *   body, and no failure carries any text of the provider's answer.
 *
 * `HostedTestSeam` is a TEST SEAM in the style of the CLI adapter's: production never sets it (the registry only takes it from the
 * runner's test dependencies). It changes only HOW the checked, allowed target is connected (plain HTTP to a loopback mock, or a test
 * trust root for the TLS handshake); the target check above runs unchanged.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';

export type TransportFailure = 'bad_target' | 'no_proxy' | 'proxy_refused' | 'connect_failed' | 'tls_failed' | 'timeout' | 'too_large' | 'redirect' | 'aborted';
export type TransportResult =
  | { ok: true; status: number; headers: http.IncomingHttpHeaders; text: string }
  | { ok: false; kind: TransportFailure };

export interface HostedTestSeam {
  /** Connect plain HTTP to this address (a loopback mock) instead of the proxy tunnel and TLS. The `Host` header is still the provider's. */
  plain?: { host: string; port: number };
  /** PEM trust root(s) for the TLS handshake (a test CA); production uses the system roots. */
  ca?: string | readonly string[];
}

export interface HostPort { host: string; port: number }

export interface PostOptions {
  url: string;
  /** The hosts this request may go to (the chosen provider's own host and port). */
  allowed: readonly HostPort[];
  /** Extra headers (the auth header). The fixed ones (host, content type and length, accept, connection) cannot be overridden. */
  headers: Record<string, string>;
  /** The request body, JSON text. */
  body: string;
  /** The turn's host egress proxy URL (`http://127.0.0.1:<port>`), or null when none runs. */
  proxyUrl: string | null;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  seam?: HostedTestSeam;
}

/** The most bytes of an error answer that are read (it is only classified, never kept). */
const ERROR_BODY_MAX = 64 * 1024;

/** The checked parts of a URL, or null when it is not a request this runtime may make. */
export function checkTarget(url: unknown, allowed: readonly HostPort[]): { host: string; port: number; path: string } | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.hash !== '') return null;
  const host = u.hostname.toLowerCase();
  if (host.length === 0 || net.isIP(host) !== 0 || host.startsWith('[')) return null;
  const port = u.port === '' ? 443 : Number(u.port);
  if (!Number.isInteger(port) || !allowed.some((a) => a.host.toLowerCase() === host && a.port === port)) return null;
  return { host, port, path: `${u.pathname}${u.search}` };
}

/** `http://127.0.0.1:<port>` only: the runner's own loopback proxy. */
function parseProxy(url: string | null): HostPort | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username !== '' || u.password !== '' || u.port === '') return null;
  const port = Number(u.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? { host: '127.0.0.1', port } : null;
}

const TLS_CODE_RE = /CERT|SIGNATURE|ISSUER|ALTNAME|ERR_TLS|ERR_SSL|SELF_SIGNED|EPROTO/i;

/** A CONNECT tunnel to `target` through the loopback proxy. The proxy's own answer decides: 200 is a tunnel, anything else a refusal. */
function openTunnel(proxy: HostPort, target: HostPort, track: (s: net.Socket) => void, onReq: (r: http.ClientRequest) => void): Promise<{ ok: true; socket: net.Socket } | { ok: false; kind: 'proxy_refused' | 'connect_failed' }> {
  return new Promise((resolve) => {
    const authority = `${target.host}:${target.port}`;
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: authority, headers: { host: authority }, agent: false });
    onReq(req);
    req.once('connect', (res, socket) => {
      track(socket);
      if (res.statusCode === 200) { resolve({ ok: true, socket }); return; }
      socket.destroy();
      resolve({ ok: false, kind: 'proxy_refused' });
    });
    req.once('response', (res) => { res.resume(); resolve({ ok: false, kind: 'proxy_refused' }); });
    req.once('error', () => resolve({ ok: false, kind: 'connect_failed' }));
    req.end();
  });
}

/** One JSON POST. Never throws; the answer's status is reported as it came (a 4xx or 5xx is `ok: true` for the caller to classify). */
export function postJson(o: PostOptions): Promise<TransportResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sockets = new Set<net.Socket>();
    const reqs = new Set<http.ClientRequest>();
    const done = (r: TransportResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (!r.ok) { for (const q of reqs) { try { q.destroy(); } catch { /* gone */ } } for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } } }
      resolve(r);
    };
    const onAbort = (): void => done({ ok: false, kind: 'aborted' });

    const target = checkTarget(o.url, o.allowed);
    if (!target) { resolve({ ok: false, kind: 'bad_target' }); return; }
    if (o.signal?.aborted) { resolve({ ok: false, kind: 'aborted' }); return; }
    o.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => done({ ok: false, kind: 'timeout' }), Math.max(1, o.timeoutMs));
    (timer as { unref?: () => void }).unref?.();

    const payload = Buffer.from(o.body, 'utf8');
    const headers: Record<string, string> = {
      ...o.headers,
      host: target.port === 443 ? target.host : `${target.host}:${target.port}`,
      accept: 'application/json', 'accept-encoding': 'identity', 'content-type': 'application/json', 'content-length': String(payload.length),
      connection: 'close', 'user-agent': 'nexus-hosted-model'
    };
    let tlsError: NodeJS.ErrnoException | null = null;
    const fail = (e: unknown): void => {
      const code = (e as NodeJS.ErrnoException | null)?.code ?? '';
      const tlsCode = tlsError?.code ?? '';
      done({ ok: false, kind: TLS_CODE_RE.test(code) || TLS_CODE_RE.test(tlsCode) ? 'tls_failed' : 'connect_failed' });
    };

    const onResponse = (res: http.IncomingMessage): void => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); done({ ok: false, kind: 'redirect' }); return; }
      const okStatus = status >= 200 && status < 300;
      const cap = okStatus ? o.maxBytes : Math.min(o.maxBytes, ERROR_BODY_MAX);
      const declared = Number(res.headers['content-length']);
      if (okStatus && Number.isFinite(declared) && declared > cap) { res.resume(); done({ ok: false, kind: 'too_large' }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      let cut = false;
      res.on('data', (c: Buffer) => {
        if (cut) return;
        size += c.length;
        if (size > cap) {
          if (okStatus) { done({ ok: false, kind: 'too_large' }); res.destroy(); return; }
          cut = true; res.destroy(); finish(); return;
        }
        chunks.push(c);
      });
      const finish = (): void => done({ ok: true, status, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
      res.on('error', () => { if (cut) finish(); else done({ ok: false, kind: 'connect_failed' }); });
      res.on('aborted', () => { if (!cut) done({ ok: false, kind: 'connect_failed' }); });
      res.on('end', finish);
    };

    const send = (req: http.ClientRequest): void => {
      reqs.add(req);
      req.on('response', onResponse);
      req.on('error', fail);
      req.end(payload);
    };

    try {
      if (o.seam?.plain) {
        send(http.request({ host: o.seam.plain.host, port: o.seam.plain.port, method: 'POST', path: target.path, headers, agent: false }));
        return;
      }
      const proxy = parseProxy(o.proxyUrl);
      if (!proxy) { done({ ok: false, kind: 'no_proxy' }); return; }
      void openTunnel(proxy, target, (s) => { sockets.add(s); }, (r) => { reqs.add(r); }).then((t) => {
        if (settled) { if (t.ok) t.socket.destroy(); return; }
        if (!t.ok) { done({ ok: false, kind: t.kind }); return; }
        const secure = tls.connect({ socket: t.socket, servername: target.host, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'], rejectUnauthorized: true,
          ...(o.seam?.ca ? { ca: o.seam.ca as string | string[] } : {}) });
        sockets.add(secure);
        secure.once('error', (e) => { tlsError = e; });
        send(https.request({ host: target.host, port: target.port, method: 'POST', path: target.path, headers, createConnection: () => secure }));
      }, () => done({ ok: false, kind: 'connect_failed' }));
    } catch {
      done({ ok: false, kind: 'connect_failed' });
    }
  });
}
