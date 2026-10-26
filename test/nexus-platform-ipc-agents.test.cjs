'use strict';
// B2b Task 14: the agent channels #42-#51 through the one wrapper, the bounded diff preview of a change set, #23's agent row,
// the runtime health wiring (the runner's probe -> main's cache) and the merge confirmation. IA1-IA15 plus the carry-forwards.
// Real SQLite (test:db); a fake runner that answers the probe; nothing launches Electron, Docker, the engine or touches userData.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { agentWorld } = require('./helpers/agentFixtures.cjs');
const { FakeRunner } = require('./helpers/fakeRunner.cjs');
const { ipcOver, asLocalUser, noLeak, intent } = require('./helpers/ipcExec.cjs');
const { resolveDataHome } = loadTs('src/main/nexusExec/dataHome.ts');
const IPC = loadTs('src/main/nexusIpc/registerNexusIpc.ts');
const { registerNexusIpc, NEXUS_AGENT_CHANNELS, NEXUS_ALL_CHANNELS, NEXUS_EVERY_CHANNEL } = IPC;
const { AGENT_REASON_MESSAGES: REASON_MESSAGES, REASON_MESSAGES: B1_REASONS, AGENTS_SUB_REASONS } = loadTs('src/main/nexusIpc/envelope.ts');
const { PlatformError } = loadTs('src/main/nexus/errors.ts');
const { AcceptService } = loadTs('src/main/nexus/repo/acceptService.ts');
const { hostsSha256 } = loadTs('src/main/nexus/agents/budgetService.ts');
const { AGENT_DEFAULTS } = loadTs('src/shared/nexus/agentPolicy.ts');
const { GIT_DIFF_MAX_BYTES_PER_SIDE } = loadTs('src/shared/nexus/execution.ts');
const { mergeDialogOptions, confirmMergeWith } = loadTs('src/main/nexusExec/mergeDialog.ts');
const ACT = loadTs('src/renderer/src/nexus/project/activityModel.ts');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PROJECT = 'p-ledger';
const WS = 'sde';
const UNKNOWN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const API_HOST = { host: 'api.anthropic.com', port: 443 };
const OK_HEALTH = { ok: true, version: '2.1.309' };
const okRuntime = (o = {}) => ({ kind: 'cli-agent', health: o.health ?? OK_HEALTH,
  setup: { signedIn: o.signedIn ?? 'yes', flagsOk: true, label: 'Test Engine', egressHosts: o.hosts ?? [API_HOST] } });
const probeMsg = (st) => ({ op: 'probe.result', probe: { docker: 'running', gpu: { detected: false, usableInContainers: false } }, images: [],
  freeBytes: 10 ** 12, runtimes: st.runtimes });
/** What the scheduler's own probe is answered with: the sandbox facts and NO runtimes (the engine is checked only on request). */
const sandboxMsg = () => probeMsg({ runtimes: [] });

/** A v10 world, a runner that answers every probe with `st.runtimes`, and the 51 channels registered as main does. */
function world(o = {}) {
  const dataHome = resolveDataHome(h.tmpDir('nx-ia-home-'));
  const w = agentWorld({ agents: o.agents, platform: { dataHome, ...(o.platform ?? {}) } });
  w.dataHome = dataHome;
  w.st = { runtimes: o.runtimes ?? [okRuntime()] };
  if (o.agents !== false && !o.noRunner) {
    // As the real runner answers: the sandbox probe at once; the runtimes (a second result) only for a probe flagged `runtimes: true`.
    w.runner = new FakeRunner(o.hung ? { neverAnswers: true } : { probeReply: (msg) => (msg.runtimes === true ? [sandboxMsg(), probeMsg(w.st)] : [sandboxMsg()]) });
    w.nx.exec.attachRunner(w.runner, w.nx.bootId);
    // The first look at the engine is on demand (the setup sheet opening); nothing asks for it at attach or on a timer.
    if (!o.noInitialRefresh && w.nx.agentProbe) w.nx.agentProbe.refresh();
  }
  w.confirms = [];
  w.confirmAnswer = o.confirm ?? false;
  w.x = ipcOver(w, { agentsUnavailableReason: o.agentsReason ?? (() => null),
    ...(o.noConfirm ? {} : { confirmMerge: async (info) => { w.confirms.push(info); return w.confirmAnswer; } }) });
  w.addUser = (id, role, scope = 'project', scopeId = PROJECT) => {
    w.db.prepare('INSERT INTO principals VALUES (?,?,?,NULL,?)').run(id, 'user', id, h.NOW);
    w.db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?)').run(id, scope, scopeId, role, h.NOW);
    return { id, kind: 'user', displayName: id };
  };
  return w;
}
const grant = (w, caps) => w.x.ok('nexus:agent:consent', { op: 'grant', ...(caps ? { caps } : {}) });
const startArgs = (o = {}) => ({ projectId: PROJECT, workspaceId: WS, sessionId: null, focusVersionIds: [], message: 'add a ledger export', intentId: intent(), ...o });

/**
 * A change set version in the given status (a git head, its recorded base and branch in metadata, like Task 8 writes it). The default
 * metadata says its preview is COMPLETE (`previewComplete: true`, which ingest always writes): approval is refused without it, so the
 * fixtures that need an approval carry it, and the ones that test the refusal override it.
 */
