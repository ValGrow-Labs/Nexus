// The local-model runtime kind (neutral names only): its kind id, the loopback rule for its endpoint, the shape of a model name
// and the models a probe lists. Pure; shared by main (settings, plan, consent, views), the runner's plan check and the renderer.
// The one destination this runtime may reach is a loopback address on the consented port (never a remote host).

/** The runtime kind id of the local-model runtime, and the `provider` its run request's model names. */
export const LOCAL_MODEL_KIND = 'local-model';
export const LOCAL_MODEL_PROVIDER = 'local-model';

/** The most models a probe lists for one runtime (the rest are not offered). */
export const RUNTIME_MODELS_MAX = 64;
/** A model name as a person types or a server lists it: a short, plain token (letters, digits and `. _ : / @ -`), never a path. */
export const MODEL_NAME_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
export const isModelName = (x: unknown): x is string => typeof x === 'string' && MODEL_NAME_RE.test(x);

/** One model a runtime's probe lists: its name and whether it reports that it can call tools. */
export interface RuntimeModelInfo { name: string; tools: boolean }

export interface LoopbackEndpoint { host: string; port: number }

/**
 * A loopback host as the runtime dials it, or null when it is not one. `localhost` and `127.0.0.1` are the IPv4 loopback address
 * (`127.0.0.1`); `::1` (bracketed or not) is the IPv6 one. Nothing else is loopback here: no other 127.x.x.x, no name, no `0.0.0.0`.
 */
export function normalizeLoopbackHost(host: unknown): string | null {
  if (typeof host !== 'string') return null;
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1') return '127.0.0.1';
  if (h === '::1' || h === '[::1]') return '::1';
  return null;
}

/** A loopback endpoint (`host` normalised, `port` 1..65535), or null. */
export function loopbackEndpoint(x: unknown): LoopbackEndpoint | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const { host, port } = x as { host?: unknown; port?: unknown };
  const h = normalizeLoopbackHost(host);
  return h !== null && typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? { host: h, port } : null;
}

/**
 * Why a chosen model cannot be used, from the models a probe listed: `local_model_missing` when it is not in the list (or no list
 * was reported), `local_model_no_tools` when it is there but reports no tool support; null when it can be used.
 */
export function modelProblem(models: readonly RuntimeModelInfo[] | null | undefined, name: string | null): 'local_model_missing' | 'local_model_no_tools' | null {
  if (name === null) return 'local_model_missing';
  const m = Array.isArray(models) ? models.find((x) => x.name === name) : undefined;
  if (!m) return 'local_model_missing';
  return m.tools ? null : 'local_model_no_tools';
}

/** The reasons the local-model runtime refuses a start for (each has a fixed sentence in main and in the renderer). */
export const LOCAL_MODEL_REASONS = ['local_model_not_chosen', 'local_model_endpoint', 'local_model_missing', 'local_model_no_tools', 'local_model_server_down'] as const;
export type LocalModelReason = (typeof LOCAL_MODEL_REASONS)[number];
