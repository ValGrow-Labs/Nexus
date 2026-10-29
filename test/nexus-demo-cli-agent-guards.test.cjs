'use strict';
// The real-CLI check's guards (tools/nexus-demo-cli-agent.cjs): it never starts without BOTH --go and --i-accept-quota, never into a non-empty
// --out, never with an unknown argument, never with a NEXUS_DB_HOLD_* variable or a temp folder inside the app's real user data, never when the
// resource preflight is not ok; its STOP section is computed purely from the transcript; and its source never reads or copies the CLI's own
// home folder. Pure: it never starts Docker, the CLI, a model or a world (every refusal comes first; the process-level runs below all carry
// a NEXUS_DB_HOLD_* variable as a second guard, so a refusal that went missing could still not start anything).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const demo = require('../tools/nexus-demo-cli-agent.cjs');

const DRIVER = path.join(__dirname, '..', 'tools', 'nexus-demo-cli-agent.cjs');
const OUT = path.join(os.tmpdir(), `nx-cli-demo-guard-${process.pid}-never-created`);
const okPre = () => ({ ok: true, checks: [] });
const badPre = () => ({ ok: false, checks: [{ ok: false, notRun: 'Docker is not running.', action: 'Start it.' }] });
const deps = (x = {}) => ({ env: {}, tmpdir: () => os.tmpdir(), userDataDirs: () => [path.join(os.tmpdir(), 'nx-never-real-user-data')], preflight: okPre, ...x });
const refusal = (argv, d = deps()) => demo.refusal(demo.parseArgs(argv), d);
const GO = ['--go', '--i-accept-quota'];
/** A process-level run: the refusal is the whole run. A hold variable is the second guard (it refuses before the preflight and before Electron). */
const spawnDriver = (argv) => spawnSync(process.execPath, [DRIVER, ...argv], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NEXUS_DB_HOLD_V10: '1' } });

test('CD1 without --go nothing starts (exit 2), with or without any other argument; nothing is even asked', () => {
  let asked = false;
  const r = demo.refusal(demo.parseArgs(['--i-accept-quota', '--out', OUT]), deps({ preflight: () => { asked = true; return okPre(); } }));
  assert.equal(r.code, demo.EXIT.REFUSED); assert.match(r.lines.join('\n'), /--go was not given/); assert.equal(asked, false);
  assert.equal(refusal([]).code, demo.EXIT.REFUSED);
  const p = spawnDriver(['--i-accept-quota', '--out', OUT]);
  assert.equal(p.status, demo.EXIT.REFUSED); assert.match(p.stderr, /--go was not given/);
  assert.equal(fs.existsSync(OUT), false);
});

test('CD2 without --i-accept-quota nothing starts either (exit 2): --go alone is not enough, in either order', () => {
  let asked = false;
  const r = demo.refusal(demo.parseArgs(['--go', '--out', OUT]), deps({ preflight: () => { asked = true; return okPre(); } }));
  assert.equal(r.code, demo.EXIT.REFUSED); assert.match(r.lines.join('\n'), /--i-accept-quota was not given/); assert.equal(asked, false);
  assert.equal(refusal(['--out', OUT, '--go']).code, demo.EXIT.REFUSED);
  const p = spawnDriver(['--go', '--out', OUT]);
  assert.equal(p.status, demo.EXIT.REFUSED); assert.match(p.stderr, /--i-accept-quota was not given/);
  assert.equal(fs.existsSync(OUT), false);
  assert.equal(refusal([...GO, '--out', OUT]), null, 'with both flags and a new folder, every guard passes');
});

