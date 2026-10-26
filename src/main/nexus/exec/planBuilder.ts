/**
 * The plan builder: job + recipe + inputs -> an `AttemptPlan` with a fully resolved
 * `ContainerSpec`. Pure (no I/O): the caller hands in rows main has read and paths main
 * derived; the renderer never supplies any part of a plan.
 *
 * - argv comes from the recipe's argv templates (`ARGV_TEMPLATES`, fixed arrays) and
 *   main-resolved, validated values only (discovered test files from an input version).
 *   Never a shell string. Recipes whose templates are framework alternatives
 *   (`node-test.*`, `jest.*`, `vitest.*`, `mocha.*`, `pytest.*`) run exactly one; any other
 *   recipe runs its templates in order, joined by the entry's `STEP_SEPARATOR`.
 * - env comes from the recipe's allow-list only (`ALLOWED_ENV_NAMES`); a name outside it, or a
 *   value that `looksSecret` (shared) or `containsSecret` (main's redactor) flags, refuses
 *   the plan. No host variable is ever copied.
 * - mounts: bind mounts only under the data home (`work/<jobId>/<n>/{in,out}`), plus named
 *   volumes (`nexus-ws-<attemptId>`, `nexus-deps-<profile>-<lock12>`). Nothing else.
 * - network: `none` unless the recipe is `egress-approved` AND the caller passes an approval
 *   of THIS job that is approved and was consumed by THIS attempt; otherwise the plan is
 *   refused (`network_not_approved`). Never `egress-approved` for any other recipe. An approved install never gets a
 *   route out (B2a stabilization, constraint 5): it runs on the job's INTERNAL network `nexus-egress-in-<jobId>` with the
 *   proxy settings (`egressClientEnv`), and the plan carries the job's Nexus egress proxy (`egressProxy`: the pinned
 *   sde-node image running infra/images/sde-node/egress-proxy.js, on that network and the outbound bridge
 *   `nexus-egress-out-<jobId>`), whose only allowed destinations are the recipe's allow-list
 *   (src/shared/nexus/egressPolicy.ts EGRESS_ALLOWLISTS, HTTPS 443 only). No proxy image: the plan is refused (`image_missing`).
 * - labels, limits (`--pids-limit 512`, the recipe's CPUs, memory and output cap, a 512 MiB
 *   `/tmp`), read-only root, `--cap-drop ALL`, no-new-privileges: fixed.
 * - Engine recipes (`repo.snapshot`, `sde.app.assemble`) get an `EnginePlan` whose repository
 *   folder is the one main accepted from the `projects` row (`acceptFsRoot`), never a param. `sde.diagnose` (B2a Task 12)
 *   gets one naming the subject's containers and attempt log ranges, all read by main from its own rows (no folder).
 * - The B2b git write recipes (`repo.worktree`, `changeset.collect`, `changeset.merge_check`, `changeset.accept`,
 *   `changeset.accept_rollback`, `repo.ff`; B2b Task 7) get an `EnginePlan` from the job's SYSTEM-written params
 *   (`ctx.params`: a session id, a branch, commits; checked here again), the accepted project folder and the data home:
 *   the worktree is `<dataHome>/wt/<session id lowercased>`, its git folder `<repo>/.git/worktrees/<same>`, the session
 *   ref `refs/nexus/job/<same>` and the integration ref `refs/nexus/accepted/<branch>` (D-B13). Commit messages are
 *   main's: the agent's commit carries the `Nexus-Job: <turn job>` trailer, an accept `Nexus-Accepted-By: user:local` (D-B8).
 * - The Nexus entry (infra/images/common/nexus-entry) receives its backstop in `NEXUS_WALL_SECONDS` (main's number: TWICE
 *   the container's wall clock, final batch item 2, the Task 7 R3 ruling: the in-container timeout is at least limit + cap,
 *   so it never ends work main still counts as in time; main's wall clock stays the authority) and bounds the whole run
 *   with its own `timeout`; node:test runs one file at a time (`nexus-node-test`) with a
 *   `perFileJunit` mapping the runner merges and attributes (A5).
 * - The service recipe (`sde.preview.start`, B2a Task 9) gets a `ServicePlan`: the app container runs the
 *   application manifest's validated `run` argv (an array, never a shell string) on the internal network
 *   `nexus-svc-<jobId>` only (no egress); the `nexus-fwd` forwarder joins it and `nexus-pub-<jobId>` and publishes
 *   exactly one port, on 127.0.0.1 (`publish.hostPort` 0: the runner picks it from its ephemeral range before
 *   create and reports it). The build's files are staged from the blob store; the lifetime is fixed (2 h).
 *
 * Errors are PlatformError 'invalid' with `detail.reason` (`network_not_approved`,
 * `env_not_allowed`, `secret_in_env`, `image_missing`, `mount_outside_data_home`,
 * `project_folder_unavailable`, `bad_input`, `not_in_this_build`).
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { DIAGNOSE_MAX_CONTAINERS, DIAGNOSE_MAX_RANGES, DIAGNOSE_RANGE_MAX_BYTES, STEP_SEPARATOR_TOKEN } from '../../../shared/nexus/execution';
import type {
  AgentPlan, AttemptPlan, ContainerSpec, EnginePlan, MountSpec, NetworkMode, ResourceLabels, ResourceLimits, SandboxProfile, ServicePlan, ToolPlan
} from '../../../shared/nexus/execution';
import type { RunRequest, RuntimeKind } from '../../../shared/nexus/runtime';
import type { RecipeDef } from '../../../shared/nexus/recipes';
import { looksSecret } from '../../../shared/nexus/secretShape';
import { homeLabel } from '../../../shared/nexus/homeLabel';
import { containsSecret } from '../activity/redact';
import {
  EGRESS_ENV_NAMES, EGRESS_PROXY_ARGV, EGRESS_PROXY_LIMITS, EGRESS_PROXY_PROFILE, egressAllowFor, egressClientEnv, egressInternalNetwork,
  egressOutboundNetwork, formatAllow
} from '../../../shared/nexus/egressPolicy';
import { PlatformError } from '../errors';

/** The environment names a container may receive from main (values are main's, never the host's). */
export const ALLOWED_ENV_NAMES: readonly string[] = Object.freeze([
  'HOME', 'CI', 'NODE_ENV', 'PYTHONPATH', 'JEST_JUNIT_OUTPUT_FILE', 'PIP_NO_INPUT', 'npm_config_cache', 'PYTHONDONTWRITEBYTECODE',
  // B2a Task 12: the container's wall clock in whole seconds, for the Nexus entry's own `timeout` (main's number, never the job's).
  'NEXUS_WALL_SECONDS',
  // B2a stabilization (constraint 5): an approved install's proxy settings and the proxy's allow-list (main's constants).
  ...EGRESS_ENV_NAMES
]);
/**
 * The in-container backstop is this many times the wall clock (final batch item 2): main's timeout (limit plus the
 * excluded stalls, capped at 1x) always fires first; the entry's own `timeout` only ends a container main lost.
 */
export const ENTRY_WALL_FACTOR = 2;
/** The entry's own backstop (whole seconds, at least 1) for a plan wall clock in milliseconds: ENTRY_WALL_FACTOR x the wall clock. */
export function wallSeconds(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms <= 0) return refuse('bad_input', 'a container needs a wall clock');
  return String(Math.max(1, Math.ceil((ms * ENTRY_WALL_FACTOR) / 1000)));
}
export const PIDS_LIMIT = 512;
export const TMPFS_MB = 512;
/** The Nexus entry splits a multi-step recipe's argv on this token (the entry script is Task 12; shared: STEP_SEPARATOR_TOKEN). */
export const STEP_SEPARATOR = STEP_SEPARATOR_TOKEN;
export const MAX_DISCOVERED_FILES = 5000;
const FRAMEWORKS = ['node-test', 'jest', 'vitest', 'mocha', 'pytest'] as const;
export type TestFramework = (typeof FRAMEWORKS)[number];

