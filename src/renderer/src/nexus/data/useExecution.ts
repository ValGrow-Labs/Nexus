// The renderer's execution data (B2a channels #22-#40) as hooks. One nexus:hint
// subscription is shared by every mounted hook; hints are coalesced (one events
// pull at a time, at most every HINT_COALESCE_MS) and only the lists the new
// events touch are read again (data/executionModel.ts affectedLists). A channel
// that main has not registered answers "execution unreachable", never a crash.
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type {
  ActionAvailabilityView, ApprovalView, DeploymentView, DomainSpecView, HealthView, JobDetailView, JobView, NexusResult, ValidationResultView
} from '@shared/nexus/ipc';
import { nexusClient, newIntentId } from './nexusClient';
import { usePlatform } from './platformStore';
import { affectedLists, availabilityFrom, type ExecAvailability, type ExecList } from './executionModel';
import { bundledDomainViews } from '../workspaces/lifecycleModel';

export const HINT_COALESCE_MS = 300;
const EVENTS_PAGE = 500;

interface ExecStore {
  health: NexusResult<HealthView> | null;
  ticks: Record<ExecList, number>;
  bump: (lists: Iterable<ExecList>) => void;
  setHealth: (r: NexusResult<HealthView>) => void;
}

export const useExecStore = create<ExecStore>((set) => ({
  health: null,
  ticks: { jobs: 0, approvals: 0, deployments: 0, validations: 0, health: 0, artifacts: 0 },
  bump: (lists) => set((s) => {
    const ticks = { ...s.ticks };
    for (const l of lists) ticks[l] += 1;
    return { ticks };
  }),
  setHealth: (r) => set({ health: r })
}));

// ---------- the one hint subscription ----------

let subscribers = 0;
let unsubscribe: (() => void) | null = null;
let knownSeq: number | null = null;
let wantedSeq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let pulling = false;
const ALL: ExecList[] = ['jobs', 'approvals', 'deployments', 'validations', 'health', 'artifacts'];

function applyLists(lists: Set<ExecList>): void {
  const store = useExecStore.getState();
  // Artifacts are read through the platform rev (useProjectArtifacts); bump it only when events touched them.
  if (lists.has('artifacts')) usePlatform.getState().bumpRev();
  lists.delete('artifacts');
  if (lists.size > 0) store.bump(lists);
}

async function pull(): Promise<void> {
  timer = null;
  if (pulling) return;
  pulling = true;
  try {
    while (knownSeq !== null && knownSeq < wantedSeq) {
      const r = await nexusClient.eventsSince({ sinceSeq: knownSeq, limit: EVENTS_PAGE });
      if (!r.ok) { applyLists(new Set(ALL)); knownSeq = wantedSeq; break; }
      const lists = affectedLists(r.data.events);
      const before = knownSeq;
      const last = r.data.events.length ? r.data.events[r.data.events.length - 1].seq : wantedSeq;
      knownSeq = Math.max(knownSeq, last, r.data.events.length < EVENTS_PAGE ? wantedSeq : last);
      applyLists(lists);
      // A page that does not move the cursor would loop forever: stop, and let the next hint try again.
      if (knownSeq <= before) break;
    }
  } finally {
    pulling = false;
    if (knownSeq !== null && knownSeq < wantedSeq && !timer) timer = setTimeout(() => { void pull(); }, HINT_COALESCE_MS);
  }
}

function onHint(lastSeq: number): void {
  if (knownSeq === null) {
    // The first hint: what changed before it is unknown, so every list is read once.
    knownSeq = lastSeq; wantedSeq = lastSeq;
    applyLists(new Set(ALL));
    return;
  }
  if (lastSeq <= wantedSeq) return;
  wantedSeq = lastSeq;
  if (!timer && !pulling) timer = setTimeout(() => { void pull(); }, HINT_COALESCE_MS);
}

