import { useCallback, useEffect, useRef, useState } from 'react';
import type { TryOptionView } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { execFailText } from '../data/errorCopy';
import { useExecStore, useHealth, useJob, withIntent } from '../data/useExecution';
import { Button } from '../ui/Button';
import { useExecutionUi } from './execContext';
import {
  TRY_INTRO, TRY_MAX_LINES, TRY_NO_BUTTONS, TRY_NO_COMMIT, TRY_NO_OUTPUT, TRY_OWN_EXAMPLE, TRY_OWN_HINT, TRY_OWN_SUMMARY, tryOutput, tryView
} from './tryModel';

/** While a run is live its job and its output are read again this often (the output is the job's own log, read through the log reader). */
const LIVE_REFRESH_MS = 1_500;
const PAGE_BYTES = 64 * 1024;

/** The last try run of each suggested change, kept while the page is open (so leaving and coming back still shows what happened). */
const lastRun = new Map<string, string>();

/**
 * "Try it": run the suggested changes in the safe space and see what they print, before anything touches your files. "Run the tests" and
 * "Run the program" are the buttons Nexus found in the change; "Try your own command" is one text box. Nothing runs by itself: the press is
 * the OK. The run is the ordinary sandbox job (no internet, the same limits as a test run); Stop ends it; every way it can end has its words.
 */
