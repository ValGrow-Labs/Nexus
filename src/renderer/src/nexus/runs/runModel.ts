export type StageId = 'context' | 'plan' | 'execute' | 'output' | 'review';
export type StageState = 'done' | 'active' | 'waiting' | 'pending' | 'unreported';
export type RunView = { id: string; title: string; headline: string; stages: { id: StageId; label: string; state: StageState }[]; needsInput: boolean; agentOffline: boolean };

const LABELS: Record<StageId, string> = { context: 'Your request', plan: 'Plan', execute: 'Work', output: 'Result', review: 'Look over' };
const WORKING = new Set(['working', 'thinking']);

/** The lead AI helper reports only queue state, acknowledged deliveries and its
 *  terminal status. Plan, output and review stay "unreported" until an
 *  AgentRuntime provides them.
 *  - queued: the message is still in the agent's queue;
 *  - delivered: the drain acknowledged writing it to the agent's terminal;
 *  - isLatestDelivered: it is the last message delivered to that agent, so the
 *    agent's live status (working / blocked) can be attributed to it. */
export function leadAgentRun(input: {
  request: { id: string; text: string; sentAt: number };
  queued: boolean; delivered: boolean; isLatestDelivered: boolean;
  agentPresent: boolean; agentStatus: string | null; blocked: boolean;
}): RunView {
  const { queued, delivered, isLatestDelivered, agentPresent, agentStatus, blocked } = input;
  const live = delivered && isLatestDelivered && agentPresent;
  let execute: StageState; let headline: string;
  if (queued && !agentPresent) { execute = 'pending'; headline = 'Waiting. The lead AI helper is not running. Open Agents to start it'; }
  else if (queued) { execute = 'pending'; headline = 'Waiting for the lead AI helper to pick it up'; }
  else if (live && blocked) { execute = 'waiting'; headline = 'The lead AI helper is waiting for you. Open Agents to answer it'; }
  else if (live && agentStatus && WORKING.has(agentStatus)) { execute = 'active'; headline = 'The lead AI helper is working on it'; }
  else if (delivered) { execute = 'unreported'; headline = 'Handed to the lead AI helper. Open Agents to see its reply'; }
  // Removing an agent deletes its queue, so without the agent we cannot say more.
  else if (!agentPresent) { execute = 'unreported'; headline = 'Nexus can no longer follow this. The lead AI helper it went to is not running'; }
  // Removed or cleared by the user, or dropped by the drain after failed writes.
  else { execute = 'unreported'; headline = 'It was taken off the waiting list before the lead AI helper got it. Send it again'; }
  const state: Record<StageId, StageState> = { context: 'done', plan: 'unreported', execute, output: 'unreported', review: 'unreported' };
  return {
    id: input.request.id,
    title: input.request.text.trim().slice(0, 80),
    headline,
    stages: (Object.keys(LABELS) as StageId[]).map((id) => ({ id, label: LABELS[id], state: state[id] })),
    needsInput: execute === 'waiting',
    agentOffline: !agentPresent
  };
}

export type RunRequest = { id: string; agentId: string; queuedMessageId: string; text: string; sentAt: number };
export type RunAgent = { id: string; status: string; running: boolean; blocked: boolean };
export type DeliveryRecord = { deliveredIds: Record<string, true>; lastDelivered: Record<string, string> };

/** Derives each request's run from real store state only: the agent's queue,
 *  the drain's acknowledged deliveries, and the agent record. */
export function runsFor(
  requests: RunRequest[],
  agents: RunAgent[],
  queues: Record<string, { id: string }[] | undefined>,
  delivery: DeliveryRecord
): RunView[] {
  return requests.map((r) => {
    const agent = agents.find((a) => a.id === r.agentId);
    return leadAgentRun({
      request: r,
      queued: !!queues[r.agentId]?.some((m) => m.id === r.queuedMessageId),
      delivered: !!delivery.deliveredIds[r.queuedMessageId],
      isLatestDelivered: delivery.lastDelivered[r.agentId] === r.queuedMessageId,
      agentPresent: !!agent?.running,
      agentStatus: agent ? agent.status : null,
      blocked: !!agent?.blocked
    });
  });
}

/** A run that is still in motion: queued, working, or waiting on the user. */
export function isRunLive(run: RunView): boolean {
  const ex = run.stages.find((s) => s.id === 'execute')?.state;
  return ex === 'pending' || ex === 'active' || ex === 'waiting';
}
