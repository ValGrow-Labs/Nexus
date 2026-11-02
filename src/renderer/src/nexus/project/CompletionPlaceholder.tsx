import { Fragment } from 'react';
import type { Project } from '@shared/project';
import { primaryViewOf } from '../workspaces/participation';
import { useParticipationIndex } from '../data/useParticipations';
import { Badge } from '../ui/Badge';
import { Icon } from '../icons';
import { completionCopy } from './completionModel';

/** The Checklist tool before it exists: a plain coming-later
 *  state. No checklist, no counts, no actions; nothing here is tracked yet. */
export function CompletionPlaceholder({ project }: { project: Project }) {
  // Same workspace source the passport uses: the project's primary.
  const c = completionCopy({ domainLabel: primaryViewOf(useParticipationIndex(), project.id)?.label ?? null });
  return (
    <section className="nx-surface" aria-labelledby="nx-surface-title">
      <header className="nx-surface__head">
        <h1 id="nx-surface-title" className="nx-surface__title" tabIndex={-1}>{c.title}</h1>
        <Badge>{c.badge}</Badge>
      </header>
      {/* Static copy, so no role="status". Styled with the shared EmptyState classes. */}
      <div className="nx-empty"><p className="nx-empty__title"><Icon name="completion" size={16} className="nx-empty__icon" />{c.lead}</p></div>
      <dl className="nx-completion__facts">
        {c.facts.map((f) => <Fragment key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></Fragment>)}
      </dl>
    </section>
  );
}
