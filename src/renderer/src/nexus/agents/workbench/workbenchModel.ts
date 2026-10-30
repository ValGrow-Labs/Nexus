// Pure: the agent workbench's section list, legacy tab-request mapping and the
// delivery control's copy. No React, no window — loadable by test/load-ts.cjs.

export type WorkbenchSectionId = 'terminal' | 'git' | 'messages' | 'traces' | 'team' | 'requests' | 'tasks'
  | 'needs-you' | 'activity' | 'triggers' | 'history' | 'memory' | 'graph' | 'skills' | 'workers';

/** `hosted`: the body is an existing component hosted inside the workbench
 *  rather than a Nexus-native section. `leadOnly`: shown for the lead agent only. */
export interface WorkbenchSection { id: WorkbenchSectionId; label: string; hosted: boolean; leadOnly: boolean }

export const WORKBENCH_SECTIONS: readonly WorkbenchSection[] = [
  { id: 'terminal', label: 'Terminal', hosted: false, leadOnly: false },
  { id: 'git', label: 'File changes', hosted: true, leadOnly: false },
  { id: 'messages', label: 'Messages', hosted: true, leadOnly: false },
  { id: 'traces', label: 'Tool calls', hosted: true, leadOnly: false },
  { id: 'team', label: 'Team', hosted: false, leadOnly: true },
  { id: 'requests', label: 'Requests', hosted: false, leadOnly: true },
  { id: 'tasks', label: 'Tasks', hosted: false, leadOnly: true },
  { id: 'needs-you', label: 'Needs you', hosted: false, leadOnly: true },
  { id: 'activity', label: 'Activity', hosted: false, leadOnly: true },
  { id: 'triggers', label: 'Triggers', hosted: true, leadOnly: true },
  { id: 'history', label: 'Trigger history', hosted: true, leadOnly: true },
  { id: 'memory', label: 'Memory', hosted: true, leadOnly: true },
  { id: 'graph', label: 'Memory map', hosted: true, leadOnly: true },
  { id: 'skills', label: 'Skills', hosted: true, leadOnly: true },
  { id: 'workers', label: 'Workers', hosted: true, leadOnly: true }
];

const AGENT_ORDER: readonly WorkbenchSectionId[] = ['terminal', 'git', 'messages', 'traces'];
const LEAD_ORDER: readonly WorkbenchSectionId[] = ['terminal', 'team', 'requests', 'tasks', 'needs-you', 'activity', 'triggers',
  'history', 'memory', 'graph', 'skills', 'workers', 'messages', 'traces'];

const BY_ID = new Map(WORKBENCH_SECTIONS.map((s) => [s.id, s] as const));

/** The sections an agent's workbench shows, in order. History appears only when
 *  something outside can reach the app (`triggerHistoryVisible`). */
export function sectionsFor(o: { isLead: boolean; showHistory: boolean }): WorkbenchSection[] {
  const order = o.isLead ? LEAD_ORDER : AGENT_ORDER;
  return order
    .filter((id) => id !== 'history' || o.showHistory)
    .map((id) => BY_ID.get(id) as WorkbenchSection);
}

/** Legacy tab keys (store `ccTabRequest`) that changed name in the workbench. */
const LEGACY_REQUESTS: Readonly<Record<string, WorkbenchSectionId>> = {
  floor: 'requests',
  human: 'needs-you',
  'trigger-history': 'history'
};

/** Map a `ccTabRequest` tab value to a workbench section, or null when unknown. */
export function sectionForRequest(tab: string): WorkbenchSectionId | null {
  if (Object.prototype.hasOwnProperty.call(LEGACY_REQUESTS, tab)) return LEGACY_REQUESTS[tab];
  return BY_ID.has(tab as WorkbenchSectionId) ? (tab as WorkbenchSectionId) : null;
}

/** Where a workbench opens: the stored section when this agent has it, else the terminal. */
export function initialSection(o: { isLead: boolean; stored?: string | null }): WorkbenchSectionId {
  const stored = o.stored ?? null;
  if (!stored) return 'terminal';
  const order = o.isLead ? LEAD_ORDER : AGENT_ORDER;
  return order.includes(stored as WorkbenchSectionId) ? (stored as WorkbenchSectionId) : 'terminal';
}

/** The lead agent's delivery switch: one control for every agent's queue. */
export function deliveryLabel(paused: boolean): { text: string; title: string } {
  return paused
    ? { text: 'Resume messages', title: 'Messages you queued are on hold for every AI helper. Resume to send them automatically.' }
    : { text: 'Pause messages', title: 'Messages you queued are sent to every AI helper automatically. Pause to hold them back.' };
}

/** Every live agent, the lead included, gets the same auto-delivery state. */
export function deliveryTargets(agents: ReadonlyArray<{ id: string }>): string[] {
  return agents.map((a) => a.id);
}
