/**
 * Accept a reviewed change set, and "Merge accepted work" (B2b Task 9; D-B6, D-B13, F11).
 *
 * ACCEPT never touches the user's checked-out branch, index or files: it moves ONE hidden ref, `refs/nexus/accepted/<branch>`,
 * by compare-and-swap, in the engine job `changeset.accept` (src/runner/gitWrite.ts). `accept(user, versionId, expectedHead)`:
 *   1. one IMMEDIATE transaction: the version is a `change_set` CANDIDATE and its newest review approves it (else
 *      `illegal_transition`); the system child job `changeset.accept { versionId, branch, expectedOld, head, title,
 *      acceptedBy }` is inserted. The job row is the durable "accepting" marker. A second click joins the live job.
 *   2. the runner runs `merge-tree --write-tree`, `commit-tree` (Nexus <agent@nexus.invalid>, trailer
 *      `Nexus-Accepted-By: user:local`), reports `accept.prepared { old, new }`, and only then `update-ref <ref> <new> <old>`.
 *   3. ingest (exec/acceptIngest.ts), ONE transaction with the job's completion: the accept-time `git.applies_cleanly`
 *      result (advisory: the version is no longer a draft), the version promoted BY THE USER (compare-and-swap), the
 *      `change_set_accepts` row. If that fails (a trigger, a reject recorded meanwhile, the version no longer a candidate),
 *      the SAME transaction queues `changeset.accept_rollback { from: new, to: old }` and the job fails `accept_rolled_back`.
 *   4. recovery (exec/recovery.ts) and this service answer an accept that ended without an accept row, whose
 *      `accept.prepared` exists, with the same rollback: an accept is never retried and never merged later.
 *   The answer is `{ version, accept }` or a PlatformError: `conflict` with `detail.reason` `ref_moved` (and `current`),
 *   `merge_conflict` (the version is NOT touched; an advisory failed `git.applies_cleanly` row records it),
 *   `accept_rolled_back`; `illegal_transition` for a version that is not an approved candidate.
 *
 * `status(user, projectId)` reads the repository through the runner (`GitRead`) and says: the branch, the integration head,
 * how many accepted commits the branch lacks, whether the user's tree is clean and whether it can fast-forward, and
 * `integrationConsistent` (O25): the integration head must equal the newest accept's `ref_after`, or the initial head
 * (the base of the first worktree) while nothing was accepted. A ref moved by hand, or by an accept that did not finish,
 * reads false and "Merge" is refused.
 *
 * `mergeAccepted(user, projectId, { branch, expectedAcceptedHead }, confirm)` refuses (PlatformError `conflict`,
 * `detail.reason`): `integration_unexpected` (O25 fails, nothing was accepted, or the integration head is not the one the
 * caller saw), `branch_mismatch`, `tree_dirty`, `not_fast_forward`, `nothing_to_merge`, `cancelled` (the dialog said no).
 * Otherwise the system child job `repo.ff { branch, sha: expectedAcceptedHead, mergedBy, confirmedVia: 'dialog' }` runs
 * `symbolic-ref HEAD` (re-checked right before) and `git merge --ff-only <sha>` for that sha ONLY: a ref that moved after
 * the dialog is never merged, the branch lands on the confirmed commit or the merge refuses. Ingest writes the
 * `repo_merges` row with `sha_confirmed`. Never the system or an agent: `repo.merge` and `changeset.accept` need a user.
 */
import type Database from 'better-sqlite3';
import type { ArtifactVersion, Principal } from '../../../shared/nexus/platform';
import { GIT_DIFF_MAX_BYTES_PER_SIDE } from '../../../shared/nexus/execution';
import { getRecipe } from '../../../shared/nexus/recipes';
import { integrationRefFor } from '../../../shared/nexus/changeSet';
import { appendJobEventTx } from '../exec/events';
import { GIT_FAILURE_TEXT } from '../exec/recovery';
import { GIT_BRANCH_RE } from '../exec/planBuilder';
import type { ArtifactService } from '../artifact/artifactService';
import type { AuthService } from '../auth/authService';
import { requireStoredUser, type PrincipalResolver } from '../auth/principals';
import { immediateTx } from '../db/tx';
import { redactSecretText } from '../activity/redact';
import { PlatformError } from '../errors';
import type { JobService } from '../jobs/jobService';
import { ProjectAccess } from '../project/projectAccess';
import type { ValidationService } from '../validation/validationService';
import * as appliesCleanly from '../validation/validators/appliesCleanly';
import type { GitRead } from './gitRead';
import { enqueueAcceptRollbackTx, endedAcceptJobIds, rollbackNeeded } from './acceptRollback';
import { integrationBaseline, rollbackOutstanding as rollbackOutstandingFor } from './integrationBaseline';

