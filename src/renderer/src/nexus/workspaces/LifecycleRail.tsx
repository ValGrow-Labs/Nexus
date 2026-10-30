import type { RailView } from './lifecycleModel';
import { railSummary } from './lifecycleModel';

/** A workspace's steps in its own words: each step with its word (never colour alone); steps that come later
 *  are hatched and say when they arrive. Nothing here is a control. `compact` draws the Spine's one-line form:
 *  a segment per step (its words for screen readers) and the counts of the rail's own steps. */
export function LifecycleRail({ rail, compact = false }: { rail: RailView; compact?: boolean }) {
  if (!rail.supported || rail.steps.length === 0) {
    return <p className={compact ? 'nx-lrail__line' : 'nx-lrail__note'}>{rail.availability ?? 'Not yet a supported workflow'}</p>;
  }
  if (compact) {
    return (
      <div className="nx-lrail nx-lrail--compact">
        <ol className="nx-lrail__bar" aria-label={`${rail.label} steps`}>
          {rail.steps.map((s) => (
            <li key={s.id} data-future={s.future ? 'true' : undefined} data-state={s.state ?? undefined} title={`${s.label}: ${s.word}`}>
              <span className="nx-visually-hidden">{s.label}: {s.word}</span>
            </li>
          ))}
        </ol>
        <p className="nx-lrail__line">{railSummary(rail)}</p>
      </div>
    );
  }
  return (
    <section className="nx-lrail" aria-label={`${rail.label} steps`}>
      <p className="nx-lrail__note">{rail.statusNote}</p>
      {rail.availability && <p className="nx-lrail__note"><b>{rail.availability}.</b></p>}
      <ol className="nx-lrail__steps">
        {rail.steps.map((s) => (
          <li key={s.id} className="nx-lrail__step" data-future={s.future ? 'true' : undefined} data-state={s.state ?? undefined}>
            <span className="nx-lrail__n nx-id" aria-hidden="true">{s.n}</span>
            <span className="nx-lrail__label">{s.label}</span>
            <span className="nx-lrail__word">{s.word}</span>
            {(s.note || s.when) && <span className="nx-lrail__scope">{s.when && <b className="nx-lrail__when">{s.when}. </b>}{s.note}</span>}
          </li>
        ))}
      </ol>
      {rail.modules.length > 0 && (
        <p className="nx-lrail__modules">
          <span className="nx-lrail__sub">Parts</span>{' '}
          {rail.modules.map((m, i) => (
            <span key={m.id}>{i > 0 ? ' · ' : ''}{m.label}{m.note ? <span className="nx-muted"> ({m.note})</span> : null}</span>
          ))}
        </p>
      )}
    </section>
  );
}
