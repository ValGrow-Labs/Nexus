'use strict';
// The fake recipe world (B2a Task 12): everything real except Docker.
// - main: a v9 database (the v6 fixture migrated with enableV9), the platform composed as the app composes it (real
//   ingest, validation, approvals, deployments and RepoService; main's own git for the repository check and
//   git.head_resolves), the profiles and image contexts loaded from infra/images/lock.json (A3);
// - the runner: a real RunnerCore (real git archive staging, real object store hashing, real parsers, the per-file JUnit
//   merge, the diagnose engine, real log files) over an in-process bridge that clones every message as a MessagePort does;
// - Docker: the fake sandbox driver (test/helpers/fakeSandboxDriver.cjs: preflight runs the real comparator over a Docker
//   29-shaped inspect), whose containers play RECORDED outputs: node 20.20.2's own JUnit reports of the fixtures
//   (test/fixtures/exec/recorded, the node the lock pins; host paths rewritten to /workspace), pytest's collect-only and
//   xunit2 report of pytest-app written in pytest's format (no host Python is ever run), and the build outputs the
//   fixtures' build scripts write. Dev deployment health answers come from the fixture's routes.
// Time is a fake clock: main's `now` and the runner's timers; `until` advances it a second at a time and runs the
// scheduler's tick, while real I/O (git, files) is awaited between steps: the runner's host git and file system calls
// are counted (`trackRealIo`), and the clock never advances while one is still in flight (B2a stabilization: on a loaded
// machine a snapshot's real git calls outlasted 60 fake seconds, so its 60 s wall clock ran out under them).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const h = require('./sqlite.cjs');
const loadTs = require('../load-ts.cjs');
const { track, cleanupAfterAll } = require('./cleanup.cjs');
const { FakeSandboxDriver } = require('./fakeSandboxDriver.cjs');

// Worlds shut their runner down (no attempt log left open: Windows cannot remove a folder holding an open file) BEFORE
// cleanup.cjs's hook closes the stores and removes the temp folders: this hook is registered first.
const WORLDS = [];
require('node:test').after(async () => { for (const w of WORLDS.splice(0)) await w.close(); });
cleanupAfterAll();
const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'exec');
const RECORDED = path.join(FIXTURES, 'recorded');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { resolveDataHome } = loadTs('src/main/nexusExec/dataHome.ts');
const { loadImageProfiles } = loadTs('src/main/nexusExec/profiles.ts');
const { RunnerCore } = loadTs('src/runner/core.ts');
const { repositoryCheck, resolveCommit } = loadTs('src/main/git.ts');
const { getDomain } = loadTs('src/shared/nexus/domains/index.ts');
const { getUserAction } = loadTs('src/shared/nexus/actions.ts');
const { stepStateFrom } = loadTs('src/shared/nexus/stepState.ts');
const { STEP_SEPARATOR } = loadTs('src/main/nexus/exec/planBuilder.ts');

const GIB = 2 ** 30;
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra', 'images', 'lock.json'), 'utf8'));

class FakeClock {
  constructor(t) { this.now = t; this.q = []; this.n = 0; }
  setTimeout(fn, ms) { const x = { id: ++this.n, at: this.now + ms, fn, every: 0 }; this.q.push(x); return x; }
  setInterval(fn, ms) { const x = { id: ++this.n, at: this.now + ms, fn, every: ms }; this.q.push(x); return x; }
  clearTimeout(x) { this.q = this.q.filter((y) => y !== x); }
  clearInterval(x) { this.clearTimeout(x); }
  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const due = this.q.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.now = due.at;
      if (due.every) due.at += due.every; else this.q = this.q.filter((x) => x !== due);
      due.fn();
    }
    this.now = end;
  }
}

/**
 * The runner's real I/O, counted (test only): every promise a method of `obj` returns is in flight until it settles.
 * `io.n` is the number in flight; the fake clock waits for it (see `until`). Values and getters pass through unchanged.
 */
function trackRealIo(obj, io) {
  const tracked = (r) => {
    if (!r || typeof r.then !== 'function') return r;
    io.n++;
    return Promise.resolve(r).finally(() => { io.n--; });
  };
  return new Proxy(obj, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? (...args) => tracked(v.apply(t, args)) : v;
    }
  });
}

