import { useEffect, useState } from 'react';
import { TryIt } from './TryIt';
import { TRY_PAGE_TITLE, TRY_PROJECT_NOW, TRY_PROJECT_NOTE, TRY_CHANGE_CHOICE } from './tryModel';

/**
 * The project's Try it page: run the project as it stands (its last saved version), or, when a suggested change is waiting, that change.
 * One Try it panel (the same one the review page uses); this only chooses what it runs.
 */
export function ProjectTry({ projectId, change }: { projectId: string; change: { versionId: string; name: string } | null }) {
  const [target, setTarget] = useState<'project' | 'change'>('project');
  // A change that is gone (decided) leaves the choice on the project.
  useEffect(() => { if (!change && target === 'change') setTarget('project'); }, [change, target]);
  const versionId = target === 'change' && change ? change.versionId : null;
  return (
    <section className="nx-surface nx-try-page" aria-label={TRY_PAGE_TITLE}>
      <h2 className="nx-surface__title">{TRY_PAGE_TITLE}</h2>
      {change && (
        <div className="nx-try__targets" role="group" aria-label="What to run">
          <button type="button" className="nx-btn nx-btn--quiet" aria-pressed={target === 'project'} onClick={() => setTarget('project')}>{TRY_PROJECT_NOW}</button>
          <button type="button" className="nx-btn nx-btn--quiet" aria-pressed={target === 'change'} onClick={() => setTarget('change')}>{TRY_CHANGE_CHOICE}: {change.name}</button>
        </div>
      )}
      {target === 'project' && <p className="nx-muted">{TRY_PROJECT_NOTE}</p>}
      <TryIt key={versionId ?? 'project'} projectId={projectId} versionId={versionId} heading={false} />
    </section>
  );
}
