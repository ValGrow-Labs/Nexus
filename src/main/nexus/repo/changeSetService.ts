/**
 * Change-set registration (B2b Task 8; D-B14, F23). `ChangeSetService.register(claims, args)` is the service behind
 * the `changeset_register` MCP tool: it enqueues the system child job `changeset.collect` (parent: the turn job),
 * then waits for the runner to commit the agent's work and for main to ingest it (a draft `change_set` with its
 * lineage and register validators run inline, `ingest.ts`), up to `waitMs` (120 s in production). Past that it
 * answers `{ pending: jobId }`, and the agent polls `job_status`.
 *
 * - `title` (<=200), `summary` (<=4000) and `requirementVersionIds` (<=5, each an existing, non-draft `requirement`
 *   version of the token's project) are the version's metadata and `implements` lineage; `reviseArtifactId`, when
 *   given, appends the next version to that existing change-set artifact instead of a new one (CS9: its lineage
 *   `derived_from` the prior version).
 * - The path scope collected under is the token's own `code.edit` capability scope (its `paths` list), never an
 *   agent-supplied argument: an agent cannot ask Nexus to collect outside what it was granted to edit.
 * - `clientKey` makes one register() call one job: the collect job's idempotency key is `changeset.collect:<turn
 *   job>:<clientKey>`, so a retried MCP call (the same callId, or a fresh one with the same clientKey) answers the
 *   same job rather than collecting twice.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CapabilityClaims } from '../../../shared/nexus/tokens';
import type { Principal } from '../../../shared/nexus/platform';
import { getRecipe } from '../../../shared/nexus/recipes';
import { PlatformError } from '../errors';
import { immediateTx } from '../db/tx';
import { appendJobEventTx } from '../exec/events';
import type { JobService } from '../jobs/jobService';

/** How long `register()` waits for the collect job to be ingested before answering `pending` (F23's 120 s). */
export const CHANGESET_REGISTER_WAIT_MS = 120_000;
const POLL_MS = 25;
export const MAX_TITLE_CHARS = 200;
export const MAX_SUMMARY_CHARS = 4000;
export const MAX_REQUIREMENTS = 5;
const TERMINAL_JOB_STATES = ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'];

export interface ChangeSetRegisterArgs {
  title: string;
  summary: string;
  requirementVersionIds?: string[];
  reviseArtifactId?: string;
  clientKey: string;
}
export interface ChangeSetRegisterResult {
  versionId: string;
  artifactId: string;
  status: string;
}
export type ChangeSetRegisterAnswer = ChangeSetRegisterResult | { pending: string };

