// Pure: a version's checks (ValidationResultView[], #32) as the Folio's evidence
// page. Every fact names where it came from: the test tool's counts, a
// hash, an HTTP probe, a git check, an exit code, a docker inspect field, a log
// range. Nothing is summarised into a number the records do not hold.
import type { ValidationResultView, VersionView } from '@shared/nexus/ipc';
import { blockingValidatorsFor } from '@shared/nexus/validators';
import { runsOnUserAction } from '@shared/nexus/stepState';

export type CheckStatus = ValidationResultView['status'];
export type ChecksHeadline = 'Checks passed' | 'Checks failed' | 'Checks could not run' | 'Checking…' | 'No checks saved yet'
  | 'This kind of item has no checks' | 'No required checks' | 'No checks ran' | 'Some checks have not run';

export interface EvidenceFact { kind: string; label: string; value: string; source: string }
export interface EvidenceRow {
  validatorId: string;
  label: string;
  /** Always a word: "Passed", "Failed", "Could not run", "Skipped", "Not run yet". */
  word: string;
  status: CheckStatus;
  blocking: boolean;
  /** The check's own sentence; for a check that could not run, "Checks could not run: <reason>". */
  summary: string | null;
  facts: EvidenceFact[];
  /** The newest run result of an advisory row (never the status). */
  latestRun: { word: string; summary: string } | null;
  history: number;
  /** Reason codes cut out of the summary (`tests_failed`): never shown as text, kept for a title attribute. */
  codes: string[];
}
/** The headline is a ChecksHeadline, an application's preview word, or what passed and what still waits for a preview. */
export interface EvidenceView { headline: string; rows: EvidenceRow[]; revalidate: boolean }

export const STATUS_WORD: Readonly<Record<string, string>> = Object.freeze({
  passed: 'Passed', failed: 'Failed', error: 'Could not run', skipped: 'Skipped'
});
export const statusWord = (s: CheckStatus): string => (s ? STATUS_WORD[s] ?? s : 'Not run yet');

/**
 * What each check says to a person, in plain words, never its id: `name` is what is looked at (also used while the check has no result),
 * `pass` and `fail` are the sentence for a result. A check this build does not know reads "Another check", never its id.
 */
interface CheckWords { name: string; pass: string; fail: string }
const CHECK_WORDS: Readonly<Record<string, CheckWords>> = Object.freeze({
  'git.head_resolves': { name: 'The saved version in your project', pass: 'The saved version was found in your project', fail: 'The saved version was not found in your project' },
  'req.schema': { name: 'The requirement', pass: 'The requirement has a title and at least one thing to check', fail: 'The requirement is missing a title or something to check' },
  'problem.schema': { name: 'The problem statement', pass: 'The problem statement is complete', fail: 'The problem statement is not complete' },
  'suite.discovered': { name: 'Finding your tests', pass: 'Nexus found your tests', fail: 'Nexus did not find any tests' },
  'sde.tests_pass': { name: 'Your tests', pass: 'Your tests ran and passed', fail: 'Some of your tests failed' },
  'build.exit_zero': { name: 'The build', pass: 'The build finished without errors', fail: 'The build stopped with an error' },
  'build.manifest_present': { name: 'Files made by the build', pass: 'The build made files', fail: 'The build made no files' },
  'build.output_hashed': { name: 'Saving the build files', pass: 'All the files from the build were saved', fail: 'Some files from the build were not saved' },
  'blob.integrity': { name: 'The saved files', pass: 'The saved files are not damaged', fail: 'A saved file has changed or is missing' },
  'app.manifest_schema': { name: 'The app’s settings file', pass: 'The app’s settings file is valid', fail: 'The app’s settings file is not valid' },
  'app.preview_health': { name: 'Trying your app', pass: 'Your app answered when Nexus tried it', fail: 'Your app did not answer when Nexus tried it' },
  'diag.schema': { name: 'The report’s sources', pass: 'Every fact in the report says where it came from', fail: 'A fact in the report does not say where it came from' },
  'sde.deps.lock_matches': { name: 'The add-ons installed for your project', pass: 'The add-ons installed for your project match its list', fail: 'The add-ons installed for your project do not match its list' },
  // A change the AI helper suggested. The tests of a change are the project's own tests run on it, and no name says "passed".
  'git.diff_nonempty': { name: 'Edits in the suggested changes', pass: 'The suggested changes include real edits', fail: 'The suggested changes are empty' },
  'git.paths_in_scope': { name: 'Files the changes touch', pass: 'The changes only touch files they should', fail: 'The changes touch files they should not' },
  'sec.secret_scan': { name: 'Scan for common kinds of secret keys', pass: 'No secret keys found', fail: 'A secret key may be in the changes' },
  'sec.entropy_notes': { name: 'Text that could be a password (advice only)', pass: 'No random-looking text that could be a password', fail: 'Some random-looking text could be a password (advice only)' },
  'cs.tests_pass': { name: 'Your tests, run on the changes', pass: 'Your tests ran and passed', fail: 'Some of your tests failed' },
  'git.applies_cleanly': { name: 'Fit with your project', pass: 'The changes fit your project without conflicts', fail: 'The changes clash with your project' }
});
const OTHER_CHECK = 'Another check';
const lowerFirst = (t: string): string => (t ? t[0].toLowerCase() + t.slice(1) : t);

