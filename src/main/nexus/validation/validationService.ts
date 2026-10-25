/**
 * The validation framework (B2a, constraint 4): validator results with their evidence, the finalize rule, and the
 * `validate` jobs that run candidate checks (executed by `CheckRunner`, ./checkRunner.ts).
 *
 * - Results. `recordResultTx` is the only writer of `validations` and accepts only the stored system principal
 *   (anyone else: 'denied', audited; the database refuses a non-system blocking pass or fail, tr_validations_insert).
 *   Evidence is persisted as given or not at all: it must be a list of members of the `Evidence` union with exactly
 *   their fields (`checkEvidence`; else `error`, `bad_evidence`); a secret-shaped value outside the union's typed
 *   digest positions (`secret_in_evidence`) or an oversized list (`evidence_too_large`) turns the result into `error`
 *   with an empty evidence list; evidence is never redacted in place. A result bound to a job also writes one
 *   `validation` job event.
 * - Only a draft takes blocking rows. A result on a version that is no longer a draft (a deduplicated output, a
 *   user's test run on a candidate suite) is recorded ADVISORY (blocking = 0), still bound to (job, n): it is the
 *   attempt's evidence, and it never changes what the version's blocking validators said.
 * - Latest per (version, validator) counts: the newest row by `finished_at`, then insertion order. A v2 row beside a
 *   v1 row simply supersedes it; old rows are never changed or removed. The finalize rule reads the latest BLOCKING
 *   row of each validator.
 * - Finalize (`finalizeIfReady`, system, inside the caller's transaction or its own): an engine-made draft (a job or
 *   session produced it; a user's own draft is made ready by the user, B1) becomes `candidate`
 *   only when EVERY blocking register and candidate validator of its kind has a latest `passed` row; any latest
 *   blocking `failed` makes it `failed`; any `error` leaves it draft ("Checks could not run", Revalidate); advisory
 *   rows never gate. A `cancelled_partial` draft never finalizes on its own; only a revalidation may finalize it.
 *   A `repository` version that reaches candidate is promoted `active` by the system in the same transaction.
 * - Register validators run inline (`runRegisterTx`) over the facts the caller hands in (ingest, inline saves).
 * - Candidate validators run as system `validate` jobs (`enqueueCandidate`) carrying `params.versionId`, never
 *   job_inputs, so drafts can be validated. Only this service creates them for a user (JobService refuses the kind
 *   to anyone but the system). While a live validate job exists for a (version, validator), it is returned instead
 *   of a new one, so a revalidation is bounded. A recipe validator (`sde.tests_pass`) is a validate job with a recipe
 *   that the scheduler leases like a tool job; its ingest records the result. Deployment validators are recorded by
 *   the deployment (Task 9).
 * - `revalidate` (user, 'version.revalidate'): drafts only; validate jobs for every blocking validator of the kind;
 *   old rows stay. With an intent (IPC #33) the same intent sent again returns the same jobs (its answer is recorded).
 */
import type Database from 'better-sqlite3';
import type { Evidence, ValidationResult, ValidationStatus, ValidatorStage } from '../../../shared/nexus/evidence';
import type { MainToRunner } from '../../../shared/nexus/runnerProtocol';
import type { Principal, ScopeRef, VersionStatus } from '../../../shared/nexus/platform';
import { blockingValidatorsFor, getValidator, VALIDATORS, type ValidatorDef } from '../../../shared/nexus/validators';
import { getRecipe, type RecipeDef } from '../../../shared/nexus/recipes';
import type { AuthService } from '../auth/authService';
import { PrincipalResolver } from '../auth/principals';
import { containsSecret, redactText } from '../activity/redact';
import type { ArtifactService } from '../artifact/artifactService';
import type { BlobIndex } from '../blobs/blobIndex';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { validateKey, type JobService } from '../jobs/jobService';
import { appendActivityRow } from '../activity/writer';
import { ProjectAccess } from '../project/projectAccess';
import { appendJobEventTx } from '../exec/events';
import { errored, type ValidatorOutcome } from './normalized';
import { checkEvidence, secretCheckView } from './evidenceShape';
import { CheckRunner, type ResolveCommit, type VersionFacts } from './checkRunner';
import * as gitHead from './validators/gitHeadResolves';
import * as req from './validators/reqSchema';
import * as problem from './validators/problemSchema';
import * as suite from './validators/suiteDiscovered';
import * as build from './validators/buildChecks';
import * as appManifest from './validators/appManifestSchema';
import * as diag from './validators/diagSchema';
import * as depsLock from './validators/depsLockMatches';
import * as diffNonempty from './validators/diffNonempty';
import * as pathsInScope from './validators/pathsInScope';
import * as secretScan from './validators/secretScan';
import * as secretEntropyNotes from './validators/secretEntropyNotes';
import * as csTestsPass from './validators/csTestsPass';
import * as appliesCleanly from './validators/appliesCleanly';

export { VERIFY_TIMEOUT_MS, type ResolveCommit } from './checkRunner';

/**
 * The pure validators main runs, by id: the one dispatch table of `runPure` (B2a Task 13 pins its keys, with the
 * validators main executes elsewhere, to the registry's B2A_IMPL).
 */
