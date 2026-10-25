/**
 * Ingest of runner outputs (architecture §12.7, B2a). The execution core calls it after an attempt's exit is
 * durable: `prepare` (async, outside any transaction) gathers what main observes itself (its own `resolveCommit`
 * for a snapshot); `ingestTx` then runs inside ONE IMMEDIATE transaction, under the shared blob ingest lock, and
 * the core moves the attempt to `succeeded` and the job to `completed` in that same transaction, or fails both.
 *
 * In the transaction, per recipe:
 * - contract: the outputs the recipe needs are re-read from the report (shapes re-validated, never trusted);
 * - refusals, deterministic and never retried (`invalid_output` with the reason): a secret-shaped value in what
 *   would be stored (`secret_in_output`: a branch, a discovered test name, a manifest argument, a provider-key shape
 *   in a build output file name), a discovered list
 *   a test run cannot take whole (`discovery_too_large`: more than MAX_DISCOVERED_FILES files, or more than a
 *   version's metadata holds), an output tree over MAX_TREE_FILES files (`tree_too_large`), the project's
 *   repository archived (`repository_archived`);
 * - targets: a new or existing artifact owned by the job's participation, or the project's one `repository`;
 * - versions: drafts with `output_path`, `environment_json` (the attempt's, exactly) and `storage_kind`
 *   `inline` / `git` / `tree`, written whole while draft (ArtifactService.insertSystemVersionTx), with the
 *   producing attempt in `version_attempts`; blobs recorded and attached (role `discovery`, `file`, `junit`);
 *   a discovered list is kept WHOLE in the suite's metadata (the test plan runs exactly it);
 * - lineage: edges to the job's granted inputs (source `job_input`) and to the previous version (source `ingest`);
 * - validators: register validators inline (ValidationService.runRegisterTx), then the finalize rule, then the
 *   candidate validate jobs (ValidationService.enqueueCandidate);
 * - idempotent: by `(produced_by_job_id, output_path)`, and by content hash (the same commit, the same list,
 *   the same tree). Output that deduplicates to an existing version still records a validation bound to
 *   (job, attempt n), so the evidence backstop sees the attempt's evidence; on a version that is no longer a
 *   draft that row is advisory (ValidationService), and onto a draft it finalizes it and queues its candidate
 *   checks when it is ready for them.
 * - a user's test run on a candidate suite records its result (advisory) and keeps its JUnit bytes as a blob
 *   named by the result's evidence (the suite itself is immutable).
 *
 * - a diagnosis (B2a Task 12): the runner's facts re-validated, main's own probe table of the deployment added, the report
 *   stored inline as a `diagnostic_report` draft (lineage to the previewed application), `diag.schema` run, finalized.
 *
 * - a dependency install (B2a Task 13 fix round 1, the `deps` rule): exit 0 is required and never enough. The run must
 *   leave exactly its contract output `lock.sha256`, which `prepare` reads back from the blob store (small; its sha256
 *   re-checked); `sde.deps.lock_matches` then requires 64 lowercase hex characters equal to BOTH the input repository
 *   version's `metadata.lockfile.sha256` and the `lockfileSha256` of the approval consumed by THIS attempt. A missing file
 *   is refused `missing_output`; a mismatch, an extra output, non-hex content or a secret-shaped value `invalid_output`;
 *   nothing is stored on a refusal. On a pass the result is recorded ADVISORY on the repository version, bound to (job, n).
 * - a failing test run (fix round 1): the failed and errored cases of the runner's normalized JUnit are kept with the
 *   `sde.tests_pass` result as `case` evidence (failures first, at most MAX_LISTED_CASES and CASE_EVIDENCE_BUDGET, names
 *   redacted and capped), the per-case table the junit_summary preview pages.
 *
 * - a session worktree (B2b Task 7, the `worktree` rule): the runner's `git-facts` re-validated against what main derives
 *   from the job's own params (the ref and folder named after the session, lowercased; the integration ref of its
 *   branch; two full commits; locked), then ONE `session_worktrees` row (v10) in this transaction: the row exists only
 *   once the worktree does (task 2's ruling). A row already recorded for the session with the same identity is the
 *   answer (idempotent); one with another identity is refused.
 * - a rollback of an unfinished accept (B2b Task 7, the `gitFacts` rule): its facts re-validated; the job completes.
 *
 * A recipe without an ingest rule here is refused with `ingest_unavailable` / `no_ingest_rule`: unfinished work is never
 * completed.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { StagedOutput } from '../../../shared/nexus/execution';
import type { Principal } from '../../../shared/nexus/platform';
import { containsSecret, REDACTED, redactSecretText } from '../activity/redact';
import { hasProviderKey } from '../../../shared/nexus/secretShape';
import type { ArtifactService } from '../artifact/artifactService';
import { INLINE_MAX_BYTES } from '../artifact/versionRules';
import type { BlobIndex, IngestToken } from '../blobs/blobIndex';
import { PlatformError } from '../errors';
import type { ResolveCommit, ValidationService } from '../validation/validationService';
import { checkDiagnosis, checkDiscovery, checkGitFacts, COMMIT_RE, type ValidatorOutcome } from '../validation/normalized';
import * as tests from '../validation/validators/testsPass';
import * as depsLock from '../validation/validators/depsLockMatches';
import { MAX_CASE_TEXT } from '../validation/evidenceShape';
import type { Evidence } from '../../../shared/nexus/evidence';
import { manifestSha256, exitZero, EXIT_ZERO, type TreeFile } from '../validation/validators/buildChecks';
import type { AttemptExited, IngestContext, IngestDecision, IngestPort } from './executionService';
import { MAX_DISCOVERED_FILES } from './planBuilder';
import { acceptManifestReport, APP_MANIFEST_MAX_BYTES, readAppManifest } from '../repo/repoService';
import { buildDiagnosticReport, type ProbeTable } from './diagnosticReport';
import { appendActivityRow } from '../activity/writer';

export type { AttemptExited };

export interface IngestDeps {
  artifacts: ArtifactService;
  validation: ValidationService;
  blobs: BlobIndex | null;
  now: () => number;
  /** main's own async commit resolution in the project folder (src/main/git.ts resolveCommit). */
  resolveCommit?: ResolveCommit | null;
  /** Fault injection for tests: called inside the transaction after the version rows are written. */
  faults?: { afterRows?: (recipeId: string) => void } | null;
  /**
   * The blob store's bytes (main's data home, src/main/nexusExec/dataHome.ts): a stored object of at most `maxBytes`,
   * read through its confined path; `null` when it is not there, `'too_large'` when it is larger.
   */
  objects?: { readObjectBytes(sha256: string, maxBytes: number): Promise<Buffer | 'too_large' | null> } | null;
}

