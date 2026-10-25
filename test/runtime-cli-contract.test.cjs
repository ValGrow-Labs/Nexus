'use strict';
// B2b Task 13, CR0-CR15: the CLI agent adapter (src/runner/runtimes/cliAgent). The installed agent CLI runs ONLY inside the
// Task 0 harness (decision D-B12): a fake home, a fake key, a loopback mock model and a deny-all proxy. It never touches
// the user's home, login or CLI store, and never the network. Every check that does not need the real executable runs
// against the stand-in (test/fixtures/agent/fake-cli.cjs); the others report "NOT RUN" when no CLI is installed.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const loadTs = require('./load-ts.cjs');
const H = require('./helpers/agentHarness.cjs');
const M = require('./helpers/mockModel.cjs');
const mockModel = require('./helpers/mockModel.cjs');
const fakeHome = require('./helpers/fakeHome.cjs');
const { collect, assertRuntimeContract } = require('./helpers/runtimeContract.cjs');
const probe = require('../tools/nexus-agent-probe.cjs');

const adapterMod = loadTs('src/runner/runtimes/cliAgent/adapter.ts');
const argsMod = loadTs('src/runner/runtimes/cliAgent/args.ts');
const envMod = loadTs('src/runner/runtimes/cliAgent/env.ts');
const filesMod = loadTs('src/runner/runtimes/cliAgent/files.ts');
const binaryMod = loadTs('src/runner/runtimes/cliAgent/binary.ts');
const streamMod = loadTs('src/runner/runtimes/cliAgent/stream.ts');
const seam = loadTs('src/runner/runtimes/cliAgent/testSeam.ts');
const { ProcTree, defaultTaskkillBin } = loadTs('src/runner/procTree.ts');
const { McpServer } = loadTs('src/runner/mcpServer.ts');
const { MCP_TOOLS } = loadTs('src/shared/nexus/mcpTools.ts');
const { SENSITIVE_PATH_RE } = loadTs('src/shared/nexus/changeSet.ts');
const { CliAgentAdapter, EGRESS_HOSTS } = adapterMod;

const ROOT = path.resolve(__dirname, '..');
const REPORT = JSON.parse(fs.readFileSync(path.join(ROOT, '.superpowers', 'sdd', '2026-10-21-nexus-b2b', 'task0-probe-report.json'), 'utf8'));
const FAKE = path.join(__dirname, 'fixtures', 'agent', 'fake-cli.cjs');
const AUTH_FIX = path.join(__dirname, 'fixtures', 'agent', 'probe');
const BIN = H.resolveCli();
const NO_CLI = BIN ? false : 'NOT RUN: the agent CLI is not installed';
const TOKEN = `${'q'.repeat(22)}.${'r'.repeat(43)}`;

