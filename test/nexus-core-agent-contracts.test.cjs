'use strict';
// B2b Task 1: the shared agent contracts. The runner protocol's new ops (SC1, SC1b), the MCP tool table (SC2), the
// spend and rate policy (SC3), the change-set path rules (SC4), the registry flip to B2b (SC5), the Nexus skills (SC6),
// the diff-line secret rule (SC7), the six git engine recipes (SC8), the change-set validators and the agent views.
// Pure data and pure functions: plain node, no database, no Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const { scanText } = require('./helpers/identityGuard.cjs');

const ROOT = path.resolve(__dirname, '..');
const proto = loadTs('src/shared/nexus/runnerProtocol.ts');
const { parseRunnerMessage, parseExecGrant, chunkText, RUNNER_OPS } = proto;
const { TOKEN_RE, isTokenShape } = loadTs('src/shared/nexus/tokens.ts');
const { MCP_TOOLS, parseToolArgs, getMcpTool } = loadTs('src/shared/nexus/mcpTools.ts');
const policy = loadTs('src/shared/nexus/agentPolicy.ts');
const cs = loadTs('src/shared/nexus/changeSet.ts');
const { diffLineSecret, looksSecret } = loadTs('src/shared/nexus/secretShape.ts');
const { RECIPES, getRecipe } = loadTs('src/shared/nexus/recipes.ts');
const { VALIDATORS, blockingValidatorsFor } = loadTs('src/shared/nexus/validators.ts');
const { SKILLS } = loadTs('src/shared/nexus/capabilities.ts');
const { USER_ACTIONS } = loadTs('src/shared/nexus/actions.ts');
const spec = loadTs('src/shared/nexus/domainSpec.ts');
const { DOMAINS, getDomain } = loadTs('src/shared/nexus/domains/index.ts');
const { checkRegistry, B2A_IMPL, B2B_IMPL, B2B_E2E_STUB, B2B_PENDING } = loadTs('src/shared/nexus/registryCheck.ts');

const ULID = '01J9ZQ4M6X8Y2V3T5R7P9N1K0H';
const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const TOKEN = 'A'.repeat(22) + '.' + 'b'.repeat(43);
const VENDOR = /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-/i;
const clone = (x) => JSON.parse(JSON.stringify(x));
const exit = { code: 0, oomKilled: false, finishedAt: 1700000000000 };

// ----- SC1: RunnerToMain additions -----

const RUNTIME_EVENTS = [
  { t: 'run.started', runRef: 'run-1', at: 1 },
  { t: 'message.delta', text: 'Reading the tests.' },
  { t: 'tool.started', callId: 'call_1', tool: 'sandbox_exec', argsSummary: 'npm test' },
  { t: 'tool.completed', callId: 'call_1', ok: true, resultBytes: 120 },
  { t: 'approval.requested', approvalRef: 'ap-1', summary: 'install dependencies' },
  { t: 'usage', inputTokens: 10, outputTokens: 5, cacheCreationTokens: 2, cacheReadTokens: 100, costUsdCents: 3, toolCalls: 1, estimated: false },
  { t: 'usage', inputTokens: 10, outputTokens: 5, cacheCreationTokens: 2, cacheReadTokens: 100, costUsdCents: null, toolCalls: 1, estimated: true },
  { t: 'run.completed', at: 2, stopReason: 'end_turn' },
  { t: 'run.failed', at: 2, code: 'limit', message: 'the token cap was reached' },
  { t: 'run.cancelled', at: 2 }
];
const B2B_SAMPLES = {
  'ready': { op: 'ready', bootId: ULID, mcpUrl: 'http://127.0.0.1:51234/mcp' },
  'probe.result': { op: 'probe.result', freeBytes: null, images: [], probe: { docker: 'running', gpu: { detected: false, usableInContainers: false } },
    runtimes: [{ kind: 'cli-agent', health: { ok: true, version: '2.1.0' },
      setup: { signedIn: 'yes', flagsOk: true, label: 'Engine', egressHosts: [{ host: 'api.example.com', port: 443 }] } }] },
  'mcp.call': { op: 'mcp.call', callId: 'c-1', bearer: TOKEN, tool: 'sandbox_exec', args: { argv: ['npm', 'test'], timeoutMs: 60000 } },
  'agent.exec.done': { op: 'agent.exec.done', attemptId: ULID, execId: 'e-1', exit, stdoutBytes: 10, stderrBytes: 0, stdoutSha256: SHA, truncated: false },
  'attempt.runtime': { op: 'attempt.runtime', attemptId: ULID, seq: 0, event: RUNTIME_EVENTS[1] },
  'git.read.result': { op: 'git.read.result', reqId: 'r-1', result: { ok: true, read: 'status', branch: 'main', head: COMMIT, dirty: false,
    integrationHead: null, acceptedNotMerged: 0, fastForward: false } }
};
const nest = (n) => { let v = 1; for (let i = 0; i < n; i++) v = { k: v }; return v; };
const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));

test('SC1 every RunnerToMain addition round-trips through parseRunnerMessage as a fresh copy', () => {
  for (const op of ['mcp.call', 'agent.exec.done', 'attempt.runtime', 'git.read.result']) assert.ok(RUNNER_OPS.includes(op), op);
  for (const [op, sample] of Object.entries(B2B_SAMPLES)) {
    const out = parseRunnerMessage(clone(sample));
    assert.deepEqual(out, sample, op);
    assert.equal(parseRunnerMessage({ ...clone(sample), extra: 1 }), null, `${op} with an extra key`);
  }
  const m = clone(B2B_SAMPLES['mcp.call']);
  const out = parseRunnerMessage(m);
  assert.notEqual(out.args, m.args, 'args are deep-copied');
  m.args.argv.push('changed');
  assert.deepEqual(out.args.argv, ['npm', 'test']);
  // ready with no endpoint yet (null), and every runtime event, every git read result, and the accept.prepared progress.
  assert.ok(parseRunnerMessage({ op: 'ready', bootId: ULID, mcpUrl: null }));
  for (const event of RUNTIME_EVENTS) assert.deepEqual(parseRunnerMessage({ ...B2B_SAMPLES['attempt.runtime'], event }).event, event, event.t);
  for (const result of [
    { ok: true, read: 'status', branch: 'feature/x', head: null, dirty: true, integrationHead: COMMIT, acceptedNotMerged: 3, fastForward: true },
    { ok: true, read: 'diff', base: COMMIT, head: 'c'.repeat(64), patch: 'diff --git a/x b/x\n+line\n', bytes: 24, truncated: false },
    { ok: false, code: 'not_a_repository', message: 'not a git repository' }
  ]) assert.deepEqual(parseRunnerMessage({ op: 'git.read.result', reqId: 'r-1', result }).result, result, JSON.stringify(result).slice(0, 40));
  const prepared = { op: 'attempt.event', attemptId: ULID, seq: 4, event: { t: 'accept.prepared', old: COMMIT, new: 'd'.repeat(40), at: 9 } };
  assert.deepEqual(parseRunnerMessage(clone(prepared)), prepared);
  assert.equal(parseRunnerMessage({ ...prepared, event: { ...prepared.event, new: 'HEAD' } }), null);
  // A setup is optional; a diff patch may hold up to 2 MiB (both sides), never more.
  const noSetup = clone(B2B_SAMPLES['probe.result']); delete noSetup.runtimes[0].setup;
  assert.ok(parseRunnerMessage(noSetup));
  const big = (n) => ({ op: 'git.read.result', reqId: 'r', result: { ok: true, read: 'diff', base: COMMIT, head: COMMIT, patch: 'x'.repeat(n), bytes: n, truncated: true } });
  assert.ok(parseRunnerMessage(big(2 * 1048576)));
  assert.equal(parseRunnerMessage(big(2 * 1048576 + 1)), null);
});

