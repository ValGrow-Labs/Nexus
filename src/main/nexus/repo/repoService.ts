/**
 * Repository snapshots and the application manifest contract (B2a Task 9).
 *
 * Snapshot requests (`requestSnapshot`, a user with `job.create` in an active participation):
 * - Authorization comes first (the stored participation), so a refusal is audited before anything is read.
 * - One live snapshot job per project: while a `repo.snapshot` job of the project is queued, leased, running, waiting
 *   for approval or scheduled for a retry, a request returns it (`created: false`) instead of starting another. The
 *   check is made again after the asynchronous folder check, right before the synchronous start, so two requests at
 *   once leave one live job.
 * - The project folder must be one main accepts (`acceptFsRoot`, else `invalid: project_folder_unavailable`) and a
 *   git repository (`isRepository`, main's own async git check; else `invalid: not_a_repository`). No job is created
 *   for a refused folder. Without a repository check in this build, or when the check reports that no git binary is
 *   installed (`'git_missing'`), the request is `unavailable` (`setup:git_missing`), never `not_a_repository`.
 * - A snapshot records `dirty` (ingest); `checkoutNote` (shared) turns it into "uncommitted changes are not included".
 *
 * The application manifest contract (`nexus.app.json`, read by the `sde.app.assemble` engine with
 * `git show <commit>:nexus.app.json`): the engine reports `{ manifest }`; main accepts it only as a plain JSON object of
 * at most 16 KiB holding nothing secret-shaped (`acceptManifestReport`); `app.manifest_schema` then judges its shape.
 * A dev deployment reads it back from the application version (`readAppManifest`); a manifest that names environment
 * variables cannot start (`previewBlocker`): secrets for dev deployments are not supported yet.
 */
import type Database from 'better-sqlite3';
import type { Principal } from '../../../shared/nexus/platform';
import { checkoutNote, snapshotFacts, type RepoSnapshotFacts } from '../../../shared/nexus/repoSnapshot';
import type { AuthService } from '../auth/authService';
import { containsSecret } from '../activity/redact';
import { PlatformError } from '../errors';
import { ProjectAccess } from '../project/projectAccess';
import { requireActiveParticipation, validateKey } from '../jobs/jobService';
import { appManifestErrors } from '../validation/normalized';

export const APP_MANIFEST_PATH = 'nexus.app.json';
export const APP_MANIFEST_MAX_BYTES = 16 * 1024;
export const SNAPSHOT_RECIPE = 'repo.snapshot';
/**
 * The token RepoService passes to the execution core's start: proof that the repository check ran. With a repository
 * check configured, the core refuses the snapshot action without it (`repository_check_required`).
 */
export const REPOSITORY_CHECKED: unique symbol = Symbol('nexus.repository-checked');
const LIVE_JOB_STATES = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'] as const;

export interface AppManifest {
  version: 1; profile: 'sde-node' | 'sde-python'; run: string[]; port: number; healthPath: string; env: string[];
  build?: { outputDir: string };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };

/**
 * The engine's report of `nexus.app.json` as main accepts it: `{ manifest: <plain JSON object> }`, the manifest at most
 * APP_MANIFEST_MAX_BYTES as JSON and free of secret-shaped values. Its schema is judged by `app.manifest_schema`.
 */
export function acceptManifestReport(normalized: unknown):
  { ok: true; manifest: Record<string, unknown> } | { ok: false; reason: 'parser_contract' | 'manifest_too_large' | 'secret_in_output' } {
  const manifest = isObj(normalized) ? normalized.manifest : undefined;
  if (!isObj(manifest)) return { ok: false, reason: 'parser_contract' };
  let text: string;
  try { text = JSON.stringify(manifest); } catch { return { ok: false, reason: 'parser_contract' }; }
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > APP_MANIFEST_MAX_BYTES) return { ok: false, reason: 'manifest_too_large' };
  if (containsSecret(manifest)) return { ok: false, reason: 'secret_in_output' };
  return { ok: true, manifest: JSON.parse(text) as Record<string, unknown> };
}

/** The manifest of an application version (inline storage), when it passes the schema; else null. */
export function readAppManifest(storageRefJson: string | null): AppManifest | null {
  const st = parse(storageRefJson);
  return manifestFromJson(isObj(st) && st.kind === 'inline' ? st.json : undefined);
}

/** A manifest object (`nexus.app.json` read from a change's own commit by main) as the manifest it is, when it passes the schema; else null. */
export function manifestFromJson(m: unknown): AppManifest | null {
  if (!isObj(m) || appManifestErrors(m).length > 0) return null;
  return { version: 1, profile: m.profile as AppManifest['profile'], run: [...(m.run as string[])], port: m.port as number,
    healthPath: m.healthPath as string, env: Array.isArray(m.env) ? [...(m.env as string[])] : [],
    ...(isObj(m.build) ? { build: { outputDir: String(m.build.outputDir) } } : {}) };
}

/** Why a dev deployment of this manifest cannot start in B2a, or null. Names are shown; values never exist. */
export function previewBlocker(m: AppManifest): { reason: 'secrets_not_supported'; message: string; names: string[] } | null {
  if (m.env.length === 0) return null;
  return { reason: 'secrets_not_supported', names: m.env.slice(0, 16),
    message: `This app needs ${m.env[0]}; secrets for dev deployments are not supported yet` };
}