export const PURE_VALIDATORS: Readonly<Record<string, (facts: unknown) => ValidatorOutcome>> = Object.freeze({
  [gitHead.ID]: (f: unknown) => gitHead.run(f as gitHead.GitHeadFacts),
  [req.ID]: (f: unknown) => req.run(f),
  [problem.ID]: (f: unknown) => problem.run(f),
  [suite.ID]: (f: unknown) => suite.run(f as suite.SuiteDiscoveredFacts),
  [appManifest.ID]: (f: unknown) => appManifest.run(f),
  [diag.ID]: (f: unknown) => diag.run(f),
  [build.EXIT_ZERO]: (f: unknown) => build.exitZero(f as Parameters<typeof build.exitZero>[0]),
  [build.MANIFEST_PRESENT]: (f: unknown) => build.manifestPresent(f as Parameters<typeof build.manifestPresent>[0]),
  [build.OUTPUT_HASHED]: (f: unknown) => build.outputHashed(f as Parameters<typeof build.outputHashed>[0]),
  // B2a Task 13 fix round 1: a dependency install's evidence (advisory, on the repository version), run at its ingest.
  [depsLock.ID]: (f: unknown) => depsLock.run(f as depsLock.DepsLockFacts),
  // B2b Task 8: the change-set register validators, run inline over the runner's collect facts (ingest.ts).
  [diffNonempty.ID]: (f: unknown) => diffNonempty.run(f as diffNonempty.DiffNonemptyFacts),
  [pathsInScope.ID]: (f: unknown) => pathsInScope.run(f as pathsInScope.PathsInScopeFacts),
  [secretScan.ID]: (f: unknown) => secretScan.run(f as secretScan.SecretScanFacts),
  [secretEntropyNotes.ID]: (f: unknown) => secretEntropyNotes.run(f as secretEntropyNotes.SecretEntropyNotesFacts)
});
export const MAX_EVIDENCE_CHARS = 65_536;
export const MAX_SUMMARY_CHARS = 500;

export interface ValidationDeps {
  auth: AuthService; artifacts: ArtifactService; jobs: JobService; now: () => number; log?: (line: string) => void;
  blobs: BlobIndex | null;
  /** main's own async commit resolution in the project folder (src/main/git.ts `resolveCommit`). */
  resolveCommit?: ResolveCommit | null;
  acceptFsRoot?: ((root: string) => string | null) | null;
  /** Sends a message to the runner (late-bound to the execution core); false when it did not go. */
  send?: (msg: MainToRunner) => boolean;
  appVersion?: string | null;
}

export interface RecordInput {
  versionId: string; validatorId: string; validatorVersion?: string; stage?: ValidatorStage; status: ValidationStatus;
  blocking?: boolean; advisory?: boolean; summary: string; evidence: unknown; jobId?: string | null; attemptN?: number | null;
  startedAt?: number; finishedAt?: number;
}

interface ValidationRow {
  id: string; version_id: string; validator_id: string; validator_version: string; stage: ValidatorStage; status: ValidationStatus;
  blocking: number; advisory: number; summary: string; evidence_json: string; job_id: string | null; attempt_n: number | null;
  created_by: string; started_at: number; finished_at: number;
}

const PLATFORM: ScopeRef = { type: 'platform' };
const LIVE_JOB_STATES = "('queued','leased','running','awaiting_approval','retry_scheduled')";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };

export function toValidationResult(r: ValidationRow): ValidationResult {
  return { id: r.id, versionId: r.version_id, validatorId: r.validator_id, validatorVersion: r.validator_version, status: r.status,
    blocking: r.blocking === 1, advisory: r.advisory === 1, summary: r.summary, evidence: (parse(r.evidence_json) as Evidence[] | null) ?? [],
    ...(r.job_id !== null ? { jobId: r.job_id } : {}), ...(r.attempt_n !== null ? { attemptN: r.attempt_n } : {}),
    startedAt: r.started_at, finishedAt: r.finished_at };
}

/** The summary as stored: one line, redacted, at most 500 characters, the machine reason appended. */
function summaryText(summary: string, reason: string | null): string {
  const base = redactText(String(summary ?? '')).replace(/[\r\n\t]+/g, ' ').trim() || 'checked';
  const withReason = reason ? `${base} (${reason})` : base;
  return withReason.length > MAX_SUMMARY_CHARS ? `${withReason.slice(0, MAX_SUMMARY_CHARS - 1)}…` : withReason;
}

/** The test recipe of a suite version (`sde.tests_pass` runs it): python for a python profile, node otherwise. */
export function testRecipeFor(metadata: unknown, def: ValidatorDef): RecipeDef | null {
  const profile = isObj(metadata) && typeof metadata.profile === 'string' ? metadata.profile : 'sde-node';
  const ids = def.recipes ?? [];
  const id = ids.find((r) => getRecipe(r)?.profiles.includes(profile as never)) ?? null;
  return id ? getRecipe(id) : null;
}

export class ValidationService {
  private readonly principals: PrincipalResolver;
  private readonly access: ProjectAccess;
  private readonly log: (line: string) => void;
  /** The 26-character owner of the attempts main itself executes (validate jobs run in main). */
  readonly mainBootId: string;
  /** Executes the validate jobs (main checks, re-hashes, ended recipe checks). */
  private readonly runner: CheckRunner;

