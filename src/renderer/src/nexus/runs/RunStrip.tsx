import { useId } from 'react';
import type { RunView, StageState } from './runModel';

/** What each stage state means, for screen readers (the bar carries it visually). */
const STATE_TEXT: Record<StageState, string> = {
  done: 'done',
  active: 'in progress',
  waiting: 'waiting for you',
  pending: 'not started',
  unreported: 'Nexus cannot see this part'
};

export function RunStrip({ run, onOpenConversation, onRetry }: { run: RunView; onOpenConversation(): void; onRetry(): void }) {
  const titleId = useId();
  const unreported = run.stages.filter((s) => s.state === 'unreported').map((s) => s.label);
  return (
    <article className={`nx-run${run.needsInput ? ' nx-run--needs-input' : ''}`} aria-labelledby={titleId}>
      <header className="nx-run__head">
        <h3 id={titleId} className="nx-run__title">{run.title}</h3>
        <span className="nx-run__headline" aria-live="polite">{run.headline}</span>
      </header>
      <ol className="nx-run__stages" aria-label="Stages">
        {run.stages.map((s) => (
          <li key={s.id} data-state={s.state} title={s.state === 'unreported' ? 'Nexus cannot see this part' : undefined}>
            <span>{s.label}</span>
            <span className="nx-visually-hidden">: {STATE_TEXT[s.state]}</span>
          </li>
        ))}
      </ol>
      {unreported.length > 0 && (
        // Visible key for the dashed bars; screen readers get it per stage above.
        <p className="nx-run__note" aria-hidden="true">Nexus cannot see these parts: {unreported.join(', ')}</p>
      )}
      <div className="nx-run__actions">
        <button type="button" className={`nx-btn${run.needsInput ? ' nx-btn--primary' : ''}`} onClick={onOpenConversation}>Open Agents</button>
        <button type="button" className="nx-btn nx-btn--quiet" onClick={onRetry}>Edit and send again</button>
      </div>
    </article>
  );
}
