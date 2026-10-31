import { useEffect, useMemo, useRef, useState } from 'react';
import { nexusClient } from '../data/nexusClient';
import { execFailText } from '../data/errorCopy';
import { useDeployments, useExecStore, useHealth, withIntent } from '../data/useExecution';
import { useNexusUi } from '../state/uiStore';
import { Button } from '../ui/Button';
import { useExecutionUi } from './execContext';
import { PreviewPanel } from './PreviewPanel';
import {
  PREVIEW_ASK_HELPER, PREVIEW_INTRO, PREVIEW_LIMITS, PREVIEW_TITLE, isLive, runPreviewChain, stepWords, type ChainClient, type PreviewStep
} from './previewModel';
import { TRY_SETUP_TEXT } from './tryModel';

const POLL_MS = 1_500;
const JOB_WAIT_MS = 12 * 60_000;
const VERSION_WAIT_MS = 60_000;
const DEPLOYMENT_WAIT_MS = 120_000;
const ENDED = ['completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted'] as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The project's Preview: one press runs the four steps (save a starting point, build, get ready, start) for the project as it stands and shows the
 * running app in an isolated panel inside Nexus. One preview per project (a new press stops the earlier one first); Stop, Reload and Open in browser.
 * Nothing runs until the button is pressed.
 */
export function ProjectPreview({ projectId }: { projectId: string }) {
  const ui = useExecutionUi();
  const { availability } = useHealth();
  const deployments = useDeployments(projectId);
  const [step, setStep] = useState<PreviewStep | null>(null);
  const [fail, setFail] = useState<{ text: string; askHelper: boolean } | null>(null);
  const [stopping, setStopping] = useState(false);
  const cancelled = useRef(false);
  const currentJob = useRef<string | null>(null);
  const nonce = useRef(0);

  const live = useMemo(() => [...(deployments.data ?? [])].filter(isLive).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null, [deployments.data]);
  const ready = availability.kind === 'ready';
  const working = step !== null;
  // The newest deployment, live or just ended, so the panel can say how it ended.
  const latest = useMemo(() => [...(deployments.data ?? [])].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null, [deployments.data]);
  useEffect(() => { if (live) setFail(null); }, [live]);

  const client = (): ChainClient => ({
    async start(s, actionId, inputs) {
      nonce.current += 1;
      const r = await withIntent(`preview:${projectId}:${s}:${nonce.current}:${Date.now()}`, (intentId) => nexusClient.jobStart({ projectId, workspaceId: 'sde', actionId, inputs, params: {}, intentId }));
      if (!r.ok) return { ok: false, text: execFailText(r) };
      currentJob.current = r.data.job.id;
      return { ok: true, jobId: r.data.job.id };
    },
    async waitJob(jobId) {
      const until = Date.now() + JOB_WAIT_MS;
      while (Date.now() < until) {
        if (cancelled.current) return { state: 'cancelled', outputs: [], why: null };
        const r = await nexusClient.jobGet(jobId);
        if (r.ok && (ENDED as readonly string[]).includes(r.data.state)) return { state: r.data.state as 'completed', outputs: r.data.outputs.map((o) => o.versionId), why: null };
        await sleep(POLL_MS);
      }
      return { state: 'timed_out', outputs: [], why: null };
    },
    async waitVersion(versionId) {
      const until = Date.now() + VERSION_WAIT_MS;
      let status = 'draft';
      while (Date.now() < until) {
        if (cancelled.current) return 'cancelled';
        const r = await nexusClient.versionGet(versionId);
        if (r.ok) { status = r.data.status; if (status !== 'draft') return status; }
        await sleep(500);
      }
      return status;
    },
    async latestOf(kind) {
      const r = await nexusClient.artifactsByProject(projectId);
      if (!r.ok) return null;
      const hit = r.data.filter((a) => a.artifact.kind === kind && a.latest).sort((a, b) => b.latest!.versionNo - a.latest!.versionNo)[0];
      return hit && hit.latest ? hit.latest.id : null;
    },
    async stopLive() {
      const r = await nexusClient.deploymentsList({ projectId });
      if (!r.ok) return;
      for (const d of r.data.filter(isLive)) await nexusClient.deploymentStop(d.id);
    },
    async waitDeployment(jobId) {
      const until = Date.now() + DEPLOYMENT_WAIT_MS;
      while (Date.now() < until) {
        if (cancelled.current) return { id: '', ok: false, why: null };
        const r = await nexusClient.deploymentsList({ projectId });
        const d = r.ok ? r.data.find((x) => x.jobId === jobId) : undefined;
        if (d && d.status === 'healthy') return { id: d.id, ok: true, why: null };
        if (d && !isLive(d)) return { id: d.id, ok: false, why: null };
        if (!d) {
          const j = await nexusClient.jobGet(jobId);
          if (j.ok && (ENDED as readonly string[]).includes(j.data.state)) return { id: '', ok: false, why: null };
        }
        await sleep(POLL_MS);
      }
      return { id: '', ok: false, why: 'It did not answer in time.' };
    }
  });

  const start = async () => {
    if (working || !ready) return;
    cancelled.current = false; setFail(null); setStep('snapshot');
    try {
      const res = await runPreviewChain(client(), (s) => setStep(s));
      if (!res.ok && !cancelled.current) setFail({ text: res.text, askHelper: res.askHelper });
    } finally { setStep(null); currentJob.current = null; useExecStore.getState().bump(['deployments', 'jobs']); }
  };
  const cancel = async () => {
    cancelled.current = true;
    if (currentJob.current) await nexusClient.jobCancel(currentJob.current);
    useExecStore.getState().bump(['deployments', 'jobs']);
  };
  const stop = async () => {
    if (!live || stopping) return;
    setStopping(true);
    await nexusClient.deploymentStop(live.id);
    setStopping(false);
    useExecStore.getState().bump(['deployments', 'jobs']);
  };
  const askHelper = () => { useNexusUi.getState().setDraft(PREVIEW_ASK_HELPER); useNexusUi.getState().focusIntent(); };

  return (
    <section className="nx-previewsec" aria-label={PREVIEW_TITLE}>
      <h3 className="nx-cs__sub">{PREVIEW_TITLE}</h3>
      <p className="nx-muted">{PREVIEW_INTRO}</p>
      <p className="nx-muted">{PREVIEW_LIMITS}</p>
      {!ready && !working && (
        <p className="nx-try__setup" role="status">{TRY_SETUP_TEXT} {ui && <Button variant="quiet" onClick={() => ui.openSetup()}>Get this computer ready</Button>}</p>
      )}
      <div className="nx-previewsec__acts">
        <Button variant="primary" disabled={working || !ready} onClick={() => { void start(); }}>{live ? 'Preview again' : 'Preview'}</Button>
        {working && <Button variant="quiet" onClick={() => { void cancel(); }}>Cancel</Button>}
        {step && <span className="nx-previewsec__step" role="status">{stepWords(step)}</span>}
      </div>
      {fail && (
        <p className="nx-passport__note" role="alert">{fail.text}{' '}
          {fail.askHelper && <Button variant="quiet" onClick={askHelper}>Ask the AI helper to make it runnable</Button>}</p>
      )}
      {live ? <PreviewPanel deployment={live} onStop={() => { void stop(); }} stopping={stopping} />
        : latest && !working && <PreviewPanel deployment={latest} onStop={() => undefined} stopping={false} />}
    </section>
  );
}