function addChangeSet(w, { status = 'draft', kind = 'change_set', storage = { kind: 'git', commit: HEAD }, metadata = { base: BASE, branch: 'main', title: 'Add a thing', previewComplete: true } } = {}) {
  const pw = w.nx.workspaces.primaryOf(w.me, PROJECT);
  const art = require('./load-ts.cjs')('src/main/nexus/db/ids.ts').newId(w.clock.t + Math.floor(Math.random() * 1000));
  w.db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, description, owner_scope, owner_participation_id, owner_workspace_id,
      created_by, status, current_version_id, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, 'change', NULL, 'participation', ?, ?, 'user:local', 'active', NULL, '{}', ?, ?)`).run(art, PROJECT, kind, pw.id, pw.workspaceId, w.clock.t, w.clock.t);
  const v = w.nx.artifacts.registerVersion(w.me, { artifactId: art, storage, metadata }).version.id;
  if (status !== 'draft') w.nx.artifacts.finalize(w.sys, v, 'candidate');
  if (status === 'active') {
    w.db.transaction(() => {
      w.db.prepare("UPDATE artifact_versions SET status = 'active' WHERE id = ?").run(v);
      w.db.prepare('UPDATE artifacts SET current_version_id = ? WHERE id = ?').run(v, art);
    })();
  }
  return v;
}
const setRoot = (w, root) => w.db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(root, PROJECT);
/** A git read that answers from a script and records every task it was asked. */
function fakeGitRead(answer) {
  const tasks = [];
  return { tasks, request: async (task) => { tasks.push(task); return typeof answer === 'function' ? answer(task) : answer; } };
}
const withFakeGit = (w, gitRead) => {
  w.nx.accepts = new AcceptService(w.db, { auth: w.nx.auth, principals: w.nx.principals, artifacts: w.nx.artifacts, jobs: w.nx.jobs, validation: w.nx.validation,
    gitRead, system: w.sys, now: () => w.clock.t, acceptFsRoot: (r) => (typeof r === 'string' && r ? r : null) });
  return gitRead;
};
const diffOk = (patch, o = {}) => ({ ok: true, read: 'diff', base: BASE, head: HEAD, patch, bytes: Buffer.byteLength(patch), truncated: o.truncated === true });
const preview = (w, versionId, extra = {}) => w.x.call('nexus:version:preview', versionId, { part: 'diff', maxBytes: 65536, ...extra });

// ---------- IA1: registration ----------

test('IA1 the ten agent channels are frozen, distinct, registered once each through the one wrapper, and exposed by the preload exactly once', () => {
  assert.equal(NEXUS_AGENT_CHANNELS.length, 10); assert.equal(new Set(NEXUS_AGENT_CHANNELS).size, 10); assert.ok(Object.isFrozen(NEXUS_AGENT_CHANNELS));
  assert.deepEqual([...NEXUS_EVERY_CHANNEL], [...NEXUS_ALL_CHANNELS, ...NEXUS_AGENT_CHANNELS]);
  assert.equal(NEXUS_EVERY_CHANNEL.length, 51);
  for (const c of NEXUS_AGENT_CHANNELS) assert.ok(!NEXUS_ALL_CHANNELS.includes(c), c);
  const got = [];
  const deps = (more) => ({ platform: () => null, unavailableReason: () => 'held', sources: {}, log: () => {}, executionUnavailableReason: () => null, ...more });
  registerNexusIpc({ handle: (c) => got.push(c) }, deps({ agentsUnavailableReason: () => null }));
  assert.deepEqual([...got].sort(), [...NEXUS_EVERY_CHANNEL].sort());
  assert.equal(new Set(got).size, 51, 'each channel once');
  // Without the agent deps only the 41 B1 and B2a channels exist (the B2a callers are unchanged).
  const base = []; registerNexusIpc({ handle: (c) => base.push(c) }, deps({}));
  assert.deepEqual([...base].sort(), [...NEXUS_ALL_CHANNELS].sort());
  // The preload: one literal and one invoke per channel, ten methods.
  const preload = read('src/preload/index.ts');
  for (const c of NEXUS_AGENT_CHANNELS) assert.equal((preload.match(new RegExp(`ipcRenderer\\.invoke\\('${c}'`, 'g')) || []).length, 1, c);
  const methods = (preload.match(/^\s{2}(nexus[A-Z][A-Za-z]*):/gm) || []).map((x) => x.trim().slice(0, -1));
  for (const m of ['nexusAgentStart', 'nexusSessionsList', 'nexusSessionGet', 'nexusSessionEnd', 'nexusSessionCancel', 'nexusReviewDecide', 'nexusChangeSetAccept',
    'nexusRepoStatus', 'nexusRepoMergeAccepted', 'nexusAgentConsent']) assert.ok(methods.includes(m), m);
  assert.equal(methods.length, 51, 'B1 21 + B2a 20 + 10 agent methods');
});


// ---------- IA2: with the agents part off ----------

test('IA2 with v10 off the ten channels answer platform_unavailable / agents_unavailable / subReason, and #1-#41 still answer; #23 shows the row unavailable', async () => {
  let reason = 'not_enabled';
  const w = world({ agents: false, noRunner: true, agentsReason: () => reason });
  assert.equal(w.nx.agentsAvailable, false);
  const args = {
    'nexus:agent:start': [startArgs()], 'nexus:sessions:list': [{ projectId: PROJECT }], 'nexus:session:get': [UNKNOWN], 'nexus:session:end': [UNKNOWN],
    'nexus:session:cancel': [UNKNOWN], 'nexus:review:decide': [UNKNOWN, { decision: 'approve' }, intent()], 'nexus:changeSet:accept': [UNKNOWN, BASE],
    'nexus:repo:status': [PROJECT], 'nexus:repo:mergeAccepted': [PROJECT, { branch: 'main', expectedAcceptedHead: BASE }], 'nexus:agent:consent': [{ op: 'get' }]
  };
  for (const sub of ['not_enabled', 'held', 'auto_held', 'backup_failed', 'failed', 'shape']) {
    reason = sub;
    for (const ch of NEXUS_AGENT_CHANNELS) {
      const r = await w.x.call(ch, ...args[ch]);
      assert.deepEqual([r.ok, r.code, r.reason, r.subReason], [false, 'platform_unavailable', 'agents_unavailable', sub], `${ch} ${sub}`);
      assert.equal(r.message, 'Agent work is not available on this database.');
      noLeak(r, ch);
    }
  }
  // The platform's own state applies when main says nothing: agents were never composed here.
  reason = null;
  const r = await w.x.call('nexus:sessions:list', { projectId: PROJECT });
  assert.deepEqual([r.reason, r.subReason], ['agents_unavailable', 'not_enabled']);
  // An unknown sub-reason is never echoed.
  reason = 'C:\\Users\\x';
  assert.equal((await w.x.call('nexus:sessions:list', { projectId: PROJECT })).subReason, 'not_enabled');
  assert.deepEqual([...AGENTS_SUB_REASONS].sort(), ['auto_held', 'backup_failed', 'failed', 'held', 'not_enabled', 'not_started', 'registry_invalid', 'shape', 'v8_unavailable']);
  // #1-#41 still answer.
  assert.equal((await w.x.call('nexus:participations:list')).ok, true);
  assert.equal((await w.x.call('nexus:jobs:list', {})).ok, true);
  const health = await w.x.ok('nexus:platform:health');
  assert.equal(health.agent.state, 'off');
  assert.equal(health.agent.consent.live, false);
  // With agents off, #24 still says so for the agent flow actions.
  const actions = await w.x.ok('nexus:actions:available', { projectId: PROJECT, workspaceId: WS });
  assert.equal(actions.find((a) => a.actionId === 'sde.agent.turn').reason, 'agents_unavailable');
});

test('IA2b with no platform at all every agent channel answers the store\'s reason', async () => {
  const x = ipcOver({ nx: null, dataHome: null }, { platform: () => null, agentsUnavailableReason: () => null });
  for (const ch of NEXUS_AGENT_CHANNELS) { const r = await x.call(ch, {}); assert.deepEqual([r.ok, r.code, r.reason], [false, 'platform_unavailable', 'held'], ch); }
});

// ---------- IA3: nothing the renderer must not choose is accepted ----------

test('IA3 no path, command, principal, model id or host is accepted by any agent channel; hostile arguments are bad requests', async () => {
  const w = world();
  const banned = { path: 'C:\\x', cwd: '/x', command: 'rm', principal: 'user:local', principalId: 'user:local', actor: 'a', actorId: 'a', role: 'owner',
    model: 'm', modelId: 'm', host: 'evil.example.com', hosts: ['evil.example.com:443'], image: 'i', network: 'host', argv: ['x'], env: { A: 'b' }, runtime: 'x', worktree: 'x', token: 't' };
  const bad = async (ch, args, field) => {
    const r = await w.x.call(ch, ...args);
    assert.deepEqual([r.ok, r.code, r.reason], [false, 'invalid', 'bad_request'], `${ch} ${field}: ${JSON.stringify(r)}`);
    noLeak(r, ch);
    return r;
  };
  for (const [k, v] of Object.entries(banned)) {
    assert.equal((await bad('nexus:agent:start', [{ ...startArgs(), [k]: v }], k)).field, k);
    await bad('nexus:sessions:list', [{ projectId: PROJECT, [k]: v }], k);
    await bad('nexus:review:decide', [UNKNOWN, { decision: 'approve', [k]: v }, intent()], k);
    await bad('nexus:repo:mergeAccepted', [PROJECT, { branch: 'main', expectedAcceptedHead: BASE, [k]: v }], k);
    await bad('nexus:agent:consent', [{ op: 'grant', [k]: v }], k);
    await bad('nexus:agent:consent', [{ op: 'grant', caps: { turnUsdCents: 100, [k]: v } }], k);
  }
  // Shapes: ids, lengths, counts, enums, arity.
  const ok = startArgs();
  const NUL = String.fromCharCode(0);
  for (const patch of [{ projectId: 'a b' }, { workspaceId: 'SDE' }, { sessionId: 'nope' }, { sessionId: undefined }, { focusVersionIds: [UNKNOWN, UNKNOWN] },
    { focusVersionIds: Array.from({ length: 21 }, (_, i) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, '0')}`) }, { focusVersionIds: 'x' }, { message: '' }, { message: '   ' },
    { message: 'x'.repeat(8001) }, { message: `a${NUL}b` }, { message: 7 }, { skillId: '../x' }, { intentId: 'short' }]) {
    await bad('nexus:agent:start', [{ ...ok, ...patch }], JSON.stringify(Object.keys(patch)));
  }
  await bad('nexus:agent:start', [], 'none'); await bad('nexus:agent:start', [ok, ok], 'two'); await bad('nexus:agent:start', ['x'], 'str');
  await bad('nexus:sessions:list', [{ projectId: PROJECT, statuses: ['nope'] }], 'status');
  await bad('nexus:sessions:list', [{ projectId: PROJECT, statuses: [] }], 'empty statuses');
  await bad('nexus:session:get', ['x'], 'id'); await bad('nexus:session:end', [{}], 'obj'); await bad('nexus:session:cancel', [null], 'null');
  await bad('nexus:review:decide', [UNKNOWN, { decision: 'merge' }, intent()], 'decision');
  await bad('nexus:review:decide', [UNKNOWN, { decision: 'reject', comment: 'x'.repeat(4001) }, intent()], 'comment');
  await bad('nexus:review:decide', [UNKNOWN, { decision: 'approve' }, 'x'], 'intent');
  await bad('nexus:changeSet:accept', [UNKNOWN, 'abc'], 'head'); await bad('nexus:changeSet:accept', [UNKNOWN, 'A'.repeat(40)], 'upper');
  await bad('nexus:repo:status', ['a b'], 'project');
  await bad('nexus:repo:mergeAccepted', [PROJECT, { branch: '--upload-pack=x y', expectedAcceptedHead: BASE }], 'branch');
  await bad('nexus:repo:mergeAccepted', [PROJECT, { branch: 'main', expectedAcceptedHead: 'abc' }], 'sha');
  await bad('nexus:agent:consent', [{ op: 'nope' }], 'op'); await bad('nexus:agent:consent', [{ op: 'get', caps: {} }], 'caps with get');
  await bad('nexus:agent:consent', [{ op: 'revoke', caps: {} }], 'caps with revoke');
  await bad('nexus:agent:consent', [{ op: 'grant', caps: { turnUsdCents: 0 } }], 'cap 0'); await bad('nexus:agent:consent', [{ op: 'grant', caps: { turnUsdCents: 1.5 } }], 'cap float');
  await bad('nexus:agent:consent', [{ op: 'grant', caps: { wallClockMs: 5 } }], 'wall clock is not a stored cap');
  // Proxies and accessors are refused, never run.
  let ran = false;
  const hostile = { get message() { ran = true; return 'x'; } };
  await bad('nexus:agent:start', [hostile], 'getter');
  assert.equal(ran, false);
  await bad('nexus:agent:start', [new Proxy({}, { ownKeys() { throw new Error('trap'); } })], 'proxy');
  assert.equal(w.x.logs.length, 0, 'nothing was logged as internal');
});

// ---------- #23 health: the agent row ----------

test('H1 #23 carries the agent row: state, label (this row only), version, signedIn, consent {live, caps, hostsCount}, usageToday; hosts appear nowhere', async () => {
  const w = world();
  const health = await w.x.ok('nexus:platform:health');
  const a = health.agent;
  assert.deepEqual([a.state, a.label, a.version, a.signedIn, a.flagsOk], ['ready', 'Test Engine', '2.1.309', 'yes', true]);
  assert.deepEqual(a.consent, { live: false, caps: null, hostsCount: 0, grantedAt: null });
  assert.deepEqual(a.usageToday, { usdCents: 0, turns: 0, estimated: false });
  // The label is on the setup row only: the rest of the health answer never names the engine or a host.
  const { agent, ...rest } = health;
  assert.doesNotMatch(JSON.stringify(rest), /Test Engine|anthropic|api\./);
  const g = await grant(w);
  assert.equal(g.consent.live, true); assert.equal(g.consent.hostsCount, 1);
  assert.doesNotMatch(JSON.stringify(await w.x.ok('nexus:platform:health')), /anthropic|api\.|engine\.example/, 'hosts are never in #23');
  // ... only in #51's consent row (F24): the same answer without its `hosts` names none.
  assert.deepEqual(g.consent.hosts, ['api.anthropic.com:443']);
  const { hosts: _h, ...consentRest } = g.consent;
  assert.doesNotMatch(JSON.stringify({ ...g, consent: consentRest }), /anthropic|api\./);
  // Every state of the cached health.
  const states = [[{ ok: false, reason: 'not_installed', detail: 'x' }, 'not_installed'], [{ ok: false, reason: 'not_authenticated', detail: 'x' }, 'not_signed_in'],
    [{ ok: false, reason: 'version_unsupported', detail: 'x' }, 'version_unsupported'], [{ ok: false, reason: 'error', detail: 'x' }, 'unavailable']];
  for (const [health2, state] of states) {
    w.st.runtimes = [okRuntime({ health: health2, signedIn: state === 'not_signed_in' ? 'no' : 'unknown' })];
    w.runner.report(probeMsg(w.st));
    const v = (await w.x.ok('nexus:platform:health')).agent;
    assert.equal(v.state, state); assert.equal(v.version, null);
    if (state === 'not_signed_in') assert.equal(v.signedIn, 'no');
  }
  noLeak(await w.x.ok('nexus:platform:health'));
  w.nx.exec.attachRunner(null, w.nx.bootId);
  assert.equal((await w.x.ok('nexus:platform:health')).agent.state, 'unknown', 'no runner, no known health');
});

// ---------- #51 consent: caps only, hosts from the probe, clamped, owner only ----------

