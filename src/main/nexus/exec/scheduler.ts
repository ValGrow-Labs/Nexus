/**
 * The scheduler's rules: caps, guards and the order in which queued jobs are considered.
 * Pure (no I/O); ExecutionService.tick applies them against the database and the cached
 * runner probe, one IMMEDIATE lease transaction per job.
 *
 * Order of a tick (ExecutionService.tick):
 *   1. due retries (`retry_scheduled`, `next_attempt_at <= now`) -> `queued`;
 *   2. the timeout sweep and the heartbeat-gap sweep;
 *   3. queued `tool.run` jobs with a recipe, by `ix_jobs_sched` (state, priority, created_at;
 *      priority 0 first), each checked against the guards below. A job that does not fit stays
 *      `queued` with `phase` set to the reason; one that fits is leased.
 * No lease at all while blob GC holds its exclusive lock (the blob store contract): the tick
 * leaves every queued job as it is and the next tick tries again.
 *
 * Guards (first failing one wins): runner ready -> Docker running (container recipes) ->
 * profile image present and matching (a dev deployment also needs the `nexus-fwd` forwarder image) ->
 * free space at the data home >= the lease floor ->
 * slots (job containers, service containers) -> memory budget. Engine recipes (no container)
 * need only the runner.
 */
import type { ImageStatus, SandboxProbe, SandboxProfileId } from '../../../shared/nexus/execution';
import type { RecipeDef } from '../../../shared/nexus/recipes';
import { leaseFloorBytes } from '../../../shared/nexus/resourceGate';
import { AGENT_TURN_MEMORY_MB } from './planBuilder';

export interface SchedulerCaps {
  /** Share of Docker's memory that live containers may reserve. */
  memoryShare: number;
  jobContainers: number;
  serviceContainers: number;
  /** Queued or live jobs per project; `start` refuses beyond it (`queue_full`). */
  perProjectQueue: number;
  /** How often the cached probe is refreshed (a `probe` message to the runner). */
  probeRefreshMs: number;
}

export const DEFAULT_CAPS: SchedulerCaps = Object.freeze({
  memoryShare: 0.6, jobContainers: 3, serviceContainers: 2, perProjectQueue: 20, probeRefreshMs: 60_000
});

/** The one container let through above the share when nothing is live may still use at most this much of Docker's memory. */
export const SOLO_MEMORY_SHARE = 0.85;

export type WaitReason = 'waiting:runner' | 'waiting:docker' | 'waiting:image' | 'waiting:disk' | 'waiting:slots' | 'waiting:memory';

/** The cached facts a lease decision reads; never waits on the runner. */
export interface ProbeCache {
  probe: SandboxProbe;
  images: ImageStatus[];
  freeBytes: number | null;
  at: number;
}

/** What is live right now (attempts in `starting` or `running`). */
export interface LiveUse { jobContainers: number; serviceContainers: number; reservedMemoryMb: number }

export interface LeaseCandidate { recipe: RecipeDef; profile: SandboxProfileId | null; memoryMb: number }

/** The image a profile runs, as the probe saw it; null when missing or not matching its pin. */
export function usableImage(cache: ProbeCache | null, profile: SandboxProfileId | null): ImageStatus | null {
  if (!cache || !profile) return null;
  const s = cache.images.find((i) => i.profile === profile);
  return s && s.present === true && s.digestMatches === true && typeof s.imageId === 'string' ? s : null;
}

/** The first guard a candidate fails, or null when it may be leased now. */
export function leaseGuard(c: LeaseCandidate, runnerReady: boolean, cache: ProbeCache | null, live: LiveUse, caps: SchedulerCaps): WaitReason | null {
  if (!runnerReady) return 'waiting:runner';
  if (c.recipe.executor === 'engine') return null;
  if (!cache || cache.probe.docker !== 'running') return 'waiting:docker';
  if (!usableImage(cache, c.profile)) return 'waiting:image';
  // A dev deployment (service recipe) runs its app behind the loopback forwarder: both images must be usable.
  if (c.recipe.executor === 'service' && !usableImage(cache, 'nexus-fwd')) return 'waiting:image';
  // An approved install reaches its registries only through the Nexus egress proxy, which runs in the sde-node image.
  if (c.recipe.network === 'egress-approved' && !usableImage(cache, 'sde-node')) return 'waiting:image';
  const floor = leaseFloorBytes(c.recipe.limits?.outputMaxBytes ?? 0);
  if (cache.freeBytes === null || cache.freeBytes < floor) return 'waiting:disk';
  if (c.recipe.executor === 'service' ? live.serviceContainers >= caps.serviceContainers : live.jobContainers >= caps.jobContainers) {
    return 'waiting:slots';
  }
  const dockerMb = typeof cache.probe.memoryBytes === 'number' ? cache.probe.memoryBytes / 2 ** 20 : 0;
  const budgetMb = dockerMb * caps.memoryShare;
  // Nothing live: the first container is let through even above the share (it could never run otherwise);
  // Docker itself refuses one that cannot fit at all (a create fault, failed infra_error).
  const nothingLive = live.jobContainers + live.serviceContainers === 0;
  if (!nothingLive && live.reservedMemoryMb + c.memoryMb > budgetMb) return 'waiting:memory';
  // ... but only up to 85 % of Docker's memory: above that it waits, and setup says Docker needs more memory.
  if (nothingLive && (dockerMb <= 0 || c.memoryMb > dockerMb * SOLO_MEMORY_SHARE)) return 'waiting:memory';
  return null;
}

