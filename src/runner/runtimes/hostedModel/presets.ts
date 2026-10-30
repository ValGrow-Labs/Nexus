/**
 * The hosted-model runtime's preset table: the ONLY place a provider's name, host name, endpoint path or model name lives
 * (ruling H1: main, the renderer and every other runner file treat a provider as an opaque id taken from the probe). The table is
 * data: a provider or a model is added or changed here and nowhere else.
 *
 * Each provider is reached over HTTPS on port 443 at exactly one host name, through its chat-completions endpoint (a wire shape
 * both providers offer: messages, tools, tool_calls, usage). `quirks` hold what a provider does differently from the common shape.
 *
 * The consent a user grants covers the whole table's host list (hash-bound as for every runtime); the adapter calls only the CHOSEN
 * provider's host and refuses any other (client.ts, transport.ts).
 */

/** What one provider does differently from the common chat-completions shape. */
export interface ProviderQuirks {
  /** JSON-schema keys the provider rejects inside a tool's parameters (removed, at any depth, from the copy that is sent). */
  readonly stripSchemaKeys?: readonly string[];
  /** The provider wants the tool's name on a tool-result message as well as the call id. */
  readonly toolMessageName?: boolean;
  /** The provider answers a tool call it could not parse with this error code (and the text it tried): retried, never shown. */
  readonly badGenerationCode?: string;
  /** Error codes (in the answer's error object) that say the chosen model does not exist for this provider. */
  readonly modelMissingCodes?: readonly string[];
}

export interface ProviderPreset {
  /** The opaque id main and the renderer carry (`^[a-z][a-z0-9-]{0,31}$`). */
  readonly id: string;
  /** The display label (a setup row only). */
  readonly label: string;
  /** The one host name this provider is reached at (port 443, https). */
  readonly host: string;
  readonly port: 443;
  /** The endpoint's base path, no trailing slash; the chat call is `<basePath>/chat/completions`. */
  readonly basePath: string;
  /** The request header that carries the key, and the text before the key in its value. */
  readonly authHeader: string;
  readonly authPrefix: string;
  /** The model a user starts with (a tool-capable free-tier model). */
  readonly defaultModel: string;
  readonly models: readonly { readonly name: string; readonly tools: boolean }[];
  readonly quirks: ProviderQuirks;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  Object.freeze({
    id: 'groq',
    label: 'Groq (free API key)',
    host: 'api.groq.com',
    port: 443 as const,
    basePath: '/openai/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    defaultModel: 'llama-3.3-70b-versatile',
    models: Object.freeze([
      Object.freeze({ name: 'llama-3.3-70b-versatile', tools: true }),
      Object.freeze({ name: 'llama-3.1-8b-instant', tools: true }),
      Object.freeze({ name: 'openai/gpt-oss-20b', tools: true }),
      Object.freeze({ name: 'openai/gpt-oss-120b', tools: true })
    ]),
    quirks: Object.freeze({
      badGenerationCode: 'tool_use_failed',
      modelMissingCodes: Object.freeze(['model_not_found', 'model_decommissioned', 'model_not_active'])
    })
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Google Gemini (free API key)',
    host: 'generativelanguage.googleapis.com',
    port: 443 as const,
    basePath: '/v1beta/openai',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    defaultModel: 'gemini-2.5-flash',
    models: Object.freeze([
      Object.freeze({ name: 'gemini-2.5-flash', tools: true }),
      Object.freeze({ name: 'gemini-2.5-flash-lite', tools: true }),
      Object.freeze({ name: 'gemini-2.0-flash', tools: true })
    ]),
    quirks: Object.freeze({
      stripSchemaKeys: Object.freeze(['additionalProperties', '$schema']),
      toolMessageName: true,
      modelMissingCodes: Object.freeze(['model_not_found'])
    })
  })
]);

/** The preset with this id, or null. */
export function presetFor(id: unknown): ProviderPreset | null {
  return typeof id === 'string' ? PROVIDER_PRESETS.find((p) => p.id === id) ?? null : null;
}

/** Every host the table names, once each, port 443: the list the consent covers and the probe reports. */
export function allPresetHosts(): { host: string; port: number }[] {
  const seen = new Set<string>();
  const out: { host: string; port: number }[] = [];
  for (const p of PROVIDER_PRESETS) if (!seen.has(p.host)) { seen.add(p.host); out.push({ host: p.host, port: p.port }); }
  return out;
}

/** The providers as a probe's setup lists them (offline preset data). */
export function providerList(): { id: string; label: string; hosts: string[]; models: { name: string; tools: boolean }[] }[] {
  return PROVIDER_PRESETS.map((p) => ({ id: p.id, label: p.label, hosts: [p.host], models: p.models.map((m) => ({ name: m.name, tools: m.tools })) }));
}

/** Every model name of the table, once each (a name listed by two providers reports tool support if either does). */
export function allModels(): { name: string; tools: boolean }[] {
  const byName = new Map<string, boolean>();
  for (const p of PROVIDER_PRESETS) for (const m of p.models) byName.set(m.name, (byName.get(m.name) ?? false) || m.tools);
  return [...byName].map(([name, tools]) => ({ name, tools }));
}
