/**
 * The engine's argv for one turn (B2b Task 13), exactly the list Task 0 pinned and CR1 compares:
 *
 *   -p --output-format stream-json --verbose --input-format text
 *   --restricted --strict-mcp-config
 *   --mcp-config <dir>/mcp.json --settings <dir>/settings.json --setting-sources ""
 *   --tools Read,Edit,Write,Glob,Grep
 *   --allowedTools Read Edit Write Glob Grep mcp__nexus__<each tool>
 *   --disallowedTools Task Agent PowerShell Bash WebFetch WebSearch NotebookEdit
 *   --permission-mode dontAsk --permission-prompts none
 *   --no-session-persistence --disable-slash-commands --no-chrome
 *   --max-budget-usd <budget>
 *   [--append-system-prompt-file <dir>/skills.md]
 *
 * D-B15: there is NO `--safe-mode` (the probe proved it silently drops the Nexus MCP server). The locks that remain:
 * `--restricted`, an empty `--setting-sources`, `--strict-mcp-config`, an explicit tool list with explicit allow and
 * deny rules (the subagent tool under both of its names), and `dontAsk` so nothing waits on a prompt nobody sees.
 * No `--model`: the engine's own default is used and the model it reports is recorded opaquely (F24).
 *
 * The message, the context and the token are never in argv: the first two go on stdin, the token in the environment.
 */
import { MCP_SERVER_NAME } from './files';

export const BUILTIN_TOOLS: readonly string[] = Object.freeze(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
/** D-B15: both spellings of the subagent tool, and the shells, the network tools and the notebook editor. */
export const DISALLOWED_TOOLS: readonly string[] = Object.freeze(['Task', 'Agent', 'PowerShell', 'Bash', 'WebFetch', 'WebSearch', 'NotebookEdit']);
/** `--setting-sources` takes a comma list; the adapter loads none of user, project or local. */
export const SETTING_SOURCES_FORM = '';
/** The turn's default budget when no cap is known (D-B4: $2 per turn). */
export const DEFAULT_BUDGET_CENTS = 200;
/** The argv must stay small: the message and the context travel on stdin. */
export const ARGV_MAX_BYTES = 8 * 1024;

export interface ArgsInput {
  /** The job's config dir (`mcp.json`, `settings.json` and the optional `skills.md` live here). */
  dir: string;
  mcpJson: string;
  settingsJson: string;
  /** The Nexus MCP tool names this turn may call (without the `mcp__nexus__` prefix). */
  mcpTools: readonly string[];
  /** The turn's spend limit in cents (min of the turn cap and what is left of the day). */
  budgetCents: number;
  /** The skills file, when it exists and the build names `--append-system-prompt-file`. */
  skillsFile?: string | null;
}

/** Cents as the dollar string the flag takes (`200` -> `2`, `150` -> `1.5`). */
export function budgetUsd(cents: number): string {
  return String(Math.round(cents) / 100);
}

export function buildArgs(i: ArgsInput): string[] {
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'text',
    '--restricted', '--strict-mcp-config',
    '--mcp-config', i.mcpJson,
    '--settings', i.settingsJson,
    '--setting-sources', SETTING_SOURCES_FORM,
    '--tools', BUILTIN_TOOLS.join(','),
    '--allowedTools', ...BUILTIN_TOOLS, ...i.mcpTools.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`),
    '--disallowedTools', ...DISALLOWED_TOOLS,
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
    '--max-budget-usd', budgetUsd(i.budgetCents),
    ...(i.skillsFile ? ['--append-system-prompt-file', i.skillsFile] : [])
  ];
}

/** The turn's spend limit in cents: the smallest known cap, else the default. Zero or less means nothing may be spent. */
export function budgetCentsOf(o: { turnUsdCents?: number; dayRemainingUsdCents?: number; maxCostUsd?: number }): number {
  const caps = [o.turnUsdCents, o.dayRemainingUsdCents, typeof o.maxCostUsd === 'number' ? o.maxCostUsd * 100 : undefined]
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return caps.length > 0 ? Math.min(...caps) : DEFAULT_BUDGET_CENTS;
}
