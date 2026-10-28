'use strict';
// The showcase driver's guards (tools/nexus-demo-local-model.cjs): it never starts without --go, never for a non-loopback model address,
// never when the resource preflight is not ok. Pure: it never starts Docker, a model server or a world (the refusals come first).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const demo = require('../tools/nexus-demo-local-model.cjs');

const OUT = path.join(os.tmpdir(), `nx-demo-guard-${process.pid}-never-created`);
const okPre = () => ({ ok: true, checks: [] });
const badPre = () => ({ ok: false, checks: [{ ok: false, notRun: 'Docker is not running.', action: 'Start it.' }] });
const refusal = (argv, pre = okPre) => demo.refusal(demo.parseArgs(argv), pre);

test('DM1 without --go nothing starts (exit 2), with or without any other argument; the preflight is not even asked', () => {
  let asked = false;
  const r = demo.refusal(demo.parseArgs(['--out', OUT]), () => { asked = true; return okPre(); });
  assert.equal(r.code, demo.EXIT.REFUSED); assert.equal(asked, false);
  assert.equal(refusal([]).code, demo.EXIT.REFUSED);
  // run as a process: the refusal is the whole run (no electron is started, nothing is created)
  const p = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'nexus-demo-local-model.cjs'), '--out', OUT], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(p.status, demo.EXIT.REFUSED); assert.match(p.stderr, /--go was not given/);
  assert.equal(require('node:fs').existsSync(OUT), false);
});
test('DM2 the model address must be loopback: a LAN address, a name, https, credentials and an unparsable value are refused; loopback spellings pass', () => {
  for (const url of ['http://192.168.1.20:11434', 'http://evil.example.com:11434', 'https://127.0.0.1:11434', 'http://u:p@127.0.0.1:11434', 'not a url', 'http://10.0.0.1', 'http://[::ffff:127.0.0.1]:11434']) {
    const r = refusal(['--go', '--out', OUT, '--url', url]);
    assert.equal(r && r.code, demo.EXIT.REFUSED, url);
  }
  for (const url of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434']) assert.equal(refusal(['--go', '--out', OUT, '--url', url]), null, url);
  assert.equal(demo.loopbackUrl('http://localhost:12345'), 'http://127.0.0.1:12345');
});
test('DM3 the preflight must pass (exit 3, NOT RUN lines); --out, --model, --max-turns and unknown arguments are checked; defaults are the documented ones', () => {
  const r = refusal(['--go', '--out', OUT], badPre);
  assert.equal(r.code, demo.EXIT.NOT_RUN); assert.match(r.lines.join('\n'), /NOT RUN: Docker is not running/);
  assert.equal(refusal(['--go']).code, demo.EXIT.REFUSED, '--out is required');
  assert.equal(refusal(['--go', '--out', OUT, '--model', 'a b']).code, demo.EXIT.REFUSED);
  assert.equal(refusal(['--go', '--out', OUT, '--max-turns', '9']).code, demo.EXIT.REFUSED);
  assert.equal(refusal(['--go', '--out', OUT, '--frobnicate']).code, demo.EXIT.REFUSED);
  assert.equal(refusal(['--go', '--out', os.tmpdir()]).code, demo.EXIT.REFUSED, 'an existing non-empty folder is never written into');
  const o = demo.parseArgs(['--go', '--out', OUT]);
  assert.deepEqual([o.model, o.url, o.maxTurns], ['qwen2.5-coder:7b', 'http://127.0.0.1:11434', 3]);
  assert.match(o.brief, /todo-list library/);
  assert.equal(refusal(['--go', '--out', OUT]), null);
});
test('DM4 the transcript reads node:test totals and renders honestly (a failed run says so)', () => {
  assert.deepEqual(demo.testCounts('ok 1 - a\n# tests 7\n# suites 0\n# pass 5\n# fail 2\n'), { tests: 7, pass: 5, fail: 2 });
  assert.deepEqual(demo.testCounts('no totals'), { tests: null, pass: null, fail: null });
  const md = demo.markdown({ result: 'no_candidate', model: 'm', endpoint: 'http://127.0.0.1:1', startedAt: 'x', wallMs: 5000, maxTurns: 3, brief: 'b', merge: null, problems: ['no change set reached candidate in 1 turns'],
    totals: { turns: 1, toolCalls: 2, inTokens: 10, outTokens: 5 }, turns: [{ n: 1, state: 'completed', outcome: 'completed', tools: ['write_file'], ms: 1000, tokens: { in: 10, out: 5 }, error: null,
      sandboxRuns: [{ argv: 'node --test', exit: 1, tests: 3, pass: 2, fail: 1 }], changeSet: { versionId: 'v1', status: 'failed', testsSummary: '1 failed' } }] });
  assert.match(md, /no_candidate/); assert.match(md, /exit 1; tests 3, pass 2, fail 1/); assert.match(md, /\*\*failed\*\*/); assert.match(md, /Problems/);
});
