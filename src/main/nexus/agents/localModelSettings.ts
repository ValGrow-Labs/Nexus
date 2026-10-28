/**
 * The local-model runtime's settings (the ONE main-side Nexus file that knows where the user keeps the setting).
 *
 * The user's existing local-server setting lives in the legacy app config (`providerBaseUrls` and `providerDefaultModels`, the
 * entry the app's local-model engine uses, `opencode`: a server such as Ollama at `http://127.0.0.1:11434/v1`). This file reads
 * exactly that, through an injected reader (main passes `readConfig`; tests pass a literal), and answers `{ endpoint, model }`.
 *
 * Rules:
 * - The endpoint must be a LOOPBACK address (`127.0.0.1`, `localhost`, `::1`): anything else is refused, never used, never
 *   "fixed". A missing base URL is the default `127.0.0.1:11434`. The path (`/v1`) is ignored; credentials, a query or a
 *   fragment in the URL make it unusable.
 * - The model is the one the user chose for the live permission (Nexus's own record, `chosenModel`), else the default model
 *   of that same settings entry when it names a local model (`local/<name>` or `ollama/<name>`); otherwise there is none.
 * - It never throws: a missing, malformed or hostile config answers a refusal reason, never an exception.
 */
import { LOCAL_MODEL_KIND, isModelName, loopbackEndpoint, normalizeLoopbackHost, type LoopbackEndpoint } from '../../../shared/nexus/localModel';

/** The subset of the legacy config this file reads (structural: `HarnessConfig` satisfies it). */
export interface LocalServerConfig {
  providerBaseUrls?: Partial<Record<string, string>> | null;
  providerDefaultModels?: Partial<Record<string, string>> | null;
}

/** The legacy settings entry the app's local-model engine keeps its address and default model under. */
const SETTINGS_ENTRY = 'opencode';
export const DEFAULT_ENDPOINT: Readonly<LoopbackEndpoint> = Object.freeze({ host: '127.0.0.1', port: 11434 });

export interface LocalModelSettings { endpoint: LoopbackEndpoint; model: string }
export type LocalModelSettingsRead =
  | { ok: true; endpoint: LoopbackEndpoint; model: string }
  /** `endpoint_not_local`: the configured address is not loopback (or unusable). `model_missing`: no model is chosen or set. */
  | { ok: false; reason: 'endpoint_not_local' | 'model_missing'; endpoint: LoopbackEndpoint | null; model: null };

/** The model a settings default names, when it is a local model (`local/x` or `ollama/x`); null otherwise (a cloud model is never used here). */
function legacyDefaultModel(cfg: LocalServerConfig | null | undefined): string | null {
  let v: unknown;
  try { v = cfg?.providerDefaultModels?.[SETTINGS_ENTRY]; } catch { return null; }
  if (typeof v !== 'string') return null;
  const m = /^(?:local|ollama)\/(.+)$/i.exec(v.trim());
  return m && isModelName(m[1]) ? m[1] : null;
}

/** The endpoint of the settings' base URL: default when none is set, null when it is set and is not a loopback address. */
function endpointOf(cfg: LocalServerConfig | null | undefined): LoopbackEndpoint | null {
  let raw: unknown;
  try { raw = cfg?.providerBaseUrls?.[SETTINGS_ENTRY]; } catch { return null; }
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { ...DEFAULT_ENDPOINT };
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return null;
  const host = normalizeLoopbackHost(u.hostname);
  const port = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
  return host === null ? null : loopbackEndpoint({ host, port });
}

/**
 * The settings, or why there are none. `chosenModel`: the model the user chose for the live permission (null when none).
 * The endpoint comes back whenever it is a usable loopback address, even when no model is set (the picker needs it).
 */
export function readLocalModelSettings(o: { readConfig: () => LocalServerConfig | null | undefined; chosenModel?: string | null }): LocalModelSettingsRead {
  let cfg: LocalServerConfig | null | undefined;
  try { cfg = o.readConfig(); } catch { cfg = null; }
  const endpoint = endpointOf(cfg);
  if (endpoint === null) return { ok: false, reason: 'endpoint_not_local', endpoint: null, model: null };
  const chosen = isModelName(o.chosenModel) ? o.chosenModel : null;
  const model = chosen ?? legacyDefaultModel(cfg);
  return model === null ? { ok: false, reason: 'model_missing', endpoint, model: null } : { ok: true, endpoint, model };
}

/** The shape the spec asks for: `{ endpoint, model }` or null (no settings, no model, or a non-loopback address). */
export function localModelSettings(o: { readConfig: () => LocalServerConfig | null | undefined; chosenModel?: string | null }): LocalModelSettings | null {
  const r = readLocalModelSettings(o);
  return r.ok ? { endpoint: r.endpoint, model: r.model } : null;
}

/** The runtime kind this file serves (re-exported so a caller needs only this module). */
export { LOCAL_MODEL_KIND };
