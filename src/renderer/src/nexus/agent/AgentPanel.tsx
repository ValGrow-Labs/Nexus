import { useEffect, useMemo, useRef, useState } from 'react';
import { nexusClient } from '../data/nexusClient';
import { useApprovals, useHealth, useExecStore, withIntent } from '../data/useExecution';
import { useSessionDetail, useSessions, useTurnJobs } from '../data/useAgents';
import { usePlatform } from '../data/platformStore';
import { GLOSSARY } from '../data/glossary';
import { useExecutionUi } from '../project/execContext';
import { dockTail } from '../project/nextStepModel';
import { IntentLine } from '../intent/IntentLine';
import { Icon } from '../icons';
import { Button } from '../ui/Button';
import { ApprovalList } from '../project/ApprovalsSection';
import { SessionLog } from './SessionLog';
import { ISOLATION_NOTE, agentFailText, agentPanelModel, chatItems, liveStepLine, replyOf, usageShort } from './agentModel';

/** How often the elapsed time is refreshed while a request runs (a slow tick: it is not a clock). */
const PROGRESS_TICK_MS = 5_000;
/** While a request is shown as live, its jobs are read again this often, so a missed change message can never leave it "working". */
const LIVE_REFRESH_MS = 5_000;
/** The first thing an empty chat says (a hint, not a message). */
export const DOCK_GREETING = 'Hi! What would you like to build?';

/**
 * The AI helper as a plain chat, in three parts: a one-line header (name, one status word, More, close), the conversation (your
 * messages and the AI helper's as bubbles, its steps as small grey lines, and at the end ONE inline message with its one button when
 * something needs you), and the request box. Everything else (earlier conversations, cost, the safe-copy note, what happened) is behind More.
 */