test('SC1 malformed additions answer null: the bearer, the args bounds, a long delta, output text, extra keys, seq, ready and mcpUrl', () => {
  const call = (o) => parseRunnerMessage({ ...clone(B2B_SAMPLES['mcp.call']), ...o });
  // The bearer: oversize, or not TOKEN_RE-shaped.
  for (const bearer of ['x'.repeat(129), TOKEN + 'x'.repeat(63), TOKEN.slice(1), TOKEN.replace('.', '-'), 'A'.repeat(22) + '.' + 'b'.repeat(42) + '=',
    `Bearer ${TOKEN}`, '', 7, null]) assert.equal(call({ bearer }), null, `bearer ${String(bearer).slice(0, 30)}`);
  assert.ok(TOKEN_RE.test(TOKEN) && isTokenShape(TOKEN) && !isTokenShape('x'.repeat(129)));
  // Args: depth 8 and 64 keys pass; depth 9 or 65 keys do not; nor 64 KiB+; nor a function, NaN, a class instance or __proto__.
  // Depth counts objects and lists: the args object is level 1, so `{ a: nest(7) }` is 8 levels and `{ a: nest(8) }` 9.
  assert.ok(call({ args: nest(7) }), 'depth 7');
  assert.ok(call({ args: { a: nest(7) } }), 'depth 8');
  assert.equal(call({ args: { a: nest(8) } }), null, 'depth 9');
  assert.ok(call({ args: keys(64) }), '64 keys');
  assert.equal(call({ args: keys(65) }), null, '65 keys');
  assert.equal(call({ args: { a: { b: keys(65) } } }), null, '65 keys deeper');
  assert.ok(call({ args: { body: 'x'.repeat(60 * 1024) } }), 'a 60 KiB string (args strings are bounded by the total)');
  assert.equal(call({ args: { body: 'x'.repeat(64 * 1024) } }), null, 'over 64 KiB in all');
  assert.equal(call({ args: { a: Array.from({ length: 1025 }, () => 0) } }), null, 'a list over 1024 items');
  for (const [name, v] of [['a function', () => 1], ['NaN', NaN], ['a Date', new Date()], ['undefined', undefined],
    ['a __proto__ key', JSON.parse('{"__proto__": {"x": 1}}')], ['a lone surrogate', '\ud800']]) {
    assert.equal(call({ args: { v } }), null, name);
  }
  for (const tool of ['', 'has space', 'x'.repeat(65), 'tool.dotted']) assert.equal(call({ tool }), null, `tool ${tool}`);
  // A message.delta over 4 KiB (UTF-8) is refused; exactly 4 KiB passes. Longer text is chunked by the runner.
  const delta = (text) => parseRunnerMessage({ op: 'attempt.runtime', attemptId: ULID, seq: 1, event: { t: 'message.delta', text } });
  assert.ok(delta('x'.repeat(4096)));
  assert.equal(delta('x'.repeat(4097)), null);
  assert.equal(delta('é'.repeat(2049)), null, '4098 UTF-8 bytes');
  const long = 'abc😀é'.repeat(3000);
  const chunks = chunkText(long);
  assert.ok(chunks.length > 1 && chunks.join('') === long);
  for (const c of chunks) assert.ok(Buffer.byteLength(c, 'utf8') <= 4096 && delta(c), 'each chunk parses');
  // agent.exec.done carries no output text.
  for (const k of ['stdout', 'stderr', 'output', 'text']) {
    assert.equal(parseRunnerMessage({ ...clone(B2B_SAMPLES['agent.exec.done']), [k]: 'secret output' }), null, `exec.done with ${k}`);
  }
  assert.equal(parseRunnerMessage({ ...clone(B2B_SAMPLES['agent.exec.done']), stdoutSha256: 'abc' }), null);
  // Extra keys inside nested shapes; a negative or fractional seq.
  assert.equal(parseRunnerMessage({ ...B2B_SAMPLES['attempt.runtime'], event: { ...RUNTIME_EVENTS[1], extra: 1 } }), null);
  assert.equal(parseRunnerMessage({ ...B2B_SAMPLES['attempt.runtime'], event: { ...RUNTIME_EVENTS[5], costUsd: 1 } }), null, 'the old usage field');
  const setupExtra = clone(B2B_SAMPLES['probe.result']); setupExtra.runtimes[0].setup.identity = 'someone';
  assert.equal(parseRunnerMessage(setupExtra), null, 'a setup never carries an identity');
  const gitExtra = clone(B2B_SAMPLES['git.read.result']); gitExtra.result.repoPath = 'C:/x';
  assert.equal(parseRunnerMessage(gitExtra), null);
  for (const seq of [-1, 1.5, '1', null]) assert.equal(parseRunnerMessage({ ...B2B_SAMPLES['attempt.runtime'], seq }), null, `seq ${seq}`);
  assert.equal(parseRunnerMessage({ ...B2B_SAMPLES['attempt.runtime'], event: { t: 'usage', ...RUNTIME_EVENTS[5], inputTokens: -1 } }), null);
  // ready without mcpUrl, and an mcpUrl that is not http://127.0.0.1:<port>/mcp.
  assert.equal(parseRunnerMessage({ op: 'ready', bootId: ULID }), null, 'ready without mcpUrl');
  for (const mcpUrl of ['http://localhost:51234/mcp', 'https://127.0.0.1:51234/mcp', 'http://127.0.0.1:51234/other', 'http://127.0.0.1:51234/mcp/',
    'http://127.0.0.1/mcp', 'http://127.0.0.1:0/mcp', 'http://127.0.0.1:70000/mcp', 'http://0.0.0.0:51234/mcp', 'http://[::1]:51234/mcp',
    'http://127.0.0.1:051234/mcp', 'http://user@127.0.0.1:51234/mcp', '', 5]) {
    assert.equal(parseRunnerMessage({ op: 'ready', bootId: ULID, mcpUrl }), null, `mcpUrl ${mcpUrl}`);
  }
  // A setup's hosts are bounded and host-shaped.
  const hosts = clone(B2B_SAMPLES['probe.result']);
  hosts.runtimes[0].setup.egressHosts = Array.from({ length: 9 }, (_, i) => ({ host: `h${i}.example.com`, port: 443 }));
  assert.equal(parseRunnerMessage(hosts), null, 'at most 8 hosts');
  hosts.runtimes[0].setup.egressHosts = [{ host: 'api.example.com', port: 0 }];
  assert.equal(parseRunnerMessage(hosts), null, 'port 0');
});

// ----- SC1b: MainToRunner shapes are type-checked -----

/** Type-checks virtual files against the real protocol module; returns each file's diagnostic messages. */
function typeCheck(files) {
  const dir = path.join(ROOT, 'test', '__sc1b__');
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, skipLibCheck: true, types: [], lib: ['lib.es2022.d.ts'] };
  const host = ts.createCompilerHost(options);
  const virtual = new Map(Object.entries(files).map(([name, text]) => [path.join(dir, name).replace(/\\/g, '/'), text]));
  const norm = (f) => f.replace(/\\/g, '/');
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, ...rest) => virtual.has(norm(f)) ? ts.createSourceFile(f, virtual.get(norm(f)), lang) : getSourceFile(f, lang, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (f) => virtual.has(norm(f)) || fileExists(f);
  const readFile = host.readFile.bind(host);
  host.readFile = (f) => virtual.get(norm(f)) ?? readFile(f);
  const program = ts.createProgram([...virtual.keys()], options, host);
  const out = {};
  for (const [f] of virtual) {
    const sf = program.getSourceFile(f);
    out[path.basename(f)] = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  }
  return out;
}