const TMP = [];
after(() => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ } } });
const tmpDir = (p = 'nx-rt-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TMP.push(d); return d; };

// ---------------------------------------------------------------- helpers

async function until(pred, what, ms = 20_000) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const tasklistBin = () => path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tasklist.exe');
function isPidAlive(pid) {
  const r = cp.spawnSync(tasklistBin(), ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return typeof r.stdout === 'string' && r.stdout.includes(String(pid));
}
const untilPidGone = (pid, ms = 15_000) => until(() => !isPidAlive(pid), `pid ${pid} to end`, ms);

const script = (steps) => (_b, s) => steps[s] ?? null;
const use = (id, name, input) => [{ type: 'tool_use', id, name, input }];

/** A request for a turn whose job dir and worktree are under `root`. */
function mkReq(root, o = {}) {
  const configDir = o.configDir ?? path.join(root, 'job');
  const worktree = o.worktree ?? path.join(root, 'wt');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const ctxFile = path.join(configDir, 'context.md');
  fs.writeFileSync(ctxFile, o.contextText ?? '## context\nfor this turn\n');
  return {
    jobId: 'j1', attempt: 1, sessionId: 's1', idempotencyKey: 'k1', domainId: 'd1', skills: [],
    context: { hash: 'h'.repeat(64), file: ctxFile }, message: o.message ?? 'Do the work.',
    worktree: { hostPath: worktree, editable: ['/workspace'] }, container: { id: 'c1' }, mcp: { url: o.mcpUrl ?? 'http://127.0.0.1:1/mcp' },
    model: { provider: 'x', model: 'y' }, limits: { wallClockMs: o.wallClockMs ?? 120_000, maxTurns: 20 }, credential: { ref: 'runtime-owned' }, configDir
  };
}

async function withHarness(opts, fn) {
  const h = await H.start({ home: 'fake', mcp: 'recorder', model: 'mock', proxy: 'deny-all', ...opts });
  try { return await fn(h); } finally { await h.stop(); }
}

/** The real CLI through the test seam: the harness's fake home as the base environment, a loopback mock model. */
function realAdapter(h, over = {}, baseUrl = h.mock ? h.mock.url : null) {
  const overlay = { ANTHROPIC_API_KEY: H.FAKE_KEY };
  if (baseUrl) overlay.ANTHROPIC_BASE_URL = baseUrl;
  const make = seam.createCliAdapterForTests({ envOverlay: overlay, baseEnv: h.env, bin: BIN });
  return make({ token: TOKEN, mcpUrl: h.mcp.url, proxyUrl: () => h.proxy.url, mcpTools: h.mcpToolNames, ...over });
}
const reqOf = (h, o = {}) => mkReq(h.root, { configDir: h.jobDir, worktree: h.worktree, mcpUrl: h.mcp.url, ...o });

/** The stand-in, as an explicit executable (`process.execPath`) with its `--fake-*` knobs in the argv prefix. */
function fakeAdapter(knobs = [], over = {}) {
  const base = {
    SystemRoot: process.env.SystemRoot, USERPROFILE: 'C:\\fake\\home', HOMEDRIVE: 'C:', HOMEPATH: '\\fake\\home', APPDATA: 'C:\\fake\\home\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\fake\\home\\AppData\\Local', TEMP: 'C:\\fake\\tmp', ANTHROPIC_API_KEY: 'sk-ant-REAL-LOOKING', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDE_CONFIG_DIR: 'C:\\x',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth', MY_API_KEY: 'k', GITHUB_TOKEN: 'ghp_x', NODE_EXTRA_CA_CERTS: 'C:\\ca.pem', HTTP_PROXY: 'http://evil:1', HTTPS_PROXY: 'http://evil:2',
    NEXUS_MCP_TOKEN: 'inherited-token', ...(over.baseEnv ?? {})
  };
  return new CliAgentAdapter({ bin: process.execPath, argvPrefix: [FAKE, ...knobs], baseEnv: base, token: TOKEN, mcpUrl: 'http://127.0.0.1:1/mcp',
    proxyUrl: () => 'http://127.0.0.1:9', ...over, ...(over.baseEnv ? { baseEnv: base } : {}) });
}

// ---------------------------------------------------------------- CR0

const NEXUS_PROD = ['src/runner', 'src/shared/nexus', 'src/main/nexus', 'src/main/nexusExec'];
const walk = (d) => (!fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])));
const codeOnly = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('CR0 no production Nexus file names the test seam or its two environment names outside cliAgent/testSeam.ts', () => {
  const files = NEXUS_PROD.flatMap((d) => walk(path.join(ROOT, d))).filter((f) => /\.(ts|tsx)$/.test(f));
  assert.ok(files.length > 100, 'the walk sees the production tree');
  const seamFile = path.join(ROOT, 'src', 'runner', 'runtimes', 'cliAgent', 'testSeam.ts');
  assert.ok(files.includes(seamFile));
  const offenders = files.filter((f) => f !== seamFile && /ForTests|ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY/.test(codeOnly(f))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(offenders, []);
  assert.match(codeOnly(seamFile), /ANTHROPIC_BASE_URL/);
  // The seam accepts exactly those two names.
  assert.throws(() => seam.createCliAdapterForTests({ envOverlay: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', SOMETHING_ELSE: '1' } }), /only ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY/);
  // No engine spawn without the env builder; nothing in cliAgent spreads the runner's own environment or sets a shell.
  for (const f of walk(path.join(ROOT, 'src', 'runner', 'runtimes', 'cliAgent')).filter((x) => x.endsWith('.ts'))) {
    const s = codeOnly(f);
    assert.doesNotMatch(s, /\.\.\.\s*process\.env|shell\s*:\s*true|--safe-mode|--model/, path.relative(ROOT, f));
  }
});

// ---------------------------------------------------------------- CR1

/** The expected argv, built here from Task 0's recorded decisions (task0-probe-report.json), not from the adapter. */
function expectedArgv({ dir, tools, budget, skills }) {
  const decision = (id) => REPORT.decisions.find((d) => d.id === id)?.branch;
  assert.equal(decision('settingSourcesForm'), '""', 'Task 0 chose the empty form of --setting-sources');
  assert.match(decision('safeMode'), /^dropped/, 'D-B15: --safe-mode is dropped');
  assert.equal(decision('skillsDelivery'), 'append-system-prompt-file');
  assert.equal(decision('mcpHeaderForm'), 'env-expansion');
  const pinned = JSON.parse(decision('toolNames').replace(/^pinned:/, ''));
  // Task 0 recorded the engine's own (sorted) list of what it offered; the argv names them in the order the harness used.
  const builtin = H.BUILTIN_TOOLS.slice();
  assert.deepEqual(pinned.allowed.filter((t) => !t.startsWith('mcp__')).sort(), builtin.slice().sort());
  assert.deepEqual(pinned.allowed.filter((t) => t.startsWith('mcp__')).sort(), ['mcp__nexus__changeset_register', 'mcp__nexus__context_get']);
  for (const t of ['Task', 'Agent', 'PowerShell', 'Bash', 'WebFetch', 'WebSearch', 'NotebookEdit']) assert.ok(pinned.disallowed.includes(t), t);
  return ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'text', '--restricted', '--strict-mcp-config',
    '--mcp-config', path.join(dir, 'mcp.json'), '--settings', path.join(dir, 'settings.json'), '--setting-sources', '',
    '--tools', builtin.join(','), '--allowedTools', ...builtin, ...tools.map((t) => `mcp__nexus__${t}`),
    '--disallowedTools', ...pinned.disallowed, '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--no-session-persistence', '--disable-slash-commands', '--no-chrome', '--max-budget-usd', budget,
    ...(skills ? ['--append-system-prompt-file', path.join(dir, 'skills.md')] : [])];
}

test('CR1 the argv equals the list Task 0 pinned; the flags are the probed ones; no --safe-mode, no --model', () => {
  const dir = path.join('C:', 'job');
  const tools = ['context_get', 'changeset_register'];
  const got = argsMod.buildArgs({ dir, mcpJson: path.join(dir, 'mcp.json'), settingsJson: path.join(dir, 'settings.json'), mcpTools: tools, budgetCents: 200, skillsFile: path.join(dir, 'skills.md') });
  assert.deepEqual(got, expectedArgv({ dir, tools, budget: '2', skills: true }));
  assert.deepEqual(argsMod.buildArgs({ dir, mcpJson: path.join(dir, 'mcp.json'), settingsJson: path.join(dir, 'settings.json'), mcpTools: tools, budgetCents: 150 }),
    expectedArgv({ dir, tools, budget: '1.5', skills: false }));
  assert.ok(!got.includes('--safe-mode') && !got.includes('--model'));
  // The probed flag set is the adapter's pinned set (plus the optional skills-file flag Task 0 also listed).
  assert.deepEqual([...binaryMod.PINNED_FLAGS].sort(), Object.keys(REPORT.helpFlags).filter((f) => f !== '--append-system-prompt-file').sort());
  assert.equal(binaryMod.SKILLS_FILE_FLAG, '--append-system-prompt-file');
  assert.deepEqual([...argsMod.DISALLOWED_TOOLS], ['Task', 'Agent', 'PowerShell', 'Bash', 'WebFetch', 'WebSearch', 'NotebookEdit']);
  assert.equal(argsMod.budgetCentsOf({ turnUsdCents: 200, dayRemainingUsdCents: 75 }), 75);
  assert.equal(argsMod.budgetCentsOf({}), 200);
});

test('CR1 a turn: argv is what was pinned; the message, the context and the token are not in it; it is under 8 KiB; the files hold no token', async () => {
  const root = tmpDir();
  const req = mkReq(root, { message: 'MESSAGE-CANARY-7731 please', contextText: '## ctx\nCONTEXT-CANARY-4452\n' });
  fs.writeFileSync(path.join(req.configDir, 'skills.md'), 'SKILLS-BODY\n');
  const events = await collect(fakeAdapter(['--fake-dump-argv'], { mcpTools: ['context_get', 'changeset_register'], caps: { turnUsdCents: 200, dayRemainingUsdCents: 1000 } }), req);
  assertRuntimeContract(events, { terminal: 'run.completed' });
  const dumped = JSON.parse(events.find((e) => e.t === 'message.delta').text);
  const argv = dumped; // the stand-in's own knobs come first, then the pinned argv from -p
  const pinned = argv.slice(argv.indexOf('-p'));
  assert.deepEqual(pinned, expectedArgv({ dir: req.configDir, tools: ['context_get', 'changeset_register'], budget: '2', skills: false }));
  const all = dumped.join(' ');
  for (const secret of ['MESSAGE-CANARY-7731', 'CONTEXT-CANARY-4452', TOKEN]) assert.ok(!all.includes(secret), `${secret.slice(0, 12)} is not in argv`);
  assert.ok(Buffer.byteLength(all, 'utf8') < 8 * 1024);
  const mcp = fs.readFileSync(path.join(req.configDir, 'mcp.json'), 'utf8');
  assert.ok(mcp.includes('Bearer ${NEXUS_MCP_TOKEN}') && !mcp.includes(TOKEN), 'the header is the literal expansion form');
  const settings = JSON.parse(fs.readFileSync(path.join(req.configDir, 'settings.json'), 'utf8'));
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.env, undefined);
  assert.ok(settings.permissions.deny.includes('Read(**/.env*)') && settings.permissions.deny.includes('Edit(**/*.pem)'));
});

test('CR1 the deny rules cover every sensitive name the change-set scan blocks', () => {
  const rules = filesMod.settingsJson().permissions.deny;
  for (const tool of ['Read', 'Edit', 'Write']) for (const g of ['**/.git', '**/.git/**', '**/.env*', '**/*.pem', '**/id_rsa*', '**/*.key', '**/.npmrc', '**/.pypirc']) assert.ok(rules.includes(`${tool}(${g})`), `${tool}(${g})`);
  for (const p of ['.env', 'a/.env.local', 'certs/a.pem', 'x/id_rsa.pub', 'k.key', '.npmrc', '.pypirc', '.git/config']) assert.ok(SENSITIVE_PATH_RE.test(p), p);
});

// ---------------------------------------------------------------- CR2

test('CR2 a scripted turn on the real CLI: Bash and WebFetch are unavailable; one Edit inside the worktree succeeds; context_get reaches the runner MCP server; changeset_register reaches the fake main', { skip: NO_CLI }, async () => {
  await withHarness({}, async (h) => {
    const target = path.join(h.worktree, 'src', 'app.txt');
    const toMain = [];
    const server = await McpServer({
      onCall: async (_id, bearer, tool, args) => { toMain.push({ bearer, tool, args }); return { ok: true, value: { tool, accepted: true } }; },
      onExecGrant: async () => ({ ok: false, code: 'x', message: 'no exec in this test' })
    });
    try {
      h.mock.setScript(script([
        [{ type: 'text', text: 'Reading.' }, ...use('toolu_r', 'Read', { file_path: target })],
        use('toolu_e', 'Edit', { file_path: target, old_string: 'hello from the worktree', new_string: 'edited by the agent' }),
        use('toolu_c', 'mcp__nexus__context_get', {}),
        use('toolu_g', 'mcp__nexus__changeset_register', { title: 'T', summary: 'S', clientKey: 'ck1' }),
        use('toolu_b', 'Bash', { command: 'echo hi' }),
        use('toolu_w', 'WebFetch', { url: 'https://example.com', prompt: 'x' }),
        [{ type: 'text', text: 'done' }]
      ]));
      const req = reqOf(h, { mcpUrl: server.url });
      const events = await collect(realAdapter(h, { mcpUrl: server.url }), req);
      assertRuntimeContract(events, { terminal: 'run.completed' });
      const done = (id) => events.find((e) => e.t === 'tool.completed' && e.callId === id);
      assert.equal(done('toolu_e').ok, true, 'the Edit inside the worktree succeeded');
      assert.equal(fs.readFileSync(target, 'utf8').trim(), 'edited by the agent');
      assert.equal(done('toolu_c').ok, true);
      assert.equal(done('toolu_g').ok, true);
      assert.equal(done('toolu_b').ok, false, 'Bash is unavailable');
      assert.equal(done('toolu_w').ok, false, 'WebFetch is unavailable');
      assert.deepEqual(toMain.map((c) => c.tool), ['context_get', 'changeset_register'], 'both calls reached the fake main, through the runner MCP server');
      assert.deepEqual(toMain[1].args, { title: 'T', summary: 'S', clientKey: 'ck1' });
      assert.ok(toMain.every((c) => c.bearer === TOKEN), 'the header carried the turn bearer (expanded from the environment)');
      const offered = [...new Set(h.mock.toolRequests().flatMap((q) => M.toolNames(q.body)))];
      for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'PowerShell', 'NotebookEdit']) assert.ok(!offered.includes(t), `${t} was never offered to the model`);
      assert.ok(offered.includes('mcp__nexus__context_get') && offered.includes('Edit'));
    } finally { await server.close(); }
  });
});

