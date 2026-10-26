/**
 * Artifacts and their immutable versions.
 *
 * - Ownership. An artifact belongs to the ACTIVE participation of (project,
 *   workspace) that exists when it is created; the participation is resolved here,
 *   never taken from the caller. Only that participation appends versions (the
 *   database enforces it in tr_versions_insert). A withdrawn owner freezes its
 *   artifacts: register, edit, discard and promote refuse with
 *   'participation_inactive'. The engine's finalize may still close a frozen draft
 *   as 'failed', but finalizing it to 'candidate' is 'participation_inactive' too.
 *   `repository` (project-owned) is refused until B1.
 * - Producers. A producing job or session must exist ('not_found'), be in the
 *   artifact's project and act for the artifact's OWNER participation ('invalid'
 *   otherwise), and not be terminal ('conflict'). With a job, every input must be
 *   granted to it as the same (version, role) in job_inputs, else
 *   'input_not_granted' with one denied activity row (AuthService.auditDenial, so
 *   it survives a caller's rollback). A repeated (job, clientKey) returns the stored
 *   version when the content hash matches and is a 'conflict' when it does not.
 * - Authority. Every operation on an existing artifact or version authorizes with
 *   the workspace of the STORED owner participation (artifacts.owner_workspace_id),
 *   never a workspace named by the caller (see ProjectAccess). Authorization runs
 *   BEFORE any transaction is opened, so a denial is audited at once in its own
 *   transaction. An unknown id is 'not_found' only for a principal authorized for
 *   the action at platform scope; anyone else gets 'denied'.
 * - Versions. version_no is COALESCE(MAX)+1 inside BEGIN IMMEDIATE, so concurrent
 *   writers serialise; UNIQUE(artifact_id, version_no) is the backstop. Content is
 *   editable only while draft (F.7); the database rejects any later change.
 * - Promotion is compare-and-set on artifacts.current_version_id, in one IMMEDIATE
 *   transaction: activate the version, move the pointer, deprecate the previous
 *   active version(s). Every kind is single-active until the kind registry exists.
 * - Secrets. A name, description, metadata or ioContract holding anything
 *   secret-shaped is refused before any transaction ('invalid', reason
 *   'secret_in_metadata'). Inline storage content is product data and is not checked.
 * - Each mutation writes exactly one activity row in its own transaction. Every
 *   transaction runs through immediateTx, so a lock held past busy_timeout surfaces
 *   as 'platform_unavailable'.
 * - B1. The writes are built from in-transaction helpers (insertArtifactTx,
 *   insertVersionTx, setStatusTx, promoteTx) that authorize nothing and write the same
 *   rows as before. saveUserVersion composes them: a user save of a new artifact is the
 *   artifact, version 1 and both activity rows in ONE transaction (no empty artifact),
 *   deduplicated by content hash. markReady is finalize performed by the system
 *   principal on the user's behalf (C4), only for drafts no job or session produced.
 *   listForReader filters cross-project rows with a read-only authorize (no audit rows).
 * - B2a. `saveInline` saves the user-authorable inline kinds (requirement, problem_statement) with
 *   their register validators recorded by the system, in one transaction. `insertSystemVersionTx`
 *   (@internal, system only, ingest only) writes job-made drafts with blob/tree storage and the
 *   project-owned repository; the public create and registerVersion are unchanged.
 */
import type Database from 'better-sqlite3';
import type {
  Artifact, ArtifactId, ArtifactSummary, ArtifactVersion, JobId, LineageRelation, PlatformAction, Principal, ProjectId,
  SessionId, StorageRef, VersionId, VersionInput, VersionStatus, WorkspaceId
} from '../../../shared/nexus/platform';
import type { AuthService } from '../auth/authService';
import { PrincipalResolver, requireStoredUser } from '../auth/principals';
import { containsSecret, redactText } from '../activity/redact';
import { appendActivityRow } from '../activity/writer';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { isKnownRelation, writeEdges, type EdgeSpec } from '../lineage/edgeWriter';
import { ProjectAccess } from '../project/projectAccess';
import { assertExactJson, contentHashOf, INLINE_MAX_BYTES, validateStorage } from './versionRules';
import { getDomain } from '../../../shared/nexus/domains';
import { requirementErrors } from '../validation/validators/reqSchema';
import { problemErrors } from '../validation/validators/problemSchema';

export interface CreateArtifactInput {
  projectId: ProjectId; workspaceId: WorkspaceId; kind: string; name: string; description?: string; metadata?: Record<string, unknown>;
}
export interface RegisterVersionInput {
  artifactId: ArtifactId; storage: StorageRef; metadata?: unknown; ioContract?: unknown;
  inputs?: (VersionInput & { relation?: LineageRelation })[];
  producedByJobId?: JobId; producedBySessionId?: SessionId;
  clientKey?: string; action?: string;
}
/** One input of an ingested version: the edge source says whether it was granted to the job or found by ingest. */
export interface SystemVersionInput {
  artifactId?: ArtifactId;
  /** A new artifact in the same transaction: owned by `participation`, or (null) the project's one `repository`. */
  newArtifact?: { kind: string; name: string; participation: string | null };
  storage: StorageRef; contentHash: string; metadata: unknown; environment: unknown | null;
  jobId: JobId; attemptN?: number | null; outputPath: string | null; action: string | null; onBehalfOf: string;
  inputs: { versionId: VersionId; role: string; relation?: LineageRelation; source: 'job_input' | 'ingest' }[];
  now: number;
}
/** The user-authorable inline kinds of B2a and their schema checks (the register validators' own rules). */
const INLINE_KINDS = Object.freeze({
  requirement: { action: 'user.save_requirement', errors: requirementErrors },
  problem_statement: { action: 'user.save_problem', errors: problemErrors }
});
export type InlineKind = keyof typeof INLINE_KINDS;
export interface SaveInlineInput {
  projectId: ProjectId; workspaceId: WorkspaceId; kind: InlineKind; target: SaveTarget; content: unknown;
  /**
   * B2b Task 16: the agent turn that drafted this version (main only: the MCP gateway; the IPC schema has no such field). It is
   * recorded as the version's producer (`produced_by_job_id`, `produced_by_session_id`), so "which versions did this turn
   * register" is one join for a requirement draft as it is for a change set. The job must be an `agent.run` of the same
   * project, requested by the saving user.
   */
  producedBy?: { jobId: string; sessionId: string | null };
}
/** Late-bound by the platform once the validation service exists (schema v9). */
export interface ArtifactValidatorHooks {
  recordInlineRegisterTx?: (versionId: VersionId, kind: string, content: unknown, now: number) => void;
}

/** Storage an ingest may write: the B0b kinds plus `blob` and `tree` (the blob store exists from B2a). */
function systemStorage(s: unknown): StorageRef {
  if (!isPlainObject(s) || typeof s.kind !== 'string') throw new PlatformError('invalid', 'storage must be an object with a kind');
  if (s.kind === 'inline' || s.kind === 'git') return validateStorage(s);
  if (s.kind === 'blob') {
    if (typeof s.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.sha256) || !Number.isSafeInteger(s.bytes) || (s.bytes as number) < 0
      || typeof s.mediaType !== 'string' || s.mediaType.length < 3 || s.mediaType.length > 100) {
      throw new PlatformError('invalid', 'blob storage needs { sha256, bytes, mediaType }');
    }
    return { kind: 'blob', sha256: s.sha256, bytes: s.bytes as number, mediaType: s.mediaType };
  }
  if (s.kind === 'tree') {
    if (typeof s.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.manifestSha256) || !Number.isSafeInteger(s.files) || (s.files as number) < 0
      || !Number.isSafeInteger(s.bytes) || (s.bytes as number) < 0) {
      throw new PlatformError('invalid', 'tree storage needs { manifestSha256, files, bytes }');
    }
    return { kind: 'tree', manifestSha256: s.manifestSha256, files: s.files as number, bytes: s.bytes as number };
  }
  throw new PlatformError('invalid', 'unknown storage kind');
}

export type PromoteResult =
  | { ok: true; version: ArtifactVersion; previous: VersionId | null }
  | { ok: false; code: 'conflict'; currentVersionId: VersionId | null };

/** The kinds a user saves directly (conflict C5: git_commit is a plain participation-owned kind, not `repository`). */
export const USER_SAVE_KINDS = ['git_commit', 'text_file'] as const;
export type UserSaveKind = (typeof USER_SAVE_KINDS)[number];
/** Each user-save kind has one storage kind and one recorded action. */
const USER_SAVE_RULES: Readonly<Record<UserSaveKind, { storage: StorageRef['kind']; action: 'user.save_commit' | 'user.save_file' }>> = Object.freeze({
  git_commit: { storage: 'git', action: 'user.save_commit' },
  text_file: { storage: 'inline', action: 'user.save_file' }
});
export type SaveTarget = { artifactId: ArtifactId } | { name: string };
export interface SaveUserVersionInput {
  projectId: ProjectId; workspaceId: WorkspaceId;          // selects the ACTIVE participation; never authority
  kind: UserSaveKind; target: SaveTarget;
  storage: StorageRef; metadata: Record<string, unknown>; action: 'user.save_commit' | 'user.save_file';
}
export interface ArtifactReaderFilter {
  projectId?: string; workspaceId?: string; kind?: string; status?: 'active' | 'archived'; limit?: number;
}