/** argv templates by id: fixed arrays, run after the Nexus entry. Values main adds are appended by `expand`. */
export const ARGV_TEMPLATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'npm.ci-ignore-scripts': ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
  'pip.install-binary-hashes': ['python', '-m', 'pip', 'install', '--only-binary=:all:', '--require-hashes', '--no-deps',
    '-r', '/workspace/requirements.txt', '--target', '/deps'],
  // An install's evidence (final batch item 1): the Nexus entry hashes the lockfile it installed from into /out/lock.sha256
  // (fixed argv, no job value); main judges it against the snapshot's `metadata.lockfile.sha256` (sde.deps.lock_matches).
  'entry.lock-hash-npm': ['nexus-lock-hash', '--file', 'package-lock.json', '--out', '/out/lock.sha256'],
  'entry.lock-hash-pip': ['nexus-lock-hash', '--file', 'requirements.txt', '--out', '/out/lock.sha256'],
  'node-test.glob': ['nexus-glob', '--out', '/out/ids.txt', '**/*.test.js', '**/*.test.mjs', '**/*.test.cjs',
    'test/**/*.js', 'test/**/*.mjs', 'test/**/*.cjs'],
  'jest.list-tests': ['nexus-capture', '--out', '/out/ids.txt', '--', './node_modules/.bin/jest', '--listTests', '--json'],
  'vitest.list': ['nexus-capture', '--out', '/out/ids.txt', '--', './node_modules/.bin/vitest', 'list', '--json'],
  'mocha.dry-run': ['nexus-capture', '--out', '/out/ids.txt', '--', './node_modules/.bin/mocha', '--dry-run', '--reporter', 'json'],
  'pytest.collect-only': ['nexus-capture', '--out', '/out/ids.txt', '--', 'python', '-m', 'pytest', '--collect-only', '-q',
    '-p', 'no:cacheprovider'],
  // node:test runs each discovered file on its own (per-file JUnit, merged and attributed by the runner: A5).
  'node-test.junit': ['nexus-node-test', '--out-dir', '/out/junit', '--'],
  'jest.junit': ['./node_modules/.bin/jest', '--ci', '--reporters=/opt/nexus/reporters/node_modules/jest-junit'],
  'vitest.junit': ['./node_modules/.bin/vitest', 'run', '--reporter=junit', '--outputFile=/out/junit.xml'],
  'mocha.junit': ['./node_modules/.bin/mocha', '--reporter', '/opt/nexus/reporters/node_modules/mocha-junit-reporter',
    '--reporter-options', 'mochaFile=/out/junit.xml'],
  'pytest.junit': ['python', '-m', 'pytest', '-q', '--junitxml=/out/junit.xml', '-p', 'no:cacheprovider'],
  'npm.run-build': ['npm', 'run', 'build'],
  'entry.collect-output': ['nexus-collect', '--from', 'dist', '--to', '/out/dist'],
  'python.build-wheel': ['python', '-m', 'build', '--wheel', '--no-isolation', '--outdir', '/out/dist'],
  // A dev deployment: the app runs the manifest's validated argv (appended by main); the forwarder's target is appended.
  'app.manifest-run': [],
  'fwd.socat-loopback': ['socat', 'TCP-LISTEN:8080,fork,reuseaddr']
});

/** The forwarder listens on this port inside its container; the runner publishes it on 127.0.0.1 only. */
export const FORWARDER_PORT = 8080;
export const SERVICE_START_TIMEOUT_MS = 60_000;
export const SERVICE_HEALTH_INTERVAL_MS = 5_000;
/** The forwarder's own small limits (it only relays bytes). */
export const FORWARDER_LIMITS = Object.freeze({ cpus: 0.5, memoryMb: 128, tmpfsMb: 16, outputMaxBytes: 2 ** 20 });
export const MAX_RUN_ARGS = 32;
export const MAX_RUN_ARG_CHARS = 512;
const HEALTH_PATH_RE = /^\/[A-Za-z0-9/_.-]{0,200}$/;
const STAGED_PATH_RE = /^(?![./-])[A-Za-z0-9_@+=,.\- /]{1,1024}$/;
/** sandbox_json keeps each argv item to this many characters and at most RECORD_ARGV_ITEMS items (final review A1). */
export const RECORD_ARG_CHARS = 200;
export const RECORD_ARGV_ITEMS = 200;
/** Above this a record keeps only `argvCount` and `argvSha256` of each argv (attempts.ts refuses beyond 32 768). */
export const RECORD_MAX_CHARS = 30_000;

/** What a dev deployment's plan needs beyond a tool plan (main reads it from the application version and the probe). */
export interface ServiceContext {
  deploymentId: string;
  /** The application manifest (`nexus.app.json`), already validated by `app.manifest_schema`; re-checked here. */
  manifest: { profile: string; run: unknown; port: unknown; healthPath: unknown };
  forwarder: SandboxProfile | null;
  forwarderImageId: `sha256:${string}` | null;
  /** The build's files (blob sha256 and the path inside the build tree), staged into `in/dist/<path>`. */
  files: readonly { sha256: string; path: string }[];
  /** The fixed lifetime of a dev deployment (the containers' wall clock). */
  lifetimeMs: number;
}

/** A consumed approval as read from `approvals` (only the fields the builder checks). */
export interface PlanApproval {
  id: string; job_id: string | null; status: string; consumed_at: number | null;
  consumed_by_job_id: string | null; consumed_by_attempt_n: number | null;
}

export interface PlanInput {
  versionId: string; slot: string; contentHash: string;
  storage: { kind: string; commit?: string } & Record<string, unknown>;
  metadata: unknown;
}

export interface PlanContext {
  job: { id: string; projectId: string };
  attempt: { id: string; n: number };
  bootId: string;
  recipe: RecipeDef;
  /** Tool recipes: the sandbox profile main picked for this job, and the local image id of its pinned image. */
  profile?: SandboxProfile | null;
  imageId?: `sha256:${string}` | null;
  dataHomeRoot: string;
  workRel: string;
  logRel: string;
  inputs: readonly PlanInput[];
  framework?: TestFramework | null;
  /** The project folder, as main accepted it from the `projects` row (acceptFsRoot); null when refused. */
  repoPath?: string | null;
  approval?: PlanApproval | null;
  /** The service recipe only (a dev deployment). */
  service?: ServiceContext | null;
  /** `sde.diagnose` only (B2a Task 12): what main read from its own rows about the subject. */
  diagnose?: DiagnoseContext | null;
  /** Egress recipes only: the egress proxy's profile (sde-node) and the local id of its pinned image. */
  egressProxy?: { profile: SandboxProfile | null; imageId: `sha256:${string}` | null } | null;
  /**
   * The job's params as stored (`jobs.params_json`, parsed). Only the B2b git write recipes read them: the system writes
   * them when it queues the job (WorktreeService, ChangeSetService, AcceptService), and every value is checked here.
   */
  params?: unknown;
  /**
   * `changeset.collect` only (B2b Task 10): the session's recorded worktree, read by the core from `session_worktrees`. A
   * worktree reused by a new session (an interrupted session's) is named after the session it was made for, not the new
   * one, so its folder, git folder and session ref come from this row; without it they derive from the params' session.
   */
  worktree?: { relPath: string; ref: string } | null;
}

/**
 * What a diagnosis reads (main derives every value from its rows: the subject deployment's or job's attempts): the
 * subject's containers, and byte ranges of its attempts' logs (`logRel` as stored on the attempt row).
 */
export interface DiagnoseContext {
  target: 'deployment' | 'job';
  containerIds: readonly string[];
  logRanges: readonly { attemptId: string; logRel: string; offset: number; length: number; tail: boolean }[];
}

