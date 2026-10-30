'use strict';
// B2b Task 16: the end-to-end agent world. Everything is the real thing except the model and Docker:
// - main: a v10 database (agents on), the platform composed as the app composes it (real ingest, validation, approvals,
//   RepoService, the agent services, the MCP gateway, the budget and consent, the runtime health cache), a temp data home,
//   the 51 nexus:* handlers (test/helpers/ipcExec.cjs ipcOver), the user's merge dialog faked at its `show` seam only;
// - the runner: a real RunnerCore in this process (real git engines for the worktree, collect, accept and the fast-forward,
//   the real loopback MCP server, the real host egress proxy, the real worktree guard, the real MCP relay and exec relay),
//   over an in-process bridge that clones every message as a MessagePort does;
// - the model: ScriptedRuntime (src/runner/runtimes/scripted.ts), which calls the REAL MCP server over HTTP with the turn's
//   own bearer. `scriptFor(plan)` is where a test plays "the agent": it may edit the turn's worktree (the engine's file tools
//   do that on the host) and returns the MCP calls the agent makes;
// - Docker: the fake sandbox driver. A tool container plays RECORDED-format outputs derived from the staged source tree it
//   was given (the git archive of the commit under test): node:test and pytest reports built from the test titles in the
//   staged files, where a title ending ` [fails]` (node) or a function ending `_fails` (python) is played as failing.
//   Nothing the agent wrote is ever run on the host. So `cs.tests_pass` passing or failing in these flows is a FAKE-DRIVER convention
//   (playTool / playExec build the JUnit by regex over test titles in the staged tree; `[fails]` is not a product behaviour): what they
//   prove is that the platform runs the check on the change set's own head commit and judges by the report. A real node:test or pytest
//   run is XA6 of the gated suite only, and that has not been run.
// - the LOCAL-MODEL variant (`flowWorld({ runtime: 'local-model', modelUrl, model })`): the model is the REAL local-model adapter
//   (src/runner/runtimes/localModel/, built by runtimeFor as in production: no scriptFor), talking to `modelUrl`, a loopback model
//   server (test/helpers/mockOllama.cjs in the tests, the real server only in the showcase). The runner's probe reports that adapter
//   with its destination `127.0.0.1:<port of modelUrl>`; the consent is granted through #51 for that kind with `model`, so the plan
//   carries the model and the loopback endpoint, and the adapter's own destination rule applies unchanged (no test seam in the runner).
//   Everything else (main, the real runner core, the MCP server, the fake or real Docker) is as above. `w.bearers` collects every
//   bearer the adapter sent to the MCP server (an observer on its fetch), for the no-leak scans.
// - the HOSTED-MODEL variant (`flowWorld({ runtime: 'hosted-model', provider, model, modelUrl })`): the model is the REAL hosted-model adapter
//   (src/runner/runtimes/hostedModel/, built by runtimeFor as in production: no scriptFor) with the runner's TEST SEAM (`hostedTestSeam`,
//   RunnerDeps.agentRuntime): the allowed target is connected as plain HTTP to `modelUrl`, a loopback mock of the chat-completions API
//   (test/helpers/mockOpenAiServer.cjs; no real provider, no real key, no network beyond loopback). The Host header and the path are still the
//   chosen provider's. The runner's probe is the production hosted adapter (offline preset data); the consent is granted through #51 with the
//   provider and model; the key is stored through the REAL key store (createHostedKeys, src/main/nexus/agents/hostedModelSettings.ts) over a
//   FAKE safeStorage (`w.keyStore`: its "disk" holds only scrambled text) and resolved by main at the lease into the plan's in-memory field.
//   `w.keys` is that store's API (set, delete, present, list), `w.setKey(key, provider?)` stores one once the probe has listed the providers.
//   `o.hostedSeam` replaces the seam (`null`: none, the production path through the host egress proxy) and `o.startProxy` replaces the proxy
//   starter (a test's fake CONNECT proxy). `w.bearers` is as in the local-model variant. With `real: true`, no `modelUrl` and `hostedSeam: null`
//   `o.alsoLocal: { modelUrl, model }` adds the production local-model adapter to the probe (and main's local-server setting) so a test can switch between the two
//   runtimes (revoke, then grant); `w.consentLocal()` grants that one. With `real: true`, no `modelUrl` and `hostedSeam: null`
//   there is no seam at all: the REAL provider through the REAL host egress proxy (the controller-only showcase, tools/nexus-demo-hosted-model.cjs).
// - the REAL-CLI variant (`flowWorld({ runtime: 'cli-agent', real: true })`, controller-only: tools/nexus-demo-cli-agent.cjs; never part of
//   a test run, since it needs the user's installed vendor CLI and login): the runner's probe adapters are the production ones
//   (registry.probeAdapters(): the probe reports the real CLI's health and its host list), the consent is granted through #51 for kind
//   `cli-agent` with the adapter's own hosts and the default caps (never raised), there is NO scriptFor and no fake runtime, the runner
//   starts the REAL host egress proxy bound to the consent (default startProxy), and the REAL cli-agent adapter resolves the user's
//   installed native CLI itself (production path: no agentBin / agentEnv seam). Docker is real (it requires `real: true`). The world
//   exposes what a controller records: `w.egressDecisions(jobId)` (+ `w.egressTruncated`), `w.usageOf(jobId)`, `w.toolCallsOf(jobId)`,
//   all read from the records main keeps (job_events / job_attempts). The probe's own proxy runs report nothing (its onDecision is a no-op).
// Time is a fake clock (main's `now` and the runner's timers); `until` advances it a second at a time and runs the
// scheduler's tick, while real I/O (git, files) is awaited between steps (the runner's own real I/O is counted).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const h = require('./sqlite.cjs');
const loadTs = require('../load-ts.cjs');
const { track } = require('./cleanup.cjs');
const { FakeSandboxDriver } = require('./fakeSandboxDriver.cjs');
const EFW = require('./execFakeWorld.cjs');
const { ipcOver, intent } = require('./ipcExec.cjs');
const { allOrphans, ALL_ZERO } = require('./orphans.cjs');

const { FakeClock, bridge, trackRealIo, fixtureRepo, addCommon, WORLDS, ROOT, LOCK } = EFW;
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { applyV10, v10ShapeProblem } = loadTs('src/main/nexus/db/schemaV10.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { resolveDataHome } = loadTs('src/main/nexusExec/dataHome.ts');
const { loadImageProfiles } = loadTs('src/main/nexusExec/profiles.ts');
const { RunnerCore } = loadTs('src/runner/core.ts');
const { createLocalModelAdapter } = loadTs('src/runner/runtimes/localModel/adapter.ts');
const { createHostedModelAdapter } = loadTs('src/runner/runtimes/hostedModel/adapter.ts');
const { createHostedKeys } = loadTs('src/main/nexus/agents/hostedModelSettings.ts');
const { repositoryCheck, resolveCommit } = loadTs('src/main/git.ts');
const { confirmMergeWith } = loadTs('src/main/nexusExec/mergeDialog.ts');
const { STEP_SEPARATOR } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { startHostEgressProxy } = loadTs('src/runner/hostEgressProxy.ts');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');
const { getDomain } = loadTs('src/shared/nexus/domains/index.ts');
const { stepStateFrom } = loadTs('src/shared/nexus/stepState.ts');

const GIB = 2 ** 30;
const API_HOST = { host: 'api.anthropic.com', port: 443 };
const RUNTIME_KIND = 'scripted';
const TERMINAL = ['completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted'];

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'user@example.invalid',
    GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'user@example.invalid', GIT_OPTIONAL_LOCKS: '0' } }).trim();

