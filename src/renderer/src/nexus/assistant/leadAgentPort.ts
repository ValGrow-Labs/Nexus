import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import { navigate } from '../router/useRoute';
import { useCanonicalAgents, useRegistryIds } from '../agents/agentIdentity';
import { displayAgents, leadAgentId } from '@shared/agentDisplay';
import { resolveAssistantStatus, type AssistantPort } from './port';

/** Mirrors MessageQueueComposer's useDeliveryPaused: poll the control snapshot. */
function useDeliveryPaused(agentId: string | null): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!agentId) { setPaused(false); return; }
    let alive = true;
    const read = () => {
      window.cth.controlSnapshot(agentId)
        .then((s) => { if (alive) setPaused(!!s?.autoDeliveryPaused); })
        .catch(() => { /* main not ready — assume not paused */ });
    };
    read();
    const iv = setInterval(read, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, [agentId]);
  return paused;
}

export function useLeadAgentPort(): AssistantPort {
  const agents = useStore((s) => s.agents);
  const hint = useRegistryIds();
  const god = useMemo(() => {
    const id = leadAgentId(agents, hint);
    return agents.find((a) => a.id === id) ?? null;
  }, [agents, hint]);
  const canon = useCanonicalAgents();
  const godLabel = god ? displayAgents(canon, hint).get(god.id)?.label ?? 'Lead AI helper' : null;
  const godStatus = useStore((s) => s.godStatus);
  const paused = useDeliveryPaused(god?.id ?? null);
  const status = resolveAssistantStatus({ god: god && godLabel ? { id: god.id, name: godLabel } : null, godStatus, deliveryPaused: paused });
  return {
    status,
    replyHint: 'Its reply shows up in Agents.',
    send: ({ text, contextHeader }) => {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, error: 'Type a message first.' };
      if (status.state === 'unavailable') return { ok: false, error: status.reason };
      const instruction = contextHeader ? `${contextHeader}\n${trimmed}` : trimmed;
      const queuedMessageId = useStore.getState().enqueueMessage(status.target.id, trimmed, { instruction });
      if (!queuedMessageId) return { ok: false, error: 'Nexus could not hand the message to the lead AI helper. Try again.' };
      return { ok: true, target: status.target, queuedMessageId };
    },
    openConversation: () => {
      if (god) useStore.getState().select(god.id);
      navigate({ name: 'agents' });
    }
  };
}