/**
 * Agent turns (B2b Task 10). A turn is no recipe: it needs the runner (with its loopback MCP server), the agent runtime,
 * the user's consent, the budget and the hourly rate, one live turn at a time (`concurrentTurns`), and then a container
 * slot like any other container job (its own 1024 MiB). A turn that waits stays `queued` and `jobs.phase` names why;
 * the job's headline stays `queued` (the closed headline set is unchanged; the reason is the phase).
 */
export const AGENT_TURN_WAITS = ['waiting:runner', 'waiting:runtime', 'waiting:consent', 'waiting:budget', 'waiting:rate', 'waiting:slots',
  'waiting:docker', 'waiting:image', 'waiting:disk', 'waiting:memory', 'waiting:approval', 'waiting:worktree'] as const;
export type AgentWaitReason = typeof AGENT_TURN_WAITS[number];

/** What the scheduler knows about the policy side of a queued turn (BudgetService and the runtime health cache). */
export interface AgentPolicyFacts {
  /** The runner is attached and ready, with a loopback MCP server (its `ready` carried a URL). */
  runnerReady: boolean;
  /** The cached health of the agent runtime: true when it is installed, supported and signed in. */
  runtimeOk: boolean;
  /** `startGuard`'s answer for this project, with the turn itself left out of the live and hourly counts. */
  guard: 'ok' | 'consent_missing' | 'budget_exhausted' | 'rate_limited';
  /** Turns holding a slot now (leased, running or waiting for approval), the turn being leased left out, and the cap. */
  liveTurns: number; concurrentTurns: number;
}

/**
 * The first guard a queued turn fails, or null when it may be leased now: the runner, the runtime, consent, budget, rate,
 * concurrency, then the container guards of any tool job (Docker, the profile image, disk, slots, memory).
 */
export function agentTurnGuard(f: AgentPolicyFacts, profile: SandboxProfileId | null, cache: ProbeCache | null, live: LiveUse, caps: SchedulerCaps):
  AgentWaitReason | null {
  if (!f.runnerReady) return 'waiting:runner';
  if (!f.runtimeOk) return 'waiting:runtime';
  if (f.guard === 'consent_missing') return 'waiting:consent';
  if (f.guard === 'budget_exhausted') return 'waiting:budget';
  if (f.guard === 'rate_limited') return 'waiting:rate';
  if (f.liveTurns >= f.concurrentTurns) return 'waiting:slots';
  if (!cache || cache.probe.docker !== 'running') return 'waiting:docker';
  if (!usableImage(cache, profile)) return 'waiting:image';
  if (cache.freeBytes === null || cache.freeBytes < leaseFloorBytes(0)) return 'waiting:disk';
  if (live.jobContainers >= caps.jobContainers) return 'waiting:slots';
  const dockerMb = typeof cache.probe.memoryBytes === 'number' ? cache.probe.memoryBytes / 2 ** 20 : 0;
  const nothingLive = live.jobContainers + live.serviceContainers === 0;
  if (!nothingLive && live.reservedMemoryMb + AGENT_TURN_MEMORY_MB > dockerMb * caps.memoryShare) return 'waiting:memory';
  if (nothingLive && (dockerMb <= 0 || AGENT_TURN_MEMORY_MB > dockerMb * SOLO_MEMORY_SHARE)) return 'waiting:memory';
  return null;
}

/** The backoff before retry `attempts + 1` (10 s, 60 s, 300 s, then the last one again). */
export function backoffMs(backoff: readonly number[], attempts: number): number {
  if (backoff.length === 0) return 10_000;
  return backoff[Math.min(Math.max(attempts - 1, 0), backoff.length - 1)];
}
