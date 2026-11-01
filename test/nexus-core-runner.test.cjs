'use strict';
// B2a Task 11: RunnerCore with the fake sandbox driver (D1-D24) and the carried decisions (CD1-CD11). Plain node: no
// Docker, no Electron, no database. Main's own plan builder makes the plans, main's own parser checks every message.
// Temp folders are removed by the file's after hook; git runs only in temp repositories the tests make.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { MessageChannel } = require('node:worker_threads');

// D18: a spawn spy over the whole suite, installed before any runner module is loaded.
const SPAWNED = [];
const realSpawn = cp.spawn;
cp.spawn = function spySpawn(cmd, args, opts) {
  SPAWNED.push({ cmd, args: [...(args ?? [])], cwd: opts?.cwd, shell: opts?.shell, windowsHide: opts?.windowsHide, env: opts?.env });
  return realSpawn.apply(this, arguments);
};

// Before the temp folders are removed (cleanup.cjs's hook, registered next): every runner of the file shuts down, so
// no attempt log is still open (Windows cannot remove a folder holding an open file), and every port is closed.
const WORLDS = [];
after(async () => {
  for (const w of WORLDS) { try { await w.core.shutdown(); } catch { /* best effort */ } try { w.port1.close(); } catch { /* closed */ } }
});
const C = require('./helpers/cleanup.cjs');
C.cleanupAfterAll();
const h = require('./helpers/sqlite.cjs');
const loadTs = require('./load-ts.cjs');
const { FakeSandboxDriver } = require('./helpers/fakeSandboxDriver.cjs');
const { RunnerCore, HEARTBEAT_MS, RUNNER_WALL_FACTOR } = loadTs('src/runner/core.ts');
const { createArgv, DockerDriver, classifyDockerError } = loadTs('src/runner/sandbox/dockerDriver.ts');
const { dockerCli, resolveDockerBinary } = loadTs('src/runner/sandbox/dockerCli.ts');
const { contextSha256 } = loadTs('src/runner/imageBuilder.ts');
const { RENAME_RETRIES } = loadTs('src/runner/objectStore.ts');
const { GUARD_POLL_MS } = loadTs('src/runner/sandbox/sizeGuard.ts');
const { parseRunnerMessage, EPHEMERAL_PORT_MIN, EPHEMERAL_PORT_MAX } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { comparePreflight } = loadTs('src/shared/nexus/preflightCheck.ts');
const { homeLabel } = loadTs('src/shared/nexus/homeLabel.ts');
const { buildPlan, STEP_SEPARATOR } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { inspectFor } = require('./helpers/fakeSandboxDriver.cjs');
const { isGitBinary, insideFolder } = loadTs('src/main/gitBinary.ts');
/**
 * A runner git spawn: the resolved binary, from the data home, the repository by -C, the safe config; returns the subcommand
 * argv. B2a final review B1: a content-converting call (archive, status) also carries, right after that prefix, the
 * `-c filter.<n>.{smudge,clean,process}= -c filter.<n>.required=false` group of every configured filter driver; each group
 * is checked whole here and removed from the returned argv (its driver names are on `.filters`).
 */
function gitSub(s, w, repoDir) {
  assert.ok(isGitBinary(s.cmd), `the resolved git binary, not ${s.cmd}`);
  assert.ok(!insideFolder(s.cmd, repoDir), 'never a git inside the repository');
  assert.equal(path.resolve(s.cwd), path.resolve(w.home), 'git runs from the data home');
  assert.deepEqual(s.args.slice(0, 6), ['-C', repoDir, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${path.join(w.home, '.nexus-no-git-hooks')}`]);
  const rest = s.args.slice(6);
  const keys = new Map();
  let i = 0;
  while (rest[i] === '-c' && /^filter\./.test(rest[i + 1] ?? '')) {
    const m = /^filter\.(.+)\.(smudge|clean|process|required)=(.*)$/.exec(rest[i + 1]);
    assert.ok(m, rest[i + 1]);
    assert.equal(m[3], m[2] === 'required' ? 'false' : '', `${rest[i + 1]} switches the driver off`);
    keys.set(m[1], [...(keys.get(m[1]) ?? []), m[2]]);
    i += 2;
  }
  for (const [n, k] of keys) assert.deepEqual(k, ['smudge', 'clean', 'process', 'required'], `every key of filter ${n} is switched off`);
  const sub = rest.slice(i);
  Object.defineProperty(sub, 'filters', { value: [...keys.keys()], enumerable: false });
  return sub;
}
/** The configured filter drivers git itself lists for `dir` (what a neutralised call must switch off). */
function configuredFilters(dir) {
  const r = cp.spawnSync('git', ['config', '--name-only', '--get-regexp', '^filter\\.'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return [...new Set(r.stdout.split('\n').filter(Boolean).map((k) => k.slice('filter.'.length, k.lastIndexOf('.'))))];
}
const { FILTER_CONFIG_ARGV } = loadTs('src/main/gitBinary.ts');
const { ARCHIVE_EOL_CONFIG, inertSignatureArgs } = loadTs('src/runner/git.ts');
const { PROXY_READY_MS } = loadTs('src/runner/egress.ts');

const GIB = 2 ** 30;
const NOW = 1_780_000_000_000;
const BOOT = newId(NOW);
const IMAGE = 'sha256:' + '1'.repeat(64);
const FWD_IMAGE = 'sha256:' + '3'.repeat(64);
const PROFILE = { id: 'sde-node', image: { repository: 'nexus/sde-node', digest: `sha256:${'7'.repeat(64)}` }, user: { uid: 10001, gid: 10001 },
  defaults: { cpus: 1, memoryMb: 1024, pids: 512, wallClockMs: 60000, outputMaxBytes: 2 ** 20, tmpfsMb: 512 },
  entrypoint: ['/opt/nexus/entry'], imageEnv: ['PATH', 'HOME', 'LANG'] };
const FWD = { id: 'nexus-fwd', image: { repository: 'nexus/nexus-fwd', digest: `sha256:${'9'.repeat(64)}` }, user: { uid: 10001, gid: 10001 },
  defaults: { cpus: 1, memoryMb: 128, pids: 512, wallClockMs: 60000, outputMaxBytes: 2 ** 20, tmpfsMb: 16 },
  entrypoint: ['/opt/nexus/fwd-entry'], imageEnv: ['PATH', 'HOME'] };

/** Every message any runner of this file sent (D19 checks them all at the end). */
const ALL = [];
/** [world number, message] for the per-process seq check. */
const BY_WORLD = [];

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

const tick = () => new Promise((r) => setImmediate(r));
// The wait only bounds how long a fake-driver event may take to arrive; the event itself is still required.
// 15 s keeps a full `node --test test/` run (many files in parallel) from timing out on a loaded machine.
async function until(pred, what, ms = 15_000) {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function world(o = {}) {
  const dir = h.tmpDir('nx-run-');
  // `homeDir`: the same data home as another runner (a restarted runner of the same install).
  const home = o.homeDir ?? path.join(dir, 'nexus');
  for (const d of ['objects/tmp', 'logs/jobs', 'logs/images', 'work']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const clock = new FakeClock(NOW);
  const driver = o.driver ?? new FakeSandboxDriver(o.fake ?? {});
  const { port1, port2 } = new MessageChannel();
  const got = [];
  const wn = WORLDS.length;
  port1.on('message', (m) => { got.push(m); ALL.push(m); BY_WORLD.push([wn, m]); });
  const logs = [];
  const core = new RunnerCore(port2, {
    driver, now: () => clock.now, fs: o.fs ?? fsp, timers: clock, log: (l) => logs.push(l), freeBytes: o.freeBytes ?? (async () => 100 * GIB),
    sleep: o.sleep ?? (async () => {}), limits: o.limits, pickPort: o.pickPort, docker: o.docker ?? null, imagesDir: o.imagesDir, probeHttp: o.probeHttp,
    resolveGit: o.resolveGit
  });
  const label = homeLabel(home);
  const w = {
    dir, home, clock, driver, core, got, logs, port1, label,
    send: (m) => port1.postMessage(m),
    of: (op, attemptId) => got.filter((m) => m.op === op && (attemptId === undefined || m.attemptId === attemptId)),
    one: (op, attemptId) => got.find((m) => m.op === op && (attemptId === undefined || m.attemptId === attemptId)),
    async wait(op, attemptId, what) { await until(() => w.one(op, attemptId) !== undefined, what ?? op); return w.one(op, attemptId); },
    advance: async (ms) => { clock.advance(ms); for (let i = 0; i < 5; i++) await tick(); }
  };
  WORLDS.push(w);
  w.send({ op: 'hello', bootId: BOOT, dataHome: home, home: label, profiles: o.profiles ?? [PROFILE] });
  await until(() => got.some((m) => m.op === 'ready'), 'ready');
  return w;
}

// The default test plan is a framework whose container writes /out/junit.xml itself (mocha's forced reporter), the path
// these Task 11 tests exercise (hashing, parsing, reconcile, adoption). node:test plans are per-file since Task 12 (A5):
// their junit.xml is the runner's merge of /out/junit/NNNN.xml, and a container-written junit.xml is never taken for
// them (Task 12 fix round 1, item 6; the RV tests below). No assertion here depends on the framework.
const DEFAULT_INPUTS = [{ versionId: 'V1', slot: 'suite', contentHash: 'x', storage: { kind: 'inline' }, metadata: { framework: 'mocha', files: ['test/a.test.js'] } }];
function toolPlan(w, o = {}) {
  const jobId = newId(NOW); const attemptId = newId(NOW);
  const plan = buildPlan({ job: { id: jobId, projectId: 'p-ledger' }, attempt: { id: attemptId, n: 1 }, bootId: BOOT, recipe: getRecipe(o.recipe ?? 'sde.test.node'),
    profile: PROFILE, imageId: IMAGE, dataHomeRoot: w.home, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`,
    inputs: o.inputs ?? DEFAULT_INPUTS, repoPath: o.repoPath ?? null, approval: o.approval ?? null, framework: o.framework ?? null });
  if (o.limits) Object.assign(plan.container.limits, o.limits);
  return plan;
}
async function start(w, plan) {
  w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  const p = await w.wait('attempt.provisioned', plan.attemptId, 'provisioned');
  return p;
}
const outFile = (plan, rel, data) => {
  const f = path.join(plan.workDir, 'out', ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  return f;
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const JUNIT = fs.readFileSync(path.join(__dirname, 'fixtures', 'exec', 'junit', 'node-test.xml'));
const gitOk = (cwd, args) => {
  const r = cp.spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
function repo(w, files) {
  const dir = path.join(w.dir, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  gitOk(dir, ['init', '-q']);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-qm', 'init']);
  return { dir, commit: gitOk(dir, ['rev-parse', 'HEAD']) };
}

// ---------- D1-D3: create -> preflight -> start, refusals and Docker's errors ----------

test('D1 order is create -> preflight -> start; a failing preflight removes the container, never starts it, and reports ok:false', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const p = await start(w, plan);
  assert.equal(p.preflight.ok, true);
  const ops = w.driver.ops().filter((o) => ['create', 'preflight', 'start'].includes(o));
  assert.deepEqual(ops, ['create', 'preflight', 'start']);
  assert.equal(p.imageDigest, IMAGE);

  const bad = await world({ fake: { mutateInspect: (rec) => { rec[0].HostConfig.NetworkMode = 'bridge'; rec[0].NetworkSettings.Networks = { bridge: {} }; return rec; } } });
  const plan2 = toolPlan(bad);
  const p2 = await start(bad, plan2);
  assert.equal(p2.preflight.ok, false);
  assert.ok(p2.preflight.problems.some((x) => /network/.test(x)), p2.preflight.problems.join('; '));
  assert.ok(bad.driver.ops().includes('remove'));
  assert.ok(!bad.driver.ops().includes('start'), 'never started');
  assert.ok(bad.driver.ops().indexOf('remove') > bad.driver.ops().indexOf('preflight'));
});

test('D2 Docker stopped or missing: attempt.start is refused and nothing is created', async () => {
  for (const [docker, reason] of [['stopped', 'docker_stopped'], ['missing', 'docker_missing']]) {
    const w = await world({ fake: { docker } });
    const plan = toolPlan(w);
    w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
    const r = await w.wait('attempt.refused', plan.attemptId);
    assert.equal(r.reason, reason);
    for (const op of ['create', 'createVolume', 'createNetwork', 'start']) assert.ok(!w.driver.ops().includes(op), `${docker}: ${op}`);
    assert.ok(!fs.existsSync(path.join(plan.workDir, 'in')), 'nothing staged');
  }
});

test('D3 create errors map to classes; a missing image is a refusal; a name conflict is retried once with a new name', async () => {
  const cases = [['Error response from daemon: no space left on device', 'disk_full'], ['Error response from daemon: cannot allocate memory', 'docker_resources'],
    ['Minimum memory limit allowed is 6MB', 'docker_resources'], ['Error response from daemon: something odd', 'docker_error']];
  for (const [stderr, cls] of cases) {
    const w = await world({ fake: { createFaults: [stderr] } });
    const plan = toolPlan(w);
    w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
    const f = await w.wait('fault', plan.attemptId);
    assert.equal(f.failureClass, cls, stderr);
    assert.equal(f.attemptId, plan.attemptId);
    await until(() => !w.driver.volumes.size, 'workspace volume removed after the fault');
  }
  const img = await world({ fake: { createFaults: ['Error response from daemon: No such image: nexus/sde-node@sha256:77'] } });
  const plan = toolPlan(img);
  img.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  assert.equal((await img.wait('attempt.refused', plan.attemptId)).reason, 'image_missing');
  const c = await world({ fake: { createFaults: ['Error response from daemon: Conflict. The container name "/nexus-x" is already in use by container "abc"'] } });
  const plan3 = toolPlan(c);
  const p = await start(c, plan3);
  assert.equal(p.preflight.ok, true);
  const creates = c.driver.callsOf('create');
  assert.equal(creates.length, 2);
  assert.equal(creates[1].args[1].name, `${plan3.container.name}-2`);
});

// ---------- D4-D7: timeout, cancel, size guards ----------

test('D4 the wall-clock backstop fires stop -t 10 then kill; the exit report says reason: timeout', async () => {
  const w = await world();
  const plan = toolPlan(w, { limits: { wallClockMs: 1000 } });
  const p = await start(w, plan);
  await w.advance(1000 * RUNNER_WALL_FACTOR - 1);
  assert.ok(!w.driver.ops().includes('stop'));
  await w.advance(1);
  const e = await w.wait('attempt.exited', plan.attemptId);
  const stops = w.driver.calls.filter((x) => (x.op === 'stop' || x.op === 'kill') && x.args[0] === p.containerId);
  assert.deepEqual(stops.map((x) => [x.op, x.args[1]]), [['stop', 10000], ['kill', undefined]]);
  assert.equal(e.reason, 'timeout');
  assert.deepEqual(e.outputs, []);
});

test('D5 cancel: stop with grace, then kill; the container and the /workspace volume go only after attempt.release', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const p = await start(w, plan);
  w.send({ op: 'attempt.cancel', attemptId: plan.attemptId, graceMs: 10000, reason: 'user' });
  const e = await w.wait('attempt.exited', plan.attemptId);
  assert.equal(e.reason, 'cancelled');
  assert.deepEqual(w.driver.calls.filter((x) => ['stop', 'kill'].includes(x.op)).map((x) => [x.op, x.args[1]]), [['stop', 10000], ['kill', undefined]]);
  await w.advance(1000);
  assert.ok(!w.driver.ops().includes('remove') && !w.driver.ops().includes('removeVolume'), 'nothing removed before release');
  w.send({ op: 'attempt.release', attemptId: plan.attemptId });
  await until(() => w.driver.ops().includes('removeVolume'), 'cleanup');
  assert.ok(w.driver.callsOf('remove').some((x) => x.args[0] === p.containerId));
  assert.deepEqual(w.driver.callsOf('removeVolume').map((x) => x.args[0]), [`nexus-ws-${plan.attemptId}`]);
  assert.ok(fs.existsSync(plan.workDir), 'the work folder stays');
});

test('D6 /out growing past outputMaxBytes: the guard kills the container and the exit says output_too_large', async () => {
  const w = await world();
  const plan = toolPlan(w, { limits: { outputMaxBytes: 1024 } });
  const p = await start(w, plan);
  outFile(plan, 'big.bin', Buffer.alloc(4096, 1));
  await w.advance(GUARD_POLL_MS);
  const e = await w.wait('attempt.exited', plan.attemptId);
  assert.equal(e.outputError, 'output_too_large');
  assert.deepEqual(e.outputs, []);
  assert.ok(w.driver.callsOf('kill').some((x) => x.args[0] === p.containerId));
  const guard = w.of('attempt.event', plan.attemptId).find((m) => m.event.t === 'guard');
  assert.deepEqual([guard.event.guard, guard.event.limitBytes], ['output_too_large', 1024]);
});

test('D7 /workspace past its guard (du through docker exec): killed, workspace_too_large', async () => {
  const w = await world({ fake: { duKib: 4096 }, limits: { workspaceMaxBytes: 2 ** 20 } });
  const plan = toolPlan(w);
  const p = await start(w, plan);
  await w.advance(GUARD_POLL_MS);
  const e = await w.wait('attempt.exited', plan.attemptId);
  assert.equal(e.outputError, 'workspace_too_large');
  const ex = w.driver.callsOf('exec')[0];
  assert.deepEqual([ex.args[0], ex.args[1]], [p.containerId, ['/usr/bin/du', '-s', '-x', '-k', '/workspace']]);
});

// ---------- D8-D10: outputs, hashing, logs ----------

/** An fs that records every file it opens (nothing outside /out may be read). */
function spyFs() {
  const opened = [];
  const f = { ...fsp, open: (p, ...r) => { opened.push(path.resolve(String(p))); return fsp.open(p, ...r); } };
  return { f, opened };
}

test('D8 unsafe /out entries are refused with their path (a link, a hard link, a FIFO, a name with ..); nothing outside /out is read', async () => {
  const outside = (w) => { const d = path.join(w.dir, 'secret'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'key.txt'), 'outside'); return d; };
  const run = async (o, prepare) => {
    const s = spyFs();
    const w = await world({ fs: o.fs ?? s.f });
    const plan = toolPlan(w);
    const p = await start(w, plan);
    outFile(plan, 'junit.xml', JUNIT);
    prepare(w, plan);
    w.driver.exitContainer(p.containerId, { code: 0 });
    const e = await w.wait('attempt.exited', plan.attemptId);
    const sec = path.join(w.dir, 'secret');
    assert.ok(!s.opened.some((x) => x.startsWith(sec)), 'nothing outside /out was opened');
    return e;
  };
  const link = await run({}, (w, plan) => fs.symlinkSync(outside(w), path.join(plan.workDir, 'out', 'leak'), 'junction'));
  assert.equal(link.outputError, 'symlink'); assert.equal(link.outputErrorEntry, 'leak'); assert.deepEqual(link.outputs, []);
  const hard = await run({}, (w, plan) => { outside(w); fs.linkSync(path.join(w.dir, 'secret', 'key.txt'), path.join(plan.workDir, 'out', 'hard.txt')); });
  assert.equal(hard.outputError, 'hardlink'); assert.equal(hard.outputErrorEntry, 'hard.txt');
  const dots = await run({}, (w, plan) => outFile(plan, 'sub/a..b', 'x'));
  assert.equal(dots.outputError, 'bad_name'); assert.equal(dots.outputErrorEntry, 'sub/a..b');
  // A FIFO cannot be made on every platform: the fs reports one (lstat), as a Linux bind mount would.
  const fifoFs = { ...fsp, lstat: async (p) => {
    const st = await fsp.lstat(p);
    if (path.basename(String(p)) !== 'pipe') return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, isFIFO: () => true });
  } };
  const fifo = await run({ fs: fifoFs }, (w, plan) => outFile(plan, 'pipe', ''));
  assert.equal(fifo.outputError, 'special_file'); assert.equal(fifo.outputErrorEntry, 'pipe');
  for (const e of [link, hard, dots, fifo]) assert.ok(parseRunnerMessage(e));
});