const refuse = (reason: string, message: string): never => { throw new PlatformError('invalid', message, { reason }); };
const COMMIT_RE = /^[0-9a-f]{40}$/;
const LOCK_RE = /^[0-9a-f]{64}$/;
const DISCOVERED_RE = /^(?![./-])[A-Za-z0-9_@+=,.\- /]{1,512}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * This install's `nexus.home` label (src/shared/nexus/homeLabel.ts, shared with the runner): every container, volume and
 * network of an attempt carries it; restart recovery removes only resources with this value. Re-exported here.
 */
export { homeLabel };

/**
 * The reference a container is created from: the local image id for an image Nexus built (every B2a profile; a built
 * image has no repository digest, so `repository@digest` would name the BASE image, which is not present), else the
 * pulled image's `repository@digest`. Preflight pins the local id either way.
 */
export function imageRef(profile: SandboxProfile, imageId: `sha256:${string}`): string {
  return profile.image.source === 'pulled' ? `${profile.image.repository}@${profile.image.digest}` : imageId;
}

/** The labels of an attempt's volumes and networks (and the base of its containers' labels). */
function attemptLabels(ctx: Pick<PlanContext, 'job' | 'attempt' | 'bootId' | 'dataHomeRoot'>): ResourceLabels {
  return { 'nexus.job': ctx.job.id, 'nexus.attempt': ctx.attempt.id, 'nexus.boot': ctx.bootId, 'nexus.project': ctx.job.projectId,
    'nexus.home': homeLabel(ctx.dataHomeRoot) };
}

/** A bind-mount source (and an adopted attempt's log path): `<root>/<rel>`, which must stay inside the data home. */
export function underDataHome(root: string, rel: string): string {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  const r = path.relative(base, full);
  if (r === '' || r.startsWith('..') || path.isAbsolute(r)) refuse('mount_outside_data_home', 'a mount must stay under the data home');
  return full;
}

/** The framework of a test recipe: the caller's, else the one the input version recorded, else the profile's default. */
export function pickFramework(recipe: RecipeDef, profileId: string | null, given: string | null | undefined, inputs: readonly PlanInput[]): TestFramework | null {
  const alternatives = recipe.argvTemplates.some((t) => FRAMEWORKS.some((f) => t.startsWith(`${f}.`)));
  if (!alternatives) return null;
  const meta = inputs.map((i) => (isPlainObject(i.metadata) ? i.metadata.framework : undefined)).find((x) => typeof x === 'string');
  const want = given ?? (typeof meta === 'string' ? meta : null) ?? (profileId === 'sde-python' ? 'pytest' : 'node-test');
  if (!(FRAMEWORKS as readonly string[]).includes(want)) refuse('bad_input', 'unknown test framework');
  if (!recipe.argvTemplates.some((t) => t.startsWith(`${want}.`))) refuse('bad_input', `the recipe has no ${want} template`);
  return want as TestFramework;
}

/** The discovered test files a node-test run is limited to (from an input version), validated as plain relative paths. */
function discoveredFiles(inputs: readonly PlanInput[]): string[] {
  for (const i of inputs) {
    const files = isPlainObject(i.metadata) ? i.metadata.files : undefined;
    if (!Array.isArray(files)) continue;
    if (files.length > MAX_DISCOVERED_FILES) refuse('bad_input', 'too many discovered files');
    for (const f of files) {
      if (typeof f !== 'string' || !DISCOVERED_RE.test(f) || f.split('/').some((s) => s === '..' || s === '' || s === '.')) {
        refuse('bad_input', 'a discovered file is not a plain relative path');
      }
      // The entry splits steps on this token: a value equal to it would cut the step in two (fix round 1, item 8).
      if (f === STEP_SEPARATOR) refuse('bad_input', 'a discovered file is the step separator');
    }
    return [...files] as string[];
  }
  return [];
}

export function expandArgv(recipe: RecipeDef, framework: TestFramework | null, inputs: readonly PlanInput[]): string[] {
  const ids = framework === null ? recipe.argvTemplates : recipe.argvTemplates.filter((t) => t.startsWith(`${framework}.`));
  const out: string[] = [];
  for (const id of ids) {
    const base = ARGV_TEMPLATES[id];
    if (!base) refuse('not_in_this_build', `argv template ${id} is not in this build`);
    if (out.length > 0) out.push(STEP_SEPARATOR);
    out.push(...base);
    if (id === 'node-test.junit') out.push(...discoveredFiles(inputs));
  }
  return out;
}

export function envFor(recipe: RecipeDef, profileId: string, framework: TestFramework | null): Record<string, string> {
  const env: Record<string, string> = { HOME: '/home/nexus', CI: 'true' };
  if (profileId === 'sde-node') {
    env.npm_config_cache = '/home/nexus/.npm';
    if (recipe.id.startsWith('sde.build.')) env.NODE_ENV = 'production';
    else if (recipe.id.startsWith('sde.test.')) env.NODE_ENV = 'test';
  }
  if (profileId === 'sde-python') { env.PIP_NO_INPUT = '1'; env.PYTHONPATH = '/deps'; env.PYTHONDONTWRITEBYTECODE = '1'; }
  if (framework === 'jest') env.JEST_JUNIT_OUTPUT_FILE = '/out/junit.xml';
  return checkEnv(env);
}

/** Every name allow-listed, every value free of secrets by both detectors. Returns a fresh copy. */
export function checkEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ALLOWED_ENV_NAMES.includes(k)) refuse('env_not_allowed', `environment name ${k.slice(0, 64)} is not allowed`);
    if (typeof v !== 'string' || v.includes('\0') || looksSecret(v) || containsSecret({ [k]: v })) {
      refuse('secret_in_env', `environment value of ${k} is refused`);
    }
    out[k] = v;
  }
  return out;
}

/** The network of a recipe's container. Egress only with this job's approval, consumed by this attempt. */
export function networkFor(recipe: RecipeDef, job: { id: string }, attempt: { n: number }, approval: PlanApproval | null | undefined): NetworkMode {
  if (recipe.network === 'none' || recipe.network === 'not-applicable') return { mode: 'none' };
  if (recipe.network === 'egress-approved') {
    const a = approval;
    if (!a || a.job_id !== job.id || a.status !== 'approved' || a.consumed_at === null
      || a.consumed_by_job_id !== job.id || a.consumed_by_attempt_n !== attempt.n) {
      return refuse('network_not_approved', 'egress needs an approval of this job, consumed by this attempt');
    }
    return { mode: 'egress-approved', approvalId: a.id, purpose: 'deps' };
  }
  return refuse('not_in_this_build', 'service networks arrive with dev deployments');
}

function sourceOf(inputs: readonly PlanInput[]): { commit: string } | null {
  for (const i of inputs) {
    const c = i.storage?.kind === 'git' ? i.storage.commit : isPlainObject(i.metadata) ? i.metadata.commit : undefined;
    if (typeof c === 'string') {
      if (!COMMIT_RE.test(c)) refuse('bad_input', 'an input commit is not a full sha');
      return { commit: c };
    }
  }
  return null;
}

/** The lockfile hash an input version recorded (`metadata.lockfile.sha256`), or null. */
export function lockfileSha256Of(inputs: readonly PlanInput[]): string | null {
  for (const i of inputs) {
    const lf = isPlainObject(i.metadata) ? i.metadata.lockfile : undefined;
    const sha = isPlainObject(lf) ? lf.sha256 : undefined;
    if (typeof sha === 'string' && LOCK_RE.test(sha)) return sha;
  }
  return null;
}

/** The dependency cache volume of a profile and the inputs' lockfile hash (`nexus-deps-<profile>-<lock12>`), or null. */
export function depsVolumeName(profileId: string | null | undefined, inputs: readonly PlanInput[]): string | null {
  const lock = lockfileSha256Of(inputs);
  return lock && typeof profileId === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(profileId) ? `nexus-deps-${profileId}-${lock.slice(0, 12)}` : null;
}
const depsVolume = depsVolumeName;

