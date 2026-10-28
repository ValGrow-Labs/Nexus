'use strict';
// The local-model flows' shared pieces (test/nexus-platform-b2b-flows-localmodel.test.cjs, the gated test/nexus-exec-agent-localmodel.test.cjs):
// a world whose agent is the REAL local-model adapter talking to a mock model server on loopback (test/helpers/mockOllama.cjs), and the
// builders of the mock's scripted replies. What the model "decides" is the script; what is real is everything the platform does with it:
// the adapter's tool loop and host file tools, the runner's MCP server, sandbox_exec (fake or real Docker), changeset_register, the
// validators, review, accept and merge.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const mock = require('./mockOllama.cjs');
const { flowWorld, useFixture } = require('./agentFlowWorld.cjs');

const MODEL = 'qwen2.5-coder:7b';

/** One model reply that calls tools: `calls`: [[name, args], ...]; `x`: in/out token counts and the reply's own text. */
const calls = (list, x = {}) => ({ calls: list.map(([name, args]) => ({ name, args })), ...x });
/** One model reply that only talks. */
const say = (text, x = {}) => ({ text, ...x });
const writeFile = (path, content) => ['write_file', { path, content }];
const exec = (argv, timeoutMs = 120_000) => ['sandbox_exec', { argv, cwd: '/workspace', timeoutMs }];
const register = (title, summary, clientKey, extra = {}) => ['changeset_register', { title, summary, clientKey, ...extra }];

/** A reply sequence for a turn that writes files, runs the tests, registers the change and stops: 4 model calls. */
function buildTurn(files, o = {}) {
  const t = o.tokens ?? { in: 120, out: 60 };
  return [
    calls(Object.entries(files).map(([p, c]) => writeFile(p, c)), { in: t.in, out: t.out }),
    calls([exec(o.argv ?? ['node', '--test'])], { in: t.in, out: t.out }),
    calls([register(o.title, o.summary ?? 'Done.', o.clientKey ?? 'cs1', o.reviseArtifactId ? { reviseArtifactId: o.reviseArtifactId } : {})], { in: t.in, out: t.out }),
    say(o.final ?? 'The change is registered.', { in: t.in, out: t.out })
  ];
}

/**
 * A world whose agent is the real local-model adapter over a mock model server. `o.script`: the mock's first script; `o.models`; `o.real`:
 * the real Docker driver; `o.noConsent`; `o.caps`: the consent's caps. Returns the world, with `w.ollama` (the mock) and `w.lm` helpers.
 */
async function lmWorld(o = {}) {
  const ollama = await mock.start({ script: o.script ?? [], models: o.models });
  let w;
  try {
    w = await flowWorld({ runtime: 'local-model', modelUrl: ollama.url, model: o.model ?? MODEL, real: o.real === true });
    await useFixture(w, o.fixture ?? 'node-test-app');
    await w.snapshot();
    if (!o.noConsent) await w.consent(o.caps);
  } catch (e) { await ollama.stop(); throw e; }
  w.ollama = ollama;
  const close = w.close;
  w.close = async () => { try { await close(); } finally { await ollama.stop(); } };
  /** The next turn's replies (the mock's call counter restarts). */
  w.model = (script) => { ollama.setScript(script); return w; };
  /** The tool results the model was given, in order (the `tool` messages of every chat request so far, last request's history). */
  w.toolMessages = () => { const cs = ollama.chats(); return cs.length === 0 ? [] : cs[cs.length - 1].messages.filter((m) => m.role === 'tool').map((m) => String(m.content)); };
  return w;
}

// ---- the scans the flows share
const chatRequests = (w) => w.ollama.requests.filter((r) => r.chat);

/** Every row of every table, every log the runner and main kept, and every attempt log and context file: one text. */
function everything(w) {
  const out = [];
  for (const t of w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) for (const r of w.db.prepare(`SELECT * FROM "${t.name}"`).all()) out.push(JSON.stringify(r));
  out.push(...w.logs, ...w.runnerLogs);
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.log$|\.md$|\.json$/.test(e.name)) out.push(fs.readFileSync(p, 'utf8')); } };
  for (const d of ['logs', 'jobs']) { try { walk(path.join(w.dataHome.root, d)); } catch { /* none */ } }
  return out.join('\n');
}
/** No bearer the adapter used anywhere the platform or the model server could see it. */
function assertNoBearer(w, name) {
  assert.ok(w.bearers.length > 0, `${name}: the adapter used a bearer`);
  const modelSide = w.ollama.requests.map((r) => `${JSON.stringify(r.headers)}\n${r.url}\n${r.body}`).join('\n');
  const all = everything(w);
  for (const tok of new Set(w.bearers)) {
    assert.ok(!modelSide.includes(tok), `${name}: a bearer is in a request the model server received`);
    assert.ok(!all.includes(tok), `${name}: a bearer is in a row, a log or a file`);
  }
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0, `${name}: every turn's token is revoked at its end`);
  for (const r of w.ollama.requests) assert.equal(r.headers.authorization, undefined, `${name}: no authorization header went to the model server`);
}
const agentContainers = (w) => w.driver.all().filter((r) => r.kind === 'container' && r.labels['nexus.kind'] === 'agent').length;

module.exports = { chatRequests, everything, assertNoBearer, agentContainers, lmWorld, buildTurn, calls, say, writeFile, exec, register, MODEL, mock };
