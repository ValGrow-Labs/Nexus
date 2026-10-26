// The renderer's agent data (B2b channels #43, #44, #47-#49, #51) as hooks, on the same read pattern as useExecution: stale answers
// are dropped, lists are read again on the jobs tick (agent turns are jobs), the validations tick and the platform revision.
// Nothing here polls in the background. The setup sheet alone re-asks while it is open.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentConsentView, JobView, NexusResult, RepoStatusView, SessionDetailView, SessionView, ValidationResultView } from '@shared/nexus/ipc';
import type { ReviewDecision } from '@shared/nexus/ipc';
import { nexusClient } from './nexusClient';
import { usePlatform } from './platformStore';
import { useExecStore, useHints, useRead, useJobs, type Read } from './useExecution';
import { latestReviews } from '../project/changeSetModel';
import { consentRereadDelay } from './executionModel';

/** The project's agent conversations (#43), newest first. */
export function useSessions(projectId: string | null): Read<SessionView[]> {
  useHints();
  const jobs = useExecStore((s) => s.ticks.jobs);
  const rev = usePlatform((s) => s.rev);
  return useRead(projectId, () => nexusClient.sessionsList({ projectId: projectId! }), [jobs, rev]);
}

/** One conversation with its turns, display-only messages, tool calls and registered versions (#44). */
export function useSessionDetail(sessionId: string | null, enabled: boolean): Read<SessionDetailView> {
  useHints();
  const jobs = useExecStore((s) => s.ticks.jobs);
  return useRead(enabled ? sessionId : null, () => nexusClient.sessionGet(sessionId!), [jobs]);
}

/** The repository status the accept and merge need (#49). */
export function useRepoStatus(projectId: string | null): Read<RepoStatusView> {
  useHints();
  const jobs = useExecStore((s) => s.ticks.jobs);
  const rev = usePlatform((s) => s.rev);
  return useRead(projectId, () => nexusClient.repoStatus(projectId!), [jobs, rev]);
}

/** The newest review of each change, from the project's activity (there is no review list channel): versionId to decision.
 *  A change whose review row is older than the page read is treated as not reviewed; Accept is then not offered, and the
 *  person may approve again (main refuses an accept without an approving review in any case). */
export function useReviews(projectId: string | null): { decisions: ReadonlyMap<string, ReviewDecision>; loaded: boolean; reload: () => void } {
  useHints();
  const jobs = useExecStore((s) => s.ticks.jobs);
  const rev = usePlatform((s) => s.rev);
  const read = useRead(projectId, () => nexusClient.activityByProject(projectId!, { limit: 50 }), [jobs, rev]);
  const decisions = useMemo(() => (read.data ? latestReviews(read.data) : new Map<string, ReviewDecision>()), [read.data]);
  return { decisions, loaded: read.loaded, reload: read.reload };
}

/** The checks of a change (#32). */
export function useChangeChecks(versionId: string | null): Read<ValidationResultView[]> {
  useHints();
  const tick = useExecStore((s) => s.ticks.validations);
  const rev = usePlatform((s) => s.rev);
  return useRead(versionId, () => nexusClient.versionValidations(versionId!), [tick, rev]);
}

/** The live turn jobs of a project's conversations, by job id (for the waiting reason). */
export function useTurnJobs(projectId: string): ReadonlyMap<string, JobView> {
  const jobs = useJobs(projectId);
  return useMemo(() => new Map((jobs.data ?? []).filter((j) => j.kind === 'agent.run').map((j) => [j.id, j] as const)), [jobs.data]);
}

/** How often the open setup sheet asks main for the permission row again (main answers from its on-demand probe cache). */
export const CONSENT_REASK_MS = 45_000;

/**
 * The agent's permission row for the setup sheet (#51 get): read once when the sheet opens and again every CONSENT_REASK_MS
 * only while it stays open (no background timer). #51 never waits, so an answer that has no destination yet is read again a
 * bounded number of times (consentRereadDelay) after the probe had time to land. `act` grants or revokes and answers the new row
 * (or the failure); the shared health is read again after it. Only the destinations are taken from this answer.
 */
export function useAgentConsent(open: boolean): {
  view: AgentConsentView | null; fail: Extract<NexusResult<AgentConsentView>, { ok: false }> | null; loaded: boolean;
  act: (op: 'grant' | 'revoke') => Promise<NexusResult<AgentConsentView>>; reload: () => void; reloadAfter: (ms: number) => void;
} {
  const [state, setState] = useState<{ view: AgentConsentView | null; fail: Extract<NexusResult<AgentConsentView>, { ok: false }> | null; loaded: boolean }>(
    { view: null, fail: null, loaded: false });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const reloadAfter = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setAttempt((n) => n + 1); }, ms);
  }, []);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let again: ReturnType<typeof setTimeout> | null = null;
    const read = (tries: number) => { void nexusClient.agentConsent({ op: 'get' }).then((r) => {
      if (!alive) return;
      setState((prev) => (r.ok ? { view: r.data, fail: null, loaded: true } : { view: prev.view, fail: r, loaded: true }));
      const delay = r.ok ? consentRereadDelay(r.data, tries) : null;
      if (delay !== null) again = setTimeout(() => { if (alive) read(tries + 1); }, delay);
    }); };
    read(0);
    const t = setInterval(() => read(0), CONSENT_REASK_MS);
    return () => { alive = false; clearInterval(t); if (again) clearTimeout(again); };
  }, [open, attempt]);
  const act = useCallback(async (op: 'grant' | 'revoke') => {
    const r = await nexusClient.agentConsent({ op });
    if (r.ok) setState({ view: r.data, fail: null, loaded: true });
    // The permission changed: the shared health (the panel's facts) is read again.
    useExecStore.getState().bump(['health', 'jobs']);
    return r;
  }, []);
  return { view: state.view, fail: state.fail, loaded: state.loaded, act, reload, reloadAfter };
}