export function useHints(): void {
  useEffect(() => {
    subscribers += 1;
    if (subscribers === 1) unsubscribe = nexusClient.onHint((h) => onHint(h.lastSeq));
    return () => {
      subscribers -= 1;
      if (subscribers === 0) {
        unsubscribe?.(); unsubscribe = null;
        if (timer) { clearTimeout(timer); timer = null; }
        knownSeq = null; wantedSeq = 0;
      }
    };
  }, []);
}

// ---------- a list read: stale answers dropped, re-read on its ticks ----------

export interface Read<T> { data: T | null; fail: Extract<NexusResult<T>, { ok: false }> | null; loaded: boolean; reload: () => void }

export function useRead<T>(key: string | null, run: () => Promise<NexusResult<T>>, deps: readonly unknown[]): Read<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null; fail: Read<T>['fail']; loaded: boolean }>({ key, data: null, fail: null, loaded: false });
  const seq = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (key === null) { setState({ key, data: null, fail: null, loaded: true }); return; }
    const mine = ++seq.current;
    void run().then((r) => {
      if (mine !== seq.current) return;
      setState((prev) => (r.ok ? { key, data: r.data, fail: null, loaded: true }
        // A passing failure keeps what was read for the same key; anything else clears it.
        : { key, data: prev.key === key && (r.code === 'internal' || r.reason === 'busy') ? prev.data : null, fail: r, loaded: true }));
    });
    return () => { seq.current += 1; };
    // `run` closes over the deps listed by the caller.
  }, [key, attempt, ...deps]);
  const same = state.key === key;
  return { data: same ? state.data : null, fail: same ? state.fail : null, loaded: same && state.loaded, reload };
}

// ---------- the hooks ----------

// ---------- health: one shared read for every hook instance ----------

let healthInFlight = false;
let healthLoadedTick = -1;

/** Reads #23 once per health tick (or when forced), whichever hook asks; concurrent asks share the one read. */
function loadHealth(force: boolean): void {
  const st = useExecStore.getState();
  if (healthInFlight || (!force && healthLoadedTick === st.ticks.health)) return;
  healthInFlight = true;
  const tick = st.ticks.health;
  void nexusClient.platformHealth().then((r) => {
    healthInFlight = false;
    healthLoadedTick = tick;
    useExecStore.getState().setHealth(r);
    // A tick that arrived while this read ran is read again.
    if (useExecStore.getState().ticks.health !== tick) loadHealth(false);
  });
}

/** How long after "Check again" the cache is read again: main probes in the background and answers from its cache. */
export const CHECK_AGAIN_REREAD_MS = 1_500;

/**
 * "Check again": #23 with `{ probe: true }` asks main for a fresh probe of this computer (at most one per 5 s there)
 * and answers from the cache at once; the fresh facts are read again shortly after (and by the sheet's poll).
 */
function checkAgain(): void {
  void nexusClient.platformHealthProbe().then((r) => {
    useExecStore.getState().setHealth(r);
    setTimeout(() => loadHealth(true), CHECK_AGAIN_REREAD_MS);
  });
}

/** Health (#23) and where execution stands. One read is shared by every mounted hook; it is read again on
 *  image, preflight and recovery events, and on `refresh`. `checkAgain` also asks main for a fresh probe. */
export function useHealth(): { health: HealthView | null; availability: ExecAvailability; refresh: () => void; checkAgain: () => void } {
  useHints();
  const health = useExecStore((s) => s.health);
  const tick = useExecStore((s) => s.ticks.health);
  const unavailable = usePlatform((s) => s.unavailable);
  useEffect(() => { loadHealth(false); }, [tick]);
  const refresh = useCallback(() => loadHealth(true), []);
  return { health: health && health.ok ? health.data : null, availability: availabilityFrom({ unavailable }, health), refresh, checkAgain };
}

/** While the setup sheet is open, this computer is read again gently (main answers from its cache). */
export const HEALTH_POLL_MS = 15_000;
export function useHealthPoll(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => loadHealth(true), HEALTH_POLL_MS);
    return () => clearInterval(t);
  }, [active]);
}

let domainsCache: { list: DomainSpecView[]; source: 'main' | 'bundled' } | null = null;

