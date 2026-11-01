// The live preview: the isolation rules (pure), the chain that gets an app running (played with a fake client), and the source pins of the wiring.
// The real run (Docker, the isolated view) is the controller's verification; the flow of the chain through main is test/nexus-platform-b2b-flows-node.test.cjs.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const P = loadTs('src/shared/nexus/previewPolicy.ts');
const M = loadTs('src/renderer/src/nexus/project/previewModel.ts');
const { systemPrompt } = loadTs('src/runner/runtimes/localModel/prompt.ts');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VENDOR = /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-|docker|emergent|lovable/i;

test('PV1 the preview loads ONE origin: its own 127.0.0.1 port, nothing else', () => {
  const port = 50123;
  assert.equal(P.previewOrigin(port), 'http://127.0.0.1:50123');
  for (const yes of ['http://127.0.0.1:50123', 'http://127.0.0.1:50123/', 'http://127.0.0.1:50123/a/b?x=1#h']) assert.equal(P.isPreviewNavigationAllowed(yes, port), true, yes);
  for (const no of ['http://127.0.0.1:50124/', 'http://127.0.0.1/', 'http://localhost:50123/', 'http://0.0.0.0:50123/', 'http://[::1]:50123/', 'https://127.0.0.1:50123/',
    'http://127.0.0.1.evil.com:50123/', 'http://127.0.0.1:50123@evil.com/', 'http://user:pw@127.0.0.1:50123/', 'http://evil.com/', 'https://example.com/', 'file:///C:/x', 'javascript:alert(1)',
    'data:text/html,hi', 'about:blank', 'chrome://gpu', 'devtools://devtools/', 'ftp://127.0.0.1:50123/', '', 'not a url', undefined, null, 42, 'http://127.0.0.1:5012/', 'http://127.0.0.1:501234/']) {
    assert.equal(P.isPreviewNavigationAllowed(no, port), false, String(no));
  }
  // requests: its own origin, inline data, its own blobs and sockets; every other loopback server and every outside address is cancelled
  for (const yes of ['http://127.0.0.1:50123/app.js', 'data:image/png;base64,AAAA', 'blob:http://127.0.0.1:50123/6f0b-1', 'ws://127.0.0.1:50123/socket']) assert.equal(P.isPreviewRequestAllowed(yes, port), true, yes);
  for (const no of ['http://127.0.0.1:63106/', 'http://127.0.0.1:63107/', 'http://127.0.0.1:3000/', 'http://localhost:50123/', 'https://cdn.example.com/x.js', 'http://169.254.169.254/latest/meta-data',
    'blob:http://evil.com/1', 'blob:null/1', 'ws://127.0.0.1:63106/', 'wss://example.com/', 'ws://127.0.0.1:50123@evil.com/', 'file:///etc/passwd', 'ftp://example.com/', '', undefined]) {
    assert.equal(P.isPreviewRequestAllowed(no, port), false, String(no));
  }
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'midi', 'fullscreen', 'openExternal', 'unknown']) assert.equal(P.isPreviewPermissionAllowed(permission), false, permission);
});