test('D9 hashing: the object equals its sha256 name; an identical object already there is a no-op; EPERM x5 is file_locked', async () => {
  const renames = [];
  const isObject = (p) => String(p).includes(`${path.sep}objects${path.sep}`);
  const w = await world({ fs: { ...fsp, rename: (a, b) => { if (isObject(b)) renames.push(b); return fsp.rename(a, b); } } });
  const plan = toolPlan(w);
  const p = await start(w, plan);
  outFile(plan, 'junit.xml', JUNIT);
  outFile(plan, 'copy/junit.xml', JUNIT);
  const known = sha(Buffer.from('already here'));
  outFile(plan, 'known.txt', 'already here');
  const knownPath = path.join(w.home, 'objects', known.slice(0, 2), known.slice(2));
  fs.mkdirSync(path.dirname(knownPath), { recursive: true }); fs.writeFileSync(knownPath, 'already here');
  w.driver.exitContainer(p.containerId, { code: 0 });
  const e = await w.wait('attempt.exited', plan.attemptId);
  assert.equal(e.outputError, undefined);
  for (const o of e.outputs) {
    const bytes = fs.readFileSync(path.join(w.home, 'objects', o.sha256.slice(0, 2), o.sha256.slice(2)));
    assert.equal(sha(bytes), o.sha256); assert.equal(bytes.length, o.bytes);
  }
  assert.equal(e.outputs.find((o) => o.relPath === 'junit.xml').sha256, sha(JUNIT));
  assert.equal(e.outputs.find((o) => o.relPath === 'junit.xml').mediaType, 'application/xml');
  assert.ok(!renames.some((r) => r.endsWith(known.slice(2))), 'no rename onto the existing identical object');
  assert.equal(renames.filter((r) => r.endsWith(sha(JUNIT).slice(2))).length, 1, 'the second copy of the same bytes is a no-op');
  assert.deepEqual(fs.readdirSync(path.join(w.home, 'objects', 'tmp')), [], 'no temporary file is left');
  assert.equal(e.parsed[0].parser, 'junit');

  let tries = 0;
  const locked = await world({ fs: { ...fsp, rename: async (a, b) => {
    if (!isObject(b)) return fsp.rename(a, b);              // the attempt's own records (plan.json, exit.json)
    tries++; const err = new Error('EPERM'); err.code = 'EPERM'; throw err;
  } } });
  const plan2 = toolPlan(locked);
  const p2 = await start(locked, plan2);
  outFile(plan2, 'junit.xml', JUNIT);
  locked.driver.exitContainer(p2.containerId, { code: 0 });
  const e2 = await locked.wait('attempt.exited', plan2.attemptId);
  assert.equal(e2.outputError, 'file_locked'); assert.equal(e2.outputErrorEntry, 'junit.xml');
  assert.equal(tries, RENAME_RETRIES);
  assert.deepEqual(fs.readdirSync(path.join(locked.home, 'objects', 'tmp')), []);
});

test('D10 logs: secret-shaped text is stored [redacted]; frames are JSONL; past the cap the middle is dropped with one marker; logBytes reported', async () => {
  const w = await world({ limits: { logCapBytes: 8192 } });
  const plan = toolPlan(w);
  const p = await start(w, plan);
  w.driver.emit(p.containerId, 'stdout', 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 end\nAuthorization: Bearer abc.def.ghi-jkl\n');
  w.driver.emit(p.containerId, 'stderr', 'first stderr line\n');
  for (let i = 0; i < 400; i++) w.driver.emit(p.containerId, 'stdout', `line ${String(i).padStart(4, '0')} ${'x'.repeat(40)}\n`);
  w.driver.emit(p.containerId, 'stdout', 'the last line\n');
  outFile(plan, 'junit.xml', JUNIT);
  w.driver.exitContainer(p.containerId, { code: 0 });
  const e = await w.wait('attempt.exited', plan.attemptId);
  const text = fs.readFileSync(plan.logPath, 'utf8');
  assert.equal(e.logBytes, Buffer.byteLength(text));
  assert.ok(e.logBytes <= 8192);
  const frames = text.trimEnd().split('\n').map((l) => JSON.parse(l));
  for (const f of frames) { assert.equal(typeof f.ts, 'number'); assert.ok(['stdout', 'stderr', 'nexus'].includes(f.stream)); assert.equal(typeof f.text, 'string'); }
  assert.doesNotMatch(text, /sk-ant-api03|abc\.def\.ghi/);
  assert.ok(frames.some((f) => f.text.includes('[redacted]')));
  assert.equal(frames.filter((f) => f.truncatedMiddle === true).length, 1, 'one marker');
  assert.ok(frames.some((f) => f.text === 'first stderr line'), 'the head is kept');
  assert.equal(frames[frames.length - 1].text, 'the last line', 'the tail is kept');
  assert.ok(!frames.some((f) => f.text.startsWith('line 0200')), 'the middle is dropped');
});

// ---------- D11-D15: staging, labels, heartbeats, git ----------

test('D11 staging: git archive argv exact, run in the plan\'s project folder; a non-hex commit is refused before spawn; a changed input blob is refused', async () => {
  const w = await world();
  const r = repo(w, { 'package.json': '{"name":"x"}', 'test/a.test.js': 'require("node:test")' });
  const plan = toolPlan(w, { repoPath: r.dir, inputs: [{ versionId: 'V1', slot: 'suite', contentHash: 'x', storage: { kind: 'git', commit: r.commit },
    metadata: { framework: 'node-test', files: ['test/a.test.js'] } }] });
  const before = SPAWNED.length;
  await start(w, plan);
  const git = SPAWNED.slice(before).filter((s) => isGitBinary(s.cmd));
  // B1: the configured filter drivers are read first (read-only), then the archive switches every one of them off and
  // keeps the committed line endings (core.autocrlf=false, core.eol=lf). B2a stabilization (security review): every
  // signature program is the resolved git binary itself, so an export-subst %G placeholder runs nothing of the repository's.
  assert.deepEqual(git.map((s) => gitSub(s, w, r.dir)), [[...FILTER_CONFIG_ARGV],
    [...inertSignatureArgs(git[1].cmd), ...ARCHIVE_EOL_CONFIG, 'archive', '--format=tar', r.commit]]);
  assert.deepEqual(gitSub(git[1], w, r.dir).filters, configuredFilters(r.dir), 'every configured filter driver is switched off');
  assert.equal(git[1].env.GIT_LFS_SKIP_SMUDGE, '1');
  assert.equal(git[0].shell, false); assert.equal(git[0].windowsHide, true);
  const tar = fs.readFileSync(path.join(plan.workDir, 'in', 'src.tar'));
  const staging = JSON.parse(fs.readFileSync(path.join(plan.workDir, 'staging.json'), 'utf8'));
  assert.deepEqual(staging.source, { sha256: sha(tar), bytes: tar.length });

  const bad = toolPlan(w, { repoPath: r.dir, inputs: [{ versionId: 'V1', slot: 'suite', contentHash: 'x', storage: { kind: 'git', commit: r.commit },
    metadata: { framework: 'node-test', files: ['test/a.test.js'] } }] });
  bad.staging.source.commit = 'HEAD';
  const n0 = SPAWNED.length;
  w.send({ op: 'attempt.start', attemptId: bad.attemptId, plan: bad });
  const refused = await w.wait('attempt.refused', bad.attemptId);
  assert.equal(refused.reason, 'bad_plan');
  assert.equal(SPAWNED.length, n0, 'git was never spawned');

  const blob = toolPlan(w);
  const good = Buffer.from('build output');
  const s = sha(good);
  const obj = path.join(w.home, 'objects', s.slice(0, 2), s.slice(2));
  fs.mkdirSync(path.dirname(obj), { recursive: true }); fs.writeFileSync(obj, 'tampered bytes');
  blob.staging.blobs = [{ sha256: s, relPath: 'dist/app.js' }];
  w.send({ op: 'attempt.start', attemptId: blob.attemptId, plan: blob });
  const r2 = await w.wait('attempt.refused', blob.attemptId);
  assert.equal(r2.reason, 'input_changed');
  assert.ok(!fs.existsSync(path.join(blob.workDir, 'in', 'dist', 'app.js')), 'the bad copy is removed');
  assert.ok(!w.driver.callsOf('create').some((c) => c.args[0].labels['nexus.attempt'] === blob.attemptId), 'nothing created');
});

test('D12 listing always filters by label (nexus.attempt and this install); unlabelled and foreign resources never reach the reconcile result', async () => {
  const extra = [
    { kind: 'container', id: 'f'.repeat(64), name: 'nexus-x', labels: {}, state: 'running' },
    { kind: 'container', id: 'e'.repeat(64), name: 'nexus-other', labels: { 'nexus.attempt': newId(NOW), 'nexus.home': '0123456789abcdef' }, state: 'exited' },
    { kind: 'volume', id: 'nexus-ws-user', name: 'nexus-ws-user', labels: { 'nexus.note': 'mine' } }
  ];
  const w = await world({ fake: { extra } });
  const plan = toolPlan(w);
  const p = await start(w, plan);
  w.send({ op: 'reconcile.list', attempts: [{ attemptId: plan.attemptId, containerId: p.containerId, kind: 'tool' }] });
  const r = await w.wait('reconcile.result');
  assert.ok(w.driver.filters.length > 0 && w.driver.filters.every((f) => f.includes('label=nexus.attempt') && f.includes(`label=nexus.home=${w.label}`)));
  const ids = r.labelled.map((x) => x.id);
  assert.ok(!ids.includes('f'.repeat(64)) && !ids.includes('e'.repeat(64)) && !ids.includes('nexus-ws-user'));
  assert.ok(ids.includes(p.containerId) && ids.includes(`nexus-ws-${plan.attemptId}`));
  for (const x of r.labelled) assert.ok(Object.keys(x.labels).every((k) => k.startsWith('nexus.')), 'only nexus.* labels travel');
  assert.deepEqual(r.attempts, [{ attemptId: plan.attemptId, container: 'running', containerId: p.containerId }]);
  // The real driver: every list command carries the label filter.
  const argvs = [];
  const fakeCli = { binary: async () => 'C:\\x\\docker.exe', run: async (argv) => { argvs.push(argv); return { code: 0, stdout: '', stderr: '', stdoutBytes: 0, truncated: false, timedOut: false, aborted: false, error: null }; } };
  await new DockerDriver(fakeCli, { now: () => NOW }).listResources({ 'nexus.home': w.label });
  assert.equal(argvs.length, 3);
  for (const a of argvs) { assert.ok(a.includes('label=nexus.attempt'), a.join(' ')); assert.ok(a.includes(`label=nexus.home=${w.label}`)); }
});

test('D13 heartbeats every 15 s per live attempt with the container state and byte counts; none after release', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const p = await start(w, plan);
  const n0 = w.of('attempt.heartbeat', plan.attemptId).length;
  assert.ok(n0 >= 1, 'a heartbeat at start');
  outFile(plan, 'junit.xml', JUNIT);
  // The size guard measures /out every 5 s; the next heartbeat carries what it measured.
  const execs0 = w.driver.callsOf('exec').length;
  await w.advance(GUARD_POLL_MS);
  // Final batch item 11: deterministic, never a wall-clock sleep. The guard sets its /out measure before it asks Docker for
  // the workspace size (`du`), so that exec call is the signal that the measure the next heartbeat carries is in.
  await until(() => w.driver.callsOf('exec').length > execs0, 'the size guard measured /out', 30_000);
  await w.advance(HEARTBEAT_MS - GUARD_POLL_MS);
  const hb = w.of('attempt.heartbeat', plan.attemptId);
  assert.equal(hb.length, n0 + 1);
  const last = hb[hb.length - 1];
  assert.equal(last.container, 'running'); assert.equal(typeof last.logBytes, 'number'); assert.equal(last.outBytes, JUNIT.length);
  assert.equal(last.at, NOW + HEARTBEAT_MS);
  w.driver.exitContainer(p.containerId, { code: 0 });
  await w.wait('attempt.exited', plan.attemptId);
  await w.advance(HEARTBEAT_MS);
  assert.equal(w.of('attempt.heartbeat', plan.attemptId).at(-1).container, 'exited');
  w.send({ op: 'attempt.release', attemptId: plan.attemptId });
  await until(() => !w.core.held().includes(plan.attemptId), 'released');
  const n1 = w.of('attempt.heartbeat', plan.attemptId).length;
  await w.advance(HEARTBEAT_MS * 3);
  assert.equal(w.of('attempt.heartbeat', plan.attemptId).length, n1, 'none after release');
});

test('D14 repo.snapshot: git argv exact; the dirty flag from the status output length only (no file name leaves the runner)', async () => {
  const w = await world();
  const r = repo(w, { 'a.txt': 'a' });
  fs.writeFileSync(path.join(r.dir, 'zz-private-name.txt'), 'not committed');
  const jobId = newId(NOW); const attemptId = newId(NOW);
  const plan = buildPlan({ job: { id: jobId, projectId: 'p-ledger' }, attempt: { id: attemptId, n: 1 }, bootId: BOOT, recipe: getRecipe('repo.snapshot'),
    dataHomeRoot: w.home, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, inputs: [], repoPath: r.dir });
  const before = SPAWNED.length;
  w.send({ op: 'attempt.start', attemptId, plan });
  const e = await w.wait('attempt.exited', attemptId);
  // B1: status reads the filter drivers first and switches them off; final batch item 1: the lockfile at the commit is
  // looked up by its fixed names (this repository has none, so nothing more is read).
  const spawned = SPAWNED.slice(before).filter((s) => isGitBinary(s.cmd));
  assert.deepEqual(spawned.map((s) => gitSub(s, w, r.dir)),
    [['rev-parse', '--verify', 'HEAD^{commit}'], ['symbolic-ref', '--short', '-q', 'HEAD'], [...FILTER_CONFIG_ARGV], ['status', '--porcelain=v1', '-z', '--ignore-submodules=all'],
      ['rev-parse', 'HEAD^{tree}'], ['cat-file', '-s', `${r.commit}:package-lock.json`], ['cat-file', '-s', `${r.commit}:requirements.txt`],
      // Live preview phase 2: the package list (package.json) at the commit is looked up by its fixed name too (this repository has none).
      ['cat-file', '-s', `${r.commit}:package.json`]]);
  assert.deepEqual(gitSub(spawned[3], w, r.dir).filters, configuredFilters(r.dir), 'status switches every configured filter driver off');
  assert.deepEqual(w.one('attempt.provisioned', attemptId), { op: 'attempt.provisioned', attemptId });
  assert.equal(e.exit.code, 0);
  const facts = e.parsed[0].normalized;
  assert.equal(e.parsed[0].parser, 'repo-snapshot');
  assert.equal(facts.commit, r.commit); assert.equal(facts.dirty, true); assert.match(facts.tree, /^[0-9a-f]{40}$/);
  assert.equal(typeof facts.branch, 'string');
  assert.equal(facts.lockfile, null, 'no lockfile at the commit');
  assert.equal(facts.manifest, null, 'no package list at the commit');
  assert.doesNotMatch(JSON.stringify(w.got), /zz-private-name/);
});

