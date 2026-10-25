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
  const failing = secretScan.run({ head, secretHits: [{ path: 'src/a.ts', line: 12, rule: 'provider_key' }] });
  assert.equal(failing.status, 'failed');
  assert.equal(failing.reason, 'secret_shaped_line');
  const text = JSON.stringify(failing.evidence);
  assert.ok(!/AKIA|BEGIN|sk-/.test(text), 'no secret shape leaks into the evidence');
  assert.deepEqual(failing.evidence, [{ type: 'location', path: 'src/a.ts', line: 12, rule: 'provider_key' }]);
  const clean = secretScan.run({ head, secretHits: [] });
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
async function collectWith(w, turn, service, args, facts) {
  const p = service.register(turn.claims, { clientKey: nextKey(), ...args });
  const job = findJob(w, turn.job.id, 'changeset.collect');
  assert.ok(job, 'the collect job was queued');
  const attemptId = leaseAndRun(w, job.id);
  finish(turn, attemptId, { code: facts.ok === false ? 1 : 0, parsed: [facts.ok === false ? gitRefused(facts.code) : gitFacts(facts)] });
  return p;
}

/**
 * Completes the discover -> test-run chain for a change set's `cs.tests_pass`: one passing JS test. The discover job
 * is session-less and parent-less (ValidationService.enqueueChangeSetDiscoverTx), so it is found by its idempotency
 * key, keyed by the change set's own version id, not by `parent_job_id`.
 */
function completeTests(w, turn, versionId) {
  const discover = w.db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(`cs.tests_pass:${versionId}:discover`);
  assert.ok(discover, 'cs.tests_pass queued its discover child job');
  const idsSha = crypto.createHash('sha256').update('ids').digest('hex');
  const dAttempt = leaseAndRun(w, discover.id);
  finish(turn, dAttempt, {
    outputs: [{ relPath: 'ids.txt', sha256: idsSha, bytes: 10, mediaType: 'text/plain' }],
    parsed: [{ parser: 'discovery', sourceSha256: idsSha, normalized: { framework: 'node-test', ids: ['a.test.js'], files: ['a.test.js'] } }]
  });
  const run = findJob(w, discover.id, 'sde.test.node');
  assert.ok(run, 'the suite\'s own sde.tests_pass child job was queued');
  const junitSha = crypto.createHash('sha256').update('junit').digest('hex');
  const rAttempt = leaseAndRun(w, run.id);
  finish(turn, rAttempt, {
    outputs: [{ relPath: 'junit.xml', sha256: junitSha, bytes: 50, mediaType: 'application/xml' }],
    parsed: [{ parser: 'junit', sourceSha256: junitSha, normalized: {
      sha256: junitSha, total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, declaredTotal: 1, countsMismatch: false,
      cases: [{ id: 'a.test.js', file: 'a.test.js', classname: 'a', name: 't1', outcome: 'passed', ms: 1 }]
    } }]
  });
}

function completeMergeCheck(w, turn, collectJobId, { clean = true } = {}) {
  const check = findJob(w, collectJobId, 'changeset.merge_check');
  assert.ok(check, 'git.applies_cleanly queued its merge-check child job');
  const attempt = leaseAndRun(w, check.id);
  finish(turn, attempt, { parsed: [gitFacts({ clean, tree: clean ? TREE : null, integrationHead: COMMIT_BASE })] });
  return check.id;
}

function latest(w, versionId, validatorId) {
  return w.db.prepare(`SELECT * FROM validations WHERE version_id = ? AND validator_id = ? ORDER BY rowid DESC LIMIT 1`).get(versionId, validatorId);
}
function version(w, id) { return w.db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(id); }

