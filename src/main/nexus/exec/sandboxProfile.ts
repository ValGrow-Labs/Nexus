/**
 * Which sandbox profile a project's code runs in (B2b Task 16 extracted it from ExecutionService.profileFor so the change-set
 * checks use the same rule): an input's recorded `profile`, else the project's detected languages (Python only, no JavaScript or
 * TypeScript: `sde-python`), else `sde-node`. `cs.tests_pass` used to take the first profile of the discovery recipe
 * (`sde-node`) for every change set, so a Python project's change set was discovered with node's glob and never passed.
 *
 * The machine learning kit (`ml-python`): a project whose primary kind of work is Machine learning (its primary participation is the
 * `ml` workspace) runs what would run in `sde-python` in `ml-python` instead: the same Python and tools plus the locked ML packages,
 * offline, the same for every ML project. A Python project of any other kind keeps `sde-python`. The AI helper's own container of an
 * ML project is `ml-python` too, also when the repository has no language yet (a new project, a dataset only); only a repository
 * recorded or detected as JavaScript or TypeScript keeps the helper in `sde-node`.
 */
import type Database from 'better-sqlite3';
import { SANDBOX_PROFILE_IDS, type SandboxProfileId } from '../../../shared/nexus/execution';

/** The workspace id of the Machine learning domain (src/shared/nexus/domains/ml.ts). */
export const ML_WORKSPACE_ID = 'ml';
/** The machine learning kit: on demand, needed only on a computer with a Machine learning project. */
export const ML_PROFILE: SandboxProfileId = 'ml-python';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (text: string | null): unknown => { if (text === null) return null; try { return JSON.parse(text) as unknown; } catch { return null; } };

/** Whether the project's primary kind of work is Machine learning (its primary participation, always active, is the `ml` workspace). */
export function isMachineLearningProject(db: Database.Database, projectId: string): boolean {
  try {
    const row = db.prepare('SELECT workspace_id AS w FROM project_workspaces WHERE project_id = ? AND is_primary = 1 LIMIT 1').get(projectId) as { w?: unknown } | undefined;
    return row?.w === ML_WORKSPACE_ID;
  } catch { return false; }
}

/** Whether any project on this computer is a Machine learning project (the machine learning kit is then part of getting ready). */
export function anyMachineLearningProject(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT workspace_id AS w FROM project_workspaces WHERE workspace_id = ? AND is_primary = 1 LIMIT 1').get(ML_WORKSPACE_ID) as { w?: unknown } | undefined;
    return row?.w === ML_WORKSPACE_ID;
  } catch { return false; }
}

/** The profile before the machine learning rule, and where it came from. */
function baseProfile(db: Database.Database, projectId: string, facts: { metadata: unknown }[]): { profile: SandboxProfileId; from: 'recorded' | 'languages' | 'default' } {
  for (const f of facts) {
    const m = isObj(f.metadata) ? f.metadata.profile : undefined;
    if (typeof m === 'string' && (SANDBOX_PROFILE_IDS as readonly string[]).includes(m)) return { profile: m as SandboxProfileId, from: 'recorded' };
  }
  const row = db.prepare('SELECT metadata_json FROM projects WHERE id = ?').get(projectId) as { metadata_json: string | null } | undefined;
  const meta = parse(row?.metadata_json ?? null);
  // `detectedLanguages` is what the project scanner stores: ProjectLanguageStat OBJECTS `{ language, fileCount, extension }`
  // (shared/project.ts); a bare language string is accepted too. String(object) is "[object Object]", never a language.
  const langs = isObj(meta) && Array.isArray(meta.detectedLanguages)
    ? meta.detectedLanguages.map((x: unknown) => (typeof x === 'string' ? x : isObj(x) && typeof x.language === 'string' ? x.language : '').toLowerCase()).filter((x: string) => x.length > 0)
    : [];
  // The scanner's names include "TypeScript (React)" and "JavaScript (React)": any JavaScript or TypeScript variant keeps the node profile.
  const scripts = langs.some((l: string) => l.startsWith('javascript') || l.startsWith('typescript'));
  if (langs.includes('python') && !scripts) return { profile: 'sde-python', from: 'languages' };
  return { profile: 'sde-node', from: scripts ? 'languages' : 'default' };
}

/** A run's profile in this project: `sde-python` becomes the machine learning kit in a Machine learning project; anything else is kept. */
export function forProject(db: Database.Database, projectId: string, profile: SandboxProfileId): SandboxProfileId {
  return profile === 'sde-python' && isMachineLearningProject(db, projectId) ? ML_PROFILE : profile;
}

/** The profile for these input facts (the first one that records a valid `profile`), else the project's languages, else node; then the ML rule. */
export function profileFromFacts(db: Database.Database, projectId: string, facts: { metadata: unknown }[]): SandboxProfileId {
  return forProject(db, projectId, baseProfile(db, projectId, facts).profile);
}

/**
 * The AI helper's own container: the run profile, except that in a Machine learning project it is the machine learning kit unless the
 * repository is recorded or detected as JavaScript or TypeScript (an empty or language-less ML project gets the ML kit, not node).
 */
export function agentProfileFromFacts(db: Database.Database, projectId: string, facts: { metadata: unknown }[]): SandboxProfileId {
  const b = baseProfile(db, projectId, facts);
  if (!isMachineLearningProject(db, projectId)) return b.profile;
  return b.profile === 'sde-python' || (b.profile === 'sde-node' && b.from === 'default') ? ML_PROFILE : b.profile;
}

/** The profile of the project's repository: its newest live repository version's recorded profile, else the project's languages. */
export function projectSandboxProfile(db: Database.Database, projectId: string): SandboxProfileId {
  const row = db.prepare(`SELECT v.metadata_json FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id
    WHERE a.project_id = ? AND a.kind = 'repository' AND a.status = 'active' AND v.status IN ('candidate','active')
    ORDER BY (v.id = a.current_version_id) DESC, v.version_no DESC LIMIT 1`).get(projectId) as { metadata_json: string } | undefined;
  return profileFromFacts(db, projectId, row ? [{ metadata: parse(row.metadata_json) }] : []);
}
