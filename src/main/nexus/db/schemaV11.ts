/**
 * Schema v11 (live preview of a suggested change): the ONE trigger `tr_deployments_insert` is replaced so a deployment's subject may also be a
 * `change_set` version. No table, column, index, seed or other trigger changes, and no row is written beyond the migration record and its activity row.
 *
 * Why a migration: v9 froze `tr_deployments_insert` with the subject kinds `application` and `inference_service`. A live preview of a change that is
 * not yet in the project has the change-set version as its subject. The new trigger is the v9 text word for word with `change_set` added to that
 * one list (src/main/nexus/db/schemaV11Trigger.ts) and nothing broader: a deployment whose subject is any other kind is still refused.
 *
 * V11_DDL is shipped migration text once v11 runs on a real database: never edit it then - later changes go in a new migration. Plain template
 * literal, no interpolation. The one non-additive statement is the `DROP TRIGGER IF EXISTS` of that one trigger, immediately followed by its replacement
 * in the same transaction.
 *
 * applyV11 runs inside the caller's single BEGIN IMMEDIATE transaction:
 *   exact v7 shape -> exact v8 shape -> v9 shape (the trigger as v9 OR as v11) -> exact v10 shape -> v11 pre-check ->
 *   DDL -> nexus_migrations record -> one activity row (only when the record is new) -> verifyV11.
 * Any throw rolls the whole step back (SQLite restores the dropped trigger with it). user_version is the caller's (db.ts).
 */
import type Database from 'better-sqlite3';
import type { MigrationContext } from './migrationTypes';
import { ddlObjects, normaliseSql, v7ShapeProblem } from './schemaV7';
import { v8ShapeProblem } from './schemaV8';
import { v9ShapeProblem, V9_DDL } from './schemaV9';
import { v10ShapeProblem } from './schemaV10';
import { V11_TRIGGER_DDL, V11_TRIGGER_NAME, V11_TRIGGER_SQL } from './schemaV11Trigger';
import { appendActivityRow } from '../activity/writer';

export const V11_DDL: string = `
DROP TRIGGER IF EXISTS tr_deployments_insert;
${V11_TRIGGER_DDL}`;

/** The v9 definition of the replaced trigger (from the frozen V9_DDL), normalised. */
const V9_TRIGGER_SQL: string = (() => {
  const o = ddlObjects(V9_DDL).find((x) => x.name === V11_TRIGGER_NAME);
  if (!o) throw new Error('v9 has no tr_deployments_insert');
  return o.sql;
})();

/** Not compared with the pre-counts: the migration itself writes them (or SQLite does). */
const COUNT_EXEMPT = new Set(['activity', 'nexus_migrations', 'sqlite_sequence']);
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const countOf = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n;

function storedTrigger(db: Database.Database): { sql: string; table: string } | null {
  const r = db.prepare("SELECT sql, tbl_name AS tbl FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(V11_TRIGGER_NAME) as
    { sql: string; tbl: string } | undefined;
  return r ? { sql: normaliseSql(r.sql), table: r.tbl } : null;
}

/**
 * The first difference between the database and the v11 definition, or null: the trigger exists on `deployments` with exactly the v11 text.
 * With `exact` false the v9 text is accepted too (the pre-check before the step runs).
 */
export function v11ShapeProblem(db: Database.Database, exact = true): string | null {
  const t = storedTrigger(db);
  if (!t) return `trigger ${V11_TRIGGER_NAME} is missing`;
  if (t.table !== 'deployments') return `${V11_TRIGGER_NAME} is on ${t.table}, expected deployments`;
  if (t.sql === V11_TRIGGER_SQL) return null;
  if (!exact && t.sql === V9_TRIGGER_SQL) return null;
  return `trigger ${V11_TRIGGER_NAME} has a different definition`;
}

/** Throws on the first mismatch. Runs inside the v11 transaction, so a throw rolls everything back. */
export function verifyV11(db: Database.Database, pre: MigrationContext): void {
  const v7 = v7ShapeProblem(db, true);
  if (v7) throw new Error(`v11 verification failed: the v7 shape changed: ${v7}`);
  const v8 = v8ShapeProblem(db, true);
  if (v8) throw new Error(`v11 verification failed: the v8 shape changed: ${v8}`);
  const v9 = v9ShapeProblem(db, true, { v11: true });
  if (v9) throw new Error(`v11 verification failed: the v9 shape changed: ${v9}`);
  const v10 = v10ShapeProblem(db, true);
  if (v10) throw new Error(`v11 verification failed: the v10 shape changed: ${v10}`);
  const shape = v11ShapeProblem(db, true);
  if (shape) throw new Error(`v11 verification failed: ${shape}`);
  const fk = db.pragma('foreign_key_check') as Array<{ table: string }>;
  if (fk.length) {
    throw new Error(`v11 verification failed: foreign_key_check reports ${fk.length} row(s) in ${[...new Set(fk.map((r) => r.table))].join(', ')}`);
  }
  if (pre.preCounts) {
    for (const [table, before] of Object.entries(pre.preCounts)) {
      if (COUNT_EXEMPT.has(table)) continue;
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        throw new Error(`v11 verification failed: table ${table} is missing`);
      }
      const after = countOf(db, table);
      if (after !== before) throw new Error(`v11 verification failed: ${table} has ${after} rows, expected ${before}`);
    }
  }
}

/**
 * MIGRATIONS[10]. Sits only on an exact v7 + v8 + v9 + v10 whose `tr_deployments_insert` is the v9 text (or already the v11 text).
 * Idempotent: on a database that already has the v11 trigger it changes nothing (`recorded` is false).
 */
export function applyV11(db: Database.Database, ctx: MigrationContext): { triggers: number; recorded: boolean } {
  const v7 = v7ShapeProblem(db, true);
  if (v7) throw new Error(`v11 needs an exact v7 shape: ${v7}`);
  const v8 = v8ShapeProblem(db, true);
  if (v8) throw new Error(`v11 needs an exact v8 shape: ${v8}`);
  const v9 = v9ShapeProblem(db, true, { v11: true });
  if (v9) throw new Error(`v11 needs an exact v9 shape: ${v9}`);
  const v10 = v10ShapeProblem(db, true);
  if (v10) throw new Error(`v11 needs an exact v10 shape: ${v10}`);
  const conflict = v11ShapeProblem(db, false);
  if (conflict) throw new Error(`v11 cannot be applied over a changed trigger: ${conflict}`);
  const now = ctx.now();
  const already = v11ShapeProblem(db, true) === null;
  if (!already) db.exec(V11_DDL);
  const record = db.prepare(`INSERT OR IGNORE INTO nexus_migrations (version, from_version, applied_at, app_version, backup_file,
      backup_sha256, backup_bytes, row_counts_json, backfill_json) VALUES (11, 10, ?, ?, ?, ?, ?, ?, '{}')`).run(
    now, ctx.appVersion, ctx.backup?.file ?? null, ctx.backup?.sha256 ?? null, ctx.backup?.bytes ?? null,
    JSON.stringify(ctx.preCounts ?? {}));
  if (record.changes === 1) {
    appendActivityRow(db, {
      actorKind: 'system', actorId: 'system', entityType: 'schema', entityId: '11', action: 'db.migrated', status: 'succeeded',
      details: { from: 10, to: 11, backupFile: ctx.backup?.file ?? null, backupSha256: ctx.backup?.sha256 ?? null }
    }, now);
  }
  verifyV11(db, ctx);
  return { triggers: 1, recorded: record.changes === 1 };
}
