import { useEffect, useMemo, useState } from 'react';
import type { ImageProfileArg } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { execFailText } from '../data/errorCopy';
import { checkedLine, consentHostsOf, noticeFor, pickerPermissionRows, runtimeChoices, runtimeInUse, runtimeMemory, setupLead, setupSheet, type RuntimeChoice } from '../data/executionModel';
import { CHECK_AGAIN_REREAD_MS, useApprovals, useHealth, useHealthPoll, withIntent } from '../data/useExecution';
import { useAgentConsent } from '../data/useAgents';
import { useOptionalShellActions } from '../shellActions';
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
  // Everything but the destinations comes from the shared health (the one fresh probe); #51 supplies only the destinations.
  const baseRows = health ? setupSheet(health, { estimates, pending: pendingProfiles, hosts: consentHostsOf(consent.view) }) : [];
  // "Check again" refreshes health first; #51 is read again once that re-read has had its time (the probe lands before the next look).
  const checkAgain = () => { askAgain(); consent.reloadAfter(CHECK_AGAIN_REREAD_MS + 500); };
  const [busy, setBusy] = useState<string | null>(null);
  // The runtime picker (shown only when the probe reported more than one runtime): the model picked per runtime in this open sheet.
  // Remembered for the session: a revoke, or closing and opening the sheet again, keeps the runtime and model that were picked.
  const [picked, setPicked] = useState<Record<string, string>>(() => runtimeMemory.models());
  // The provider picked per runtime that offers providers (the hosted runtime), remembered the same way.
  const [pickedProviders, setPickedProviders] = useState<Record<string, string>>(() => runtimeMemory.providers());
  const shell = useOptionalShellActions();
  const inUse = runtimeInUse(consent.view);
  useEffect(() => { if (inUse) runtimeMemory.rememberInUse(inUse.kind, inUse.model); }, [inUse?.kind, inUse?.model]);
  useEffect(() => { if (inUse && inUse.provider) runtimeMemory.rememberProvider(inUse.kind, inUse.provider); }, [inUse?.kind, inUse?.provider]);
  const choices = runtimeChoices(consent.view, picked, runtimeMemory.kind(), pickedProviders);
  const rows = pickerPermissionRows(baseRows, { picker: choices.length > 0, live: !!consent.view?.consent.live });
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
    // Revoking answers with the probe's cache not yet refilled, so the runtime list would show one row until the next 45 s re-ask: read #51 again soon (no new health probe).
    else consent.reloadAfter(CHECK_AGAIN_REREAD_MS + 500);
  };

  const useRuntime = async (c: RuntimeChoice) => {
    if (busy || !c.action || c.action.disabled) return;
    setBusy(`runtime:${c.kind}`); setNote(null);
    const model = c.model !== null ? { model: c.model } : {};
    const provider = c.providers && c.provider ? { provider: c.provider } : {};
    runtimeMemory.rememberInUse(c.kind, c.model);
    if (c.providers && c.provider) runtimeMemory.rememberProvider(c.kind, c.provider);
    const r = await consent.send(c.action.op === 'switch' ? { op: 'switch', runtime: c.kind, ...model, ...provider } : { op: 'grant', runtime: c.kind, ...model, ...provider });
    setBusy(null);
    setNote(r.ok ? { text: c.action.op === 'switch' ? 'The agent runtime was changed.' : 'The network permission was granted for that runtime.', alert: false } : { text: agentFailText(r), alert: true });
    checkAgain();
  };

  // A model picked for the runtime in use changes at once (no new permission); for another runtime it only readies the button.
  const pickModel = async (c: RuntimeChoice, model: string) => {
    setPicked((p) => ({ ...p, [c.kind]: model }));
    runtimeMemory.rememberModel(c.kind, model);
    if (!c.selected || busy) return;
    setBusy(`model:${c.kind}`); setNote(null);
    const r = await consent.send({ op: 'model', model, ...(c.providers && c.provider ? { provider: c.provider } : {}) });
    setBusy(null);
    setNote(r.ok ? { text: 'The model was changed.', alert: false } : { text: agentFailText(r), alert: true });
    checkAgain();
  };

  // A provider picked for a runtime that offers providers: its first model that can use tools is picked with it. For the runtime in use the
  // change is made at once (no new permission); for another runtime it only readies the button.
  const pickProvider = async (c: RuntimeChoice, providerId: string) => {
    const p = c.providers?.find((x) => x.id === providerId);
    if (!p) return;
    const model = p.models.find((m) => !m.disabled)?.name ?? null;
    setPickedProviders((s) => ({ ...s, [c.kind]: providerId }));
    runtimeMemory.rememberProvider(c.kind, providerId);
    if (model !== null) { setPicked((s) => ({ ...s, [c.kind]: model })); runtimeMemory.rememberModel(c.kind, model); }
    if (!c.selected || busy || model === null) return;
    setBusy(`model:${c.kind}`); setNote(null);
    const r = await consent.send({ op: 'model', model, provider: providerId });
    setBusy(null);
    setNote(r.ok ? { text: 'The provider was changed.', alert: false } : { text: agentFailText(r), alert: true });
    checkAgain();
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
      {choices.length > 0 && (
        <section aria-labelledby="nx-xs-runtimes">
          <h3 id="nx-xs-runtimes" className="nx-xs__sub">Agent runtime</h3>
          <ul className="nx-xs__rows" aria-label="Agent runtime">
            {choices.map((c) => (
              <li key={c.kind} className="nx-xs__row" data-state={c.state}>
                <span className="nx-xs__label">{c.label}</span>
                <span className="nx-xs__word">{c.word}</span>
                <span className="nx-xs__text">{c.text}{!c.selected && c.destination ? ` Using it lets Nexus reach only ${c.destination}.` : ''}</span>
                {c.providers && c.providers.length > 0 && (
                  <>
                    <span className="nx-xs__action">
                      <label>Provider
                        <select className="nx-xs__select" aria-label={`Provider for ${c.label}`} disabled={busy !== null}
                          value={c.provider ?? ''} onChange={(e) => { void pickProvider(c, e.target.value); }}>
                          {c.provider === null && <option value="" disabled>Choose a provider</option>}
                          {c.providers.map((p) => <option key={p.id} value={p.id}>{p.keyPresent ? p.label : `${p.label} (no key saved)`}</option>)}
                        </select>
                      </label>
                    </span>
                    <span className="nx-xs__action">
                      <label>Model
                        <select className="nx-xs__select" aria-label={`Model for ${c.label}`} disabled={busy !== null}
                          value={c.model ?? ''} onChange={(e) => { void pickModel(c, e.target.value); }}>
                          {c.model === null && <option value="" disabled>Choose a model</option>}
                          {(c.providers.find((p) => p.id === c.provider)?.models ?? []).map((m) => <option key={m.name} value={m.name} disabled={m.disabled}>{m.label}</option>)}
                        </select>
                      </label>
                    </span>
                    {c.keyHelp && (
                      <span className="nx-xs__action" role="note">
                        {c.keyHelp.text}{' '}
                        {c.keyHelp.settings && shell && <Button onClick={() => { onClose(); shell.openSettings('Agents & Models'); }}>Open Settings</Button>}
                      </span>
                    )}
                  </>
                )}
                {c.models && (
                  <span className="nx-xs__action">
                    <label>Model
                      <select className="nx-xs__select" aria-label={`Model for ${c.label}`} disabled={busy !== null}
                        value={c.model !== null && c.models.some((m) => m.name === c.model) ? c.model : ''} onChange={(e) => { void pickModel(c, e.target.value); }}>
                        {!(c.model !== null && c.models.some((m) => m.name === c.model)) && <option value="" disabled>{c.models.length > 0 ? 'Choose a model' : 'No models installed'}</option>}
                        {c.models.map((m) => <option key={m.name} value={m.name} disabled={m.disabled}>{m.label}</option>)}
                      </select>
                    </label>
                  </span>
                )}
                {c.action && (
                  <span className="nx-xs__btn">
                    <Button disabled={busy !== null || c.action.disabled} onClick={() => { void useRuntime(c); }}>{busy === `runtime:${c.kind}` ? 'Working…' : c.action.label}</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
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