test('IA15 a #51 grant with caps above D-B4 is clamped (never refused); lower caps stay lower; the row holds only what the probe reported', async () => {
  const w = world();
  const g = await grant(w, { turnUsdCents: 99999, dayUsdCents: 5_000_000, turnsPerHour: 100, concurrentTurns: 9, turnTokens: 10 ** 9, toolCalls: 10 ** 6 });
  assert.deepEqual(g.consent.caps, { turnUsdCents: 200, dayUsdCents: 1000, turnsPerHour: 6, concurrentTurns: 1, turnTokens: 400_000, toolCalls: 200,
    wallClockMs: AGENT_DEFAULTS.wallClockMs, childJobs: AGENT_DEFAULTS.childJobs });
  const row = w.db.prepare('SELECT * FROM runtime_consents WHERE revoked_at IS NULL').get();
  assert.equal(row.turn_usd_cents, 200); assert.equal(row.day_usd_cents, 1000); assert.equal(row.turns_per_hour, 6); assert.equal(row.concurrent_turns, 1);
  assert.equal(row.turn_tokens, 400_000); assert.equal(row.tool_calls, 200);
  assert.equal(row.hosts_json, JSON.stringify(['api.anthropic.com:443']), 'the destination is the adapter\'s, from the probe');
  assert.equal(row.hosts_sha256, hostsSha256([API_HOST]));
  assert.equal(row.runtime_kind, 'cli-agent');
  // One live consent at a time, with its own sentence; revoke is idempotent and ends it.
  const again = await w.x.refused('nexus:agent:consent', [{ op: 'grant' }], 'conflict', { reason: 'consent_live' });
  assert.equal(again.message, REASON_MESSAGES.consent_live);
  assert.equal((await w.x.ok('nexus:agent:consent', { op: 'revoke' })).consent.live, false);
  assert.equal((await w.x.ok('nexus:agent:consent', { op: 'revoke' })).consent.live, false);
  const lower = await grant(w, { turnUsdCents: 50, toolCalls: 10 });
  assert.equal(lower.consent.caps.turnUsdCents, 50); assert.equal(lower.consent.caps.toolCalls, 10); assert.equal(lower.consent.caps.dayUsdCents, 1000);
  // Omitted caps take the ceilings.
  await w.x.ok('nexus:agent:consent', { op: 'revoke' });
  assert.equal((await grant(w)).consent.caps.turnUsdCents, 200);
});

test('C2 the destinations of a grant are the adapter\'s own as the probe reported them; with no probe answer there is no grant', async () => {
  const w = world();
  w.st.runtimes = [okRuntime({ hosts: [{ host: 'models.example.com', port: 443 }] })];
  w.runner.report(probeMsg(w.st));
  await grant(w);
  assert.equal(w.db.prepare('SELECT hosts_json FROM runtime_consents WHERE revoked_at IS NULL').get().hosts_json, JSON.stringify(['models.example.com:443']));
  // No runtime ever reported: nothing to grant for.
  const none = world({ noRunner: true });
  const r = await none.x.refused('nexus:agent:consent', [{ op: 'grant' }], 'unavailable', { reason: 'runtime_unknown' });
  assert.equal(r.message, REASON_MESSAGES.runtime_unknown);
  assert.equal(none.db.prepare('SELECT COUNT(*) n FROM runtime_consents').get().n, 0);
});

test('IA9 #51 grant and revoke need the owner role: a viewer is denied, audited, and nothing is stored; get is judged like #23', async () => {
  const w = world();
  const viewer = w.addUser('u-viewer', 'viewer');
  const restore = asLocalUser(w.nx, viewer);
  const d0 = w.db.prepare("SELECT COUNT(*) n FROM activity WHERE status = 'denied'").get().n;
  await w.x.refused('nexus:agent:consent', [{ op: 'grant' }], 'denied');
  await w.x.refused('nexus:agent:consent', [{ op: 'revoke' }], 'denied');
  assert.ok(w.db.prepare("SELECT COUNT(*) n FROM activity WHERE status = 'denied'").get().n > d0, 'the denials are audited');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM runtime_consents').get().n, 0);
  restore();
  for (const p of [w.sys, { id: 'agent:x', kind: 'agent', displayName: 'x' }]) {
    const r2 = asLocalUser(w.nx, p);
    await w.x.refused('nexus:agent:consent', [{ op: 'grant' }], 'denied');
    r2();
  }
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM runtime_consents').get().n, 0);
  await grant(w);
  const r3 = asLocalUser(w.nx, viewer);
  await w.x.refused('nexus:agent:consent', [{ op: 'revoke' }], 'denied');
  // `get` is judged like #23 (the platform health read): a project viewer has no standing for it.
  await w.x.refused('nexus:agent:consent', [{ op: 'get' }], 'denied');
  r3();
  assert.equal((await w.x.ok('nexus:agent:consent', { op: 'get' })).consent.live, true, 'still live');
});

test('H2 the engine check is on demand: the flag rides only on a refresh, with the live consent\'s hash only while a consent is live; a grant or revoke refreshes', async () => {
  const w = world({ noInitialRefresh: true });
  const probes = () => w.runner.sentOf('probe');
  assert.ok(probes().length >= 1);
  assert.ok(probes().every((p) => p.runtimes === undefined && p.consentHostsSha256 === undefined), 'attach: the scheduler\'s probe is sandbox-only, never the engine');
  w.nx.exec.requestProbe();
  assert.ok(probes().every((p) => p.runtimes === undefined), 'the scheduler/requestProbe path never carries the flag');
  assert.equal(w.nx.agentProbe.cache.fresh(), null, 'nothing was checked yet: unknown, not ok');
  assert.equal(w.nx.agentProbe.refresh(), true);
  assert.deepEqual(probes().at(-1), { op: 'probe', runtimes: true }, 'a refresh before consent: flagged, no hash (the runner stays deny-all)');
  assert.ok(w.nx.agentProbe.cache.fresh(), 'its answer filled the cache');
  const n0 = probes().length;
  await grant(w);
  assert.equal(probes().length, n0 + 1, 'a grant asks for a fresh check at once');
  assert.deepEqual(probes().at(-1), { op: 'probe', runtimes: true, consentHostsSha256: hostsSha256([API_HOST]) });
  // The scheduler's own probe, even with a live consent, stays plain (requestProbe is rate limited: let its window pass).
  w.advance(6000);
  w.nx.exec.requestProbe();
  assert.deepEqual(probes().at(-1), { op: 'probe' });
  const n1 = probes().length;
  await w.x.ok('nexus:agent:consent', { op: 'revoke' });
  assert.equal(probes().length, n1 + 1, 'a revoke asks for a fresh check');
  assert.deepEqual(probes().at(-1), { op: 'probe', runtimes: true }, 'revoked: the check is deny-all again');
});

test('I1 with agents off the engine is never asked for: no flag on any probe, #23 \"Check again\" included; the wrapper drops a flag nobody should send', async () => {
  const w = world({ agents: false, agentsReason: () => 'not_enabled' });
  w.runner = new FakeRunner({ probeReply: () => sandboxMsg() });
  w.nx.exec.attachRunner(w.runner, w.nx.bootId);
  assert.equal(w.nx.agentProbe, null);
  w.nx.exec.requestProbe();
  await w.x.ok('nexus:platform:health', { probe: true });
  w.clock.t += 120_000;
  w.nx.exec.tick(w.clock.t);
  w.nx.exec.sendToRunner({ op: 'probe', runtimes: true, consentHostsSha256: 'a'.repeat(64) });
  assert.ok(w.runner.sentOf('probe').length >= 2);
  assert.ok(w.runner.sentOf('probe').every((p) => p.runtimes === undefined && p.consentHostsSha256 === undefined), JSON.stringify(w.runner.sentOf('probe')));
});

test('I1b with agents on: no flag at attach, none from the scheduler\'s ticks; the flag comes from the setup sheet (#51 get when stale, #23 check again), a consent change, and a start with a stale answer', async () => {
  const w = world({ noInitialRefresh: true, platform: { runtimeHealthTtlMs: 60_000 } });
  const flagged = () => w.runner.sentOf('probe').filter((p) => p.runtimes === true).length;
  w.clock.t += 5 * 60_000;
  w.nx.exec.tick(w.clock.t);
  w.nx.exec.tick(w.clock.t + 120_000);
  assert.equal(flagged(), 0, 'no timer ever asks for the engine');
  await w.x.ok('nexus:agent:consent', { op: 'get' });
  assert.equal(flagged(), 1, 'the setup sheet opening (get while stale)');
  await w.x.ok('nexus:agent:consent', { op: 'get' });
  assert.equal(flagged(), 1, 'a fresh answer is not asked for again');
  await w.x.ok('nexus:platform:health', { probe: true });
  assert.equal(flagged(), 2, '"Check again" in the setup sheet');
  await grant(w);
  assert.equal(flagged(), 3);
  w.advance(60_001);
  await w.x.ok('nexus:agent:start', startArgs());
  assert.equal(flagged(), 4, 'a start with a stale answer asks first');
  await w.x.ok('nexus:platform:health');
  assert.equal(flagged(), 4, 'a plain health read never asks');
});

