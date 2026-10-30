import { useId } from 'react';
import { useStore } from '@/store/store';
import { displayNameForId } from '@shared/agentDisplay';
import { waitsOnHuman, type HiveTask } from '@/components/TasksKanban';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { useAgentDisplay } from '../agentIdentity';
import { useHiveTasks } from './useHiveTasks';
import { TASK_COLUMNS, columnsFor } from './teamModel';

const POLL_MS = 3000;

/** Tasks: the lead AI helper's tasks, by status. The lead AI helper writes the
 *  cards; here a person can open one in full or delete one they no longer want
 *  tracked. New work goes in through Requests. */
export function TasksSection({ onRequests }: { onRequests: () => void }) {
  const { tasks, setTasks, loaded, error, refresh } = useHiveTasks(POLL_MS);
  const { canon, hint } = useAgentDisplay();
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const columns = columnsFor(tasks);

  // Main removes the named id from its latest on-disk ledger, so a card added
  // since this renderer's last poll cannot be lost.
  const remove = async (t: HiveTask): Promise<void> => {
    if (!window.confirm('Delete this task? AI helpers will no longer see it.')) return;
    setTasks((prev) => prev.filter((x) => x.id !== t.id)); // optimistic
    try {
      const result = await window.cth.hiveDeleteTask(t.id);
      if (!result.ok) void refresh();
    } catch { /* keep last good; the next poll re-syncs from disk */ }
  };

  return (
    <div className="nxs">
      <div className="nxs__inner nxs__inner--wide">
        <header className="nxs__head">
          <h3 className="nxs__title">Tasks</h3>
          <p className="nxs__lede">
            {error ? 'Nexus could not read the tasks.' : loaded ? `${tasks.length} task${tasks.length === 1 ? '' : 's'} in total.` : 'Reading the tasks…'}
          </p>
          <Button variant="quiet" icon="send" onClick={onRequests}>New request</Button>
        </header>

        {error && <p className="nxs__error" role="alert">Nexus could not read the tasks: {error}</p>}
        {error && tasks.length === 0 ? null : loaded && tasks.length === 0 ? (
          <EmptyState
            level={4}
            icon="completion"
            title="No tasks"
            body="No tasks yet. Send a request to the lead AI helper to start one."
            actions={<Button onClick={onRequests}>Open Requests</Button>}
          />
        ) : loaded && (
          <div className="nxk">
            {TASK_COLUMNS.map((col) => (
              <TaskColumn
                key={col.id}
                id={col.id}
                label={col.label}
                tasks={columns[col.id] as HiveTask[]}
                nameOf={(id) => displayNameForId(id, canon, hint)}
                onOpen={(t) => openTaskDetail(t.id)}
                onDelete={(t) => { void remove(t); }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskColumn({ id, label, tasks, nameOf, onOpen, onDelete }: {
  id: string;
  label: string;
  tasks: HiveTask[];
  nameOf: (id: string) => string;
  onOpen: (t: HiveTask) => void;
  onDelete: (t: HiveTask) => void;
}) {
  const headId = useId();
  return (
    <section className="nxk__col" data-status={id} aria-labelledby={headId}>
      <h4 className="nxk__head" id={headId}>
        <span>{label}</span>
        <span className="nxk__count">{tasks.length}</span>
      </h4>
      {tasks.length === 0 ? (
        <p className="nxk__empty">None</p>
      ) : (
        <ul className="nxk__list">
          {tasks.map((t) => (
            <li key={t.id} className="nxk__card">
              <span className="nxk__title">{t.title}</span>
              <span className="nxk__meta">
                {t.assignee ? nameOf(t.assignee) : 'Unassigned'}
                {waitsOnHuman(t) && <span className="nxt-chip nxk__waiting">Needs you</span>}
              </span>
              <span className="nxk__actions">
                <Button variant="quiet" ariaLabel={`Open task: ${t.title}`} onClick={() => onOpen(t)}>Open</Button>
                <Button variant="quiet" ariaLabel={`Delete task: ${t.title}`} onClick={() => onDelete(t)}>Delete</Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