  constructor(private readonly db: Database.Database, private readonly deps: ValidationDeps) {
    this.principals = new PrincipalResolver(db);
    this.access = new ProjectAccess(db, { auth: deps.auth });
    this.log = deps.log ?? (() => {});
    this.mainBootId = newId(deps.now());
    this.runner = new CheckRunner({
      db, jobs: deps.jobs, now: deps.now, log: this.log, mainBootId: this.mainBootId, appVersion: () => this.deps.appVersion ?? null,
      system: () => this.system(), versionFacts: (id) => this.versionFacts(id),
      recordOutcomeTx: (versionId, validatorId, o, bind) => this.recordOutcomeTx(versionId, validatorId, o, bind),
      finalizeIfReady: (system, versionId, o) => this.finalizeIfReady(system, versionId, o),
      runPure: (id, facts) => this.runPure(id, facts), repoPathOf: (projectId) => this.repoPathOf(projectId),
      resolveCommit: () => this.deps.resolveCommit ?? null, send: () => this.deps.send ?? null
    });
  }

  /** Late binding of the runner send (the execution core is built after this service). */
  setSender(send: (msg: MainToRunner) => boolean): void { this.deps.send = send; }

  /** Resolves when every asynchronous step started so far has settled (tests and shutdown). */
  async settled(): Promise<void> { await this.runner.settled(); }

  private system(): Principal { return this.principals.system(); }
  private isSystem(p: Principal): boolean { return p?.kind === 'system' && this.principals.get(p.id)?.kind === 'system'; }

  private versionFacts(id: string): VersionFacts | null {
    return (this.db.prepare(`SELECT v.id, v.artifact_id, v.project_id, v.participation_id, v.status, v.draft_flag, v.storage_ref_json,
        v.metadata_json, v.produced_by_job_id, v.produced_by_session_id, v.on_behalf_of, a.kind, a.owner_scope, a.owner_participation_id, a.owner_workspace_id,
        a.current_version_id
      FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`).get(id) as VersionFacts | undefined) ?? null;
  }

  // ---------- results ----------