export interface ChangeSetServiceDeps {
  jobs: JobService;
  system: Principal;
  now: () => number;
  /** Overridden in tests so CS13 does not wait a real 120 s. */
  waitMs?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ChangeSetService {
  constructor(private readonly db: Database.Database, private readonly deps: ChangeSetServiceDeps) {}

  /** The project repository's recorded branch (the snapshot's `metadata.branch`), or null without one. */
  private branchOf(projectId: string): string | null {
    const row = this.db.prepare(`SELECT v.metadata_json FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id
      WHERE a.project_id = ? AND a.kind = 'repository' AND a.status = 'active' AND v.status IN ('draft','candidate','active')
      ORDER BY (v.id = a.current_version_id) DESC, v.version_no DESC LIMIT 1`).get(projectId) as { metadata_json: string } | undefined;
    let meta: unknown = null;
    try { meta = row ? JSON.parse(row.metadata_json) : null; } catch { meta = null; }
    const b = isObj(meta) ? meta.branch : null;
    return typeof b === 'string' && b.length > 0 ? b : null;
  }

  /**
   * The `code.edit` capability's own scope (`paths`), never an agent-supplied argument. `pathInScope` (the
   * `git.paths_in_scope` validator) reads an empty list as "nothing in scope", so a capability with no `scope` at
   * all (unrestricted in the domain model) collects under the whole tree (`['**']`), not under nothing.
   */
  private scopeOf(claims: CapabilityClaims): string[] {
    const cap = claims.caps.find((c) => c.id === 'code.edit') as { scope?: { paths?: unknown } } | undefined;
    const paths = cap?.scope?.paths;
    const list = Array.isArray(paths) ? paths.filter((x): x is string => typeof x === 'string') : [];
    return list.length > 0 ? list : ['**'];
  }

  /** Every requirement version is a `requirement` of this project, not a draft. */
  private requireRequirements(projectId: string, ids: string[]): void {
    for (const id of ids) {
      const r = this.db.prepare(`SELECT v.status, a.kind FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
        WHERE v.id = ? AND v.project_id = ?`).get(id, projectId) as { status: string; kind: string } | undefined;
      if (!r || r.kind !== 'requirement' || r.status === 'draft') {
        throw new PlatformError('invalid', 'a requirement version is not usable', { reason: 'requirement_invalid', versionId: id });
      }
    }
  }

  /** `reviseArtifactId` names an existing `change_set` artifact of this project, owned by the token's participation. */
  private requireRevisable(claims: CapabilityClaims, artifactId: string): void {
    const a = this.db.prepare('SELECT project_id, kind, owner_participation_id FROM artifacts WHERE id = ?').get(artifactId) as
      { project_id: string; kind: string; owner_participation_id: string | null } | undefined;
    if (!a || a.project_id !== claims.projectId || a.kind !== 'change_set' || a.owner_participation_id !== claims.participationId) {
      throw new PlatformError('invalid', 'reviseArtifactId does not name a revisable change set', { reason: 'not_revisable' });
    }
  }

  async register(claims: CapabilityClaims, args: ChangeSetRegisterArgs): Promise<ChangeSetRegisterAnswer> {
    if (typeof args?.title !== 'string' || args.title.trim().length === 0 || args.title.length > MAX_TITLE_CHARS) {
      throw new PlatformError('invalid', `title must be 1 to ${MAX_TITLE_CHARS} characters`);
    }
    if (typeof args.summary !== 'string' || args.summary.length > MAX_SUMMARY_CHARS) {
      throw new PlatformError('invalid', `summary must be at most ${MAX_SUMMARY_CHARS} characters`);
    }
    const requirementVersionIds = Array.isArray(args.requirementVersionIds) ? [...new Set(args.requirementVersionIds)] : [];
    if (requirementVersionIds.length > MAX_REQUIREMENTS) throw new PlatformError('invalid', `at most ${MAX_REQUIREMENTS} requirements`);
    this.requireRequirements(claims.projectId, requirementVersionIds);
    if (args.reviseArtifactId !== undefined) this.requireRevisable(claims, args.reviseArtifactId);
    const branch = this.branchOf(claims.projectId);
    if (!branch) throw new PlatformError('invalid', 'the project repository has no recorded branch yet', { reason: 'branch_unknown' });
    const recipe = getRecipe('changeset.collect');
    if (!recipe) throw new PlatformError('unavailable', 'changeset.collect is not in this build');
    const scope = this.scopeOf(claims);
    const seq = sha256(`${claims.jobId}:${args.clientKey}`).slice(0, 16);
    const now = this.deps.now();
    const jobId = immediateTx(this.db, () => {
      const res = this.deps.jobs.createTx(this.deps.system, {
        kind: 'tool.run', projectId: claims.projectId, workspaceId: claims.workspaceId, sessionId: claims.sessionId,
        parentJobId: claims.jobId, idempotencyKey: `changeset.collect:${claims.jobId}:${seq}`, recipeId: recipe.id,
        params: {
          sessionId: claims.sessionId, branch, scope, title: args.title, summary: args.summary,
          requirementVersionIds, ...(args.reviseArtifactId ? { reviseArtifactId: args.reviseArtifactId } : {}),
          turnJobId: claims.jobId
        },
        retry: { idempotent: false, maxAttempts: 1, backoffMs: [] }
      });
      if (res.created) {
        const cap = { action: 'changeset.collect', recipe: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, network: recipe.network };
        this.db.prepare('UPDATE jobs SET capabilities_json = ?, limits_json = ? WHERE id = ?')
          .run(JSON.stringify([cap]), JSON.stringify({ wallClockMs: recipe.wallClockMs }), res.job.id);
        appendJobEventTx(this.db, { type: 'job.transition', summary: 'job queued: collect the change set', projectId: claims.projectId,
          jobId: res.job.id, data: { from: null, to: 'queued', recipe: recipe.id, parent: claims.jobId } }, now);
      }
      return res.job.id;
    });
    return this.waitForIngest(jobId);
  }

  /** Polls for the version `changeset.collect`'s ingest produced, or the job's failure, up to `waitMs`. */
  private async waitForIngest(jobId: string): Promise<ChangeSetRegisterAnswer> {
    const waitMs = this.deps.waitMs ?? CHANGESET_REGISTER_WAIT_MS;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const v = this.db.prepare(`SELECT id, artifact_id, status FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = 'head' LIMIT 1`)
        .get(jobId) as { id: string; artifact_id: string; status: string } | undefined;
      if (v) return { versionId: v.id, artifactId: v.artifact_id, status: v.status };
      const j = this.db.prepare('SELECT state, error_json, outcome FROM jobs WHERE id = ?').get(jobId) as
        { state: string; error_json: string | null; outcome: string | null } | undefined;
      if (j && TERMINAL_JOB_STATES.includes(j.state)) {
        let code = j.outcome ?? 'collect_failed';
        let message = 'the change set could not be collected';
        try {
          const e = j.error_json ? JSON.parse(j.error_json) as { code?: unknown; message?: unknown } : null;
          if (e && typeof e.code === 'string') code = e.code;
          if (e && typeof e.message === 'string') message = e.message;
        } catch { /* kept */ }
        // The platform's own error codes are a closed set; the collect's exact refusal code (e.g. `file_too_large`,
        // `link_or_gitlink`) travels in `detail.reason`, which the MCP gateway's catch-all does not read today, so
        // a caller of this service reads it there (this test's `caught.detail.reason`).
        throw new PlatformError('invalid', message, { reason: code });
      }
      if (Date.now() >= deadline) return { pending: jobId };
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }
}
