'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { detectEnvironment, IDEAS, PLAIN_IDEAS, buildStartRequest, chosenEnvironment, startBlocker, startTarget, startDomainId } = loadTs('src/renderer/src/nexus/start/startModel.ts');
const { parseHash, formatRoute } = loadTs('src/renderer/src/nexus/router/routes.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');

const id = (text) => detectEnvironment(text).id;

test('detect: common requests land in the right environment', () => {
  assert.equal(id('build a web app for invoices'), 'sde');
  assert.equal(id('Create a REST API'), 'sde');
  assert.equal(id('train a model to classify emails'), 'ml');
  assert.equal(id('fine-tune a CNN on my images'), 'dl');
  assert.equal(id('analyze sales data and build a dashboard'), 'data');
  assert.equal(id('write a literature review paper'), 'research');
  assert.equal(id('write end-to-end tests for checkout'), 'qa');
  assert.equal(id('design a landing page prototype'), 'uiux');
  assert.equal(id('deploy to kubernetes with a CI pipeline'), 'devops');
});

test('detect: reports confidence and the words that matched', () => {
  const d = detectEnvironment('train a model on the latest dataset');
  assert.equal(d.id, 'ml');
  assert.equal(d.confidence, 'strong');
  assert.ok(d.matched.includes('model') && d.matched.includes('dataset'));
  const weak = detectEnvironment('make something with a model');
  assert.equal(weak.confidence, 'weak');
});

test('detect: nothing recognisable returns none, never a guess', () => {
  assert.deepEqual(detectEnvironment('hello there'), { id: null, confidence: 'none', matched: [] });
  assert.deepEqual(detectEnvironment('   '), { id: null, confidence: 'none', matched: [] });
});

test('detect: only ever returns a workspace that exists', () => {
  for (const s of ['web app', 'model', 'dashboard', 'pipeline', 'prototype', 'tests', 'paper', 'neural network']) {
    const r = detectEnvironment(s);
    assert.ok(r.id === null || WORKSPACES.some((w) => w.id === r.id), `${s} → ${r.id}`);
  }
});

test('ideas: each chip fills a request that detects to its own environment', () => {
  assert.ok(IDEAS.length >= 5);
  for (const idea of IDEAS) assert.equal(id(idea.prompt), idea.expect, idea.label);
  for (const idea of PLAIN_IDEAS) assert.equal(id(idea.prompt), idea.expect, idea.label);
});

test('request: the context header names environment and project; the text is unchanged', () => {
  const r = buildStartRequest({ text: '  build a web app  ', workspaceLabel: 'SDE', project: { name: 'shop', rootPath: 'C:\\code\\shop' } });
  assert.equal(r.text, 'build a web app');
  assert.match(r.contextHeader, /workspace SDE/);
  assert.match(r.contextHeader, /project shop \(C:\\code\\shop\)/);
  assert.match(r.contextHeader, /page Start/);
});

test('environment: detection follows the words until the person picks one', () => {
  assert.equal(chosenEnvironment('Train a model to classify support emails', null), 'ml');
  assert.equal(chosenEnvironment('Train a model to classify support emails', 'dl'), 'dl');
  assert.equal(chosenEnvironment('', null), null);
  assert.equal(chosenEnvironment('hello there', null), null);
  assert.equal(chosenEnvironment('anything', 'not-a-workspace'), null);
});

test('start: Start is ready with a request and a project; the two reasons are plain; nothing else (not the environment, not the old lead agent) blocks it', () => {
  assert.equal(startBlocker({ text: 'Train a model', hasProject: true }), null);
  assert.equal(startBlocker({ text: 'Train a model', hasProject: true, assistant: 'unavailable', envId: null }), null, 'the old lead agent and an unmatched environment never block');
  assert.equal(startBlocker({ text: '   ', hasProject: true }), 'Type what you want.');
  assert.equal(startBlocker({ text: 'Train a model', hasProject: false }), 'Choose a project or a folder.');
  assert.equal(startBlocker({ text: '', hasProject: false }), 'Type what you want.', 'one reason at a time, the request first');
});