/** The scripted runtime as the runner's probe sees an engine: healthy, signed in, one destination. */
const scriptedAdapter = {
  kind: RUNTIME_KIND,
  async describe() { return { egressHosts: [API_HOST] }; },
  async health() { return { ok: true, version: '1.0.0' }; },
  async setup() { return { signedIn: 'yes', flagsOk: true, label: 'Scripted test runtime', egressHosts: [API_HOST] }; },
  async check() { return { health: { ok: true, version: '1.0.0' }, setup: { signedIn: 'yes', flagsOk: true, label: 'Scripted test runtime', egressHosts: [API_HOST] } }; }
};

// ---------------------------------------------------------------- the staged tree, as the recorded containers read it

/** The files of an uncompressed tar (what `git archive` wrote to `in/src.tar`), by path. */
function tarFiles(buf) {
  const files = new Map(); let off = 0; let paxPath = null;
  const cstr = (b) => b.toString('utf8').replace(/\0[\s\S]*$/, '');
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const name = cstr(hdr.subarray(0, 100));
    const size = parseInt(cstr(hdr.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(hdr[156]);
    const prefix = cstr(hdr.subarray(345, 500));
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8')); paxPath = m ? m[1] : null; continue; }
    if (type === 'g') continue;
    const full = paxPath ?? (prefix ? `${prefix}/${name}` : name); paxPath = null;
    if (type === '0' || type === '\0') files.set(full, Buffer.from(body));
  }
  return files;
}
/** Every file below `dir` (relative paths with `/`), skipping `.git`, `node_modules` and links. */
function dirFiles(dir) {
  const out = new Map();
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules' || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else if (e.isFile()) out.set(r, fs.readFileSync(path.join(dir, r)));
    }
  };
  walk('');
  return out;
}
const globRe = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?')}$`);
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** The test cases a staged node:test file declares: `test('title', ...)` / `it(...)`; a title ending ` [fails]` fails. */
function nodeCases(text) {
  return [...text.matchAll(/\b(?:test|it)\(\s*(['"`])((?:(?!\1).)+)\1/g)].map((m) => ({ name: m[2], fails: / \[fails\]$/.test(m[2]) }));
}
/** The test functions of a staged pytest file: `def test_x(`; a name ending `_fails` fails. */
function pyCases(text) {
  return [...text.matchAll(/^def (test_\w+)\(/gm)].map((m) => ({ name: m[1], fails: /_fails$/.test(m[1]) }));
}
function nodeJunit(cases) {
  const failed = cases.filter((c) => c.fails).length;
  const body = cases.map((c) => (c.fails
    ? `\t<testcase name="${xml(c.name)}" time="0.002000" classname="test" failure="Expected values to be strictly equal:2 !== 3">\n\t\t<failure type="testCodeFailure" message="Expected values to be strictly equal:2 !== 3">\nAssertionError [ERR_ASSERTION]: 2 !== 3\n\t\t</failure>\n\t</testcase>`
    : `\t<testcase name="${xml(c.name)}" time="0.001000" classname="test"/>`)).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body}\n\t<!-- tests ${cases.length} -->\n\t<!-- suites 0 -->\n\t<!-- pass ${cases.length - failed} -->\n\t<!-- fail ${failed} -->\n\t<!-- cancelled 0 -->\n\t<!-- skipped 0 -->\n\t<!-- todo 0 -->\n\t<!-- duration_ms 41.5 -->\n</testsuites>\n`;
}
function pyJunit(cases) {
  const failed = cases.filter((c) => c.fails).length;
  const body = cases.map((c) => (c.fails
    ? `<testcase classname="${xml(c.file.replace(/\.py$/, '').replace(/\//g, '.'))}" name="${xml(c.name)}" time="0.001"><failure message="assert 2 == 3">assert 2 == 3</failure></testcase>`
    : `<testcase classname="${xml(c.file.replace(/\.py$/, '').replace(/\//g, '.'))}" name="${xml(c.name)}" time="0.001" />`)).join('');
  return `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="${failed}" skipped="0" tests="${cases.length}" time="0.034" timestamp="2026-10-10T10:00:00.000000+00:00" hostname="nexus-sandbox">${body}</testsuite></testsuites>`;
}

const steps = (argv) => {
  const out = [[]];
  for (const a of argv) { if (a === STEP_SEPARATOR) out.push([]); else out[out.length - 1].push(a); }
  return out;
};
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

/**
 * A tool container's program as the pinned images run it, played from the staged source tree. Returns its exit code, or
 * null for a container that keeps running (an agent turn's sleeping container, a proxy).
 */
function playTool(w, c, driver) {
  const spec = c.spec;
  const kind = spec.labels['nexus.kind'];
  if (kind === 'service') { driver.emit(c.id, 'stdout', `${w.current.name} listening on ${spec.service?.containerPort}\n`); return null; }
  if (kind !== 'tool') return null;
  const out = spec.mounts.find((m) => m.kind === 'out').hostPath;
  const inDir = spec.mounts.find((m) => m.kind === 'input').hostPath;
  const toOut = (p) => path.join(out, ...p.replace(/^\/out\/?/, '').split('/').filter(Boolean));
  const tar = path.join(inDir, 'src.tar');
  const files = fs.existsSync(tar) ? tarFiles(fs.readFileSync(tar)) : new Map();
  w.played.push({ container: c.id, argv: [...spec.argv], files: [...files.keys()].sort() });
  let code = 0;
  for (const st of steps(spec.argv)) {
    if (code !== 0) break;
    const [cmd] = st;
    if (cmd === 'nexus-glob') {
      const res = st.slice(3).map(globRe);
      const hit = [...files.keys()].filter((f) => !/(^|\/)(node_modules|\.git)\//.test(f) && res.some((re) => re.test(f))).sort();
      write(toOut(st[2]), hit.map((f) => `${f}\n`).join(''));
    } else if (cmd === 'nexus-node-test') {
      const list = st.slice(st.indexOf('--') + 1);
      list.forEach((f, i) => {
        const cases = nodeCases((files.get(f) ?? Buffer.alloc(0)).toString('utf8'));
        write(path.join(toOut(st[2]), `${String(i + 1).padStart(4, '0')}.xml`), nodeJunit(cases));
        driver.emit(c.id, 'stdout', `ran ${f}\n`);
        if (cases.some((x) => x.fails) && code === 0) code = 1;
      });
    } else if (cmd === 'nexus-capture' && st.includes('--collect-only')) {
      const lines = [];
      for (const [f, buf] of [...files.entries()].sort()) {
        if (/^tests?\/.*\.py$/.test(f) || /(^|\/)test_[^/]*\.py$/.test(f)) for (const k of pyCases(buf.toString('utf8'))) lines.push(`${f}::${k.name}`);
      }
      write(toOut(st[2]), `${lines.join('\n')}\n\n${lines.length} tests collected in 0.01s\n`);
    } else if (cmd === 'python' && st.includes('pytest')) {
      const dest = st.find((a) => a.startsWith('--junitxml=')).slice('--junitxml='.length);
      const cases = [];
      for (const [f, buf] of [...files.entries()].sort()) {
        if (/^tests?\/.*\.py$/.test(f) || /(^|\/)test_[^/]*\.py$/.test(f)) for (const k of pyCases(buf.toString('utf8'))) cases.push({ ...k, file: f });
      }
      write(toOut(dest), pyJunit(cases));
      if (cases.some((x) => x.fails)) code = 1;
    } else if (cmd === 'npm' && st[1] === 'run' && st[2] === 'build') {
      driver.emit(c.id, 'stdout', 'built dist/index.html and dist/app.js\n');
    } else if (cmd === 'nexus-collect') {
      const handler = require(path.join(w.current.dir, 'src', 'handler.js'));
      write(path.join(toOut(st[4]), 'index.html'), `${handler.route('/').body}\n`);
      write(path.join(toOut(st[4]), 'app.js'), "'use strict';\nconsole.log('node-test-app build');\n");
    } else if (cmd === 'python' && st[2] === 'build') {
      const dest = st[st.indexOf('--outdir') + 1];
      write(path.join(toOut(dest), 'pytest_app-0.1.0-py3-none-any.whl'), Buffer.from('PK\u0003\u0004 pytest_app 0.1.0 (a recorded stand-in for the wheel)'));
    } else {
      driver.emit(c.id, 'stderr', `${cmd}: not found\n`);
      code = 127;
    }
  }
  return code;
}

/**
 * The agent's own `sandbox_exec` inside its sleeping container, played from the worktree the container binds: a test command
 * reports the worktree's tests (a title ending ` [fails]` fails); `hold` waits for the test; anything else is not found.
 */
async function playExec(w, driver, id, argv) {
  const c = driver.containers.get(id);
  const ok = (stdout, code = 0) => ({ exit: { code, oomKilled: false, finishedAt: w.clock.now }, stdout, stderr: '', truncated: false });
  if (!c) return { exit: { code: 127, oomKilled: false, finishedAt: 0 }, stdout: '', stderr: 'no such container', truncated: false };
  const wt = c.spec.mounts.find((m) => m.kind === 'worktree');
  const files = wt ? dirFiles(wt.hostPath) : new Map();
  w.execs.push({ container: id, argv: [...argv] });
  if (argv[0] === 'hold') { await w.holdGate; return ok('released\n'); }
  if (argv[0] === 'plant-link') {
    // The agent's command plants a symbolic link in the bind-mounted worktree (the file tools could not).
    const target = argv[2];
    try { fs.symlinkSync(target, path.join(wt.hostPath, argv[1]), process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { return ok(`could not link: ${e.code}\n`, 1); }
    return ok('linked\n');
  }
  if (argv[0] === 'node' || argv[0] === 'npm' || (argv[0] === 'python' && argv.includes('pytest'))) {
    const py = argv[0] === 'python';
    const cases = [];
    for (const [f, buf] of [...files.entries()].sort()) {
      if (py ? (/^tests?\/.*\.py$/.test(f) || /(^|\/)test_[^/]*\.py$/.test(f)) : (/\.test\.(js|mjs|cjs)$/.test(f) || /^test\/.*\.(js|mjs|cjs)$/.test(f))) {
        for (const k of (py ? pyCases : nodeCases)(buf.toString('utf8'))) cases.push({ ...k, file: f });
      }
    }
    const failed = cases.filter((k) => k.fails).length;
    return ok(`${cases.map((k) => `${k.fails ? 'not ok' : 'ok'} - ${k.name}`).join('\n')}\n# tests ${cases.length}\n# fail ${failed}\n`, failed > 0 ? 1 : 0);
  }
  return { exit: { code: 127, oomKilled: false, finishedAt: 0 }, stdout: '', stderr: `${argv[0]}: not found`, truncated: false };
}

// ---------------------------------------------------------------- the world

/** A fake safeStorage-backed secret store (the hosted keys' store in the hosted-model variant): the "disk" holds only scrambled text. */
function fakeKeyStore(o = {}) {
  const st = { available: o.available ?? true, blob: {} };
  const enc = (v) => Buffer.from(v, 'utf8').map((b) => b ^ 0x5a).toString('base64');
  const dec = (v) => Buffer.from(Buffer.from(v, 'base64').map((b) => b ^ 0x5a)).toString('utf8');
  return Object.assign(st, {
    encryptionAvailable: () => st.available,
    set(ref, v) { if (!st.available) return { ok: false, error: 'unavailable' }; st.blob[ref] = enc(v); return { ok: true }; },
    get(ref) { return st.blob[ref] === undefined ? undefined : dec(st.blob[ref]); },
    has(ref) { return st.blob[ref] !== undefined; },
    delete(ref) { delete st.blob[ref]; }
  });
}

/**
 * `o.fixture`: 'node-test-app' or 'pytest-app'. `o.noConsent`: leave the consent ungranted. `o.reopen`: `{ file, userData, repo, roots }`
 * to continue an earlier world's database, data home and repository (a main restart) on a NEW platform, runner and bridge.
 * Returns the world; every step a test takes goes through `w.x` (the nexus:* handlers) unless it is a deliberate fault.
 */
async function flowWorld(o = {}) {
  // `o.real` (the gated real-Docker suite, test/nexus-exec-agent.test.cjs): the REAL Docker driver, the real clock and real timers.
  // Nothing else changes: the same main, the same runner core, ScriptedRuntime for the model. `until` then waits in real time.
  const real = o.real === true;
  // `o.runtime`: 'local-model' (see the header); `o.modelUrl`: the loopback model server; `o.model`: the model the user chooses at consent.
  const lm = o.runtime === 'local-model';
  if (lm && (typeof o.modelUrl !== 'string' || typeof o.model !== 'string')) throw new Error("flowWorld({ runtime: 'local-model' }) needs modelUrl and model");
  // `o.runtime: 'cli-agent'` (see the header): the real vendor CLI under the real runner; only with the real Docker driver.
  const ca = o.runtime === 'cli-agent';
  if (ca && real !== true) throw new Error("flowWorld({ runtime: 'cli-agent' }) needs real: true (the real CLI runs its commands in real Docker)");
  if (ca && (o.driver || o.modelUrl || o.model)) throw new Error("flowWorld({ runtime: 'cli-agent' }) takes no driver, modelUrl or model");
  // `o.runtime: 'hosted-model'` (see the header): `o.provider` / `o.model` are the user's choice at consent, `o.modelUrl` the loopback mock (none for the real provider).
  const hm = o.runtime === 'hosted-model';
  if (hm && (typeof o.provider !== 'string' || typeof o.model !== 'string')) throw new Error("flowWorld({ runtime: 'hosted-model' }) needs provider and model");
  if (hm && typeof o.modelUrl !== 'string' && o.hostedSeam === undefined) throw new Error("flowWorld({ runtime: 'hosted-model' }) needs modelUrl (or hostedSeam: null for the real provider)");
  const hostedSeam = !hm ? undefined : o.hostedSeam !== undefined ? o.hostedSeam : { plain: { host: '127.0.0.1', port: Number(new URL(o.modelUrl).port) } };
  const keyStore = hm ? (o.keyStore ?? fakeKeyStore()) : null;
  const al = hm && o.alsoLocal ? o.alsoLocal : null;
  const alPort = al ? Number(new URL(al.modelUrl).port) : 0;
  const lmPort = lm ? Number(new URL(o.modelUrl).port) : 0;
  /** The user's local-server address setting as main reads it; a test may change `lmCfg.baseUrl` (the settings a user could have). */
  const lmCfg = o.lmCfg ?? { baseUrl: lm ? `${o.modelUrl.replace(/\/+$/, '')}/v1` : al ? `${al.modelUrl.replace(/\/+$/, '')}/v1` : null };
  const clock = o.clock ?? (real ? { get now() { return Date.now(); }, advance() {} } : new FakeClock(h.NOW + 1000));
  const file = o.reopen?.file ?? h.v6Fixture().file;
  const s = track(new PersistStore(file));
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, enableV9: true, enableV10: true });
  const db = s.platformDatabase();
  if (v10ShapeProblem(db, true) !== null) db.transaction(() => applyV10(db, { now: () => h.NOW, appVersion: 't', fromVersion: 9, preCounts: null, backup: null }))();
  const userData = o.reopen?.userData ?? h.tmpDir('nx-ab-home-');
  const dataHome = resolveDataHome(userData);
  await dataHome.ensure();
  const images = loadImageProfiles(path.join(ROOT, 'infra', 'images'));
  if (images.problem) throw new Error(`lock.json: ${images.problem}`);
  const roots = o.reopen?.roots ?? new Set();
  const acceptFsRoot = (r) => (typeof r === 'string' && roots.has(path.resolve(r)) ? path.resolve(r) : null);
  const logs = [];
  // The hosted keys as main composes them (src/main/index.ts): the real key store over the fake safeStorage; the providers are the runner's probe data.
  const hostedKeys = hm ? createHostedKeys({ store: keyStore, providers: () => nx.agentProbe?.cache.fresh('hosted-model')?.setup?.providers ?? null,
    onChange: (op, provider) => nx.agents.recordKeyChange(nx.principals.localUser(), op, provider) }) : null;
  const nx = createNexusPlatform(db, { now: () => clock.now, log: (l) => logs.push(l), execution: true, agents: true, dataHome, profiles: images.profiles,
    imageContexts: images.imageContexts, acceptFsRoot, isRepository: repositoryCheck, resolveCommit, appVersion: '0.0.0-test',
    skillsResourcesDir: path.join(ROOT, 'resources'), runtimeHealthTtlMs: 365 * 24 * 3600_000, bootId: o.bootId,
    // The user's existing local-server setting (main's reader: localModelSettings.ts): the address of the model server a turn is sent to.
    ...(lm || al ? { localModelConfig: () => ({ providerBaseUrls: { opencode: lmCfg.baseUrl } }) } : {}), ...(hm ? { hostedKeys } : {}) });
  const startup = nx.startup();
  const p = { store: s, file, db, nx, logs, userData, dataHome, roots, images };
  const w = { kind: real ? 'agent-flow-real' : 'agent-flow', real, clock, runnerLogs: [], played: [], execs: [], startup, scripts: [], scriptsSeen: [], holdGate: Promise.resolve(),
    runtime: lm ? 'local-model' : hm ? 'hosted-model' : ca ? 'cli-agent' : 'scripted', model: lm || hm ? o.model : null, modelUrl: lm || hm ? o.modelUrl ?? null : null, bearers: o.bearers ?? [], lmCfg,
    ...(hm ? { provider: o.provider, keyStore, keys: hostedKeys } : {}) };
  addCommon(w, p);
  w.userData = userData; w.file = file; w.store = s;
  if (o.reopen) { w.current = o.reopen.current; w.repoDir = o.reopen.repo; }
  w.health = (q) => (w.current && w.current.healthPaths.includes(q) ? 200 : 404);

  const versionsLabel = (q) => Object.entries(LOCK.profiles[q].versions).map(([k, v]) => `${k}=${v}`).join(' ');
  const imageInfo = (q, n) => ({ present: true, digestMatches: true, imageId: `sha256:${String(n).repeat(64)}`, sizeBytes: LOCK.profiles[q].estimatedBytes,
    contextSha256: LOCK.profiles[q].contextSha256, versions: versionsLabel(q) });
  // The Docker CLI the real driver (and the runner's image builds) run through; null in the fake world.
  const cli = real ? loadTs('src/runner/sandbox/dockerCli.ts').dockerCli(fsp) : null;
  let driver = o.driver;
  if (!driver && real) driver = new (loadTs('src/runner/sandbox/dockerDriver.ts').DockerDriver)(cli, { now: Date.now });
  if (!driver) {
    driver = new FakeSandboxDriver({ images: { 'sde-node': imageInfo('sde-node', 1), 'sde-python': imageInfo('sde-python', 2), 'nexus-fwd': imageInfo('nexus-fwd', 3) },
      onStart: (c, d) => { const code = playTool(w, c, d); if (code !== null) d.exitContainer(c.id, { code, finishedAt: clock.now }); } });
    // The agent's own commands in its sleeping container are played from the worktree it binds (the fake world only).
    const origExec = driver.exec.bind(driver);
    driver.exec = async (id, argv, x) => {
      const c = driver.containers.get(id);
      if (c && c.spec.labels['nexus.kind'] === 'agent') { driver.rec('exec', id, argv, x); return playExec(w, driver, id, argv); }
      return origExec(id, argv, x);
    };
  }

  /** A new runner (core + bridge) attached to this platform. Returns what a restart needs to drop the old one. */
  const io = { n: 0 };
  function attachCore() {
    const b = bridge();
    // The test seam for the host proxy (RunnerDeps.agentRuntime.startProxy): the REAL proxy is started, and the decisions a test queued with
    // `w.injectEgress` are reported through the proxy's own `onDecision` right after, so the egress progress events have content. Nothing
    // flows through the proxy under ScriptedRuntime: real traffic is only ever seen by the gated real-Docker suite.
    const startProxy = async (opts) => {
      const proxy = await startHostEgressProxy(opts);
      for (const d of w.egressQueue.splice(0)) opts.onDecision({ t: 'egress', decision: d.decision, host: d.host, port: d.port, reason: d.reason, at: Date.now() });
      return proxy;
    };
    const fakeOnly = real ? {} : { timers: clock, freeBytes: async () => 100 * GIB, sleep: async () => {}, probeHttp: async (_port, q) => ({ status: w.health(q), ms: 3 }),
      pickPort: (() => { let n = 49200; return () => n++; })() };
    // The real-CLI world: the production probe adapters, built once per runner (they share the registry's preflight cache).
    const caAdapters = ca ? loadTs('src/runner/runtimes/registry.ts').probeAdapters() : null;
    const core = new RunnerCore(b.transport, { driver, now: () => clock.now, fs: trackRealIo(fsp, io), log: (l) => w.runnerLogs.push(l),
      docker: cli, imagesDir: path.join(ROOT, 'infra', 'images'), ...fakeOnly,
      // The local-model world: the REAL adapter is what the probe reports (its destination is the model server's own loopback address)
      // and what runtimeFor builds for the turn (consent hosts from the plan); the only observer is a fetch that notes the MCP bearer.
      runtimeProbe: { adapters: () => (ca ? caAdapters : hm ? [createHostedModelAdapter(), ...(al ? [createLocalModelAdapter({ consentedHosts: [{ host: '127.0.0.1', port: alPort }], model: al.model })] : [])] : lm ? [createLocalModelAdapter({ consentedHosts: [{ host: '127.0.0.1', port: lmPort }], model: o.model })] : [scriptedAdapter]) },
      // The real-CLI world sets nothing: no scriptFor, no agentBin / agentEnv, no startProxy (the runner's default, real proxy).
      agentRuntime: ca ? {} : hm
        ? { fetchImpl: (url, init) => { const a = init && init.headers && init.headers.authorization; if (typeof a === 'string' && a.startsWith('Bearer ')) w.bearers.push(a.slice(7)); return fetch(url, init); },
          ...(hostedSeam ? { hostedTestSeam: hostedSeam } : {}), ...(o.startProxy ? { startProxy: o.startProxy } : {}) }
        : lm
        ? { fetchImpl: (url, init) => { const a = init && init.headers && init.headers.authorization; if (typeof a === 'string' && a.startsWith('Bearer ')) w.bearers.push(a.slice(7)); return fetch(url, init); } }
        : { scriptFor: (plan) => w.nextScript(plan), ...(real ? {} : { startProxy }) } });
    let gitRunner = core.git ?? null;
    Object.defineProperty(core, 'git', { configurable: true, enumerable: true, get: () => gitRunner, set: (v) => { gitRunner = v ? trackRealIo(v, io) : v; } });
    if (gitRunner) gitRunner = trackRealIo(gitRunner, io);
    // The git write and read engines' own hardened git (worktree, collect, accept, fast-forward): counted as well.
    let writer = core.gitw ?? null;
    Object.defineProperty(core, 'gitw', { configurable: true, enumerable: true, get: () => writer, set: (v) => { writer = v ? trackRealIo(v, io) : v; } });
    if (writer) writer = trackRealIo(writer, io);
    // main's own wiring at every runner `ready` (src/main/nexusExec/execWiring.ts): ask the runner to reconcile, apply its answer as
    // restart recovery's phase B and hand it the leftovers to remove. Copied in miniature: the real wiring forks a runner process.
    const system = nx.principals.system();
    const execPort = {
      state: () => b.port.state(),
      send: (m) => b.port.send(m),
      onMessage: (fn) => b.port.onMessage((raw) => {
        const op = raw && raw.op;
        if (op === 'ready') {
          let sent = false;
          try { b.port.send({ op: 'reconcile.list', attempts: nx.exec.reconcileCandidates() }); sent = true; } catch { /* not sent */ }
          if (sent) nx.exec.reconcileList();
        } else if (op === 'reconcile.result') {
          const report = nx.exec.recoverPhaseB(system, nx.bootId, { docker: raw.docker, attempts: raw.attempts, labelled: raw.labelled });
          if (report && report.remove.length > 0) {
            b.port.send({ op: 'reconcile.remove', resources: report.remove.map((x) => ({ kind: x.kind, id: x.id })) });
            nx.exec.recordOrphanRemoval(system, report.remove);
          }
          return;
        }
        fn(raw);
      })
    };
    nx.exec.attachRunner(execPort, nx.bootId);
    return { core, bridge: b };
  }
  Object.assign(w, { driver, io });
  Object.assign(w, attachCore());
  w.extraCores = [];
  w.close = async () => {
    try { await w.core.shutdown(); } catch { /* down */ }
    // The real world removes everything this install's label owns (containers, volumes, networks): nothing of a test is left in Docker.
    if (real) { try { require('./execReal.cjs').removeLabelled(loadTs('src/shared/nexus/homeLabel.ts').homeLabel(dataHome.root)); } catch { /* best effort */ } }
    try { w.bridge.close(); } catch { /* closed */ }
    for (const extra of w.extraCores ?? []) { try { await extra.core.shutdown(); } catch { /* down */ } try { extra.bridge.close(); } catch { /* closed */ } }
    try { s.close(); } catch { /* closed */ }
  };
  WORLDS.push(w);

  const IO_WAIT_MS = 120_000;
  const flush = async () => {
    const end = Date.now() + IO_WAIT_MS;
    do {
      while (io.n > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setImmediate(r));
        await nx.exec.settled();
        if (nx.validation) await nx.validation.settled();
      }
      await new Promise((r) => setTimeout(r, 2));
    } while (io.n > 0 && Date.now() < end);
  };
  w.flush = flush;
  const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
  w.until = async (pred, what, ms = 10 * 60_000) => {
    // The real world waits in real time (the scheduler ticks every 250 ms, as main's does every second); the fake one advances its clock.
    const stepsN = real ? Number.MAX_SAFE_INTEGER : Math.ceil(ms / 1000) + 30;
    const deadline = Date.now() + ms;
    for (let i = 0; i < stepsN; i++) {
      await flush();
      if (pred()) return;
      if (real) { if (Date.now() > deadline) break; await sleepReal(250); } else clock.advance(1000);
      nx.exec.tick(clock.now);
      if (nx.validation) nx.validation.runPending(clock.now);
    }
    await flush();
    if (!pred()) throw new Error(`timed out waiting for ${what}\n${logs.slice(-15).join('\n')}\n${w.runnerLogs.slice(-15).join('\n')}`);
  };
  /** Drives the world until a promise (a handler call that waits for jobs) settles; returns its value or throws its error. */
  w.drive = async (promise, what = 'the call', ms = 10 * 60_000) => {
    let settled = false; let value; let error; let failed = false;
    promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; failed = true; error = e; });
    await w.until(() => settled, what, ms);
    if (failed) throw error;
    return value;
  };
  w.sleepFake = async (ms) => { for (let t = 0; t < ms; t += 1000) { await flush(); if (real) await sleepReal(1000); else clock.advance(1000); nx.exec.tick(clock.now); if (nx.validation) nx.validation.runPending(clock.now); } await flush(); };

  // ---- the agent's scripts: one provider per turn, in the order the turns start
  /** Queues proxy decisions for the NEXT turn's host proxy (see `startProxy` above): `{ decision, host, port, reason }` each. */
  w.egressQueue = [];
  w.injectEgress = (...decisions) => { w.egressQueue.push(...decisions); };
  /** The next `hold` exec (sandbox_exec ['hold']) waits until `release()` is called: a turn caught mid-command. */
  w.hold = () => { w.holdGate = new Promise((r) => { w.release = r; }); };
  w.script = (fn) => { w.scripts.push(typeof fn === 'function' ? fn : () => fn); return w; };
  w.nextScript = (plan) => {
    const fn = w.scripts.shift();
    w.scriptsSeen.push(plan.jobId);
    return fn ? fn(plan) : [{ op: 'complete' }];
  };
  /** Writes files into the turn's worktree, as the engine's file tools do on the host (`files`: relative path -> text, null deletes). */
  w.edit = (plan, files) => {
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(plan.worktree.hostPath, ...rel.split('/'));
      if (text === null) { fs.rmSync(abs, { force: true }); continue; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
  };

  w.x = ipcOver(w, { agentsUnavailableReason: () => null,
    confirmMerge: (info) => confirmMergeWith(async (opts) => { w.dialogs.push({ opts, info }); if (w.onDialog) await w.onDialog(info); return { response: w.dialogAnswer }; }, info) });
  w.dialogs = []; w.dialogAnswer = 1; w.onDialog = null;
  w.PROJECT = 'p-ledger'; w.WORKSPACE = 'sde';
  w.tick = () => nx.exec.tick(clock.now);

  await w.until(() => nx.exec.health().docker.state === 'running', 'the runner probe', 30_000);

  // ---- the user's steps, through the handlers
  /** The runtime check and the consent (#51), as the setup sheet does: the adapter's own destination, never one the renderer names. */
  w.consent = async (caps) => {
    if (ca) {
      // The real CLI's check takes seconds and the cache may hold an older probe: wait for a result recorded AFTER this refresh.
      await w.probeCli();
      if (caps) throw new Error('the real-CLI world grants the default caps only (never raised, never lowered by the driver)');
      return w.x.ok('nexus:agent:consent', { op: 'grant', runtime: 'cli-agent' });
    }
    if (hm) await w.probeAgain(); else {
      nx.agentProbe.refresh();
      await w.until(() => !nx.agentProbe.cache.isStale(), 'the runtime check');
    }
    return w.x.ok('nexus:agent:consent', { op: 'grant', ...(lm ? { runtime: 'local-model', model: o.model } : hm ? { runtime: 'hosted-model', provider: o.provider, model: o.model } : {}), ...(caps ? { caps } : {}) });
  };
  if (hm) {
    /** A fresh runtime check, waited for (a result recorded AFTER this call: after a revoke the cache may hold the other runtime's entry only). */
    w.probeAgain = async () => {
      clock.advance(1000);
      const since = clock.now;
      let done = false;
      nx.agentProbe.refresh();
      nx.agentProbe.cache.whenRecorded(since, 120_000).then(() => { done = true; }, () => { done = true; });
      await w.until(() => done, 'the runtime check');
    };
    /** Waits until the probe has listed the providers (the key store only stores a key for a listed provider). */
    w.providersKnown = async () => {
      if (hostedKeys.list().ok) return;
      nx.agentProbe.refresh();
      await w.until(() => hostedKeys.list().ok, 'the provider list of the runtime check');
    };
    /** Grants the local-model runtime (the world was made with `alsoLocal`); the hosted permission must have been revoked first. */
    w.consentLocal = async () => {
      if (!al) throw new Error('the world has no alsoLocal runtime');
      await w.probeAgain();
      return w.x.ok('nexus:agent:consent', { op: 'grant', runtime: 'local-model', model: al.model });
    };
    /** Stores the user's key for a provider (default: the chosen one) through the real key store; returns the store's answer. */
    w.setKey = async (key, provider = o.provider) => { await w.providersKnown(); return hostedKeys.set(provider, key); };
  }
  /**
   * The real-CLI world: asks the runner for a fresh probe and waits for it (the real adapter runs the CLI's `--version`, `--help` and
   * `auth status`). Returns the cache entry of kind `cli-agent` ({ kind, health, setup }; setup.signedIn is yes|no|unknown, never the
   * CLI's own output) or null when the probe did not report it. Reads nothing of the CLI's home.
   */
  w.probeCli = async (ms = 120_000) => {
    const since = clock.now;
    if (!nx.agentProbe.refresh()) throw new Error('the runtime check could not be asked for');
    const recorded = await nx.agentProbe.cache.whenRecorded(since, ms);
    if (!recorded) throw new Error('the runtime check did not answer in time');
    return nx.agentProbe.cache.fresh('cli-agent');
  };
  // ---- what a controller records of a turn (read from main's own records; no secret is ever in them)
  /** Every proxy decision of the turn, in order: [{ decision: 'allowed'|'refused', host, port, reason }] (job_events attempt.progress `$.egress`). */
  w.egressDecisions = (jobId) => db.prepare("SELECT json_extract(data_json, '$.egress') AS e FROM job_events WHERE job_id = ? AND type = 'attempt.progress' AND json_extract(data_json, '$.egress') IS NOT NULL ORDER BY seq")
    .all(jobId).map((r) => JSON.parse(r.e));
  /** How many decisions the runner did not report (more than EGRESS_EVENT_MAX): their hosts are NOT recorded anywhere. */
  w.egressTruncated = (jobId) => db.prepare("SELECT COALESCE(SUM(json_extract(data_json, '$.egressTruncated.count')), 0) AS n FROM job_events WHERE job_id = ? AND type = 'attempt.progress' AND json_extract(data_json, '$.egressTruncated') IS NOT NULL")
    .get(jobId).n;
  /** The turn's latest attempt's usage as main recorded it (job_attempts.usage_json), or null. */
  w.usageOf = (jobId) => { const r = db.prepare('SELECT usage_json FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1').get(jobId); return r && r.usage_json ? JSON.parse(r.usage_json) : null; };
  /** The tools the agent used in the turn, in order (job_events `runtime.tool`): names only. */
  w.toolCallsOf = (jobId) => db.prepare("SELECT json_extract(data_json, '$.tool') AS t FROM job_events WHERE job_id = ? AND type = 'attempt.progress' AND json_extract(data_json, '$.t') = 'runtime.tool' ORDER BY seq")
    .all(jobId).map((r) => r.t);
  /** The live consent row as stored (hosts and caps only). */
  w.consentRow = () => db.prepare('SELECT runtime_kind, hosts_json, hosts_sha256, turn_usd_cents, day_usd_cents, turns_per_hour, concurrent_turns, turn_tokens, tool_calls FROM runtime_consents WHERE revoked_at IS NULL').get() ?? null;
  /** #42, the user's message; the turn's worktree preparation, approval A3 and lease follow on their own. */
  w.start = async (message, x = {}) => w.x.ok('nexus:agent:start', { projectId: w.PROJECT, workspaceId: w.WORKSPACE, sessionId: x.sessionId ?? null,
    focusVersionIds: x.focus ?? [], message, intentId: x.intentId ?? intent(), ...(x.skillId ? { skillId: x.skillId } : {}) });
  w.jobRow = (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  w.ended = (jobId) => TERMINAL.includes(w.jobRow(jobId).state);
  /** The user answers the repository-write approval (A3) a first turn waits for (#39), once. */
  w.approveA3 = async (decision = 'once') => {
    await w.until(() => db.prepare("SELECT 1 FROM approvals WHERE reason = 'repo.write_refs' AND status = 'pending'").get() !== undefined, 'the repository-write approval');
    const a = db.prepare("SELECT id FROM approvals WHERE reason = 'repo.write_refs' AND status = 'pending' ORDER BY requested_at DESC").get();
    return w.x.ok('nexus:approval:respond', a.id, decision);
  };
  /** Runs a turn to its end: start, (A3 once), then until the job is terminal. Returns the job row and the session id. */
  w.turn = async (message, x = {}) => {
    const r = await w.start(message, x);
    const jobId = r.job.id;
    if (x.approve !== false && x.sessionId == null && !db.prepare("SELECT 1 FROM approvals WHERE reason = 'repo.write_refs' AND status = 'approved'").get()) await w.approveA3();
    await w.until(() => w.ended(jobId), `turn ${jobId} ends`, x.ms ?? 15 * 60_000);
    return { jobId, sessionId: r.session.id, job: w.jobRow(jobId) };
  };
  /** A change set's check results, latest per validator. */
  w.checks = (versionId) => Object.fromEntries(db.prepare(`SELECT x.validator_id, x.status, x.blocking FROM validations x WHERE x.version_id = ? AND NOT EXISTS
    (SELECT 1 FROM validations y WHERE y.version_id = x.version_id AND y.validator_id = x.validator_id AND (y.finished_at > x.finished_at OR (y.finished_at = x.finished_at AND y.rowid > x.rowid)))`)
    .all(versionId).map((r) => [r.validator_id, r.status]));
  w.versionRow = (id) => db.prepare('SELECT v.*, a.kind FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?').get(id);
  /** The change sets a turn's collect children produced, oldest first. */
  w.changeSetsOf = (jobId) => db.prepare(`SELECT v.id FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id JOIN jobs c ON c.id = v.produced_by_job_id
    WHERE c.parent_job_id = ? AND c.recipe_id = 'changeset.collect' AND a.kind = 'change_set' ORDER BY v.rowid`).all(jobId).map((r) => r.id);
  w.until_candidate = async (versionId, ms = 15 * 60_000) => {
    await w.until(() => w.versionRow(versionId).status !== 'draft', `change set ${versionId} leaves draft`, ms);
    return w.versionRow(versionId).status;
  };
  /**
   * The state of an SDE step from the records (stepStateFrom), computed here from the database (addCommon's `stepState`). The `review`
   * step is a RECORD step the product's rail reads itself: use `railStep('review')`, which asks the product's own reader instead of a
   * rule invented here. Never an exit code: a job that exited 0 changes no step.
   */
  w.stepOf = (stepId) => {
    const step = getDomain('sde').lifecycle.find((x) => x.id === stepId);
    if ('record' in step.doneWhen && (step.doneWhen.record === 'review' || step.doneWhen.record === 'iteration')) throw new Error(`the ${stepId} step is read through w.railStep('${stepId}'), the product own rail`);
    return w.stepState('sde', stepId);
  };
  /**
   * The state of an SDE step as the PRODUCT's rail reads it: the renderer's own reader (workspaces/lifecycleModel.railFor over
   * project/spineModel.railRecordsFor) over the artifact summaries (#8) and each shown version's check results (#32) that the handlers
   * answer, exactly the inputs ProjectBench gives it. `o.deploymentHealthy`: the project's healthy-deployment record.
   */
  w.railStep = async (stepId, o = {}) => {
    const L = loadTs('src/renderer/src/nexus/workspaces/lifecycleModel.ts');
    const S = loadTs('src/renderer/src/nexus/project/spineModel.ts');
    const artifacts = await w.x.ok('nexus:artifacts:byProject', w.PROJECT);
    const checks = new Map();
    for (const { versionId } of S.checkedVersionIds(artifacts)) {
      const rows = await w.x.ok('nexus:version:validations', versionId);
      checks.set(versionId, Object.fromEntries(rows.map((r) => [r.validatorId, r.status])));
    }
    const records = S.railRecordsFor({ workspaceId: w.WORKSPACE, artifacts, checks, liveActions: [], deploymentHealthy: o.deploymentHealthy === true, participating: true });
    const view = L.bundledDomainViews().find((v) => v.id === 'sde');
    const step = L.railFor(view, records).steps.find((x) => x.id === stepId);
    return step.state;
  };
  /** A handler call that waits for a runner job (accept, merge, status): driven until it answers; the envelope's data, or a failed assertion. */
  w.okd = async (ch, ...a) => {
    const r = await w.drive(w.x.call(ch, ...a), ch);
    if (r.ok !== true) throw new Error(`${ch}: ${JSON.stringify(r)}`);
    return r.data;
  };
  w.refusedd = async (ch, args, reason) => {
    const r = await w.drive(w.x.call(ch, ...args), ch);
    if (r.ok !== false) throw new Error(`${ch} should have refused: ${JSON.stringify(r)}`);
    if (reason !== undefined && r.reason !== reason && r.subReason !== reason && r.code !== reason) throw new Error(`${ch} refused for another reason: ${JSON.stringify(r)}`);
    return r;
  };
  /** The attempt logs of a job as the runner wrote them (one JSON frame per line: stream, text, ts), oldest first. */
  w.attemptLog = (jobId) => {
    const frames = [];
    for (const a of db.prepare('SELECT log_path FROM job_attempts WHERE job_id = ? ORDER BY n').all(jobId)) {
      if (!a.log_path) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(dataHome.root, ...a.log_path.split('/')), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) { if (!line.startsWith('{')) continue; try { frames.push(JSON.parse(line)); } catch { /* not a frame */ } }
    }
    return frames;
  };
  /** The turn's `sandbox_exec` results from its log: { argv, exit, stdout, stderr } (what the runner recorded, redacted). */
  w.execResults = (jobId) => w.attemptLog(jobId).filter((f) => f.stream === 'nexus' && typeof f.text === 'string' && f.text.startsWith('sandbox_exec ')).map((f) => {
    const m = /^sandbox_exec ([\s\S]*?) -> (?:exit (\S+)|failed: ([\s\S]*?))(?:\nstdout: ([\s\S]*?))?(?:\nstderr: ([\s\S]*))?$/.exec(f.text);
    return m ? { argv: m[1], exit: m[2] === undefined ? null : m[2] === 'null' ? null : Number(m[2]), failed: m[3] ?? null, stdout: m[4] ?? '', stderr: m[5] ?? '' }
      : { argv: f.text, exit: null, failed: 'unparsed', stdout: '', stderr: '' };
  });
  /** The user's repository: its branch, HEAD, and every file below it, as the user sees them. */
  w.userHead = () => git(w.repoDir, 'rev-parse', 'HEAD');
  w.userState = () => {
    const files = {};
    for (const [rel, buf] of dirFiles(w.repoDir)) files[rel] = crypto.createHash('sha256').update(buf).digest('hex');
    const idx = path.join(w.repoDir, '.git', 'index');
    return { head: w.userHead(), branch: git(w.repoDir, 'symbolic-ref', 'HEAD'), status: git(w.repoDir, 'status', '--porcelain'), stash: git(w.repoDir, 'stash', 'list'),
      index: fs.existsSync(idx) ? crypto.createHash('sha256').update(fs.readFileSync(idx)).digest('hex') : null, files };
  };
  w.refOf = (ref) => { try { return git(w.repoDir, 'rev-parse', '--verify', '-q', ref); } catch { return null; } };
  w.git = (...a) => git(w.repoDir, ...a);

  /**
   * A crash of main and its runner mid-work, then a fresh boot on the same database, data home, repository and Docker (the same
   * fake driver, so a container the old runner left is still there for the new one to find): the old store is closed (the process is
   * gone), the old runner is deaf, and a NEW platform runs its startup recovery and attaches a NEW runner. Returns the new world.
   */
  w.restart = async (o2 = {}) => {
    const old = { core: w.core, bridge: w.bridge };
    w.bridge.close();
    try { s.close(); } catch { /* closed */ }
    const w2 = await flowWorld({ clock, driver, real, runtime: o.runtime, modelUrl: o.modelUrl, model: o.model, provider: o.provider, keyStore, alsoLocal: o.alsoLocal, hostedSeam: o.hostedSeam, startProxy: o.startProxy, bearers: w.bearers, lmCfg, reopen: { file, userData, roots, repo: w.repoDir, current: w.current }, ...o2 });
    w2.old = old;
    w2.extraCores.push(old);
    w2.played = w.played; w2.execs = w.execs;
    return w2;
  };
  w.liveLabelled = (jobId) => driver.all().filter((r) => r.labels && r.labels['nexus.job'] === jobId && r.labels['nexus.kind'] !== 'deps').length;
  w.attachCore = attachCore;
  return w;
}