export function AgentPanel({ projectId, workspaceId, reviewReady = 0, onReview, onDock, onClose }: { projectId: string; workspaceId: string; reviewReady?: number; onReview?: () => void;
  /** Tells the dock what to show on its edge and when to open itself (a request started, needs you, or ended with a reply). */
  onDock?: (s: { attention: boolean; tone: string }) => void; onClose?: () => void }) {
  const ui = useExecutionUi();
  const { health, availability, checkAgain } = useHealth();
  const sessions = useSessions(projectId);
  const jobs = useTurnJobs(projectId);
  const [now, setNow] = useState(() => Date.now());
  const newestId = useMemo(() => [...(sessions.data ?? [])].sort((x, y) => y.updatedAt - x.updatedAt)[0]?.id ?? null, [sessions.data]);
  const detail = useSessionDetail(newestId, true);
  const reply = replyOf(detail.data);
  const panel = agentPanelModel({ health, availability, sessions: sessions.data, sessionsFail: sessions.fail, jobs, now, reply });
  const approvals = useApprovals(projectId);
  const repoWaiting = useMemo(() => (approvals.data ?? []).filter((a) => a.status === 'pending' && a.reason === 'repo.write_refs'), [approvals.data]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [logOf, setLogOf] = useState<string | null>(null);
  const [snapshotStarted, setSnapshotStarted] = useState(false);
  const running = panel.progress !== null;
  useEffect(() => {
    if (!running) return;
    setSnapshotStarted(false);
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), PROGRESS_TICK_MS);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (!running && panel.working === null) return;
    const t = setInterval(() => { useExecStore.getState().bump(['jobs']); sessions.reload(); }, LIVE_REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, panel.working]);
  const needsLook = panel.working !== null || repoWaiting.length > 0 || panel.waiting !== null || panel.ending?.tone === 'failed' || (panel.ending?.reply ?? null) !== null || reviewReady > 0;
  const liveSession = panel.sessions.find((s) => s.canStop) ?? null;
  const tail = dockTail({ panel, reviewReady, repoApprovalWaiting: repoWaiting.length > 0, canStop: liveSession !== null, liveLine: liveStepLine(detail.data) });
  const showTail = tail !== null && !(snapshotStarted && tail.button?.kind === 'snapshot');
  const tone = repoWaiting.length > 0 || panel.waiting ? 'waiting' : running ? 'working' : reviewReady > 0 ? 'review' : panel.kind === 'ready' ? 'ready' : 'setup';
  useEffect(() => { onDock?.({ attention: needsLook, tone }); }, [needsLook, tone]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = chatItems(detail.data);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { const e = bodyRef.current; if (e) e.scrollTop = e.scrollHeight; }, [items.length, tail?.text, repoWaiting.length]);
  const elapsed = (panel.progress?.running ?? '').split(' for ').pop()?.replace(/\.$/, '') ?? '';
  const word = repoWaiting.length > 0 || panel.waiting ? 'Waiting for you'
    : running ? (elapsed ? `Working · ${elapsed}` : 'Working')
      : panel.kind === 'ready' ? 'Ready' : panel.kind === 'off' ? 'Not available' : 'Not ready';

  const refresh = () => { usePlatform.getState().bumpRev(); useExecStore.getState().bump(['jobs']); sessions.reload(); };
  const press = async () => {
    const b = tail?.button;
    if (!b || busy) return;
    if (b.kind === 'setup') ui?.openSetup();
    else if (b.kind === 'recheck') checkAgain();
    else if (b.kind === 'review') onReview?.();
    else if (b.kind === 'stop' && liveSession) {
      setBusy('stop'); setNote(null);
      const r = await nexusClient.sessionCancel(liveSession.id);
      setBusy(null); setNote(r.ok ? 'Asked the AI helper to stop.' : agentFailText(r)); refresh();
    } else if (b.kind === 'snapshot') {
      setBusy('snapshot'); setNote(null);
      const r = await withIntent(`agent:snapshot:${projectId}`, (intentId) => nexusClient.jobStart({ projectId, workspaceId, actionId: 'sde.repository.snapshot', inputs: [], params: {}, intentId }));
      setBusy(null);
      if (r.ok) setSnapshotStarted(true);
      setNote(r.ok ? 'Saving a starting point. Then ask again.' : agentFailText(r)); refresh();
    }
  };
  const end = async (id: string) => {
    if (busy) return;
    setBusy(id);
    const r = await nexusClient.sessionEnd(id);
    setBusy(null); setNote(r.ok ? 'The conversation was ended.' : agentFailText(r)); refresh();
  };
  return (
    <section className="nx-ag nx-ag--dock" aria-label="AI helper">
      <div className="nx-ag__top">
        <span className="nx-ag__name">AI helper</span>
        <span className="nx-ag__word" role="status"><span className="nx-ag__dot" data-tone={tone} aria-hidden="true" />{word}</span>
        <button type="button" className="nx-btn nx-btn--quiet nx-iconbtn" aria-label="More about the AI helper" aria-expanded={more} title="More" onClick={() => setMore((m) => !m)}>
          <span aria-hidden="true">i</span>
        </button>
        {onClose && <button type="button" className="nx-btn nx-btn--quiet nx-iconbtn" aria-label="Close the AI helper (Ctrl+L)" title="Close (Ctrl+L)" onClick={onClose}><Icon name="close" size={15} /></button>}
      </div>
      {more && (
        <div className="nx-ag__more" aria-label="More about the AI helper">
          <p>{ISOLATION_NOTE}</p>
          {panel.usageToday && <p>{panel.usageToday}</p>}
          {health?.agent && health.agent.consent.live && <p>{usageShort(health.agent.usageToday)}</p>}
          <Button variant="quiet" onClick={() => ui?.openSetup()}>{GLOSSARY.getReady.name}</Button>
          {panel.sessions.length > 0 && (
            <ul className="nx-ag__sessions" aria-label="Conversations with the AI helper">
              {panel.sessions.map((s, n) => (
                <li key={s.id}>
                  <span>{n === 0 ? 'This conversation' : 'Earlier'} · {s.word} · {s.turns}</span>{s.why && <span className="nx-muted"> · {s.why}</span>}
                  {' '}<Button variant="quiet" ariaExpanded={logOf === s.id} onClick={() => setLogOf(logOf === s.id ? null : s.id)}>{logOf === s.id ? 'Hide what happened' : 'Show what happened'}</Button>
                  {s.canEnd && <Button variant="quiet" disabled={busy !== null} onClick={() => { void end(s.id); }}>End conversation</Button>}
                  {logOf === s.id && <SessionLog sessionId={s.id} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="nx-ag__chat" ref={bodyRef} tabIndex={0} aria-label="Conversation with the AI helper">
        {items.length === 0 && !showTail && <p className="nx-ag__hint">{DOCK_GREETING}</p>}
        {items.map((m) => m.kind === 'steps'
          ? <p key={m.key} className="nx-ag__step">{m.text}</p>
          : (
            <div key={m.key} className="nx-ag__bubble" data-from={m.kind}>
              <span className="nx-ag__who">{m.kind === 'you' ? 'You' : 'AI helper'}{m.when ? ` · ${m.when}` : ''}</span>
              <span className="nx-ag__text">{m.text}</span>
            </div>
          ))}
        {repoWaiting.length > 0 && <ApprovalList approvals={repoWaiting} label="Question the AI helper is waiting for" />}
        {showTail && tail && (
          <div className="nx-ag__tail" role="status">
            <span>{tail.text}</span>
            {tail.button && <Button variant="primary" disabled={busy !== null} onClick={() => { void press(); }}>{tail.button.label}</Button>}
          </div>
        )}
        {note && <p className="nx-ag__step" role="status">{note}</p>}
        {panel.readError && <p className="nx-ag__step" role="status">The conversations could not be read. <Button variant="quiet" onClick={sessions.reload}>Try again</Button></p>}
      </div>
      <div className="nx-ag__input"><IntentLine inline compact locked={panel.kind !== 'ready'} /></div>
    </section>
  );
}
