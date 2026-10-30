export interface AssistantTarget { id: string; name: string; kind: 'lead-agent' | (string & {}) }
export type AssistantStatus =
  | { state: 'unavailable'; reason: string }
  | { state: 'starting'; target: AssistantTarget }
  | { state: 'ready'; target: AssistantTarget; deliveryPaused: boolean };
export type SendResult = { ok: true; target: AssistantTarget; queuedMessageId: string } | { ok: false; error: string };

/** What the assistant UI needs from whatever answers it. Phase A: the lead
 *  agent. A future provider (e.g. Hermes) implements this same interface and
 *  is selected in useAssistant() — the panel does not change. */
export interface AssistantPort {
  status: AssistantStatus;
  send(input: { text: string; contextHeader: string | null }): SendResult;
  openConversation(): void;
  /** Human-readable note on where replies appear. */
  replyHint: string;
}

export function resolveAssistantStatus(input: { god: { id: string; name: string } | null; godStatus: string; deliveryPaused: boolean }): AssistantStatus {
  if (!input.god) return { state: 'unavailable', reason: 'The lead AI helper is not running. Open Agents to start it.' };
  const target: AssistantTarget = { id: input.god.id, name: input.god.name, kind: 'lead-agent' };
  if (input.godStatus === 'booting') return { state: 'starting', target };
  return { state: 'ready', target, deliveryPaused: input.deliveryPaused };
}