export function limitsFor(recipe: RecipeDef): ResourceLimits {
  const l = recipe.limits;
  if (!l) return refuse('not_in_this_build', 'an engine recipe has no container limits');
  return { cpus: l.cpus, memoryMb: l.memoryMb, pids: PIDS_LIMIT, wallClockMs: recipe.wallClockMs, outputMaxBytes: l.outputMaxBytes, tmpfsMb: TMPFS_MB };
}

/** Builds the plan for one attempt (see the module header). Throws PlatformError 'invalid' with a reason. */
export function buildPlan(ctx: PlanContext): AttemptPlan {
  const { recipe, job, attempt } = ctx;
  const base = {
    attemptId: attempt.id, jobId: job.id, attemptN: attempt.n, recipe: { id: recipe.id, version: recipe.version },
    workDir: underDataHome(ctx.dataHomeRoot, ctx.workRel), logPath: underDataHome(ctx.dataHomeRoot, ctx.logRel)
  };
  if (recipe.executor === 'engine') return buildEnginePlan(ctx, base);
  if (recipe.executor === 'service') return buildServicePlan(ctx, base);
  if (recipe.executor !== 'tool') return refuse('not_in_this_build', 'this executor is not in this build');
  const profile = ctx.profile;
  if (!profile || !recipe.profiles.includes(profile.id)) return refuse('image_missing', 'no sandbox profile for this recipe');
  if (!ctx.imageId || !/^sha256:[0-9a-f]{64}$/.test(ctx.imageId)) return refuse('image_missing', 'the profile image is not present');
  const framework = pickFramework(recipe, profile.id, ctx.framework, ctx.inputs);
  const source = sourceOf(ctx.inputs);
  if (source && !ctx.repoPath) refuse('project_folder_unavailable', 'the project folder is not available');
  const deps = depsVolume(profile.id, ctx.inputs);
  const egress = recipe.network === 'egress-approved';
  const mounts: MountSpec[] = [
    { kind: 'input', hostPath: underDataHome(ctx.dataHomeRoot, `${ctx.workRel}/in`), containerPath: '/in', readOnly: true },
    { kind: 'out', hostPath: underDataHome(ctx.dataHomeRoot, `${ctx.workRel}/out`), containerPath: '/out', readOnly: false },
    { kind: 'workspace', hostPath: `nexus-ws-${attempt.id}`, containerPath: '/workspace', readOnly: false }
  ];
  if (deps) mounts.push({ kind: 'deps', hostPath: deps, containerPath: profile.id === 'sde-python' ? '/deps' : '/workspace/node_modules', readOnly: !egress });
  const network = networkFor(recipe, job, attempt, ctx.approval);
  const container: ContainerSpec = {
    name: `nexus-${attempt.id.toLowerCase()}`,
    labels: { ...attemptLabels(ctx), 'nexus.kind': 'tool' },
    profile: profile.id,
    image: { ref: imageRef(profile, ctx.imageId), id: ctx.imageId },
    entrypoint: [...profile.entrypoint],
    argv: expandArgv(recipe, framework, ctx.inputs),
    imageEnv: [...profile.imageEnv],
    env: checkEnv({ ...envFor(recipe, profile.id, framework), NEXUS_WALL_SECONDS: wallSeconds(recipe.wallClockMs),
      ...(network.mode === 'egress-approved' ? egressClientEnv(profile.id) : {}) }),
    mounts,
    network,
    limits: limitsFor(recipe),
    readOnlyRootfs: true,
    capDrop: ['ALL'],
    noNewPrivileges: true
  };
  // An egress plan names the approval it consumed (networkFor checked it is this job's, consumed by this attempt).
  const approval = container.network.mode === 'egress-approved' && ctx.approval
    ? { approval: { id: ctx.approval.id, jobId: job.id, attemptN: attempt.n } } : {};
  const egressProxy = container.network.mode === 'egress-approved' ? { egressProxy: egressProxyFor(ctx, container.network.approvalId) } : {};
  const plan: ToolPlan = {
    ...base, kind: 'tool', container, resourceLabels: attemptLabels(ctx), ...approval, ...egressProxy,
    staging: {
      ...(source && ctx.repoPath ? { source: { repoPath: ctx.repoPath, commit: source.commit } } : {}),
      blobs: [],
      ...(deps ? { depsVolume: { name: deps, readOnly: !egress } } : {})
    },
    ...(framework === 'node-test' && recipe.id === 'sde.test.node' ? { perFileJunit: { dir: 'junit' as const, files: discoveredFiles(ctx.inputs) } } : {}),
    outputContract: { required: [...recipe.outputContract.required], maxFiles: 10_000 },
    parse: recipe.parsers.map((p) => ({ parser: p, relPath: p === 'junit' ? 'junit.xml' : p === 'discovery' ? 'ids.txt' : '' }))
      .filter((x) => x.relPath !== '')
  };
  return plan;
}

/**
 * The Nexus egress proxy of an approved install (B2a stabilization, constraint 5): the pinned sde-node image, the fixed
 * proxy command, the recipe's allow-list in NEXUS_EGRESS_ALLOW, no mount, small limits, the install's wall clock; on the
 * job's internal network (alias nexus-egress-proxy) and its outbound bridge. Refused without an allow-list or the image.
 */
function egressProxyFor(ctx: PlanContext, approvalId: string): NonNullable<ToolPlan['egressProxy']> {
  const { recipe, job, attempt } = ctx;
  const allow = egressAllowFor(recipe.id);
  if (!allow || allow.length === 0) return refuse('network_not_approved', 'this recipe has no egress allow-list');
  const p = ctx.egressProxy;
  if (!p || !p.profile || p.profile.id !== EGRESS_PROXY_PROFILE) return refuse('image_missing', 'the egress proxy image (sde-node) is not present');
  if (!p.imageId || !/^sha256:[0-9a-f]{64}$/.test(p.imageId)) return refuse('image_missing', 'the egress proxy image (sde-node) is not present');
  const container: ContainerSpec = {
    name: `nexus-${attempt.id.toLowerCase()}-proxy`, labels: { ...attemptLabels(ctx), 'nexus.kind': 'egress-proxy' }, profile: p.profile.id,
    image: { ref: imageRef(p.profile, p.imageId), id: p.imageId }, entrypoint: [...p.profile.entrypoint], argv: [...EGRESS_PROXY_ARGV],
    imageEnv: [...p.profile.imageEnv],
    env: checkEnv({ HOME: '/home/nexus', NEXUS_WALL_SECONDS: wallSeconds(recipe.wallClockMs), NEXUS_EGRESS_ALLOW: formatAllow(allow) }),
    mounts: [], network: { mode: 'egress-proxy', approvalId },
    limits: { cpus: EGRESS_PROXY_LIMITS.cpus, memoryMb: EGRESS_PROXY_LIMITS.memoryMb, pids: PIDS_LIMIT, wallClockMs: recipe.wallClockMs,
      outputMaxBytes: EGRESS_PROXY_LIMITS.outputMaxBytes, tmpfsMb: EGRESS_PROXY_LIMITS.tmpfsMb },
    readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true
  };
  return { container, networks: { internal: egressInternalNetwork(job.id), outbound: egressOutboundNetwork(job.id) } };
}

/** The manifest's run argv as a container argv: 1-32 plain strings, none secret-shaped. Never a shell string. */
export function checkRunArgv(run: unknown): string[] {
  if (!Array.isArray(run) || run.length < 1 || run.length > MAX_RUN_ARGS) return refuse('bad_input', 'the app manifest run list is not 1 to 32 arguments');
  const out: string[] = [];
  for (const a of run as unknown[]) {
    if (typeof a !== 'string' || a.length === 0 || a.length > MAX_RUN_ARG_CHARS || a.includes('\0')) refuse('bad_input', 'an app manifest argument is not plain text');
    // The Nexus entry splits a command into steps on this token: the app's argv may never hold it (fix round 1, item 8).
    if (a === STEP_SEPARATOR) refuse('bad_input', 'an app manifest argument is the step separator');
    if (looksSecret(a as string) || containsSecret([a])) refuse('secret_in_argv', 'an app manifest argument is secret-shaped');
    out.push(a as string);
  }
  return out;
}

