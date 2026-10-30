import { useEffect, useMemo, useRef, useState } from 'react';
import { nexusClient } from '../data/nexusClient';
import { useApprovals, useHealth, useExecStore, withIntent } from '../data/useExecution';
import { useSessionDetail, useSessions, useTurnJobs } from '../data/useAgents';
import { usePlatform } from '../data/platformStore';
import { GLOSSARY } from '../data/glossary';
import { useExecutionUi } from '../project/execContext';
import { nextStep } from '../project/nextStepModel';
import { IntentLine } from '../intent/IntentLine';
import { Button } from '../ui/Button';
import { ApprovalList } from '../project/ApprovalsSection';
import { SessionLog } from './SessionLog';
import { CHOOSE_RUNTIME_BUTTON, REPO_APPROVAL_WAIT_TEXT, agentFailText, agentPanelModel, liveStepLine, replyOf, sessionLogModel } from './agentModel';

/** How often the "working for 2 minutes" line is refreshed while a request runs (a slow tick: it is not a clock). */
const PROGRESS_TICK_MS = 15_000;
/** While a request is shown as live, its jobs are read again this often, so a missed change message can never leave it "working". */
const LIVE_REFRESH_MS = 5_000;

/** The AI helper on the project page: where it stands (getting ready, working, waiting for you), a message box when it can take one,
 *  and the project's conversations with their logs. A prerequisite that is not met is a sentence with the way forward, never a dead button. */
