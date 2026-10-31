import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { nexusClient } from '../data/nexusClient';
import { useExecStore, useHealth } from '../data/useExecution';
import { useSessionDetail, useSessions, useTurnJobs } from '../data/useAgents';
import { usePlatform } from '../data/platformStore';
import { Button } from '../ui/Button';
import { agentFailText, agentPanelModel, chatItems, liveStepLine, replyOf } from './agentModel';
import { buildView } from './buildModel';
import { usePendingStart } from './pendingStart';

/** While the request runs its jobs are read again this often, so the page never stays on "working" after the work has ended. */
const LIVE_REFRESH_MS = 3_000;
/** The elapsed time on the page is a slow tick, not a clock. */
const TICK_MS = 2_000;

/**
 * The project's main area while the AI helper builds: the request as the heading, what it is doing now, how long, the steps so far,
 * and one button (Stop while it works, then "Look at the suggested changes", or "Back to the project" when it ended without any).
 * Otherwise it shows `children`, the project as usual. The AI helper dock stays on the right as the chat.
 */
export function BuildStage({ projectId, blocked, reviewReady, onReview, children }: { projectId: string; blocked: boolean; reviewReady: number; onReview: () => void; children: ReactNode }) {
  const { health, availability } = useHealth();
  const sessions = useSessions(projectId);
  const jobs = useTurnJobs(projectId);
  const [now, setNow] = useState(() => Date.now());
  const newestId = useMemo(() => [...(sessions.data ?? [])].sort((x, y) => y.updatedAt - x.updatedAt)[0]?.id ?? null, [sessions.data]);
  const detail = useSessionDetail(newestId, true);
  const panel = agentPanelModel({ health, availability, sessions: sessions.data, sessionsFail: sessions.fail, jobs, now, reply: replyOf(detail.data) });
  const pending = usePendingStart((s) => s.pending);
  const sending = usePendingStart((s) => s.sending);
  const failed = usePendingStart((s) => s.failed);
  const startingText = blocked ? null : sending?.projectId === projectId ? sending.text : pending?.projectId === projectId && panel.canAsk ? pending.text : null;
  const startFailed = failed?.projectId === projectId ? { text: failed.text, error: failed.error } : null;
  const live = panel.progress !== null || panel.waiting !== null;
  const sawLive = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  // A request that starts (or is seen running) shows its end here, until the person goes back; a new one opens the page again.
  if (live || startingText !== null) { sawLive.current = true; if (dismissed) setDismissed(false); }
  useEffect(() => {
    if (!live && startingText === null) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    const r = setInterval(() => { useExecStore.getState().bump(['jobs']); sessions.reload(); }, LIVE_REFRESH_MS);
    return () => { clearInterval(t); clearInterval(r); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, startingText !== null]);

  const view = buildView({ panel, items: chatItems(detail.data), liveLine: liveStepLine(detail.data), reviewReady, starting: startingText, startFailed, sawLive: sawLive.current, dismissed });
  if (blocked || !view) return <>{children}</>;

  const liveSession = panel.sessions.find((s) => s.canStop) ?? null;
  const stop = async () => {
    if (!liveSession || stopping) return;
    setStopping(true); setNote(null);
    const r = await nexusClient.sessionCancel(liveSession.id);
    setStopping(false);
    setNote(r.ok ? 'Asked the AI helper to stop.' : agentFailText(r));
    usePlatform.getState().bumpRev(); useExecStore.getState().bump(['jobs']); sessions.reload();
  };
  const press = () => {
    if (!view.button) return;
    if (view.button.kind === 'review') onReview();
    else { usePendingStart.getState().clearFailed(); setDismissed(true); }
  };
  const elapsed = view.elapsed ? view.elapsed.replace(/\.$/, '') : null;
  return (
    <section className="nx-build" aria-label="The AI helper is building" data-state={view.state}>
      <h2 className="nx-build__title">{view.heading}</h2>
      <p className="nx-build__status" role="status">
        <span className="nx-build__dot" data-state={view.state} aria-hidden="true" />
        <span>{view.status}</span>
        {elapsed && <span className="nx-build__time">{elapsed}</span>}
      </p>
      {view.next && <p className="nx-build__next">{view.next}</p>}
      {view.steps.length > 0 && (
        <ol className="nx-build__steps" aria-label="What the AI helper has done">
          {view.steps.map((s) => (
            <li key={s.key} data-now={s.now ? 'true' : undefined}>
              <span className="nx-build__mark" aria-hidden="true">{s.now ? '' : '✓'}</span>
              <span>{s.text}{s.now ? '…' : ''}</span>
            </li>
          ))}
        </ol>
      )}
      {view.said && <p className="nx-build__said"><span className="nx-build__who">The AI helper said</span>{view.said}</p>}
      <div className="nx-build__acts">
        {view.button && <button type="button" className="nx-btn nx-btn--primary nx-build__big" onClick={press}>{view.button.label}</button>}
        {view.state === 'ready' && <Button variant="secondary" onClick={onReview}>Try it in the safe space first</Button>}
        {view.canStop && <Button variant="secondary" disabled={stopping} onClick={() => { void stop(); }}>Stop</Button>}
      </div>
      {note && <p className="nx-build__next" role="status">{note}</p>}
    </section>
  );
}
