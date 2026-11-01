// The B2a and B2b recipes as data. A recipe names argv *templates* by id; main builds the
// actual argv array (never a string) from the template, the pinned profile and
// main-resolved inputs. The renderer never supplies any part of it. Engine-side
// recipes run in the runner process itself (async git, `docker inspect`) and
// start no container.

import type { ParserId, SandboxProfileId } from './execution';
import type { KindId, ParamsSchema, RecipeId, SubPhase } from './domainSpec';
import { deepFreeze } from './freeze';

export type RecipeExecutor = 'engine' | 'tool' | 'service';
/**
 * What restart recovery does with an attempt that was running (B2b engine git recipes state it): `requeue` runs it
 * again (idempotent work), `interrupted` ends it interrupted (work that must not repeat blind; `changeset.accept` is
 * then reconciled from its durable `accept.prepared` event and rolled back, never merged later). When absent (B2a),
 * recovery follows `retry.idempotent`.
 */
export type RecipeRecovery = 'requeue' | 'interrupted';
/** `not-applicable`: an engine-side recipe runs no container. Egress happens only behind approval A1. */
export type RecipeNetwork = 'none' | 'egress-approved' | 'service-internal' | 'not-applicable';

export interface RecipeDef {
  id: RecipeId;
  version: string;
  executor: RecipeExecutor;
  /** Candidate profiles; main picks one from the repository (package.json or a Python project). Empty for engine recipes. */
  profiles: SandboxProfileId[];
  /** Ids of the argv templates main expands, in the order they run (after the Nexus entry). */
  argvTemplates: string[];
  /** Parameters main passes to the recipe; derived from the job's inputs, never from renderer text. */
  params: ParamsSchema;
  network: RecipeNetwork;
  retry: { idempotent: boolean; maxAttempts: number };
  wallClockMs: number;
  /** Container limits; null for engine recipes. */
  limits: { cpus: number; memoryMb: number; outputMaxBytes: number } | null;
  /** What must exist for the attempt to count as having produced its outputs (paths under `/out`, or engine facts). */
  outputContract: { required: string[]; description: string };
  parsers: ParserId[];
  produces: KindId[];
  subPhase: SubPhase;
  recovery?: RecipeRecovery;
}

export const NO_PARAMS: ParamsSchema = deepFreeze({ type: 'object', properties: {}, required: [], additionalProperties: false });
const MIN = 60_000;
const MIB = 2 ** 20;
const engine = { executor: 'engine' as const, profiles: [] as SandboxProfileId[], network: 'not-applicable' as const, limits: null };
const NODE_OR_PY: SandboxProfileId[] = ['sde-node', 'sde-python'];

