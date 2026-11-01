// User actions (renderer → main through `nexus:job:start` and the inline save).
// An action is an id with input slots and a parameter schema: never a command,
// a path, a network, an image or an identity. Main picks the recipe from the
// action's list (by the repository's profile), resolves every path and builds
// the container spec. Only steps that are REAL in this build have actions. The B2b
// agent flows run through their own channels (#42, #47, #48, #50), never as a job start.

import type { KindId, ParamsSchema, PlatformFlowId, PrerequisiteId, RecipeId, SubPhase, UserActionId } from './domainSpec';
import { NO_PARAMS } from './recipes';
import { deepFreeze } from './freeze';

/**
 * B2b flows: work with its own channel and service, not a recipe job: an agent turn (#42), a review decision (#47),
 * accepting a change (#48) and merging accepted work (#50). Each needs the agents part of the platform (schema v10).
 */
export type AgentFlowId = 'agent.turn' | 'review.decide' | 'changeset.accept' | 'repo.merge_accepted';
export const AGENT_FLOW_IDS: readonly AgentFlowId[] = deepFreeze(['agent.turn', 'review.decide', 'changeset.accept', 'repo.merge_accepted']);

/**
 * One recipe job (main picks among `recipes`), an inline save of a user-authored kind, a control on a live record, or
 * (B2b) an agent flow.
 */
export type ActionRun =
  | { recipes: RecipeId[] }
  | { inlineKind: KindId }
  | { control: 'deployment.stop' }
  | { flow: AgentFlowId };

export interface InputSlot { slot: string; kinds: KindId[]; min: number; max: number }

export interface UserActionDef {
  id: UserActionId;
  domain: string;
  labelKey: string;
  /** Plain words in the domain's language. */
  label: string;
  run: ActionRun;
  inputs: InputSlot[];
  params: ParamsSchema;
  /** Platform prerequisites. A profile-dependent image (sde-node or sde-python) is resolved per repository by main. */
  prerequisites: PrerequisiteId[];
  subPhase: SubPhase;
}

/** Existing platform flows (B0b/B1) a step can name; they are not jobs. */
export const PLATFORM_FLOWS: readonly PlatformFlowId[] = deepFreeze(['project.import', 'project.attach', 'user.save_commit', 'user.save_file']);

const ID = '^[A-Za-z0-9_-]{1,64}$';
const one = (slot: string, kind: KindId): InputSlot => ({ slot, kinds: [kind], min: 1, max: 1 });
const a = (id: UserActionId, domain: string, label: string, run: ActionRun, inputs: InputSlot[],
  prerequisites: PrerequisiteId[], params: ParamsSchema = NO_PARAMS): UserActionDef =>
  ({ id, domain, labelKey: `action.${id}`, label, run, inputs, params, prerequisites, subPhase: 'B2a' });
const b2b = (id: UserActionId, label: string, run: ActionRun, inputs: InputSlot[], prerequisites: PrerequisiteId[]): UserActionDef =>
  ({ id, domain: 'sde', labelKey: `action.${id}`, label, run, inputs, params: NO_PARAMS, prerequisites, subPhase: 'B2b' });