/** What a check looks at, in plain words (never its id). */
export const validatorLabel = (id: string): string => (Object.prototype.hasOwnProperty.call(CHECK_WORDS, id) ? CHECK_WORDS[id].name : OTHER_CHECK);

/**
 * One plain line for a check with its result: "Your tests ran and passed", "Some of your tests failed", or, when there is no
 * result to speak of, what could not be said ("Could not check: fit with your project"). Never an id.
 */
export function validatorLine(id: string, status: CheckStatus): string {
  const w = Object.prototype.hasOwnProperty.call(CHECK_WORDS, id) ? CHECK_WORDS[id] : null;
  if (!w) return status === 'failed' ? 'Another check failed' : status === 'passed' ? 'Another check is fine' : OTHER_CHECK;
  switch (status) {
    case 'passed': return w.pass;
    case 'failed': return w.fail;
    case 'error': return `Nexus could not run this check: ${lowerFirst(w.name)}`;
    case 'skipped': return `Skipped: ${lowerFirst(w.name)}`;
    default: return `Not checked yet: ${lowerFirst(w.name)}`;
  }
}

/**
 * A sentence from a record with its reason codes cut out: "1 of 2 executed test(s) failed. (tests_failed)" reads
 * "1 of 2 executed test(s) failed." and `codes` keeps `tests_failed` (for a title attribute, never visible text).
 */