/** main's RunnerPort and the runner's transport, joined: each message is cloned and delivered on a later turn. */
function bridge() {
  const toMain = new Set(); let toRunner = null; let closed = false;
  const port = {
    state: () => (closed ? 'crashed' : 'ready'),
    send(m) { if (closed) throw new Error('the runner is gone'); const c = structuredClone(m); setImmediate(() => { if (!closed && toRunner) toRunner(c); }); },
    onMessage(fn) { toMain.add(fn); return () => toMain.delete(fn); },
    report(m) { for (const f of [...toMain]) f(m); }
  };
  const transport = {
    postMessage(m) { const c = structuredClone(m); setImmediate(() => { if (!closed) for (const f of [...toMain]) f(c); }); },
    on(_e, fn) { toRunner = fn; }
  };
  return { port, transport, close() { closed = true; } };
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 'Nexus Fixture', GIT_AUTHOR_EMAIL: 'fixture@nexus.invalid',
    GIT_COMMITTER_NAME: 'Nexus Fixture', GIT_COMMITTER_EMAIL: 'fixture@nexus.invalid', GIT_AUTHOR_DATE: '2026-10-10T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-10T10:00:00Z' } }).trim();

/**
 * A fresh git repository holding a fixture template (plus `overlay` files), one commit. The templates' JavaScript files
 * are stored as `<name>.js.tpl` (a plain `node --test test/` must never run a fixture's app, build or failing test as one
 * of this repository's tests); the copy gives them their real names.
 */
function fixtureRepo(name, overlay = {}) {
  const dir = h.tmpDir(`nx-fx-${name}-`);
  const copy = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name); const b = path.join(to, e.name.replace(/\.tpl$/, ''));
      if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copy(a, b); } else fs.copyFileSync(a, b);
    }
  };
  copy(path.join(FIXTURES, name), dir);
  for (const [rel, text] of Object.entries(overlay)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `fixture ${name}`);
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}

/** The repository files matching the entry's `**\/<name>` and `<dir>/**\/<name>` patterns (node_modules and .git skipped). */
function globFiles(repo, patterns) {
  const all = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(repo, rel), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else if (e.isFile()) all.push(r);
    }
  };
  walk('');
  const out = new Set();
  for (const p of patterns) {
    const [dir, name] = p.startsWith('**/') ? ['', p.slice(3)] : [p.slice(0, p.indexOf('/**/')), p.slice(p.indexOf('/**/') + 4)];
    const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
    for (const f of all) if ((dir === '' || f.startsWith(`${dir}/`)) && re.test(f.slice(f.lastIndexOf('/') + 1))) out.add(f);
  }
  return [...out].sort();
}

/** A template file by its real name (`src/handler.js` is stored as `src/handler.js.tpl`). */
function fixtureText(name, rel) {
  const p = path.join(FIXTURES, name, ...rel.split('/'));
  return fs.readFileSync(fs.existsSync(p) ? p : `${p}.tpl`, 'utf8');
}

const steps = (argv) => {
  const out = [[]];
  for (const a of argv) { if (a === STEP_SEPARATOR) out.push([]); else out[out.length - 1].push(a); }
  return out;
};
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

/**
 * A container's program as the pinned images run it, played from recordings. Returns its exit code, or null for a
 * long-running app or forwarder (it runs until it is stopped).
 */
function play(w, c, driver) {
  const spec = c.spec;
  const kind = spec.labels['nexus.kind'];
  if (kind === 'forwarder') return null;
  if (kind === 'service') { driver.emit(c.id, 'stdout', `${w.current.name} listening on ${spec.service?.containerPort}\n`); return null; }
  const out = spec.mounts.find((m) => m.kind === 'out').hostPath;
  const toOut = (p) => path.join(out, ...p.replace(/^\/out\/?/, '').split('/').filter(Boolean));
  const fx = w.current;
  let code = 0;
  for (const st of steps(spec.argv)) {
    if (code !== 0) break;
    const [cmd] = st;
    if (cmd === 'nexus-glob') {
      write(toOut(st[2]), globFiles(fx.dir, st.slice(3)).map((f) => `${f}\n`).join(''));
    } else if (cmd === 'nexus-node-test') {
      const files = st.slice(st.indexOf('--') + 1);
      files.forEach((f, i) => {
        const rec = path.join(RECORDED, fx.name, `${String(i + 1).padStart(4, '0')}.xml`);
        if (!fs.existsSync(rec)) return;
        const xml = fs.readFileSync(rec);
        write(path.join(toOut(st[2]), `${String(i + 1).padStart(4, '0')}.xml`), xml);
        driver.emit(c.id, 'stdout', `ran ${f}\n`);
        if (/<failure/.test(xml.toString('utf8')) && code === 0) code = 1;
      });
    } else if (cmd === 'nexus-capture' && st.includes('--collect-only')) {
      write(toOut(st[2]), fs.readFileSync(path.join(RECORDED, fx.name, 'collect.txt')));
    } else if (cmd === 'python' && st.includes('pytest')) {
      const dest = st.find((a) => a.startsWith('--junitxml=')).slice('--junitxml='.length);
      write(toOut(dest), fs.readFileSync(path.join(RECORDED, fx.name, 'junit.xml')));
    } else if (cmd === 'npm' && st[1] === 'run' && st[2] === 'build') {
      driver.emit(c.id, 'stdout', 'built dist/index.html and dist/app.js\n');
    } else if (cmd === 'nexus-collect') {
      const handler = require(path.join(fx.dir, 'src', 'handler.js'));
      write(path.join(toOut(st[4]), 'index.html'), `${handler.route('/').body}\n`);
      write(path.join(toOut(st[4]), 'app.js'), "'use strict';\nconsole.log('node-test-app build');\n");
    } else if (cmd === 'python' && st[2] === 'build') {
      const dest = st[st.indexOf('--outdir') + 1];
      write(path.join(toOut(dest), 'pytest_app-0.1.0-py3-none-any.whl'), Buffer.from('PK\u0003\u0004 pytest_app 0.1.0 (a recorded stand-in for the wheel)'));
    } else {
      driver.emit(c.id, 'stderr', `${cmd}: not found\n`);
      code = 127;
    }
  }
  return code;
}

