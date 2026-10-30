import { statSync } from 'node:fs';
import * as path from 'node:path';
import type { HarnessConfig } from './config';
import { isAgentProvider, providerPreset, type AgentProvider } from '../shared/agentProvider';
import { expandTilde } from './fs';
import { MODEL_VALUE, autoFlagBlocked, classifySpawn, shrinkTrustedEngines, tokenizeCommandLine } from './spawnPolicy';

/**
 * Which config keys the renderer may change through `config:update` (O.9 #22),
 * and how. Pure, so every rule is unit-tested (test/nexus-config-hardening).
 *
 *  - renderer:    applied directly; some values are validated (see below);
 *  - confirm:     security-relevant; applied only after a main-process dialog
 *                 (or directly when the change cannot hurt, e.g. turning auto
 *                 mode OFF or closing a tunnel);
 *  - secret:      routed to the encrypted store, never written as plaintext
 *                 when secure storage works; '' means "unchanged", null removes;
 *  - shrink-only: entries may be removed, never added;
 *  - internal:    main-only; the renderer can never write it.
 */
export type KeyPolicy = 'renderer' | 'confirm' | 'secret' | 'internal' | 'shrink-only';

export type SecretField = 'slackSigningSecret' | 'slackBotToken' | 'groqApiKey' | 'webhookSecret';

/** Exhaustive: tsc fails if a new HarnessConfig key is not classified here. */
export const CONFIG_KEY_POLICY: Record<keyof HarnessConfig, KeyPolicy> = {
  // ── renderer-editable (Settings, onboarding, Agents page) ──────────────────
  onboardingComplete: 'renderer',     // validated: true only, once
  audience: 'renderer',
  registeredRepos: 'renderer',        // validated: additions must be existing folders
  autoModeReviewedV1: 'renderer',     // the auto mode banner's answer
  serverPostureNoticeV1: 'renderer',  // validated: false only (dismiss the notice)
  defaultModel: 'renderer',           // validated: a model id
  godProvider: 'renderer',            // validated: a provider id (lead engine picker)
  godModel: 'renderer',               // validated: a model id (lead engine picker)
  leadAutoStart: 'renderer',          // validated: a boolean (the wizard's engine-step choice)
  mcpDefaults: 'renderer',
  semanticMemory: 'renderer',
  embeddingModel: 'renderer',
  missions: 'renderer',
  costCapUsd: 'renderer',
  costCapTokens: 'renderer',
  agentTokenCaps: 'renderer',
  autoDeliveryPausedAgents: 'renderer',
  maxTurns: 'renderer',
  maxConcurrentWorkers: 'renderer',
  workerIdleTimeoutMinutes: 'renderer',
  defaultWorkerTokenCap: 'renderer',
  circuitBreaker: 'renderer',
  knowledgeGraph: 'renderer',
  notifications: 'renderer',
  strongKeepalive: 'renderer',
  autoUpdate: 'renderer',
  multiWindow: 'renderer',
  terminalTheme: 'renderer',
  telemetryEnabled: 'renderer',
  tvShowOffices: 'renderer',
  officeTheme: 'renderer',
  providerDefaultModels: 'renderer',
  slackEnabled: 'renderer',
  slackChannelId: 'renderer',
  slackProactivePosting: 'renderer',
  freeflowModel: 'renderer',
  realtimeIdleDisconnectMs: 'renderer',
  webhookEnabled: 'renderer',
  reflectEnabled: 'renderer',
  reflectIntervalMs: 'renderer',
  reflectByteTriggerPct: 'renderer',
  reflectSectionTrigger: 'renderer',
  reflectRecentKeep: 'renderer',
  reflectMinBytes: 'renderer',
  // ── main-process confirmation ──────────────────────────────────────────────
  autoMode: 'confirm',                // off → on only
  harnessHome: 'confirm',
  defaultCommand: 'confirm',          // unless it classifies as a preset CLI
  slackPort: 'confirm',
  webhookPort: 'confirm',
  slackPublicTunnel: 'confirm',       // turning on only
  webhookPublicTunnel: 'confirm',     // turning on only
  freeflowEnabled: 'confirm',         // microphone: the first time it turns on
  realtimeVoiceEnabled: 'confirm',    // microphone: the first time it turns on
  providerBaseUrls: 'confirm',        // a new/changed host receives the BYOK key
  // ── secrets (encrypted store) ──────────────────────────────────────────────
  slackSigningSecret: 'secret',
  slackBotToken: 'secret',
  groqApiKey: 'secret',
  webhookSecret: 'secret',
  // ── allowed engines: removals only ─────────────────────────────────────────
  trustedEngineCommands: 'shrink-only',
  // ── main-only ──────────────────────────────────────────────────────────────
  recentHives: 'internal',            // maintained by writeConfig on a home change
  opsStandupSeeded: 'internal',
  heartbeatSeeded: 'internal',
  compactMaintenanceSeeded: 'internal',
  integrations: 'internal',           // integrations:* IPC (validated records)
  contextTrigger: 'internal',         // triggers:setContext (clamped)
  webhookTriggers: 'internal',        // webhooks:* IPC (secrets, sanitised)
  orgTrigger: 'internal',             // org:setTrigger (secret)
  triggersMigratedV1: 'internal',
  secretsMigratedV1: 'internal',
  serverPostureV1: 'internal',
  micConfirmedFreeflowV1: 'internal',
  micConfirmedRealtimeV1: 'internal'
};

