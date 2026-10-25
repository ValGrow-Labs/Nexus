// The domain registry contract (DomainSpec v3, B2a; this build is B2b). Types, the sub-phase order
// and a few pure helpers only. A domain is data: its lifecycle steps, the kinds
// it produces and accepts, its capability ceiling, recipes, actions, handoff
// routes and modules. Every id it names must resolve (registryCheck.ts), and a
// step may be REAL or PARTIAL only once this build's sub-phase has reached the
// step's sub-phase. Nothing here is ticked by hand: a step's state is computed
// from records (versions and their validations).

import type { SandboxProfileId } from './execution';
import type { ValidatorId } from './evidence';

/** REAL: runs for real end to end in this build. PARTIAL: runs for real with a stated scope limit.
 *  FUTURE: not in this build; the UI shows its position and the reason, never an action or a result. */
export type StepStatus = 'REAL' | 'PARTIAL' | 'FUTURE';
export const STEP_STATUSES: readonly StepStatus[] = ['REAL', 'PARTIAL', 'FUTURE'];

export type SubPhase = 'B1' | 'B2a' | 'B2b' | 'B2c' | 'B3' | 'B4' | 'B5' | 'B6';
/** In delivery order. */
export const SUB_PHASES: readonly SubPhase[] = ['B1', 'B2a', 'B2b', 'B2c', 'B3', 'B4', 'B5', 'B6'];
/** The sub-phase this build implements: the registry's soundness checks (which steps may be REAL, which actions
 *  are planned) are made against it. It is never a claim to the user that a step runs. */
export const CURRENT_SUB_PHASE: SubPhase = 'B2b';
/** The sub-phase this build has proven end to end; Task 16 sets it to CURRENT_SUB_PHASE in the commit that empties
 *  B2B_E2E_STUB. Every user-facing or derived claim (delivered, "In this release", executable end to end, the
 *  summary) reads against it, never against CURRENT_SUB_PHASE. */
export const DELIVERED_SUB_PHASE: SubPhase = 'B2a';

export function isSubPhase(v: unknown): v is SubPhase {
  return typeof v === 'string' && (SUB_PHASES as readonly string[]).includes(v);
}
/** True when `phase` is delivered at or before `at` (default: this build). An unknown phase is never delivered. */
export function isAtOrBefore(phase: SubPhase, at: SubPhase = CURRENT_SUB_PHASE): boolean {
  const p = SUB_PHASES.indexOf(phase);
  const a = SUB_PHASES.indexOf(at);
  return p >= 0 && a >= 0 && p <= a;
}

export type KindId = string;
export type CapabilityId = string;
export type RecipeId = string;
export type SkillId = string;
export type UserActionId = string;
export type ViewerId = string;
/** An existing platform flow (B0b/B1) that is not a job: importing a project, saving a commit. */
export type PlatformFlowId = string;

/** What a step needs on this machine. Engine and credential prerequisites are vendor-neutral:
 *  the agent runtime behind the AgentRuntime interface decides what they mean. */
export type PrerequisiteId = 'git' | 'docker' | `image:${SandboxProfileId}` | 'runtime:agent' | 'credential:agent' | 'gpu' | 'disk:5GiB';

export type HandoffAction =
  | 'test' | 'fix' | 'release-gate' | 'inform' | 'investigate' | 'use-as-input' | 'feature-idea'
  | 'productionize' | 'create-api' | 'test-api' | 'package';
export const HANDOFF_ACTIONS: readonly HandoffAction[] = ['test', 'fix', 'release-gate', 'inform', 'investigate', 'use-as-input',
  'feature-idea', 'productionize', 'create-api', 'test-api', 'package'];

/** A domain is executable end to end only when every listed step is REAL or PARTIAL in the same build.
 *  `subPhase` is the sub-phase the plan expects that to happen in; it is never a claim about this build. */
export interface CompletionRule { id: string; label: string; steps: string[]; subPhase: SubPhase }