/** What the repository service needs from the execution core (late-bound). */
export interface RepoExecPort {
  start(p: Principal, r: { projectId: string; workspaceId: string; actionId: string; inputs: { versionId: string; slot: string }[];
    params: Record<string, unknown>; intentId: string }, checked?: symbol): { job: { id: string; state: string }; created: boolean };
  get(p: Principal, jobId: string): { id: string; state: string };
}

export interface RepoDeps {
  auth: AuthService; now: () => number; log?: (line: string) => void;
  acceptFsRoot?: ((root: string) => string | null) | null;
  /**
   * main's own async check that a folder is a git repository (src/main/git.ts `repositoryCheck`): true, false, or
   * 'git_missing' when no git binary is installed; null: snapshots unavailable.
   */
  isRepository?: ((root: string) => Promise<boolean | 'git_missing'>) | null;
}

export interface SnapshotView extends RepoSnapshotFacts { versionId: string; status: string; note: string }

export class RepoService {
  private readonly access: ProjectAccess;
  private readonly log: (line: string) => void;
  private execPort: RepoExecPort | null = null;

  constructor(private readonly db: Database.Database, private readonly deps: RepoDeps) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
    this.log = deps.log ?? (() => {});
  }

  bindExecution(exec: RepoExecPort | null): void { this.execPort = exec; }

  private exec(): RepoExecPort {
    if (!this.execPort) throw new PlatformError('platform_unavailable', 'snapshots need the execution core', { reason: 'not_enabled' });
    return this.execPort;
  }

  /** The live snapshot job of a project, or null. */
  liveSnapshotJob(projectId: string): string | null {
    const r = this.db.prepare(`SELECT id FROM jobs WHERE project_id = ? AND recipe_id = ? AND state IN (${LIVE_JOB_STATES.map(() => '?').join(', ')})
      ORDER BY created_at, rowid LIMIT 1`).get(projectId, SNAPSHOT_RECIPE, ...LIVE_JOB_STATES) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** See the module header. Resolves with the live job (created false) or the new one. */
  async requestSnapshot(p: Principal, r: { projectId: string; workspaceId: string; intentId: string }): Promise<{ job: { id: string; state: string }; created: boolean }> {
    if (!isObj(r) || typeof r.projectId !== 'string' || typeof r.workspaceId !== 'string') throw new PlatformError('invalid', 'projectId and workspaceId are required');
    const pw = requireActiveParticipation(this.access, this.db, p, r.projectId, r.workspaceId, 'job.create');
    validateKey(r.intentId);
    const exec = this.exec();
    const live = this.liveSnapshotJob(pw.project_id);
    if (live) return { job: exec.get(p, live), created: false };
    const row = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(pw.project_id) as { root_path: string | null } | undefined;
    let root: string | null = null;
    try { root = row && typeof row.root_path === 'string' && row.root_path.length > 0 && this.deps.acceptFsRoot ? this.deps.acceptFsRoot(row.root_path) : null; } catch { root = null; }
    if (!root) throw new PlatformError('invalid', 'the project folder is not available', { reason: 'project_folder_unavailable' });
    const check = this.deps.isRepository;
    if (!check) throw new PlatformError('unavailable', 'repository checks are not available in this build', { reason: 'setup:git_missing' });
    let found: boolean | 'git_missing' = false;
    try { found = await check(root); } catch { found = false; }
    if (found === 'git_missing') throw new PlatformError('unavailable', 'git is not installed', { reason: 'setup:git_missing' });
    if (found !== true) throw new PlatformError('invalid', 'the project folder is not a git repository', { reason: 'not_a_repository' });
    // Another request may have started one while git answered: it is the answer (one live snapshot job per project).
    const again = this.liveSnapshotJob(pw.project_id);
    if (again) return { job: exec.get(p, again), created: false };
    // The user action (src/shared/nexus/actions.ts) whose one recipe is repo.snapshot.
    return exec.start(p, { projectId: pw.project_id, workspaceId: pw.workspace_id, actionId: 'sde.repository.snapshot', inputs: [], params: {},
      intentId: r.intentId }, REPOSITORY_CHECKED);
  }

  /** A repository version as the UI shows it: its commit, branch, dirty flag and the checkout note driven by `dirty`. */
  snapshotView(p: Principal, versionId: string): SnapshotView {
    const v = typeof versionId === 'string' && versionId.length > 0 ? this.db.prepare(`SELECT v.id, v.project_id, v.status, v.storage_ref_json,
        v.metadata_json, a.kind, a.owner_workspace_id FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`).get(versionId) as
      { id: string; project_id: string; status: string; storage_ref_json: string; metadata_json: string; kind: string; owner_workspace_id: string | null } | undefined
      : undefined;
    if (!v) {
      this.deps.auth.require(p, 'artifact.read', { type: 'platform' });
      throw new PlatformError('not_found', 'version not found');
    }
    this.access.require(p, v.project_id, 'artifact.read', v.owner_workspace_id ? { workspaceId: v.owner_workspace_id } : undefined);
    const facts = v.kind === 'repository' ? snapshotFacts(parse(v.storage_ref_json), parse(v.metadata_json)) : null;
    if (!facts) throw new PlatformError('invalid', 'the version is not a repository snapshot', { reason: 'not_a_snapshot' });
    return { ...facts, versionId: v.id, status: v.status, note: checkoutNote(facts) };
  }
}
