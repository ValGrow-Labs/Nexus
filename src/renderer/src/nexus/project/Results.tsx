import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResultContentView, ResultsView } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { useExecStore, useHints } from '../data/useExecution';
import { Button } from '../ui/Button';
import {
  CHARTS_TITLE, CLEAR_CONFIRM, EMPTY_LINE, FILES_TITLE, MODEL_NOTE, OVER_LIMIT_LINE, REMOVE_ALL_LABEL, REMOVE_LABEL, REPORT_TITLE, RESULTS_TITLE, SAVE_LABEL,
  STAYS_LINE, TRUNCATED_LINE, clearedLine, moreLine, newestReport, removedLine, reportBlocks, resultRows, resultsFailureText, savedLine, shownCharts, skippedLine,
  type ReportBlock, type Span
} from './resultsModel';

/** Spans as React text: bold as <b>, everything else as the letters it is (never HTML). */
function Text({ spans }: { spans: Span[] }) {
  return <>{spans.map((s, i) => (s.bold ? <b key={i}>{s.text}</b> : <span key={i}>{s.text}</span>))}</>;
}

/** The report as plain blocks, each a React element with text children only. */
export function Report({ blocks }: { blocks: ReportBlock[] }) {
  return (
    <div className="nx-results__report">
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const H = b.level === 1 ? 'h3' : b.level === 2 ? 'h4' : 'h5';
          return <H key={i} className={`nx-results__h nx-results__h--${b.level}`}><Text spans={b.spans} /></H>;
        }
        if (b.type === 'list') {
          const L = b.ordered ? 'ol' : 'ul';
          return <L key={i} className="nx-results__ul">{b.items.map((it, j) => <li key={j}><Text spans={it} /></li>)}</L>;
        }
        if (b.type === 'pre') return <pre key={i} className="nx-results__pre">{b.text}</pre>;
        return <p key={i} className="nx-results__p"><Text spans={b.spans} /></p>;
      })}
    </div>
  );
}

/**
 * "Results" (a Machine learning project's work area, after "Your data"): the newest report, the charts, and every file with Save and
 * Remove. Nothing at all for any other project (main answers `applies: false`, by the same rule the safe space uses) or while it cannot be
 * read. It is read again whenever a job changes (an AI helper turn or a run finishing). The renderer never sends or receives a location:
 * Save only asks main to open its own Save window. The report is text: it is never rendered as HTML.
 */