export function TryIt({ projectId, versionId = null, heading = true }: { projectId: string; /** A suggested change; null or none: the project as it stands. */ versionId?: string | null; heading?: boolean }) {
  const target = versionId ?? `project:${projectId}`;
  const ui = useExecutionUi();
  const { availability } = useHealth();
  const [options, setOptions] = useState<TryOptionView[] | null>(null);
  const [noCommit, setNoCommit] = useState(false);
  const [jobId, setJobId] = useState<string | null>(() => lastRun.get(target) ?? null);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const nonce = useRef(0);

  // The buttons Nexus found in this change (read once per change; main reads them from the change's own files).
  useEffect(() => {
    let alive = true;
    setOptions(null); setNoCommit(false);
    void nexusClient.tryRun({ op: 'options', projectId, ...(versionId ? { versionId } : {}) }).then((r) => {
      if (!alive) return;
      setOptions(r.ok && 'options' in r.data ? r.data.options : []);
      setNoCommit(r.ok && 'options' in r.data && r.data.noCommit === true);
    });
    return () => { alive = false; };
  }, [projectId, versionId]);
  useEffect(() => { setJobId(lastRun.get(target) ?? null); setError(null); }, [target]);

  const job = useJob(jobId);
  const detail = job.data ?? null;
  const exitCode = detail && detail.attemptHistory.length > 0 ? detail.attemptHistory[detail.attemptHistory.length - 1].exitCode : null;
  const ready = availability.kind === 'ready';
  const view = tryView({ job: detail, exitCode, setup: !ready, now });
  const attemptN = detail && detail.attemptHistory.length > 0 ? detail.attemptHistory[detail.attemptHistory.length - 1].n : null;

  // The output: the job's log, read from the start and on from where it ended, while the run is live and once more after it ends.
  const [out, setOut] = useState<{ text: string; next: number; eof: boolean; cut: boolean }>({ text: '', next: 0, eof: false, cut: false });
  const reading = useRef(false);
  const outKey = useRef<string | null>(null);
  const readMore = useCallback(async () => {
    if (!jobId || attemptN === null || reading.current) return;
    reading.current = true;
    try {
      const key = `${jobId}:${attemptN}`;
      if (outKey.current !== key) { outKey.current = key; outRef.current = { text: '', next: 0, eof: false, cut: false }; setOut(outRef.current); }
      let from = outRef.current.next;
      for (let n = 0; n < 8; n++) {
        const r = await nexusClient.jobLogs(jobId, { attempt: attemptN, fromOffset: from, maxBytes: PAGE_BYTES });
        if (!r.ok) break;
        from = r.data.nextOffset;
        const page = r.data;
        outRef.current = { text: outRef.current.text + page.text, next: page.nextOffset, eof: page.eof, cut: outRef.current.cut || page.truncatedMiddle };
        setOut(outRef.current);
        if (page.eof) break;
      }
    } finally { reading.current = false; }
  }, [jobId, attemptN]);
  const outRef = useRef(out);
  useEffect(() => { outRef.current = out; }, [out]);
  useEffect(() => { outRef.current = { text: '', next: 0, eof: false, cut: false }; outKey.current = null; setOut(outRef.current); }, [jobId]);

  useEffect(() => {
    if (!jobId) return undefined;
    void readMore();
    if (!view.live) return undefined;
    const t = setInterval(() => { setNow(Date.now()); useExecStore.getState().bump(['jobs']); void readMore(); }, LIVE_REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, attemptN, view.live]);
  // Once the run has ended, one more read gets the last of the output.
  const endedOnce = useRef<string | null>(null);
  useEffect(() => {
    if (view.ended && jobId && endedOnce.current !== jobId) { endedOnce.current = jobId; void readMore(); }
    if (!view.ended && endedOnce.current === jobId) endedOnce.current = null;
  }, [view.ended, jobId, readMore]);

  const run = async (what: 'tests' | 'program' | 'custom') => {
    if (busy || view.live) return;
    if (what === 'custom' && command.trim() === '') return;
    setBusy(true); setError(null);
    nonce.current += 1;
    const r = await withIntent(`try:${target}:${what}:${nonce.current}:${Date.now()}`, (intentId) => nexusClient.tryRun({
      op: 'run', projectId, ...(versionId ? { versionId } : {}), what, ...(what === 'custom' ? { command: command.trim() } : {}), intentId
    }));
    setBusy(false);
    if (!r.ok) { setError(execFailText(r)); return; }
    if ('job' in r.data) { lastRun.set(target, r.data.job.id); setJobId(r.data.job.id); setNow(Date.now()); }
  };
  const stop = async () => {
    if (!jobId || !view.canStop) return;
    const r = await nexusClient.jobCancel(jobId);
    if (!r.ok) setError(execFailText(r));
    useExecStore.getState().bump(['jobs']);
  };

  const shown = tryOutput(out.text);
  const lines = shown.lines.length > TRY_MAX_LINES ? shown.lines.slice(-TRY_MAX_LINES) : shown.lines;
  const cutTop = shown.lines.length > TRY_MAX_LINES;
  const disabled = busy || view.live || !ready || noCommit;
  return (
    <div className="nx-try" data-state={view.state}>
      {heading && <h3 className="nx-cs__sub">Try it</h3>}
      <p className="nx-muted">{TRY_INTRO}</p>
      {noCommit && <p className="nx-try__setup" role="status">{TRY_NO_COMMIT}</p>}
      {!ready && detail === null && (
        <p className="nx-try__setup" role="status">
          {view.headline}{' '}
          {ui && <Button variant="quiet" onClick={() => ui.openSetup()}>Get this computer ready</Button>}
        </p>
      )}
      <div className="nx-try__buttons">
        {options === null && <span className="nx-muted" role="status">Looking at the changes…</span>}
        {options !== null && options.map((o) => (
          <span key={o.what} className="nx-try__opt">
            <Button variant="secondary" disabled={disabled} onClick={() => { void run(o.what); }}>{o.label}</Button>
            <span className="nx-try__shows">{o.shows}</span>
          </span>
        ))}
        {options !== null && options.length === 0 && !noCommit && <span className="nx-muted">{TRY_NO_BUTTONS}</span>}
      </div>
      <details className="nx-try__own">
        <summary>{TRY_OWN_SUMMARY}</summary>
        <form onSubmit={(e) => { e.preventDefault(); void run('custom'); }}>
          <label className="nx-visually-hidden" htmlFor={`nx-try-cmd-${target}`}>Your command</label>
          <input id={`nx-try-cmd-${target}`} className="nx-try__cmd" type="text" value={command} maxLength={1000} spellCheck={false} autoComplete="off"
            placeholder={TRY_OWN_EXAMPLE} onChange={(e) => setCommand(e.target.value)} />
          <Button variant="secondary" type="submit" disabled={disabled || command.trim() === ''}>Run it</Button>
        </form>
        <p className="nx-muted">{TRY_OWN_HINT}</p>
      </details>
      {error && <p className="nx-passport__note" role="alert">{error}</p>}
      {detail !== null && (
        <div className="nx-try__result">
          <p className="nx-try__status" role="status" data-state={view.state}>
            <span className="nx-try__dot" aria-hidden="true" />
            <span>{view.headline}</span>
            {view.canStop && <Button variant="quiet" onClick={() => { void stop(); }}>Stop</Button>}
          </p>
          {view.detail && <p className="nx-muted">{view.detail}</p>}
          {view.state === 'setup' && ui && <Button variant="quiet" onClick={() => ui.openSetup()}>Get this computer ready</Button>}
          {view.state === 'could_not_run' && ui && <Button variant="quiet" onClick={() => ui.openSetup()}>Get this computer ready</Button>}
          {(lines.length > 0 || view.ended) && (
            <pre className="nx-try__out" tabIndex={0} aria-label="What it printed">
              {cutTop && <span className="nx-try__cut">Only the last {TRY_MAX_LINES} lines are shown.{'\n'}</span>}
              {lines.length === 0 ? <span className="nx-muted">{TRY_NO_OUTPUT}</span> : lines.map((l) => (
                <span key={l.key} className="nx-try__line" data-stream={l.stream}>
                  {l.stream === 'stderr' && <span className="nx-visually-hidden">Error: </span>}{l.text}{'\n'}
                </span>
              ))}
            </pre>
          )}
          {out.cut && <p className="nx-muted">The middle of the output was left out because it was very long.</p>}
        </div>
      )}
    </div>
  );
}
