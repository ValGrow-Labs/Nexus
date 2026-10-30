// The hosted-model runtime kind (neutral names only): its kind id, the shape of a provider id, the providers a probe lists, the
// reasons it refuses a start for, and how a failed turn's fixed runner sentence maps to one of those reasons. Pure; shared by main
// (settings, plan, consent, views) and the renderer. Provider ids, their hosts and their model names come from the runner's probe
// entry (`setup.providers`) and are opaque here: nothing in this file names a provider.
import type { RuntimeModelInfo } from './localModel';

/** The runtime kind id of the hosted-model runtime. */
export const HOSTED_MODEL_KIND = 'hosted-model';

/** A provider id as the probe lists one: short, lowercase, opaque. */
export const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const isProviderId = (x: unknown): x is string => typeof x === 'string' && PROVIDER_ID_RE.test(x);

/** One provider as the runner's probe lists it (offline preset data). */
export interface HostedProviderInfo { id: string; label: string; hosts: string[]; models: RuntimeModelInfo[] }

/** The reasons the hosted-model runtime refuses a start for or fails a turn with (each has a fixed sentence in main and in the renderer). */
export const HOSTED_MODEL_REASONS = ['hosted_provider_not_chosen', 'hosted_key_missing', 'hosted_key_rejected', 'hosted_rate_limited',
  'hosted_quota_exhausted', 'hosted_model_unavailable'] as const;
export type HostedModelReason = (typeof HOSTED_MODEL_REASONS)[number];
export const isHostedReason = (x: unknown): x is HostedModelReason => typeof x === 'string' && (HOSTED_MODEL_REASONS as readonly string[]).includes(x);

/**
 * The sentences the hosted-model runner reports a failed turn with (its `run.failed` message), mapped to the reason main records as
 * the turn's outcome. The runner's own file (src/runner/runtimes/hostedModel/messages.ts) holds the words; a test compares them.
 * A message that is none of these keeps the generic outcome of its code.
 */
export const HOSTED_RUNNER_MESSAGE_REASON: Readonly<Record<string, HostedModelReason>> = Object.freeze({
  'no API key was given for this turn': 'hosted_key_missing',
  'the model provider rejected the API key': 'hosted_key_rejected',
  'the model provider is rate limiting requests and the turn ran out of time to wait': 'hosted_rate_limited',
  'the free quota of the model provider is used up for now': 'hosted_quota_exhausted',
  'the chosen model is not available from the model provider': 'hosted_model_unavailable',
  'this runtime needs a model provider and a model to be chosen': 'hosted_provider_not_chosen'
});

/** The reason a hosted turn's `run.failed` message stands for, or null. */
export function hostedReasonOfMessage(message: unknown): HostedModelReason | null {
  return typeof message === 'string' && Object.prototype.hasOwnProperty.call(HOSTED_RUNNER_MESSAGE_REASON, message) ? HOSTED_RUNNER_MESSAGE_REASON[message] : null;
}

/**
 * Why a chosen provider and model cannot be used, from the providers a probe listed: `hosted_provider_not_chosen` when none is chosen
 * or it is not listed, `hosted_model_unavailable` when the model is not one of that provider's (or cannot use tools); null when usable.
 * (A missing key is main's own knowledge, not the probe's.)
 */
export function hostedChoiceProblem(providers: readonly HostedProviderInfo[] | null | undefined, provider: string | null, model: string | null):
  'hosted_provider_not_chosen' | 'hosted_model_unavailable' | null {
  if (provider === null || model === null) return 'hosted_provider_not_chosen';
  const list: readonly HostedProviderInfo[] = Array.isArray(providers) ? (providers as readonly HostedProviderInfo[]) : [];
  const p = list.find((x: HostedProviderInfo) => x.id === provider);
  if (!p) return 'hosted_provider_not_chosen';
  const m = p.models.find((x: RuntimeModelInfo) => x.name === model);
  return m && m.tools ? null : 'hosted_model_unavailable';
}


/**
 * An API key as a person pastes it and as it travels (`plan.runtime.apiKey`): visible ASCII, no space, 8 to 512 characters. The same rule as
 * the runner protocol's `isRuntimeApiKey` (a test compares them); kept here so the renderer's Settings panel needs no protocol code.
 */
export const API_KEY_RE = /^[\x21-\x7e]{8,512}$/;
export const isApiKeyShape = (x: unknown): x is string => typeof x === 'string' && API_KEY_RE.test(x);
