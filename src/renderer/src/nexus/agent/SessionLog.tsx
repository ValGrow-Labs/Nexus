import { agentFailText, sessionLogModel } from './agentModel';
import { useSessionDetail } from '../data/useAgents';

/**
 * What happened in one conversation: its requests (how each one ended, the steps it took and what it cost, with the label that says
 * who reported it), what was said (for reading only: what the AI helper wrote is not proof), the steps the AI helper took (each in
 * plain words with whether it worked, never its arguments) and the items it saved.
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
          <h3 className="nx-ag__sub">Requests</h3>
          <ol className="nx-ag__list" aria-label="Requests">
            {view.turns.map((t) => (
              <li key={t.key}>
                <span>{t.headline}</span> {t.when && <span className="nx-muted">at {t.when}</span>}{t.usage && <span className="nx-muted"> · {t.usage}</span>}
                {t.next && <span className="nx-muted"> · Next: {t.next.charAt(0).toLowerCase()}{t.next.slice(1)}</span>}
              </li>
            ))}
          </ol>
        </>
      )}
      <h3 className="nx-ag__sub">What was said (for reading only)</h3>
      {view.messages.length === 0 ? <p className="nx-muted">Nothing has been said yet.</p> : (
        <ol className="nx-ag__list" aria-label="What was said, for reading only">
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
          <h3 className="nx-ag__sub">Steps the AI helper took</h3>
          <ul className="nx-ag__list" aria-label="Steps the AI helper took">
            {view.toolCalls.map((c) => <li key={c.key}><span>{c.tool}</span> <span className="nx-muted">{c.outcome}</span></li>)}
          </ul>
        </>
      )}
      {view.versions.length > 0 && (
        <>
          <h3 className="nx-ag__sub">Saved by the AI helper</h3>
          <ul className="nx-ag__list" aria-label="Items saved by the AI helper">
            {view.versions.map((v) => <li key={v.key}>{v.kind}, {v.status}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
