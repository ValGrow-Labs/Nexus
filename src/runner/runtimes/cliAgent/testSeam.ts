/**
 * The test seam (B2b Task 13, F3, pinned by CR0): the ONLY place that may add the model service's base URL and a key
 * to the engine's environment. The base URL points a test at a loopback mock model and the key is a fake one; nothing
 * in the production path can set either (source pin CR0: no other production file names this function or these two
 * variables). Tests use it together with the harness's fake home as `baseEnv`.
 *
 * `createCliAdapterForTests({ envOverlay, ... })` returns a function that builds one adapter per turn from the turn's
 * own options (token, MCP URL, proxy, caps, callbacks).
 */
import { CliAgentAdapter, type CliAdapterOptions } from './adapter';

/** The two names a test overlay may carry, and no others. */
export const TEST_SEAM_ENV_NAMES: readonly string[] = Object.freeze(['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']);

export interface TestSeamOptions {
  /** `ANTHROPIC_BASE_URL` (a loopback mock) and/or a fake `ANTHROPIC_API_KEY`: nothing else is accepted. */
  envOverlay: Readonly<Record<string, string>>;
  /** The harness's fake-home environment: the allow-listed names are copied from it. */
  baseEnv?: NodeJS.ProcessEnv;
  bin?: string;
  argvPrefix?: readonly string[];
}

export function createCliAdapterForTests(seam: TestSeamOptions): (turn?: Partial<CliAdapterOptions>) => CliAgentAdapter {
  for (const k of Object.keys(seam.envOverlay ?? {})) {
    if (!TEST_SEAM_ENV_NAMES.includes(k)) throw new Error(`the test seam adds only ${TEST_SEAM_ENV_NAMES.join(' and ')}, not ${k}`);
  }
  const overlay = { ...(seam.envOverlay ?? {}) };
  return (turn = {}) => new CliAgentAdapter({ ...turn, baseEnv: seam.baseEnv ?? turn.baseEnv, bin: seam.bin ?? turn.bin,
    argvPrefix: seam.argvPrefix ?? turn.argvPrefix, envOverlay: overlay });
}
