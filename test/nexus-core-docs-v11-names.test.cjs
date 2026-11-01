'use strict';
// Part V of docs/nexus/platform-core.md (schema v11) names only things the code has, and says what the code does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DOC = read('docs/nexus/platform-core.md');
const PART5 = DOC.slice(DOC.indexOf('\n# Part V: Schema v11'));

test('DOC11-1 Part V has sections 64 and 65 in order, the contents point at it, and its links resolve', () => {
  assert.ok(PART5.length > 1000);
  const heads = PART5.split('\n').filter((l) => /^## \d+\. /.test(l)).map((l) => Number(/^## (\d+)\./.exec(l)[1]));
  assert.deepEqual(heads, [64, 65]);
  assert.match(DOC, /\*\*\[Part V\]\(#part-v-schema-v11-and-the-live-preview-of-a-change\) \(sections 64 and 65\)\*\*/);
  const slug = (h) => h.replace(/^#+\s*/, '').toLowerCase().replace(/[^a-z0-9 _\-]/g, '').replace(/ /g, '-');
  const slugs = new Set(DOC.split('\n').filter((l) => /^#{1,3} /.test(l)).map(slug));
  for (const m of PART5.matchAll(/\]\(#([a-z0-9-]+)\)/g)) assert.ok(slugs.has(m[1]), `link target #${m[1]} exists`);
  assert.ok(slugs.has('part-v-schema-v11-and-the-live-preview-of-a-change'));
});

test('DOC11-2 every name Part V gives is in the code, and the claims match it', () => {
  const db = read('src/main/db.ts');
  const v11 = read('src/main/nexus/db/schemaV11.ts');
  const trig = read('src/main/nexus/db/schemaV11Trigger.ts');
  for (const n of ['V11_ENABLED_BY_DEFAULT = false', 'NEXUS_ENABLE_V11', 'NEXUS_DB_HOLD_V11', 'changePreviewAvailable', 'lastMigrationV11', 'changePreviewUnavailableReason']) {
    assert.ok(PART5.includes(n.split(' ')[0]), `${n} is in Part V`);
  }
  assert.match(db, /export const V11_ENABLED_BY_DEFAULT = false;/);
  assert.match(read('src/main/index.ts'), /NEXUS_ENABLE_V11/); assert.match(db, /NEXUS_DB_HOLD_V11/);
  assert.match(db, /get changePreviewAvailable\(\)/); assert.match(db, /get lastMigrationV11\(\)/); assert.match(db, /get changePreviewUnavailableReason\(\)/);
  for (const r of ['not_enabled', 'held', 'auto_held', 'backup_failed', 'failed', 'shape']) assert.ok(PART5.includes('`' + r + '`'), r);
  assert.match(db, /export type ChangePreviewUnavailableReason = 'not_enabled' \| 'held' \| 'auto_held' \| 'backup_failed' \| 'failed' \| 'shape';/);
  assert.match(v11, /DROP TRIGGER IF EXISTS tr_deployments_insert;/);
  assert.match(trig, /a\.kind IN \('application','inference_service','change_set'\)/);
  assert.ok(PART5.includes('src/main/nexus/db/schemaV11.ts') && PART5.includes('src/main/nexus/db/schemaV11Trigger.ts'));
  for (const f of ['src/main/nexus/db/schemaV11.ts', 'src/main/nexus/db/schemaV11Trigger.ts', 'test/nexus-db-v11-migration.test.cjs', 'tools/nexus-db-restore.cjs']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  assert.match(PART5, /harness-v10-<UTC>\.db/);
  assert.match(PART5, /\.v11-failures\.json/);
  assert.match(db, /platformFailureMarkerPath\(dbFile, 11\)/);
  // The text says nothing is changed beyond the trigger, and the frozen texts are not edited.
  assert.match(PART5, /one trigger is replaced and nothing else changes/);
  assert.match(PART5, /`V9_DDL` and `V10_DDL` stay as they are/);
});
