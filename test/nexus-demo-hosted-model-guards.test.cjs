'use strict';
// The hosted-model showcase driver's guards (tools/nexus-demo-hosted-model.cjs): it never starts without BOTH --go and --i-accept-limits, never
// without a provider that the runner's own preset table lists (read through the table, never repeated in the driver), never for a model that
// provider does not list with tools, never with the key anywhere but an environment variable (there is no key argument, and a value pasted
// into an unknown argument is never echoed), never into a non-empty --out, never with a NEXUS_DB_HOLD_* variable or a temp folder inside the
// app's real user data, never when the resource preflight is not ok; its STOP section is computed purely from the transcript; its transcript
// never holds the key; and its source never prints or writes the key, opens no connection itself and names no provider. Pure: it never starts
// Docker, a model, a world or a provider (every refusal comes first; the process-level runs below all carry a NEXUS_DB_HOLD_* variable as a
// second guard, so a refusal that went missing could still not start anything). No real key is used: the keys here are made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const demo = require('../tools/nexus-demo-hosted-model.cjs');
const { PROVIDER_PRESETS, allPresetHosts } = loadTs('src/runner/runtimes/hostedModel/presets.ts');
const { createHostedModelAdapter } = loadTs('src/runner/runtimes/hostedModel/adapter.ts');

const DRIVER = path.join(__dirname, '..', 'tools', 'nexus-demo-hosted-model.cjs');
const OUT = path.join(os.tmpdir(), `nx-hosted-demo-guard-${process.pid}-never-created`);
const FAKE_KEY = 'TESTKEY-guards-0123456789abcdef-NEVER-REAL';
const okPre = () => ({ ok: true, checks: [] });
const badPre = () => ({ ok: false, checks: [{ ok: false, notRun: 'Docker is not running.', action: 'Start it.' }] });
const deps = (x = {}) => ({ env: { NEXUS_DEMO_API_KEY: FAKE_KEY }, tmpdir: () => os.tmpdir(), userDataDirs: () => [path.join(os.tmpdir(), 'nx-never-real-user-data')], preflight: okPre, ...x });
const refusal = (argv, d = deps()) => demo.refusal(demo.parseArgs(argv), d);
const P = PROVIDER_PRESETS[0];
const GO = ['--go', '--i-accept-limits', '--provider', P.id];
/** A process-level run: the refusal is the whole run. A hold variable is the second guard (it refuses before the preflight and before Electron). */
const spawnDriver = (argv, env = {}) => spawnSync(process.execPath, [DRIVER, ...argv], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NEXUS_DB_HOLD_V10: '1', ...env } });

test('HD1 without --go nothing starts (exit 2), with or without any other argument; nothing is even asked', () => {
  let asked = false;
  const r = demo.refusal(demo.parseArgs(['--i-accept-limits', '--provider', P.id, '--out', OUT]), deps({ preflight: () => { asked = true; return okPre(); } }));
  assert.equal(r.code, demo.EXIT.REFUSED); assert.match(r.lines.join('\n'), /--go was not given/); assert.equal(asked, false);
  assert.equal(refusal([]).code, demo.EXIT.REFUSED);
  const p = spawnDriver(['--i-accept-limits', '--provider', P.id, '--out', OUT]);
  assert.equal(p.status, demo.EXIT.REFUSED); assert.match(p.stderr, /--go was not given/);
  assert.equal(fs.existsSync(OUT), false);
});

test('HD2 without --i-accept-limits nothing starts either (exit 2): --go alone is not enough, in either order; with both flags every guard passes', () => {
  let asked = false;
  const r = demo.refusal(demo.parseArgs(['--go', '--provider', P.id, '--out', OUT]), deps({ preflight: () => { asked = true; return okPre(); } }));
  assert.equal(r.code, demo.EXIT.REFUSED); assert.match(r.lines.join('\n'), /--i-accept-limits was not given/); assert.equal(asked, false);
  assert.equal(refusal(['--out', OUT, '--provider', P.id, '--go']).code, demo.EXIT.REFUSED);
  const p = spawnDriver(['--go', '--provider', P.id, '--out', OUT]);
  assert.equal(p.status, demo.EXIT.REFUSED); assert.match(p.stderr, /--i-accept-limits was not given/);
  assert.equal(fs.existsSync(OUT), false);
  assert.equal(refusal([...GO, '--out', OUT]), null, 'with both flags, a listed provider, a key and a new folder, every guard passes');
});