interface VersionRow { id: string; artifact_id: string; status: string; content_hash: string; storage_ref_json: string; metadata_json: string; draft_flag: string | null }
interface InputRow { version_id: string; role: string; status: string; storage_ref_json: string; metadata_json: string; kind: string }

const ok: IngestDecision = { ok: true };
const refuse = (outcome: string, code: string, message: string): IngestDecision => ({ ok: false, outcome, error: { code, message } });
const secretRefusal = (what: string): IngestDecision =>
  refuse('invalid_output', 'secret_in_output', `the ${what} holds a secret-shaped value; nothing was stored`);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
/** The most files a build output tree may hold (the ingest transaction stays bounded; the blob index takes 10,000 per call). */
export const MAX_TREE_FILES = 5000;

/** The ingest rule of each recipe: the one dispatch table of `ingestTx` (B2a Task 13 pins it to the registry's B2A_IMPL). */
export const INGEST_RULES: Readonly<Record<string, 'snapshot' | 'discovery' | 'testRun' | 'build' | 'assemble' | 'diagnose' | 'deps' | 'worktree'
  | 'gitFacts'>> = Object.freeze({
  'repo.snapshot': 'snapshot', 'sde.test.discover': 'discovery', 'sde.test.node': 'testRun', 'sde.test.pytest': 'testRun',
  'sde.build.node': 'build', 'sde.build.python': 'build', 'sde.app.assemble': 'assemble', 'sde.diagnose': 'diagnose',
  'sde.deps.node': 'deps', 'sde.deps.python': 'deps',
  // B2b Task 7: the session worktree row, and an accept's rollback.
  'repo.worktree': 'worktree', 'changeset.accept_rollback': 'gitFacts'
});
/**
 * The implemented recipes whose outputs are never ingested, each with why: a dev deployment is a service (its evidence is
 * `app.preview_health`, recorded while it runs).
 */
export const NOT_INGESTED: Readonly<Record<string, string>> = Object.freeze({
  'sde.preview.start': 'a service: its evidence is app.preview_health',
  // B2b Task 7 plans and runs these git writes; what their facts become is recorded by the services that queue them. Until
  // that ingest lands, a finished job of these recipes is refused (`ingest_unavailable`): unfinished work never completes.
  'changeset.collect': 'its change_set version, lineage and register validators are recorded by the change-set service (B2b Task 8)',
  'changeset.merge_check': 'its result is the git.applies_cleanly validation, recorded by the change-set checks (B2b Task 8)',
  'changeset.accept': 'its promotion and accept row are recorded by the accept service in one transaction with a rollback (B2b Task 9)',
  'repo.ff': 'its repo_merges row is recorded by the accept service after the dialog-confirmed merge (B2b Task 9)'
});
/**
 * The validators an ingest rule records that are not run through `runPure` (the registry check derives main's dispatched
 * validators from this table): a test run records `sde.tests_pass` for the suite it ran (the `testRun` rule).
 */
const TEST_RUN_RECORDS: string = tests.ID;
export const INGEST_RECORDED_VALIDATORS: Readonly<Record<string, 'testRun'>> = Object.freeze({ [TEST_RUN_RECORDS]: 'testRun' });
/** The most failed or errored cases a test result lists, and the most characters they take in its evidence. */
export const MAX_LISTED_CASES = 400;
export const CASE_EVIDENCE_BUDGET = 32_768;

/**
 * The failed and errored cases of a normalized JUnit as `case` evidence: failures first, then errors, each name, class
 * and file redacted and capped at MAX_CASE_TEXT; at most MAX_LISTED_CASES items and CASE_EVIDENCE_BUDGET characters. A
 * name still secret-shaped after redaction is replaced whole, so the result never turns into `secret_in_evidence`.
 */
export function failingCaseEvidence(junit: unknown): Evidence[] {
  const j = isObj(junit) && Array.isArray(junit.cases) ? junit.cases : [];
  const cap = (s: unknown): string => {
    const t = redactSecretText(typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f]+/g, ' ');
    const c = t.length > MAX_CASE_TEXT ? `${t.slice(0, MAX_CASE_TEXT - 1)}…` : t;
    return containsSecret(c) ? REDACTED : c;
  };
  const out: Evidence[] = [];
  let used = 0;
  for (const outcome of ['failed', 'errored'] as const) {
    for (const c of j) {
      if (!isObj(c) || c.outcome !== outcome) continue;
      if (out.length >= MAX_LISTED_CASES) return out;
      const item: Evidence = { type: 'case', name: cap(c.name), classname: cap(c.classname),
        file: typeof c.file === 'string' && c.file.length > 0 ? cap(c.file) : null, outcome };
      used += JSON.stringify(item).length + 1;
      if (used > CASE_EVIDENCE_BUDGET) return out;
      out.push(item);
    }
  }
  return out;
}

/** What a diagnosis attempt was planned to read (its sandbox record), or null when the record does not say. */
function plannedDiagnosis(sandboxJson: string | null): { containerIds: string[]; attemptIds: string[] } | null {
  const rec = parse(sandboxJson);
  if (!isObj(rec) || rec.engine !== 'sde.diagnose' || !Array.isArray(rec.containerIds) || !Array.isArray(rec.logRanges)) return null;
  const containerIds: string[] = []; const attemptIds: string[] = [];
  for (const c of rec.containerIds) { if (!isObj(c) || typeof c.sha256 !== 'string') return null; containerIds.push(c.sha256); }
  for (const r of rec.logRanges) { if (!isObj(r) || typeof r.attemptId !== 'string') return null; attemptIds.push(r.attemptId); }
  return { containerIds, attemptIds };
}

export class IngestService implements IngestPort {
  constructor(private readonly db: Database.Database, private readonly deps: IngestDeps) {}

