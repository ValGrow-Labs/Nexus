'use strict';
// B2a Task 16: docs/nexus/platform-core.md Part III names the v9 objects exactly as the code does. The name list in
// section 32.6 equals V9_EXPECTED (same names, same order), the DDL block in section 32.2 equals V9_DDL, and the trigger
// and index tables of sections 32.3 and 32.4 name every v9 trigger and index and nothing else with a v9-style name.
// Plain node: schemaV9.ts loads through load-ts without opening a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/nexus/platform-core.md'), 'utf8').replace(/\r\n/g, '\n');
const { V9_EXPECTED, V9_DDL } = loadTs('src/main/nexus/db/schemaV9.ts');

/** The text from the heading line that starts with `start` up to the next heading line that starts with `end`. */
function between(start, end) {
  const lines = DOC.split('\n');
  const from = lines.findIndex((l) => l.startsWith(start));
  assert.ok(from >= 0, `heading "${start}" not found`);
  const rel = lines.slice(from + 1).findIndex((l) => l.startsWith(end));
  assert.ok(rel >= 0, `heading "${end}" not found after "${start}"`);
  return lines.slice(from + 1, from + 1 + rel).join('\n');
}
/** The body of the first fenced block of `lang` in `text`. */
function fenced(text, lang) {
  const m = new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n```').exec(text);
  assert.ok(m, `no \`\`\`${lang} block`);
  return m[1];
}
const listOf = (block, key) => {
  const line = block.split('\n').find((l) => l.startsWith(`${key}: `));
  assert.ok(line, `no "${key}:" line in the name list`);
  return line.slice(key.length + 2).split(',').map((s) => s.trim()).filter(Boolean);
};

test('Part III exists and section 32.6 lists exactly V9_EXPECTED, in order', () => {
  assert.ok(DOC.includes('\n# Part III: Schema v9 and B2a\n'));
  const block = fenced(between('### 32.6 ', '## 33. '), 'text');
  assert.deepEqual(listOf(block, 'tables'), Object.keys(V9_EXPECTED.tables));
  assert.deepEqual(listOf(block, 'indexes'), V9_EXPECTED.indexes);
  assert.deepEqual(listOf(block, 'triggers'), V9_EXPECTED.triggers);
  assert.equal(Object.keys(V9_EXPECTED.tables).length, 15);
  assert.equal(V9_EXPECTED.indexes.length, 23);
  assert.equal(V9_EXPECTED.triggers.length, 33);
});

test('section 32.2 holds V9_DDL verbatim', () => {
  const sql = fenced(between('### 32.2 ', '### 32.3 '), 'sql');
  assert.equal(sql, V9_DDL.replace(/^\n/, '').replace(/\n$/, ''));
});

test('sections 32.3 and 32.4 name every v9 trigger and index, and no other ix_, ux_ or tr_ name', () => {
  const triggers = between('### 32.3 ', '### 32.4 ');
  const indexes = between('### 32.4 ', '### 32.5 ');
  const named = (text, re) => [...new Set([...text.matchAll(re)].map((m) => m[1]))];
  const trNames = named(triggers, /`(tr_[a-z0-9_]+)`/g);
  const ixNames = named(indexes, /`((?:ix|ux)_[a-z0-9_]+)`/g);
  assert.deepEqual([...trNames].sort(), [...V9_EXPECTED.triggers].sort());
  assert.deepEqual([...ixNames].sort(), [...V9_EXPECTED.indexes].sort());
  // A v7 or v8 name in these two sections would be a copy error: every ix_/ux_/tr_ name there is a v9 one.
  for (const n of named(triggers + indexes, /`((?:ix|ux|tr)_[a-z0-9_]+)`/g)) {
    assert.ok(V9_EXPECTED.indexes.includes(n) || V9_EXPECTED.triggers.includes(n), `${n} is not a v9 name`);
  }
});

test('section 32.1 names every v9 table', () => {
  const tables = between('### 32.1 ', '### 32.2 ');
  for (const t of Object.keys(V9_EXPECTED.tables)) assert.ok(tables.includes(`\`${t}\``), `${t} missing from section 32.1`);
});

// ---------- B2a final review: Part III after Tasks 14 and 15, and the inlined peer-file text (carry 13, C2, C4) ----------