test('PV2 only a live deployment on 127.0.0.1 with a published port can be previewed; the bounds are checked', () => {
  const d = (o = {}) => ({ status: 'healthy', bindAddress: '127.0.0.1', hostPort: 50123, ...o });
  assert.equal(P.isDeploymentPreviewable(d()), true);
  assert.equal(P.isDeploymentPreviewable(d({ status: 'starting' })), true);
  assert.equal(P.isDeploymentPreviewable(d({ status: 'unhealthy' })), true);
  for (const bad of [d({ status: 'stopped' }), d({ status: 'failed' }), d({ bindAddress: '0.0.0.0' }), d({ bindAddress: 'localhost' }), d({ hostPort: null }), d({ hostPort: 80 }), d({ hostPort: 70000 }), d({ hostPort: 1.5 })]) {
    assert.equal(P.isDeploymentPreviewable(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(P.checkPreviewBounds({ x: 10.4, y: 20, width: 800.6, height: 600 }), { x: 10, y: 20, width: 801, height: 600 });
  for (const bad of [null, undefined, 'x', {}, { x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 5 }, { x: 0, y: 0, width: NaN, height: 5 }, { x: 0, y: 0, width: 1e9, height: 5 }, { x: '0', y: 0, width: 5, height: 5 }]) {
    assert.equal(P.checkPreviewBounds(bad), null, JSON.stringify(bad));
  }
});

const fake = (o = {}) => {
  const calls = [];
  const c = {
    calls,
    async start(step, actionId, inputs) { calls.push(['start', step, actionId, inputs]);
      // Live preview phase 2: by default the app lists no add-ons (or they are installed already), so the add-ons step has nothing to do.
      if (step === 'deps' && o.deps !== true) return { ok: false, text: 'Nothing to install.', skip: true };
      return o.refuse === step ? { ok: false, text: 'Nexus refused.' } : { ok: true, jobId: `job-${step}` }; },
    async waitJob(jobId) { calls.push(['waitJob', jobId]); const step = jobId.slice(4); return o.jobFails === step ? { state: 'failed', outputs: [], why: null, code: o.code ?? null } : { state: 'completed', outputs: [`ver-${step}`], why: null }; },
    async waitVersion(v) { calls.push(['waitVersion', v]); return o.versionStatus ?? 'candidate'; },
    async latestOf(kind) { calls.push(['latestOf', kind]); return o.noLatest ? null : `latest-${kind}`; },
    async stopLive() { calls.push(['stopLive']); },
    async waitDeployment(jobId) { calls.push(['waitDeployment', jobId]); return o.deployFails ? { id: '', ok: false, why: null } : { id: 'dep-1', ok: true, why: null }; }
  };
  return c;
};

test('PV3 one press runs snapshot, (add-ons), build, assemble, start in order, each from the one before, and stops any earlier preview first', async () => {
  const c = fake(); const steps = [];
  const r = await M.runPreviewChain(c, (s) => steps.push(s));
  assert.deepEqual(r, { ok: true, deploymentId: 'dep-1' });
  assert.deepEqual(steps, ['snapshot', 'build', 'assemble', 'start'], 'a skipped add-ons step shows nothing');
  assert.deepEqual(c.calls.filter((x) => x[0] === 'start').map((x) => [x[2], x[3]]), [
    ['sde.repository.snapshot', []],
    ['sde.deps.prepare', [{ versionId: 'ver-snapshot', slot: 'repository' }]],
    ['sde.build.run', [{ versionId: 'ver-snapshot', slot: 'repository' }]],
    ['sde.app.assemble', [{ versionId: 'ver-build', slot: 'build' }]],
    ['sde.preview.start', [{ versionId: 'ver-assemble', slot: 'application' }]]
  ]);
  assert.equal(c.calls[0][0], 'stopLive', 'the project\'s earlier preview is stopped first (one per project)');
  // the application stays a draft until its health check passes: it never waits for its checks; the repository and the build do
  assert.deepEqual(c.calls.filter((x) => x[0] === 'waitVersion').map((x) => x[1]), ['ver-snapshot', 'ver-build']);
});

test('PV3b a step that made nothing new (the same files as before) continues from the version it made earlier', async () => {
  const c = fake({ noOutputs: true });
  const orig = c.waitJob;
  c.waitJob = async (jobId) => { const r = await orig(jobId); return { ...r, outputs: [] }; };
  const r = await M.runPreviewChain(c, () => undefined);
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls.filter((x) => x[0] === 'start').map((x) => x[3]), [[], [{ versionId: 'latest-repository', slot: 'repository' }], [{ versionId: 'latest-repository', slot: 'repository' }], [{ versionId: 'latest-build', slot: 'build' }], [{ versionId: 'latest-application', slot: 'application' }]]);
  const none = fake({ noLatest: true }); none.waitJob = async () => ({ state: 'completed', outputs: [], why: null });
  const bad = await M.runPreviewChain(none, () => undefined);
  assert.equal(bad.ok, false); assert.equal(bad.step, 'snapshot');
});

test('PV4 a step that did not work stops the chain there with plain words and the step; no step is skipped', async () => {
  for (const [opt, step, askHelper] of [[{ refuse: 'snapshot' }, 'snapshot', false], [{ jobFails: 'build' }, 'build', true], [{ jobFails: 'assemble' }, 'assemble', true],
    [{ refuse: 'start' }, 'start', true], [{ deployFails: true }, 'start', true], [{ versionStatus: 'draft' }, 'snapshot', false], [{ jobFails: 'snapshot' }, 'snapshot', false]]) {
    const c = fake(opt);
    const r = await M.runPreviewChain(c, () => undefined);
    assert.equal(r.ok, false, JSON.stringify(opt));
    assert.equal(r.step, step, JSON.stringify(opt));
    assert.equal(r.askHelper, askHelper, JSON.stringify(opt));
    assert.ok(r.text.length > 10 && !VENDOR.test(r.text) && !/[0-9a-f]{12}|job-|ver-/.test(r.text), r.text);
    const started = c.calls.filter((x) => x[0] === 'start').map((x) => x[1]);
    assert.deepEqual(started, M.PREVIEW_STEPS.slice(0, M.PREVIEW_STEPS.indexOf(step) + 1), 'stops at the failing step: ' + JSON.stringify(opt));
  }
  const words = [M.PREVIEW_INTRO, M.PREVIEW_LIMITS, M.PREVIEW_EMBED_LABEL, M.PREVIEW_NOT_ANSWERING, M.PREVIEW_ASK_HELPER, ...M.PREVIEW_STEPS.map(M.stepWords)].join(' ');
  assert.doesNotMatch(words.replace(/Make this app runnable in Nexus[^.]*\./, ''), VENDOR);
  for (const s of ['starting', 'healthy', 'unhealthy', 'stopped', 'failed']) assert.ok(M.deploymentWord({ status: s, stopReason: null }).length > 2, s);
  assert.equal(M.deploymentWord({ status: 'stopped', stopReason: 'idle' }), 'Stopped (two hours passed)');
  assert.equal(M.isLive({ status: 'healthy' }), true); assert.equal(M.isLive({ status: 'stopped' }), false);
});

test('PV4b the add-ons step (live preview phase 2): it asks through main, waits for the answer, builds from the same repository version, and says what went wrong in plain words', async () => {
  const c = fake({ deps: true }); const steps = [];
  const r = await M.runPreviewChain(c, (s) => steps.push(s));
  assert.deepEqual(r, { ok: true, deploymentId: 'dep-1' });
  assert.deepEqual(steps, ['snapshot', 'deps', 'build', 'assemble', 'start']);
  const starts = c.calls.filter((x) => x[0] === 'start').map((x) => [x[2], x[3]]);
  assert.deepEqual(starts[1], ['sde.deps.prepare', [{ versionId: 'ver-snapshot', slot: 'repository' }]]);
  assert.deepEqual(starts[2], ['sde.build.run', [{ versionId: 'ver-snapshot', slot: 'repository' }]], 'the add-ons step makes no version: the build uses the repository one');
  assert.deepEqual(c.calls.filter((x) => x[0] === 'waitVersion').map((x) => x[1]), ['ver-snapshot', 'ver-build'], 'no check is awaited for the add-ons');
  const texts = {};
  for (const code of ['approval_denied', 'denied', 'approval_expired', 'approval_stale', 'nonzero_exit', null]) {
    const f = fake({ deps: true, jobFails: 'deps', code });
    const res = await M.runPreviewChain(f, () => undefined);
    assert.equal(res.ok, false); assert.equal(res.step, 'deps');
    assert.ok(res.text.length > 20 && !VENDOR.test(res.text) && !/[0-9a-f]{12}|job-|ver-|denied|nonzero/i.test(res.text.replace(/did not allow the download/, '')), res.text);
    assert.deepEqual(f.calls.filter((x) => x[0] === 'start').map((x) => x[1]), ['snapshot', 'deps'], 'it stops there');
    texts[code] = [res.text, res.askHelper, res.askKind];
  }
  assert.match(texts.approval_denied[0], /did not allow the download/); assert.equal(texts.approval_denied[1], false); assert.equal(texts.denied[0], texts.approval_denied[0]);
  assert.match(texts.approval_expired[0], /not answered in time/); assert.equal(texts.approval_expired[1], false);
  assert.match(texts.nonzero_exit[0], /download did not finish/); assert.deepEqual([texts.nonzero_exit[1], texts.nonzero_exit[2]], [true, 'deps']);
  const words = [M.PREVIEW_LIMITS, M.PREVIEW_DEPS_WAITING, M.PREVIEW_ASK_HELPER_DEPS, M.stepWords('deps')].join(' ');
  assert.doesNotMatch(words, /npm|node_modules|lockfile|registry|proxy|sha256/i, 'the person sees plain words');
  assert.match(M.PREVIEW_DEPS_WAITING, /from the package website only/);
  assert.match(M.PREVIEW_INTRO, /no internet/);
});

test('PV5 the view is isolated: main-owned, own in-memory session, no preload, no Node, one origin; the renderer names a deployment, never a port', () => {
  const host = read('src/main/previewHost.ts');
  assert.match(host, /new WebContentsView\(\{/);
  for (const needle of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'nodeIntegrationInSubFrames: false', 'webSecurity: true', 'webviewTag: false', 'allowRunningInsecureContent: false']) {
    assert.ok(host.includes(needle), needle);
  }
  assert.doesNotMatch(host, /preload\s*:/, 'no preload in the preview view');
  assert.match(host, /session\.fromPartition\(`nexus-preview-\$\{\+\+seq\}`\)/);
  assert.doesNotMatch(host.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /persist:/, 'the preview session lives in memory only');
  assert.match(host, /ses\.webRequest\.onBeforeRequest\(\(details, callback\) => callback\(\{ cancel: !isPreviewRequestAllowed\(details\.url, port\) \}\)\)/);
  assert.match(host, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate']) assert.ok(host.includes(`'${ev}'`), ev);
  assert.match(host, /setPermissionRequestHandler\(\(_wc, permission, callback\) => callback\(isPreviewPermissionAllowed\(permission\)\)\)/);
  assert.match(host, /setPermissionCheckHandler/); assert.match(host, /will-download/);
  assert.match(host, /clearStorageData\(\)/, 'the session is wiped at close');
  assert.match(host, /loadURL\(`\$\{previewOrigin\(port\)\}\/`\)/);
  const idx = read('src/main/index.ts');
  const open = idx.slice(idx.indexOf("ipcMain.handle('preview:open'"), idx.indexOf("ipcMain.handle('preview:bounds'"));
  assert.match(open, /fromMainWindow\(evt\)/, 'only the main Nexus window may ask');
  assert.match(open, /previewDeployment\(deploymentId\)/, 'main reads the deployment itself');
  assert.match(open, /isDeploymentPreviewable\(d\)/);
  assert.match(open, /openPreview\(mainWindow, \{ deploymentId, port: d\.hostPort \}, bounds\)/, 'the port is main\'s, from the deployment record');
  assert.doesNotMatch(open, /port: *(arg|bounds|url)|loadURL/);
  assert.match(idx, /app\.on\('before-quit', \(e\) => \{\n\s+closePreview\(\);/, 'killed on quit');
  assert.match(idx, /previewWatch = setInterval\(/, 'closes when the deployment is no longer live');
  const preload = read('src/preload/index.ts');
  for (const m of ['previewOpen', 'previewBounds', 'previewVisible', 'previewReload', 'previewClose', 'onPreviewState']) assert.ok(preload.includes(`${m}:`), m);
  assert.match(preload, /previewOpen: \(deploymentId: string, bounds/, 'the open call carries a deployment id and bounds, nothing else');
  const panel = read('src/renderer/src/nexus/project/PreviewPanel.tsx');
  assert.match(panel, /api\.previewOpen\(id, b0\)/);
  assert.doesNotMatch(panel, /<iframe|<webview|loadURL/);
  assert.match(panel, /deployment\.url\) void openLoopbackUrl\(new URL\(deployment\.url\)\.origin\)/);
  // the page the user sees is wired in once, on the Try it page; nothing starts by itself
  assert.match(read('src/renderer/src/nexus/project/ProjectTry.tsx'), /<ProjectPreview projectId=\{projectId\} versionId=\{versionId\} newest=\{change \? \{ versionId: change\.versionId \} : null\} \/>/);
  const section = read('src/renderer/src/nexus/project/ProjectPreview.tsx');
  assert.equal((section.match(/void start\(\)/g) || []).length, 1, 'one start, from the button');
  assert.match(section, /onClick=\{\(\) => \{ setUpdated\(false\); void start\(\); \}\}/);
  assert.equal((section.match(/runPreviewChain\(/g) || []).length, 1);
  assert.ok(section.indexOf('runPreviewChain(base') > section.indexOf('const start = async'), 'no effect starts the chain: only the button\'s function does');
});

test('PV6 the helper is told to make an app runnable: standard library only, port 3000 on all addresses, /health, nexus.app.json, build to dist', () => {
  const p = systemPrompt({ hasSandbox: true, hasChangeset: true });
  for (const needle of ['RUNNABLE', 'standard library', 'no CDN', 'scripts.build', 'dist', 'scripts.start', 'port 3000 on 0.0.0.0', '/health', 'nexus.app.json',
    '"profile":"sde-node"', '"run":["node","src/server.js"]', '"port":3000', '"healthPath":"/health"', '"env":[]', 'ends by itself', 'before you register the change']) {
    assert.ok(p.includes(needle), needle);
  }
  assert.doesNotMatch(p.split('\n').find((l) => l.includes('RUNNABLE')), VENDOR, 'the new rule names no vendor');
  const skill = read('resources/skills/nexus-sde-app-manifest/SKILL.md');
  assert.match(skill, /## When the person asks for an app, a website or a web page/);
  for (const needle of ['0.0.0.0', 'GET /health', 'nexus.app.json', 'dist', "Node's standard library", 'CDN']) assert.ok(skill.includes(needle), needle);
});

test('PV7 the two hour limit is shown as a countdown, in plain words', () => {
  const NOW = 1_800_000_000_000;
  assert.equal(M.countdownText(NOW + 2 * 3_600_000, NOW), 'Stops by itself in 2 hours');
  assert.equal(M.countdownText(NOW + 80 * 60_000, NOW), 'Stops by itself in 1 hour 20 minutes');
  assert.equal(M.countdownText(NOW + 61 * 60_000, NOW), 'Stops by itself in 1 hour 1 minute');
  assert.equal(M.countdownText(NOW + 45 * 60_000, NOW), 'Stops by itself in 45 minutes');
  assert.equal(M.countdownText(NOW + 20_000, NOW), 'Stops by itself in 1 minute');
  assert.equal(M.countdownText(NOW - 5, NOW), 'Stopping now');
  assert.equal(M.countdownText(Number.NaN, NOW), 'Stopping now');
  assert.match(read('src/renderer/src/nexus/project/PreviewPanel.tsx'), /countdownText\(deployment\.endsAt, now\)/);
  assert.doesNotMatch(M.countdownText(NOW + 3_600_000, NOW), VENDOR);
});

test('PV8 full-stack in one container (live preview phase 3): the helper is told one process, an API, a SQLite file through a package with no native part; the fixtures are valid apps; the data is said to be temporary', () => {
  const p = systemPrompt({ hasSandbox: true, hasChangeset: true });
  const line = p.split('\n').find((l) => l.includes('RUNNABLE'));
  for (const needle of ['ONE process', '/api', 'data/app.db', 'node-sqlite3-wasm', 'no native part', 'no built-in SQLite', 'gone when the preview stops', '/health should also read the database']) {
    assert.ok(line.includes(needle), needle);
  }
  assert.doesNotMatch(line, VENDOR, 'the rule names no vendor');
  const skill = read('resources/skills/nexus-sde-app-manifest/SKILL.md');
  for (const needle of ['full-stack app', 'ONE process in ONE container', 'data/app.db', 'node-sqlite3-wasm', 'No second process']) assert.ok(skill.includes(needle), needle);
  assert.match(M.PREVIEW_LIMITS, /If the app saves data, it is kept only inside the safe space and is deleted when the preview stops/);
  const { appManifestErrors } = loadTs('src/main/nexus/validation/normalized.ts');
  for (const name of ['node-deps-app', 'node-fullstack-app']) {
    const dir = path.join(ROOT, 'test', 'fixtures', 'exec', name);
    assert.deepEqual(appManifestErrors(JSON.parse(fs.readFileSync(path.join(dir, 'nexus.app.json'), 'utf8'))), [], name);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(Object.keys(pkg.dependencies).length === 1 && !pkg.scripts.install && !pkg.scripts.postinstall, `${name}: one add-on, no install script`);
    assert.ok(/^\d+\.\d+\.\d+$/.test(Object.values(pkg.dependencies)[0]), `${name}: pinned`);
    assert.ok(!fs.existsSync(path.join(dir, 'package-lock.json')), `${name}: no lockfile (the lock-less install is what they prove)`);
  }
  const server = fs.readFileSync(path.join(ROOT, 'test/fixtures/exec/node-fullstack-app/src/server.js.tpl'), 'utf8');
  assert.match(server, /listen\(PORT, '0\.0\.0\.0'/); assert.match(server, /\/api\/notes/); assert.match(server, /db\.ping\(\)/);
});

test('the Preview section shows ONE short line and keeps the long explanation behind a closed "How it works" (it was a wall of text)', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus', 'project', 'ProjectPreview.tsx'), 'utf8');
  assert.match(src, /<p className="nx-muted">\{PREVIEW_INTRO\}<\/p>\s*<details className="nx-fb__more">\s*<summary>How it works<\/summary>\s*<p className="nx-muted">\{PREVIEW_LIMITS\}<\/p>\s*<\/details>/);
  assert.ok(!/<details[^>]*\bopen\b/.test(src.slice(src.indexOf('How it works') - 120, src.indexOf('How it works') + 40)), 'closed by default');
});