/**
 * The database and the platform, composed as the app composes them (shared by the fake world and the real-Docker world):
 * a v9 store, the platform with real ingest, validation, approvals, deployments and RepoService, main's own git, and the
 * profiles and image contexts from infra/images/lock.json. `now`: the clock main reads.
 */
async function openPlatform(o = {}) {
  // `o.file` / `o.userData`: reopen an existing database and data home (a main restart, L16).
  const file = o.file ?? h.v6Fixture().file;
  const s = track(new PersistStore(file));
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, enableV9: true });
  const db = s.platformDatabase();
  const logs = [];
  const userData = o.userData ?? h.tmpDir('nx-xhome-');
  const dataHome = resolveDataHome(userData);
  await dataHome.ensure();
  const images = loadImageProfiles(path.join(ROOT, 'infra', 'images'));
  if (images.problem) throw new Error(`lock.json: ${images.problem}`);
  const roots = o.roots ?? new Set();
  const acceptFsRoot = (r) => (typeof r === 'string' && roots.has(path.resolve(r)) ? path.resolve(r) : null);
  const now = o.now ?? Date.now;
  const nx = createNexusPlatform(db, { now, log: (l) => logs.push(l), execution: true, dataHome, profiles: images.profiles,
    imageContexts: images.imageContexts, acceptFsRoot, isRepository: repositoryCheck, resolveCommit, appVersion: '0.0.0-test' });
  nx.startup();
  return { store: s, file, db, nx, logs, userData, dataHome, roots, images };
}