test('D14b (final batch item 1) repo.snapshot records the lockfile AT THE COMMIT: npm\'s first, hashed from the committed bytes (cat-file blob), never the work tree', async () => {
  const w = await world();
  const lock = '{\n  "name": "x",\n  "lockfileVersion": 3\n}\n';
  const r = repo(w, { 'package-lock.json': lock, 'requirements.txt': 'pytest==9.1.1 --hash=sha256:' + 'a'.repeat(64) + '\n' });
  fs.writeFileSync(path.join(r.dir, 'package-lock.json'), '{"changed":"in the work tree only"}');
  const jobId = newId(NOW); const attemptId = newId(NOW);
  const plan = buildPlan({ job: { id: jobId, projectId: 'p-ledger' }, attempt: { id: attemptId, n: 1 }, bootId: BOOT, recipe: getRecipe('repo.snapshot'),
    dataHomeRoot: w.home, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, inputs: [], repoPath: r.dir });
  const before = SPAWNED.length;
  w.send({ op: 'attempt.start', attemptId, plan });
  const e = await w.wait('attempt.exited', attemptId);
  assert.equal(e.exit.code, 0);
  assert.deepEqual(e.parsed[0].normalized.lockfile, { path: 'package-lock.json', sha256: sha(Buffer.from(lock)) });
  const sub = SPAWNED.slice(before).filter((s) => isGitBinary(s.cmd)).map((s) => gitSub(s, w, r.dir)).slice(-3, -1);   // the last call is the package list's size (live preview phase 2)
  assert.deepEqual(sub, [['cat-file', '-s', `${r.commit}:package-lock.json`], ['cat-file', 'blob', `${r.commit}:package-lock.json`]]);
  // Only pip's lockfile: that one is recorded.
  const w2 = await world();
  const req = 'pytest==9.1.1 --hash=sha256:' + 'b'.repeat(64) + '\n';
  const r2 = repo(w2, { 'requirements.txt': req });
  const j2 = newId(NOW); const a2 = newId(NOW);
  w2.send({ op: 'attempt.start', attemptId: a2, plan: buildPlan({ job: { id: j2, projectId: 'p-ledger' }, attempt: { id: a2, n: 1 }, bootId: BOOT,
    recipe: getRecipe('repo.snapshot'), dataHomeRoot: w2.home, workRel: `work/${j2}/1`, logRel: `logs/jobs/${j2}/1.log`, inputs: [], repoPath: r2.dir }) });
  const e2 = await w2.wait('attempt.exited', a2);
  assert.deepEqual(e2.parsed[0].normalized.lockfile, { path: 'requirements.txt', sha256: sha(Buffer.from(req)) });
});

test('D14d (live preview phase 2) repo.snapshot records the package list AT THE COMMIT (hash of the committed bytes, a count of add-ons, never a name); not JSON or not an object is none', async () => {
  const w = await world();
  const pkg = JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.3.0', kleur: '^4.1.5' }, devDependencies: { esbuild: '^0.20.0' } }, null, 2) + String.fromCharCode(10);
  const r = repo(w, { 'package.json': pkg });
  fs.writeFileSync(path.join(r.dir, 'package.json'), '{"changed":"in the work tree only"}');
  const jobId = newId(NOW); const attemptId = newId(NOW);
  w.send({ op: 'attempt.start', attemptId, plan: buildPlan({ job: { id: jobId, projectId: 'p-ledger' }, attempt: { id: attemptId, n: 1 }, bootId: BOOT,
    recipe: getRecipe('repo.snapshot'), dataHomeRoot: w.home, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, inputs: [], repoPath: r.dir }) });
  const e = await w.wait('attempt.exited', attemptId);
  assert.equal(e.exit.code, 0);
  assert.deepEqual(e.parsed[0].normalized.manifest, { path: 'package.json', sha256: sha(Buffer.from(pkg)), dependencies: 3 });
  assert.equal(e.parsed[0].normalized.lockfile, null);
  assert.doesNotMatch(JSON.stringify(e.parsed), /left-pad|kleur|esbuild/, 'no add-on name leaves the runner');
  for (const [name, text] of [['not json', 'not json {'], ['an array', '[1,2]']]) {
    const w2 = await world();
    const r2 = repo(w2, { 'package.json': text });
    const j2 = newId(NOW); const a2 = newId(NOW);
    w2.send({ op: 'attempt.start', attemptId: a2, plan: buildPlan({ job: { id: j2, projectId: 'p-ledger' }, attempt: { id: a2, n: 1 }, bootId: BOOT,
      recipe: getRecipe('repo.snapshot'), dataHomeRoot: w2.home, workRel: `work/${j2}/1`, logRel: `logs/jobs/${j2}/1.log`, inputs: [], repoPath: r2.dir }) });
    const e2 = await w2.wait('attempt.exited', a2);
    assert.equal(e2.exit.code, 0, name);
    assert.equal(e2.parsed[0].normalized.manifest, null, name);
  }
});

test('D14c (final review B1) a planted filter driver never runs on the host: archive (smudge) and status (clean) write no marker; the tar is still produced, with the committed bytes', async () => {
  const w = await world();
  const r = repo(w, { 'a.txt': 'committed text\n', '.gitattributes': '* filter=evil\n' });
  const marker = path.join(w.dir, 'filter-ran.txt');
  const shMarker = marker.split('\\').join('/');
  gitOk(r.dir, ['config', 'filter.evil.smudge', `echo smudge >> "${shMarker}"; cat`]);
  gitOk(r.dir, ['config', 'filter.evil.clean', `echo clean >> "${shMarker}"; cat`]);
  gitOk(r.dir, ['config', 'filter.evil.required', 'true']);
  // The control: plain git does run the planted driver (the test would see a marker if Nexus did not switch it off).
  // Deterministic: git status runs the clean filter only for an entry it must compare by content. A size change is
  // "modified" from the stat alone, so the work-tree edit keeps the committed size and gets an mtime far from the index
  // entry's: the stat is dirty but not decisive, and git must clean the file to compare it, whatever the clock granularity.
  const edited = 'COMMITTED TEXT\n';
  assert.equal(edited.length, 'committed text\n'.length);
  fs.writeFileSync(path.join(r.dir, 'a.txt'), edited);
  const past = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(path.join(r.dir, 'a.txt'), past, past);
  const ctl = cp.spawnSync('git', ['status', '--porcelain'], { cwd: r.dir, encoding: 'utf8', windowsHide: true });
  assert.equal(ctl.status, 0, ctl.stderr);
  assert.ok(fs.existsSync(marker), 'the planted driver runs under plain git (control)');
  fs.rmSync(marker);
  // Staging (git archive) and the snapshot (git status) through the runner: no marker.
  const plan = toolPlan(w, { repoPath: r.dir, inputs: [{ versionId: 'V1', slot: 'suite', contentHash: 'x', storage: { kind: 'git', commit: r.commit },
    metadata: { framework: 'mocha', files: ['test/a.test.js'] } }] });
  const p = await start(w, plan);
  assert.equal(p.preflight.ok, true);
  const tar = fs.readFileSync(path.join(plan.workDir, 'in', 'src.tar'));
  assert.ok(tar.includes(Buffer.from('committed text\n')), 'the tar holds the committed bytes');
  const jobId = newId(NOW); const attemptId = newId(NOW);
  w.send({ op: 'attempt.start', attemptId, plan: buildPlan({ job: { id: jobId, projectId: 'p-ledger' }, attempt: { id: attemptId, n: 1 }, bootId: BOOT,
    recipe: getRecipe('repo.snapshot'), dataHomeRoot: w.home, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, inputs: [], repoPath: r.dir }) });
  const e = await w.wait('attempt.exited', attemptId);
  assert.equal(e.exit.code, 0); assert.equal(e.parsed[0].normalized.dirty, true);
  assert.equal(fs.existsSync(marker), false, 'no filter driver ran on the host');
});