  /** System only, inside the caller's transaction (or its own). See the module header for the evidence rules. */
  recordResultTx(p: Principal, r: RecordInput): ValidationResult {
    if (!this.isSystem(p)) {
      // A user, an agent or a forged principal never writes a validation result: denied and audited.
      this.deps.auth.require(p, 'exec.ingest', PLATFORM, { entityType: 'validation' });
      throw new PlatformError('denied', 'validation results are recorded by the system', { reason: 'system_only' });
    }
    if (!isObj(r) || typeof r.versionId !== 'string' || typeof r.validatorId !== 'string') throw new PlatformError('invalid', 'a result names its version and validator');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionFacts(r.versionId);
      if (!v) throw new PlatformError('not_found', 'version not found');
      const def = getValidator(r.validatorId);
      // Only a draft takes blocking rows: on any other version the result is the attempt's evidence, advisory.
      const blocking = v.status === 'draft' && (r.blocking ?? def?.blocking ?? false);
      const advisory = !blocking && (v.status !== 'draft' || (r.advisory ?? true));
      let status: ValidationStatus = r.status;
      let summary = r.summary;
      let evidenceJson = '[]';
      if (!['passed', 'failed', 'error', 'skipped'].includes(status)) throw new PlatformError('invalid', 'unknown validation status');
      const checked = checkEvidence(r.evidence);
      if (!checked.ok) {
        status = 'error'; summary = summaryText('Checks could not run: the evidence was not in the evidence format.', 'bad_evidence');
      } else if (containsSecret(secretCheckView(checked.value))) {
        status = 'error'; summary = summaryText('Checks could not run: the evidence held a secret-shaped value and was not stored.', 'secret_in_evidence');
      } else {
        const text = JSON.stringify(checked.value);
        if (typeof text !== 'string' || text.length > MAX_EVIDENCE_CHARS) {
          status = 'error'; summary = summaryText('Checks could not run: the evidence was too large to store.', 'evidence_too_large');
        } else {
          evidenceJson = text;
          summary = summaryText(summary, null);
        }
      }
      const id = newId(now);
      const startedAt = r.startedAt ?? now; const finishedAt = Math.max(r.finishedAt ?? now, startedAt);
      this.db.prepare(`INSERT INTO validations (id, version_id, validator_id, validator_version, stage, status, blocking, advisory, summary,
          evidence_json, job_id, attempt_n, created_by, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, v.id, r.validatorId, r.validatorVersion ?? String(def?.version ?? 1), r.stage ?? def?.stage ?? 'candidate', status,
          blocking ? 1 : 0, advisory ? 1 : 0, summary, evidenceJson, r.jobId ?? null, r.jobId ? (r.attemptN ?? null) : null,
          p.id, startedAt, finishedAt);
      if (r.jobId) {
        const job = this.db.prepare('SELECT project_id FROM jobs WHERE id = ?').get(r.jobId) as { project_id: string } | undefined;
        if (job) {
          appendJobEventTx(this.db, { type: 'validation', summary: `${r.validatorId}: ${status}`, projectId: job.project_id, jobId: r.jobId,
            attemptN: r.attemptN ?? null, data: { versionId: v.id, validatorId: r.validatorId, status } }, now);
        }
      }
      return toValidationResult(this.db.prepare('SELECT * FROM validations WHERE id = ?').get(id) as ValidationRow);
    });
  }

  /** Records one validator outcome (system), bound to a job attempt when given. */
  recordOutcomeTx(versionId: string, validatorId: string, o: ValidatorOutcome, bind: { jobId?: string | null; attemptN?: number | null; startedAt?: number } = {}): ValidationResult {
    const def = getValidator(validatorId);
    return this.recordResultTx(this.system(), {
      versionId, validatorId, validatorVersion: String(def?.version ?? 1), stage: def?.stage ?? 'candidate', status: o.status,
      // An advisory validator (sde.deps.lock_matches) records advisory rows on any version; the others as before.
      blocking: def?.blocking ?? false, advisory: def?.blocking === false, summary: o.reason && o.status !== 'passed' ? `${o.summary} (${o.reason})` : o.summary,
      evidence: o.evidence, jobId: bind.jobId ?? null, attemptN: bind.attemptN ?? null, startedAt: bind.startedAt
    });
  }

  /** The latest row per validator of a version (newest `finished_at`, then insertion order). */
  private latestRows(versionId: string): ValidationRow[] {
    return this.db.prepare(`SELECT v.* FROM validations v WHERE v.version_id = ? AND NOT EXISTS (SELECT 1 FROM validations w
        WHERE w.version_id = v.version_id AND w.validator_id = v.validator_id
          AND (w.finished_at > v.finished_at OR (w.finished_at = v.finished_at AND w.rowid > v.rowid)))
      ORDER BY v.validator_id`).all(versionId) as ValidationRow[];
  }

  /** The latest BLOCKING row per validator of a version: what the finalize rule reads (advisory rows never gate). */
  private latestBlockingRows(versionId: string): ValidationRow[] {
    return this.db.prepare(`SELECT v.* FROM validations v WHERE v.version_id = ? AND v.blocking = 1 AND NOT EXISTS (SELECT 1 FROM validations w
        WHERE w.version_id = v.version_id AND w.validator_id = v.validator_id AND w.blocking = 1
          AND (w.finished_at > v.finished_at OR (w.finished_at = v.finished_at AND w.rowid > v.rowid)))
      ORDER BY v.validator_id`).all(versionId) as ValidationRow[];
  }

  /** The latest result per validator of a version the caller may read. */
  latestForVersion(p: Principal, versionId: string): ValidationResult[] {
    const v = typeof versionId === 'string' && versionId.length > 0 ? this.versionFacts(versionId) : null;
    if (!v) {
      this.deps.auth.require(p, 'artifact.read', PLATFORM);
      throw new PlatformError('not_found', 'version not found');
    }
    this.access.require(p, v.project_id, 'artifact.read', v.owner_workspace_id ? { workspaceId: v.owner_workspace_id } : undefined);
    return this.latestRows(v.id).map(toValidationResult);
  }

  // ---------- register validators ----------

  /**
   * Every register validator of a kind (blocking and advisory alike: B2b's `sec.entropy_notes` is the first
   * advisory register validator, F15), run over the facts given (by validator id); every result recorded.
   * `recordOutcomeTx` itself stamps `blocking`/`advisory` from each validator's own definition, so an advisory
   * row is recorded but never gates (`blockingValidatorsFor` only ever reads the blocking ones).
   */
  runRegisterTx(system: Principal, versionId: string, facts: Record<string, unknown>, bind: { jobId?: string | null; attemptN?: number | null } = {}): ValidationResult[] {
    if (!this.isSystem(system)) throw new PlatformError('denied', 'register validators are run by the system', { reason: 'system_only' });
    const v = this.versionFacts(versionId);
    if (!v) throw new PlatformError('not_found', 'version not found');
    const defs = VALIDATORS.filter((d) => d.stage === 'register' && d.kinds.includes(v.kind));
    return defs.map((d) => {
      const f = Object.prototype.hasOwnProperty.call(facts, d.id) ? facts[d.id] : undefined;
      const o = f === undefined ? errored('facts_missing', 'Checks could not run: the facts for this check were not recorded.') : this.runPure(d.id, f);
      return this.recordOutcomeTx(v.id, d.id, o, bind);
    });
  }

  /** A pure validator by id (PURE_VALIDATORS). */
  runPure(id: string, facts: unknown): ValidatorOutcome {
    const fn = Object.prototype.hasOwnProperty.call(PURE_VALIDATORS, id) ? PURE_VALIDATORS[id] : null;
    return fn ? fn(facts) : errored('unknown_validator', 'Checks could not run: this check is not in this build.');
  }

  /** For ArtifactService.saveInline (late-bound hook): the register validators of an inline kind over its content. */
  recordInlineRegisterTx(versionId: string, kind: string, content: unknown): void {
    const facts: Record<string, unknown> = {};
    for (const d of VALIDATORS) if (d.stage === 'register' && d.kinds.includes(kind)) facts[d.id] = content;
    this.runRegisterTx(this.system(), versionId, facts);
  }

  // ---------- finalize ----------

  /** The finalize rule (module header). Runs in the caller's transaction or its own. Returns the version's status. */
  finalizeIfReady(system: Principal, versionId: string, o: { allowPartial?: boolean } = {}): VersionStatus {
    if (!this.isSystem(system)) throw new PlatformError('denied', 'only the system finalizes a version', { reason: 'system_only' });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionFacts(versionId);
      if (!v) throw new PlatformError('not_found', 'version not found');
      if (v.status !== 'draft') return v.status;
      // A user's own draft is made ready by the user (Mark ready, B1); only engine-made drafts are finalized here.
      if (v.produced_by_job_id === null && v.produced_by_session_id === null) return 'draft';
      if (v.draft_flag === 'cancelled_partial' && o.allowPartial !== true) return 'draft';
      const blockers = blockingValidatorsFor(v.kind);
      if (blockers.length === 0) return 'draft';
      const latest = new Map(this.latestBlockingRows(v.id).map((r) => [r.validator_id, r.status]));
      const statuses = blockers.map((b) => latest.get(b.id) ?? 'pending');
      const setState = (s: 'passed' | 'failed' | 'error'): void => {
        this.db.prepare('UPDATE artifact_versions SET validation_state = ? WHERE id = ? AND validation_state IS NOT ?').run(s, v.id, s);
      };
      if (statuses.includes('failed')) {
        this.deps.artifacts.setStatusTx(system, v.id, 'failed', { now, onBehalfOf: v.on_behalf_of, via: 'validation' });
        setState('failed');
        return 'failed';
      }
      if (statuses.includes('error')) { setState('error'); return 'draft'; }
      if (statuses.some((s) => s !== 'passed')) return 'draft';
      const ownerActive = v.owner_scope === 'project' || !!this.db.prepare("SELECT 1 FROM project_workspaces WHERE id = ? AND status = 'active'")
        .get(v.owner_participation_id);
      if (!ownerActive) return 'draft';
      this.deps.artifacts.setStatusTx(system, v.id, 'candidate', { now, onBehalfOf: v.on_behalf_of, via: 'validation' });
      setState('passed');
      if (v.kind === 'repository') {
        // Platform policy: a validated snapshot records git state, not work product, so the system makes it current.
        const art = this.db.prepare('SELECT current_version_id FROM artifacts WHERE id = ?').get(v.artifact_id) as { current_version_id: string | null };
        const r = this.deps.artifacts.promoteTx(system, v.id, art.current_version_id, now, { onBehalfOf: v.on_behalf_of });
        if (!r.ok) throw new PlatformError('conflict', 'the repository moved during promotion');
        return 'active';
      }
      return 'candidate';
    });
  }

  // ---------- candidate validation jobs ----------

  /**
   * Creates one system `validate` job per blocking candidate validator of the version's kind that main, the runner
   * or a recipe executes (`params.versionId`; never job_inputs). Deployment validators are recorded by the
   * deployment. Runs in the caller's transaction or its own. Returns the job ids.
   */
  enqueueCandidate(system: Principal, versionId: string, o: { parentJobId?: string | null } = {}): string[] {
    if (!this.isSystem(system)) throw new PlatformError('denied', 'candidate validation is enqueued by the system', { reason: 'system_only' });
    return this.createValidateJobs(system, versionId, VALIDATORS.filter((d) => d.blocking && d.stage === 'candidate'), { parentJobId: o.parentJobId ?? null, revalidate: false });
  }

  private createValidateJobs(by: Principal, versionId: string, defs: readonly ValidatorDef[], o: { parentJobId: string | null; revalidate: boolean }): string[] {
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const v = this.versionFacts(versionId);
      if (!v) throw new PlatformError('not_found', 'version not found');
      const pwId = v.owner_participation_id ?? (v.produced_by_job_id
        ? (this.db.prepare('SELECT participation_id FROM jobs WHERE id = ?').get(v.produced_by_job_id) as { participation_id: string | null } | undefined)?.participation_id ?? null
        : null);
      if (!pwId) return [];
      const pw = this.db.prepare('SELECT project_id, workspace_id FROM project_workspaces WHERE id = ?').get(pwId) as { project_id: string; workspace_id: string } | undefined;
      if (!pw) return [];
      const out: string[] = [];
      // A live check that can run: a recipe check counts only with the capability the scheduler leases it by.
      const live = this.db.prepare(`SELECT id FROM jobs WHERE kind = 'validate' AND validator_id = ? AND state IN ${LIVE_JOB_STATES}
        AND project_id = ? AND json_extract(params_json, '$.versionId') = ?
        AND (recipe_id IS NULL OR (json_type(capabilities_json, '$[0].recipe') = 'text' AND json_type(capabilities_json, '$[0].action') = 'text'))
        ORDER BY rowid DESC LIMIT 1`);
      for (const d of defs) {
        if (!d.kinds.includes(v.kind) || d.executes === 'deployment') continue;
        // A change set's register validators were judged once, at ingest, over facts only that ingest had (the paths
        // and scan hits are not stored); their rows stand, and a revalidation never re-runs them.
        if (v.kind === 'change_set' && d.stage === 'register') continue;
        // B2b Task 8: a change set's two child-job candidate checks are not the generic single-recipe shape (their
        // jobs need a session/participation and task params no other validator's child job needs), so they are
        // enqueued here directly rather than through the generic recipe-matching branch below.
        if (d.id === csTestsPass.ID) { const id = this.enqueueChangeSetDiscoverTx(by, v, o.parentJobId); if (id) out.push(id); continue; }
        if (d.id === appliesCleanly.ID) { const id = this.enqueueChangeSetMergeCheckTx(by, v, o.parentJobId); if (id) out.push(id); continue; }
        const recipe = d.executes === 'child-job' ? testRecipeFor(parse(v.metadata_json), d) : null;
        if (d.executes === 'child-job' && !recipe) continue;
        // Bounded: while a check of this (version, validator) is still waiting or running, it is the answer.
        const existing = live.get(d.id, pw.project_id, v.id) as { id: string } | undefined;
        if (existing) { out.push(existing.id); continue; }
        const seq = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'validate' AND validator_id = ?
          AND json_extract(params_json, '$.versionId') = ?`).get(d.id, v.id) as { n: number }).n + 1;
        // The one creator of validate jobs (JobService refuses the kind to anyone but the system otherwise).
        const res = this.deps.jobs.createCheckTx(by, {
          kind: 'validate', projectId: pw.project_id, workspaceId: pw.workspace_id, idempotencyKey: `validate:${v.id}:${d.id}:${seq}`,
          validatorId: d.id, ...(recipe ? { recipeId: recipe.id } : {}), ...(o.parentJobId ? { parentJobId: o.parentJobId } : {}),
          params: o.revalidate ? { versionId: v.id, revalidate: true } : { versionId: v.id },
          retry: { idempotent: false, maxAttempts: 1, backoffMs: [] }
        });
        if (recipe) {
          const profile = recipe.profiles[0];
          const cap = { action: `validate.${d.id}`, recipe: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, network: recipe.network, profile };
          const limits = recipe.limits
            ? { cpus: recipe.limits.cpus, memoryMb: recipe.limits.memoryMb, pids: 512, wallClockMs: recipe.wallClockMs, outputMaxBytes: recipe.limits.outputMaxBytes, tmpfsMb: 512 }
            : { wallClockMs: recipe.wallClockMs };
          this.db.prepare('UPDATE jobs SET capabilities_json = ?, limits_json = ? WHERE id = ?').run(JSON.stringify([cap]), JSON.stringify(limits), res.job.id);
        }
        appendJobEventTx(this.db, { type: 'job.transition', summary: `job queued: check ${d.id}`, projectId: pw.project_id, jobId: res.job.id,
          data: { from: null, to: 'queued', validator: d.id, versionId: v.id, recipe: recipe?.id ?? null } }, now);
        out.push(res.job.id);
        if (!recipe) this.runner.noteQueued();
      }
      return out;
    });
  }

  /**
   * The agent session a change set's version was produced in, and its (project, workspace): null when it has none.
   * `artifact_versions.produced_by_session_id` is never set by `insertSystemVersionTx` (it names the producing JOB
   * only), so this reads the producing job's own `session_id` instead.
   */
  private changeSetSession(v: VersionFacts): { sessionId: string; projectId: string; workspaceId: string } | null {
    if (!v.produced_by_job_id) return null;
    const j = this.db.prepare('SELECT session_id, project_id, workspace_id FROM jobs WHERE id = ?').get(v.produced_by_job_id) as
      { session_id: string | null; project_id: string; workspace_id: string } | undefined;
    return j && j.session_id ? { sessionId: j.session_id, projectId: j.project_id, workspaceId: j.workspace_id } : null;
  }

  /** The newest live job whose idempotency key matches `like`, or null (a check not yet finished is the answer). */
  private liveChangeSetCheck(like: string): string | null {
    const r = this.db.prepare(`SELECT id FROM jobs WHERE idempotency_key LIKE ? AND state IN ${LIVE_JOB_STATES} ORDER BY rowid DESC LIMIT 1`).get(like) as { id: string } | undefined;
    return r?.id ?? null;
  }
  /**
   * A change-set check that could not even be queued must not leave a draft with no check and no word: its row is
   * recorded `error` ("Checks could not run", Revalidate offered), and the reason is logged.
   */
  private checkNotQueued(v: VersionFacts, validatorId: string, why: string): null {
    this.log(`[nexus] validation: ${validatorId} was not queued for a change set (${why})`);
    try {
      this.recordOutcomeTx(v.id, validatorId, errored('enqueue_failed', 'Checks could not run: the check could not be queued.'), {});
    } catch { /* the version is gone or settled; nothing to record against */ }
    return null;
  }
  private countChangeSetChecks(like: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key LIKE ?').get(like) as { n: number }).n;
  }

  /**
   * B2b Task 8: `cs.tests_pass`'s first child job, `sde.test.discover` at the change set's own head commit. A draft
   * version cannot be a `job_inputs` row (`JobService.requireInputVersion`: candidate or active only), so, like
   * `git.applies_cleanly`'s `changeset.merge_check`, this is a `validate`-kind job carrying no job_inputs and
   * `params.versionId` instead; `discovery()` (ingest.ts) reads that param for a `validate`-kind job exactly as
   * `testRun()` already does, and `planInputs()` (executionService.ts) already synthesizes the one input slot of a
   * recipe-less-input `validate` job from the same param, so planBuilder stages the change set's own commit (its
   * storage is `{kind:'git', commit: head}`, exactly what a repository input would carry) unmodified. Idempotent by
   * key: a repeat (restart recovery, a second enqueue) answers the same job. Once the suite `discovery()` derives
   * from it reaches its own `sde.tests_pass` result, ingest.ts mirrors it onto this change set's `cs.tests_pass` row.
   */
  private enqueueChangeSetDiscoverTx(by: Principal, v: VersionFacts, _parentJobId: string | null): string | null {
    void _parentJobId;
    const s = this.changeSetSession(v);
    const recipe = getRecipe('sde.test.discover');
    if (!s || !recipe) return this.checkNotQueued(v, csTestsPass.ID, 'no session or recipe');
    const meta = parse(v.metadata_json);
    const profile = isObj(meta) && typeof meta.profile === 'string' && recipe.profiles.includes(meta.profile as never) ? meta.profile : recipe.profiles[0];
    // A live check of this change set is the answer; a settled one (it errored, or its runner failed) is re-run under a
    // fresh key (revalidate), exactly as the generic branch bounds and re-queues its checks.
    const live = this.liveChangeSetCheck('cs.tests_pass:' + v.id + ':discover%');
    if (live) return live;
    const seq = this.countChangeSetChecks('cs.tests_pass:' + v.id + ':discover%') + 1;
    let res: { job: { id: string }; created: boolean };
    try {
      // No sessionId and no parentJobId: the suite's own sde.tests_pass (the generic recipe-matching branch above)
      // is itself created session-less and parent-less, and JobService.requireParentJob requires a child's session
      // to equal its parent's exactly; a session-bearing discover job would make that generic child impossible.
      res = this.deps.jobs.createCheckTx(by, {
        kind: 'validate', projectId: s.projectId, workspaceId: s.workspaceId, validatorId: csTestsPass.ID,
        idempotencyKey: `cs.tests_pass:${v.id}:discover:${seq}`, recipeId: recipe.id,
        params: { versionId: v.id }, retry: { idempotent: true, maxAttempts: 2, backoffMs: [10_000, 60_000] }
      });
    } catch (e) { return this.checkNotQueued(v, csTestsPass.ID, (e as { code?: string })?.code ?? 'error'); }
    if (res.created) {
      const cap = { action: 'cs.tests_pass.discover', recipe: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, network: recipe.network, profile };
      const limits = recipe.limits
        ? { cpus: recipe.limits.cpus, memoryMb: recipe.limits.memoryMb, pids: 512, wallClockMs: recipe.wallClockMs, outputMaxBytes: recipe.limits.outputMaxBytes, tmpfsMb: 512 }
        : { wallClockMs: recipe.wallClockMs };
      this.db.prepare('UPDATE jobs SET capabilities_json = ?, limits_json = ? WHERE id = ?').run(JSON.stringify([cap]), JSON.stringify(limits), res.job.id);
      appendJobEventTx(this.db, { type: 'job.transition', summary: 'job queued: change-set test discovery', projectId: s.projectId, jobId: res.job.id,
        data: { from: null, to: 'queued', validator: csTestsPass.ID, versionId: v.id, recipe: recipe.id } }, this.deps.now());
      this.runner.noteQueued();
    }
    return res.job.id;
  }

  /**
   * B2b Task 8: `git.applies_cleanly`'s child job, the engine recipe `changeset.merge_check` (an engine recipe has no
   * sandbox profile, so it is never matched by `testRecipeFor`'s profile lookup; it is enqueued here directly instead,
   * exactly as `repo.worktree` and the other git engine jobs are). Params carry `branch` and `head` (planBuilder reads
   * them for `changeset.merge_check`'s task); `versionId` is what `step()`/ingest key the result to.
   */
  private enqueueChangeSetMergeCheckTx(by: Principal, v: VersionFacts, parentJobId: string | null): string | null {
    const s = this.changeSetSession(v);
    const recipe = getRecipe('changeset.merge_check');
    const storage = parse(v.storage_ref_json);
    const meta = parse(v.metadata_json);
    const head = isObj(storage) && typeof storage.commit === 'string' ? storage.commit : null;
    const branch = isObj(meta) && typeof meta.branch === 'string' ? meta.branch : null;
    if (!s || !recipe || !head || !branch) return this.checkNotQueued(v, appliesCleanly.ID, 'no session, recipe, commit or branch');
    const live = this.liveChangeSetCheck('git.applies_cleanly:' + v.id + ':merge_check%');
    if (live) return live;
    const seq = this.countChangeSetChecks('git.applies_cleanly:' + v.id + ':merge_check%') + 1;
    let res: { job: { id: string }; created: boolean };
    try {
      res = this.deps.jobs.createCheckTx(by, {
        kind: 'validate', projectId: s.projectId, workspaceId: s.workspaceId, sessionId: s.sessionId, validatorId: appliesCleanly.ID,
        ...(parentJobId ? { parentJobId } : {}), idempotencyKey: `git.applies_cleanly:${v.id}:merge_check:${seq}`, recipeId: recipe.id,
        params: { versionId: v.id, branch, head }, retry: { idempotent: false, maxAttempts: 1, backoffMs: [] }
      });
    } catch (e) { return this.checkNotQueued(v, appliesCleanly.ID, (e as { code?: string })?.code ?? 'error'); }
    if (res.created) {
      const cap = { action: 'validate.git.applies_cleanly', recipe: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, network: recipe.network };
      this.db.prepare('UPDATE jobs SET capabilities_json = ?, limits_json = ? WHERE id = ?')
        .run(JSON.stringify([cap]), JSON.stringify({ wallClockMs: recipe.wallClockMs }), res.job.id);
      appendJobEventTx(this.db, { type: 'job.transition', summary: 'job queued: check git.applies_cleanly', projectId: s.projectId, jobId: res.job.id,
        data: { from: null, to: 'queued', validator: appliesCleanly.ID, versionId: v.id, recipe: recipe.id } }, this.deps.now());
    }
    return res.job.id;
  }

  /**
   * @internal Restart recovery (system, inside the caller's transaction): a check main was running when the app stopped
   * (its job interrupted, its attempt abandoned) is queued again as a new validate job for the same version and
   * validator, with the same parent and revalidation flag. Results are idempotent: the version stays a draft until a
   * result row exists. Returns the queued job ids (the live one when a check of that pair is already waiting).
   */
  requeueCheckTx(system: Principal, jobId: string): string[] {
    if (!this.isSystem(system)) throw new PlatformError('denied', 'checks are queued again by the system', { reason: 'system_only' });
    const j = this.db.prepare("SELECT validator_id, params_json, parent_job_id FROM jobs WHERE id = ? AND kind = 'validate'").get(jobId) as
      { validator_id: string | null; params_json: string; parent_job_id: string | null } | undefined;
    const def = j ? getValidator(j.validator_id ?? '') : null;
    const params = j ? parse(j.params_json) : null;
    const versionId = isObj(params) && typeof params.versionId === 'string' ? params.versionId : null;
    if (!j || !def || !versionId || !this.versionFacts(versionId)) return [];
    const ids = this.createValidateJobs(system, versionId, [def], { parentJobId: j.parent_job_id, revalidate: isObj(params) && params.revalidate === true });
    return ids.filter((id) => id !== jobId);
  }

  /**
   * User: run every blocking check of a draft again (new rows; old rows stay). Returns the validate jobs.
   * With an intent (a ULID the renderer minted once, B2a Task 13 fix round 1), the request is idempotent: its answer is
   * recorded with it (one `version.revalidate` activity row, in the transaction that queues the checks), and the same
   * intent sent again returns the same jobs and queues nothing, whatever happened since (the version left draft, the
   * checks ended). An intent is one request for ONE version (fix round 2): it is looked up whatever the version, and
   * re-sent for another version it is refused (`invalid` / `intent_mismatch`), never answered with the other's jobs.
   */
  revalidate(p: Principal, versionId: string, intentId?: string): { jobs: string[] } {
    const v = typeof versionId === 'string' && versionId.length > 0 ? this.versionFacts(versionId) : null;
    if (!v) {
      this.deps.auth.require(p, 'version.revalidate', PLATFORM);
      throw new PlatformError('not_found', 'version not found');
    }
    this.access.require(p, v.project_id, 'version.revalidate', v.owner_workspace_id ? { workspaceId: v.owner_workspace_id } : undefined);
    const intent = intentId === undefined ? null : validateKey(intentId);
    if (intent !== null) {
      const prior = this.revalidateAnswer(v.id, intent);
      if (prior) return { jobs: prior };
    }
    if (v.status !== 'draft') throw new PlatformError('illegal_transition', `checks are run again only on a draft, not a ${v.status} version`, { from: v.status });
    // The user asked for it; the jobs act on the user's behalf, the results are still recorded by the system.
    const defs = blockingValidatorsFor(v.kind);
    const now = this.deps.now();
    const jobs = immediateTx(this.db, () => {
      const prior = intent !== null ? this.revalidateAnswer(v.id, intent) : null;
      if (prior) return prior;
      const ids = this.createValidateJobs(p, v.id, defs, { parentJobId: null, revalidate: true });
      if (intent !== null) {
        appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, projectId: v.project_id, workspaceId: v.owner_workspace_id,
          artifactId: v.artifact_id, versionId: v.id, entityType: 'artifact_version', entityId: v.id, action: 'version.revalidate', status: 'succeeded',
          details: { intent, jobs: ids } }, now);
      }
      return ids;
    });
    this.runPending(this.deps.now());
    return { jobs };
  }

  /**
   * The jobs an earlier revalidation with this intent answered, or null when the intent is new. The intent is looked up
   * for every version (fix round 2): one used for another version is refused, `invalid` / `intent_mismatch`.
   */
  private revalidateAnswer(versionId: string, intent: string): string[] | null {
    const r = this.db.prepare(`SELECT version_id, details_json FROM activity WHERE action = 'version.revalidate' AND status = 'succeeded'
      AND json_extract(details_json, '$.intent') = ? ORDER BY seq DESC LIMIT 1`).get(intent) as { version_id: string | null; details_json: string } | undefined;
    if (!r) return null;
    if (r.version_id !== versionId) {
      throw new PlatformError('invalid', 'this request was already made for another version', { reason: 'intent_mismatch' });
    }
    const d = parse(r.details_json);
    return isObj(d) && Array.isArray(d.jobs) ? d.jobs.filter((x): x is string => typeof x === 'string') : [];
  }

  // ---------- running validate jobs (CheckRunner) ----------

  /** A full pass over the queued main and runner checks and the ended recipe checks. Never throws. */
  runPending(now: number): void { this.runner.runPending(now); }
  /** The scheduler's pass (every tick): work only when some is due. */
  tick(now: number): void { this.runner.tick(now); }
  /** The runner's `blob.verified` answer. */
  onBlobVerified(sha256: string, ok: boolean): void { this.runner.onBlobVerified(sha256, ok); }
  /** A runner-wide fault (no attempt named, or the port left `ready` or was replaced): outstanding re-hashes are `error`. */
  onRunnerFault(): void { this.runner.onRunnerFault(); }
  /** A validate job reached a terminal state (the execution core reports it). */
  onJobEnded(): void { this.runner.onJobEnded(); }
  /** Records the result of recipe checks that ended without one. */
  recordEndedRecipeChecks(): void { this.runner.recordEndedRecipeChecks(); }

  repoPathOf(projectId: string): string | null {
    const accept = this.deps.acceptFsRoot;
    if (!accept) return null;
    const p = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string | null } | undefined;
    if (!p || typeof p.root_path !== 'string' || p.root_path.length === 0) return null;
    try { return accept(p.root_path); } catch { return null; }
  }
}
