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
const { hostsSha256 } = loadTs('src/runner/hostEgressProxy.ts');

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
        ? { ok: true, value: { grant: { execId: newId(clock.now), argv: m.args.argv, cwd: o.grantCwd ?? m.args.cwd, timeoutMs: m.args.timeoutMs } } }
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
  // The worktree is a session folder of the data home (`<home>/wt/<26 lowercase>`), the config dir exactly `<home>/jobs/<job>/agent`.
  const worktreeDir = o.worktreeDir ?? path.join(w.home, 'wt', attemptId.toLowerCase());
  fs.mkdirSync(worktreeDir, { recursive: true });
  const configDir = o.configDir ?? path.join(w.home, 'jobs', jobId, 'agent');
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
    egress: o.egress ?? { allow: [] },
    caps: { turnTokens: 100_000, turnUsdCents: 1000, dayRemainingUsdCents: 1000, toolCalls: 100 },
    ...(o.mcpTools !== undefined ? { mcpTools: o.mcpTools } : {}),
    resourceLabels: { 'nexus.job': jobId, 'nexus.attempt': attemptId, 'nexus.boot': BOOT, 'nexus.project': 'p-ledger', 'nexus.home': w.label }
  };
}

/** Points a plan's worktree (the plan, the mount and the run request alike) somewhere else. */
function retarget(plan, p) {
  plan.worktree.hostPath = p;
  plan.container.mounts[0].hostPath = p;
  plan.runtime.request.worktree.hostPath = p;
}

/** One `tools/call` to the runner's real loopback MCP server, as an agent's client would send it. */
async function mcpCall(w, token, tool, args) {
  const url = w.one('ready').mcpUrl;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) });
  const json = await res.json();
  return { isError: json.result.isError, text: json.result.content[0].text };
}
const EXEC_ARGS = { argv: ['echo', 'late'], cwd: '/workspace', timeoutMs: 5000 };

/** Sends attempt.start and waits for the runner's refusal. */
async function startRefused(w, plan) {
  w.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
  return w.waitOp('attempt.refused', plan.attemptId, 'agent plan refused');
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
  await until(() => !fs.existsSync(path.join(w.home, 'pids', `${spawned.pid}.json`)), 'the pidfile to be removed after cancel');
  assert.equal(w.driver.containers.size, 0);
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
  await w.waitOp('attempt.exited', plan.attemptId, 'the turn ends once its process is gone');
  assert.equal(w.driver.containers.size, 0, 'the turn also removes its container');
});

test('AT17 the app-quit shutdown op also ends live agent process trees', async () => {
  let spawned = null;
  const w = await world({ agentRuntime: { agentBin: process.execPath, agentEnv: { ELECTRON_RUN_AS_NODE: '1' }, agentArgvPrefix: [FAKE_CLI],
    onSpawned: (info) => { spawned = info; } } });
  const plan = agentPlan(w, { kind: 'cli-agent' });
  await startAgent(w, plan);
  await until(() => spawned !== null, 'the fake CLI to spawn');
  assert.equal(w.driver.containers.size, 1, 'the agent container is running');
  await w.core.shutdown();
  await untilPidGone(spawned.pid);
  assert.ok(!isPidAlive(spawned.pid));
  assert.equal(w.driver.containers.size, 0, 'shutdown stops and removes the agent container (its rw worktree bind is not left running)');
  assert.ok(w.driver.ops().includes('remove'));
});

// ---------- Fix round 1 ----------

// I1: nothing the runner creates, binds or deletes in is taken on trust from the plan.