/** The domain registry (#22). Until main answers, the registry bundled with this build (the very data main reads). */
export function useDomains(): { list: DomainSpecView[]; source: 'main' | 'bundled' } {
  const [state, setState] = useState(() => domainsCache ?? { list: bundledDomainViews(), source: 'bundled' as const });
  useEffect(() => {
    if (domainsCache?.source === 'main') return;
    let alive = true;
    void nexusClient.domainsList().then((r) => {
      if (!r.ok || !Array.isArray(r.data)) return;
      domainsCache = { list: r.data, source: 'main' };
      if (alive) setState(domainsCache);
    });
    return () => { alive = false; };
  }, []);
  return state;
}

export function useJobs(projectId: string): Read<JobView[]> {
  useHints();
  const tick = useExecStore((s) => s.ticks.jobs);
  return useRead(projectId, () => nexusClient.jobsList({ projectId, limit: 50 }), [tick]);
}

export function useJob(jobId: string | null): Read<JobDetailView> {
  useHints();
  const tick = useExecStore((s) => s.ticks.jobs);
  return useRead(jobId, () => nexusClient.jobGet(jobId!), [tick]);
}

export function useApprovals(projectId: string | null): Read<ApprovalView[]> {
  useHints();
  const tick = useExecStore((s) => s.ticks.approvals);
  return useRead(`approvals:${projectId ?? '*'}`, () => nexusClient.approvalsList(projectId ? { projectId } : undefined), [tick]);
}

export function useDeployments(projectId: string): Read<DeploymentView[]> {
  useHints();
  const tick = useExecStore((s) => s.ticks.deployments);
  return useRead(projectId, () => nexusClient.deploymentsList({ projectId }), [tick]);
}

export function useActions(projectId: string, workspaceId: string | null, versionId?: string | null): Read<ActionAvailabilityView[]> {
  useHints();
  const ticks = useExecStore((s) => s.ticks);
  const rev = usePlatform((s) => s.rev);
  const key = workspaceId ? `${projectId}:${workspaceId}:${versionId ?? ''}` : null;
  return useRead(key, () => nexusClient.actionsAvailable({ projectId, workspaceId: workspaceId!, ...(versionId ? { versionId } : {}) }),
    [ticks.health, ticks.jobs, ticks.deployments, rev]);
}

export function useValidations(versionId: string | null): Read<ValidationResultView[]> {
  useHints();
  const tick = useExecStore((s) => s.ticks.validations);
  const rev = usePlatform((s) => s.rev);
  return useRead(versionId, () => nexusClient.versionValidations(versionId!), [tick, rev]);
}

// ---------- intents: one per user intent, kept until answered (a reload re-sends it, never a second job) ----------

const INTENTS_KEY = 'nexus.pendingIntents';
function readIntents(): Record<string, string> {
  try { const v = JSON.parse(sessionStorage.getItem(INTENTS_KEY) ?? '{}') as unknown; return v && typeof v === 'object' ? v as Record<string, string> : {}; } catch { return {}; }
}
function writeIntents(m: Record<string, string>): void {
  try { sessionStorage.setItem(INTENTS_KEY, JSON.stringify(m)); } catch { /* storage off: the intent lives for this call only */ }
}

/** The intent for a request key: the pending one if a send was not answered yet, else a new one. */
export function intentFor(requestKey: string): string {
  const m = readIntents();
  if (m[requestKey]) return m[requestKey];
  const id = newIntentId();
  writeIntents({ ...m, [requestKey]: id });
  return id;
}
/** The request was answered (either way): the next click is a new intent. */
export function settleIntent(requestKey: string): void {
  const m = readIntents();
  if (!(requestKey in m)) return;
  delete m[requestKey];
  writeIntents(m);
}

/** Send a request under its intent; the answer settles it, except a failure that never reached main. */
export async function withIntent<T>(requestKey: string, send: (intentId: string) => Promise<NexusResult<T>>): Promise<NexusResult<T>> {
  const r = await send(intentFor(requestKey));
  if (r.ok || r.code !== 'internal') settleIntent(requestKey);
  if (r.ok) useExecStore.getState().bump(['jobs', 'approvals']);
  return r;
}