test('D15 sde.app.assemble reads only nexus.app.json at the commit and refuses one over 16 KiB without reading it', async () => {
  const w = await world();
  const manifest = { version: 1, profile: 'sde-node', run: ['node', 'src/server.js'], port: 3000, healthPath: '/health' };
  const r = repo(w, { 'nexus.app.json': JSON.stringify(manifest), 'other.txt': 'never read' });
  const mk = (commit) => {
    const jobId = newId(NOW); const attemptId = newId(NOW);
    return buildPlan({ job: { id: jobId, projectId: 'p-ledger' }, attempt: { id: attemptId, n: 1 }, bootId: BOOT, recipe: getRecipe('sde.app.assemble'),
      dataHomeRoot: w.home, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`,
      inputs: [{ versionId: 'B', slot: 'build', contentHash: 'x', storage: { kind: 'tree' }, metadata: { commit } }], repoPath: r.dir });
  };
  const plan = mk(r.commit);
  const before = SPAWNED.length;
  w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  const e = await w.wait('attempt.exited', plan.attemptId);
  assert.deepEqual(SPAWNED.slice(before).filter((s) => isGitBinary(s.cmd)).map((s) => gitSub(s, w, r.dir)),
    [['cat-file', '-s', `${r.commit}:nexus.app.json`], ['show', `${r.commit}:nexus.app.json`]]);
  assert.deepEqual(e.parsed[0].normalized, { manifest });
  assert.equal(e.parsed[0].parser, 'app-manifest');

  fs.writeFileSync(path.join(r.dir, 'nexus.app.json'), JSON.stringify({ ...manifest, pad: 'p'.repeat(17 * 1024) }));
  gitOk(r.dir, ['commit', '-qam', 'big']);
  const big = mk(gitOk(r.dir, ['rev-parse', 'HEAD']));
  const b0 = SPAWNED.length;
  w.send({ op: 'attempt.start', attemptId: big.attemptId, plan: big });
  const e2 = await w.wait('attempt.exited', big.attemptId);
  assert.equal(e2.exit.code, 1); assert.deepEqual(e2.parsed, []);
  assert.deepEqual(SPAWNED.slice(b0).filter((s) => isGitBinary(s.cmd)).map((s) => gitSub(s, w, r.dir)[0]), ['cat-file'], 'never read');
});

// ---------- D16-D17: dev deployments and egress ----------

function servicePlan(w) {
  const jobId = newId(NOW); const attemptId = newId(NOW);
  return buildPlan({ job: { id: jobId, projectId: 'p-ledger' }, attempt: { id: attemptId, n: 1 }, bootId: BOOT, recipe: getRecipe('sde.preview.start'),
    profile: PROFILE, imageId: IMAGE, dataHomeRoot: w.home, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, inputs: [], repoPath: null,
    service: { deploymentId: newId(NOW), manifest: { profile: 'sde-node', run: ['node', 'server.js'], port: 3000, healthPath: '/health' }, forwarder: FWD,
      forwarderImageId: FWD_IMAGE, files: [], lifetimeMs: 2 * 3600_000 } });
}

test('D16 service: internal and publish networks with labels; the app on service-internal; the forwarder publishes 127.0.0.1:<port>:8080 only; probes arrive as service.health', async () => {
  const probes = [];
  const w = await world({ profiles: [PROFILE, FWD], pickPort: () => 50001, probeHttp: async (port, p) => { probes.push([port, p]); return { status: 200, ms: 4, bodySha256: 'a'.repeat(64) }; } });
  const plan = servicePlan(w);
  const p = await start(w, plan);
  assert.equal(p.preflight.ok, true, p.preflight.problems.join('; '));
  assert.equal(p.hostPort, 50001);
  const nets = w.driver.callsOf('createNetwork').map((c) => [c.args[0], c.args[2].internal, c.args[1]['nexus.home'], c.args[1]['nexus.attempt']]);
  assert.deepEqual(nets, [[plan.networks.internal, true, w.label, plan.attemptId], [plan.networks.publish, false, w.label, plan.attemptId]]);
  const creates = w.driver.callsOf('create');
  assert.deepEqual(creates[0].args[0].network, { mode: 'service-internal', network: plan.networks.internal });
  assert.equal(creates[0].args[1].alias, 'app');
  const fwdSpec = creates[1].args[0];
  assert.deepEqual(fwdSpec.publish, { hostIp: '127.0.0.1', hostPort: 50001, containerPort: 8080 });
  const argv = createArgv(fwdSpec);
  assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '-p'), ['127.0.0.1:50001:8080/tcp']);
  assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '--network'), [plan.networks.internal, plan.networks.publish]);
  assert.ok(!createArgv(creates[0].args[0], { alias: 'app' }).includes('-p'));
  await w.advance(plan.health.intervalMs);
  const sh = await w.wait('service.health', plan.attemptId);
  assert.deepEqual([sh.status, sh.ms, sh.container], [200, 4, 'running']);
  assert.deepEqual(probes[0], [50001, '/health']);
});

function egressPlan(w) {
  const jobId = newId(NOW); const attemptId = newId(NOW);
  return buildPlan({ job: { id: jobId, projectId: 'p-ledger' }, attempt: { id: attemptId, n: 1 }, bootId: BOOT, recipe: getRecipe('sde.deps.node'),
    profile: PROFILE, imageId: IMAGE, dataHomeRoot: w.home, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, inputs: [], repoPath: null,
    approval: { id: 'AP1', job_id: jobId, status: 'approved', consumed_at: NOW, consumed_by_job_id: jobId, consumed_by_attempt_n: 1 },
    egressProxy: { profile: PROFILE, imageId: IMAGE } });
}

test('D17 egress-approved without an approval id, or with one main did not consume for this attempt, is refused network_not_approved', async () => {
  const w = await world();
  const mk = () => egressPlan(w);
  const noId = mk(); noId.container.network = { ...noId.container.network, approvalId: '' };
  const other = mk(); other.approval = { ...other.approval, id: 'AP2' };
  const otherJob = mk(); otherJob.approval = { ...otherJob.approval, jobId: newId(NOW) };
  const missing = mk(); delete missing.approval;
  for (const plan of [noId, other, otherJob, missing]) {
    w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
    assert.equal((await w.wait('attempt.refused', plan.attemptId)).reason, 'network_not_approved');
  }
  assert.equal(w.driver.callsOf('create').length, 0);
  const ok = mk();
  const p = await start(w, ok);
  assert.equal(p.preflight.ok, true, p.preflight.problems.join('; '));
  // B2a stabilization (constraint 5): the install's network is INTERNAL (no route out); only the proxy joins the outbound bridge.
  const nets = w.driver.callsOf('createNetwork').map((c) => [c.args[0], c.args[2].internal, c.args[1]['nexus.home'], c.args[1]['nexus.attempt']]);
  assert.deepEqual(nets, [[`nexus-egress-in-${ok.jobId}`, true, w.label, ok.attemptId], [`nexus-egress-out-${ok.jobId}`, false, w.label, ok.attemptId]]);
});

test('D17b an approved install: the install and the proxy are both preflighted before either starts; the proxy starts first and must listen; its decisions become egress events; it stops when the install exits', async () => {
  const w = await world();
  const plan = egressPlan(w);
  const p = await start(w, plan);
  assert.equal(p.preflight.ok, true, p.preflight.problems.join('; '));
  const creates = w.driver.callsOf('create').map((c) => c.args[0]);
  assert.deepEqual(creates.map((s) => [s.labels['nexus.kind'], s.network.mode]), [['tool', 'egress-approved'], ['egress-proxy', 'egress-proxy']]);
  const [installId, proxyId] = [...w.driver.containers.keys()];
  const ops = w.driver.calls.filter((c) => ['create', 'preflight', 'start'].includes(c.op)).map((c) => `${c.op}:${c.args[0] === installId || c.args[0]?.labels?.['nexus.kind'] === 'tool' ? 'install' : 'proxy'}`);
  assert.deepEqual(ops, ['create:install', 'create:proxy', 'preflight:install', 'preflight:proxy', 'start:proxy', 'start:install']);
  // The proxy's decisions: each one an `egress` event (main's own parser accepts it) and an attempt-log line.
  w.driver.emit(proxyId, 'stdout', 'nexus-egress {"decision":"allowed","host":"registry.npmjs.org","port":443,"reason":"allowed","address":"104.16.0.35"}\n'
    + 'nexus-egress {"decision":"refused","host":"host.docker.internal","port":443,"reason":"host_not_allowed"}\nnexus-egress {"decision":"refused","host":"169.254.1');
  w.driver.emit(proxyId, 'stdout', '69.254","port":80,"reason":"ip_literal"}\nnot a decision\n');
  await until(() => w.of('attempt.event', plan.attemptId).filter((m) => m.event.t === 'egress').length === 3, 'three egress events');
  const ev = w.of('attempt.event', plan.attemptId).filter((m) => m.event.t === 'egress').map((m) => m.event);
  assert.deepEqual(ev.map((e) => [e.decision, e.host, e.port, e.reason]), [['allowed', 'registry.npmjs.org', 443, 'allowed'],
    ['refused', 'host.docker.internal', 443, 'host_not_allowed'], ['refused', '169.254.169.254', 80, 'ip_literal']]);
  for (const m of w.of('attempt.event', plan.attemptId)) assert.ok(parseRunnerMessage(m), JSON.stringify(m));
  // The install exits: the proxy is stopped before the exit is reported.
  outFile(plan, 'lock.sha256', 'a'.repeat(64) + '\n');
  w.driver.exitContainer(installId, { code: 0 });
  const e = await w.wait('attempt.exited', plan.attemptId);
  assert.equal(e.exit.code, 0);
  assert.equal(w.driver.containers.get(proxyId).state, 'exited', 'the proxy was stopped');
  assert.ok(w.driver.calls.findIndex((c) => c.op === 'stop' && c.args[0] === proxyId) >= 0);
  const log = fs.readFileSync(plan.logPath, 'utf8');
  assert.match(log, /egress allowed registry\.npmjs\.org:443/); assert.match(log, /egress refused host\.docker\.internal:443 \(host_not_allowed\)/);
  assert.match(log, /egress proxy: not a decision/);
  // Release removes both containers and both networks.
  w.send({ op: 'attempt.release', attemptId: plan.attemptId });
  await until(() => w.driver.containers.size === 0 && w.driver.networks.size === 0, 'everything removed');
});

test('D17c the proxy fails closed: a proxy that never listens fails the attempt before the install starts; a proxy preflight problem removes both, starts neither; a tampered topology is refused', async () => {
  const w = await world({ fake: { proxyReady: false } });
  const plan = egressPlan(w);
  w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  await until(() => w.driver.callsOf('start').length === 1, 'the proxy started');
  await w.advance(PROXY_READY_MS);
  const f = await w.wait('fault', plan.attemptId);
  assert.equal(f.failureClass, 'docker_error'); assert.match(f.message, /egress proxy did not start/);
  assert.equal(w.driver.callsOf('start').length, 1, 'the install never started');
  // Preflight of the proxy fails (its alias missing): both are removed, neither starts, main hears limits_not_applied's report.
  const w2 = await world({ fake: { mutateInspect: (rec, spec) => { if (spec.network.mode === 'egress-proxy') for (const n of Object.values(rec[0].NetworkSettings.Networks)) n.Aliases = null; return rec; } } });
  const p2 = egressPlan(w2);
  const r2 = await start(w2, p2);
  assert.equal(r2.preflight.ok, false);
  assert.ok(r2.preflight.problems.some((x) => /^egress proxy: network endpoint .* aliases/.test(x)), r2.preflight.problems.join('; '));
  assert.equal(w2.driver.callsOf('start').length, 0);
  assert.equal(w2.driver.containers.size, 0, 'both removed');
  // A plan whose proxy carries another allow-list (a test-only pinned entry, an extra host) never reaches Docker.
  const w3 = await world();
  for (const allow of ['registry.npmjs.org:443=127.0.0.1', 'registry.npmjs.org:443,evil.example:443']) {
    const p3 = egressPlan(w3); p3.egressProxy.container.env.NEXUS_EGRESS_ALLOW = allow;
    w3.send({ op: 'attempt.start', attemptId: p3.attemptId, plan: p3 });
    const r3 = await w3.wait('attempt.refused', p3.attemptId);
    assert.equal(r3.reason, 'network_not_approved'); assert.match(r3.detail, /allow-list/);
  }
  assert.equal(w3.driver.callsOf('create').length, 0);
});

// ---------- D20-D24: images, blobs, GC, shutdown, no Docker ----------

function fakeDockerCli(o = {}) {
  const runs = [];
  const res = (x) => ({ code: 0, signal: null, stdout: '', stderr: '', stdoutBytes: 0, truncated: false, timedOut: false, aborted: false, error: null, ...x });
  return { runs, binary: async () => 'C:\\fake\\docker.exe', async run(argv, opts = {}) {
    runs.push({ argv: [...argv], opts });
    if (argv[0] === 'build') {
      o.onBuild?.(argv);
      for (const l of o.progress ?? []) opts.onStderr?.(Buffer.from(`${l}\n`));
      if (o.hang) await new Promise((r) => { if (opts.signal?.aborted) r(); else opts.signal?.addEventListener('abort', r, { once: true }); });
      if (opts.signal?.aborted) return res({ code: null, aborted: true });
      return res({ code: o.buildCode ?? 0, stderr: o.buildErr ?? '' });
    }
    if (argv[0] === 'image' && argv[1] === 'inspect') return res({ stdout: JSON.stringify([{ Id: 'sha256:' + 'c'.repeat(64), Size: 12345 }]) });
    return res({ code: 1 });
  } };
}
function imagesDir(w) {
  const d = path.join(w.dir, 'images');
  fs.mkdirSync(path.join(d, 'sde-node'), { recursive: true }); fs.mkdirSync(path.join(d, 'common'), { recursive: true });
  fs.writeFileSync(path.join(d, 'sde-node', 'Dockerfile'), 'FROM scratch\n'); fs.writeFileSync(path.join(d, 'common', 'nexus-entry'), '#!/bin/sh\n');
  // Outside the hashed context: a root .dockerignore and another profile's file must never reach a build.
  fs.writeFileSync(path.join(d, '.dockerignore'), 'common\n');
  fs.mkdirSync(path.join(d, 'sde-python'), { recursive: true }); fs.writeFileSync(path.join(d, 'sde-python', 'Dockerfile'), 'FROM scratch\n');
  return d;
}

test('D20 image build: argv carries both labels and the infra/images context; progress events; cancel kills the CLI and reports cancelled; one build per profile', async () => {
  const sent = [];
  const listAll = (d) => fs.readdirSync(d, { recursive: true }).map(String).map((x) => x.split(path.sep).join('/')).sort();
  const cli = fakeDockerCli({ progress: ['#1 [internal] load build definition', '#5 [2/4] RUN npm ci sk-ant-api03-abcdefghijklmnopqrstuv'],
    onBuild: (argv) => sent.push({ dir: argv[argv.length - 1], files: listAll(argv[argv.length - 1]) }) });
  const base = await world();
  const dir = imagesDir(base);
  const w = await world({ docker: cli, imagesDir: dir });
  const ctx = await contextSha256(fsp, dir, 'sde-node');
  const buildId = newId(NOW);
  w.send({ op: 'image.build.start', buildId, profile: 'sde-node', approvalId: newId(NOW), contextSha256: ctx });
  const done = await w.wait('image.build.done');
  assert.deepEqual(done, { op: 'image.build.done', buildId, outcome: 'succeeded', imageId: 'sha256:' + 'c'.repeat(64), sizeBytes: 12345 });
  const b = cli.runs.find((r) => r.argv[0] === 'build').argv;
  assert.ok(b.includes('nexus.profile=sde-node') && b.includes(`nexus.context-sha256=${ctx}`));
  // Fix round 1 (13): the context sent is exactly the hashed one, assembled under the data home, removed afterwards.
  const ctxDir = path.join(w.home, 'work', '.image-context', buildId);
  assert.equal(b[b.length - 1], ctxDir); assert.equal(b[b.indexOf('--file') + 1], path.join(ctxDir, 'sde-node', 'Dockerfile'));
  assert.deepEqual(sent[0].files, ['common', 'common/nexus-entry', 'sde-node', 'sde-node/Dockerfile'], 'no .dockerignore, no other profile');
  assert.equal(fs.existsSync(ctxDir), false, 'the assembled context is removed');
  const progress = w.of('image.build.progress');
  assert.ok(progress.length >= 2);
  assert.doesNotMatch(JSON.stringify(progress), /sk-ant-api03/);
  assert.ok(fs.existsSync(path.join(w.home, 'logs', 'images', `${buildId}.log`)));

  const hang = fakeDockerCli({ hang: true });
  const h2 = await world({ docker: hang, imagesDir: dir });
  const id1 = newId(NOW); const id2 = newId(NOW);
  h2.send({ op: 'image.build.start', buildId: id1, profile: 'sde-node', approvalId: 'A', contextSha256: ctx });
  await until(() => hang.runs.some((r) => r.argv[0] === 'build'), 'build started');
  h2.send({ op: 'image.build.start', buildId: id2, profile: 'sde-node', approvalId: 'A', contextSha256: ctx });
  const second = await until(() => h2.got.some((m) => m.op === 'image.build.done' && m.buildId === id2), 'second refused').then(() => h2.got.find((m) => m.buildId === id2 && m.op === 'image.build.done'));
  assert.equal(second.outcome, 'failed'); assert.match(second.error, /already running/);
  h2.send({ op: 'image.build.cancel', buildId: id1 });
  await until(() => h2.got.some((m) => m.op === 'image.build.done' && m.buildId === id1), 'cancelled');
  assert.equal(h2.got.find((m) => m.op === 'image.build.done' && m.buildId === id1).outcome, 'cancelled');
  assert.equal(hang.runs.find((r) => r.argv[0] === 'build').opts.signal.aborted, true, 'the CLI was killed');

  const stale = await world({ docker: fakeDockerCli(), imagesDir: dir });
  const id3 = newId(NOW);
  stale.send({ op: 'image.build.start', buildId: id3, profile: 'sde-node', approvalId: 'A', contextSha256: 'd'.repeat(64) });
  const d3 = await stale.wait('image.build.done');
  assert.equal(d3.outcome, 'failed'); assert.match(d3.error, /changed since it was approved/);
});

test('D21 blob.verify re-hashes from objects/; a changed or missing object is ok: false', async () => {
  const w = await world();
  const put = (bytes, as) => { const p = path.join(w.home, 'objects', as.slice(0, 2), as.slice(2)); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); };
  const good = sha(Buffer.from('good')); put('good', good);
  const bad = sha(Buffer.from('bad')); put('changed', bad);
  const gone = sha(Buffer.from('gone'));
  for (const s of [good, bad, gone]) w.send({ op: 'blob.verify', sha256: s });
  await until(() => w.of('blob.verified').length === 3, 'verified');
  const by = new Map(w.of('blob.verified').map((m) => [m.sha256, m.ok]));
  assert.deepEqual([by.get(good), by.get(bad), by.get(gone)], [true, false, false]);
});

test('D22 gc.apply deletes only the listed shas, only under objects/, and only finished work folders', async () => {
  const w = await world();
  const shas = ['a', 'b', 'c'].map((x) => sha(Buffer.from(x)));
  for (const s of shas) { const p = path.join(w.home, 'objects', s.slice(0, 2), s.slice(2)); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); }
  const decoy = path.join(w.home, 'work', 'keep.txt'); fs.writeFileSync(decoy, 'keep');
  const jobId = newId(NOW);
  const wd = path.join(w.home, 'work', jobId, '1'); fs.mkdirSync(path.join(wd, 'out'), { recursive: true });
  w.send({ op: 'gc.apply', scanId: newId(NOW), objects: [shas[0], '../../work/keep.txt', shas[2], 'Z'.repeat(64)], workDirs: [{ jobId, attemptN: 1 }, { jobId: '..', attemptN: 1 }] });
  await until(() => w.logs.some((l) => l.includes('gc removed')), 'gc');
  const exists = (s) => fs.existsSync(path.join(w.home, 'objects', s.slice(0, 2), s.slice(2)));
  assert.deepEqual(shas.map(exists), [false, true, false]);
  assert.ok(fs.existsSync(decoy)); assert.ok(!fs.existsSync(wd));
  w.send({ op: 'gc.scan', scanId: newId(NOW), olderThanMs: 0 });
  const scan = await w.wait('gc.result');
  assert.ok(parseRunnerMessage(scan));
});

test('D23 shutdown: dev deployments stopped; tool containers left running (adoptable); no work folder removed', async () => {
  const w = await world({ profiles: [PROFILE, FWD], pickPort: () => 50002, probeHttp: async () => ({ status: 200, ms: 1 }) });
  const tool = toolPlan(w);
  const t = await start(w, tool);
  const svc = servicePlan(w);
  await start(w, svc);
  const svcContainers = w.driver.callsOf('create').filter((c) => c.args[0].labels['nexus.attempt'] === svc.attemptId).length;
  w.send({ op: 'shutdown' });
  await until(() => w.driver.callsOf('kill').length >= svcContainers, 'services stopped');
  assert.equal(w.driver.containers.get(t.containerId).state, 'running');
  assert.ok(!w.driver.calls.some((c) => ['stop', 'kill', 'remove'].includes(c.op) && c.args[0] === t.containerId));
  assert.ok(!w.driver.ops().includes('removeVolume'));
  assert.ok(fs.existsSync(tool.workDir) && fs.existsSync(svc.workDir));
});

test('D24 no docker binary: the probe says missing and nothing throws', async () => {
  const noFs = { stat: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } };
  assert.equal(await resolveDockerBinary(noFs, { PATH: '' }, 'win32'), null);
  const cli = dockerCli(noFs, { PATH: '' });
  const d = new DockerDriver(cli, { now: () => NOW });
  assert.deepEqual(await d.probe(), { docker: 'missing', gpu: { detected: false, usableInContainers: false } });
  assert.deepEqual(await d.imageInfo('sde-node'), { present: false, digestMatches: false });
  const w = await world({ driver: d });
  w.send({ op: 'probe' });
  const r = await w.wait('probe.result');
  assert.equal(r.probe.docker, 'missing');
  assert.deepEqual(r.images, [{ profile: 'sde-node', present: false, digestMatches: false }]);
  // A path with spaces is fine (an argv array); only docker/docker.exe is ever launched.
  const found = await resolveDockerBinary({ stat: async (p) => { if (p === 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe') return { isFile: () => true }; throw Object.assign(new Error('x'), { code: 'ENOENT' }); } },
    { PATH: '', ProgramFiles: 'C:\\Program Files' }, 'win32');
  assert.equal(found, 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe');
});

// ---------- restart recovery (contract lines 8-12) ----------

test('R1 attempt.adopt of a durable exit: re-hashes /out from the data home (no Docker) and reports the recorded exit again', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const p = await start(w, plan);
  outFile(plan, 'junit.xml', JUNIT);
  w.driver.exitContainer(p.containerId, { code: 1, finishedAt: NOW + 5 });
  const first = await w.wait('attempt.exited', plan.attemptId);
  const rec = JSON.parse(fs.readFileSync(path.join(plan.workDir, 'exit.json'), 'utf8'));
  assert.deepEqual(rec.exit, first.exit);
  // A new runner process (restart), Docker down: the adoption needs nothing but the data home.
  const r = await world({ fake: { docker: 'stopped' }, homeDir: w.home });
  r.send({ op: 'attempt.adopt', attemptId: plan.attemptId, containerId: p.containerId, logPath: plan.logPath });
  const again = await r.wait('attempt.exited', plan.attemptId);
  assert.deepEqual(again.exit, first.exit);
  assert.deepEqual(again.outputs, first.outputs);
  assert.deepEqual(again.parsed, first.parsed);
  assert.ok(r.of('attempt.heartbeat', plan.attemptId).every((m) => m.container === 'exited'));
  assert.ok(!r.driver.ops().includes('create') && !r.driver.ops().includes('start'));
});

test('R2 attempt.adopt of a running container reattaches its log and heartbeats; of an exited one finalizes from inspect; release of an attempt not held removes its labelled resources', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const p = await start(w, plan);
  // The same Docker, a new runner process.
  const r = await world({ driver: w.driver, homeDir: w.home });
  r.send({ op: 'attempt.adopt', attemptId: plan.attemptId, containerId: p.containerId, logPath: plan.logPath });
  await until(() => r.of('attempt.heartbeat', plan.attemptId).length > 0, 'heartbeat');
  assert.equal(r.of('attempt.heartbeat', plan.attemptId)[0].container, 'running');
  await until(() => w.driver.callsOf('streamLogs').length >= 2, 'the log is followed again');
  assert.ok(typeof w.driver.callsOf('streamLogs')[1].args[1] === 'number', 'resumed from the last write of the log');
  outFile(plan, 'junit.xml', JUNIT);
  w.driver.exitContainer(p.containerId, { code: 0 });
  const e = await r.wait('attempt.exited', plan.attemptId);
  assert.equal(e.exit.code, 0); assert.equal(e.parsed[0].parser, 'junit');
  // Release from a runner that does not hold the attempt: by label only.
  const fresh = await world({ driver: w.driver, homeDir: w.home });
  fresh.send({ op: 'attempt.release', attemptId: plan.attemptId });
  await until(() => !w.driver.containers.has(p.containerId) && !w.driver.volumes.has(`nexus-ws-${plan.attemptId}`), 'removed by label');
});

test('R3 reconcile.result: exited tool containers report their COMPLETE staged list; Docker down reports every attempt missing; reconcile.remove removes only this install\'s labelled resources', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const p = await start(w, plan);
  outFile(plan, 'junit.xml', JUNIT);
  w.driver.exitContainer(p.containerId, { code: 0, oomKilled: false });
  await w.wait('attempt.exited', plan.attemptId);
  const r = await world({ driver: w.driver, homeDir: w.home });
  r.driver.extra.push({ kind: 'volume', id: 'nexus-deps-sde-node-aaaaaaaaaaaa', name: 'nexus-deps-sde-node-aaaaaaaaaaaa',
    labels: { 'nexus.attempt': newId(NOW), 'nexus.home': r.label, 'nexus.kind': 'deps' } });
  r.send({ op: 'reconcile.list', attempts: [{ attemptId: plan.attemptId, containerId: p.containerId, kind: 'tool' }] });
  const res = await r.wait('reconcile.result');
  const a = res.attempts[0];
  assert.equal(a.container, 'exited'); assert.equal(a.containerId, p.containerId); assert.equal(a.exit.code, 0);
  assert.deepEqual(a.staged.map((s) => s.relPath), ['junit.xml']);
  assert.ok(parseRunnerMessage(res));
  // Removal: an id of this install with an attempt label goes; a deps cache and a foreign resource never do.
  r.driver.extra.push({ kind: 'container', id: 'd'.repeat(64), name: 'nexus-foreign', labels: { 'nexus.attempt': newId(NOW), 'nexus.home': 'ffffffffffffffff' }, state: 'exited' });
  r.send({ op: 'reconcile.remove', resources: [{ kind: 'container', id: p.containerId }, { kind: 'volume', id: 'nexus-deps-sde-node-aaaaaaaaaaaa' },
    { kind: 'container', id: 'd'.repeat(64) }, { kind: 'volume', id: `nexus-ws-${plan.attemptId}` }] });
  await until(() => r.logs.some((l) => l.includes('leftover resources removed')), 'removal');
  assert.match(r.logs.find((l) => l.includes('leftover resources removed')), /removed=2 refused=2/);
  assert.ok(!w.driver.containers.has(p.containerId));
  assert.ok(r.driver.calls.some((c) => c.op === 'stop' && c.args[0] === p.containerId && c.args[1] === 10000));
  assert.ok(!r.driver.calls.some((c) => c.op === 'removeVolume' && c.args[0].startsWith('nexus-deps-')));
  const down = await world({ fake: { docker: 'stopped' } });
  down.send({ op: 'reconcile.list', attempts: [{ attemptId: plan.attemptId, containerId: p.containerId, kind: 'tool' }] });
  const d = await down.wait('reconcile.result');
  assert.deepEqual(d, { op: 'reconcile.result', docker: 'stopped', attempts: [{ attemptId: plan.attemptId, container: 'missing' }], labelled: [] });
});

// ---------- the carried decisions ----------

test('CD1 faults carry attemptId and failureClass together or neither (a runner-wide fault names no attempt)', async () => {
  const w = await world({ fake: { listThrows: true } });
  w.send({ op: 'reconcile.list', attempts: [] });
  const f = await w.wait('fault');
  assert.equal(f.attemptId, undefined); assert.equal(f.failureClass, undefined);
  const faults = ALL.filter((m) => m.op === 'fault');
  assert.ok(faults.length >= 5);
  for (const m of faults) assert.equal(m.attemptId === undefined, m.failureClass === undefined, JSON.stringify(m));
});

test('CD2 heartbeats run from attempt.start through staging, create and preflight; a slow re-hash of an adopted exit heartbeats exited, never missing', async () => {
  const w = await world();
  const release = w.driver.gate('create');
  const plan = toolPlan(w);
  w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  await until(() => w.driver.callsOf('create').length === 1, 'create pending');
  const n0 = w.of('attempt.heartbeat', plan.attemptId).length;
  assert.ok(n0 >= 1);
  await w.advance(HEARTBEAT_MS);
  await w.advance(HEARTBEAT_MS);
  const during = w.of('attempt.heartbeat', plan.attemptId);
  assert.equal(during.length, n0 + 2, 'heartbeats while create is pending');
  assert.ok(during.every((m) => m.container === undefined), 'no container yet');
  release();
  await w.wait('attempt.provisioned', plan.attemptId);

  // Adopted durable exit with a slow /out: heartbeats keep the lease and say `exited`.
  const p2 = toolPlan(w);
  const pp = await start(w, p2);
  outFile(p2, 'junit.xml', JUNIT);
  w.driver.exitContainer(pp.containerId, { code: 0 });
  await w.wait('attempt.exited', p2.attemptId);
  let open; const gate = new Promise((r) => { open = r; });
  const slowFs = { ...fsp, readdir: async (p, ...rest) => { if (String(p).endsWith(`${path.sep}out`)) await gate; return fsp.readdir(p, ...rest); } };
  const r = await world({ fs: slowFs, fake: { docker: 'stopped' }, homeDir: w.home });
  r.send({ op: 'attempt.adopt', attemptId: p2.attemptId, containerId: pp.containerId, logPath: p2.logPath });
  await until(() => r.of('attempt.heartbeat', p2.attemptId).length >= 1, 'first heartbeat');
  await r.advance(HEARTBEAT_MS); await r.advance(HEARTBEAT_MS);
  const hb = r.of('attempt.heartbeat', p2.attemptId);
  assert.ok(hb.length >= 3);
  assert.ok(hb.every((m) => m.container === 'exited'), JSON.stringify(hb.map((m) => m.container)));
  assert.equal(r.of('attempt.exited', p2.attemptId).length, 0, 'still hashing');
  open();
  await r.wait('attempt.exited', p2.attemptId);
});

test('CD3 no upper memory check of its own: a memory limit above Docker\'s total is still created with --memory = --memory-swap', async () => {
  const w = await world({ fake: { memoryBytes: 8 * GIB } });
  const plan = toolPlan(w, { limits: { memoryMb: 65536 } });
  const p = await start(w, plan);
  assert.equal(p.preflight.ok, true);
  assert.equal(w.driver.callsOf('create')[0].args[0].limits.memoryMb, 65536);
  const argv = createArgv(plan.container);
  assert.equal(argv[argv.indexOf('--memory') + 1], '65536m'); assert.equal(argv[argv.indexOf('--memory-swap') + 1], '65536m');
});

test('CD4 the GC lock: an object never lands while gc.apply deletes, and gc.apply waits for a landing in flight', async () => {
  let openRename; const renameGate = new Promise((r) => { openRename = r; });
  const order = [];
  const f = { ...fsp,
    rename: async (a, b) => {
      if (!String(b).includes(`${path.sep}objects${path.sep}`)) return fsp.rename(a, b);
      order.push('rename:start'); await renameGate; order.push('rename:end'); return fsp.rename(a, b);
    },
    unlink: async (p) => { if (String(p).includes(`objects${path.sep}`) && !String(p).includes(`tmp${path.sep}`)) order.push('gc:unlink'); return fsp.unlink(p); } };
  const w = await world({ fs: f });
  const victim = sha(Buffer.from('victim'));
  const vp = path.join(w.home, 'objects', victim.slice(0, 2), victim.slice(2));
  fs.mkdirSync(path.dirname(vp), { recursive: true }); fs.writeFileSync(vp, 'victim');
  const plan = toolPlan(w);
  const p = await start(w, plan);
  outFile(plan, 'junit.xml', JUNIT);
  w.driver.exitContainer(p.containerId, { code: 0 });
  await until(() => order.includes('rename:start'), 'landing in flight');
  w.send({ op: 'gc.apply', scanId: newId(NOW), objects: [victim], workDirs: [] });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!order.includes('gc:unlink'), 'GC waits for the landing');
  openRename();
  await until(() => order.includes('gc:unlink'), 'gc ran');
  assert.ok(order.indexOf('rename:end') < order.indexOf('gc:unlink'));
  // The other way: a landing waits while GC holds the store.
  const { ObjectStore } = loadTs('src/runner/objectStore.ts');
  const { HomePaths } = loadTs('src/runner/paths.ts');
  const store = new ObjectStore(new HomePaths(w.home), fsp, async () => {});
  let releaseGc; const gcHeld = store.withGc(() => new Promise((r) => { releaseGc = r; }));
  let landed = false;
  const landing = store.withLanding(async () => { landed = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(landed, false, 'no landing while GC holds the store');
  releaseGc(); await gcHeld; await landing;
  assert.equal(landed, true);
});

test('CD5 docker invocation: --mount (never -v), --runtime runc, --restart no, no --rm, --pull never, env exactly the plan, the pinned image, every label on containers, volumes and networks', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const argv = createArgv(plan.container);
  assert.equal(argv[0], 'create');
  assert.ok(!argv.includes('-v') && !argv.includes('--volume') && !argv.includes('--rm') && !argv.includes('--privileged'));
  for (const [flag, value] of [['--runtime', 'runc'], ['--restart', 'no'], ['--pull', 'never'], ['--user', '10001:10001'], ['--cap-drop', 'ALL'],
    ['--security-opt', 'no-new-privileges'], ['--network', 'none'], ['--pids-limit', '512']]) assert.equal(argv[argv.indexOf(flag) + 1], value, flag);
  assert.ok(argv.includes('--read-only'));
  const mounts = argv.filter((a, i) => argv[i - 1] === '--mount');
  assert.equal(mounts.length, plan.container.mounts.length);
  assert.ok(mounts.every((m) => /^type=(bind|volume),/.test(m)));
  assert.ok(mounts.some((m) => m.endsWith('dst=/in,readonly')));
  const env = argv.filter((a, i) => argv[i - 1] === '--env');
  assert.deepEqual(env.sort(), Object.entries(plan.container.env).map(([k, v]) => `${k}=${v}`).sort());
  const labels = Object.fromEntries(argv.filter((a, i) => argv[i - 1] === '--label').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  for (const k of ['nexus.attempt', 'nexus.boot', 'nexus.home', 'nexus.job', 'nexus.project', 'nexus.kind']) assert.equal(labels[k], plan.container.labels[k], k);
  assert.equal(labels['nexus.home'], w.label);
  const imgAt = argv.indexOf(plan.container.image.ref);
  // Fix round 1 (6): a locally built image is created by its local id (preflight pins the same id).
  assert.equal(plan.container.image.ref, IMAGE); assert.equal(plan.container.image.id, IMAGE);
  assert.deepEqual(argv.slice(imgAt + 1), plan.container.argv);
  // Volumes and networks the runner makes carry the plan's resource labels (with nexus.home from hello).
  await start(w, plan);
  const vol = w.driver.callsOf('createVolume')[0];
  assert.deepEqual(vol.args[1], plan.resourceLabels);
  assert.equal(vol.args[1]['nexus.home'], homeLabel(w.home));
  assert.throws(() => createArgv({ ...plan.container, image: { ...plan.container.image, ref: 'nexus/sde-node:latest' } }), /digest-pinned/);
  assert.equal(classifyDockerError('Bind for 127.0.0.1:50001 failed: port is already allocated'), 'port_conflict');
});

test('CD6 preflight: named-volume Mode accepts "", z, Z, rw, ro; none has no endpoint on a created container; the forwarder must join both of its networks', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const base = () => inspectFor(plan.container, 'a'.repeat(64), plan.container.name);
  for (const mode of ['', 'z', 'Z', 'rw']) {
    const rec = base(); rec[0].Mounts.find((m) => m.Type === 'volume').Mode = mode;
    assert.deepEqual(comparePreflight(plan.container, rec).problems, [], mode);
  }
  const ro = base(); const v = ro[0].Mounts.find((m) => m.Type === 'volume'); v.Mode = 'ro';
  assert.ok(comparePreflight(plan.container, ro).problems.some((p) => /contradicts/.test(p)), 'ro on a writable volume');
  const shared = base(); shared[0].Mounts.find((m) => m.Type === 'volume').Mode = 'shared';
  assert.ok(comparePreflight(plan.container, shared).problems.some((p) => /mode/.test(p)));
  const bindZ = base(); bindZ[0].Mounts.find((m) => m.Type === 'bind').Mode = 'z';
  assert.ok(comparePreflight(plan.container, bindZ).problems.some((p) => /mode/.test(p)), 'z is for volumes only');
  const ep = base(); ep[0].NetworkSettings.Networks.none.EndpointID = 'e'.repeat(64);
  assert.ok(comparePreflight(plan.container, ep).problems.some((p) => /network none has an endpoint/.test(p)));
  const ip = base(); ip[0].NetworkSettings.Networks.none.IPAddress = '172.17.0.2';
  assert.ok(comparePreflight(plan.container, ip).problems.some((p) => /endpoint/.test(p)));
  const svc = servicePlan(w);
  const fwd = { ...svc.forwarder, publish: { ...svc.forwarder.publish, hostPort: 50003 } };
  const both = inspectFor(fwd, 'b'.repeat(64), fwd.name);
  assert.deepEqual(comparePreflight(fwd, both).problems, []);
  const one = inspectFor(fwd, 'b'.repeat(64), fwd.name); delete one[0].NetworkSettings.Networks[svc.networks.publish];
  assert.ok(comparePreflight(fwd, one).problems.some((p) => p.includes(`${svc.networks.publish} is not attached`)));
  const extra = inspectFor(svc.app, 'c'.repeat(64), svc.app.name); extra[0].NetworkSettings.Networks[svc.networks.publish] = {};
  assert.ok(comparePreflight(svc.app, extra).problems.some((p) => /is attached, expected only/.test(p)), 'the app never joins the publish network');
});

test('CD7 image builds: a second concurrent build of a profile is refused; image.build.cancel kills the CLI and reports cancelled (see D20)', async () => {
  const D20 = ALL.filter((m) => m.op === 'image.build.done');
  assert.ok(D20.some((m) => m.outcome === 'cancelled'));
  assert.ok(D20.some((m) => m.outcome === 'failed' && /already running/.test(m.error)));
});

test('CD9 hostPort is picked from 49152-65535 and Docker\'s "port is already allocated" is retried once with another port', async () => {
  const ports = [50010, 50011];
  const w = await world({ profiles: [PROFILE, FWD], pickPort: () => ports.shift(), probeHttp: async () => ({ status: 200, ms: 1 }),
    fake: { startFaults: [null, 'Error response from daemon: Bind for 127.0.0.1:50010 failed: port is already allocated'] } });
  const plan = servicePlan(w);
  const p = await start(w, plan);
  assert.equal(p.preflight.ok, true, p.preflight.problems.join('; '));
  assert.equal(p.hostPort, 50011);
  const fwdCreates = w.driver.callsOf('create').filter((c) => c.args[0].profile === 'nexus-fwd');
  assert.deepEqual(fwdCreates.map((c) => c.args[0].publish.hostPort), [50010, 50011]);
  const { pickPort } = loadTs('src/runner/service.ts');
  for (let i = 0; i < 200; i++) { const x = pickPort(new Set()); assert.ok(x >= EPHEMERAL_PORT_MIN && x <= EPHEMERAL_PORT_MAX); }
  assert.equal(pickPort(new Set([50000]), (() => { const s = [50000, 50001]; return () => s.shift(); })()), 50001);
  // A second conflict is not retried again.
  const twice = await world({ profiles: [PROFILE, FWD], pickPort: () => 50020, fake: { startFaults: [null, 'port is already allocated', 'port is already allocated'] } });
  const plan2 = servicePlan(twice);
  twice.send({ op: 'attempt.start', attemptId: plan2.attemptId, plan: plan2 });
  const f = await twice.wait('fault', plan2.attemptId);
  assert.equal(f.failureClass, 'docker_error');
});

test('CD11 secrets: Docker\'s error text and parser results never carry a secret-shaped value out of the runner', async () => {
  const w = await world({ fake: { createFaults: ['Error: failed with token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 Bearer sk-ant-api03-zzzzzzzzzzzzzzzz'] } });
  const plan = toolPlan(w);
  w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  const f = await w.wait('fault', plan.attemptId);
  assert.doesNotMatch(f.message, /ghp_abcdef|sk-ant-api03/);
  assert.match(f.message, /\[redacted\]/);
  const s = await world();
  const p2 = toolPlan(s);
  const pp = await start(s, p2);
  outFile(p2, 'junit.xml', '<testsuites tests="1"><testsuite name="s" tests="1"><testcase classname="c" name="uses sk-ant-api03-abcdefghijklmnopqrstuvwxyz"/></testsuite></testsuites>');
  s.driver.exitContainer(pp.containerId, { code: 0 });
  const e = await s.wait('attempt.exited', p2.attemptId);
  assert.deepEqual(e.parsed, [], 'the secret-shaped result is withheld');
  // Never silently: the outputs are refused with a reason main can show (fix round 1, item 9).
  assert.equal(e.outputError, 'secret_in_report'); assert.equal(e.outputErrorEntry, 'junit.xml'); assert.deepEqual(e.outputs, []);
  assert.doesNotMatch(JSON.stringify(s.got), /sk-ant-api03-abcdef/);
  assert.doesNotMatch(JSON.stringify(ALL), /sk-ant-api03-[a-z]{6}|ghp_[a-z]{6}/);
});

// ---------- Fix round 1 (review of 0e7b8ce9) ----------

/** A repository with a planted git: git.exe (another program), git.cmd and git.bat (each would write a marker). */
function plantedRepo(w) {
  const r = repo(w, { 'a.txt': 'a', 'nexus.app.json': JSON.stringify({ version: 1, profile: 'sde-node', run: ['node', 's.js'], port: 3000, healthPath: '/' }) });
  const marker = path.join(r.dir, 'planted-ran.txt');
  if (process.platform === 'win32') {
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), path.join(r.dir, 'git.exe'));
    for (const ext of ['cmd', 'bat']) fs.writeFileSync(path.join(r.dir, `git.${ext}`), `@echo off\r\necho planted> "%~dp0planted-ran.txt"\r\n`);
  } else {
    fs.writeFileSync(path.join(r.dir, 'git'), `#!/bin/sh\necho planted > "${marker}"\n`, { mode: 0o755 });
  }
  return { ...r, marker };
}

test('FR1 (critical) a git planted in the repository never runs: staging, snapshot and assembly use the resolved git, from the data home, with -C', async () => {
  const w = await world();
  const r = plantedRepo(w);
  const before = SPAWNED.length;
  const plan = toolPlan(w, { repoPath: r.dir, inputs: [{ versionId: 'V1', slot: 'suite', contentHash: 'x', storage: { kind: 'git', commit: r.commit },
    metadata: { framework: 'node-test', files: ['test/a.test.js'] } }] });
  const p = await start(w, plan);
  assert.equal(p.preflight.ok, true, 'the checkout was staged by the real git');
  const tar = fs.readFileSync(path.join(plan.workDir, 'in', 'src.tar'));
  assert.ok(tar.length > 0 && tar.includes(Buffer.from('a.txt')), 'a real tar of the commit');
  const engine = (recipe, inputs) => {
    const jobId = newId(NOW); const attemptId = newId(NOW);
    return buildPlan({ job: { id: jobId, projectId: 'p-ledger' }, attempt: { id: attemptId, n: 1 }, bootId: BOOT, recipe: getRecipe(recipe),
      dataHomeRoot: w.home, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, inputs, repoPath: r.dir });
  };
  const snap = engine('repo.snapshot', []);
  w.send({ op: 'attempt.start', attemptId: snap.attemptId, plan: snap });
  const e1 = await w.wait('attempt.exited', snap.attemptId);
  assert.equal(e1.exit.code, 0); assert.equal(e1.parsed[0].normalized.commit, r.commit);
  const asm = engine('sde.app.assemble', [{ versionId: 'B', slot: 'build', contentHash: 'x', storage: { kind: 'tree' }, metadata: { commit: r.commit } }]);
  w.send({ op: 'attempt.start', attemptId: asm.attemptId, plan: asm });
  const e2 = await w.wait('attempt.exited', asm.attemptId);
  assert.equal(e2.exit.code, 0); assert.equal(e2.parsed[0].normalized.manifest.port, 3000);
  const spawned = SPAWNED.slice(before);
  assert.ok(spawned.length >= 7);
  for (const s of spawned) gitSub(s, w, r.dir);
  assert.equal(fs.existsSync(r.marker), false, 'no planted program ran');
});

test('FR1b a resolved git inside the repository itself is refused (bad_plan), nothing runs', async () => {
  const w = await world();
  const r = repo(w, { 'a.txt': 'a' });
  const inside = path.join(r.dir, process.platform === 'win32' ? 'git.exe' : 'git');
  const { RunnerCore: Core } = loadTs('src/runner/core.ts');
  const { port1, port2 } = new MessageChannel();
  const got = []; port1.on('message', (m) => got.push(m));
  const clock = new FakeClock(NOW);
  const core = new Core(port2, { driver: new FakeSandboxDriver(), now: () => clock.now, fs: fsp, timers: clock, log: () => {}, freeBytes: async () => 100 * GIB,
    sleep: async () => {}, resolveGit: async () => inside });
  WORLDS.push({ core, port1 });
  port1.postMessage({ op: 'hello', bootId: BOOT, dataHome: w.home, home: w.label, profiles: [PROFILE] });
  await until(() => got.some((m) => m.op === 'ready'), 'ready');
  const plan = toolPlan(w, { repoPath: r.dir, inputs: [{ versionId: 'V1', slot: 'suite', contentHash: 'x', storage: { kind: 'git', commit: r.commit },
    metadata: { framework: 'node-test', files: ['test/a.test.js'] } }] });
  const n0 = SPAWNED.length;
  port1.postMessage({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  await until(() => got.some((m) => m.op === 'attempt.refused'), 'refused');
  const ref = got.find((m) => m.op === 'attempt.refused');
  assert.equal(ref.reason, 'bad_plan'); assert.match(ref.detail, /inside the repository/);
  assert.equal(SPAWNED.length, n0, 'nothing spawned');
});

test('FR2 docker wait: a failed wait is never exit 0; not found -> thrown (missing); still running -> waits again; garbage output -> the inspected exit', async () => {
  const base = { signal: null, stdoutBytes: 0, truncated: false, timedOut: false, aborted: false, error: null };
  const script = (steps) => {
    const calls = [];
    return { calls, binary: async () => 'C:/x/docker.exe', run: async (argv) => {
      calls.push(argv[0]);
      const next = steps[argv[0]].shift();
      return { ...base, ...next };
    } };
  };
  const inspectOf = (status, code) => JSON.stringify([{ Id: 'a'.repeat(64), RestartCount: 0, State: { Status: status, ExitCode: code, OOMKilled: false, FinishedAt: '2026-10-09T10:00:00Z' } }]);
  // DW1: wait fails (container removed mid-run) and inspect says not found -> thrown, never code 0.
  const dw1 = script({ wait: [{ code: 1, stdout: '', stderr: 'Error response from daemon: No such container: abc' }],
    inspect: [{ code: 1, stdout: '[]', stderr: 'Error: No such container: abc' }] });
  await assert.rejects(new DockerDriver(dw1, { now: () => 42 }).wait('a'.repeat(64), new AbortController().signal), /No such container|gone/);
  // DW2: the daemon is down -> thrown.
  const dw2 = script({ wait: [{ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }], inspect: [{ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }] });
  await assert.rejects(new DockerDriver(dw2, { now: () => 42 }).wait('a'.repeat(64), new AbortController().signal));
  // DW3: the wait is cut short while the container still runs -> it waits again, then reads the recorded exit 7.
  const dw3 = script({ wait: [{ code: 1, stdout: '', stderr: 'unexpected EOF' }, { code: 0, stdout: '7\n', stderr: '' }],
    inspect: [{ code: 0, stdout: inspectOf('running', 0) }, { code: 0, stdout: inspectOf('exited', 7) }] });
  const e3 = await new DockerDriver(dw3, { now: () => 42 }).wait('a'.repeat(64), new AbortController().signal);
  assert.equal(e3.code, 7); assert.deepEqual(dw3.calls, ['wait', 'inspect', 'wait', 'inspect']);
  // DW4: wait "succeeds" with garbage -> the inspected exit (3), never 0.
  const dw4 = script({ wait: [{ code: 0, stdout: 'hello', stderr: '' }], inspect: [{ code: 0, stdout: inspectOf('exited', 3) }] });
  assert.equal((await new DockerDriver(dw4, { now: () => 42 }).wait('a'.repeat(64), new AbortController().signal)).code, 3);
  // DW5: it never ends -> bounded retries, then thrown.
  const forever = { calls: [], binary: async () => 'C:/x/docker.exe', run: async (argv) => { forever.calls.push(argv[0]);
    return argv[0] === 'wait' ? { ...base, code: 1, stdout: '', stderr: 'EOF' } : { ...base, code: 0, stdout: inspectOf('running', 0) }; } };
  await assert.rejects(new DockerDriver(forever, { now: () => 42 }).wait('a'.repeat(64), new AbortController().signal), /could not be read/);
  assert.equal(forever.calls.filter((c) => c === 'wait').length, 5);
});

test('FR3 logs: a secret straddling the frame split (5 cut points), a ghp_ token straddling it, and a key crossing the forced flush of an unterminated line are all stored redacted', async () => {
  const w = await world();
  const KEY = 'sk-ant-api03-' + 'A1b2C3d4E5'.repeat(9) + 'xyzAA';
  const GHP = 'ghp_' + 'Z9y8X7w6V5'.repeat(3) + 'abcdef';
  const { LogWriter } = loadTs('src/runner/logs.ts');
  let k = 0;
  const run = async (writes) => {
    const file = path.join(w.home, 'logs', 'jobs', `fr3-${++k}.log`);
    const lw = new LogWriter(fsp, w.home, file, { now: () => 1 });
    await lw.open();
    for (const [s, t] of writes) lw.write(s, t);
    await lw.close();
    const text = fs.readFileSync(file, 'utf8');
    for (const l of text.trimEnd().split('\n')) JSON.parse(l);
    return text;
  };
  for (const off of [4, 8, 13, 20, 40]) {
    const t = await run([['stdout', 'x'.repeat(16384 - off) + ' ' + KEY + ' tail\n']]);
    assert.doesNotMatch(t, /A1b2C3d4E5A1b2/, `L2 cut ${off + 1} chars into the key`);
    assert.match(t, /\[redacted\]/);
  }
  assert.doesNotMatch(await run([['stdout', 'x'.repeat(16384 - 10) + ' ' + GHP + '\n']]), /Z9y8X7w6V5Z9/, 'L3');
  const chunkA = 'y'.repeat(16380) + ' sk-ant-api03-A1b2C3';
  const chunkB = KEY.slice('sk-ant-api03-A1b2C3'.length) + ' rest\n';
  assert.doesNotMatch(await run([['stdout', chunkA], ['stdout', chunkB]]), /d4E5A1b2C3d4/, 'L4');
  // A long unterminated line is still flushed in bounded pieces, and a bearer phrase near the cut stays together.
  const t5 = await run([['stdout', 'z'.repeat(20000) + ' Authorization: Bearer abc.def.ghi-jkl-mno'], ['stdout', 'pqr more\n']]);
  assert.doesNotMatch(t5, /abc\.def\.ghi|jkl-mnopqr/);
  assert.ok(t5.trimEnd().split('\n').every((l) => JSON.parse(l).text.length <= 16384));
});

test('FR5 a container that vanishes: heartbeat missing, the attempt settled, and NOTHING removed (volume, networks, /out) until attempt.release', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const p = await start(w, plan);
  outFile(plan, 'partial.txt', 'kept');
  await w.driver.remove(p.containerId);
  await until(() => w.of('attempt.heartbeat', plan.attemptId).some((m) => m.container === 'missing'), 'a missing heartbeat');
  await w.advance(HEARTBEAT_MS);
  assert.equal(w.driver.callsOf('removeVolume').length, 0, 'the workspace volume stays');
  assert.ok(w.core.held().includes(plan.attemptId), 'the attempt is still held');
  assert.ok(fs.existsSync(path.join(plan.workDir, 'out', 'partial.txt')));
  assert.equal(w.of('attempt.exited', plan.attemptId).length, 0);
  w.send({ op: 'attempt.release', attemptId: plan.attemptId });
  await until(() => w.driver.callsOf('removeVolume').length === 1, 'removed at release');
  assert.ok(fs.existsSync(path.join(plan.workDir, 'out', 'partial.txt')), 'the work folder stays even then');
});

test('FR6 a locally built image is created by its local id (preflight accepts it); a pulled one by repository@digest; tags and look-alikes refused', async () => {
  const w = await world();
  const plan = toolPlan(w);
  assert.equal(plan.container.image.ref, IMAGE);
  const p = await start(w, plan);
  assert.equal(p.preflight.ok, true, p.preflight.problems.join('; '));
  assert.equal(createArgv(plan.container).includes(IMAGE), true);
  const { imageRef } = loadTs('src/main/nexus/exec/planBuilder.ts');
  assert.equal(imageRef({ ...PROFILE, image: { ...PROFILE.image, source: 'pulled' } }, IMAGE), `nexus/sde-node@${PROFILE.image.digest}`);
  assert.equal(imageRef(PROFILE, IMAGE), IMAGE);
  for (const ref of ['nexus/sde-node:latest', 'localhost:5000/xsha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64)]) {
    assert.throws(() => createArgv({ ...plan.container, image: { ...plan.container.image, ref } }), /digest-pinned/, ref);
  }
  const svc = servicePlan(w);
  assert.equal(svc.app.image.ref, IMAGE); assert.equal(svc.forwarder.image.ref, FWD_IMAGE);
});

test('FR7 image.build.start re-sent for a build that runs is idempotent (no answer for it)', async () => {
  const base = await world();
  const dir = imagesDir(base);
  const hang = fakeDockerCli({ hang: true });
  const w = await world({ docker: hang, imagesDir: dir });
  const ctx = await contextSha256(fsp, dir, 'sde-node');
  const id = newId(NOW);
  w.send({ op: 'image.build.start', buildId: id, profile: 'sde-node', approvalId: 'A', contextSha256: ctx });
  await until(() => hang.runs.some((r) => r.argv[0] === 'build'), 'build started');
  w.send({ op: 'image.build.start', buildId: id, profile: 'sde-node', approvalId: 'A', contextSha256: ctx });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.of('image.build.done').length, 0, 'the running build is not answered "already running"');
  assert.equal(hang.runs.filter((r) => r.argv[0] === 'build').length, 1);
  w.send({ op: 'image.build.cancel', buildId: id });
  const d = await w.wait('image.build.done');
  assert.equal(d.outcome, 'cancelled');
});

test('FR10 file system failures while staging are infrastructure faults: ENOSPC -> disk_full, EACCES -> io_error (never docker_error or bad_plan)', async () => {
  for (const [code, cls] of [['ENOSPC', 'disk_full'], ['EACCES', 'io_error']]) {
    const failing = { ...fsp, mkdir: async (p, ...r) => { if (String(p).endsWith(`${path.sep}in`)) { const e = new Error(code); e.code = code; throw e; } return fsp.mkdir(p, ...r); } };
    const w = await world({ fs: failing });
    const plan = toolPlan(w);
    w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
    const f = await w.wait('fault', plan.attemptId);
    assert.equal(f.failureClass, cls, code);
    assert.equal(w.of('attempt.refused', plan.attemptId).length, 0);
  }
  const { failureClassOf } = loadTs('src/runner/core.ts');
  assert.equal(failureClassOf(Object.assign(new Error('x'), { code: 'ENOSPC' })), 'disk_full');
  assert.equal(failureClassOf(Object.assign(new Error('x'), { code: 'EIO' })), 'io_error');
  assert.equal(failureClassOf(new Error('plain')), 'docker_error');
});

test('FR11 a deps volume must be nexus-deps-<profile>-<12 hex>: anything looser is refused', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const loose = 'nexus-deps-x';
  plan.staging.depsVolume = { name: loose, readOnly: true };
  plan.container.mounts.push({ kind: 'deps', hostPath: loose, containerPath: '/workspace/node_modules', readOnly: true });
  w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  const r = await w.wait('attempt.refused', plan.attemptId);
  assert.equal(r.reason, 'bad_plan');
  assert.equal(w.driver.callsOf('createVolume').length, 0);
  const { DEPS_VOLUME_RE } = loadTs('src/runner/sandbox/dockerDriver.ts');
  assert.ok(DEPS_VOLUME_RE.test('nexus-deps-sde-node-0123456789ab'));
  for (const bad of ['nexus-deps-sde-node-0123', 'nexus-deps-evil-0123456789ab', `nexus-ws-${newId(NOW)}`, 'nexus-deps-sde-node-0123456789ab-x']) assert.ok(!DEPS_VOLUME_RE.test(bad), bad);
  const good = toolPlan(w);
  good.container.mounts.push({ kind: 'deps', hostPath: 'nexus-deps-evil', containerPath: '/deps', readOnly: true });
  assert.throws(() => createArgv(good.container), /dependency cache/);
});

test('FR12 attempt.adopt checks the container\'s labels: one that is not this attempt\'s (or this install\'s) is never removed', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const p = await start(w, plan);
  w.driver.exitContainer(p.containerId, { code: 0 });
  await w.wait('attempt.exited', plan.attemptId);
  const foreign = 'f'.repeat(64);
  w.driver.containers.set(foreign, { id: foreign, name: 'user-thing', spec: plan.container, labels: { 'nexus.home': 'ffffffffffffffff', 'nexus.attempt': plan.attemptId },
    state: 'exited', exit: { code: 0, oomKilled: false, finishedAt: 1 }, waiters: [], logs: [], logEnd: [] });
  const r = await world({ driver: w.driver, homeDir: w.home });
  r.send({ op: 'attempt.adopt', attemptId: plan.attemptId, containerId: foreign, logPath: plan.logPath });
  await r.wait('attempt.exited', plan.attemptId);
  r.send({ op: 'attempt.release', attemptId: plan.attemptId });
  await until(() => !r.core.held().includes(plan.attemptId), 'released');
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(w.driver.containers.has(foreign), 'the foreign container is untouched');
  assert.ok(!w.driver.calls.some((c) => ['remove', 'stop', 'kill'].includes(c.op) && c.args[0] === foreign));
  assert.ok(!w.driver.containers.has(p.containerId), 'the attempt\'s own labelled container is removed by label');
});

test('FR17 /out walks read folders one entry at a time and stop past the bound (millions of entries never fill memory)', async () => {
  const w = await world();
  const dir = path.join(w.home, 'work', 'fr17', 'out');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
  let read = 0;
  const counting = { ...fsp, opendir: async (p, ...r) => {
    const d = await fsp.opendir(p, ...r);
    const it = d[Symbol.asyncIterator].bind(d);
    return { close: () => d.close(), [Symbol.asyncIterator]: () => { const i = it(); return { next: async () => { const x = await i.next(); if (!x.done) read++; return x; }, return: async () => { await d.close().catch(() => {}); return { done: true }; } }; } };
  }, readdir: async () => { throw new Error('readdir is not used'); } };
  const { scanOut, outBytes, entryBudget } = loadTs('src/runner/outputs.ts');
  const r = await scanOut(counting, dir, { maxFiles: 3, maxBytes: 2 ** 20 });
  assert.equal(r.ok, false); assert.equal(r.code, 'too_many_files');
  assert.ok(read <= entryBudget(3) + 1, `read ${read} entries`);
  read = 0;
  await outBytes(counting, dir, 2 ** 30, 3);
  assert.ok(read <= entryBudget(3) + 1, `outBytes read ${read}`);
  fs.rmSync(path.join(w.home, 'work', 'fr17'), { recursive: true, force: true });
});

// ---------- Fix round 2 (review of 0b56e6ba) ----------

/** An in-memory RunnerFs for LogWriter alone (the sweep below writes 2,800 logs; real files would take minutes on Windows). */
function memLogFs() {
  const store = { text: '' };
  return { store, fs: {
    lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    mkdir: async () => {},
    open: async () => { store.text = ''; return { stat: async () => ({ size: 0 }), write: async (s) => { store.text += s; }, close: async () => {} }; }
  } };
}

test('D10 (sweep, review round 2) an unterminated minified-JSON line past 16 KiB: a ghp_ or sk-ant token (and a password, URL credential or bearer phrase) at every one of 700 offsets around the forced cut is stored redacted, never split', async () => {
  const { LogWriter, forcedCut, isTokenChar, MAX_TOKEN_RUN, OVERLAP_CHARS } = loadTs('src/runner/logs.ts');
  const GHP = 'ghp_' + 'Z9y8X7w6V5'.repeat(3) + 'abcdef';
  const KEY = 'sk-ant-api03-' + 'A1b2C3d4E5'.repeat(9) + 'xyzAA';
  // The reviewer's sweep (r2-logsweep.cjs) for the two tokens, plus phrase-shaped secrets the redactor only sees whole.
  const cases = [
    ['ghp_', (s) => `"a":"${'w'.repeat(s)}","token":"${GHP}","b":"${'q'.repeat(1000 - s)}"`, /Z9y8X7w6V5|abcdef/],
    ['sk-ant', (s) => `"a":"${'w'.repeat(s)}","token":"${KEY}","b":"${'q'.repeat(1000 - s)}"`, /A1b2C3d4E5/],
    ['"password":"..."', (s) => `"a":"${'w'.repeat(s)}","password":"hunter2-Secret-Value","b":"${'q'.repeat(1000 - s)}"`, /hunter2|Secret-Value/],
    ['URL credentials', (s) => `"a":"${'w'.repeat(s)}","u":"https://alice:s3cr3tPassw0rd@db.example.com/x","b":"${'q'.repeat(1000 - s)}"`, /s3cr3tPassw0rd|alice/],
    ['Bearer <value>', (s) => `"a":"${'w'.repeat(s)}","h":"Bearer abcDEF123.ghiJKL456-mno","b":"${'q'.repeat(1000 - s)}"`, /abcDEF123|ghiJKL456/]
  ];
  for (const [name, second, leak] of cases) {
    const leaks = [];
    for (let shift = 0; shift < 700; shift++) {
      const m = memLogFs();
      const lw = new LogWriter(m.fs, '/mem', '/mem/logs/a.log', { now: () => 1 });
      await lw.open();
      lw.write('stdout', '{"k":"' + 'v'.repeat(16000 - 6) + '",');
      lw.write('stdout', second(shift));
      await lw.close();
      const frames = m.store.text.trimEnd().split('\n').map((l) => JSON.parse(l).text);
      assert.ok(frames.length >= 2 && frames.every((t) => t.length <= 16384), `${name} @${shift}: bounded frames`);
      if (leak.test(m.store.text)) leaks.push(shift);
    }
    assert.deepEqual(leaks, [], `${name}: no offset leaks`);
  }
  // The cut lands on a separator (never inside a token run), keeps OVERLAP_CHARS back, and falls back to the limit only
  // after more than MAX_TOKEN_RUN token characters.
  const p = '{"k":"' + 'v'.repeat(16000) + '","token":"' + GHP + '","b":"' + 'q'.repeat(600) + '"';
  const c = forcedCut(p);
  assert.ok(c <= p.length - OVERLAP_CHARS && !isTokenChar(p.charCodeAt(c)), 'a separator');
  assert.ok(p.slice(0, c).includes(GHP), 'the token stays whole on one side');
  const run = 'y'.repeat(20000);
  assert.equal(forcedCut(run), run.length - OVERLAP_CHARS, 'one long run: the limit');
  const farSep = 'a '.repeat(10) + 'z'.repeat(MAX_TOKEN_RUN + 600);
  assert.equal(forcedCut(farSep), farSep.length - OVERLAP_CHARS, 'a separator farther than MAX_TOKEN_RUN back is not used');
  for (const ch of '":,;& \t{}[]') assert.equal(isTokenChar(ch.charCodeAt(0)), false, ch);
  for (const ch of 'aZ09._~+/=-') assert.equal(isTokenChar(ch.charCodeAt(0)), true, ch);
});

/** A DockerDriver whose `docker wait` is scripted (DW5: always cut short; DW6: prints 0 while inspect says running). */
function scriptedWait(kind) {
  const base = { signal: null, stdoutBytes: 0, truncated: false, timedOut: false, aborted: false, error: null };
  const running = JSON.stringify([{ Id: 'a'.repeat(64), RestartCount: 0, State: { Status: 'running', ExitCode: 0, OOMKilled: false, FinishedAt: '0001-01-01T00:00:00Z' } }]);
  const cli = { calls: [], binary: async () => 'C:/x/docker.exe', run: async (argv) => {
    cli.calls.push(argv[0]);
    if (argv[0] === 'wait') return kind === 'DW5' ? { ...base, code: 1, stdout: '', stderr: 'error during connect: EOF' } : { ...base, code: 0, stdout: '0\n', stderr: '' };
    return { ...base, code: 0, stdout: running, stderr: '' };
  } };
  return { cli, driver: new DockerDriver(cli, { now: () => 42 }) };
}

test('FR-R2-4 a wait cut short WAIT_RETRIES times on a container still running (DW5, DW6) is a docker_error fault, never missing; nothing is removed before release', async () => {
  const { WAIT_RETRIES } = loadTs('src/runner/sandbox/dockerDriver.ts');
  for (const kind of ['DW5', 'DW6']) {
    // The driver alone: never an exit code (DW6 printed 0, but the container runs), WAIT_RETRIES waits, then thrown.
    const s = scriptedWait(kind);
    await assert.rejects(s.driver.wait('a'.repeat(64), new AbortController().signal), /could not be read/, kind);
    assert.equal(s.cli.calls.filter((c) => c === 'wait').length, WAIT_RETRIES, kind);
    // The runner: the fake container keeps running, `wait` is the real driver's over the scripted CLI.
    const w = await world();
    const live = scriptedWait(kind);
    w.driver.wait = (id, signal) => { w.driver.rec('wait', id); return live.driver.wait(id, signal); };
    const plan = toolPlan(w);
    const p = await start(w, plan);
    outFile(plan, 'partial.txt', 'kept');
    const f = await w.wait('fault', plan.attemptId, `${kind}: the docker_error fault`);
    assert.equal(f.failureClass, 'docker_error', kind);
    assert.match(f.message, /could not be read/);
    assert.equal(w.driver.containers.get(p.containerId).state, 'running', 'Docker still reports it running');
    await w.advance(HEARTBEAT_MS);
    assert.ok(!w.of('attempt.heartbeat', plan.attemptId).some((m) => m.container === 'missing'), `${kind}: never missing`);
    assert.equal(w.of('attempt.exited', plan.attemptId).length, 0, 'no invented exit');
    assert.equal(w.driver.callsOf('remove').length + w.driver.callsOf('removeVolume').length, 0, 'nothing removed before release');
    assert.ok(w.core.held().includes(plan.attemptId));
    assert.ok(fs.existsSync(path.join(plan.workDir, 'out', 'partial.txt')));
    // Main fails the attempt docker_error and releases it: the container and the workspace volume go then.
    w.send({ op: 'attempt.release', attemptId: plan.attemptId });
    await until(() => w.driver.callsOf('removeVolume').length === 1 && !w.driver.containers.has(p.containerId), `${kind}: removed at release`);
    assert.ok(fs.existsSync(path.join(plan.workDir, 'out', 'partial.txt')), 'the work folder stays even then');
  }
});

test('FR-R2-2 no git installed: a tool plan with a source and a git engine are refused git_missing before anything is made (the job waits, never fails)', async () => {
  const w = await world({ resolveGit: async () => null });
  const r = repo(w, { 'a.txt': 'a', 'nexus.app.json': '{}' });
  const n0 = SPAWNED.length;
  const plan = toolPlan(w, { repoPath: r.dir, inputs: [{ versionId: 'V1', slot: 'suite', contentHash: 'x', storage: { kind: 'git', commit: r.commit },
    metadata: { framework: 'node-test', files: ['test/a.test.js'] } }] });
  w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  const ref = await w.wait('attempt.refused', plan.attemptId);
  assert.equal(ref.reason, 'git_missing'); assert.match(ref.detail, /git is not installed/);
  assert.equal(w.of('fault', plan.attemptId).length, 0, 'not a fault: a setup refusal');
  assert.equal(w.of('attempt.provisioned', plan.attemptId).length, 0);
  assert.equal(w.driver.callsOf('create').length + w.driver.callsOf('createVolume').length, 0, 'nothing made');
  for (const recipe of ['repo.snapshot', 'sde.app.assemble']) {
    const jobId = newId(NOW); const attemptId = newId(NOW);
    const inputs = recipe === 'repo.snapshot' ? [] : [{ versionId: 'B', slot: 'build', contentHash: 'x', storage: { kind: 'tree' }, metadata: { commit: r.commit } }];
    const eng = buildPlan({ job: { id: jobId, projectId: 'p-ledger' }, attempt: { id: attemptId, n: 1 }, bootId: BOOT, recipe: getRecipe(recipe),
      dataHomeRoot: w.home, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, inputs, repoPath: r.dir });
    w.send({ op: 'attempt.start', attemptId, plan: eng });
    const e = await w.wait('attempt.refused', attemptId, `${recipe} refused`);
    assert.equal(e.reason, 'git_missing', recipe);
    assert.equal(w.of('attempt.provisioned', attemptId).length + w.of('attempt.exited', attemptId).length, 0, `${recipe}: nothing reported as run`);
  }
  assert.equal(SPAWNED.length, n0, 'nothing spawned');
  // The resolver is asked again on the next attempt: a git installed meanwhile is found without a restart.
  const { GitRunner, GitError } = loadTs('src/runner/git.ts');
  const { resolveGitBinary } = loadTs('src/main/gitBinary.ts');
  const real = await resolveGitBinary(fsp);
  assert.ok(real, 'this machine has git');
  let calls = 0;
  const later = new GitRunner({ cwd: w.home, resolve: async () => (++calls === 1 ? null : real) });
  await assert.rejects(later.snapshot(r.dir), (e) => e instanceof GitError && e.kind === 'git_missing');
  assert.equal((await later.snapshot(r.dir)).commit, r.commit, 'found on the next call');
  assert.equal(calls, 2, 'a miss is not kept; a found binary is');
});

// ---------- B2a Task 12 fix round 1: nothing in /out is ever written or read through a link (items 1 and 6) ----------

const { parseJunit } = loadTs('src/runner/parsers/junit.ts');
const PER_FILE_INPUTS = (files) => [{ versionId: 'V1', slot: 'suite', contentHash: 'x', storage: { kind: 'inline' }, metadata: { framework: 'node-test', files } }];
const REPORT = (name) => `<testsuites><testcase name="${name}" classname="test"/><!-- tests 1 --></testsuites>\n`;
/** A file outside the data home standing for a host file a container must never reach. */
function hostFile(w, rel, text) { const f = path.join(w.dir, 'host', ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; }
/** A file symlink (Developer Mode or admin on Windows); false when this machine cannot make one. */
function fileLink(target, at) {
  try { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, 'file'); return true; } catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES') return false; throw e; }
}
/** The `nexus` lines of an attempt log. */
const nexusLines = (plan) => fs.readFileSync(plan.logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((f) => f.stream === 'nexus').map((f) => f.text);
const NO_LINKS = 'file symlinks need Developer Mode (or admin) on this Windows machine';

test('RV1a (item 1) the merge writes its temporary file in the work folder, never in /out: a link planted at the old temporary name changes no host file, and junit.xml never becomes a link', async (t) => {
  const w = await world();
  const plan = toolPlan(w, { inputs: PER_FILE_INPUTS(['test/a.test.js']) });
  assert.ok(plan.perFileJunit, 'a per-file plan');
  const p = await start(w, plan);
  const host = hostFile(w, 'host.txt', 'HOST BYTES\n');
  outFile(plan, 'junit/0001.xml', REPORT('a1'));
  if (!fileLink(host, path.join(plan.workDir, 'out', '.nexus-junit-merge.tmp'))) return t.skip(NO_LINKS);
  w.driver.exitContainer(p.containerId, { code: 0 });
  const e = await w.wait('attempt.exited', plan.attemptId);
  assert.equal(fs.readFileSync(host, 'utf8'), 'HOST BYTES\n', 'the host file is unchanged');
  const j = fs.lstatSync(path.join(plan.workDir, 'out', 'junit.xml'));
  assert.ok(j.isFile() && !j.isSymbolicLink(), 'junit.xml is the merged plain file, not the planted link');
  assert.ok(parseJunit(fs.readFileSync(path.join(plan.workDir, 'out', 'junit.xml'))).ok);
  assert.ok(fs.lstatSync(path.join(plan.workDir, 'out', '.nexus-junit-merge.tmp')).isSymbolicLink(), 'the planted link was never renamed or written through');
  // The planted link is still in /out, so the collection refuses the outputs: nothing of the attempt is trusted.
  assert.deepEqual([e.outputError, e.outputErrorEntry, e.parsed], ['symlink', '.nexus-junit-merge.tmp', []]);
  assert.deepEqual(fs.readdirSync(plan.workDir).filter((n) => /junit-merge/.test(n)), [], 'no temporary file is left in the work folder');
});

test('RV1b (item 1) a junit.xml that is a link is refused: never written through, never replaced; no host file changes', async (t) => {
  const w = await world();
  const plan = toolPlan(w, { inputs: PER_FILE_INPUTS(['test/a.test.js']) });
  const p = await start(w, plan);
  const host = hostFile(w, 'target.xml', 'HOST REPORT\n');
  outFile(plan, 'junit/0001.xml', REPORT('a1'));
  if (!fileLink(host, path.join(plan.workDir, 'out', 'junit.xml'))) return t.skip(NO_LINKS);
  w.driver.exitContainer(p.containerId, { code: 0 });
  const e = await w.wait('attempt.exited', plan.attemptId);
  assert.equal(fs.readFileSync(host, 'utf8'), 'HOST REPORT\n', 'the host file is unchanged');
  assert.ok(fs.lstatSync(path.join(plan.workDir, 'out', 'junit.xml')).isSymbolicLink(), 'the link is left as it was (never replaced)');
  assert.deepEqual([e.outputError, e.outputErrorEntry, e.parsed], ['symlink', 'junit.xml', []]);
  assert.ok(nexusLines(plan).some((l) => /junit\.xml is a link; nothing was merged/.test(l)), nexusLines(plan).join(' | '));
  // A second hard link at junit.xml is refused the same way (a rename would leave the other name holding the bytes).
  const w2 = await world();
  const plan2 = toolPlan(w2, { inputs: PER_FILE_INPUTS(['test/a.test.js']) });
  const p2 = await start(w2, plan2);
  const host2 = hostFile(w2, 'hard.xml', 'HOST HARD\n');
  outFile(plan2, 'junit/0001.xml', REPORT('a1'));
  fs.linkSync(host2, path.join(plan2.workDir, 'out', 'junit.xml'));
  w2.driver.exitContainer(p2.containerId, { code: 0 });
  const e2 = await w2.wait('attempt.exited', plan2.attemptId);
  assert.equal(fs.readFileSync(host2, 'utf8'), 'HOST HARD\n');
  assert.equal(fs.statSync(path.join(plan2.workDir, 'out', 'junit.xml')).nlink, 2, 'never replaced');
  assert.deepEqual([e2.outputError, e2.outputErrorEntry, e2.parsed], ['hardlink', 'junit.xml', []]);
});

test('RV1c (item 1) a junit/ folder that is a link (a junction) is never read: nothing behind it is opened, the container\'s own junit.xml is not taken, the outputs are refused', async () => {
  const s = spyFs();
  const w = await world({ fs: s.f });
  const plan = toolPlan(w, { inputs: PER_FILE_INPUTS(['test/a.test.js']) });
  const p = await start(w, plan);
  const hostDir = path.dirname(hostFile(w, 'reports/0001.xml', REPORT('from the host')));
  fs.symlinkSync(hostDir, path.join(plan.workDir, 'out', 'junit'), 'junction');
  outFile(plan, 'junit.xml', JUNIT);
  w.driver.exitContainer(p.containerId, { code: 0 });
  const e = await w.wait('attempt.exited', plan.attemptId);
  assert.ok(!s.opened.some((x) => x.startsWith(path.resolve(hostDir))), 'nothing behind the junction was opened');
  assert.equal(fs.readFileSync(path.join(hostDir, '0001.xml'), 'utf8'), REPORT('from the host'));
  assert.equal(fs.existsSync(path.join(plan.workDir, 'out', 'junit.xml')), false, 'the container-written junit.xml was removed (item 6)');
  assert.deepEqual([e.outputError, e.outputErrorEntry, e.parsed], ['symlink', 'junit', []]);
});

test('RV1d (item 1) a per-file report that is a link or a second hard link is never read (no case from it); no host file changes; the outputs are refused', async (t) => {
  const s = spyFs();
  const w = await world({ fs: s.f });
  const plan = toolPlan(w, { inputs: PER_FILE_INPUTS(['test/a.test.js', 'test/b.test.js']) });
  const p = await start(w, plan);
  const linked = hostFile(w, 'passing.xml', REPORT('would pass'));
  const hard = hostFile(w, 'also-passing.xml', REPORT('would also pass'));
  if (!fileLink(linked, path.join(plan.workDir, 'out', 'junit', '0001.xml'))) return t.skip(NO_LINKS);
  fs.linkSync(hard, path.join(plan.workDir, 'out', 'junit', '0002.xml'));
  w.driver.exitContainer(p.containerId, { code: 0 });
  const e = await w.wait('attempt.exited', plan.attemptId);
  assert.ok(!s.opened.includes(path.resolve(linked)), 'the link\'s target was never opened');
  assert.deepEqual([fs.readFileSync(linked, 'utf8'), fs.readFileSync(hard, 'utf8')], [REPORT('would pass'), REPORT('would also pass')]);
  const lines = nexusLines(plan);
  assert.ok(lines.includes('test/a.test.js: its report is not a plain file') && lines.includes('test/b.test.js: its report is not a plain file'), lines.join(' | '));
  const merged = parseJunit(fs.readFileSync(path.join(plan.workDir, 'out', 'junit.xml')));
  assert.deepEqual(merged.value.cases, [], 'no case came from either');
  assert.equal(e.outputError, 'symlink'); assert.equal(e.outputErrorEntry, 'junit/0001.xml'); assert.deepEqual(e.parsed, []);
});

test('RV1e (item 1, audit) the size guard never counts what a folder swapped for a link points at; readPlainFile refuses a link, a hard link and a file swapped between its lstat and its open', async () => {
  const { outBytes } = loadTs('src/runner/outputs.ts');
  const { readPlainFile } = loadTs('src/runner/paths.ts');
  const dir = h.tmpDir('nx-rv1e-');
  const out = path.join(dir, 'out'); const sub = path.join(out, 'sub'); const elsewhere = path.join(dir, 'elsewhere');
  fs.mkdirSync(sub, { recursive: true }); fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(out, 'own.txt'), Buffer.alloc(10));
  fs.writeFileSync(path.join(elsewhere, 'big.bin'), Buffer.alloc(5000));
  // A container swaps out/sub for a link to `elsewhere` between the guard's lstat of it and its listing.
  let swapped = false;
  const racy = { ...fsp,
    opendir: (d, ...r) => { if (path.resolve(String(d)) === path.resolve(sub)) { swapped = true; return fsp.opendir(elsewhere, ...r); } return fsp.opendir(d, ...r); },
    lstat: async (p) => {
      const rp = path.resolve(String(p));
      if (swapped && rp === path.resolve(sub)) { const st = await fsp.lstat(elsewhere); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isSymbolicLink: () => true, isDirectory: () => false }); }
      if (swapped && rp.startsWith(path.resolve(sub) + path.sep)) return fsp.lstat(path.join(elsewhere, path.basename(rp)));
      return fsp.lstat(p);
    } };
  assert.equal(await outBytes(racy, out, 1e9), 10, 'only /out\'s own bytes are counted');
  assert.equal(swapped, true, 'the swap happened during the walk');
  // readPlainFile
  const f = path.join(dir, 'plain.txt'); fs.writeFileSync(f, 'plain');
  assert.deepEqual(await readPlainFile(fsp, f, 100), { ok: true, bytes: Buffer.from('plain') });
  assert.deepEqual(await readPlainFile(fsp, path.join(dir, 'nope.txt'), 100), { ok: false, why: 'missing' });
  assert.deepEqual(await readPlainFile(fsp, f, 2), { ok: false, why: 'too_large' });
  const hl = path.join(dir, 'second-name.txt'); fs.linkSync(f, hl);
  assert.deepEqual(await readPlainFile(fsp, hl, 100), { ok: false, why: 'hardlink' });
  fs.unlinkSync(hl);
  const j = path.join(dir, 'junction'); fs.symlinkSync(elsewhere, j, 'junction');
  assert.equal((await readPlainFile(fsp, j, 100)).ok, false, 'a junction is never read');
  const other = path.join(dir, 'other.txt'); fs.writeFileSync(other, 'other');
  const swapFs = { ...fsp, open: (p, ...r) => fsp.open(path.resolve(String(p)) === path.resolve(f) ? other : p, ...r) };
  assert.deepEqual(await readPlainFile(swapFs, f, 100), { ok: false, why: 'changed' }, 'a file swapped between the lstat and the open is refused');
});