test('SC1b the MainToRunner additions are type-checked: a grant always has an argv array', () => {
  const head = "import type { MainToRunner, SandboxExecGrant, SandboxExecReply } from '../../src/shared/nexus/runnerProtocol';\n";
  const grant = "{ execId: 'e1', argv: ['npm', 'test'], cwd: '/workspace', timeoutMs: 60000 }";
  const r = typeCheck({
    'ok.ts': head + [
      `const a: MainToRunner = { op: 'mcp.reply', callId: 'c1', result: { ok: true, value: { grant: ${grant} } } };`,
      "const b: MainToRunner = { op: 'mcp.reply', callId: 'c1', result: { ok: false, code: 'denied', message: 'not allowed' } };",
      "const c: MainToRunner = { op: 'git.read', reqId: 'r1', task: { read: 'diff', repoPath: 'C:/r', base: 'a', head: 'b', maxBytesPerSide: 1048576 } };",
      "const d: MainToRunner = { op: 'git.read', reqId: 'r2', task: { read: 'status', repoPath: 'C:/r', branch: 'main', integrationRef: 'refs/nexus/accepted/main' } };",
      "const e: MainToRunner = { op: 'agent.shutdownTrees' };",
      `const f: SandboxExecReply = { op: 'mcp.reply', callId: 'c2', result: { ok: true, value: { grant: ${grant} } } };`,
      'const g: MainToRunner = f;',
      'export { a, b, c, d, e, g };'
    ].join('\n'),
    'no-argv.ts': head + "export const g: SandboxExecGrant = { execId: 'e1', cwd: '/workspace', timeoutMs: 1 };",
    'string-argv.ts': head + "export const g: SandboxExecGrant = { execId: 'e1', argv: 'npm test', cwd: '/workspace', timeoutMs: 1 };",
    'reply-no-argv.ts': head + "export const r: SandboxExecReply = { op: 'mcp.reply', callId: 'c', result: { ok: true, value: { grant: { execId: 'e', cwd: '/workspace', timeoutMs: 1 } } } };",
    'reply-no-ok.ts': head + "export const r: MainToRunner = { op: 'mcp.reply', callId: 'c', result: { value: 1 } };",
    'diff-bound.ts': head + "export const t: MainToRunner = { op: 'git.read', reqId: 'r', task: { read: 'diff', repoPath: 'C:/r', base: 'a', head: 'b', maxBytesPerSide: 2 } };",
    'shutdown-extra.ts': head + "export const t: MainToRunner = { op: 'agent.shutdownTrees', all: true };"
  });
  assert.deepEqual(r['ok.ts'], [], 'the well-formed shapes compile');
  for (const f of ['no-argv.ts', 'string-argv.ts', 'reply-no-argv.ts', 'reply-no-ok.ts', 'diff-bound.ts', 'shutdown-extra.ts'])
    assert.ok(r[f].length > 0, `${f} does not compile`);
  assert.ok(r['no-argv.ts'].some((m) => /argv/.test(m)));
  // The runner's own check of a grant before it runs it (defense in depth).
  const g = { execId: 'e1', argv: ['npm', 'test'], cwd: '/workspace/app', timeoutMs: 60000 };
  const parsed = parseExecGrant({ grant: g });
  assert.deepEqual(parsed, g);
  assert.notEqual(parsed.argv, g.argv);
  for (const [name, bad] of [['no argv', { ...g, argv: undefined }], ['a shell string', { ...g, argv: 'npm test' }], ['an empty argv', { ...g, argv: [] }],
    ['a non-string word', { ...g, argv: ['npm', 1] }], ['cwd outside /workspace', { ...g, cwd: '/etc' }], ['cwd with ..', { ...g, cwd: '/workspace/../etc' }],
    ['cwd /workspacex', { ...g, cwd: '/workspacex' }], ['a timeout over 30 min', { ...g, timeoutMs: 30 * 60_000 + 1 }], ['an extra key', { ...g, shell: true }]]) {
    assert.equal(parseExecGrant({ grant: JSON.parse(JSON.stringify(bad)) }), null, name);
  }
  assert.equal(parseExecGrant(g), null, 'the value is { grant }');
});

// ----- SC2: the MCP tool table -----

test('SC2 MCP tools: underscore names, capabilities within the SDE ceiling, no authority tool; arguments parse against the schema', () => {
  assert.deepEqual(MCP_TOOLS.map((t) => t.name), ['context_get', 'artifact_list', 'artifact_read', 'validations_get', 'job_status', 'job_logs',
    'sandbox_exec', 'job_request', 'changeset_register', 'requirement_draft', 'review_request']);
  const ceiling = new Set(getDomain('sde').capabilities.map((c) => c.id));
  for (const t of MCP_TOOLS) {
    assert.match(t.name, /^[a-z_]{3,48}$/, t.name);
    assert.ok(ceiling.has(t.capability), `${t.name}: ${t.capability} is in the SDE ceiling`);
    assert.doesNotMatch(t.name, /promote|accept|merge|approve|sign|handoff|secret/, t.name);
    assert.equal(t.args.additionalProperties, false, t.name);
    assert.ok(Number.isSafeInteger(t.resultMaxBytes) && t.resultMaxBytes > 0 && t.resultMaxBytes <= 256 * 1024 + 64 * 1024, t.name);
    assert.equal(typeof t.mutates, 'boolean');
  }
  assert.deepEqual(MCP_TOOLS.filter((t) => !t.mutates).map((t) => t.name).sort(),
    ['artifact_list', 'artifact_read', 'context_get', 'job_logs', 'job_status', 'validations_get']);
  // parseToolArgs: a fresh copy of good arguments; the first bad field named otherwise.
  const ok = parseToolArgs('sandbox_exec', { argv: ['npm', 'test'], cwd: '/workspace/app', timeoutMs: 60000 });
  assert.deepEqual(ok, { ok: true, args: { argv: ['npm', 'test'], cwd: '/workspace/app', timeoutMs: 60000 } });
  assert.deepEqual(parseToolArgs('shell_exec', {}), { ok: false, code: 'unknown_tool', field: null });
  assert.deepEqual(parseToolArgs('sandbox_exec', { argv: 'npm test', timeoutMs: 1000 }), { ok: false, code: 'bad_args', field: '/argv' });
  assert.deepEqual(parseToolArgs('sandbox_exec', { argv: ['x'], timeoutMs: 1000, network: 'host' }), { ok: false, code: 'bad_args', field: '/network' });
  assert.deepEqual(parseToolArgs('sandbox_exec', { argv: ['x'] }), { ok: false, code: 'bad_args', field: '/timeoutMs' });
  for (const cwd of ['/etc', '/workspace/../etc', '/workspace/./x', '/workspace//x', 'workspace', '/workspace\\x'])
    assert.equal(parseToolArgs('sandbox_exec', { argv: ['x'], cwd, timeoutMs: 1000 }).ok, false, cwd);
  assert.equal(parseToolArgs('job_request', { recipeId: 'sde.build.node' }).ok, false, 'only the listed recipes');
  assert.equal(parseToolArgs('job_request', { recipeId: 'sde.test.discover', inputs: [ULID] }).ok, true);
  assert.equal(parseToolArgs('artifact_read', { versionId: 'not-a-ulid' }).ok, false);
  assert.equal(parseToolArgs('artifact_read', { versionId: ULID, maxBytes: 256 * 1024 + 1 }).ok, false);
  const draft = { title: 'Reset a password', criteria: [{ id: 'AC1', text: 'An email is sent' }], clientKey: 'k1' };
  assert.equal(parseToolArgs('requirement_draft', draft).ok, true);
  assert.deepEqual(parseToolArgs('requirement_draft', { ...draft, criteria: [{ id: 'AC1' }] }), { ok: false, code: 'bad_args', field: '/criteria/0/text' });
  assert.equal(parseToolArgs('requirement_draft', { ...draft, criteria: [] }).ok, false, 'at least one criterion');
  assert.equal(parseToolArgs('context_get', []).ok, false, 'args are an object');
  assert.equal(parseToolArgs('context_get', {}).ok, true);
  assert.equal(getMcpTool('sandbox_exec').capability, 'sandbox.exec');
});