type ServiceBase = Omit<ServicePlan, 'kind' | 'deploymentId' | 'app' | 'forwarder' | 'networks' | 'resourceLabels' | 'health' | 'idleTtlMs' | 'staging'>;

function buildServicePlan(ctx: PlanContext, base: ServiceBase): ServicePlan {
  const { recipe, job, attempt } = ctx;
  const s = ctx.service;
  if (!s || typeof s.deploymentId !== 'string' || s.deploymentId.length === 0) return refuse('bad_input', 'a dev deployment needs its deployment and manifest');
  const profile = ctx.profile;
  if (!profile || profile.id !== s.manifest.profile || !recipe.profiles.includes(profile.id) || profile.id === 'nexus-fwd') {
    return refuse('image_missing', 'no sandbox profile for this app');
  }
  if (!ctx.imageId || !/^sha256:[0-9a-f]{64}$/.test(ctx.imageId)) return refuse('image_missing', 'the app profile image is not present');
  const fwd = s.forwarder;
  if (!fwd || fwd.id !== 'nexus-fwd' || !s.forwarderImageId || !/^sha256:[0-9a-f]{64}$/.test(s.forwarderImageId)) {
    return refuse('image_missing', 'the forwarder image is not present');
  }
  const port = s.manifest.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) return refuse('bad_input', 'the app port is out of range');
  const healthPath = s.manifest.healthPath;
  if (typeof healthPath !== 'string' || !HEALTH_PATH_RE.test(healthPath)) return refuse('bad_input', 'the health path is not a plain path');
  const argv = checkRunArgv(s.manifest.run);
  const lifetime = s.lifetimeMs;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) return refuse('bad_input', 'a dev deployment needs a lifetime');
  for (const f of s.files) {
    if (typeof f?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || typeof f.path !== 'string' || !STAGED_PATH_RE.test(f.path)
      || f.path.split('/').some((x) => x === '' || x === '.' || x === '..')) {
      refuse('bad_input', 'a build file is not a plain relative path');
    }
  }
  const source = sourceOf(ctx.inputs);
  if (source && !ctx.repoPath) refuse('project_folder_unavailable', 'the project folder is not available');
  const deps = depsVolume(profile.id, ctx.inputs);
  const internal = `nexus-svc-${job.id.toLowerCase()}`;
  const publish = `nexus-pub-${job.id.toLowerCase()}`;
  const labels = (kind: string): ContainerSpec['labels'] => ({ ...attemptLabels(ctx), 'nexus.kind': kind });
  const mounts: MountSpec[] = [
    { kind: 'input', hostPath: underDataHome(ctx.dataHomeRoot, `${ctx.workRel}/in`), containerPath: '/in', readOnly: true },
    { kind: 'out', hostPath: underDataHome(ctx.dataHomeRoot, `${ctx.workRel}/out`), containerPath: '/out', readOnly: false },
    { kind: 'workspace', hostPath: `nexus-ws-${attempt.id}`, containerPath: '/workspace', readOnly: false }
  ];
  if (deps) mounts.push({ kind: 'deps', hostPath: deps, containerPath: profile.id === 'sde-python' ? '/deps' : '/workspace/node_modules', readOnly: true });
  const network: NetworkMode = { mode: 'service-internal', network: internal };
  const app: ContainerSpec = {
    name: `nexus-${attempt.id.toLowerCase()}-app`, labels: labels('service'), profile: profile.id,
    image: { ref: imageRef(profile, ctx.imageId), id: ctx.imageId },
    entrypoint: [...profile.entrypoint], argv, imageEnv: [...profile.imageEnv],
    env: checkEnv({ ...envFor(recipe, profile.id, null), NEXUS_WALL_SECONDS: wallSeconds(lifetime) }), mounts, network,
    limits: { ...limitsFor(recipe), wallClockMs: lifetime }, readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true,
    service: { containerPort: port, healthPath }
  };
  const forwarder: ContainerSpec = {
    name: `nexus-${attempt.id.toLowerCase()}-fwd`, labels: labels('forwarder'), profile: 'nexus-fwd',
    image: { ref: imageRef(fwd, s.forwarderImageId), id: s.forwarderImageId },
    entrypoint: [...fwd.entrypoint], argv: [...ARGV_TEMPLATES['fwd.socat-loopback'], `TCP:app:${port}`], imageEnv: [...fwd.imageEnv],
    env: checkEnv({ HOME: '/home/nexus', NEXUS_WALL_SECONDS: wallSeconds(lifetime) }), mounts: [], network,
    limits: { cpus: FORWARDER_LIMITS.cpus, memoryMb: FORWARDER_LIMITS.memoryMb, pids: PIDS_LIMIT, wallClockMs: lifetime,
      outputMaxBytes: FORWARDER_LIMITS.outputMaxBytes, tmpfsMb: FORWARDER_LIMITS.tmpfsMb },
    readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true,
    publish: { hostIp: '127.0.0.1', hostPort: 0, containerPort: FORWARDER_PORT }
  };
  return {
    ...base, kind: 'service', deploymentId: s.deploymentId, app, forwarder, networks: { internal, publish }, resourceLabels: attemptLabels(ctx),
    health: { path: healthPath, startTimeoutMs: SERVICE_START_TIMEOUT_MS, intervalMs: SERVICE_HEALTH_INTERVAL_MS },
    idleTtlMs: lifetime,
    staging: {
      ...(source && ctx.repoPath ? { source: { repoPath: ctx.repoPath, commit: source.commit } } : {}),
      blobs: s.files.map((f) => ({ sha256: f.sha256, relPath: `dist/${f.path}` })),
      ...(deps ? { depsVolume: { name: deps, readOnly: true } } : {})
    }
  };
}

const LOG_REL_RE = /^logs\/jobs\/[0-9A-Za-z_-]{1,64}\/[1-9][0-9]{0,6}\.log$/;
const ULID_PLAN_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function buildDiagnosePlan(ctx: PlanContext, base: Omit<EnginePlan, 'kind' | 'task' | 'wallClockMs'>): EnginePlan {
  const d = ctx.diagnose;
  if (!d || (d.target !== 'deployment' && d.target !== 'job')) return refuse('bad_input', 'a diagnosis needs its subject');
  if (!Array.isArray(d.containerIds) || d.containerIds.length > DIAGNOSE_MAX_CONTAINERS
    || !d.containerIds.every((c) => typeof c === 'string' && /^[0-9a-f]{64}$/.test(c))) return refuse('bad_input', 'the diagnosed containers are not container ids');
  if (!Array.isArray(d.logRanges) || d.logRanges.length > DIAGNOSE_MAX_RANGES) return refuse('bad_input', 'too many log ranges');
  const logRanges = d.logRanges.map((r) => {
    if (typeof r?.attemptId !== 'string' || !ULID_PLAN_RE.test(r.attemptId) || typeof r.logRel !== 'string' || !LOG_REL_RE.test(r.logRel)
      || !Number.isSafeInteger(r.offset) || r.offset < 0 || !Number.isSafeInteger(r.length) || r.length < 0 || r.length > DIAGNOSE_RANGE_MAX_BYTES
      || typeof r.tail !== 'boolean') {
      return refuse('bad_input', 'a log range is not an attempt log range');
    }
    return { attemptId: r.attemptId, logPath: underDataHome(ctx.dataHomeRoot, r.logRel), offset: r.offset, length: r.length, tail: r.tail };
  });
  if (d.containerIds.length === 0 && logRanges.length === 0) return refuse('bad_input', 'the subject has nothing to diagnose yet');
  return { ...base, kind: 'engine', task: { engine: 'sde.diagnose', target: d.target, containerIds: [...d.containerIds], logRanges },
    wallClockMs: ctx.recipe.wallClockMs };
}

