'use strict';
// B2a Task 13: the nexus:* handlers over a test platform, as main registers them (a fake registrar stands in for
// ipcMain). `ipcOver(w)` registers every channel with main's execution deps: `executionUnavailableReason` (main's
// store reason; null by default) and `exec` (the execution wiring's IPC port over the world's data home). Nothing here
// changes authorization: a restricted principal is the LOCAL USER of the test (`asLocalUser`), resolved by the wrapper
// exactly as main resolves it, and every service check runs as written.
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { registerNexusIpc } = loadTs('src/main/nexusIpc/registerNexusIpc.ts');
const { execIpcPort } = loadTs('src/main/nexusExec/execWiring.ts');

/** Ports that record every call (no B2a channel may use them). */
function spyPorts(calls = []) {
  const no = (name) => async () => { calls.push(name); return null; };
  return { calls, projectRoot: no('projectRoot'), readFile: no('readFile'), resolveCommit: no('resolveCommit') };
}

function ipcOver(w, o = {}) {
  const handlers = new Map(); const logs = [];
  const sources = spyPorts();
  registerNexusIpc({ handle: (ch, fn) => { assert.ok(!handlers.has(ch), `duplicate ${ch}`); handlers.set(ch, fn); } }, {
    platform: o.platform ?? (() => w.nx), unavailableReason: () => 'held', handoffsUnavailableReason: () => null,
    sources, log: (l) => logs.push(l),
    executionUnavailableReason: o.executionUnavailableReason ?? (() => null),
    exec: o.exec ?? (() => (w.nx && w.dataHome ? execIpcPort(w.nx, w.dataHome) : null)),
    // B2b Task 14: the agent deps, only when a test passes them (the B2a callers register the 41 channels as before).
    ...(o.agentsUnavailableReason ? { agentsUnavailableReason: o.agentsUnavailableReason } : {}),
    ...(o.confirmMerge ? { confirmMerge: o.confirmMerge } : {})
  });
  const call = (ch, ...a) => { const f = handlers.get(ch); assert.ok(f, `no handler ${ch}`); return f({ sender: {} }, ...a); };
  const ok = async (ch, ...a) => { const r = await call(ch, ...a); assert.equal(r.ok, true, `${ch}: ${JSON.stringify(r)}`); return r.data; };
  const refused = async (ch, args, code, extra = {}) => {
    const r = await call(ch, ...args);
    assert.equal(r.ok, false, `${ch} should refuse: ${JSON.stringify(r)}`);
    assert.equal(r.code, code, `${ch}: ${JSON.stringify(r)}`);
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(r[k], v, `${ch}.${k}: ${JSON.stringify(r)}`);
    noLeak(r, ch);
    return r;
  };
  return { handlers, logs, sources, call, ok, refused };
}

/** The test's local user becomes `p` (a restricted principal): the wrapper resolves it as main resolves the local user. */
function asLocalUser(nx, p) {
  const orig = nx.principals.localUser.bind(nx.principals);
  nx.principals.localUser = () => p;
  return () => { nx.principals.localUser = orig; };
}

/** Nothing a renderer receives names a host path, a principal id, a stack or SQLite text. */
const LEAK = /[A-Za-z]:\\|\\\\|\/Users\/|\/home\/(?!nexus)|\/tmp\/|AppData|user:local|\bat [A-Za-z.]+ \(|\.ts:\d+|SQLITE_|nx-home-|nx-xhome-/;
function noLeak(x, what = 'answer') {
  assert.doesNotMatch(JSON.stringify(x), LEAK, `${what}: ${JSON.stringify(x).slice(0, 400)}`);
}

/** A fresh intent id (a ULID, as the renderer mints one). */
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const intent = () => newId(Date.now());

module.exports = { ipcOver, asLocalUser, noLeak, intent, spyPorts, LEAK };
