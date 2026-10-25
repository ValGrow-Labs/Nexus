'use strict';
// B2b Task 11: agent turns in the runner (src/runner/agentAttempt.ts, procTree.ts, runtimes/{registry,scripted}.ts).
// Plain node: no Docker, no Electron, no database, a fake sandbox driver, the real loopback MCP server, and either the
// in-process ScriptedRuntime or the fake-CLI process stand-in (test/fixtures/agent/fake-cli.cjs). Temp folders are
// removed by the file's after hook.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
const { MessageChannel } = require('node:worker_threads');

const C = require('./helpers/cleanup.cjs');
C.cleanupAfterAll();
const h = require('./helpers/sqlite.cjs');
const loadTs = require('./load-ts.cjs');
const { FakeSandboxDriver } = require('./helpers/fakeSandboxDriver.cjs');
const { textTurn, execTurn, failTurn } = require('./helpers/scriptedFixtures.cjs');
const { RunnerCore } = loadTs('src/runner/core.ts');
const { parseRunnerMessage, chunkText, MESSAGE_DELTA_MAX_BYTES } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { homeLabel } = loadTs('src/shared/nexus/homeLabel.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { defaultTaskkillBin, isTaskkillBinary } = loadTs('src/runner/procTree.ts');

const ROOT = path.resolve(__dirname, '..');
const IMAGES = path.join(ROOT, 'infra', 'images');
const FAKE_CLI = path.join(__dirname, 'fixtures', 'agent', 'fake-cli.cjs');

const NOW = 1_781_000_000_000;
const BOOT = newId(NOW);
const ANOTHER_BOOT = newId(NOW + 1);
const IMAGE = `sha256:${'2'.repeat(64)}`;
const PROFILE = { id: 'sde-node', image: { repository: 'nexus/sde-node', digest: `sha256:${'7'.repeat(64)}` }, user: { uid: 10001, gid: 10001 },
  defaults: { cpus: 1, memoryMb: 1024, pids: 512, wallClockMs: 60000, outputMaxBytes: 2 ** 20, tmpfsMb: 512 },
  entrypoint: ['/opt/nexus/entry'], imageEnv: ['PATH', 'HOME', 'LANG'] };

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

async function until(pred, what, ms = 15_000) {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const WORLDS = [];
after(async () => {
  for (const w of WORLDS) { try { await w.core.shutdown(); } catch { /* best effort */ } try { w.port1.close(); } catch { /* closed */ } }
});

/** Every scripted fixture, keyed by the attempt id that replays it (set by agentPlan, read by RunnerDeps.agentRuntime.scriptFor). */
const SCRIPTS = new Map();

function world(o = {}) {
  const dir = h.tmpDir('nx-agent-');
  const home = o.homeDir ?? path.join(dir, 'nexus');
  for (const d of ['objects/tmp', 'logs/jobs', 'logs/images', 'work']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const clock = new FakeClock(NOW);
  const driver = o.driver ?? new FakeSandboxDriver(o.fake ?? {});
  const { port1, port2 } = new MessageChannel();
  const got = [];
  const w = {
    dir, home, clock, driver, got,
    label: homeLabel(home),
    send: (m) => port1.postMessage(m),
    of: (op, attemptId) => got.filter((m) => m.op === op && (attemptId === undefined || m.attemptId === attemptId)),
    one: (op, attemptId) => got.find((m) => m.op === op && (attemptId === undefined || m.attemptId === attemptId)),
    async wait(pred, what) { await until(() => got.some(pred), what); return got.find(pred); },
    async waitOp(op, attemptId, what) { await until(() => w.one(op, attemptId) !== undefined, what ?? op); return w.one(op, attemptId); },
    advance: async (ms) => { clock.advance(ms); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); }
  };
  port1.on('message', (m) => {
    got.push(m);
    // A stand-in "main": every `mcp.call` is answered immediately, so a ScriptedRuntime's `tools/call` always completes.
    if (m.op === 'mcp.call') {
      const result = m.tool === 'sandbox_exec'
        ? { ok: true, value: { grant: { execId: newId(clock.now), argv: m.args.argv, cwd: m.args.cwd, timeoutMs: m.args.timeoutMs } } }
        : { ok: true, value: { tool: m.tool, args: m.args } };
      w.send({ op: 'mcp.reply', callId: m.callId, result });
    }
  });
  const core = new RunnerCore(port2, {
    driver, now: () => clock.now, fs: o.fs ?? fsp, timers: clock, log: (l) => (w.logs ??= []).push(l),
    freeBytes: o.freeBytes ?? (async () => 100 * 2 ** 30), sleep: o.sleep ?? (async () => {}), imagesDir: o.imagesDir ?? IMAGES,
    docker: null, agentRuntime: { scriptFor: (plan) => SCRIPTS.get(plan.attemptId) ?? [], ...o.agentRuntime }
  });
  w.core = core; w.port1 = port1;
  WORLDS.push(w);
  w.send({ op: 'hello', bootId: o.bootId ?? BOOT, dataHome: home, home: w.label, profiles: [PROFILE] });
  return until(() => got.some((m) => m.op === 'ready'), 'ready').then(() => w);
}

/** A valid AgentPlan: a worktree the mount points at exactly, a job config dir main would have written context.md into. */
function agentPlan(w, o = {}) {
  const jobId = newId(NOW); const attemptId = newId(NOW + 1);
  const worktreeDir = path.join(w.dir, 'wt', attemptId);
  fs.mkdirSync(worktreeDir, { recursive: true });
  const configDir = path.join(w.home, 'jobs', jobId, 'agent');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'context.md'), '## (no context available for this turn)\n', 'utf8');
  const token = `${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const labels = { 'nexus.job': jobId, 'nexus.attempt': attemptId, 'nexus.boot': BOOT, 'nexus.project': 'p-ledger', 'nexus.home': w.label, 'nexus.kind': 'agent' };
  if (Array.isArray(o.steps)) SCRIPTS.set(attemptId, o.steps);
  return {
    kind: 'agent', attemptId, jobId, attemptN: 1,
    recipe: { id: 'agent.turn', version: '1' },
    workDir: path.join(w.home, 'work', jobId, '1'),
    logPath: path.join(w.home, 'logs', 'jobs', jobId, '1.log'),
    container: {
      name: `nexus-${attemptId.toLowerCase()}`, labels, profile: 'sde-node', image: { ref: IMAGE, id: IMAGE },
      entrypoint: PROFILE.entrypoint, argv: ['nexus-agent-entry'], imageEnv: PROFILE.imageEnv, env: {},
      mounts: [{ kind: 'worktree', hostPath: worktreeDir, containerPath: '/workspace', readOnly: o.readOnlyWorktree === true }],
      network: { mode: o.networkMode ?? 'none' }, limits: PROFILE.defaults, readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true
    },
    worktree: { hostPath: worktreeDir, gitDir: path.join(worktreeDir, '.git-worktree'), ref: `refs/nexus/job/${'a'.repeat(26)}`, base: 'f'.repeat(40), editable: ['/workspace'] },
    runtime: {
      kind: o.kind ?? 'scripted',
      request: {
        jobId, attempt: 1, sessionId: attemptId, idempotencyKey: attemptId, domainId: 'd1', skills: [],
        context: { hash: 'h'.repeat(64), file: path.join(configDir, 'context.md') }, message: o.message ?? 'hello',
        worktree: { hostPath: worktreeDir, editable: ['/workspace'] }, container: { id: 'pending' },
        mcp: { url: 'http://127.0.0.1:1/mcp' }, model: { provider: 'x', model: 'y' },
        limits: { wallClockMs: 60_000, maxTurns: 10 }, credential: { ref: 'runtime-owned' }, configDir
      },
      token
    },
    egress: { allow: [] },
    caps: { turnTokens: 100_000, turnUsdCents: 1000, dayRemainingUsdCents: 1000, toolCalls: 100 },
    resourceLabels: { 'nexus.job': jobId, 'nexus.attempt': attemptId, 'nexus.boot': BOOT, 'nexus.project': 'p-ledger', 'nexus.home': w.label }
  };
}

async function startAgent(w, plan) {
  w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  return w.waitOp('attempt.provisioned', plan.attemptId, 'agent provisioned');
}

// ---------- Windows process liveness (test code only: AT7/AT8) ----------

function tasklistBin() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'tasklist.exe');
}
function isPidAlive(pid) {
  const r = cp.spawnSync(tasklistBin(), ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return typeof r.stdout === 'string' && r.stdout.includes(String(pid));
}
async function untilPidGone(pid, ms = 15_000) {
  await until(() => !isPidAlive(pid), `pid ${pid} to end`, ms);
}

// ---------- AT1r: a ScriptedRuntime turn end to end through the real MCP server ----------

test('AT1r a scripted agent turn: message, a real sandbox_exec round trip, then it completes', async () => {
  const w = await world();
  const plan = agentPlan(w, { steps: [{ op: 'delta', text: 'hello there' }, { op: 'call', tool: 'context_get', args: {} }, ...execTurn(['echo', 'hi'])] });
  const provisioned = await startAgent(w, plan);
  assert.equal(provisioned.preflight.ok, true, JSON.stringify(provisioned.preflight?.problems));
  assert.equal(w.driver.ops().filter((o) => o === 'create').length, 1);
  assert.deepEqual(w.driver.ops().filter((o) => ['create', 'preflight', 'start'].includes(o)), ['create', 'preflight', 'start']);

  await w.waitOp('attempt.exited', plan.attemptId, 'agent exited');
  const exited = w.one('attempt.exited', plan.attemptId);
  assert.equal(exited.exit.code, 0);
  assert.equal(exited.outputs.length, 0);
  assert.equal(exited.parsed.length, 0);

  const events = w.of('attempt.runtime', plan.attemptId).map((m) => m.event);
  assert.ok(events.some((e) => e.t === 'run.started'));
  assert.ok(events.some((e) => e.t === 'message.delta' && e.text === 'hello there'));
  assert.ok(events.some((e) => e.t === 'tool.started' && e.tool === 'context_get'));
  assert.ok(events.some((e) => e.t === 'tool.started' && e.tool === 'sandbox_exec'));
  assert.ok(events.some((e) => e.t === 'tool.completed' && e.ok === true));
  assert.ok(events.some((e) => e.t === 'run.completed'));
  // Every posted event parses (bounds, shape) under main's own protocol parser.
  for (const m of w.of('attempt.runtime', plan.attemptId)) assert.ok(parseRunnerMessage(m), JSON.stringify(m));

  // The exec was actually granted and run against the turn's own container (Task 6's relay).
  assert.ok(w.of('agent.exec.done', plan.attemptId).length === 1);
  assert.deepEqual(w.one('agent.exec.done', plan.attemptId).exit.code, 127); // FakeSandboxDriver.exec() answers "not found" for anything but du

  // The container was stopped and removed at the end (never left behind).
  assert.equal(w.driver.containers.size, 0);
});

test('AT1r a preflight refusal reports ok:false and never starts the container', async () => {
  const w = await world({ fake: { mutateInspect: (rec) => { rec[0].HostConfig.ReadonlyRootfs = false; return rec; } } });
  const plan = agentPlan(w, { steps: [{ op: 'complete' }] });
  const provisioned = await startAgent(w, plan);
  assert.equal(provisioned.preflight.ok, false);
  assert.ok(!w.driver.ops().includes('start'));
  assert.ok(w.driver.ops().includes('remove'));
});

test('a scripted run.failed ends the turn with a non-zero exit', async () => {
  const w = await world();
  const plan = agentPlan(w, { steps: failTurn('the model refused', 'limit') });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'agent exited (failed)');
  const exited = w.one('attempt.exited', plan.attemptId);
  assert.notEqual(exited.exit.code, 0);
  const events = w.of('attempt.runtime', plan.attemptId).map((m) => m.event);
  assert.ok(events.some((e) => e.t === 'run.failed' && e.code === 'limit'));
});

// ---------- AT19: a 20 KiB message.delta arrives as 5 chunks, in order ----------

test('AT19 a 20 KiB message.delta is relayed as 5 ordered chunks of at most 4 KiB', async () => {
  const w = await world();
  const big = 'x'.repeat(20 * 1024);
  const plan = agentPlan(w, { steps: [{ op: 'delta', text: big }, { op: 'complete' }] });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'agent exited');

  const deltas = w.of('attempt.runtime', plan.attemptId).map((m) => m.event).filter((e) => e.t === 'message.delta');
  assert.equal(deltas.length, 5, deltas.map((d) => d.text.length));
  for (const d of deltas) assert.ok(Buffer.byteLength(d.text, 'utf8') <= MESSAGE_DELTA_MAX_BYTES);
  assert.equal(deltas.map((d) => d.text).join(''), big, 'the chunks are in order and reassemble exactly');
  assert.deepEqual(deltas.map((d) => d.text), chunkText(big));
});

// ---------- AT9: a secret in message.delta and in exec output is redacted ----------

test('AT9 a secret-shaped string in message.delta is redacted in attempt.runtime and the log', async () => {
  const w = await world();
  const secret = 'AKIA1234567890ABCDEF';
  const plan = agentPlan(w, { steps: textTurn(`the key is ${secret} do not share it`) });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'agent exited');

  const deltas = w.of('attempt.runtime', plan.attemptId).map((m) => m.event).filter((e) => e.t === 'message.delta');
  const joined = deltas.map((d) => d.text).join('');
  assert.ok(!joined.includes(secret), 'the secret never reaches attempt.runtime');
  assert.ok(joined.includes('[redacted]'));

  const logText = fs.readFileSync(plan.logPath, 'utf8');
  assert.ok(!logText.includes(secret), 'the secret never reaches the attempt log on disk');
  assert.ok(logText.includes('[redacted]'));
});

test('AT9 a secret-shaped string in sandbox_exec output is redacted in the log frames', async () => {
  const w = await world();
  const secret = 'AKIA1234567890ABCDEF';
  // FakeSandboxDriver.exec() only understands `du`; this test plays the container's answer to the granted exec.
  w.driver.exec = async (id, argv) => ({ exit: { code: 0, oomKilled: false, finishedAt: 0 }, stdout: `token=${secret}\n`, stderr: '', truncated: false });
  const plan = agentPlan(w, { steps: execTurn(['env']) });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'agent exited');

  const logText = fs.readFileSync(plan.logPath, 'utf8');
  assert.ok(!logText.includes(secret), 'the raw exec output never reaches the attempt log on disk');
  assert.ok(logText.includes('[redacted]'));
  // Never travels to main at all (only counts and a hash do): agent.exec.done carries no text.
  const done = w.one('agent.exec.done', plan.attemptId);
  assert.ok(done && !JSON.stringify(done).includes(secret));
});

// ---------- AT14: a symlink planted by an exec is caught by the walk; the turn fails worktree_guard ----------

test('AT14 a symlink planted by an exec is caught by the worktree guard; the turn fails worktree_guard', async () => {
  const w = await world();
  const plan = agentPlan(w, { steps: execTurn(['ln', '-s', '/etc/passwd', 'evil']) });
  const worktreeDir = plan.worktree.hostPath;
  w.driver.exec = async (id, argv) => {
    // The exec "planted" a symlink in the agent's own read-write bind mount (what the sandboxed process touches on
    // the host, through the bind mount, in real life). A junction needs no elevation on Windows and is caught the
    // same way (worktreeGuard.ts: "a symlink, a junction or another reparse point").
    const linkPath = path.join(worktreeDir, 'evil-link');
    try { fs.symlinkSync(path.join(worktreeDir, '..'), linkPath, 'junction'); } catch { try { fs.symlinkSync('/etc/passwd', linkPath); } catch { /* platform */ } }
    return { exit: { code: 0, oomKilled: false, finishedAt: 0 }, stdout: '', stderr: '', truncated: false };
  };
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'agent exited');

  const exited = w.one('attempt.exited', plan.attemptId);
  assert.notEqual(exited.exit.code, 0);
  const logText = fs.readFileSync(plan.logPath, 'utf8');
  assert.ok(/worktree_guard/.test(logText), logText);
  const runtimeText = JSON.stringify(w.of('attempt.runtime', plan.attemptId));
  assert.ok(/worktree_guard/.test(runtimeText), runtimeText);
  assert.equal(w.driver.containers.size, 0, 'the container is still stopped and removed');
});

// ---------- AT7: cancel leaves no fake-CLI process ----------

test('AT7 cancelling a cli-agent turn leaves no fake-CLI process', async () => {
  let spawned = null;
  const w = await world({ agentRuntime: { agentBin: process.execPath, agentEnv: { ELECTRON_RUN_AS_NODE: '1' }, agentArgvPrefix: [FAKE_CLI],
    onSpawned: (info) => { spawned = info; } } });
  const plan = agentPlan(w, { kind: 'cli-agent' });
  await startAgent(w, plan);
  await until(() => spawned !== null, 'the fake CLI to spawn');
  assert.ok(isPidAlive(spawned.pid), 'the fake CLI is actually running');
  await w.wait((m) => m.op === 'attempt.runtime' && m.attemptId === plan.attemptId && m.event.t === 'run.started', 'run.started');

  w.send({ op: 'attempt.cancel', attemptId: plan.attemptId, graceMs: 1000, reason: 'user' });
  await w.waitOp('attempt.exited', plan.attemptId, 'agent exited (cancelled)');
  await untilPidGone(spawned.pid);
  assert.ok(!isPidAlive(spawned.pid));
});

// ---------- AT8: a runner crash in the same main boot; the next hello kills the tree ----------

test('AT8 a runner crash in the same main boot: the next hello kills the tree; another boot leaves it running', async () => {
  // Same main boot: a crashed world's pidfile is killed by the next hello on the same data home.
  let spawned1 = null;
  const w1 = await world({ bootId: BOOT, agentRuntime: { agentBin: process.execPath, agentEnv: { ELECTRON_RUN_AS_NODE: '1' }, agentArgvPrefix: [FAKE_CLI],
    onSpawned: (info) => { spawned1 = info; } } });
  const plan1 = agentPlan(w1, { kind: 'cli-agent' });
  await startAgent(w1, plan1);
  await until(() => spawned1 !== null, 'the fake CLI to spawn (same boot)');
  assert.ok(isPidAlive(spawned1.pid));
  // w1 "crashes": no cancel, no release, no shutdown — its pidfile is the only trace left.

  const w2 = await world({ homeDir: w1.home, bootId: BOOT });
  await untilPidGone(spawned1.pid);
  assert.ok(!isPidAlive(spawned1.pid), 'the same-boot orphan was killed at the next hello');

  // Another main boot: a crashed world's pidfile is only deleted; its process is left running.
  let spawned3 = null;
  const w3 = await world({ bootId: BOOT, agentRuntime: { agentBin: process.execPath, agentEnv: { ELECTRON_RUN_AS_NODE: '1' }, agentArgvPrefix: [FAKE_CLI],
    onSpawned: (info) => { spawned3 = info; } } });
  const plan3 = agentPlan(w3, { kind: 'cli-agent' });
  await startAgent(w3, plan3);
  await until(() => spawned3 !== null, 'the fake CLI to spawn (another boot)');
  assert.ok(isPidAlive(spawned3.pid));

  const pidsDir = path.join(w3.home, 'pids');
  await until(() => fs.existsSync(path.join(pidsDir, `${spawned3.pid}.json`)), 'the pidfile to be written');

  await world({ homeDir: w3.home, bootId: ANOTHER_BOOT });
  await until(() => !fs.existsSync(path.join(pidsDir, `${spawned3.pid}.json`)), 'the other-boot pidfile to be deleted');
  // Given no proxy, no MCP server and no token of w3 still exist, the orphan can reach nothing; it is still alive.
  assert.ok(isPidAlive(spawned3.pid), 'a pidfile from another main boot never has its process touched');
  const { killProcessTree } = loadTs('src/runner/procTree.ts');
  await killProcessTree(spawned3.pid, 'node.exe');
  await untilPidGone(spawned3.pid);
});

// ---------- AT17: shutdown kills live trees and leaves no process ----------

test('AT17 agent.shutdownTrees kills every live tree this runner holds', async () => {
  let spawned = null;
  const w = await world({ agentRuntime: { agentBin: process.execPath, agentEnv: { ELECTRON_RUN_AS_NODE: '1' }, agentArgvPrefix: [FAKE_CLI],
    onSpawned: (info) => { spawned = info; } } });
  const plan = agentPlan(w, { kind: 'cli-agent' });
  await startAgent(w, plan);
  await until(() => spawned !== null, 'the fake CLI to spawn');
  assert.ok(isPidAlive(spawned.pid));

  w.send({ op: 'agent.shutdownTrees' });
  await untilPidGone(spawned.pid);
  assert.ok(!isPidAlive(spawned.pid));
});

test('AT17 the app-quit shutdown op also ends live agent process trees', async () => {
  let spawned = null;
  const w = await world({ agentRuntime: { agentBin: process.execPath, agentEnv: { ELECTRON_RUN_AS_NODE: '1' }, agentArgvPrefix: [FAKE_CLI],
    onSpawned: (info) => { spawned = info; } } });
  const plan = agentPlan(w, { kind: 'cli-agent' });
  await startAgent(w, plan);
  await until(() => spawned !== null, 'the fake CLI to spawn');
  await w.core.shutdown();
  await untilPidGone(spawned.pid);
  assert.ok(!isPidAlive(spawned.pid));
});

// ---------- the posture pin this task adds (sanity: taskkill is resolved, never a bare command) ----------

test('taskkill is launched only by its resolved absolute path', () => {
  const bin = defaultTaskkillBin();
  assert.ok(path.isAbsolute(bin));
  assert.ok(isTaskkillBinary(bin));
  for (const bad of ['taskkill', 'taskkill.exe', 'C:\\x\\taskkill.exe.bat', '']) assert.equal(isTaskkillBinary(bad), false, bad);
});
