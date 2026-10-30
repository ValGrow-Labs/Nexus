// test/nexus-reachability.test.cjs
// B0a exit: identity guard at zero, no dead legacy tab requests, memory and
// settings one click away, and the Nexus workbench/agents files on tokens only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const LEAKS = require('./nexus-identity-leaks.json');
const m = loadTs('src/renderer/src/nexus/agents/workbench/workbenchModel.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

test('B0a exit: no known identity leaks remain; only reasoned allowlist entries', () => {
  assert.deepEqual(LEAKS.knownLeaks, {});
  for (const a of LEAKS.allowlist) assert.ok(a.reason.length >= 20);
});

test('every legacy tab request in the app lands on a workbench section', () => {
  const src = walk(path.join(__dirname, '..', 'src/renderer/src')).filter((f) => /\.tsx?$/.test(f) && !f.includes(`${path.sep}scene${path.sep}`));
  for (const f of src) for (const [, tab] of fs.readFileSync(f, 'utf8').matchAll(/requestCommandCenterTab\('([^']+)'\)/g))
    assert.notEqual(m.sectionForRequest(tab), null, `${f}: ${tab}`);
});

test('semantic memory and settings stay one click away', () => {
  const agents = read('src/renderer/src/nexus/agents/AgentsPage.tsx');
  assert.match(agents, /MemoryPanel|openLeadSection\('memory'\)/);
  assert.match(agents, /<MemoryPanel defaultOpen \/>/);
  const palette = read('src/renderer/src/nexus/chrome/paletteIndex.ts');
  assert.match(palette, /Settings/);
  assert.match(palette, /label: 'Open settings: Memory & Knowledge'.*settingsSection: 'Memory & Knowledge'/);
  assert.match(palette, /label: 'Agents: Memory'.*action: 'openSemanticMemory'/);
  const run = read('src/renderer/src/nexus/chrome/CommandPalette.tsx');
  assert.match(run, /actions\.openSettings\(e\.settingsSection\)/);
  assert.match(run, /openSemanticMemory/);
  // Every palette settings section exists in Settings.
  const sections = read('src/renderer/src/components/SettingsModal.tsx').match(/const NAV_SECTIONS: Section\[\] = \[([^\]]+)\]/)[1];
  for (const [, s] of palette.matchAll(/settingsSection: '([^']+)'/g)) assert.ok(sections.includes(`'${s}'`), s);
});

test('new Nexus files use tokens, not legacy colours or pixel chrome', () => {
  const dir = path.join(__dirname, '..', 'src/renderer/src/nexus');
  for (const f of walk(dir).filter((f) => /workbench|agents[\\/]|Completion|hosted/.test(f) && /\.(tsx|css)$/.test(f))) {
    const s = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /--cth-|#[0-9a-fA-F]{3,6}\b|drop-shadow\(\s*4px 4px 0/, f);
    assert.doesNotMatch(s, /Pixel(Panel|Button|Badge)/, f);
  }
});

test('restyled hosted panels and Manage projects carry no pixel chrome', () => {
  for (const f of ['components/MemoryPanel.tsx', 'components/SkillsTab.tsx', 'components/WorkersTab.tsx',
    'components/MemoryGraphPanel.tsx', 'components/triggers/ui.tsx', 'components/triggers/TriggersTab.tsx',
    'components/triggers/OrgSection.tsx', 'components/triggers/TriggerHistoryTab.tsx',
    'project/ProjectSummaryCard.tsx', 'project/ProjectDashboardModal.tsx']) {
    const s = read(`src/renderer/src/${f}`);
    assert.doesNotMatch(s, /Pixel(Panel|Button|Badge)/, f);
    assert.doesNotMatch(s, /\d+px \d+px 0 var/, `${f}: hard offset shadow`);
  }
  const card = read('src/renderer/src/project/ProjectSummaryCard.tsx');
  assert.doesNotMatch(card, /HEALTH:|healthScore\}%/);
  assert.match(card, /Repo health <strong>\{health\} of 100<\/strong>/);
});

test('the boot splash and favicon no longer use the old pixel portrait', () => {
  const main = read('src/renderer/src/main.tsx');
  assert.doesNotMatch(main, /@brand\/|logo\.png/);
  assert.match(main, /nx-boot-mark/);
});