export function plainSentence(text: string | null | undefined): { text: string; codes: string[] } {
  const codes: string[] = [];
  const out = String(text ?? '').replace(/\s*\(([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\)/g, (_m, code: string) => { codes.push(code); return ''; })
    .replace(/\s{2,}/g, ' ').trim();
  return { text: out, codes };
}

/** Short names of the checks an application's headline lists. */
const CHECK_SHORT: Readonly<Record<string, string>> = Object.freeze({ 'app.manifest_schema': 'manifest check', 'app.preview_health': 'preview check' });
const shortName = (id: string): string => CHECK_SHORT[id] ?? validatorLabel(id).replace(/^\w/, (c) => c.toLowerCase());
const listOf = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const cap = (t: string): string => (t ? t[0].toUpperCase() + t.slice(1) : t);

/** A hash as 12 hex characters (`sha256:` kept when present); anything else unchanged. */
export function shortHash(v: string): string {
  const m = /^(sha256:)?([0-9a-f]{12,64})$/i.exec(v);
  return m ? `${(m[1] ?? '').toLowerCase()}${m[2].slice(0, 12).toLowerCase()}` : v;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** One evidence item of the view as a sourced fact; null for an item that carries nothing to show. */
export function factOf(e: ValidationResultView['evidence'][number], _validatorId?: string): EvidenceFact | null {
  const name = e.name ?? '';
  const value = e.value;
  switch (e.type) {
    case 'junit': return value === null ? null : { kind: 'junit', label: 'Test counts', value: str(value), source: 'Reported by the test tool' };
    case 'hash': return value === null ? null : { kind: 'hash', label: name || 'Fingerprint', value: shortHash(str(value)), source: 'Worked out by Nexus' };
    case 'http': return { kind: 'http', label: name ? `Answer from ${name}` : 'Answer from your app', value: value === null ? 'No answer' : `Answered ${str(value)}`, source: 'Asked by Nexus' };
    case 'git': return value === null ? null : { kind: 'git', label: 'Saved version', value: shortHash(str(value)), source: 'Checked by Nexus' };
    case 'exit': return { kind: 'exit', label: 'Result code', value: value === null ? 'None (it was stopped before it finished)' : str(value), source: 'Reported by the safe space' };
    case 'inspect': return value === null ? null : { kind: 'inspect', label: name || 'Safe space detail', value: str(value), source: 'Read from Docker' };
    case 'file': return { kind: 'file', label: name || 'File', value: value === null ? 'Saved' : shortHash(str(value)), source: 'Worked out by Nexus' };
    case 'number': return value === null ? null : { kind: 'number', label: name || 'Count', value: str(value), source: 'Recorded by Nexus' };
    case 'schema': return { kind: 'schema', label: name || 'Format', value: 'Checked', source: 'Checked by Nexus' };
    case 'log': return value === null ? null : { kind: 'log', label: 'Part of the log', value: shortHash(str(value)), source: 'Worked out from the task log' };
    case 'user': return { kind: 'user', label: 'Confirmed by you', value: name || 'Yes', source: 'Your action' };
    default: return value === null ? null : { kind: e.type, label: name || 'Detail', value: str(value), source: 'Recorded by Nexus' };
  }
}

/**
 * The evidence page of one version. The headline reads the BLOCKING rows only (advisory rows are run results, shown
 * as runs). `checked` is false for a kind no check ever gates: it never reads "Checking…". Revalidate is offered only
 * for a draft whose blocking checks could not run.
 */
export function evidenceView(given: readonly ValidationResultView[], version: Pick<VersionView, 'status'> | null, checked = true,
  /**
   * `kind`: the artifact's kind, so every blocking check it has is listed, with "Not run yet" when #32 has no result
   * for it (the headline never says passed while one has none). `deployments` (an application's, of this version; null
   * while unread): a draft never reads "Checking…" while nothing checks it.
   */
  ctx: { kind?: string; deployments?: readonly PreviewDeployment[] | null } = {}): EvidenceView {
  const have = new Set(given.filter((r) => r.blocking).map((r) => r.validatorId));
  const missing: ValidationResultView[] = (checked && ctx.kind ? blockingValidatorsFor(ctx.kind) : []).filter((d) => !have.has(d.id))
    .map((d) => ({ validatorId: d.id, blocking: true, status: null,
      summary: runsOnUserAction(d.id) ? 'This check needs your app to be running: start a preview to run it.' : null,
      finishedAt: null, evidence: [], latestRun: null, history: 0 }));
  const results = [...given, ...missing];
  const rows: EvidenceRow[] = results.map((r) => {
    const plain = plainSentence(r.summary);
    const latest = r.latestRun ? plainSentence(r.latestRun.summary) : null;
    return {
      validatorId: r.validatorId, label: validatorLine(r.validatorId, r.status), word: statusWord(r.status), status: r.status, blocking: r.blocking,
      summary: r.status === 'error' ? `Checks could not run: ${(plain.text || 'no reason was recorded').replace(/\.+$/, '')}.`
        : r.summary === null ? null : plain.text,
      facts: r.evidence.map((e) => factOf(e, r.validatorId)).filter((f): f is EvidenceFact => f !== null),
      latestRun: r.latestRun && latest ? { word: statusWord(r.latestRun.status), summary: latest.text } : null,
      history: r.history,
      codes: [...plain.codes, ...(latest?.codes ?? [])]
    };
  });
  const draft = version?.status === 'draft';
  const blocking = results.filter((r) => r.blocking);
  let headline: ChecksHeadline;
  if (!checked) headline = 'This kind of item has no checks';
  else if (results.length === 0) headline = draft ? 'Checking…' : 'No checks saved yet';
  else if (blocking.length === 0) headline = 'No required checks';
  else if (blocking.some((r) => r.status === 'failed')) headline = 'Checks failed';
  else if (blocking.some((r) => r.status === 'error')) headline = 'Checks could not run';
  else if (blocking.some((r) => r.status === null)) headline = draft ? 'Checking…' : 'Some checks have not run';
  else if (blocking.every((r) => r.status === 'skipped')) headline = 'No checks ran';
  else headline = 'Checks passed';
  const revalidate = checked && draft && blocking.some((r) => r.status === 'error');
  if (ctx.kind === 'application' && ctx.deployments !== undefined && headline === 'Checking…' && version) {
    const validators: Record<string, CheckStatus> = {};
    for (const r of blocking) validators[r.validatorId] = r.status;
    const p = applicationPreview({ status: version.status, validators, deployments: ctx.deployments });
    if (p && p.state === 'not_checked') {
      // What passed and what still waits for a preview, in plain words.
      const passed = blocking.filter((r) => r.status === 'passed').map((r) => shortName(r.validatorId));
      const waiting = blocking.filter((r) => r.status === null).map((r) => shortName(r.validatorId));
      const lead = passed.length ? `${cap(listOf(passed))} passed; ${listOf(waiting)}` : cap(listOf(waiting));
      return { headline: `${lead} not run yet — start a preview`, rows, revalidate };
    }
    // A draft nothing can be said about (its deployments unread) claims no checking either.
    if (p) return { headline: p.state === 'draft' ? 'Some checks have not run' : p.word, rows, revalidate };
  }
  return { headline, rows, revalidate };
}

// ---------- an application's dev deployment check (B2a stabilization) ----------

export type PreviewState = 'draft' | 'not_checked' | 'checking' | 'healthy' | 'failed';
export type PreviewWord = 'Draft' | 'Ready to check — start a preview' | 'Checking: the dev deployment is starting'
  | 'Checking: waiting for the dev deployment to answer' | 'Answered its health check' | 'Failed its health check'
  | 'The health check could not run' | 'Checks failed' | 'The dev deployment failed';
export interface PreviewView { state: PreviewState; word: PreviewWord }
export interface PreviewDeployment { status: 'starting' | 'healthy' | 'unhealthy' | 'stopped' | 'failed'; startedAt: number }

const LIVE_DEPLOYMENT = new Set(['starting', 'healthy', 'unhealthy']);

/**
 * Where an application version's health check stands, from its blocking check results (`validators`, null while
 * unread) and the dev deployments of that version (null while unread). `app.preview_health` runs only on a dev
 * deployment, so a draft with none is "not checked yet", never "Checking…":
 *  - failed: a blocking check failed or could not run, or the version's latest dev deployment failed;
 *  - healthy: `app.preview_health` passed;
 *  - checking: a dev deployment of the version is starting, or live and not yet recorded as answering;
 *  - not_checked: a draft whose manifest passed, with no live dev deployment;
 *  - draft: a draft whose checks or deployments could not be read (no claim either way).
 * Null for a version that left draft with nothing above to add (its own checks word stands).
 */
export function applicationPreview(i: { status: VersionView['status']; validators: Readonly<Record<string, CheckStatus | undefined>> | null;
  deployments: readonly PreviewDeployment[] | null }): PreviewView | null {
  const v = i.validators ?? {};
  const manifest = v['app.manifest_schema'] ?? null;
  const health = v['app.preview_health'] ?? null;
  if (manifest === 'failed') return { state: 'failed', word: 'Checks failed' };
  if (health === 'failed') return { state: 'failed', word: 'Failed its health check' };
  if (health === 'error' || manifest === 'error') return { state: 'failed', word: 'The health check could not run' };
  if (health === 'passed') return { state: 'healthy', word: 'Answered its health check' };
  if (i.deployments) {
    const latest = [...i.deployments].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
    const live = i.deployments.find((d) => LIVE_DEPLOYMENT.has(d.status)) ?? null;
    if (live) return { state: 'checking', word: live.status === 'starting' ? 'Checking: the dev deployment is starting' : 'Checking: waiting for the dev deployment to answer' };
    if (latest && latest.status === 'failed') return { state: 'failed', word: 'The dev deployment failed' };
  }
  if (i.status !== 'draft') return null;
  // The rail's words for the same state (stepState `awaiting_check`).
  if (i.validators && i.deployments && manifest === 'passed') return { state: 'not_checked', word: 'Ready to check — start a preview' };
  return { state: 'draft', word: 'Draft' };
}

/**
 * The checks word of an application version (a Spine node, a version row): for a draft, where its health check
 * stands (applicationPreview); null for a draft nothing can be said about (never "Checking…" with nothing checking);
 * otherwise the version's own checks word.
 */
export function applicationChecksWord(i: { status: VersionView['status']; validationState: VersionView['validationState'] | null | undefined;
  validators: Readonly<Record<string, CheckStatus | undefined>> | null; deployments: readonly PreviewDeployment[] | null }): string | null {
  if (i.status !== 'draft') return checksWord(i.validationState, i.status);
  const p = applicationPreview(i);
  if (!p || p.state === 'draft') return checksWord(i.validationState, i.status) === 'Checking…' ? null : checksWord(i.validationState, i.status);
  return p.word;
}

/** The word a Spine node and a version row show for a version's validation state. */
export function checksWord(state: VersionView['validationState'] | null | undefined, status?: VersionView['status'] | null): string | null {
  // "pending" means "being checked" only for a draft; a version that left draft without a check never reads "Checking…".
  if (state === 'pending' && status && status !== 'draft') return null;
  switch (state) {
    case 'passed': return 'Checks passed';
    case 'failed': return 'Checks failed';
    case 'error': return 'Checks could not run';
    case 'pending': return 'Checking…';
    default: return null;
  }
}

// ---------- log ranges (a diagnostic report's facts point at exact log bytes) ----------

/**
 * A range of an attempt log: open it in the log reader at `offset` for `length` bytes. `attemptId` is the attempt the
 * report names; `attempt` is its number once known (from the job's attempt history, which carries each attempt's id).
 */
export interface LogRange { jobId: string; attemptId: string | null; attempt: number | null; offset: number; length: number; sha256: string; label: string }

/** The attempt number a range points at: its own number, else the attempt in the history whose id the report names. */
export function rangeAttempt(range: Pick<LogRange, 'attempt' | 'attemptId'>, history: readonly { id: string; n: number }[]): number | null {
  if (range.attempt !== null) return range.attempt;
  if (range.attemptId === null) return null;
  return history.find((a) => a.id === range.attemptId)?.n ?? null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const ATTEMPT_ID = /^[0-9A-Za-z_-]{1,64}$/;

/**
 * The log ranges a diagnostic report's fields cite, for the job whose logs they are (`jobId`). Each range keeps the
 * attempt id the report names. `attempts` is either the job's attempt history (`{ id, n }` per attempt, from #27):
 * the range then carries the exact attempt number; or a bare count: the number is known only when the job has
 * exactly one attempt, and otherwise the log reader resolves the id against the job's own history.
 */
export function logRangesOf(report: unknown, jobId: string, attempts: number | readonly { id: string; n: number }[]): LogRange[] {
  if (!isObj(report) || !Array.isArray(report.fields)) return [];
  const seen = new Set<string>();
  const out: LogRange[] = [];
  for (const f of report.fields as unknown[]) {
    if (!isObj(f) || !isObj(f.source) || f.source.type !== 'log') continue;
    const s = f.source;
    if (!nonNegInt(s.offset) || !nonNegInt(s.length) || typeof s.sha256 !== 'string') continue;
    const attemptId = typeof s.attemptId === 'string' && ATTEMPT_ID.test(s.attemptId) ? s.attemptId : null;
    const key = `${attemptId ?? ''}:${s.offset}:${s.length}:${s.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const attempt = Array.isArray(attempts) ? rangeAttempt({ attempt: null, attemptId }, attempts)
      : attempts === 1 ? 1 : null;
    out.push({ jobId, attemptId, attempt, offset: s.offset, length: s.length, sha256: shortHash(s.sha256),
      label: `Part of the task log (bytes ${s.offset} to ${s.offset + s.length})` });
  }
  return out;
}

/** The note a report larger than one page shows until it is read whole: its facts are not shown from part of it. */
export function partialReportNote(readBytes: number, totalBytes: number | null): string {
  return typeof totalBytes === 'number' && totalBytes > 0
    ? `This report is too long for one page: ${readBytes} of ${totalBytes} bytes loaded so far. Its facts show once all of it is loaded.`
    : 'This report is too long for one page. Its facts show once all of it is loaded.';
}

/** An object or array value as short JSON text (never "[object Object]"). */
function jsonText(v: unknown): string {
  let t: string;
  try { t = JSON.stringify(v) ?? ''; } catch { t = ''; }
  if (!t) return 'Not readable';
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

/** A diagnostic report's facts with their sources, for the report viewer. */
export function reportFacts(report: unknown): { name: string; value: string; source: string }[] {
  if (!isObj(report) || !Array.isArray(report.fields)) return [];
  const out: { name: string; value: string; source: string }[] = [];
  for (const f of report.fields as unknown[]) {
    if (!isObj(f) || typeof f.name !== 'string') continue;
    const v = f.value;
    const value = v === null || v === undefined ? 'Not seen'
      : isObj(v) && typeof v.sha256 === 'string' ? shortHash(v.sha256)
      : typeof v === 'object' ? jsonText(v) : String(v);
    const s = isObj(f.source) ? f.source : {};
    const source = s.type === 'inspect' ? `read from Docker ${typeof s.field === 'string' ? s.field : ''}`.trim()
      : s.type === 'http' ? `answer from your app ${typeof s.path === 'string' ? s.path : ''}`.trim()
      : s.type === 'log' ? 'part of the task log'
      : s.type === 'unobserved' ? 'not seen' : 'unknown source';
    out.push({ name: f.name, value, source });
  }
  return out;
}