export function Results({ projectId }: { projectId: string }) {
  useHints();
  const jobsTick = useExecStore((s) => s.ticks.jobs);
  const [view, setView] = useState<ResultsView | null>(null);
  const [report, setReport] = useState<{ key: string; content: Extract<ResultContentView, { kind: 'report' }> } | null>(null);
  const [charts, setCharts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => { setView(null); setReport(null); setCharts({}); setNote(null); setConfirmClear(false); }, [projectId]);
  useEffect(() => {
    void nexusClient.results({ op: 'list', projectId }).then((r) => { if (alive.current && r.ok) setView(r.data); });
  }, [projectId, jobsTick]);

  // The newest report and the charts, read when the listing names new ones (a result is keyed by its id and when it was written).
  const reportItem = view ? newestReport(view) : null;
  const reportKey = reportItem ? `${reportItem.id}:${reportItem.modifiedAt}` : null;
  useEffect(() => {
    if (!reportItem || !reportKey || report?.key === reportKey) return;
    void nexusClient.results({ op: 'read', projectId, resultId: reportItem.id }).then((r) => {
      if (alive.current && r.ok && r.data.content?.kind === 'report') setReport({ key: reportKey, content: r.data.content });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, reportKey]);
  const chartItems = view ? shownCharts(view) : [];
  const chartKeys = chartItems.map((c) => `${c.id}:${c.modifiedAt}`).join(',');
  useEffect(() => {
    for (const c of chartItems) {
      const key = `${c.id}:${c.modifiedAt}`;
      if (charts[key]) continue;
      void nexusClient.results({ op: 'read', projectId, resultId: c.id }).then((r) => {
        if (alive.current && r.ok && r.data.content?.kind === 'chart' && r.data.content.dataUrl.startsWith('data:image/png;base64,')) {
          const url = r.data.content.dataUrl;
          setCharts((prev) => ({ ...prev, [key]: url }));
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, chartKeys]);

  const act = useCallback(async (key: string, run: () => ReturnType<typeof nexusClient.results>, done: (v: ResultsView) => string | null) => {
    if (busy) return;
    setBusy(key); setNote(null);
    const r = await run();
    if (!alive.current) return;
    setBusy(null);
    if (!r.ok) { setNote({ text: resultsFailureText(r), alert: true }); return; }
    setView(r.data);
    const line = done(r.data);
    if (line) setNote({ text: line, alert: false });
  }, [busy]);

  if (!view || !view.applies) return null;
  const rows = resultRows(view, Date.now());
  const shownReport = report && reportItem && report.key === reportKey ? report.content : null;

  return (
    <section className="nx-results" aria-labelledby="nx-results-title">
      <div className="nx-results__head">
        <h2 id="nx-results-title" className="nx-results__title">{RESULTS_TITLE}</h2>
        {rows.length > 0 && !confirmClear && <Button variant="quiet" disabled={busy !== null} onClick={() => setConfirmClear(true)}>{REMOVE_ALL_LABEL}</Button>}
      </div>
      {confirmClear && (
        <div className="nx-xq__confirm" role="alertdialog" aria-label={CLEAR_CONFIRM}>
          <p>{CLEAR_CONFIRM}</p>
          <div className="nx-results__actions">
            <Button disabled={busy !== null} onClick={() => { setConfirmClear(false); void act('clear', () => nexusClient.results({ op: 'clear', projectId }), (v) => clearedLine(v.cleared ?? 0)); }}>{REMOVE_ALL_LABEL}</Button>
            <Button variant="quiet" onClick={() => setConfirmClear(false)}>Keep them</Button>
          </div>
        </div>
      )}
      {view.overLimit && <p className="nx-passport__note" role="alert">{OVER_LIMIT_LINE}</p>}
      {rows.length === 0
        ? <p className="nx-results__empty">{EMPTY_LINE}</p>
        : (
          <>
            {shownReport && (
              <article className="nx-results__reportbox" aria-label={`${REPORT_TITLE}: ${reportItem!.name}`}>
                <h3 className="nx-results__sub">{REPORT_TITLE} <span className="nx-muted">{reportItem!.name}</span></h3>
                <Report blocks={reportBlocks(shownReport.text)} />
                {shownReport.truncated && <p className="nx-muted nx-results__p">{TRUNCATED_LINE}</p>}
              </article>
            )}
            {chartItems.length > 0 && (
              <div>
                <h3 className="nx-results__sub">{CHARTS_TITLE}</h3>
                <div className="nx-results__charts">
                  {chartItems.map((c) => {
                    const url = charts[`${c.id}:${c.modifiedAt}`];
                    return (
                      <figure key={c.id} className="nx-results__chart">
                        {url ? <img src={url} alt={`Chart: ${c.name}`} /> : <div className="nx-results__chartwait" aria-hidden="true" />}
                        <figcaption className="nx-muted">{c.name}</figcaption>
                      </figure>
                    );
                  })}
                </div>
              </div>
            )}
            <div>
              <h3 className="nx-results__sub">{FILES_TITLE}</h3>
              <ul className="nx-data__list" aria-label="Result files">
                {rows.map((d) => (
                  <li key={d.id} className="nx-data__row">
                    <div className="nx-data__text">
                      <b className="nx-data__name">{d.name}</b>
                      <span className="nx-data__facts">{d.facts}</span>
                      <span className="nx-muted nx-data__added">{d.made}</span>
                      {d.isModel && <span className="nx-muted nx-results__model">{MODEL_NOTE}</span>}
                      {d.note && <span className="nx-muted">{d.note}</span>}
                    </div>
                    <div className="nx-results__actions">
                      <Button disabled={busy !== null || !d.canSave} ariaLabel={d.saveLabel}
                        onClick={() => { void act(`save:${d.id}`, () => nexusClient.results({ op: 'save', projectId, resultId: d.id }), (v) => (v.saved ? savedLine(d.name) : null)); }}>
                        {busy === `save:${d.id}` ? 'Saving…' : SAVE_LABEL}
                      </Button>
                      <Button variant="quiet" disabled={busy !== null} ariaLabel={d.removeLabel}
                        onClick={() => { void act(`remove:${d.id}`, () => nexusClient.results({ op: 'remove', projectId, resultId: d.id }), () => removedLine(d.name)); }}>
                        {busy === `remove:${d.id}` ? 'Removing…' : REMOVE_LABEL}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {view.more > 0 && <p className="nx-muted nx-results__p">{moreLine(view.more)}</p>}
            </div>
          </>
        )}
      {view.skipped > 0 && <p className="nx-muted nx-results__p">{skippedLine(view.skipped)}</p>}
      {note && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
      <p className="nx-muted nx-results__note">{STAYS_LINE}</p>
    </section>
  );
}
