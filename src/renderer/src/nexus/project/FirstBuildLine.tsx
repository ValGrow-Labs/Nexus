import { Button } from '../ui/Button';
import type { FirstBuildLine as Line } from './firstBuildLineModel';

/** "Your first build": the three steps in one plain line, with one button that opens the setup sheet. */
export function FirstBuildLine({ line, onOpen }: { line: Line; onOpen: () => void }) {
  return (
    <section className="nx-fbl" aria-labelledby="nx-fbl-title">
      <h2 id="nx-fbl-title" className="nx-fbl__title">{line.title}</h2>
      <ol className="nx-fbl__steps">
        {line.steps.map((s) => <li key={s.number}><span className="nx-fbl__n" aria-hidden="true">{s.number}</span> {s.title}</li>)}
      </ol>
      <p className="nx-muted nx-fbl__lead">{line.lead}</p>
      <Button variant="primary" onClick={onOpen}>{line.button}</Button>
    </section>
  );
}