export function AgentPanel({ projectId, workspaceId, reviewReady = 0, onReview, onDock }: { projectId: string; workspaceId: string; reviewReady?: number; onReview?: () => void;
  /** Tells the dock what to show on its edge and when to open itself (a request started, needs you, or ended with a reply). */
  onDock?: (s: { attention: boolean; tone: string }) => void }) {
  const ui = useExecutionUi();
  const { health, availability } = useHealth();
  const sessions = useSessions(projectId);
  const jobs = useTurnJobs(projectId);
  // The clock only moves while a request is live (no background timer otherwise).
  const [now, setNow] = useState(() => Date.now());
  // The newest conversation's detail: what the AI helper last said (shown, not hidden in a log) and what it is doing now.
  const newestId = useMemo(() => [...(sessions.data ?? [])].sort((x, y) => y.updatedAt - x.updatedAt)[0]?.id ?? null, [sessions.data]);
  const detail = useSessionDetail(newestId, true);
  const reply = replyOf(detail.data);
  const panel = agentPanelModel({ health, availability, sessions: sessions.data, sessionsFail: sessions.fail, jobs, now, reply });
  // The OK a request waits on to keep Nexus's notes in the project is answered here, in the panel (the project's strip leaves it out).
  const approvals = useApprovals(projectId);
  const repoWaiting = useMemo(() => (approvals.data ?? []).filter((a) => a.status === 'pending' && a.reason === 'repo.write_refs'), [approvals.data]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  const [logOf, setLogOf] = useState<string | null>(null);
  // The starting point a failed request asked for was saved from here: the old failure is answered until the next message.
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
  // A request that starts working opens the panel so it is seen; the person can close it again.
  // The dock opens by itself while a request works, waits for you, or ends with a reply, suggested changes or a problem.
  const needsLook = panel.working !== null || repoWaiting.length > 0 || panel.waiting !== null || panel.ending?.tone === 'failed' || (panel.ending?.reply ?? null) !== null || reviewReady > 0;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { const e = bodyRef.current; if (e) e.scrollTop = e.scrollHeight; }, [reply, panel.progress?.now, panel.ending?.title, repoWaiting.length]);
  const step = nextStep({ panel, reviewReady, repoApprovalWaiting: repoWaiting.length > 0 });
  const press = () => {
    if (!step.action) return;
    if (step.action.kind === 'setup') ui?.openSetup();
    else onReview?.();
  };

  const refresh = () => { usePlatform.getState().bumpRev(); useExecStore.getState().bump(['jobs']); sessions.reload(); };
  // A request that failed for want of a starting point: it is saved from here (the same action as the item page's).
  const snapshot = async () => {
    if (busy) return;
    setBusy('snapshot'); setNote(null);
    const r = await withIntent(`agent:snapshot:${projectId}`, (intentId) => nexusClient.jobStart({ projectId, workspaceId, actionId: 'sde.repository.snapshot', inputs: [], params: {}, intentId }));
    setBusy(null);
    if (r.ok) setSnapshotStarted(true);
    setNote(r.ok ? { text: 'Saving a starting point has begun. When it has finished (see Runs), send your message again.', alert: false } : { text: agentFailText(r), alert: true });
    refresh();
  };
  const stop = async (id: string, kind: 'cancel' | 'end') => {
    if (busy) return;
    setBusy(id); setNote(null);
    const r = kind === 'cancel' ? await nexusClient.sessionCancel(id) : await nexusClient.sessionEnd(id);
    setBusy(null);
    setNote(r.ok ? { text: kind === 'cancel' ? 'Asked the AI helper to stop.' : 'The conversation was ended.', alert: false } : { text: agentFailText(r), alert: true });
    refresh();
  };

  const stepNow = nextStep({ panel, reviewReady, repoApprovalWaiting: repoWaiting.length > 0 });
  useEffect(() => { onDock?.({ attention: needsLook, tone: stepNow.tone }); }, [needsLook, stepNow.tone]);
  const row = (s: (typeof panel.sessions)[number]) => (
    <li key={s.id} className="nx-ag__session">
      <p className="nx-ag__row">
        <span className="nx-xq__word">{s.word}</span> <span className="nx-muted">{s.turns}</span>
        {s.turn && <span>{s.turn}</span>}
        <Button variant="quiet" ariaExpanded={logOf === s.id} onClick={() => setLogOf(logOf === s.id ? null : s.id)}>{logOf === s.id ? 'Hide what happened' : 'Show what happened'}</Button>
        {s.canStop && <Button variant="quiet" disabled={busy !== null} onClick={() => { void stop(s.id, 'cancel'); }}>Stop</Button>}
        {s.canEnd && <Button variant="quiet" disabled={busy !== null} onClick={() => { void stop(s.id, 'end'); }}>End conversation</Button>}
      </p>
      {s.why && <p className="nx-muted">{s.why}</p>}
      {logOf === s.id && <SessionLog sessionId={s.id} />}
    </li>
  );
  const ending = panel.ending && repoWaiting.length === 0 && !snapshotStarted ? panel.ending : null;
  return (
    <section className="nx-ag nx-ag--dock" aria-label="AI helper">
      <div className="nx-ag__statusline" data-tone={step.tone}>
        <p className="nx-ag__next-title" role="status">AI helper · {step.title}</p>
        <p className="nx-ag__next-text">{step.text}</p>
        {step.action && <div className="nx-passport__actions"><Button variant="primary" onClick={press}>{step.action.label}</Button></div>}
      </div>
      <div className="nx-ag__chat" ref={bodyRef} tabIndex={0} aria-label="Conversation with the AI helper">
        {/* The conversation as a chat: what you asked and what the AI helper said back, oldest first; the newest is at the bottom. */}
        {detail.data && sessionLogModel(detail.data).messages.length > 0 && (
          <ol className="nx-ag__chatlist" aria-label="What was said">
            {sessionLogModel(detail.data).messages.map((m) => (
              <li key={m.key} className="nx-ag__bubble" data-from={m.author === 'You' ? 'you' : 'helper'}>
                <span className="nx-ag__who">{m.author === 'You' ? 'You' : 'AI helper'}{m.when ? ` · ${m.when}` : ''}</span>
                <span className="nx-ag__text">{m.text}</span>
              </li>
            ))}
          </ol>
        )}
        {panel.kind === 'off' && <p className="nx-muted">{panel.lead}</p>}
        {panel.kind === 'setup' && (
          <ul className="nx-xa__why" aria-label="What the AI helper needs">
            {panel.blockers.map((b) => <li key={b}><span>{b}</span></li>)}
            {/* No AI service chosen: one sentence above and one button that opens the guide. */}
            {ui && <li><Button variant={panel.chooseRuntime ? 'primary' : 'quiet'} onClick={ui.openSetup}>{panel.chooseRuntime ? CHOOSE_RUNTIME_BUTTON : GLOSSARY.getReady.name}</Button></li>}
          </ul>
        )}
        {panel.kind === 'ready' && <p className="nx-muted">{panel.lead} Ask in the box above.</p>}
        {/* While it works: what it is doing, for how long, that you can leave, and what happens next. */}
        {panel.progress && (
          <div className="nx-ag__progress" aria-label="Progress of the AI helper">
            <p><strong>{panel.progress.now}.</strong>{panel.progress.running ? ` ${panel.progress.running}.` : ''}</p>
            {liveStepLine(detail.data) && <p>{liveStepLine(detail.data)}</p>}
            <p className="nx-muted">{panel.progress.keepUsing} Next: {panel.progress.next.charAt(0).toLowerCase()}{panel.progress.next.slice(1)}</p>
          </div>
        )}
        {/* When it cannot go on without you: one clear card, and the question is answered right here. */}
        {(repoWaiting.length > 0 || panel.waiting) && (
          <div className="nx-ag__wait" role="status">
            <p><strong>Waiting for you.</strong></p>
            {repoWaiting.length > 0 ? <p>{REPO_APPROVAL_WAIT_TEXT}</p> : panel.waiting && <p>{panel.waiting.text}</p>}
            {repoWaiting.length > 0
              ? <p className="nx-muted">Next: answer the question below. The AI helper carries on by itself after that.</p>
              : panel.waiting && <p className="nx-muted">Next: {panel.waiting.next.charAt(0).toLowerCase()}{panel.waiting.next.slice(1)}</p>}
            {repoWaiting.length > 0 && <ApprovalList approvals={repoWaiting} label="Question the AI helper is waiting for" />}
          </div>
        )}
        {/* How the last request ended, with the reason in plain words and one next step. */}
        {ending && (
          <p className={ending.tone === 'failed' ? 'nx-passport__note nx-ag__end' : 'nx-ag__end'} role="status" data-tone={ending.tone}>
            <strong>{ending.title}.</strong> {ending.text}{ending.reply ? <> <span className="nx-ag__reply">The AI helper replied: {ending.reply}</span></> : null}{ending.next ? ` Next: ${ending.next.charAt(0).toLowerCase()}${ending.next.slice(1)}` : ''}{' '}
            {ending.snapshot && <Button variant="primary" disabled={busy !== null} onClick={() => { void snapshot(); }}>{busy === 'snapshot' ? 'Starting…' : 'Save a starting point'}</Button>}
          </p>
        )}
        {panel.note && <p className="nx-muted" role="status">{panel.note}</p>}
        {panel.readError && <p className="nx-muted" role="status">The conversations could not be read. {panel.readError} <Button variant="quiet" onClick={sessions.reload}>Try again</Button></p>}
        {note && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
        {panel.sessions.length > 0 && (
          <ul className="nx-ag__sessions" aria-label="Conversations with the AI helper">{panel.sessions.slice(0, 1).map(row)}</ul>
        )}
        {panel.sessions.length > 1 && (
          <details className="nx-ag__earlier">
            <summary>Earlier conversations ({panel.sessions.length - 1})</summary>
            <ul className="nx-ag__sessions" aria-label="Earlier conversations">{panel.sessions.slice(1).map(row)}</ul>
          </details>
        )}
        {panel.usageToday && <p className="nx-muted">{panel.usageToday}</p>}

      </div>
      <div className="nx-ag__input"><IntentLine inline compact /></div>
    </section>
  );
}
