'use strict';
// B2b Task 16: the real-Docker agent flows XA1-XA7, called by test/nexus-exec-agent.test.cjs behind the test:exec resource gate
// (test/helpers/execGate.cjs). Loaded ONLY inside that gate: this module needs a running Docker and the pinned images.
//
// The world is test/helpers/agentFlowWorld.cjs in `real` mode: the same main (database, services, handlers, MCP gateway), the same
// in-process runner core, the same ScriptedRuntime for the model, but the REAL Docker driver, the real clock and real timers. So
// what these flows add over the scripted flows (test/nexus-platform-b2b-flows-*.test.cjs, which play Docker from recordings) is
// exactly what only Docker can prove: the container's real isolation (network none, one bind, dropped capabilities), real command
// output through the MCP exec relay, real cancellation and restart cleanup, real node:test and pytest runs for cs.tests_pass, and
// the worktree guard over a real bind mount. ScriptedRuntime is still not a real model (Verification V5).
//
// Written without Docker available on the authoring machine: these flows have NOT been executed. Read every assertion as a claim to
// check at Verification V4, not as an observed result.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./sqlite.cjs');
const loadTs = require('../load-ts.cjs');
const { flowWorld, useFixture, makeChange, sound } = require('./agentFlowWorld.cjs');
const { dockerJson, labelled, docker } = require('./execReal.cjs');
const { REAL } = require('./agentFlowCode.cjs');
const { homeLabel } = loadTs('src/shared/nexus/homeLabel.ts');

const MIN = 60_000;
const slash = (p) => String(p).replace(/\\/g, '/').toLowerCase();

/** A real world with the repository snapshotted and the agent's permission granted; `w.close()` removes everything it made in Docker. */
async function xaWorld(fixture = 'node-test-app') {
  const w = await flowWorld({ real: true });
  await useFixture(w, fixture);
  await w.snapshot();
  await w.consent();
  w.home = homeLabel(w.dataHome.root);
  /** The ids of this install's live or stopped agent containers (every Docker resource this world owns carries its `nexus.home`). */
  w.agentContainers = () => labelled(w.home, { 'nexus.kind': 'agent' }).containers;
  w.inspect = (id) => { const r = dockerJson(['inspect', '--type', 'container', id]); return r && r[0] ? r[0] : null; };
  w.worktreeDir = (sessionId) => path.join(w.dataHome.root, 'wt', sessionId.toLowerCase());
  return w;
}
/** Runs `body(w)` and always removes the world's Docker resources and folders afterwards. */
async function withWorld(fixture, body) {
  const w = await xaWorld(fixture);
  try { return await body(w); } finally { try { await w.close(); } catch { /* best effort */ } }
}
/** A turn that runs one command in its container (`argv`), then ends; returns { jobId, sessionId, job } once the job has ended. */
async function runOne(w, argv, o = {}) {
  w.script((plan) => [{ op: 'call', tool: 'sandbox_exec', args: { argv, cwd: '/workspace', timeoutMs: o.timeoutMs ?? 120_000 } }, { op: 'complete' }]);
  return w.turn(o.message ?? 'Run a command', { ms: o.ms ?? 10 * MIN });
}
/** Starts a turn running `argv` and waits until its container is up and the job runs (the command is then in flight). */
async function startHeld(w, argv, o = {}) {
  w.script((plan) => [{ op: 'call', tool: 'sandbox_exec', args: { argv, cwd: '/workspace', timeoutMs: o.timeoutMs ?? 10 * MIN } }, { op: 'complete' }]);
  const r = await w.start(o.message ?? 'Run a long command');
  await w.approveA3();
  await w.until(() => w.jobRow(r.job.id).state === 'running' && w.agentContainers().length === 1, 'the turn container is up and the job runs', 3 * MIN);
  return r;
}

