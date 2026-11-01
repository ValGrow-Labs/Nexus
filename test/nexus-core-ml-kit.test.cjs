'use strict';
// The machine learning kit (ml-python), pure parts: which profile a project's runs and its AI helper get, how a plan in the kit
// looks (no dependency volume, no PYTHONPATH, pytest), the recipes that may run in it (offline runs only: never an install, never a
// preview), and the plain words a person sees for it. Plain node: no database file, no Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { profileFromFacts, agentProfileFromFacts, projectSandboxProfile, forProject, isMachineLearningProject, anyMachineLearningProject, ML_WORKSPACE_ID, ML_PROFILE } =
  loadTs('src/main/nexus/exec/sandboxProfile.ts');
const { buildPlan, buildAgentPlan, depsVolumeName, envFor, pickFramework, PYTHON_PROFILES, ALLOWED_ENV_NAMES } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { getRecipe, RECIPES } = loadTs('src/shared/nexus/recipes.ts');
const { EGRESS_ALLOWLISTS } = loadTs('src/shared/nexus/egressPolicy.ts');
const { loadImageProfiles, LOCKED_PROFILE_IDS } = loadTs('src/main/nexusExec/profiles.ts');
const { IMAGE_PROFILES, EGRESS_REGISTRIES } = loadTs('src/main/nexus/approvals/approvalService.ts');
const { IMAGE_PROFILES_ACCEPTED } = loadTs('src/main/nexusIpc/validate.ts');
const { PROFILE_LABEL, kitTitle } = loadTs('src/renderer/src/nexus/data/executionModel.ts');
const { comparePreflight } = loadTs('src/shared/nexus/preflightCheck.ts');
const { inspectFor } = require('./helpers/fakeSandboxDriver.cjs');

const IMAGES = path.join(__dirname, '..', 'infra', 'images');

/** A database stand-in: the project's languages, its primary workspace (`primary`), the repository row; `throws` makes every read fail. */
function db(o = {}) {
  return {
    prepare: (sql) => ({
      get: (...args) => {
        if (o.throws && /project_workspaces/.test(sql)) throw new Error('no such table');
        if (/FROM project_workspaces WHERE project_id/.test(sql)) return o.primary ? { w: o.primary } : undefined;
        if (/FROM project_workspaces WHERE workspace_id/.test(sql)) return o.anyMl ? { w: args[0] } : undefined;
        if (/FROM projects/.test(sql)) return o.langs ? { metadata_json: JSON.stringify({ detectedLanguages: o.langs }) } : undefined;
        return o.repo;
      }
    })
  };
}
const ML = (x = {}) => db({ primary: 'ml', ...x });

test('MK1 runs: a Machine learning project\'s Python code runs in the ML kit; JavaScript stays node; a Python project of another kind keeps sde-python', () => {
  assert.equal(ML_WORKSPACE_ID, 'ml'); assert.equal(ML_PROFILE, 'ml-python');
  assert.equal(profileFromFacts(ML({ langs: ['Python'] }), 'p', []), 'ml-python');
  assert.equal(profileFromFacts(ML({ langs: [{ language: 'Python', fileCount: 3, extension: 'py' }] }), 'p', []), 'ml-python');
  assert.equal(profileFromFacts(ML({ langs: ['JavaScript'] }), 'p', [{ metadata: { profile: 'sde-python' } }]), 'ml-python', 'a recorded sde-python too');
  assert.equal(profileFromFacts(ML({ langs: ['Python', 'TypeScript'] }), 'p', []), 'sde-node');
  assert.equal(profileFromFacts(ML({ langs: [] }), 'p', []), 'sde-node', 'runs of a project with no Python stay as they were');
  assert.equal(profileFromFacts(ML(), 'p', [{ metadata: { profile: 'sde-node' } }]), 'sde-node');
  assert.equal(profileFromFacts(ML(), 'p', [{ metadata: { profile: 'ml-python' } }]), 'ml-python', 'a recorded ML profile (a suite found in the kit)');
  for (const primary of [undefined, 'sde', 'data', 'qa', 'dl']) {
    assert.equal(profileFromFacts(db({ primary, langs: ['Python'] }), 'p', []), 'sde-python', String(primary));
  }
  assert.equal(profileFromFacts(db({ throws: true, langs: ['Python'] }), 'p', []), 'sde-python', 'an unreadable participation is not ML');
  assert.equal(projectSandboxProfile(ML({ repo: { metadata_json: JSON.stringify({ profile: 'sde-python' }) } }), 'p'), 'ml-python');
  assert.equal(forProject(ML(), 'p', 'sde-python'), 'ml-python');
  for (const other of ['sde-node', 'nexus-fwd', 'ml-python']) assert.equal(forProject(ML(), 'p', other), other);
  assert.equal(forProject(db({ primary: 'sde' }), 'p', 'sde-python'), 'sde-python');
});