export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_VERSION_INPUTS = 256;
export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;
const KIND_RE = /^[a-z][a-z0-9_.-]{1,39}$/;
const ACTION_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_CLIENT_KEY_CHARS = 200;
const MAX_ROLE_CHARS = 64;
const MAX_FILTER_ID_CHARS = 128;
/** Rows read per page while filtering a cross-project list by readability. */
const READER_PAGE = 500;
const PLATFORM = { type: 'platform' } as const;

interface ArtifactRow {
  id: string; project_id: string; kind: string; name: string; description: string | null; owner_scope: 'participation' | 'project';
  owner_participation_id: string | null; owner_workspace_id: string | null; created_by: string; status: 'active' | 'archived';
  current_version_id: string | null; metadata_json: string; created_at: number; updated_at: number;
}
interface VersionRow {
  id: string; artifact_id: string; version_no: number; project_id: string; participation_id: string | null; status: VersionStatus;
  draft_flag: 'cancelled_partial' | null; storage_kind: string; storage_ref_json: string; content_hash: string; inputs_json: string;
  io_contract_json: string | null; metadata_json: string; validation_state: ArtifactVersion['validationState'];
  produced_by_job_id: string | null; produced_by_session_id: string | null; produced_by_action: string | null;
  actor_id: string; on_behalf_of: string; created_at: number; status_changed_at: number; promoted_by: string | null;
  promoted_at: number | null; client_key: string | null;
}

const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }   // json_valid CHECKs make this unreachable
};
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const toArtifact = (r: ArtifactRow): Artifact => ({
  id: r.id, projectId: r.project_id, kind: r.kind, name: r.name, description: r.description, ownerScope: r.owner_scope,
  ownerParticipationId: r.owner_participation_id, ownerWorkspaceId: r.owner_workspace_id, createdBy: r.created_by,
  status: r.status, currentVersionId: r.current_version_id,
  metadata: (isPlainObject(parse(r.metadata_json)) ? parse(r.metadata_json) : {}) as Record<string, unknown>,
  createdAt: r.created_at, updatedAt: r.updated_at
});
const toVersion = (r: VersionRow): ArtifactVersion => ({
  id: r.id, artifactId: r.artifact_id, versionNo: r.version_no, projectId: r.project_id, participationId: r.participation_id,
  status: r.status, draftFlag: r.draft_flag, storage: parse(r.storage_ref_json) as StorageRef, contentHash: r.content_hash,
  inputs: (parse(r.inputs_json) as VersionInput[] | null) ?? [], ioContract: parse(r.io_contract_json), metadata: parse(r.metadata_json),
  validationState: r.validation_state, producedByJobId: r.produced_by_job_id, producedBySessionId: r.produced_by_session_id,
  producedByAction: r.produced_by_action, actorId: r.actor_id, onBehalfOf: r.on_behalf_of, createdAt: r.created_at,
  statusChangedAt: r.status_changed_at, promotedBy: r.promoted_by, promotedAt: r.promoted_at, clientKey: r.client_key
});

/**
 * Secrets never reach artifact rows: a name, description, metadata or ioContract
 * holding anything secret-shaped is refused ('invalid', reason 'secret_in_metadata'),
 * as JobService refuses secret-shaped params. Inline storage CONTENT is product data
 * and is deliberately not checked; secrets travel by reference.
 */
function refuseSecretText(s: string | undefined, what: string): void {
  if (s !== undefined && redactText(s) !== s) {
    throw new PlatformError('invalid', `${what} holds a secret-shaped value`, { reason: 'secret_in_metadata' });
  }
}
function refuseSecretJson(v: unknown, what: string): void {
  if (v !== undefined && containsSecret(v)) {
    throw new PlatformError('invalid', `${what} holds a secret-shaped key or value`, { reason: 'secret_in_metadata' });
  }
}

/** JSON text for a caller-supplied value: exact JSON only (nothing coerced), bounded like inline storage, never secret-shaped. */
function jsonText(v: unknown, what: string): string {
  assertExactJson(v, what);
  refuseSecretJson(v, what);
  const text = JSON.stringify(v);
  if (Buffer.byteLength(text, 'utf8') > INLINE_MAX_BYTES) throw new PlatformError('invalid', `${what} exceeds ${INLINE_MAX_BYTES} bytes`);
  return text;
}

export class ArtifactService {
  private readonly access: ProjectAccess;
  private readonly principals: PrincipalResolver;