test('start: Machine learning is delivered (a new folder becomes a Machine learning project); a workspace that is not delivered starts as Software, with one plain line, and the text is carried over unchanged', () => {
  assert.deepEqual(startTarget('sde', 'Software'), { workspaceId: 'sde', note: null });
  assert.deepEqual(startTarget(null, null), { workspaceId: 'sde', note: null });
  assert.deepEqual(startTarget('ml', 'Machine learning'), { workspaceId: 'ml', note: null }, 'Machine learning is delivered: data upload and results exist');
  assert.equal(startDomainId('ml'), 'ai-ml');
  assert.equal(startDomainId('sde'), 'software-engineering');
  const dl = startTarget('dl', 'Deep learning');
  assert.equal(dl.workspaceId, 'sde');
  assert.equal(dl.note, 'Deep learning projects are coming later. Nexus will start this as a Software project.');
  const fs0 = require('node:fs'); const pg = fs0.readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer', 'src', 'nexus', 'start', 'StartPage.tsx'), 'utf8');
  assert.ok(pg.includes('startDomainId(startAt.workspaceId)') && !pg.includes("const domainId = 'software-engineering'"), 'a new folder takes its kind from where the work starts');
  assert.ok(pg.includes("nexusClient.participationAttach(res.project.id, 'sde')"), 'a new Machine learning project joins the workspace the AI helper works in, so the helper can start without a setup step');
  const fs = require('node:fs'); const page = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer', 'src', 'nexus', 'start', 'StartPage.tsx'), 'utf8');
  assert.ok(page.includes('useNexusUi.getState().setDraft(text.trim());') && page.includes('useNexusUi.getState().focusIntent();'), 'the typed words are put in the AI helper’s request box and focused, not sent');
  assert.ok(!page.includes("status.state === 'unavailable' ?") && !page.includes('Start with the lead agent') && !page.includes('Lead agent ·') && !page.includes('Ctrl + Enter'), 'no state depends on the old lead agent; no keyboard hint');
  assert.ok(page.includes('disabled={busy || !!blocker}') && page.includes('Nexus will set up Git in this new folder so it can track changes.'));
  assert.ok(page.includes('Your request goes to the AI helper') && page.includes("The project opens so you can follow the AI helper's work"));
  assert.ok(!page.includes('Send to the lead AI helper instead') && !page.includes('useAssistant'), 'a request never goes to the old lead agent from Start');
  assert.equal((page.match(/<span>Start<\/span>/g) ?? []).length, 1, 'exactly one Start button on the page');
  assert.ok(page.includes("'Choose folder'") && !page.includes('nx-wb__cta'), 'one Start (the composer’s); the right side has the folder button instead of a second Start');
  assert.ok(page.includes('usePendingStart.getState().hand(target.id, text);'), 'Start begins the build: the project page sends the words to its AI helper once it can take them');
  assert.ok(!/useAssistant|assistant\/|port\.send|queuedMessage|lead AI helper|lead agent/i.test(page), 'Start has no path to the old lead helper');
  assert.ok(page.includes('markHandoff();'), 'Start hands focus to the request box that opens on the project page');
});

test('routes: the old environment picker is gone; #/browse opens the Workspaces list, and Start links there', () => {
  assert.deepEqual(parseHash('#/browse'), { name: 'workspaces' }, 'an old link never dead-ends');
  assert.deepEqual(parseHash('#/browse/'), { name: 'workspaces' });
  assert.equal(formatRoute({ name: 'workspaces' }), '#/workspaces');
  assert.deepEqual(parseHash('#/'), { name: 'home' });
  const fs = require('node:fs'); const path = require('node:path');
  const nexus = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
  assert.ok(fs.readFileSync(path.join(nexus, 'start', 'StartPage.tsx'), 'utf8').includes("navigate({ name: 'workspaces' })"), 'Browse all environments goes to the Workspaces page');
  const routeView = fs.readFileSync(path.join(nexus, 'routes', 'RouteView.tsx'), 'utf8');
  assert.ok(!routeView.includes('LauncherPage') && !routeView.includes("'browse'"));
  for (const gone of ['LauncherPage.tsx', 'TileScene.tsx', 'indexModel.ts', 'wallModel.ts']) assert.ok(!fs.existsSync(path.join(nexus, 'launcher', gone)), `${gone} is deleted`);
  assert.ok(!fs.existsSync(path.join(nexus, 'styles', 'launcher.css')) && !fs.readFileSync(path.join(nexus, 'styles', 'index.css'), 'utf8').includes('launcher.css'));
});