// ----- SC3: spend and rate policy -----

test('SC3 AGENT_DEFAULTS are the D-B4 values; budgetDecision boundaries; clampCaps never raises a value', () => {
  const D = policy.AGENT_DEFAULTS;
  assert.deepEqual({ ...D }, { turnUsdCents: 200, dayUsdCents: 1000, turnsPerHour: 6, concurrentTurns: 1, turnTokens: 400_000, toolCalls: 200,
    wallClockMs: 30 * 60_000, childJobs: 20 });
  assert.ok(Object.isFrozen(D));
  const caps = { ...D };
  const u = (o = {}) => ({ turnUsdCents: 0, dayUsdCents: 0, turnsLastHour: 0, liveTurns: 0, ...o });
  const decide = (o) => policy.budgetDecision({ usage: u(o), caps });
  assert.deepEqual(decide({}), { ok: true, dayRemainingUsdCents: 1000, turnBudgetUsdCents: 200 });
  // At the cap refused, one below allowed.
  assert.equal(decide({ dayUsdCents: 1000 }).reason, 'budget_exhausted');
  assert.deepEqual(decide({ dayUsdCents: 999 }), { ok: true, dayRemainingUsdCents: 1, turnBudgetUsdCents: 1 });
  assert.equal(decide({ turnUsdCents: 200 }).reason, 'budget_exhausted');
  assert.deepEqual(decide({ turnUsdCents: 199 }), { ok: true, dayRemainingUsdCents: 1000, turnBudgetUsdCents: 1 });
  assert.equal(decide({ turnsLastHour: 6 }).reason, 'rate_limited');
  assert.equal(decide({ turnsLastHour: 5 }).ok, true);
  assert.equal(decide({ liveTurns: 1 }).reason, 'busy', 'liveTurns === concurrentTurns');
  assert.equal(decide({ liveTurns: 0 }).ok, true);
  // The day remaining never goes below 0; the turn budget is min(turn cap - turn so far, day remaining).
  assert.deepEqual(decide({ dayUsdCents: 5000 }), { ok: false, reason: 'budget_exhausted', dayRemainingUsdCents: 0 });
  assert.equal(decide({ dayUsdCents: 850, turnUsdCents: 20 }).turnBudgetUsdCents, 150);
  assert.equal(decide({ dayUsdCents: 100, turnUsdCents: 20 }).turnBudgetUsdCents, 180);
  assert.equal(policy.dayRemainingCents(1200, caps), 0);
  assert.equal(policy.dayRemainingCents(NaN, caps), 1000);
  // Order: spend, then rate, then concurrency.
  assert.equal(decide({ dayUsdCents: 1000, turnsLastHour: 6, liveTurns: 1 }).reason, 'budget_exhausted');
  assert.equal(decide({ turnsLastHour: 6, liveTurns: 1 }).reason, 'rate_limited');
  // clampCaps: grants may only lower caps; a malformed or missing value takes the ceiling.
  // Wave-1 review, finding 6 (a named edit, stricter than before): a whole number below 1 is refused (CapsRefused, code
  // `invalid`), never kept, and the turn cap is lowered to the day cap; so every output satisfies the runtime_consents
  // CHECK ranges (1..ceiling, turn <= day). The old pin `clampCaps({ turnUsdCents: 0 }).turnUsdCents === 0` is replaced
  // by the refusal below.
  const requests = [{}, null, undefined, { turnUsdCents: 50 }, { dayUsdCents: 1e9, turnTokens: 1e12 },
    { toolCalls: 1.5, wallClockMs: NaN, childJobs: '3', concurrentTurns: Infinity, turnsPerHour: 1e300 }, { dayUsdCents: 150 }, { dayUsdCents: 1 },
    Object.fromEntries(policy.AGENT_CAP_KEYS.map((k) => [k, D[k] + 1])), Object.fromEntries(policy.AGENT_CAP_KEYS.map((k) => [k, Math.max(1, Math.floor(D[k] / 2))])),
    Object.fromEntries(policy.AGENT_CAP_KEYS.map((k) => [k, 1]))];
  const { V10_CONSENT_CEILINGS } = loadTs('src/main/nexus/db/v10Seed.ts');
  const CONSENT_COLS = { turnUsdCents: 'turn_usd_cents', dayUsdCents: 'day_usd_cents', turnsPerHour: 'turns_per_hour', concurrentTurns: 'concurrent_turns',
    turnTokens: 'turn_tokens', toolCalls: 'tool_calls' };
  // The two copies of the D-B4 caps agree: the shared defaults and the frozen v10 consent ceilings (and the DDL CHECKs).
  assert.deepEqual(Object.keys(V10_CONSENT_CEILINGS).sort(), Object.keys(CONSENT_COLS).sort());
  for (const k of Object.keys(CONSENT_COLS)) assert.equal(D[k], V10_CONSENT_CEILINGS[k], `${k}: AGENT_DEFAULTS equals V10_CONSENT_CEILINGS`);
  const { V10_DDL } = loadTs('src/main/nexus/db/schemaV10.ts');
  const consentDdl = V10_DDL.slice(V10_DDL.indexOf('CREATE TABLE IF NOT EXISTS runtime_consents'));
  for (const [k, col] of Object.entries(CONSENT_COLS)) {
    const range = k === 'concurrentTurns' ? new RegExp(`CHECK \\(${col} = ${D[k]}\\)`) : new RegExp(`CHECK \\(${col} BETWEEN 1 AND ${D[k]}\\)`);
    assert.match(consentDdl, range, `${col} CHECK is 1..${D[k]}`);
  }
  assert.match(consentDdl, /CHECK \(turn_usd_cents <= day_usd_cents\)/);
  /** The runtime_consents CHECK ranges, as the DDL above states them. */
  const consentRowOk = (c) => Object.keys(CONSENT_COLS).every((k) => Number.isSafeInteger(c[k]) && c[k] >= 1 && c[k] <= V10_CONSENT_CEILINGS[k])
    && c.turnUsdCents <= c.dayUsdCents;
  for (const r of requests) {
    const c = policy.clampCaps(r);
    assert.deepEqual(Object.keys(c).sort(), [...policy.AGENT_CAP_KEYS].sort());
    for (const k of policy.AGENT_CAP_KEYS) {
      assert.ok(Number.isSafeInteger(c[k]) && c[k] >= 1 && c[k] <= D[k], `${JSON.stringify(r)} ${k}=${c[k]}`);
      const asked = r && r[k];
      if (k !== 'turnUsdCents' && typeof asked === 'number' && Number.isSafeInteger(asked) && asked >= 1 && asked <= D[k]) assert.equal(c[k], asked, 'a lower value is kept');
    }
    assert.ok(consentRowOk(c), `${JSON.stringify(r)}: the clamped caps satisfy the runtime_consents CHECKs`);
  }
  assert.equal(policy.clampCaps({ turnUsdCents: 50 }).turnUsdCents, 50);
  assert.equal(policy.clampCaps({ turnUsdCents: 5000 }).turnUsdCents, 200);
  // The turn cap never exceeds a lowered day cap.
  assert.deepEqual([policy.clampCaps({ dayUsdCents: 150 }).turnUsdCents, policy.clampCaps({ dayUsdCents: 150, turnUsdCents: 100 }).turnUsdCents], [150, 100]);
  assert.equal(policy.clampCaps({ dayUsdCents: 1 }).turnUsdCents, 1);
  // Below 1 is refused for every cap, with the field named; a malformed value (not a whole number) still takes the ceiling.
  for (const k of policy.AGENT_CAP_KEYS) for (const bad of [0, -1, -1e9]) {
    assert.throws(() => policy.clampCaps({ [k]: bad }), (e) => e instanceof policy.CapsRefused && e instanceof RangeError && e.code === 'invalid'
      && e.field === k && e.message === `${k} must be at least 1`, `${k}=${bad}`);
  }
  assert.equal(policy.clampCaps({ turnsPerHour: 0.5 }).turnsPerHour, 6, 'a fraction is malformed: the ceiling');
  // Usage: capped tokens leave cache reads out (F10); an unreported cost is charged at the turn cap, estimated.
  const usage = { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 25, cacheReadTokens: 1e6, costUsdCents: null, toolCalls: 3, estimated: true };
  assert.equal(policy.cappedTokens(usage), 175);
  assert.deepEqual(policy.chargedCents(usage, caps), { usdCents: 200, estimated: true });
  assert.deepEqual(policy.chargedCents({ costUsdCents: 12 }, caps), { usdCents: 12, estimated: false });
  assert.equal(policy.turnLimitReached(usage, caps), null);
  assert.equal(policy.turnLimitReached({ ...usage, inputTokens: 400_000 - 75 }, caps), 'tokens');
  assert.equal(policy.turnLimitReached({ ...usage, inputTokens: 400_000 - 76 }, caps), null);
  assert.equal(policy.turnLimitReached({ ...usage, costUsdCents: 200 }, caps), 'usd');
  assert.equal(policy.turnLimitReached({ ...usage, toolCalls: 200 }, caps), 'tool_calls');
  assert.equal(policy.isMonotonicUsage(null, usage), true);
  assert.equal(policy.isMonotonicUsage(usage, { ...usage, outputTokens: 60 }), true);
  assert.equal(policy.isMonotonicUsage(usage, { ...usage, outputTokens: 40 }), false);
  assert.equal(policy.isMonotonicUsage({ ...usage, costUsdCents: 5 }, { ...usage, costUsdCents: null }), false, 'a reported cost never disappears');
});