test('HD3 the provider must be one the runner\'s preset table lists and the model one of its tool-capable models (both read from the table); the default model is the table\'s', () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.deepEqual(demo.table().providers.map((p) => p.id), ids, 'the driver reads the runner\'s own table');
  assert.equal(refusal(['--go', '--i-accept-limits', '--out', OUT]).code, demo.EXIT.REFUSED, '--provider is required (there is no default provider)');
  assert.match(refusal(['--go', '--i-accept-limits', '--out', OUT]).lines[0], new RegExp(ids[0]), 'the message lists the ids from the table');
  for (const bad of ['nope', ids[0].toUpperCase(), `${ids[0]} `, 'api.example.com', '--out', '']) assert.equal(refusal(['--go', '--i-accept-limits', '--provider', bad, '--out', OUT]).code, demo.EXIT.REFUSED, JSON.stringify(bad));
  for (const p of PROVIDER_PRESETS) {
    assert.equal(refusal(['--go', '--i-accept-limits', '--provider', p.id, '--out', OUT]), null, `${p.id} with its default model`);
    for (const m of p.models.filter((x) => x.tools)) assert.equal(refusal(['--go', '--i-accept-limits', '--provider', p.id, '--model', m.name, '--out', OUT]), null, `${p.id} / ${m.name}`);
    assert.equal(refusal(['--go', '--i-accept-limits', '--provider', p.id, '--model', 'no-such-model', '--out', OUT]).code, demo.EXIT.REFUSED);
  }
  const other = PROVIDER_PRESETS[1];
  if (other) assert.equal(refusal(['--go', '--i-accept-limits', '--provider', P.id, '--model', other.defaultModel, '--out', OUT]).code, demo.EXIT.REFUSED, 'another provider\'s model is refused');
  const p = spawnDriver([...GO.slice(0, 2), '--provider', 'nope', '--out', OUT]);
  assert.equal(p.status, demo.EXIT.REFUSED); assert.match(p.stderr, /--provider must be one of/);
  assert.equal(fs.existsSync(OUT), false);
});

test('HD4 the key comes from an environment variable only: no key argument exists, a value pasted into an unknown argument is never echoed, an unset or key-unshaped variable is refused and its value never shown; --key-env names the variable', () => {
  // there is no key argument: any spelling is an unknown argument, and the refusal names only the flag
  for (const arg of ['--key', '--api-key', `--api-key=${FAKE_KEY}`, `--key=${FAKE_KEY}`]) {
    const r = refusal([...GO, '--out', OUT, arg, FAKE_KEY]);
    assert.equal(r.code, demo.EXIT.REFUSED, arg);
    assert.match(r.lines[0], /unknown argument --(?:api-)?key/, arg);
    assert.ok(!r.lines.join('\n').includes(FAKE_KEY), `${arg}: the pasted value is never echoed`);
  }
  const p = spawnDriver([...GO, '--out', OUT, `--api-key=${FAKE_KEY}`]);
  assert.equal(p.status, demo.EXIT.REFUSED); assert.ok(!p.stderr.includes(FAKE_KEY) && !p.stdout.includes(FAKE_KEY));
  // the variable: unset, empty, with a space (not key-shaped), too short
  for (const [env, why] of [[{}, 'unset'], [{ NEXUS_DEMO_API_KEY: '' }, 'empty'], [{ NEXUS_DEMO_API_KEY: 'has a space in it 12345' }, 'a space'], [{ NEXUS_DEMO_API_KEY: 'short' }, 'too short']]) {
    const r = refusal([...GO, '--out', OUT], deps({ env }));
    assert.equal(r.code, demo.EXIT.REFUSED, why); assert.match(r.lines[0], /NEXUS_DEMO_API_KEY/, why);
    for (const v of Object.values(env)) if (v.length > 0) assert.ok(!r.lines.join('\n').includes(v), `${why}: the value is never shown`);
  }
  // --key-env: another name, validated as a NAME; the default name is used when none is given
  assert.equal(demo.parseArgs([...GO, '--out', OUT]).keyEnv, 'NEXUS_DEMO_API_KEY');
  assert.equal(refusal([...GO, '--out', OUT, '--key-env', 'MY_ONE_RUN_KEY'], deps({ env: { MY_ONE_RUN_KEY: FAKE_KEY } })), null);
  assert.equal(refusal([...GO, '--out', OUT, '--key-env', 'MY_ONE_RUN_KEY'], deps({ env: { NEXUS_DEMO_API_KEY: FAKE_KEY } })).code, demo.EXIT.REFUSED, 'the named variable, not the default');
  for (const bad of [FAKE_KEY, 'a b', '1ABC', '', 'X'.repeat(80), 'A=B']) assert.equal(refusal([...GO, '--out', OUT, '--key-env', bad]).code, demo.EXIT.REFUSED, `a key-env that is not a name: ${bad.slice(0, 10)}`);
  assert.equal(demo.argName(`--api-key=${FAKE_KEY}`), '--api-key');
  // the order: the key is checked AFTER the cheap refusals and before the preflight (a missing key never asks Docker anything)
  let asked = false;
  refusal([...GO, '--out', OUT], deps({ env: {}, preflight: () => { asked = true; return okPre(); } }));
  assert.equal(asked, false);
});

