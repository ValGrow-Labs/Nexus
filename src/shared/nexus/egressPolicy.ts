/**
 * The Nexus egress policy (B2a stabilization, user constraint 5: "any network-enabled operation goes through an explicit
 * Nexus-controlled policy and approval path; no unrestricted escape").
 *
 * An approved dependency install (`sde.deps.node`, `sde.deps.python`) never gets a route out. Its container sits on an
 * `--internal` network (`nexus-egress-in-<jobId>`) whose only other member is the Nexus egress proxy
 * (infra/images/sde-node/egress-proxy.js, run in the pinned sde-node image). The proxy alone also joins the job's
 * outbound bridge (`nexus-egress-out-<jobId>`), and it allows only HTTPS `CONNECT` to the recipe's allow-list below, after
 * resolving the name itself and refusing any private, loopback, link-local, metadata or otherwise non-routable address.
 *
 * This file is the single source of the allow-lists: main's plan builder writes them into the proxy's environment, the
 * approval summary names exactly these hosts, and the runner refuses a plan whose proxy carries anything else.
 * Pure (no I/O); shared by main and the runner.
 */

/** One allowed destination: an exact DNS name and port (no wildcard, no suffix match). */
export interface EgressHost { host: string; port: number }

/** The hosts each egress recipe may reach, HTTPS (443) only. Nothing else is reachable from an install. */
export const EGRESS_ALLOWLISTS: Readonly<Record<string, readonly EgressHost[]>> = Object.freeze({
  'sde.deps.node': Object.freeze([Object.freeze({ host: 'registry.npmjs.org', port: 443 })]),
  'sde.deps.resolve': Object.freeze([Object.freeze({ host: 'registry.npmjs.org', port: 443 })]),
  'sde.deps.python': Object.freeze([Object.freeze({ host: 'pypi.org', port: 443 }), Object.freeze({ host: 'files.pythonhosted.org', port: 443 })])
});

/** The allow-list of an egress recipe, or null (a recipe without one never gets network access). */
export function egressAllowFor(recipeId: string): readonly EgressHost[] | null {
  return Object.prototype.hasOwnProperty.call(EGRESS_ALLOWLISTS, recipeId) ? EGRESS_ALLOWLISTS[recipeId] : null;
}

/** The proxy's environment value: `host:port` entries, comma-separated (the proxy's own parser is stricter still). */
export function formatAllow(list: readonly EgressHost[]): string {
  return list.map((e) => `${e.host}:${e.port}`).join(',');
}

/** The proxy runs in this profile's pinned image (node is already there: no new image, no new package). */
export const EGRESS_PROXY_PROFILE = 'sde-node' as const;
/** The proxy's fixed command, run by the Nexus entry. */
export const EGRESS_PROXY_ARGV: readonly string[] = Object.freeze(['node', '/opt/nexus/egress-proxy.js']);
export const EGRESS_PROXY_PORT = 3128;
/** The proxy's name on the internal network (the install's HTTPS_PROXY points at it). */
export const EGRESS_PROXY_ALIAS = 'nexus-egress-proxy';
export const EGRESS_PROXY_URL = `http://${EGRESS_PROXY_ALIAS}:${EGRESS_PROXY_PORT}`;
/** The proxy's own small limits (it only relays bytes). */
export const EGRESS_PROXY_LIMITS = Object.freeze({ cpus: 0.5, memoryMb: 256, tmpfsMb: 16, outputMaxBytes: 2 ** 20 });

/** The internal network of an install (no route out): the install and the proxy. */
export function egressInternalNetwork(jobId: string): string { return `nexus-egress-in-${jobId}`; }
/** The outbound bridge of an install: the proxy only. */
export function egressOutboundNetwork(jobId: string): string { return `nexus-egress-out-${jobId}`; }

/**
 * The proxy settings an install container receives (values are main's constants). Every tool also has no route out, so
 * a tool that ignores them simply cannot connect; these only make the approved path work.
 */
export function egressClientEnv(profileId: string): Record<string, string> {
  const env: Record<string, string> = { HTTPS_PROXY: EGRESS_PROXY_URL, HTTP_PROXY: EGRESS_PROXY_URL, https_proxy: EGRESS_PROXY_URL, http_proxy: EGRESS_PROXY_URL };
  if (profileId === 'sde-node') { env.npm_config_proxy = EGRESS_PROXY_URL; env.npm_config_https_proxy = EGRESS_PROXY_URL; }
  if (profileId === 'sde-python') env.PIP_PROXY = EGRESS_PROXY_URL;
  return env;
}

/** The environment names the proxy settings use (main's env allow-list includes them). */
export const EGRESS_ENV_NAMES: readonly string[] = Object.freeze(['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy',
  'npm_config_proxy', 'npm_config_https_proxy', 'PIP_PROXY', 'NEXUS_EGRESS_ALLOW']);

/** Why the proxy refused (or `allowed`). The proxy prints exactly these. */
export type EgressReason = 'allowed' | 'plain_http' | 'malformed' | 'ip_literal' | 'host_not_allowed' | 'port_not_allowed'
  | 'not_tls' | 'sni_mismatch' | 'private_address' | 'dns_failed' | 'connect_failed' | 'busy';
export const EGRESS_REASONS: readonly EgressReason[] = Object.freeze(['allowed', 'plain_http', 'malformed', 'ip_literal', 'host_not_allowed',
  'port_not_allowed', 'not_tls', 'sni_mismatch', 'private_address', 'dns_failed', 'connect_failed', 'busy'] as EgressReason[]);

/** One proxy decision as the runner reports it (`attempt.event` `egress`). */
export interface EgressDecision { decision: 'allowed' | 'refused'; host: string; port: number; reason: EgressReason }

/** A host as it may appear in a decision: a DNS name or an address the client wrote (bracketed IPv6 too), never a path. */
export const EGRESS_HOST_RE = /^[A-Za-z0-9.:[\]_-]{0,255}$/;

/** A proxy output line `nexus-egress {json}` -> the decision, or null (anything else, or a malformed record). */
export function parseEgressLine(line: string): EgressDecision | null {
  if (typeof line !== 'string' || line.length > 1024 || !line.startsWith('nexus-egress {')) return null;
  let v: unknown;
  try { v = JSON.parse(line.slice('nexus-egress '.length)); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const decision = r.decision; const host = r.host; const port = r.port; const reason = r.reason;
  if ((decision !== 'allowed' && decision !== 'refused') || typeof host !== 'string' || !EGRESS_HOST_RE.test(host)
    || typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535
    || typeof reason !== 'string' || !(EGRESS_REASONS as readonly string[]).includes(reason)) return null;
  if ((decision === 'allowed') !== (reason === 'allowed')) return null;
  return { decision, host, port, reason: reason as EgressReason };
}

/** True when a line says the proxy listens (`nexus-egress-ready {...}`). */
export function isEgressReadyLine(line: string): boolean {
  return typeof line === 'string' && line.startsWith('nexus-egress-ready ');
}