// ----- SC4: change-set path rules -----

test('SC4 pathInScope and SENSITIVE_PATH_RE: .git in every spelling, streams, traversal, drives, env files and keys at any depth', () => {
  const SCOPE = ['**', '!.git/**'];
  for (const p of ['src/a.ts', 'README.md', 'a/b/c/d.py', '.github/workflows/ci.yml', '.gitignore', '.gitattributes', 'docs/keyboard.md',
    'src/keys.ts', 'environment.ts', 'src/env.ts', 'pem.txt']) {
    assert.equal(cs.pathInScope(p, SCOPE), true, p);
    assert.equal(cs.SENSITIVE_PATH_RE.test(p), false, `${p} is not sensitive`);
  }
  const sensitive = ['.git/config', '.GIT/config', 'GIT~1/config', 'git~2/HEAD', '.git./x', '.git /x', 'a/.git/config', 'a/b/.Git/hooks/pre-commit',
    '.git', 'x::$DATA', 'src/a.ts::$DATA', '.git::$INDEX_ALLOCATION/x', '.env', '.env.local', 'app/.ENV.production', 'certs/a.PEM', 'a.pem.',
    'id_rsa', 'home/id_rsa.pub', 'tls/server.key', 'tls/SERVER.KEY', '.npmrc', 'sub/.pypirc', 'a.pem/x'];
  for (const p of sensitive) {
    assert.equal(cs.SENSITIVE_PATH_RE.test(p), true, `${p} is sensitive`);
    assert.equal(cs.isSensitivePath(p), true, p);
    assert.equal(cs.pathInScope(p, SCOPE), false, `${p} is out of scope`);
  }
  assert.equal(cs.isSensitivePath('a\\.git\\config'), true, 'backslashes are read as separators');
  for (const p of ['../x', 'a/../../b', 'a/./b', './a', 'C:/x', 'c:x', '/etc/passwd', 'a\\b', 'a//b', '', 'a/', 'a\u0000b', 'a\nb'])
    assert.equal(cs.pathInScope(p, SCOPE), false, `${JSON.stringify(p)} is refused`);
  // Scopes: positive patterns include, `!` patterns exclude (case-insensitively), nothing matches an empty scope.
  assert.equal(cs.pathInScope('src/a.ts', ['src/**']), true);
  assert.equal(cs.pathInScope('lib/a.ts', ['src/**']), false);
  assert.equal(cs.pathInScope('src/a.ts', []), false);
  assert.equal(cs.pathInScope('SECRETS/a.txt', ['**', '!secrets/**']), false);
  assert.equal(cs.pathInScope('secrets', ['**', '!secrets/**']), false, 'the excluded folder itself');
  assert.equal(cs.pathInScope('src/a.test.ts', ['src/*.test.ts']), true);
  assert.equal(cs.pathInScope('src/x/a.test.ts', ['src/*.test.ts']), false, '* stays within a segment');
  assert.equal(cs.pathInScope('src/x/a.test.ts', ['src/**/*.test.ts']), true);
  assert.equal(cs.pathInScope('a.ts', ['**', '']), false, 'a malformed scope refuses');
  // Lockfiles.
  for (const p of ['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'go.sum'])
    assert.equal(cs.isLockfilePath(p), true, p);
  for (const p of ['package.json', 'lock.json', 'yarn.lock.bak', 'src/go.sum.ts']) assert.equal(cs.isLockfilePath(p), false, p);
  // Refs live under refs/nexus/* only (D-B13).
  // Wave-1 review, finding 3 (a named edit): the job ref and the worktree folder use the LOWERCASED session id, exactly
  // the pair schema v10's tr_worktrees_insert accepts for a new worktree (a real insert is in nexus-db-v10-schema S10-2g).
  assert.equal(cs.jobRefFor(ULID), `refs/nexus/job/${ULID.toLowerCase()}`);
  assert.equal(cs.worktreeRelPathFor(ULID), `wt/${ULID.toLowerCase()}`);
  assert.notEqual(cs.jobRefFor(ULID), `refs/nexus/job/${ULID}`, 'never the uppercase id');
  assert.equal(cs.jobRefFor(ULID.toLowerCase()), cs.jobRefFor(ULID), 'case-insensitive in the id');
  const { V10_DDL } = loadTs('src/main/nexus/db/schemaV10.ts');
  const trigger = V10_DDL.slice(V10_DDL.indexOf('CREATE TRIGGER IF NOT EXISTS tr_worktrees_insert'));
  const named = trigger.slice(0, trigger.indexOf('END;'));
  assert.match(named, /NEW\.rel_path IS NOT \('wt\/' \|\| lower\(NEW\.session_id\)\)/);
  assert.match(named, /NEW\.ref IS NOT \('refs\/nexus\/job\/' \|\| lower\(NEW\.session_id\)\)/);
  // The trigger's own expressions, evaluated for this id (SQLite lower() folds ASCII, as toLowerCase does for a ULID).
  const sqlLower = (s) => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  assert.deepEqual([cs.worktreeRelPathFor(ULID), cs.jobRefFor(ULID)], ['wt/' + sqlLower(ULID), 'refs/nexus/job/' + sqlLower(ULID)]);
  assert.equal(cs.integrationRefFor('main'), 'refs/nexus/accepted/main');
  assert.ok(cs.jobRefFor(ULID).startsWith(cs.NEXUS_REF_PREFIX) && cs.integrationRefFor('x').startsWith(cs.NEXUS_REF_PREFIX));
});

// ----- SC4b: the token claims as a v10 row (wave-1 review, finding 2) -----

test('SC4b claimsRowParts maps the claims onto the capability_tokens row and satisfies every v10 CHECK', () => {
  const { claimsRowParts, JTI_RE } = loadTs('src/shared/nexus/tokens.ts');
  const { V10_DDL } = loadTs('src/main/nexus/db/schemaV10.ts');
  const caps = getDomain('sde').capabilities.map((c) => JSON.parse(JSON.stringify(c)));
  const claims = { jti: 'AbCdEfGhIjKlMnOpQr_-01', sub: `agent:${ULID}`, onBehalfOf: 'user:local', projectId: 'p1', workspaceId: 'sde',
    participationId: 'pw1', jobId: 'j1', sessionId: ULID, caps, inputs: [ULID], mcpTools: ['context_get', 'sandbox_exec'], maxChildJobs: 20,
    iat: 1_000, exp: 1_000 + 30 * 60_000 };
  const row = claimsRowParts(claims);
  assert.deepEqual(Object.keys(row).sort(), ['caps_json', 'caps_sha256', 'expires_at', 'inputs_json', 'issued_at', 'job_id', 'jti', 'on_behalf_of',
    'principal_id', 'session_id', 'tools_json'].sort(), 'exactly the claim columns: no project, workspace or participation, no token or MAC');
  // The mapping the token service writes and reads back.
  assert.equal(row.caps_json, JSON.stringify({ caps, maxChildJobs: 20 }));
  assert.deepEqual(JSON.parse(row.caps_json), { caps, maxChildJobs: 20 });
  assert.equal(row.caps_sha256, crypto.createHash('sha256').update(row.caps_json).digest('hex'));
  assert.deepEqual([JSON.parse(row.inputs_json), JSON.parse(row.tools_json)], [[ULID], ['context_get', 'sandbox_exec']]);
  assert.deepEqual([row.jti, row.job_id, row.session_id, row.principal_id, row.on_behalf_of, row.issued_at, row.expires_at],
    ['AbCdEfGhIjKlMnOpQr_-01', 'j1', ULID, `agent:${ULID}`, 'user:local', 1_000, 1_000 + 30 * 60_000]);
  // The v10 CHECKs, as the DDL states them (a real insert is in nexus-db-v10-schema S10-2a).
  const table = V10_DDL.slice(V10_DDL.indexOf('CREATE TABLE IF NOT EXISTS capability_tokens'), V10_DDL.indexOf('CREATE INDEX IF NOT EXISTS ix_tokens_job'));
  assert.match(table, /json_type\(caps_json\) = 'object' AND length\(caps_json\) <= 8192/);
  assert.match(table, /json_type\(inputs_json\) = 'array' AND length\(inputs_json\) <= 8192/);
  assert.match(table, /json_type\(tools_json\) = 'array' AND length\(tools_json\) <= 2048/);
  const isObj = (t) => { const v = JSON.parse(t); return v !== null && typeof v === 'object' && !Array.isArray(v); };
  assert.ok(row.jti.length === 22 && JTI_RE.test(row.jti));
  assert.ok(isObj(row.caps_json) && row.caps_json.length <= 8192, 'caps_json is a JSON object (the array is never the column)');
  assert.ok(Array.isArray(JSON.parse(row.inputs_json)) && row.inputs_json.length <= 8192);
  assert.ok(Array.isArray(JSON.parse(row.tools_json)) && row.tools_json.length <= 2048);
  assert.match(row.caps_sha256, /^[0-9a-f]{64}$/);
  assert.ok(row.expires_at > row.issued_at);
  assert.equal(row.principal_id, `agent:${row.session_id}`, 'tr_tokens_insert: the principal is the agent of its session');
  // Never a token-shaped value or a MAC in the row.
  for (const v of Object.values(row)) assert.ok(!isTokenShape(String(v)), String(v));
  // Claims that cannot be a v10 row are refused, never mapped partially.
  for (const [name, over] of [['a raw token as jti', { jti: 'AbCdEfGhIjKlMnOpQr_-01.x' }], ['another agent', { sub: 'agent:01J9ZQ4M6X8Y2V3T5R7P9N1K0J' }],
    ['caps not a list', { caps: { id: 'artifact.read' } }], ['no job', { jobId: '' }], ['exp not after iat', { exp: 1_000 }],
    ['a negative child-job budget', { maxChildJobs: -1 }], ['caps over 8 KiB', { caps: [{ id: 'x'.repeat(8200) }] }],
    ['tools over 2 KiB', { mcpTools: ['x'.repeat(2100)] }]]) {
    assert.throws(() => claimsRowParts({ ...claims, ...over }), TypeError, name);
  }
});

// ----- SC5: the registry flip to B2b -----

/** The other five first-class domains and the three registry-only entries, as of B2a's close (4aec76f6). */
const SNAPSHOT = {
  qa: '340f7ff3299f9a88d2af7c4cfef6a148adf83ff40aaa288b8c24fb73e129c79b',
  data: 'f2df781207b20cff13d87628a3043762dde5b23815ce13568cf3243ce3fccc1e',
  'data-scientist': '68091aefe6a0ab948219d893bac0efb1084399d9118193c5e778c1f5d2c2216e',
  ml: 'f555104f653c2bd5de862d5b76bd330242435c35c715a046206676b2c62e36a8',
  dl: 'f7eb26389c077e530ee15478b4d229f3e89bb08415b4f6ff8cbf051101261d1f',
  research: '4e9c9f67cb4a1d01983c4235b422f664a009314a7a0577a54364eb54f83ee6f5',
  uiux: 'e5e0278c2a4ffcfe7c9b1b037be0c138064af30d134efad4debe0dd4da76e9d3',
  devops: '6dbb2203ea8f3d4b00af0abef25dcd4289f9ecff794687a9df14b72c59934ca0'
};

test('SC5 the registry passes at B2b: SDE steps 5, 7 and 12 are REAL; the other domains are unchanged (snapshot)', () => {
  assert.equal(spec.CURRENT_SUB_PHASE, 'B2b');
  assert.deepEqual(checkRegistry(DOMAINS, B2B_IMPL), []);
  for (const d of DOMAINS.filter((x) => x.id !== 'sde'))
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(d)).digest('hex'), SNAPSHOT[d.id], `${d.id} is unchanged`);
  const sde = getDomain('sde');
  const step = (id) => sde.lifecycle.find((s) => s.id === id);
  assert.deepEqual(sde.lifecycle.map((s) => [s.id, s.status, s.subPhase, s.e2eTestId ?? null]), [
    ['requirement', 'REAL', 'B2a', 'e2e.sde.requirement'], ['project', 'REAL', 'B1', 'e2e.sde.project'], ['repository', 'REAL', 'B2a', 'e2e.sde.repository'],
    ['code', 'REAL', 'B2a', 'e2e.sde.code'], ['ai-implementation', 'REAL', 'B2b', 'e2e.sde.ai-implementation'], ['tests', 'REAL', 'B2a', 'e2e.sde.tests'],
    ['review', 'REAL', 'B2b', 'e2e.sde.review'], ['build', 'REAL', 'B2a', 'e2e.sde.build'], ['application', 'REAL', 'B2a', 'e2e.sde.application'],
    ['dev-deployment', 'REAL', 'B2a', 'e2e.sde.dev-deployment'], ['diagnostics', 'REAL', 'B2a', 'e2e.sde.diagnostics'], ['iteration', 'REAL', 'B2b', 'e2e.sde.iteration']]);
  assert.ok(step('requirement').via.some((v) => v.skill === 'nexus-sde-requirement-draft'), 'step 1 names the drafting skill');
  assert.ok(step('requirement').via.some((v) => v.userAction === 'sde.requirement.write'), 'and still the user action');
  const csValidators = ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly'];
  for (const id of ['ai-implementation', 'iteration']) {
    assert.deepEqual(step(id).doneWhen, { kind: 'change_set', statuses: ['candidate', 'active'], validators: csValidators }, id);
    assert.ok(step(id).via.some((v) => v.skill === 'nexus-sde-change') && step(id).via.some((v) => v.userAction === 'sde.agent.turn'), id);
  }
  assert.deepEqual(step('review').via, [{ userAction: 'sde.changeset.review' }, { userAction: 'sde.changeset.accept' }, { userAction: 'sde.repo.merge' }]);
  assert.deepEqual(sde.skills, SKILLS.map((s) => s.id));
  assert.equal(SKILLS.length, 4);
  for (const r of ['repo.worktree', 'changeset.collect', 'changeset.merge_check', 'changeset.accept', 'changeset.accept_rollback', 'repo.ff'])
    assert.ok(sde.recipes.includes(r), r);
  // Wave-1 review, ruling on finding 1 (restored by B2b Task 16): SDE is executable end to end at B2b by the registry (status
  // alone) and, now that the scripted end-to-end flows pass (DELIVERED_SUB_PHASE = B2b), as delivered; the other five never are.
  // The SDE notes carry their B2b words.
  assert.equal(spec.isExecutableEndToEnd(sde, 'B2b'), true);
  for (const d of DOMAINS.filter((x) => x.id !== 'sde')) assert.equal(spec.isExecutableEndToEnd(d, 'B2b'), false, d.id);
  for (const d of DOMAINS) assert.equal(spec.isExecutableEndToEnd(d), d.id === 'sde', `${d.id} as delivered`);
  assert.ok(!/complete/i.test(sde.statusNote));
  assert.match(sde.statusNote, /The agent drafts requirements and implements changes in its own worktree; you review, accept and merge them\.$/);
  assert.equal(step('requirement').scopeNote, 'You write it in Nexus, or the agent drafts it for you to review.');
  // The delivery pin: DELIVERED_SUB_PHASE equals CURRENT_SUB_PHASE exactly when the e2e stub and the pending list are
  // empty, so Task 16 cannot empty the stub without flipping the constant, nor flip it without writing the titles.
  const pendingEmpty = B2B_PENDING.recipes.length === 0 && B2B_PENDING.validators.length === 0;
  assert.equal(spec.DELIVERED_SUB_PHASE === spec.CURRENT_SUB_PHASE, B2B_E2E_STUB.length === 0 && pendingEmpty,
    'DELIVERED_SUB_PHASE reaches CURRENT_SUB_PHASE in the same commit that empties B2B_E2E_STUB and B2B_PENDING');
  // B2B_IMPL extends B2A_IMPL; the e2e stub is empty (Task 16 wrote the titles) and B2B_IMPL names the three B2b ids in lifecycle order.
  for (const k of ['recipes', 'validators', 'viewers', 'e2eTests']) for (const id of B2A_IMPL[k]) assert.ok(B2B_IMPL[k].includes(id), `${k}: ${id}`);
  assert.deepEqual([...B2B_E2E_STUB], []);
  assert.deepEqual(B2B_IMPL.e2eTests.slice(-3), ['e2e.sde.ai-implementation', 'e2e.sde.review', 'e2e.sde.iteration']);
  assert.ok(B2B_IMPL.viewers.includes('viewer.change_set'));
  for (const r of B2B_PENDING.recipes) assert.ok(B2B_IMPL.recipes.includes(r) && !B2A_IMPL.recipes.includes(r), r);
  for (const v of B2B_PENDING.validators) assert.ok(B2B_IMPL.validators.includes(v) && !B2A_IMPL.validators.includes(v), v);
  // With B2A_IMPL the flipped registry is not sound (the B2b steps need their implementations): never quietly passes.
  const problems = checkRegistry(DOMAINS, B2A_IMPL);
  assert.ok(problems.some((p) => /sde\/ai-implementation/.test(p)) && problems.some((p) => /sde\/review/.test(p)) && problems.some((p) => /sde\/iteration/.test(p)));
  // The B2b actions are the agent flows of SDE, and only SDE has them.
  const flows = USER_ACTIONS.filter((a) => 'flow' in a.run);
  assert.deepEqual(flows.map((a) => [a.id, a.run.flow, a.subPhase, a.domain]), [
    ['sde.agent.turn', 'agent.turn', 'B2b', 'sde'], ['sde.changeset.review', 'review.decide', 'B2b', 'sde'],
    ['sde.changeset.accept', 'changeset.accept', 'B2b', 'sde'], ['sde.repo.merge', 'repo.merge_accepted', 'B2b', 'sde']]);
  for (const a of flows) assert.deepEqual(Object.keys(a.params.properties), [], `${a.id} takes no renderer parameter`);
});

