/**
 * The agent turn's context file (B2b, F23): main is the single writer of `<dataHome>/jobs/<jobId>/agent/context.md`.
 * The agent reads it from its own mounted worktree; main never sends its content back over MCP except as metadata
 * (`context_get`, mcpGateway.ts).
 *
 * - Contents, one section per field: the domain and its vocabulary, the turn's focus versions (job_inputs with role
 *   'focus'), up to MAX_PRIOR_MESSAGES prior user messages of the session (from the activity log), outstanding
 *   `request_changes` review comments on the project's change sets, and a short note of the project's newest
 *   diagnostic report, when one exists.
 * - Every field is secret-checked before it is written (`containsSecret`). A single-value field (Domain, Vocabulary,
 *   Focus versions, Diagnostic facts) that hits is dropped whole; a list field (prior user messages, requested
 *   changes) is checked ITEM BY ITEM, so one secret-shaped message never costs the rest of the history. Either way
 *   nothing is ever partially redacted mid-value (a secret-shaped line carries no signal worth keeping once it is
 *   cut up), and every drop is counted in `context_redacted`.
 * - Returns `{ path, sha256, bytes }`; the hash is recorded in `jobs.context_hash` (present since schema v7, reused
 *   here) in its own transaction. The relative path is confined under the data home before every write (dataHome.ts).
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { getDomain } from '../../../shared/nexus/domains/index';
import { containsSecret, redactText } from '../activity/redact';
import { appendActivityRow } from '../activity/writer';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import type { Principal } from '../../../shared/nexus/platform';

/** The data home surface ContextResolver and Skills need: confinement and the per-job relative folder. */
export interface AgentDataHome {
  readonly root: string;
  jobRel(jobId: string): string;
  confineToDataHome(rel: string): Promise<string | null>;
}

export interface ContextJob {
  id: string; projectId: string; workspaceId: string; sessionId: string | null;
  /** Main's own notes to the agent (for example that its working copy is fresh); secret-checked like every field. */
  notes?: readonly string[];
}
export interface ContextResolverDeps { dataHome: AgentDataHome | null; now: () => number; system: Principal }
export interface ContextResult { path: string; sha256: string; bytes: number }

/** The most prior user messages (and the most request_changes comments) a context file carries. */
export const MAX_PRIOR_MESSAGES = 20;
const MAX_CONTEXT_BYTES = 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parseJson = (t: string): unknown => { try { return JSON.parse(t) as unknown; } catch { return null; } };

export class ContextResolver {
  constructor(private readonly db: Database.Database, private readonly deps: ContextResolverDeps) {}

