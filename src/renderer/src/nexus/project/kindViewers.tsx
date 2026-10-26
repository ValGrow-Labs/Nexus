import { useEffect, useRef, useState } from 'react';
import type { PreviewPart, PreviewView, VersionView } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { errorCopy } from '../data/errorCopy';
import { useExecStore } from '../data/useExecution';
import { Button } from '../ui/Button';
import { useExecutionUi } from './execContext';
import { logRangesOf, partialReportNote, reportFacts } from './evidenceModel';
import { ChangeSetReview } from './ChangeSetReview';

const PAGE_BYTES = 64 * 1024;

/** One preview part (#34), paged: rows by their cursor (fromRow / nextRow), text by page. */
function usePreview(versionId: string, part: PreviewPart): { pages: PreviewView[]; error: string | null; more: (() => void) | null; loaded: boolean } {
  const [pages, setPages] = useState<PreviewView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const tick = useExecStore((s) => s.ticks.validations);
  const read = async (from: PreviewView | null, alive: () => boolean) => {
    const q = part === 'content' || part === 'diff' ? { part, page: from?.nextPage ?? 0, maxBytes: PAGE_BYTES } : { part, fromRow: from?.nextRow ?? 0, maxBytes: PAGE_BYTES };
    const r = await nexusClient.versionPreview(versionId, q);
    if (!alive()) return;
    setLoaded(true);
    if (!r.ok) {
      const c = errorCopy(r.code, r.reason, r.subReason);
      // Execution off (the notice says so) or a part this version does not have (`invalid`): nothing to show.
      setError(c.kind === 'execution_unavailable' || c.kind === 'unavailable' || r.code === 'invalid' ? null : c.text);
      return;
    }
    setError(null);
    setPages((p) => (from ? [...p, r.data] : [r.data]));
  };
  useEffect(() => {
    let alive = true;
    setPages([]); setLoaded(false);
    void read(null, () => alive);
    return () => { alive = false; };
  }, [versionId, part]);
  // New check results (a validations tick) refresh the first page in place; pages already loaded further are kept.
  const pageCount = useRef(0);
  pageCount.current = pages.length;
  const firstTick = useRef(tick);
  useEffect(() => {
    if (tick === firstTick.current || pageCount.current > 1) return;
    let alive = true;
    void read(null, () => alive);
    return () => { alive = false; };
  }, [tick]);
  const last = pages[pages.length - 1] ?? null;
  const hasMore = last !== null && (part === 'content' || part === 'diff' ? last.nextPage !== null : last.nextRow !== null);
  return { pages, error, loaded, more: hasMore ? () => { void read(last, () => true); } : null };
}

function Rows({ versionId, part, title, empty }: { versionId: string; part: PreviewPart; title: string; empty: string }) {
  const p = usePreview(versionId, part);
  const rows = p.pages.flatMap((x) => x.rows ?? []);
  const total = p.pages[0]?.totalRows ?? null;
  if (!p.loaded) return null;
  if (p.error) return <section><h2>{title}</h2><p className="nx-muted">{p.error}</p></section>;
  if (p.pages.length === 0) return null;
  return (
    <section>
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="nx-muted">{empty}</p> : (
        <ul className="nx-xv__rows">
          {rows.map((r, i) => (
            <li key={`${r.name}:${i}`}>
              <span className="nx-xv__name">{r.name}</span>
              {r.outcome && <span className="nx-xv__word">{r.outcome}</span>}
              {r.detail && <span className="nx-muted">{r.detail}</span>}
              {r.bytes !== null && <span className="nx-muted">{r.bytes} bytes</span>}
            </li>
          ))}
        </ul>
      )}
      {total !== null && <p className="nx-muted">{rows.length} of {total} shown.</p>}
      {p.more && <Button variant="quiet" onClick={p.more}>Load more</Button>}
    </section>
  );
}

/** The version's content as text (#34 content), parsed as JSON where the kind is structured. The JSON is parsed only
 *  once every page is read (`more` is null); `readBytes` / `totalBytes` say how much of it is read so far. */
function useContent(versionId: string): { text: string | null; json: unknown; error: string | null; loaded: boolean;
  more: (() => void) | null; readBytes: number; totalBytes: number | null } {
  const p = usePreview(versionId, 'content');
  const text = p.pages.length ? p.pages.map((x) => x.text ?? '').join('') : null;
  let json: unknown = null;
  if (text !== null && p.more === null) { try { json = JSON.parse(text) as unknown; } catch { json = null; } }
  const readBytes = text === null ? 0 : new TextEncoder().encode(text).length;
  const totalBytes = p.pages[0]?.totalBytes ?? null;
  return { text, json, error: p.error, loaded: p.loaded, more: p.more, readBytes, totalBytes };
}


