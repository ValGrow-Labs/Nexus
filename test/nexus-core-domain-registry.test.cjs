'use strict';
// B2a Task 2: the domain registry (DomainSpec v3), its boot checks and its projections.
// Pure data and pure checks; no database, no Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const guard = require('./helpers/identityGuard.cjs');

const ROOT = path.resolve(__dirname, '..');
const spec = loadTs('src/shared/nexus/domainSpec.ts');
const { DOMAINS, getDomain } = loadTs('src/shared/nexus/domains/index.ts');
const { checkRegistry, projectWorkspaceCatalog, B2B_IMPL, B2B_E2E_STUB, BANNED_PARAM_FIELD, E2E_TEST_ID_RE } = loadTs('src/shared/nexus/registryCheck.ts');
const { KINDS } = loadTs('src/shared/nexus/kinds.ts');
const { RECIPES } = loadTs('src/shared/nexus/recipes.ts');
const { VALIDATORS } = loadTs('src/shared/nexus/validators.ts');
const { USER_ACTIONS, PLATFORM_FLOWS } = loadTs('src/shared/nexus/actions.ts');
const { CAPABILITIES } = loadTs('src/shared/nexus/capabilities.ts');
const { PLATFORM_WORKSPACE_IDS, LEGACY_DOMAIN_TO_WORKSPACE } = loadTs('src/shared/nexus/workspaceCatalog.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');

// The e2e titles are written by Task 12 (enforced from it): every REAL step's e2e id is listed in B2B_IMPL.e2eTests and
// is part of a test TITLE in one of these files (the fake-driver recipes file runs under test:db; the real-Docker one
// behind the test:exec gate). Task 13 added test/nexus-platform-b2a-flows.test.cjs (the flows through the IPC handlers).
// B2b Task 1 (the registry flip): the build is B2b and the registry is checked against B2B_IMPL. The e2e ids of the three
// steps B2b makes REAL were a stub (B2B_E2E_STUB) until B2b Task 16 wrote them as titles; it did, in the scripted flows
// (test/nexus-platform-b2b-flows-node.test.cjs and -python.test.cjs, run by test:db) and in the gated real-Docker agent suite
// (test/nexus-exec-agent.test.cjs, behind the test:exec gate). The stub is empty and the title checks below cover every REAL step.
const E2E_ENFORCED = true;
const E2E_PENDING = new Set(B2B_E2E_STUB);
const E2E_FILES = ['test/nexus-platform-exec-recipes.test.cjs', 'test/nexus-exec-recipes.test.cjs', 'test/nexus-platform-b2a-flows.test.cjs',
  'test/nexus-platform-b2b-flows-node.test.cjs', 'test/nexus-platform-b2b-flows-python.test.cjs', 'test/nexus-exec-agent.test.cjs'];
/** The real-Docker files (test:exec gate): a Docker-dependent step's e2e id must be a title in one of them too (fix round 1; B2b Task 16 added the agent suite). */
const REAL_DOCKER_E2E_FILES = ['test/nexus-exec-recipes.test.cjs', 'test/nexus-exec-agent.test.cjs'];

/** A deep, mutable copy of the registry for negative fixtures. */
const clone = () => JSON.parse(JSON.stringify(DOMAINS));
const byId = (specs, id) => specs.find((d) => d.id === id);
const step = (d, id) => d.lifecycle.find((s) => s.id === id);
const FIRST_CLASS = ['sde', 'qa', 'data', 'data-scientist', 'ml', 'dl'];

test('DR0 the registry holds six first-class domains and three registry-only entries; the build is B2b', () => {
  assert.equal(spec.CURRENT_SUB_PHASE, 'B2b');
  assert.deepEqual(DOMAINS.filter((d) => d.tier === 'first-class').map((d) => d.id).sort(), [...FIRST_CLASS].sort());
  assert.deepEqual(DOMAINS.filter((d) => d.tier === 'registry-only').map((d) => d.id).sort(), ['devops', 'research', 'uiux']);
  for (const d of DOMAINS) assert.equal(d.specVersion, 3, d.id);
  assert.equal(getDomain('sde').label, 'Software Development Engineer');
  assert.equal(getDomain('nope'), null);
  assert.ok(Object.isFrozen(DOMAINS) && Object.isFrozen(getDomain('sde').lifecycle[0]), 'the registry is frozen');
  for (const [name, table] of Object.entries({ KINDS, RECIPES, VALIDATORS, USER_ACTIONS, CAPABILITIES, PLATFORM_FLOWS, DOMAINS }))
    assert.ok(Object.isFrozen(table) && table.every((row) => Object.isFrozen(row)), name + ' is frozen');
  assert.ok(Object.isFrozen(RECIPES[1].limits) && Object.isFrozen(USER_ACTIONS[0].params.properties), 'nested rows are frozen');
  assert.throws(() => { 'use strict'; KINDS[0].label = 'x'; });
});

