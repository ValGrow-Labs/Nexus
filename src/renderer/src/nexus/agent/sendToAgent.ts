import { nexusClient } from '../data/nexusClient';
import { usePlatform } from '../data/platformStore';
import { withIntent } from '../data/useExecution';
import { agentFailText, continuableSession, messageKey, startArgs } from './agentModel';

/**
 * Sends a message to a project's AI helper: the one place that does it (the request box and the Home page's Start both use it).
 * It continues the project's newest conversation that has no live request, and starts one only when there is none (or it cannot be read).
 * The pending-intent key holds a hash of the message, never the message itself, so sending the same words twice is the same request.
 */
export async function sendToProjectAgent(text: string, projectId: string): Promise<{ ok: true; continued: boolean } | { ok: false; error: string }> {
  const list = await nexusClient.sessionsList({ projectId });
  const sessionId = list.ok ? continuableSession(list.data)?.id ?? null : null;
  const built = startArgs({ projectId, workspaceId: 'sde', sessionId, message: text, intentId: 'pending' });
  if ('problem' in built) return { ok: false, error: built.problem };
  const r = await withIntent(`intent:agent:${projectId}:${sessionId ?? 'new'}:${messageKey(text)}`, (intentId) => nexusClient.agentStart({ ...built.args, intentId }));
  if (!r.ok) return { ok: false, error: agentFailText(r) };
  usePlatform.getState().bumpRev();
  return { ok: true, continued: sessionId !== null };
}