/** The B2b git write recipes (B2b Task 7), each a system child job; their plans come from `buildGitEnginePlan`. */
export const GIT_ENGINE_RECIPES: readonly string[] = Object.freeze(['repo.worktree', 'changeset.collect', 'changeset.merge_check', 'changeset.accept',
  'changeset.accept_rollback', 'repo.ff']);
/** The engine recipes main plans (each has its branch below; the registry check pins this list to B2B_IMPL). */
export const ENGINE_TASK_RECIPES: readonly string[] = Object.freeze(['repo.snapshot', 'sde.app.assemble', 'sde.diagnose', ...GIT_ENGINE_RECIPES]);
/** The collect guard's caps (F12): 50 MiB per file, 8 GiB per worktree (the runner's worktreeGuard defaults). */
export const CHANGESET_MAX_FILE_BYTES = 50 * 2 ** 20;
export const CHANGESET_MAX_TOTAL_BYTES = 8 * 2 ** 30;
/** A branch name `refs/nexus/accepted/<branch>` may carry (check-ref-format's rules, conservatively; the runner's BRANCH_RE). */
export const GIT_BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\/\.)(?!\.)(?!.*\.lock(?:\/|$))(?!.*[/.]$)[A-Za-z0-9._/-]{1,200}$/;
const SESSION_ID_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
const SCOPE_RE = /^!?(?![:/\\])[^\0\r\n]{1,512}$/;
export const MAX_SCOPE_ENTRIES = 64;

/** The session's lowercased name: the worktree folder, the worktree's git folder and the session ref's last segment. */
export function sessionName(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return refuse('bad_input', 'the session id is malformed');
  return sessionId.toLowerCase();
}
export const sessionRefOf = (sessionId: string): string => `refs/nexus/job/${sessionName(sessionId)}`;
export function integrationRefOf(branch: unknown): string {
  if (typeof branch !== 'string' || !GIT_BRANCH_RE.test(branch)) return refuse('bad_input', 'the branch name is not usable');
  return `refs/nexus/accepted/${branch}`;
}
const oneLine = (v: unknown, fallback: string): string => {
  const t = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : '';
  return t.length > 0 ? t : fallback;
};
const commitParam = (p: Record<string, unknown>, k: string): string => {
  const v = p[k];
  if (typeof v !== 'string' || !COMMIT_RE.test(v)) return refuse('bad_input', `${k} is not a full commit id`);
  return v;
};
const jobIdParam = (p: Record<string, unknown>, k: string): string => {
  const v = p[k];
  if (typeof v !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(v)) return refuse('bad_input', `${k} is not a job id`);
  return v;
};

/** A B2b git write recipe's plan (see the module header). */
function buildGitEnginePlan(ctx: PlanContext, base: Omit<EnginePlan, 'kind' | 'task' | 'wallClockMs'>, repoPath: string): EnginePlan {
  const p = isPlainObject(ctx.params) ? ctx.params : null;
  if (!p) return refuse('bad_input', 'a git job needs its params');
  if (containsSecret(p)) return refuse('bad_input', 'the git job params hold a secret-shaped value');
  const wallClockMs = ctx.recipe.wallClockMs;
  const plan = (task: EnginePlan['task']): EnginePlan => ({ ...base, kind: 'engine', task, wallClockMs });
  switch (ctx.recipe.id) {
    case 'repo.worktree': {
      const name = sessionName(p.sessionId);
      return plan({ engine: 'repo.worktree', repoPath, worktreePath: underDataHome(ctx.dataHomeRoot, `wt/${name}`), ref: `refs/nexus/job/${name}`,
        integrationRef: integrationRefOf(p.branch), branch: p.branch as string,
        // B6: the integration head main recorded (null: none known, so the ref is never moved).
        expectedIntegrationHead: p.integrationBaseline === undefined || p.integrationBaseline === null ? null : commitParam(p, 'integrationBaseline'),
        allowRewrite: p.allowRewrite === true });
    }
    case 'changeset.collect': {
      let name = sessionName(p.sessionId);
      let sessionRef = `refs/nexus/job/${name}`;
      const wt = ctx.worktree ?? null;
      if (wt) {
        const m = /^wt\/([0-9a-z]{26})$/.exec(wt.relPath);
        if (!m || wt.ref !== `refs/nexus/job/${m[1]}`) return refuse('bad_input', 'the recorded worktree is not a session worktree');
        name = m[1]; sessionRef = wt.ref;
      }
      const scope = p.scope === undefined ? [] : p.scope;
      if (!Array.isArray(scope) || scope.length > MAX_SCOPE_ENTRIES || !scope.every((x) => typeof x === 'string' && SCOPE_RE.test(x) && !x.includes('..'))) {
        return refuse('bad_input', 'the scope is not a list of relative patterns');
      }
      const message = `${oneLine(p.title, 'Agent change')}\n\nNexus-Job: ${jobIdParam(p, 'turnJobId')}\n`;
      return plan({ engine: 'changeset.collect', repoPath, worktreePath: underDataHome(ctx.dataHomeRoot, `wt/${name}`),
        gitDir: path.join(repoPath, '.git', 'worktrees', name), ref: sessionRef, integrationRef: integrationRefOf(p.branch),
        scope: [...scope] as string[], message, maxFileBytes: CHANGESET_MAX_FILE_BYTES, maxTotalBytes: CHANGESET_MAX_TOTAL_BYTES });
    }
    case 'changeset.merge_check':
      return plan({ engine: 'changeset.merge_check', repoPath, integrationRef: integrationRefOf(p.branch), head: commitParam(p, 'head') });
    case 'changeset.accept': {
      const message = `${oneLine(p.title, 'Accept the agent\'s change')}\n\nNexus-Accepted-By: user:local\n`;
      return plan({ engine: 'changeset.accept', repoPath, integrationRef: integrationRefOf(p.branch), expectedOld: commitParam(p, 'expectedOld'),
        head: commitParam(p, 'head'), message });
    }
    case 'changeset.accept_rollback':
      return plan({ engine: 'changeset.accept_rollback', repoPath, integrationRef: integrationRefOf(p.branch), from: commitParam(p, 'from'), to: commitParam(p, 'to') });
    case 'repo.ff': {
      integrationRefOf(p.branch);
      return plan({ engine: 'repo.ff', repoPath, branch: p.branch as string, sha: commitParam(p, 'sha') });
    }
    default: return refuse('not_in_this_build', `${ctx.recipe.id} is not an engine task of this build`);
  }
}

/**
 * The recipes main can build a plan for: an engine recipe with its branch here, or a container recipe (tool or service)
 * whose every argv template exists in ARGV_TEMPLATES.
 */
export function plannedRecipeIds(recipes: readonly RecipeDef[]): string[] {
  return recipes.filter((r) => (r.executor === 'engine' ? ENGINE_TASK_RECIPES.includes(r.id)
    : r.argvTemplates.length > 0 && r.argvTemplates.every((t) => Object.prototype.hasOwnProperty.call(ARGV_TEMPLATES, t)))).map((r) => r.id);
}

function buildEnginePlan(ctx: PlanContext, base: Omit<EnginePlan, 'kind' | 'task' | 'wallClockMs'>): EnginePlan {
  if (!ENGINE_TASK_RECIPES.includes(ctx.recipe.id)) return refuse('not_in_this_build', `${ctx.recipe.id} is not an engine task of this build`);
  // A diagnosis reads Docker and the data home only: it needs no project folder.
  if (ctx.recipe.id === 'sde.diagnose') return buildDiagnosePlan(ctx, base);
  const repoPath = ctx.repoPath;
  if (!repoPath) return refuse('project_folder_unavailable', 'the project folder is not available');
  if (ctx.recipe.id === 'repo.snapshot') return { ...base, kind: 'engine', task: { engine: 'repo.snapshot', repoPath }, wallClockMs: ctx.recipe.wallClockMs };
  if (GIT_ENGINE_RECIPES.includes(ctx.recipe.id)) return buildGitEnginePlan(ctx, base, repoPath);
  if (ctx.recipe.id === 'sde.app.assemble') {
    const src = sourceOf(ctx.inputs);
    if (!src) return refuse('bad_input', 'assembly needs the commit of its build');
    return { ...base, kind: 'engine', task: { engine: 'sde.app.assemble', repoPath, commit: src.commit }, wallClockMs: ctx.recipe.wallClockMs };
  }
  return refuse('not_in_this_build', `${ctx.recipe.id} is not an engine task of this build`);
}