/** The fixture repository on disk, accepted as the project's folder; returns its facts. */
async function useFixture(w, name, overlay = {}) {
  const r = await w.useFixture(name, overlay);
  w.repoDir = r.dir;
  if (name === 'pytest-app') w.setLanguages(['python']);
  return r;
}

// ---------------------------------------------------------------- the user's B2a steps, through the handlers

const MIN = 60_000;
const startArgs = (actionId, o = {}) => ({ projectId: 'p-ledger', workspaceId: 'sde', actionId, inputs: o.inputs ?? [], params: o.params ?? {}, intentId: intent() });
/** Waits for a job to end; returns its detail through #26. */
async function jobEnds(w, jobId, ms = 10 * MIN) {
  await w.until(() => w.ended(jobId), `job ${jobId} ends`, ms);
  return w.x.ok('nexus:job:get', jobId);
}
/** The version a job's output became (its own, or the one its evidence is bound to after a deduplicated output). */
function outputOf(w, jobId, outputPath) {
  const own = w.db.prepare('SELECT id FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = ? ORDER BY rowid DESC LIMIT 1').get(jobId, outputPath);
  if (own) return own.id;
  const bound = w.db.prepare('SELECT version_id FROM validations WHERE job_id = ? ORDER BY rowid DESC LIMIT 1').get(jobId);
  return bound ? bound.version_id : null;
}
/** #31 discover + the suite's own run: returns { jobId, suite } once the suite has left draft. */
async function discoverTests(w, repoV) {
  const d = await w.x.ok('nexus:job:start', startArgs('sde.tests.discover', { inputs: [{ versionId: repoV, slot: 'repository' }] }));
  const dj = await jobEnds(w, d.job.id);
  const suite = outputOf(w, d.job.id, 'ids.txt');
  await w.until(() => w.versionRow(suite).status !== 'draft', 'the suite leaves draft', 15 * MIN);
  return { jobId: d.job.id, job: dj, suite };
}
/** The build of a repository version: returns { jobId, build } once it has left draft. */
async function runBuild(w, repoV, outputPath) {
  const b = await w.x.ok('nexus:job:start', startArgs('sde.build.run', { inputs: [{ versionId: repoV, slot: 'repository' }] }));
  const bj = await jobEnds(w, b.job.id);
  const build = outputOf(w, b.job.id, outputPath);
  await w.until(() => w.versionRow(build).status !== 'draft', 'the build leaves draft', 5 * MIN);
  return { jobId: b.job.id, job: bj, build };
}
/** Assemble, a dev deployment (healthy, through the forwarder), a diagnosis of it, then stop. Returns the ids. */
async function deployAndDiagnose(w, buildV) {
  const x = w.x;
  const asm = await x.ok('nexus:job:start', startArgs('sde.app.assemble', { inputs: [{ versionId: buildV, slot: 'build' }] }));
  await jobEnds(w, asm.job.id);
  const app = outputOf(w, asm.job.id, 'manifest');
  const pv = await x.ok('nexus:job:start', startArgs('sde.preview.start', { inputs: [{ versionId: app, slot: 'application' }] }));
  await w.until(() => { const d = w.deploymentOf(pv.job.id); return !!d && d.status !== 'starting'; }, 'the deployment leaves starting', 3 * MIN);
  const dep = (await x.ok('nexus:deployments:list', { projectId: 'p-ledger' })).find((d) => d.jobId === pv.job.id);
  await w.until(() => w.versionRow(app).status === 'candidate', 'the application becomes a candidate', MIN);
  await w.until(() => JSON.parse(w.deploymentRow(dep.id).health_json).length >= 1, 'a probe is recorded', MIN);
  const dg = await x.ok('nexus:job:start', startArgs('sde.diagnose', { params: { target: 'deployment', targetId: dep.id } }));
  await jobEnds(w, dg.job.id, 3 * MIN);
  const report = outputOf(w, dg.job.id, 'report');
  await w.until(() => w.versionRow(report).status !== 'draft', 'the report leaves draft', MIN);
  return { app, deployment: dep, previewJob: pv.job.id, diagnoseJob: dg.job.id, report };
}
async function stopDeployment(w, d) {
  await w.x.ok('nexus:deployment:stop', d.deployment.id);
  await jobEnds(w, d.previewJob, 3 * MIN);
  await w.until(() => w.liveLabelled(d.previewJob) === 0, 'the deployment resources are removed', 2 * MIN);
}