test('CD3 --out must be a new or empty folder: an existing non-empty folder (or a file) is refused (exit 2); an empty one passes', () => {
  assert.equal(refusal([...GO]).code, demo.EXIT.REFUSED, '--out is required');
  assert.equal(refusal([...GO, '--out', os.tmpdir()]).code, demo.EXIT.REFUSED, 'a non-empty folder is never written into');
  assert.equal(refusal([...GO, '--out', __filename]).code, demo.EXIT.REFUSED, 'a file is not a folder');
  const p = spawnDriver([...GO, '--out', os.tmpdir()]);
  assert.equal(p.status, demo.EXIT.REFUSED); assert.match(p.stderr, /not an empty folder/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-cli-demo-empty-'));
  try { assert.equal(refusal([...GO, '--out', empty]), null); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('CD4 an unknown argument is refused (exit 2) before anything else; --max-turns is 1 or 2; the brief is bounded; defaults are the documented ones', () => {
  assert.equal(refusal([...GO, '--out', OUT, '--frobnicate']).code, demo.EXIT.REFUSED);
  assert.match(refusal([...GO, '--out', OUT, '--model', 'x']).lines[0], /unknown argument --model/, 'no model, fixture or url choice exists');
  assert.equal(refusal([...GO, '--out', OUT, '--max-turns', '3']).code, demo.EXIT.REFUSED);
  assert.equal(refusal([...GO, '--out', OUT, '--max-turns', '0']).code, demo.EXIT.REFUSED);
  assert.equal(refusal([...GO, '--out', OUT, '--brief', 'short']).code, demo.EXIT.REFUSED);
  const p = spawnDriver([...GO, '--out', OUT, '--frobnicate']);
  assert.equal(p.status, demo.EXIT.REFUSED); assert.match(p.stderr, /unknown argument --frobnicate/);
  assert.equal(fs.existsSync(OUT), false);
  const o = demo.parseArgs([...GO, '--out', OUT]);
  assert.equal(o.maxTurns, 2);
  assert.match(o.brief, /src\/greet\.js/); assert.match(o.brief, /test\/greet\.test\.js/); assert.match(o.brief, /Hello, <name>!/); assert.match(o.brief, /TypeError/);
  assert.match(o.brief, /\["node","--test"\]/); assert.match(o.brief, /changeset_register/); assert.match(o.brief, /at least three tests/);
});

test('CD5 a NEXUS_DB_HOLD_* variable, a temp folder inside the real user data, and a failing preflight each stop the run before it starts (the preflight is exit 3)', () => {
  const h = refusal([...GO, '--out', OUT], deps({ env: { NEXUS_DB_HOLD_V10: '1' } }));
  assert.equal(h.code, demo.EXIT.REFUSED); assert.match(h.lines[0], /NEXUS_DB_HOLD_V10 is set/); assert.doesNotMatch(h.lines.join(''), /=1/, 'names only, never values');
  const real = refusal([...GO, '--out', OUT], deps({ tmpdir: () => path.join(os.tmpdir(), 'inside-real'), userDataDirs: () => [os.tmpdir()] }));
  assert.equal(real.code, demo.EXIT.REFUSED); assert.match(real.lines[0], /inside the app's real user data/);
  const pre = refusal([...GO, '--out', OUT], deps({ preflight: badPre }));
  assert.equal(pre.code, demo.EXIT.NOT_RUN); assert.match(pre.lines.join('\n'), /NOT RUN: Docker is not running/);
  // the order: the cheap refusals first, the preflight last (a held or unscratched run never asks Docker anything)
  let asked = false;
  refusal([...GO, '--out', OUT], deps({ env: { NEXUS_DB_HOLD_V9: '1' }, preflight: () => { asked = true; return okPre(); } }));
  assert.equal(asked, false);
});

test('CD6 the STOP section: empty for the one consented host; filled for any other host, unreported decisions, a missing sign-in, a changed consent or a change outside the scratch folders', () => {
  const caps = { turnUsdCents: 200, dayUsdCents: 1000, turnsPerHour: 6, concurrentTurns: 1, turnTokens: 400000, toolCalls: 200 };
  const base = () => ({ probe: { before: { healthOk: true, reason: null, signedIn: 'yes', flagsOk: true, hosts: ['api.anthropic.com:443'] }, after: { healthOk: true, reason: null, signedIn: 'yes', flagsOk: true, hosts: ['api.anthropic.com:443'] } },
    consent: { kind: 'cli-agent', hosts: ['api.anthropic.com:443'], caps: { ...caps }, defaults: { ...caps } }, outside: [],
    turns: [{ n: 1, egress: { decisions: [{ decision: 'allowed', host: 'api.anthropic.com', port: 443, reason: 'allowed' }, { decision: 'allowed', host: 'api.anthropic.com', port: 443, reason: 'allowed' }], truncated: 0 } }] });
  assert.deepEqual(demo.stopFindings(base()), []);
  const other = base(); other.turns[0].egress.decisions.push({ decision: 'refused', host: 'statsig.anthropic.com', port: 443, reason: 'host_not_allowed' });
  assert.match(demo.stopFindings(other).join('\n'), /host other than api\.anthropic\.com:443 was requested: statsig\.anthropic\.com:443 \(allowed 0, refused 1; host_not_allowed\)/);
  const port = base(); port.turns[0].egress.decisions.push({ decision: 'refused', host: 'api.anthropic.com', port: 80, reason: 'port_not_allowed' });
  assert.match(demo.stopFindings(port).join('\n'), /api\.anthropic\.com:80/, 'the same name on another port is another destination');
  const redacted = base(); redacted.turns[0].egress.decisions.push({ decision: 'refused', host: 'invalid', port: 443, reason: 'ip_literal' });
  assert.equal(demo.stopFindings(redacted).length, 1, 'an address (reported as "invalid") is a host other than the consented one');
  const cut = base(); cut.turns[0].egress.truncated = 3;
  assert.match(demo.stopFindings(cut).join('\n'), /3 proxy decision\(s\) were not reported/);
  const signed = base(); signed.probe.before = { healthOk: false, reason: 'not_authenticated', detail: 'the agent CLI is not signed in', signedIn: 'no', flagsOk: true, hosts: [] };
  assert.match(demo.stopFindings(signed).join('\n'), /the CLI is not signed in \(the probe before the permission says not authenticated\)/);
  const broken = base(); broken.probe.after = { healthOk: false, reason: 'version_unsupported', detail: 'version 9.9.9 is not a supported version', signedIn: 'unknown', flagsOk: false, hosts: [] };
  assert.match(demo.stopFindings(broken).join('\n'), /not usable here/);
  const auth = base(); auth.turns[0].authFailure = true;
  assert.match(demo.stopFindings(auth).join('\n'), /refused the CLI's login/);
  const consent = base(); consent.consent.hosts = ['api.anthropic.com:443', 'example.org:443']; consent.consent.caps.dayUsdCents = 500;
  assert.equal(demo.stopFindings(consent).length, 2, 'a wrong host list and a changed cap are both named');
  const outside = base(); outside.outside.push({ when: 'after turn 1', what: 'the scratch user repository changed before any approval (files)' });
  assert.match(demo.stopFindings(outside).join('\n'), /outside the worktree and the scratch folders \(after turn 1\)/);
  assert.deepEqual(demo.egressSummary(other), { 'api.anthropic.com:443': { allowed: 2, refused: 0, reasons: ['allowed'] }, 'statsig.anthropic.com:443': { allowed: 0, refused: 1, reasons: ['host_not_allowed'] } });
});

test('CD7 the transcript scrubs secrets and the profile folder, renders the STOP section and the network table, and reads node:test totals', () => {
  const s = demo.scrub('key sk-ant-api03-abcdefghijklmnop and Authorization: Bearer abcdef0123456789 at C:\\Users\\jane\\x ANTHROPIC_API_KEY=zzz123 /home/jane/y');
  assert.doesNotMatch(s, /abcdefghijklmnop|abcdef0123456789|jane|zzz123/);
  assert.deepEqual(demo.testCounts('ok 1 - a\n# tests 4\n# suites 0\n# pass 3\n# fail 1\n'), { tests: 4, pass: 3, fail: 1 });
  const facts = demo.probeFacts({ kind: 'cli-agent', health: { ok: false, reason: 'not_authenticated', detail: 'the agent CLI is not signed in' }, setup: { signedIn: 'no', flagsOk: true, label: 'x', egressHosts: [{ host: 'api.anthropic.com', port: 443 }] } });
  assert.deepEqual([facts.healthOk, facts.signedIn, facts.hosts], [false, 'no', ['api.anthropic.com:443']]);
  const T = { result: 'stopped', fixture: 'node-test-app', startedAt: 'x', wallMs: 5000, maxTurns: 2, brief: 'b', merge: null, problems: [], outside: [], probe: { before: facts, after: null }, consent: null,
    egress: { 'x.example:443': { allowed: 0, refused: 1, reasons: ['host_not_allowed'] } }, stop: ['a host other than api.anthropic.com:443 was requested: x.example:443'],
    totals: { turns: 1, toolCalls: 2, proxyDecisions: 1, inTokens: 10, outTokens: 5, costUsdCents: 7 },
    turns: [{ n: 1, state: 'completed', outcome: 'completed', tools: ['Write', 'sandbox_exec'], ms: 1000, error: null, egress: { decisions: [{ decision: 'refused', host: 'x.example', port: 443, reason: 'host_not_allowed' }], truncated: 0 },
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, toolCalls: 2, costUsdCents: 7, estimated: false },
      sandboxRuns: [{ argv: 'node --test', exit: 1, tests: 3, pass: 2, fail: 1 }], changeSet: { versionId: 'v1', status: 'failed', testsSummary: '1 failed' } }] };
  const md = demo.markdown(T);
  assert.match(md, /\(STOP\)/); assert.match(md, /## STOP\n\n- a host other than/); assert.match(md, /NOT the consented host/); assert.match(md, /refused x\.example:443 \(host_not_allowed\)/);
  assert.match(md, /cost \$0\.07/); assert.match(md, /exit 1; tests 3, pass 2, fail 1/);
});

test('CD8 the driver never reads or copies the CLI\'s home folder: its source names no credential or config location of the CLI and reads no environment value but variable NAMES', () => {
  const src = fs.readFileSync(DRIVER, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const [re, what] of [[/\.claude/i, 'the CLI\'s dot folder'], [/\.credentials/i, 'a credentials file'], [/credential/i, 'any credential'], [/CLAUDE_CONFIG_DIR/, 'the config dir variable'], [/ANTHROPIC_/, 'a provider variable'],
    [/homedir/i, 'the home folder'], [/USERPROFILE|APPDATA|LOCALAPPDATA|\bHOME\b/, 'a profile location'], [/keychain|keyring/i, 'a key store'], [/auth\s+status|setup-token/i, 'the CLI\'s own login commands'], [/\bclaude\b/i, 'the CLI by name']]) {
    assert.doesNotMatch(code, re, `the driver's code must not name ${what}`);
  }
  // every process.env use is a name list or the child's pass-through; never a value read, printed or stored
  for (const line of code.split('\n').filter((l) => /process\.env/.test(l))) {
    assert.match(line, /\.\.\.process\.env|deps\.env \|\| process\.env|process\.env\.ELECTRON_RUN_AS_NODE/, `an environment use is a pass-through or a name list: ${line.trim()}`);
  }
  // the only file reads and copies are of the scratch product (copyTree), the scratch out folder and the transcript
  const reads = code.split('\n').filter((l) => /readFileSync|readFile\(|copyFileSync|cpSync|readdirSync|statSync/.test(l));
  for (const l of reads) assert.match(l, /fs\.readdirSync\(out\)|fs\.statSync\(out\)|copyFileSync\(a, b\)|readdirSync\(from|copyTree/, `a file read is only of the scratch out folder or the product: ${l.trim()}`);
  // the world helper's real-CLI branch reads nothing of the CLI's home either
  const world = fs.readFileSync(path.join(__dirname, 'helpers', 'agentFlowWorld.cjs'), 'utf8');
  const start = world.indexOf('w.probeCli = async');
  assert.ok(start > 0);
  assert.doesNotMatch(world.slice(start, start + 4000), /\.claude|credential|homedir/i);
});