/** Minimal schema for the parameters a renderer may send with an action (ids, enums, bounded strings).
 *  It never has a path, command, network, image, principal or role field (registryCheck enforces it). */
export type ParamField =
  | { type: 'string'; maxLength: number; pattern?: string; enum?: readonly string[] }
  | { type: 'integer'; minimum: number; maximum: number }
  | { type: 'boolean' };
export interface ParamsSchema {
  type: 'object';
  properties: Readonly<Record<string, ParamField>>;
  required: readonly string[];
  additionalProperties: false;
}

export type DomainTier = 'first-class' | 'registry-only';

export interface DomainSpec {
  specVersion: 3;
  id: string; label: string; shortLabel: string; description: string;
  tier: DomainTier; hueSlot: number; icon: string; order: number;
  /** The sub-phase from which a project can take part in this domain (DS: B4, when its workspace row exists).
   *  It says nothing about which steps run: that is each step's status. Before it, no step runs and no action exists. */
  participationFromSubPhase: SubPhase;
  /** One plain sentence on what works in this build. Never claims the domain is finished. */
  statusNote: string;
  /** The live legacy-domain map used by the primary projection (B0b D4). Unchanged in B2a. */
  legacyDomainIds: string[];
  vocabulary: Partial<Record<KindId, { singular: string; plural: string }>>;
  kindsProduced: KindId[]; kindsAccepted: KindId[];
  /** The capability ceiling an agent token can be granted in this domain (tokens arrive in B2b). */
  capabilities: { id: CapabilityId; scope?: { paths?: string[]; recipes?: RecipeId[]; kinds?: KindId[]; note?: string } }[];
  recipes: RecipeId[]; skills: SkillId[]; actions: UserActionId[];
  lifecycle: LifecycleStep[];
  handoffRoutes: { to: string; kinds: KindId[]; action: HandoffAction; acceptance?: CompletionRule[]; subPhase: SubPhase }[];
  completionRules: CompletionRule[];
  modules: { id: string; label: string; kinds: KindId[]; subPhase: SubPhase }[];
}

export type StepVia = { userAction: UserActionId } | { recipe: RecipeId } | { skill: SkillId } | { platform: PlatformFlowId };

export type StepRecord = 'participation' | 'review' | 'signature' | 'selection' | 'conclusion' | 'deployment_healthy'
  | 'export' | 'handoff_sent';

export type StepDoneWhen =
  | { kind: KindId; statuses: ('candidate' | 'active')[]; validators: ValidatorId[] }
  | { record: StepRecord };

export interface LifecycleStep {
  id: string; label: string;
  consumes: KindId[]; produces: KindId[];
  via: StepVia[];
  doneWhen: StepDoneWhen;
  status: StepStatus;
  /** Required for PARTIAL (the scope limit). For FUTURE, why it is not in this build. */
  scopeNote?: string;
  /** The sub-phase in which the step becomes REAL or PARTIAL. */
  subPhase: SubPhase;
  prerequisites: PrerequisiteId[];
  /** Required when status is not FUTURE (boot check); a test title in the B2a flow or recipe tests. */
  e2eTestId?: string;
}

/** True only when every step of every completion rule is REAL or PARTIAL and delivered at `at` (default: the
 *  delivered sub-phase, what this build has proven end to end; pass CURRENT_SUB_PHASE for the registry-level fact). */
export function isExecutableEndToEnd(spec: DomainSpec, at: SubPhase = DELIVERED_SUB_PHASE): boolean {
  if (spec.tier !== 'first-class' || spec.lifecycle.length === 0 || spec.completionRules.length === 0) return false;
  if (!isAtOrBefore(spec.participationFromSubPhase, at)) return false;
  return spec.completionRules.every((rule) => rule.steps.every((id) => {
    const step = spec.lifecycle.find((s) => s.id === id);
    return !!step && step.status !== 'FUTURE' && isAtOrBefore(step.subPhase, at);
  }));
}