test('DR1 ids unique; hue slots unique and equal to the renderer registry for the eight live ids; DS takes slot 8', () => {
  const ids = DOMAINS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  const hues = DOMAINS.map((d) => d.hueSlot);
  assert.equal(new Set(hues).size, hues.length);
  assert.equal(WORKSPACES.length, 8);
  for (const w of WORKSPACES) assert.equal(getDomain(w.id).hueSlot, w.hueSlot, w.id);
  for (const w of WORKSPACES) assert.equal(getDomain(w.id).order, w.order, `${w.id} order`);
  assert.equal(getDomain('data-scientist').hueSlot, 8);
  assert.equal(getDomain('data-scientist').participationFromSubPhase, 'B4');
});

test('DR2 checkRegistry(DOMAINS, B2B_IMPL) is clean; every REAL step names a well-formed e2e test id', () => {
  assert.deepEqual(checkRegistry(DOMAINS, B2B_IMPL), []);
  const real = DOMAINS.flatMap((d) => d.lifecycle.filter((s) => s.status !== 'FUTURE').map((s) => ({ d: d.id, s })));
  assert.ok(real.length > 0);
  for (const { d, s } of real) assert.match(s.e2eTestId ?? '', E2E_TEST_ID_RE, `${d}/${s.id}`);
  const all = real.map(({ s }) => s.e2eTestId);
  assert.equal(new Set(all).size, all.length, 'e2e ids are unique');
  // A missing id or a malformed one fails the boot check.
  const a = clone(); delete step(byId(a, 'sde'), 'tests').e2eTestId;
  assert.ok(checkRegistry(a, B2B_IMPL).some((p) => /sde\/tests.*e2eTestId/.test(p)));
  const b = clone(); step(byId(b, 'sde'), 'tests').e2eTestId = 'Tests pass';
  assert.ok(checkRegistry(b, B2B_IMPL).some((p) => /sde\/tests.*e2eTestId/.test(p)));
  // With titles supplied, an id that is not a title fails.
  const titled = { ...B2B_IMPL, e2eTests: all.filter((id) => id !== step(getDomain('sde'), 'build').e2eTestId) };
  assert.ok(checkRegistry(DOMAINS, titled).some((p) => /sde\/build.*no end-to-end test/.test(p)));
  if (E2E_ENFORCED) {
    const text = E2E_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    const titled = all.filter((id) => !E2E_PENDING.has(id));
    for (const id of titled) assert.ok(text.includes(id), `${id} is a test title`);
    // Stronger than a mention: the id is a word of a test('...') title, and B2B_IMPL lists exactly these ids.
    const titles = [...text.matchAll(/\btest\(\s*(['"`])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
    for (const id of titled) assert.ok(titles.some((t) => t.split(/\s+/).includes(id)), `${id} is part of a test title`);
    assert.deepEqual([...B2B_IMPL.e2eTests].sort(), [...all].sort(), 'B2B_IMPL.e2eTests lists exactly the REAL steps\' e2e ids');
    // The B2b stub (pin): empty since B2b Task 16 wrote the three B2b steps' titles (in lifecycle order below); a stub id that is
    // a title must not be in the stub, and nothing is exempt from the title checks.
    assert.deepEqual([...E2E_PENDING], [], 'the e2e stub is empty');
    assert.deepEqual(['e2e.sde.ai-implementation', 'e2e.sde.review', 'e2e.sde.iteration'].filter((id) => !titles.some((t) => t.split(/\s+/).includes(id))), [],
      'the three B2b steps are titles');
    assert.deepEqual(B2B_IMPL.e2eTests.slice(-3), ['e2e.sde.ai-implementation', 'e2e.sde.review', 'e2e.sde.iteration'], 'in lifecycle order');
    // Fix round 1, item 12: a step whose proof needs Docker (its prerequisites name docker or an image) must ALSO be a
    // test title in the real-Docker file; the fake-driver titles alone never satisfy it.
    const dockerSteps = real.filter(({ s }) => (s.prerequisites ?? []).some((p) => p === 'docker' || String(p).startsWith('image:')));
    assert.deepEqual(dockerSteps.map(({ s }) => s.e2eTestId).sort(),
      ['e2e.sde.ai-implementation', 'e2e.sde.application', 'e2e.sde.build', 'e2e.sde.dev-deployment', 'e2e.sde.diagnostics', 'e2e.sde.iteration',
        'e2e.sde.tests']);
    const missingFrom = (fileText) => {
      const t = [...fileText.matchAll(/\btest\(\s*(['"`])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
      return dockerSteps.map(({ s }) => s.e2eTestId).filter((id) => !t.some((x) => x.split(/\s+/).includes(id)));
    };
    const realDockerTexts = REAL_DOCKER_E2E_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const realDocker = realDockerTexts.join('\n');
    // Every Docker-dependent e2e id is a title in a real-Docker file: the recipes file (B2a's steps) or the agent suite (the two
    // agent steps, B2b Task 16).
    assert.deepEqual(missingFrom(realDocker), [], 'every Docker-dependent e2e id is a title in a real-Docker file');
    assert.deepEqual(missingFrom(realDockerTexts[1]).sort(), ['e2e.sde.application', 'e2e.sde.build', 'e2e.sde.dev-deployment', 'e2e.sde.diagnostics', 'e2e.sde.tests'],
      'the agent suite proves the two agent steps and none of B2a\'s');
    // Not vacuous: the real files without a title fail it, whatever the fake-driver files' titles say.
    assert.deepEqual(missingFrom(realDocker.replace('X5 e2e.sde.build ', 'X5 ')), ['e2e.sde.build']);
    assert.deepEqual(missingFrom(realDocker.replace('XA1 e2e.sde.ai-implementation ', 'XA1 ').replace('XA6 e2e.sde.iteration ', 'XA6 ')), ['e2e.sde.ai-implementation', 'e2e.sde.iteration']);
  }
  // A REAL step whose implementation is not registered fails.
  const noRecipe = { ...B2B_IMPL, recipes: B2B_IMPL.recipes.filter((r) => r !== 'sde.build.node') };
  assert.ok(checkRegistry(DOMAINS, noRecipe).some((p) => /sde\.build\.node/.test(p) && /implementation/.test(p)));
  const noValidator = { ...B2B_IMPL, validators: B2B_IMPL.validators.filter((v) => v !== 'sde.tests_pass') };
  assert.ok(checkRegistry(DOMAINS, noValidator).some((p) => /sde\.tests_pass/.test(p)));
  const noViewer = { ...B2B_IMPL, viewers: B2B_IMPL.viewers.filter((v) => v !== 'viewer.build') };
  assert.ok(checkRegistry(DOMAINS, noViewer).some((p) => /viewer\.build/.test(p)));
});

test('DR3 a step is REAL only at or after its sub-phase; SDE matches the B2b status table exactly', () => {
  assert.ok(spec.isAtOrBefore('B2a', 'B2a') && spec.isAtOrBefore('B1', 'B2a') && !spec.isAtOrBefore('B2b', 'B2a'));
  assert.ok(spec.isAtOrBefore('B2b') && !spec.isAtOrBefore('B2c'), 'this build is B2b');
  const sde = getDomain('sde');
  // B2b Task 1 (the registry flip): AI-assisted implementation, review and iteration are REAL in B2b.
  assert.deepEqual(sde.lifecycle.map((s) => [s.label, s.status, s.subPhase]), [
    ['Requirement', 'REAL', 'B2a'], ['Project', 'REAL', 'B1'], ['Repository', 'REAL', 'B2a'], ['Code', 'REAL', 'B2a'],
    ['AI-assisted implementation', 'REAL', 'B2b'], ['Tests', 'REAL', 'B2a'], ['Review', 'REAL', 'B2b'],
    ['Build', 'REAL', 'B2a'], ['Application', 'REAL', 'B2a'], ['Dev deployment', 'REAL', 'B2a'],
    ['Logs and diagnostics', 'REAL', 'B2a'], ['Iteration', 'REAL', 'B2b']]);
  assert.equal(sde.lifecycle.filter((s) => s.status === 'REAL').length, 12);
  // DA, ML and DL: only the problem statement step is REAL. QA and DS (no participation before B4) have none.
  const counts = { qa: 11, data: 10, 'data-scientist': 12, ml: 13, dl: 15 };
  for (const [id, n] of Object.entries(counts)) {
    const d = getDomain(id);
    assert.equal(d.lifecycle.length, n, `${id} has ${n} steps`);
    const real = d.lifecycle.filter((s) => s.status !== 'FUTURE');
    if (id === 'qa' || id === 'data-scientist') assert.deepEqual(real, [], id);
    else {
      assert.equal(real.length, 1, id);
      assert.deepEqual(real[0].produces, ['problem_statement']);
      assert.equal(real[0].subPhase, 'B2a');
    }
    for (const s of d.lifecycle.filter((x) => x.status === 'FUTURE'))
      assert.ok(!spec.isAtOrBefore(s.subPhase, 'B2b'), `${id}/${s.id} FUTURE names a later sub-phase`);
  }
  // Wave-1 review, ruling on finding 1 (restored by B2b Task 16): the build has now proven the B2b flow end to end with
  // ScriptedRuntime (DELIVERED_SUB_PHASE = B2b), so as delivered, as at the registry's sub-phase (B2b), only SDE is executable
  // end to end, never the other five. At B2a (what B2a delivered) none was.
  assert.equal(spec.DELIVERED_SUB_PHASE, 'B2b');
  for (const d of DOMAINS) assert.equal(spec.isExecutableEndToEnd(d), d.id === 'sde', `${d.id} as delivered`);
  for (const d of DOMAINS) assert.equal(spec.isExecutableEndToEnd(d, 'B2a'), false, `${d.id} at B2a`);
  for (const d of DOMAINS) assert.equal(spec.isExecutableEndToEnd(d, 'B2b'), d.id === 'sde', `${d.id} at B2b (the registry-level fact)`);
  // Negative fixture: a step of a later sub-phase (B2c) marked REAL fails.
  const bad = clone(); const s = step(byId(bad, 'qa'), 'test-plan');
  s.status = 'REAL'; s.e2eTestId = 'e2e.qa.test-plan';
  assert.ok(checkRegistry(bad, B2B_IMPL).some((p) => /qa\/test-plan.*B2c/.test(p)));
  // A FUTURE step that names the current sub-phase is a stale label.
  const stale = clone(); step(byId(stale, 'qa'), 'test-plan').subPhase = 'B2b';
  assert.ok(checkRegistry(stale, B2B_IMPL).some((p) => /qa\/test-plan: FUTURE but names B2b/.test(p)));
  // A completion rule cannot claim the current build while a step is FUTURE.
  const claim = clone(); byId(claim, 'qa').completionRules[0].subPhase = 'B2b';
  assert.ok(checkRegistry(claim, B2B_IMPL).some((p) => /qa completion/.test(p)));
  // ... nor can SDE's once one of its steps is FUTURE again.
  const back = clone(); Object.assign(step(byId(back, 'sde'), 'iteration'), { status: 'FUTURE', subPhase: 'B2c', via: [] });
  delete step(byId(back, 'sde'), 'iteration').e2eTestId;
  assert.ok(checkRegistry(back, B2B_IMPL).some((p) => /sde completion sde\.end-to-end: names B2b while iteration are FUTURE/.test(p)));
  // A REAL step cannot produce a kind that arrives later.
  const later = clone(); step(byId(later, 'sde'), 'build').produces.push('test_run');
  assert.ok(checkRegistry(later, B2B_IMPL).some((p) => /test_run, which arrives in B2c/.test(p)));
});

test('DR4 every referenced kind, recipe, validator, action and capability id resolves; an unknown id fails', () => {
  const kinds = new Set(KINDS.map((k) => k.id));
  for (const d of DOMAINS) {
    for (const k of [...d.kindsProduced, ...d.kindsAccepted, ...Object.keys(d.vocabulary)]) assert.ok(kinds.has(k), `${d.id}: ${k}`);
    for (const s of d.lifecycle) for (const k of [...s.consumes, ...s.produces]) assert.ok(kinds.has(k), `${d.id}/${s.id}: ${k}`);
  }
  for (const v of VALIDATORS) for (const k of v.kinds) assert.ok(kinds.has(k), v.id);
  for (const r of RECIPES) for (const k of r.produces) assert.ok(kinds.has(k), r.id);
  const cases = [
    ['kind', (a) => { byId(a, 'sde').kindsProduced.push('spreadsheet'); }, /spreadsheet/],
    ['step kind', (a) => { step(byId(a, 'ml'), 'training').produces = ['weights']; }, /weights/],
    ['recipe', (a) => { byId(a, 'sde').recipes.push('sde.lint'); }, /sde\.lint/],
    ['validator', (a) => { step(byId(a, 'sde'), 'build').doneWhen.validators.push('build.signed'); }, /build\.signed/],
    ['action', (a) => { byId(a, 'sde').actions.push('sde.deploy.prod'); }, /sde\.deploy\.prod/],
    ['capability', (a) => { byId(a, 'sde').capabilities.push({ id: 'host.shell' }); }, /host\.shell/],
    ['skill', (a) => { byId(a, 'sde').skills.push('sde-change'); }, /sde-change/],
    ['route receiver', (a) => { byId(a, 'sde').handoffRoutes.push({ to: 'legal', kinds: ['build'], action: 'inform', subPhase: 'B2c' }); }, /legal/],
    ['route kind not accepted', (a) => { byId(a, 'sde').handoffRoutes.push({ to: 'dl', kinds: ['build'], action: 'inform', subPhase: 'B2c' }); }, /dl.*build|build.*dl/],
    ['vocabulary', (a) => { byId(a, 'sde').vocabulary.blueprint = { singular: 'Blueprint', plural: 'Blueprints' }; }, /blueprint/],
    ['produced kind missing from kindsProduced', (a) => { const d = byId(a, 'sde'); d.kindsProduced = d.kindsProduced.filter((k) => k !== 'build'); }, /kindsProduced.*build|build.*kindsProduced/],
    ['duplicate id', (a) => { a.push({ ...byId(a, 'qa') }); }, /duplicate/],
    ['duplicate hue', (a) => { byId(a, 'uiux').hueSlot = 0; }, /hue/]
  ];
  for (const [name, mutate, re] of cases) {
    const a = clone(); mutate(a);
    const problems = checkRegistry(a, B2B_IMPL);
    assert.ok(problems.some((p) => re.test(p)), `${name}: ${JSON.stringify(problems)}`);
  }
  // The capability table is the one the domains reference.
  const caps = new Set(CAPABILITIES.map((c) => c.id));
  for (const d of DOMAINS) for (const c of d.capabilities) assert.ok(caps.has(c.id), `${d.id}: ${c.id}`);
  // Implementation ids the build claims must exist in the tables.
  assert.ok(checkRegistry(DOMAINS, { ...B2B_IMPL, recipes: [...B2B_IMPL.recipes, 'ghost.recipe'] }).some((p) => /ghost\.recipe/.test(p)));
});

test('DR5 projectWorkspaceCatalog equals the live workspace catalogue exactly', () => {
  const cat = projectWorkspaceCatalog(DOMAINS);
  assert.deepEqual(cat.ids, [...PLATFORM_WORKSPACE_IDS]);
  assert.deepEqual(cat.legacyMap, { ...LEGACY_DOMAIN_TO_WORKSPACE });
  assert.ok(!cat.ids.includes('data-scientist'), 'DS waits for B4');
  assert.ok(!('deep-learning' in cat.legacyMap), 'deep-learning waits for its phase');
  assert.equal(cat.legacyMap['data-science'], 'data', 'data-science stays with Data Analyst until ruling R1');
  const dup = clone(); byId(dup, 'ml').legacyDomainIds.push('data-analytics');
  assert.ok(checkRegistry(dup, B2B_IMPL).some((p) => /data-analytics/.test(p)));
});

test('DR6 vocabulary covers every produced kind; registry strings are plain words', () => {
  for (const d of DOMAINS.filter((x) => x.tier === 'first-class'))
    for (const k of d.kindsProduced) assert.ok(d.vocabulary[k], `${d.id} names ${k}`);
  assert.equal(getDomain('data').vocabulary.problem_statement.singular, 'Business question');
  assert.equal(getDomain('data-scientist').vocabulary.problem_statement.singular, 'Business problem');
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk([DOMAINS, KINDS, RECIPES, VALIDATORS, USER_ACTIONS, CAPABILITIES]);
  assert.ok(strings.length > 500);
  const hits = strings.flatMap((s) => guard.scanText(s, true).map((h) => `${h.rule}: ${s}`));
  assert.deepEqual(hits, []);
  const vendor = strings.filter((s) => /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-/i.test(s));
  assert.deepEqual(vendor, [], 'vendor-neutral registry');
  for (const d of DOMAINS) assert.ok(!/complete/i.test(d.statusNote), `${d.id} never claims completion`);
});

test('DR7 actions: SDE actions map to REAL steps; no action for a FUTURE step; params name no path, command, network, image, principal or role', () => {
  for (const d of DOMAINS) {
    const realActions = new Set(d.lifecycle.filter((s) => s.status !== 'FUTURE')
      .flatMap((s) => s.via.filter((v) => 'userAction' in v).map((v) => v.userAction)));
    for (const a of d.actions) assert.ok(realActions.has(a), `${d.id}: ${a} maps to a REAL step`);
    for (const s of d.lifecycle.filter((x) => x.status === 'FUTURE'))
      assert.deepEqual(s.via.filter((v) => 'userAction' in v), [], `${d.id}/${s.id} offers no action`);
    if (d.tier === 'registry-only') {
      assert.deepEqual([d.actions, d.modules, d.lifecycle, d.recipes], [[], [], [], []], d.id);
    }
  }
  assert.ok(getDomain('sde').actions.length >= 8);
  for (const a of USER_ACTIONS) {
    for (const field of Object.keys(a.params.properties)) assert.doesNotMatch(field, BANNED_PARAM_FIELD, `${a.id}.${field}`);
    assert.equal(a.params.additionalProperties, false, a.id);
  }
  for (const r of RECIPES) for (const field of Object.keys(r.params.properties)) assert.doesNotMatch(field, BANNED_PARAM_FIELD, r.id);
  for (const f of ['repoPath', 'command', 'argv', 'network', 'image', 'principalId', 'role', 'workDir', 'url', 'hostPort'])
    assert.match(f, BANNED_PARAM_FIELD, f);
  // Negative fixtures: an action on a FUTURE step, and a params field naming a path.
  // (B2b Task 1: SDE's review step is REAL now, so the FUTURE step is SDE's iteration put back into a later sub-phase.)
  const a = clone(); Object.assign(step(byId(a, 'sde'), 'iteration'), { status: 'FUTURE', subPhase: 'B2c' });
  delete step(byId(a, 'sde'), 'iteration').e2eTestId;
  assert.ok(checkRegistry(a, B2B_IMPL).some((p) => /sde\/iteration: a FUTURE step has no user action/.test(p)));
  const actions = loadTs('src/shared/nexus/actions.ts');
  const original = actions.USER_ACTIONS.find((x) => x.id === 'sde.diagnose');

  assert.deepEqual(checkActionParams(original), []);
  const bad = JSON.parse(JSON.stringify(original)); bad.params.properties.logPath = { type: 'string', maxLength: 10 };
  assert.ok(checkActionParams(bad).some((p) => /logPath/.test(p)));
});

test('DR8 the recipe and validator tables match the B2a plan and the B2b additions', () => {
  // B2b Task 1: the six git engine recipes and the six change-set validators follow the B2a rows (their own pins are in
  // test/nexus-core-agent-contracts.test.cjs, SC8 and SC8b).
  assert.deepEqual(RECIPES.map((r) => r.id), ['repo.snapshot', 'sde.deps.node', 'sde.deps.python', 'sde.test.discover', 'sde.test.node',
    'sde.test.pytest', 'sde.build.node', 'sde.build.python', 'sde.app.assemble', 'sde.preview.start', 'sde.diagnose',
    'repo.worktree', 'changeset.collect', 'changeset.merge_check', 'changeset.accept', 'changeset.accept_rollback', 'repo.ff']);
  const r = (id) => RECIPES.find((x) => x.id === id);
  assert.deepEqual([r('sde.deps.node').network, r('sde.deps.python').network], ['egress-approved', 'egress-approved']);
  for (const x of RECIPES.filter((y) => !y.id.startsWith('sde.deps.') && y.id !== 'sde.preview.start'))
    assert.ok(['none', 'not-applicable'].includes(x.network), `${x.id} has no network`);
  for (const x of RECIPES) assert.equal(x.executor === 'engine', x.network === 'not-applicable', `${x.id} engine-side recipes run no container`);
  assert.equal(r('sde.preview.start').network, 'service-internal');
  assert.deepEqual(r('sde.test.node').limits, { cpus: 2, memoryMb: 2048, outputMaxBytes: 64 * 2 ** 20 });
  assert.deepEqual(r('sde.build.node').limits, { cpus: 2, memoryMb: 2048, outputMaxBytes: 256 * 2 ** 20 });
  assert.equal(r('sde.test.discover').wallClockMs, 5 * 60_000);
  assert.deepEqual([r('repo.snapshot').retry.maxAttempts, r('sde.test.node').retry.maxAttempts, r('sde.test.node').retry.idempotent], [3, 1, false]);
  assert.deepEqual(r('sde.test.node').outputContract.required, ['junit.xml']);
  // B2a Task 13 fix round 1 (the ruled defect): a dependency install's evidence, sde.deps.lock_matches, is the one ADVISORY
  // validator of B2a; B2b adds exactly one more, sec.entropy_notes (D-B14). Every other validator stays blocking.
  assert.deepEqual(VALIDATORS.map((v) => v.id), ['git.head_resolves', 'req.schema', 'problem.schema', 'suite.discovered', 'sde.tests_pass',
    'build.exit_zero', 'build.manifest_present', 'build.output_hashed', 'blob.integrity', 'app.manifest_schema', 'app.preview_health', 'diag.schema',
    'sde.deps.lock_matches', 'git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'sec.entropy_notes', 'cs.tests_pass', 'git.applies_cleanly']);
  for (const v of VALIDATORS) assert.equal(v.blocking, !['sde.deps.lock_matches', 'sec.entropy_notes'].includes(v.id), v.id);
  const lock = VALIDATORS.find((v) => v.id === 'sde.deps.lock_matches');
  assert.deepEqual([lock.kinds, lock.executes, lock.evidence], [['repository'], 'main', ['hash', 'exit']]);
  assert.ok(!loadTs('src/shared/nexus/validators.ts').blockingValidatorsFor('repository').some((v) => v.id === lock.id), 'it never gates a repository version');
  assert.deepEqual(VALIDATORS.find((v) => v.id === 'sde.tests_pass').recipes, ['sde.test.node', 'sde.test.pytest']);
});

// ----- fix round 1 -----
const { REGISTRY_TABLES, checkActionParams } = loadTs('src/shared/nexus/registryCheck.ts');
const tablesCopy = () => JSON.parse(JSON.stringify(REGISTRY_TABLES));
const has = (problems, re) => problems.some((p) => re.test(p));

test('DR9 before a domain takes part (participationFromSubPhase), it has no running step, no action and no earlier module', () => {
  assert.equal(getDomain('data-scientist').actions.length, 0);
  assert.ok(!USER_ACTIONS.some((a) => a.domain === 'data-scientist'));
  const s = step(getDomain('data-scientist'), 'business-problem');
  assert.deepEqual([s.status, s.subPhase, s.via, s.e2eTestId], ['FUTURE', 'B4', [], undefined]);
  // Negative fixture: DS with a REAL step, an action and a B2a module.
  const a = clone(); const ds = byId(a, 'data-scientist');
  Object.assign(step(ds, 'business-problem'), { status: 'REAL', subPhase: 'B2a', via: [{ userAction: 'ml.problem.write' }], e2eTestId: 'e2e.data-scientist.business-problem' });
  ds.actions.push('ml.problem.write');
  ds.modules[0].subPhase = 'B2a';
  const p = checkRegistry(a, B2B_IMPL);
  assert.ok(has(p, /data-scientist\/business-problem: REAL before projects can take part/), JSON.stringify(p));
  assert.ok(has(p, /data-scientist: action ml\.problem\.write exists before projects can take part/));
  assert.ok(has(p, /data-scientist module problems: B2a is before projects can take part/));
});

test('DR10 checkRegistry is total: malformed input is a problem, never an exception', () => {
  const nullSpec = [...clone(), null];
  assert.doesNotThrow(() => checkRegistry(nullSpec, B2B_IMPL));
  assert.ok(has(checkRegistry(nullSpec, B2B_IMPL), /spec #9: not an object/));
  const noLifecycle = clone(); delete byId(noLifecycle, 'ml').lifecycle;
  assert.ok(has(checkRegistry(noLifecycle, B2B_IMPL), /ml: lifecycle must be a list/));
  const noVia = clone(); delete step(byId(noVia, 'sde'), 'build').via;
  assert.ok(has(checkRegistry(noVia, B2B_IMPL), /sde: step build: via must be a list/));
  const badStep = clone(); byId(badStep, 'qa').lifecycle.push(7);
  assert.ok(has(checkRegistry(badStep, B2B_IMPL), /qa: step #11 is not an object/));
  for (const input of [null, undefined, 'x', {}, [undefined], [{}]])
    assert.ok(checkRegistry(input, B2B_IMPL).length > 0, String(JSON.stringify(input)));
  for (const impl of [null, {}, { ...B2B_IMPL, viewers: 'x' }]) assert.ok(has(checkRegistry(DOMAINS, impl), /implementation: malformed/));
  assert.ok(checkRegistry(DOMAINS, B2B_IMPL, { kinds: null }).length > 0);
  assert.ok(checkActionParams(null).length > 0);
});

test('DR11 table integrity: duplicate ids, recipe shape per executor, child-job validators, unknown viewers, duplicate e2e ids', () => {
  for (const name of ['kinds', 'recipes', 'validators', 'actions', 'capabilities']) {
    const t = tablesCopy(); t[name].push({ ...t[name][0] });
    assert.ok(has(checkRegistry(DOMAINS, B2B_IMPL, { [name]: t[name] }), new RegExp(`table ${name}: duplicate id ${t[name][0].id.replace(/\./g, '\.')}`)), name);
  }
  const rcases = [
    ['no executor', (r) => { delete r[0].executor; }, /recipe repo\.snapshot: bad or missing executor/],
    ['engine with a profile', (r) => { r[0].profiles = ['sde-node']; }, /recipe repo\.snapshot: an engine recipe has no profiles/],
    ['engine with limits', (r) => { r[0].limits = { cpus: 1, memoryMb: 1, outputMaxBytes: 1 }; }, /repo\.snapshot: an engine recipe has no container limits/],
    ['tool without a profile', (r) => { r[1].profiles = []; }, /sde\.deps\.node: a tool recipe needs a profile/],
    ['tool without limits', (r) => { r[1].limits = null; }, /sde\.deps\.node: a tool recipe needs limits/],
    ['service without limits', (r) => { r[9].limits = null; }, /sde\.preview\.start: a service recipe needs limits/],
    ['tool with no network mode', (r) => { r[4].network = 'not-applicable'; }, /sde\.test\.node: a tool recipe needs a container network mode/]
  ];
  for (const [name, mutate, re] of rcases) {
    const t = tablesCopy(); mutate(t.recipes);
    assert.ok(has(checkRegistry(DOMAINS, B2B_IMPL, { recipes: t.recipes }), re), name);
  }
  const v = tablesCopy(); delete v.validators.find((x) => x.id === 'sde.tests_pass').recipes;
  assert.ok(has(checkRegistry(DOMAINS, B2B_IMPL, { validators: v.validators }), /sde\.tests_pass: a child-job validator names its recipes/));
  assert.ok(has(checkRegistry(DOMAINS, { ...B2B_IMPL, viewers: [...B2B_IMPL.viewers, 'viewer.hologram'] }), /unknown viewer viewer\.hologram/));
  const dup = clone(); step(byId(dup, 'sde'), 'build').e2eTestId = 'e2e.sde.tests';
  assert.ok(has(checkRegistry(dup, B2B_IMPL), /sde\/build: e2eTestId e2e\.sde\.tests is already used by sde\/tests/));
});

test('DR12 wording and small rules from review: no over-claiming names, sign-only release decisions, scope notes', () => {
  for (const d of DOMAINS) for (const c of d.completionRules) assert.equal(c.label, 'End-to-end flow', d.id);
  assert.ok(DOMAINS.every((d) => !('availableFromSubPhase' in d)));
  assert.equal(KINDS.find((k) => k.id === 'release_recommendation').userAuthorable, false);
  assert.deepEqual(step(getDomain('sde'), 'application').prerequisites, ['git', 'docker', 'image:nexus-fwd']);
  assert.match(step(getDomain('dl'), 'inference').scopeNote, /CPU only/);
  assert.match(getDomain('data-scientist').capabilities.find((c) => c.id === 'model.train.cpu').scope.note, /[Bb]aseline estimators only/);
});
