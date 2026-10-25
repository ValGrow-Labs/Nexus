'use strict';
// B2b Task 8: change sets — register, validators and lineage. CS1-CS14.
//
// Pure validator unit tests need no database; the lifecycle tests (CS1-CS14) drive the real services through
// `agentFixtures.cjs` (a real session, turn, job and token) exactly as Tasks 4-9 do, and complete each system child
// job by hand (lease, attempt, `FakeRunner.report({op:'attempt.exited', ...})`), the same way the B2a exec tests
// drive engine and tool jobs without Docker.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { agentWorld, openRunningTurn } = require('./helpers/agentFixtures.cjs');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { immediateTx } = loadTs('src/main/nexus/db/tx.ts');
const { insertAttemptTx, transitionAttemptTx, attemptRow } = loadTs('src/main/nexus/exec/attempts.ts');
const { jobRefFor } = loadTs('src/shared/nexus/changeSet.ts');
const { ChangeSetService } = loadTs('src/main/nexus/repo/changeSetService.ts');
const diffNonempty = loadTs('src/main/nexus/validation/validators/diffNonempty.ts');
const pathsInScope = loadTs('src/main/nexus/validation/validators/pathsInScope.ts');
const secretScan = loadTs('src/main/nexus/validation/validators/secretScan.ts');
const secretEntropyNotes = loadTs('src/main/nexus/validation/validators/secretEntropyNotes.ts');
const appliesCleanly = loadTs('src/main/nexus/validation/validators/appliesCleanly.ts');
const { scanAddedLines } = loadTs('src/runner/gitWrite.ts');
const { orphans } = require('./helpers/orphans.cjs');

const PROJECT = 'p-ledger';
const WORKSPACE = 'sde';
const COMMIT_BASE = 'a'.repeat(40);
const TREE = 'c'.repeat(40);

// ---------- pure validator unit tests (no database) ----------

test('git.diff_nonempty: an unchanged commit fails empty_diff; a changed one passes', () => {
  const head = 'b'.repeat(40);
  const base = COMMIT_BASE;
  const empty = diffNonempty.run({ base, head, changed: false, diffstat: { files: 0, insertions: 0, deletions: 0 } });
  assert.equal(empty.status, 'failed');
  assert.equal(empty.reason, 'empty_diff');
  const ok = diffNonempty.run({ base, head, changed: true, diffstat: { files: 1, insertions: 3, deletions: 0 } });
  assert.equal(ok.status, 'passed');
  assert.ok(ok.evidence.some((e) => e.type === 'git' && e.check === 'diff_nonempty'));
});

test('git.paths_in_scope: a sensitive or out-of-scope path fails; an in-scope plain path passes', () => {
  const head = 'b'.repeat(40);
  for (const bad of ['.git/config', '.env', 'id_rsa', 'certs/a.pem']) {
    const r = pathsInScope.run({ head, paths: [bad], pathsTruncated: false, scope: ['**'] });
    assert.equal(r.status, 'failed', bad);
    assert.equal(r.reason, 'out_of_scope');
  }
  const r2 = pathsInScope.run({ head, paths: ['src/a.ts', 'docs/readme.md'], pathsTruncated: false, scope: ['src/**'] });
  assert.equal(r2.status, 'failed');
  const r3 = pathsInScope.run({ head, paths: ['src/a.ts'], pathsTruncated: false, scope: ['src/**'] });
  assert.equal(r3.status, 'passed');
  const truncated = pathsInScope.run({ head, paths: ['src/a.ts'], pathsTruncated: true, scope: ['**'] });
  assert.equal(truncated.status, 'error');
});

test('sec.secret_scan: any hit fails; the evidence holds path and line only, never the secret text', () => {
  const head = 'b'.repeat(40);
  const failing = secretScan.run({ head, secretHits: [{ path: 'src/a.ts', line: 12, rule: 'provider_key' }], scanTruncated: false });
  assert.equal(failing.status, 'failed');
  assert.equal(failing.reason, 'secret_shaped_line');
  const text = JSON.stringify(failing.evidence);
  assert.ok(!/AKIA|BEGIN|sk-/.test(text), 'no secret shape leaks into the evidence');
  assert.deepEqual(failing.evidence, [{ type: 'location', path: 'src/a.ts', line: 12, rule: 'provider_key' }]);
  const clean = secretScan.run({ head, secretHits: [], scanTruncated: false });
  assert.equal(clean.status, 'passed');
});