test('H3 the cached health is bounded in age: a stale ok reads unknown, is refreshed before a start, and never passes a start without an answer', async () => {
  const w = world({ platform: { runtimeHealthTtlMs: 60_000 } });
  await grant(w);
  assert.equal((await w.x.ok('nexus:platform:health')).agent.state, 'ready');
  const n0 = w.runner.sentOf('probe').length;
  w.advance(60_001);
  assert.equal((await w.x.ok('nexus:platform:health')).agent.state, 'unknown', 'old health is unknown, not ok');
  assert.equal(w.nx.agentProbe.cache.healthEntry(), null);
  // Before a start the stale cache is refreshed (the runner answers at once here), then the start is judged on fresh facts.
  const r = await w.x.ok('nexus:agent:start', startArgs());
  assert.equal(r.job.kind, 'agent.run');
  assert.equal(w.runner.sentOf('probe').length, n0 + 1, 'exactly one refresh');
  assert.equal(w.runner.sentOf('probe').at(-1).runtimes, true);
  // Stale and no runner to ask: the start is refused (the old ok never passes).
  const w2 = world({ platform: { runtimeHealthTtlMs: 60_000 } });
  await grant(w2);
  w2.nx.exec.attachRunner(null, w2.nx.bootId);
  w2.nx.agentProbe.cache.record([okRuntime()]);
  assert.ok(w2.nx.agentProbe.cache.fresh());
  w2.advance(60_001);
  const refused = await w2.x.refused('nexus:agent:start', [startArgs()], 'unavailable', { reason: 'runtime_unknown' });
  assert.equal(refused.message, REASON_MESSAGES.runtime_unknown);
  assert.equal(w2.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'agent.run'").get().n, 0);
  // Setup open and consent changes ask too: a stale `get` sends a probe.
  const w3 = world({ platform: { runtimeHealthTtlMs: 1000 } });
  const n3 = w3.runner.sentOf('probe').length;
  w3.advance(1001);
  await w3.x.ok('nexus:agent:consent', { op: 'get' });
  assert.equal(w3.runner.sentOf('probe').length, n3 + 1);
  // A clock that moved back never makes an entry fresh.
  w3.advance(-5000);
  assert.equal(w3.nx.agentProbe.cache.fresh(), null);
});

// ---------- #42-#46: sessions ----------

test('IA5 + IA4 start: a re-sent intent answers the same session and job; views carry no token, path, pid, container, worktree or principal id', async () => {
  const w = world();
  // Refusals first, each with its sentence and nothing created.
  const noConsent = await w.x.refused('nexus:agent:start', [startArgs()], 'unavailable', { reason: 'consent_missing' });
  assert.equal(noConsent.message, 'Agent turns need your network permission. Open Setup to grant it.');
  assert.doesNotMatch(noConsent.message, /anthropic|api\./);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'agent.run'").get().n, 0);
  w.st.runtimes = [okRuntime({ health: { ok: false, reason: 'not_authenticated', detail: 'x' }, signedIn: 'no' })];
  w.runner.report(probeMsg(w.st));
  await grant(w);
  const unauth = await w.x.refused('nexus:agent:start', [startArgs()], 'unavailable', { reason: 'runtime_not_authenticated' });
  assert.equal(unauth.message, REASON_MESSAGES.runtime_not_authenticated);
  w.st.runtimes = [okRuntime()];
  w.runner.report(probeMsg(w.st));

  const args = startArgs({ message: 'add a ledger export to the CSV report' });
  const r1 = await w.x.ok('nexus:agent:start', args);
  const r2 = await w.x.ok('nexus:agent:start', args);
  assert.equal(r1.session.id, r2.session.id); assert.equal(r1.job.id, r2.job.id);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'agent.run'").get().n, 1);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM agent_sessions').get().n, 1);
  assert.deepEqual([r1.job.kind, r1.job.state, r1.job.requestedByKind, r1.session.projectId, r1.session.workspaceId, r1.session.turns], ['agent.run', 'queued', 'user', PROJECT, WS, 1]);
  // Another intent in the same conversation while a turn runs: refused with its sentence.
  const busy = await w.x.refused('nexus:agent:start', [startArgs({ sessionId: r1.session.id })], 'conflict', { reason: 'turn_running' });
  assert.equal(busy.message, REASON_MESSAGES.turn_running);
  // The views.
  const list = await w.x.ok('nexus:sessions:list', { projectId: PROJECT });
  const detail = await w.x.ok('nexus:session:get', r1.session.id);
  assert.equal(list.length, 1); assert.equal(list[0].id, r1.session.id); assert.equal(list[0].liveJobId, r1.job.id);
  assert.equal(detail.turnHistory.length, 1);
  assert.deepEqual(detail.messages.map((m) => [m.from, m.text, m.displayOnly]), [['user', 'add a ledger export to the CSV report', true]]);
  const everything = JSON.stringify([r1, list, detail, await w.x.ok('nexus:platform:health')]);
  noLeak(JSON.parse(everything), 'agent views');
  const principals = w.db.prepare('SELECT id FROM principals').all().map((p) => p.id);
  for (const id of principals) assert.ok(!everything.includes(id), `no principal id (${id}) in a view`);
  const keys = new Set(); const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(JSON.parse(everything));
  for (const k of keys) assert.doesNotMatch(k, /^(token|bearer|pid|containerId|container|worktree\w*|configDir|principal\w*|actor\w*|hostPath|secret|password|credential|jti)$/i, `view key ${k}`);
  assert.doesNotMatch(everything, /nxt_|Bearer|api\.anthropic|engine\.example/);
  // The job view of the turn is the ordinary JobView (#27 reads it too).
  assert.equal((await w.x.ok('nexus:job:get', r1.job.id)).id, r1.job.id);
});

test('S1 cancel stops the live turn and keeps the conversation; end finishes it; unknown ids are not_found; a project filter and statuses work', async () => {
  const w = world();
  await grant(w);
  const a = await w.x.ok('nexus:agent:start', startArgs());
  const cancelled = await w.x.ok('nexus:session:cancel', a.session.id);
  assert.equal(cancelled.id, a.session.id); assert.equal(cancelled.liveJobId, null);
  assert.equal((await w.x.ok('nexus:job:get', a.job.id)).state, 'cancelled');
  const again = await w.x.refused('nexus:session:cancel', [a.session.id], 'conflict', { reason: 'no_turn' });
  assert.equal(again.message, REASON_MESSAGES.no_turn);
  const b = await w.x.ok('nexus:agent:start', startArgs({ sessionId: a.session.id }));
  assert.equal(b.session.id, a.session.id, 'the conversation continued');
  assert.equal(b.session.turns, 2);
  const ended = await w.x.ok('nexus:session:end', a.session.id);
  assert.ok(['completed', 'cancelled'].includes(ended.status), ended.status);
  assert.equal((await w.x.ok('nexus:session:end', a.session.id)).status, ended.status, 'ending twice answers the same');
  const gone = await w.x.refused('nexus:agent:start', [startArgs({ sessionId: a.session.id })], 'conflict', { reason: 'session_ended' });
  assert.equal(gone.message, REASON_MESSAGES.session_ended);
  for (const ch of ['nexus:session:get', 'nexus:session:end', 'nexus:session:cancel']) await w.x.refused(ch, [UNKNOWN], 'not_found');
  assert.equal((await w.x.ok('nexus:sessions:list', { projectId: PROJECT, statuses: [ended.status] })).length, 1);
  assert.equal((await w.x.ok('nexus:sessions:list', { projectId: PROJECT, statuses: ['running'] })).length, 0);
  await w.x.refused('nexus:sessions:list', [{ projectId: 'p-nothing' }], 'not_found');
});

test('IA11 with a hung runner #43 and #44 answer within 250 ms (they read the database only)', async () => {
  const w = world();
  await grant(w);
  const a = await w.x.ok('nexus:agent:start', startArgs());
  w.runner.o.neverAnswers = true; delete w.runner.o.probeReply;
  for (const [ch, args] of [['nexus:sessions:list', [{ projectId: PROJECT }]], ['nexus:session:get', [a.session.id]]]) {
    const t0 = Date.now();
    const r = await w.x.call(ch, ...args);
    assert.equal(r.ok, true, ch);
    assert.ok(Date.now() - t0 < 250, `${ch} took ${Date.now() - t0} ms`);
  }
});

test('S2 a queued turn shows why it waits: the phase reason rides on the job view while the headline stays within the closed set', async () => {
  const w = world();
  await grant(w);
  const a = await w.x.ok('nexus:agent:start', startArgs());
  await w.x.ok('nexus:agent:consent', { op: 'revoke' });
  w.runner.report({ op: 'ready', bootId: w.nx.bootId, mcpUrl: 'http://127.0.0.1:5555/mcp' });
  w.nx.exec.tick(w.clock.t);
  const j = await w.x.ok('nexus:job:get', a.job.id);
  assert.equal(j.state, 'queued');
  assert.equal(j.phase, 'waiting:consent', 'Task 15 can say "waiting for your network permission"');
  assert.equal(j.headline, 'queued');
  assert.equal((await w.x.ok('nexus:session:get', a.session.id)).turnHistory[0].headline, 'queued');
});

// ---------- #47 / #48: review and accept ----------

test('IA7 #48 on a non-candidate answers illegal_transition; #47 on a draft too; a candidate takes a review, once per intent', async () => {
  const w = world();
  setRoot(w, w.dataHome.root);
  const draft = addChangeSet(w, { status: 'draft' });
  const r = await w.x.refused('nexus:changeSet:accept', [draft, BASE], 'illegal_transition', { reason: 'not_candidate' });
  assert.equal(r.message, REASON_MESSAGES.not_candidate);
  const rv = await w.x.refused('nexus:review:decide', [draft, { decision: 'approve' }, intent()], 'illegal_transition', { reason: 'not_candidate' });
  assert.equal(rv.message, REASON_MESSAGES.not_candidate);
  // Not a change set at all: refused with a sentence.
  const repo = addChangeSet(w, { kind: 'repository', status: 'candidate', metadata: { profile: 'sde-node', branch: 'main', lockfile: { sha256: 'a'.repeat(64) } } });
  const nc = await w.x.refused('nexus:review:decide', [repo, { decision: 'approve' }, intent()], 'invalid', { reason: 'not_a_change_set' });
  assert.equal(nc.message, REASON_MESSAGES.not_a_change_set);
  await w.x.refused('nexus:changeSet:accept', [repo, BASE], 'invalid', { reason: 'not_a_change_set' });
  await w.x.refused('nexus:changeSet:accept', [UNKNOWN, BASE], 'not_found');
  // A candidate: request_changes and reject need a comment; approve is recorded once per intent (IA5).
  const cand = addChangeSet(w, { status: 'candidate' });
  const needs = await w.x.refused('nexus:review:decide', [cand, { decision: 'reject' }, intent()], 'invalid', { reason: 'comment_required' });
  assert.equal(needs.message, REASON_MESSAGES.comment_required);
  const it = intent();
  const a1 = await w.x.ok('nexus:review:decide', cand, { decision: 'approve', comment: 'looks right' }, it);
  const a2 = await w.x.ok('nexus:review:decide', cand, { decision: 'approve', comment: 'looks right' }, it);
  assert.equal(a1.review.id, a2.review.id);
  assert.deepEqual([a1.review.decision, a1.review.reviewerKind, a1.review.versionId, a1.job], ['approve', 'user', cand, null]);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM reviews WHERE version_id = ?').get(cand).n, 1);
  assert.deepEqual(Object.keys(a1.review).sort(), ['comment', 'createdAt', 'decision', 'id', 'jobId', 'reviewerKind', 'versionId']);
  const mism = await w.x.refused('nexus:review:decide', [cand, { decision: 'reject', comment: 'no' }, it], 'invalid', { reason: 'intent_mismatch' });
  noLeak(mism);
  // A secret in a comment is refused, never stored or echoed.
  const sec = await w.x.refused('nexus:review:decide', [cand, { decision: 'reject', comment: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, intent()], 'invalid', { reason: 'secret_in_comment' });
  assert.doesNotMatch(JSON.stringify(sec), /ghp_/);
  // Only a stored user decides.
  for (const p of [w.sys, { id: 'agent:x', kind: 'agent', displayName: 'x' }]) {
    const restore = asLocalUser(w.nx, p);
    await w.x.refused('nexus:review:decide', [cand, { decision: 'approve' }, intent()], 'denied');
    await w.x.refused('nexus:changeSet:accept', [cand, BASE], 'denied');
    restore();
  }
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM reviews WHERE version_id = ?').get(cand).n, 1);
});

test('IA6 A3 (the repository write approval) is answered by users only: the system and an agent are denied through #39', async () => {
  const w = world();
  for (const p of [w.sys, { id: 'agent:x', kind: 'agent', displayName: 'x' }]) {
    const restore = asLocalUser(w.nx, p);
    const r = await w.x.refused('nexus:approval:respond', [UNKNOWN, 'once'], 'denied');
    assert.equal(r.reason, 'user_only');
    restore();
  }
  // The agent channels have no door to an approval: none of them names the approval service.
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  const agentBlock = mod.slice(mod.indexOf('// ---------- B2b Task 14: the agent channels #42-#51'));
  assert.ok(agentBlock.length > 1000);
  assert.doesNotMatch(agentBlock, /nx\.approvals|approvalsOf|\.respond\(/);
});

test('E1 every refusal of the accept, merge and review flows reaches the renderer as one plain sentence: never git text, a path or a sha (ref_moved names the head it found)', async () => {
  const w = world();
  // The agent sentences live apart from the B1/B2a ones (the renderer mirrors those word for word): no reason is in both.
  for (const k of Object.keys(B1_REASONS)) assert.ok(!(k in REASON_MESSAGES), k);
  const RAW = `fatal: C:\\Users\\x\\repo\\.git failed at ${'c'.repeat(40)} (exit 128)`;
  const thrown = { err: null };
  w.nx.accepts = { accept: async () => { throw thrown.err; }, mergeAccepted: async () => { throw thrown.err; }, status: async () => { throw thrown.err; } };
  const reasons = ['ref_moved', 'merge_conflict', 'accept_rolled_back', 'integration_unexpected', 'tree_dirty', 'branch_mismatch', 'not_fast_forward', 'nothing_to_merge',
    'cancelled', 'accept_pending', 'merge_pending'];
  for (const reason of reasons) {
    thrown.err = new PlatformError('conflict', RAW, { reason, current: 'd'.repeat(40), expected: 'e'.repeat(40), jobId: UNKNOWN, rollbackOwed: true, path: 'C:\\secret' });
    for (const [ch, args] of [['nexus:changeSet:accept', [UNKNOWN, BASE]], ['nexus:repo:mergeAccepted', [PROJECT, { branch: 'main', expectedAcceptedHead: BASE }]]]) {
      const r = await w.x.refused(ch, args, 'conflict', { reason });
      assert.equal(r.message, REASON_MESSAGES[reason], `${ch} ${reason}`);
      assert.doesNotMatch(r.message, /fatal|exit 128|\.git/);
      assert.doesNotMatch(JSON.stringify(r), /C:\\|Users|secret/);
      assert.deepEqual(Object.keys(r.detail ?? {}).sort(), ['current', 'jobId', 'rollbackOwed'], 'only the allow-listed detail');
      assert.equal(r.detail.current, 'd'.repeat(40)); assert.equal(r.detail.rollbackOwed, true);
      assert.ok(!('expected' in (r.detail ?? {})));
    }
  }
  assert.match(REASON_MESSAGES.tree_dirty, /tracked files/);
  assert.match(REASON_MESSAGES.tree_dirty, /untracked/);
  // A refusal the map does not know keeps its scrubbed text, never a path.
  thrown.err = new PlatformError('unavailable', RAW, { reason: 'git_failed' });
  const u = await w.x.call('nexus:repo:mergeAccepted', PROJECT, { branch: 'main', expectedAcceptedHead: BASE });
  assert.deepEqual([u.ok, u.code, u.reason], [false, 'unavailable', 'git_failed']);
  assert.doesNotMatch(JSON.stringify(u), /C:\\|Users/);
  // Every reason a person can reach through the agent flows has a sentence, none of them a bare code.
  for (const reason of ['agents_unavailable', 'runtime_unknown', 'runtime_not_installed', 'runtime_not_authenticated', 'runtime_version_unsupported', 'runtime_error',
    'runtime_mismatch', 'consent_missing', 'consent_mismatch', 'consent_live', 'budget_exhausted', 'rate_limited', 'turn_running', 'session_ended', 'no_turn',
    'secret_in_message', 'message_too_long', 'unknown_skill', 'secret_in_comment', 'comment_required', 'comment_too_long', 'not_a_change_set', 'not_candidate',
    'not_approved', ...reasons, 'no_such_part', 'no_commit', 'runner_unavailable', 'branch_unknown', 'git_missing']) {
    const m = REASON_MESSAGES[reason];
    assert.ok(typeof m === 'string' && m.length > 10 && /[.?]$/.test(m) && !/_/.test(m), reason);
  }
});

// ---------- #49 / #50: status and merge ----------

test('IA8 #50 cancel answers cancelled; the only confirmation the accept service gets is main\'s dialog function; with none wired a merge is cancelled', async () => {
  const MERGE = { id: 'M1', projectId: PROJECT, branch: 'main', before: BASE, after: HEAD, shaConfirmed: HEAD, mergedBy: 'user:local', mergedAt: 5, ffJobId: UNKNOWN };
  const seen = [];
  const fakeAccepts = (cancelMessage) => ({ mergeAccepted: async (me, projectId, args, confirm) => {
    seen.push({ args, confirm });
    const info = { projectId, branch: args.branch, from: BASE, to: args.expectedAcceptedHead, commitCount: 1, accepted: [{ versionId: UNKNOWN, title: 'T', mergeCommit: HEAD, acceptedAt: 1 }] };
    if ((await confirm(info)) !== true) throw new PlatformError('conflict', cancelMessage, { reason: 'cancelled' });
    return { merge: MERGE };
  } });
  const margs = [PROJECT, { branch: 'main', expectedAcceptedHead: HEAD }];
  const w = world({ confirm: false });
  w.nx.accepts = fakeAccepts('git said fatal at C:\\x');
  const c = await w.x.refused('nexus:repo:mergeAccepted', margs, 'conflict', { reason: 'cancelled' });
  assert.equal(c.message, REASON_MESSAGES.cancelled);
  assert.equal(w.confirms.length, 1, 'main\'s dialog function was asked once');
  assert.deepEqual(w.confirms[0].accepted.map((a) => a.title), ['T']);
  assert.equal(typeof seen[0].confirm, 'function');
  // The user says yes in the dialog: the merge view is a closed shape, with no principal id or job id.
  w.confirmAnswer = true;
  const m = await w.x.ok('nexus:repo:mergeAccepted', ...margs);
  assert.deepEqual(m, { projectId: PROJECT, branch: 'main', before: BASE, after: HEAD, mergedAt: 5 });
  // Anything but an exact true is no (a truthy string, a number, an object from a misbehaving dialog).
  for (const bad of ['yes', 1, {}, 'true']) {
    w.confirmAnswer = bad;
    await w.x.refused('nexus:repo:mergeAccepted', margs, 'conflict', { reason: 'cancelled' });
  }
  // No dialog wired at all: cancelled, always.
  const w2 = world({ noConfirm: true });
  w2.nx.accepts = fakeAccepts('x');
  await w2.x.refused('nexus:repo:mergeAccepted', margs, 'conflict', { reason: 'cancelled' });
  // The confirmation is whatever main passed as the dependency, nothing from the request: pinned in the source.
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  assert.equal((mod.match(/mergeAccepted\(/g) || []).length, 1, 'one call');
  assert.match(mod, /mergeAccepted\(me, q\.projectId, \{ branch: q\.branch, expectedAcceptedHead: q\.expectedAcceptedHead \}, confirmMerge\)/);
  assert.match(mod, /const confirmMerge: \(info: MergeConfirmInfo\) => Promise<boolean> = deps\.confirmMerge \?\? \(async \(\) => false\);/);
  assert.equal((mod.match(/deps\.confirmMerge/g) || []).length, 2, 'the dependency is read in two places: whether to register, and the confirmation itself');
  // main: the dependency is the execution handle's confirmMerge; the dialog is passed to startExecution only.
  const idx = read('src/main/index.ts');
  assert.match(idx, /confirmMerge: \(info\) => \(nexusExecution \? nexusExecution\.confirmMerge\(info\) : Promise\.resolve\(false\)\)/);
  assert.match(idx, /mergeDialog: \(info\) => confirmMergeOn\(BrowserWindow\.getFocusedWindow\(\) \?\? mainWindow, \(win, o\) => dialog\.showMessageBox\(win, o\), info\) \}\)/);
  assert.doesNotMatch(idx, /dialog\.showMessageBox\(o\)/, 'never a parent-less dialog');
  assert.equal((idx.match(/confirmMerge/g) || []).length, 4, 'the import of the dialog, the dep, the comment line, and the handle call');
  assert.equal((idx.match(/mergeAccepted|\.accepts\b/g) || []).length, 0, 'index.ts never calls the accept service');
  // Nothing else under src/main calls mergeAccepted or builds a confirm.
  for (const f of fs.readdirSync(path.join(ROOT, 'src/main'), { recursive: true }).map(String).filter((x) => x.endsWith('.ts'))) {
    const t = read(path.join('src/main', f));
    const calls = (t.match(/\.mergeAccepted\(/g) || []).length;
    assert.equal(calls, f.replace(/\\/g, '/') === 'nexusIpc/registerNexusIpc.ts' ? 1 : 0, f);
  }
});

test('M1 the merge dialog lists the commits, names the branch, defaults to Cancel and says only tracked files are checked; only the Merge button confirms', async () => {
  const sha = (c) => c.repeat(40);
  const info = { projectId: PROJECT, branch: 'main', from: sha('a'), to: sha('b'), commitCount: 3, accepted: [
    { versionId: UNKNOWN, title: 'Add the export', mergeCommit: sha('1'), acceptedAt: 1 },
    { versionId: UNKNOWN, title: 'Line one\nline two with\ttabs ghp_abcdefghijklmnopqrstuvwxyz0123456789 and ' + 'x'.repeat(300), mergeCommit: sha('2'), acceptedAt: 2 },
    { versionId: UNKNOWN, title: '', mergeCommit: sha('3'), acceptedAt: 3 }] };
  const o = mergeDialogOptions(info);
  assert.deepEqual(o.buttons, ['Cancel', 'Merge']);
  assert.equal(o.defaultId, 0); assert.equal(o.cancelId, 0);
  assert.equal(o.noLink, true);
  assert.match(o.message, /3 accepted changes/); assert.match(o.message, /"main"/);
  assert.match(o.detail, /11111111/); assert.match(o.detail, /22222222/); assert.match(o.detail, /33333333/);
  assert.match(o.detail, /Add the export/); assert.match(o.detail, /Agent change/);
  assert.match(o.detail, /aaaaaaaa to bbbbbbbb/);
  assert.match(o.detail, /tracked/); assert.match(o.detail, /untracked/);
  assert.doesNotMatch(o.detail, /ghp_/, 'a secret-shaped title is redacted');
  for (const l of o.detail.split('\n')) assert.ok(l.length < 400, 'titles are cut');
  // 14 commits: ten are listed, the rest counted.
  const many = mergeDialogOptions({ ...info, commitCount: 14, accepted: Array.from({ length: 14 }, (_, i) => ({ versionId: UNKNOWN, title: `T${i}`, mergeCommit: sha('4'), acceptedAt: i })) });
  assert.match(many.detail, /and 4 more/);
  assert.equal(mergeDialogOptions({ ...info, commitCount: 1, accepted: info.accepted.slice(0, 1) }).message.startsWith('Merge 1 accepted change into'), true);
  // Only the Merge button confirms.
  assert.equal(await confirmMergeWith(async () => ({ response: 1 }), info), true);
  for (const r of [{ response: 0 }, { response: 2 }, { response: '1' }, {}, null, undefined]) assert.equal(await confirmMergeWith(async () => r, info), false, JSON.stringify(r));
  assert.equal(await confirmMergeWith(async () => { throw new Error('closed'); }, info), false);
  let shown = null;
  await confirmMergeWith(async (opts) => { shown = opts; return { response: 0 }; }, info);
  assert.equal(shown.defaultId, 0);
});

test('P1 #49 status: a repository that cannot be read answers a status that says why (never an error); a real status maps to the closed view', async () => {
  const w = world();
  setRoot(w, w.dataHome.root);
  // No branch recorded yet: the status says so.
  withFakeGit(w, fakeGitRead({ ok: false, code: 'git_missing', message: 'fatal: C:\\Users\\x' }));
  const none = await w.x.ok('nexus:repo:status', PROJECT);
  assert.deepEqual([none.branch, none.canFastForward, none.reason, none.acceptedNotMerged], [null, false, 'branch_unknown', 0]);
  // A recorded branch, git missing.
  addChangeSet(w, { kind: 'repository', status: 'active', metadata: { profile: 'sde-node', branch: 'main', lockfile: { sha256: 'a'.repeat(64) } } });
  const missing = await w.x.ok('nexus:repo:status', PROJECT);
  assert.equal(missing.reason, 'git_missing'); assert.equal(missing.canFastForward, false);
  noLeak(missing);
  // A readable repository: the closed view, the integration head as `acceptedHead`.
  withFakeGit(w, fakeGitRead({ ok: true, read: 'status', branch: 'main', head: BASE, dirty: false, integrationHead: HEAD, acceptedNotMerged: 2, fastForward: true }));
  const s = await w.x.ok('nexus:repo:status', PROJECT);
  assert.deepEqual(Object.keys(s).sort(), ['acceptedHead', 'acceptedNotMerged', 'branch', 'canFastForward', 'checkedAt', 'dirty', 'head', 'integrationRef', 'projectId', 'reason']);
  // `acceptedNotMerged` counts accepted CHANGES (accept records the branch lacks), not the commits git reports (2 here): nothing was
  // accepted in this world, so it is 0 (Task 16 fix round 1; before, it was git's commit count).
  assert.deepEqual([s.branch, s.head, s.dirty, s.integrationRef, s.acceptedHead, s.acceptedNotMerged], ['main', BASE, false, 'refs/nexus/accepted/main', HEAD, 0]);
  assert.equal(s.canFastForward, false, 'nothing was accepted, so the integration ref is not consistent and Merge is not offered');
  assert.equal(s.reason, 'integration_unexpected');
  await w.x.refused('nexus:repo:status', ['p-nothing'], 'not_found');
  const stranger = w.addUser('u-stranger', 'viewer', 'project', 'p-other');
  const restore = asLocalUser(w.nx, stranger);
  await w.x.refused('nexus:repo:status', [PROJECT], 'denied');
  restore();
});

test('P2 the merge block reason follows the order the merge itself refuses in, and a clean fast-forward is allowed', () => {
  const { mergeBlockReason, repoStatusView } = loadTs('src/main/nexusIpc/dto.ts');
  const ok = { branch: 'main', integrationRef: 'refs/nexus/accepted/main', integrationHead: HEAD, checkedOutBranch: 'main', head: BASE, acceptedNotMerged: 1, commitCount: 2, fastForward: true,
    userTreeClean: true, integrationConsistent: true, lastAcceptedHead: HEAD };
  assert.equal(mergeBlockReason(ok), null);
  assert.equal(mergeBlockReason({ ...ok, integrationConsistent: false }), 'integration_unexpected');
  assert.equal(mergeBlockReason({ ...ok, lastAcceptedHead: null }), 'nothing_to_merge');
  assert.equal(mergeBlockReason({ ...ok, acceptedNotMerged: 0 }), 'nothing_to_merge');
  assert.equal(mergeBlockReason({ ...ok, checkedOutBranch: 'dev' }), 'branch_mismatch');
  assert.equal(mergeBlockReason({ ...ok, userTreeClean: false }), 'tree_dirty');
  assert.equal(mergeBlockReason({ ...ok, fastForward: false }), 'not_fast_forward');
  const v = repoStatusView(PROJECT, ok, 7);
  assert.deepEqual([v.canFastForward, v.reason, v.dirty, v.checkedAt], [true, null, false, 7]);
});

// ---------- #34 diff ----------

test('IA13 the diff part works for a change set from its RECORDED base and head, is refused for other kinds, and an oversized diff says too_large', async () => {
  const w = world();
  setRoot(w, w.dataHome.root);
  const git = withFakeGit(w, fakeGitRead(diffOk('diff --git a/x b/x\n+one\n-two\n')));
  const cs = addChangeSet(w, { status: 'candidate' });
  const r = await preview(w, cs);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.data.part, r.data.versionId, r.data.text, r.data.rows, r.data.page, r.data.nextPage], ['diff', cs, 'diff --git a/x b/x\n+one\n-two\n', null, 0, null]);
  // The read named only what Nexus recorded: the base from the metadata, the head from the storage, the folder from the stored project.
  assert.equal(git.tasks.length, 1);
  assert.deepEqual(git.tasks[0], { read: 'diff', repoPath: w.dataHome.root, base: BASE, head: HEAD, maxBytesPerSide: GIT_DIFF_MAX_BYTES_PER_SIDE });
  assert.equal(GIT_DIFF_MAX_BYTES_PER_SIDE, 1_048_576);
  // The renderer cannot name a commit, a folder or a size beyond the page cap.
  for (const extra of [{ base: BASE }, { head: HEAD }, { repoPath: '/x' }, { cwd: '/x' }]) {
    const bad = await preview(w, cs, extra);
    assert.deepEqual([bad.ok, bad.code, bad.reason], [false, 'invalid', 'bad_request']);
  }
  assert.equal((await preview(w, cs, { fromRow: 0 })).ok, false, 'a text part pages by page');
  assert.equal(git.tasks.length, 1, 'refused requests never reached git');
  // Paging by maxBytes.
  const big = withFakeGit(w, fakeGitRead(diffOk('x'.repeat(250))));
  const p0 = await preview(w, cs, { maxBytes: 100 });
  assert.equal(p0.data.text.length, 100); assert.equal(p0.data.nextPage, 1); assert.equal(p0.data.totalBytes, 250);
  const p2 = await preview(w, cs, { maxBytes: 100, page: 2 });
  assert.equal(p2.data.text.length, 50); assert.equal(p2.data.nextPage, null);
  void big;
  // Other kinds: refused with the same answer the other parts give.
  const repo = addChangeSet(w, { kind: 'repository', status: 'candidate', metadata: { profile: 'sde-node', branch: 'main', lockfile: { sha256: 'a'.repeat(64) } } });
  const other = await preview(w, repo);
  assert.deepEqual([other.ok, other.code, other.reason], [false, 'invalid', 'no_such_part']);
  assert.equal(other.message, REASON_MESSAGES.no_such_part);
  assert.equal(big.tasks.length, 2, 'the repository version never reached git');
  // A diff the runner cut (1 MiB per side) or refused is too_large, in a sentence, with no patch.
  for (const answer of [diffOk('x'.repeat(100), { truncated: true }), { ok: false, code: 'too_large', message: 'fatal: C:\\Users\\x' }]) {
    withFakeGit(w, fakeGitRead(answer));
    const t = await preview(w, cs);
    assert.deepEqual([t.ok, t.code], [false, 'too_large']);
    assert.equal(t.message, 'This change is too large to show here.');
    noLeak(t);
  }
  // A failed read says so without the runner's own text.
  withFakeGit(w, fakeGitRead({ ok: false, code: 'unknown_ref', message: 'fatal: bad object C:\\Users\\x\\repo' }));
  const u = await preview(w, cs);
  assert.deepEqual([u.ok, u.code, u.reason], [false, 'unavailable', 'unknown_ref']);
  noLeak(u);
  // A change set that records no base cannot be shown (never a guess).
  withFakeGit(w, fakeGitRead(diffOk('x')));
  const nobase = addChangeSet(w, { status: 'candidate', metadata: { branch: 'main', title: 'x' } });
  const nb = await preview(w, nobase);
  assert.deepEqual([nb.ok, nb.code, nb.reason], [false, 'unavailable', 'no_commit']);
  // A reader with no standing on the project is denied.
  const stranger = w.addUser('u-stranger', 'viewer', 'project', 'p-other');
  const restore = asLocalUser(w.nx, stranger);
  assert.equal((await preview(w, cs)).code, 'denied');
  restore();
  assert.equal((await preview(w, UNKNOWN)).code, 'not_found');
});

test('IA14 the diff preview of a change set with a secret line shows it redacted, even when the runner\'s answer was not', async () => {
  const w = world();
  setRoot(w, w.dataHome.root);
  const KEY = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const AWS = 'AKIAIOSFODNN7EXAMPLE';
  const patch = ['diff --git a/.env b/.env', '+++ b/.env', `+GITHUB_TOKEN=${KEY}`, `+aws_access_key_id=${AWS}`, '+PLAIN=value', ''].join('\n');
  withFakeGit(w, fakeGitRead(diffOk(patch)));
  const cs = addChangeSet(w, { status: 'candidate' });
  const r = await preview(w, cs);
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.data.text, new RegExp(`${KEY}|${AWS}`), 'neither secret reaches the renderer');
  assert.match(r.data.text, /PLAIN=value/, 'the rest of the diff is intact');
  assert.match(r.data.text, /redacted/i, 'the line shows that it was redacted');
  // Cut into pages the secret never reappears (the whole text is redacted before it is paged).
  let all = '';
  for (let page = 0; page < 40; page++) {
    const p = await preview(w, cs, { maxBytes: 16, page });
    all += p.data.text;
    if (p.data.nextPage === null) break;
  }
  assert.doesNotMatch(all, new RegExp(`${KEY}|${AWS}`));
});

