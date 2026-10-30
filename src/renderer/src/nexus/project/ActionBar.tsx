import { useState } from 'react';
import { getUserAction } from '@shared/nexus/actions';
import { nexusClient } from '../data/nexusClient';
import { errorCopy, execFailText } from '../data/errorCopy';
import { useActions, useDeployments, useExecStore, useHealth, useJobs, withIntent } from '../data/useExecution';
import { useParticipationIndex } from '../data/useParticipations';
import { viewOf } from '../workspaces/participation';
import { Button } from '../ui/Button';
import { termName } from '../data/glossary';
import { useExecutionUi } from './execContext';
import { actionBar, liveDeploymentOf, startedNote } from './actionModel';

/** The actions of one workspace here: available ones as buttons, the others as sentences that say why (with "Get this
 *  computer ready" when the fix is on this computer). With a version, only actions that take it as an input. Actions of
 *  steps not in this release are not listed. */
export function ActionBar({ projectId, workspaceId, version, title }: {
  projectId: string; workspaceId: string; title: string;
  /** `buildId`: an application version's build (its assembled_from source), so a preview job not yet leased counts. */
  version: { id: string; kind: string; status: string; buildId?: string | null } | null;
}) {
  const ui = useExecutionUi();
  const { availability } = useHealth();
  const list = useActions(projectId, workspaceId, version?.id ?? null);
  // A dev deployment of this version already live (or starting): no second start from here (main would allow one).
  const deployments = useDeployments(projectId);
  const jobs = useJobs(projectId);
  const liveDeployment = version ? liveDeploymentOf({ versionId: version.id, buildVersionId: version.buildId ?? null }, deployments.data ?? [], jobs.data ?? []) : null;
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  // The job this bar just started, while it can still be stopped from here (Runs offers Cancel too).
  const [started, setStarted] = useState<{ jobId: string; label: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  if (!ui) return null; // outside a project bench (the Artifacts page): nothing to open the sheets with
  if (list.fail) {
    const c = errorCopy(list.fail.code, list.fail.reason, list.fail.subReason);
    // Execution off: the notice says why. A passing failure says so here, with Try again.
    if (c.kind !== 'busy' && c.kind !== 'internal') return null;
    return (
      <section aria-label={title}>
        <h2>{title}</h2>
        <p className="nx-muted nx-xa__line" role="status"><span>Nexus could not load the actions here. {c.text}</span> <Button variant="quiet" onClick={list.reload}>Try again</Button></p>
      </section>
    );
  }
  if (!list.data) return null;
  const view = actionBar(list.data, { workspaceId, availability, version: version ? { kind: version.kind, status: version.status } : null, liveDeployment });
  if (view.buttons.length === 0 && view.sentences.length === 0) return null;

  const start = async (actionId: string, slot: string | null) => {
    const def = getUserAction(actionId);
    if (!def || busy) return;
    if ('inlineKind' in def.run) {
      const kind = def.run.inlineKind === 'requirement' ? 'requirement' : 'problem_statement';
      ui.openWrite({ workspaceId, kind });
      return;
    }
    setBusy(actionId); setNote(null); setStarted(null);
    const inputs = slot && version ? [{ versionId: version.id, slot }] : [];
    const key = `start:${projectId}:${workspaceId}:${actionId}:${version?.id ?? ''}`;
    const r = await withIntent(key, (intentId) => nexusClient.jobStart({ projectId, workspaceId, actionId, inputs, params: {}, intentId }));
    setBusy(null);
    setNote(r.ok ? { text: startedNote(def.label, r.data.created), alert: false } : { text: execFailText(r), alert: true });
    if (r.ok && !r.data.job.cancelRequested) setStarted({ jobId: r.data.job.id, label: def.label });
  };
  const cancel = async () => {
    if (!started || cancelling) return;
    setCancelling(true);
    const r = await nexusClient.jobCancel(started.jobId);
    useExecStore.getState().bump(['jobs', 'approvals']);
    setCancelling(false);
    setStarted(null);
    setNote(r.ok ? { text: `${started.label}: asked to stop. Runs shows where it stopped.`, alert: false } : { text: execFailText(r), alert: true });
  };

  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      {view.buttons.length > 0 && (
        <div className="nx-passport__actions">
          {view.buttons.map((b) => (
            <Button key={b.actionId} disabled={busy !== null} onClick={() => { void start(b.actionId, b.slot); }}>
              {busy === b.actionId ? 'Starting…' : `${b.label}${b.inline ? '…' : ''}`}
            </Button>
          ))}
        </div>
      )}
      {view.buttons.some((b) => b.needsApproval) && <p className="nx-muted">Installing add-ons asks for your OK before anything is downloaded.</p>}
      {view.sentences.length > 0 && (
        <ul className="nx-xa__why">
          {view.sentences.map((s) => (
            <li key={s.actionId}>
              <span>{s.text}</span>
              {s.setup && <Button variant="quiet" onClick={ui.openSetup}>{termName('getReady')}</Button>}
            </li>
          ))}
        </ul>
      )}
      {note && (
        <p className={note.alert ? 'nx-passport__note' : 'nx-muted nx-xa__line'} role={note.alert ? 'alert' : 'status'}>
          <span>{note.text}</span>
          {started && <> <Button variant="quiet" disabled={cancelling} onClick={() => { void cancel(); }}>{cancelling ? 'Cancelling…' : 'Cancel'}</Button></>}
        </p>
      )}
    </section>
  );
}

/** The project-level bars: one per active workspace of the project (actions that take no input, and why others wait). */
export function ProjectActions({ projectId }: { projectId: string }) {
  const idx = useParticipationIndex();
  const rows = (idx.byProject.get(projectId) ?? []).filter((r) => r.status === 'active');
  return (
    <>
      {rows.map((r) => (
        <ActionBar key={r.workspaceId} projectId={projectId} workspaceId={r.workspaceId} version={null} title={`${viewOf(r.workspaceId).label} actions`} />
      ))}
    </>
  );
}
