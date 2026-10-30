import { useAssistant } from '../assistant/useAssistant';
import { useNexusUi } from '../state/uiStore';
import { RunStrip } from '../runs/RunStrip';
import { useRuns } from '../runs/useRuns';

/** Mobile only: the latest two real runs for this project, above the spine.
 *  Renders nothing when there are none. */
export function MobileRuns({ projectId }: { projectId: string }) {
  const port = useAssistant();
  const setDraft = useNexusUi((s) => s.setDraft);
  const focusIntent = useNexusUi((s) => s.focusIntent);
  const entries = useRuns().filter((e) => e.request.projectId === projectId).reverse().slice(0, 2);
  if (entries.length === 0) return <p className="nx-mruns nx-muted">No tasks have run for this project yet.</p>;
  return (
    <section className="nx-mruns" aria-label="Latest runs">
      <ul className="nx-runs">
        {entries.map(({ request, run }) => (
          <li key={request.id}>
            <RunStrip run={run} onOpenConversation={port.openConversation} onRetry={() => { setDraft(request.text); focusIntent(); }} />
          </li>
        ))}
      </ul>
    </section>
  );
}