test('HD5 --out must be a new or empty folder; a NEXUS_DB_HOLD_* variable, a temp folder inside the real user data, and a failing preflight each stop the run before it starts (the preflight is exit 3)', () => {
  assert.equal(refusal([...GO]).code, demo.EXIT.REFUSED, '--out is required');
  assert.equal(refusal([...GO, '--out', os.tmpdir()]).code, demo.EXIT.REFUSED, 'a non-empty folder is never written into');
  assert.equal(refusal([...GO, '--out', __filename]).code, demo.EXIT.REFUSED, 'a file is not a folder');
  const p = spawnDriver([...GO, '--out', os.tmpdir()], { NEXUS_DEMO_API_KEY: FAKE_KEY });
  assert.equal(p.status, demo.EXIT.REFUSED); assert.match(p.stderr, /not an empty folder/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-hosted-demo-empty-'));
  try { assert.equal(refusal([...GO, '--out', empty]), null); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  const h = refusal([...GO, '--out', OUT], deps({ env: { NEXUS_DB_HOLD_V10: '1', NEXUS_DEMO_API_KEY: FAKE_KEY } }));
  assert.equal(h.code, demo.EXIT.REFUSED); assert.match(h.lines[0], /NEXUS_DB_HOLD_V10 is set/); assert.doesNotMatch(h.lines.join(''), /=1/, 'names only, never values');
  const real = refusal([...GO, '--out', OUT], deps({ tmpdir: () => path.join(os.tmpdir(), 'inside-real'), userDataDirs: () => [os.tmpdir()] }));
  assert.equal(real.code, demo.EXIT.REFUSED); assert.match(real.lines[0], /inside the app's real user data/);
  const pre = refusal([...GO, '--out', OUT], deps({ preflight: badPre }));
  assert.equal(pre.code, demo.EXIT.NOT_RUN); assert.match(pre.lines.join('\n'), /NOT RUN: Docker is not running/);
  let asked = false;
  refusal([...GO, '--out', OUT], deps({ env: { NEXUS_DB_HOLD_V9: '1', NEXUS_DEMO_API_KEY: FAKE_KEY }, preflight: () => { asked = true; return okPre(); } }));
  assert.equal(asked, false, 'a held run never asks Docker anything');
});

test('HD6 arguments: an unknown one is refused first; fixture, --weather, brief and --max-turns are checked; defaults are the documented ones', () => {
  assert.equal(refusal([...GO, '--out', OUT, '--frobnicate']).code, demo.EXIT.REFUSED);
  assert.match(refusal([...GO, '--out', OUT, '--url', 'http://x']).lines[0], /unknown argument --url/, 'no address argument exists: the provider is a table entry');
  assert.equal(refusal([...GO, '--out', OUT, '--fixture', 'nope']).code, demo.EXIT.REFUSED);
  assert.equal(refusal([...GO, '--out', OUT, '--max-turns', '5']).code, demo.EXIT.REFUSED);
  assert.equal(refusal([...GO, '--out', OUT, '--max-turns', '0']).code, demo.EXIT.REFUSED);
  assert.equal(refusal([...GO, '--out', OUT, '--brief', 'short']).code, demo.EXIT.REFUSED);
  const o = demo.parseArgs([...GO, '--out', OUT]);
  assert.deepEqual([o.model, o.fixture, o.maxTurns, o.keyEnv], [null, 'node-test-app', 3, 'NEXUS_DEMO_API_KEY']);
  assert.match(o.brief, /todo-list library/); assert.match(o.brief, /\["node","--test"\]/);
  const wx = demo.parseArgs([...GO, '--out', OUT, '--weather']);
  assert.equal(wx.fixture, 'pytest-app'); assert.match(wx.brief, /weather-prediction model/); assert.match(wx.brief, /\["python","-m","pytest","-q"\]/);
  assert.equal(refusal([...GO, '--out', OUT, '--weather']), null);
  assert.equal(refusal([...GO, '--out', OUT, '--fixture', 'pytest-app', '--brief', 'Build a tiny python thing with tests.']), null);
  for (const n of [1, 2, 3, 4]) assert.equal(refusal([...GO, '--out', OUT, '--max-turns', String(n)]), null);
});

// ---------------------------------------------------------------- the STOP section and the transcript

const hosts = allPresetHosts().map((x) => `${x.host}:${x.port}`);
const chosen = `${P.host}:${P.port}`;
const cleanT = () => ({ provider: P.id, model: P.defaultModel, chosenHost: chosen, tableHosts: hosts, probe: { listed: true, providers: [P.id] },
  consent: { kind: 'hosted-model', hosts, provider: P.id, model: P.defaultModel, caps: { toolCalls: 200, turnTokens: 400000 }, defaults: { toolCalls: 200, turnTokens: 400000 } },
  turns: [{ n: 1, egress: { decisions: [{ decision: 'allowed', host: P.host, port: 443, reason: null }, { decision: 'allowed', host: P.host, port: 443, reason: null }], truncated: 0 }, keyRejected: false }], outside: [] });

test('HD7 the STOP section is pure and exact: any host but the chosen provider\'s (allowed or refused), unreported decisions, a rejected key, a consent that is not the table\'s, a provider the check does not list, a change outside the scratch folders', () => {
  assert.deepEqual(demo.stopFindings(cleanT()), [], 'a clean run says nothing');
  const other = PROVIDER_PRESETS[1] ? PROVIDER_PRESETS[1].host : 'elsewhere.example.com';
  const t1 = cleanT(); t1.turns[0].egress.decisions.push({ decision: 'refused', host: other, port: 443, reason: 'host_not_allowed' });
  assert.match(demo.stopFindings(t1).join('\n'), new RegExp(`a host other than ${chosen.replace(/\./g, '\\.')} was requested: ${other.replace(/\./g, '\\.')}:443 \\(allowed 0, refused 1; host_not_allowed\\)`));
  const t2 = cleanT(); t2.turns[0].egress.decisions.push({ decision: 'allowed', host: other, port: 443, reason: null });
  assert.match(demo.stopFindings(t2).join('\n'), /a host other than .* was requested/);
  const t3 = cleanT(); t3.turns[0].egress.decisions.push({ decision: 'allowed', host: P.host, port: 8443, reason: null });
  assert.match(demo.stopFindings(t3).join('\n'), /:8443 \(allowed 1/, 'the port counts too');
  const t4 = cleanT(); t4.turns[0].egress.truncated = 3;
  assert.match(demo.stopFindings(t4).join('\n'), /3 proxy decision\(s\) were not reported/);
  const t5 = cleanT(); t5.turns[0].keyRejected = true;
  assert.match(demo.stopFindings(t5).join('\n'), /the provider rejected the API key/);
  const t6 = cleanT(); t6.consent.hosts = [chosen];
  assert.match(demo.stopFindings(t6).join('\n'), /consent's hosts are/);
  const t7 = cleanT(); t7.consent.kind = 'cli-agent'; t7.consent.provider = 'x'; t7.consent.caps.toolCalls = 999;
  const s7 = demo.stopFindings(t7).join('\n');
  assert.match(s7, /not hosted-model/); assert.match(s7, /consent records x/); assert.match(s7, /cap toolCalls is 999/);
  const t8 = cleanT(); t8.probe.listed = false;
  assert.match(demo.stopFindings(t8).join('\n'), /does not list the chosen provider and model/);
  const t9 = cleanT(); t9.outside = [{ when: 'after turn 1', what: 'the scratch user repository changed before any approval (files)' }];
  assert.match(demo.stopFindings(t9).join('\n'), /outside the worktree/);
  assert.deepEqual(demo.egressSummary(t1), { [chosen]: { allowed: 2, refused: 0, reasons: [null] }, [`${other}:443`]: { allowed: 0, refused: 1, reasons: ['host_not_allowed'] } });
});

test('HD8 the transcript never holds the key: the scrubber cuts it out in every form and key-shaped strings too; the files written are clean; the rendering is honest (a stop, a limit, a refused host)', () => {
  const sc = demo.scrubber([FAKE_KEY]);
  const b64 = Buffer.from(FAKE_KEY).toString('base64');
  for (const form of [FAKE_KEY, b64, encodeURIComponent(FAKE_KEY), `Authorization: Bearer ${FAKE_KEY}`, `key=${FAKE_KEY}`]) assert.ok(!sc(`before ${form} after`).includes(FAKE_KEY) && !sc(`before ${form} after`).includes(b64), form);
  assert.equal(demo.scrub('a gsk_abcdefghijklmnopqrstuv b AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ c sk-abcdefghijklmnop'), 'a [secret] b [secret] c [secret]');
  assert.equal(demo.scrub('C:\\Users\\alice\\x and /home/bob/y'), 'C:\\Users\\<user>\\x and /<home>/<user>/y');
  const T = { ...cleanT(), result: 'stopped', startedAt: 'x', fixture: 'node-test-app', keyEnv: 'NEXUS_DEMO_API_KEY', brief: 'b', maxTurns: 3, merge: null, wallMs: 5000, changeSets: [], egress: {},
    problems: [`oops ${FAKE_KEY}`], stop: ['a stop'], totals: { turns: 1, toolCalls: 2, providerRequests: 2, proxyDecisions: 2, inTokens: 10, outTokens: 5 }, scrubWith: sc };
  T.turns[0] = { ...T.turns[0], state: 'failed', outcome: 'hosted_rate_limited', tools: ['write_file'], ms: 1000, usage: { inputTokens: 10, outputTokens: 5, toolCalls: 1 }, providerRequests: 5, limitHit: 'hosted_rate_limited',
    sandboxRuns: [{ argv: 'node --test', exit: 1, tests: 3, pass: 2, fail: 1 }], changeSet: { versionId: 'v1', status: 'failed', testsSummary: `1 failed ${FAKE_KEY}` }, error: `boom ${FAKE_KEY}` };
  T.egress = demo.egressSummary(T);
  const md = demo.markdown(T);
  assert.match(md, /ENDED ON THE LIMIT: hosted_rate_limited/); assert.match(md, /provider requests: 5/); assert.match(md, /\*\*failed\*\*/); assert.match(md, /exit 1; tests 3, pass 2, fail 1/); assert.match(md, /STOP/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-hosted-demo-tr-'));
  try {
    const base = demo.writeTranscript(T, { out: path.join(dir, 'product') }, sc);
    for (const f of [`${base}.json`, `${base}.md`]) {
      const text = fs.readFileSync(f, 'utf8');
      assert.ok(!text.includes(FAKE_KEY) && !text.includes(b64), `${path.basename(f)} holds the key`);
      assert.ok(!text.includes('scrubWith'));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const bad = { ...T, turns: [{ ...T.turns[0], egress: { decisions: [{ decision: 'refused', host: 'elsewhere.example.com', port: 443, reason: 'host_not_allowed' }], truncated: 0 } }] };
  bad.egress = demo.egressSummary(bad);
  assert.match(demo.markdown(bad), /NOT the chosen provider's host/);
});

// ---------------------------------------------------------------- the source

const SRC = fs.readFileSync(DRIVER, 'utf8');
const lines = SRC.split(/\r?\n/);
const codeLines = lines.map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l));

test('HD9 the source never prints or writes the key (its holders are only ever stored into the key store and given to the scrubber), reads the variable once and removes it, opens no connection and names no provider', () => {
  // The key's holders: `apiKey` (the value read in run) and `raw` (the value read in refusal, for its SHAPE). Neither is printed, logged, written, thrown or interpolated.
  const sink = /console\.|\blog\(|writeFile|appendFile|stringify|\bthrow\b|Error\(|process\.std|\.write\(|`[^`]*\$\{[^}]*\b(?:apiKey|raw)\b|T\.[A-Za-z]+\s*=.*\b(?:apiKey|raw)\b|problems\.push\([^)]*\b(?:apiKey|raw)\b/;
  for (const { l, n } of codeLines) {
    if (/\b(?:apiKey|raw)\b/.test(l)) assert.ok(!sink.test(l), `line ${n} mentions the key's holder next to a print/write/throw: ${l.trim().slice(0, 120)}`);
  }
  const apiKeyLines = codeLines.filter(({ l }) => /\bapiKey\b/.test(l)).map(({ l }) => l.trim());
  assert.deepEqual(apiKeyLines.map((l) => l.replace(/\s+/g, ' ')).map((l) => (/^const apiKey = /.test(l) ? 'read' : /scrubber\(\[apiKey\]\)/.test(l) ? 'scrubber' : /w\.setKey\(apiKey, o\.provider\)/.test(l) ? 'store' : `OTHER: ${l}`)), ['read', 'scrubber', 'store'],
    'the key value is read, given to the scrubber and stored into the key store: nowhere else');
  assert.equal(codeLines.filter(({ l }) => /process\.env\[o\.keyEnv\]/.test(l)).length, 2, 'one line reads the variable and one removes it');
  assert.ok(codeLines.some(({ l }) => /delete process\.env\[o\.keyEnv\]/.test(l)), 'the variable is removed from the process environment right after it is read');
  const reads = codeLines.filter(({ l }) => /process\.env\[o\.keyEnv\]/.test(l) && !/delete /.test(l));
  assert.equal(reads.length, 1, 'read exactly once');
  // no key argument, no key file
  assert.ok(!/'--(?:api-)?key'/.test(SRC), 'no key argument is parsed');
  assert.ok(!/readFile(?:Sync)?\([^)]*(?:key|secret)/i.test(SRC), 'no key file is read');
  // the transcript writer scrubs everything it writes
  const writes = codeLines.filter(({ l }) => /fs\.writeFileSync\(/.test(l)).map(({ l }) => l.trim());
  assert.ok(writes.length === 2 && writes.every((l) => /sc\(/.test(l)), `every transcript write goes through the scrubber: ${writes.join(' | ')}`);
  // the driver itself opens no connection and imports no network module
  for (const { l, n } of codeLines) assert.ok(!/require\('(?:node:)?(?:http|https|net|tls|dns|dgram|http2)'\)|\bfetch\(|XMLHttpRequest|WebSocket/.test(l), `line ${n} opens a connection`);
  // scratch folders only: nothing is written but --out's folder and the transcript beside it; the data home is the world's own temp folder
  assert.ok(codeLines.some(({ l }) => /inside\(w\.repoDir, os\.tmpdir\(\)\)/.test(l)) && codeLines.some(({ l }) => /\[w\.userData, w\.dataHome\.root\]\.every\(\(p\) => inside\(p, os\.tmpdir\(\)\)\)/.test(l)));
  // no provider is named: ids, hosts and model names live in the runner's table only
  for (const p of PROVIDER_PRESETS) for (const word of [p.id, p.host, ...p.models.map((m) => m.name), p.basePath]) {
    assert.ok(!SRC.toLowerCase().includes(word.toLowerCase()), `the driver names "${word}": a provider's words live in the preset table only`);
  }
  assert.ok(!/googleapis|api\.[a-z]+\.com/i.test(SRC), 'no host name in the driver');
});

test('HD10 the table the driver validates against is the runner\'s own: the same ids, hosts and models as the adapter\'s probe entry, and the driver never reads a key to build it', async () => {
  const entry = await createHostedModelAdapter().check();
  const t = demo.table();
  assert.deepEqual(t.providers.map((p) => [p.id, p.models]), entry.setup.providers.map((p) => [p.id, p.models]));
  assert.deepEqual(t.hosts, entry.setup.egressHosts.map((h) => `${h.host}:${h.port}`));
  for (const p of t.providers) assert.ok(p.models.some((m) => m.name === p.defaultModel && m.tools), `${p.id}: the default model is a tool-capable one of its own list`);
});
