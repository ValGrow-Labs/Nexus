import { useEffect, useMemo, useState } from 'react';
import type { ImageProfileArg } from '@shared/nexus/ipc';
import { requestKeysFocus } from '@/components/HostedKeysSettings';
import { nexusClient } from '../data/nexusClient';
import { execFailText } from '../data/errorCopy';
import { PERMISSION_NOTE, checkedLine, consentHostsOf, noticeFor, pickerPermissionRows, runtimeChoices, runtimeInUse, runtimeMemory, setupLead, setupSheet, type RuntimeChoice, type SetupRow } from '../data/executionModel';
import { CHECK_AGAIN_REREAD_MS, useApprovals, useHealth, useHealthPoll, withIntent } from '../data/useExecution';
import { useAgentConsent } from '../data/useAgents';
import { runtimeGuide, type GuideWay } from '../data/runtimeGuideModel';
import { firstBuild } from '../data/firstBuildModel';
import { termName } from '../data/glossary';
import { useOptionalShellActions } from '../shellActions';
import { agentFailText } from '../agent/agentModel';
import { ApprovalList } from '../project/ApprovalsSection';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';

const PROFILES: readonly string[] = ['sde-node', 'sde-python', 'nexus-fwd'];

/**
 * "Get this computer ready": the three steps of "Your first build" (get this computer ready, choose your AI helper, save a starting point), each
 * Done, Next or Waiting, with the first step that is not done as the only one to act on. The exact numbers (Docker's memory and processors, free
 * disk, each safe-space kit, the GPU) sit behind "More details", closed.
 */
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
  // Nexus asks before it keeps its own notes in a project: the question is answered here too, in step 3.
  const notesWaiting = useMemo(() => (approvals.data ?? []).filter((a) => a.reason === 'repo.write_refs' && a.status === 'pending'), [approvals.data]);
  const estimates = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of prepares) if (a.request.profile && typeof a.request.estimatedBytes === 'number') m.set(a.request.profile, a.request.estimatedBytes);
    return m;
  }, [prepares]);
  const pendingProfiles = useMemo(() => new Set(waiting.map((a) => a.request.profile ?? '')), [waiting]);
  // B2b: the AI helper's permission row reads #51 when the sheet opens (and again every 45 s while it stays open). Its destinations are
  // shown on that row and nowhere else.
  const consent = useAgentConsent(true);
  // Everything but the destinations comes from the shared health (the one fresh probe); #51 supplies only the destinations.
  const baseRows = health ? setupSheet(health, { estimates, pending: pendingProfiles, hosts: consentHostsOf(consent.view) }) : [];
  // "Check again" refreshes health first; #51 is read again once that re-read has had its time (the probe lands before the next look).
  const checkAgain = () => { askAgain(); consent.reloadAfter(CHECK_AGAIN_REREAD_MS + 500); };
  const [busy, setBusy] = useState<string | null>(null);
  // The AI service picker (shown only when the probe reported more than one): the model picked per service in this open sheet.
  // Remembered for the session: a revoke, or closing and opening the sheet again, keeps the service and model that were picked.
  const [picked, setPicked] = useState<Record<string, string>>(() => runtimeMemory.models());
  // The AI service picked per runtime that offers several (Free online AI), remembered the same way.
  const [pickedProviders, setPickedProviders] = useState<Record<string, string>>(() => runtimeMemory.providers());
  const shell = useOptionalShellActions();
  const inUse = runtimeInUse(consent.view);
  useEffect(() => { if (inUse) runtimeMemory.rememberInUse(inUse.kind, inUse.model); }, [inUse?.kind, inUse?.model]);
  useEffect(() => { if (inUse && inUse.provider) runtimeMemory.rememberProvider(inUse.kind, inUse.provider); }, [inUse?.kind, inUse?.provider]);
  const choices = runtimeChoices(consent.view, picked, runtimeMemory.kind(), pickedProviders);
  // First run (no permission given): the guide "Choose your AI helper" speaks for the helper. The program's own rows (which would
  // lead with an uninstalled program) and the permission row wait until a way is chosen; a helper that is off keeps its one row.
  const guide = health?.agent?.state === 'off' ? null : runtimeGuide(consent.view, choices);
  const shownRows = pickerPermissionRows(baseRows, { picker: choices.length > 0, live: !!consent.view?.consent.live });
  const rows = guide ? shownRows.filter((r) => !r.id.startsWith('agent')) : shownRows;
  const computerRows = rows.filter((r) => !r.id.startsWith('agent'));
  const helperRows = rows.filter((r) => r.id.startsWith('agent'));
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  const notice = noticeFor(availability);
  const lead = setupLead(availability, rows);
  const helperOff = health?.agent?.state === 'off' ? (shownRows.find((r) => r.id === 'agent')?.text ?? null) : null;
  const steps = firstBuild({ availability, rows: computerRows, helperReady: !!consent.view?.consent.live, helperLabel: choices.find((c) => c.selected)?.label ?? null,
    helperOff, startingPointWaiting: notesWaiting.length > 0 });
  // "Add my key" opens Settings on the section that holds the keys, which scrolls to them (the sheet closes first).
  const addKey = () => { if (shell) { onClose(); requestKeysFocus(); shell.openSettings('Agents & Models'); } };
  const pressWay = (way: GuideWay, which: 'action' | 'secondary') => {
    const a = way[which];
    if (!a || a.disabled) return;
    if (a.op === 'add-key') addKey();
    else if (way.choice) void useRuntime(way.choice);
    else void changeConsent('grant');
  };

  const prepare = async (profile: string) => {
    if (busy || !PROFILES.includes(profile)) return;
    setBusy(profile); setNote(null);
    const r = await withIntent(`prepare:${profile}`, (id) => nexusClient.setupPrepareImage(profile as ImageProfileArg, id));
    setBusy(null);
    approvals.reload();
    setNote(r.ok ? { text: 'Now answer the request below. Nexus downloads a kit only after you allow it.', alert: false } : { text: execFailText(r), alert: true });
  };

  // One button for every kit that is not ready: the same request for each, one after the other (each still waits for its own answer).
  const prepareAll = async () => {
    const todo = computerRows.flatMap((r) => (r.prepare && PROFILES.includes(r.prepare.profile) ? [r.prepare.profile] : []));
    if (busy || todo.length === 0) return;
    setBusy('prepare:all'); setNote(null);
    let failed: string | null = null;
    for (const profile of todo) {
      const r = await withIntent(`prepare:${profile}`, (id) => nexusClient.setupPrepareImage(profile as ImageProfileArg, id));
      if (!r.ok) { failed = execFailText(r); break; }
    }
    setBusy(null);
    approvals.reload();
    setNote(failed !== null ? { text: failed, alert: true }
      : { text: `Nexus asked about ${todo.length === 1 ? 'one kit' : `${todo.length} kits`}. Answer each request below. Nexus downloads a kit only after you allow it.`, alert: false });
  };

  const changeConsent = async (op: 'grant' | 'revoke') => {
    if (busy) return;
    setBusy(`consent:${op}`); setNote(null);
    const r = await consent.act(op);
    setBusy(null);
    setNote(r.ok ? { text: op === 'grant' ? 'Internet permission was given.' : 'Internet permission was taken back.', alert: false } : { text: agentFailText(r), alert: true });
    if (op === 'grant') checkAgain();
    // Revoking answers with the probe's cache not yet refilled, so the service list would show one row until the next 45 s re-ask: read #51 again soon (no new health probe).
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
    setNote(r.ok ? { text: c.action.op === 'switch' ? 'Your AI service was changed.' : 'Your AI service is set. Internet permission was given for it.', alert: false } : { text: agentFailText(r), alert: true });
    checkAgain();
  };

  // A model picked for the service in use changes at once (no new permission); for another service it only readies the button.
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

  // An AI service picked for a runtime that offers several: its first model that can use tools is picked with it. For the one in use the
  // change is made at once (no new permission); for another it only readies the button.
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
    setNote(r.ok ? { text: 'The AI service was changed.', alert: false } : { text: agentFailText(r), alert: true });
    checkAgain();
  };

  // The AI service, model and key-help controls of one service row: the picker below and the first-run guide's options use the same ones.
  const runtimeControls = (c: RuntimeChoice, withKeyHelp: boolean) => (
    <>
      {c.providers && c.providers.length > 0 && (
        <>
          <span className="nx-xs__action">
            <label>AI service
              <select className="nx-xs__select" aria-label={`AI service for ${c.label}`} disabled={busy !== null}
                value={c.provider ?? ''} onChange={(e) => { void pickProvider(c, e.target.value); }}>
                {c.provider === null && <option value="" disabled>Choose an AI service</option>}
                {c.providers.map((p) => <option key={p.id} value={p.id}>{p.keyPresent ? p.label : `${p.label} (no access key yet)`}</option>)}
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
          {withKeyHelp && c.keyHelp && (
            <span className="nx-xs__action" role="note">
              {c.keyHelp.text}{' '}
              {c.keyHelp.settings && shell && <Button onClick={addKey}>Add my key</Button>}
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
    </>
  );

  // One row: a label, a status word (never colour alone), the facts, what to do, and its buttons. Used for this computer's details and the AI helper's rows.
  const renderRow = (r: SetupRow) => (
    <li key={r.id} className="nx-xs__row" data-state={r.state}>
      <span className="nx-xs__label">{r.label}</span>
      <span className="nx-xs__word">{r.word}</span>
      <span className="nx-xs__text">{r.text}</span>
      {r.action && <span className="nx-xs__action">{r.action}</span>}
      {r.more && (
        <details className="nx-xs__fold">
          <summary>More details</summary>
          <p>{r.more}</p>
        </details>
      )}
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
  );

  // The AI helper's choices (step 2): the guide while nothing is given, the service list once something is.
  const helperBody = (locked: boolean) => (
    <>
      {guide && (
        <section aria-labelledby="nx-xs-guide" className="nx-xg">
          <h3 id="nx-xs-guide" className="nx-xs__sub">{guide.title}</h3>
          <p className="nx-xg__intro">{guide.lead}</p>
          <p className="nx-muted">{guide.note}</p>
          <ul className="nx-xg__ways" aria-label={guide.title}>
            {guide.ways.map((way) => (
              <li key={way.id} className="nx-xg__way" data-state={way.state} data-free={way.free ? 'true' : 'false'}>
                <h4 className="nx-xg__title">{way.title}</h4>
                <p className="nx-xg__text">{way.lead}</p>
                <p className="nx-muted">{way.cost}</p>
                {way.providers.length > 0 && <p className="nx-muted">Free AI services Nexus can use: {way.providers.join(', ')}.</p>}
                <p className="nx-xg__status"><span className="nx-xs__word">{way.word}</span> <span>{way.status}</span></p>
                {way.steps.length > 0 && <ol className="nx-xg__steps">{way.steps.map((t) => <li key={t}>{t}</li>)}</ol>}
                {way.controls && way.choice && <div className="nx-xg__controls">{runtimeControls(way.choice, false)}</div>}
                {(way.action || way.secondary) && (
                  <div className="nx-xg__buttons">
                    {way.action && (way.action.op !== 'add-key' || shell) && (
                      <Button variant="primary" disabled={busy !== null || way.action.disabled || locked} onClick={() => pressWay(way, 'action')}>
                        {way.choice && busy === `runtime:${way.choice.kind}` ? 'Working…' : way.action.label}
                      </Button>
                    )}
                    {way.secondary && shell && <Button disabled={busy !== null || locked} onClick={() => pressWay(way, 'secondary')}>{way.secondary.label}</Button>}
                  </div>
                )}
                {way.safety && (
                  <details className="nx-xs__fold">
                    <summary>Is this safe?</summary>
                    <p>{way.safety}</p>
                  </details>
                )}
              </li>
            ))}
          </ul>
          <p className="nx-muted">{PERMISSION_NOTE}</p>
        </section>
      )}
      {choices.length > 0 && !guide && (
        <section aria-labelledby="nx-xs-runtimes">
          <h3 id="nx-xs-runtimes" className="nx-xs__sub">Your AI service</h3>
          <ul className="nx-xs__rows" aria-label="Your AI service">
            {choices.map((c) => (
              <li key={c.kind} className="nx-xs__row" data-state={c.state}>
                <span className="nx-xs__label">{c.label}</span>
                <span className="nx-xs__word">{c.word}</span>
                <span className="nx-xs__text">{c.text}{!c.selected && c.destination ? ` Using it lets your AI helper reach only ${c.destination}.` : ''}</span>
                {runtimeControls(c, true)}
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
      {!guide && helperRows.length > 0 && (
        <ul className="nx-xs__rows" aria-label="Your AI helper and internet permission">{helperRows.map(renderRow)}</ul>
      )}
    </>
  );

  return (
    <div className="nx-xs">
      <header className="nx-xs__head">
        <p className="nx-xs__kind">This computer</p>
        <h2 id="nx-xs-title" className="nx-xs__title">{termName('getReady')}</h2>
      </header>
      {availability.kind !== 'setup' && availability.kind !== 'ready' && notice && <p className="nx-xs__lead">{notice.text}</p>}
      <section aria-labelledby="nx-fb-title" className="nx-fb">
        <h3 id="nx-fb-title" className="nx-xs__sub">{steps.title}</h3>
        <p className="nx-xs__lead">{steps.lead}</p>
        <ol className="nx-fb__steps" aria-label={steps.title}>
          {steps.steps.map((step) => (
            <li key={step.id} className="nx-fb__step" data-state={step.state} data-current={steps.current === step.id ? 'true' : 'false'}>
              <p className="nx-fb__head">
                <span className="nx-fb__num" aria-hidden="true">{step.number}</span>
                <b className="nx-fb__title">{step.title}</b>
                <span className="nx-xs__word">{step.word}</span>
              </p>
              <p className="nx-fb__line">{step.line}</p>
              {step.id === 'computer' && step.items.length > 0 && step.state !== 'done' && (
                <ul className="nx-fb__items" aria-label="What Nexus checked on this computer">
                  {step.items.map((it) => (
                    <li key={it.id} className="nx-fb__item" data-state={it.state}>
                      <span className="nx-xs__label">{it.label}</span>
                      <span className="nx-xs__word">{it.word}</span>
                      <span className="nx-muted nx-fb__what">{it.what}</span>
                      <span className="nx-fb__say">{it.line}</span>
                    </li>
                  ))}
                </ul>
              )}
              {step.id === 'computer' && step.action && (
                <div className="nx-xs__btn">
                  <Button variant="primary" disabled={busy !== null} onClick={() => { void prepareAll(); }}>{busy === 'prepare:all' ? 'Asking…' : step.action.label}</Button>
                </div>
              )}
              {step.id === 'computer' && waiting.length > 0 && (
                <section aria-labelledby="nx-xs-approvals">
                  <h3 id="nx-xs-approvals" className="nx-xs__sub">Waiting for your answer</h3>
                  <ApprovalList approvals={waiting} label="Safe-space kit requests" />
                </section>
              )}
              {step.id === 'helper' && step.state !== 'waiting' && helperBody(false)}
              {step.id === 'helper' && step.state === 'waiting' && !helperOff && (
                <details className="nx-fb__ahead">
                  <summary>Look at your choices</summary>
                  {helperBody(true)}
                </details>
              )}
              {step.id === 'starting-point' && step.help && <p className="nx-muted">{step.help}</p>}
              {step.id === 'starting-point' && notesWaiting.length > 0 && (
                <ApprovalList approvals={notesWaiting} label="Requests to keep hidden Nexus notes" />
              )}
            </li>
          ))}
        </ol>
      </section>
      {health ? (
        <details className="nx-fb__more">
          <summary>More details</summary>
          <p className="nx-muted">{lead ?? 'The exact numbers behind the steps above.'}</p>
          <ul className="nx-xs__rows" aria-label="Computer details">{computerRows.map(renderRow)}</ul>
          <p className="nx-muted">{checkedLine(health.checkedAt)}</p>
        </details>
      ) : (
        <p className="nx-muted" role="status">{availability.kind === 'unknown' && !availability.text ? 'Nexus is reading this computer…' : 'Nexus cannot check this computer while running tasks is off.'}</p>
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