  constructor(private readonly db: Database.Database, private readonly deps: { auth: AuthService; now: () => number; validators?: ArtifactValidatorHooks }) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
    this.principals = new PrincipalResolver(db);
  }

  // ---------- artifacts ----------

  create(p: Principal, i: CreateArtifactInput): Artifact {
    if (!isPlainObject(i)) throw new PlatformError('invalid', 'input must be an object');
    if (!isStr(i.projectId) || !isStr(i.workspaceId)) throw new PlatformError('invalid', 'projectId and workspaceId are required');
    if (typeof i.kind !== 'string' || !KIND_RE.test(i.kind)) throw new PlatformError('invalid', 'kind must be a lowercase identifier of 2 to 40 characters');
    if (i.kind === 'repository') throw new PlatformError('invalid', 'repository artifacts are project-owned and arrive in a later phase');
    if (typeof i.name !== 'string' || i.name.trim().length === 0 || i.name.length > 200) throw new PlatformError('invalid', 'name must be 1 to 200 characters');
    if (i.description !== undefined && (typeof i.description !== 'string' || i.description.length > MAX_DESCRIPTION_CHARS)) {
      throw new PlatformError('invalid', `description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
    }
    if (i.metadata !== undefined && !isPlainObject(i.metadata)) throw new PlatformError('invalid', 'metadata must be an object');
    refuseSecretText(i.name, 'name');
    refuseSecretText(i.description, 'description');
    const metadataJson = jsonText(i.metadata ?? {}, 'metadata');

    // The workspace input only SELECTS the participation; the stored row is the authority.
    const pw = this.activeParticipation(i.projectId, i.workspaceId);
    if (!pw) {
      // Authorize at plain project scope first, so an unauthorized caller learns nothing about participations.
      this.access.require(p, i.projectId, 'artifact.create');
      throw new PlatformError('not_participating', 'the project does not actively take part in that workspace');
    }
    this.access.require(p, pw.project_id, 'artifact.create', { workspaceId: pw.workspace_id });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const live = this.activeParticipation(i.projectId, i.workspaceId);
      if (!live || live.id !== pw.id) throw new PlatformError('not_participating', 'the participation is no longer active');
      return this.insertArtifactTx(p, { participation: pw, kind: i.kind, name: i.name, description: i.description ?? null,
        metadataJson, now });
    });
  }

  get(p: Principal, id: ArtifactId): Artifact {
    return toArtifact(this.loadArtifact(p, id, 'artifact.read'));
  }

  listByProject(p: Principal, projectId: ProjectId, o?: { kind?: string; limit?: number }): Artifact[] {
    if (o?.kind !== undefined && (typeof o.kind !== 'string' || !KIND_RE.test(o.kind))) throw new PlatformError('invalid', 'invalid kind filter');
    const limit = o?.limit === undefined ? DEFAULT_LIST_LIMIT : o.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new PlatformError('invalid', `limit must be 1 to ${MAX_LIST_LIMIT}`);
    // Project scope: a list spans every participation, so no single stored workspace applies.
    this.access.require(p, projectId, 'artifact.read');
    const rows = o?.kind !== undefined
      ? this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY created_at, id LIMIT ?').all(projectId, o.kind, limit)
      : this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at, id LIMIT ?').all(projectId, limit);
    return (rows as ArtifactRow[]).map(toArtifact);
  }

  archive(p: Principal, id: ArtifactId): Artifact {
    const stored = this.loadArtifact(p, id, 'artifact.archive');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const a = this.artifactRow(stored.id)!;
      if (a.status === 'archived') return toArtifact(a);
      this.db.prepare("UPDATE artifacts SET status = 'archived', updated_at = ? WHERE id = ?").run(now, a.id);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: a.project_id, workspaceId: a.owner_workspace_id,
        artifactId: a.id, entityType: 'artifact', entityId: a.id, action: 'artifact.archive', status: 'succeeded', details: {} }, now);
      return toArtifact(this.artifactRow(a.id)!);
    });
  }

  // ---------- versions: reads ----------

  getVersion(p: Principal, id: VersionId): ArtifactVersion {
    return toVersion(this.loadVersion(p, id, 'artifact.read').v);
  }

  listVersions(p: Principal, artifactId: ArtifactId): ArtifactVersion[] {
    const a = this.loadArtifact(p, artifactId, 'artifact.read');
    return (this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version_no').all(a.id) as VersionRow[]).map(toVersion);
  }

  // ---------- versions: writes ----------

  registerVersion(p: Principal, i: RegisterVersionInput): { version: ArtifactVersion; created: boolean } {
    if (!isPlainObject(i)) throw new PlatformError('invalid', 'input must be an object');
    const storage = validateStorage(i.storage);
    const contentHash = contentHashOf(storage);
    const metadataJson = jsonText(i.metadata === undefined ? {} : i.metadata, 'metadata');
    const ioContractJson = i.ioContract === undefined ? null : jsonText(i.ioContract, 'ioContract');
    const jobId = i.producedByJobId === undefined ? null : i.producedByJobId;
    const sessionId = i.producedBySessionId === undefined ? null : i.producedBySessionId;
    if (jobId !== null && !isStr(jobId)) throw new PlatformError('invalid', 'producedByJobId must be an id');
    if (sessionId !== null && !isStr(sessionId)) throw new PlatformError('invalid', 'producedBySessionId must be an id');
    const clientKey = i.clientKey === undefined ? null : i.clientKey;
    if (clientKey !== null) {
      if (!isStr(clientKey) || clientKey.length > MAX_CLIENT_KEY_CHARS) throw new PlatformError('invalid', 'clientKey must be a short string');
      // The unique index is (job, clientKey); without a job the key could not be idempotent.
      if (jobId === null) throw new PlatformError('invalid', 'clientKey needs producedByJobId');
    }
    const action = i.action === undefined ? null : i.action;
    if (action !== null && (typeof action !== 'string' || !ACTION_RE.test(action))) throw new PlatformError('invalid', 'action must be a short lowercase label');
    const inputs = this.validateInputs(i.inputs);

    const a = this.loadArtifact(p, i.artifactId, 'version.register');
    // Producers first (read-only): an unknown or foreign job/session is refused before any grant check, so it never
    // produces a denied row. Project and participation are immutable on jobs and sessions, so this check holds.
    if (jobId !== null) this.checkProducer('job', jobId, a);
    if (sessionId !== null) this.checkProducer('session', sessionId, a);
    // Inputs are checked before the transaction: versions are never deleted, never change project, never return to
    // draft, and job_inputs are append-only, so a check that passes here still holds when the insert runs.
    this.checkInputs(p, a, inputs, jobId);
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      if (jobId !== null && clientKey !== null) {
        const prior = this.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ? AND client_key = ?')
          .get(jobId, clientKey) as VersionRow | undefined;
        if (prior) {
          if (prior.artifact_id !== a.id) throw new PlatformError('conflict', 'that (job, clientKey) already registered a version of another artifact');
          if (prior.content_hash !== contentHash) {
            throw new PlatformError('conflict', 'that (job, clientKey) already registered different content', { versionId: prior.id });
          }
          return { version: toVersion(prior), created: false };
        }
      }
      const art = this.requireWritableArtifact(a.id);
      if (jobId !== null) this.requireLiveJob(jobId);
      if (sessionId !== null) this.requireLiveSession(sessionId);
      const version = this.insertVersionTx(p, art.id, { storage, contentHash, metadataJson, ioContractJson, inputs, jobId, sessionId,
        action, clientKey, now });
      return { version, created: true };
    });
  }

  updateDraft(p: Principal, versionId: VersionId, patch: { storage?: StorageRef; metadata?: unknown; ioContract?: unknown }): ArtifactVersion {
    if (!isPlainObject(patch)) throw new PlatformError('invalid', 'patch must be an object');
    const sets: string[] = []; const args: unknown[] = []; const changed: string[] = [];
    if (patch.storage !== undefined) {
      const storage = validateStorage(patch.storage);
      sets.push('storage_kind = ?', 'storage_ref_json = ?', 'content_hash = ?');
      args.push(storage.kind, JSON.stringify(storage), contentHashOf(storage)); changed.push('storage');
    }
    if (patch.metadata !== undefined) { sets.push('metadata_json = ?'); args.push(jsonText(patch.metadata, 'metadata')); changed.push('metadata'); }
    if (patch.ioContract !== undefined) { sets.push('io_contract_json = ?'); args.push(jsonText(patch.ioContract, 'ioContract')); changed.push('ioContract'); }
    if (sets.length === 0) throw new PlatformError('invalid', 'nothing to update');
    const { v: stored } = this.loadVersion(p, versionId, 'version.update_draft');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionRow(stored.id)!;
      if (v.status !== 'draft') throw new PlatformError('immutable', 'version content is immutable after draft');
      const art = this.requireWritableArtifact(v.artifact_id);
      this.db.prepare(`UPDATE artifact_versions SET ${sets.join(', ')} WHERE id = ?`).run(...args, v.id);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: v.project_id, workspaceId: art.owner_workspace_id,
        artifactId: v.artifact_id, versionId: v.id, entityType: 'artifact_version', entityId: v.id, action: 'version.update_draft',
        status: 'succeeded', details: { changed } }, now);
      return toVersion(this.versionRow(v.id)!);
    });
  }

  /**
   * Engine role (F.7): draft -> candidate | failed. System principals only. On a
   * frozen (withdrawn) owner only 'failed' is allowed, so the engine can close out a
   * draft it was writing; 'candidate' is 'participation_inactive'.
   */
  finalize(system: Principal, versionId: VersionId, to: 'candidate' | 'failed'): ArtifactVersion {
    if (to !== 'candidate' && to !== 'failed') throw new PlatformError('invalid', "finalize moves a draft to 'candidate' or 'failed'");
    const { v: stored } = this.loadVersion(system, versionId, 'version.finalize');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionRow(stored.id)!;
      if (v.status === to) return toVersion(v);
      if (v.status !== 'draft') throw new PlatformError('illegal_transition', `cannot finalize a ${v.status} version`);
      if (to === 'candidate' && !this.ownerActive(v.artifact_id)) {
        throw new PlatformError('participation_inactive', 'the owning participation is not active; a frozen draft can only fail');
      }
      return this.setStatusTx(system, v.id, to, { now });
    });
  }

  /** draft | candidate -> deprecated. Idempotent on a deprecated version. */
  discard(p: Principal, versionId: VersionId): ArtifactVersion {
    const { v: stored } = this.loadVersion(p, versionId, 'version.discard');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionRow(stored.id)!;
      if (v.status === 'deprecated') return toVersion(v);
      if (v.status !== 'draft' && v.status !== 'candidate') throw new PlatformError('illegal_transition', `cannot discard a ${v.status} version`);
      const art = this.requireWritableArtifact(v.artifact_id);
      this.db.prepare("UPDATE artifact_versions SET status = 'deprecated', status_changed_at = ? WHERE id = ?").run(now, v.id);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: v.project_id, workspaceId: art.owner_workspace_id,
        artifactId: v.artifact_id, versionId: v.id, entityType: 'artifact_version', entityId: v.id, action: 'version.discard',
        status: 'succeeded', details: { from: v.status } }, now);
      return toVersion(this.versionRow(v.id)!);
    });
  }

  /**
   * candidate -> active, or deprecated -> active for a version that was active before
   * (rollback). Compare-and-set on the artifact's current pointer: `expectedCurrentVersionId`
   * must equal it, else { ok: false, code: 'conflict' } and nothing changes.
   */
  promote(p: Principal, versionId: VersionId, expectedCurrentVersionId: VersionId | null): PromoteResult {
    if (expectedCurrentVersionId !== null && !isStr(expectedCurrentVersionId)) throw new PlatformError('invalid', 'expectedCurrentVersionId must be an id or null');
    const { v: stored } = this.loadVersion(p, versionId, 'version.promote');
    // B2b: a change set becomes current only through review and accept (the accept ingest's own `promoteTx`, with the user's
    // compare-and-set), never through this door: neither promote nor a rollback to an earlier accepted change set.
    if (this.artifactRow(stored.artifact_id)?.kind === 'change_set') {
      throw new PlatformError('illegal_transition', 'A change set is accepted through review, not made current directly.', { reason: 'change_set_not_promotable' });
    }
    const now = this.deps.now();
    return immediateTx(this.db, (): PromoteResult => this.promoteTx(p, stored.id, expectedCurrentVersionId, now));
  }

  // ---------- in-transaction helpers ----------
  //
  // INTERNAL (@internal; pinned by test/nexus-platform-b1-services.test.cjs so no transport maps them). Each runs inside the caller's open IMMEDIATE transaction (it refuses to run outside one) and
  // AUTHORIZES NOTHING: the caller has already authorized the principal, with the stored owner workspace, before
  // opening the transaction, and has checked the rules of its own operation. Each writes its row(s) plus exactly
  // the activity row the public method always wrote, so create, registerVersion, finalize and promote keep their
  // B0b behaviour. The single-transaction flows (user saves, mark ready, handoff accept) compose them.

  /** @internal Inserts a participation-owned artifact and its 'artifact.create' row. `metadataJson` is already validated. */
  insertArtifactTx(actor: Principal, o: {
    participation: { id: string; project_id: string; workspace_id: string }; kind: string; name: string;
    description: string | null; metadataJson: string; now: number;
  }): Artifact {
    this.requireTx();
    const { participation: pw, now } = o;
    const id = newId(now);
    this.db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, description, owner_scope, owner_participation_id,
        owner_workspace_id, created_by, status, current_version_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'participation', ?, ?, ?, 'active', NULL, ?, ?, ?)`)
      .run(id, pw.project_id, o.kind, o.name, o.description, pw.id, pw.workspace_id, actor.id, o.metadataJson, now, now);
    appendActivityRow(this.db, { actorKind: actor.kind, actorId: actor.id, projectId: pw.project_id, workspaceId: pw.workspace_id,
      artifactId: id, entityType: 'artifact', entityId: id, action: 'artifact.create', status: 'succeeded',
      details: { kind: o.kind } }, now);
    return toArtifact(this.artifactRow(id)!);
  }

  /**
   * @internal
   * Appends a draft version (the next version_no), its lineage edges, the artifact's updated_at and its
   * 'version.register' row. Storage, hash and JSON texts are already validated; the caller has run
   * requireWritableArtifact (and its producer checks) in the same transaction.
   */
  insertVersionTx(actor: Principal, artifactId: ArtifactId, o: {
    storage: StorageRef; contentHash: string; metadataJson: string; ioContractJson: string | null;
    inputs: (VersionInput & { relation?: LineageRelation })[]; jobId: string | null; sessionId: string | null;
    action: string | null; clientKey: string | null; now: number;
  }): ArtifactVersion {
    this.requireTx();
    const art = this.artifactRow(artifactId);
    if (!art) throw new PlatformError('not_found', 'artifact not found');
    const { storage, inputs, jobId, sessionId, now } = o;
    const versionNo = (this.db.prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(art.id) as { n: number }).n;
    const id = newId(now);
    const inputsJson = JSON.stringify(inputs.map((x) => ({ versionId: x.versionId, role: x.role })));
    this.db.prepare(`INSERT INTO artifact_versions (id, artifact_id, version_no, project_id, participation_id, status, draft_flag,
        storage_kind, storage_ref_json, content_hash, inputs_json, io_contract_json, metadata_json, validation_state,
        produced_by_job_id, produced_by_session_id, produced_by_action, actor_id, on_behalf_of, environment_json,
        created_at, status_changed_at, promoted_by, promoted_at, purged_at, client_key, output_path)
      VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, NULL)`)
      .run(id, art.id, versionNo, art.project_id, art.owner_participation_id, storage.kind, JSON.stringify(storage), o.contentHash,
        inputsJson, o.ioContractJson, o.metadataJson, jobId, sessionId, o.action, actor.id, actor.id, now, now, o.clientKey);
    const edges: EdgeSpec[] = inputs.filter((x) => x.relation !== undefined)
      .map((x) => ({ toVersionId: x.versionId, relation: x.relation as LineageRelation }));
    const edgeCount = edges.length
      ? writeEdges(this.db, { fromVersionId: id, edges, source: jobId !== null ? 'job_input' : 'user_action', jobId, createdBy: actor.id, now })
      : 0;
    this.db.prepare('UPDATE artifacts SET updated_at = ? WHERE id = ?').run(now, art.id);
    appendActivityRow(this.db, { actorKind: actor.kind, actorId: actor.id, onBehalfOf: actor.id, jobId, sessionId, projectId: art.project_id,
      workspaceId: art.owner_workspace_id, artifactId: art.id, versionId: id, entityType: 'artifact_version', entityId: id,
      action: 'version.register', status: 'succeeded',
      details: { versionNo, storageKind: storage.kind, inputs: inputs.length, edges: edgeCount } }, now);
    return toVersion(this.versionRow(id)!);
  }

  /**
   * @internal
   * The engine transition draft -> candidate | failed and its 'version.finalize' row, acted by `system`. With
   * `onBehalfOf` and `via`, the row also records the user the system acted for and the flow (for example
   * 'mark_ready'). A version that is not a draft is 'illegal_transition'. The caller has checked the owner
   * participation before moving a draft to 'candidate'.
   */
  setStatusTx(system: Principal, versionId: VersionId, to: 'candidate' | 'failed', o: { now: number; onBehalfOf?: string; via?: string }): ArtifactVersion {
    this.requireTx();
    // Only the stored system principal performs the engine transition (callers authorized it for version.finalize).
    if (system?.kind !== 'system' || this.principals.get(system.id)?.kind !== 'system') {
      throw new PlatformError('invalid', 'the engine transition is performed by the system principal');
    }
    const v = this.versionRow(versionId);
    if (!v) throw new PlatformError('not_found', 'version not found');
    if (v.status !== 'draft') throw new PlatformError('illegal_transition', `cannot finalize a ${v.status} version`);
    const { now } = o;
    this.db.prepare('UPDATE artifact_versions SET status = ?, status_changed_at = ? WHERE id = ?').run(to, now, v.id);
    appendActivityRow(this.db, { actorKind: system.kind, actorId: system.id, onBehalfOf: o.onBehalfOf ?? null, projectId: v.project_id,
      workspaceId: this.ownerWorkspace(v.artifact_id), artifactId: v.artifact_id, versionId: v.id, jobId: v.produced_by_job_id,
      sessionId: v.produced_by_session_id, entityType: 'artifact_version', entityId: v.id, action: 'version.finalize',
      status: 'succeeded', details: o.via === undefined ? { from: 'draft', to } : { from: 'draft', to, via: o.via } }, now);
    return toVersion(this.versionRow(v.id)!);
  }

  /**
   * @internal The body of promote(): compare-and-set on the current pointer, single-active, one 'version.promote' row.
   * B2a: the stored system principal may also promote a version of the project-owned `repository` (the platform policy
   * that a validated snapshot becomes active), and `o.onBehalfOf` names the user it acted for on the activity row.
   */
  promoteTx(p: Principal, versionId: VersionId, expectedCurrentVersionId: VersionId | null, now: number, o?: { onBehalfOf?: string }): PromoteResult {
    this.requireTx();
    const v = this.versionRow(versionId);
    if (!v) throw new PlatformError('not_found', 'version not found');
    const owned = this.artifactRow(v.artifact_id);
    const systemOnProject = owned !== null && owned.owner_scope === 'project' && owned.kind === 'repository' && owned.status === 'active'
      && p?.kind === 'system' && this.principals.get(p.id)?.kind === 'system';
    const art = systemOnProject ? owned! : this.requireWritableArtifact(v.artifact_id);
    const previous = art.current_version_id;
    if (previous !== expectedCurrentVersionId) return { ok: false, code: 'conflict', currentVersionId: previous };
    const rollback = v.status === 'deprecated' && v.promoted_at !== null;
    if (v.status !== 'candidate' && !rollback) {
      throw new PlatformError('illegal_transition', v.status === 'deprecated'
        ? 'only a version that was active before can be rolled back to'
        : `cannot promote a ${v.status} version`);
    }
    // 1. activate, 2. move the pointer (CAS), 3. deprecate the previous active version(s): single-active.
    this.db.prepare("UPDATE artifact_versions SET status = 'active', status_changed_at = ?, promoted_by = ?, promoted_at = ? WHERE id = ?")
      .run(now, p.id, now, v.id);
    const moved = this.db.prepare('UPDATE artifacts SET current_version_id = ?, updated_at = ? WHERE id = ? AND current_version_id IS ?')
      .run(v.id, now, art.id, expectedCurrentVersionId);
    if (moved.changes !== 1) throw new PlatformError('conflict', 'the current version moved during promotion');
    this.db.prepare("UPDATE artifact_versions SET status = 'deprecated', status_changed_at = ? WHERE artifact_id = ? AND status = 'active' AND id <> ?")
      .run(now, art.id, v.id);
    appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, onBehalfOf: o?.onBehalfOf ?? null, projectId: v.project_id,
      workspaceId: art.owner_workspace_id, artifactId: art.id, versionId: v.id, entityType: 'artifact_version', entityId: v.id, action: 'version.promote',
      status: 'succeeded', details: { from: v.status, previous, rollback } }, now);
    return { ok: true, version: toVersion(this.versionRow(v.id)!), previous };
  }

  /**
   * @internal For execution ingest only, INSIDE its IMMEDIATE transaction. Appends a draft version made by a job,
   * written whole while it is a draft (storage, content hash, metadata, environment, output path): the version is
   * immutable afterwards. Accepts every storage kind (`blob` and `tree` included) and the project-owned `repository`.
   * - Only the stored system principal (else 'invalid'); the producing job must exist, be live, be in the artifact's
   *   project and act for its owning participation (a project-owned repository has none).
   * - `artifactId` appends to an active artifact (participation-owned: the owner must be active), or `newArtifact`
   *   creates one in the same transaction (participation-owned, or the project's one repository with `participation: null`).
   * - Inputs must be out of draft and in the project; an input whose edge source is `job_input` must be granted to
   *   the job as the same (version, role) in job_inputs, else 'input_not_granted' (the B0b rule).
   * - Lineage edges are written with their own source (`job_input` or `ingest`); one 'version.register' row (actor
   *   system, on behalf of the job's user).
   * - Secrets never reach the version: secret-shaped metadata, inline content, git ref or git paths are refused
   *   ('invalid', reason 'secret_in_metadata'; ingest refuses such outputs first as `secret_in_output`).
   * The public `create` still refuses `repository`, and the public `registerVersion` still answers
   * 'storage_unavailable' for blob, tree and external storage.
   */
  insertSystemVersionTx(system: Principal, o: SystemVersionInput): ArtifactVersion {
    this.requireTx();
    if (system?.kind !== 'system' || this.principals.get(system.id)?.kind !== 'system') {
      throw new PlatformError('invalid', 'an ingested version is written by the system principal');
    }
    const storage = systemStorage(o.storage);
    if (typeof o.contentHash !== 'string' || o.contentHash.length === 0 || o.contentHash.length > 200) throw new PlatformError('invalid', 'contentHash is required');
    if (o.outputPath !== null && (typeof o.outputPath !== 'string' || o.outputPath.length === 0 || o.outputPath.length > 1024)) {
      throw new PlatformError('invalid', 'outputPath must be a short path');
    }
    if (o.action !== null && (typeof o.action !== 'string' || !ACTION_RE.test(o.action))) throw new PlatformError('invalid', 'action must be a short lowercase label');
    assertExactJson(o.metadata, 'metadata');
    // What a runner reported never carries a secret into a version: metadata, inline content and the git ref are
    // checked here (the public path leaves inline content alone; an ingested one is the runner's report).
    refuseSecretJson(o.metadata, 'metadata');
    if (storage.kind === 'inline') refuseSecretJson(storage.json, 'the inline content');
    if (storage.kind === 'git') { refuseSecretText(storage.ref, 'the git ref'); refuseSecretJson(storage.paths, 'the git paths'); }
    const metadataJson = JSON.stringify(o.metadata);
    if (Buffer.byteLength(metadataJson, 'utf8') > INLINE_MAX_BYTES) throw new PlatformError('invalid', `metadata exceeds ${INLINE_MAX_BYTES} bytes`);
    const environmentJson = o.environment === null ? null : JSON.stringify(o.environment);
    const job = this.db.prepare(`SELECT j.id, j.project_id, j.participation_id, s.terminal FROM jobs j JOIN job_states s ON s.state = j.state
      WHERE j.id = ?`).get(o.jobId) as { id: string; project_id: string; participation_id: string | null; terminal: number } | undefined;
    if (!job) throw new PlatformError('not_found', 'producing job not found');
    if (job.terminal === 1) throw new PlatformError('conflict', 'the producing job has finished');
    const now = o.now;
    let art: ArtifactRow;
    if (o.artifactId !== undefined) {
      const a = this.artifactRow(o.artifactId);
      if (!a) throw new PlatformError('not_found', 'artifact not found');
      art = a.owner_scope === 'project' && a.kind === 'repository' && a.status === 'active' ? a : this.requireWritableArtifact(a.id);
    } else if (o.newArtifact) {
      const n = o.newArtifact;
      if (typeof n.name !== 'string' || n.name.trim().length === 0 || n.name.length > 200) throw new PlatformError('invalid', 'name must be 1 to 200 characters');
      if (!KIND_RE.test(n.kind)) throw new PlatformError('invalid', 'kind must be a lowercase identifier');
      if (n.participation === null) {
        if (n.kind !== 'repository') throw new PlatformError('invalid', 'only the repository is project-owned');
        const id = newId(now);
        this.db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, description, owner_scope, owner_participation_id, owner_workspace_id,
            created_by, status, current_version_id, metadata_json, created_at, updated_at)
          VALUES (?, ?, 'repository', ?, NULL, 'project', NULL, NULL, ?, 'active', NULL, '{}', ?, ?)`).run(id, job.project_id, n.name, system.id, now, now);
        appendActivityRow(this.db, { actorKind: system.kind, actorId: system.id, onBehalfOf: o.onBehalfOf, jobId: job.id, projectId: job.project_id,
          artifactId: id, entityType: 'artifact', entityId: id, action: 'artifact.create', status: 'succeeded',
          details: { kind: 'repository' } }, now);
        art = this.artifactRow(id)!;
      } else {
        const pw = this.db.prepare("SELECT id, project_id, workspace_id FROM project_workspaces WHERE id = ? AND status = 'active'")
          .get(n.participation) as { id: string; project_id: string; workspace_id: string } | undefined;
        if (!pw) throw new PlatformError('participation_inactive', 'the owning participation is not active');
        art = this.artifactRow(this.insertArtifactTx(system, { participation: pw, kind: n.kind, name: n.name, description: null,
          metadataJson: '{}', now }).id)!;
      }
    } else {
      throw new PlatformError('invalid', 'an ingested version names its artifact or a new one');
    }
    if (art.project_id !== job.project_id) throw new PlatformError('invalid', 'the producing job belongs to another project');
    if (art.owner_scope === 'participation' && job.participation_id !== art.owner_participation_id) {
      throw new PlatformError('invalid', "the producing job does not act for the artifact's owning participation");
    }
    const inputs = Array.isArray(o.inputs) ? o.inputs : [];
    const granted = this.db.prepare('SELECT 1 FROM job_inputs WHERE job_id = ? AND version_id = ? AND role = ?');
    for (const x of inputs) {
      const v = this.versionRow(x.versionId);
      if (!v || v.project_id !== job.project_id) throw new PlatformError('invalid', 'an input is not a version of the project');
      if (v.status === 'draft') throw new PlatformError('invalid', 'a draft cannot be an input');
      if (x.source === 'job_input' && granted.get(job.id, x.versionId, x.role) === undefined) {
        throw new PlatformError('input_not_granted', 'an input is not granted to the job as that version and role');
      }
      if (x.relation !== undefined && !isKnownRelation(this.db, x.relation)) throw new PlatformError('invalid', 'unknown lineage relation');
    }
    const versionNo = (this.db.prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(art.id) as { n: number }).n;
    const id = newId(now);
    const inputsJson = JSON.stringify(inputs.filter((x) => x.source === 'job_input').map((x) => ({ versionId: x.versionId, role: x.role })));
    this.db.prepare(`INSERT INTO artifact_versions (id, artifact_id, version_no, project_id, participation_id, status, draft_flag,
        storage_kind, storage_ref_json, content_hash, inputs_json, io_contract_json, metadata_json, validation_state,
        produced_by_job_id, produced_by_session_id, produced_by_action, actor_id, on_behalf_of, environment_json,
        created_at, status_changed_at, promoted_by, promoted_at, purged_at, client_key, output_path)
      VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?, NULL, ?, 'pending', ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`)
      .run(id, art.id, versionNo, art.project_id, art.owner_participation_id, storage.kind, JSON.stringify(storage), o.contentHash,
        inputsJson, metadataJson, job.id, o.action, system.id, o.onBehalfOf, environmentJson, now, now, o.outputPath);
    let edgeCount = 0;
    for (const source of ['job_input', 'ingest'] as const) {
      const edges: EdgeSpec[] = inputs.filter((x) => x.source === source && x.relation !== undefined)
        .map((x) => ({ toVersionId: x.versionId, relation: x.relation as LineageRelation }));
      if (edges.length) edgeCount += writeEdges(this.db, { fromVersionId: id, edges, source, jobId: job.id, createdBy: system.id, now });
    }
    this.db.prepare('UPDATE artifacts SET updated_at = ? WHERE id = ?').run(now, art.id);
    appendActivityRow(this.db, { actorKind: system.kind, actorId: system.id, onBehalfOf: o.onBehalfOf, jobId: job.id, attemptN: o.attemptN ?? null,
      projectId: art.project_id, workspaceId: art.owner_workspace_id, artifactId: art.id, versionId: id, entityType: 'artifact_version',
      entityId: id, action: 'version.register', status: 'succeeded',
      details: { versionNo, storageKind: storage.kind, inputs: inputs.length, edges: edgeCount } }, now);
    return toVersion(this.versionRow(id)!);
  }

  /**
   * B2a: saves a user-authored inline kind (`requirement`, `problem_statement`) as a draft version, in ONE transaction
   * with its activity rows and its register validator results (recorded by the system).
   * - `kind` must be user-authorable inline ('invalid', reason 'kind_not_authorable') and produced by the domain of
   *   `workspaceId` ('kind_not_in_domain'). `content` must meet the kind's schema ('bad_content'; a secret-shaped
   *   value is 'secret_in_metadata') before anything is written.
   * - New artifact (`target.name`) or append (`target.artifactId`), authorized exactly like saveUserVersion.
   * - Dedupe: the same content as the latest live version of the target (or of an active artifact with the same owner,
   *   kind and name) returns that version with `created: false` and writes nothing.
   * Needs schema v9 (the validations table): otherwise 'platform_unavailable'.
   */
  saveInline(p: Principal, i: SaveInlineInput): { artifact: Artifact; version: ArtifactVersion; created: boolean } {
    // Only a stored, enabled user writes a requirement or a problem statement (fix round 1: an agent or the system is
    // denied and audited, never answered a bare 'invalid'), before anything else is read.
    requireStoredUser(this.principals, this.deps.auth, p, 'artifact.create', 'artifact', 'only a user saves an inline artifact');
    if (!isPlainObject(i)) throw new PlatformError('invalid', 'input must be an object');
    if (!isStr(i.projectId) || !isStr(i.workspaceId)) throw new PlatformError('invalid', 'projectId and workspaceId are required');
    const kind = i.kind as string;
    const rule = INLINE_KINDS[kind as InlineKind];
    if (!rule) throw new PlatformError('invalid', `kind must be one of ${Object.keys(INLINE_KINDS).join(', ')}`, { reason: 'kind_not_authorable' });
    const domain = getDomain(i.workspaceId);
    if (!domain || !domain.kindsProduced.includes(kind)) {
      throw new PlatformError('invalid', `the ${i.workspaceId.slice(0, 32)} workspace does not produce a ${kind}`, { reason: 'kind_not_in_domain' });
    }
    const check = rule.errors(i.content);
    if (check.secret) throw new PlatformError('invalid', 'the content holds a secret-shaped value', { reason: 'secret_in_metadata' });
    if (check.errors.length > 0) {
      throw new PlatformError('invalid', `the ${kind} breaks its schema: ${check.errors[0].path || '/'} ${check.errors[0].message}`,
        { reason: 'bad_content', errors: check.errors.slice(0, 20) });
    }
    const hook = this.deps.validators;
    if (!hook || typeof hook.recordInlineRegisterTx !== 'function') {
      throw new PlatformError('platform_unavailable', 'inline saves need the validation records of schema v9', { reason: 'not_enabled' });
    }
    const storage = validateStorage({ kind: 'inline', json: i.content });
    const contentHash = contentHashOf(storage);
    const t = i.target as unknown;
    if (!isPlainObject(t)) throw new PlatformError('invalid', 'target must be an object');
    const byId = Object.prototype.hasOwnProperty.call(t, 'artifactId');
    const byName = Object.prototype.hasOwnProperty.call(t, 'name');
    if (byId === byName || Object.keys(t).length !== 1) throw new PlatformError('invalid', 'target names either an artifactId or a name');
    const by = i.producedBy;
    if (by !== undefined) {
      const j = isPlainObject(by) && isStr(by.jobId)
        ? this.db.prepare('SELECT project_id, kind, requested_by FROM jobs WHERE id = ?').get(by.jobId) as { project_id: string; kind: string; requested_by: string } | undefined
        : undefined;
      if (!j || j.kind !== 'agent.run' || j.project_id !== i.projectId || j.requested_by !== p.id) {
        throw new PlatformError('invalid', 'producedBy does not name an agent turn of this project run for the saving user', { reason: 'bad_producer' });
      }
    }
    const version = { storage, contentHash, metadataJson: '{}', ioContractJson: null, inputs: [], jobId: by?.jobId ?? null, sessionId: by?.sessionId ?? null,
      action: rule.action, clientKey: null };
    const record = (v: ArtifactVersion, now: number): void => hook.recordInlineRegisterTx!(v.id, kind, i.content, now);

    if (byId) {
      if (!isStr(t.artifactId)) throw new PlatformError('invalid', 'target.artifactId must be an id');
      const a = this.loadArtifact(p, t.artifactId, 'version.register');
      if (a.project_id !== i.projectId) throw new PlatformError('invalid', 'the artifact belongs to another project');
      if (a.kind !== kind) throw new PlatformError('invalid', `the artifact is a ${a.kind}, not a ${kind}`, { reason: 'kind_mismatch' });
      if (a.owner_workspace_id !== i.workspaceId) throw new PlatformError('invalid', 'the artifact is owned by another workspace');
      const now = this.deps.now();
      return immediateTx(this.db, () => {
        const art = this.requireWritableArtifact(a.id);
        const latest = this.latestLiveVersion(art.id);
        if (latest && latest.content_hash === contentHash) return { artifact: toArtifact(art), version: toVersion(latest), created: false };
        const v = this.insertVersionTx(p, art.id, { ...version, now });
        record(v, now);
        return { artifact: toArtifact(this.artifactRow(art.id)!), version: toVersion(this.versionRow(v.id)!), created: true };
      });
    }
    const name = t.name;
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) throw new PlatformError('invalid', 'name must be 1 to 200 characters');
    refuseSecretText(name, 'name');
    const pw = this.activeParticipation(i.projectId, i.workspaceId);
    if (!pw) {
      this.access.require(p, i.projectId, 'artifact.create');
      throw new PlatformError('not_participating', 'the project does not actively take part in that workspace');
    }
    this.access.require(p, pw.project_id, 'artifact.create', { workspaceId: pw.workspace_id });
    this.access.require(p, pw.project_id, 'version.register', { workspaceId: pw.workspace_id });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const live = this.activeParticipation(i.projectId, i.workspaceId);
      if (!live || live.id !== pw.id) throw new PlatformError('not_participating', 'the participation is no longer active');
      const dup = this.db.prepare(`SELECT a.id AS artifact_id, v.id AS version_id FROM artifacts a
          JOIN artifact_versions v ON v.id = (SELECT x.id FROM artifact_versions x WHERE x.artifact_id = a.id
            AND x.status IN ('draft','candidate','active') ORDER BY x.version_no DESC LIMIT 1)
        WHERE a.owner_participation_id = ? AND a.kind = ? AND a.name = ? AND a.status = 'active' AND v.content_hash = ?
        ORDER BY a.created_at, a.id LIMIT 1`).get(pw.id, kind, name, contentHash) as { artifact_id: string; version_id: string } | undefined;
      if (dup) return { artifact: toArtifact(this.artifactRow(dup.artifact_id)!), version: toVersion(this.versionRow(dup.version_id)!), created: false };
      const artifact = this.insertArtifactTx(p, { participation: pw, kind, name, description: null, metadataJson: '{}', now });
      const v = this.insertVersionTx(p, artifact.id, { ...version, now });
      record(v, now);
      return { artifact: toArtifact(this.artifactRow(artifact.id)!), version: toVersion(this.versionRow(v.id)!), created: true };
    });
  }

  // ---------- B1: summaries and cross-project reads ----------

  /**
   * Every artifact of the project (creation order) with its version count, latest and current version. At most
   * `o.limit` rows (default MAX_LIST_LIMIT); a caller may ask for MAX_LIST_LIMIT + 1 to learn whether more exist.
   */
  summariesByProject(p: Principal, projectId: ProjectId, o?: { limit?: number }): ArtifactSummary[] {
    const limit = o?.limit === undefined ? MAX_LIST_LIMIT : o.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT + 1) throw new PlatformError('invalid', `limit must be 1 to ${MAX_LIST_LIMIT + 1}`);
    // Project scope, as listByProject: the list spans every participation, so no single stored workspace applies.
    this.access.require(p, projectId, 'artifact.read');
    const rows = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at, id LIMIT ?')
      .all(projectId, limit) as ArtifactRow[];
    return rows.map((r) => this.summaryOf(r));
  }

  /**
   * Artifacts across projects, newest update first (ix_artifacts_updated), for the global Artifacts page. Each row
   * is kept only when the caller may read it: a read-only auth.authorize('artifact.read', project scope + the
   * artifact's STORED owner workspace), cached per (project, workspace), exactly like lineage walks. It writes no
   * audit row; an unreadable row is simply absent.
   */
  listForReader(p: Principal, f?: ArtifactReaderFilter): ArtifactSummary[] {
    if (f !== undefined && !isPlainObject(f)) throw new PlatformError('invalid', 'filter must be an object');
    const o: ArtifactReaderFilter = f ?? {};
    const where: string[] = []; const args: unknown[] = [];
    if (o.projectId !== undefined) {
      if (!isStr(o.projectId) || o.projectId.length > MAX_FILTER_ID_CHARS) throw new PlatformError('invalid', 'invalid projectId filter');
      where.push('project_id = ?'); args.push(o.projectId);
    }
    if (o.workspaceId !== undefined) {
      if (!isStr(o.workspaceId) || o.workspaceId.length > MAX_FILTER_ID_CHARS) throw new PlatformError('invalid', 'invalid workspaceId filter');
      where.push('owner_workspace_id = ?'); args.push(o.workspaceId);
    }
    if (o.kind !== undefined) {
      if (typeof o.kind !== 'string' || !KIND_RE.test(o.kind)) throw new PlatformError('invalid', 'invalid kind filter');
      where.push('kind = ?'); args.push(o.kind);
    }
    if (o.status !== undefined) {
      if (o.status !== 'active' && o.status !== 'archived') throw new PlatformError('invalid', "status must be 'active' or 'archived'");
      where.push('status = ?'); args.push(o.status);
    }
    const limit = o.limit === undefined ? DEFAULT_LIST_LIMIT : o.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new PlatformError('invalid', `limit must be 1 to ${MAX_LIST_LIMIT}`);

    const readable = new Map<string, boolean>();
    const canRead = (projectId: string, ws: string | null): boolean => {
      const key = `${projectId}\u0000${ws ?? ''}`;
      let ok = readable.get(key);
      if (ok === undefined) {
        ok = this.deps.auth.authorize(p, 'artifact.read', ws ? { type: 'project', projectId, workspaceId: ws } : { type: 'project', projectId }).allowed;
        readable.set(key, ok);
      }
      return ok;
    };
    const page = this.db.prepare(`SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`);
    const out: ArtifactSummary[] = [];
    for (let offset = 0; out.length < limit; offset += READER_PAGE) {
      const rows = page.all(...args, READER_PAGE, offset) as ArtifactRow[];
      for (const r of rows) {
        if (!canRead(r.project_id, r.owner_workspace_id)) continue;
        out.push(this.summaryOf(r));
        if (out.length >= limit) break;
      }
      if (rows.length < READER_PAGE) break;
    }
    return out;
  }

  // ---------- B1: user saves and mark ready ----------

  /**
   * Saves a git commit or a small text file as a version, in ONE transaction with its activity rows.
   * - New artifact (`target.name`): the ACTIVE participation of (project, workspace) is resolved here (the
   *   workspace only selects it); 'artifact.create' and 'version.register' are required with its stored workspace.
   *   The artifact, its version 1 and both rows commit together, or nothing does.
   * - Append (`target.artifactId`): 'version.register' with the artifact's STORED owner workspace. The kind must
   *   match ('invalid', reason 'kind_mismatch') and the owner workspace must be `workspaceId` ('invalid').
   * - Dedupe: when the same content (hash) is already the latest live (draft, candidate or active) version of an
   *   active artifact with the same owner, kind and name (or of the target artifact), that version is returned with
   *   `created: false` and nothing is written. A discarded or failed version never blocks a new save.
   * Names and metadata are refused when secret-shaped ('invalid', reason 'secret_in_metadata').
   */
  saveUserVersion(p: Principal, i: SaveUserVersionInput): { artifact: Artifact; version: ArtifactVersion; created: boolean } {
    if (!isPlainObject(i)) throw new PlatformError('invalid', 'input must be an object');
    if (p?.kind !== 'user') throw new PlatformError('invalid', 'a user save is made by a user principal');
    if (!isStr(i.projectId) || !isStr(i.workspaceId)) throw new PlatformError('invalid', 'projectId and workspaceId are required');
    const kind = i.kind as string;
    if (!(USER_SAVE_KINDS as readonly string[]).includes(kind)) throw new PlatformError('invalid', `kind must be one of ${USER_SAVE_KINDS.join(', ')}`);
    const rule = USER_SAVE_RULES[kind as UserSaveKind];
    if (i.action !== rule.action) throw new PlatformError('invalid', `a ${kind} save is recorded as ${rule.action}`);
    const storage = validateStorage(i.storage);
    if (storage.kind !== rule.storage) throw new PlatformError('invalid', `a ${kind} save is stored as ${rule.storage}`);
    const contentHash = contentHashOf(storage);
    if (!isPlainObject(i.metadata)) throw new PlatformError('invalid', 'metadata must be an object');
    const metadataJson = jsonText(i.metadata, 'metadata');
    const t = i.target as unknown;
    if (!isPlainObject(t)) throw new PlatformError('invalid', 'target must be an object');
    const byId = Object.prototype.hasOwnProperty.call(t, 'artifactId');
    const byName = Object.prototype.hasOwnProperty.call(t, 'name');
    if (byId === byName || Object.keys(t).length !== 1) throw new PlatformError('invalid', 'target names either an artifactId or a name');
    const version = { storage, contentHash, metadataJson, ioContractJson: null, inputs: [], jobId: null, sessionId: null,
      action: rule.action, clientKey: null };

    if (byId) {
      if (!isStr(t.artifactId)) throw new PlatformError('invalid', 'target.artifactId must be an id');
      const a = this.loadArtifact(p, t.artifactId, 'version.register');
      if (a.project_id !== i.projectId) throw new PlatformError('invalid', 'the artifact belongs to another project');
      if (a.kind !== kind) throw new PlatformError('invalid', `the artifact is a ${a.kind}, not a ${kind}`, { reason: 'kind_mismatch' });
      if (a.owner_workspace_id !== i.workspaceId) throw new PlatformError('invalid', 'the artifact is owned by another workspace');
      const now = this.deps.now();
      return immediateTx(this.db, () => {
        const art = this.requireWritableArtifact(a.id);
        const latest = this.latestLiveVersion(art.id);
        if (latest && latest.content_hash === contentHash) return { artifact: toArtifact(art), version: toVersion(latest), created: false };
        const v = this.insertVersionTx(p, art.id, { ...version, now });
        return { artifact: toArtifact(this.artifactRow(art.id)!), version: v, created: true };
      });
    }

    const name = t.name;
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) throw new PlatformError('invalid', 'name must be 1 to 200 characters');
    refuseSecretText(name, 'name');
    // The workspace input only SELECTS the participation; the stored row is the authority.
    const pw = this.activeParticipation(i.projectId, i.workspaceId);
    if (!pw) {
      // Plain project scope first, so an unauthorized caller learns nothing about participations.
      this.access.require(p, i.projectId, 'artifact.create');
      throw new PlatformError('not_participating', 'the project does not actively take part in that workspace');
    }
    this.access.require(p, pw.project_id, 'artifact.create', { workspaceId: pw.workspace_id });
    this.access.require(p, pw.project_id, 'version.register', { workspaceId: pw.workspace_id });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const live = this.activeParticipation(i.projectId, i.workspaceId);
      if (!live || live.id !== pw.id) throw new PlatformError('not_participating', 'the participation is no longer active');
      const dup = this.db.prepare(`SELECT a.id AS artifact_id, v.id AS version_id FROM artifacts a
          JOIN artifact_versions v ON v.id = (SELECT x.id FROM artifact_versions x WHERE x.artifact_id = a.id
            AND x.status IN ('draft','candidate','active') ORDER BY x.version_no DESC LIMIT 1)
        WHERE a.owner_participation_id = ? AND a.kind = ? AND a.name = ? AND a.status = 'active' AND v.content_hash = ?
        ORDER BY a.created_at, a.id LIMIT 1`).get(pw.id, kind, name, contentHash) as { artifact_id: string; version_id: string } | undefined;
      if (dup) return { artifact: toArtifact(this.artifactRow(dup.artifact_id)!), version: toVersion(this.versionRow(dup.version_id)!), created: false };
      const artifact = this.insertArtifactTx(p, { participation: pw, kind, name, description: null, metadataJson: '{}', now });
      const v = this.insertVersionTx(p, artifact.id, { ...version, now });
      return { artifact: toArtifact(this.artifactRow(artifact.id)!), version: v, created: true };
    });
  }

  /**
   * "Mark ready": draft -> candidate on the user's behalf (conflict C4). The user must hold 'version.update_draft'
   * with the artifact's STORED owner workspace, and the draft must have no producing job or session ('invalid',
   * reason 'produced_by_job'): engine-made drafts stay engine-finalized. The system principal is then authorized
   * for 'version.finalize' (system only, unchanged) and performs it; the one activity row has actor 'system',
   * on_behalf_of the user and details.via 'mark_ready'. A candidate is returned as is; any other status is
   * 'illegal_transition'; a frozen owner is 'participation_inactive'.
   */
  markReady(p: Principal, versionId: VersionId): ArtifactVersion {
    if (p?.kind !== 'user') throw new PlatformError('invalid', 'mark ready is a user action');
    const { v: stored, a } = this.loadVersion(p, versionId, 'version.update_draft');
    if (stored.produced_by_job_id !== null || stored.produced_by_session_id !== null) {
      throw new PlatformError('invalid', 'a draft made by a job or session is finalized by the engine', { reason: 'produced_by_job' });
    }
    const system = this.principals.system();
    this.access.require(system, a.project_id, 'version.finalize', a.owner_workspace_id ? { workspaceId: a.owner_workspace_id } : undefined);
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionRow(stored.id)!;
      if (v.status === 'candidate') return toVersion(v);
      if (v.status !== 'draft') throw new PlatformError('illegal_transition', `cannot mark a ${v.status} version ready`);
      this.requireWritableArtifact(v.artifact_id);
      return this.setStatusTx(system, v.id, 'candidate', { now, onBehalfOf: p.id, via: 'mark_ready' });
    });
  }

  // ---------- helpers ----------

  private requireTx(): void {
    if (!this.db.inTransaction) throw new PlatformError('invalid', 'this helper runs inside the caller transaction');
  }

  private activeParticipation(projectId: ProjectId, workspaceId: WorkspaceId): { id: string; project_id: string; workspace_id: string } | null {
    return (this.db.prepare("SELECT id, project_id, workspace_id FROM project_workspaces WHERE project_id = ? AND workspace_id = ? AND status = 'active'")
      .get(projectId, workspaceId) as { id: string; project_id: string; workspace_id: string } | undefined) ?? null;
  }

  private artifactRow(id: string): ArtifactRow | null {
    return (this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined) ?? null;
  }

  private versionRow(id: string): VersionRow | null {
    return (this.db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(id) as VersionRow | undefined) ?? null;
  }

  /** The newest version of the artifact that is draft, candidate or active (the user-save dedupe target). */
  private latestLiveVersion(artifactId: string): VersionRow | null {
    return (this.db.prepare(`SELECT * FROM artifact_versions WHERE artifact_id = ? AND status IN ('draft','candidate','active')
      ORDER BY version_no DESC LIMIT 1`).get(artifactId) as VersionRow | undefined) ?? null;
  }

  private summaryOf(r: ArtifactRow): ArtifactSummary {
    const c = this.db.prepare('SELECT COUNT(*) AS n, MAX(version_no) AS mx FROM artifact_versions WHERE artifact_id = ?')
      .get(r.id) as { n: number; mx: number | null };
    const latest = c.mx === null ? undefined : this.db.prepare('SELECT id, version_no, status FROM artifact_versions WHERE artifact_id = ? AND version_no = ?')
      .get(r.id, c.mx) as { id: string; version_no: number; status: VersionStatus } | undefined;
    const current = r.current_version_id === null ? undefined : this.db.prepare('SELECT id, version_no FROM artifact_versions WHERE id = ?')
      .get(r.current_version_id) as { id: string; version_no: number } | undefined;
    return {
      artifact: toArtifact(r), versionCount: c.n,
      latest: latest ? { id: latest.id, versionNo: latest.version_no, status: latest.status } : null,
      current: current ? { id: current.id, versionNo: current.version_no } : null
    };
  }

  private ownerWorkspace(artifactId: string): string | null {
    return (this.db.prepare('SELECT owner_workspace_id AS w FROM artifacts WHERE id = ?').get(artifactId) as { w: string | null } | undefined)?.w ?? null;
  }

  /** Loads an artifact and authorizes `action` on it with the STORED owner workspace. Outside any transaction. */
  private loadArtifact(p: Principal, id: ArtifactId, action: PlatformAction): ArtifactRow {
    const a = isStr(id) ? this.artifactRow(id) : null;
    if (!a) {
      this.deps.auth.require(p, action, PLATFORM);
      throw new PlatformError('not_found', 'artifact not found');
    }
    this.access.require(p, a.project_id, action, a.owner_workspace_id ? { workspaceId: a.owner_workspace_id } : undefined);
    return a;
  }

  private loadVersion(p: Principal, id: VersionId, action: PlatformAction): { v: VersionRow; a: ArtifactRow } {
    const v = isStr(id) ? this.versionRow(id) : null;
    if (!v) {
      this.deps.auth.require(p, action, PLATFORM);
      throw new PlatformError('not_found', 'version not found');
    }
    const a = this.artifactRow(v.artifact_id)!;
    this.access.require(p, a.project_id, action, a.owner_workspace_id ? { workspaceId: a.owner_workspace_id } : undefined);
    return { v, a };
  }

  /** Inside the transaction: the artifact is active and its owner participation is active. */
  private requireWritableArtifact(artifactId: string): ArtifactRow {
    const art = this.artifactRow(artifactId);
    if (!art) throw new PlatformError('not_found', 'artifact not found');
    if (art.status !== 'active') throw new PlatformError('conflict', 'the artifact is archived');
    if (art.owner_participation_id === null) throw new PlatformError('invalid', 'project-owned artifacts are not writable in this phase');
    const pw = this.db.prepare('SELECT status FROM project_workspaces WHERE id = ?').get(art.owner_participation_id) as { status: string } | undefined;
    if (!pw || pw.status !== 'active') {
      throw new PlatformError('participation_inactive', 'the owning participation is not active; its artifacts are frozen');
    }
    return art;
  }

  /** True when the artifact's owner participation exists and is active. */
  private ownerActive(artifactId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM artifacts a JOIN project_workspaces pw ON pw.id = a.owner_participation_id
      WHERE a.id = ? AND pw.status = 'active'`).get(artifactId) !== undefined;
  }

  /**
   * Read-only, before the transaction: the producing job or session exists
   * ('not_found'), is in the artifact's project and acts for the artifact's owner
   * participation ('invalid'). A job without a participation never matches. These
   * columns are immutable (identity triggers), so the result holds in the transaction.
   */
  private checkProducer(kind: 'job' | 'session', id: string, a: ArtifactRow): void {
    const row = (kind === 'job'
      ? this.db.prepare('SELECT project_id, participation_id FROM jobs WHERE id = ?').get(id)
      : this.db.prepare('SELECT project_id, participation_id FROM agent_sessions WHERE id = ?').get(id)
    ) as { project_id: string; participation_id: string | null } | undefined;
    if (!row) throw new PlatformError('not_found', `producing ${kind} not found`);
    if (row.project_id !== a.project_id) throw new PlatformError('invalid', `the producing ${kind} belongs to another project`);
    if (row.participation_id === null || row.participation_id !== a.owner_participation_id) {
      throw new PlatformError('invalid', `the producing ${kind} does not act for the artifact's owning participation`);
    }
  }

  /** Inside the transaction: the producing job has not finished (its state can move). */
  private requireLiveJob(jobId: string): void {
    const j = this.db.prepare('SELECT s.terminal FROM jobs j JOIN job_states s ON s.state = j.state WHERE j.id = ?')
      .get(jobId) as { terminal: number } | undefined;
    if (!j) throw new PlatformError('not_found', 'producing job not found');
    if (j.terminal === 1) throw new PlatformError('conflict', 'the producing job has finished');
  }

  /** Inside the transaction: the producing session has not ended. */
  private requireLiveSession(sessionId: string): void {
    const s = this.db.prepare('SELECT st.terminal FROM agent_sessions a JOIN agent_session_states st ON st.state = a.status WHERE a.id = ?')
      .get(sessionId) as { terminal: number } | undefined;
    if (!s) throw new PlatformError('not_found', 'producing session not found');
    if (s.terminal === 1) throw new PlatformError('conflict', 'the producing session has ended');
  }

  private validateInputs(raw: unknown): (VersionInput & { relation?: LineageRelation })[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > MAX_VERSION_INPUTS) throw new PlatformError('invalid', `inputs must be a list of at most ${MAX_VERSION_INPUTS}`);
    const seen = new Set<string>();
    return raw.map((x: unknown) => {
      if (!isPlainObject(x) || !isStr(x.versionId) || !isStr(x.role) || x.role.length > MAX_ROLE_CHARS) {
        throw new PlatformError('invalid', 'each input needs a versionId and a role of at most 64 characters');
      }
      const key = `${x.versionId}\u0000${x.role}`;
      if (seen.has(key)) throw new PlatformError('invalid', 'duplicate input');
      seen.add(key);
      if (x.relation !== undefined && !isKnownRelation(this.db, x.relation)) throw new PlatformError('invalid', 'unknown lineage relation');
      return x.relation === undefined
        ? { versionId: x.versionId, role: x.role }
        : { versionId: x.versionId, role: x.role, relation: x.relation as LineageRelation };
    });
  }

  /**
   * Inputs must exist, be in the artifact's project, be out of draft and be readable by
   * the caller in their owner's workspace ('denied', audited). With a job,
   * every input must be granted to the job as the same (version, role) in job_inputs;
   * otherwise the registration is refused with 'input_not_granted' and one denied
   * activity row. The row goes through AuthService.auditDenial: written at once, or,
   * inside a caller's transaction, after it ends, so a rollback cannot lose it.
   */
  private checkInputs(p: Principal, a: ArtifactRow, inputs: VersionInput[], jobId: string | null): void {
    for (const x of inputs) {
      // The caller must be able to read every input, in its owner's workspace ('denied', audited), before learning
      // anything about it: whether it exists, its project (both only for a platform-authorized caller) or its status.
      const v = this.access.requireVersionReadable(p, x.versionId, a.project_id);
      if (v.status === 'draft') throw new PlatformError('invalid', 'a draft cannot be an input');
    }
    if (jobId === null || inputs.length === 0) return;
    const granted = this.db.prepare('SELECT 1 FROM job_inputs WHERE job_id = ? AND version_id = ? AND role = ?');
    const missing = inputs.filter((x) => granted.get(jobId, x.versionId, x.role) === undefined).length;
    if (missing === 0) return;
    const audited = this.deps.auth.auditDenial(p, { action: 'version.register', reason: 'input_not_granted', jobId,
      projectId: a.project_id, workspaceId: a.owner_workspace_id, artifactId: a.id, entityType: 'artifact_version',
      details: { notGranted: missing } });
    throw new PlatformError('input_not_granted', 'an input is not granted to the job as that version and role', { audited });
  }
}
