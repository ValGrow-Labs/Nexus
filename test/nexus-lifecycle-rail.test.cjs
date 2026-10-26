// test/nexus-lifecycle-rail.test.cjs
// B2a Task 15: every domain's lifecycle as a rail in its own words (workspaces/lifecycleModel.ts through
// load-ts), states derived from records only (shared/nexus/stepState.ts), and source pins on the rail,
// the workspace page and the Spine (no jsdom).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const L = loadTs('src/renderer/src/nexus/workspaces/lifecycleModel.ts');
const { DOMAINS } = loadTs('src/shared/nexus/domains/index.ts');
const NEXUS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');
const views = L.bundledDomainViews();
const view = (id) => views.find((v) => v.id === id);
const rail = (id, records = null) => L.railFor(view(id), records);
/** The view as the registry would project it at `at` (wave-1 review, ruling on finding 1): the B2b doneWhen logic is
 *  pinned on a view built at B2b, never by claiming the delivered build has reached B2b. */
const viewAt = (id, at) => ({ ...view(id), currentSubPhase: at });

test('the bundled projection is exactly what main sends over #22 (dto.ts domainView)', () => {
  const { domainView } = loadTs('src/main/nexusIpc/dto.ts');
  for (const d of DOMAINS) assert.deepEqual(L.domainViewOf(d), domainView(d), d.id);
});

// Wave-1 review, ruling on finding 1 (a restoration, not a weakening): the registry has AI-assisted implementation,
// review and iteration REAL at B2b (CURRENT_SUB_PHASE), and the rail reads the DELIVERED sub-phase. B2b Task 16 proved the SDE
// flow end to end (scripted) and set DELIVERED_SUB_PHASE = B2b, so SDE now shows all twelve steps in this release; the B2a
// reading (nine in this release, three not) is still what a view built at B2a says, so the claim stays tied to the constant.
test('LR1 SDE as delivered (B2b): twelve steps in this release, none "Not in this release"', () => {
  const r = rail('sde');
  assert.equal(view('sde').currentSubPhase, 'B2b', 'the view carries the delivered sub-phase');
  assert.equal(r.steps.length, 12);
  assert.deepEqual(r.steps.filter((s) => s.future), []);
  assert.ok(r.steps.every((s) => s.status === 'REAL' && s.word === 'In this release'));
  for (const s of r.steps.filter((x) => x.subPhase === 'B2b')) assert.ok(s.note && !/^Not in this release/.test(s.note), s.id);
  assert.deepEqual(r.steps.filter((s) => s.subPhase === 'B2b').map((s) => s.id), ['ai-implementation', 'review', 'iteration']);
  assert.deepEqual(view('sde').lifecycle.filter((s) => !s.delivered), [], 'the #22 view marks every SDE step delivered');
  assert.equal(r.availability, null);
  assert.equal(r.supported, true);
});

test('LR1 SDE read at B2a (what B2a delivered): nine steps in this release, three not ("Not in this release: arrives with AI-assisted changes")', () => {
  const r = L.railFor(viewAt('sde', 'B2a'));
  assert.equal(r.steps.length, 12);
  const now = r.steps.filter((s) => !s.future);
  const later = r.steps.filter((s) => s.future);
  assert.equal(now.length, 9);
  assert.ok(now.every((s) => s.status === 'REAL' && s.word === 'In this release'));
  assert.deepEqual(later.map((s) => s.id), ['ai-implementation', 'review', 'iteration']);
  for (const s of later) {
    assert.equal(s.note, 'Not in this release: arrives with AI-assisted changes');
    assert.equal(s.word, 'Not in this release');
    assert.equal(s.subPhase, 'B2b');
  }
});

test('LR1 QA, DA, DS, ML and DL show their full lifecycles, FUTURE steps marked with their real sub-phase', () => {
  const PHASE = { qa: 'B2c', data: 'B3', 'data-scientist': 'B4', ml: 'B5', dl: 'B6' };
  for (const [id, phase] of Object.entries(PHASE)) {
    const r = rail(id);
    const spec = DOMAINS.find((d) => d.id === id);
    assert.deepEqual(r.steps.map((s) => [s.id, s.label, s.status, s.subPhase]), spec.lifecycle.map((s) => [s.id, s.label, s.status, s.subPhase]), id);
    for (const s of r.steps.filter((x) => x.future)) {
      assert.equal(s.subPhase, phase, `${id}/${s.id}`);
      assert.ok(s.note.startsWith('Not in this release: arrives with ') && s.note.includes(`(${phase})`), `${id}/${s.id}: ${s.note}`);
    }
  }
});

test('LR1 problem statements are in this release for DA, ML and DL; DS cannot be added to a project until B4 (registry ruling)', () => {
  for (const [id, step] of [['data', 'business-question'], ['ml', 'problem'], ['dl', 'problem']]) {
    const s = rail(id).steps.find((x) => x.id === step);
    assert.deepEqual([s.status, s.future, s.word], ['REAL', false, 'In this release'], id);
    assert.ok(s.note && /You write it in Nexus/.test(s.note), `${id}: the honest scope note`);
    assert.equal(rail(id).availability, null);
  }
  const ds = rail('data-scientist');
  assert.equal(ds.availability, 'Available from B4; it cannot be added to a project yet');
  const bp = ds.steps.find((x) => x.id === 'business-problem');
  assert.deepEqual([bp.status, bp.future, bp.subPhase], ['FUTURE', true, 'B4']);
  assert.ok(ds.steps.every((s) => s.future), 'none of its steps runs');
  assert.ok(ds.modules.every((m) => !m.delivered));
  // Even with records, a domain a project cannot take part in claims no state.
  assert.ok(L.railFor(view('data-scientist'), { versions: [], liveActions: [], participation: true, deploymentHealthy: false }).steps.every((s) => s.state === null));
});

