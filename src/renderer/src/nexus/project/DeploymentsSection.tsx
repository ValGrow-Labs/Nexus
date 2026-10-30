import { useState } from 'react';
import { nexusClient, openLoopbackUrl } from '../data/nexusClient';
import { errorCopy, execFailText } from '../data/errorCopy';
import { useActions, useDeployments, useExecStore, withIntent } from '../data/useExecution';
import { Button } from '../ui/Button';
import { deploymentRow } from './actionModel';
import { useExecutionUi } from './execContext';

/** In an application's Folio: its test runs with their status words, the address on this computer while it answers,
 *  the last check, Stop, and Diagnose when it is offered. Nothing while running tasks is off. */
export function DeploymentsSection({ projectId, workspaceId, versionIds }: { projectId: string; workspaceId: string; versionIds: readonly string[] }) {
  const list = useDeployments(projectId);
  const actions = useActions(projectId, workspaceId, null);
  const ui = useExecutionUi();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  if (list.fail) {
    const c = errorCopy(list.fail.code, list.fail.reason, list.fail.subReason);
    if (c.kind !== 'busy' && c.kind !== 'internal') return null; // execution off: the notice says why
    return (
      <section aria-label="Test runs of your app">
        <h2>Test runs of your app</h2>
        <p className="nx-muted nx-xa__line" role="status"><span>Nexus could not load the test runs. {c.text}</span> <Button variant="quiet" onClick={list.reload}>Try again</Button></p>
      </section>
    );
  }
  if (!list.data) return null;
  const open = async (url: string) => {
    const r = await openLoopbackUrl(url);
    if (!r.ok) setNote({ text: `Nexus could not open the address in your browser. Open ${url} yourself.`, alert: true });
  };
  const mine = list.data.filter((d) => versionIds.includes(d.subjectVersionId)).sort((a, b) => b.startedAt - a.startedAt).slice(0, 10);
  const canDiagnose = !!actions.data?.some((a) => a.actionId === 'sde.diagnose' && a.available);
  const run = async (key: string, send: () => Promise<{ ok: boolean; code?: string; reason?: string; subReason?: string }>, done: string) => {
    if (busy) return;
    setBusy(key); setNote(null);
    const r = await send();
    useExecStore.getState().bump(['deployments', 'jobs']);
    setBusy(null);
    setNote(r.ok ? { text: done, alert: false } : { text: execFailText({ code: r.code ?? 'internal', reason: r.reason, subReason: r.subReason }), alert: true });
  };
  return (
    <section aria-label="Test runs of your app">
      <h2>Test runs of your app</h2>
      {mine.length === 0 ? <p className="nx-muted">No test run of this app yet.</p> : (
        <ul className="nx-xd__list">
          {mine.map((d) => {
            const v = deploymentRow(d);
            return (
              <li key={d.id} className="nx-xd__row">
                <p className="nx-xq__head"><span className="nx-xq__word">{v.word}</span>
                  {v.url && <button type="button" className="nx-apx__handoff" onClick={() => { void open(v.url!); }}>{v.url}</button>}</p>
                <dl className="nx-xq__facts">{v.facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
                <div className="nx-xq__acts">
                  {v.canStop && <Button disabled={busy !== null} onClick={() => { void run(`stop:${d.id}`, () => nexusClient.deploymentStop(d.id), 'Stopping the test run.'); }}>{busy === `stop:${d.id}` ? 'Stopping…' : 'Stop'}</Button>}
                  {canDiagnose && ui && (
                    <Button disabled={busy !== null} onClick={() => { void run(`diag:${d.id}`, () => withIntent(`diagnose:${d.id}`, (intentId) => nexusClient.jobStart({
                      projectId, workspaceId, actionId: 'sde.diagnose', inputs: [], params: { target: 'deployment', targetId: d.id }, intentId })), 'Diagnosis started. Follow it in Runs.'); }}>
                      {busy === `diag:${d.id}` ? 'Starting…' : 'Diagnose'}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {note && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
    </section>
  );
}