// ---------- IA10 / IA12 ----------

test('IA10 the activity rows the agent flows write have keys and sentences: none reads as a bare action name', async () => {
  const w = world();
  await grant(w);
  await w.x.ok('nexus:agent:consent', { op: 'revoke' });
  const rows = w.db.prepare("SELECT * FROM activity WHERE action = 'agent.consent' ORDER BY seq").all();
  assert.equal(rows.length, 2);
  // The server's activity view carries the row's `op` (grant or revoke) so a sentence can tell them apart.
  const { activityView } = loadTs('src/main/nexusIpc/dto.ts');
  const toEntry = (r) => ({ seq: r.seq, ts: r.ts, action: r.action, status: r.status, actorKind: r.actor_kind, actorId: r.actor_id, onBehalfOf: r.on_behalf_of, entityType: r.entity_type,
    entityId: r.entity_id, projectId: r.project_id, workspaceId: r.workspace_id, artifactId: r.artifact_id, versionId: r.version_id, details: JSON.parse(r.details_json) });
  assert.deepEqual(rows.map((r) => activityView(toEntry(r)).details.op), ['grant', 'revoke']);
  const ctx = { names: new Map(), versionNos: new Map(), workspaceLabel: (x) => x, now: h.NOW + 5000 };
  const view = (action, details = {}, status = 'succeeded') => ({ seq: 1, ts: h.NOW, action, status, actorKind: 'user', onBehalfOfUser: false, entityType: 'x', entityId: null,
    projectId: PROJECT, workspaceId: WS, artifactId: null, versionId: null, details });
  for (const [i, row] of rows.entries()) {
    const text = ACT.activityText(view('agent.consent', { op: JSON.parse(row.details_json).op }), ctx);
    assert.doesNotMatch(text, /^Recorded|agent\.consent/);
    if (i === 0) assert.match(text, /given network permission/);
  }
  for (const action of ['agent.consent', 'token.mint', 'token.revoke', 'repo.worktree', 'review.decide', 'mcp.call', 'context_redacted', 'changeset.accept', 'changeset.rollback', 'repo.merge']) {
    assert.ok(ACT.ACTIVITY_ACTIONS.includes(action), `${action} is a listed action`);
    const text = ACT.activityText(view(action), ctx);
    assert.doesNotMatch(text, /^Recorded /, action);
    assert.doesNotMatch(text, new RegExp(action.replace('.', '\\.')), `${action} reads as a sentence`);
    assert.ok(ACT.actionWords(action).length > 3 && !/\./.test(ACT.actionWords(action)), `${action} has words for a refusal`);
  }
  // Every action the agent services write is one of them (a new row without a sentence fails here).
  const written = new Set();
  for (const f of ['src/main/nexus/agents/budgetService.ts', 'src/main/nexus/agents/agentService.ts', 'src/main/nexus/review/reviewService.ts', 'src/main/nexus/repo/acceptService.ts',
    'src/main/nexus/exec/acceptIngest.ts', 'src/main/nexus/agents/mcpGateway.ts', 'src/main/nexus/agents/tokenService.ts']) {
    for (const m of read(f).matchAll(/action: '([a-z_]+(?:\.[a-z_]+)?)'/g)) written.add(m[1]);
  }
  // (`auth.denied` is the gateway's own refusal row from Task 5: a denial reads "Refused: ..."; its words are the renderer's, Task 15's carry.)
  for (const a of written) if (a !== 'auth.denied') assert.ok(ACT.ACTIVITY_ACTIONS.includes(a), `${a} is written by the agent services and needs a sentence`);
});