test('sec.entropy_notes: advisory, lists hits, never fails the version (blocking:false in validators.ts)', () => {
  const { VALIDATORS } = loadTs('src/shared/nexus/validators.ts');
  assert.equal(VALIDATORS.find((v) => v.id === 'sec.entropy_notes').blocking, false);
  const head = 'b'.repeat(40);
  const r = secretEntropyNotes.run({ head, entropyHits: [{ path: 'src/a.ts', line: 3, rule: 'high_entropy' }] });
  assert.equal(r.evidence.length, 1);
  const r2 = secretEntropyNotes.run({ head, entropyHits: [] });
  assert.equal(r2.status, 'passed');
});

test('git.applies_cleanly: a conflict fails, a clean merge passes', () => {
  const head = 'b'.repeat(40); const integrationHead = COMMIT_BASE;
  const conflict = appliesCleanly.run({ head, integrationHead, clean: false });
  assert.equal(conflict.status, 'failed');
  assert.equal(conflict.reason, 'merge_conflict');
  const clean = appliesCleanly.run({ head, integrationHead, clean: true });
  assert.equal(clean.status, 'passed');
});

// ---------- scanAddedLines (the runner's diff scan; CS4, CS11b at the unit level) ----------

test('scanAddedLines: an AWS key and a private-key header are secret hits at their exact line; package-lock integrity is not', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 0000000..1111111 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -0,0 +1,2 @@',
    '+const key = "AKIAABCDEFGHIJKLMNOP";',
    '+const ok = "just text";',
    'diff --git a/src/b.pem b/src/b.pem',
    'new file mode 100644',
    'index 0000000..2222222',
    '--- /dev/null',
    '+++ b/src/b.pem',
    '@@ -0,0 +1,1 @@',
    '+-----BEGIN OPENSSH PRIVATE KEY-----',
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1,0 +2,1 @@',
    '+    "integrity": "sha512-abcDEFghiJKLmnoPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX==",'
  ].join('\n');
  const { secretHits, entropyHits } = scanAddedLines(patch);
  assert.deepEqual(secretHits, [
    { path: 'src/a.ts', line: 1, rule: 'provider_key' },
    { path: 'src/b.pem', line: 1, rule: 'private_key' }
  ]);
  // The lockfile's own integrity hash is excluded from the advisory notes (CS11b), and holds no secret shape anyway.
  assert.ok(!entropyHits.some((e) => e.path === 'package-lock.json'));
  assert.ok(!secretHits.some((e) => e.path === 'package-lock.json'));
  assert.ok(JSON.stringify(secretHits).indexOf('AKIA') === -1 && JSON.stringify(secretHits).indexOf('BEGIN') === -1, 'never the line text');
});

test('scanAddedLines: a high-entropy line outside a lockfile is an entropy hit; a plain line is not', () => {
  const patch = [
    'diff --git a/src/token.ts b/src/token.ts',
    '--- a/src/token.ts',
    '+++ b/src/token.ts',
    '@@ -0,0 +1,2 @@',
    '+const t = "xJ3kLm9QpR2vN7wZaB4cD6eF8gH0iK1lM3nO5pQ7rS9t";',
    '+const t2 = "hello world";'
  ].join('\n');
  const { entropyHits } = scanAddedLines(patch);
  assert.deepEqual(entropyHits, [{ path: 'src/token.ts', line: 1, rule: 'high_entropy' }]);
});

test('scanAddedLines: text that begins ++ or looks like a header is scanned as content, never read as a header', () => {
  const patch = [
    'diff --git a/x.txt b/x.txt',
    '--- /dev/null',
    '+++ b/x.txt',
    '@@ -0,0 +1,6 @@',
    '++AKIAABCDEFGHIJKLMNOP',
    '++-----BEGIN PRIVATE KEY-----',
    '+++ b/fake.txt',
    '++ package-lock.json',
    '+@@ -1,1 +1,1 @@',
    '+AKIAABCDEFGHIJKLMNOQ',
    'diff --git a/y.txt b/y.txt',
    '--- /dev/null',
    '+++ b/y.txt',
    '@@ -0,0 +1,1 @@',
    '+tail'
  ].join(String.fromCharCode(10));
  const { secretHits, entropyHits } = scanAddedLines(patch);
  assert.deepEqual(secretHits, [
    { path: 'x.txt', line: 1, rule: 'provider_key' },
    { path: 'x.txt', line: 2, rule: 'private_key' },
    { path: 'x.txt', line: 6, rule: 'provider_key' }
  ], 'every spoofing line is content of x.txt, at its own line');
  assert.ok(entropyHits.every((h) => h.path === 'x.txt'), 'no hit is attributed to a spoofed path');
  assert.ok(!JSON.stringify(secretHits).includes('AKIA'));
});