test('RV1f (item 1, audit) gc.apply removes a finished work folder whose /out holds planted links without following them: what they point at is untouched', async (t) => {
  const w = await world();
  const jobId = newId(NOW);
  const wd = path.join(w.home, 'work', jobId, '1'); fs.mkdirSync(path.join(wd, 'out'), { recursive: true });
  const hostDirFile = hostFile(w, 'keepdir/inside.txt', 'KEEP\n');
  const host = hostFile(w, 'keep.txt', 'KEEP FILE\n');
  fs.symlinkSync(path.dirname(hostDirFile), path.join(wd, 'out', 'dirlink'), 'junction');
  const fileLinked = fileLink(host, path.join(wd, 'out', 'filelink'));
  w.send({ op: 'gc.apply', scanId: newId(NOW), objects: [], workDirs: [{ jobId, attemptN: 1 }] });
  await until(() => w.logs.some((l) => l.includes('gc removed')), 'gc');
  assert.equal(fs.existsSync(wd), false, 'the work folder is gone');
  assert.equal(fs.readFileSync(hostDirFile, 'utf8'), 'KEEP\n', 'the junction\'s target folder and its file are untouched');
  assert.equal(fs.readFileSync(host, 'utf8'), 'KEEP FILE\n');
  if (!fileLinked) t.diagnostic(NO_LINKS);
});

