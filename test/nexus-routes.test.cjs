'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { parseHash, formatRoute, routeTitle } = loadTs('src/renderer/src/nexus/router/routes.ts');

test('parseHash: every route', () => {
  assert.deepEqual(parseHash(''), { name: 'home' });
  assert.deepEqual(parseHash('#'), { name: 'home' });
  assert.deepEqual(parseHash('#/'), { name: 'home' });
  assert.deepEqual(parseHash('#/workspaces'), { name: 'workspaces' });
  assert.deepEqual(parseHash('#/w/ml'), { name: 'workspace', id: 'ml' });
  assert.deepEqual(parseHash('#/projects'), { name: 'projects' });
  assert.deepEqual(parseHash('#/p/proj-1'), { name: 'project', id: 'proj-1', tool: 'bench' });
  assert.deepEqual(parseHash('#/artifacts'), { name: 'artifacts' });
  assert.deepEqual(parseHash('#/handoffs'), { name: 'handoffs' });
  assert.deepEqual(parseHash('#/deployments'), { name: 'deployments' });
  assert.deepEqual(parseHash('#/agents'), { name: 'agents' });
  assert.deepEqual(parseHash('#/welcome'), { name: 'welcome' });
});

test('parseHash: tolerant of trailing slashes and missing leading slash', () => {
  assert.deepEqual(parseHash('#/projects/'), { name: 'projects' });
  assert.deepEqual(parseHash('#projects'), { name: 'projects' });
});

test('parseHash: bad input is not-found, never a throw', () => {
  assert.deepEqual(parseHash('#/w/unknown'), { name: 'not-found', path: '/w/unknown' });
  assert.deepEqual(parseHash('#/p/'), { name: 'not-found', path: '/p' });
  assert.deepEqual(parseHash('#/nope/x'), { name: 'not-found', path: '/nope/x' });
  assert.deepEqual(parseHash('#/p/%E0%A4%A'), { name: 'not-found', path: '/p/%E0%A4%A' }); // malformed escape
});

test('ids are URL-decoded and round-trip through formatRoute', () => {
  assert.deepEqual(parseHash('#/p/a%2Fb%20c'), { name: 'project', id: 'a/b c', tool: 'bench' });
  const routes = [
    { name: 'home' }, { name: 'workspaces' }, { name: 'workspace', id: 'uiux' }, { name: 'projects' },
    { name: 'project', id: 'a/b c', tool: 'bench' }, { name: 'artifacts' }, { name: 'handoffs' }, { name: 'deployments' }, { name: 'agents' }, { name: 'welcome' }
  ];
  for (const r of routes) assert.deepEqual(parseHash(formatRoute(r)), r);
  assert.equal(formatRoute({ name: 'home' }), '#/');
});

test('routeTitle gives a human page label', () => {
  assert.equal(routeTitle({ name: 'home' }), 'Home');
  assert.equal(routeTitle({ name: 'workspace', id: 'ml' }), 'Machine learning workspace');
  assert.equal(routeTitle({ name: 'agents' }), 'Agents');
});

test('parseHash: project tools', () => {
  assert.deepEqual(parseHash('#/p/proj-1'), { name: 'project', id: 'proj-1', tool: 'bench' });
  assert.deepEqual(parseHash('#/p/proj-1/changes'), { name: 'project', id: 'proj-1', tool: 'changes' });
  assert.deepEqual(parseHash('#/p/proj-1/plan'), { name: 'project', id: 'proj-1', tool: 'completion' });
  assert.deepEqual(parseHash('#/p/proj-1/runs'), { name: 'project', id: 'proj-1', tool: 'runs' });
});

test('parseHash: unknown tool and unknown workspace are not found', () => {
  assert.equal(parseHash('#/p/proj-1/deploy').name, 'not-found');
  assert.equal(parseHash('#/w/robotics').name, 'not-found');
  assert.equal(parseHash('#/p/proj-1/changes/extra').name, 'not-found');
});

test('formatRoute: bench is the default and is omitted', () => {
  assert.equal(formatRoute({ name: 'project', id: 'a b', tool: 'bench' }), '#/p/a%20b');
  assert.equal(formatRoute({ name: 'project', id: 'a', tool: 'changes' }), '#/p/a/changes');
});

test('routeTitle: workspace titles come from the registry', () => {
  assert.equal(routeTitle({ name: 'workspace', id: 'ml' }), 'Machine learning workspace');
  assert.equal(routeTitle({ name: 'project', id: 'x', tool: 'changes' }), 'Suggested changes');
});

// ---------- Task 12: artifacts and handoffs take an optional record id ----------

const ID = '01J9ZQ3V4K5M6N7P8Q9R0STVWX';

test('#/artifacts/<id> and #/handoffs/<id> round-trip', () => {
  assert.deepEqual(parseHash(`#/artifacts/${ID}`), { name: 'artifacts', id: ID });
  assert.deepEqual(parseHash(`#/handoffs/${ID}`), { name: 'handoffs', id: ID });
  assert.deepEqual(parseHash(`#/artifacts/${ID}/`), { name: 'artifacts', id: ID });
  for (const r of [{ name: 'artifacts', id: ID }, { name: 'handoffs', id: ID }, { name: 'artifacts' }, { name: 'handoffs' }]) {
    assert.deepEqual(parseHash(formatRoute(r)), r);
  }
  assert.equal(formatRoute({ name: 'artifacts', id: ID }), `#/artifacts/${ID}`);
  assert.equal(formatRoute({ name: 'artifacts' }), '#/artifacts');
  assert.equal(routeTitle({ name: 'artifacts' }), 'Saved items');
  assert.equal(routeTitle({ name: 'artifacts', id: ID }), 'Saved item');
  assert.equal(routeTitle({ name: 'handoffs', id: ID }), 'Handoff');
});

test('a malformed artifact or handoff id is not found', () => {
  for (const bad of ['x', ID.toLowerCase(), ID.slice(1), `${ID}0`, ID.replace('Z', 'U'), ID.replace('Z', 'I'), '..', '%E0%A4%A', `${ID}%2Fx`]) {
    assert.equal(parseHash(`#/artifacts/${bad}`).name, 'not-found', bad);
    assert.equal(parseHash(`#/handoffs/${bad}`).name, 'not-found', bad);
  }
  assert.equal(parseHash(`#/artifacts/${ID}/extra`).name, 'not-found');
  assert.equal(parseHash(`#/deployments/${ID}`).name, 'not-found');
  assert.equal(parseHash(`#/projects/${ID}`).name, 'not-found');
});

test('the old routes still parse exactly as before', () => {
  assert.deepEqual(parseHash('#/artifacts'), { name: 'artifacts' });
  assert.ok(!('id' in parseHash('#/artifacts')));
  assert.deepEqual(parseHash('#/handoffs'), { name: 'handoffs' });
  assert.deepEqual(parseHash('#/deployments'), { name: 'deployments' });
  assert.deepEqual(parseHash('#/p/proj-1/changes'), { name: 'project', id: 'proj-1', tool: 'changes' });
  assert.deepEqual(parseHash('#/w/ml'), { name: 'workspace', id: 'ml' });
});