test('scanAddedLines: quoted, spaced and no-newline-marker patches keep their paths and line numbers', () => {
  const nl = String.fromCharCode(10); const bs = String.fromCharCode(92);
  const patch = [
    'diff --git "a/q' + bs + 't.txt" "b/q' + bs + 't.txt"',
    '--- /dev/null',
    '+++ "b/q' + bs + 'tt.txt"',
    '@@ -0,0 +1,1 @@',
    '+AKIAABCDEFGHIJKLMNOP',
    bs + ' No newline at end of file',
    'diff --git a/sp ace.txt b/sp ace.txt',
    '--- a/sp ace.txt\t',
    '+++ b/sp ace.txt\t',
    '@@ -3,2 +3,2 @@',
    '-old1', '-old2', '+new1', '+AKIAABCDEFGHIJKLMNOP'
  ].join(nl);
  const { secretHits } = scanAddedLines(patch);
  assert.deepEqual(secretHits, [{ path: 'q\tt.txt', line: 1, rule: 'provider_key' }, { path: 'sp ace.txt', line: 4, rule: 'provider_key' }]);
});

test('sec.secret_scan: a truncated scan never passes (failed scan_truncated), with or without hits', () => {
  const head = 'b'.repeat(40);
  const r = secretScan.run({ head, secretHits: [], scanTruncated: true });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'scan_truncated');
  assert.equal(secretScan.run({ head, secretHits: [], scanTruncated: false }).status, 'passed');
  // An absent flag says nothing was checked: it counts as truncated, exactly like ingest's fail-closed read.
  assert.equal(secretScan.run({ head, secretHits: [] }).reason, 'scan_truncated');
});

test('git.paths_in_scope: a .claude segment at any depth is refused whatever the scope says', () => {
  const head = 'b'.repeat(40);
  for (const p of ['.claude/settings.local.json', 'a/.claude/x', '.CLAUDE/x', 'a/.claude']) {
    const r = pathsInScope.run({ head, paths: [p], pathsTruncated: false, scope: ['**'] });
    assert.equal(r.status, 'failed', p);
  }
  assert.equal(pathsInScope.run({ head, paths: ['src/claude.ts', 'docs/.claudeish/x'], pathsTruncated: false, scope: ['**'] }).status, 'passed');
});

// ---------- lifecycle tests (CS1-CS14) ----------