const SECRET_FIELD_SET = new Set<string>(['slackSigningSecret', 'slackBotToken', 'groqApiKey', 'webhookSecret']);

/** Shell syntax and control characters: never part of an engine command line. */
const SHELL_SYNTAX = /[&|;<>^%$`!\r\n\0]/;

export const DEFAULT_SLACK_PORT = 3847;
export const DEFAULT_WEBHOOK_PORT = 3849;

export interface ConfigPatchClassification {
  apply: Partial<HarnessConfig>;
  confirm: Array<{ key: keyof HarnessConfig; value: unknown }>;
  secrets: Array<{ field: SecretField; value: string | null }>;
  rejected: string[];
}

/** Injected file-system check (tests pass a fake). */
export interface PolicyEnv {
  isDirectory(p: string): boolean;
}

const realEnv: PolicyEnv = {
  isDirectory(p: string): boolean {
    try { return statSync(p).isDirectory(); } catch { return false; }
  }
};

function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/** A folder string compared the way the registered list stores it. */
function repoKey(p: string): string {
  const abs = expandTilde(p.trim());
  return process.platform === 'win32' ? path.win32.normalize(abs).toLowerCase() : path.normalize(abs);
}

/**
 * Registered folders: removals and re-ordering always apply; an ADDITION must
 * be an absolute, existing directory (what the folder picker returns). A UNC
 * path is never stat'ed from a renderer-supplied string (no SMB lookup).
 * Returns the accepted list and whether something was dropped.
 */
export function filterRegisteredRepos(proposed: unknown, current: readonly string[] | undefined, env: PolicyEnv = realEnv): { list: string[] | null; dropped: boolean } {
  if (!Array.isArray(proposed)) return { list: null, dropped: true };
  const have = new Set((Array.isArray(current) ? current : []).filter((r) => typeof r === 'string').map(repoKey));
  const out: string[] = [];
  let dropped = false;
  for (const r of proposed) {
    if (typeof r !== 'string' || !r.trim()) { dropped = true; continue; }
    if (have.has(repoKey(r))) { out.push(r); continue; }
    const abs = expandTilde(r.trim());
    const ok = (path.win32.isAbsolute(abs) || path.posix.isAbsolute(abs)) && !isUncPath(abs) && env.isDirectory(abs);
    if (ok) out.push(r); else dropped = true;
  }
  return { list: out, dropped };
}

function validPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
}

function validModel(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (typeof v === 'string' && MODEL_VALUE.test(v));
}

/**
 * Split a renderer patch by policy. Nothing in `confirm` is applied until the
 * user says yes in main's dialog; nothing in `rejected` is ever applied.
 */
export function classifyConfigPatch(
  patch: Record<string, unknown>,
  current: HarnessConfig,
  env: PolicyEnv = realEnv
): ConfigPatchClassification {
  const out: ConfigPatchClassification = { apply: {}, confirm: [], secrets: [], rejected: [] };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  const apply = out.apply as Record<string, unknown>;
  const onboarding = current.onboardingComplete === false;

  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (!Object.prototype.hasOwnProperty.call(CONFIG_KEY_POLICY, key)) { out.rejected.push(key); continue; }
    const k = key as keyof HarnessConfig;
    const policy = CONFIG_KEY_POLICY[k];

    if (policy === 'internal') { out.rejected.push(key); continue; }

    if (policy === 'secret') {
      if (value === undefined || value === '') continue;            // "unchanged"
      if (value === null) { out.secrets.push({ field: key as SecretField, value: null }); continue; }
      if (typeof value === 'string' && value.trim()) { out.secrets.push({ field: key as SecretField, value: value.trim() }); continue; }
      if (typeof value === 'string') continue;                       // whitespace = unchanged
      out.rejected.push(key);
      continue;
    }

    if (policy === 'shrink-only') {
      const have = Array.isArray(current.trustedEngineCommands) ? current.trustedEngineCommands : [];
      if (!Array.isArray(value) || value.some((c) => typeof c !== 'string' || !have.includes(c))) { out.rejected.push(key); continue; }
      apply[key] = shrinkTrustedEngines(value, have);
      continue;
    }

    if (k === 'providerBaseUrls') {
      // Per entry: unchanged and removed entries apply; each new or changed
      // host waits for its own dialog (the provider's BYOK key goes there).
      const r = classifyBaseUrls(value, current.providerBaseUrls);
      if (!r) { out.rejected.push(key); continue; }
      apply[key] = r.base;
      for (const c of r.changed) out.confirm.push({ key: k, value: c });
      continue;
    }

    if (policy === 'confirm') {
      const verdict = classifyConfirmKey(k, value, current, onboarding);
      if (verdict === 'reject') out.rejected.push(key);
      else if (verdict === 'apply') {
        apply[key] = value;
        // Onboarding's own choice of auto mode counts as the review.
        if (k === 'autoMode' && value === true) apply.autoModeReviewedV1 = true;
      } else if (verdict === 'confirm') out.confirm.push({ key: k, value });
      continue;
    }

    // renderer
    switch (k) {
      case 'onboardingComplete':
        // Onboarding is the explicit-choice UI; it must not be re-opened from
        // the renderer to change home or auto mode without a dialog.
        if (value === true || (value === false && onboarding)) apply[key] = value;
        else out.rejected.push(key);
        break;
      case 'registeredRepos': {
        const r = filterRegisteredRepos(value, current.registeredRepos, env);
        if (r.list) apply[key] = r.list;
        if (r.dropped) out.rejected.push(key);
        break;
      }
      case 'godProvider':
        if (isAgentProvider(value)) apply[key] = value; else out.rejected.push(key);
        break;
      case 'godModel':
      case 'defaultModel':
        // '' / null mean "unset" (the CLI or preset default).
        if (validModel(value)) apply[key] = value === '' || value === null ? undefined : value; else out.rejected.push(key);
        break;
      case 'autoModeReviewedV1':
      case 'leadAutoStart':
        if (typeof value === 'boolean') apply[key] = value; else out.rejected.push(key);
        break;
      case 'serverPostureNoticeV1':
        // Only main sets the notice; the renderer can only dismiss it.
        if (value === false) apply[key] = false; else out.rejected.push(key);
        break;
      default:
        apply[key] = value;
    }
  }
  return out;
}

/** One base-URL change awaiting confirmation. */
export interface BaseUrlChange { provider: AgentProvider; url: string }

function isHttpUrl(v: string): boolean {
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

/**
 * Split a proposed providerBaseUrls map: `base` is the current map with
 * removals and unchanged entries applied (changed entries keep their current
 * value); `changed` lists every new or changed host. null = malformed.
 */
export function classifyBaseUrls(
  proposed: unknown,
  current: Partial<Record<AgentProvider, string>> | undefined
): { base: Partial<Record<AgentProvider, string>>; changed: BaseUrlChange[] } | null {
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) return null;
  const cur = current && typeof current === 'object' ? current : {};
  const base: Partial<Record<AgentProvider, string>> = {};
  const changed: BaseUrlChange[] = [];
  const entries = Object.entries(proposed as Record<string, unknown>);
  for (const [prov, raw] of entries) {
    if (!isAgentProvider(prov)) return null;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return null;
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) continue;                                   // removal
    if (!isHttpUrl(v)) return null;
    if (v === cur[prov]) { base[prov] = v; continue; }  // unchanged
    changed.push({ provider: prov, url: v });
    if (typeof cur[prov] === 'string') base[prov] = cur[prov];  // kept until confirmed
  }
  return { base, changed };
}

type ConfirmVerdict = 'apply' | 'confirm' | 'reject' | 'skip';

function classifyConfirmKey(k: keyof HarnessConfig, value: unknown, current: HarnessConfig, onboarding: boolean): ConfirmVerdict {
  switch (k) {
    case 'autoMode':
      if (typeof value !== 'boolean') return 'reject';
      if (value === false || current.autoMode === true || onboarding) return 'apply';
      return 'confirm';
    case 'harnessHome':
      if (typeof value !== 'string' || !value.trim()) return 'reject';
      if (onboarding || value === current.harnessHome) return 'apply';
      return 'confirm';
    case 'defaultCommand': {
      if (typeof value !== 'string' || !value.trim()) return 'reject';
      if (value === current.defaultCommand) return 'skip';
      // Shell syntax is never an engine command line (O.9 #6), dialog or not.
      if (SHELL_SYNTAX.test(value)) return 'reject';
      const toks = tokenizeCommandLine(value.trim());
      if (toks.length === 0) return 'reject';
      // Auto mode off: the default command may not carry a bypass flag; auto
      // mode alone decides that flag (B0a final review, finding 1b).
      if (autoFlagBlocked(toks[0], toks.slice(1), { autoMode: current.autoMode })) return 'reject';
      // Option B: a provider preset CLI with only allow-listed flags is no
      // escalation; anything else is shown in full in the dialog.
      const v = classifySpawn(toks[0], toks.slice(1), {
        autoMode: current.autoMode, trustedEngineCommands: current.trustedEngineCommands
      });
      if (v.ok) return 'apply';
      return v.reason === 'needs-confirmation' ? 'confirm' : 'reject';
    }
    case 'slackPort':
    case 'webhookPort': {
      if (value === undefined || value === null) return 'apply';    // back to the default port
      if (!validPort(value)) return 'reject';
      const fallback = k === 'slackPort' ? DEFAULT_SLACK_PORT : DEFAULT_WEBHOOK_PORT;
      const cur = validPort(current[k]) ? current[k] : fallback;
      return value === cur ? 'apply' : 'confirm';
    }
    case 'slackPublicTunnel':
    case 'webhookPublicTunnel':
      if (typeof value !== 'boolean') return 'reject';
      return value === false || current[k] === true ? 'apply' : 'confirm';
    case 'freeflowEnabled':
      if (typeof value !== 'boolean') return 'reject';
      return value === false || current.freeflowEnabled === true || current.micConfirmedFreeflowV1 === true ? 'apply' : 'confirm';
    case 'realtimeVoiceEnabled':
      if (typeof value !== 'boolean') return 'reject';
      return value === false || current.realtimeVoiceEnabled === true || current.micConfirmedRealtimeV1 === true ? 'apply' : 'confirm';
    default:
      return 'reject';
  }
}

/** What a confirmed key writes: the value, plus the latch that remembers the
 *  user's answer where there is one. */
export function confirmedPatch(key: keyof HarnessConfig, value: unknown, base: Partial<HarnessConfig> = {}): Partial<HarnessConfig> {
  if (key === 'providerBaseUrls') {
    // One confirmed host, merged onto what this patch already applies.
    const c = value as BaseUrlChange;
    return { providerBaseUrls: { ...(base.providerBaseUrls ?? {}), [c.provider]: c.url } };
  }
  const p: Record<string, unknown> = { [key]: value };
  if (key === 'autoMode' && value === true) p.autoModeReviewedV1 = true;
  if (key === 'freeflowEnabled' && value === true) p.micConfirmedFreeflowV1 = true;
  if (key === 'realtimeVoiceEnabled' && value === true) p.micConfirmedRealtimeV1 = true;
  return p as Partial<HarnessConfig>;
}

/** Whether a key is one of the four config secrets. */
export function isSecretField(key: string): key is SecretField {
  return SECRET_FIELD_SET.has(key);
}

/** Main-process dialog copy for each confirm key. */
export function confirmPrompt(key: keyof HarnessConfig, value: unknown): { message: string; detail: string; confirmLabel: string } {
  switch (key) {
    case 'autoMode':
      return {
        message: 'Turn on auto mode?',
        detail: 'Agents will skip their CLI approval prompts: they can run commands and change files in their folders without asking you first. You can turn it off again in Settings.',
        confirmLabel: 'Turn on auto mode'
      };
    case 'harnessHome':
      return {
        message: `Change the Nexus home folder to ${String(value)}?`,
        detail: 'Agents, memory and tasks live in the home folder. Nexus relaunches after the change.',
        confirmLabel: 'Change folder'
      };
    case 'defaultCommand':
      return {
        message: `Use “${String(value)}” to start agents?`,
        detail: 'Every new agent will run this program. Only continue if you trust it.',
        confirmLabel: 'Use this program'
      };
    case 'slackPort':
    case 'webhookPort':
      return {
        message: `Change the ${key === 'slackPort' ? 'Slack' : 'webhook'} port to ${String(value)}?`,
        detail: 'Callers must use the new port. Nexus restarts the server.',
        confirmLabel: 'Change port'
      };
    case 'slackPublicTunnel':
    case 'webhookPublicTunnel':
      return {
        message: `Open a public tunnel for ${key === 'slackPublicTunnel' ? 'Slack' : 'webhooks'}?`,
        detail: `Nexus will ask tunnelmole for a public URL that forwards to this computer. Anyone with the URL can send requests; each request is still checked (${key === 'slackPublicTunnel' ? "Slack's signature" : "the webhook's secret"}). You can turn it off in Settings → Connections.`,
        confirmLabel: 'Open tunnel'
      };
    case 'freeflowEnabled':
      return {
        message: 'Let Free Flow use the microphone?',
        detail: 'While you hold the talk key, Free Flow records your voice and sends the audio to Groq for transcription. You can turn it off in Settings.',
        confirmLabel: 'Allow microphone'
      };
    case 'realtimeVoiceEnabled':
      return {
        message: 'Let realtime voice use the microphone?',
        detail: 'During a voice session your microphone audio streams to OpenAI. Nexus asks once; you can stop any session at any time.',
        confirmLabel: 'Allow microphone'
      };
    case 'providerBaseUrls': {
      const c = value as BaseUrlChange;
      let label: string = c.provider;
      try { label = providerPreset(c.provider).label || c.provider; } catch { /* id */ }
      let host = c.url;
      try { host = new URL(c.url).host; } catch { /* raw */ }
      return {
        message: `Send your ${label} key to ${host}?`,
        detail: `${label} agents will send their API key and prompts to ${c.url}. Only continue if you trust this server.`,
        confirmLabel: 'Use this server'
      };
    }
    default:
      return { message: `Change ${String(key)}?`, detail: '', confirmLabel: 'Change' };
  }
}