/**
 * A turn that edits the worktree and registers one change set (the common path of the flows): returns { turn, cs }. `o.execArgv`: the
 * command the agent runs in its container first (default: none); `o.files`: relative path -> text (null deletes).
 */
async function makeChange(w, o) {
  w.script((plan) => {
    w.edit(plan, o.files);
    return [{ op: 'delta', text: o.say ?? 'Working on it.' },
      ...(o.execArgv ? [{ op: 'call', tool: 'sandbox_exec', args: { argv: o.execArgv, cwd: '/workspace', timeoutMs: 60000 } }] : []),
      { op: 'call', tool: 'changeset_register', args: { title: o.title, summary: o.summary ?? 'Done.', clientKey: o.clientKey ?? 'cs-1',
        ...(o.requirementVersionIds ? { requirementVersionIds: o.requirementVersionIds } : {}), ...(o.reviseArtifactId ? { reviseArtifactId: o.reviseArtifactId } : {}) } },
      { op: 'usage', inputTokens: 1000, outputTokens: 300, costUsdCents: 5, toolCalls: o.execArgv ? 2 : 1, estimated: false }, { op: 'complete' }];
  });
  const turn = await w.turn(o.message ?? 'Make the change', { sessionId: o.sessionId ?? null });
  const [cs] = w.changeSetsOf(turn.jobId);
  return { turn, cs };
}
/** Review (approve) and accept a candidate change set through the handlers; returns { status, accept } with the status read before accepting. */
async function approveAndAccept(w, cs, o = {}) {
  await w.x.ok('nexus:review:decide', cs, { decision: 'approve' }, intent());
  if (o.afterApprove) await o.afterApprove();
  const status = await w.okd('nexus:repo:status', w.PROJECT);
  const accept = await w.okd('nexus:changeSet:accept', cs, status.acceptedHead);
  return { status, accept: accept.accept, version: accept.version };
}