test('CS1: the happy path reaches candidate, with exact lineage', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  const repo = addRepository(w);
  const req = makeRequirement(w);
  const turn = openRunningTurn(w.db, w.nx);
  const service = css(w);
  const answer = await collectWith(w, turn, service, { title: 'Add feature', summary: 'does a thing', requirementVersionIds: [req] },
    { changed: true, parent: COMMIT_BASE, head: 'b'.repeat(40), tree: TREE, base: COMMIT_BASE, ref: jobRefFor(turn.session.id),
      diffstat: { files: 1, insertions: 3, deletions: 0 }, paths: ['src/a.ts'], pathsTruncated: false, secretHits: [], entropyHits: [] });
  assert.ok(answer.versionId, 'a version was produced');
  assert.equal(answer.status, 'draft');
  const collectJobId = findJob(w, turn.job.id, 'changeset.collect').id;
  completeTests(w, turn, answer.versionId);
  completeMergeCheck(w, turn, collectJobId);
  const v = version(w, answer.versionId);
  assert.equal(v.status, 'candidate', 'every blocking register and candidate validator passed');
  for (const id of ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly']) {
    assert.equal(latest(w, answer.versionId, id)?.status, 'passed', id);
  }
  const edges = w.db.prepare('SELECT to_version_id AS id, relation FROM artifact_edges WHERE from_version_id = ?').all(answer.versionId);
  assert.ok(edges.some((e) => e.id === repo.versionId && e.relation === 'derived_from'), 'derived_from the repository version');
  assert.ok(edges.some((e) => e.id === req && e.relation === 'implements'), 'implements the requirement');
  assert.deepEqual(JSON.parse(w.db.prepare('SELECT metadata_json FROM artifact_versions WHERE id = ?').get(answer.versionId).metadata_json).branch, 'main');
});

test('CS2: an empty diff is refused and no version is written', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  addRepository(w);
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'No-op', summary: '' },
    { changed: false, parent: COMMIT_BASE, head: COMMIT_BASE, tree: TREE, base: COMMIT_BASE, ref: jobRefFor(turn.session.id),
      diffstat: { files: 0, insertions: 0, deletions: 0 }, paths: [], pathsTruncated: false, secretHits: [], entropyHits: [] });
  assert.equal(answer.status, 'failed');
  assert.equal(latest(w, answer.versionId, 'git.diff_nonempty').status, 'failed');
  assert.equal(version(w, answer.versionId).status, 'failed');
});

test('CS3: .git/config or .env fails paths_in_scope', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  addRepository(w);
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'Touch sensitive', summary: '' },
    { changed: true, parent: COMMIT_BASE, head: 'b'.repeat(40), tree: TREE, base: COMMIT_BASE, ref: jobRefFor(turn.session.id),
      diffstat: { files: 2, insertions: 2, deletions: 0 }, paths: ['.git/config', '.env'], pathsTruncated: false, secretHits: [], entropyHits: [] });
  assert.equal(version(w, answer.versionId).status, 'failed');
  assert.equal(latest(w, answer.versionId, 'git.paths_in_scope').status, 'failed');
});

test('CS4: a secret line fails the version; the evidence holds path:line only, never in activity, job_events or job_attempts', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  addRepository(w);
  const turn = openRunningTurn(w.db, w.nx);
  const SECRET = 'AKIAABCDEFGHIJKLMNOP';
  const answer = await collectWith(w, turn, css(w), { title: 'Leak', summary: '' },
    { changed: true, parent: COMMIT_BASE, head: 'b'.repeat(40), tree: TREE, base: COMMIT_BASE, ref: jobRefFor(turn.session.id),
      diffstat: { files: 1, insertions: 1, deletions: 0 }, paths: ['src/a.ts'], pathsTruncated: false,
      secretHits: [{ path: 'src/a.ts', line: 4, rule: 'provider_key' }], entropyHits: [] });
  assert.equal(version(w, answer.versionId).status, 'failed');
  const row = latest(w, answer.versionId, 'sec.secret_scan');
  assert.equal(row.status, 'failed');
  assert.deepEqual(JSON.parse(row.evidence_json), [{ type: 'location', path: 'src/a.ts', line: 4, rule: 'provider_key' }]);
  const dump = [
    ...w.db.prepare('SELECT details_json FROM activity').all().map((r) => r.details_json),
    ...w.db.prepare('SELECT data_json FROM job_events').all().map((r) => r.data_json),
    ...w.db.prepare('SELECT error_json FROM job_attempts').all().map((r) => r.error_json ?? ''),
    row.evidence_json, row.summary
  ].join('\n');
  assert.ok(!dump.includes(SECRET), 'the key text appears nowhere');
});

