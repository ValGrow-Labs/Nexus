/**
 * The hosted-model runtime's settings: the ONE main-side file that plumbs the user's provider choice and API key.
 *
 * - The provider ids, labels and model lists are the runner's probe data (`setup.providers`); nothing here names a provider.
 * - The KEY is a credential. It is kept ONLY in the existing encrypted secret store (src/main/integrations.ts, safeStorage; its
 *   `config:` family of refs, here `config:hosted:<providerId>`), written once by the user in Settings and never read back by the
 *   renderer: the views carry booleans (`present`). If the system cannot encrypt, the key is refused with a fixed sentence and
 *   nothing is stored (never plaintext). Main reads it with `resolve` at lease time and hands it to the runner in memory.
 * - The key is in no row, log line, event, error text, view or dto: every refusal here is a fixed sentence built without it.
 * - The provider and model the user chose are recorded with the permission's audit rows (BudgetService.chooseModel / liveChoice):
 *   no schema change. `hostedChoice` judges that choice against the probe's list.
 * - It never throws: a store that fails answers a refusal, never an exception that could carry the key.
 */
import { HOSTED_MODEL_KIND, hostedChoiceProblem, isProviderId, type HostedModelReason, type HostedProviderInfo } from '../../../shared/nexus/hostedModel';
import { isRuntimeApiKey } from '../../../shared/nexus/runnerProtocol';

export { HOSTED_MODEL_KIND };

/** The encrypted secret store as this file needs it (main passes src/main/integrations.ts; a test passes a fake safeStorage). */
export interface HostedSecretStore {
  /** Whether the system can encrypt a secret at rest. When false nothing is ever stored. */
  encryptionAvailable(): boolean;
  set(ref: string, value: string): { ok: boolean; error?: string };
  get(ref: string): string | undefined;
  has(ref: string): boolean;
  delete(ref: string): void;
}

/** The ref a provider's key is kept under: its own `config:hosted:` family, next to the other config secrets. */
export const hostedKeyRef = (providerId: string): string => `config:hosted:${providerId}`;

/** The most characters a pasted key may have before it is trimmed and judged (a clipboard accident is refused, not stored). */
const PASTE_MAX = 4096;

export type KeyRefusal = 'bad_provider' | 'providers_unknown' | 'bad_key' | 'encryption_unavailable' | 'store_failed' | 'not_allowed' | 'bad_request';
/** The fixed sentences of a refused key change (no key text, no path, no system message). */
export const KEY_REFUSAL_TEXT: Readonly<Record<KeyRefusal, string>> = Object.freeze({
  bad_provider: 'That AI service is not one Nexus offers.',
  providers_unknown: 'Nexus has not read the list of AI services yet. Open “Get this computer ready”, check again, then try again.',
  bad_key: 'That does not look like an access key. Paste the key exactly as the AI service shows it (letters, digits and symbols, no spaces).',
  encryption_unavailable: 'This computer cannot keep a secret safely right now, so the access key was not saved.',
  store_failed: 'The access key could not be saved. Nothing was changed.',
  not_allowed: 'Only the person who owns this Nexus can change access keys.',
  bad_request: 'Nexus could not read that request. Nothing was changed.'
});
export type KeyRefused = { ok: false; reason: KeyRefusal; message: string };
export type KeyResult = { ok: true } | KeyRefused;
const refused = (reason: KeyRefusal): KeyRefused => ({ ok: false, reason, message: KEY_REFUSAL_TEXT[reason] });

/** One provider as the Settings panel lists it: the probe's id and label, and whether a key is stored (a boolean only). */
export interface ProviderKeyRow { id: string; label: string; present: boolean }
export type ProviderKeyList = { ok: true; providers: ProviderKeyRow[] } | { ok: false; reason: 'providers_unknown'; message: string };

export interface HostedKeys {
  /** Stores the key (owner-checked by the caller). The value is validated (visible ASCII, 8 to 512 characters) and never returned. */
  set(provider: unknown, key: unknown): KeyResult;
  /** Deletes the stored key; idempotent. */
  delete(provider: unknown): KeyResult;
  /** Whether a key is stored for the provider: a boolean, nothing else. */
  present(provider: unknown): boolean;
  /** The providers the probe lists with their key presence; refused while the probe has not been read. */
  list(): ProviderKeyList;
  /** MAIN-INTERNAL: the key for a turn's plan, or null (none stored, unreadable, or not of the accepted shape). Never exposed over IPC. */
  resolve(provider: string): string | null;
}

