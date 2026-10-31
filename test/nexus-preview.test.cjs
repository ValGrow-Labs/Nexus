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
    async start(step, actionId, inputs) { calls.push(['start', step, actionId, inputs]); return o.refuse === step ? { ok: false, text: 'Nexus refused.' } : { ok: true, jobId: `job-${step}` }; },
    async waitJob(jobId) { calls.push(['waitJob', jobId]); const step = jobId.slice(4); return o.jobFails === step ? { state: 'failed', outputs: [], why: null } : { state: 'completed', outputs: [`ver-${step}`], why: null }; },
    async waitVersion(v) { calls.push(['waitVersion', v]); return o.versionStatus ?? 'candidate'; },
    async latestOf(kind) { calls.push(['latestOf', kind]); return o.noLatest ? null : `latest-${kind}`; },
    async stopLive() { calls.push(['stopLive']); },
    async waitDeployment(jobId) { calls.push(['waitDeployment', jobId]); return o.deployFails ? { id: '', ok: false, why: null } : { id: 'dep-1', ok: true, why: null }; }
  };
  return c;
};

test('PV3 one press runs snapshot, build, assemble, start in order, each from the one before, and stops any earlier preview first', async () => {
  const c = fake(); const steps = [];
  const r = await M.runPreviewChain(c, (s) => steps.push(s));
  assert.deepEqual(r, { ok: true, deploymentId: 'dep-1' });
  assert.deepEqual(steps, ['snapshot', 'build', 'assemble', 'start']);
  assert.deepEqual(c.calls.filter((x) => x[0] === 'start').map((x) => [x[2], x[3]]), [
    ['sde.repository.snapshot', []],
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
  assert.deepEqual(c.calls.filter((x) => x[0] === 'start').map((x) => x[3]), [[], [{ versionId: 'latest-repository', slot: 'repository' }], [{ versionId: 'latest-build', slot: 'build' }], [{ versionId: 'latest-application', slot: 'application' }]]);
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
  assert.match(read('src/renderer/src/nexus/project/ProjectTry.tsx'), /<ProjectPreview projectId=\{projectId\} \/>/);
  const section = read('src/renderer/src/nexus/project/ProjectPreview.tsx');
  assert.equal((section.match(/void start\(\)/g) || []).length, 1, 'one start, from the button');
  assert.match(section, /onClick=\{\(\) => \{ void start\(\); \}\}/);
  assert.equal((section.match(/runPreviewChain\(/g) || []).length, 1);
  assert.ok(section.indexOf('runPreviewChain(client()') > section.indexOf('const start = async'), 'no effect starts the chain: only the button\'s function does');
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
