/** Pure decisions for the team restore, kept free of React and the store so they can be tested. */
import { canonicalAgents, displayAgents, type DisplayHint, type DisplayInput } from '@shared/agentDisplay';

export interface AutoRestoreInput {
  autoRestoreEnabled: boolean;
  autoStarted: boolean;
  restoring: boolean;
  onboardingComplete: boolean;
  restorableCount: number;
}

/** True when the app shell should schedule the one-time boot restore. */
export function shouldScheduleAutoRestore(i: AutoRestoreInput): boolean {
  return i.autoRestoreEnabled && i.onboardingComplete && !i.autoStarted && !i.restoring && i.restorableCount > 0;
}

export type RestoreStatus =
  | { kind: 'idle' }
  | { kind: 'pending'; count: number }
  | { kind: 'running'; auto: boolean }
  | { kind: 'done'; note: string };

export function restoreStatusLine(s: RestoreStatus): string | null {
  switch (s.kind) {
    case 'pending':
      return `Bringing back ${s.count} ${s.count === 1 ? 'AI helper' : 'AI helpers'} from your last session in a moment.`;
    case 'running':
      return s.auto ? 'Bringing back your AI helpers from your last session…' : 'Bringing back your AI helpers…';
    case 'done':
      return s.note === 'nothing to restore' ? null : `Last session: ${s.note}`;
    default:
      return null;
  }
}

/** The label a restorable agent has on screen, for the restore status line
 *  (B0a final review, finding 4). Built from the same canonical list every
 *  surface uses (live, then restorable, then archived), never the stored name. */
export function restoreLabeler(
  live: readonly DisplayInput[],
  restorable: readonly DisplayInput[],
  archived: readonly DisplayInput[],
  hint?: DisplayHint
): (id: string) => string {
  const display = displayAgents(canonicalAgents<DisplayInput>(live, restorable, archived), hint);
  return (id) => display.get(id)?.label ?? 'Agent';
}
