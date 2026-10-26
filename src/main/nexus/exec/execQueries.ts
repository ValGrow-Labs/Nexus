/**
 * Execution reads for the IPC layer (B2a Task 13): what a person may do now, where an attempt's log is stored, what a
 * version preview reads, and a version's checks. Every method authorizes through the platform's own rules first
 * (ProjectAccess / ArtifactService / ExecutionService: a denial is audited, an unknown id is `not_found` only for a
 * platform-wide reader); nothing here writes, and nothing here reads a file: the async reads of a stored log or object
 * happen in main's execution wiring (src/main/nexusExec), from the RELATIVE location returned here, confined to the
 * data home there.
 *
 * - actionsFor (#24): the domain's user actions with `available` and a reason: `planned`, `future`, `withdrawn` or
 *   `complete` (the participation is not active: fix round 1, never reported as `permission`), `permission`,
 *   `not_applicable`, `blocked_by_step:<id>` (an input kind the step produces has no usable version yet) or the
 *   execution core's `setup:<id>`. Permission is decided without an audit row (a list is not an attempt). B2b: an agent
 *   flow action (an agent turn, a review, accept, merge accepted work) answers `agents_unavailable` while the agents part
 *   of the platform is off.
 * - attemptLog (#28): the stored `log_path` of attempt n of a readable job (job.read).
 * - previewSource (#34): what a page of a version reads: its inline JSON, its git facts, its blob, its tree manifest
 *   (version_blobs `file` rows), its discovered tests (metadata) or its latest JUnit table: the counts (failures first),
 *   then the per-case rows, failed cases first, then errored ones (fix round 1: the `case` evidence the ingest kept with
 *   the latest `sde.tests_pass` result, from the runner's normalized report; main never parses the XML).
 * - validationsFor (#32): per validator, the LATEST BLOCKING row (the version's status) and, apart from it, the newest
 *   advisory run (a user's run on a candidate, a deduplicated output): a run result, never the status.
 */
import type Database from 'better-sqlite3';
import type { Principal, VersionStatus } from '../../../shared/nexus/platform';
import { getUserAction } from '../../../shared/nexus/actions';
import { getDomain } from '../../../shared/nexus/domains/index';
import { isAtOrBefore } from '../../../shared/nexus/domainSpec';
import { getRecipe } from '../../../shared/nexus/recipes';
import type { AuthService } from '../auth/authService';
import type { ArtifactService } from '../artifact/artifactService';
import { PlatformError } from '../errors';
import { participationFor } from '../jobs/jobService';
import { ProjectAccess } from '../project/projectAccess';
import type { ExecutionService } from './executionService';

export interface ActionAvailability {
  actionId: string; label: string; stepId: string | null; available: boolean; reason: string | null;
  inputs: { slot: string; kinds: string[]; min: number; max: number }[]; needsApproval: boolean;
}
/** `diff` (B2b Task 14) is read through the accept service (the runner's bounded git read), not through `previewSource`. */
export type PreviewPartId = 'content' | 'manifest' | 'discovery' | 'junit_summary' | 'diff';
export interface PreviewRow { name: string; detail: string | null; bytes: number | null; outcome: string | null }
/** What a preview page reads: text main holds, a stored object (read in the wiring), or rows. */
export type PreviewSource =
  | { type: 'text'; text: string }
  | { type: 'object'; sha256: string; bytes: number; mediaType: string }
  | { type: 'rows'; rows: PreviewRow[] };
export interface ValidatorSummary {
  validatorId: string; blocking: boolean;
  latestBlocking: { status: string; summary: string; finishedAt: number; evidence: unknown } | null;
  latestRun: { status: string; summary: string; finishedAt: number } | null;
  history: number;
}

/**
 * A blob larger than this is not previewed (`too_large`). Fix round 1: a preview redacts the WHOLE content before it pages
 * it (a cut can never split a secret), so the bound keeps one page request's redaction pass short.
 */
export const PREVIEW_MAX_OBJECT_BYTES = 4 * 2 ** 20;
const LIVE_DEPLOYMENTS = "('starting','healthy','unhealthy')";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };

export class ExecQueries {
  private readonly access: ProjectAccess;

