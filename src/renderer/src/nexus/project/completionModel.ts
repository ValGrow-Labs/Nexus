// Pure: the copy for the Checklist tool (route id: completion). Completion rules arrive in a later
// phase; until then nothing is tracked, so this copy must never claim that work
// is finished, checked or partly done, nor name a phase it will ship in.

export interface CompletionCopy {
  title: string;
  badge: string;
  lead: string;
  planned: string;
  detail: string;
  facts: Array<{ label: string; value: string }>;
}

export function completionCopy(i: { domainLabel?: string | null }): CompletionCopy {
  return {
    title: 'Checklist',
    badge: 'Coming later',
    lead: 'The checklist will show what each workspace in this project still needs before its work is accepted.',
    planned: 'It is coming later. Each workspace will have its own list, and every item will link to the work and the proof behind it.',
    detail: 'Nexus does not keep track of that yet, so there is nothing to show here. Nothing is counted as done just because checks ran or files exist.',
    facts: [{ label: 'Workspace', value: i.domainLabel || 'Unassigned' }]
  };
}
