'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { detectEnvironment, IDEAS, buildStartRequest, chosenEnvironment, startBlocker } = loadTs('src/renderer/src/nexus/start/startModel.ts');
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

test('start: one reason at a time, in the order the person fills the screen', () => {
  const ok = { text: 'Train a model', envId: 'ml', hasProject: true, assistant: 'ready' };
  assert.equal(startBlocker(ok), null);
  assert.equal(startBlocker({ ...ok, assistant: 'starting' }), null);
  assert.match(startBlocker({ ...ok, text: '   ' }), /Describe/);
  assert.match(startBlocker({ ...ok, envId: null }), /environment/);
  assert.match(startBlocker({ ...ok, hasProject: false }), /project/);
  assert.match(startBlocker({ ...ok, assistant: 'unavailable' }), /lead agent/);
  assert.match(startBlocker({ text: '', envId: null, hasProject: false, assistant: 'unavailable' }), /Describe/);
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