// ----- SC6: the skills -----

test('SC6 the four skills exist, each at most 8 KiB, with no persona, office word or engine name', () => {
  for (const s of SKILLS) {
    const file = path.join(ROOT, 'resources', 'skills', s.id, 'SKILL.md');
    assert.ok(fs.existsSync(file), `${s.id}/SKILL.md exists`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(text, 'utf8') <= 8 * 1024, `${s.id} is at most 8 KiB`);
    assert.match(text, new RegExp(`^---\\r?\\nname: ${s.id}\\r?\\n`), `${s.id} names itself`);
    assert.equal(VENDOR.test(text), false, `${s.id} names no engine`);
    assert.deepEqual(scanText(text, true), [], `${s.id} passes the identity guard rules`);
    assert.doesNotMatch(text, /\byou are (an?|the) /i, `${s.id} gives the agent no persona`);
    assert.equal(s.availableFrom, 'B2b');
    assert.equal(s.domain, 'sde');
  }
  assert.deepEqual(SKILLS.map((s) => s.id), ['nexus-sde-change', 'nexus-sde-tests-first', 'nexus-sde-requirement-draft', 'nexus-sde-app-manifest']);
  // Skills teach the tool names the table serves.
  const change = fs.readFileSync(path.join(ROOT, 'resources', 'skills', 'nexus-sde-change', 'SKILL.md'), 'utf8');
  for (const t of ['context_get', 'sandbox_exec', 'changeset_register', 'review_request', 'job_request']) assert.ok(change.includes(t), t);
});