test('LR1 registry-only domains say "Not yet a supported workflow"', () => {
  for (const id of ['research', 'uiux', 'devops']) {
    const r = rail(id);
    assert.deepEqual([r.supported, r.availability, r.steps.length, r.modules.length], [false, 'Not yet a supported workflow', 0, 0], id);
  }
});

test('LR1 modules in the domain\'s words: delivered now, or the sub-phase they arrive in', () => {
  const da = rail('data');
  assert.deepEqual(da.modules.find((m) => m.id === 'questions'), { id: 'questions', label: 'Questions', delivered: true, note: null });
  assert.equal(da.modules.find((m) => m.id === 'queries').note, 'arrives in B3');
  // Wave-1 review, finding 1 (restored by B2b Task 16): the SDE Changes module is delivered now that the flow is proven; read at
  // B2a it still arrives in B2b. A QA module still names the sub-phase it arrives in.
  assert.deepEqual(rail('sde').modules.find((m) => m.id === 'changes'), { id: 'changes', label: 'Changes', delivered: true, note: null });
  assert.deepEqual(L.railFor(viewAt('sde', 'B2a')).modules.find((m) => m.id === 'changes'), { id: 'changes', label: 'Changes', delivered: false, note: 'arrives in B2b' });
  assert.equal(rail('qa').modules.find((m) => m.id === 'defects').note, 'arrives in B2c');
});

// ---------- LR2 ----------

const rec = (o = {}) => ({ versions: [], liveActions: [], participation: true, deploymentHealthy: false, ...o });
const stepOf = (id, step, records) => L.railFor(view(id), records).steps.find((s) => s.id === step);
const PASSED = { 'suite.discovered': 'passed', 'sde.tests_pass': 'passed' };

test('LR2 step states come from records only: a finished job without a candidate version is not done', () => {
  // The run finished (no live job) and left nothing usable: the step is not done.
  const repo = { kind: 'repository', status: 'active', validators: { 'git.head_resolves': 'passed' } };
  assert.equal(stepOf('sde', 'tests', rec({ versions: [repo] })).state, 'ready');
  assert.equal(stepOf('sde', 'tests', rec()).state, 'blocked', 'no repository snapshot yet');
  assert.equal(stepOf('sde', 'tests', rec({ versions: [repo], liveActions: ['sde.tests.run'] })).state, 'in_progress');
  // A draft suite whose checks have not finished is still being checked, never done.
  assert.equal(stepOf('sde', 'tests', rec({ versions: [repo, { kind: 'test_suite', status: 'draft', validators: { 'suite.discovered': 'passed' } }] })).state, 'in_progress');
});

test('LR2 a candidate test suite with its checks passed (suite.discovered and sde.tests_pass) is done; a failed one needs attention', () => {
  const done = stepOf('sde', 'tests', rec({ versions: [{ kind: 'test_suite', status: 'candidate', validators: PASSED }] }));
  assert.deepEqual([done.state, done.word], ['done', 'Done']);
  const failed = stepOf('sde', 'tests', rec({ versions: [{ kind: 'test_suite', status: 'candidate', validators: { 'suite.discovered': 'passed', 'sde.tests_pass': 'failed' } }] }));
  assert.deepEqual([failed.state, failed.word], ['failed', 'Needs attention']);
  // Record steps: the participation, a healthy dev deployment.
  assert.equal(stepOf('sde', 'project', rec()).state, 'done');
  assert.equal(stepOf('sde', 'dev-deployment', rec({ versions: [{ kind: 'application', status: 'candidate', validators: {} }] })).state, 'ready');
  assert.equal(stepOf('sde', 'dev-deployment', rec({ deploymentHealthy: true })).state, 'done');
  // A step not in this release is unavailable whatever the records say: SDE's ai-implementation read at B2a (what B2a
  // delivered), and a QA FUTURE step.
  const CS_OK = { 'git.diff_nonempty': 'passed', 'git.paths_in_scope': 'passed', 'sec.secret_scan': 'passed', 'cs.tests_pass': 'passed',
    'git.applies_cleanly': 'passed' };
  const stepAtB2a = (step, records) => L.railFor(viewAt('sde', 'B2a'), records).steps.find((s) => s.id === step);
  assert.equal(stepAtB2a('ai-implementation', rec({ versions: [{ kind: 'change_set', status: 'active', validators: {} }] })).state, 'unavailable');
  assert.equal(stepAtB2a('ai-implementation', rec({ versions: [{ kind: 'change_set', status: 'candidate', validators: CS_OK }] })).state, 'unavailable');
  assert.equal(stepOf('qa', 'test-plan', rec({ versions: [{ kind: 'test_plan', status: 'active', validators: {} }] })).state, 'unavailable');
  // The B2b doneWhen logic, as delivered (B2b Task 16): a change set is done only with every blocking change-set check passed,
  // never on its status alone.
  assert.notEqual(stepOf('sde', 'ai-implementation', rec({ versions: [{ kind: 'change_set', status: 'active', validators: {} }] })).state, 'done');
  assert.equal(stepOf('sde', 'ai-implementation', rec({ versions: [{ kind: 'change_set', status: 'candidate', validators: CS_OK }] })).state, 'done');
  assert.equal(stepOf('sde', 'ai-implementation', rec({ versions: [{ kind: 'change_set', status: 'candidate',
    validators: { ...CS_OK, 'cs.tests_pass': 'failed' } }] })).state, 'failed');
  // Without records (a workspace page, or checks that could not be read): no state is claimed.
  assert.ok(rail('sde').steps.every((s) => s.state === null));
});