test('RV6 (item 6) a per-file plan never takes a container-written junit.xml: with no junit/ folder (or a junit file instead of a folder) it is removed and no report is parsed', async () => {
  for (const shape of ['none', 'file']) {
    const w = await world();
    const plan = toolPlan(w, { inputs: PER_FILE_INPUTS(['test/a.test.js']) });
    const p = await start(w, plan);
    outFile(plan, 'junit.xml', JUNIT);
    if (shape === 'file') outFile(plan, 'junit', 'not a folder');
    w.driver.exitContainer(p.containerId, { code: 0 });
    const e = await w.wait('attempt.exited', plan.attemptId);
    assert.equal(e.outputError, undefined, shape);
    assert.ok(!e.outputs.some((o) => o.relPath === 'junit.xml'), `${shape}: the container's junit.xml is not an output`);
    assert.deepEqual(e.parsed, [], `${shape}: no report is parsed`);
    assert.equal(fs.existsSync(path.join(plan.workDir, 'out', 'junit.xml')), false, shape);
    const lines = nexusLines(plan);
    // Final review B5: nothing is deleted before release. The container's junit.xml leaves /out (it is still never taken)
    // by a move into the work folder, where it stays byte for byte until the attempt is released.
    assert.ok(lines.some((l) => /junit\.xml is not parsed/.test(l)) && lines.some((l) => /junit\.xml the container wrote was set aside/.test(l)), `${shape}: ${lines.join(' | ')}`);
    assert.deepEqual(fs.readFileSync(path.join(plan.workDir, 'container-junit.xml')), JUNIT, `${shape}: kept outside /out, unchanged`);
  }
  // With its per-file folder, the same plan merges and parses (the merged report, attributed to its file).
  const w = await world();
  const plan = toolPlan(w, { inputs: PER_FILE_INPUTS(['test/a.test.js']) });
  const p = await start(w, plan);
  outFile(plan, 'junit.xml', JUNIT);
  outFile(plan, 'junit/0001.xml', REPORT('a1'));
  w.driver.exitContainer(p.containerId, { code: 0 });
  const e = await w.wait('attempt.exited', plan.attemptId);
  assert.equal(e.parsed[0].parser, 'junit');
  assert.deepEqual(e.parsed[0].normalized.cases.map((c) => [c.file, c.name]), [['test/a.test.js', 'a1']]);
  // Final review B5: the merge never overwrites the container's junit.xml; it was moved to the work folder first.
  assert.deepEqual(fs.readFileSync(path.join(plan.workDir, 'container-junit.xml')), JUNIT);
});

