import { useEffect, useMemo, useRef, useState } from 'react';
import { nexusClient } from '../data/nexusClient';
import { execFailText } from '../data/errorCopy';
import { useApprovals, useDeployments, useExecStore, useHealth, withIntent } from '../data/useExecution';
import { useNexusUi } from '../state/uiStore';
import { Button } from '../ui/Button';
import { ApprovalList } from './ApprovalsSection';
import { useExecutionUi } from './execContext';
import { PreviewPanel } from './PreviewPanel';
import {
  PREVIEW_ASK_HELPER, PREVIEW_ASK_HELPER_DEPS, PREVIEW_DEPS_WAITING, PREVIEW_INTRO, PREVIEW_LIMITS, PREVIEW_TITLE, PREVIEW_UPDATED, isLive, runChangePreview, runPreviewChain, stepWords, type ChainClient, type PreviewStep
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
export function ProjectPreview({ projectId, versionId = null, newest = null }: { projectId: string; /** A suggested change to run; none: the project as it stands. */ versionId?: string | null; /** The newest suggested change waiting (a follow-up replaces the one being previewed). */ newest?: { versionId: string } | null }) {
  const ui = useExecutionUi();
  const { availability } = useHealth();
  const deployments = useDeployments(projectId);
  const [step, setStep] = useState<PreviewStep | null>(null);
  const [fail, setFail] = useState<{ text: string; askHelper: boolean; askKind?: 'deps' } | null>(null);
  const approvals = useApprovals(projectId);
  // The download question of the add-ons step, shown here while the steps run (the same question the Approvals list shows).
  const depsQuestion = useMemo(() => (approvals.data ?? []).filter((a) => a.status === 'pending' && a.reason === 'egress.deps'), [approvals.data]);
  const [stopping, setStopping] = useState(false);
  const [updated, setUpdated] = useState(false);
  const cancelled = useRef(false);
  const currentJob = useRef<string | null>(null);
  const nonce = useRef(0);
  const asked = useRef(new Set<string>());

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
      if (!r.ok) return { ok: false, text: execFailText(r), skip: r.reason === 'no_dependencies' || r.reason === 'deps_ready' };
      currentJob.current = r.data.job.id;
      return { ok: true, jobId: r.data.job.id };
    },
    async waitJob(jobId) {
      const until = Date.now() + JOB_WAIT_MS;
      while (Date.now() < until) {
        if (cancelled.current) return { state: 'cancelled', outputs: [], why: null };
        const r = await nexusClient.jobGet(jobId);
        if (r.ok && (ENDED as readonly string[]).includes(r.data.state)) {
          return { state: r.data.state as 'completed', outputs: r.data.outputs.map((o) => o.versionId), why: null, code: r.data.error?.code ?? null };
        }
        // A job that waits for the download question: make sure the question is on the screen.
        if (r.ok && r.data.headline === 'waiting_for_approval' && !asked.current.has(jobId)) { asked.current.add(jobId); useExecStore.getState().bump(['approvals', 'jobs']); }
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

  const start = async (changeId: string | null = versionId) => {
    if (working || !ready) return;
    cancelled.current = false; setFail(null); setStep(changeId ? 'start' : 'snapshot');
    try {
      const base = client();
      const res = changeId
        ? await runChangePreview({
          stopLive: base.stopLive,
          startChange: async () => {
            nonce.current += 1;
            const r = await withIntent(`preview:${projectId}:${changeId}:${nonce.current}:${Date.now()}`, (intentId) => nexusClient.tryRun({ op: 'run', projectId, versionId: changeId, what: 'preview', intentId }));
            if (!r.ok) return { ok: false as const, text: execFailText(r) };
            if (!('job' in r.data)) return { ok: false as const, text: 'Nexus could not start the preview.' };
            currentJob.current = r.data.job.id;
            return { ok: true as const, jobId: r.data.job.id };
          },
          waitDeployment: base.waitDeployment
        }, (s) => setStep(s))
        : await runPreviewChain(base, (s) => setStep(s));
      if (!res.ok && !cancelled.current) setFail({ text: res.text, askHelper: res.askHelper, ...('askKind' in res && res.askKind ? { askKind: res.askKind } : {}) });
    } finally { setStep(null); currentJob.current = null; useExecStore.getState().bump(['deployments', 'jobs']); }
  };
  // A follow-up message changed the app: the change being previewed has a newer version, so the preview starts again with it (the person already started this preview).
  const liveSubject = live ? live.subjectVersionId : null;
  useEffect(() => {
    if (!live || !newest || working || !ready || liveSubject === newest.versionId) return undefined;
    let alive = true;
    void Promise.all([nexusClient.versionGet(liveSubject!), nexusClient.versionGet(newest.versionId)]).then(([a, b]) => {
      if (!alive || !a.ok || !b.ok || a.data.artifactId !== b.data.artifactId || a.data.id === b.data.id) return;
      setUpdated(true);
      void start(newest.versionId);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSubject, newest?.versionId, working, ready]);
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
  const askHelper = () => { useNexusUi.getState().setDraft(fail?.askKind === 'deps' ? PREVIEW_ASK_HELPER_DEPS : PREVIEW_ASK_HELPER); useNexusUi.getState().focusIntent(); };

  return (
    <section className="nx-previewsec" aria-label={PREVIEW_TITLE}>
      <h3 className="nx-cs__sub">{PREVIEW_TITLE}</h3>
      <p className="nx-muted">{PREVIEW_INTRO}</p>
      <details className="nx-fb__more">
        <summary>How it works</summary>
        <p className="nx-muted">{PREVIEW_LIMITS}</p>
      </details>
      {!ready && !working && (
        <p className="nx-try__setup" role="status">{TRY_SETUP_TEXT} {ui && <Button variant="quiet" onClick={() => ui.openSetup()}>Get this computer ready</Button>}</p>
      )}
      <div className="nx-previewsec__acts">
        <Button variant="primary" disabled={working || !ready} onClick={() => { setUpdated(false); void start(); }}>{live ? 'Preview again' : 'Preview'}</Button>
        {working && <Button variant="quiet" onClick={() => { void cancel(); }}>Cancel</Button>}
        {step && <span className="nx-previewsec__step" role="status">{stepWords(step)}</span>}
      </div>
      {working && depsQuestion.length > 0 && (
        <div className="nx-previewsec__ask">
          <p className="nx-muted" role="status">{PREVIEW_DEPS_WAITING}</p>
          <ApprovalList approvals={depsQuestion} label="The download question" />
        </div>
      )}
      {updated && live && !working && <p className="nx-muted" role="status">{PREVIEW_UPDATED}</p>}
      {fail && (
        <p className="nx-passport__note" role="alert">{fail.text}{' '}
          {fail.askHelper && <Button variant="quiet" onClick={askHelper}>{fail.askKind === 'deps' ? 'Ask the AI helper to fix the add-ons' : 'Ask the AI helper to make it runnable'}</Button>}</p>
      )}
      {live ? <PreviewPanel deployment={live} onStop={() => { void stop(); }} stopping={stopping} />
        : latest && !working && <PreviewPanel deployment={latest} onStop={() => undefined} stopping={false} />}
    </section>
  );
}
