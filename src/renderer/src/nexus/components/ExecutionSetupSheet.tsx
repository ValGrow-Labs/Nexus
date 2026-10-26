import { useMemo, useState } from 'react';
import type { ImageProfileArg } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { execFailText } from '../data/errorCopy';
import { checkedLine, consentHostsOf, noticeFor, setupLead, setupSheet } from '../data/executionModel';
import { useApprovals, useHealth, useHealthPoll, withIntent } from '../data/useExecution';
import { useAgentConsent } from '../data/useAgents';
import { agentFailText } from '../agent/agentModel';
import { ApprovalList } from '../project/ApprovalsSection';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';

const PROFILES: readonly string[] = ['sde-node', 'sde-python', 'nexus-fwd'];

/** The execution setup as an actionable sheet: Docker, memory, CPUs, disk against the gate with the exact numbers,
 *  the sandbox images (Prepare image asks for an approval first), the runner, and the GPU line. */
export function ExecutionSetupSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} labelledBy="nx-xs-title" focusHeading>
      {open && <SetupBody onClose={onClose} />}
    </Sheet>
  );
}

function SetupBody({ onClose }: { onClose: () => void }) {
  const { health, availability, checkAgain: askAgain } = useHealth();
  useHealthPoll(true);
  const approvals = useApprovals(null);
  const prepares = useMemo(() => (approvals.data ?? []).filter((a) => a.reason === 'image.prepare'), [approvals.data]);
  const waiting = prepares.filter((a) => a.status === 'pending');
  const estimates = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of prepares) if (a.request.profile && typeof a.request.estimatedBytes === 'number') m.set(a.request.profile, a.request.estimatedBytes);
    return m;
  }, [prepares]);
  const pendingProfiles = useMemo(() => new Set(waiting.map((a) => a.request.profile ?? '')), [waiting]);
  // B2b: the agent's permission row reads #51 when the sheet opens (and again every 45 s while it stays open). Its destinations are
  // shown on that row and nowhere else.
  const consent = useAgentConsent(true);
  const checkAgain = () => { askAgain(); consent.reload(); };
  const shown = health && consent.view ? { ...health, agent: consent.view } : health;
  const rows = shown ? setupSheet(shown, { estimates, pending: pendingProfiles, hosts: consentHostsOf(consent.view) }) : [];
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  const notice = noticeFor(availability);
  const lead = setupLead(availability, rows);

  const prepare = async (profile: string) => {
    if (busy || !PROFILES.includes(profile)) return;
    setBusy(profile); setNote(null);
    const r = await withIntent(`prepare:${profile}`, (id) => nexusClient.setupPrepareImage(profile as ImageProfileArg, id));
    setBusy(null);
    approvals.reload();
    setNote(r.ok ? { text: 'Approve the request below to prepare the image.', alert: false } : { text: execFailText(r), alert: true });
  };

  const changeConsent = async (op: 'grant' | 'revoke') => {
    if (busy) return;
    setBusy(`consent:${op}`); setNote(null);
    const r = await consent.act(op);
    setBusy(null);
    setNote(r.ok ? { text: op === 'grant' ? 'The network permission was granted.' : 'The network permission was revoked.', alert: false } : { text: agentFailText(r), alert: true });
    if (op === 'grant') checkAgain();
  };

  return (
    <div className="nx-xs">
      <header className="nx-xs__head">
        <p className="nx-xs__kind">This computer</p>
        <h2 id="nx-xs-title" className="nx-xs__title">Execution setup</h2>
      </header>
      {lead ? <p className="nx-xs__lead">{lead}</p> : notice && <p className="nx-xs__lead">{notice.text}</p>}
      {health ? (
        <ul className="nx-xs__rows" aria-label="Execution setup">
          {rows.map((r) => (
            <li key={r.id} className="nx-xs__row" data-state={r.state}>
              <span className="nx-xs__label">{r.label}</span>
              <span className="nx-xs__word">{r.word}</span>
              <span className="nx-xs__text">{r.text}</span>
              {r.action && <span className="nx-xs__action">{r.action}</span>}
              {r.consent && (
                <span className="nx-xs__btn">
                  <Button disabled={busy !== null} onClick={() => { void changeConsent(r.consent!.op); }}>{busy === `consent:${r.consent.op}` ? 'Working…' : r.consent.label}</Button>
                </span>
              )}
              {r.prepare && (
                <span className="nx-xs__btn">
                  <Button disabled={busy !== null} onClick={() => { void prepare(r.prepare!.profile); }}>{busy === r.prepare.profile ? 'Asking…' : r.prepare.label}</Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="nx-muted" role="status">{availability.kind === 'unknown' && !availability.text ? 'Reading this computer’s setup…' : 'The setup cannot be read while execution is off.'}</p>
      )}
      {health && <p className="nx-muted">{checkedLine(health.checkedAt)}</p>}
      {waiting.length > 0 && (
        <section aria-labelledby="nx-xs-approvals">
          <h3 id="nx-xs-approvals" className="nx-xs__sub">Waiting for your approval</h3>
          <ApprovalList approvals={waiting} label="Image preparation requests" />
        </section>
      )}
      {note && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
      <div className="nx-xs__actions">
        {/* #23 { probe: true }: main probes this computer again now; "Checked at" moves once the fresh probe is read. */}
        <Button variant="primary" icon="refresh" onClick={checkAgain}>Check again</Button>
        <Button onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}
