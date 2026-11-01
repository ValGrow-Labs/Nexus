/**
 * "Use these changes": the three steps a person would press one after the other (Looks good, Keep these changes, Add to my project) run in that order from ONE
 * button, each only after the one before succeeded. Nothing is skipped or weakened: the button is shown only when "Looks good" itself is offered (every required
 * check passed and the whole change was read), each step is the same call as its own button, and the real confirmation of the last step is still the separate
 * window main opens. A step that fails stops the run and says which one, in the step's own words; what was already done stays done (a kept change is not lost).
 */
import type { MergeView, NexusResult, RepoStatusView } from '@shared/nexus/ipc';
import { mergeModel, type MergeModel } from './changeSetModel';

export type FlowStep = 'looks_good' | 'keep' | 'add';

export interface FlowDeps {
  /** "Looks good" (the person's own review decision). */
  approve: () => Promise<NexusResult<unknown>>;
  /** "Keep these changes", with the integration head the person's screen knew. */
  keep: (expectedHead: string) => Promise<NexusResult<unknown>>;
  /** The repository status, read again after keeping (the head moved). */
  repoStatus: () => Promise<NexusResult<RepoStatusView>>;
  /** "Add to my project" (main asks in its own window). */
  add: (args: NonNullable<MergeModel['button']>['args']) => Promise<NexusResult<MergeView>>;
  /** The integration head now (null: it is not known, nothing is run). */
  head: string | null;
}

export type FlowOutcome =
  | { done: 'added'; merge: MergeView }
  /** Kept, but "Add to my project" is not possible right now: its own sentence says why. */
  | { done: 'kept'; sentence: string | null }
  | { failed: FlowStep; result: Extract<NexusResult<unknown>, { ok: false }> };

/** True when the failure is the person pressing Cancel in the confirmation window (not an error). */
export function isCancelled(r: Extract<NexusResult<unknown>, { ok: false }>): boolean {
  return r.code === 'conflict' && r.reason === 'cancelled';
}

export async function runChangesFlow(d: FlowDeps): Promise<FlowOutcome | null> {
  if (!d.head) return null;
  const a = await d.approve();
  if (!a.ok) return { failed: 'looks_good', result: a };
  const k = await d.keep(d.head);
  if (!k.ok) return { failed: 'keep', result: k };
  const s = await d.repoStatus();
  if (!s.ok) return { failed: 'add', result: s };
  const m = mergeModel(s.data);
  if (!m || !m.button) return { done: 'kept', sentence: m ? m.sentence : null };
  const added = await d.add(m.button.args);
  if (!added.ok) return { failed: 'add', result: added };
  return { done: 'added', merge: added.data };
}

/** What each step is called when it is the one that stopped the run. */
export const FLOW_STEP_WORD: Readonly<Record<FlowStep, string>> = Object.freeze({ looks_good: 'Looks good', keep: 'Keep these changes', add: 'Add to my project' });
