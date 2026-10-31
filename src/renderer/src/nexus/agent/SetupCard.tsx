import { useState } from 'react';
import type { Project } from '@shared/project';
import { nexusClient } from '../data/nexusClient';
import { usePlatform } from '../data/platformStore';
import { withIntent } from '../data/useExecution';
import { Button } from '../ui/Button';
import { setupFailText, type SetupCard as Card } from '../project/projectSetupModel';

/**
 * The one card that stands where the AI helper's dock will be while the project is not ready for it: add it to Software, or set up Git in
 * the folder (then the starting point is saved by itself so the AI helper can start). One button, one sentence of why, one line of result.
 */
export function SetupCard({ card, project, onDone }: { card: Card; project: Project; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const press = async () => {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      if (card.kind === 'workspace') {
        const r = await nexusClient.participationAttach(project.id, 'sde');
        if (!r.ok) { setNote('It did not work. Try again.'); return; }
        usePlatform.getState().bumpRev();
      } else {
        const r = await window.cth.gitInitProject(project.id);
        if (!r.ok) { setNote(setupFailText(r.reason)); return; }
        setNote('Done. Saving a starting point…');
        // The starting point (what the AI helper starts from) is saved right away; if it cannot be yet, the AI helper offers it later.
        await withIntent(`setup:snapshot:${project.id}`, (intentId) => nexusClient.jobStart({ projectId: project.id, workspaceId: 'sde', actionId: 'sde.repository.snapshot', inputs: [], params: {}, intentId })).catch(() => null);
      }
      onDone();
    } finally { setBusy(false); }
  };
  return (
    <section className="nx-setup" aria-label="Get the AI helper ready">
      <p className="nx-setup__title">{card.title}</p>
      <p className="nx-setup__text">{card.text}</p>
      <div className="nx-passport__actions"><Button variant="primary" disabled={busy} onClick={() => { void press(); }}>{busy ? 'Working…' : card.button}</Button></div>
      {note && <p className="nx-setup__note" role="status">{note}</p>}
    </section>
  );
}