test('MK2 the AI helper of a Machine learning project gets the ML kit, also with no language yet; a JavaScript or TypeScript repository keeps node', () => {
  assert.equal(agentProfileFromFacts(ML({ langs: [] }), 'p', []), 'ml-python', 'a new ML project (a dataset, no code yet)');
  assert.equal(agentProfileFromFacts(ML({ langs: ['Markdown'] }), 'p', []), 'ml-python');
  assert.equal(agentProfileFromFacts(ML({ langs: ['Python'] }), 'p', []), 'ml-python');
  assert.equal(agentProfileFromFacts(ML({ langs: ['TypeScript (React)'] }), 'p', []), 'sde-node');
  assert.equal(agentProfileFromFacts(ML({ langs: [] }), 'p', [{ metadata: { profile: 'sde-node' } }]), 'sde-node', 'a repository recorded as node');
  assert.equal(agentProfileFromFacts(db({ primary: 'sde', langs: [] }), 'p', []), 'sde-node', 'not ML: unchanged');
  assert.equal(agentProfileFromFacts(db({ primary: 'sde', langs: ['Python'] }), 'p', []), 'sde-python');
  assert.equal(isMachineLearningProject(ML(), 'p'), true);
  assert.equal(isMachineLearningProject(db({ primary: 'sde' }), 'p'), false);
  assert.equal(isMachineLearningProject(db({ throws: true }), 'p'), false);
  assert.equal(anyMachineLearningProject(db({ anyMl: true })), true);
  assert.equal(anyMachineLearningProject(db({})), false);
  assert.equal(anyMachineLearningProject(db({ throws: true })), false);
  // A row that is not a participation (a stand-in answering every query alike) is never read as ML.
  assert.equal(isMachineLearningProject({ prepare: () => ({ get: () => ({ metadata_json: '{}' }) }) }, 'p'), false);
});

test('MK3 the recipes: the project\'s offline runs may use the ML kit; an install (network) and a preview never do', () => {
  for (const id of ['sde.test.discover', 'sde.test.pytest', 'sde.build.python', 'sde.try.run']) {
    const r = getRecipe(id);
    assert.ok(r.profiles.includes('ml-python'), id);
    assert.equal(r.network, 'none', `${id} runs offline`);
  }
  for (const r of RECIPES) {
    if (r.profiles.includes('ml-python')) assert.equal(r.network, 'none', `${r.id}: the ML kit never runs with a network`);
  }
  for (const id of ['sde.deps.python', 'sde.deps.node', 'sde.deps.resolve', 'sde.preview.start', 'sde.preview.live', 'sde.test.node', 'sde.build.node']) {
    assert.equal(getRecipe(id).profiles.includes('ml-python'), false, id);
  }
  // No egress path names the ML kit: no allow-list, no registry for an approved install.
  assert.equal(JSON.stringify(EGRESS_ALLOWLISTS).includes('ml-python'), false);
  assert.equal(EGRESS_REGISTRIES['ml-python'], undefined);
});

