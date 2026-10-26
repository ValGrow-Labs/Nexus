import { useEffect, useId, useState } from 'react';
import { nexusClient } from '../data/nexusClient';
import { useHealth, useExecStore, withIntent } from '../data/useExecution';
import { useSessions, useTurnJobs } from '../data/useAgents';
import { usePlatform } from '../data/platformStore';
import { useExecutionUi } from '../project/execContext';
import { Button } from '../ui/Button';
import { SessionLog } from './SessionLog';
import { agentFailText, agentPanelModel, startArgs } from './agentModel';

/** The agent in the bench: where it stands (set up, working, waiting for you), a message box when it can take one, and the
 *  project's conversations with their logs. A prerequisite that is not met is a sentence with the way forward, never a dead button. */
export function AgentPanel({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
  const ui = useExecutionUi();
  const { health, availability } = useHealth();
  const sessions = useSessions(projectId);
  const jobs = useTurnJobs(projectId);
  const panel = agentPanelModel({ health, availability, sessions: sessions.data, sessionsFail: sessions.fail, jobs });
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [target, setTarget] = useState<string>('new');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  const [logOf, setLogOf] = useState<string | null>(null);
  const ids = { field: useId(), target: useId(), body: useId() };
  // A turn that starts working opens the panel so it is seen; the person can close it again.
  useEffect(() => { if (panel.working) setOpen(true); }, [panel.working]);
  const openRows = panel.sessions.filter((s) => s.canSend);
  const chosen = target !== 'new' && openRows.some((s) => s.id === target) ? target : 'new';

  const refresh = () => { usePlatform.getState().bumpRev(); useExecStore.getState().bump(['jobs']); sessions.reload(); };
  const send = async () => {
    if (busy) return;
    const key = `agent:start:${projectId}:${chosen}:${message.length}:${message.slice(0, 64)}`;
    const built = startArgs({ projectId, workspaceId, sessionId: chosen === 'new' ? null : chosen, message, intentId: 'pending' });
    if ('problem' in built) { setNote({ text: built.problem, alert: true }); return; }
    setBusy('send'); setNote(null);
    const r = await withIntent(key, (intentId) => nexusClient.agentStart({ ...built.args, intentId }));
    setBusy(null);
    if (r.ok) { setMessage(''); setNote({ text: 'Sent. The agent works in its own copy of the repository; follow the turn here or in Runs.', alert: false }); setLogOf(r.data.session.id); }
    else setNote({ text: agentFailText(r), alert: true });
    refresh();
  };
  const stop = async (id: string, kind: 'cancel' | 'end') => {
    if (busy) return;
    setBusy(id); setNote(null);
    const r = kind === 'cancel' ? await nexusClient.sessionCancel(id) : await nexusClient.sessionEnd(id);
    setBusy(null);
    setNote(r.ok ? { text: kind === 'cancel' ? 'Asked the agent to stop.' : 'The conversation was ended.', alert: false } : { text: agentFailText(r), alert: true });
    refresh();
  };

  const status = panel.working ?? (panel.kind === 'ready' ? 'Ready' : panel.kind === 'off' ? 'Not available' : 'Needs setup');
  return (
    <section className="nx-ag" aria-labelledby={ids.body}>
      <div className="nx-ag__head">
        <h2 id={ids.body} className="nx-xq__title">Agent</h2>
        <span className="nx-ag__status" role="status">{status}</span>
        <Button variant="quiet" onClick={() => setOpen((o) => !o)} ariaLabel={open ? 'Hide the agent panel' : 'Show the agent panel'}>{open ? 'Hide' : 'Show'}</Button>
      </div>
      {open && (
        <div className="nx-ag__body">
          {panel.kind === 'off' && <p className="nx-muted">{panel.lead}</p>}
          {panel.kind === 'setup' && (
            <ul className="nx-xa__why" aria-label="What the agent needs">
              {panel.blockers.map((b) => <li key={b}><span>{b}</span></li>)}
              {ui && <li><Button variant="quiet" onClick={ui.openSetup}>Open Setup</Button></li>}
            </ul>
          )}
          {panel.kind === 'ready' && (
            <form className="nx-ag__form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <p className="nx-muted">{panel.lead}</p>
              {openRows.length > 0 && (
                <>
                  <label htmlFor={ids.target}>Send to</label>
                  <select id={ids.target} className="nx-ag__select" value={chosen} onChange={(e) => setTarget(e.target.value)}>
                    <option value="new">A new conversation</option>
                    {openRows.map((s) => <option key={s.id} value={s.id}>An open conversation ({s.turns})</option>)}
                  </select>
                </>
              )}
              <label htmlFor={ids.field}>Message to the agent</label>
              <textarea id={ids.field} className="nx-cs__comment" rows={3} maxLength={8000} value={message} onChange={(e) => { setMessage(e.target.value); setNote(null); }}
                placeholder="Describe the change you want" />
              <div className="nx-passport__actions">
                <Button variant="primary" type="submit" disabled={busy !== null || message.trim() === ''}>{busy === 'send' ? 'Sending…' : 'Ask the agent'}</Button>
              </div>
            </form>
          )}
          {panel.usageToday && <p className="nx-muted">{panel.usageToday}</p>}
          {note && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
          {panel.sessions.length > 0 && (
            <ul className="nx-ag__sessions" aria-label="Conversations with the agent">
              {panel.sessions.map((s) => (
                <li key={s.id} className="nx-ag__session">
                  <p className="nx-ag__row">
                    <span className="nx-xq__word">{s.word}</span> <span className="nx-muted">{s.turns}</span>
                    {s.turn && <span>{s.turn}</span>}
                    <Button variant="quiet" onClick={() => setLogOf(logOf === s.id ? null : s.id)}>{logOf === s.id ? 'Hide log' : 'Show log'}</Button>
                    {s.canStop && <Button variant="quiet" disabled={busy !== null} onClick={() => { void stop(s.id, 'cancel'); }}>Stop</Button>}
                    {s.canEnd && <Button variant="quiet" disabled={busy !== null} onClick={() => { void stop(s.id, 'end'); }}>End conversation</Button>}
                  </p>
                  {logOf === s.id && <SessionLog sessionId={s.id} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