const xa = {
  /**
   * XA1 e2e.sde.ai-implementation: the turn container passes the runner's preflight with the worktree bind and network `none`. The
   * attempt only reaches `running` after the comparison of Docker's own inspect record with the plan (the runner reports `provisioned`
   * after it); the container, inspected while it runs, has exactly the isolation the plan names.
   */
  async XA1() {
    return withWorld('node-test-app', async (w) => {
      const r = await startHeld(w, ['sleep', '45']);
      const id = w.agentContainers()[0];
      const c = w.inspect(id);
      assert.ok(c, 'docker inspect answers');
      assert.equal(c.HostConfig.NetworkMode, 'none', 'network none');
      assert.equal(c.HostConfig.ReadonlyRootfs, true);
      assert.deepEqual(c.HostConfig.CapDrop, ['ALL']);
      assert.ok((c.HostConfig.SecurityOpt ?? []).some((x) => /no-new-privileges/.test(x)));
      assert.equal(c.HostConfig.Privileged, false);
      assert.equal(c.Config.User, '10001:10001');
      assert.deepEqual(c.Config.Cmd.slice(0, 1), ['sleep'], 'the container sleeps; every command is a sandbox_exec');
      assert.equal(c.Config.Labels['nexus.kind'], 'agent');
      assert.equal(c.Config.Labels['nexus.job'], r.job.id);
      const binds = c.Mounts.filter((m) => m.Type === 'bind');
      assert.deepEqual(c.Mounts.map((m) => m.Destination), ['/workspace'], 'one mount, the worktree');
      assert.equal(binds.length, 1); assert.equal(binds[0].RW, true, 'the worktree is bound read-write');
      assert.ok(slash(binds[0].Source).endsWith(`/wt/${r.session.id.toLowerCase()}`), `the bind is the session worktree (${binds[0].Source})`);
      // Main's own record of the attempt: running (so the preflight passed), the sandbox it was given, no host path in it.
      const at = w.db.prepare('SELECT state, container_id, sandbox_json FROM job_attempts WHERE job_id = ?').get(r.job.id);
      assert.equal(at.state, 'running'); assert.equal(at.container_id, id);
      const sb = JSON.parse(at.sandbox_json);
      assert.equal(sb.network.mode, 'none');
      assert.deepEqual(sb.mounts.map((m) => [m.kind, m.containerPath, m.readOnly]), [['worktree', '/workspace', false]]);
      assert.ok(!JSON.stringify(sb).includes(w.dataHome.root), 'no host path in the record');
      await w.x.ok('nexus:session:cancel', r.session.id);
      await w.until(() => w.ended(r.job.id), 'the turn ends', 2 * MIN);
      sound(w, 'XA1');
    });
  },

  /** XA2: a network probe fails inside the turn container (no route, no DNS), and what the command printed says why. */
  async XA2() {
    return withWorld('node-test-app', async (w) => {
      const probe = "const net=require('net');const s=net.connect({host:'1.1.1.1',port:443,timeout:4000});"
        + "s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',(e)=>{console.log('NOPE '+e.code);process.exit(2)});"
        + "s.on('timeout',()=>{console.log('NOPE timeout');process.exit(3)});";
      const dns = "require('dns').lookup('example.com',(e,a)=>{console.log(e?'DNS_NOPE '+e.code:'DNS_OK '+a);process.exit(e?2:0)});";
      w.script((plan) => [
        { op: 'call', tool: 'sandbox_exec', args: { argv: ['node', '-e', probe], cwd: '/workspace', timeoutMs: 60_000 } },
        { op: 'call', tool: 'sandbox_exec', args: { argv: ['node', '-e', dns], cwd: '/workspace', timeoutMs: 60_000 } },
        { op: 'complete' }]);
      const t = await w.turn('Probe the network', { ms: 5 * MIN });
      const ex = w.execResults(t.jobId);
      assert.equal(ex.length, 2, JSON.stringify(ex));
      assert.notEqual(ex[0].exit, 0, 'the TCP connection failed');
      assert.match(ex[0].stdout, /NOPE/); assert.doesNotMatch(ex[0].stdout, /CONNECTED/);
      assert.notEqual(ex[1].exit, 0, 'the name did not resolve');
      assert.match(ex[1].stdout, /DNS_NOPE/); assert.doesNotMatch(ex[1].stdout, /DNS_OK/);
      sound(w, 'XA2');
    });
  },

  /** XA3: the container sees no host path beyond /workspace: a file next to the worktree is not there, no host mount appears. */
  async XA3() {
    return withWorld('node-test-app', async (w) => {
      const sibling = path.join(w.userData, 'xa3-host-secret.txt');
      fs.writeFileSync(sibling, 'only on the host\n');
      fs.writeFileSync(path.join(w.repoDir, 'xa3-repo-secret.txt'), 'only in the repo\n');
      const script = [
        'echo "[root]"; ls -a /',
        'echo "[workspace]"; ls -a /workspace',
        'echo "[find]"; find / -xdev \\( -name xa3-host-secret.txt -o -name xa3-repo-secret.txt \\) 2>/dev/null',
        'echo "[mounts]"; cut -d" " -f2 /proc/mounts',
        'echo "[pointer]"; p=$(sed "s/^gitdir: //" /workspace/.git 2>/dev/null); if [ -n "$p" ] && [ -e "$p" ]; then echo REACHABLE; else echo UNREACHABLE; fi'
      ].join('; ');
      const t = await runOne(w, ['sh', '-c', script]);
      const out = w.execResults(t.jobId)[0];
      assert.equal(out.exit, 0, JSON.stringify(out));
      // The command printed `[name]` section headers; a section is the lines up to the next header (it may be empty).
      const sections = {}; let cur = null;
      for (const line of out.stdout.split('\n')) { const m = /^\[([a-z]+)\]$/.exec(line); if (m) { cur = m[1]; sections[cur] = []; } else if (cur) sections[cur].push(line); }
      const part = (name) => (sections[name] ?? []).join('\n');
      assert.deepEqual(Object.keys(sections), ['root', 'workspace', 'find', 'mounts', 'pointer'], 'every section was printed');
      assert.equal(part('find').trim(), '', 'a file beside the worktree and a file of the repository are nowhere in the container');
      assert.doesNotMatch(out.stdout, /xa3-/);
      assert.match(part('workspace'), /\.git/, '/workspace is the worktree');
      const dests = part('mounts').split('\n').map((x) => x.trim()).filter(Boolean);
      assert.equal(dests.filter((d) => d === '/workspace').length, 1, 'one mount at /workspace');
      for (const d of dests) assert.doesNotMatch(d, /^\/(Users|c|mnt|host_mnt|run\/desktop|home\/[^n])/, `no host mount: ${d}`);
      assert.match(part('pointer'), /UNREACHABLE/, 'the worktree\'s pointer to the repository names a path the container cannot open');
      assert.doesNotMatch(part('pointer'), /(^|\n)REACHABLE/);
      sound(w, 'XA3');
    });
  },

  /** XA4: cancel leaves nothing behind: no container, volume or network of the job, the token revoked, the worktree kept. */
  async XA4() {
    return withWorld('node-test-app', async (w) => {
      const r = await startHeld(w, ['sleep', '300']);
      await w.sleepFake(3000);
      const attempt = w.db.prepare('SELECT id FROM job_attempts WHERE job_id = ?').get(r.job.id);
      assert.ok(w.agentContainers().length === 1);
      await w.x.ok('nexus:session:cancel', r.session.id);
      await w.until(() => w.ended(r.job.id), 'the turn is cancelled', 3 * MIN);
      assert.equal(w.jobRow(r.job.id).state, 'cancelled');
      await w.until(() => { const l = labelled(w.home, { 'nexus.job': r.job.id }); return l.containers.length + l.networks.length + l.volumes.length === 0; },
        'nothing of the job is left in Docker', 3 * MIN);
      assert.equal(docker(['ps', '-a', '-q', '--filter', `label=nexus.attempt=${attempt.id}`]).stdout.trim(), '', 'docker ps -a finds no container of the attempt');
      assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0, 'the token is revoked');
      assert.ok(fs.existsSync(w.worktreeDir(r.session.id)), 'the worktree is kept');
      assert.equal(w.db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(r.session.id).status, 'running', 'the conversation stays open');
      sound(w, 'XA4');
    });
  },

  /** XA5: a restart mid-turn: the job and session are interrupted at once, and the new runner's phase B removes the container. */
  async XA5() {
    const w = await xaWorld('node-test-app');
    let w2 = null;
    try {
      const r = await startHeld(w, ['sleep', '300']);
      assert.equal(w.agentContainers().length, 1);
      const wt = w.db.prepare('SELECT rel_path, ref FROM session_worktrees WHERE session_id = ?').get(r.session.id);
      const refBefore = w.refOf(wt.ref);
      // The process dies: main and its runner. The turn's container is still up in Docker.
      w2 = await w.restart();
      await w2.until(() => w2.jobRow(r.job.id).state === 'interrupted', 'the turn is interrupted', 3 * MIN);
      assert.equal(w2.db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(r.session.id).status, 'interrupted');
      assert.equal(w2.db.prepare('SELECT revoke_reason FROM capability_tokens WHERE job_id = ?').get(r.job.id).revoke_reason, 'restart');
      await w2.until(() => w.agentContainers().length === 0, 'the new runner removes the turn container in phase B', 5 * MIN);
      assert.equal(docker(['ps', '-a', '-q', '--filter', `label=nexus.job=${r.job.id}`]).stdout.trim(), '', 'no container of the job is left');
      assert.ok(fs.existsSync(w.worktreeDir(r.session.id)), 'the worktree is kept');
      assert.equal(w2.refOf(wt.ref), refBefore, 'its session ref is kept');
      assert.ok(w2.db.prepare('SELECT 1 FROM session_worktrees WHERE session_id = ? AND removed_at IS NULL').get(r.session.id));
      sound(w2, 'XA5');
    } finally {
      try { if (w2) await w2.close(); } catch { /* best effort */ }
      try { await w2?.old?.core?.shutdown(); } catch { /* best effort */ }
      try { await w.close(); } catch { /* best effort */ }
    }
  },

  /**
   * XA6 e2e.sde.iteration: cs.tests_pass passes and fails on a real fixture, with the real test runner of the sde image: a change whose
   * test genuinely fails stays out of candidate; the next turn (the iteration, the same conversation) fixes it, and v2, derived from v1,
   * reaches candidate. `kind`: 'node' (node:test) or 'python' (pytest).
   */
  async XA6(kind) {
    const fixture = kind === 'node' ? 'node-test-app' : 'pytest-app';
    return withWorld(fixture, async (w) => {
      const code = REAL[kind];
      const one = await makeChange(w, { files: code.fail, title: 'Add a sum with a failing test', clientKey: 'xa6-v1', message: 'Add the sum' });
      assert.equal(one.turn.job.state, 'completed', one.turn.job.error_json);
      assert.equal(await w.until_candidate(one.cs, 20 * MIN), 'failed', 'the real test run failed, so the change set is not a candidate');
      assert.equal(w.checks(one.cs)['cs.tests_pass'], 'failed');
      const tp1 = w.db.prepare("SELECT summary, evidence_json FROM validations WHERE version_id = ? AND validator_id = 'cs.tests_pass' ORDER BY rowid DESC").get(one.cs);
      assert.match(tp1.summary, /fail/i);
      assert.ok(JSON.parse(tp1.evidence_json).some((e) => e.type === 'junit'), 'the evidence is the real JUnit report');
      assert.notEqual(w.stepOf('ai-implementation'), 'done');
      // The iteration: the same conversation fixes the test; v2 of the same change set.
      const artifact = w.versionRow(one.cs).artifact_id;
      const two = await makeChange(w, { files: code.fixed, title: 'Add a sum', clientKey: 'xa6-v2', reviseArtifactId: artifact, sessionId: one.turn.sessionId, message: 'Fix the failing test' });
      assert.equal(two.turn.job.state, 'completed', two.turn.job.error_json);
      assert.equal(await w.until_candidate(two.cs, 20 * MIN), 'candidate', 'the real test run passed');
      assert.equal(w.checks(two.cs)['cs.tests_pass'], 'passed');
      assert.match(w.db.prepare("SELECT summary FROM validations WHERE version_id = ? AND validator_id = 'cs.tests_pass' ORDER BY rowid DESC").get(two.cs).summary, /pass/i);
      assert.equal(w.versionRow(two.cs).artifact_id, artifact, 'v2 of the same change set');
      assert.ok(w.db.prepare("SELECT 1 FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND relation = 'derived_from'").get(two.cs, one.cs), 'v2 derived_from v1');
      assert.equal(w.stepOf('ai-implementation'), 'done');
      assert.equal(await w.railStep('iteration'), 'done', 'a second version that passed its checks is an iteration');
      assert.equal(w.checks(one.cs)['cs.tests_pass'], 'failed', 'v1 keeps its own failed result');
      sound(w, `XA6 ${kind}`);
    });
  },

  /**
   * XA7: the worktree bind holds a planted link, and the guard refuses it after sandbox_exec. The command tries to plant the link from
   * inside the container (`ln -s`, which a Docker Desktop bind mount on Windows may refuse); when it did not appear on the host, the test
   * plants it on the host while the command is still in flight, so the guard has a real bind mount and a real exec to walk after.
   */
  async XA7() {
    return withWorld('node-test-app', async (w) => {
      const outside = h.tmpDir('nx-xa7-outside-');
      fs.writeFileSync(path.join(outside, 'private.txt'), 'outside the worktree\n');
      const before = w.userState();
      w.script((plan) => [
        { op: 'call', tool: 'sandbox_exec', args: { argv: ['sh', '-c', 'ln -s /etc /workspace/evil-link; echo ln-exit=$?; sleep 8'], cwd: '/workspace', timeoutMs: 120_000 } },
        { op: 'call', tool: 'changeset_register', args: { title: 'After the link', summary: 'x', clientKey: 'xa7' } },
        { op: 'complete' }]);
      const r = await w.start('Run a command');
      await w.approveA3();
      await w.until(() => w.jobRow(r.job.id).state === 'running' && w.agentContainers().length === 1, 'the command is in flight', 3 * MIN);
      const link = path.join(w.worktreeDir(r.session.id), 'evil-link');
      await w.sleepFake(5000);
      let how = 'the container';
      let planted = false;
      try { planted = fs.lstatSync(link).isSymbolicLink(); } catch { planted = false; }
      if (!planted) {
        how = 'the host (the bind mount did not make a link for ln -s in the container)';
        fs.rmSync(link, { recursive: true, force: true });
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      }
      console.log(`[XA7] the link was planted by ${how}`);
      await w.until(() => w.ended(r.job.id), 'the turn ends', 5 * MIN);
      const job = w.jobRow(r.job.id);
      assert.equal(job.state, 'failed', job.error_json);
      assert.equal(job.outcome, 'worktree_guard', `the guard refused the tree after the exec (${job.error_json})`);
      assert.equal(w.changeSetsOf(r.job.id).length, 0, 'nothing was registered');
      assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'outside the worktree\n');
      await w.until(() => w.agentContainers().length === 0, 'the turn container is removed', 3 * MIN);
      assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0);
      assert.deepEqual(w.userState(), before, 'the user\'s folder is untouched');
      sound(w, 'XA7');
    });
  }
};

module.exports = { xa, xaWorld };