  /** Writes the turn's context file (overwriting any earlier one for this job) and records its hash. */
  async resolve(job: ContextJob): Promise<ContextResult> {
    if (typeof job?.id !== 'string' || job.id.length === 0) throw new PlatformError('invalid', 'a job is required');
    if (!this.deps.dataHome) throw new PlatformError('platform_unavailable', 'no data home: the context file cannot be written');
    const dataHome = this.deps.dataHome;

    const sections: string[] = [];
    let redacted = 0;
    const field = (label: string, value: string | null | undefined): void => {
      if (value === null || value === undefined || value.trim().length === 0) return;
      if (containsSecret(value)) { redacted++; return; }
      sections.push(`## ${label}\n\n${redactText(value).trim()}\n`);
    };

    if (Array.isArray(job.notes) && job.notes.length > 0) field('Notes', job.notes.join('\n'));
    const domain = getDomain(job.workspaceId);
    field('Domain', domain ? `${domain.label} (${domain.id})` : job.workspaceId);
    if (domain) {
      const vocab = Object.entries(domain.vocabulary)
        .filter((e): e is [string, { singular: string; plural: string }] => !!e[1])
        .map(([k, v]) => `- ${k}: ${v.singular} / ${v.plural}`).join('\n');
      field('Vocabulary', vocab);
    }

    const focus = this.db.prepare(`SELECT ji.version_id AS id, a.kind AS kind, a.name AS name FROM job_inputs ji
        JOIN artifact_versions v ON v.id = ji.version_id JOIN artifacts a ON a.id = v.artifact_id
        WHERE ji.job_id = ? AND ji.role = 'focus' ORDER BY ji.version_id`).all(job.id) as
      { id: string; kind: string; name: string }[];
    if (focus.length > 0) field('Focus versions', focus.map((f) => `- ${f.kind} "${f.name}" (${f.id})`).join('\n'));

    // Each ITEM (one message, one comment) is secret-checked on its own: a secret-shaped item is dropped alone,
    // never the whole section, so one bad message never costs the other 19 their history.
    const itemField = (label: string, items: readonly string[]): void => {
      const kept: string[] = [];
      for (const item of items) {
        if (containsSecret(item)) { redacted++; continue; }
        kept.push(`- ${redactText(item)}`);
      }
      if (kept.length > 0) sections.push(`## ${label}\n\n${kept.join('\n')}\n`);
    };

    if (job.sessionId) {
      const rows = this.db.prepare(`SELECT details_json, ts FROM activity WHERE session_id = ? AND actor_kind = 'user'
          ORDER BY seq DESC LIMIT ?`).all(job.sessionId, MAX_PRIOR_MESSAGES) as { details_json: string; ts: number }[];
      const texts: string[] = [];
      for (const r of rows.reverse()) {
        const d = parseJson(r.details_json);
        const text = isObj(d) && typeof d.text === 'string' ? d.text : isObj(d) ? JSON.stringify(d) : '';
        if (text) texts.push(text);
      }
      itemField('Prior user messages', texts);
    }

    const reviewRows = this.db.prepare(`SELECT r.comment AS comment, r.created_at AS ts FROM reviews r
        JOIN artifact_versions v ON v.id = r.version_id WHERE v.project_id = ? AND r.decision = 'request_changes'
          AND r.comment IS NOT NULL ORDER BY r.created_at DESC LIMIT ?`)
      .all(job.projectId, MAX_PRIOR_MESSAGES) as { comment: string; ts: number }[];
    itemField('Requested changes', reviewRows.reverse().map((r) => r.comment));

    const diag = this.db.prepare(`SELECT v.id AS id, v.metadata_json AS metadata_json FROM artifact_versions v
        JOIN artifacts a ON a.id = v.artifact_id WHERE a.project_id = ? AND a.kind = 'diagnostic_report'
          AND v.status IN ('candidate','active') ORDER BY v.created_at DESC LIMIT 1`)
      .get(job.projectId) as { id: string; metadata_json: string } | undefined;
    if (diag) {
      const m = parseJson(diag.metadata_json);
      // The secret check runs on the WHOLE text, before the cut: a secret straddling the 4000-character mark never slips through.
      const full = isObj(m) ? JSON.stringify(m) : `report ${diag.id}`;
      if (containsSecret(full)) redacted++; else field('Diagnostic facts', full.slice(0, 4000));
    }

    const markdown = sections.length > 0 ? sections.join('\n') : '## (no context available for this turn)\n';
    const bounded = Buffer.byteLength(markdown, 'utf8') > MAX_CONTEXT_BYTES
      ? `${markdown.slice(0, MAX_CONTEXT_BYTES)}\n\n[context truncated]\n` : markdown;

    const rel = `${dataHome.jobRel(job.id)}/agent/context.md`;
    const abs = await dataHome.confineToDataHome(rel);
    if (!abs) throw new PlatformError('invalid', 'the context path could not be confined to the data home');
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bounded, 'utf8');
    const sha256 = createHash('sha256').update(bounded, 'utf8').digest('hex');
    const bytes = Buffer.byteLength(bounded, 'utf8');
    const now = this.deps.now();
    const row = this.db.prepare('SELECT project_id, workspace_id FROM jobs WHERE id = ?').get(job.id) as
      { project_id: string; workspace_id: string } | undefined;
    immediateTx(this.db, () => {
      this.db.prepare('UPDATE jobs SET context_hash = ? WHERE id = ?').run(sha256, job.id);
      if (redacted > 0) {
        // Operator-facing count only: never which field, never the value.
        appendActivityRow(this.db, { actorKind: 'system', actorId: this.deps.system.id, jobId: job.id, sessionId: job.sessionId,
          projectId: row?.project_id ?? job.projectId, workspaceId: row?.workspace_id ?? job.workspaceId, entityType: 'job',
          entityId: job.id, action: 'context_redacted', status: 'succeeded', details: { count: redacted } }, now);
      }
    });
    return { path: rel, sha256, bytes };
  }
}
