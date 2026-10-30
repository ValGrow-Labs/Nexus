'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { leadAgentRun, runsFor, isRunLive } = loadTs('src/renderer/src/nexus/runs/runModel.ts');
const req = { id: 'r1', text: 'Run the tests and fix failures', sentAt: 1 };
const states = (r) => Object.fromEntries(r.stages.map((s) => [s.id, s.state]));
const base = { request: req, queued: false, delivered: false, isLatestDelivered: false, agentPresent: true, agentStatus: 'idle', blocked: false };
const run = (o) => leadAgentRun({ ...base, ...o });

test('queued request: context done, execute pending, the rest unreported', () => {
  const r = run({ queued: true });
  assert.deepEqual(states(r), { context: 'done', plan: 'unreported', execute: 'pending', output: 'unreported', review: 'unreported' });
  assert.equal(r.headline, 'Waiting for the lead AI helper to pick it up');
});

test('latest delivered and working: execute active', () => {
  const r = run({ delivered: true, isLatestDelivered: true, agentStatus: 'working' });
  assert.equal(states(r).execute, 'active');
  assert.equal(r.headline, 'The lead AI helper is working on it');
  assert.equal(states(run({ delivered: true, isLatestDelivered: true, agentStatus: 'thinking' })).execute, 'active');
});

test('latest delivered and blocked: waiting for input in the terminal', () => {
  const r = run({ delivered: true, isLatestDelivered: true, agentStatus: 'blocked', blocked: true });
  assert.equal(states(r).execute, 'waiting');
  assert.equal(r.needsInput, true);
  assert.equal(r.headline, 'The lead AI helper is waiting for you. Open Agents to answer it');
});

test('delivered and idle: no claim that the work finished', () => {
  const r = run({ delivered: true, isLatestDelivered: true, agentStatus: 'idle' });
  assert.equal(states(r).execute, 'unreported');
  assert.equal(r.headline, 'Handed to the lead AI helper. Open Agents to see its reply');
});

test('delivered but not the latest delivery: the agent’s live status is not claimed', () => {
  for (const o of [{ agentStatus: 'working' }, { agentStatus: 'blocked', blocked: true }]) {
    const r = run({ delivered: true, isLatestDelivered: false, ...o });
    assert.equal(states(r).execute, 'unreported');
    assert.equal(r.needsInput, false);
    assert.equal(r.headline, 'Handed to the lead AI helper. Open Agents to see its reply');
  }
});

test('left the queue without delivery (removed, cleared or dropped): never "delivered"', () => {
  const r = run({ queued: false, delivered: false, agentStatus: 'working' });
  assert.equal(states(r).execute, 'unreported');
  assert.equal(r.headline, 'It was taken off the waiting list before the lead AI helper got it. Send it again');
});

test('agent offline: still queued, never working', () => {
  const r = run({ queued: true, agentPresent: false, agentStatus: null });
  assert.equal(r.agentOffline, true);
  assert.equal(states(r).execute, 'pending');
  assert.equal(r.headline, 'Waiting. The lead AI helper is not running. Open Agents to start it');
});

test('agent gone and message neither queued nor delivered: not tracked', () => {
  const r = run({ agentPresent: false, agentStatus: null });
  assert.equal(states(r).execute, 'unreported');
  assert.equal(r.agentOffline, true);
  assert.equal(r.headline, 'Nexus can no longer follow this. The lead AI helper it went to is not running');
});

test('title is the request text, trimmed to 80 characters', () => {
  const r = run({ request: { ...req, text: 'x'.repeat(120) }, queued: true });
  assert.equal(r.title.length, 80);
});

test('runsFor: queued from the queue, delivered from the delivery record, live status only for the latest delivery', () => {
  const reqs = [
    { id: 'a', agentId: 'g', queuedMessageId: 'q1', text: 'delivered earlier', sentAt: 1 },
    { id: 'b', agentId: 'g', queuedMessageId: 'q2', text: 'latest delivered', sentAt: 2 },
    { id: 'c', agentId: 'g', queuedMessageId: 'q3', text: 'still queued', sentAt: 3 },
    { id: 'd', agentId: 'g', queuedMessageId: 'q4', text: 'removed by the user', sentAt: 4 }
  ];
  const agents = [{ id: 'g', status: 'working', running: true, blocked: false }];
  const delivery = { deliveredIds: { q1: true, q2: true }, lastDelivered: { g: 'q2' } };
  const [a, b, c, d] = runsFor(reqs, agents, { g: [{ id: 'q3' }] }, delivery);
  assert.equal(states(a).execute, 'unreported');
  assert.equal(states(b).execute, 'active');
  assert.equal(states(c).execute, 'pending');
  assert.equal(d.headline, 'It was taken off the waiting list before the lead AI helper got it. Send it again');
  assert.deepEqual([a, b, c, d].map(isRunLive), [false, true, true, false]);
});

test('runsFor: a later non-intent delivery takes the live status away from the intent request', () => {
  const reqs = [{ id: 'a', agentId: 'g', queuedMessageId: 'q1', text: 'mine', sentAt: 1 }];
  const agents = [{ id: 'g', status: 'blocked', running: true, blocked: true }];
  const [a] = runsFor(reqs, agents, {}, { deliveredIds: { q1: true, other: true }, lastDelivered: { g: 'other' } });
  assert.equal(states(a).execute, 'unreported');
  assert.equal(a.needsInput, false);
  const [a2] = runsFor(reqs, agents, {}, { deliveredIds: { q1: true }, lastDelivered: { g: 'q1' } });
  assert.equal(a2.needsInput, true);
});