// ----- SC7: the diff-line secret rule (D-B14) -----

test('SC7 diffLineSecret blocks provider keys and private-key headers only; a lockfile integrity hash does not hit', () => {
  for (const line of ['+const key = "AKIAIOSFODNN7EXAMPLE";', 'aws_access_key_id = ASIAABCDEFGHIJKLMNOP', '-----BEGIN OPENSSH PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----', '-----BEGIN ENCRYPTED PRIVATE KEY-----',
    'token: ghp_' + 'a1B2'.repeat(9), 'url = "https://user:pa55word@example.com/x"']) {
    assert.equal(diffLineSecret(line), true, line);
  }
  const integrity = '      "integrity": "sha512-Bb8dd3g0EX2EdbmqrOmzuQyqgBs5xMC6zyiJb8Qra1tVkzXo6xljjAHi0sLHCMmzrJ0bJ3YRbh1JDcQvo3AQLg==",';
  assert.equal(diffLineSecret(integrity), false, 'a package-lock.json integrity line');
  for (const line of ['const x = 1;', '-----BEGIN PUBLIC KEY-----', '-----BEGIN CERTIFICATE-----', 'sha256: ' + SHA,
    'const id = "3f2a9c1e7b4d8a6f0e5c2b9d1a7f4e3c";', '', 7]) assert.equal(diffLineSecret(line), false, String(line));
  // A high-entropy string is advisory only: it stays in looksSecret, never in the blocking rule.
  const entropic = 'const blob = "Zx81kQ0p7LmN3vB6tYc2Rw9eH4uJ5sDa";';
  assert.equal(looksSecret(entropic), true);
  assert.equal(diffLineSecret(entropic), false);
});