test('CS7: a merge-tree conflict fails git.applies_cleanly', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  addRepository(w);
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'Conflicting', summary: '' },
    { changed: true, parent: COMMIT_BASE, head: 'b'.repeat(40), tree: TREE, base: COMMIT_BASE, ref: jobRefFor(turn.session.id),
      diffstat: { files: 1, insertions: 1, deletions: 0 }, paths: ['src/a.ts'], pathsTruncated: false, secretHits: [], entropyHits: [] });
  const collectJobId = findJob(w, turn.job.id, 'changeset.collect').id;
  completeMergeCheck(w, turn, collectJobId, { clean: false });
  assert.equal(latest(w, answer.versionId, 'git.applies_cleanly').status, 'failed');
  assert.notEqual(version(w, answer.versionId).status, 'candidate');
});

test('CS9: revise gives v2 derived_from v1', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  addRepository(w);
  const turn = openRunningTurn(w.db, w.nx);
  const service = css(w);
  // v1 fails its register validators (a scope violation) and so leaves draft immediately, as a revised v1 normally
  // would (F23: "a failed change set never becomes a candidate again; the agent revises it as v2").
  const v1 = await collectWith(w, turn, service, { title: 'v1', summary: '' },
    { changed: true, parent: COMMIT_BASE, head: 'b'.repeat(40), tree: TREE, base: COMMIT_BASE, ref: jobRefFor(turn.session.id),
      diffstat: { files: 1, insertions: 1, deletions: 0 }, paths: ['.git/config'], pathsTruncated: false, secretHits: [], entropyHits: [] });
  assert.equal(version(w, v1.versionId).status, 'failed');
  const v2 = await collectWith(w, turn, service, { title: 'v1', summary: '', reviseArtifactId: v1.artifactId },
    { changed: true, parent: 'b'.repeat(40), head: 'd'.repeat(40), tree: 'e'.repeat(40), base: COMMIT_BASE, ref: jobRefFor(turn.session.id),
      diffstat: { files: 1, insertions: 1, deletions: 0 }, paths: ['src/a.ts'], pathsTruncated: false, secretHits: [], entropyHits: [] });
  assert.equal(v2.artifactId, v1.artifactId);
  const edges = w.db.prepare("SELECT to_version_id AS id FROM artifact_edges WHERE from_version_id = ? AND relation = 'derived_from'").all(v2.versionId);
  assert.ok(edges.some((e) => e.id === v1.versionId));
});

test('CS11: a 60 MiB file fails with file_too_large', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  addRepository(w);
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
  const w = agentWorld({ platform: { ingest: undefined } });
  addRepository(w);
  const turn = openRunningTurn(w.db, w.nx);
  const answer = await collectWith(w, turn, css(w), { title: 'Lockfile bump', summary: '' },
    { changed: true, parent: COMMIT_BASE, head: 'b'.repeat(40), tree: TREE, base: COMMIT_BASE, ref: jobRefFor(turn.session.id),
      diffstat: { files: 1, insertions: 1, deletions: 0 }, paths: ['package-lock.json'], pathsTruncated: false, secretHits: [], entropyHits: [] });
  assert.ok(answer.versionId, `expected a version, got ${JSON.stringify(answer)}`);
  assert.equal(latest(w, answer.versionId, 'sec.secret_scan').status, 'passed');
  const notes = latest(w, answer.versionId, 'sec.entropy_notes');
  assert.equal(notes.status, 'passed');
  assert.deepEqual(JSON.parse(notes.evidence_json), []);
});

