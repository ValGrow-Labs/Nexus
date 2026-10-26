import { useEffect, useId, useRef, useState } from 'react';
import type { DeploymentView, JobView, ValidationResultView } from '@shared/nexus/ipc';
import { useAssistant } from '../assistant/useAssistant';
import { useNexusUi } from '../state/uiStore';
import { nexusClient } from '../data/nexusClient';
import { errorCopy, execFailText } from '../data/errorCopy';
import { useDeployments, useJobs, useExecStore, withIntent } from '../data/useExecution';
import { useExecutionUi } from '../project/execContext';
import { Button } from '../ui/Button';
import { RunStrip } from './RunStrip';
import { useRuns } from './useRuns';
import { STAGE_STATE_TEXT, awaitingUserCheck, expectedChecksFor, jobRun, livePreviewsOf } from './jobRunModel';

/**
 * For a job whose outputs are still being checked (headline `validating`): true when they wait only for a check the
 * user starts (a preview) and nothing that could run it is live: the rail's `awaiting_check` rule, from the job's
 * outputs (#27), their checks (#32), the dev deployments (#36) and the project's jobs. False while anything is unread.
 */
function useAwaitingCheck(job: JobView, jobs: readonly JobView[], deployments: readonly DeploymentView[] | null): boolean {
  const enabled = job.headline === 'validating' && deployments !== null && expectedChecksFor(job.actionId).length > 0;
  const tick = useExecStore((s) => s.ticks.validations);
  const [outputs, setOutputs] = useState<{ versionId: string; rows: ValidationResultView[] }[] | null>(null);
  useEffect(() => {
    if (!enabled) { setOutputs(null); return; }
    let alive = true;
    void (async () => {
      const d = await nexusClient.jobGet(job.id);
      if (!d.ok) { if (alive) setOutputs(null); return; }
      const drafts = d.data.outputs.filter((o) => o.status === 'draft').slice(0, 4);
      const reads = await Promise.all(drafts.map((o) => nexusClient.versionValidations(o.versionId)));
      if (!alive) return;
      const rows: { versionId: string; rows: ValidationResultView[] }[] = [];
      for (let i = 0; i < drafts.length; i++) { const r = reads[i]; if (!r.ok) { setOutputs(null); return; } rows.push({ versionId: drafts[i].versionId, rows: r.data }); }
      setOutputs(rows);
    })();
    return () => { alive = false; };
  }, [job.id, job.updatedAt, enabled, tick]);
  if (!enabled || !outputs || !deployments) return false;
  // Per version: the outputs were assembled from this job's own build input, which a preview job of them runs.
  const buildVersionId = job.inputs.find((x) => x.slot === 'build')?.versionId ?? null;
  const live = outputs.reduce((n, o) => n + livePreviewsOf({ versionId: o.versionId, buildVersionId }, deployments, jobs).length, 0);
  return awaitingUserCheck({ expected: expectedChecksFor(job.actionId), outputs: outputs.map((o) => o.rows), liveDeployments: live });
}

/** The first failed (or not run) check summary of what a finished job made: the sourced reason of its headline. */
function useCheckReason(job: JobView, enabled: boolean): string | null {
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) { setReason(null); return; }
    let alive = true;
    void (async () => {
      const d = await nexusClient.jobGet(job.id);
      if (!d.ok) return;
      for (const id of [...d.data.outputs.map((o) => o.versionId), ...d.data.inputs.map((i) => i.versionId)].slice(0, 4)) {
        const v = await nexusClient.versionValidations(id);
        if (!v.ok) continue;
        const bad = v.data.find((x) => x.blocking && (x.status === 'failed' || x.status === 'error'));
        if (bad?.summary) { if (alive) setReason(bad.summary); return; }
      }
    })();
    return () => { alive = false; };
  }, [job.id, job.updatedAt, enabled]);
  return reason;
}