/** After a flow: no orphan of any kind (O1-O22), foreign keys, integrity, the activity chain. */
function sound(w, name) {
  const swept = w.exec.lastExpirySweepAt;
  if (swept === null) assert.equal(w.db.prepare("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").get().n, 0, `${name}: pending approvals, never swept`);
  assert.deepEqual(allOrphans(w.db, { sweptAt: swept === null ? Number.MAX_SAFE_INTEGER : swept }), ALL_ZERO, `${name}: orphans`);
  assert.deepEqual(w.db.prepare('PRAGMA foreign_key_check').all(), [], `${name}: foreign keys`);
  assert.equal(w.db.pragma('integrity_check', { simple: true }), 'ok', `${name}: integrity`);
  assert.equal(verifyActivityChain(w.db).ok, true, `${name}: activity chain`);
}

/**
 * Registers a script that edits the worktree and calls changeset_register. `o.execArgv` (default `node --test`; `false`: none) is the
 * command the agent runs first; `o.tokens` collects the turn's bearer for the no-leak scans; `o.say` is its one line of text.
 */
function implementing(w, files, args, o = {}) {
  const execArgv = o.execArgv === undefined ? ['node', '--test'] : o.execArgv;
  w.script((plan) => {
    if (o.tokens) o.tokens.push(plan.runtime.token);
    w.edit(plan, files);
    return [{ op: 'delta', text: o.say ?? 'Working on it.' },
      ...(execArgv ? [{ op: 'call', tool: 'sandbox_exec', args: { argv: execArgv, cwd: '/workspace', timeoutMs: 60000 } }] : []),
      { op: 'call', tool: 'changeset_register', args: { summary: 'Done.', ...args } },
      { op: 'usage', inputTokens: 1800, outputTokens: 600, costUsdCents: 9, toolCalls: 3, estimated: false }, { op: 'complete' }];
  });
}

module.exports = { fakeKeyStore, sound, implementing, makeChange, approveAndAccept, flowWorld, useFixture, tarFiles, dirFiles, git, API_HOST, RUNTIME_KIND, TERMINAL, scriptedAdapter,
  MIN, startArgs, jobEnds, outputOf, discoverTests, runBuild, deployAndDiagnose, stopDeployment };