export const ACCEPT_WAIT_MS = 120_000;
const POLL_MS = 25;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const TERMINAL = ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'];
const LIVE = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];

export interface AcceptView {
  versionId: string; projectId: string; integrationRef: string; refBefore: string; refAfter: string; mergeCommit: string;
  acceptJobId: string; acceptedBy: string; acceptedAt: number;
}
export interface MergeView {
  id: string; projectId: string; branch: string; before: string; after: string; shaConfirmed: string; mergedBy: string; mergedAt: number; ffJobId: string;
}
export interface AcceptStatus {
  branch: string; integrationRef: string; integrationHead: string | null;
  /** The user's checked-out branch and its HEAD (null when detached or unreadable). */
  checkedOutBranch: string; head: string | null;
  /**
   * How many ACCEPTED CHANGES (change_set_accepts rows) the branch lacks: the accepts after the newest merge of this branch (all of
   * them when it was never merged), and 0 whenever git says the branch already holds the integration head (a merge made outside
   * Nexus). One accepted change set is one change however many commits it adds to the integration ref.
   */
  acceptedNotMerged: number;
  /** The COMMITS on the integration ref that are not on the branch (git rev-list): an accept adds the change's own commits and the accept commit. */
  commitCount: number;
  fastForward: boolean; userTreeClean: boolean;
  /** O25: the integration head is the newest accept's `ref_after`, or the initial head while nothing was accepted. */
  integrationConsistent: boolean;
  /**
   * B6: the integration ref and the user's branch have each moved on from a common commit (the branch got commits, and accepted work
   * still waits): no resync can happen and "Merge accepted work" cannot fast-forward. A new agent turn then refuses with the
   * reason `integration_diverged`.
   */
  integrationDiverged: boolean;
  /** The newest accept's `ref_after`: the commit "Merge accepted work" would merge (null: nothing accepted yet). */
  lastAcceptedHead: string | null;
}
/** What the confirmation dialog shows (the commits of the work to be merged, from the accept records). */
export interface MergeConfirmInfo {
  projectId: string; branch: string; from: string | null; to: string; commitCount: number;
  accepted: { versionId: string; title: string; mergeCommit: string; acceptedAt: number }[];
}
/**
 * The dialog's answer. `confirmedVia: 'dialog'` on the merge job is SELF-ASSERTED by this service once `confirm` returned exactly
 * `true` (anything else, a throw included, is a cancel). The IPC layer (Task 14) must therefore pass ONLY
 * `ExecutionHandle.confirmMerge` (main's native dialog) as `confirm`: never a value from the renderer, never a stub that says yes.
 */
export type ConfirmMerge = (info: MergeConfirmInfo) => Promise<boolean> | boolean;

export interface AcceptDeps {
  auth: AuthService; principals: PrincipalResolver; artifacts: ArtifactService; jobs: JobService; validation: ValidationService;
  gitRead: GitRead | null; system: Principal; now: () => number;
  /** main's acceptance of a stored project folder (index.ts `acceptFsRoot`); null refuses it. */
  acceptFsRoot: ((root: string) => string | null) | null;
  /** Called after a job was queued (the scheduler's next tick leases it). */
  onQueued?: () => void;
  /** Overridden in tests: how long accept and merge wait for their job (default 120 s). */
  waitMs?: number;
  /** One line per swallowed secondary failure (never a secret, a path or a sha); default: none. */
  log?: (line: string) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const conflict = (reason: string, message: string, more?: Record<string, unknown>): PlatformError => new PlatformError('conflict', message, { reason, ...(more ?? {}) });

/** The project repository's recorded branch (the snapshot's `metadata.branch`), or null. */
export function repoBranchOf(db: Database.Database, projectId: string): string | null {
  const row = db.prepare(`SELECT v.metadata_json FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id
    WHERE a.project_id = ? AND a.kind = 'repository' AND a.status = 'active' AND v.status IN ('draft','candidate','active')
    ORDER BY (v.id = a.current_version_id) DESC, v.version_no DESC LIMIT 1`).get(projectId) as { metadata_json: string } | undefined;
  const meta = row ? parse(row.metadata_json) : null;
  const b = isObj(meta) ? meta.branch : null;
  return typeof b === 'string' && GIT_BRANCH_RE.test(b) ? b : null;
}

interface VersionFacts {
  id: string; project_id: string; status: string; kind: string; artifact_id: string; owner_workspace_id: string | null;
  storage_ref_json: string; metadata_json: string;
}
interface JobLite { state: string; error_json: string | null }

export class AcceptService {
  private readonly access: ProjectAccess;
  /** Projects with a merge in flight (its dialog may be open): a second call answers `merge_pending`, so dialogs never stack. */
  private readonly merging = new Set<string>();
  constructor(private readonly db: Database.Database, private readonly deps: AcceptDeps) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
  }