// ---------------------------------------------------------------- CR3

test('CR3 planted customizations (home and worktree: hooks, MCP servers, plugins, CLAUDE.md, agents, skills, commands, settings) load nothing and reach no prompt', { skip: NO_CLI }, async () => {
  // The control proves the plants are live: without the locks the same harness lights several of them up.
  const CONTROL_ARGV = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'text', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--allowedTools', 'Read', '--no-session-persistence'];
  const readme = (h) => script([use('toolu_p', 'Read', { file_path: path.join(h.worktree, 'README.md') }), [{ type: 'text', text: 'done' }]]);
  await withHarness({}, async (h) => {
    h.mock.setScript(readme(h));
    const r = await h.run(CONTROL_ARGV, { stdin: 'Read the README.' });
    assert.ok(h.detectPlants(r).length > 0, 'control: the plants are live without the locks');
  });
  await withHarness({}, async (h) => {
    h.mock.setScript(readme(h));
    const events = await collect(realAdapter(h), reqOf(h));
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.deepEqual(h.detectPlants({ events: [] }), [], 'nothing planted loaded or ran');
    assert.deepEqual(h.mcp.strays, [], 'no stray MCP server was contacted');
    assert.deepEqual(fs.readdirSync(h.markerDir), [], 'no hook ran');
    const raw = h.mock.requests.map((q) => q.raw).join('\n');
    for (const k of H.ISOLATION_CANARY_KEYS) assert.ok(!raw.includes(h.canaries[k]), `${k} did not reach the model`);
    assert.ok(h.mock.requests.length > 0);
  });
});

