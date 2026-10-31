'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { resolveAssistantStatus } = loadTs('src/renderer/src/nexus/assistant/port.ts');
const { buildContextHeader } = loadTs('src/renderer/src/nexus/assistant/context.ts');
const { QUICK_ACTIONS, SUGGESTIONS } = loadTs('src/renderer/src/nexus/assistant/prompts.ts');
const { NEXUS_ICON_NAMES } = loadTs('src/renderer/src/nexus/iconNames.ts');

test('status: no lead agent → unavailable (never targets a missing id)', () => {
  const s = resolveAssistantStatus({ god: null, godStatus: 'ready', deliveryPaused: false });
  assert.equal(s.state, 'unavailable');
  assert.ok(s.reason.length > 0);
});

test('status: booting with an agent → starting, carries the target so sends can queue', () => {
  const s = resolveAssistantStatus({ god: { id: 'g', name: 'Lead' }, godStatus: 'booting', deliveryPaused: false });
  assert.deepEqual(s, { state: 'starting', target: { id: 'g', name: 'Lead', kind: 'lead-agent' } });
});

test('status: ready reflects delivery pause', () => {
  const s = resolveAssistantStatus({ god: { id: 'g', name: 'Lead' }, godStatus: 'ready', deliveryPaused: true });
  assert.deepEqual(s, { state: 'ready', target: { id: 'g', name: 'Lead', kind: 'lead-agent' }, deliveryPaused: true });
});

test('status: a lead agent whose terminal has ended is unavailable, so no request box queues to it', () => {
  const s = resolveAssistantStatus({ god: { id: 'g', name: 'Lead' }, godStatus: 'ready', deliveryPaused: false, exited: true });
  assert.equal(s.state, 'unavailable');
  assert.equal(s.reason, 'The lead AI helper has stopped. Open Agents to start it again.');
  assert.equal(resolveAssistantStatus({ god: { id: 'g', name: 'Lead' }, godStatus: 'ready', deliveryPaused: false, exited: false }).state, 'ready');
});

test('context header contains only provided facts', () => {
  assert.equal(buildContextHeader({}), null);
  assert.equal(buildContextHeader({ page: 'Home' }), null);
  assert.equal(buildContextHeader({ workspace: 'ML', page: 'Home' }), '[Nexus context: workspace ML; page Home]');
  assert.equal(
    buildContextHeader({ workspace: 'ML', project: { name: 'fraud', rootPath: 'C:\\repos\\fraud' }, page: 'Project' }),
    '[Nexus context: workspace ML; project fraud (C:\\repos\\fraud); page Project]'
  );
  assert.equal(buildContextHeader({ project: { name: 'x', rootPath: '/x' } }), '[Nexus context: project x (/x)]');
});

test('quick actions: every action acts; all icons exist', () => {
  const byId = Object.fromEntries(QUICK_ACTIONS.map((a) => [a.id, a]));
  assert.equal(byId['new-project'].kind, 'new-project');
  assert.equal(byId['analyze-dataset'].kind, 'prefill');
  assert.ok(QUICK_ACTIONS.every((a) => a.kind === 'new-project' || a.kind === 'prefill'));
  for (const a of QUICK_ACTIONS) assert.ok(NEXUS_ICON_NAMES.includes(a.icon), a.id);
  for (const s of SUGGESTIONS) { assert.ok(s.prompt.trim().length > 10, s.id); assert.ok(NEXUS_ICON_NAMES.includes(s.icon), s.id); }
});

test('the request box inside the AI helper dock always belongs to the project\'s AI helper, never the old lead agent, whichever workspace the project is filed under first', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus', f), 'utf8');
  const intent = src('intent/IntentLine.tsx');
  assert.match(intent, /const mode = dock && ctx\.project \? \(canAsk \? 'agent' : 'legacy'\)/, 'in the dock a project box is agent mode when it can ask');
  assert.match(intent, /const lockedBox = \(locked \|\| dock\) && mode !== 'agent'/, 'in the dock a box that cannot ask is locked, never sent to the lead agent');
  assert.match(src('agent/AgentPanel.tsx'), /<IntentLine inline compact dock /, 'the dock\'s box says it is the dock');
});

test('a disabled primary button (the request box before you type) keeps readable words: flat grey fill, grey text, no fading of the whole button', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus', 'styles', 'ui.css'), 'utf8');
  assert.match(css, /\.nx-btn--primary:disabled \{[^}\r\n]*opacity: 1;[^}\r\n]*background: var\(--nx-sunken\);[^}\r\n]*color: var\(--nx-text-3\);/);
});