test('section 45 holds the full peer-file text inline (carry 13): the scripts, every test:focused file, and the index.ts lines', () => {
  const sec = between('## 45. ', '## 46. ');
  assert.doesNotMatch(sec, /\.superpowers|task-\d+-report/, 'no pointer to the git-ignored reports');
  assert.ok(sec.includes('"test:exec": "node tools/run-exec-tests.cjs",'));
  assert.ok(sec.includes('"fast-xml-parser": "5.11.2",'));
  const line = fenced(sec, 'text').trim().split(/\s+/);
  for (const f of ['test/nexus-ui-exec-models.test.cjs', 'test/nexus-lifecycle-rail.test.cjs', 'test/nexus-honesty-audit.test.cjs',
    'test/nexus-core-git-binary.test.cjs', 'test/nexus-core-docs-v9-names.test.cjs', 'test/nexus-core-runner.test.cjs', 'test/nexus-core-exec-entry.test.cjs']) {
    assert.ok(line.includes(f), `${f} is in the test:focused line`);
  }
  assert.equal(new Set(line).size, line.length, 'no file twice');
  for (const f of line) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  const ts = [...sec.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((m) => m[1]).join('\n');
  for (const s of ["import { startExecution, type ExecutionHandle } from './nexusExec/execWiring';", 'executionUnavailableReason: () => executionUnavailableReason',
    'exec: () => nexusExecution', 'isRepository: repositoryCheck', 'execution: persist.executionAvailable', "holdV9: process.env.NEXUS_DB_HOLD_V9 === '1',",
    "enableV9: process.env.NEXUS_ENABLE_V9 === '1' ? true : undefined,", 'void Promise.race([h.stop().catch(() => undefined), bound]).finally(() => app.quit());']) {
    assert.ok(ts.includes(s), `index.ts text: ${s}`);
  }
  assert.doesNotMatch(ts, /enableV9: false/);
  assert.equal((ts.match(/startExecution\(/g) || []).length, 1);
});

test('Part III describes the renderer that exists (C4): no "no renderer" claim, and every renderer file it names exists', () => {
  const part3 = DOC.slice(DOC.indexOf('\n# Part III: Schema v9 and B2a\n'));
  assert.doesNotMatch(part3, /No renderer code calls|no renderer (UI|code)|renderer UI exists/i);
  assert.ok(part3.includes('### 40.1 The renderer'));
  const table = between('## 31. ', '## 32. ');
  const rows = table.split('\n').filter((l) => l.startsWith('| `src/renderer/'));
  assert.ok(rows.length >= 6, 'the renderer rows are in the code table');
  for (const r of rows) {
    const cell = r.split('|')[1];
    const names = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const base = path.dirname(names[0].replace(/\/$/, ''));
    for (const n of names) {
      const full = n.startsWith('src/') ? n : path.posix.join(n.includes('/') ? 'src/renderer/src/nexus' : base, n);
      assert.ok(fs.existsSync(path.join(ROOT, full)), `${full} (named in section 31) exists`);
    }
  }
});

test('section 42 states the ruled disk gate (C2) in the renderer\'s own words', () => {
  const X = loadTs('src/renderer/src/nexus/data/executionModel.ts');
  const GIB = 2 ** 30;
  const a = X.availabilityFrom({ unavailable: null }, { ok: true, data: {
    db: { version: 9, platform: true, handoffs: true, execution: true }, registry: { valid: true, problems: 0 }, runner: { state: 'ready', attached: true, restarts: 0 },
    docker: { state: 'running', cpus: 8, memoryBytes: 8 * GIB }, images: [],
    disk: { dataHomeFreeBytes: 18 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'below_required' },
    problems: ['disk_low'], gpu: { detected: false, supported: false }, checkedAt: 1 } });
  assert.equal(a.kind, 'ready');
  const sec = between('## 42. ', '## 43. ');
  assert.ok(sec.includes(`"${a.advisories[0]}"`), 'the advisory sentence is quoted exactly');
  assert.match(sec, /Only "Prepare this kit" is unavailable/);
  assert.match(sec, /heavy actions are not disabled for this reason/);
  assert.doesNotMatch(sec, /blocks heavy execution below these limits/);
});