export const RECIPES: readonly RecipeDef[] = deepFreeze([
  { id: 'repo.snapshot', version: '1', ...engine,
    argvTemplates: ['git.rev-parse-head-commit', 'git.symbolic-ref-short', 'git.status-porcelain-z', 'git.rev-parse-head-tree'],
    params: NO_PARAMS, retry: { idempotent: true, maxAttempts: 3 }, wallClockMs: 60_000,
    outputContract: { required: ['commit', 'branch', 'dirty', 'tree'], description: 'Facts: commit, branch, dirty flag and tree.' },
    parsers: ['repo-snapshot'], produces: ['repository'], subPhase: 'B2a' },
  { id: 'sde.deps.node', version: '1', executor: 'tool', profiles: ['sde-node'],
    argvTemplates: ['npm.ci-ignore-scripts', 'entry.lock-hash-npm'], params: NO_PARAMS, network: 'egress-approved',
    retry: { idempotent: true, maxAttempts: 2 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 1 * MIB },
    outputContract: { required: ['lock.sha256'], description: 'The lockfile hash, equal to the lockfile in the checkout.' },
    parsers: [], produces: [], subPhase: 'B2a' },
  { id: 'sde.deps.python', version: '1', executor: 'tool', profiles: ['sde-python'],
    argvTemplates: ['pip.install-binary-hashes', 'entry.lock-hash-pip'], params: NO_PARAMS, network: 'egress-approved',
    retry: { idempotent: true, maxAttempts: 2 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 1 * MIB },
    outputContract: { required: ['lock.sha256'], description: 'The lockfile hash, equal to the lockfile in the checkout.' },
    parsers: [], produces: [], subPhase: 'B2a' },
  { id: 'sde.test.discover', version: '1', executor: 'tool', profiles: NODE_OR_PY,
    argvTemplates: ['node-test.glob', 'jest.list-tests', 'vitest.list', 'mocha.dry-run', 'pytest.collect-only'],
    params: NO_PARAMS, network: 'none',
    retry: { idempotent: true, maxAttempts: 2 }, wallClockMs: 5 * MIN, limits: { cpus: 1, memoryMb: 1024, outputMaxBytes: 8 * MIB },
    outputContract: { required: ['ids.txt'], description: 'The discovered test ids or files.' },
    parsers: ['discovery'], produces: ['test_suite'], subPhase: 'B2a' },
  { id: 'sde.test.node', version: '1', executor: 'tool', profiles: ['sde-node'],
    argvTemplates: ['node-test.junit', 'jest.junit', 'vitest.junit', 'mocha.junit'], params: NO_PARAMS, network: 'none',
    retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 64 * MIB },
    outputContract: { required: ['junit.xml'], description: 'A JUnit report written by a forced reporter.' },
    parsers: ['junit'], produces: [], subPhase: 'B2a' },
  { id: 'sde.test.pytest', version: '1', executor: 'tool', profiles: ['sde-python'],
    argvTemplates: ['pytest.junit'], params: NO_PARAMS, network: 'none',
    retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 64 * MIB },
    outputContract: { required: ['junit.xml'], description: 'A JUnit report.' },
    parsers: ['junit'], produces: [], subPhase: 'B2a' },
  { id: 'sde.build.node', version: '1', executor: 'tool', profiles: ['sde-node'],
    argvTemplates: ['npm.run-build', 'entry.collect-output'], params: NO_PARAMS, network: 'none',
    retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 256 * MIB },
    outputContract: { required: ['dist/**'], description: 'The build output tree.' },
    parsers: [], produces: ['build'], subPhase: 'B2a' },
  { id: 'sde.build.python', version: '1', executor: 'tool', profiles: ['sde-python'],
    argvTemplates: ['python.build-wheel'], params: NO_PARAMS, network: 'none',
    retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 256 * MIB },
    outputContract: { required: ['dist/*.whl'], description: 'One or more wheels.' },
    parsers: [], produces: ['build'], subPhase: 'B2a' },
  { id: 'sde.app.assemble', version: '1', ...engine,
    argvTemplates: ['git.show-app-manifest'], params: NO_PARAMS, retry: { idempotent: true, maxAttempts: 3 }, wallClockMs: 60_000,
    outputContract: { required: ['manifest'], description: 'The nexus.app.json manifest of the built commit (at most 16 KiB).' },
    parsers: ['app-manifest'], produces: ['application'], subPhase: 'B2a' },
  { id: 'sde.preview.start', version: '1', executor: 'service', profiles: [...NODE_OR_PY, 'nexus-fwd'],
    argvTemplates: ['app.manifest-run', 'fwd.socat-loopback'], params: NO_PARAMS, network: 'service-internal',
    retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 60_000, limits: { cpus: 1, memoryMb: 1024, outputMaxBytes: 1 * MIB },
    outputContract: { required: ['health'], description: 'A health probe answered on 127.0.0.1 within 60 s; idle for 2 h, it stops.' },
    parsers: [], produces: [], subPhase: 'B2a' },
  { id: 'sde.diagnose', version: '1', ...engine,
    argvTemplates: ['docker.inspect', 'probe.table', 'log.ranges'], params: NO_PARAMS, retry: { idempotent: true, maxAttempts: 3 },
    wallClockMs: 60_000,
    outputContract: { required: ['target', 'containers', 'logs'],
      description: 'Facts: the inspected containers and the hashed log ranges; main adds its own probe table and stores a report whose every field comes from inspect, a probe or a log range.' },
    parsers: ['diagnostic'], produces: ['diagnostic_report'], subPhase: 'B2a' },
  // A try run (B2b, "Try it"): the person presses a button, a suggested change runs in the safe space and its output is shown. The command is an
  // argument array main wrote into the job (a detected button, or the person's own command tokenized by main); the lease checks it again. Same
  // limits and wall clock as a test run, no network, one run at a time per project; the output is capped at 4 MiB and shown redacted.
  { id: 'sde.try.run', version: '1', executor: 'tool', profiles: NODE_OR_PY,
    argvTemplates: ['try.run'], params: NO_PARAMS, network: 'none',
    retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 4 * MIB },
    outputContract: { required: [], description: 'None: the output is the log of the run, and the exit status says how it ended.' },
    parsers: [], produces: [], subPhase: 'B2a' },
  // Live preview phase 2: an app with add-ons and no lockfile. ONE approved job: the exact versions are worked out (npm's lock-only mode), then installed from
  // them with scripts off, through the same registry-only proxy and allow-list as sde.deps.node. Its evidence is the hash of the package list it installed from.
  { id: 'sde.deps.resolve', version: '1', executor: 'tool', profiles: ['sde-node'],
    argvTemplates: ['npm.lock-only', 'npm.ci-ignore-scripts', 'entry.lock-hash-package'], params: NO_PARAMS, network: 'egress-approved',
    retry: { idempotent: true, maxAttempts: 2 }, wallClockMs: 15 * MIN, limits: { cpus: 2, memoryMb: 2048, outputMaxBytes: 1 * MIB },
    outputContract: { required: ['lock.sha256'], description: 'The hash of the package list that was installed, equal to the package list in the checkout.' },
    parsers: [], produces: [], subPhase: 'B2a' },
  // ----- B2b: the git writes of agent changes, each a system child job. Every ref is under refs/nexus/* (D-B13); only
  // repo.ff touches the user's branch, and only after the user confirmed it in a dialog. -----
  { id: 'repo.worktree', version: '1', ...engine,
    argvTemplates: ['git.update-ref-create-integration', 'git.update-ref-create-job', 'git.worktree-add-detach', 'git.worktree-lock'],
    params: NO_PARAMS, retry: { idempotent: true, maxAttempts: 2 }, wallClockMs: 60_000, recovery: 'requeue',
    outputContract: { required: ['integrationHead', 'ref', 'worktree'],
      description: 'Facts: the integration ref (created at the branch head when absent), the session ref at the integration head, and a locked detached worktree under the data home.' },
    parsers: [], produces: [], subPhase: 'B2b' },
  { id: 'changeset.collect', version: '1', ...engine,
    argvTemplates: ['git.status-porcelain-z', 'git.add-scope', 'git.write-tree', 'git.commit-tree-agent', 'git.update-ref-job'],
    params: NO_PARAMS, retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 120_000, recovery: 'interrupted',
    outputContract: { required: ['base', 'head', 'diffstat'],
      description: 'Facts: the merge base with the integration ref, the commit Nexus wrote on the session ref from the paths in scope, and its diffstat. Links, nested repositories and oversized files are refused.' },
    parsers: [], produces: ['change_set'], subPhase: 'B2b' },
  { id: 'changeset.merge_check', version: '1', ...engine,
    argvTemplates: ['git.merge-tree-write-tree'], params: NO_PARAMS, retry: { idempotent: true, maxAttempts: 2 }, wallClockMs: 60_000,
    recovery: 'requeue',
    outputContract: { required: ['clean', 'tree'], description: 'Facts: whether the change merges onto the integration head without a conflict, and the merged tree. Writes no ref.' },
    parsers: [], produces: [], subPhase: 'B2b' },
  { id: 'changeset.accept', version: '1', ...engine,
    argvTemplates: ['git.merge-tree-write-tree', 'git.commit-tree-accept', 'git.update-ref-cas'],
    params: NO_PARAMS, retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 120_000, recovery: 'interrupted',
    outputContract: { required: ['old', 'new', 'mergeCommit'],
      description: 'Facts: the integration ref moved from the expected head to the merge commit by compare-and-swap, reported as prepared before the move. An unfinished accept is rolled back, never merged later.' },
    parsers: [], produces: [], subPhase: 'B2b' },
  { id: 'changeset.accept_rollback', version: '1', ...engine,
    argvTemplates: ['git.update-ref-cas'], params: NO_PARAMS, retry: { idempotent: true, maxAttempts: 3 }, wallClockMs: 60_000,
    recovery: 'requeue',
    outputContract: { required: ['from', 'to'], description: 'Facts: the integration ref moved back by compare-and-swap (or already back).' },
    parsers: [], produces: [], subPhase: 'B2b' },
  { id: 'repo.ff', version: '1', ...engine,
    argvTemplates: ['git.symbolic-ref-short', 'git.status-porcelain-z', 'git.merge-ff-only'],
    params: NO_PARAMS, retry: { idempotent: false, maxAttempts: 1 }, wallClockMs: 60_000, recovery: 'interrupted',
    outputContract: { required: ['before', 'after'],
      description: 'Facts: the checked-out branch of the user fast-forwarded to the confirmed commit; a dirty tree, another branch or a non-fast-forward is refused and nothing changes.' },
    parsers: [], produces: [], subPhase: 'B2b' }
]);

/** How long an idle dev deployment lives before it is stopped. */
export const PREVIEW_IDLE_TTL_MS = 2 * 60 * MIN;
export const RETRY_BACKOFF_MS: readonly number[] = deepFreeze([10_000, 60_000, 300_000]);

export const RECIPE_IDS: readonly RecipeId[] = deepFreeze(RECIPES.map((r) => r.id));

export function getRecipe(id: string): RecipeDef | null {
  return RECIPES.find((r) => r.id === id) ?? null;
}