  /**
   * Async facts main observes itself, before the transaction: the snapshot's commit, resolved in the project folder; an
   * install's `lock.sha256`, read back from the blob store (at most LOCK_OUTPUT_MAX_BYTES, its sha256 re-checked).
   */
  prepare(ctx: IngestContext): unknown {
    if (INGEST_RULES[ctx.recipe.id] === 'deps') return this.readLock(ctx);
    if (ctx.recipe.id !== 'repo.snapshot') return null;
    const parsed = ctx.exited.parsed.find((p) => p.parser === 'repo-snapshot')?.normalized
      ?? ctx.exited.parsed.find((p) => isObj(p.normalized))?.normalized;
    const g = checkGitFacts(parsed);
    if (!g.ok) return { resolved: null };
    const root = this.deps.validation.repoPathOf(ctx.job.project_id);
    const resolve = this.deps.resolveCommit;
    if (!root || !resolve) return { resolved: null };
    return resolve(root, g.value.commit)
      .then((r) => ({ resolved: 'commit' in r ? { commit: r.commit } : { error: String(r.error) } }), () => ({ resolved: { error: 'git_failed' } }));
  }

  ingestTx(ctx: IngestContext): IngestDecision {
    if (!this.db.inTransaction) throw new PlatformError('platform_unavailable', 'ingest runs inside the exit transaction');
    const rule = Object.prototype.hasOwnProperty.call(INGEST_RULES, ctx.recipe.id) ? INGEST_RULES[ctx.recipe.id] : null;
    switch (rule) {
      case 'snapshot': return this.snapshot(ctx);
      case 'discovery': return this.discovery(ctx);
      case 'testRun': return this.testRun(ctx);
      case 'build': return this.build(ctx);
      case 'assemble': return this.assemble(ctx);
      case 'diagnose': return this.diagnose(ctx);
      case 'deps': return this.depsInstall(ctx);
      case 'worktree': return this.worktree(ctx);
      case 'gitFacts': return this.rollbackFacts(ctx);
      default: return refuse('ingest_unavailable', 'no_ingest_rule', `outputs of ${ctx.recipe.id} are not ingested in this build`);
    }
  }

  /** The install's `lock.sha256` as stored (never trusted from the report): `{ lock: { text } | { error } | null }`. */
  private readLock(ctx: IngestContext): unknown {
    const staged = ctx.exited.outputs.filter((o) => o.relPath === depsLock.LOCK_OUTPUT);
    // Missing, repeated or too large: the rule decides from the outputs alone; nothing is read.
    if (staged.length !== 1 || !(staged[0].bytes <= depsLock.LOCK_OUTPUT_MAX_BYTES) || !/^[0-9a-f]{64}$/.test(staged[0].sha256)) return { lock: null };
    const reader = this.deps.objects;
    if (!reader) return { lock: { error: 'no_blob_store' } };
    const want = staged[0].sha256;
    return reader.readObjectBytes(want, depsLock.LOCK_OUTPUT_MAX_BYTES).then((b) => {
      if (b === null) return { lock: { error: 'missing' } };
      if (b === 'too_large') return { lock: { error: 'too_large' } };
      if (createHash('sha256').update(b).digest('hex') !== want) return { lock: { error: 'hash_mismatch' } };
      return { lock: { text: b.toString('utf8') } };
    }, () => ({ lock: { error: 'unreadable' } }));
  }

  // ---------- helpers ----------

  private token(ctx: IngestContext): IngestToken {
    if (!this.deps.blobs || !ctx.token) throw new PlatformError('conflict', 'blob writes need the ingest lock', { reason: 'lock_not_held' });
    return ctx.token;
  }

  private environment(ctx: IngestContext): unknown { return parse(ctx.attempt.environment_json); }

  /** The job's granted inputs of a slot, with their versions. */
  private inputs(jobId: string, role?: string): InputRow[] {
    return this.db.prepare(`SELECT ji.version_id, ji.role, v.status, v.storage_ref_json, v.metadata_json, a.kind FROM job_inputs ji
      JOIN artifact_versions v ON v.id = ji.version_id JOIN artifacts a ON a.id = v.artifact_id
      WHERE ji.job_id = ?${role ? ' AND ji.role = ?' : ''} ORDER BY ji.rowid`).all(...(role ? [jobId, role] : [jobId])) as InputRow[];
  }

  /** A version this job already ingested at this output path (idempotency by (produced_by_job_id, output_path)). */
  private already(jobId: string, outputPath: string): VersionRow | null {
    return (this.db.prepare('SELECT * FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = ?').get(jobId, outputPath) as VersionRow | undefined) ?? null;
  }

  /** The live (draft, candidate or active) version of an artifact with this content, newest first. */
  private sameContent(artifactId: string, contentHash: string): VersionRow | null {
    return (this.db.prepare(`SELECT * FROM artifact_versions WHERE artifact_id = ? AND content_hash = ? AND status IN ('draft','candidate','active')
      ORDER BY version_no DESC LIMIT 1`).get(artifactId, contentHash) as VersionRow | undefined) ?? null;
  }

  /** The newest live version of an artifact (the `derived_from` source of the next one). */
  private latestLive(artifactId: string): VersionRow | null {
    return (this.db.prepare(`SELECT * FROM artifact_versions WHERE artifact_id = ? AND status IN ('draft','candidate','active')
      ORDER BY version_no DESC LIMIT 1`).get(artifactId) as VersionRow | undefined) ?? null;
  }

  /** The participation-owned artifact of this kind and name the job's participation writes to, or null. */
  private ownedArtifact(participationId: string, kind: string, name: string): string | null {
    return (this.db.prepare(`SELECT id FROM artifacts WHERE owner_participation_id = ? AND kind = ? AND name = ? AND status = 'active'
      ORDER BY created_at, id LIMIT 1`).get(participationId, kind, name) as { id: string } | undefined)?.id ?? null;
  }

  private bindAttempt(versionId: string, jobId: string, n: number): void {
    this.db.prepare('INSERT INTO version_attempts (version_id, job_id, attempt_n) VALUES (?, ?, ?)').run(versionId, jobId, n);
  }

  private record(token: IngestToken, outputs: StagedOutput[]): void {
    if (outputs.length) this.deps.blobs!.recordBlobsTx(token, outputs.map((o) => ({ sha256: o.sha256, bytes: o.bytes, mediaType: o.mediaType })));
  }