test('RV6b (item 6, recovery) a per-file run that ended while the runner was gone: reconcile merges its reports first, so main judges the merged junit.xml, never the container\'s own', async () => {
  const w = await world();
  /** An attempt whose container exited while no runner watched it: its plan record, its /out, its exited container. */
  const ended = (files) => {
    const plan = toolPlan(w, { inputs: PER_FILE_INPUTS(['test/a.test.js']) });
    fs.mkdirSync(path.join(plan.workDir, 'out'), { recursive: true });
    fs.writeFileSync(path.join(plan.workDir, 'plan.json'), JSON.stringify({ plan }));
    for (const [rel, text] of Object.entries(files)) outFile(plan, rel, text);
    const cid = crypto.randomBytes(32).toString('hex');
    w.driver.extra.push({ kind: 'container', id: cid, name: plan.container.name, state: 'exited', exit: { code: 0, oomKilled: false, finishedAt: NOW },
      labels: { 'nexus.home': w.label, 'nexus.attempt': plan.attemptId, 'nexus.job': plan.jobId, 'nexus.kind': 'tool' } });
    return { plan, cid };
  };
  const merged = ended({ 'junit/0001.xml': REPORT('a1') });
  const unmerged = ended({ 'junit.xml': JUNIT });
  w.send({ op: 'reconcile.list', attempts: [merged, unmerged].map((x) => ({ attemptId: x.plan.attemptId, containerId: x.cid, kind: 'tool' })) });
  const res = await w.wait('reconcile.result');
  const [a, b] = res.attempts;
  assert.equal(a.container, 'exited');
  assert.deepEqual(a.staged.map((s) => s.relPath).sort(), ['junit.xml', 'junit/0001.xml'], 'the merged report is staged (the contract check sees it)');
  const j = parseJunit(fs.readFileSync(path.join(merged.plan.workDir, 'out', 'junit.xml')));
  assert.deepEqual(j.value.cases.map((c) => [c.file, c.name]), [['test/a.test.js', 'a1']]);
  assert.deepEqual(b.staged ?? [], [], 'the container\'s own junit.xml is never staged for a per-file run');
  assert.equal(fs.existsSync(path.join(unmerged.plan.workDir, 'out', 'junit.xml')), false);
  assert.ok(parseRunnerMessage(res));
});