  constructor(private readonly db: Database.Database, private readonly deps: {
    auth: AuthService; artifacts: ArtifactService; exec: ExecutionService;
    /**
     * B2b: whether the agents part of the platform is on (schema v10, wired by a later B2b task). Absent means off:
     * every agent flow action then answers `agents_unavailable`.
     */
    agentsAvailable?: () => boolean;
  }) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
  }

  // ---------- #24 actions ----------

  actionsFor(p: Principal, q: { projectId: string; workspaceId: string; versionId?: string }): ActionAvailability[] {
    this.access.require(p, q.projectId, 'project.read');
    const domain = getDomain(q.workspaceId);
    if (!domain) throw new PlatformError('not_found', 'workspace not found');
    const pw = participationFor(this.db, q.projectId, q.workspaceId);
    if (!pw) throw new PlatformError('not_participating', 'the project does not take part in that workspace');
    let versionKind: string | null = null;
    if (q.versionId !== undefined) {
      const v = this.deps.artifacts.getVersion(p, q.versionId);
      if (v.projectId !== q.projectId) throw new PlatformError('invalid', 'the version belongs to another project', { reason: 'other_project' });
      versionKind = (this.db.prepare('SELECT a.kind FROM artifacts a WHERE a.id = ?').get(v.artifactId) as { kind: string }).kind;
    }
    const scope = { type: 'project' as const, projectId: pw.project_id, workspaceId: pw.workspace_id };
    const can = (action: 'job.create' | 'artifact.create' | 'deployment.stop' | 'agent.start' | 'review.decide' | 'changeset.accept' | 'repo.merge'): boolean =>
      pw.status === 'active' && this.deps.auth.authorize(p, action, scope).allowed;
    const usable = (kind: string, statuses: readonly VersionStatus[]): boolean => !!this.db.prepare(`SELECT 1 FROM artifact_versions v
      JOIN artifacts a ON a.id = v.artifact_id WHERE a.project_id = ? AND a.kind = ? AND a.status = 'active'
        AND v.status IN (${statuses.map(() => '?').join(', ')}) LIMIT 1`).get(q.projectId, kind, ...statuses);
    const producedBy = (kind: string): string => domain.lifecycle.find((s) => s.produces.includes(kind))?.id ?? kind;
    const out: ActionAvailability[] = [];
    for (const id of domain.actions) {
      const action = getUserAction(id);
      if (!action) continue;
      const step = domain.lifecycle.find((s) => s.via.some((v) => 'userAction' in v && v.userAction === id)) ?? null;
      const recipes = 'recipes' in action.run ? action.run.recipes.map((r) => getRecipe(r)).filter((r) => r !== null) : [];
      const view: ActionAvailability = {
        actionId: action.id, label: action.label, stepId: step?.id ?? null, available: false, reason: null,
        inputs: action.inputs.map((s) => ({ slot: s.slot, kinds: [...s.kinds], min: s.min, max: s.max })),
        needsApproval: recipes.some((r) => r!.network === 'egress-approved')
      };
      const reason = this.reasonFor(action, step, versionKind, can, usable, producedBy, q.projectId, pw.status);
      view.available = reason === null;
      view.reason = reason;
      out.push(view);
    }
    return out;
  }

  private reasonFor(action: NonNullable<ReturnType<typeof getUserAction>>, step: { status: string; subPhase: Parameters<typeof isAtOrBefore>[0] } | null,
    versionKind: string | null, can: (a: 'job.create' | 'artifact.create' | 'deployment.stop' | 'agent.start' | 'review.decide' | 'changeset.accept' | 'repo.merge') => boolean,
    usable: (kind: string, statuses: readonly VersionStatus[]) => boolean, producedBy: (kind: string) => string, projectId: string,
    participation: string): string | null {
    if (!isAtOrBefore(action.subPhase)) return 'planned';
    if (step && (step.status === 'FUTURE' || !isAtOrBefore(step.subPhase))) return 'future';
    // The participation is withdrawn or complete: that is why nothing can start, not a missing permission.
    if (participation !== 'active') return participation;
    const run = action.run;
    // B2b agent flows (an agent turn, a review, accept, merge accepted work) have their own channels, never a job start.
    // While the agents part is off they answer `agents_unavailable` (a sentence, never a button).
    if ('flow' in run) {
      if (versionKind !== null && !action.inputs.some((s) => s.kinds.includes(versionKind))) return 'not_applicable';
      let agents = false;
      try { agents = this.deps.agentsAvailable?.() === true; } catch { agents = false; }
      if (!agents) return 'agents_unavailable';
      // Each flow is judged by its own platform action (not by job.create): starting a turn, deciding a review, accepting, merging.
      const needs = run.flow === 'agent.turn' ? 'agent.start' : run.flow === 'review.decide' ? 'review.decide'
        : run.flow === 'changeset.accept' ? 'changeset.accept' : 'repo.merge';
      return can(needs) ? null : 'permission';
    }
    if ('inlineKind' in run) {
      if (!can('artifact.create')) return 'permission';
      return versionKind !== null && versionKind !== run.inlineKind ? 'not_applicable' : null;
    }
    if ('control' in run) {
      if (!can('deployment.stop')) return 'permission';
      const live = this.db.prepare(`SELECT 1 FROM deployments WHERE project_id = ? AND status IN ${LIVE_DEPLOYMENTS} LIMIT 1`).get(projectId);
      return live ? null : 'not_applicable';
    }
    if (!can('job.create')) return 'permission';
    if (versionKind !== null && !action.inputs.some((s) => s.kinds.includes(versionKind))) return 'not_applicable';
    // A dev deployment previews an application that may still be a draft (its health check makes it a candidate).
    const preview = run.recipes.some((r) => getRecipe(r)?.executor === 'service');
    for (const s of action.inputs) {
      if (s.min < 1) continue;
      const statuses: VersionStatus[] = preview ? ['draft', 'candidate', 'active'] : ['candidate', 'active'];
      if (!s.kinds.some((k) => usable(k, statuses))) return `blocked_by_step:${producedBy(s.kinds[0])}`;
    }
    const setup = this.deps.exec.setupAvailability({ actionId: action.id });
    return setup.available ? null : (setup.reason ?? 'setup:runner_unavailable');
  }

  // ---------- #28 the stored log of one attempt ----------

  /** The stored log path (relative to the data home) of attempt `n` of a job the caller may read. */
  attemptLog(p: Principal, jobId: string, n: number): { logRel: string | null; logBytes: number } {
    const j = this.deps.exec.get(p, jobId);
    const a = this.db.prepare('SELECT log_path, log_bytes FROM job_attempts WHERE job_id = ? AND n = ?').get(j.id, n) as
      { log_path: string | null; log_bytes: number } | undefined;
    if (!a) throw new PlatformError('not_found', 'attempt not found', { jobId: j.id });
    return { logRel: a.log_path, logBytes: a.log_bytes };
  }

  // ---------- #32 the checks of a version ----------

  validationsFor(p: Principal, versionId: string): ValidatorSummary[] {
    const v = this.deps.artifacts.getVersion(p, versionId);
    type Row = { validator_id: string; status: string; blocking: number; summary: string; finished_at: number; evidence_json: string };
    const rows = this.db.prepare(`SELECT validator_id, status, blocking, summary, finished_at, evidence_json FROM validations
      WHERE version_id = ? ORDER BY validator_id, finished_at, rowid`).all(v.id) as Row[];
    const by = new Map<string, Row[]>();
    for (const r of rows) { const l = by.get(r.validator_id) ?? []; l.push(r); by.set(r.validator_id, l); }
    const out: ValidatorSummary[] = [];
    for (const [id, list] of by) {
      // Rows are oldest first: the last of each kind is the latest.
      const blocking = list.filter((r) => r.blocking === 1).pop() ?? null;
      const advisory = list.filter((r) => r.blocking === 0).pop() ?? null;
      out.push({
        validatorId: id, blocking: blocking !== null,
        latestBlocking: blocking ? { status: blocking.status, summary: blocking.summary, finishedAt: blocking.finished_at, evidence: parse(blocking.evidence_json) } : null,
        latestRun: advisory ? { status: advisory.status, summary: advisory.summary, finishedAt: advisory.finished_at } : null,
        history: list.length
      });
    }
    return out;
  }

  // ---------- #34 what a preview reads ----------

  previewSource(p: Principal, versionId: string, part: PreviewPartId): PreviewSource {
    const v = this.deps.artifacts.getVersion(p, versionId);
    const kind = (this.db.prepare('SELECT kind FROM artifacts WHERE id = ?').get(v.artifactId) as { kind: string }).kind;
    const none = (): never => { throw new PlatformError('invalid', `a ${kind} version has no ${part} to preview`, { reason: 'no_such_part' }); };
    const s = v.storage;
    if (part === 'diff') return none();
    if (part === 'content') {
      if (s.kind === 'inline') return { type: 'text', text: JSON.stringify(s.json, null, 2) ?? '' };
      if (s.kind === 'git') return { type: 'text', text: [`commit ${s.commit}`, ...(s.ref ? [`ref ${s.ref}`] : [])].join('\n') };
      if (s.kind === 'blob') {
        if (s.bytes > PREVIEW_MAX_OBJECT_BYTES) throw new PlatformError('too_large', 'the stored content is too large to preview', { versionId: v.id });
        return { type: 'object', sha256: s.sha256, bytes: s.bytes, mediaType: s.mediaType };
      }
      return none();
    }
    if (part === 'manifest') {
      if (s.kind !== 'tree') return none();
      const files = this.db.prepare(`SELECT vb.path, vb.sha256, b.bytes FROM version_blobs vb LEFT JOIN blobs b ON b.sha256 = vb.sha256
        WHERE vb.version_id = ? AND vb.role = 'file' ORDER BY vb.path`).all(v.id) as { path: string; sha256: string; bytes: number | null }[];
      return { type: 'rows', rows: files.map((f) => ({ name: f.path, detail: `sha256:${f.sha256.slice(0, 12)}`, bytes: f.bytes, outcome: null })) };
    }
    if (part === 'discovery') {
      const m = v.metadata;
      if (kind !== 'test_suite' || !isObj(m)) return none();
      const files = Array.isArray(m.files) ? m.files.filter((x): x is string => typeof x === 'string') : [];
      const framework = typeof m.framework === 'string' ? m.framework : null;
      return { type: 'rows', rows: files.map((f) => ({ name: f, detail: framework, bytes: null, outcome: null })) };
    }
    // junit_summary: the latest sde.tests_pass result's JUnit counts (failures first), then its per-case table: the failed
    // cases, then the errored ones (each row: the test name, its file or class, its outcome).
    if (kind !== 'test_suite') return none();
    const r = this.db.prepare(`SELECT evidence_json, status FROM validations WHERE version_id = ? AND validator_id = 'sde.tests_pass'
      ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get(v.id) as { evidence_json: string; status: string } | undefined;
    const ev = r ? parse(r.evidence_json) : null;
    const junit = Array.isArray(ev) ? ev.find((e) => isObj(e) && e.type === 'junit') as Record<string, unknown> | undefined : undefined;
    if (!junit) return { type: 'rows', rows: [] };
    const n = (k: string): number | null => (typeof junit[k] === 'number' ? junit[k] as number : null);
    const rows: PreviewRow[] = [
      { name: 'failed', detail: null, bytes: null, outcome: String(n('failed') ?? 0) },
      { name: 'errored', detail: null, bytes: null, outcome: String(n('errored') ?? 0) },
      { name: 'passed', detail: null, bytes: null, outcome: String(n('passed') ?? 0) },
      { name: 'skipped', detail: null, bytes: null, outcome: String(n('skipped') ?? 0) },
      { name: 'total', detail: r!.status, bytes: null, outcome: String(n('total') ?? 0) }
    ];
    const cases = (ev as unknown[]).filter((e): e is Record<string, unknown> => isObj(e) && e.type === 'case'
      && (e.outcome === 'failed' || e.outcome === 'errored') && typeof e.name === 'string');
    for (const outcome of ['failed', 'errored'] as const) {
      for (const c of cases) {
        if (c.outcome !== outcome) continue;
        const where = typeof c.file === 'string' && c.file.length > 0 ? c.file : typeof c.classname === 'string' && c.classname.length > 0 ? c.classname : null;
        rows.push({ name: c.name as string, detail: where, bytes: null, outcome });
      }
    }
    return { type: 'rows', rows };
  }
}
