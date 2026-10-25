/**
 * The engine-format files of one turn (B2b Task 13), written into the job's own config dir:
 *
 * - `mcp.json`: the one Nexus MCP server. The bearer is NOT in the file: the header is the literal text
 *   `Bearer ${NEXUS_MCP_TOKEN}`, which the engine expands from its own environment (Task 0, P6: it expands, and the
 *   token appears in no file under the harness root).
 * - `settings.json`: `permissions.deny` for Read, Edit and Write on the sensitive path patterns (F16: the same names as
 *   `SENSITIVE_PATH_RE`), `disableAllHooks: true`, and no `env`.
 * - `tmp/`: the engine's temporary folder (`TEMP` and `TMP`).
 *
 * `skills.md` and `context.md` are main's files in the same folder; this module only reads them.
 */
import * as path from 'node:path';
import type { RunnerFs } from '../../types';

/** The MCP server's name in the engine's config: the tool names the allow-list uses are `mcp__<name>__<tool>`. */
export const MCP_SERVER_NAME = 'nexus';
/** The environment variable the header expands. */
export const MCP_TOKEN_ENV = 'NEXUS_MCP_TOKEN';

/**
 * The deny patterns, gitignore-style, any depth: a `.git` entry (directory or file), `.env*`, `*.pem`, `id_rsa*`,
 * `*.key`, `.npmrc` and `.pypirc`. They mirror `SENSITIVE_PATH_RE` in shared/nexus/changeSet.ts.
 */
export const SENSITIVE_GLOBS: readonly string[] = Object.freeze([
  '**/.git', '**/.git/**', '**/.env*', '**/*.pem', '**/id_rsa*', '**/*.key', '**/.npmrc', '**/.pypirc'
]);
/** The file tools the deny rules cover. */
export const DENIED_FILE_TOOLS: readonly string[] = Object.freeze(['Read', 'Edit', 'Write']);

export function settingsJson(): { permissions: { deny: string[] }; disableAllHooks: true } {
  return { permissions: { deny: DENIED_FILE_TOOLS.flatMap((t) => SENSITIVE_GLOBS.map((g) => `${t}(${g})`)) }, disableAllHooks: true };
}

export function mcpJson(mcpUrl: string): { mcpServers: Record<string, { type: 'http'; url: string; headers: { Authorization: string } }> } {
  return { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` } } } };
}

export interface TurnFiles { mcpJson: string; settingsJson: string; skillsMd: string; tempDir: string }

export function turnFiles(dir: string): TurnFiles {
  return { mcpJson: path.join(dir, 'mcp.json'), settingsJson: path.join(dir, 'settings.json'), skillsMd: path.join(dir, 'skills.md'), tempDir: path.join(dir, 'tmp') };
}

/** Writes `mcp.json`, `settings.json` and the temp folder into `dir`. Throws on a write failure (the turn then fails). */
export async function writeTurnFiles(fs: RunnerFs, dir: string, mcpUrl: string): Promise<TurnFiles> {
  const f = turnFiles(dir);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(f.tempDir, { recursive: true });
  await fs.writeFile(f.mcpJson, JSON.stringify(mcpJson(mcpUrl), null, 2), 'utf8');
  await fs.writeFile(f.settingsJson, JSON.stringify(settingsJson(), null, 2), 'utf8');
  return f;
}