  // ---------- helpers ----------

  private versionOf(id: unknown): VersionFacts | null {
    if (typeof id !== 'string' || id.length === 0) return null;
    return (this.db.prepare(`SELECT v.id, v.project_id, v.status, a.kind, v.artifact_id, a.owner_workspace_id, v.storage_ref_json, v.metadata_json
      FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`).get(id) as VersionFacts | undefined) ?? null;
  }

  private repoPathOf(projectId: string): string | null {
    const accept = this.deps.acceptFsRoot;
    if (!accept) return null;
    const p = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string | null } | undefined;
    if (!p || typeof p.root_path !== 'string' || p.root_path.length === 0) return null;
    try { return accept(p.root_path); } catch { return null; }
  }

  private newestReview(versionId: string): string | null {
    return (this.db.prepare('SELECT decision FROM reviews WHERE version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(versionId) as
      { decision: string } | undefined)?.decision ?? null;
  }

  private acceptRow(versionId: string): AcceptView | null {
    const r = this.db.prepare('SELECT * FROM change_set_accepts WHERE version_id = ?').get(versionId) as Record<string, unknown> | undefined;
    return r ? this.toAccept(r) : null;
  }
  private toAccept(r: Record<string, unknown>): AcceptView {
    return { versionId: r.version_id as string, projectId: r.project_id as string, integrationRef: r.integration_ref as string, refBefore: r.ref_before as string,
      refAfter: r.ref_after as string, mergeCommit: r.merge_commit as string, acceptJobId: r.accept_job_id as string, acceptedBy: r.accepted_by as string,
      acceptedAt: r.accepted_at as number };
  }

  private job(id: string): JobLite | null {
    return (this.db.prepare('SELECT state, error_json FROM jobs WHERE id = ?').get(id) as JobLite | undefined) ?? null;
  }
  private errorCode(j: JobLite): string {
    const e = parse(j.error_json);
    return isObj(e) && typeof e.code === 'string' ? e.code : 'failed';
  }

  /** Polls a job to an end state (real wall clock), or throws `accept_pending`/`merge_pending` past `waitMs`. */
  private async untilEnded(jobId: string, pending: string): Promise<JobLite> {
    const deadline = Date.now() + (this.deps.waitMs ?? ACCEPT_WAIT_MS);
    for (;;) {
      const j = this.job(jobId);
      if (j && TERMINAL.includes(j.state)) return j;
      if (Date.now() >= deadline) throw conflict(pending, 'it is still running; ask again in a moment', { jobId });
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  private createGitJob(recipeId: 'changeset.accept' | 'repo.ff', projectId: string, workspaceId: string, key: string, params: Record<string, unknown>, now: number): string {
    const recipe = getRecipe(recipeId)!;
    const res = this.deps.jobs.createTx(this.deps.system, {
      kind: 'tool.run', projectId, workspaceId, idempotencyKey: key, recipeId, params,
      retry: { idempotent: false, maxAttempts: 1, backoffMs: [] }
    });
    if (res.created) {
      const cap = { action: `system.${recipeId}`, recipe: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, network: recipe.network, profile: null };
      this.db.prepare('UPDATE jobs SET capabilities_json = ?, limits_json = ? WHERE id = ?')
        .run(JSON.stringify([cap]), JSON.stringify({ wallClockMs: recipe.wallClockMs }), res.job.id);
      appendJobEventTx(this.db, { type: 'job.transition', summary: `job queued: ${recipeId === 'repo.ff' ? 'merge accepted work' : 'accept a change set'}`,
        projectId, jobId: res.job.id, data: { from: null, to: 'queued', recipe: recipe.id } }, now);
    }
    return res.job.id;
  }

  // ---------- accept ----------

  async accept(user: Principal, versionId: string, expectedIntegrationHead: string): Promise<{ version: ArtifactVersion; accept: AcceptView }> {
    requireStoredUser(this.deps.principals, this.deps.auth, user, 'changeset.accept', 'artifact_version', 'a change set is accepted by a user');
    const v = this.versionOf(versionId);
    if (!v) { this.deps.auth.require(user, 'changeset.accept', { type: 'platform' }); throw new PlatformError('not_found', 'version not found'); }
    this.access.require(user, v.project_id, 'changeset.accept', v.owner_workspace_id ? { workspaceId: v.owner_workspace_id } : undefined);
    if (typeof expectedIntegrationHead !== 'string' || !COMMIT_RE.test(expectedIntegrationHead)) {
      throw new PlatformError('invalid', 'expectedIntegrationHead must be a full commit id', { reason: 'bad_head' });
    }
    if (v.kind !== 'change_set') throw new PlatformError('invalid', 'only a change set is accepted', { reason: 'not_a_change_set' });
    if (!this.repoPathOf(v.project_id)) throw new PlatformError('unavailable', 'the project folder is not available', { reason: 'project_folder_unavailable' });
    // An accept that ended without its rows is rolled back first (idempotent); one that could not even be queued still blocks below.
    this.reconcileEnded();
    const now = this.deps.now();
    const jobId = immediateTx(this.db, () => {
      const cur = this.versionOf(v.id)!;
      if (cur.status !== 'candidate') throw new PlatformError('illegal_transition', `a ${cur.status} change set cannot be accepted`, { reason: 'not_candidate' });
      if (this.newestReview(v.id) !== 'approve') throw new PlatformError('illegal_transition', 'the change set has no approving review', { reason: 'not_approved' });
      // A second click on the SAME head while the accept runs joins it; a different head never does (the CAS answers it).
      const live = this.db.prepare(`SELECT id FROM jobs WHERE recipe_id = 'changeset.accept' AND json_extract(params_json, '$.versionId') = ?
        AND json_extract(params_json, '$.expectedOld') = ? AND state IN (${LIVE.map(() => '?').join(', ')}) ORDER BY rowid DESC LIMIT 1`)
        .get(v.id, expectedIntegrationHead, ...LIVE) as { id: string } | undefined;
      if (live) return live.id;
      const storage = parse(cur.storage_ref_json); const meta = parse(cur.metadata_json);
      const head = isObj(storage) && typeof storage.commit === 'string' && COMMIT_RE.test(storage.commit) ? storage.commit : null;
      const branch = isObj(meta) && typeof meta.branch === 'string' && GIT_BRANCH_RE.test(meta.branch) ? meta.branch : null;
      if (!head || !branch) throw new PlatformError('invalid', 'the change set records no commit or branch', { reason: 'no_commit' });
      // O25 (I1): never accept on top of a ref Nexus has no record of. An accept whose rollback is still owed (queued, running,
      // failed, or never queued) leaves the ref at an unrecorded commit that holds a change that was never accepted.
      if (!this.consistent(cur.project_id, integrationRefFor(branch), expectedIntegrationHead) || this.rollbackOutstanding(cur.project_id, branch)) {
        throw conflict('integration_unexpected', 'The accepted branch is not where Nexus recorded it (an earlier accept did not finish, or it was changed outside Nexus), so nothing was accepted.');
      }
      const title = isObj(meta) && typeof meta.title === 'string' ? meta.title : 'Agent change';
      // What the user reviewed is `base..head`; the accept refuses (`base_moved`) if base is no longer under the integration head.
      const base = isObj(meta) && typeof meta.base === 'string' && COMMIT_RE.test(meta.base) ? meta.base : null;
      if (!base) throw new PlatformError('invalid', 'the change set records no base commit', { reason: 'no_commit' });
      const seq = (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE recipe_id = 'changeset.accept' AND json_extract(params_json, '$.versionId') = ?").get(v.id) as { n: number }).n + 1;
      const workspaceId = cur.owner_workspace_id;
      if (!workspaceId) throw new PlatformError('invalid', 'the change set has no workspace', { reason: 'no_workspace' });
      return this.createGitJob('changeset.accept', cur.project_id, workspaceId, `changeset.accept:${v.id}:${seq}`,
        { versionId: v.id, branch, expectedOld: expectedIntegrationHead, head, base, title, acceptedBy: user.id }, now);
    });
    this.deps.onQueued?.();
    const ended = await this.untilEnded(jobId, 'accept_pending');
    if (ended.state === 'completed') {
      const accept = this.acceptRow(v.id);
      if (!accept) throw new PlatformError('unavailable', 'the accept finished without a record', { reason: 'accept_unrecorded' });
      return { version: this.deps.artifacts.getVersion(user, v.id), accept };
    }
    await this.afterFailedAccept(v, jobId, ended, expectedIntegrationHead);
    throw new PlatformError('unavailable', 'the accept did not finish', { reason: this.errorCode(ended) });
  }

  /** Maps a failed accept job to its answer (always throws), after making sure an unfinished move is rolled back. */
  private async afterFailedAccept(v: VersionFacts, jobId: string, ended: JobLite, expected: string): Promise<never> {
    const code = this.errorCode(ended);
    this.reconcileEnded();
    // A rollback still owed after the pass (it could not be queued) is said so: the ref may hold an unrecorded commit.
    const info = { jobId, ...(rollbackNeeded(this.db, jobId) ? { rollbackOwed: true } : {}) };
    if (code === 'ref_moved') {
      let current: string | null = null;
      try { current = (await this.readStatus(v.project_id, repoBranchOf(this.db, v.project_id)))?.integrationHead ?? null; } catch { current = null; }
      throw conflict('ref_moved', GIT_FAILURE_TEXT.ref_moved, { current, expected, ...info });
    }
    if (code === 'merge_conflict') {
      // A failure of the advisory row never replaces the refusal the user must see.
      try { this.recordAcceptTimeConflict(v, jobId, expected); } catch (e) { this.note(`the accept-time check row was not written (${(e as { code?: string })?.code ?? (e as Error)?.name ?? 'error'})`); }
      throw conflict('merge_conflict', GIT_FAILURE_TEXT.merge_conflict, info);
    }
    if (code === 'base_moved') throw conflict('base_moved', GIT_FAILURE_TEXT.base_moved, info);
    if (code === 'accept_rolled_back') {
      throw conflict('accept_rolled_back', 'The accept could not be recorded, so the accepted branch was put back as it was. The change is still waiting for you.', info);
    }
    const text = Object.prototype.hasOwnProperty.call(GIT_FAILURE_TEXT, code) ? GIT_FAILURE_TEXT[code] : 'The accept did not finish; nothing was merged.';
    throw new PlatformError('unavailable', text, { reason: code, ...info });
  }

  /** A merge conflict at accept time never touches the version: one advisory `git.applies_cleanly` row (failed) records it. */
  private recordAcceptTimeConflict(v: VersionFacts, jobId: string, integrationHead: string): void {
    const attempt = (this.db.prepare('SELECT MAX(n) AS n FROM job_attempts WHERE job_id = ?').get(jobId) as { n: number | null }).n;
    if (attempt === null) return;
    if (this.db.prepare('SELECT 1 FROM validations WHERE job_id = ? AND validator_id = ?').get(jobId, appliesCleanly.ID)) return;
    const storage = parse(v.storage_ref_json);
    const head = isObj(storage) && typeof storage.commit === 'string' ? storage.commit : null;
    if (!head) return;
    this.deps.validation.recordOutcomeTx(v.id, appliesCleanly.ID, appliesCleanly.run({ head, integrationHead, clean: false }), { jobId, attemptN: attempt });
  }

  /**
   * Accept jobs that ended without an accept row but did report `accept.prepared`: the integration ref may be where the
   * accept left it, so the rollback is queued (idempotent by key; never a retry). Restart recovery does the same at startup.
   */
  reconcileEnded(): { queued: number; failed: number } {
    let queued = 0; let failed = 0;
    for (const id of endedAcceptJobIds(this.db)) {
      const n = rollbackNeeded(this.db, id);
      if (!n) continue;
      try {
        immediateTx(this.db, () => enqueueAcceptRollbackTx(this.db, this.deps.jobs, this.deps.system, this.deps.now(),
          { jobId: n.job.id, projectId: n.job.project_id, workspaceId: n.job.workspace_id, branch: n.branch, versionId: n.versionId, move: n.move }));
        queued++;
      } catch (e) {
        // Never silent: the rollback stays owed (accept and merge refuse meanwhile) and the next pass tries again.
        failed++;
        this.note(`a rollback of an unfinished accept could not be queued (${(e as { code?: string })?.code ?? (e as Error)?.name ?? 'error'}); it is retried`);
      }
    }
    if (queued > 0) this.deps.onQueued?.();
    return { queued, failed };
  }

  private note(line: string): void {
    try { this.deps.log?.(`[nexus] ${redactSecretText(line).slice(0, 300)}`); } catch { /* a logger never breaks the refusal */ }
  }

  /** True while an accept's rollback for this project and branch is owed: queued, running, failed or not yet queued. */
  private rollbackOutstanding(projectId: string, branch: string): boolean {
    return rollbackOutstandingFor(this.db, projectId, branch);
  }

  // ---------- status (O25) ----------

  private lastAccept(projectId: string, integrationRef: string): { ref_after: string } | null {
    return (this.db.prepare('SELECT ref_after FROM change_set_accepts WHERE project_id = ? AND integration_ref = ? ORDER BY rowid DESC LIMIT 1')
      .get(projectId, integrationRef) as { ref_after: string } | undefined) ?? null;
  }

  /**
   * O25: the integration head is the RECORDED head (integrationBaseline.ts: the end of the chain of the initial head, the accepts and
   * the resyncs). A ref that is not there, or a chain that is unknown or forks, is never consistent; a missing ref is consistent
   * only while nothing was ever accepted or resynced.
   */
  private consistent(projectId: string, integrationRef: string, integrationHead: string | null): boolean {
    const b = integrationBaseline(this.db, projectId, integrationRef);
    if (integrationHead === null) return !b.records.some((r) => r.kind !== 'initial');
    return b.known && b.head === integrationHead;
  }

  private async readStatus(projectId: string, branch: string | null): Promise<AcceptStatus> {
    if (!branch) throw new PlatformError('unavailable', 'the project repository has no recorded branch yet', { reason: 'branch_unknown' });
    const repoPath = this.repoPathOf(projectId);
    if (!repoPath) throw new PlatformError('unavailable', 'the project folder is not available', { reason: 'project_folder_unavailable' });
    if (!this.deps.gitRead) throw new PlatformError('unavailable', 'the repository cannot be read right now', { reason: 'runner_unavailable' });
    const integrationRef = integrationRefFor(branch);
    const r = await this.deps.gitRead.request({ read: 'status', repoPath, branch, integrationRef });
    if (!r.ok || r.read !== 'status') throw new PlatformError('unavailable', r.ok ? 'the repository did not answer' : r.message, { reason: r.ok ? 'error' : r.code });
    const last = this.lastAccept(projectId, integrationRef);
    const pending = r.acceptedNotMerged === 0 ? 0 : this.acceptsSinceMerge(projectId, branch, integrationRef, 1).count;
    return { branch, integrationRef, integrationHead: r.integrationHead, checkedOutBranch: r.branch, head: r.head, acceptedNotMerged: pending,
      commitCount: r.acceptedNotMerged, fastForward: r.fastForward, userTreeClean: !r.dirty, integrationConsistent: this.consistent(projectId, integrationRef, r.integrationHead),
      // Both sides have commits the other lacks: the integration ref cannot move forward to the branch, nor the branch to it (B6).
      // Only accepted work that waits can make it a divergence (with nothing accepted a rewritten branch is simply resynced).
      integrationDiverged: r.integrationHead !== null && r.head !== null && pending > 0 && !r.fastForward,
      lastAcceptedHead: last?.ref_after ?? null };
  }

  async status(user: Principal, projectId: string): Promise<AcceptStatus> {
    this.access.require(user, projectId, 'project.read');
    this.reconcileEnded();
    return this.readStatus(projectId, repoBranchOf(this.db, projectId));
  }

  // ---------- the diff of a change set (B2b Task 14, F19) ----------

  /**
   * The patch between a change set's RECORDED base (`metadata.base`) and head (`storage.commit`), by the runner's bounded git
   * read (1 MiB per side) and redacted again here. Nothing the renderer sends names a commit. A change set only: any other kind
   * is refused (`no_such_part`). A diff larger than the cap answers `too_large`; a read that fails says so in a fixed sentence.
   */
  async diff(user: Principal, versionId: string): Promise<{ patch: string; bytes: number }> {
    const v = this.versionOf(versionId);
    if (!v) { this.deps.auth.require(user, 'project.read', { type: 'platform' }); throw new PlatformError('not_found', 'version not found'); }
    this.access.require(user, v.project_id, 'artifact.read', v.owner_workspace_id ? { workspaceId: v.owner_workspace_id } : undefined);
    if (v.kind !== 'change_set') throw new PlatformError('invalid', `a ${v.kind} version has no diff to preview`, { reason: 'no_such_part' });
    const storage = parse(v.storage_ref_json); const meta = parse(v.metadata_json);
    const head = isObj(storage) && typeof storage.commit === 'string' && COMMIT_RE.test(storage.commit) ? storage.commit : null;
    const base = isObj(meta) && typeof meta.base === 'string' && COMMIT_RE.test(meta.base) ? meta.base : null;
    if (!head || !base) throw new PlatformError('unavailable', 'the change set records no commits to compare', { reason: 'no_commit' });
    const repoPath = this.repoPathOf(v.project_id);
    if (!repoPath) throw new PlatformError('unavailable', 'the project folder is not available', { reason: 'project_folder_unavailable' });
    if (!this.deps.gitRead) throw new PlatformError('unavailable', 'the repository cannot be read right now', { reason: 'runner_unavailable' });
    const r = await this.deps.gitRead.request({ read: 'diff', repoPath, base, head, maxBytesPerSide: GIT_DIFF_MAX_BYTES_PER_SIDE });
    const tooLarge = (): PlatformError => new PlatformError('too_large', 'This change is too large to show here.', { versionId: v.id });
    if (!r.ok) {
      if (r.code === 'too_large') throw tooLarge();
      const text = r.code === 'git_missing' ? GIT_FAILURE_TEXT.git_missing : r.code === 'unknown_ref' ? GIT_FAILURE_TEXT.unknown_commit : 'The change could not be read from the repository.';
      throw new PlatformError('unavailable', text, { reason: r.code });
    }
    if (r.read !== 'diff') throw new PlatformError('unavailable', 'The change could not be read from the repository.', { reason: 'error' });
    if (r.truncated) throw tooLarge();
    return { patch: redactSecretText(r.patch), bytes: r.bytes };
  }

  // ---------- merge accepted work ----------

  /** The accepts since the newest merge of this branch (all of them when it was never merged): their number, and up to `limit` rows, oldest first. */
  private acceptsSinceMerge(projectId: string, branch: string, integrationRef: string, limit: number):
    { count: number; rows: { version_id: string; merge_commit: string; accepted_at: number; metadata_json: string }[] } {
    const lastMerge = this.db.prepare('SELECT sha_confirmed FROM repo_merges WHERE project_id = ? AND branch = ? ORDER BY rowid DESC LIMIT 1')
      .get(projectId, branch) as { sha_confirmed: string } | undefined;
    const since = lastMerge
      ? (this.db.prepare('SELECT rowid AS r FROM change_set_accepts WHERE project_id = ? AND integration_ref = ? AND ref_after = ?')
        .get(projectId, integrationRef, lastMerge.sha_confirmed) as { r: number } | undefined)?.r ?? 0
      : 0;
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM change_set_accepts WHERE project_id = ? AND integration_ref = ? AND rowid > ?')
      .get(projectId, integrationRef, since) as { n: number }).n;
    const rows = this.db.prepare(`SELECT c.version_id, c.merge_commit, c.accepted_at, v.metadata_json FROM change_set_accepts c
      JOIN artifact_versions v ON v.id = c.version_id WHERE c.project_id = ? AND c.integration_ref = ? AND c.rowid > ? ORDER BY c.rowid LIMIT ?`)
      .all(projectId, integrationRef, since, limit) as { version_id: string; merge_commit: string; accepted_at: number; metadata_json: string }[];
    return { count, rows };
  }

  private mergeInfo(projectId: string, s: AcceptStatus, to: string): MergeConfirmInfo {
    const rows = this.acceptsSinceMerge(projectId, s.branch, s.integrationRef, 50).rows;
    return { projectId, branch: s.branch, from: s.head, to, commitCount: s.commitCount, accepted: rows.map((r) => {
      const m = parse(r.metadata_json);
      return { versionId: r.version_id, title: isObj(m) && typeof m.title === 'string' ? m.title.slice(0, 200) : 'Agent change', mergeCommit: r.merge_commit, acceptedAt: r.accepted_at };
    }) };
  }

  async mergeAccepted(user: Principal, projectId: string, args: { branch: string; expectedAcceptedHead: string }, confirm: ConfirmMerge): Promise<{ merge: MergeView }> {
    requireStoredUser(this.deps.principals, this.deps.auth, user, 'repo.merge', 'repo_merge', 'accepted work is merged by a user');
    this.access.require(user, projectId, 'repo.merge');
    if (!isObj(args) || typeof args.branch !== 'string' || !GIT_BRANCH_RE.test(args.branch) || typeof args.expectedAcceptedHead !== 'string'
      || !COMMIT_RE.test(args.expectedAcceptedHead) || typeof confirm !== 'function') {
      throw new PlatformError('invalid', 'a merge names its branch and the accepted commit it was shown', { reason: 'bad_args' });
    }
    // One merge per project at a time (single-flight): a second quick call neither opens a second dialog nor queues a second job.
    if (this.merging.has(projectId)) throw conflict('merge_pending', 'A merge for this project is already waiting for you or running. Ask again in a moment.');
    this.merging.add(projectId);
    try { return await this.runMerge(user, projectId, args, confirm); } finally { this.merging.delete(projectId); }
  }

  private async runMerge(user: Principal, projectId: string, args: { branch: string; expectedAcceptedHead: string }, confirm: ConfirmMerge): Promise<{ merge: MergeView }> {
    const sha = args.expectedAcceptedHead;
    if (args.branch !== repoBranchOf(this.db, projectId)) throw conflict('branch_mismatch', GIT_FAILURE_TEXT.branch_mismatch);
    this.reconcileEnded();
    const s = await this.readStatus(projectId, args.branch);
    // O25 first: a ref moved by hand (or by an accept that did not finish) is never offered for merging.
    if (!s.integrationConsistent || this.rollbackOutstanding(projectId, args.branch) || s.lastAcceptedHead === null || s.integrationHead !== sha || s.lastAcceptedHead !== sha) {
      throw conflict('integration_unexpected', 'The accepted work is not what Nexus recorded (its branch was changed outside Nexus, or an accept did not finish), so nothing was merged.');
    }
    if (s.checkedOutBranch !== args.branch) throw conflict('branch_mismatch', GIT_FAILURE_TEXT.branch_mismatch);
    if (!s.userTreeClean) throw conflict('tree_dirty', GIT_FAILURE_TEXT.tree_dirty);
    if (s.head === sha || s.acceptedNotMerged === 0) throw conflict('nothing_to_merge', 'Your branch already has all the accepted work.');
    if (!s.fastForward) throw conflict('not_fast_forward', GIT_FAILURE_TEXT.not_fast_forward);
    let confirmed = false;
    try { confirmed = (await confirm(this.mergeInfo(projectId, s, sha))) === true; } catch { confirmed = false; }
    if (!confirmed) throw conflict('cancelled', 'The merge was cancelled; nothing was changed.');
    // The job merges `sha` (the commit the dialog showed) whatever the integration ref is by now.
    const now = this.deps.now();
    const jobId = immediateTx(this.db, () => {
      const live = this.db.prepare(`SELECT id FROM jobs WHERE recipe_id = 'repo.ff' AND project_id = ? AND json_extract(params_json, '$.sha') = ?
        AND state IN (${LIVE.map(() => '?').join(', ')}) ORDER BY rowid DESC LIMIT 1`).get(projectId, sha, ...LIVE) as { id: string } | undefined;
      if (live) return live.id;
      const ws = this.db.prepare(`SELECT a.owner_workspace_id AS w FROM change_set_accepts c JOIN artifact_versions v ON v.id = c.version_id
        JOIN artifacts a ON a.id = v.artifact_id WHERE c.project_id = ? AND c.integration_ref = ? AND c.ref_after = ?`)
        .get(projectId, s.integrationRef, sha) as { w: string | null } | undefined;
      if (!ws?.w) throw conflict('integration_unexpected', 'The commit is not one Nexus accepted, so nothing was merged.');
      const seq = (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE recipe_id = 'repo.ff' AND project_id = ? AND json_extract(params_json, '$.sha') = ?").get(projectId, sha) as { n: number }).n + 1;
      return this.createGitJob('repo.ff', projectId, ws.w, `repo.ff:${projectId}:${sha}:${seq}`,
        { branch: args.branch, sha, mergedBy: user.id, confirmedVia: 'dialog' }, now);
    });
    this.deps.onQueued?.();
    const ended = await this.untilEnded(jobId, 'merge_pending');
    if (ended.state === 'completed') {
      const r = this.db.prepare('SELECT * FROM repo_merges WHERE ff_job_id = ?').get(jobId) as Record<string, unknown> | undefined;
      if (!r) throw new PlatformError('unavailable', 'the merge finished without a record', { reason: 'merge_unrecorded' });
      return { merge: { id: r.id as string, projectId: r.project_id as string, branch: r.branch as string, before: r.before as string, after: r.after as string,
        shaConfirmed: r.sha_confirmed as string, mergedBy: r.merged_by as string, mergedAt: r.merged_at as number, ffJobId: r.ff_job_id as string } };
    }
    const code = this.errorCode(ended);
    if (code === 'tree_dirty' || code === 'branch_mismatch' || code === 'not_fast_forward') throw conflict(code, GIT_FAILURE_TEXT[code], { jobId });
    throw new PlatformError('unavailable', Object.prototype.hasOwnProperty.call(GIT_FAILURE_TEXT, code) ? GIT_FAILURE_TEXT[code] : 'The merge did not finish; check your branch.',
      { reason: code, jobId });
  }
}