const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function Structured({ version, kind }: { version: VersionView; kind: 'requirement' | 'problem_statement' }) {
  const c = useContent(version.id);
  if (!c.loaded || c.error) return c.error ? <section><h2>Content</h2><p className="nx-muted">{c.error}</p></section> : null;
  const j = isObj(c.json) ? c.json : null;
  if (!j) return c.text ? <section><h2>Content</h2><pre className="nx-xv__text">{c.text}</pre></section> : null;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  if (kind === 'requirement') {
    const criteria = Array.isArray(j.criteria) ? j.criteria.filter(isObj) : [];
    return (
      <section>
        <h2>Requirement</h2>
        {typeof j.title === 'string' && <p className="nx-xv__title">{j.title}</p>}
        {typeof j.body === 'string' && <p className="nx-xv__body">{j.body}</p>}
        <h2>Acceptance criteria</h2>
        <ol className="nx-xv__rows">{criteria.map((x, i) => <li key={String(x.id ?? i)}><span className="nx-id">{String(x.id ?? '')}</span> <span>{String(x.text ?? '')}</span></li>)}</ol>
      </section>
    );
  }
  return (
    <section>
      <h2>Question</h2>
      {typeof j.question === 'string' && <p className="nx-xv__title">{j.question}</p>}
      {typeof j.context === 'string' && <p className="nx-xv__body">{j.context}</p>}
      {typeof j.audience === 'string' && <p className="nx-muted">For: {j.audience}</p>}
      {list(j.successCriteria).length > 0 && <><h2>Success criteria</h2><ul className="nx-xv__rows">{list(j.successCriteria).map((x, i) => <li key={`${i}:${x}`}>{x}</li>)}</ul></>}
      {list(j.constraints).length > 0 && <><h2>Constraints</h2><ul className="nx-xv__rows">{list(j.constraints).map((x, i) => <li key={`${i}:${x}`}>{x}</li>)}</ul></>}
    </section>
  );
}

function DiagnosticReport({ version }: { version: VersionView }) {
  const c = useContent(version.id);
  const ui = useExecutionUi();
  if (!c.loaded) return null;
  if (c.error) return <section><h2>Report</h2><p className="nx-muted">{c.error}</p></section>;
  // A report past one page cannot be parsed from its first part: say so and offer the rest, never "no fact".
  if (c.more) {
    return (
      <section>
        <h2>Report</h2>
        <p className="nx-muted">{partialReportNote(c.readBytes, c.totalBytes)}</p>
        <Button variant="quiet" onClick={c.more}>Load more</Button>
      </section>
    );
  }
  const facts = reportFacts(c.json);
  const subject = isObj(c.json) && isObj(c.json.subject) ? c.json.subject : null;
  const jobId = subject && subject.target === 'job' && typeof subject.id === 'string' ? subject.id : null;
  // Each range keeps the attempt id the report names; the log reader opens exactly that attempt (#27's history carries ids).
  const ranges = jobId ? logRangesOf(c.json, jobId, []) : [];
  return (
    <section>
      <h2>Report</h2>
      {facts.length === 0 ? <p className="nx-muted">The report holds no fact.</p> : (
        <dl className="nx-xe__facts">{facts.map((f, i) => <div key={`${f.name}:${i}`}><dt>{f.name}</dt><dd>{f.value} <span className="nx-muted">({f.source})</span></dd></div>)}</dl>
      )}
      {ui && ranges.length > 0 && (
        <ul className="nx-xv__rows" aria-label="Log ranges">
          {ranges.map((r) => <li key={`${r.offset}:${r.length}`}><Button variant="quiet" onClick={() => ui.openLog({ jobId: r.jobId, range: r })}>{r.label}</Button></li>)}
        </ul>
      )}
    </section>
  );
}

function Repository({ version }: { version: VersionView }) {
  const c = useContent(version.id);
  if (!c.loaded || !c.text) return null;
  return <section><h2>Snapshot</h2><pre className="nx-xv__text">{c.text}</pre></section>;
}

/** What a version holds, by kind: a change made by the agent (diff and decisions), a test suite's discovered tests and JUnit table (failures first), a build's
 *  manifest, an application's manifest, a diagnostic report's sourced facts, a requirement or a problem statement,
 *  a repository snapshot. Other kinds keep the Passport's own content line. */
export function KindViewer({ kind, version }: { kind: string; version: VersionView }) {
  switch (kind) {
    case 'test_suite': return <><Rows versionId={version.id} part="junit_summary" title="Test results" empty="No test result is recorded yet." />
      <Rows versionId={version.id} part="discovery" title="Discovered tests" empty="No test was discovered." /></>;
    case 'build': return <Rows versionId={version.id} part="manifest" title="Build output" empty="The build recorded no file." />;
    case 'application': return <Rows versionId={version.id} part="manifest" title="Application manifest" empty="The manifest lists nothing." />;
    case 'diagnostic_report': return <DiagnosticReport version={version} />;
    case 'requirement': case 'problem_statement': return <Structured version={version} kind={kind} />;
    case 'repository': return <Repository version={version} />;
    // B2b: a change made by the agent: the read-only diff, your decision, Accept and Merge (its checks are the Folio's evidence section).
    case 'change_set': return <ChangeSetReview key={version.id} versionId={version.id} projectId={version.projectId} status={version.status} />;
    default: return null;
  }
}