test('MK4 a plan in the ML kit: pytest by default, no PYTHONPATH and no dependency volume (even with a lockfile), offline; preflight over its inspect passes', () => {
  const { profiles, problem } = loadImageProfiles(IMAGES);
  assert.equal(problem, null);
  assert.deepEqual([...LOCKED_PROFILE_IDS], ['sde-node', 'sde-python', 'nexus-fwd', 'ml-python']);
  const ml = profiles.find((p) => p.id === 'ml-python');
  assert.ok(ml.imageEnv.includes('MPLBACKEND') && ml.imageEnv.includes('MPLCONFIGDIR'));
  assert.deepEqual(PYTHON_PROFILES, ['sde-python', 'ml-python']);
  const lockInput = [{ versionId: 'V', slot: 'repository', contentHash: 'x', storage: { kind: 'git', commit: 'c'.repeat(40) },
    metadata: { lockfile: { path: 'requirements.txt', sha256: 'a'.repeat(64) } } }];
  assert.equal(depsVolumeName('ml-python', lockInput), null);
  assert.match(depsVolumeName('sde-python', lockInput), /^nexus-deps-sde-python-a{12}$/, 'the Python kit still uses its volume');
  assert.equal(pickFramework(getRecipe('sde.test.discover'), 'ml-python', null, []), 'pytest');
  assert.deepEqual(envFor(getRecipe('sde.test.pytest'), 'ml-python', 'pytest'), { HOME: '/home/nexus', CI: 'true', PIP_NO_INPUT: '1', PYTHONDONTWRITEBYTECODE: '1' });
  assert.equal(envFor(getRecipe('sde.test.pytest'), 'sde-python', 'pytest').PYTHONPATH, '/deps', 'unchanged for the Python kit');
  const plan = buildPlan({ job: { id: '01K7A0J0B000000000000000AA', projectId: 'p' }, attempt: { id: '01K7A0ATTEMPT0000000000AAA', n: 1 }, bootId: '01K7A0B00T00000000000000AA',
    recipe: getRecipe('sde.test.pytest'), profile: ml, imageId: `sha256:${'b'.repeat(64)}`, dataHomeRoot: path.join(IMAGES, '..', 'nx-home-not-created'),
    workRel: 'work/01K7A0J0B000000000000000AA/1', logRel: 'logs/jobs/01K7A0J0B000000000000000AA/1.log', repoPath: path.join(IMAGES, 'repo'), inputs: lockInput });
  const c = plan.container;
  assert.equal(c.profile, 'ml-python');
  assert.deepEqual(c.argv, ['python', '-m', 'pytest', '-q', '--junitxml=/out/junit.xml', '-p', 'no:cacheprovider']);
  assert.equal(c.env.PYTHONPATH, undefined);
  assert.deepEqual(c.mounts.map((m) => m.kind), ['input', 'out', 'workspace']);
  assert.equal(plan.staging.depsVolume, undefined);
  assert.deepEqual(c.network, { mode: 'none' });
  for (const k of Object.keys(c.env)) assert.ok(ALLOWED_ENV_NAMES.includes(k), k);
  assert.deepEqual(comparePreflight(c, inspectFor(c, 'f'.repeat(64), c.name)).problems, [], 'the image\'s own MPL* names are allowed by imageEnv');
});

test('MK5 the AI helper\'s turn plan in the ML kit: its container is the ML image, offline, the worktree only', () => {
  const { profiles } = loadImageProfiles(IMAGES);
  const ml = profiles.find((p) => p.id === 'ml-python');
  const plan = buildAgentPlan({ job: { id: '01K7A0J0B000000000000000AA', projectId: 'p' }, attempt: { id: '01K7A0ATTEMPT0000000000AAA', n: 1 }, bootId: '01K7A0B00T00000000000000AA',
    dataHomeRoot: path.join(IMAGES, '..', 'nx-home-not-created'), workRel: 'work/01K7A0J0B000000000000000AA/1', logRel: 'logs/jobs/01K7A0J0B000000000000000AA/1.log',
    profile: ml, imageId: `sha256:${'c'.repeat(64)}`, worktree: { relPath: 'wt/01k7a0j0b000000000000000aa', gitDir: 'g', ref: 'refs/nexus/job/x', base: 'd'.repeat(40) },
    runtime: { kind: 'scripted', token: 't', sessionId: 's', idempotencyKey: 'k', domainId: 'ml', skills: [], context: { hash: 'e'.repeat(64) }, message: 'm',
      mcpUrl: 'http://127.0.0.1:1/mcp', model: { provider: 'runtime-owned', model: 'default' } },
    egress: { allow: [], consentHostsSha256: 'f'.repeat(64) }, caps: { turnTokens: 1, turnUsdCents: 1, dayRemainingUsdCents: 1, toolCalls: 1 }, wallClockMs: 60_000, mcpTools: [] });
  assert.equal(plan.container.profile, 'ml-python');
  assert.equal(plan.container.image.id, `sha256:${'c'.repeat(64)}`);
  assert.deepEqual(plan.container.network, { mode: 'none' });
  assert.deepEqual(plan.container.mounts.map((m) => [m.kind, m.containerPath]), [['worktree', '/workspace']]);
  assert.deepEqual(plan.container.imageEnv, ml.imageEnv);
});

test('MK6 the ML kit can be prepared through the existing approval, and a person sees it in plain words', () => {
  assert.ok(IMAGE_PROFILES.includes('ml-python'));
  assert.ok(IMAGE_PROFILES_ACCEPTED.includes('ml-python'));
  assert.equal(PROFILE_LABEL['ml-python'], 'Safe-space kit for machine learning projects');
  assert.equal(kitTitle('ml-python'), 'Prepare the safe-space kit for machine learning projects');
  assert.doesNotMatch(`${PROFILE_LABEL['ml-python']} ${kitTitle('ml-python')}`, /ml-python|docker|image|python/i, 'no id, no vendor or tool word');
});