function addRepository(w, { branch = 'main', commit = COMMIT_BASE } = {}) {
  const pw = w.nx.workspaces.primaryOf(w.me, PROJECT);
  const art = newId(w.clock.t);
  w.db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, description, owner_scope, owner_participation_id, owner_workspace_id,
      created_by, status, current_version_id, metadata_json, created_at, updated_at)
    VALUES (?, ?, 'repository', 'ledger-api', NULL, 'participation', ?, ?, 'user:local', 'active', NULL, '{}', ?, ?)`)
    .run(art, PROJECT, pw.id, pw.workspaceId, w.clock.t, w.clock.t);
  const v = w.nx.artifacts.registerVersion(w.me, { artifactId: art, storage: { kind: 'git', commit },
    metadata: { profile: 'sde-node', branch, lockfile: { sha256: 'a'.repeat(64) } } }).version.id;
  w.nx.artifacts.finalize(w.sys, v, 'candidate');
  w.db.transaction(() => {
    w.db.prepare("UPDATE artifact_versions SET status = 'active' WHERE id = ?").run(v);
    w.db.prepare('UPDATE artifacts SET current_version_id = ? WHERE id = ?').run(v, art);
  })();
  return { artifactId: art, versionId: v };
}

function makeRequirement(w) {
  const art = w.nx.artifacts.create(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, kind: 'requirement', name: `req-${crypto.randomBytes(3).toString('hex')}` });
  const v = w.nx.artifacts.registerVersion(w.me, { artifactId: art.id, storage: { kind: 'inline', json: { title: 'r1', criteria: [{ id: 'c1', text: 'works' }] } } }).version.id;
  w.nx.artifacts.finalize(w.sys, v, 'candidate');
  return v;
}

function css(w, waitMs = 60_000) {
  return new ChangeSetService(w.db, { jobs: w.nx.jobs, system: w.sys, now: () => w.clock.t, waitMs });
}

function findJob(w, parentId, recipeId) {
  return w.db.prepare("SELECT id FROM jobs WHERE parent_job_id = ? AND recipe_id = ? ORDER BY rowid DESC LIMIT 1").get(parentId, recipeId);
}
function jobRow(w, id) { return w.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id); }

function leaseAndRun(w, jobId) {
  return immediateTx(w.db, () => {
    const leased = w.nx.jobs.transitionTx(w.sys, jobId, 'leased', undefined, { expectState: 'queued' });
    const attemptId = newId(w.clock.t);
    insertAttemptTx(w.db, { id: attemptId, jobId, projectId: PROJECT, n: leased.attempts, bootId: w.nx.bootId, now: w.clock.t, logPath: null,
      sandbox: { kind: 'tool' }, environment: {} });
    transitionAttemptTx(w.db, attemptRow(w.db, attemptId), 'running', w.clock.t, PROJECT);
    w.nx.jobs.transitionTx(w.sys, jobId, 'running', undefined, { expectState: 'leased' });
    return attemptId;
  });
}

function finish(turn, attemptId, { code = 0, outputs = [], parsed = [] } = {}) {
  turn.runner.report({ op: 'attempt.exited', attemptId, exit: { code, oomKilled: false, finishedAt: Date.now() }, outputs, parsed, logBytes: 0 });
}
const gitFacts = (o) => ({ parser: 'git-facts', sourceSha256: '0'.repeat(64), normalized: { ok: true, ...o } });
const gitRefused = (code) => ({ parser: 'git-facts', sourceSha256: '0'.repeat(64), normalized: { ok: false, code } });

let seq = 0;
const nextKey = () => `ck${Date.now()}_${++seq}`;

/** Runs the collect job for a register() call to completion with the given git facts, returning the answer. */
async function collectWith(w, turn, service, args, facts, clientKey = nextKey()) {
  const p = service.register(turn.claims, { clientKey, ...args });
  const job = findJob(w, turn.job.id, 'changeset.collect');
  assert.ok(job, 'the collect job was queued');
  const attemptId = leaseAndRun(w, job.id);
  finish(turn, attemptId, { code: facts.ok === false ? 1 : 0, parsed: [facts.ok === false ? gitRefused(facts.code) : gitFacts(facts)] });
  return p;
}

const keyed = (w, like) => w.db.prepare('SELECT id FROM jobs WHERE idempotency_key LIKE ? ORDER BY rowid DESC LIMIT 1').get(like);
const PASSING = { id: 'a.test.js', file: 'a.test.js', classname: 'a', name: 't1', outcome: 'passed', ms: 1 };

/**
 * Completes the discover -> test-run chain for a change set's `cs.tests_pass` (one JS test; `o.cases` is the JUnit's
 * rows, `o.discovered` the discovered files). The discover job is session-less and parent-less
 * (ValidationService.enqueueChangeSetDiscoverTx), so it is found by its idempotency key, keyed by the change set's own
 * version id (the newest one: a revalidation queues a fresh job).
 */
function completeTests(w, turn, versionId, o = {}) {
  const discover = keyed(w, `cs.tests_pass:${versionId}:discover:%`);
  assert.ok(discover, 'cs.tests_pass queued its discover child job');
  const files = o.discovered ?? ['a.test.js'];
  const idsSha = crypto.createHash('sha256').update('ids' + files.join(',')).digest('hex');
  const dAttempt = leaseAndRun(w, discover.id);
  finish(turn, dAttempt, {
    outputs: [{ relPath: 'ids.txt', sha256: idsSha, bytes: 10, mediaType: 'text/plain' }],
    parsed: [{ parser: 'discovery', sourceSha256: idsSha, normalized: { framework: 'node-test', ids: files, files } }]
  });
  const run = findJob(w, discover.id, 'sde.test.node');
  if (!run) return { discover, run: null };
  const cases = o.cases ?? [PASSING];
  const failedN = cases.filter((c) => c.outcome === 'failed').length;
  const skippedN = cases.filter((c) => c.outcome === 'skipped').length;
  const junitSha = crypto.createHash('sha256').update('junit' + JSON.stringify(cases)).digest('hex');
  const rAttempt = leaseAndRun(w, run.id);
  finish(turn, rAttempt, {
    code: failedN > 0 ? 1 : 0,
    outputs: [{ relPath: 'junit.xml', sha256: junitSha, bytes: 50, mediaType: 'application/xml' }],
    parsed: [{ parser: 'junit', sourceSha256: junitSha, normalized: {
      sha256: junitSha, total: cases.length, passed: cases.length - failedN - skippedN, failed: failedN, errored: 0, skipped: skippedN,
      declaredTotal: cases.length, countsMismatch: false, cases
    } }]
  });
  return { discover, run };
}

/** Completes the newest merge-check job of a change set (found by its idempotency key); `parsed` overrides the facts. */
function completeMergeCheck(w, turn, versionId, { clean = true, parsed = null, code = 0 } = {}) {
  const check = keyed(w, `git.applies_cleanly:${versionId}:merge_check:%`);
  assert.ok(check, 'git.applies_cleanly queued its merge-check child job');
  const attempt = leaseAndRun(w, check.id);
  finish(turn, attempt, { code, parsed: [parsed ?? gitFacts({ clean, tree: clean ? TREE : null, integrationHead: COMMIT_BASE })] });
  return check.id;
}

function latest(w, versionId, validatorId) {
  return w.db.prepare(`SELECT * FROM validations WHERE version_id = ? AND validator_id = ? ORDER BY rowid DESC LIMIT 1`).get(versionId, validatorId);
}
function version(w, id) { return w.db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(id); }
const HEAD1 = 'b'.repeat(40);
const factsFor = (turn, o = {}) => ({ changed: true, parent: COMMIT_BASE, head: HEAD1, tree: TREE, base: COMMIT_BASE, ref: jobRefFor(turn.session.id),
  diffstat: { files: 1, insertions: 3, deletions: 0 }, paths: ['src/a.ts'], pathsTruncated: false, secretHits: [], entropyHits: [], scanTruncated: false, ...o });
const newWorld = () => { const w = agentWorld({ platform: { ingest: undefined } }); addRepository(w); return w; };

test('CS1: the happy path reaches candidate, with exact lineage', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  const repo = addRepository(w);
  const req = makeRequirement(w);
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'Add feature', summary: 'does a thing', requirementVersionIds: [req] }, factsFor(turn));
  assert.ok(answer.versionId, 'a version was produced');
  assert.equal(answer.status, 'draft');
  completeTests(w, turn, answer.versionId);
  completeMergeCheck(w, turn, answer.versionId);
  assert.equal(version(w, answer.versionId).status, 'candidate', 'every blocking register and candidate validator passed');
  for (const id of ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly']) {
    assert.equal(latest(w, answer.versionId, id)?.status, 'passed', id);
  }
  const ev = JSON.parse(latest(w, answer.versionId, 'cs.tests_pass').evidence_json);
  const suite = w.db.prepare("SELECT id FROM artifact_versions v WHERE json_extract(v.metadata_json, '$.changeSetVersionId') = ?").get(answer.versionId);
  assert.ok(ev.some((e) => e.type === 'junit' && e.passed === 1) && ev.some((e) => e.type === 'hash' && e.label === `suite:${suite.id}`),
    'the evidence names the suite version, the junit hash and the counts');
  const edges = w.db.prepare('SELECT to_version_id AS id, relation FROM artifact_edges WHERE from_version_id = ?').all(answer.versionId);
  assert.ok(edges.some((e) => e.id === repo.versionId && e.relation === 'derived_from'), 'derived_from the repository version');
  assert.ok(edges.some((e) => e.id === req && e.relation === 'implements'), 'implements the requirement');
  assert.deepEqual(JSON.parse(version(w, answer.versionId).metadata_json).branch, 'main');
});

// F23 ruling: an empty diff yields a FAILED version (not "no version written"), because the revise flow needs failed
// versions to exist; the agent revises it as v2.
test('CS2: an empty diff fails git.diff_nonempty and the version is failed (it stays, to be revised)', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'No-op', summary: '' },
    factsFor(turn, { changed: false, head: COMMIT_BASE, diffstat: { files: 0, insertions: 0, deletions: 0 }, paths: [] }));
  assert.equal(answer.status, 'failed');
  assert.equal(latest(w, answer.versionId, 'git.diff_nonempty').status, 'failed');
  assert.equal(version(w, answer.versionId).status, 'failed');
});

test('CS3: .git/config, .env and an agent-tool settings path fail paths_in_scope', async () => {
  for (const paths of [['.git/config', '.env'], ['.claude/settings.local.json'], ['x/.claude/y.txt']]) {
    const w = newWorld();
    const turn = openRunningTurn(w.db, w.nx);
    const answer = await collectWith(w, turn, css(w), { title: 'Touch sensitive', summary: '' }, factsFor(turn, { paths }));
    assert.equal(version(w, answer.versionId).status, 'failed', paths.join());
    assert.equal(latest(w, answer.versionId, 'git.paths_in_scope').status, 'failed');
  }
});

test('CS4: a secret line fails the version; the evidence holds path:line only, never in activity, job_events, jobs, job_attempts or the logs', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const SECRET = 'AKIAABCDEFGHIJKLMNOP';
  const answer = await collectWith(w, turn, css(w), { title: 'Leak', summary: '' },
    factsFor(turn, { secretHits: [{ path: 'src/a.ts', line: 4, rule: 'provider_key' }] }));
  assert.equal(version(w, answer.versionId).status, 'failed');
  const row = latest(w, answer.versionId, 'sec.secret_scan');
  assert.equal(row.status, 'failed');
  assert.deepEqual(JSON.parse(row.evidence_json), [{ type: 'location', path: 'src/a.ts', line: 4, rule: 'provider_key' }]);
  const dump = [
    ...w.db.prepare('SELECT details_json FROM activity').all().map((r) => r.details_json),
    ...w.db.prepare('SELECT data_json FROM job_events').all().map((r) => r.data_json),
    ...w.db.prepare('SELECT params_json, capabilities_json, limits_json, error_json, state_json, progress_json FROM jobs').all().map((r) => JSON.stringify(r)),
    ...w.db.prepare('SELECT error_json, sandbox_json, environment_json FROM job_attempts').all().map((r) => JSON.stringify(r)),
    ...w.db.prepare('SELECT * FROM validations').all().map((r) => JSON.stringify(r)),
    ...w.logs
  ].join('\n');
  assert.ok(!dump.includes(SECRET), 'the key text appears nowhere');
});

test('CS5: a failing test keeps the change set out of candidate: the suite\'s failure is mirrored and the version fails', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'Broken', summary: '' }, factsFor(turn));
  completeMergeCheck(w, turn, answer.versionId);
  completeTests(w, turn, answer.versionId, { cases: [{ ...PASSING, outcome: 'failed' }] });
  const row = latest(w, answer.versionId, 'cs.tests_pass');
  assert.equal(row.status, 'failed');
  assert.match(row.summary, /tests_failed/);
  assert.equal(version(w, answer.versionId).status, 'failed');
});

test('CS6: no tests ran (a run that executed nothing, or nothing discovered) fails cs.tests_pass and the version', async () => {
  // A run whose only case was skipped executed nothing: failed no_tests, mirrored.
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const a = await collectWith(w, turn, css(w), { title: 'Skips', summary: '' }, factsFor(turn));
  completeMergeCheck(w, turn, a.versionId);
  completeTests(w, turn, a.versionId, { cases: [{ ...PASSING, outcome: 'skipped' }] });
  assert.equal(latest(w, a.versionId, 'cs.tests_pass').status, 'failed');
  assert.match(latest(w, a.versionId, 'cs.tests_pass').summary, /no_tests/);
  assert.equal(version(w, a.versionId).status, 'failed');
  // Nothing discovered: the suite fails suite.discovered, its own check never runs, and the change set fails here.
  const w2 = newWorld();
  const t2 = openRunningTurn(w2.db, w2.nx);
  const b = await collectWith(w2, t2, css(w2), { title: 'Nothing', summary: '' }, factsFor(t2));
  const r = completeTests(w2, t2, b.versionId, { discovered: [] });
  assert.equal(r.run, null, 'no test-run child job exists');
  assert.equal(latest(w2, b.versionId, 'cs.tests_pass').status, 'failed');
  assert.equal(version(w2, b.versionId).status, 'failed');
});

test('CS7: a merge-tree conflict fails git.applies_cleanly', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'Conflicting', summary: '' }, factsFor(turn));
  completeMergeCheck(w, turn, answer.versionId, { clean: false });
  assert.equal(latest(w, answer.versionId, 'git.applies_cleanly').status, 'failed');
  assert.notEqual(version(w, answer.versionId).status, 'candidate');
});

test('CS8: a check that could not run is `error`, the version stays a draft, and Revalidate re-runs it and records its validation', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'Flaky', summary: '' }, factsFor(turn));
  const refused = { parser: 'git-facts', sourceSha256: '0'.repeat(64), normalized: { ok: false, code: 'git_failed' } };
  const first = completeMergeCheck(w, turn, answer.versionId, { code: 1, parsed: refused });
  assert.equal(latest(w, answer.versionId, 'git.applies_cleanly').status, 'error');
  assert.equal(version(w, answer.versionId).status, 'draft', 'a check that could not run never fails the version');
  const { jobs } = w.nx.validation.revalidate(w.me, answer.versionId);
  const second = keyed(w, `git.applies_cleanly:${answer.versionId}:merge_check:%`);
  assert.notEqual(second.id, first, 'a fresh merge-check job, not the finished one');
  assert.ok(jobs.includes(second.id));
  // Asking again while that check is still live answers the same job: bounded, never a second one.
  assert.ok(w.nx.validation.revalidate(w.me, answer.versionId).jobs.includes(second.id));
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key LIKE ?').get(`git.applies_cleanly:${answer.versionId}:merge_check:%`).n, 2);
  completeMergeCheck(w, turn, answer.versionId);
  assert.equal(latest(w, answer.versionId, 'git.applies_cleanly').status, 'passed', 'the re-run recorded its validation');
});

test('CS9: revise gives v2 derived_from v1', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const service = css(w);
  // v1 fails its register validators (a scope violation) and so leaves draft immediately, as a revised v1 normally
  // would (F23: "a failed change set never becomes a candidate again; the agent revises it as v2").
  const v1 = await collectWith(w, turn, service, { title: 'v1', summary: '' }, factsFor(turn, { paths: ['.git/config'] }));
  assert.equal(version(w, v1.versionId).status, 'failed');
  const v2 = await collectWith(w, turn, service, { title: 'v1', summary: '', reviseArtifactId: v1.artifactId },
    factsFor(turn, { parent: HEAD1, head: 'd'.repeat(40), tree: 'e'.repeat(40) }));
  assert.equal(v2.artifactId, v1.artifactId);
  const edges = w.db.prepare("SELECT to_version_id AS id FROM artifact_edges WHERE from_version_id = ? AND relation = 'derived_from'").all(v2.versionId);
  assert.ok(edges.some((e) => e.id === v1.versionId));
});

test('CS9b: v2 revising with an UNCHANGED head still gets its own discovery and cs.tests_pass (no dedupe onto v1\'s suite)', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const service = css(w);
  const v1 = await collectWith(w, turn, service, { title: 'v1', summary: '' }, factsFor(turn));
  completeTests(w, turn, v1.versionId);
  completeMergeCheck(w, turn, v1.versionId, { clean: false });      // v1 fails on its merge check; its suite is a candidate
  assert.equal(version(w, v1.versionId).status, 'failed');
  const v2 = await collectWith(w, turn, service, { title: 'v1', summary: '', reviseArtifactId: v1.artifactId }, factsFor(turn));
  completeTests(w, turn, v2.versionId);
  completeMergeCheck(w, turn, v2.versionId);
  assert.equal(latest(w, v2.versionId, 'cs.tests_pass')?.status, 'passed', 'v2\'s own cs.tests_pass is recorded');
  assert.equal(version(w, v2.versionId).status, 'candidate', 'the draft does not stick');
});

test('scanAddedLines: non-BMP characters in quoted paths stay whole; a malformed trailing backslash is attributed to an unreadable path, never dropped', () => {
  const nl = String.fromCharCode(10); const bs = String.fromCharCode(92);
  const emoji = String.fromCodePoint(0x1f600);
  const patch = [
    '--- /dev/null', '+++ "b/' + bs + '360' + bs + '237' + bs + '230' + bs + '200.txt"', '@@ -0,0 +1,1 @@', '+AKIAABCDEFGHIJKLMNOP',
    '--- /dev/null', '+++ "b/' + emoji + bs + 't.txt"', '@@ -0,0 +1,1 @@', '+AKIAABCDEFGHIJKLMNOP',
    '--- /dev/null', '+++ "b/x' + bs + '"', '@@ -0,0 +1,1 @@', '+AKIAABCDEFGHIJKLMNOP'
  ].join(nl);
  const { secretHits } = scanAddedLines(patch);
  assert.deepEqual(secretHits.map((h) => h.path), [emoji + '.txt', emoji + String.fromCharCode(9) + '.txt', '(unreadable path)']);
  assert.ok(secretHits.every((h) => !h.path.includes(String.fromCharCode(0xfffd))), 'no replacement character');
});

test('a second revalidate while the suite derived from a change set is still running queues no second discovery', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'Slow suite', summary: '' }, factsFor(turn));
  const discover = keyed(w, `cs.tests_pass:${answer.versionId}:discover:%`);
  const idsSha = crypto.createHash('sha256').update('ids').digest('hex');
  finish(turn, leaseAndRun(w, discover.id), {
    outputs: [{ relPath: 'ids.txt', sha256: idsSha, bytes: 10, mediaType: 'text/plain' }],
    parsed: [{ parser: 'discovery', sourceSha256: idsSha, normalized: { framework: 'node-test', ids: ['a.test.js'], files: ['a.test.js'] } }]
  });
  const run = findJob(w, discover.id, 'sde.test.node');
  assert.ok(run, 'the suite\'s own test run is queued and not yet run');
  const a = w.nx.validation.revalidate(w.me, answer.versionId);
  const b = w.nx.validation.revalidate(w.me, answer.versionId);
  assert.ok(a.jobs.includes(run.id) && b.jobs.includes(run.id), 'the live test run is the answer');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key LIKE ?').get(`cs.tests_pass:${answer.versionId}:discover:%`).n, 1, 'no second discovery');
});

test('CS10: after these flows, no orphan (the existing invariant queries, O1-O22)', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const a = await collectWith(w, turn, css(w), { title: 'Clean', summary: '' }, factsFor(turn));
  completeTests(w, turn, a.versionId);
  completeMergeCheck(w, turn, a.versionId);
  const counts = orphans(w.db);
  for (const [k, n] of Object.entries(counts)) assert.equal(n, 0, `${k}: ${n}`);
});

test('CS11: a 60 MiB file fails with file_too_large', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  let caught = null;
  try { await collectWith(w, turn, css(w), { title: 'Huge', summary: '' }, { ok: false, code: 'file_too_large' }); }
  catch (e) { caught = e; }
  assert.ok(caught, 'register() surfaces the refusal');
  assert.equal(caught.detail?.reason, 'file_too_large');
  const collectJobId = findJob(w, turn.job.id, 'changeset.collect').id;
  assert.equal(jobRow(w, collectJobId).state, 'failed');
  assert.equal(JSON.parse(jobRow(w, collectJobId).error_json).code, 'file_too_large');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'change_set'").get().n, 0);
});

test('CS11b: a change that only touches package-lock.json passes sec.secret_scan and records no entropy notes', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'Lockfile bump', summary: '' }, factsFor(turn, { paths: ['package-lock.json'] }));
  assert.ok(answer.versionId, `expected a version, got ${JSON.stringify(answer)}`);
  assert.equal(latest(w, answer.versionId, 'sec.secret_scan').status, 'passed');
  const notes = latest(w, answer.versionId, 'sec.entropy_notes');
  assert.equal(notes.status, 'passed');
  assert.deepEqual(JSON.parse(notes.evidence_json), []);
});

test('a truncated secret scan fails the version (never passes what it could not read)', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'Padded', summary: '' }, factsFor(turn, { scanTruncated: true }));
  assert.equal(latest(w, answer.versionId, 'sec.secret_scan').status, 'failed');
  assert.match(latest(w, answer.versionId, 'sec.secret_scan').summary, /scan_truncated/);
  assert.equal(version(w, answer.versionId).status, 'failed');
});

test('CS12: a planted gitlink or symlink in the index fails with link_or_gitlink', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  let caught = null;
  try { await collectWith(w, turn, css(w), { title: 'Planted', summary: '' }, { ok: false, code: 'link_or_gitlink' }); }
  catch (e) { caught = e; }
  assert.equal(caught?.detail?.reason, 'link_or_gitlink');
});

test('CS13: register waits up to its configured timeout, then answers pending; a retry with the same clientKey answers the same job', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const service = css(w, 40);
  const t0 = Date.now();
  const answer = await service.register(turn.claims, { title: 'Slow', summary: '', clientKey: 'same-key' });
  assert.ok(Date.now() - t0 >= 35, 'it actually waited');
  assert.ok(answer.pending, 'it answers pending, never throwing, while the job is still queued');
  const job = findJob(w, turn.job.id, 'changeset.collect');
  assert.equal(answer.pending, job.id);
  assert.equal(w.nx.exec.get(w.me, job.id).id, job.id, 'the agent can poll job_status for it');
  const again = await service.register(turn.claims, { title: 'Slow', summary: '', clientKey: 'same-key' });
  assert.equal(again.pending, job.id, 'the same clientKey is the same job');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE recipe_id = 'changeset.collect'").get().n, 1);
});

test('CS14 (service level): v2\'s metadata base is whatever merge-base the runner reported; the real-git proof is in nexus-core-gitwrite', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const service = css(w);
  const v1 = await collectWith(w, turn, service, { title: 'v1', summary: '' }, factsFor(turn));
  const v2 = await collectWith(w, turn, service, { title: 'v2', summary: '' },
    factsFor(turn, { parent: HEAD1, head: 'd'.repeat(40), tree: 'e'.repeat(40), base: HEAD1, paths: ['src/b.ts'] }));
  assert.equal(JSON.parse(version(w, v1.versionId).metadata_json).base, COMMIT_BASE);
  assert.equal(JSON.parse(version(w, v2.versionId).metadata_json).base, HEAD1);
});

test('a token with no code.edit capability, or with an empty path list, cannot register (no_code_edit_scope); the scope is never widened', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const service = css(w);
  const noCap = { ...turn.claims, caps: turn.claims.caps.filter((c) => c.id !== 'code.edit') };
  const emptyPaths = { ...turn.claims, caps: turn.claims.caps.map((c) => (c.id === 'code.edit' ? { id: 'code.edit', scope: { paths: [] } } : c)) };
  const noScope = { ...turn.claims, caps: turn.claims.caps.map((c) => (c.id === 'code.edit' ? { id: 'code.edit' } : c)) };
  for (const claims of [noCap, emptyPaths, noScope]) {
    await assert.rejects(service.register(claims, { title: 't', summary: '', clientKey: nextKey() }), (e) => e.code === 'invalid' && e.detail?.reason === 'no_code_edit_scope');
  }
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE recipe_id = 'changeset.collect'").get().n, 0, 'no job was queued');
});

test('revise refuses a change set whose latest version is still a draft', async () => {
  const w = newWorld();
  const turn = openRunningTurn(w.db, w.nx);
  const service = css(w);
  const v1 = await collectWith(w, turn, service, { title: 'v1', summary: '' }, factsFor(turn));
  assert.equal(version(w, v1.versionId).status, 'draft');
  await assert.rejects(service.register(turn.claims, { title: 'v1', summary: '', reviseArtifactId: v1.artifactId, clientKey: nextKey() }),
    (e) => e.detail?.reason === 'not_revisable');
});