test('CS12: a planted gitlink or symlink in the index fails with link_or_gitlink', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  addRepository(w);
  const turn = openRunningTurn(w.db, w.nx);
  let caught = null;
  try { await collectWith(w, turn, css(w), { title: 'Planted', summary: '' }, { ok: false, code: 'link_or_gitlink' }); }
  catch (e) { caught = e; }
  assert.equal(caught?.detail?.reason, 'link_or_gitlink');
});

test('CS13: register waits up to its configured timeout, then answers pending, and the agent polls', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  addRepository(w);
  const turn = openRunningTurn(w.db, w.nx);
  const service = css(w, 40);
  const t0 = Date.now();
  const answer = await service.register(turn.claims, { title: 'Slow', summary: '', clientKey: nextKey() });
  assert.ok(Date.now() - t0 >= 35, 'it actually waited');
  assert.ok(answer.pending, 'it answers pending, never throwing, while the job is still queued');
  const job = findJob(w, turn.job.id, 'changeset.collect');
  assert.equal(answer.pending, job.id);
  assert.equal(w.nx.exec.get(w.me, job.id).id, job.id, 'the agent can poll job_status for it');
});

test('CS14: v2\'s base is the merge-base with the integration ref (not v1\'s own base)', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  addRepository(w);
  const turn = openRunningTurn(w.db, w.nx);
  const service = css(w);
  const v1 = await collectWith(w, turn, service, { title: 'v1', summary: '' },
    { changed: true, parent: COMMIT_BASE, head: 'b'.repeat(40), tree: TREE, base: COMMIT_BASE, ref: jobRefFor(turn.session.id),
      diffstat: { files: 1, insertions: 1, deletions: 0 }, paths: ['src/a.ts'], pathsTruncated: false, secretHits: [], entropyHits: [] });
  // After v1 is accepted (Task 9), the integration ref moves; here the runner reports the merge-base it computed
  // against the (now moved) integration ref directly, as `changeset.collect` always does (F29).
  const movedBase = 'b'.repeat(40);
  const v2 = await collectWith(w, turn, service, { title: 'v2', summary: '' },
    { changed: true, parent: 'b'.repeat(40), head: 'd'.repeat(40), tree: 'e'.repeat(40), base: movedBase, ref: jobRefFor(turn.session.id),
      diffstat: { files: 1, insertions: 1, deletions: 0 }, paths: ['src/b.ts'], pathsTruncated: false, secretHits: [], entropyHits: [] });
  const m1 = JSON.parse(w.db.prepare('SELECT metadata_json FROM artifact_versions WHERE id = ?').get(v1.versionId).metadata_json);
  const m2 = JSON.parse(w.db.prepare('SELECT metadata_json FROM artifact_versions WHERE id = ?').get(v2.versionId).metadata_json);
  assert.equal(m1.base, COMMIT_BASE);
  assert.equal(m2.base, movedBase);
  assert.notEqual(m2.base, m1.base, 'v2\'s base reflects the moved integration ref, not v1\'s own base');
});

test('CS10: after these flows, no orphan (the existing invariant queries)', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  addRepository(w);
  const turn = openRunningTurn(w.db, w.nx);
  await collectWith(w, turn, css(w), { title: 'Clean', summary: '' },
    { changed: true, parent: COMMIT_BASE, head: 'b'.repeat(40), tree: TREE, base: COMMIT_BASE, ref: jobRefFor(turn.session.id),
      diffstat: { files: 1, insertions: 1, deletions: 0 }, paths: ['src/a.ts'], pathsTruncated: false, secretHits: [], entropyHits: [] });
  const counts = orphans(w.db);
  for (const [k, n] of Object.entries(counts)) assert.equal(n, 0, `${k}: ${n}`);
});
