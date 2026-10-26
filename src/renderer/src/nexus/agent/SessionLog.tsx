import { agentFailText, sessionLogModel } from './agentModel';
import { useSessionDetail } from '../data/useAgents';

/**
 * One conversation's log: its turns (what each ended as, and its usage with the label that says who reported it), the messages
 * (display only: what the agent wrote is not evidence), the tool calls (a name and a result size, never arguments) and the
 * versions its turns registered.
 */
export function SessionLog({ sessionId }: { sessionId: string }) {
  const d = useSessionDetail(sessionId, true);
  if (d.fail) return <p className="nx-muted" role="status">{agentFailText(d.fail)}</p>;
  if (!d.data) return <p className="nx-muted" role="status">Reading the conversation…</p>;
  const view = sessionLogModel(d.data);
  return (
    <div className="nx-ag__log">
      <p className="nx-muted">{view.note}</p>
      {view.turns.length > 0 && (
        <>
          <h3 className="nx-ag__sub">Turns</h3>
          <ol className="nx-ag__list" aria-label="Turns">
            {view.turns.map((t) => (
              <li key={t.key}><span>{t.headline}</span> {t.when && <span className="nx-muted">at {t.when}</span>}{t.usage && <span className="nx-muted"> · {t.usage}</span>}</li>
            ))}
          </ol>
        </>
      )}
      <h3 className="nx-ag__sub">Messages (display only)</h3>
      {view.messages.length === 0 ? <p className="nx-muted">No message is recorded yet.</p> : (
        <ol className="nx-ag__list" aria-label="Messages, display only">
          {view.messages.map((m) => (
            <li key={m.key} className="nx-ag__msg">
              <span className="nx-ag__who">{m.author}{m.when ? ` · ${m.when}` : ''}</span>
              <span className="nx-ag__text">{m.text}</span>
            </li>
          ))}
        </ol>
      )}
      {view.toolCalls.length > 0 && (
        <>
          <h3 className="nx-ag__sub">Tool calls</h3>
          <ul className="nx-ag__list" aria-label="Tool calls">
            {view.toolCalls.map((c) => <li key={c.key}><span className="nx-id">{c.tool}</span> <span className="nx-muted">{c.outcome}; result {c.size}</span></li>)}
          </ul>
        </>
      )}
      {view.versions.length > 0 && (
        <>
          <h3 className="nx-ag__sub">Registered by the agent</h3>
          <ul className="nx-ag__list" aria-label="Registered versions">
            {view.versions.map((v) => <li key={v.key}>{v.kind}, {v.status}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
