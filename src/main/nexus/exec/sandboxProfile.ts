/**
 * Which sandbox profile a project's code runs in (B2b Task 16 extracted it from ExecutionService.profileFor so the change-set
 * checks use the same rule): an input's recorded `profile`, else the project's detected languages (Python only, no JavaScript or
 * TypeScript: `sde-python`), else `sde-node`. `cs.tests_pass` used to take the first profile of the discovery recipe
 * (`sde-node`) for every change set, so a Python project's change set was discovered with node's glob and never passed.
 */
import type Database from 'better-sqlite3';
import { SANDBOX_PROFILE_IDS, type SandboxProfileId } from '../../../shared/nexus/execution';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (text: string | null): unknown => { if (text === null) return null; try { return JSON.parse(text) as unknown; } catch { return null; } };

/** The profile for these input facts (the first one that records a valid `profile`), else the project's languages, else node. */
export function profileFromFacts(db: Database.Database, projectId: string, facts: { metadata: unknown }[]): SandboxProfileId {
  for (const f of facts) {
    const m = isObj(f.metadata) ? f.metadata.profile : undefined;
    if (typeof m === 'string' && (SANDBOX_PROFILE_IDS as readonly string[]).includes(m)) return m as SandboxProfileId;
  }
  const row = db.prepare('SELECT metadata_json FROM projects WHERE id = ?').get(projectId) as { metadata_json: string | null } | undefined;
  const meta = parse(row?.metadata_json ?? null);
  const langs = isObj(meta) && Array.isArray(meta.detectedLanguages) ? meta.detectedLanguages.map((x) => String(x).toLowerCase()) : [];
  if (langs.includes('python') && !langs.some((l) => l === 'javascript' || l === 'typescript')) return 'sde-python';
  return 'sde-node';
}

/** The profile of the project's repository: its newest live repository version's recorded profile, else the project's languages. */
export function projectSandboxProfile(db: Database.Database, projectId: string): SandboxProfileId {
  const row = db.prepare(`SELECT v.metadata_json FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id
    WHERE a.project_id = ? AND a.kind = 'repository' AND a.status = 'active' AND v.status IN ('candidate','active')
    ORDER BY (v.id = a.current_version_id) DESC, v.version_no DESC LIMIT 1`).get(projectId) as { metadata_json: string } | undefined;
  return profileFromFacts(db, projectId, row ? [{ metadata: parse(row.metadata_json) }] : []);
}