test('IA12 no system-only method is reachable: the agent channels call a closed list of user-facing methods and nothing else', () => {
  const files = ['src/main/nexusIpc/registerNexusIpc.ts', 'src/main/nexusIpc/agentSetup.ts', 'src/main/nexusIpc/dto.ts'].map((f) => [f, read(f)]);
  const allowed = {
    agents: new Set(['start', 'get', 'list', 'end', 'cancel', 'revokeConsent']), reviews: new Set(['decide']), accepts: new Set(['accept', 'status', 'mergeAccepted']),
    budget: new Set(['grant', 'revoke', 'live', 'usageToday']), agentProbe: new Set(['cache', 'refresh', 'refreshAndWait'])
  };
  const SERVICES = ['agents', 'reviews', 'accepts', 'budget', 'agentProbe', 'tokens', 'mcpGateway', 'worktrees', 'changeSets', 'contextResolver', 'skills', 'gitRead'];
  for (const [f, text] of files) {
    for (const m of text.matchAll(/\bnx\.(\w+)(?:!)?\.(\w+)/g)) {
      if (!SERVICES.includes(m[1])) continue;
      assert.ok(allowed[m[1]]?.has(m[2]), `${f}: nx.${m[1]}.${m[2]} is not a user-facing agent method`);
    }
    for (const sys of ['revokeLiveAgentTokens', 'revokeForJob', 'mintTx', 'continueWith', 'reconcileEnded', 'interruptTurnTx', 'sessionFailedTx', 'turnLeftTx', 'planTx',
      'provisionedTx', 'runtimeEvent', 'recoverPhaseA', 'recoverPhaseB', 'bindAgents', 'bindMcpGateway', 'enqueueAcceptRollbackTx', 'startForAgent', 'attachRunner', 'sendToRunner']) {
      assert.doesNotMatch(text, new RegExp(`\\b${sys}\\b`), `${f} must not name ${sys}`);
    }
  }
  // The principal is the wrapper's alone: no agent channel reads one from its arguments (the existing scan also covers this file).
  const mod = files[0][1];
  assert.equal((mod.match(/principals\.localUser\(\)/g) || []).length, 1);
  // Through the real handlers: a request that tries to act for someone else is a bad request, never an action.
  assert.doesNotMatch(mod, /\b(o|a|q)\.(principal|principalId|actor|actorId|role|onBehalfOf)\b/);
});

