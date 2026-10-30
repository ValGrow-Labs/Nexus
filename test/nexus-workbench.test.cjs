'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const m = loadTs('src/renderer/src/nexus/agents/workbench/workbenchModel.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('every agent opens on the terminal; only the lead gets coordination sections', () => {
  assert.deepEqual(m.sectionsFor({ isLead: false, showHistory: true }).map((s) => s.id), ['terminal', 'git', 'messages', 'traces']);
  const lead = m.sectionsFor({ isLead: true, showHistory: false }).map((s) => s.id);
  assert.equal(lead[0], 'terminal');
  for (const id of ['team', 'requests', 'tasks', 'needs-you', 'activity', 'triggers', 'memory', 'graph', 'skills', 'workers']) assert.ok(lead.includes(id), id);
  assert.ok(!lead.includes('history'));
  assert.ok(m.sectionsFor({ isLead: true, showHistory: true }).some((s) => s.id === 'history'));
  assert.equal(m.initialSection({ isLead: false, stored: 'git' }), 'git');
  assert.equal(m.initialSection({ isLead: false, stored: 'team' }), 'terminal');
  assert.equal(m.initialSection({ isLead: true, stored: null }), 'terminal');
});

test('legacy tab requests land on a workbench section', () => {
  assert.equal(m.sectionForRequest('floor'), 'requests');
  assert.equal(m.sectionForRequest('human'), 'needs-you');
  assert.equal(m.sectionForRequest('trigger-history'), 'history');
  for (const t of ['terminal', 'tasks', 'triggers', 'memory', 'graph', 'activity', 'skills', 'workers']) assert.equal(m.sectionForRequest(t), t);
  assert.equal(m.sectionForRequest('nonsense'), null);
});

test('labels carry no legacy vocabulary', () => {
  for (const s of m.WORKBENCH_SECTIONS) assert.doesNotMatch(s.label, /floor|hive|god|command center|ask me|monitor|dispatch/i, s.id);
});

test('delivery control covers every agent and says what it does', () => {
  assert.deepEqual(m.deliveryTargets([{ id: 'god' }, { id: 'b1' }, { id: 'b2' }]), ['god', 'b1', 'b2']);
  assert.deepEqual(m.deliveryLabel(false), { text: 'Pause messages', title: 'Messages you queued are sent to every AI helper automatically. Pause to hold them back.' });
  assert.deepEqual(m.deliveryLabel(true), { text: 'Resume messages', title: 'Messages you queued are on hold for every AI helper. Resume to send them automatically.' });
});

test('one terminal mount per pty, keyed by generation, with the fullscreen guard', () => {
  const src = read('src/renderer/src/nexus/agents/workbench/WorkbenchTerminal.tsx');
  assert.equal((src.match(/<PtyTerminalView/g) || []).length, 1);
  assert.match(src, /key=\{terminalInstanceKey\(agent\.ptyId, agent\.terminalGeneration\)\}/);
  assert.match(src, /fullscreenAgentId === agent\.id && !fullscreen/);
  assert.match(src, /<MessageQueueComposer agent=\{agent\}/);
  assert.match(src, /historyAdd\(/);
  assert.equal((read('src/renderer/src/nexus/agents/workbench/AgentWorkbench.tsx').match(/usePtyParser\(/g) || []).length, 1);
});

test('the workbench is Nexus-native: no pixel chrome, no Command Center mount', () => {
  const dir = path.join(__dirname, '..', 'src/renderer/src/nexus/agents/workbench');
  for (const f of fs.readdirSync(dir)) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /components\/Pixel|PixelPanel|PixelButton|PixelBadge/, f);
  assert.doesNotMatch(read('src/renderer/src/components/FullscreenTerminal.tsx'), /<CommandCenterPanel/);
  assert.doesNotMatch(read('src/renderer/src/nexus/agents/AgentsPage.tsx'), /AgentDetailPanel/);
});