test('RV8 (item 8) the runner refuses a per-file plan naming the step separator (or an option) as a test file', async () => {
  for (const bad of ['--nexus-then', '--require=x.js']) {
    const w = await world();
    const plan = toolPlan(w, { inputs: PER_FILE_INPUTS(['test/a.test.js']) });
    plan.perFileJunit.files.push(bad); plan.container.argv.push(bad);
    w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
    const r = await w.wait('attempt.refused', plan.attemptId);
    assert.deepEqual([r.reason, r.detail], ['bad_plan', 'a per-file test file is not a plain relative path'], bad);
    assert.ok(!w.driver.ops().includes('create'), `${bad}: nothing was created`);
  }
});

// ---------- B2a final fix (backend): B3, B4, carry items 8 and 9 ----------

test('FX1 (final review B3) an adopted running container resumes its log from the LAST FRAME on disk, read before the "picked up again" frame is written: nothing printed while main was closed is skipped', async () => {
  const w = await world();
  const plan = toolPlan(w);
  const p = await start(w, plan);
  await w.advance(1000);
  w.driver.emit(p.containerId, 'stdout', 'printed while the first runner watched\n');
  await until(() => fs.existsSync(plan.logPath) && fs.readFileSync(plan.logPath, 'utf8').includes('first runner watched'), 'the line is written');
  const frames = () => fs.readFileSync(plan.logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const lastTs = frames().at(-1).ts;
  // A new runner process, much later (main was closed meanwhile).
  const r = await world({ driver: w.driver, homeDir: w.home });
  await r.advance(10 * 60_000);
  const n0 = w.driver.callsOf('streamLogs').length;
  r.send({ op: 'attempt.adopt', attemptId: plan.attemptId, containerId: p.containerId, logPath: plan.logPath });
  await until(() => w.driver.callsOf('streamLogs').length > n0, 'the log is followed again');
  const since = w.driver.callsOf('streamLogs').at(-1).args[1];
  assert.equal(since, lastTs, 'docker logs --since the last frame on disk, not the moment of the adoption');
  await until(() => frames().some((f) => f.stream === 'nexus' && /picked up again/.test(f.text)), 'the picked-up frame');
  const picked = frames().find((f) => f.stream === 'nexus' && /picked up again/.test(f.text));
  assert.ok(picked.ts > since, 'the picked-up frame was written after since was read');
  w.driver.exitContainer(p.containerId, { code: 0 });
  outFile(plan, 'junit.xml', JUNIT);
  await r.wait('attempt.exited', plan.attemptId);
});

test('FX2 (final review B4) an /out entry that cannot be read (EACCES on opendir or lstat) refuses the outputs as unreadable_output_entry: the exit is reported, never a lost runner', async () => {
  for (const op of ['opendir', 'lstat']) {
    const deny = (p) => p.split(/[\\/]/).includes('locked');
    const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const wrapped = { ...fsp,
      opendir: async (p, ...rest) => { if (op === 'opendir' && deny(p)) throw eacces(); return fsp.opendir(p, ...rest); },
      lstat: async (p, ...rest) => { if (op === 'lstat' && deny(p)) throw eacces(); return fsp.lstat(p, ...rest); } };
    const w = await world({ fs: wrapped });
    const plan = toolPlan(w);
    const p = await start(w, plan);
    outFile(plan, 'junit.xml', JUNIT);
    outFile(plan, 'locked/inner.txt', 'x');
    w.driver.exitContainer(p.containerId, { code: 0 });
    const e = await w.wait('attempt.exited', plan.attemptId);
    assert.equal(e.outputError, 'unreadable_output_entry', op);
    assert.equal(e.outputErrorEntry, 'locked', op);
    assert.deepEqual(e.outputs, [], `${op}: nothing from /out is trusted`);
    assert.equal(e.exit.code, 0);
    assert.equal(w.of('fault', plan.attemptId).length, 0, `${op}: no fault`);
  }
});

test('FX3 (final batch item 9) the runner refuses a dev deployment whose app argv holds the step separator, before anything is created', async () => {
  const w = await world({ profiles: [PROFILE, FWD], pickPort: () => 50002 });
  const plan = servicePlan(w);
  plan.app.argv = ['node', 'server.js', STEP_SEPARATOR, 'sh'];
  w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  const r = await w.wait('attempt.refused', plan.attemptId);
  assert.deepEqual([r.reason, r.detail], ['bad_plan', 'the app argv holds the step separator']);
  assert.ok(!w.driver.ops().includes('create'), 'nothing was created');
});

test('FX4 (final batch item 8) identity checks compare BigInt file ids: two files whose ids differ only above 2^53 are not taken for one another', async () => {
  const { readPlainFile } = loadTs('src/runner/paths.ts');
  const { sameFile, hashFile } = loadTs('src/runner/objectStore.ts');
  const big = 2n ** 60n;
  assert.equal(Number(big + 1n), Number(big + 2n), 'the two ids are the same Number');
  assert.equal(sameFile({ ino: big + 1n, dev: 1n, size: 3n }, { ino: big + 2n, dev: 1n, size: 3n }), false);
  assert.equal(sameFile({ ino: big + 1n, dev: 1n, size: 3n }, { ino: big + 1n, dev: 1n, size: 3n }), true);
  const dir = h.tmpDir('nx-bigint-');
  const f = path.join(dir, 'a.xml');
  fs.writeFileSync(f, 'abc');
  const withIno = (s, ino) => Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino });
  const swapped = { ...fsp,
    lstat: async (p, o) => { const s = await fsp.lstat(p, o); return o?.bigint ? withIno(s, big + 1n) : s; },
    open: async (...a) => {
      const fh = await fsp.open(...a);
      return { stat: async (o) => { const s = await fh.stat(o); return o?.bigint ? withIno(s, big + 2n) : s; },
        read: (...x) => fh.read(...x), close: () => fh.close(), [Symbol.asyncDispose]: () => fh.close() };
    } };
  assert.deepEqual(await readPlainFile(swapped, f, 1024), { ok: false, why: 'changed' });
  await assert.rejects(hashFile(swapped, f), /changed while it was opened/);
  assert.deepEqual((await readPlainFile(fsp, f, 1024)).ok, true);
});

test('D18 the runner spawned only docker and git, never through a shell', () => {
  assert.ok(SPAWNED.some((s) => isGitBinary(s.cmd)), 'the spy saw the runner\'s git');
  for (const s of SPAWNED) {
    assert.ok(isGitBinary(s.cmd) || /(^|[\\/])docker(\.exe)?$/i.test(s.cmd), `spawned ${s.cmd}`);
    assert.ok(path.isAbsolute(s.cmd), `by its resolved absolute path: ${s.cmd}`);
    assert.notEqual(s.shell, true);
  }
});

test('D19 every outgoing message round-trips through parseRunnerMessage unchanged; attempt.event seq strictly increases per attempt', () => {
  assert.ok(ALL.length > 100);
  for (const m of ALL) assert.deepEqual(parseRunnerMessage(m), m, m.op);
  // Per runner process: a restarted runner numbers from its own clock (above the old one in real time).
  const last = new Map();
  for (const [wn, m] of BY_WORLD.filter(([, x]) => x.op === 'attempt.event')) {
    const k = `${wn}:${m.attemptId}`;
    if (last.has(k)) assert.ok(m.seq > last.get(k), `${k}: ${m.seq} after ${last.get(k)}`);
    last.set(k, m.seq);
  }
});
