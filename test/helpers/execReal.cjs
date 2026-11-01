'use strict';
// The real-Docker world (B2a Task 12; loaded only behind the test:exec gate, test/helpers/execGate.cjs).
// - main: a v9 database in a temp folder, the platform composed as the app composes it (test/helpers/execFakeWorld.cjs
//   openPlatform: real ingest, validation, approvals, deployments, RepoService, main's git, the lock's profiles), and the
//   REAL execution wiring (src/main/nexusExec/execWiring.ts startExecution: the runner host's supervision and restarts,
//   reconcile at every runner ready, the 1 s scheduler tick), with a temp data home: never the app's userData;
// - the runner: a real RunnerCore in a child process (test/helpers/runner-child.cjs) with the Docker driver, killed and
//   restarted by the tests (L3, L13-L15) as a crashed utilityProcess would be;
// - Docker: the user's Docker Desktop and the pinned images built by tools/nexus-prepare-images.cjs (the preflight
//   checked their labels against lock.json).
// Also `runnerHarness()`: a RunnerCore in THIS process over the real Docker driver, for the sandbox tests (K1-K11), which
// hand it plans from main's own plan builder (real recipe specs) with a probe command in place of the recipe argv.
// Everything a test makes is labelled with this world's `nexus.home`; `close()` removes it by label, and L12 checks that
// no other container changed.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { MessageChannel } = require('node:worker_threads');
const h = require('./sqlite.cjs');
const loadTs = require('../load-ts.cjs');
const { openPlatform, addCommon, WORLDS, LOCK, ROOT } = require('./execFakeWorld.cjs');