  /**
   * Output that deduplicates to an existing version: the check still runs and binds this attempt's evidence (advisory
   * when the version is no longer a draft). Onto a draft, the new evidence may make it ready: finalize, then queue its
   * candidate checks (a live one is reused) once its register checks passed.
   */
  private dedupe(ctx: IngestContext, prior: VersionRow, validatorId: string, outcome: ValidatorOutcome): IngestDecision {
    const { job, attempt, system } = ctx;
    this.deps.validation.recordOutcomeTx(prior.id, validatorId, outcome, { jobId: job.id, attemptN: attempt.n });
    if (prior.status === 'draft' && this.deps.validation.finalizeIfReady(system, prior.id) === 'draft' && this.registerPassed(prior.id)) {
      this.deps.validation.enqueueCandidate(system, prior.id, { parentJobId: job.id });
    }
    return ok;
  }

  /** Every blocking register validator of the version's latest blocking rows passed. */
  private registerPassed(versionId: string): boolean {
    return !this.db.prepare(`SELECT 1 FROM validations v WHERE v.version_id = ? AND v.stage = 'register' AND v.blocking = 1 AND v.status <> 'passed'
      AND NOT EXISTS (SELECT 1 FROM validations w WHERE w.version_id = v.version_id AND w.validator_id = v.validator_id AND w.blocking = 1
        AND (w.finished_at > v.finished_at OR (w.finished_at = v.finished_at AND w.rowid > v.rowid)))`).get(versionId);
  }

  // ---------- B2b git writes (engine) ----------

  private gitFacts(ctx: IngestContext): Record<string, unknown> | null {
    const f = ctx.exited.parsed.find((p) => p.parser === 'git-facts')?.normalized;
    return isObj(f) && f.ok === true ? f : null;
  }

