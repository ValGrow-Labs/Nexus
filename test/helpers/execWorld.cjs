'use strict';
// A v9 database (the v6 fixture migrated with enableV9) with the execution core composed by the
// platform, a temp data home, two pinned test profiles, a candidate repository version and a
// candidate test suite version in p-ledger's sde participation, and helpers to drive jobs through a
// FakeRunner. No Docker, no runner process, no real userData. Authorization is never mocked: the
// world's principals are the seeded local owner and the system, plus restricted users the test adds.
const path = require('node:path');
const h = require('./sqlite.cjs');
const loadTs = require('../load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
// B2a Task 10 fix round 3: worlds are closed and their temp dirs removed by one after hook per test file.
const { track, cleanupAfterAll } = require('./cleanup.cjs');
cleanupAfterAll();
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { resolveDataHome } = loadTs('src/main/nexusExec/dataHome.ts');
const crypto = require('node:crypto');
const { FakeRunner } = require('./fakeRunner.cjs');
const { allOrphans } = require('./orphans.cjs');
const { getDomain } = loadTs('src/shared/nexus/domains/index.ts');
const { getUserAction } = loadTs('src/shared/nexus/actions.ts');
const { stepStateFrom } = loadTs('src/shared/nexus/stepState.ts');

const GIB = 2 ** 30;
const COMMIT = 'c0ffee'.padEnd(40, '0');
const IMAGE = { 'sde-node': 'sha256:' + '1'.repeat(64), 'sde-python': 'sha256:' + '2'.repeat(64), 'nexus-fwd': 'sha256:' + '3'.repeat(64), 'ml-python': 'sha256:' + '4'.repeat(64) };
const PROFILES = ['sde-node', 'sde-python'].map((id, i) => ({
  id, image: { repository: `nexus/${id}`, digest: `sha256:${String(i + 7).repeat(64)}` }, user: { uid: 10001, gid: 10001 },
  defaults: { cpus: 1, memoryMb: 1024, pids: 512, wallClockMs: 60000, outputMaxBytes: 2 ** 20, tmpfsMb: 512 },
  entrypoint: ['/opt/nexus/entry'], imageEnv: ['PATH', 'HOME', 'LANG']
}));
/** B2a Task 9: the loopback forwarder of dev deployments (with `fwd: true`). */
const FWD_PROFILE = {
  id: 'nexus-fwd', image: { repository: 'nexus/nexus-fwd', digest: `sha256:${'9'.repeat(64)}` }, user: { uid: 10001, gid: 10001 },
  defaults: { cpus: 1, memoryMb: 128, pids: 512, wallClockMs: 60000, outputMaxBytes: 2 ** 20, tmpfsMb: 16 },
  entrypoint: ['/opt/nexus/fwd-entry'], imageEnv: ['PATH', 'HOME']
};
/** The machine learning kit (with `ml: true`): the Python kit's tools plus the ML packages, with its two matplotlib environment names. */
const ML_PROFILE = {
  id: 'ml-python', image: { repository: 'nexus/ml-python', digest: `sha256:${'8'.repeat(64)}` }, user: { uid: 10001, gid: 10001 },
  defaults: { cpus: 1, memoryMb: 1024, pids: 512, wallClockMs: 60000, outputMaxBytes: 2 ** 20, tmpfsMb: 512 },
  entrypoint: ['/opt/nexus/entry'], imageEnv: ['PATH', 'HOME', 'LANG', 'MPLBACKEND', 'MPLCONFIGDIR']
};
const DEFAULT_INPUTS = { 'sde.build.run': 'repository', 'sde.tests.discover': 'repository', 'sde.deps.install': 'repository', 'sde.tests.run': 'suite' };

/** A preflight report that passes, with every observed field present. */
function passingPreflight() {
  return { ok: true, problems: [], observed: { nanoCpus: 2e9, memory: 2048 * 2 ** 20, memorySwap: 2048 * 2 ** 20, pidsLimit: 512,
    networkMode: 'none', readonlyRootfs: true, capDrop: ['ALL'], capAdd: [], privileged: false, user: '10001:10001',
    securityOpt: ['no-new-privileges'], mounts: [], portBindings: [], tmpfs: ['/tmp', '/home/nexus'], devices: [] } };
}

function execWorld(o = {}) {
  const { file } = h.v6Fixture();
  const s = track(new PersistStore(file));
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, enableV9: true });
  const db = s.platformDatabase();
  const clock = { t: h.NOW + 1000 };
  const logs = [];
  const fsRootCalls = [];
  const acceptFsRoot = o.acceptFsRoot ?? ((root) => { fsRootCalls.push(root); return typeof root === 'string' && root.length > 0 ? root : null; });
  const dataHome = resolveDataHome(h.tmpDir('nx-home-'));
  // B2a Task 9: `approvals: 'real'` uses the platform's own ApprovalService as the egress port (and its expiry sweep).
  const approvals = o.approvals === 'real' ? undefined : o.approvals === false || o.approvals === undefined ? null : {
    requestEgressTx(job, attempt, recipe, now) {
      const id = newId(now);
      db.prepare(`INSERT INTO approvals (id, project_id, job_id, reason, summary, request_json, request_sha256, status, requested_by,
          on_behalf_of, requested_at, expires_at, status_changed_at) VALUES (?, ?, ?, 'egress.deps', ?, ?, ?, 'pending', 'system', ?, ?, ?, ?)`)
        .run(id, job.projectId, job.id, 'Download dependencies', JSON.stringify({ recipeId: recipe.id, jobId: job.id }), 'e'.repeat(64),
          job.onBehalfOf, now, now + 15 * 60_000, now);
      return id;
    }
  };
  const nx = createNexusPlatform(db, { now: () => clock.t, log: (l) => logs.push(l), execution: o.execution ?? true,
    dataHome, profiles: [...PROFILES, ...(o.fwd ? [FWD_PROFILE] : []), ...(o.ml ? [ML_PROFILE] : [])], acceptFsRoot, approvals, ingest: o.realIngest ? undefined : (o.ingest ?? null),
    resolveCommit: o.resolveCommit ?? null, ingestFaults: o.ingestFaults ?? null, executionUnavailableReason: o.unavailableReason, appVersion: o.appVersion ?? null,
    imageContexts: o.imageContexts ?? null, isRepository: o.isRepository ?? null, findGit: o.findGit ?? null });
  const me = nx.principals.localUser(); const sys = nx.principals.system();
  const bootId = newId(clock.t);
  const probe = {
    docker: o.docker ?? 'running', memoryBytes: o.dockerMemoryBytes ?? 8 * GIB, cpus: 4, freeBytes: o.freeBytes ?? 100 * GIB,
    images: o.images ?? [{ profile: 'sde-node', present: true, digestMatches: true, imageId: IMAGE['sde-node'] },
      { profile: 'sde-python', present: true, digestMatches: true, imageId: IMAGE['sde-python'] },
      ...(o.fwd ? [{ profile: 'nexus-fwd', present: true, digestMatches: true, imageId: IMAGE['nexus-fwd'] }] : [])]
  };
  const probeMsg = () => ({ op: 'probe.result', probe: { docker: probe.docker, version: '27.0.0', cpus: probe.cpus, memoryBytes: probe.memoryBytes,
    gpu: { detected: false, usableInContainers: false } }, images: probe.images.map((x) => ({ ...x })), freeBytes: probe.freeBytes, runtimes: [] });
  let runner = null;
  const real = nx.exec;
  const attach = real.attachRunner.bind(real);
  real.attachRunner = (port, boot) => { attach(port, boot); runner = port; if (port) port.report(probeMsg()); };

  const pw = nx.workspaces.primaryOf(me, 'p-ledger');
  // A repository artifact is project data the snapshot ingest (Task 8/9) writes; the fixture inserts the artifact row
  // directly (the public create refuses `repository`) and registers its version through the service.
  const repoArtifact = newId(clock.t);
  db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, description, owner_scope, owner_participation_id, owner_workspace_id,
      created_by, status, current_version_id, metadata_json, created_at, updated_at)
    VALUES (?, 'p-ledger', 'repository', 'ledger-api', NULL, 'participation', ?, ?, 'user:local', 'active', NULL, '{}', ?, ?)`)
    .run(repoArtifact, pw.id, pw.workspaceId, clock.t, clock.t);
  const repoMeta = { profile: o.profile ?? 'sde-node', ...(o.repoMeta ?? {}) };
  const repoV = nx.artifacts.registerVersion(me, { artifactId: repoArtifact, storage: { kind: 'git', commit: COMMIT }, metadata: repoMeta }).version.id;
  nx.artifacts.finalize(sys, repoV, 'candidate');
  const suiteA = nx.artifacts.create(me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'test_suite', name: 'suite' });
  const suiteV = nx.artifacts.registerVersion(me, { artifactId: suiteA.id, storage: { kind: 'git', commit: COMMIT },
    metadata: { profile: o.profile ?? 'sde-node', framework: 'node-test', files: ['test/a.test.js'] } }).version.id;
  nx.artifacts.finalize(sys, suiteV, 'candidate');

  let k = 0;
  const liveStmt = db.prepare("SELECT * FROM job_attempts WHERE job_id = ? AND state IN ('starting','running')");
  const w = {
    s, db, nx, exec: real, clock, logs, fsRootCalls, dataHome, me, sys, bootId, projectId: 'p-ledger', pw, repoV, suiteV, probe, COMMIT, IMAGE,
    now: () => clock.t,
    probeMsg,
    advance(ms) { clock.t += ms; return clock.t; },
    req(actionId, extra = {}) {
      const slot = DEFAULT_INPUTS[actionId];
      const inputs = slot === undefined ? [] : [{ versionId: slot === 'suite' ? suiteV : repoV, slot }];
      return { projectId: 'p-ledger', workspaceId: 'sde', actionId, inputs, params: {}, intentId: `intent-${++k}-${Math.random()}`, ...extra };
    },
    /** Push a changed probe through the attached runner (as the runner's next probe.result). */
    setProbe(patch) { Object.assign(probe, patch); if (runner) runner.report(probeMsg()); },
    job: (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id),
    jobState: (id) => db.prepare('SELECT state FROM jobs WHERE id = ?').get(id).state,
    attempt: (id) => db.prepare('SELECT * FROM job_attempts WHERE id = ?').get(id),
    attempts: (jobId) => db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n').all(jobId),
    liveAttempt: (jobId) => liveStmt.get(jobId),
    liveCount: () => db.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE state IN ('starting','running')").get().n,
    events: (jobId, type) => db.prepare(`SELECT * FROM job_events WHERE job_id = ?${type ? ' AND type = ?' : ''} ORDER BY seq`).all(...(type ? [jobId, type] : [jobId])),
    activity: (jobId, action) => db.prepare(`SELECT * FROM activity WHERE job_id = ?${action ? ' AND action = ?' : ''} ORDER BY seq`).all(...(action ? [jobId, action] : [jobId])),
    /** Report a passing provisioned for the job's live attempt. */
    provision(r, jobId, extra = {}) {
      const a = w.liveAttempt(jobId);
      r.report({ op: 'attempt.provisioned', attemptId: a.id, containerId: (extra.c ?? 'c').repeat(64), imageDigest: extra.imageDigest ?? IMAGE['sde-node'],
        preflight: passingPreflight() });
      return a;
    },
    /** Let `ms` pass at the scheduler's cadence (a tick every 5 s); a runner, when given, heartbeats every 30 s. */
    run(r, ms, step = 5_000) {
      for (let t = step; t <= ms; t += step) {
        clock.t += step;
        if (r && t % 30_000 === 0) w.heartbeatAll(r);
        real.tick(clock.t);
      }
    },
    /** A heartbeat for every live attempt (as a live runner sends them). */
    heartbeatAll(r) {
      for (const a of db.prepare("SELECT id FROM job_attempts WHERE state IN ('starting','running')").all()) {
        r.report({ op: 'attempt.heartbeat', attemptId: a.id, at: clock.t, logBytes: 0, outBytes: 0, container: 'running' });
      }
    },
    /** Report an exit for the job's live attempt (outputs by relPath). */
    exit(r, jobId, x = {}) {
      const a = w.liveAttempt(jobId) ?? x.attempt;
      r.report({ op: 'attempt.exited', attemptId: a.id, exit: { code: x.code ?? 0, oomKilled: x.oom ?? false, finishedAt: clock.t },
        outputs: (x.outputs ?? []).map((p) => ({ relPath: p, sha256: 'f'.repeat(64), bytes: 10, mediaType: 'application/octet-stream' })),
        parsed: x.parsed ?? [], logBytes: 100, ...(x.outputError ? { outputError: x.outputError } : {}) });
      return a;
    },
    /** A user with one role at one scope (no mocking of authorization). */
    addUser(id, scopeType, scopeId, role) {
      db.prepare('INSERT INTO principals VALUES (?,?,?,NULL,?)').run(id, 'user', id, h.NOW);
      db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?)').run(id, scopeType, scopeId, role, h.NOW);
      return { id, kind: 'user', displayName: id };
    },
    // ---------- B2a Task 8: ingest and validation helpers (with `realIngest: true` the platform's own ingest runs) ----------
    /** The world's FakeRunner, attached once. */
    attach() {
      if (!w._runner) { w._runner = new FakeRunner(); real.attachRunner(w._runner, bootId); }
      return w._runner;
    },
    /** A staged output: its sha256 is the hash of `content` (as the runner hashes the bytes it wrote). */
    file(relPath, content = relPath, mediaType = 'application/octet-stream') {
      const buf = Buffer.from(String(content));
      return { relPath, sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length, mediaType };
    },
    /** B2a Task 13 fix round 1: a staged output whose bytes are ALSO in the data home's object store, as the runner leaves them. */
    stored(relPath, content = relPath, mediaType = 'application/octet-stream') {
      const f = w.file(relPath, content, mediaType);
      const abs = path.join(dataHome.root, dataHome.objectRel(f.sha256));
      require('node:fs').mkdirSync(path.dirname(abs), { recursive: true });
      require('node:fs').writeFileSync(abs, Buffer.from(String(content)));
      return f;
    },
    /** Report an exit with full outputs (StagedOutput objects) and parser results. */
    exitWith(r, jobId, x = {}) {
      const a = w.liveAttempt(jobId) ?? x.attempt;
      r.report({ op: 'attempt.exited', attemptId: a.id, exit: { code: x.code ?? 0, oomKilled: x.oom ?? false, finishedAt: clock.t },
        outputs: x.outputs ?? [], parsed: x.parsed ?? [], logBytes: 100, ...(x.outputError ? { outputError: x.outputError } : {}) });
      return a;
    },
    /** An engine attempt is handed to the runner (no container). */
    provisionEngine(r, jobId) {
      const a = w.liveAttempt(jobId);
      r.report({ op: 'attempt.provisioned', attemptId: a.id });
      return a;
    },
    /** Waits for every asynchronous ingest and check, then runs what became ready. */
    async settle() {
      for (let i = 0; i < 20; i++) {
        await real.settled();
        if (nx.validation) await nx.validation.settled();
        await new Promise((res) => setImmediate(res));
        if (nx.validation) nx.validation.runPending(clock.t);
      }
    },
    version: (id) => db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(id),
    /** The latest result of one validator on a version (or undefined). */
    latest(versionId, validatorId) {
      return db.prepare(`SELECT * FROM validations v WHERE v.version_id = ? AND v.validator_id = ? ORDER BY v.finished_at DESC, v.rowid DESC LIMIT 1`)
        .get(versionId, validatorId);
    },
    validations: (versionId) => db.prepare('SELECT * FROM validations WHERE version_id = ? ORDER BY rowid').all(versionId),
    validateJobs: (versionId, validatorId) => db.prepare(`SELECT * FROM jobs WHERE kind = 'validate' AND json_extract(params_json, '$.versionId') = ?
      ${validatorId ? 'AND validator_id = ?' : ''} ORDER BY rowid`).all(...(validatorId ? [versionId, validatorId] : [versionId])),
    orphans: () => allOrphans(db),
    /** A step's state, computed from the records exactly as the rail does (src/shared/nexus/stepState.ts). */
    stepState(domainId, stepId) {
      const step = getDomain(domainId).lifecycle.find((s) => s.id === stepId);
      const kind = 'kind' in step.doneWhen ? step.doneWhen.kind : null;
      const versions = kind === null ? [] : db.prepare(`SELECT v.id, v.status FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
        WHERE a.project_id = ? AND a.kind = ?`).all('p-ledger', kind).map((v) => {
        // The latest BLOCKING row per validator (what the finalize rule reads; advisory rows never gate a step).
        const rows = db.prepare(`SELECT validator_id, status FROM validations x WHERE x.version_id = ? AND x.blocking = 1 AND NOT EXISTS (SELECT 1 FROM validations y
          WHERE y.version_id = x.version_id AND y.validator_id = x.validator_id AND y.blocking = 1
            AND (y.finished_at > x.finished_at OR (y.finished_at = x.finished_at AND y.rowid > x.rowid)))`).all(v.id);
        return { status: v.status, validators: Object.fromEntries(rows.map((r) => [r.validator_id, r.status])) };
      });
      const recipes = step.via.flatMap((v) => ('userAction' in v ? (getUserAction(v.userAction)?.run.recipes ?? []) : 'recipe' in v ? [v.recipe] : []));
      const live = "('queued','leased','running','awaiting_approval','retry_scheduled')";
      const liveJobs = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE project_id = 'p-ledger' AND state IN ${live}
        AND (recipe_id IN (${recipes.map(() => '?').join(',') || "''"}) OR (kind = 'validate' AND json_extract(params_json, '$.versionId') IN
          (SELECT v.id FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.kind = ?)))`).get(...recipes, kind ?? '').n;
      const inputsAvailable = step.consumes.every((k) => db.prepare(`SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
        WHERE a.project_id = 'p-ledger' AND a.kind = ? AND v.status IN ('candidate','active')`).get(k));
      return stepStateFrom(step, { versions, liveJobs, inputsAvailable });
    },
    /**
     * Discovery then the sde.tests_pass check, through the fake runner: `discovery` lists the files, `junit` is a
     * junit() result (null: no junit.xml at all), `exit` the test container's exit code.
     */
    async runTests(o = {}) {
      const r = w.attach();
      const files = o.discovery ?? ['test/a.test.js'];
      const d = real.start(w.me, w.req('sde.tests.discover')).job;
      real.tick(clock.t); w.provision(r, d.id, { c: 'a' });
      const ids = w.file('ids.txt', files.join('\n'));
      const normalized = o.discoveryNormalized ?? { framework: o.framework ?? 'node-test', ids: o.ids ?? files, files };
      w.exitWith(r, d.id, { code: 0, outputs: [ids], parsed: [{ parser: 'discovery', sourceSha256: o.listSha ?? ids.sha256, normalized }] });
      await w.settle();
      const suite = db.prepare("SELECT id FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = 'ids.txt'").get(d.id);
      const out = { discoveryJobId: d.id, parentJobId: d.id, suiteVersionId: suite?.id ?? null, testJobId: null };
      const tj = suite ? db.prepare("SELECT * FROM jobs WHERE kind = 'validate' AND validator_id = 'sde.tests_pass' AND parent_job_id = ? ORDER BY rowid DESC").get(d.id) : null;
      if (!tj || o.skipTests) return out;
      out.testJobId = tj.id;
      real.tick(clock.t); w.provision(r, tj.id, { c: 'b' });
      const outputs = [];
      const parsed = [];
      if (o.junit !== null && o.junit !== undefined) {
        const jf = w.file('junit.xml', JSON.stringify(o.junit));
        outputs.push(jf);
        parsed.push({ parser: 'junit', sourceSha256: jf.sha256, normalized: { sha256: jf.sha256, ...o.junit } });
      }
      w.exitWith(r, tj.id, { code: o.exit ?? 0, outputs, parsed });
      await w.settle();
      return out;
    },
    /** A build through the fake runner: `files` under dist/ ({ path, content }), `extraFiles` beside it. */
    async runBuild(o = {}) {
      const r = w.attach();
      const b = real.start(w.me, w.req('sde.build.run')).job;
      real.tick(clock.t); w.provision(r, b.id, { c: 'd' });
      const outputs = [...(o.files ?? []).map((f) => w.file(`dist/${f.path ?? f}`, f.content ?? `content of ${f.path ?? f}`)),
        ...(o.extraFiles ?? []).map((p) => w.file(p, `extra ${p}`))];
      w.exitWith(r, b.id, { code: o.exit ?? 0, outputs });
      await w.settle();
      const v = db.prepare("SELECT id FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = 'dist'").get(b.id);
      return { buildJobId: b.id, buildVersionId: v?.id ?? null, outputs };
    },
    /** Answer every blob.verify the runner was sent and has not answered (ok, or a function of the sha). */
    answerVerifies(r, ok = true) {
      const sent = r.sentOf('blob.verify');
      w._answered = w._answered ?? 0;
      const fresh = sent.slice(w._answered);
      w._answered = sent.length;
      for (const m of fresh) r.report({ op: 'blob.verified', sha256: m.sha256, ok: typeof ok === 'function' ? ok(m.sha256) : ok });
      return fresh.length;
    },
    /** A repository snapshot through the fake runner (engine): the runner reports `facts`. */
    async snapshot(facts) {
      const r = w.attach();
      const j = real.start(w.me, w.req('sde.repository.snapshot')).job;
      real.tick(clock.t); w.provisionEngine(r, j.id);
      w.exitWith(r, j.id, { code: 0, outputs: [], parsed: [{ parser: 'repo-snapshot', sourceSha256: 'e'.repeat(64), normalized: facts }] });
      await w.settle();
      return j.id;
    },
    close() { s.close(); }
  };
  return w;
}

/**
 * A normalized JUnit result (without its sha256, which the world adds from the staged file): `cases` are
 * { name, file?, classname?, outcome? ('passed' default) }; `o.declaredTotal` is the report's `tests` attribute.
 */
function junit(cases, o = {}) {
  const rows = cases.map((c, i) => {
    const file = c.file === undefined ? 'test/a.test.js' : c.file;
    const classname = c.classname ?? (file ?? 'suite');
    const name = c.name ?? `case ${i + 1}`;
    return { id: `${file ?? ''}::${classname}::${name}`, ...(file ? { file } : {}), classname, name, outcome: c.outcome ?? 'passed', ms: 1 };
  });
  const by = (x) => rows.filter((r) => r.outcome === x).length;
  return { total: o.total ?? rows.length, passed: o.passed ?? by('passed'), failed: o.failed ?? by('failed'), errored: o.errored ?? by('errored'),
    skipped: o.skipped ?? by('skipped'), cases: rows, declaredTotal: o.declaredTotal === undefined ? rows.length : o.declaredTotal,
    countsMismatch: o.countsMismatch ?? false };
}

module.exports = { execWorld, passingPreflight, PROFILES, FWD_PROFILE, ML_PROFILE, GIB, junit };