// ---------- agent turns (B2b Task 10) ----------

/** The recipe id and version an agent turn's plan carries (it is no recipe: the turn is not leased by the recipe scheduler). */
export const AGENT_TURN_RECIPE = Object.freeze({ id: 'agent.turn', version: '1' });
/** The container outlives its turn's wall clock by this much (a `sleep`; the entry's own backstop is twice the wall clock). */
export const AGENT_SLEEP_MARGIN_S = 120;
/** A turn's container reserves this much memory (it counts as one job slot with it). */
export const AGENT_TURN_MEMORY_MB = 1024;

/** What an agent turn's plan needs beyond the ids (main reads each value from its own rows; nothing comes from the renderer). */
export interface AgentPlanContext {
  job: { id: string; projectId: string };
  attempt: { id: string; n: number };
  bootId: string;
  dataHomeRoot: string;
  workRel: string;
  logRel: string;
  profile: SandboxProfile | null;
  imageId: `sha256:${string}` | null;
  /** The session worktree as a recorded row and WorktreeService.ensure know it (host paths under the data home / the repository). */
  worktree: { relPath: string; gitDir: string; ref: string; base: string };
  runtime: {
    kind: string; token: string; sessionId: string; idempotencyKey: string; domainId: string;
    skills: readonly { id: string; version: string; sha256: string }[];
    context: { hash: string };
    message: string; mcpUrl: string; model: { provider: string; model: string };
  };
  /** The live consent's hosts and its recorded `hosts_sha256` (never derived from `allow`). */
  egress: { allow: readonly { host: string; port: number }[]; consentHostsSha256: string };
  caps: { turnTokens: number; turnUsdCents: number; dayRemainingUsdCents: number; toolCalls: number };
  wallClockMs: number;
  /** The token's own `mcpTools` claim. */
  mcpTools: readonly string[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The plan of one agent turn: the turn's own container (`sleep <s>`, the worktree bound read-write at `/workspace`,
 * network `none`; every command the agent runs goes into it through `sandbox_exec`), the runtime request (the context
 * file, the skills, the loopback MCP url), the turn's token (over the MessagePort only), the live consent's hosts and hash,
 * and its caps. Pure. Errors are PlatformError 'invalid' with a reason.
 */
export function buildAgentPlan(ctx: AgentPlanContext): AgentPlan {
  const { job, attempt } = ctx;
  const profile = ctx.profile;
  if (!profile) return refuse('image_missing', 'no sandbox profile for the agent turn');
  if (!ctx.imageId || !/^sha256:[0-9a-f]{64}$/.test(ctx.imageId)) return refuse('image_missing', 'the profile image is not present');
  if (!Number.isSafeInteger(ctx.wallClockMs) || ctx.wallClockMs <= 0) return refuse('bad_input', 'a turn needs a wall clock');
  if (!/^wt\/[0-9a-z]{26}$/.test(ctx.worktree.relPath)) return refuse('bad_input', 'the worktree is not a session folder');
  if (typeof ctx.runtime.token !== 'string' || ctx.runtime.token.length === 0) return refuse('bad_input', 'a turn needs its token');
  if (!SHA256_HEX.test(ctx.egress.consentHostsSha256)) return refuse('consent_mismatch', 'the live consent carries no valid hosts hash');
  const worktreePath = underDataHome(ctx.dataHomeRoot, ctx.worktree.relPath);
  const configDir = underDataHome(ctx.dataHomeRoot, `jobs/${job.id}/agent`);
  const labels = attemptLabels({ job, attempt, bootId: ctx.bootId, dataHomeRoot: ctx.dataHomeRoot });
  const container: ContainerSpec = {
    name: `nexus-${attempt.id.toLowerCase()}`,
    labels: { ...labels, 'nexus.kind': 'agent' },
    profile: profile.id,
    image: { ref: imageRef(profile, ctx.imageId), id: ctx.imageId },
    entrypoint: [...profile.entrypoint],
    argv: ['sleep', String(Math.ceil(ctx.wallClockMs / 1000) + AGENT_SLEEP_MARGIN_S)],
    imageEnv: [...profile.imageEnv],
    env: checkEnv({ HOME: '/home/nexus', CI: 'true', NEXUS_WALL_SECONDS: wallSeconds(ctx.wallClockMs) }),
    mounts: [{ kind: 'worktree', hostPath: worktreePath, containerPath: '/workspace', readOnly: false }],
    network: { mode: 'none' },
    limits: { cpus: profile.defaults.cpus, memoryMb: AGENT_TURN_MEMORY_MB, pids: PIDS_LIMIT, wallClockMs: ctx.wallClockMs,
      outputMaxBytes: profile.defaults.outputMaxBytes, tmpfsMb: TMPFS_MB },
    readOnlyRootfs: true,
    capDrop: ['ALL'],
    noNewPrivileges: true
  };
  const cents = Math.max(0, Math.min(ctx.caps.turnUsdCents, ctx.caps.dayRemainingUsdCents));
  const request: RunRequest = {
    jobId: job.id, attempt: attempt.n, sessionId: ctx.runtime.sessionId, idempotencyKey: ctx.runtime.idempotencyKey,
    domainId: ctx.runtime.domainId,
    skills: ctx.runtime.skills.map((s) => ({ id: s.id, version: s.version, dir: configDir, sha256: s.sha256 })),
    context: { hash: ctx.runtime.context.hash, file: path.join(configDir, 'context.md') },
    message: ctx.runtime.message,
    worktree: { hostPath: worktreePath, editable: ['/workspace'] },
    container: { id: 'pending' },
    mcp: { url: ctx.runtime.mcpUrl },
    model: ctx.runtime.model,
    limits: { wallClockMs: ctx.wallClockMs, maxTurns: ctx.caps.toolCalls, maxCostUsd: cents / 100 },
    credential: { ref: 'runtime-owned' },
    configDir
  };
  return {
    attemptId: attempt.id, jobId: job.id, attemptN: attempt.n, recipe: { ...AGENT_TURN_RECIPE },
    workDir: underDataHome(ctx.dataHomeRoot, ctx.workRel), logPath: underDataHome(ctx.dataHomeRoot, ctx.logRel),
    kind: 'agent', container,
    worktree: { hostPath: worktreePath, gitDir: ctx.worktree.gitDir, ref: ctx.worktree.ref, base: ctx.worktree.base, editable: ['/workspace'] },
    runtime: { kind: ctx.runtime.kind as RuntimeKind, request, token: ctx.runtime.token },
    egress: { allow: ctx.egress.allow.map((h) => ({ host: h.host, port: h.port })), consentHostsSha256: ctx.egress.consentHostsSha256 },
    caps: { ...ctx.caps },
    mcpTools: [...ctx.mcpTools],
    resourceLabels: labels
  };
}

/**
 * What an agent attempt's `sandbox_json` records (F31): the profile, image, limits, network, mounts (the destination and
 * `kind` only: never a host path), the runtime kind, the adapter version, the flags sha256, the skills' sha256 values, the
 * context sha256 and the proxy allow-list, plus the turn's caps (main's own recovery of them at every usage event). Never
 * the token, the message, the config path or the worktree's host path.
 */
export function agentSandboxRecord(plan: AgentPlan, extra: { adapterVersion: string | null; flagsSha256: string | null }): Record<string, unknown> {
  const c = plan.container;
  return {
    executor: 'agent', name: c.name, profile: c.profile, image: c.image,
    limits: c.limits, network: c.network,
    mounts: c.mounts.map((m) => ({ kind: m.kind, containerPath: m.containerPath, readOnly: m.readOnly })),
    readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true,
    runtime: { kind: plan.runtime.kind, adapterVersion: extra.adapterVersion, flagsSha256: extra.flagsSha256 },
    skills: plan.runtime.request.skills.map((s) => ({ id: s.id, version: s.version, sha256: s.sha256 })),
    context: { sha256: plan.runtime.request.context.hash },
    egress: { allow: plan.egress.allow.map((h) => `${h.host}:${h.port}`), consentHostsSha256: plan.egress.consentHostsSha256 ?? null },
    turn: { tokens: plan.caps.turnTokens, usdCents: plan.caps.turnUsdCents, dayRemainingUsdCents: plan.caps.dayRemainingUsdCents,
      toolCalls: plan.caps.toolCalls, wallClockMs: c.limits.wallClockMs },
    mcpTools: plan.mcpTools ?? null
  };
}

/** What an agent attempt's `environment_json` records: the runtime kind, its version, the model id (opaque) and the image. */
export function agentEnvironmentRecord(plan: AgentPlan, extra: { runtimeVersion: string | null; nexusVersion: string | null; dockerVersion: string | null;
  runnerBootId: string | null }): Record<string, unknown> {
  return {
    executor: 'agent', recipeId: AGENT_TURN_RECIPE.id, recipeVersion: AGENT_TURN_RECIPE.version, profile: plan.container.profile,
    imageRef: plan.container.image.ref, imageId: plan.container.image.id,
    runtimeKind: plan.runtime.kind, runtimeVersion: extra.runtimeVersion, model: plan.runtime.request.model.model,
    dockerVersion: extra.dockerVersion, runnerBootId: extra.runnerBootId, nexusVersion: extra.nexusVersion
  };
}

/** What `job_attempts.sandbox_json` records of a plan: argv, env NAMES, mounts without host paths, network, limits. */
export function sandboxRecord(plan: AttemptPlan): Record<string, unknown> {
  if (plan.kind === 'agent') return agentSandboxRecord(plan, { adapterVersion: null, flagsSha256: null });
  if (plan.kind === 'engine') {
    const t = plan.task;
    return { executor: 'engine', engine: t.engine, network: 'not-applicable', wallClockMs: plan.wallClockMs,
      // A diagnosis records exactly what it was planned to read (fix round 1, item 11: ingest holds the report to it).
      // Container ids sit under `sha256` keys (the redactor reads a hex digest as an integrity hash only there).
      ...(t.engine === 'sde.diagnose' ? { target: t.target, containers: t.containerIds.length, containerIds: t.containerIds.map((c) => ({ sha256: c })),
        logRanges: t.logRanges.map((r) => ({ attemptId: r.attemptId, offset: r.offset, length: r.length, tail: r.tail })) } : {}),
      // A git write records the refs and commits it was planned to write (never a host path).
      ...gitRecord(t) };
  }
  if (plan.kind === 'service') {
    const rec = (c: ContainerSpec): Record<string, unknown> => ({
      name: c.name, profile: c.profile, image: c.image, entrypoint: c.entrypoint, argv: c.argv.slice(0, MAX_RUN_ARGS).map((x) => x.slice(0, RECORD_ARG_CHARS)),
      argvCount: c.argv.length, argvSha256: createHash('sha256').update(JSON.stringify(c.argv)).digest('hex'), envNames: Object.keys(c.env).sort(),
      mounts: c.mounts.map((m) => ({ kind: m.kind, containerPath: m.containerPath, readOnly: m.readOnly })), network: c.network, limits: c.limits,
      ...(c.service ? { service: c.service } : {}), ...(c.publish ? { publish: { hostIp: c.publish.hostIp, containerPort: c.publish.containerPort } } : {})
    });
    return boundedRecord({
      executor: 'service', deploymentId: plan.deploymentId, image: plan.app.image, network: plan.app.network, app: rec(plan.app),
      forwarder: rec(plan.forwarder), networks: plan.networks, health: plan.health, idleTtlMs: plan.idleTtlMs, user: '10001:10001',
      readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true, stagedFiles: plan.staging.blobs.length
    });
  }
  if (plan.kind !== 'tool') return { executor: 'unknown' };
  const c = plan.container;
  // Each item capped as the service branch does (final review A1: 200 long test paths no longer overflow the column).
  const argv = c.argv.slice(0, RECORD_ARGV_ITEMS).map((x) => x.slice(0, RECORD_ARG_CHARS));
  const argvSha256 = createHash('sha256').update(JSON.stringify(c.argv)).digest('hex');
  // An approved install records its proxy too: the image, the command, the allow-list it enforced and both networks.
  const px = plan.egressProxy;
  const egress = px ? { egressProxy: { name: px.container.name, profile: px.container.profile, image: px.container.image, entrypoint: px.container.entrypoint,
    argv: px.container.argv, envNames: Object.keys(px.container.env).sort(), allow: (px.container.env.NEXUS_EGRESS_ALLOW ?? '').split(',').filter(Boolean),
    network: px.container.network, networks: px.networks, limits: px.container.limits } } : {};
  return boundedRecord({
    executor: 'tool', name: c.name, profile: c.profile, image: c.image, entrypoint: c.entrypoint, argv, argvCount: c.argv.length, argvSha256,
    envNames: Object.keys(c.env).sort(), mounts: c.mounts.map((m) => ({ kind: m.kind, containerPath: m.containerPath, readOnly: m.readOnly })),
    network: c.network, limits: c.limits, user: '10001:10001', readOnlyRootfs: c.readOnlyRootfs, capDrop: c.capDrop,
    noNewPrivileges: c.noNewPrivileges, tmpfs: { '/tmp': `${c.limits.tmpfsMb}m`, '/home/nexus': '256m' },
    sizeGuard: { outputMaxBytes: c.limits.outputMaxBytes, pollMs: 5000 }, ...egress
  });
}

/** What a git write's sandbox record names: its refs, branch, commits and scope (no host path, no message). */
function gitRecord(t: EnginePlan['task']): Record<string, unknown> {
  switch (t.engine) {
    case 'repo.worktree': return { git: { ref: t.ref, integrationRef: t.integrationRef, branch: t.branch, worktree: `wt/${path.basename(t.worktreePath)}` } };
    case 'changeset.collect': return { git: { ref: t.ref, integrationRef: t.integrationRef, worktree: `wt/${path.basename(t.worktreePath)}`, scope: t.scope.slice(0, MAX_SCOPE_ENTRIES),
      maxFileBytes: t.maxFileBytes, maxTotalBytes: t.maxTotalBytes } };
    case 'changeset.merge_check': return { git: { integrationRef: t.integrationRef, head: t.head } };
    case 'changeset.accept': return { git: { integrationRef: t.integrationRef, expectedOld: t.expectedOld, head: t.head } };
    case 'changeset.accept_rollback': return { git: { integrationRef: t.integrationRef, from: t.from, to: t.to } };
    case 'repo.ff': return { git: { branch: t.branch, sha: t.sha } };
    default: return {};
  }
}

/** Drops every `argv` list (keeping `argvCount` and `argvSha256`) at any depth: what fits a record of any plan. */
function withoutArgvLists(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutArgvLists);
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'argv' && Array.isArray(x)) { out.argvOmitted = true; continue; }
    out[k] = withoutArgvLists(x);
  }
  return out;
}

/**
 * A sandbox record that always fits `job_attempts.sandbox_json` (final review A1): above RECORD_MAX_CHARS the argv lists
 * give way to their count and sha256 (`argvOmitted: true`), which still name exactly what ran. Callers that add facts to
 * a record (the provisioned report, a resumed plan) pass the whole record through this again.
 */
export function boundedRecord(rec: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(rec).length <= RECORD_MAX_CHARS) return rec;
  return withoutArgvLists(rec) as Record<string, unknown>;
}