// ---------- fix round 1: hosts in #51's consent row only, merge single-flight, the dialog fails closed ----------

test('I3 #51 names the destination in its consent row (hosts, `host:port`, the adapter\'s own) and no other answer does; #23 keeps only hostsCount', async () => {
  const w = world();
  // Before any grant: what a grant would cover, from the probe.
  const g0 = await w.x.ok('nexus:agent:consent', { op: 'get' });
  assert.deepEqual(g0.consent.hosts, ['api.anthropic.com:443']);
  assert.deepEqual([g0.consent.live, g0.consent.hostsCount], [false, 0]);
  const g1 = await grant(w);
  assert.deepEqual(g1.consent.hosts, ['api.anthropic.com:443']);
  assert.deepEqual([g1.consent.live, g1.consent.hostsCount], [true, 1]);
  assert.deepEqual((await w.x.ok('nexus:agent:consent', { op: 'get' })).consent.hosts, ['api.anthropic.com:443'], 'the live consent\'s own hosts');
  assert.deepEqual((await w.x.ok('nexus:agent:consent', { op: 'revoke' })).consent.hosts, ['api.anthropic.com:443'], 'after a revoke the sheet still names what a grant covers');
  await grant(w);
  // Every other answer: no host, no `hosts` key.
  const a = await w.x.ok('nexus:agent:start', startArgs());
  const others = [await w.x.ok('nexus:platform:health'), a, await w.x.ok('nexus:sessions:list', { projectId: PROJECT }), await w.x.ok('nexus:session:get', a.session.id),
    await w.x.ok('nexus:job:get', a.job.id), await w.x.ok('nexus:jobs:list', {}), await w.x.ok('nexus:actions:available', { projectId: PROJECT, workspaceId: WS }),
    await w.x.ok('nexus:events:since', { sinceSeq: 0 }), await w.x.ok('nexus:activity:byProject', PROJECT)];
  const text = JSON.stringify(others);
  assert.doesNotMatch(text, /anthropic|api\.|engine\.example|:443/);
  const keys = new Set(); const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(others);
  assert.ok(![...keys].some((k) => /^hosts?$/i.test(k)), 'no view but #51 has a hosts key');
  assert.equal(others[0].agent.consent.hostsCount, 1);
  assert.ok(!('hosts' in others[0].agent.consent));
  // The hosts are the adapter's own, whatever it reports.
  const w2 = world({ runtimes: [okRuntime({ hosts: [{ host: 'models.example.com', port: 443 }] })] });
  assert.deepEqual((await w2.x.ok('nexus:agent:consent', { op: 'get' })).consent.hosts, ['models.example.com:443']);
  assert.deepEqual((await grant(w2)).consent.hosts, ['models.example.com:443']);
  // Nothing probed yet: no host to show.
  const w3 = world({ noRunner: true });
  assert.deepEqual((await w3.x.ok('nexus:agent:consent', { op: 'get' })).consent.hosts, []);
  // The source: the consent view is built in one place and nowhere else puts a host into a view.
  const setup = read('src/main/nexusIpc/agentSetup.ts');
  assert.equal((setup.match(/hosts/g) || []).length > 0, true);
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  assert.equal((mod.match(/agentConsentView\(nx\)/g) || []).length, 3, 'get, grant and revoke of #51 only');
  assert.match(mod, /agentSetupView\(nx\)\)\);/, '#23 keeps the plain setup row');
  const dto = read('src/main/nexusIpc/dto.ts');
  assert.doesNotMatch(dto, /hosts\??\s*:|\.hosts|egressHosts/, 'dto.ts builds no view from a host list');
});

test('S3 #43 answers closed SessionView rows; #50 is single-flight per project: a second call answers merge_pending (no second dialog), and the slot is released afterwards', async () => {
  const w = world();
  await grant(w);
  const a = await w.x.ok('nexus:agent:start', startArgs());
  const list = await w.x.ok('nexus:sessions:list', { projectId: PROJECT });
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'id', 'liveJobId', 'projectId', 'status', 'turns', 'updatedAt', 'workspaceId']);
  assert.equal(list[0].id, a.session.id);
  // Single flight: the first merge waits on a repository read that does not answer.
  setRoot(w, w.dataHome.root);
  addChangeSet(w, { kind: 'repository', status: 'active', metadata: { profile: 'sde-node', branch: 'main', lockfile: { sha256: 'a'.repeat(64) } } });
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve({ ok: false, code: 'git_missing', message: 'x' }); });
  withFakeGit(w, { request: () => gate });
  const margs = [PROJECT, { branch: 'main', expectedAcceptedHead: HEAD }];
  const first = w.x.call('nexus:repo:mergeAccepted', ...margs);
  await new Promise((r) => setImmediate(r));
  const second = await w.x.refused('nexus:repo:mergeAccepted', margs, 'conflict', { reason: 'merge_pending' });
  assert.equal(second.message, 'The merge is still running. Ask again in a moment.');
  assert.equal(w.confirms.length, 0, 'no dialog was opened');
  release();
  const done = await first;
  assert.deepEqual([done.ok, done.code, done.reason], [false, 'unavailable', 'git_missing']);
  // The slot is free again: the next call is judged on its own (here: the repository answer), never merge_pending.
  withFakeGit(w, fakeGitRead({ ok: false, code: 'git_missing', message: 'x' }));
  const third = await w.x.call('nexus:repo:mergeAccepted', ...margs);
  assert.equal(third.reason, 'git_missing');
});