test('I1 a config dir that is not exactly <home>/jobs/<job>/agent is refused bad_plan before anything is created or deleted', async () => {
  const w = await world();
  const elsewhere = path.join(w.dir, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'precious');
  const plan = agentPlan(w, { configDir: elsewhere });
  const refused = await startRefused(w, plan);
  assert.equal(refused.reason, 'bad_plan');
  assert.ok(!w.driver.ops().includes('create'));
  assert.equal(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8'), 'precious');

  // Another job's agent folder, and a '..' spelling of the right one: both refused.
  const other = agentPlan(w);
  other.runtime.request.configDir = path.join(w.home, 'jobs', newId(NOW), 'agent');
  assert.equal((await startRefused(w, other)).reason, 'bad_plan');
  const dots = agentPlan(w);
  dots.runtime.request.configDir = `${dots.runtime.request.configDir}${path.sep}..${path.sep}agent`;
  assert.equal((await startRefused(w, dots)).reason, 'bad_plan');
  assert.ok(!w.driver.ops().includes('create'));
});

test('I1 a worktree outside <home>/wt/<session>, or spelled with .., is refused bad_plan; the run request must agree with the plan', async () => {
  const w = await world();
  const outside = path.join(w.dir, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const a = agentPlan(w); retarget(a, outside);
  assert.equal((await startRefused(w, a)).reason, 'bad_plan');

  const b = agentPlan(w);
  retarget(b, `${path.join(w.home, 'wt', 'x')}${path.sep}..${path.sep}${path.basename(b.worktree.hostPath)}`);
  assert.equal((await startRefused(w, b)).reason, 'bad_plan');

  const c = agentPlan(w); c.runtime.request.worktree.hostPath = outside;
  assert.equal((await startRefused(w, c)).reason, 'bad_plan');
  const d = agentPlan(w); delete d.runtime.request.container;
  assert.equal((await startRefused(w, d)).reason, 'bad_plan');
  const e = agentPlan(w); e.runtime.request.jobId = 'someone-else';
  assert.equal((await startRefused(w, e)).reason, 'bad_plan');
  const bad = agentPlan(w); bad.container = null;   // M1: a malformed plan is a refusal, not a TypeError fault
  assert.equal((await startRefused(w, bad)).reason, 'bad_plan');
  assert.ok(!w.driver.ops().includes('create'));
  assert.equal(w.of('fault').length, 0);
});

test('I1 the run request handed to the runtime names the real container', async () => {
  let seen = null;
  const w = await world({ agentRuntime: { makeRuntime: () => ({ kind: 'scripted', async describe() { return {}; }, async health() { return { ok: true, version: '1' }; },
    async *start(req) { seen = req; yield { t: 'run.started', runRef: 'r1', at: 1 }; yield { t: 'run.completed', at: 2, stopReason: 'end_turn' }; }, async cancel() {} }) } });
  const plan = agentPlan(w);
  const p = await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  assert.equal(seen.container.id, p.containerId);
});

// I2: the host process never outlives its turn, and its pidfile goes with it.

test('I2 a turn that completes while its CLI hangs on leaves no process and no pidfile', async () => {
  let spawned = null;
  const w = await world({ agentRuntime: { agentBin: process.execPath, agentEnv: { ELECTRON_RUN_AS_NODE: '1', FAKE_CLI_COMPLETE_HANG: '1' }, agentArgvPrefix: [FAKE_CLI],
    onSpawned: (info) => { spawned = info; } } });
  const plan = agentPlan(w, { kind: 'cli-agent' });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  assert.equal(w.one('attempt.exited', plan.attemptId).exit.code, 0, 'the turn itself completed');
  assert.ok(spawned);
  await untilPidGone(spawned.pid);
  await until(() => !fs.existsSync(path.join(w.home, 'pids', `${spawned.pid}.json`)), 'the pidfile to be removed');
  assert.equal(w.driver.containers.size, 0);
});

test('I2 a CLI that exits on its own leaves no pidfile behind', async () => {
  let spawned = null;
  const w = await world({ agentRuntime: { agentBin: process.execPath, agentEnv: { ELECTRON_RUN_AS_NODE: '1', FAKE_CLI_QUICK: '1' }, agentArgvPrefix: [FAKE_CLI],
    onSpawned: (info) => { spawned = info; } } });
  const plan = agentPlan(w, { kind: 'cli-agent' });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  assert.equal(w.one('attempt.exited', plan.attemptId).exit.code, 0);
  await until(() => !fs.existsSync(path.join(w.home, 'pids', `${spawned.pid}.json`)), 'the pidfile to be removed after a natural exit');
  await untilPidGone(spawned.pid);
});

// I3: the worktree guard.

test('I3 an exec that throws is still walked; later execs are refused; a refused worktree never ends as completed', async () => {
  let W = null;
  const late = [];
  const w = await world({ agentRuntime: { makeRuntime: (plan) => ({ kind: 'scripted', async describe() { return {}; }, async health() { return { ok: true, version: '1' }; },
    // A runtime that ignores the abort: it execs again after the guard refused, then reports it completed.
    async *start() {
      yield { t: 'run.started', runRef: 'r1', at: 1 };
      late.push(await mcpCall(W, plan.runtime.token, 'sandbox_exec', EXEC_ARGS));
      late.push(await mcpCall(W, plan.runtime.token, 'sandbox_exec', EXEC_ARGS));
      yield { t: 'run.completed', at: 2, stopReason: 'end_turn' };
    }, async cancel() {} }) } });
  W = w;
  const plan = agentPlan(w);
  const wt = plan.worktree.hostPath;
  let execCalls = 0;
  w.driver.exec = async () => {
    execCalls++;
    fs.symlinkSync(path.join(wt, '..'), path.join(wt, 'evil-link'), 'junction');
    throw new Error('the exec was killed mid-way');
  };
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  assert.equal(execCalls, 1, 'the second exec after the refusal never reached the container');
  assert.equal(late[0].isError, true);
  assert.equal(late[1].isError, true);
  assert.match(late[1].text, /ended/);
  const events = w.of('attempt.runtime', plan.attemptId).map((m) => m.event);
  assert.ok(!events.some((e) => e.t === 'run.completed'), 'never reported as completed');
  assert.ok(events.some((e) => e.t === 'run.failed' && /worktree_guard/.test(e.message)));
  assert.notEqual(w.one('attempt.exited', plan.attemptId).exit.code, 0);
  assert.match(fs.readFileSync(plan.logPath, 'utf8'), /worktree_guard/);
});

// I5: bind/unbind is structural.

test('I5 a proxy that fails to start fails the turn proxy_failed; the bearer is unbound and nothing is left', async () => {
  const w = await world({ agentRuntime: { startProxy: async () => { throw new Error('listen failed'); } } });
  const plan = agentPlan(w, { steps: textTurn('never reached') });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  assert.notEqual(w.one('attempt.exited', plan.attemptId).exit.code, 0);
  const events = w.of('attempt.runtime', plan.attemptId).map((m) => m.event);
  assert.ok(events.some((e) => e.t === 'run.failed' && /proxy_failed/.test(e.message)));
  assert.ok(!events.some((e) => e.t === 'message.delta'), 'the runtime never ran');
  assert.equal(w.driver.containers.size, 0);
  const stale = await mcpCall(w, plan.runtime.token, 'sandbox_exec', EXEC_ARGS);
  assert.equal(stale.isError, true);
  assert.match(stale.text, /no running turn/);
  assert.equal(w.driver.callsOf('exec').length, 0);
});

test('I5 a runtime whose start throws, and a finished turn, both leave the old bearer refused', async () => {
  const w = await world({ agentRuntime: { makeRuntime: () => ({ kind: 'scripted', async describe() { return {}; }, async health() { return { ok: true, version: '1' }; },
    start() { throw new Error('start blew up'); }, async cancel() {} }) } });
  const plan = agentPlan(w);
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  assert.notEqual(w.one('attempt.exited', plan.attemptId).exit.code, 0);
  assert.equal(w.driver.containers.size, 0);
  assert.match((await mcpCall(w, plan.runtime.token, 'sandbox_exec', EXEC_ARGS)).text, /no running turn/);

  const w2 = await world();
  const plan2 = agentPlan(w2, { steps: textTurn('fine') });
  await startAgent(w2, plan2);
  await w2.waitOp('attempt.exited', plan2.attemptId, 'exited');
  const stale2 = await mcpCall(w2, plan2.runtime.token, 'sandbox_exec', EXEC_ARGS);
  assert.equal(stale2.isError, true);
  assert.match(stale2.text, /no running turn/);
  assert.equal(w2.driver.callsOf('exec').length, 0);
});

// CONSENT: the live consent's hash is main's, never derived from the allow list.

const ALLOW = [{ host: 'api.example.com', port: 443 }];

test('CONSENT a matching consent hash starts the proxy and the turn completes', async () => {
  const w = await world();
  const plan = agentPlan(w, { steps: textTurn('ok'), egress: { allow: ALLOW, consentHostsSha256: hostsSha256(ALLOW) } });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  assert.equal(w.one('attempt.exited', plan.attemptId).exit.code, 0);
});

test('CONSENT a hash that does not match the allowed hosts fails the turn consent_mismatch; no container, bearer unbound', async () => {
  const w = await world();
  const plan = agentPlan(w, { steps: textTurn('never reached'), egress: { allow: ALLOW, consentHostsSha256: 'f'.repeat(64) } });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  assert.notEqual(w.one('attempt.exited', plan.attemptId).exit.code, 0);
  const events = w.of('attempt.runtime', plan.attemptId).map((m) => m.event);
  assert.ok(events.some((e) => e.t === 'run.failed' && /consent_mismatch/.test(e.message)), JSON.stringify(events));
  assert.ok(!events.some((e) => e.t === 'message.delta'));
  assert.equal(w.driver.containers.size, 0);
  assert.match((await mcpCall(w, plan.runtime.token, 'sandbox_exec', EXEC_ARGS)).text, /no running turn/);
});

test('CONSENT hosts without a valid consent hash are refused bad_plan; an empty list needs none', async () => {
  const w = await world();
  for (const egress of [{ allow: ALLOW }, { allow: ALLOW, consentHostsSha256: 'nothex' }, { allow: [], consentHostsSha256: 'nothex' }]) {
    const plan = agentPlan(w, { egress });
    assert.equal((await startRefused(w, plan)).reason, 'bad_plan', JSON.stringify(egress));
  }
  assert.ok(!w.driver.ops().includes('create'));
  const ok = agentPlan(w, { steps: textTurn('deny-all is fine'), egress: { allow: [] } });
  await startAgent(w, ok);
  await w.waitOp('attempt.exited', ok.attemptId, 'exited');
  assert.equal(w.one('attempt.exited', ok.attemptId).exit.code, 0);
});

// ---------- Task 13: the cli-agent adapter's environment and proxy, through the runner ----------

test('AT-env a cli-agent turn runs with the allow-list environment, the own proxy of the turn and its own bearer, never the environment of the runner; the bearer is redacted in what the engine says', async () => {
  const keep = { k: process.env.ANTHROPIC_API_KEY, t: process.env.GITHUB_TOKEN, c: process.env.NODE_EXTRA_CA_CERTS, h: process.env.HTTP_PROXY };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-RUNNER-OWN', GITHUB_TOKEN: 'ghp_RUNNER_OWN', NODE_EXTRA_CA_CERTS: 'C:\runner-ca.pem', HTTP_PROXY: 'http://runner-own.invalid:1' });
  try {
    const w = await world({ agentRuntime: { agentBin: process.execPath, agentEnv: { ELECTRON_RUN_AS_NODE: '1' }, agentArgvPrefix: [FAKE_CLI, '--fake-dump-env'] } });
    const plan = agentPlan(w, { kind: 'cli-agent' });
    await startAgent(w, plan);
    await w.waitOp('attempt.exited', plan.attemptId, 'exited');
    assert.equal(w.one('attempt.exited', plan.attemptId).exit.code, 0);
    const delta = w.of('attempt.runtime', plan.attemptId).map((m) => m.event).find((e) => e.t === 'message.delta');
    const env = JSON.parse(delta.text);
    assert.match(env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/, 'the loopback proxy of the turn');
    assert.equal(env.NO_PROXY, '127.0.0.1');
    for (const k of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'CLAUDE_CONFIG_DIR']) assert.equal(env[k], undefined, `${k} is never handed on`);
    // Exactly the allow-list (plus the test seam's own name). Windows itself adds four non-secret names to ANY process started
    // with an explicit environment (a plain node child shows them too); they are not the adapter's doing.
    const OS_ADDED = ['LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME'];
    const ALLOW = ['SystemRoot', 'windir', 'PATH', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'HTTPS_PROXY', 'NO_PROXY',
      'NEXUS_MCP_TOKEN', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'ELECTRON_RUN_AS_NODE'];
    const names = Object.keys(env).map((k) => k.toLowerCase()).filter((k) => !OS_ADDED.map((x) => x.toLowerCase()).includes(k)).sort();
    assert.deepEqual(names, ALLOW.map((k) => k.toLowerCase()).sort());
    assert.ok(!JSON.stringify(w.got).includes(plan.runtime.token), 'the bearer is in no frame');
    assert.ok(!fs.readFileSync(plan.logPath, 'utf8').includes(plan.runtime.token), 'nor in the attempt log');
    assert.ok(env.NEXUS_MCP_TOKEN && env.NEXUS_MCP_TOKEN !== plan.runtime.token, 'the engine said it, and the relay redacted it');
  } finally {
    for (const [k, v] of [['ANTHROPIC_API_KEY', keep.k], ['GITHUB_TOKEN', keep.t], ['NODE_EXTRA_CA_CERTS', keep.c], ['HTTP_PROXY', keep.h]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ---------- final review: a granted command runs in the folder named, under /workspace only ----------

test('CWD a granted sandbox_exec runs with its working folder (docker exec -w) under /workspace; a folder outside it, or with .., runs nothing', async () => {
  const w = await world();
  const plan = agentPlan(w, { steps: execTurn(['echo', 'hi'], { cwd: '/workspace/sub/dir' }) });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  const execs = w.driver.callsOf('exec');
  assert.equal(execs.length, 1);
  assert.equal(execs[0].args[2].cwd, '/workspace/sub/dir', 'the folder reaches the driver');
  for (const bad of ['/etc', '/workspace/../etc', '/workspaceX', 'workspace', '/workspace/a/../b', '/workspace\evil']) {
    const w2 = await world({ grantCwd: bad });
    const p2 = agentPlan(w2, { steps: execTurn(['echo', 'hi'], { cwd: '/workspace' }) });
    await startAgent(w2, p2);
    await w2.waitOp('attempt.exited', p2.attemptId, 'exited');
    assert.equal(w2.driver.callsOf('exec').length, 0, `${bad} ran nothing`);
  }
});

// ---------- B2b Task 10: the token's tools are the runtime's allow-list ----------

test('MCPTOOLS the mcpTools of a plan are exactly the cli-agent allow-list; an unknown or repeated tool is refused bad_plan', async () => {
  const argvOf = async (mcpTools) => {
    const w = await world({ agentRuntime: { agentBin: process.execPath, agentEnv: { ELECTRON_RUN_AS_NODE: '1' }, agentArgvPrefix: [FAKE_CLI, '--fake-dump-argv'] } });
    const plan = agentPlan(w, { kind: 'cli-agent', ...(mcpTools === undefined ? {} : { mcpTools }) });
    await startAgent(w, plan);
    await w.waitOp('attempt.exited', plan.attemptId, 'exited');
    const delta = w.of('attempt.runtime', plan.attemptId).map((m) => m.event).find((e) => e.t === 'message.delta');
    const argv = JSON.parse(delta.text);
    const i = argv.indexOf('--allowedTools');
    assert.ok(i >= 0);
    const names = [];
    for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) names.push(argv[k]);
    return names.filter((n) => n.startsWith('mcp__'));
  };
  assert.deepEqual(await argvOf(['context_get', 'artifact_read']), ['mcp__nexus__context_get', 'mcp__nexus__artifact_read'], 'exactly the tools of the token');
  assert.deepEqual(await argvOf([]), [], 'a token without tools allows none');
  assert.ok((await argvOf(undefined)).length >= 11, 'without the list the default is every tool the runner serves (main still checks the claims)');
  const w = await world();
  for (const mcpTools of [['context_get', 'context_get'], ['not_a_tool'], 'context_get', [7]]) {
    const plan = agentPlan(w, { mcpTools });
    assert.equal((await startRefused(w, plan)).reason, 'bad_plan', JSON.stringify(mcpTools));
  }
  assert.ok(!w.driver.ops().includes('create'), 'nothing was created for a refused plan');
});

// ---------- Follow-up 2: the host proxy's decisions are progress events ----------

/** A stand-in host proxy: it hands the turn's `onDecision` to the test, which plays the decisions the real proxy would report. */
function fakeProxy(play, dropped = 0) {
  return async (o) => {
    play(o.onDecision);
    return { url: 'http://127.0.0.1:9', port: 9, decisions: 0, get dropped() { return dropped; }, async close() {} };
  };
}
const decision = (host, ok = true, port = 443, reason = ok ? 'allowed' : 'host_not_allowed') =>
  ({ t: 'egress', decision: ok ? 'allowed' : 'refused', host, port, reason, at: NOW });
const egressEvents = (w, attemptId) => w.of('attempt.event', attemptId).map((m) => m.event).filter((e) => e.t === 'egress');

test('EGRESS one allowed and one refused host become exactly two egress progress events with the right fields, in order, seq strictly increasing', async () => {
  const w = await world({ agentRuntime: { startProxy: fakeProxy((on) => { on(decision('api.example.com')); on(decision('evil.example.org', false)); }) } });
  const plan = agentPlan(w, { steps: textTurn('ok'), egress: { allow: ALLOW, consentHostsSha256: hostsSha256(ALLOW) } });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  const events = egressEvents(w, plan.attemptId);
  assert.deepEqual(events.map((e) => [e.decision, e.host, e.port, e.reason]),
    [['allowed', 'api.example.com', 443, 'allowed'], ['refused', 'evil.example.org', 443, 'host_not_allowed']]);
  assert.equal(w.of('attempt.event', plan.attemptId).filter((m) => m.event.t === 'egress.truncated').length, 0);
  const seqs = w.of('attempt.event', plan.attemptId).map((m) => m.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.ok(!JSON.stringify(w.of('attempt.event', plan.attemptId)).includes(plan.runtime.token), 'the turn token is in no egress event');
});

test('EGRESS at most 200 decisions are reported; the rest are counted in one egress.truncated marker (the proxy\'s own drops included)', async () => {
  const w = await world({ agentRuntime: { startProxy: fakeProxy((on) => { for (let i = 0; i < 205; i++) on(decision(`h${i}.example.com`)); }, 3) } });
  const plan = agentPlan(w, { steps: textTurn('ok'), egress: { allow: ALLOW, consentHostsSha256: hostsSha256(ALLOW) } });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  assert.equal(egressEvents(w, plan.attemptId).length, 200);
  const marks = w.of('attempt.event', plan.attemptId).map((m) => m.event).filter((e) => e.t === 'egress.truncated');
  assert.equal(marks.length, 1, 'one marker, never more');
  assert.equal(marks[0].count, 5 + 3);
  // The marker comes after every reported decision and before the turn ends.
  const all = w.got.filter((m) => m.attemptId === plan.attemptId);
  const last = all.findLastIndex((m) => m.op === 'attempt.event' && m.event.t === 'egress');
  assert.ok(all.findIndex((m) => m.op === 'attempt.event' && m.event.t === 'egress.truncated') > last);
  assert.ok(all.findIndex((m) => m.op === 'attempt.exited') > all.findIndex((m) => m.op === 'attempt.event' && m.event.t === 'egress.truncated'));
});

test('EGRESS a hostile host string is neutralised, never stored raw: secret-shaped and token-shaped are redacted, anything not a DNS name is invalid', async () => {
  const hostile = ['AKIA1234567890ABCDEF', 'a/b?q=1', 'evil\nhost', '10.0.0.5', '[fe80::1]', 'x'.repeat(300), 'bad host', 'sk-ant-abcdefghijklmnop'];
  let plan = null;
  const w = await world({ agentRuntime: { startProxy: fakeProxy((on) => {
    for (const h of hostile) on(decision(h, false, 443, 'malformed'));
    on(decision(plan.runtime.token, false, 443, 'malformed'));
    on(decision('Good-Host.example.com', false));
  }) } });
  plan = agentPlan(w, { steps: textTurn('ok'), egress: { allow: ALLOW, consentHostsSha256: hostsSha256(ALLOW) } });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  const events = egressEvents(w, plan.attemptId);
  assert.equal(events.length, hostile.length + 2);
  const hosts = events.map((e) => e.host);
  assert.deepEqual(hosts, ['redacted', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'redacted', 'redacted', 'Good-Host.example.com']);
  const wire = JSON.stringify(w.got.filter((m) => m.attemptId === plan.attemptId));
  for (const raw of [...hostile, plan.runtime.token]) assert.ok(!wire.includes(raw), `${raw.slice(0, 12)} never leaves the runner raw`);
  assert.ok(!fs.readFileSync(plan.logPath, 'utf8').includes(plan.runtime.token));
});

test('EGRESS a decision after the turn ended is never reported', async () => {
  let late = null;
  const w = await world({ agentRuntime: { startProxy: fakeProxy((on) => { late = on; }) } });
  const plan = agentPlan(w, { steps: textTurn('ok'), egress: { allow: ALLOW, consentHostsSha256: hostsSha256(ALLOW) } });
  await startAgent(w, plan);
  await w.waitOp('attempt.exited', plan.attemptId, 'exited');
  const before = w.of('attempt.event', plan.attemptId).length;
  late(decision('late.example.com'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.of('attempt.event', plan.attemptId).length, before);
});

// ---------- the posture pin this task adds (sanity: taskkill is resolved, never a bare command) ----------

test('taskkill is launched only by its resolved absolute path', () => {
  const bin = defaultTaskkillBin();
  assert.ok(path.isAbsolute(bin));
  assert.ok(isTaskkillBinary(bin));
  for (const bad of ['taskkill', 'taskkill.exe', 'C:\\x\\taskkill.exe.bat', '']) assert.equal(isTaskkillBinary(bad), false, bad);
});