export function createHostedKeys(o: {
  store: HostedSecretStore;
  /** The providers the runner's probe listed (the hosted kind's `setup.providers`), or null while unknown. */
  providers: () => readonly HostedProviderInfo[] | null | undefined;
  /** Called after a key was stored or deleted, with the provider id only (the audit row; never the key). Must not throw. */
  onChange?: (op: 'set' | 'delete', provider: string) => void;
}): HostedKeys {
  const listed = (): readonly HostedProviderInfo[] | null => {
    try { const p = o.providers(); return Array.isArray(p) && p.length > 0 ? p : null; } catch { return null; }
  };
  const changed = (op: 'set' | 'delete', provider: string): void => { try { o.onChange?.(op, provider); } catch { /* an audit row never fails a key change */ } };
  const has = (provider: string): boolean => { try { return o.store.has(hostedKeyRef(provider)); } catch { return false; } };
  return {
    set(provider, key) {
      if (!isProviderId(provider)) return refused('bad_provider');
      const ps = listed();
      if (ps === null) return refused('providers_unknown');
      if (!ps.some((p) => p.id === provider)) return refused('bad_provider');
      // Whitespace around a pasted key is dropped; anything else outside visible ASCII, or a length outside 8..512, is refused.
      const k = typeof key === 'string' && key.length <= PASTE_MAX ? key.trim() : '';
      if (!isRuntimeApiKey(k)) return refused('bad_key');
      try {
        if (!o.store.encryptionAvailable()) return refused('encryption_unavailable');
        if (!o.store.set(hostedKeyRef(provider), k).ok) return refused('store_failed');
      } catch { return refused('store_failed'); }
      changed('set', provider);
      return { ok: true };
    },
    delete(provider) {
      if (!isProviderId(provider)) return refused('bad_provider');
      try { o.store.delete(hostedKeyRef(provider)); } catch { return refused('store_failed'); }
      changed('delete', provider);
      return { ok: true };
    },
    present(provider) { return isProviderId(provider) && has(provider); },
    list() {
      const ps = listed();
      if (ps === null) return { ok: false, reason: 'providers_unknown', message: KEY_REFUSAL_TEXT.providers_unknown };
      return { ok: true, providers: ps.map((p) => ({ id: p.id, label: p.label, present: has(p.id) })) };
    },
    resolve(provider) {
      if (!isProviderId(provider)) return null;
      try {
        const v = o.store.get(hostedKeyRef(provider));
        return isRuntimeApiKey(v) ? v : null;
      } catch { return null; }
    }
  };
}

/** What an IPC payload may hold: exactly these keys, each a string (anything else is a bad request, never partly applied). */
function payloadOf(x: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  try {
    const o = x as Record<string, unknown>;
    const own = Object.keys(o);
    if (own.some((k) => !keys.includes(k))) return null;
    const out: Record<string, unknown> = {};
    for (const k of own) out[k] = o[k];
    return out;
  } catch { return null; }
}

/**
 * The key IPC the renderer's Settings panel calls (main registers one handler per method). Booleans and fixed sentences only: no method
 * ever returns a key. `authorize` is the owner check (it throws or returns false when the caller may not change keys); a payload with an
 * unknown key or a non-string value is refused whole.
 */
export function hostedKeyHandlers(o: { keys: HostedKeys; authorize: () => boolean }): {
  set(payload: unknown): KeyResult; delete(payload: unknown): KeyResult;
  present(payload?: unknown): ProviderKeyList | { ok: true; present: boolean } | KeyRefused;
} {
  const allowed = (): boolean => { try { return o.authorize() === true; } catch { return false; } };
  return {
    set(payload) {
      const p = payloadOf(payload, ['provider', 'key']);
      if (!p || typeof p.provider !== 'string' || typeof p.key !== 'string') return refused('bad_request');
      if (!allowed()) return refused('not_allowed');
      return o.keys.set(p.provider, p.key);
    },
    delete(payload) {
      const p = payloadOf(payload, ['provider']);
      if (!p || typeof p.provider !== 'string') return refused('bad_request');
      if (!allowed()) return refused('not_allowed');
      return o.keys.delete(p.provider);
    },
    present(payload) {
      if (payload === undefined || payload === null) return o.keys.list();
      const p = payloadOf(payload, ['provider']);
      if (!p || typeof p.provider !== 'string') return refused('bad_request');
      return { ok: true, present: o.keys.present(p.provider) };
    }
  };
}

/**
 * The provider and model of a turn: the user's choice (the permission's audit rows), judged against the probe's list. `ok` carries
 * what the turn's request names; otherwise the reason (`hosted_provider_not_chosen` when nothing usable is chosen,
 * `hosted_model_unavailable` when the model is not one that provider lists with tool support).
 */
export function hostedChoice(o: { providers: readonly HostedProviderInfo[] | null | undefined; chosen: { provider: string | null; model: string | null } }):
  { ok: true; provider: string; model: string } | { ok: false; reason: Extract<HostedModelReason, 'hosted_provider_not_chosen' | 'hosted_model_unavailable'> } {
  const { provider, model } = o.chosen;
  const problem = hostedChoiceProblem(o.providers, provider, model);
  return problem === null ? { ok: true, provider: provider!, model: model! } : { ok: false, reason: problem };
}