const { startExecution } = loadTs('src/main/nexusExec/execWiring.ts');
const { homeLabel } = loadTs('src/shared/nexus/homeLabel.ts');
const { RunnerCore } = loadTs('src/runner/core.ts');
const { dockerCli } = loadTs('src/runner/sandbox/dockerCli.ts');
const { DockerDriver } = loadTs('src/runner/sandbox/dockerDriver.ts');
const { buildPlan } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { loadImageProfiles } = loadTs('src/main/nexusExec/profiles.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `docker <args>` (sync, bounded): { code, stdout, stderr }. */
function docker(args, timeoutMs = 60_000) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 2 ** 20 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const dockerJson = (args) => { const r = docker(args); try { return JSON.parse(r.stdout); } catch { return null; } };

/** Every Docker resource labelled with this install's `nexus.home` (containers, volumes, networks). */
function labelled(home, extra = {}) {
  const f = ['--filter', `label=nexus.home=${home}`, ...Object.entries(extra).flatMap(([k, v]) => ['--filter', `label=${k}=${v}`])];
  const ids = (args) => docker(args).stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return { containers: ids(['ps', '-a', '-q', '--no-trunc', ...f]), volumes: ids(['volume', 'ls', '-q', ...f]), networks: ids(['network', 'ls', '-q', ...f]) };
}
function removeLabelled(home) {
  const l = labelled(home);
  if (l.containers.length) docker(['rm', '-f', ...l.containers]);
  if (l.networks.length) docker(['network', 'rm', ...l.networks]);
  if (l.volumes.length) docker(['volume', 'rm', '-f', ...l.volumes]);
}

/** The runner child as the runner host's RunnerChild (src/main/nexusExec/runnerHost.ts). */
function forkRunner(env = {}) {
  const child = fork(path.join(__dirname, 'runner-child.cjs'), [], { execPath: process.execPath, cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  return {
    process: child,
    runnerChild: {
      post(m) { if (!child.connected) throw new Error('the runner channel is closed'); child.send(m); },
      onMessage(fn) { child.on('message', fn); },
      onExit(fn) { child.once('exit', (code) => fn(typeof code === 'number' ? code : null)); },
      onOutput(fn) {
        const lines = (d) => { for (const l of d.toString('utf8').split(/\r?\n/)) if (l.trim()) fn(l); };
        child.stdout.on('data', lines); child.stderr.on('data', lines);
      },
      kill() { try { child.kill(); } catch { /* gone */ } }
    }
  };
}
/**
 * L7/L11 (fix round 1, item 4): a sampler process (test/helpers/dockerSampler.cjs) counting the RUNNING containers with
 * this install's `nexus.home` and `extra` labels every `ms`. `samples` fills as it reports; `ready()` waits for its first
 * sample; `stop()` ends it. No docker call of it runs on this (main's) loop.
 */
function dockerSampler(home, extra = {}, ms = 200) {
  const child = fork(path.join(__dirname, 'dockerSampler.cjs'), [JSON.stringify({ home, extra, ms })], { execPath: process.execPath, cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const samples = [];
  child.on('message', (m) => { if (m && typeof m.running === 'number') samples.push(m); });
  const exited = new Promise((r) => child.once('exit', r));
  return {
    samples,
    ready: async (timeoutMs = 60_000) => {
      const end = Date.now() + timeoutMs;
      while (samples.length === 0) { if (Date.now() > end) throw new Error('the docker sampler did not report'); await sleep(50); }
    },
    stop: async () => {
      try { child.send('stop'); } catch { /* gone */ }
      await Promise.race([exited, sleep(5_000)]);
      try { child.kill(); } catch { /* gone */ }
    }
  };
}

/**
 * L16 (fix round 1, item 13): main in its OWN process (test/helpers/main-child.cjs), on an existing database and data
 * home, with the real wiring and its runner child; it starts `sde.build.run` of `repo` and reports `{ jobId, containerId }`
 * once the build's container runs. The test then kills it at once (hardKill: on Windows the whole tree, its runner
 * included) - a main crash, with no quit path.
 */
async function mainChild(reopen, repo, timeoutMs = 5 * 60_000) {
  const child = fork(path.join(__dirname, 'main-child.cjs'), [], { execPath: process.execPath, cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const output = [];
  child.stdout.on('data', (d) => output.push(String(d))); child.stderr.on('data', (d) => output.push(String(d)));
  const report = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`main child did not report in time\n${output.join('').slice(-4000)}`)), timeoutMs);
    child.once('message', (m) => { clearTimeout(t); if (m && m.ok) resolve(m); else reject(new Error(`main child failed: ${m && m.error}`)); });
    child.once('exit', (code) => { clearTimeout(t); reject(new Error(`main child exited (${code}) before it reported\n${output.join('').slice(-4000)}`)); });
  });
  child.send({ file: reopen.file, userData: reopen.userData, roots: [...reopen.roots], repo });
  const exited = new Promise((r) => child.once('exit', r));
  return { process: child, report: await report, crash: async () => { hardKill(child); await Promise.race([exited, sleep(15_000)]); } };
}

/** Kills a process at once (a crash: no shutdown message, no cleanup). */
function hardKill(proc) {
  if (process.platform === 'win32' && proc.pid) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  else proc.kill('SIGKILL');
}

/** A tiny HTTP server on the host (K7-K9): answers 200 `host-ok` to whoever reaches it. */
async function hostServer() {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('host-ok'); });
  // Loopback only (no firewall prompt, nothing exposed): Docker Desktop's host.docker.internal reaches the host's loopback.
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}
/** A LAN address of this machine (K9: the forwarder must not answer on it), or null. */
function lanAddress() {
  for (const list of Object.values(require('node:os').networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
function httpGet(host, port, p, ms = 5_000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: p, timeout: ms }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
function tcpConnects(host, port, ms = 3_000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: ms }, () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

/**
 * The real world: main + the real wiring + the runner child. `o.env`: extra environment of the runner child;
 * `o.dockerDown`: Docker is expected to be unreachable; `o.reopen`: `{ file, userData, roots }` of an earlier world.
 */
async function realWorld(o = {}) {
  // `o.reopen` (L16): a new platform and boot on an existing database and data home (main restarted after a crash).
  const p = await openPlatform({ now: Date.now, ...(o.reopen ?? {}) });
  const w = { kind: 'real', children: [], runnerEnv: { ...(o.env ?? {}) }, store: p.store, file: p.file, userData: p.userData, roots: p.roots };
  addCommon(w, p);
  const home = homeLabel(p.dataHome.root);
  w.home = home;
  const handle = await startExecution({ platform: p.nx, userData: p.userData, log: (l) => p.logs.push(l),
    fork: () => { const c = forkRunner(w.runnerEnv); w.children.push(c.process); return c.runnerChild; } });
  if (!handle) throw new Error('execution did not start');
  w.handle = handle;
  WORLDS.push(w);
  w.until = async (pred, what, ms = 10 * 60_000) => {
    const end = Date.now() + ms;
    for (;;) {
      await p.nx.exec.settled();
      if (p.nx.validation) await p.nx.validation.settled();
      if (pred()) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${p.logs.slice(-20).join('\n')}`);
      await sleep(250);
    }
  };
  // `o.dockerDown` (L8): the runner is told a Docker that does not exist; the world only waits for its first probe.
  await w.until(() => handle.ticking() && (o.dockerDown ? p.nx.exec.health().checkedAt !== null : p.nx.exec.health().docker.state === 'running'),
    'the runner is ready, reconciled and probing', 3 * 60_000);
  w.runner = () => w.children[w.children.length - 1];
  /** A runner crash: the child is killed at once; the host restarts it after 1 s and main reconciles at its ready. */
  w.killRunner = () => hardKill(w.runner());
  w.httpGet = (port, q) => httpGet('127.0.0.1', port, q);
  w.liveLabelled = (jobId) => { const l = labelled(home, { 'nexus.job': jobId }); return l.containers.length + l.networks.length + l.volumes.length; };
  w.containerArgv = async (jobId) => {
    const a = w.attemptsOf(jobId).pop();
    const rec = a && a.container_id ? dockerJson(['inspect', '--type', 'container', a.container_id]) : null;
    return rec && rec[0] ? rec[0].Config.Cmd : [];
  };
  w.inspect = (id) => { const r = dockerJson(['inspect', id]); return r && r[0] ? r[0] : null; };
  w.close = async () => {
    try { await handle.stop(); } catch { /* down */ }
    for (const c of w.children) { try { hardKill(c); } catch { /* gone */ } }
    removeLabelled(home);
    try { p.store.close(); } catch { /* closed */ }
  };
  return w;
}

/**
 * A RunnerCore in this process over the real Docker driver (K1-K11): `run(plan)` sends `attempt.start` and returns the
 * messages of that attempt as they arrive; `release(attemptId)` removes what it made.
 */
async function runnerHarness(o = {}) {
  const userData = h.tmpDir('nx-xk-');
  const root = path.join(userData, 'nexus');
  for (const d of ['objects/tmp', 'logs/jobs', 'logs/images', 'work']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const cli = dockerCli(fsp);
  const runner = o.wrap ? o.wrap(cli) : cli;
  const { port1, port2 } = new MessageChannel();
  const got = [];
  port1.on('message', (m) => got.push(m));
  const core = new RunnerCore(port2, { driver: new DockerDriver(runner, { now: Date.now }), now: Date.now, fs: fsp, docker: runner,
    imagesDir: path.join(ROOT, 'infra', 'images'), ...(o.limits ? { limits: o.limits } : {}) });
  const home = homeLabel(root);
  const images = loadImageProfiles(path.join(ROOT, 'infra', 'images'));
  const bootId = newId(Date.now());
  port1.postMessage({ op: 'hello', bootId, dataHome: root, home, profiles: images.profiles });
  const until = async (pred, what, ms = 120_000) => {
    const end = Date.now() + ms;
    while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(100); }
  };
  await until(() => got.some((m) => m.op === 'ready'), 'ready');
  port1.postMessage({ op: 'probe' });
  await until(() => got.some((m) => m.op === 'probe.result'), 'probe');
  const probe = got.find((m) => m.op === 'probe.result');
  const imageOf = (profile) => probe.images.find((i) => i.profile === profile)?.imageId ?? null;
  const t = {
    root, home, core, got, bootId, images, imageOf, until,
    of: (op, attemptId) => got.filter((m) => m.op === op && (!attemptId || m.attemptId === attemptId)),
    /** A plan for `recipe` exactly as main builds it, its argv replaced by `argv` (a probe command run by the Nexus entry). */
    plan(recipeId, argv, x = {}) {
      const recipe = getRecipe(recipeId);
      const profile = images.profiles.find((pr) => pr.id === (x.profile ?? recipe.profiles[0]));
      const jobId = newId(Date.now()); const attemptId = newId(Date.now());
      const plan = buildPlan({ job: { id: jobId, projectId: 'p-exec-k' }, attempt: { id: attemptId, n: 1 }, bootId, recipe, profile, imageId: imageOf(profile.id),
        dataHomeRoot: root, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, inputs: x.inputs ?? [], repoPath: null,
        approval: x.approval ? { id: x.approval, job_id: jobId, status: 'approved', consumed_at: Date.now(), consumed_by_job_id: jobId, consumed_by_attempt_n: 1 } : null,
        // B2a stabilization (constraint 5): an approved install runs with the job's Nexus egress proxy (the sde-node image).
        egressProxy: { profile: images.profiles.find((pr) => pr.id === 'sde-node') ?? null, imageId: imageOf('sde-node') } });
      if (argv) { plan.container.argv = [...argv]; delete plan.perFileJunit; }
      if (x.limits) Object.assign(plan.container.limits, x.limits);
      return plan;
    },
    start(plan) { port1.postMessage({ op: 'attempt.start', attemptId: plan.attemptId, plan }); return plan; },
    /** Any other message to the runner core, exactly as main sends it (an image build, a fresh probe). */
    send(m) { port1.postMessage(m); },
    async exited(plan, ms = 180_000) { await until(() => t.of('attempt.exited', plan.attemptId).length > 0 || t.of('fault', plan.attemptId).length > 0
      || t.of('attempt.refused', plan.attemptId).length > 0, `the exit of ${plan.attemptId}`, ms); return t.of('attempt.exited', plan.attemptId)[0] ?? null; },
    async provisioned(plan, ms = 120_000) { await until(() => t.of('attempt.provisioned', plan.attemptId).length > 0, 'provisioned', ms); return t.of('attempt.provisioned', plan.attemptId)[0]; },
    /** The attempt log's output lines (stdout and stderr frames; each frame is one line, its newline stripped by the log). */
    output(plan) {
      try {
        return fs.readFileSync(plan.logPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((f) => f && (f.stream === 'stdout' || f.stream === 'stderr')).map((f) => `${f.text}\n`).join('');
      } catch { return ''; }
    },
    /** The attempt log's Nexus lines (what the runner itself wrote: egress decisions, refusals, ...). */
    nexusLines(plan) {
      try {
        return fs.readFileSync(plan.logPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((f) => f && f.stream === 'nexus').map((f) => f.text);
      } catch { return []; }
    },
    release(plan) { port1.postMessage({ op: 'attempt.release', attemptId: plan.attemptId }); },
    async close() { try { await core.shutdown(); } catch { /* down */ } port1.close(); removeLabelled(home); }
  };
  return t;
}

module.exports = { realWorld, runnerHarness, docker, dockerJson, labelled, removeLabelled, hostServer, lanAddress, httpGet, tcpConnects, hardKill, sleep, dockerSampler, mainChild, LOCK };
