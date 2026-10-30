import { useId, useState } from 'react';
import { useStore } from '@/store/store';
import { displayNameForId } from '@shared/agentDisplay';
import { openQuestion, waitsOnHuman, type HiveTask } from '@/components/TasksKanban';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { useAgentDisplay } from '../agentIdentity';
import { useHiveTasks } from './useHiveTasks';
import { mergeHumanQA } from './teamModel';

const POLL_MS = 5000;

/** All tasks transitively waiting on `id` (dependents chain), cycle-safe. */
function dependentsTree(id: string, all: HiveTask[], seen = new Set<string>()): HiveTask[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const direct = all.filter((t) => Array.isArray(t.dependsOn) && t.dependsOn.includes(id) && t.status !== 'done');
  return direct.flatMap((d) => [d, ...dependentsTree(d.id, all, seen)]);
}

/** Needs you: tasks an AI helper has blocked on the human, through the task system.
 *  An entry can be a question or a to-do only the human can do. Sending an
 *  answer (1) records it on the task card's humanQA, so the decision stays on
 *  the card, and (2) tells the lead agent, so it unblocks the card and work
 *  continues. Moved from the retired lead panel; the writes are unchanged. */
export function NeedsYouSection() {
  const { tasks, setTasks, loaded, error, rawOf } = useHiveTasks(POLL_MS);
  const { canon, hint } = useAgentDisplay();
  // Drafts live in the STORE (keyed by task id): switching sections unmounts
  // this view, and a half-typed answer must survive the round trip.
  const drafts = useStore((s) => s.answerDrafts);
  const setAnswerDraft = useStore((s) => s.setAnswerDraft);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const [sending, setSending] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});

  const nameFor = (id?: string): string | undefined => (id ? displayNameForId(id, canon, hint) : undefined);
  const waiting = tasks.filter(waitsOnHuman);

  const sendAnswer = async (task: HiveTask) => {
    const text = (drafts[task.id] ?? '').trim();
    const open = openQuestion(task);
    if (!text || !open || sending) return;
    setSending(task.id);
    setFailed((f) => ({ ...f, [task.id]: '' }));
    try {
      // 1) Document the answer ON the card. The patch is built from the RAW
      //    entries so humanQA fields outside the parsed schema are kept.
      const change = { a: text, answeredAt: new Date().toISOString() };
      const next = tasks.map((t) => {
        if (t.id !== task.id) return t;
        const qa = (t.humanQA ?? []).map((e) =>
          e === open || (e.q === open.q && !e.a) ? { ...e, ...change } : e
        );
        return { ...t, humanQA: qa };
      });
      const rawQA = mergeHumanQA(rawOf(task.id)?.humanQA ?? task.humanQA, open.q, change);
      const result = await window.cth.hivePatchTask(task.id, { humanQA: rawQA as HiveTask['humanQA'] });
      if (!result.ok) throw new Error('The task changed before your answer could be saved. Try again.');
      setTasks(next);
      // 2) Tell the lead agent, so the card gets unblocked and work continues.
      await window.cth.hiveSend({
        to: 'god',
        act: 'inform',
        subject: `HUMAN ANSWER on task "${task.title}"`,
        body: [
          `The human answered the open question on task ${task.id} ("${task.title}"):`,
          `Q: ${open.q}`,
          `A: ${text}`,
          'The answer is also recorded in the card\'s humanQA. Act on it, unblock the card, and continue the work.'
        ].join('\n')
      }, 'human');
      setAnswerDraft(task.id, '');
    } catch (e) {
      // Leave the draft so the user can retry.
      setFailed((f) => ({ ...f, [task.id]: e instanceof Error ? e.message : String(e) }));
    }
    setSending(null);
  };

  // Dismiss WITHOUT answering: mark the open humanQA entry `dismissedAt` (no
  // fabricated answer) so openQuestion() stops returning it. The question stays
  // on the card, so the history is never dropped; the task stays blocked and the
  // lead agent can ask again by appending a fresh entry.
  const dismiss = async (task: HiveTask) => {
    const open = openQuestion(task);
    if (!open || sending === task.id) return;
    const change = { dismissedAt: new Date().toISOString() };
    const next = tasks.map((t) => {
      if (t.id !== task.id) return t;
      const qa = (t.humanQA ?? []).map((e) =>
        e === open || (e.q === open.q && !e.a && !e.dismissedAt) ? { ...e, ...change } : e
      );
      return { ...t, humanQA: qa };
    });
    setTasks(next); // optimistic: the card leaves immediately
    try {
      const rawQA = mergeHumanQA(rawOf(task.id)?.humanQA ?? task.humanQA, open.q, change, true);
      const result = await window.cth.hivePatchTask(task.id, { humanQA: rawQA as HiveTask['humanQA'] });
      if (!result.ok) throw new Error('The task changed before it could be dismissed. Try again.');
    } catch {
      setTasks(tasks); // restore on failure so the user can retry
    }
  };

  return (
    <div className="nxs">
      <div className="nxs__inner nxs__inner--narrow">
        <header className="nxs__head">
          <h3 className="nxs__title">Needs you</h3>
          <p className="nxs__lede">
            {error ? 'Nexus could not read the tasks.' : !loaded ? 'Reading the tasks…' : waiting.length === 0 ? 'Nothing is waiting on you.' : `${waiting.length} task${waiting.length === 1 ? ' is' : 's are'} waiting on you.`}
          </p>
        </header>
        {error && <p className="nxs__error" role="alert">Nexus could not read the tasks: {error}</p>}
        {error && waiting.length === 0 ? null : loaded && waiting.length === 0 ? (
          <EmptyState
            level={4}
            icon="check"
            title="All clear"
            body="Nothing needs you right now. When an AI helper asks a question or needs your OK, it shows up here."
          />
        ) : (
          <ul className="nxs__list" aria-label="Waiting on you">
            {waiting.map((t) => (
              <li key={t.id}>
                <AskCard
                  task={t}
                  question={openQuestion(t)!.q}
                  assignee={nameFor(t.assignee)}
                  stuck={dependentsTree(t.id, tasks)}
                  nameFor={nameFor}
                  draft={drafts[t.id] ?? ''}
                  onDraft={(v) => setAnswerDraft(t.id, v)}
                  sending={sending === t.id}
                  error={failed[t.id]}
                  onSend={() => { void sendAnswer(t); }}
                  onDismiss={() => { void dismiss(t); }}
                  onOpen={() => openTaskDetail(t.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AskCard({ task: t, question, assignee, stuck, nameFor, draft, onDraft, sending, error, onSend, onDismiss, onOpen }: {
  task: HiveTask;
  question: string;
  assignee?: string;
  stuck: HiveTask[];
  nameFor: (id?: string) => string | undefined;
  draft: string;
  onDraft: (v: string) => void;
  sending: boolean;
  error?: string;
  onSend: () => void;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  const uid = useId();
  const answered = t.humanQA?.filter((e) => e.a).length ?? 0;
  return (
    <article className="nxn-card" aria-labelledby={`${uid}-t`}>
      <div className="nxt-card__top">
        <h4 className="nxt-card__name" id={`${uid}-t`}>{t.title}</h4>
        {assignee && <span className="nxt-card__meta">Asked by {assignee}</span>}
      </div>
      <p className="nxn-q" id={`${uid}-q`}>{question}</p>
      <div className="nxs-field">
        <label className="nxs-label" htmlFor={`${uid}-a`}>Your answer</label>
        <textarea
          id={`${uid}-a`}
          className="nxs-textarea"
          rows={3}
          value={draft}
          aria-describedby={`${uid}-q`}
          placeholder="Type your answer, or “done” if you did it. Press Ctrl+Enter to send."
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(); } }}
        />
      </div>
      <div className="nxs-actions">
        <Button variant="primary" disabled={!draft.trim() || sending} onClick={onSend}>
          {sending ? 'Sending…' : 'Send answer'}
        </Button>
        <Button onClick={onOpen}>{answered > 0 ? `Open task (${answered} earlier answer${answered === 1 ? '' : 's'})` : 'Open task'}</Button>
        <Button
          variant="quiet"
          disabled={sending}
          title="Remove this from Needs you without answering. The question stays on the task."
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
      {error && <p className="nxs__error" role="alert">Nexus could not send your answer: {error}</p>}
      {stuck.length > 0 && (
        <div className="nxn-stuck">
          <p className="nxs__subtitle">Holding up {stuck.length} other task{stuck.length === 1 ? '' : 's'}</p>
          <ul className="nxn-stuck__list">
            {stuck.slice(0, 6).map((d) => (
              <li key={d.id}>
                <span className="nxn-stuck__status">{d.status}</span> {d.title}
                {nameFor(d.assignee) && <span className="nxt-card__meta"> ({nameFor(d.assignee)})</span>}
              </li>
            ))}
            {stuck.length > 6 && <li className="nxs__note">and {stuck.length - 6} more</li>}
          </ul>
        </div>
      )}
    </article>
  );
}
