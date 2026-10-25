/**
 * The environment of the engine's process (B2b Task 13, F4): built from NOTHING, copying only the allow-listed names
 * out of `base`. Nothing else is inherited, so a runner that has `ANTHROPIC_*`, `CLAUDE_*`, `*_API_KEY`, `*_TOKEN` or
 * `NODE_EXTRA_CA_CERTS` in its own environment never hands them on. `CLAUDE_CONFIG_DIR` is never set: the engine
 * keeps using the user's own login store in place (D-B1) and Nexus never reads it.
 *
 * Network: `HTTPS_PROXY` is the turn's loopback egress proxy, there is no `HTTP_PROXY`, and `NO_PROXY=127.0.0.1` keeps
 * the Nexus MCP server (also on loopback) a direct connection. The proxy routes and records; it is not an OS firewall.
 */
import * as path from 'node:path';

/** The names copied from `base` when present. */
export const AGENT_ENV_FROM_BASE: readonly string[] = Object.freeze(['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']);
/** The names `agentEnv` always sets itself. */
export const AGENT_ENV_FIXED: Readonly<Record<string, string>> = Object.freeze({
  LANG: 'en_US.UTF-8',
  NO_PROXY: '127.0.0.1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
});

export interface AgentEnvOptions {
  /** The turn's egress proxy, `http://127.0.0.1:<port>`. Required: the engine never runs without one. */
  proxyUrl: string;
  /** The turn's bearer, as `NEXUS_MCP_TOKEN` (the MCP config expands it; it is never in argv or a file). Omitted for health runs. */
  token?: string;
  /** The engine's temporary folder (`TEMP` and `TMP`): a folder inside the job's config dir. */
  tempDir?: string;
  /** The engine's own folder, appended to PATH. */
  cliDir?: string;
}

const PROXY_RE = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;

export function agentEnv(base: NodeJS.ProcessEnv, o: AgentEnvOptions): Record<string, string> {
  if (typeof o.proxyUrl !== 'string' || !PROXY_RE.test(o.proxyUrl)) throw new Error('the agent environment needs a loopback proxy URL');
  const win = process.platform === 'win32';
  const sysRoot = String(base.SystemRoot ?? base.SYSTEMROOT ?? 'C:\\Windows');
  const env: Record<string, string> = {};
  if (win) {
    env.SystemRoot = sysRoot;
    env.windir = sysRoot;
    env.PATH = [path.win32.join(sysRoot, 'System32'), sysRoot, path.win32.join(sysRoot, 'System32', 'Wbem'), ...(o.cliDir ? [o.cliDir] : [])].join(';');
  } else {
    env.PATH = ['/usr/bin', '/bin', ...(o.cliDir ? [o.cliDir] : [])].join(':');
    if (typeof base.HOME === 'string') env.HOME = base.HOME;
  }
  for (const k of AGENT_ENV_FROM_BASE) {
    const v = base[k];
    if (typeof v === 'string' && v.length > 0 && !v.includes('\0')) env[k] = v;
  }
  const temp = o.tempDir ?? base.TEMP ?? base.TMP;
  if (typeof temp === 'string' && temp.length > 0) { env.TEMP = temp; env.TMP = temp; }
  Object.assign(env, AGENT_ENV_FIXED);
  env.HTTPS_PROXY = o.proxyUrl;
  if (typeof o.token === 'string' && o.token.length > 0) env.NEXUS_MCP_TOKEN = o.token;
  return env;
}
