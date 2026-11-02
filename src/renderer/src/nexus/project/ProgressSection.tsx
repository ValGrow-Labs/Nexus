import { useId, useState, type ReactNode } from 'react';

/** "Project progress": the step bar and the chain of saved items, closed until you open it (a newcomer does not need them to start). */
export function ProgressSection({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="nx-prog" aria-label="Project progress">
      <button type="button" className="nx-prog__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Project progress
      </button>
      <div id={id} className="nx-prog__body" hidden={!open}>{children}</div>
    </section>
  );
}
