// Pure: the copy for the Checklist tool (route id: completion). Completion rules arrive in a later
// phase; until then nothing is tracked, so this copy must never claim that work
// is finished, checked or partly done, nor name a phase it will ship in.

export interface CompletionCopy {
  title: string;
  badge: string;
  /** The one line the page says: nothing is tracked yet. */
  lead: string;
  facts: Array<{ label: string; value: string }>;
}

export function completionCopy(i: { domainLabel?: string | null }): CompletionCopy {
  return {
    title: 'Checklist',
    badge: 'Coming later',
    lead: 'Nothing is tracked here yet.',
    facts: [{ label: 'Workspace', value: i.domainLabel || 'Unassigned' }]
  };
}