export const USER_ACTIONS: readonly UserActionDef[] = deepFreeze([
  a('sde.requirement.write', 'sde', 'Write a requirement', { inlineKind: 'requirement' }, [], []),
  a('sde.repository.snapshot', 'sde', 'Save a starting point', { recipes: ['repo.snapshot'] }, [], ['git']),
  a('sde.deps.install', 'sde', 'Install dependencies', { recipes: ['sde.deps.node', 'sde.deps.python'] },
    [one('repository', 'repository')], ['git', 'docker', 'disk:5GiB']),
  // Live preview phase 2: the preview chain's own step. Main picks the recipe from what the repository version recorded (a lockfile: the install; a package
  // list with add-ons and no lockfile: the lock-only install), and refuses with a reason when there is nothing to do or it was already done.
  a('sde.deps.prepare', 'sde', 'Get the add-ons ready', { recipes: ['sde.deps.node', 'sde.deps.python', 'sde.deps.resolve'] },
    [one('repository', 'repository')], ['git', 'docker', 'disk:5GiB']),
  a('sde.tests.discover', 'sde', 'Find tests on a commit', { recipes: ['sde.test.discover'] },
    [one('repository', 'repository')], ['git', 'docker', 'disk:5GiB']),
  a('sde.tests.run', 'sde', 'Run tests on a commit', { recipes: ['sde.test.node', 'sde.test.pytest'] },
    [one('suite', 'test_suite')], ['git', 'docker', 'disk:5GiB']),
  // Try it (B2b): started only through its own request (`nexus:try`), which writes the command into the job; never through `nexus:job:start`.
  a('sde.try.run', 'sde', 'Try the suggested changes', { recipes: ['sde.try.run'] },
    // One suggested change, or none: with none the run is the project as it stands (its checked-out commit, which main resolves and writes into the job).
    [{ slot: 'change', kinds: ['change_set'], min: 0, max: 1 }], ['git', 'docker', 'disk:5GiB']),
  // Preview a suggested change (B2b): started only through the try request (`what: 'preview'`), which reads the change's manifest and writes it into the job.
  a('sde.preview.live', 'sde', 'Preview the suggested changes', { recipes: ['sde.preview.live'] },
    [one('change', 'change_set')], ['git', 'docker', 'image:nexus-fwd', 'disk:5GiB']),
  a('sde.build.run', 'sde', 'Build', { recipes: ['sde.build.node', 'sde.build.python'] },
    [one('repository', 'repository')], ['git', 'docker', 'disk:5GiB']),
  a('sde.app.assemble', 'sde', 'Assemble the application', { recipes: ['sde.app.assemble'] },
    [one('build', 'build')], ['git']),
  a('sde.preview.start', 'sde', 'Start a test run of your app', { recipes: ['sde.preview.start'] },
    [one('application', 'application')], ['docker', 'image:nexus-fwd', 'disk:5GiB']),
  a('sde.preview.stop', 'sde', 'Stop the test run of your app', { control: 'deployment.stop' }, [], ['docker'],
    { type: 'object', properties: { deploymentId: { type: 'string', maxLength: 64, pattern: ID } }, required: ['deploymentId'],
      additionalProperties: false }),
  a('sde.diagnose', 'sde', 'Find out what went wrong', { recipes: ['sde.diagnose'] }, [], ['docker'],
    { type: 'object', properties: { target: { type: 'string', maxLength: 16, enum: ['deployment', 'job'] },
      targetId: { type: 'string', maxLength: 64, pattern: ID } }, required: ['target', 'targetId'], additionalProperties: false }),
  a('data.problem.write', 'data', 'Write a business question', { inlineKind: 'problem_statement' }, [], []),
  a('ml.problem.write', 'ml', 'Write a problem statement', { inlineKind: 'problem_statement' }, [], []),
  a('dl.problem.write', 'dl', 'Write a problem statement', { inlineKind: 'problem_statement' }, [], []),
  // B2b: the agent flows of SDE. #24 answers them unavailable (`agents_unavailable`) while the agents part is off.
  b2b('sde.agent.turn', 'Ask the agent', { flow: 'agent.turn' }, [], ['git', 'docker', 'disk:5GiB', 'runtime:agent']),
  b2b('sde.changeset.review', 'Review the change', { flow: 'review.decide' }, [one('change', 'change_set')], ['git']),
  b2b('sde.changeset.accept', 'Accept the change', { flow: 'changeset.accept' }, [one('change', 'change_set')], ['git']),
  b2b('sde.repo.merge', 'Merge accepted work', { flow: 'repo.merge_accepted' }, [], ['git'])
]);

export const USER_ACTION_IDS: readonly UserActionId[] = deepFreeze(USER_ACTIONS.map((x) => x.id));

export function getUserAction(id: string): UserActionDef | null {
  return USER_ACTIONS.find((x) => x.id === id) ?? null;
}
