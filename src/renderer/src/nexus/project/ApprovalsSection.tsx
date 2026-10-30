import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ApprovalView } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { execFailText } from '../data/errorCopy';
import { useApprovals, useExecStore } from '../data/useExecution';
import { Button } from '../ui/Button';
import { approvalRow } from './actionModel';

/** Approval rows: what is asked in plain words, what it reaches or downloads, when it expires, and only "Allow once" or
 *  "Do not allow". Allowing asks once more inline. The exact fingerprints and the sentence as Nexus recorded it sit behind "More details". */
export function ApprovalList({ approvals, label }: { approvals: ApprovalView[]; label: string }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; alert: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Focus moves into the confirmation (onto Cancel, never the approving button) and back to the row's
  // "Allow once" when it closes without an answer, as the Passport's confirmations do.
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const approveRefs = useRef(new Map<string, HTMLButtonElement>());
  const [returnTo, setReturnTo] = useState<string | null>(null);
  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);
  useEffect(() => { if (returnTo && !confirming) { approveRefs.current.get(returnTo)?.focus(); setReturnTo(null); } }, [returnTo, confirming]);
  const cancelConfirm = (id: string) => { if (pending) return; setConfirming(null); setReturnTo(id); };
  const onConfirmKey = (id: string) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelConfirm(id); }
  };
  const now = Date.now();
  const answer = async (id: string, decision: 'once' | 'deny') => {
    if (pending) return;
    setPending(id);
    const r = await nexusClient.approvalRespond(id, decision);
    useExecStore.getState().bump(['approvals', 'jobs', 'health']);
    if (!alive.current) return;
    setPending(null); setConfirming(null);
    setNote(r.ok ? { id, text: decision === 'once' ? 'Allowed once.' : 'Not allowed.', alert: false }
      : { id, text: execFailText(r), alert: true });
  };
  return (
    <ul className="nx-xq__list" aria-label={label}>
      {approvals.map((a) => {
        const v = approvalRow(a, now);
        return (
          <li key={a.id} className="nx-xq__row">
            <p className="nx-xq__head"><b>{v.title}</b> <span className="nx-xq__word">{v.word}</span></p>
            <p className="nx-xq__text">{v.summary}</p>
            {v.facts.length > 0 && (
              <dl className="nx-xq__facts">{v.facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
            )}
            <p className="nx-muted nx-xq__meta">{v.expires}</p>
            <details className="nx-xq__more">
              <summary>More details</summary>
              {v.details.length > 0 && <dl className="nx-xq__facts">{v.details.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>}
              <p className="nx-muted nx-xq__meta">As Nexus recorded it: {v.recorded}</p>
            </details>
            {v.answers.length > 0 && confirming !== a.id && (
              <div className="nx-xq__acts">
                <button ref={(el) => { if (el) approveRefs.current.set(a.id, el); else approveRefs.current.delete(a.id); }} type="button"
                  className="nx-btn nx-btn--primary" disabled={pending !== null} onClick={() => setConfirming(a.id)}><span>Allow once</span></button>
                <Button disabled={pending !== null} onClick={() => { void answer(a.id, 'deny'); }}>{pending === a.id ? 'Answering…' : 'Do not allow'}</Button>
              </div>
            )}
            {v.answers.length > 0 && confirming === a.id && (
              <div className="nx-xq__confirm" role="group" aria-label={`Allow once: ${v.title}`} onKeyDown={onConfirmKey(a.id)}>
                <p>Allow this one time? It covers only what is listed above.</p>
                <div className="nx-xq__acts">
                  <Button variant="primary" disabled={pending !== null} onClick={() => { void answer(a.id, 'once'); }}>{pending === a.id ? 'Answering…' : 'Yes, allow once'}</Button>
                  <button ref={cancelRef} type="button" className="nx-btn" disabled={pending !== null} onClick={() => cancelConfirm(a.id)}><span>Cancel</span></button>
                </div>
              </div>
            )}
            {note && note.id === a.id && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** "Waiting for your approval" in the project: pending requests only; nothing at all while there are none. */
export function ApprovalsSection({ projectId, except = [] }: { projectId: string; except?: readonly string[] }) {
  const a = useApprovals(projectId);
  const waiting = (a.data ?? []).filter((x) => x.status === 'pending' && !except.includes(x.reason));
  if (waiting.length === 0) return null;
  return (
    <section className="nx-xq" aria-labelledby="nx-xq-title">
      <h2 id="nx-xq-title" className="nx-xq__title">Waiting for your approval</h2>
      <ApprovalList approvals={waiting} label="Requests waiting for your approval" />
    </section>
  );
}