/** The record-reading and starting methods both worlds share (the flows call only these, plus `until`). */
function addCommon(w, p) {
  const { db, nx, roots, dataHome } = p;
  const me = nx.principals.localUser();
  Object.assign(w, { db, nx, exec: nx.exec, me, sys: nx.principals.system(), logs: p.logs, lock: LOCK, dataHome, projectId: 'p-ledger', workspaceId: 'sde', current: null });
  w.useFixture = async (name, overlay = {}) => {
    const r = fixtureRepo(name, overlay);
    roots.add(path.resolve(r.dir));
    db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(r.dir, w.projectId);
    const manifest = fs.existsSync(path.join(r.dir, 'nexus.app.json')) ? JSON.parse(fs.readFileSync(path.join(r.dir, 'nexus.app.json'), 'utf8')) : null;
    w.current = { name, dir: r.dir, commit: r.commit, healthPaths: manifest && name !== 'node-test-badhealth' ? ['/', '/health'] : ['/'] };
    return r;
  };
  w.fixtureFile = (name, rel) => fixtureText(name, rel);
  w.setLanguages = (langs) => {
    const row = db.prepare('SELECT metadata_json FROM projects WHERE id = ?').get(w.projectId);
    const meta = JSON.parse(row.metadata_json || '{}');
    db.prepare('UPDATE projects SET metadata_json = ? WHERE id = ?').run(JSON.stringify({ ...meta, detectedLanguages: langs }), w.projectId);
  };
  let k = 0;
  w.start = (actionId, o = {}) => nx.exec.start(me, { projectId: w.projectId, workspaceId: w.workspaceId, actionId, inputs: o.inputs ?? [],
    params: o.params ?? {}, intentId: `x-${++k}-${actionId}-${Date.now()}` }).job;
  w.snapshot = async () => {
    const r = await nx.repo.requestSnapshot(me, { projectId: w.projectId, workspaceId: w.workspaceId, intentId: `snap-${++k}-${Date.now()}` });
    await w.until(() => ['completed', 'failed', 'cancelled', 'interrupted', 'timed_out'].includes(w.job(r.job.id).state), 'the snapshot ends', 120_000);
    const j = w.job(r.job.id);
    if (j.state !== 'completed') throw new Error(`snapshot ${j.state}: ${j.error_json}`);
    const v = db.prepare("SELECT id FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = 'facts'").get(r.job.id)
      ?? db.prepare("SELECT v.id FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.kind = 'repository' AND a.project_id = ? AND v.content_hash = ?")
        .get(w.projectId, `git:${w.current.commit}`);
    return { jobId: r.job.id, versionId: v.id };
  };
  w.job = (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  w.version = (id) => db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(id);
  w.latest = (versionId, validatorId) => db.prepare(`SELECT * FROM validations WHERE version_id = ? AND validator_id = ? ORDER BY finished_at DESC, rowid DESC LIMIT 1`)
    .get(versionId, validatorId);
  w.deploymentOf = (jobId) => db.prepare('SELECT * FROM deployments WHERE job_id = ?').get(jobId) ?? null;
  w.deploymentRow = (id) => db.prepare('SELECT * FROM deployments WHERE id = ?').get(id);
  w.attemptsOf = (jobId) => db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n').all(jobId);
  w.outDir = (jobId) => { const a = w.attemptsOf(jobId).pop(); return a ? path.join(dataHome.root, 'work', jobId, String(a.n), 'out') : null; };
  w.outExists = (jobId, rel) => { const d = w.outDir(jobId); return d !== null && fs.existsSync(path.join(d, rel)); };
  w.stepState = (domainId, stepId) => {
    const step = getDomain(domainId).lifecycle.find((x) => x.id === stepId);
    const kind = 'kind' in step.doneWhen ? step.doneWhen.kind : null;
    // The domain's own records: the project-owned repository, or what this domain's participation owns.
    const versions = kind === null ? [] : db.prepare(`SELECT v.id, v.status FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE a.project_id = ? AND a.kind = ? AND (a.owner_scope = 'project' OR a.owner_participation_id IN
        (SELECT id FROM project_workspaces WHERE project_id = ? AND workspace_id = ?))`).all(w.projectId, kind, w.projectId, domainId).map((v) => {
      const rows = db.prepare(`SELECT validator_id, status FROM validations x WHERE x.version_id = ? AND x.blocking = 1 AND NOT EXISTS (SELECT 1 FROM validations y
        WHERE y.version_id = x.version_id AND y.validator_id = x.validator_id AND y.blocking = 1
          AND (y.finished_at > x.finished_at OR (y.finished_at = x.finished_at AND y.rowid > x.rowid)))`).all(v.id);
      return { status: v.status, validators: Object.fromEntries(rows.map((r) => [r.validator_id, r.status])) };
    });
    const recipes = step.via.flatMap((v) => ('userAction' in v ? (getUserAction(v.userAction)?.run.recipes ?? []) : 'recipe' in v ? [v.recipe] : []));
    const live = "('queued','leased','running','awaiting_approval','retry_scheduled')";
    const liveJobs = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND state IN ${live}
      AND (recipe_id IN (${recipes.map(() => '?').join(',') || "''"}) OR (kind = 'validate' AND json_extract(params_json, '$.versionId') IN
        (SELECT v.id FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.kind = ?)))`).get(w.projectId, ...recipes, kind ?? '').n;
    const inputsAvailable = step.consumes.every((x) => db.prepare(`SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE a.project_id = ? AND a.kind = ? AND v.status IN ('candidate','active')`).get(w.projectId, x));
    let recordPresent;
    if ('record' in step.doneWhen) {
      if (step.doneWhen.record === 'participation') recordPresent = !!db.prepare("SELECT 1 FROM project_workspaces WHERE project_id = ? AND workspace_id = ? AND status = 'active'").get(w.projectId, domainId);
      else if (step.doneWhen.record === 'deployment_healthy') {
        recordPresent = !!db.prepare(`SELECT 1 FROM deployments d WHERE d.project_id = ? AND (d.status = 'healthy' OR EXISTS (SELECT 1 FROM validations v
          WHERE v.job_id = d.job_id AND v.validator_id = 'app.preview_health' AND v.status = 'passed'))`).get(w.projectId);
      }
    }
    return stepStateFrom(step, { versions, liveJobs, inputsAvailable, recordPresent });
  };
  return w;
}

async function fakeWorld() {
  const clock = new FakeClock(h.NOW + 1000);
  const p = await openPlatform({ now: () => clock.now });
  const { nx } = p;
  const w = { kind: 'fake', clock, runnerLogs: [], health: (q) => (w.current && w.current.healthPaths.includes(q) ? 200 : 404) };
  addCommon(w, p);
  const versionsLabel = (q) => Object.entries(LOCK.profiles[q].versions).map(([k, v]) => `${k}=${v}`).join(' ');
  const imageInfo = (q, n) => ({ present: true, digestMatches: true, imageId: `sha256:${String(n).repeat(64)}`, sizeBytes: LOCK.profiles[q].estimatedBytes,
    contextSha256: LOCK.profiles[q].contextSha256, versions: versionsLabel(q) });
  const driver = new FakeSandboxDriver({ images: { 'sde-node': imageInfo('sde-node', 1), 'sde-python': imageInfo('sde-python', 2), 'nexus-fwd': imageInfo('nexus-fwd', 3) },
    onStart: (c, d) => { const code = play(w, c, d); if (code !== null) d.exitContainer(c.id, { code, finishedAt: clock.now }); } });
  const b = bridge();
  let nextPort = 49200;
  const io = { n: 0 };
  const core = new RunnerCore(b.transport, { driver, now: () => clock.now, fs: trackRealIo(fsp, io), timers: clock, log: (l) => w.runnerLogs.push(l),
    freeBytes: async () => 100 * GIB, sleep: async () => {}, docker: null, imagesDir: path.join(ROOT, 'infra', 'images'),
    probeHttp: async (_port, q) => ({ status: w.health(q), ms: 3 }), pickPort: () => nextPort++ });
  Object.assign(w, { driver, core, bridge: b });
  // The runner makes its GitRunner at each hello: whichever it makes is counted too.
  let gitRunner = core.git ?? null;
  Object.defineProperty(core, 'git', { configurable: true, enumerable: true, get: () => gitRunner,
    set: (v) => { gitRunner = v ? trackRealIo(v, io) : v; } });
  if (gitRunner) gitRunner = trackRealIo(gitRunner, io);
  nx.exec.attachRunner(b.port, newId(clock.now));
  WORLDS.push(w);
  // Settles main, and waits (on the real clock, at most IO_WAIT_MS per step) for the runner's real I/O in flight and
  // whatever its answers start, so fake time only passes while nothing real is still running.
  const IO_WAIT_MS = 120_000;
  const flush = async () => {
    const end = Date.now() + IO_WAIT_MS;
    do {
      while (io.n > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setImmediate(r));
        await nx.exec.settled();
        if (nx.validation) await nx.validation.settled();
      }
      await new Promise((r) => setTimeout(r, 2));
    } while (io.n > 0 && Date.now() < end);
  };
  w.until = async (pred, what, ms = 10 * 60_000) => {
    const steps = Math.ceil(ms / 1000) + 30;
    for (let i = 0; i < steps; i++) {
      await flush();
      if (pred()) return;
      clock.advance(1000);
      nx.exec.tick(clock.now);
      if (nx.validation) nx.validation.runPending(clock.now);
    }
    await flush();
    if (!pred()) throw new Error(`timed out waiting for ${what}\n${p.logs.slice(-15).join('\n')}\n${w.runnerLogs.slice(-15).join('\n')}`);
  };
  await w.until(() => nx.exec.health().docker.state === 'running', 'the runner probe', 30_000);
  w.liveLabelled = (jobId) => driver.all().filter((r) => r.labels && r.labels['nexus.job'] === jobId && r.labels['nexus.kind'] !== 'deps').length;
  w.containerArgv = async (jobId) => {
    const spec = driver.callsOf('create').map((x) => x.args[0]).filter((sp) => sp.labels['nexus.job'] === jobId && sp.labels['nexus.kind'] === 'service').pop();
    return spec ? spec.argv : [];
  };
  w.close = async () => {
    try { await core.shutdown(); } catch { /* down */ }
    b.close();
    try { p.store.close(); } catch { /* closed */ }
  };
  return w;
}

module.exports = { fakeWorld, openPlatform, addCommon, fixtureRepo, fixtureText, globFiles, FakeClock, bridge, trackRealIo, LOCK, ROOT, FIXTURES, WORLDS };