function JobRow({ job, explain, jobs, deployments }: { job: JobView; explain: boolean; jobs: readonly JobView[]; deployments: readonly DeploymentView[] | null }) {
  const titleId = useId();
  const ui = useExecutionUi();
  const reason = useCheckReason(job, explain && (job.headline === 'checks_failed' || job.headline === 'checks_could_not_run'));
  const awaitingCheck = useAwaitingCheck(job, jobs, deployments);
  const run = jobRun(job, { reason, awaitingCheck });
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const act = async (kind: 'cancel' | 'retry') => {
    if (busy) return;
    setBusy(kind); setNote(null);
    const r = kind === 'cancel' ? await nexusClient.jobCancel(job.id) : await withIntent(`retry:${job.id}`, (id) => nexusClient.jobRetry(job.id, id));
    useExecStore.getState().bump(['jobs', 'approvals']);
    if (!alive.current) return;
    setBusy(null);
    if (!r.ok) setNote(execFailText(r));
  };
  return (
    <article className={`nx-run${run.needsYou ? ' nx-run--needs-input' : ''}`} aria-labelledby={titleId}>
      <header className="nx-run__head">
        <h3 id={titleId} className="nx-run__title">{run.title}</h3>
        <span className="nx-run__headline" aria-live="polite" title={run.codes.length ? run.codes.join(', ') : undefined}>{run.headline}</span>
      </header>
      {run.stages.length > 0 && (
        <ol className="nx-run__stages" aria-label="Stages">
          {run.stages.map((s) => (
            <li key={s.id} data-state={s.state === 'stopped' ? 'unreported' : s.state === 'waiting' ? 'waiting' : s.state}>
              <span>{s.label}</span>
              <span className="nx-visually-hidden">: {STAGE_STATE_TEXT[s.state]}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="nx-run__note">{run.word} · {new Date(job.createdAt).toLocaleString()}{job.attempts > 1 ? ` · ${job.attempts} attempts` : ''}</p>
      <div className="nx-run__actions">
        {run.canCancel && <Button disabled={busy !== null} onClick={() => { void act('cancel'); }}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}</Button>}
        {run.canRetry && <Button disabled={busy !== null} onClick={() => { void act('retry'); }}>{busy === 'retry' ? 'Retrying…' : 'Retry'}</Button>}
        {ui && job.attempts > 0 && <Button variant="quiet" onClick={() => ui.openLog({ jobId: job.id })}>Logs</Button>}
      </div>
      {note && <p className="nx-passport__note" role="alert">{note}</p>}
    </article>
  );
}

/** Jobs of this project, persisted (nexus:jobs:list), newest first. */
function JobsSection({ projectId }: { projectId: string }) {
  const jobs = useJobs(projectId);
  const deployments = useDeployments(projectId);
  const ui = useExecutionUi();
  const off = jobs.fail ? errorCopy(jobs.fail.code, jobs.fail.reason, jobs.fail.subReason) : null;
  return (
    <section className="nx-xj" aria-labelledby="nx-xj-title">
      <div className="nx-xj__head">
        <h2 id="nx-xj-title" className="nx-xj__title">Jobs</h2>
        {/* The setup sheet opens from here in every state of this computer, ready included (Check again, the GPU line). */}
        {ui && <Button variant="quiet" onClick={ui.openSetup}>This computer’s execution setup</Button>}
      </div>
      {/* The execution notice is the bench's (one line above every tool), not repeated here. */}
      {off && off.kind !== 'execution_unavailable' && off.kind !== 'unavailable' && (
        <p className="nx-muted" role="status">{off.text} {off.retry && <Button variant="quiet" onClick={jobs.reload}>Try again</Button>}</p>
      )}
      {!jobs.loaded && !off && <p className="nx-muted" role="status">Reading jobs…</p>}
      {jobs.loaded && !off && (jobs.data ?? []).length === 0 && <p className="nx-muted">No jobs have run for this project.</p>}
      {(jobs.data ?? []).length > 0 && (
        <ul className="nx-runs">
          {(jobs.data ?? []).map((j, i) => <li key={j.id}><JobRow job={j} explain={i < 5} jobs={jobs.data ?? []} deployments={deployments.data} /></li>)}
        </ul>
      )}
    </section>
  );
}

/** Jobs of this project (persisted), then the requests sent from it in this session, newest first. */
export function ProjectRuns({ projectId }: { projectId: string }) {
  const port = useAssistant();
  const setDraft = useNexusUi((s) => s.setDraft);
  const focusIntent = useNexusUi((s) => s.focusIntent);
  const entries = useRuns().filter((e) => e.request.projectId === projectId).reverse();
  return (
    <section className="nx-surface" aria-labelledby="nx-surface-title">
      <h1 id="nx-surface-title" className="nx-surface__title" tabIndex={-1}>Runs</h1>
      <JobsSection projectId={projectId} />
      <h2 className="nx-xj__title">Requests sent this session</h2>
      {entries.length === 0 ? (
        <p className="nx-muted">No requests sent from this project in this session. Requests you send with the intent line appear here.</p>
      ) : (
        <ul className="nx-runs">
          {entries.map(({ request, run }) => (
            <li key={request.id}>
              <RunStrip
                run={run}
                onOpenConversation={port.openConversation}
                // Prefill only: the user reviews and sends it themselves.
                onRetry={() => { setDraft(request.text); focusIntent(); }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