// ----- SC8: the six git engine recipes -----

test('SC8 the six B2b recipes are engine recipes with the idempotency, wall clock and recovery class of the plan', () => {
  const table = [
    ['repo.worktree', true, 2, 60_000, 'requeue'],
    ['changeset.collect', false, 1, 120_000, 'interrupted'],
    ['changeset.merge_check', true, 2, 60_000, 'requeue'],
    ['changeset.accept', false, 1, 120_000, 'interrupted'],
    ['changeset.accept_rollback', true, 3, 60_000, 'requeue'],
    ['repo.ff', false, 1, 60_000, 'interrupted']
  ];
  assert.deepEqual(RECIPES.filter((r) => r.subPhase === 'B2b').map((r) => r.id), table.map((t) => t[0]));
  for (const [id, idempotent, maxAttempts, wallClockMs, recovery] of table) {
    const r = getRecipe(id);
    assert.deepEqual([r.executor, r.network, r.profiles, r.limits, r.subPhase], ['engine', 'not-applicable', [], null, 'B2b'], id);
    assert.deepEqual([r.retry.idempotent, r.retry.maxAttempts, r.wallClockMs, r.recovery], [idempotent, maxAttempts, wallClockMs, recovery], id);
    assert.deepEqual(Object.keys(r.params.properties), [], `${id} takes no parameter`);
    assert.ok(r.argvTemplates.length > 0 && r.argvTemplates.every((t) => t.startsWith('git.')), `${id} runs git only`);
  }
  assert.ok(/rolled back/.test(getRecipe('changeset.accept').outputContract.description), 'accept names its reconcile rule');
  // The B2a recipes are unchanged in shape (no recovery class: it follows retry.idempotent).
  for (const r of RECIPES.filter((x) => x.subPhase === 'B2a')) assert.equal(r.recovery, undefined, r.id);
});

test('SC8b the change-set validators (vB2b): stage, executor, blocking as planned; only sec.entropy_notes is advisory', () => {
  const table = [
    ['git.diff_nonempty', 'register', 'main', true], ['git.paths_in_scope', 'register', 'main', true],
    ['sec.secret_scan', 'register', 'main', true], ['sec.entropy_notes', 'register', 'main', false],
    ['cs.tests_pass', 'candidate', 'child-job', true], ['git.applies_cleanly', 'candidate', 'child-job', true]
  ];
  assert.deepEqual(VALIDATORS.filter((v) => v.subPhase === 'B2b').map((v) => v.id), table.map((t) => t[0]));
  for (const [id, stage, executes, blocking] of table) {
    const v = VALIDATORS.find((x) => x.id === id);
    assert.deepEqual([v.kinds, v.stage, v.executes, v.blocking, v.version], [['change_set'], stage, executes, blocking, 1], id);
  }
  assert.deepEqual(VALIDATORS.find((v) => v.id === 'git.applies_cleanly').recipes, ['changeset.merge_check']);
  assert.deepEqual(VALIDATORS.find((v) => v.id === 'cs.tests_pass').recipes, ['sde.test.discover', 'sde.test.node', 'sde.test.pytest']);
  assert.deepEqual(blockingValidatorsFor('change_set').map((v) => v.id),
    ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly']);
});

// ----- the agent views carry no host, model id, token or path -----

test('SC9 the B2b views name no host, model id, token, path, folder, pid, container or principal field', () => {
  const file = path.join(ROOT, 'src', 'shared', 'nexus', 'ipc.ts');
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const VIEWS = ['SessionView', 'SessionDetailView', 'ReviewView', 'ChangeSetAcceptView', 'RepoStatusView', 'MergeView', 'AgentSetupView',
    'SessionTurnView', 'SessionMessageView', 'SessionToolCallView', 'AgentUsageView'];
  const BANNED = /(?:^|[a-z])(?:host|hosts|model|models|token|bearer|path|paths|dir|folder|pid|container|principal)(?:Id|Ids)?$/i;
  const found = new Set();
  const names = [];
  const visit = (n) => {
    if (ts.isPropertySignature(n) && n.name) names.push(n.name.getText(sf));
    ts.forEachChild(n, visit);
  };
  for (const s of sf.statements) if (ts.isInterfaceDeclaration(s) && VIEWS.includes(s.name.text)) { found.add(s.name.text); visit(s); }
  assert.deepEqual([...found].sort(), [...VIEWS].sort(), 'every view is declared');
  assert.ok(names.length > 40, 'the walk sees the fields');
  assert.deepEqual(names.filter((n) => BANNED.test(n)), []);
  for (const n of ['repoPath', 'worktreePath', 'egressHosts', 'modelId', 'containerId', 'principalId', 'token', 'configDir', 'pid'])
    assert.match(n, BANNED, `${n} would be refused`);
  for (const n of ['hostsCount', 'inputTokens', 'turnTokens', 'integrationRef']) assert.doesNotMatch(n, BANNED, `${n} is a count or a ref`);
});

test('B2b Task 16: the sandbox profile of a project\'s code (a Python project\'s change sets are checked with pytest in the python image)', () => {
  const { profileFromFacts, projectSandboxProfile } = loadTs('src/main/nexus/exec/sandboxProfile.ts');
  const db = (rows) => ({ prepare: (sql) => ({ get: () => (/FROM projects/.test(sql) ? rows.project : rows.repo) }) });
  const project = (langs) => ({ metadata_json: JSON.stringify({ detectedLanguages: langs }) });
  // An input's recorded profile wins; then the project's languages (Python only is python); else node.
  assert.equal(profileFromFacts(db({ project: project(['JavaScript']) }), 'p', [{ metadata: { profile: 'sde-python' } }]), 'sde-python');
  assert.equal(profileFromFacts(db({ project: project(['Python']) }), 'p', []), 'sde-python');
  assert.equal(profileFromFacts(db({ project: project(['python', 'TypeScript']) }), 'p', []), 'sde-node');
  assert.equal(profileFromFacts(db({ project: project([]) }), 'p', []), 'sde-node');
  assert.equal(profileFromFacts(db({ project: undefined }), 'p', [{ metadata: { profile: 'not-a-profile' } }]), 'sde-node');
  // The project's repository (its newest live version's record) is read the same way.
  assert.equal(projectSandboxProfile(db({ project: project([]), repo: { metadata_json: JSON.stringify({ profile: 'sde-python' }) } }), 'p'), 'sde-python');
  assert.equal(projectSandboxProfile(db({ project: project(['python']) }), 'p'), 'sde-python');
  // The change-set check no longer takes the discovery recipe's first profile for every project (source pin).
  const v = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'nexus', 'validation', 'validationService.ts'), 'utf8');
  assert.match(v, /projectSandboxProfile\(this\.db, s\.projectId\)/);
  assert.doesNotMatch(v, /\? meta\.profile : recipe\.profiles\[0\];/);
});