test('LR2 the compact summary counts only the rail\'s own steps', () => {
  const r = L.railFor(view('sde'), rec({ versions: [{ kind: 'test_suite', status: 'candidate', validators: PASSED }] }));
  // Wave-1 review, finding 1 (restored by B2b Task 16): as delivered (B2b) all twelve SDE steps are in this release; read at B2a
  // (what B2a delivered) nine were and three were not.
  assert.equal(L.railSummary(r), '2 of 12 steps in this release done');
  assert.equal(L.railSummary(L.railFor(viewAt('sde', 'B2a'), rec({ versions: [{ kind: 'test_suite', status: 'candidate', validators: PASSED }] }))), '2 of 9 steps in this release done; 3 not in this release');
  assert.match(L.railSummary(rail('qa', rec())), /not in this release$/, 'a domain with FUTURE steps still says so');
  assert.equal(L.railSummary(rail('data-scientist')), 'Available from B4; it cannot be added to a project yet');
  // Steps that need attention or are moving are counted too (fix round 1).
  const busy = L.railFor(view('sde'), rec({ versions: [{ kind: 'test_suite', status: 'candidate', validators: { 'suite.discovered': 'passed', 'sde.tests_pass': 'failed' } },
    { kind: 'repository', status: 'active', validators: { 'git.head_resolves': 'passed' } }], liveActions: ['sde.build.run'] }));
  assert.equal(L.railSummary(busy), '2 of 12 steps in this release done; 1 needs attention; 1 in progress');
  assert.deepEqual(rail('sde').steps.map((s) => s.n), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(L.liveActionsOf([{ state: 'running', actionId: 'a' }, { state: 'completed', actionId: 'b' }, { state: 'queued', actionId: null }]), ['a']);
});

// ---------- pins ----------

test('pin: the rail draws FUTURE steps hatched and never as a control; the workspace page and the Spine draw it', () => {
  const r = src('workspaces/LifecycleRail.tsx');
  assert.match(r, /data-future=\{s\.future \? 'true' : undefined\}/);
  assert.doesNotMatch(r, /<button|onClick|tabIndex/, 'nothing in the rail is a control');
  assert.match(r, /<span className="nx-lrail__word">\{s\.word\}<\/span>/, 'state is always a word');
  assert.match(src('styles/project.css'), /\.nx-lrail__step\[data-future="true"\]::before \{ border-style: dashed; background: repeating-linear-gradient/);
  assert.match(r, /<span className="nx-lrail__n nx-id" aria-hidden="true">\{s\.n\}<\/span>/, 'the step number');
  const page = src('pages/WorkspacePage.tsx');
  assert.match(page, /\{rail && <LifecycleRail rail=\{rail\} \/>\}/);
  assert.match(page, /useDomains\(\)\.list\.find\(\(d\) => d\.id === id\)/);
  assert.ok(page.indexOf('<LifecycleRail') < page.indexOf('id="ws-panel-projects"'), 'above the project list');
  assert.match(src('project/Spine.tsx'), /\{!g\.muted && rails\?\.get\(g\.workspaceId\) && <LifecycleRail rail=\{rails\.get\(g\.workspaceId\)!\} compact \/>\}/);
  assert.match(src('project/ProjectBench.tsx'), /railRecordsFor\(\{ workspaceId: g\.workspaceId, artifacts, checks, liveActions, deploymentHealthy: healthy, participating: true \}\)/);
});

test('pin (fix round 1): the full rail is an ordered ruled line, not a grid of cards or tiles', () => {
  const css = src('styles/execution.css') + src('styles/project.css');
  assert.doesNotMatch(css, /repeat\(auto-fill/, 'no auto-fill tile grid');
  const rules = [...css.matchAll(/(\.nx-lrail__step[^{]*)\{([^}]*)\}/g)];
  assert.ok(rules.length > 0);
  for (const [, sel, body] of rules) {
    if (sel.includes('::before')) continue; // the marker dot may be round
    assert.doesNotMatch(body, /border-radius/, `${sel} is not a rounded tile`);
    assert.doesNotMatch(body, /background\s*:/, `${sel} is not a filled tile`);
    assert.doesNotMatch(body, /border\s*:\s*1px solid/, `${sel} has no tile border (only the left rule)`);
  }
  const step = rules.find(([, sel]) => sel.trim() === '.nx-lrail__step')[2];
  assert.match(step, /border-left: 1px solid var\(--nx-line-strong\)/, 'one rule down the left, as the version timeline');
  assert.match(css, /\.nx-lrail__step::before \{ content: ""; position: absolute;/, 'a marker per step');
  assert.match(css, /\.nx-lrail__step\[data-state="failed"\]::before/);
  assert.match(css, /\.nx-lrail__bar li\[data-state="failed"\]/, 'a failed step is marked in the compact rail too');
});

test('C6b (final review) a version past the Spine read cap claims no state, never "In progress"', () => {
  const S = loadTs('src/renderer/src/nexus/project/spineModel.ts');
  const art = (i, kind, latest) => ({ artifact: { id: `a${i}`, kind, status: 'active', ownerWorkspaceId: 'sde', name: `n${i}` },
    current: null, latest: { id: `v${i}`, versionNo: 1, status: latest } });
  // 40 checked requirement drafts fill the read cap; the test suite draft is the 41st, so its checks are never read.
  const artifacts = [...Array.from({ length: S.SPINE_CHECK_READS }, (_, i) => art(i, 'requirement', 'candidate')), art(99, 'test_suite', 'draft')];
  const wanted = S.checkedVersionIds(artifacts);
  assert.equal(wanted.length, S.SPINE_CHECK_READS);
  assert.ok(!wanted.some((w) => w.versionId === 'v99'), 'past the cap');
  const checks = new Map(wanted.map((w) => [w.versionId, { 'req.schema': 'passed' }]));
  const records = S.railRecordsFor({ workspaceId: 'sde', artifacts, checks, liveActions: [], deploymentHealthy: false, participating: true });
  assert.deepEqual(records.versions.find((v) => v.kind === 'test_suite'), { kind: 'test_suite', status: 'draft', validators: {}, unread: true });
  const r = rail('sde', records);
  const tests = r.steps.find((s) => s.id === 'tests');
  assert.equal(tests.state, null, 'no state is claimed for the unread step');
  assert.equal(tests.word, 'In this release');
  assert.equal(r.steps.find((s) => s.id === 'requirement').state, 'done', 'read steps keep their state');
  // The same draft once read with no result yet is a draft being checked: in progress.
  const read = S.railRecordsFor({ workspaceId: 'sde', artifacts, checks: new Map([...checks, ['v99', {}]]), liveActions: [], deploymentHealthy: false, participating: true });
  assert.equal(rail('sde', read).steps.find((s) => s.id === 'tests').state, 'in_progress');
  // An unchecked kind has nothing to read: it is never marked unread.
  const plain = S.railRecordsFor({ workspaceId: 'sde', artifacts: [art(7, 'git_commit', 'candidate')], checks: new Map(), liveActions: [], deploymentHealthy: false, participating: true });
  assert.equal(plain.versions[0].unread, undefined);
  // The summary counts only steps with a state (requirement, and project from the participation record).
  assert.match(L.railSummary(r), /^2 of 12 steps in this release done/, 'requirement and project; the unread step is not counted as moving');
  assert.doesNotMatch(L.railSummary(r), /in progress/);
});

// ---------- B2a stabilization (workstream B): the rail from real records, the Data Scientist page ----------

const SM = loadTs('src/renderer/src/nexus/project/spineModel.ts');
/** An artifact summary as nexus:artifacts:byProject answers it (ArtifactSummaryView). */
const summary = (id, kind, status, owner) => ({
  artifact: { id, kind, status: 'active', name: id, createdAt: 1, ownerScope: owner ? 'participation' : 'project',
    ownerParticipationId: owner ? `pp-${owner}` : null, ownerWorkspaceId: owner ?? null },
  versionCount: 1, current: status === 'active' ? { id: `v-${id}`, versionNo: 1 } : null, latest: { id: `v-${id}`, versionNo: 1, status } });
const railOf = (artifacts, checks, extra = {}) => rail('sde', SM.railRecordsFor({ workspaceId: 'sde', artifacts, checks: new Map(Object.entries(checks)),
  liveActions: [], deploymentHealthy: false, participating: true, ...extra }));
const st = (r, id) => r.steps.find((s) => s.id === id).state;
const REPO_OK = { 'git.head_resolves': 'passed' };
const BUILD_OK = { 'build.exit_zero': 'passed', 'build.manifest_present': 'passed', 'build.output_hashed': 'passed', 'blob.integrity': 'passed' };

test('S7 a project-owned repository snapshot (ownerWorkspaceId null) is a record of the SDE rail: Repository done, Code ready', () => {
  assert.equal(SM.projectOwned({ ownerWorkspaceId: null, ownerParticipationId: null }), true);
  assert.equal(SM.projectOwned({ ownerWorkspaceId: 'sde', ownerParticipationId: 'pp' }), false);
  const repo = summary('repo', 'repository', 'active', null);
  const r = railOf([repo], { 'v-repo': REPO_OK });
  assert.equal(st(r, 'repository'), 'done', 'the click-through read "Ready to start" here');
  // Code is REAL in B2a (the registry: a git_commit saved through user.save_commit); it waits for that save, never for an earlier step.
  const code = DOMAINS.find((d) => d.id === 'sde').lifecycle.find((s) => s.id === 'code');
  assert.deepEqual([code.status, code.subPhase], ['REAL', 'B2a']);
  assert.equal(st(r, 'code'), 'ready', 'the click-through read "Needs an earlier step" here');
  assert.equal(st(railOf([repo, summary('c1', 'git_commit', 'candidate', 'sde')], { 'v-repo': REPO_OK }), 'code'), 'done');
  // The Repository step is done only on an ACTIVE version whose git check passed.
  assert.equal(st(railOf([summary('repo', 'repository', 'candidate', null)], { 'v-repo': REPO_OK }), 'repository'), 'ready');
  assert.equal(st(railOf([repo], { 'v-repo': { 'git.head_resolves': 'failed' } }), 'repository'), 'failed');
  // Another workspace's artifact is still not this group's record.
  assert.equal(st(railOf([summary('repo', 'repository', 'active', 'ml')], { 'v-repo': REPO_OK }), 'repository'), 'ready');
});

test('S7 Tests: discovery alone never marks the step done; a candidate suite needs sde.tests_pass passed (the tests ran)', () => {
  const repo = summary('repo', 'repository', 'active', null);
  const suite = (status) => summary('suite', 'test_suite', status, 'sde');
  // Discovery recorded its list (suite.discovered) and nothing ran the tests yet: a draft, being checked.
  assert.equal(st(railOf([repo, suite('draft')], { 'v-repo': REPO_OK, 'v-suite': { 'suite.discovered': 'passed' } }), 'tests'), 'in_progress');
  // Even a non-draft version without a passed sde.tests_pass is never done.
  assert.notEqual(st(railOf([repo, suite('candidate')], { 'v-repo': REPO_OK, 'v-suite': { 'suite.discovered': 'passed' } }), 'tests'), 'done');
  assert.equal(st(railOf([repo, suite('candidate')], { 'v-repo': REPO_OK, 'v-suite': { 'suite.discovered': 'passed', 'sde.tests_pass': 'failed' } }), 'tests'), 'failed');
  assert.equal(st(railOf([repo, suite('candidate')], { 'v-repo': REPO_OK, 'v-suite': PASSED }), 'tests'), 'done');
  // Build: done only when a build version passed every one of its checks.
  const build = (status) => summary('b', 'build', status, 'sde');
  assert.equal(st(railOf([repo, build('candidate')], { 'v-repo': REPO_OK, 'v-b': BUILD_OK }), 'build'), 'done');
  assert.notEqual(st(railOf([repo, build('candidate')], { 'v-repo': REPO_OK, 'v-b': { ...BUILD_OK, 'blob.integrity': 'failed' } }), 'build'), 'done');
  assert.equal(st(railOf([repo, build('draft')], { 'v-repo': REPO_OK, 'v-b': { 'build.exit_zero': 'passed' } }), 'build'), 'in_progress');
  // With the repository counted, the click-through's records read in order.
  const all = railOf([repo, suite('candidate'), build('candidate')], { 'v-repo': REPO_OK, 'v-suite': PASSED, 'v-b': BUILD_OK });
  assert.deepEqual(['repository', 'code', 'tests', 'build'].map((id) => st(all, id)), ['done', 'ready', 'done', 'done']);
});

test('S4 Data Scientist: #/w/data-scientist opens its domain page (never a workspace), every step "Available from B4", no action', () => {
  const RT = loadTs('src/renderer/src/nexus/router/routes.ts');
  assert.deepEqual(RT.parseHash('#/w/data-scientist'), { name: 'workspace', id: 'data-scientist' });
  assert.equal(RT.routeTitle({ name: 'workspace', id: 'data-scientist' }), 'Data Scientist');
  assert.equal(RT.parseHash('#/w/robotics').name, 'not-found', 'only registry domains');
  assert.equal(RT.formatRoute({ name: 'workspace', id: 'data-scientist' }), '#/w/data-scientist');
  assert.deepEqual(L.domainOnlyIds(), ['data-scientist']);
  // Not a workspace: no row in the platform catalog, none in the renderer's workspace list.
  const { PLATFORM_WORKSPACE_IDS } = loadTs('src/shared/nexus/workspaceCatalog.ts');
  assert.ok(!PLATFORM_WORKSPACE_IDS.includes('data-scientist'));
  const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');
  assert.ok(!WORKSPACES.some((w) => w.id === 'data-scientist'));
  // The registry is unchanged: no DS step is REAL, and it has no action.
  const ds = DOMAINS.find((d) => d.id === 'data-scientist');
  assert.ok(ds.lifecycle.every((s) => s.status === 'FUTURE'));
  assert.deepEqual(ds.actions, []);
  const r = rail('data-scientist');
  assert.equal(r.steps.length, 12);
  assert.ok(r.steps.every((s) => s.when === 'Available from B4' && s.word === 'Not in this release' && s.state === null));
  assert.ok(rail('sde').steps.every((s) => s.when === null), 'a domain a project can take part in carries no "Available from"');
  assert.equal(L.domainOnlyLead(view('data-scientist')),
    'Available from B4: a project cannot take part in it yet. None of its steps runs in this release, and it offers no actions.');
  // The page: the rail, a way back, and nothing else (no action bar, no New project, no write).
  const page = src('pages/DomainPage.tsx');
  assert.match(page, /<LifecycleRail rail=\{railFor\(view\)\} \/>/);
  assert.doesNotMatch(page, /ActionBar|New project|openNewProject|nexusClient|participationAttach|jobStart/);
  const ws = src('pages/WorkspacePage.tsx');
  assert.match(ws, /return ws \? <WorkspaceView id=\{ws\.id\} \/> : <DomainPage id=\{id\} \/>;/);
  // The entry point where domains are listed, worded so it cannot read as available.
  const list = src('pages/WorkspacesPage.tsx');
  assert.match(list, /const later = useDomains\(\)\.list\.filter\(\(d\) => isDomainOnly\(d\.id\)\);/);
  assert.match(list, />Not available yet<\/h2>/);
  assert.match(list, /Its planned lifecycle only; nothing runs\./);
  assert.match(src('workspaces/LifecycleRail.tsx'), /\{s\.when && <b className="nx-lrail__when">\{s\.when\}\. <\/b>\}/);
});

test('S8b the Application step: draft, not checked ("Ready to check — start a preview"), checking, healthy, failed, from records only', () => {
  const { stepStateFrom } = loadTs('src/shared/nexus/stepState.ts');
  const step = DOMAINS.find((d) => d.id === 'sde').lifecycle.find((s) => s.id === 'application');
  const app = (status, validators) => ({ kind: 'application', status, validators });
  const appStep = (versions, o = {}) => stepOf('sde', 'application', rec({ versions: [{ kind: 'build', status: 'candidate', validators: {} }, ...versions], ...o }));
  const MANIFEST = { 'app.manifest_schema': 'passed' };
  // Not checked: the manifest passed, app.preview_health runs only on a dev deployment, none is live and no job runs.
  const waiting = appStep([app('draft', MANIFEST)], { liveDeployments: 0 });
  assert.deepEqual([waiting.state, waiting.word], ['awaiting_check', 'Ready to check — start a preview']);
  assert.equal(stepStateFrom(step, { versions: [{ status: 'draft', validators: MANIFEST }], liveJobs: 0, inputsAvailable: true, liveDeployments: 0 }), 'awaiting_check');
  // Checking: a dev deployment is live, or the job starting one is (it belongs to the dev deployment step's actions).
  assert.equal(appStep([app('draft', MANIFEST)], { liveDeployments: 1 }).state, 'checking');
  const starting = appStep([app('draft', MANIFEST)], { liveDeployments: 0, liveActions: ['sde.preview.start'] });
  assert.deepEqual([starting.state, starting.word], ['checking', 'Checking — the preview is starting']);
  assert.equal(appStep([app('draft', MANIFEST)], { liveDeployments: 0, liveActions: ['sde.app.assemble'] }).state, 'in_progress', 'its own job is live');
  // Draft whose manifest has no result yet: being validated by main (not waiting on the user).
  assert.equal(appStep([app('draft', {})], { liveDeployments: 0 }).state, 'in_progress');
  // Deployments unread: no claim that it waits on the user (the previous reading stands).
  assert.equal(appStep([app('draft', MANIFEST)]).state, 'in_progress');
  // Healthy: the health check passed on a candidate.
  assert.equal(appStep([app('candidate', { ...MANIFEST, 'app.preview_health': 'passed' })], { liveDeployments: 0 }).state, 'done');
  // Failed: the health check failed, or could not run.
  assert.equal(appStep([app('draft', { ...MANIFEST, 'app.preview_health': 'failed' })], { liveDeployments: 0 }).state, 'failed');
  assert.equal(appStep([app('draft', { ...MANIFEST, 'app.preview_health': 'error' })], { liveDeployments: 0 }).state, 'failed');
  // A check main or the runner runs (a build re-hash) never waits on the user: still in progress.
  const build = DOMAINS.find((d) => d.id === 'sde').lifecycle.find((s) => s.id === 'build');
  assert.equal(stepStateFrom(build, { versions: [{ status: 'draft', validators: { 'build.exit_zero': 'passed' } }], liveJobs: 0, inputsAvailable: true, liveDeployments: 0 }), 'in_progress');
  // The summary says it, and never counts it as moving.
  const r = L.railFor(view('sde'), rec({ versions: [{ kind: 'build', status: 'candidate', validators: {} }, app('draft', MANIFEST)], liveDeployments: 0 }));
  assert.match(L.railSummary(r), /1 ready to check/);
  assert.doesNotMatch(L.railSummary(r), /in progress/);
  // The bench passes the live dev deployments it read (the rail's records stay those of railRecordsFor).
  const bench = src('project/ProjectBench.tsx');
  assert.match(bench, /const live = \(deployments\.data \?\? \[\]\)\.filter\(\(d\) => d\.status === 'starting' \|\| d\.status === 'healthy' \|\| d\.status === 'unhealthy'\);\n\s*const liveDeployments = live\.length;/);
  assert.match(bench, /m\.set\(g\.workspaceId, railFor\(view, records \? \{ \.\.\.records, liveDeployments, liveDeploymentStatuses, draftPreviews \} : null\)\);/);
});

test('S14 while a preview starts or is probed the rail reads "Checking — <reason>" (as the Spine and Folio do) and the summary counts it as checking', () => {
  const { stepStateFrom } = loadTs('src/shared/nexus/stepState.ts');
  const sde = DOMAINS.find((d) => d.id === 'sde');
  const appS = sde.lifecycle.find((s) => s.id === 'application');
  const devS = sde.lifecycle.find((s) => s.id === 'dev-deployment');
  const MANIFEST = { 'app.manifest_schema': 'passed' };
  const draft = [{ status: 'draft', validators: MANIFEST }];
  // stepState: the only live work is the deployment check.
  assert.equal(stepStateFrom(appS, { versions: draft, liveJobs: 0, inputsAvailable: true, liveDeployments: 1 }), 'checking');
  assert.equal(stepStateFrom(appS, { versions: draft, liveJobs: 1, inputsAvailable: true, liveDeployments: 1 }), 'in_progress', 'its own job runs');
  assert.equal(stepStateFrom(appS, { versions: draft, liveJobs: 0, inputsAvailable: true, liveDeployments: 0 }), 'awaiting_check');
  assert.equal(stepStateFrom(appS, { versions: draft, liveJobs: 0, inputsAvailable: true }), 'in_progress', 'deployments unread: as before');
  assert.equal(stepStateFrom(devS, { versions: [], liveJobs: 1, inputsAvailable: true, recordPresent: false, liveDeployments: 1 }), 'checking');
  assert.equal(stepStateFrom(devS, { versions: [], liveJobs: 1, inputsAvailable: true, recordPresent: false }), 'in_progress', 'unread: as before');
  assert.equal(stepStateFrom(devS, { versions: [], liveJobs: 1, inputsAvailable: true, recordPresent: true, liveDeployments: 1 }), 'done', 'healthy');
  // The rail as the click-through saw it: a deployment of the draft starting.
  const recs = (statuses) => rec({ versions: [{ kind: 'build', status: 'candidate', validators: {} }, { kind: 'application', status: 'draft', validators: MANIFEST }],
    liveActions: ['sde.preview.start'], liveDeployments: statuses.length, liveDeploymentStatuses: statuses });
  const r = L.railFor(view('sde'), recs(['starting']));
  const word = (id) => r.steps.find((s) => s.id === id).word;
  assert.equal(word('application'), 'Checking — the preview is starting');
  assert.equal(word('dev-deployment'), 'Checking — the preview is starting');
  assert.match(L.railSummary(r), /; 2 checking/);
  assert.doesNotMatch(L.railSummary(r), /in progress/);
  // Up but not recorded as answering yet.
  const up = L.railFor(view('sde'), recs(['unhealthy']));
  assert.equal(up.steps.find((s) => s.id === 'application').word, 'Checking — waiting for the preview to answer');
  assert.equal(L.checkingReason({ liveDeploymentStatuses: [] }), 'the preview is starting', 'a job starting one, before its row exists');
  // The bench passes the statuses it read; the rail styles a checking step like a moving one, always with its word.
  assert.match(src('project/ProjectBench.tsx'), /railFor\(view, records \? \{ \.\.\.records, liveDeployments, liveDeploymentStatuses, draftPreviews \} : null\)/);
  const css = src('styles/execution.css');
  assert.match(css, /\.nx-lrail__step\[data-state="checking"\]::before \{ border-color: var\(--nx-ink\); \}/);
  assert.match(css, /\.nx-lrail__bar li\[data-state="checking"\] \{ background: var\(--nx-line-strong\); \}/);
});

test('S16 per version: with two application versions and a live preview of only one, only that one reads "Checking" (rail, Spine node, Folio, Runs)', () => {
  const R = loadTs('src/renderer/src/nexus/runs/jobRunModel.ts');
  const EV = loadTs('src/renderer/src/nexus/project/evidenceModel.ts');
  const MANIFEST = { 'app.manifest_schema': 'passed' };
  // V1 is a candidate whose preview is live (healthy); V2 is the draft, assembled from build B2, with no preview of its own.
  const deployments = [{ jobId: 'J1', subjectVersionId: 'V1', status: 'healthy', startedAt: 1 }];
  const jobs = [{ id: 'J1', state: 'running', actionId: 'sde.preview.start', inputs: [{ versionId: 'B1', slot: 'build', contentHash: 'h' }], createdAt: 1 }];
  const draftPreviews = R.livePreviewsOf({ versionId: 'V2', buildVersionId: 'B2' }, deployments, jobs).map((p) => p.status);
  assert.deepEqual(draftPreviews, [], 'V1\'s live preview is not V2\'s');
  // The rail: the Application step (V2 draft) waits for its own preview; the Dev deployment step sees the project's.
  const base = { versions: [{ kind: 'build', status: 'candidate', validators: {} }, { kind: 'application', status: 'draft', validators: MANIFEST }],
    liveActions: ['sde.preview.start'], participation: true, deploymentHealthy: false, liveDeployments: 1, liveDeploymentStatuses: ['healthy'] };
  const r = L.railFor(view('sde'), { ...base, draftPreviews });
  assert.deepEqual([r.steps.find((s) => s.id === 'application').state, r.steps.find((s) => s.id === 'application').word], ['awaiting_check', 'Ready to check — start a preview']);
  assert.equal(r.steps.find((s) => s.id === 'dev-deployment').state, 'checking', 'the project has a live preview (V1)');
  // The same draft once ITS preview is starting (a job of build B2 not leased yet): Checking, with its own reason.
  const own = R.livePreviewsOf({ versionId: 'V2', buildVersionId: 'B2' }, deployments,
    [...jobs, { id: 'J2', state: 'queued', actionId: 'sde.preview.start', inputs: [{ versionId: 'B2', slot: 'build', contentHash: 'h' }], createdAt: 2 }]).map((p) => p.status);
  assert.deepEqual(own, ['starting']);
  const r2 = L.railFor(view('sde'), { ...base, draftPreviews: own });
  assert.equal(r2.steps.find((s) => s.id === 'application').word, 'Checking — the preview is starting');
  // The Spine node: V2's word ignores V1's live deployment.
  const SM2 = loadTs('src/renderer/src/nexus/project/spineModel.ts');
  const app = (id, status) => ({ artifact: { id, kind: 'application', status: 'active', ownerWorkspaceId: 'sde', ownerParticipationId: 'pp', name: id, createdAt: 1 },
    versionCount: 1, current: null, latest: { id, versionNo: 1, status } });
  const words = SM2.withApplicationWords(new Map([['artifact:V2', 'Checking…']]), [app('V2', 'draft')], new Map([['V2', MANIFEST]]), deployments,
    { jobs, builds: new Map([['V2', 'B2']]) });
  assert.equal(words.get('artifact:V2'), 'Ready to check — start a preview');
  const words2 = SM2.withApplicationWords(new Map(), [app('V2', 'draft')], new Map([['V2', MANIFEST]]), deployments,
    { jobs: [...jobs, { id: 'J2', state: 'queued', actionId: 'sde.preview.start', inputs: [{ versionId: 'B2', slot: 'build', contentHash: 'h' }], createdAt: 2 }], builds: new Map([['V2', 'B2']]) });
  assert.equal(words2.get('artifact:V2'), 'Checking: the dev deployment is starting');
  // The Folio reads deployments of its own version only (and the not-yet-leased preview of its own build).
  assert.equal(EV.applicationPreview({ status: 'draft', validators: MANIFEST, deployments: [] }).state, 'not_checked');
  const passport = src('project/ArtifactPassport.tsx');
  assert.match(passport, /const rows = deployments\.data\.filter\(\(d\) => d\.subjectVersionId === versionId\)/);
  assert.match(passport, /livePreviewsOf\(\{ versionId, buildVersionId: shownBuildId \}, deployments\.data, jobs\.data\)/);
  // Runs: the assemble job of V2 (input B2) is not held "checking" by V1's preview.
  const live = R.livePreviewsOf({ versionId: 'V2', buildVersionId: 'B2' }, deployments, jobs).length;
  assert.equal(R.awaitingUserCheck({ expected: R.expectedChecksFor('sde.app.assemble'), outputs: [[{ validatorId: 'app.manifest_schema', blocking: true, status: 'passed' }]], liveDeployments: live }), true);
  // The bench reads each shown draft's build (its assembled_from source) and counts per version.
  const bench = src('project/ProjectBench.tsx');
  assert.match(bench, /nexusClient\.lineageGet\(id, \{ direction: 'up', depth: 1 \}\)/);
  assert.match(bench, /livePreviewsOf\(\{ versionId, buildVersionId: builds\.get\(versionId\) \?\? null \}, deployments\.data \?\? \[\], jobs\.data \?\? \[\]\)/);
});

// ---------- B2b Task 15 fix round 3: the Review step reads its record ----------

test('LR3 the Review step is Done exactly when a change set was reviewed AND accepted (an active change set); never from approved-only, rejected, changes requested or no review', () => {
  const S = loadTs('src/renderer/src/nexus/project/spineModel.ts');
  const CHANGE = ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly'];
  const ALL = Object.fromEntries(CHANGE.map((id) => [id, 'passed']));
  const review = (records) => stepOf('sde', 'review', records);
  const cs = (status, validators = ALL) => ({ kind: 'change_set', status, validators });
  // Candidate change sets whatever their newest review says (approved, rejected, changes requested) or none: waiting, never done.
  for (const status of ['draft', 'candidate', 'failed', 'deprecated']) {
    assert.notEqual(review(rec({ versions: [cs(status)] })).state, 'done', `${status} change set`);
    assert.notEqual(review(rec({ versions: [cs(status)] })).word, 'Done');
  }
  assert.equal(review(rec({ versions: [cs('candidate')] })).state, 'ready', 'a change set waiting for a decision: ready, not done');
  assert.equal(review(rec()).state, 'blocked', 'no change set at all');
  // Accepted (active): done, with the word.
  const done = review(rec({ versions: [cs('active')] }));
  assert.equal(done.state, 'done');
  assert.equal(done.word, 'Done');
  assert.equal(L.reviewRecorded(rec({ versions: [cs('candidate')] })), false);
  assert.equal(L.reviewRecorded(rec({ versions: [cs('active')] })), true);
  assert.equal(L.reviewRecorded(rec({ versions: [{ kind: 'requirement', status: 'active', validators: {} }] })), false, 'only a change set is the review record');
  // From the Spine's own summaries: the accepted change set is the artifact's current version.
  const art = (id, kind, current, latest) => ({ artifact: { id: `a${id}`, kind, status: 'active', ownerWorkspaceId: 'sde', ownerScope: 'participation', createdAt: id, updatedAt: id },
    versionCount: 1, current, latest });
  const accepted = art(1, 'change_set', { id: 'v1', versionNo: 1 }, { id: 'v1', versionNo: 1, status: 'active' });
  const waiting = art(2, 'change_set', null, { id: 'v2', versionNo: 1, status: 'candidate' });
  const records = (artifacts) => S.railRecordsFor({ workspaceId: 'sde', artifacts, checks: new Map(artifacts.map((a) => [a.latest.id, ALL])), liveActions: [], deploymentHealthy: false, participating: true });
  assert.equal(review(records([accepted])).state, 'done');
  assert.equal(review(records([waiting])).state, 'ready');
  assert.equal(review(records([waiting, accepted])).state, 'done');
  // The other steps are unchanged by the change set.
  const withCs = L.railFor(view('sde'), records([accepted]));
  const without = L.railFor(view('sde'), records([]));
  for (const id of ['requirement', 'project', 'repository', 'code', 'tests', 'build', 'application', 'dev-deployment', 'diagnostics']) {
    const a = withCs.steps.find((x) => x.id === id); const b = without.steps.find((x) => x.id === id);
    if (a && b) assert.equal(a.state, b.state, id);
  }
  // The Review step still names its actions and keeps the registry's scope note.
  assert.match(done.note, /Accepting merges the change into a Nexus ref, never into your branch or files/);
});