// ---------------------------------------------------------------- CR4

test('CR4 the token is in no event, log line, file under the harness root, or request body to the model', { skip: NO_CLI }, async () => {
  await withHarness({ onCall: (n) => `ok:${n}` }, async (h) => {
    h.mock.setScript(script([use('toolu_c', 'mcp__nexus__context_get', {}), use('toolu_r', 'Read', { file_path: path.join(h.worktree, 'README.md') }), [{ type: 'text', text: 'done' }]]));
    const lines = [];
    const events = await collect(realAdapter(h, { log: (l) => lines.push(l) }), reqOf(h));
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.ok(h.mcp.records.some((r) => r.headers.authorization === `Bearer ${TOKEN}`), 'the MCP server did receive it, as the header, by environment expansion');
    assert.ok(!JSON.stringify(events).includes(TOKEN), 'no event');
    assert.ok(!lines.join('\n').includes(TOKEN), 'no log line');
    assert.ok(!h.mock.requests.some((q) => q.raw.includes(TOKEN)), 'no request body to the model');
    assert.deepEqual(probe.filesContaining ? probe.filesContaining(h.root, TOKEN) : [], [], 'no file');
  });
});

// ---------------------------------------------------------------- CR5

test('CR5 the engine environment is the allow-list plus exactly the two test-seam names; nothing inherited leaks', async () => {
  const base = {
    SystemRoot: process.env.SystemRoot || 'C:\\Windows', USERPROFILE: 'C:\\fake\\home', HOMEDRIVE: 'C:', HOMEPATH: '\\fake\\home', APPDATA: 'C:\\fake\\home\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\fake\\home\\AppData\\Local', TEMP: 'C:\\fake\\tmp', ANTHROPIC_API_KEY: 'sk-ant-INHERITED', ANTHROPIC_BASE_URL: 'http://evil.invalid', ANTHROPIC_AUTH_TOKEN: 'tok',
    CLAUDE_CONFIG_DIR: 'C:\\somewhere', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', MY_API_KEY: 'k', GITHUB_TOKEN: 'ghp_x', NODE_EXTRA_CA_CERTS: 'C:\\ca.pem', HTTP_PROXY: 'http://evil:1', HTTPS_PROXY: 'http://evil:2',
    NEXUS_MCP_TOKEN: 'inherited-token', HOME: 'C:\\fake\\home'
  };
  const PROXY = 'http://127.0.0.1:4455';
  const root = tmpDir();
  const req = mkReq(root);
  const make = seam.createCliAdapterForTests({ envOverlay: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5566', ANTHROPIC_API_KEY: 'sk-ant-FAKE-TEST' }, baseEnv: base, bin: process.execPath, argvPrefix: [FAKE, '--fake-dump-env'] });
  const events = await collect(make({ token: TOKEN, mcpUrl: 'http://127.0.0.1:1/mcp', proxyUrl: () => PROXY }), req);
  assertRuntimeContract(events, { terminal: 'run.completed' });
  const env = JSON.parse(events.find((e) => e.t === 'message.delta').text);
  const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  const got = lower(env);
  const ALLOW = ['SystemRoot', 'windir', 'PATH', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'HTTPS_PROXY', 'NO_PROXY', 'NEXUS_MCP_TOKEN',
    'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
  const SEAM = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'];
  // Windows itself adds four non-secret names to any process started with an explicit environment (a plain node child shows
  // them too); they are not the adapter's doing, and an exact match would be a test of the OS.
  const OS_ADDED = ['logonserver', 'systemdrive', 'userdomain', 'username'];
  assert.deepEqual(Object.keys(got).filter((k) => !OS_ADDED.includes(k)).sort(), [...ALLOW, ...SEAM].map((k) => k.toLowerCase()).sort());
  assert.deepEqual(Object.keys(envMod.agentEnv(base, { proxyUrl: PROXY, token: TOKEN })).map((k) => k.toLowerCase()).sort(), ALLOW.map((k) => k.toLowerCase()).sort(), 'the builder itself makes exactly the allow-list');
  assert.equal(got.https_proxy, PROXY);
  assert.equal(got.no_proxy, '127.0.0.1');
  assert.equal(got.http_proxy, undefined);
  assert.equal(got.nexus_mcp_token, TOKEN);
  assert.equal(got.anthropic_base_url, 'http://127.0.0.1:5566');
  assert.equal(got.anthropic_api_key, 'sk-ant-FAKE-TEST');
  assert.equal(got.userprofile, base.USERPROFILE);
  assert.equal(got.temp, path.join(req.configDir, 'tmp'));
  assert.equal(got.tmp, got.temp);
  assert.equal(got.disable_autoupdater, '1');
  for (const k of ['claude_config_dir', 'node_extra_ca_certs', 'github_token', 'my_api_key', 'anthropic_auth_token', 'claude_code_oauth_token', 'home']) assert.equal(got[k], undefined, k);
  // The builder alone (no overlay): none of the seam names, none of the dropped families.
  const bare = envMod.agentEnv(base, { proxyUrl: PROXY, token: TOKEN });
  for (const k of Object.keys(bare)) assert.ok(!/^ANTHROPIC_|_API_KEY$|NODE_EXTRA_CA_CERTS|^CLAUDE_CONFIG_DIR$/.test(k) && !(/^CLAUDE_/.test(k) && k !== 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC') && !(/_TOKEN$/.test(k) && k !== 'NEXUS_MCP_TOKEN'), k);
  assert.throws(() => envMod.agentEnv(base, { proxyUrl: 'http://evil.example:8080' }), /loopback proxy/);
});

// ---------------------------------------------------------------- CR6

test('CR6 ../outside.txt, an absolute path, a planted symlink and a junction are each denied or not followed', { skip: NO_CLI }, async () => {
  await withHarness({}, async (h) => {
    const OUT = `OUTSIDE-CANARY-${crypto.randomBytes(4).toString('hex')}`;
    const JUNC = `JUNCTION-CANARY-${crypto.randomBytes(4).toString('hex')}`;
    const outside = path.join(h.root, 'outside.txt');
    fs.writeFileSync(outside, `OUTSIDE-ORIGINAL ${OUT}\n`);
    fs.mkdirSync(path.join(h.root, 'outdir'));
    fs.writeFileSync(path.join(h.root, 'outdir', 'secret.txt'), `${JUNC}\n`);
    const planted = [];
    try { fs.symlinkSync(outside, path.join(h.worktree, 'link.txt'), 'file'); planted.push('symlink'); } catch { /* no privilege for a file symlink */ }
    try { fs.symlinkSync(path.join(h.root, 'outdir'), path.join(h.worktree, 'junc'), 'junction'); planted.push('junction'); } catch { /* none */ }
    assert.ok(planted.includes('junction'), 'a junction needs no elevation and must have been planted');
    const steps = [
      use('toolu_rel', 'Read', { file_path: '../outside.txt' }),
      use('toolu_abs', 'Read', { file_path: outside }),
      ...(planted.includes('symlink') ? [use('toolu_lnk', 'Read', { file_path: path.join(h.worktree, 'link.txt') })] : []),
      use('toolu_jn', 'Read', { file_path: path.join(h.worktree, 'junc', 'secret.txt') }),
      use('toolu_edit', 'Edit', { file_path: outside, old_string: 'OUTSIDE-ORIGINAL', new_string: 'CHANGED' }),
      [{ type: 'text', text: 'done' }]
    ];
    h.mock.setScript(script(steps));
    const events = await collect(realAdapter(h), reqOf(h));
    assertRuntimeContract(events, { terminal: 'run.completed' });
    const done = (id) => events.find((e) => e.t === 'tool.completed' && e.callId === id);
    assert.equal(done('toolu_rel').ok, false, '../outside.txt is denied');
    assert.equal(done('toolu_abs').ok, false, 'an absolute path outside is denied');
    assert.equal(done('toolu_edit').ok, false, 'an Edit outside is denied');
    const raw = h.mock.requests.map((q) => q.raw).join('\n');
    assert.ok(!raw.includes(OUT), 'the outside file was never read');
    assert.ok(!raw.includes(JUNC), 'the junction was not followed');
    assert.ok(fs.readFileSync(outside, 'utf8').startsWith('OUTSIDE-ORIGINAL'), 'the outside file is unchanged');
    if (planted.includes('symlink')) assert.equal(done('toolu_lnk').ok, false, 'the symlink was not followed');
    assert.equal(done('toolu_jn').ok, false, 'the junction was not followed');
  });
});

// ---------------------------------------------------------------- CR7

test('CR7 cancel delivers run.cancelled within the grace period plus 10 s and no process remains (the real CLI, every connection refused by the proxy)', { skip: NO_CLI }, async () => {
  await withHarness({ model: 'none' }, async (h) => {
    let spawned = null;
    const ad = realAdapter(h, { onSpawned: (i) => { spawned = i; } }, null);
    const ac = new AbortController();
    const events = [];
    const turn = (async () => { for await (const e of ad.start(reqOf(h), ac.signal)) events.push(e); })();
    await until(() => spawned !== null, 'the CLI to spawn');
    assert.ok(isPidAlive(spawned.pid));
    await until(() => h.proxy.connects.length > 0, 'the CLI to try the proxy');
    const t0 = Date.now();
    ac.abort();
    await turn;
    assert.ok(Date.now() - t0 < 1000 + 10_000, 'within the grace period plus 10 s');
    assert.equal(events[events.length - 1].t, 'run.cancelled');
    assertRuntimeContract(events, { terminal: 'run.cancelled' });
    await untilPidGone(spawned.pid);
    assert.deepEqual([...new Set(h.proxy.hosts())].filter((x) => x !== 'api.anthropic.com:443'), [], 'the only destination it asked for is the one granted');
  });
});

test('CR7 a cancel kills the whole tree: a grandchild of the stand-in ends too', async () => {
  const root = tmpDir();
  const ad = fakeAdapter(['--fake-child']);
  const ac = new AbortController();
  const events = [];
  const turn = (async () => { for await (const e of ad.start(mkReq(root), ac.signal)) events.push(e); })();
  await until(() => events.some((e) => e.t === 'message.delta' && /^pids /.test(e.text)), 'the pids');
  const [, parent, child] = events.find((e) => e.t === 'message.delta').text.split(' ').map(Number);
  assert.ok(isPidAlive(parent) && isPidAlive(child));
  ac.abort();
  await turn;
  assert.equal(events[events.length - 1].t, 'run.cancelled');
  await untilPidGone(parent); await untilPidGone(child);
});

// ---------------------------------------------------------------- CR8

test('CR8 an unknown version or a missing pinned flag gives version_unsupported, and no turn starts', async () => {
  for (const [knobs, detail] of [[['--fake-version=3.0.0'], /version 3\.0\.0/], [['--fake-version=2.2.0'], /version 2\.2\.0/], [['--fake-omit-flag=--restricted'], /missing flags: --restricted/],
    [['--fake-omit-flag=--strict-mcp-config'], /--strict-mcp-config/]]) {
    const root = tmpDir();
    const marker = path.join(root, 'turn-started.txt');
    const ad = fakeAdapter([...knobs, `--fake-marker=${marker}`]);
    const h = await ad.health();
    assert.equal(h.ok, false);
    assert.equal(h.reason, 'version_unsupported');
    assert.match(h.detail, detail);
    const events = await collect(ad, mkReq(root));
    assert.equal(events[events.length - 1].t, 'run.failed');
    assert.match(events[events.length - 1].message, /version_unsupported/);
    assert.ok(!fs.existsSync(marker), 'the engine was never started for a turn');
  }
  // A supported stand-in passes, and the optional skills flag being absent is not a refusal.
  const ok = fakeAdapter(['--fake-version=2.1.999']);
  assert.deepEqual(await ok.health(), { ok: true, version: '2.1.999' });
  assert.equal((await ok.setup()).flagsOk, true);
});

test('CR8 the installed CLI passes the version and flag check', { skip: NO_CLI }, async () => {
  await withHarness({ model: 'none' }, async (h) => {
    const ad = realAdapter(h, {}, null);
    const d = await ad.describe();
    assert.match(d.version, /^2\.1\.\d+$/);
    assert.deepEqual(await ad.health(), { ok: true, version: d.version }); // no proxy given: auth status is not run
  });
});

test('the engine binary must be the native executable by its exact name, absolute', () => {
  assert.equal(binaryMod.isAgentBinary('C:\\Users\\x\\.local\\bin\\claude.exe', 'win32'), true);
  for (const bad of ['claude', 'claude.exe', 'C:\\x\\claude.cmd', 'C:\\x\\claude.ps1', 'C:\\x\\claude.exe.bat', 'C:\\x\\notclaude.exe', '', 'C:\\x\\claude.exe\0']) assert.equal(binaryMod.isAgentBinary(bad, 'win32'), false, bad);
  const found = binaryMod.resolveAgentCli({ env: { PATH: 'C:\\a;C:\\b', USERPROFILE: 'C:\\u' }, platform: 'win32', isFile: (p) => p === 'C:\\b\\claude.exe' });
  assert.equal(found, 'C:\\b\\claude.exe');
  assert.equal(binaryMod.resolveAgentCli({ env: { PATH: 'C:\\a', USERPROFILE: 'C:\\u' }, platform: 'win32', isFile: (p) => p === 'C:\\u\\.local\\bin\\claude.exe' }), 'C:\\u\\.local\\bin\\claude.exe');
  assert.equal(binaryMod.resolveAgentCli({ env: { PATH: 'C:\\a' }, platform: 'win32', isFile: (p) => p.endsWith('claude.cmd') }), null);
  // An injected executable that is neither the native one nor this process's own is refused: the turn does not start.
  const refused = new CliAgentAdapter({ bin: 'C:\\Windows\\System32\\cmd.exe', proxyUrl: () => 'http://127.0.0.1:9' });
  return refused.health().then((h) => assert.equal(h.ok, false));
});

// ---------------------------------------------------------------- CR9

test('CR9 a runner kill in the same boot leads to killRecorded ending the CLI; another boot leaves it alone (the real CLI, every connection refused by the proxy)', { skip: NO_CLI }, async () => {
  await withHarness({ model: 'none' }, async (h) => {
    const dataRoot = tmpDir('nx-pids-');
    const BOOT = 'BOOT0000000000000000000001';
    const tree = new ProcTree({ fs: fsp, root: dataRoot });
    let spawned = null;
    const ad = realAdapter(h, { onSpawned: async (i) => { spawned = i; await tree.record({ jobId: 'JOB1', pid: i.pid, imageName: i.imageName, mainBootId: BOOT, runnerPid: process.pid }); } }, null);
    const events = [];
    const turn = (async () => { for await (const e of ad.start(reqOf(h), new AbortController().signal)) events.push(e); })();
    await until(() => spawned !== null && fs.existsSync(path.join(dataRoot, 'pids', `${spawned.pid}.json`)), 'the pidfile');
    assert.ok(isPidAlive(spawned.pid));
    // Another main boot: the pidfile is deleted, the process is not touched.
    // (checked on a copy of the file so the same-boot step below still has its evidence)
    const copyRoot = tmpDir('nx-pids2-');
    fs.mkdirSync(path.join(copyRoot, 'pids'));
    fs.copyFileSync(path.join(dataRoot, 'pids', `${spawned.pid}.json`), path.join(copyRoot, 'pids', `${spawned.pid}.json`));
    await new ProcTree({ fs: fsp, root: copyRoot }).killRecorded('BOOT0000000000000000000002');
    assert.ok(!fs.existsSync(path.join(copyRoot, 'pids', `${spawned.pid}.json`)));
    assert.ok(isPidAlive(spawned.pid), 'another boot never has its process touched');
    // "The runner was killed": nothing cancels, nothing shuts down; the next hello of the same boot reads the pidfile.
    await new ProcTree({ fs: fsp, root: dataRoot }).killRecorded(BOOT);
    await untilPidGone(spawned.pid);
    await turn; // the adapter reports the death of its process as a failure, never a hang
    assert.equal(events[events.length - 1].t, 'run.failed');
    assert.ok(!fs.existsSync(path.join(dataRoot, 'pids', `${spawned.pid}.json`)));
  });
});

// ---------------------------------------------------------------- CR10

test('CR10 the writes to the fake home are the ones Task 0 recorded; the others are the turn\'s own files (a fake home only: V3 measures the real one)', { skip: NO_CLI }, async () => {
  await withHarness({}, async (h) => {
    h.mock.setScript(script([use('toolu_e', 'Edit', { file_path: path.join(h.worktree, 'src', 'app.txt'), old_string: 'hello from the worktree', new_string: 'x' }), [{ type: 'text', text: 'done' }]]));
    const before = fakeHome.snapshot(h.root);
    const events = await collect(realAdapter(h), reqOf(h));
    assertRuntimeContract(events, { terminal: 'run.completed' });
    const writes = fakeHome.diff(before, fakeHome.snapshot(h.root)).map((w) => w.rel);
    const norm = (rel) => rel.replace(/backup\.\d+$/, 'backup.<ms>').replace(/Cache\/[^/]+\/mcp-logs-nexus\/[^/]+\.jsonl$/, 'Cache/<project>/mcp-logs-nexus/<run>.jsonl').replace(/fswatch-probe-[^/]+/, 'fswatch-probe-<id>');
    // Task 0, P10 and CR3+: the home entries of one pinned turn (home/.claude/.last-cleanup is the CR3+ run's own extra).
    const recorded = new Set([...REPORT.observed.homeWrites.map((w) => `home/${w.rel}`), ...REPORT.observed.cr3.lockedWrites.filter((w) => w.rel.startsWith('home/')).map((w) => w.rel)].map(norm));
    const homeNow = new Set(writes.filter((r) => r.startsWith('home/')).map(norm));
    for (const r of homeNow) assert.ok(recorded.has(r), `a home write Task 0 did not record: ${r}`);
    for (const r of ['home/.claude.json', 'home/AppData/Local/claude-cli-nodejs/Cache/<project>/mcp-logs-nexus/<run>.jsonl']) assert.ok(homeNow.has(r), `expected ${r}`);
    // Outside the home: the Edit, the engine's temp folder inside the job dir, the job's own files, the planted project settings file.
    const OTHER = [/^wt\/src\/app\.txt$/, /^wt\/\.claude\/settings\.local\.json$/, /^job\/(mcp|settings)\.json$/, /^job\/tmp\/claude\/fswatch-probe-[^/]+\/probe$/, /^job\/context\.md$/];
    for (const r of writes.filter((x) => !x.startsWith('home/'))) assert.ok(OTHER.some((re) => re.test(r)), `an unexpected write: ${r}`);
    assert.ok(!writes.some((r) => /^tmp\//.test(r)), 'nothing is written to a temp folder outside the job dir');
    assert.ok(!writes.some((r) => r.startsWith('home/.claude/projects') || r.startsWith('home/.claude/sessions')), 'no session store entry');
  });
});

// ---------------------------------------------------------------- CR11

test('CR11 a 200 KiB context reaches the model intact, on stdin; argv stays small', { skip: NO_CLI }, async () => {
  await withHarness({}, async (h) => {
    const ctx = probe.makeContext(200 * 1024, `CTX-CANARY-${crypto.randomBytes(4).toString('hex')}`);
    h.mock.setScript(script([[{ type: 'text', text: 'ok' }]]));
    const events = await collect(realAdapter(h), reqOf(h, { contextText: ctx, message: 'MSG-CANARY-93' }));
    assertRuntimeContract(events, { terminal: 'run.completed' });
    const first = h.mock.toolRequests()[0] ?? h.mock.messageRequests()[0];
    const user = probe.userText(first.body);
    assert.ok(user.includes(ctx), 'the whole context, intact');
    assert.ok(user.includes('MSG-CANARY-93'));
    assert.ok(user.indexOf(ctx) < user.indexOf('MSG-CANARY-93'), 'context, then the message');
  });
  // The stand-in sees the same bytes on stdin.
  const root = tmpDir();
  const ctx = probe.makeContext(200 * 1024, 'C2');
  const events = await collect(fakeAdapter(['--fake-echo-stdin']), mkReq(root, { contextText: ctx, message: 'M' }));
  const m = /^stdin (\d+) ([0-9a-f]{64})$/.exec(events.find((e) => e.t === 'message.delta').text);
  assert.ok(m && Number(m[1]) > 200 * 1024);
});

// ---------------------------------------------------------------- CR12

test('CR12 a scripted Read .env, Read certs/a.pem and Read .git/config are denied; nothing of them reaches the model', { skip: NO_CLI }, async () => {
  const PEM = `PEM-SECRET-${crypto.randomBytes(4).toString('hex')}`;
  const GIT = `GITCFG-SECRET-${crypto.randomBytes(4).toString('hex')}`;
  await withHarness({ worktreeFiles: { 'certs/a.pem': `-----BEGIN X-----\n${PEM}\n`, '.git/config': `[core]\n${GIT}\n` } }, async (h) => {
    h.mock.setScript(script([
      use('toolu_env', 'Read', { file_path: path.join(h.worktree, '.env') }),
      use('toolu_pem', 'Read', { file_path: path.join(h.worktree, 'certs', 'a.pem') }),
      use('toolu_git', 'Read', { file_path: path.join(h.worktree, '.git', 'config') }),
      use('toolu_wenv', 'Write', { file_path: path.join(h.worktree, '.env.new'), content: 'x' }),
      [{ type: 'text', text: 'done' }]
    ]));
    const events = await collect(realAdapter(h), reqOf(h));
    assertRuntimeContract(events, { terminal: 'run.completed' });
    for (const id of ['toolu_env', 'toolu_pem', 'toolu_git', 'toolu_wenv']) assert.equal(events.find((e) => e.t === 'tool.completed' && e.callId === id).ok, false, id);
    const raw = h.mock.requests.map((q) => q.raw).join('\n');
    for (const secret of [h.canaries.envSecret, PEM, GIT]) assert.ok(!raw.includes(secret), 'a sensitive file reached the model');
    assert.ok(!fs.existsSync(path.join(h.worktree, '.env.new')), 'the sensitive Write did not happen');
  });
});

// ---------------------------------------------------------------- CR13

test('CR13 the auth status output (it holds an email) never appears in a log, event, health or setup answer; only signedIn leaves the adapter', async () => {
  const signedIn = path.join(AUTH_FIX, 'auth-status.signed-in.json');
  const signedOut = path.join(AUTH_FIX, 'auth-status.signed-out.json');
  const unreachable = path.join(AUTH_FIX, 'auth-status.unreachable.txt');
  const EMAIL = 'probe-fixture-person@example.invalid';
  assert.ok(fs.readFileSync(signedIn, 'utf8').includes(EMAIL), 'the fixture holds the email');
  const PROXY = 'http://127.0.0.1:4466';
  const seen = [];
  const one = async (file) => {
    const lines = [];
    const ad = fakeAdapter([`--fake-auth=${file}`], { log: (l) => lines.push(l) });
    const setup = await ad.setup({ proxyUrl: PROXY });
    const health = await ad.health({ proxyUrl: PROXY });
    const root = tmpDir();
    const events = await collect(fakeAdapter([`--fake-auth=${file}`, '--fake-quick'], { log: (l) => lines.push(l) }), mkReq(root));
    seen.push(JSON.stringify({ lines, setup, health, events, d: await ad.describe() }));
    return { setup, health };
  };
  const yes = await one(signedIn);
  assert.equal(yes.setup.signedIn, 'yes'); assert.equal(yes.health.ok, true);
  const no = await one(signedOut);
  assert.equal(no.setup.signedIn, 'no'); assert.deepEqual(no.health, { ok: false, reason: 'not_authenticated', detail: 'the agent CLI is not signed in' });
  const unknown = await one(unreachable);
  assert.equal(unknown.setup.signedIn, 'unknown'); assert.equal(unknown.health.ok, true);
  for (const s of seen) for (const needle of [EMAIL, 'Probe Fixture Org', '00000000-0000-4000-8000-000000000000', 'authMethod', 'orgName']) assert.ok(!s.includes(needle), `${needle} left the adapter`);
  assert.deepEqual(Object.keys(yes.setup).sort(), ['egressHosts', 'flagsOk', 'label', 'signedIn']);
  // Without a proxy the status is not asked at all.
  assert.equal((await fakeAdapter([`--fake-auth=${signedIn}`]).setup()).signedIn, 'unknown');
});

// ---------------------------------------------------------------- CR14

test('CR14 usage above the token cap mid-turn makes Nexus cancel the CLI and fail the turn with limit', { skip: NO_CLI }, async () => {
  const bigMock = await mockModel.start({ usage: { input: 500_000, output: 10 } });
  try {
    await withHarness({ model: 'none' }, async (h) => {
      bigMock.setScript(script([use('toolu_r', 'Read', { file_path: path.join(h.worktree, 'README.md') }), use('toolu_r2', 'Read', { file_path: path.join(h.worktree, 'README.md') }), [{ type: 'text', text: 'done' }]]));
      let spawned = null;
      const ad = realAdapter(h, { caps: { turnTokens: 400_000, turnUsdCents: 200, dayRemainingUsdCents: 1000, toolCalls: 200 }, onSpawned: (i) => { spawned = i; } }, bigMock.url);
      const events = await collect(ad, reqOf(h));
      assertRuntimeContract(events, { terminal: 'run.failed' });
      const last = events[events.length - 1];
      assert.equal(last.code, 'limit');
      assert.match(last.message, /token cap/);
      assert.ok(events.some((e) => e.t === 'usage' && e.inputTokens > 400_000), 'the usage that crossed the cap was reported');
      assert.ok(!events.some((e) => e.t === 'run.completed'));
      await untilPidGone(spawned.pid);
    });
  } finally { await bigMock.stop(); }
});

test('CR14 a result without a cost is reported as an estimate (no cost, estimated true); a cost is rounded up to whole cents', async () => {
  const root = tmpDir();
  const noCost = await collect(fakeAdapter(['--fake-no-cost', '--fake-quick']), mkReq(root));
  assertRuntimeContract(noCost, { terminal: 'run.completed' });
  const lastUsage = [...noCost].reverse().find((e) => e.t === 'usage');
  assert.equal(lastUsage.costUsdCents, null);
  assert.equal(lastUsage.estimated, true);
  const withCost = await collect(fakeAdapter(['--fake-quick']), mkReq(tmpDir()));
  const u = [...withCost].reverse().find((e) => e.t === 'usage');
  assert.equal(u.costUsdCents, 1); assert.equal(u.estimated, false);
  // A turn with no budget left never starts the engine.
  const marker = path.join(tmpDir(), 'm.txt');
  const broke = await collect(fakeAdapter(['--fake-quick', `--fake-marker=${marker}`], { caps: { turnUsdCents: 200, dayRemainingUsdCents: 0 } }), mkReq(tmpDir()));
  assert.equal(broke[broke.length - 1].code, 'limit');
  assert.ok(!fs.existsSync(marker));
});

// ---------------------------------------------------------------- CR15 and the stream

test('CR15 describe().egressHosts is exactly api.anthropic.com:443; the neutral facts are pinned', async () => {
  const d = await fakeAdapter().describe();
  assert.deepEqual(d.egressHosts, [{ host: 'api.anthropic.com', port: 443 }]);
  assert.deepEqual(EGRESS_HOSTS, [{ host: 'api.anthropic.com', port: 443 }]);
  assert.equal(d.supportsHttpMcp, true);
  assert.equal(d.supportsResume, false);
  assert.deepEqual(d.models, []);
  assert.equal(d.label, 'Claude Code');
  assert.equal(fakeAdapter().kind, 'cli-agent');
});

test('the stream: usage is cumulative per message, tool calls are counted once, runRef is a Nexus id, a line over 1 MiB fails protocol', async () => {
  const t = new streamMod.StreamTranslator({ mcpServerName: 'nexus' });
  const msg = (id, content, usage) => `${JSON.stringify({ type: 'assistant', message: { id, content, usage } })}\n`;
  const ev = [
    ...t.feed(msg('m1', [{ type: 'text', text: 'a' }], { input_tokens: 10, output_tokens: 1 })),
    ...t.feed(msg('m1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'x' } }], { input_tokens: 10, output_tokens: 5 })),
    ...t.feed(msg('m1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'x' } }], { input_tokens: 10, output_tokens: 5 })), // the same call again
    ...t.feed(msg('m2', [], { input_tokens: 30, output_tokens: 2, cache_creation_input_tokens: 4, cache_read_input_tokens: 100 }))
  ];
  assert.equal(ev.filter((e) => e.t === 'tool.started').length, 1);
  const usage = ev.filter((e) => e.t === 'usage');
  assert.deepEqual(usage[usage.length - 1], { t: 'usage', inputTokens: 40, outputTokens: 7, cacheCreationTokens: 4, cacheReadTokens: 100, costUsdCents: null, toolCalls: 1, estimated: true });
  assert.match(streamMod.newRunRef(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(!streamMod.newRunRef().includes('-'), 'not the engine\'s own session id shape');
  const big = new streamMod.StreamTranslator({ mcpServerName: 'nexus' });
  const out = big.feed('x'.repeat(streamMod.STREAM_LINE_MAX_BYTES + 1));
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'protocol');
  assert.deepEqual(big.feed('{"type":"result"}\n'), [], 'nothing after a terminal event');
  // An error result maps to a code without copying the engine's free text.
  const f = new streamMod.StreamTranslator({ mcpServerName: 'nexus' });
  const res = f.feed(`${JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, result: 'SECRET TEXT', total_cost_usd: 2.01 })}\n`);
  const fail = res[res.length - 1];
  assert.equal(fail.code, 'limit');
  assert.ok(!JSON.stringify(res).includes('SECRET TEXT'));
  assert.equal(res.find((e) => e.t === 'usage').costUsdCents, 201);
  const auth = new streamMod.StreamTranslator({ mcpServerName: 'nexus' });
  assert.equal(auth.feed(`${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 401 })}\n`).pop().code, 'auth');
});

test('a stream line over 1 MiB from the engine fails the turn with protocol and the process is gone', async () => {
  const root = tmpDir();
  let spawned = null;
  const events = await collect(fakeAdapter(['--fake-big-line'], { onSpawned: (i) => { spawned = i; } }), mkReq(root));
  assertRuntimeContract(events, { terminal: 'run.failed' });
  assert.equal(events[events.length - 1].code, 'protocol');
  await untilPidGone(spawned.pid);
});

test('no egress proxy, no turn: the engine is never started without a proxy of the turn\'s own', async () => {
  const marker = path.join(tmpDir(), 'm.txt');
  const events = await collect(fakeAdapter(['--fake-quick', `--fake-marker=${marker}`], { proxyUrl: () => null }), mkReq(tmpDir()));
  assert.equal(events[events.length - 1].t, 'run.failed');
  assert.match(events[events.length - 1].message, /no egress proxy/);
  assert.ok(!fs.existsSync(marker));
  assert.ok(defaultTaskkillBin().length > 0);
});