test('M2 the merge dialog fails closed: with no live window to parent it nothing is shown and the answer is no; only the Merge button on a live window confirms', async () => {
  const { confirmMergeOn } = loadTs('src/main/nexusExec/mergeDialog.ts');
  const info = { projectId: PROJECT, branch: 'main', from: BASE, to: HEAD, commitCount: 1, accepted: [{ versionId: UNKNOWN, title: 'T', mergeCommit: HEAD, acceptedAt: 1 }] };
  let shown = 0;
  const show = (answer) => async () => { shown++; return { response: answer }; };
  assert.equal(await confirmMergeOn(null, show(1), info), false);
  assert.equal(await confirmMergeOn(undefined, show(1), info), false);
  assert.equal(await confirmMergeOn({ isDestroyed: () => true }, show(1), info), false);
  assert.equal(await confirmMergeOn({ isDestroyed: () => { throw new Error('gone'); } }, show(1), info), false);
  assert.equal(shown, 0, 'no dialog without a window');
  const win = { isDestroyed: () => false };
  let parent = null;
  assert.equal(await confirmMergeOn(win, async (p, o) => { parent = p; assert.equal(o.defaultId, 0); return { response: 1 }; }, info), true);
  assert.equal(parent, win, 'the dialog is parented to the window');
  assert.equal(await confirmMergeOn(win, show(0), info), false);
  assert.equal(await confirmMergeOn(win, async () => { throw new Error('closed'); }, info), false);
  // main uses it with the focused or main window and has no other way to show the dialog.
  const idx = read('src/main/index.ts');
  assert.equal((idx.match(/confirmMergeOn\(/g) || []).length, 1);
  assert.doesNotMatch(idx, /confirmMergeWith/);
});

// ---------- fix round 2: a change set is never made current by hand; its newest review rides on its view; a late runtimes message ----------

test('PR1 promote and rollback of a change set are refused on every user path (the IPC channel and the service); the version is unchanged; other kinds still promote; the accept path\'s own promotion still works', async () => {
  const w = world();
  const SENTENCE = 'A change set is accepted through review, not made current directly.';
  const cs = addChangeSet(w, { status: 'candidate' });
  const row = (id) => w.db.prepare('SELECT status, promoted_by, promoted_at FROM artifact_versions WHERE id = ?').get(id);
  const current = (id) => w.db.prepare('SELECT current_version_id FROM artifacts WHERE id = (SELECT artifact_id FROM artifact_versions WHERE id = ?)').get(id).current_version_id;
  const before = { row: row(cs), current: current(cs), promotes: w.db.prepare("SELECT COUNT(*) n FROM activity WHERE action = 'version.promote'").get().n };
  // The channel, even after an approving review (the generic door skips review, accept and the Nexus branch).
  await w.x.ok('nexus:review:decide', cs, { decision: 'approve' }, intent());
  const r = await w.x.refused('nexus:version:promote', [cs, null], 'illegal_transition', { reason: 'change_set_not_promotable' });
  assert.equal(r.message, SENTENCE);
  // The service.
  assert.throws(() => w.nx.artifacts.promote(w.me, cs, null), (e) => e instanceof PlatformError && e.code === 'illegal_transition' && e.detail.reason === 'change_set_not_promotable' && e.message === SENTENCE);
  // A rollback target: a change set that was accepted and is deprecated now (promoted before) is refused the same way.
  w.db.prepare("UPDATE artifact_versions SET status = 'deprecated', promoted_at = ?, promoted_by = 'user:local' WHERE id = ?").run(w.clock.t, cs);
  const old = row(cs);
  await w.x.refused('nexus:version:promote', [cs, null], 'illegal_transition', { reason: 'change_set_not_promotable' });
  assert.throws(() => w.nx.artifacts.promote(w.me, cs, null), (e) => e.detail?.reason === 'change_set_not_promotable');
  assert.deepEqual(row(cs), old, 'unchanged');
  assert.equal(current(cs), before.current, 'the current pointer did not move');
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM activity WHERE action = 'version.promote'").get().n, before.promotes, 'no promote row was written');
  // Another kind still promotes through the same channel.
  const repo = addChangeSet(w, { kind: 'repository', status: 'candidate', metadata: { profile: 'sde-node', branch: 'main', lockfile: { sha256: 'a'.repeat(64) } } });
  const ok = await w.x.ok('nexus:version:promote', repo, null);
  assert.equal(ok.status, 'active');
  assert.equal('latestReview' in ok, false);
  // The internal path the accept ingest uses (the user's compare-and-set inside its own transaction) is untouched.
  const { immediateTx } = loadTs('src/main/nexus/db/tx.ts');
  const cs2 = addChangeSet(w, { status: 'candidate' });
  const p = immediateTx(w.db, () => w.nx.artifacts.promoteTx(w.me, cs2, null, w.clock.t, { onBehalfOf: w.me.id }));
  assert.equal(p.ok, true);
  assert.equal(row(cs2).status, 'active');
  assert.equal(row(cs2).promoted_by, w.me.id);
  // Source: the one public door refuses; the only promoteTx callers are the accept ingest, validation (repository) and handoff receipts.
  const svc = read('src/main/nexus/artifact/artifactService.ts');
  assert.match(svc, /kind === 'change_set'\) \{\s*throw new PlatformError\('illegal_transition', 'A change set is accepted through review, not made current directly\.'/);
  const callers = fs.readdirSync(path.join(ROOT, 'src/main'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts') && /\.promoteTx\(/.test(read(path.join('src/main', f)))).map((f) => f.replace(/\\/g, '/')).sort();
  assert.deepEqual(callers, ['nexus/artifact/artifactService.ts', 'nexus/exec/acceptIngest.ts', 'nexus/handoff/handoffService.ts', 'nexus/validation/validationService.ts']);
});

test('LR1 a change set\'s version view carries its newest review (decision and ISO time), null when never reviewed; no other kind has the field; no comment or reviewer id', async () => {
  const w = world();
  const a = addChangeSet(w, { status: 'candidate' });
  const b = addChangeSet(w, { status: 'candidate' });
  const repo = addChangeSet(w, { kind: 'repository', status: 'candidate', metadata: { profile: 'sde-node', branch: 'main', lockfile: { sha256: 'a'.repeat(64) } } });
  const artifactOf = (id) => w.db.prepare('SELECT artifact_id FROM artifact_versions WHERE id = ?').get(id).artifact_id;
  const viaGet = async (id) => (await w.x.ok('nexus:artifact:get', artifactOf(id))).versions.find((v) => v.id === id);
  const viaDetail = async (id) => w.x.ok('nexus:version:get', id);
  for (const get of [viaGet, viaDetail]) {
    assert.equal((await get(a)).latestReview, null, 'never reviewed');
    assert.equal('latestReview' in (await get(repo)), false, 'absent for another kind');
  }
  const t1 = w.clock.t;
  await w.x.ok('nexus:review:decide', a, { decision: 'approve', comment: 'private words' }, intent());
  for (const get of [viaGet, viaDetail]) {
    const v = await get(a);
    assert.deepEqual(Object.keys(v.latestReview).sort(), ['decidedAt', 'decision']);
    assert.equal(v.latestReview.decision, 'approve');
    assert.equal(v.latestReview.decidedAt, new Date(t1).toISOString());
    assert.equal((await get(b)).latestReview, null, 'a review of one version is not another\'s');
  }
  // A newer review replaces it, however old the first is; the older one is not shown.
  w.advance(5000);
  await w.x.ok('nexus:review:decide', a, { decision: 'reject', comment: 'second thoughts' }, intent());
  const v2 = await viaGet(a);
  assert.deepEqual(v2.latestReview, { decision: 'reject', decidedAt: new Date(t1 + 5000).toISOString() });
  w.advance(1000);
  await w.x.ok('nexus:review:decide', a, { decision: 'approve' }, intent());
  assert.equal((await viaDetail(a)).latestReview.decision, 'approve');
  // The view holds no comment text and no principal id; the other results that return a version carry it too.
  const text = JSON.stringify([await viaGet(a), await viaDetail(a)]);
  assert.doesNotMatch(text, /private words|second thoughts|user:local/);
  const discarded = await w.x.ok('nexus:version:discard', b);
  assert.equal(discarded.latestReview, null);
  assert.equal('latestReview' in (await w.x.ok('nexus:version:discard', repo)), false);
  // The shared type documents it (absent for other kinds).
  assert.match(read('src/shared/nexus/ipc.ts'), /latestReview\?: \{ decision: ReviewDecision; decidedAt: string \} \| null;/);
  // Reviews made with agents off cannot exist: a change set view without the review service says null, never throws.
  const off = world({ agents: false, noRunner: true, agentsReason: () => 'not_enabled' });
  const cs = addChangeSet(off, { status: 'candidate' });
  assert.equal((await off.x.ok('nexus:version:get', cs)).latestReview, null);
});

test('LP1 a late runtimes message records only the runtimes: it never overwrites a newer sandbox probe with its old facts (nor is it seen by the execution core)', async () => {
  const w = world({ noInitialRefresh: true });
  const sandbox = (docker) => ({ op: 'probe.result', probe: { docker: 'running', version: docker, gpu: { detected: false, usableInContainers: false } }, images: [], freeBytes: 10 ** 12, runtimes: [] });
  w.runner.report(sandbox('27.0.0'));
  assert.equal(w.nx.exec.health().docker.version, '27.0.0');
  // The flagged probe's sandbox facts (taken before the engine check), then a NEWER scheduler probe lands while the engine is checked.
  const stale = { ...sandbox('27.0.0'), runtimes: [okRuntime()] };
  w.advance(20_000);
  w.runner.report(sandbox('28.0.0'));
  const checkedAt = w.nx.exec.health().checkedAt;
  assert.equal(w.nx.exec.health().docker.version, '28.0.0');
  w.advance(5_000);
  w.runner.report(stale);
  const h2 = w.nx.exec.health();
  assert.equal(h2.docker.version, '28.0.0', 'the newer sandbox probe stands');
  assert.equal(h2.checkedAt, checkedAt, 'its time was not re-stamped');
  assert.equal(w.nx.agentProbe.cache.fresh()?.health.ok, true, 'the runtimes were recorded');
  // With agents off a stray non-empty list is not taken for sandbox state either.
  const off = world({ agents: false, noRunner: true, agentsReason: () => 'not_enabled' });
  off.runner = new FakeRunner({ probeReply: () => sandbox('27.0.0') });
  off.nx.exec.attachRunner(off.runner, off.nx.bootId);
  off.advance(10_000);
  off.runner.report(sandbox('28.0.0'));
  off.advance(10_000);
  off.runner.report({ ...sandbox('27.0.0'), runtimes: [okRuntime()] });
  assert.equal(off.nx.exec.health().docker.version, '28.0.0');
});

test('PV1 (A1) approval over IPC is refused (preview_incomplete) for a change set whose preview is false or not recorded, allowed when true; the other decisions are never blocked; the view carries previewComplete and previewReason', async () => {
  const w = world();
  const base = { base: BASE, branch: 'main', title: 'Add a thing' };
  const absent = addChangeSet(w, { status: 'candidate', metadata: { ...base } });
  const falsy = addChangeSet(w, { status: 'candidate', metadata: { ...base, previewComplete: false, previewReason: 'hidden_lines', previewHiddenLines: 2 } });
  const odd = addChangeSet(w, { status: 'candidate', metadata: { ...base, previewComplete: 'true' } });
  const fine = addChangeSet(w, { status: 'candidate' });
  for (const id of [absent, falsy, odd]) {
    const r = await w.x.refused('nexus:review:decide', [id, { decision: 'approve' }, intent()], 'conflict', { reason: 'preview_incomplete' });
    assert.equal(r.message, REASON_MESSAGES.preview_incomplete);
    assert.match(REASON_MESSAGES.preview_incomplete, /hidden or too large/);
    assert.equal(w.db.prepare('SELECT COUNT(*) n FROM reviews WHERE version_id = ?').get(id).n, 0, 'nothing recorded');
  }
  await w.x.ok('nexus:review:decide', falsy, { decision: 'reject', comment: 'not reviewable' }, intent());
  const rc = await w.x.call('nexus:review:decide', absent, { decision: 'request_changes', comment: 'smaller, please' }, intent());
  assert.notEqual(rc.reason, 'preview_incomplete', 'asking for changes is never blocked by the preview');
  assert.equal((await w.x.ok('nexus:review:decide', fine, { decision: 'approve' }, intent())).review.decision, 'approve');
  const view = async (id) => (await w.x.ok('nexus:version:get', id));
  const f = await view(fine); const x = await view(falsy); const a = await view(absent); const o = await view(odd);
  assert.deepEqual([f.previewComplete, f.previewReason], [true, null]);
  assert.deepEqual([x.previewComplete, x.previewReason], [false, 'hidden_lines']);
  assert.deepEqual([a.previewComplete, a.previewReason], [false, 'unknown'], 'not recorded is not complete');
  assert.deepEqual([o.previewComplete, o.previewReason], [false, 'unknown']);
  const repo = addChangeSet(w, { kind: 'repository', status: 'candidate', metadata: { profile: 'sde-node', branch: 'main', lockfile: { sha256: 'a'.repeat(64) } } });
  const r = await view(repo);
  assert.ok(!('previewComplete' in r) && !('previewReason' in r), 'other kinds have no such field');
});