  /** `repo.worktree`: one session_worktrees row, only for facts that match what main derives (see the header). */
  private worktree(ctx: IngestContext): IngestDecision {
    const { job, system } = ctx;
    const f = this.gitFacts(ctx);
    if (!f) return refuse('invalid_output', 'parser_contract', 'the worktree facts were not usable');
    const params = parse(job.params_json);
    const sessionId = isObj(params) && typeof params.sessionId === 'string' && /^[0-9A-Za-z]{26}$/.test(params.sessionId) ? params.sessionId : null;
    const branch = isObj(params) && typeof params.branch === 'string' ? params.branch : null;
    if (!sessionId || !branch) return refuse('invalid_output', 'bad_input', 'the worktree job has no session or branch');
    const name = sessionId.toLowerCase();
    const want = { ref: `refs/nexus/job/${name}`, worktree: `wt/${name}`, integrationRef: `refs/nexus/accepted/${branch}` };
    if (f.ref !== want.ref || f.worktree !== want.worktree || f.locked !== true || typeof f.base !== 'string' || !COMMIT_RE.test(f.base)
      || typeof f.integrationHead !== 'string' || !COMMIT_RE.test(f.integrationHead)) {
      return refuse('invalid_output', 'parser_contract', 'the worktree facts do not match the session');
    }
    const hasTable = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_worktrees'").get();
    if (!hasTable) return refuse('ingest_unavailable', 'v10_missing', 'session worktrees are not recorded in this database yet');
    const prior = this.db.prepare('SELECT * FROM session_worktrees WHERE session_id = ?').get(sessionId) as
      { rel_path: string; ref: string; integration_ref: string; base_commit: string; removed_at: number | null } | undefined;
    if (prior) {
      if (prior.removed_at === null && prior.rel_path === want.worktree && prior.ref === want.ref && prior.integration_ref === want.integrationRef) return ok;
      return refuse('invalid_output', 'worktree_recorded', 'the session already has another worktree record');
    }
    const now = this.deps.now();
    this.db.prepare(`INSERT INTO session_worktrees (session_id, project_id, rel_path, ref, integration_ref, base_commit, locked, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(sessionId, job.project_id, want.worktree, want.ref, want.integrationRef, f.base, now);
    appendActivityRow(this.db, { actorKind: system.kind, actorId: system.id, onBehalfOf: job.on_behalf_of, jobId: job.id, attemptN: ctx.attempt.n,
      sessionId, projectId: job.project_id, workspaceId: job.workspace_id, entityType: 'worktree', entityId: sessionId, action: 'repo.worktree',
      status: 'succeeded', details: { worktree: want.worktree, ref: want.ref, integrationRef: want.integrationRef, base: f.base,
        integrationHead: f.integrationHead, integrationCreated: f.integrationCreated === true, reused: f.reused === true, locked: true } }, now);
    return ok;
  }

  /** `changeset.accept_rollback`: the facts must name the move the job was queued for. */
  private rollbackFacts(ctx: IngestContext): IngestDecision {
    const f = this.gitFacts(ctx);
    const params = parse(ctx.job.params_json);
    if (!f || !isObj(params) || f.from !== params.from || f.to !== params.to || typeof f.to !== 'string' || !COMMIT_RE.test(f.to)) {
      return refuse('invalid_output', 'parser_contract', 'the rollback facts do not match the job');
    }
    return ok;
  }

  // ---------- repository snapshot (engine) ----------

  private snapshot(ctx: IngestContext): IngestDecision {
    const { job, attempt, system } = ctx;
    const reported = ctx.exited.parsed.find((p) => p.parser === 'repo-snapshot')?.normalized
      ?? ctx.exited.parsed.find((p) => isObj(p.normalized))?.normalized;
    const g = checkGitFacts(reported);
    if (!g.ok) return refuse('invalid_output', 'parser_contract', `the snapshot facts were not usable: ${g.message}`);
    if (containsSecret(g.value)) return secretRefusal('snapshot report');
    const facts = isObj(ctx.facts) ? ctx.facts : {};
    const resolved = (isObj(facts.resolved) ? facts.resolved : null) as { commit: string } | { error: string } | null;
    const headFacts = { storageCommit: g.value.commit, reported, resolved };
    // One repository per project (ux_repository_per_project): an archived one is never replaced by a second.
    const repo = this.db.prepare("SELECT id, status FROM artifacts WHERE project_id = ? AND kind = 'repository' ORDER BY created_at, id LIMIT 1")
      .get(job.project_id) as { id: string; status: string } | undefined;
    if (repo && repo.status !== 'active') {
      return refuse('invalid_output', 'repository_archived', 'the project repository is archived; restore it before taking a snapshot');
    }
    const contentHash = `git:${g.value.commit}`;
    const prior = this.already(job.id, 'facts') ?? (repo ? this.sameContent(repo.id, contentHash) : null);
    // The same commit was already snapshotted: one version.
    if (prior) return this.dedupe(ctx, prior, 'git.head_resolves', this.deps.validation.runPure('git.head_resolves', headFacts));
    const previous = repo ? this.latestLive(repo.id) : null;
    const v = this.deps.artifacts.insertSystemVersionTx(system, {
      ...(repo ? { artifactId: repo.id } : { newArtifact: { kind: 'repository', name: 'Repository', participation: null } }),
      storage: { kind: 'git', commit: g.value.commit, ...(g.value.branch ? { ref: g.value.branch } : {}) },
      contentHash, metadata: { branch: g.value.branch, dirty: g.value.dirty, tree: g.value.tree,
        // The lockfile at the commit, as the runner hashed it (an install's lock.sha256 is judged against it).
        ...(g.value.lockfile ? { lockfile: { path: g.value.lockfile.path, sha256: g.value.lockfile.sha256 } } : {}) },
      environment: this.environment(ctx), jobId: job.id, attemptN: attempt.n, outputPath: 'facts', action: 'exec.snapshot',
      onBehalfOf: job.on_behalf_of, now: this.deps.now(),
      inputs: previous ? [{ versionId: previous.id, role: 'previous', relation: 'derived_from', source: 'ingest' }] : []
    });
    this.bindAttempt(v.id, job.id, attempt.n);
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    this.deps.validation.runRegisterTx(system, v.id, { 'git.head_resolves': headFacts }, { jobId: job.id, attemptN: attempt.n });
    this.deps.validation.finalizeIfReady(system, v.id);
    return ok;
  }

  // ---------- test discovery ----------

  private discovery(ctx: IngestContext): IngestDecision {
    const { job, attempt, system } = ctx;
    const staged = ctx.exited.outputs.find((o) => o.relPath === 'ids.txt');
    if (!staged) return refuse('invalid_output', 'outputs_missing', 'the discovered list (ids.txt) is missing');
    const parsed = ctx.exited.parsed.find((p) => p.parser === 'discovery');
    const repo = this.inputs(job.id, 'repository')[0];
    if (!repo || job.participation_id === null) return refuse('invalid_output', 'bad_input', 'discovery has no repository input');
    const repoStorage = parse(repo.storage_ref_json) as Record<string, unknown> | null;
    const commit = isObj(repoStorage) && typeof repoStorage.commit === 'string' && COMMIT_RE.test(repoStorage.commit) ? repoStorage.commit : null;
    if (!commit) return refuse('invalid_output', 'bad_input', 'the repository input stores no commit');
    const d = checkDiscovery(parsed?.normalized);
    const files = d.ok ? d.value.files : [];
    const ids = d.ok ? d.value.ids : [];
    if (containsSecret(files) || containsSecret(ids)) return secretRefusal('discovered list');
    // The test plan runs exactly the stored list (planBuilder MAX_DISCOVERED_FILES): a list it cannot take whole is
    // refused here, never cut.
    if (files.length > MAX_DISCOVERED_FILES) {
      return refuse('invalid_output', 'discovery_too_large', `the discovery lists ${files.length} test files; a test run takes at most ${MAX_DISCOVERED_FILES}`);
    }
    const repoMeta = parse(repo.metadata_json);
    const env = parse(ctx.attempt.environment_json);
    const profile = isObj(repoMeta) && typeof repoMeta.profile === 'string' ? repoMeta.profile
      : isObj(env) && typeof env.profile === 'string' ? env.profile : null;
    // The files once (the plan reads `files`); the ids only when they say more than the files and fit beside them.
    const idsDiffer = ids.length !== files.length || ids.some((x, i) => x !== files[i]);
    const framework = d.ok ? d.value.framework : null;
    const base = { profile: profile ?? 'sde-node', framework, files, commit, count: Math.max(ids.length, files.length) };
    const disc = { sha256: parsed?.sourceSha256 ?? null, framework, filesCount: files.length, idsCount: ids.length, truncated: false };
    let metadata: Record<string, unknown> = { ...base, discovery: { ...disc, ...(idsDiffer ? { ids } : {}) } };
    if (idsDiffer && jsonBytes(metadata) > INLINE_MAX_BYTES) metadata = { ...base, discovery: { ...disc, idsStored: false } };
    if (jsonBytes(metadata) > INLINE_MAX_BYTES) {
      return refuse('invalid_output', 'discovery_too_large', `the discovered list is larger than a test suite records (${INLINE_MAX_BYTES} bytes)`);
    }
    const registerFacts = { 'suite.discovered': { discovery: parsed?.normalized ?? null, listSha256: parsed?.sourceSha256 ?? null, storedSha256: staged.sha256 } };
    const contentHash = sha256(`test_suite\n${commit}\n${staged.sha256}`);
    const artifactId = this.ownedArtifact(job.participation_id, 'test_suite', 'Test suite');
    const prior = this.already(job.id, 'ids.txt') ?? (artifactId ? this.sameContent(artifactId, contentHash) : null);
    if (prior) return this.dedupe(ctx, prior, 'suite.discovered', this.deps.validation.runPure('suite.discovered', registerFacts['suite.discovered']));
    const previous = artifactId ? this.latestLive(artifactId) : null;
    const v = this.deps.artifacts.insertSystemVersionTx(system, {
      ...(artifactId ? { artifactId } : { newArtifact: { kind: 'test_suite', name: 'Test suite', participation: job.participation_id } }),
      storage: { kind: 'git', commit }, contentHash, metadata,
      environment: this.environment(ctx), jobId: job.id, attemptN: attempt.n, outputPath: 'ids.txt', action: 'exec.discover',
      onBehalfOf: job.on_behalf_of, now: this.deps.now(),
      inputs: [{ versionId: repo.version_id, role: 'repository', relation: 'derived_from', source: 'job_input' },
        ...(previous ? [{ versionId: previous.id, role: 'previous', relation: 'derived_from' as const, source: 'ingest' as const }] : [])]
    });
    this.bindAttempt(v.id, job.id, attempt.n);
    const token = this.token(ctx);
    this.record(token, [staged]);
    this.deps.blobs!.attachTx(token, v.id, [{ sha256: staged.sha256, role: 'discovery', path: 'ids.txt' }]);
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    this.deps.validation.runRegisterTx(system, v.id, registerFacts, { jobId: job.id, attemptN: attempt.n });
    if (this.deps.validation.finalizeIfReady(system, v.id) === 'draft' && this.registerPassed(v.id)) {
      this.deps.validation.enqueueCandidate(system, v.id, { parentJobId: job.id });
    }
    return ok;
  }

  // ---------- a test run (the sde.tests_pass check, or a user's run on a suite) ----------

  private testRun(ctx: IngestContext): IngestDecision {
    const { job, attempt, system } = ctx;
    let suiteId: string | null = null;
    if (job.kind === 'validate') {
      const params = parse(job.params_json);
      suiteId = isObj(params) && typeof params.versionId === 'string' ? params.versionId : null;
    } else {
      suiteId = this.inputs(job.id, 'suite')[0]?.version_id ?? null;
    }
    const suite = suiteId ? this.db.prepare(`SELECT v.*, a.kind FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE v.id = ? AND v.project_id = ?`).get(suiteId, job.project_id) as (VersionRow & { kind: string }) | undefined : undefined;
    if (!suite || suite.kind !== 'test_suite') return refuse('invalid_output', 'bad_input', 'the test run has no test suite');
    const meta = parse(suite.metadata_json);
    const disc = isObj(meta) && isObj(meta.discovery) ? meta.discovery : null;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const files = list(isObj(meta) && Array.isArray(meta.files) ? meta.files : disc?.files);
    const ids = list(disc?.ids ?? files);
    const staged = ctx.exited.outputs.find((o) => o.relPath === 'junit.xml') ?? null;
    const parsed = ctx.exited.parsed.find((p) => p.parser === 'junit');
    const env = parse(ctx.attempt.environment_json);
    const outcome = tests.run({
      junit: parsed?.normalized ?? null, junitSha256: staged?.sha256 ?? null,
      exit: { code: ctx.exited.exit.code, ...(ctx.exited.exit.signal ? { signal: ctx.exited.exit.signal } : {}), oomKilled: ctx.exited.exit.oomKilled },
      discovery: { ids, files, truncated: disc?.truncated === true },
      imageId: isObj(env) && typeof env.imageId === 'string' ? env.imageId : null,
      lockfileSha256: isObj(env) && typeof env.lockfileSha256 === 'string' ? env.lockfileSha256 : null
    });
    if (staged) {
      // The report's bytes are kept: attached to the suite they judged while it is still a draft; otherwise (a run on
      // a candidate suite, which is immutable) recorded as a blob that the result's evidence names (`hash` junit).
      const token = this.token(ctx);
      this.record(token, [staged]);
      if (suite.status === 'draft') this.deps.blobs!.attachTx(token, suite.id, [{ sha256: staged.sha256, role: 'junit', path: `junit/${job.id}-${attempt.n}.xml` }]);
    }
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    // The per-case table (fix round 1): a judged report's failed and errored cases are kept with the result (failures
    // first, bounded, redacted); the counts stay in the junit item.
    const cases = outcome.evidence.some((e) => e.type === 'junit') ? failingCaseEvidence(parsed?.normalized) : [];
    const recorded = cases.length > 0 ? { ...outcome, evidence: [...outcome.evidence, ...cases] } : outcome;
    this.deps.validation.recordOutcomeTx(suite.id, TEST_RUN_RECORDS, recorded, { jobId: job.id, attemptN: attempt.n });
    const params = parse(job.params_json);
    this.deps.validation.finalizeIfReady(system, suite.id, { allowPartial: isObj(params) && params.revalidate === true });
    return ok;
  }

  // ---------- build (a tree) ----------

  private build(ctx: IngestContext): IngestDecision {
    const { job, attempt, system } = ctx;
    const repo = this.inputs(job.id, 'repository')[0];
    if (!repo || job.participation_id === null) return refuse('invalid_output', 'bad_input', 'the build has no repository input');
    const staged = ctx.exited.outputs.filter((o) => o.relPath.startsWith('dist/') && o.relPath.length > 5);
    if (staged.length > MAX_TREE_FILES) {
      return refuse('invalid_output', 'tree_too_large', `the build output holds ${staged.length} files; at most ${MAX_TREE_FILES} are stored`);
    }
    // File names are stored (version_blobs paths): a provider-key shape in one is refused. A long hex chunk name is
    // not a secret, so the long-hex rule does not apply here.
    if (staged.some((o) => hasProviderKey(o.relPath))) return secretRefusal('build output file names');
    const files: TreeFile[] = staged.map((o) => ({ path: o.relPath.slice(5), sha256: o.sha256, bytes: o.bytes }));
    const tree = { kind: 'tree' as const, manifestSha256: manifestSha256(files), files: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) };
    const repoMeta = parse(repo.metadata_json);
    const repoStorage = parse(repo.storage_ref_json);
    const commit = isObj(repoStorage) && typeof repoStorage.commit === 'string' && COMMIT_RE.test(repoStorage.commit) ? repoStorage.commit : null;
    // A build is keyed by (commit, tree) (fix round 1, item 5): an identical tree built from ANOTHER commit is a new
    // version with its own commit and its own built_from edge (assembly reads that commit's nexus.app.json, a preview
    // stages that commit). The same tree from the same commit is still the same version; blobs dedupe as blobs.
    const contentHash = commit ? `tree:${tree.manifestSha256}@${commit}` : `tree:${tree.manifestSha256}`;
    const artifactId = this.ownedArtifact(job.participation_id, 'build', 'Build');
    const prior = this.already(job.id, 'dist') ?? (artifactId ? this.sameContent(artifactId, contentHash) : null);
    const exitFacts = { exit: { code: ctx.exited.exit.code, ...(ctx.exited.exit.signal ? { signal: ctx.exited.exit.signal } : {}), oomKilled: ctx.exited.exit.oomKilled } };
    if (prior) return this.dedupe(ctx, prior, EXIT_ZERO, exitZero(exitFacts));
    const previous = artifactId ? this.latestLive(artifactId) : null;
    const v = this.deps.artifacts.insertSystemVersionTx(system, {
      ...(artifactId ? { artifactId } : { newArtifact: { kind: 'build', name: 'Build', participation: job.participation_id } }),
      storage: tree, contentHash,
      metadata: { profile: isObj(repoMeta) && typeof repoMeta.profile === 'string' ? repoMeta.profile : null, commit, files: files.length, bytes: tree.bytes },
      environment: this.environment(ctx), jobId: job.id, attemptN: attempt.n, outputPath: 'dist', action: 'exec.build',
      onBehalfOf: job.on_behalf_of, now: this.deps.now(),
      inputs: [{ versionId: repo.version_id, role: 'repository', relation: 'built_from', source: 'job_input' },
        ...(previous ? [{ versionId: previous.id, role: 'previous', relation: 'derived_from' as const, source: 'ingest' as const }] : [])]
    });
    this.bindAttempt(v.id, job.id, attempt.n);
    if (files.length) {
      const token = this.token(ctx);
      this.record(token, staged);
      this.deps.blobs!.attachTx(token, v.id, files.map((f) => ({ sha256: f.sha256, role: 'file' as const, path: f.path })));
    }
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    this.deps.validation.enqueueCandidate(system, v.id, { parentJobId: job.id });
    return ok;
  }

  // ---------- application assembly (engine) ----------

  private assemble(ctx: IngestContext): IngestDecision {
    const { job, attempt, system } = ctx;
    const buildIn = this.inputs(job.id, 'build')[0];
    if (!buildIn || job.participation_id === null) return refuse('invalid_output', 'bad_input', 'assembly has no build input');
    // The engine reports `{ manifest }`: the nexus.app.json it read at the build's commit. The reader contract
    // (repoService.acceptManifestReport): a plain JSON object of at most 16 KiB, nothing secret-shaped; then
    // app.manifest_schema judges its shape.
    const facts = ctx.exited.parsed.find((p) => p.parser === 'app-manifest')?.normalized
      ?? ctx.exited.parsed.find((p) => isObj(p.normalized))?.normalized;
    const accepted = acceptManifestReport(facts);
    if (!accepted.ok) {
      if (accepted.reason === 'secret_in_output') return secretRefusal('application manifest');
      if (accepted.reason === 'manifest_too_large') {
        return refuse('invalid_output', 'manifest_too_large', `the manifest is larger than ${APP_MANIFEST_MAX_BYTES} bytes`);
      }
      return refuse('invalid_output', 'parser_contract', 'the manifest was not usable');
    }
    const manifest = accepted.manifest;
    const storage: { kind: 'inline'; json: unknown } = { kind: 'inline', json: manifest };
    const contentHash = sha256(`application\n${buildIn.version_id}\n${JSON.stringify(manifest)}`);
    const artifactId = this.ownedArtifact(job.participation_id, 'application', 'Application');
    const prior = this.already(job.id, 'manifest') ?? (artifactId ? this.sameContent(artifactId, contentHash) : null);
    if (prior) return this.dedupe(ctx, prior, 'app.manifest_schema', this.deps.validation.runPure('app.manifest_schema', manifest));
    const previous = artifactId ? this.latestLive(artifactId) : null;
    const v = this.deps.artifacts.insertSystemVersionTx(system, {
      ...(artifactId ? { artifactId } : { newArtifact: { kind: 'application', name: 'Application', participation: job.participation_id } }),
      storage, contentHash, metadata: {}, environment: this.environment(ctx), jobId: job.id, attemptN: attempt.n, outputPath: 'manifest',
      action: 'exec.assemble', onBehalfOf: job.on_behalf_of, now: this.deps.now(),
      inputs: [{ versionId: buildIn.version_id, role: 'build', relation: 'assembled_from', source: 'job_input' },
        ...(previous ? [{ versionId: previous.id, role: 'previous', relation: 'derived_from' as const, source: 'ingest' as const }] : [])]
    });
    this.bindAttempt(v.id, job.id, attempt.n);
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    this.deps.validation.runRegisterTx(system, v.id, { 'app.manifest_schema': manifest }, { jobId: job.id, attemptN: attempt.n });
    this.deps.validation.finalizeIfReady(system, v.id);
    return ok;
  }

  // ---------- dependency install (B2a Task 13 fix round 1) ----------

  /**
   * Exit 0 is required and never enough: `sde.deps.lock_matches` judges the stored `lock.sha256` against the input
   * repository version's lockfile hash and the approval THIS attempt consumed. A refusal stores nothing (`missing_output`
   * for a missing file, `invalid_output` otherwise); a pass is recorded advisory on the repository version, bound to
   * (job, n), and the job completes on it.
   */
  private depsInstall(ctx: IngestContext): IngestDecision {
    const { job, attempt } = ctx;
    const repo = this.inputs(job.id, 'repository')[0];
    if (!repo) return refuse('invalid_output', 'bad_input', 'the install has no repository input');
    const meta = parse(repo.metadata_json);
    const lf = isObj(meta) && isObj(meta.lockfile) ? meta.lockfile : null;
    const repositoryLock = lf && typeof lf.sha256 === 'string' ? lf.sha256 : null;
    // The approval consumed by THIS attempt (a retry's attempt needs its own): its request names the lockfile hash.
    const ap = this.db.prepare(`SELECT request_json FROM approvals WHERE job_id = ? AND consumed_by_job_id = ? AND consumed_by_attempt_n = ?
      AND status = 'approved' AND reason = 'egress.deps' ORDER BY consumed_at DESC LIMIT 1`).get(job.id, job.id, attempt.n) as { request_json: string } | undefined;
    const req = ap ? parse(ap.request_json) : null;
    const approvalLock = isObj(req) && typeof req.lockfileSha256 === 'string' ? req.lockfileSha256 : null;
    const facts = isObj(ctx.facts) ? ctx.facts : {};
    const read = isObj(facts.lock) ? facts.lock as { text: string } | { error: string } : null;
    const outcome = this.deps.validation.runPure(depsLock.ID, {
      exit: { code: ctx.exited.exit.code, ...(ctx.exited.exit.signal ? { signal: ctx.exited.exit.signal } : {}), oomKilled: ctx.exited.exit.oomKilled },
      outputs: ctx.exited.outputs.map((o) => ({ relPath: o.relPath, sha256: o.sha256, bytes: o.bytes })), read, repositoryLock, approvalLock
    } satisfies depsLock.DepsLockFacts);
    if (outcome.status !== 'passed') {
      const reason = outcome.reason ?? 'invalid_output';
      return refuse(reason === 'missing_output' ? 'missing_output' : 'invalid_output', reason, `the install was refused: ${outcome.summary}`);
    }
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    this.deps.validation.recordOutcomeTx(repo.version_id, depsLock.ID, outcome, { jobId: job.id, attemptN: attempt.n });
    return ok;
  }

  // ---------- diagnosis (engine, B2a Task 12) ----------

  /** Main's own probe table of the diagnosed deployment (its stored probes and the previewed manifest's health path). */
  private probeTable(projectId: string, deploymentId: string): ProbeTable | null {
    const d = this.db.prepare('SELECT health_json, subject_version_id FROM deployments WHERE id = ? AND project_id = ?').get(deploymentId, projectId) as
      { health_json: string; subject_version_id: string } | undefined;
    if (!d) return null;
    const subject = this.db.prepare('SELECT storage_ref_json FROM artifact_versions WHERE id = ?').get(d.subject_version_id) as { storage_ref_json: string } | undefined;
    const manifest = readAppManifest(subject?.storage_ref_json ?? null);
    const raw = parse(d.health_json);
    const probes = (Array.isArray(raw) ? raw : []).filter(isObj).filter((p) => typeof p.at === 'number' && Number.isSafeInteger(p.at) && p.at >= 0)
      .map((p) => ({ at: p.at as number, status: typeof p.status === 'number' && Number.isInteger(p.status) ? p.status : null,
        ms: typeof p.ms === 'number' && Number.isFinite(p.ms) && p.ms >= 0 ? p.ms : null }));
    return manifest ? { path: manifest.healthPath, probes } : null;
  }

  private diagnose(ctx: IngestContext): IngestDecision {
    const { job, attempt, system } = ctx;
    if (job.participation_id === null) return refuse('invalid_output', 'bad_input', 'the diagnosis has no participation');
    const reported = ctx.exited.parsed.find((p) => p.parser === 'diagnostic');
    const d = checkDiagnosis(reported?.normalized);
    if (!d.ok) return refuse('invalid_output', 'parser_contract', `the diagnosis was not usable: ${d.message}`);
    const capRow = this.db.prepare('SELECT capabilities_json FROM jobs WHERE id = ?').get(job.id) as { capabilities_json: string } | undefined;
    const caps = parse(capRow?.capabilities_json ?? null);
    const cap = Array.isArray(caps) && isObj(caps[0]) && isObj(caps[0].diagnose) ? caps[0].diagnose : null;
    const target = cap?.target === 'deployment' || cap?.target === 'job' ? cap.target : null;
    const targetId = typeof cap?.targetId === 'string' ? cap.targetId : null;
    if (!target || !targetId || target !== d.value.target) return refuse('invalid_output', 'bad_input', 'the diagnosis does not match its subject');
    // The runner reports exactly the containers and attempt logs main planned (job_attempts.sandbox_json, written at the
    // lease from main's own rows), in the planned order, and every planned attempt is the subject job's.
    const planned = plannedDiagnosis(ctx.attempt.sandbox_json);
    if (!planned) return refuse('invalid_output', 'parser_contract', 'the diagnosis plan of this attempt is not recorded');
    const subjectJob = typeof cap?.jobId === 'string' ? cap.jobId : null;
    const sameContainers = d.value.containers.length === planned.containerIds.length
      && d.value.containers.every((c, i) => c.container.sha256 === planned.containerIds[i]);
    const sameLogs = d.value.logs.length === planned.attemptIds.length && d.value.logs.every((l, i) => l.attemptId === planned.attemptIds[i]);
    const ownAttempts = subjectJob !== null && planned.attemptIds.every((id) =>
      !!this.db.prepare('SELECT 1 FROM job_attempts WHERE id = ? AND job_id = ?').get(id, subjectJob));
    if (!sameContainers || !sameLogs || !ownAttempts) {
      return refuse('invalid_output', 'parser_contract', 'the diagnosis names containers or attempts that main did not plan for this subject');
    }
    const subjectVersionId = typeof cap?.subjectVersionId === 'string' ? cap.subjectVersionId : null;
    const report = buildDiagnosticReport(d.value, targetId, target === 'deployment' ? this.probeTable(job.project_id, targetId) : null);
    if (containsSecret(report)) return secretRefusal('diagnostic report');
    if (jsonBytes(report) > INLINE_MAX_BYTES) return refuse('invalid_output', 'report_too_large', `the diagnostic report is larger than ${INLINE_MAX_BYTES} bytes`);
    const contentHash = sha256(`diagnostic_report\n${JSON.stringify(report)}`);
    const artifactId = this.ownedArtifact(job.participation_id, 'diagnostic_report', 'Diagnostic report');
    const prior = this.already(job.id, 'report') ?? (artifactId ? this.sameContent(artifactId, contentHash) : null);
    if (prior) return this.dedupe(ctx, prior, 'diag.schema', this.deps.validation.runPure('diag.schema', report));
    const previous = artifactId ? this.latestLive(artifactId) : null;
    const subjectOk = subjectVersionId !== null
      && !!this.db.prepare('SELECT 1 FROM artifact_versions WHERE id = ? AND project_id = ?').get(subjectVersionId, job.project_id);
    const v = this.deps.artifacts.insertSystemVersionTx(system, {
      ...(artifactId ? { artifactId } : { newArtifact: { kind: 'diagnostic_report', name: 'Diagnostic report', participation: job.participation_id } }),
      storage: { kind: 'inline', json: report }, contentHash,
      metadata: { target, fields: report.fields.length, sources: [...new Set(report.fields.map((f) => String(f.source.type)))].sort() },
      environment: this.environment(ctx), jobId: job.id, attemptN: attempt.n, outputPath: 'report', action: 'exec.diagnose',
      onBehalfOf: job.on_behalf_of, now: this.deps.now(),
      inputs: [...(subjectOk ? [{ versionId: subjectVersionId!, role: 'application', relation: 'derived_from' as const, source: 'ingest' as const }] : []),
        ...(previous ? [{ versionId: previous.id, role: 'previous', relation: 'derived_from' as const, source: 'ingest' as const }] : [])]
    });
    this.bindAttempt(v.id, job.id, attempt.n);
    this.deps.faults?.afterRows?.(ctx.recipe.id);
    this.deps.validation.runRegisterTx(system, v.id, { 'diag.schema': report }, { jobId: job.id, attemptN: attempt.n });
    this.deps.validation.finalizeIfReady(system, v.id);
    return ok;
  }
}

/** Ingest one exited attempt through the execution core (system only): the interface the plan names. */
export function ingestAttempt(exec: { ingestAttempt(system: Principal, attemptId: string, exited: AttemptExited): Promise<void> },
  system: Principal, attemptId: string, exited: AttemptExited): Promise<void> {
  return exec.ingestAttempt(system, attemptId, exited);
}
