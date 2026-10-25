/**
 * PersistStore — durable harness state in SQLite (better-sqlite3, synchronous).
 *
 * Phase A scope (the rest of the renderer state stays in localStorage for now):
 *   - kv:               scalar app state. Today: the main window's bounds.
 *   - command_history:  NET-NEW — every prompt the user submits to an agent.
 *
 * Lives in the Electron MAIN process (better-sqlite3 is native + synchronous);
 * the renderer reaches it over IPC. The DB file sits next to config.json under
 * app.getPath('userData'). WAL mode so reads never block the single writer.
 *
 * Schema evolves via PRAGMA user_version migrations: an ordered array where
 * migration N runs when user_version < N+1, then bumps it. NEVER edit a shipped
 * migration — only append. Phases B/C (agents + message_queue mirror) and the
 * cross-lane cost_ledger are reserved as future additive migrations (see below);
 * they are deliberately NOT built in v1.
 */
import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Project } from '../shared/project';
import type {
  ProjectGraphNode,
  ProjectGraphEdge,
  ProjectGraphStats,
  ProjectSubgraph,
  ProjectGraphNodeKind,
  ProjectGraphRelationKind,
  ProjectGraphQueryFilter
} from '../shared/graph';
import type { ProjectPlan } from '../shared/plan';
import type { ProjectGapAnalysisResult } from '../shared/gap';
import type { ProjectGoal } from '../shared/goal';
import { LegacyWriteQueue } from './legacyWriteQueue';
import { appendCrashLog, redactForLog } from './crashLog';
import type { MigrationContext, MigrationHooks, MigrationOutcome } from './nexus/db/migrationTypes';
import { applyV7, v7ShapeProblem } from './nexus/db/schemaV7';
import { applyV8, v8ShapeProblem } from './nexus/db/schemaV8';
import { applyV9, v9ShapeProblem } from './nexus/db/schemaV9';
import { applyV10, v10ShapeProblem } from './nexus/db/schemaV10';
import { syncPrimaryFromLegacyDomain } from './nexus/workspace/legacyPrimary';
import { backupAndVerify, BackupError, freeBytes, integrityOk, tableRowCounts, type BackupRecord } from './nexus/db/backup';

export const V7 = 7;
export const V8 = 8;
export const V9 = 9;
/**
 * Whether open() runs the v9 step when the caller does not say (PersistOpenOptions.enableV9).
 * v9 stays off until it is verified; making it the default is this one line.
 */
export const V9_ENABLED_BY_DEFAULT = false;
export const V10 = 10;
/**
 * Whether open() runs the v10 step when the caller does not say (PersistOpenOptions.enableV10).
 * v10 stays off until B2b is verified; making it the default is this one line, on the user's go-ahead only.
 */
export const V10_ENABLED_BY_DEFAULT = false;
/** Platform tables that reference projects ON DELETE RESTRICT (fixed names, safe to interpolate). */
const PLATFORM_RECORD_TABLES: readonly string[] = ['artifacts', 'jobs', 'agent_sessions', 'handoffs', 'deployments', 'approvals'];
/** Migrations before the platform core; they run exactly as they always have. */
const LEGACY_VERSION = 6;

/** See PersistStore.handoffsUnavailableReason. */
export type HandoffsUnavailableReason = 'held' | 'auto_held' | 'backup_failed' | 'failed' | 'shape';

/** See PersistStore.executionUnavailableReason. */
export type ExecutionUnavailableReason = 'not_enabled' | 'held' | 'auto_held' | 'backup_failed' | 'failed' | 'shape';

/** See PersistStore.agentsUnavailableReason. */
export type AgentsUnavailableReason = 'not_enabled' | 'held' | 'auto_held' | 'backup_failed' | 'failed' | 'shape';

/**
 * The v10 step's outcome: a MigrationOutcome, or the one skip only v10 has, `v9_unavailable` (execution is not in
 * place: v9 not enabled, held, skipped, failed, or a v7, v8 or v9 shape problem). No v10 line is logged for it.
 */
export type MigrationOutcomeV10 = MigrationOutcome | { state: 'skipped'; fromVersion: number; reason: 'v9_unavailable'; detail: string };

export interface PersistOpenOptions {
  /** Receives every migration log line (already ISO-stamped). Default: console plus the main crash log file. */
  log?: (line: string) => void;
  /** Where the pre-migration backup goes. Default: userData/backups. */
  backupDir?: string;
  /** Keep the database at v6 (NEXUS_DB_HOLD_V7=1). Implies holdV8. */
  holdV7?: boolean;
  /** Keep the database at v7 (NEXUS_DB_HOLD_V8=1). Default: NEXUS_DB_HOLD_V8 === '1'. */
  holdV8?: boolean;
  /**
   * Run the v9 step (execution records). Default: V9_ENABLED_BY_DEFAULT (false). Off, a v8
   * database stays at v8 and execution reports `not_enabled`; the platform and handoffs are unchanged.
   */
  enableV9?: boolean;
  /** Keep the database at v8 when v9 is enabled (NEXUS_DB_HOLD_V9=1). Default: NEXUS_DB_HOLD_V9 === '1'. holdV7 and holdV8 imply it. */
  holdV9?: boolean;
  /**
   * Run the v10 step (agent records). Default: V10_ENABLED_BY_DEFAULT (false). Off, a v9 database stays at v9 and
   * agents report `not_enabled`; the platform, handoffs and execution are unchanged. It runs only on a v9 that is in
   * place with execution enabled (enableV9).
   */
  enableV10?: boolean;
  /** Keep the database at v9 when v10 is enabled (NEXUS_DB_HOLD_V10=1). Default: NEXUS_DB_HOLD_V10 === '1'. holdV7, holdV8 and holdV9 imply it. */
  holdV10?: boolean;
  appVersion?: string | null;
  now?: () => number;
  /** Tests only. */
  hooks?: MigrationHooks;
}

/** A captured user prompt, as returned to the renderer (camelCase columns). */
export interface CommandHistoryRow {
  id: number;
  agentId: string;
  cwd: string | null;
  text: string;
  ts: number;
}

/**
 * Ordered, append-only migrations. Index N takes the DB from user_version N to
 * N+1. To evolve the schema, APPEND a new function — never edit an existing one
 * (shipped DBs have already run it).
 *
 * FUTURE (do NOT build in v1 — reserved so the array isn't painted into a corner):
 *   - Phase B: `agents` + `message_queue` mirror of the renderer roster/queues
 *     (dual-write), enabling the eventual authority flip off localStorage.
 *   - Cross-lane (Lane A #6): migrate Jim's cost ledger onto this DB so his
 *     circuit-breaker can move off transcript-polling. Column names match his
 *     <harnessHome>/hive/cost-ledger.jsonl keys 1:1 for a straight INSERT…SELECT
 *     (coordinated w/ jim-mq290qkn 2026-06-06):
 *       cost_ledger(id, agent_id, session_id TEXT, ts, input, output,
 *                   cache_read, cache_creation, model TEXT, usd REAL)
 *     Rows are CUMULATIVE snapshots (one per agent per heartbeat beat) — diff
 *     consecutive rows for velocity; index (agent_id, session_id, ts). Additive;
 *     lands as a later migration.
 */

export const MIGRATIONS: Array<(db: Database.Database, ctx: MigrationContext | null) => void> = [
  // → user_version 1 (Phase A): scalar kv + net-new command history.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,     -- JSON-encoded
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_history (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        cwd      TEXT,
        text     TEXT NOT NULL,
        ts       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ch_agent_ts ON command_history(agent_id, ts DESC);
    `);
  },
  // → user_version 2: Projects table for domain-specialized AI workspaces.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        root_path        TEXT NOT NULL,
        domain_id        TEXT NOT NULL,
        project_type     TEXT NOT NULL,
        description      TEXT,
        metadata_json    TEXT NOT NULL,
        health_json      TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        last_analyzed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_domain ON projects(domain_id);
    `);
  },
  // → user_version 3: Project Knowledge Graph nodes and edges
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_graph_nodes (
        id            TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        kind          TEXT NOT NULL,
        name          TEXT NOT NULL,
        path          TEXT,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_proj_kind ON project_graph_nodes(project_id, kind);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_proj_path ON project_graph_nodes(project_id, path);

      CREATE TABLE IF NOT EXISTS project_graph_edges (
        id            TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        source_id     TEXT NOT NULL,
        target_id     TEXT NOT NULL,
        kind          TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON project_graph_edges(project_id, source_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON project_graph_edges(project_id, target_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_kind ON project_graph_edges(project_id, kind);
    `);
  },
  // → user_version 4: Project plans (milestones, tasks, progress)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_plans (
        project_id TEXT PRIMARY KEY,
        plan_json  TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_plans_updated ON project_plans(updated_at DESC);
    `);
  },
  // → user_version 5: Project gap analysis records
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_gaps (
        project_id TEXT PRIMARY KEY,
        gaps_json  TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_gaps_updated ON project_gaps(updated_at DESC);
    `);
  },
  // → user_version 6: Project goals & required capabilities
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_goals (
        project_id TEXT PRIMARY KEY,
        goal_json  TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_goals_updated ON project_goals(updated_at DESC);
    `);
  },
  // → user_version 7: Nexus platform core (src/main/nexus/db/schemaV7.ts). Additive.
  // Only ever run by migrateV7() below: backup first, one BEGIN IMMEDIATE transaction.
  (db, ctx) => {
    if (!ctx) throw new Error('the v7 migration needs its migration context');
    applyV7(db, ctx);
  }
];

/** Basename-only, secret-redacted text for a log line. */
function safeForLog(text: string, dirs: string[]): string {
  // Any absolute path keeps only its last segment...
  let s = text.replace(/(?<=^|[\s'"(=])(?:[A-Za-z]:)?(?:[\\/][^\\/\s'"`;:]+)+[\\/]([^\\/\s'"`;:]+)/g, '$1');
  // ...and the known directories never appear, whatever their spelling.
  for (const d of dirs) {
    if (!d) continue;
    for (const form of new Set([d, d.replace(/\\/g, '/'), d.replace(/\//g, '\\')])) {
      s = s.split(`${form}\\`).join('').split(`${form}/`).join('').split(form).join('<dir>');
    }
  }
  return redactForLog(s).replace(/\s+/g, ' ').trim();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Console plus the main crash log file (logs dir), when running inside Electron. */
function defaultMigrationLog(line: string): void {
  console.log(line);
  let dir: string | null = null;
  try { dir = app.getPath('logs'); } catch { dir = null; }
  if (dir) appendCrashLog(dir, line);
}

/** Consecutive failed v7 transactions after which v7 is held automatically. */
export const V7_FAILURE_LIMIT = 3;

/** Consecutive failed v8 transactions after which v8 is held automatically. */
export const V8_FAILURE_LIMIT = 3;

/** Consecutive failed v9 transactions after which v9 is held automatically. */
export const V9_FAILURE_LIMIT = 3;

/** Consecutive failed v10 transactions after which v10 is held automatically. */
export const V10_FAILURE_LIMIT = 3;

/** Small marker next to the DB file counting consecutive failed transactions of one platform step (no table, no error text). */
export function platformFailureMarkerPath(dbFile: string, version: 7 | 8 | 9 | 10): string {
  return `${dbFile}.v${version}-failures.json`;
}

/** Small marker next to the DB file counting consecutive failed v7 transactions (no legacy table, no error text). */
export function v7FailureMarkerPath(dbFile: string): string {
  return platformFailureMarkerPath(dbFile, 7);
}

function readFailureCount(marker: string): number {
  try {
    const n = Number((JSON.parse(fs.readFileSync(marker, 'utf8')) as { count?: unknown })?.count);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeFailureCount(marker: string, count: number, at: number): void {
  try { fs.writeFileSync(marker, JSON.stringify({ count, lastFailureAt: at })); } catch { /* best effort: never breaks open() */ }
}

function clearFailureMarker(marker: string): void {
  try { fs.rmSync(marker, { force: true }); } catch { /* best effort */ }
}

function defaultAppVersion(): string | null {
  try { return app.getVersion(); } catch { return null; }
}

export class PersistStore {
  private db: Database.Database | null = null;
  /** Every write goes through this queue: a failed, early or paused write is retried, never dropped. */
  private closed = false;
  private readonly queue = new LegacyWriteQueue({ isReady: () => this.db !== null });

  /** @param dbPath  Override the DB location (tests). Defaults to userData/harness.db. */
  constructor(private dbPath?: string) {}

  private version = 0;
  private platformOk = false;
  /** The open() log sink, redaction and clock, kept for platform lines after open (primary sync, delete guard). */
  private nexusLog: (line: string) => void = (line) => console.log(line);
  private nexusScrub: (text: string) => string = (text) => safeForLog(text, []);
  private nexusNow: () => number = Date.now;
  private outcome: MigrationOutcome | null = null;
  /** True only at v8 with the v8 post-check (or the reopen shape check) passed. */
  private handoffsOk = false;
  private outcomeV8: MigrationOutcome | null = null;
  /** What the v8 step needs from the v7 step of the same open(): the version on disk before open(), and the backup folder. */
  private v8Env: { openedFrom: number; backupDir: string } = { openedFrom: 0, backupDir: '' };
  /** True only at v9 with the v9 post-check (or the reopen v9 shape check) passed. */
  private executionOk = false;
  private outcomeV9: MigrationOutcome | null = null;
  /** Whether this open() was asked to run v9 (PersistOpenOptions.enableV9). */
  private v9Enabled = V9_ENABLED_BY_DEFAULT;
  /** True only at v10 with the v10 post-check (or the reopen v10 shape check) passed. */
  private agentsOk = false;
  private outcomeV10: MigrationOutcomeV10 | null = null;
  /** Whether this open() was asked to run v10 (PersistOpenOptions.enableV10). */
  private v10Enabled = V10_ENABLED_BY_DEFAULT;

  /** Open (creating if needed) and migrate the DB. Idempotent — a second call is
   *  a no-op. Throws if the native module fails to load, the file is unusable or a
   *  legacy (v1–v6) migration fails; callers should guard so a DB failure can't
   *  crash app startup. Never throws because of v7: a v7 problem leaves the DB at
   *  v6 with the platform unavailable. Never throws because of v8 either: a v8
   *  problem leaves the DB at v7 with the platform on and handoffs unavailable. Nor
   *  because of v9 (run only with enableV9): a v9 problem leaves the DB at v8 with the
   *  platform and handoffs on and execution unavailable. Nor because of v10 (run only
   *  with enableV10): a v10 problem leaves the DB at v9 with execution on and agents unavailable. */
  open(opts: PersistOpenOptions = {}): void {
    if (this.db) return;
    const path = this.dbPath ?? join(app.getPath('userData'), 'harness.db');
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    // Writes submitted until this.db is set wait in the legacy queue: nothing is
    // written by the app before the backup is verified and the migration is done.
    this.migrate(db, path, opts);
    this.migrateV8Guarded(db, path, opts);
    this.migrateV9Guarded(db, path, opts);
    this.migrateV10Guarded(db, path, opts);
    this.db = db;
    this.closed = false;
    // Anything written before the DB was open (or while paused) goes in now, in order.
    this.queue.flush(() => this.db !== null);
  }

  /** Legacy steps, exactly as before: one transaction per migration, up to v6. */
  private migrateLegacy(db: Database.Database): void {
    const version = db.pragma('user_version', { simple: true }) as number;
    for (let i = version; i < LEGACY_VERSION; i++) {
      // Each migration + its version bump run in one transaction so a crash
      // mid-migration never leaves a half-applied schema at the wrong version.
      const run = db.transaction(() => {
        MIGRATIONS[i](db, null);
        db.pragma(`user_version = ${i + 1}`);
      });
      run();
    }
  }

  private migrate(db: Database.Database, dbFile: string, opts: PersistOpenOptions): void {
    const sink = opts.log ?? defaultMigrationLog;
    const log = (line: string): void => {
      try { sink(`${new Date().toISOString()} ${line}`); } catch { /* logging never breaks open() */ }
    };
    let backupDir = opts.backupDir ?? '';
    if (!backupDir) {
      try { backupDir = join(app.getPath('userData'), 'backups'); } catch { backupDir = join(dirname(dbFile), 'backups'); }
    }
    const now = opts.now ?? Date.now;
    const hold = opts.holdV7 ?? process.env.NEXUS_DB_HOLD_V7 === '1';
    const scrub = (text: string): string => safeForLog(text, [dirname(dbFile), backupDir]);
    this.nexusLog = log; this.nexusScrub = scrub; this.nexusNow = now;
    const from = db.pragma('user_version', { simple: true }) as number;
    this.platformOk = false;
    this.v8Env = { openedFrom: from, backupDir };
    log(`[db] schema version ${from}`);

    if (from > V10) {
      log(`[db] schema v${from} is newer than this build (v${V10}); opened for legacy use only, platform disabled, nothing migrated`);
      this.version = from;
      this.outcome = { state: 'skipped', fromVersion: from, reason: 'newer_schema', detail: `schema v${from}` };
      return;
    }
    if (from >= V7 && from <= V10) {
      // At v8, v9 and v10 the v7 objects are unchanged (later steps are additive), so the same complete v7 check
      // decides the platform: every v7 object present with its exact definition.
      let problem: string | null;
      try { problem = v7ShapeProblem(db, true); } catch (err) { problem = errorMessage(err); }
      if (problem) log(`[db] v7 shape check failed: ${scrub(problem)}; platform disabled`);
      this.version = from;
      this.platformOk = problem === null;
      this.outcome = { state: 'not_needed', version: V7 };
      return;
    }
    if (hold) {
      this.migrateLegacy(db);
      this.version = db.pragma('user_version', { simple: true }) as number;
      log(`[db] v7 migration: skipped reason=held (NEXUS_DB_HOLD_V7=1); database stays at v${this.version}`);
      this.outcome = { state: 'skipped', fromVersion: from, reason: 'held', detail: 'NEXUS_DB_HOLD_V7=1' };
      return;
    }
    // A deterministic v7 failure must not take a new backup on every launch: after
    // V7_FAILURE_LIMIT consecutive failures v7 holds itself until the marker is cleared.
    const marker = v7FailureMarkerPath(dbFile);
    const failures = readFailureCount(marker);
    if (failures >= V7_FAILURE_LIMIT) {
      this.migrateLegacy(db);
      this.version = db.pragma('user_version', { simple: true }) as number;
      log(`[db] v7 migration: skipped reason=held: repeated_failure count=${failures}; database stays at v${this.version}; no new backup taken`);
      log(`[db] to retry v7, quit and delete ${basename(marker)} next to ${basename(dbFile)}; existing backups are kept `
        + '(restore one with the restore tool, tools/nexus-db-restore.cjs, if needed)');
      this.outcome = { state: 'skipped', fromVersion: from, reason: 'held', detail: `repeated_failure count=${failures}` };
      return;
    }

    const skip = (reason: 'precheck_failed' | 'insufficient_disk' | 'backup_failed', detail: string): void => {
      this.migrateLegacy(db);
      this.version = db.pragma('user_version', { simple: true }) as number;
      log(`[db] v7 migration: skipped reason=${reason} detail=${detail}; database left at v${this.version}`);
      this.outcome = { state: 'skipped', fromVersion: from, reason, detail };
    };

    let preCounts: Record<string, number> | null = null;
    let backup: BackupRecord | null = null;
    if (from > 0) {
      // 1. Pre-checks. The database is not touched.
      try {
        const integrityStart = Date.now();
        if (!integrityOk(db)) return skip('precheck_failed', 'integrity_check is not ok');
        const integrityMs = Date.now() - integrityStart;
        const size = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };
        const needed = 2 * (size(dbFile) + size(`${dbFile}-wal`));
        const free = opts.hooks?.freeBytes ? opts.hooks.freeBytes() : freeBytes(backupDir);
        if (free !== null && free < needed) return skip('insufficient_disk', `free=${free} needed=${needed}`);
        preCounts = tableRowCounts(db);
        log(`[db] v7 precheck ok integrity=ok integrityMs=${integrityMs} free=${free ?? 'unknown'} needed=${needed}`);
      } catch (err) {
        return skip('precheck_failed', scrub(errorMessage(err)));
      }
      // 2. Backup and verify. Only after this may the original change.
      try {
        backup = this.takeBackup(db, backupDir, from, preCounts, now);
      } catch (err) {
        const stage = err instanceof BackupError ? err.stage : 'unexpected';
        log(`[db] backup failed stage=${stage} error=${scrub(errorMessage(err))}`);
        return skip('backup_failed', `stage=${stage}`);
      }
      log(`[db] backup ok file=${backup.file} bytes=${backup.bytes} sha256=${backup.sha256} from=${from} `
        + `writeMs=${backup.timings.writeMs} verifyMs=${backup.timings.verifyMs} hashMs=${backup.timings.hashMs}`);
      log(`[db] row counts ${Object.entries(preCounts).map(([t, n]) => `${t}=${n}`).join(' ')}`);
    } else {
      log('[db] fresh database: no backup needed');
    }

    // 3. Legacy steps (from < 6), now protected by the backup.
    this.migrateLegacy(db);
    const legacyVersion = db.pragma('user_version', { simple: true }) as number;
    this.version = legacyVersion;
    const backupFile = backup?.file ?? null;

    // 4. v7 in one BEGIN IMMEDIATE transaction: DDL, seeds, backfill, record,
    //    activity row, verification and user_version all commit or roll back together.
    log(`[db] v7 migration: start from=${from}`);
    const started = Date.now();
    const ctx: MigrationContext = { now, appVersion: opts.appVersion !== undefined ? opts.appVersion : defaultAppVersion(), fromVersion: from, preCounts, backup };
    let result: { backfilled: number; unassigned: number };
    try {
      opts.hooks?.beforeTransaction?.(db);
      result = db.transaction(() => {
        const r = applyV7(db, ctx);
        db.pragma(`user_version = ${V7}`);
        opts.hooks?.beforeCommit?.(db, V7);
        return r;
      }).immediate();
    } catch (err) {
      const kept = backupFile ? `backup kept at ${backupFile}` : 'no backup (fresh database)';
      log(`[db] v7 migration: failed from=${from} error=${scrub(errorMessage(err))}; database left at v${legacyVersion}; ${kept}`);
      const count = failures + 1;
      writeFailureCount(marker, count, now());
      log(count >= V7_FAILURE_LIMIT
        ? `[db] v7 migration has failed ${count} times in a row; it is held from the next launch (held: repeated_failure)`
        : `[db] v7 migration will be retried at the next launch (failure ${count} of ${V7_FAILURE_LIMIT}); set NEXUS_DB_HOLD_V7=1 to stay on v6`);
      this.outcome = { state: 'failed', fromVersion: from, error: scrub(errorMessage(err)), backupFile };
      return;
    }
    const durationMs = Date.now() - started;
    this.version = V7;
    clearFailureMarker(marker);

    // 5. Post-check after COMMIT.
    let postOk: boolean;
    try { postOk = integrityOk(db, 'quick'); } catch { postOk = false; }
    if (postOk) {
      log(`[db] v7 migration: success to=${V7} durationMs=${durationMs} backfilled=${result.backfilled} unassigned=${result.unassigned}`);
    } else {
      log(`[db] v7 post-check FAILED; platform disabled; restore from backup ${backupFile ?? '(none: fresh database)'}`);
    }
    this.platformOk = postOk;
    this.outcome = { state: 'applied', fromVersion: from, backupFile, durationMs, backfilled: result.backfilled, unassigned: result.unassigned, postCheckOk: postOk };
  }

  /** The v8 step never throws out of open(): anything unexpected leaves the platform as the v7 step left it, without handoffs. */
  private migrateV8Guarded(db: Database.Database, dbFile: string, opts: PersistOpenOptions): void {
    try {
      this.migrateV8(db, dbFile, opts);
    } catch (err) {
      this.handoffsOk = false;
      try { this.version = db.pragma('user_version', { simple: true }) as number; } catch { /* keep the last known version */ }
      const error = this.nexusScrub(errorMessage(err));
      this.nexusLogLine(`[db] v8 step: unexpected error=${error}; handoffs disabled`);
      this.outcomeV8 = { state: 'failed', fromVersion: V7, error, backupFile: null };
    }
  }

  /**
   * Schema v8 (handoffs), a sibling of the v7 step with the same safety procedure:
   * pre-checks, a verified harness-v7-<UTC>.db backup taken after the v7 COMMIT, one
   * BEGIN IMMEDIATE transaction, the NEXUS_DB_HOLD_V8 hold and its own failure marker.
   * It runs only on a clean v7 (applied, or reopened with the exact v7 shape). A
   * failure leaves the database at v7 with the platform on and handoffs off.
   */
  private migrateV8(db: Database.Database, dbFile: string, opts: PersistOpenOptions): void {
    const log = (line: string): void => this.nexusLogLine(line);   // the v7 step's sink: ISO-stamped, never throws
    const scrub = this.nexusScrub;
    const now = this.nexusNow;
    const { openedFrom, backupDir } = this.v8Env;
    this.handoffsOk = false;
    const v7 = this.outcome;
    if (v7 && v7.state === 'skipped' && v7.reason === 'newer_schema') {
      this.outcomeV8 = { ...v7 };
      return;
    }
    // 1. Decide. v7 not in place (held, skipped, failed, post-check failed or a v7 shape problem): no v8 line.
    if (this.version < V7 || !this.platformOk) {
      const detail = v7 ? (v7.state === 'skipped' ? `v7 ${v7.reason}` : `v7 ${v7.state}`) : 'v7 not run';
      this.outcomeV8 = { state: 'skipped', fromVersion: this.version, reason: 'v7_unavailable', detail };
      return;
    }
    if (this.version >= V8) {
      let problem: string | null;
      try { problem = v8ShapeProblem(db, true); } catch (err) { problem = errorMessage(err); }
      if (problem) log(`[db] v8 shape check failed: ${scrub(problem)}; handoffs disabled`);
      this.handoffsOk = problem === null;
      this.outcomeV8 = { state: 'not_needed', version: V8 };
      return;
    }
    const holdV8 = opts.holdV8 ?? process.env.NEXUS_DB_HOLD_V8 === '1';
    const holdV7 = opts.holdV7 ?? process.env.NEXUS_DB_HOLD_V7 === '1';
    if (holdV8 || holdV7) {
      const by = holdV8 ? 'NEXUS_DB_HOLD_V8=1' : 'NEXUS_DB_HOLD_V7=1';
      log(`[db] v8 migration: skipped reason=held (${by}); database stays at v${V7}`);
      this.outcomeV8 = { state: 'skipped', fromVersion: V7, reason: 'held', detail: by };
      return;
    }
    // A deterministic v8 failure must not take a new backup on every launch.
    const marker = platformFailureMarkerPath(dbFile, 8);
    const failures = readFailureCount(marker);
    if (failures >= V8_FAILURE_LIMIT) {
      log(`[db] v8 migration: skipped reason=held: repeated_failure count=${failures}; database stays at v${V7}; no new backup taken`);
      log(`[db] to retry v8, quit and delete ${basename(marker)} next to ${basename(dbFile)}; existing backups are kept `
        + '(restore one with the restore tool, tools/nexus-db-restore.cjs, if needed)');
      this.outcomeV8 = { state: 'skipped', fromVersion: V7, reason: 'held', detail: `repeated_failure count=${failures}` };
      return;
    }

    const skip = (reason: 'precheck_failed' | 'insufficient_disk' | 'backup_failed', detail: string): void => {
      log(`[db] v8 migration: skipped reason=${reason} detail=${detail}; database left at v${V7}`);
      this.outcomeV8 = { state: 'skipped', fromVersion: V7, reason, detail };
    };

    let preCounts: Record<string, number> | null = null;
    let backup: BackupRecord | null = null;
    if (openedFrom > 0) {
      // 2. Pre-checks on the committed v7 database. Nothing is written.
      try {
        const integrityStart = Date.now();
        if (!integrityOk(db)) return skip('precheck_failed', 'integrity_check is not ok');
        const integrityMs = Date.now() - integrityStart;
        const size = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };
        const needed = 2 * (size(dbFile) + size(`${dbFile}-wal`));
        const free = opts.hooks?.freeBytes ? opts.hooks.freeBytes() : freeBytes(backupDir);
        if (free !== null && free < needed) return skip('insufficient_disk', `free=${free} needed=${needed}`);
        preCounts = tableRowCounts(db);
        log(`[db] v8 precheck ok integrity=ok integrityMs=${integrityMs} free=${free ?? 'unknown'} needed=${needed}`);
      } catch (err) {
        return skip('precheck_failed', scrub(errorMessage(err)));
      }
      // 3. Backup of the v7 database (harness-v7-<UTC>.db), verified before anything changes.
      try {
        backup = this.takeBackup(db, backupDir, V7, preCounts, now);
      } catch (err) {
        const stage = err instanceof BackupError ? err.stage : 'unexpected';
        log(`[db] backup failed stage=${stage} error=${scrub(errorMessage(err))}`);
        return skip('backup_failed', `stage=${stage}`);
      }
      log(`[db] backup ok file=${backup.file} bytes=${backup.bytes} sha256=${backup.sha256} from=${V7} `
        + `writeMs=${backup.timings.writeMs} verifyMs=${backup.timings.verifyMs} hashMs=${backup.timings.hashMs}`);
      log(`[db] row counts ${Object.entries(preCounts).map(([t, n]) => `${t}=${n}`).join(' ')}`);
    } else {
      log('[db] fresh database: no v8 backup needed');
    }
    const backupFile = backup?.file ?? null;

    // 4. v8 in one BEGIN IMMEDIATE transaction: DDL, seeds, record, activity row,
    //    verification and user_version all commit or roll back together.
    log(`[db] v8 migration: start from=${V7}`);
    const started = Date.now();
    const ctx: MigrationContext = { now, appVersion: opts.appVersion !== undefined ? opts.appVersion : defaultAppVersion(), fromVersion: V7, preCounts, backup };
    let result: { handoffStates: number; handoffTransitions: number };
    try {
      opts.hooks?.beforeTransaction?.(db, V8);
      result = db.transaction(() => {
        const r = applyV8(db, ctx);
        db.pragma(`user_version = ${V8}`);
        opts.hooks?.beforeCommit?.(db, V8);
        return r;
      }).immediate();
    } catch (err) {
      // SQLite rolled everything back, user_version included: the database is still v7.
      const kept = backupFile ? `backup kept at ${backupFile}` : 'no backup (fresh database)';
      log(`[db] v8 migration: failed from=${V7} error=${scrub(errorMessage(err))}; database left at v${V7}; ${kept}`);
      const count = failures + 1;
      writeFailureCount(marker, count, now());
      log(count >= V8_FAILURE_LIMIT
        ? `[db] v8 migration has failed ${count} times in a row; it is held from the next launch (held: repeated_failure)`
        : `[db] v8 migration will be retried at the next launch (failure ${count} of ${V8_FAILURE_LIMIT}); set NEXUS_DB_HOLD_V8=1 to stay on v${V7}`);
      this.outcomeV8 = { state: 'failed', fromVersion: V7, error: scrub(errorMessage(err)), backupFile };
      return;
    }
    const durationMs = Date.now() - started;
    this.version = V8;
    clearFailureMarker(marker);

    // 5. Post-check after COMMIT. The v7 objects are unchanged, so the platform stays on either way.
    let postOk: boolean;
    try { postOk = integrityOk(db, 'quick'); } catch { postOk = false; }
    if (postOk) {
      log(`[db] v8 migration: success to=${V8} durationMs=${durationMs} handoffStates=${result.handoffStates} handoffTransitions=${result.handoffTransitions}`);
    } else {
      log(`[db] v8 post-check FAILED; handoffs disabled; restore from backup ${backupFile ?? '(none: fresh database)'}`);
    }
    this.handoffsOk = postOk;
    this.outcomeV8 = { state: 'applied', fromVersion: V7, backupFile, durationMs, backfilled: 0, unassigned: 0, postCheckOk: postOk };
  }

  /** The v9 step never throws out of open(): anything unexpected leaves the platform and handoffs as the v8 step left them, without execution. */
  private migrateV9Guarded(db: Database.Database, dbFile: string, opts: PersistOpenOptions): void {
    try {
      this.migrateV9(db, dbFile, opts);
    } catch (err) {
      this.executionOk = false;
      try { this.version = db.pragma('user_version', { simple: true }) as number; } catch { /* keep the last known version */ }
      const error = this.nexusScrub(errorMessage(err));
      this.nexusLogLine(`[db] v9 step: unexpected error=${error}; execution disabled`);
      this.outcomeV9 = { state: 'failed', fromVersion: V8, error, backupFile: null };
    }
  }

  /**
   * Schema v9 (execution records), a sibling of the v8 step with the same safety procedure:
   * pre-checks, a verified harness-v8-<UTC>.db backup taken after the v8 COMMIT, one
   * BEGIN IMMEDIATE transaction, the NEXUS_DB_HOLD_V9 hold (implied by the v7 and v8 holds)
   * and its own failure marker. It runs only when enabled (PersistOpenOptions.enableV9) and
   * only on a clean v8 (applied, or reopened with the exact v8 shape). A failure leaves the
   * database at v8 with the platform and handoffs on and execution off.
   */
  private migrateV9(db: Database.Database, dbFile: string, opts: PersistOpenOptions): void {
    const log = (line: string): void => this.nexusLogLine(line);   // the v7 step's sink: ISO-stamped, never throws
    const scrub = this.nexusScrub;
    const now = this.nexusNow;
    const { openedFrom, backupDir } = this.v8Env;
    this.executionOk = false;
    this.v9Enabled = opts.enableV9 ?? V9_ENABLED_BY_DEFAULT;
    const v8 = this.outcomeV8;
    if (v8 && v8.state === 'skipped' && v8.reason === 'newer_schema') {
      this.outcomeV9 = { ...v8 };
      return;
    }
    // 1. Decide. v8 not in place (v7 or v8 held, skipped or failed, or either shape check failed): no v9 line.
    if (this.version < V8 || !this.platformOk || !this.handoffsOk) {
      const detail = v8 ? (v8.state === 'skipped' ? `v8 ${v8.reason}` : `v8 ${v8.state}`) : 'v8 not run';
      this.outcomeV9 = { state: 'skipped', fromVersion: this.version, reason: 'v8_unavailable', detail };
      return;
    }
    if (this.version >= V9) {
      // At v9 and at v10 alike: v10 is additive and leaves every v9 object as it is, so the complete v9 check
      // (every v9 object present, with its exact definition) still decides execution above v9.
      let problem: string | null;
      try { problem = v9ShapeProblem(db, true); } catch (err) { problem = errorMessage(err); }
      if (problem) log(`[db] v9 shape check failed: ${scrub(problem)}; execution disabled`);
      this.executionOk = problem === null;
      this.outcomeV9 = { state: 'not_needed', version: V9 };
      return;
    }
    if (!this.v9Enabled) {
      log(`[db] v9 migration: not enabled; database stays at v${V8}`);
      this.outcomeV9 = { state: 'skipped', fromVersion: V8, reason: 'not_enabled', detail: 'enableV9=false' };
      return;
    }
    const holdV9 = opts.holdV9 ?? process.env.NEXUS_DB_HOLD_V9 === '1';
    const holdV8 = opts.holdV8 ?? process.env.NEXUS_DB_HOLD_V8 === '1';
    const holdV7 = opts.holdV7 ?? process.env.NEXUS_DB_HOLD_V7 === '1';
    if (holdV9 || holdV8 || holdV7) {
      const by = holdV9 ? 'NEXUS_DB_HOLD_V9=1' : holdV8 ? 'NEXUS_DB_HOLD_V8=1' : 'NEXUS_DB_HOLD_V7=1';
      log(`[db] v9 migration: skipped reason=held (${by}); database stays at v${V8}`);
      this.outcomeV9 = { state: 'skipped', fromVersion: V8, reason: 'held', detail: by };
      return;
    }
    // A deterministic v9 failure must not take a new backup on every launch.
    const marker = platformFailureMarkerPath(dbFile, 9);
    const failures = readFailureCount(marker);
    if (failures >= V9_FAILURE_LIMIT) {
      log(`[db] v9 migration: skipped reason=held: repeated_failure count=${failures}; database stays at v${V8}; no new backup taken`);
      log(`[db] to retry v9, quit and delete ${basename(marker)} next to ${basename(dbFile)}; existing backups are kept `
        + '(restore one with the restore tool, tools/nexus-db-restore.cjs, if needed)');
      this.outcomeV9 = { state: 'skipped', fromVersion: V8, reason: 'held', detail: `repeated_failure count=${failures}` };
      return;
    }

    const skip = (reason: 'precheck_failed' | 'insufficient_disk' | 'backup_failed', detail: string): void => {
      log(`[db] v9 migration: skipped reason=${reason} detail=${detail}; database left at v${V8}`);
      this.outcomeV9 = { state: 'skipped', fromVersion: V8, reason, detail };
    };

    let preCounts: Record<string, number> | null = null;
    let backup: BackupRecord | null = null;
    if (openedFrom > 0) {
      // 2. Pre-checks on the committed v8 database. Nothing is written.
      try {
        const integrityStart = Date.now();
        if (!integrityOk(db)) return skip('precheck_failed', 'integrity_check is not ok');
        const integrityMs = Date.now() - integrityStart;
        const size = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };
        const needed = 2 * (size(dbFile) + size(`${dbFile}-wal`));
        const free = opts.hooks?.freeBytes ? opts.hooks.freeBytes() : freeBytes(backupDir);
        if (free !== null && free < needed) return skip('insufficient_disk', `free=${free} needed=${needed}`);
        preCounts = tableRowCounts(db);
        log(`[db] v9 precheck ok integrity=ok integrityMs=${integrityMs} free=${free ?? 'unknown'} needed=${needed}`);
      } catch (err) {
        return skip('precheck_failed', scrub(errorMessage(err)));
      }
      // 3. Backup of the v8 database (harness-v8-<UTC>.db), verified before anything changes.
      try {
        backup = this.takeBackup(db, backupDir, V8, preCounts, now);
      } catch (err) {
        const stage = err instanceof BackupError ? err.stage : 'unexpected';
        log(`[db] backup failed stage=${stage} error=${scrub(errorMessage(err))}`);
        return skip('backup_failed', `stage=${stage}`);
      }
      log(`[db] backup ok file=${backup.file} bytes=${backup.bytes} sha256=${backup.sha256} from=${V8} `
        + `writeMs=${backup.timings.writeMs} verifyMs=${backup.timings.verifyMs} hashMs=${backup.timings.hashMs}`);
      log(`[db] row counts ${Object.entries(preCounts).map(([t, n]) => `${t}=${n}`).join(' ')}`);
    } else {
      log('[db] fresh database: no v9 backup needed');
    }
    const backupFile = backup?.file ?? null;

    // 4. v9 in one BEGIN IMMEDIATE transaction: DDL, seeds, record, activity row,
    //    verification and user_version all commit or roll back together.
    log(`[db] v9 migration: start from=${V8}`);
    const started = Date.now();
    const ctx: MigrationContext = { now, appVersion: opts.appVersion !== undefined ? opts.appVersion : defaultAppVersion(), fromVersion: V8, preCounts, backup };
    let result: { attemptStates: number; approvalStates: number; deploymentStates: number; relationsAdded: number };
    try {
      opts.hooks?.beforeTransaction?.(db, V9);
      result = db.transaction(() => {
        const r = applyV9(db, ctx);
        db.pragma(`user_version = ${V9}`);
        opts.hooks?.beforeCommit?.(db, V9);
        return r;
      }).immediate();
    } catch (err) {
      // SQLite rolled everything back, user_version included: the database is still v8.
      const kept = backupFile ? `backup kept at ${backupFile}` : 'no backup (fresh database)';
      log(`[db] v9 migration: failed from=${V8} error=${scrub(errorMessage(err))}; database left at v${V8}; ${kept}`);
      const count = failures + 1;
      writeFailureCount(marker, count, now());
      log(count >= V9_FAILURE_LIMIT
        ? `[db] v9 migration has failed ${count} times in a row; it is held from the next launch (held: repeated_failure)`
        : `[db] v9 migration will be retried at the next launch (failure ${count} of ${V9_FAILURE_LIMIT}); set NEXUS_DB_HOLD_V9=1 to stay on v${V8}`);
      this.outcomeV9 = { state: 'failed', fromVersion: V8, error: scrub(errorMessage(err)), backupFile };
      return;
    }
    const durationMs = Date.now() - started;
    this.version = V9;
    clearFailureMarker(marker);

    // 5. Post-check after COMMIT. The v7 and v8 objects are unchanged, so the platform and handoffs stay on either way.
    let postOk: boolean;
    try {
      const forced = opts.hooks?.postCheck?.(db, V9);
      postOk = typeof forced === 'boolean' ? forced : integrityOk(db, 'quick');
    } catch { postOk = false; }
    if (postOk) {
      log(`[db] v9 migration: success to=${V9} durationMs=${durationMs} attemptStates=${result.attemptStates} `
        + `approvalStates=${result.approvalStates} deploymentStates=${result.deploymentStates} relationsAdded=${result.relationsAdded}`);
    } else {
      log(`[db] v9 post-check FAILED; execution disabled; restore from backup ${backupFile ?? '(none: fresh database)'}`);
    }
    this.executionOk = postOk;
    this.outcomeV9 = { state: 'applied', fromVersion: V8, backupFile, durationMs, backfilled: 0, unassigned: 0, postCheckOk: postOk };
  }

  /** The v10 step never throws out of open(): anything unexpected leaves the platform, handoffs and execution as the v9 step left them, without agents. */
  private migrateV10Guarded(db: Database.Database, dbFile: string, opts: PersistOpenOptions): void {
    try {
      this.migrateV10(db, dbFile, opts);
    } catch (err) {
      this.agentsOk = false;
      try { this.version = db.pragma('user_version', { simple: true }) as number; } catch { /* keep the last known version */ }
      const error = this.nexusScrub(errorMessage(err));
      this.nexusLogLine(`[db] v10 step: unexpected error=${error}; agents disabled`);
      this.outcomeV10 = { state: 'failed', fromVersion: V9, error, backupFile: null };
    }
  }

  /**
   * Schema v10 (agent records), a sibling of the v9 step with the same safety procedure:
   * pre-checks, a verified harness-v9-<UTC>.db backup taken after the v9 COMMIT, one
   * BEGIN IMMEDIATE transaction, the NEXUS_DB_HOLD_V10 hold (implied by the v7, v8 and v9
   * holds) and its own failure marker. It runs only when enabled (PersistOpenOptions.enableV10)
   * and only on a v9 that is in place with execution enabled (applied, or reopened with the
   * complete v9 shape, and enableV9). A failure leaves the database at v9 with the platform,
   * handoffs and execution on and agents off.
   */
  private migrateV10(db: Database.Database, dbFile: string, opts: PersistOpenOptions): void {
    const log = (line: string): void => this.nexusLogLine(line);   // the v7 step's sink: ISO-stamped, never throws
    const scrub = this.nexusScrub;
    const now = this.nexusNow;
    const { openedFrom, backupDir } = this.v8Env;
    this.agentsOk = false;
    this.v10Enabled = opts.enableV10 ?? V10_ENABLED_BY_DEFAULT;
    const v9 = this.outcomeV9;
    if (v9 && v9.state === 'skipped' && v9.reason === 'newer_schema') {
      this.outcomeV10 = { ...v9 };
      return;
    }
    // 1. Decide. Execution not in place (v9 not enabled, any earlier hold, skip or failure, or a v7, v8 or v9
    //    shape problem): agents need execution, so there is no v10 line.
    if (this.version < V9 || !this.platformOk || !this.handoffsOk || !this.executionOk || !this.v9Enabled) {
      const detail = !v9 ? 'v9 not run'
        : v9.state === 'skipped' ? `v9 ${v9.reason}`
          : v9.state === 'not_needed' ? (this.executionOk ? 'v9 not_enabled' : 'v9 shape')
            : `v9 ${v9.state}`;
      this.outcomeV10 = { state: 'skipped', fromVersion: this.version, reason: 'v9_unavailable', detail };
      return;
    }
    if (this.version >= V10) {
      let problem: string | null;
      try { problem = v10ShapeProblem(db, true); } catch (err) { problem = errorMessage(err); }
      if (problem) log(`[db] v10 shape check failed: ${scrub(problem)}; agents disabled`);
      this.agentsOk = problem === null;
      this.outcomeV10 = { state: 'not_needed', version: V10 };
      return;
    }
    if (!this.v10Enabled) {
      log(`[db] v10 migration: not enabled; database stays at v${V9}`);
      this.outcomeV10 = { state: 'skipped', fromVersion: V9, reason: 'not_enabled', detail: 'enableV10=false' };
      return;
    }
    const holdV10 = opts.holdV10 ?? process.env.NEXUS_DB_HOLD_V10 === '1';
    const holdV9 = opts.holdV9 ?? process.env.NEXUS_DB_HOLD_V9 === '1';
    const holdV8 = opts.holdV8 ?? process.env.NEXUS_DB_HOLD_V8 === '1';
    const holdV7 = opts.holdV7 ?? process.env.NEXUS_DB_HOLD_V7 === '1';
    if (holdV10 || holdV9 || holdV8 || holdV7) {
      const by = holdV10 ? 'NEXUS_DB_HOLD_V10=1' : holdV9 ? 'NEXUS_DB_HOLD_V9=1' : holdV8 ? 'NEXUS_DB_HOLD_V8=1' : 'NEXUS_DB_HOLD_V7=1';
      log(`[db] v10 migration: skipped reason=held (${by}); database stays at v${V9}`);
      this.outcomeV10 = { state: 'skipped', fromVersion: V9, reason: 'held', detail: by };
      return;
    }
    // A deterministic v10 failure must not take a new backup on every launch.
    const marker = platformFailureMarkerPath(dbFile, 10);
    const failures = readFailureCount(marker);
    if (failures >= V10_FAILURE_LIMIT) {
      log(`[db] v10 migration: skipped reason=held: repeated_failure count=${failures}; database stays at v${V9}; no new backup taken`);
      log(`[db] to retry v10, quit and delete ${basename(marker)} next to ${basename(dbFile)}; existing backups are kept `
        + '(restore one with the restore tool, tools/nexus-db-restore.cjs, if needed)');
      this.outcomeV10 = { state: 'skipped', fromVersion: V9, reason: 'held', detail: `repeated_failure count=${failures}` };
      return;
    }

    const skip = (reason: 'precheck_failed' | 'insufficient_disk' | 'backup_failed', detail: string): void => {
      log(`[db] v10 migration: skipped reason=${reason} detail=${detail}; database left at v${V9}`);
      this.outcomeV10 = { state: 'skipped', fromVersion: V9, reason, detail };
    };

    let preCounts: Record<string, number> | null = null;
    let backup: BackupRecord | null = null;
    if (openedFrom > 0) {
      // 2. Pre-checks on the committed v9 database. Nothing is written.
      try {
        const integrityStart = Date.now();
        if (!integrityOk(db)) return skip('precheck_failed', 'integrity_check is not ok');
        const integrityMs = Date.now() - integrityStart;
        const size = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };
        const needed = 2 * (size(dbFile) + size(`${dbFile}-wal`));
        const free = opts.hooks?.freeBytes ? opts.hooks.freeBytes() : freeBytes(backupDir);
        if (free !== null && free < needed) return skip('insufficient_disk', `free=${free} needed=${needed}`);
        preCounts = tableRowCounts(db);
        log(`[db] v10 precheck ok integrity=ok integrityMs=${integrityMs} free=${free ?? 'unknown'} needed=${needed}`);
      } catch (err) {
        return skip('precheck_failed', scrub(errorMessage(err)));
      }
      // 3. Backup of the v9 database (harness-v9-<UTC>.db), verified before anything changes.
      try {
        backup = this.takeBackup(db, backupDir, V9, preCounts, now);
      } catch (err) {
        const stage = err instanceof BackupError ? err.stage : 'unexpected';
        log(`[db] backup failed stage=${stage} error=${scrub(errorMessage(err))}`);
        return skip('backup_failed', `stage=${stage}`);
      }
      log(`[db] backup ok file=${backup.file} bytes=${backup.bytes} sha256=${backup.sha256} from=${V9} `
        + `writeMs=${backup.timings.writeMs} verifyMs=${backup.timings.verifyMs} hashMs=${backup.timings.hashMs}`);
      log(`[db] row counts ${Object.entries(preCounts).map(([t, n]) => `${t}=${n}`).join(' ')}`);
    } else {
      log('[db] fresh database: no v10 backup needed');
    }
    const backupFile = backup?.file ?? null;

    // 4. v10 in one BEGIN IMMEDIATE transaction: DDL, record, activity row, verification and
    //    user_version all commit or roll back together.
    log(`[db] v10 migration: start from=${V9}`);
    const started = Date.now();
    const ctx: MigrationContext = { now, appVersion: opts.appVersion !== undefined ? opts.appVersion : defaultAppVersion(), fromVersion: V9, preCounts, backup };
    let result: { tables: number; recorded: boolean };
    try {
      opts.hooks?.beforeTransaction?.(db, V10);
      result = db.transaction(() => {
        const r = applyV10(db, ctx);
        db.pragma(`user_version = ${V10}`);
        opts.hooks?.beforeCommit?.(db, V10);
        return r;
      }).immediate();
    } catch (err) {
      // SQLite rolled everything back, user_version included: the database is still v9.
      const kept = backupFile ? `backup kept at ${backupFile}` : 'no backup (fresh database)';
      log(`[db] v10 migration: failed from=${V9} error=${scrub(errorMessage(err))}; database left at v${V9}; ${kept}`);
      const count = failures + 1;
      writeFailureCount(marker, count, now());
      log(count >= V10_FAILURE_LIMIT
        ? `[db] v10 migration has failed ${count} times in a row; it is held from the next launch (held: repeated_failure)`
        : `[db] v10 migration will be retried at the next launch (failure ${count} of ${V10_FAILURE_LIMIT}); set NEXUS_DB_HOLD_V10=1 to stay on v${V9}`);
      this.outcomeV10 = { state: 'failed', fromVersion: V9, error: scrub(errorMessage(err)), backupFile };
      return;
    }
    const durationMs = Date.now() - started;
    this.version = V10;
    clearFailureMarker(marker);

    // 5. Post-check after COMMIT. The v7, v8 and v9 objects are unchanged, so the platform, handoffs and execution stay on either way.
    let postOk: boolean;
    try {
      const forced = opts.hooks?.postCheck?.(db, V10);
      postOk = typeof forced === 'boolean' ? forced : integrityOk(db, 'quick');
    } catch { postOk = false; }
    if (postOk) {
      log(`[db] v10 migration: success to=${V10} durationMs=${durationMs} tables=${result.tables}`);
    } else {
      log(`[db] v10 post-check FAILED; agents disabled; restore from backup ${backupFile ?? '(none: fresh database)'}`);
    }
    this.agentsOk = postOk;
    this.outcomeV10 = { state: 'applied', fromVersion: V9, backupFile, durationMs, backfilled: 0, unassigned: 0, postCheckOk: postOk };
  }

  /** backupAndVerify never overwrites; a name already taken (same second) moves on to the next second. */
  private takeBackup(db: Database.Database, dir: string, from: number, rowCounts: Record<string, number>, now: () => number): BackupRecord {
    for (let attempt = 0; ; attempt++) {
      try {
        return backupAndVerify(db, { dir, fromVersion: from, rowCounts, now: () => now() + attempt * 1000 });
      } catch (err) {
        if (!(err instanceof BackupError) || err.stage !== 'exists' || attempt >= 4) throw err;
      }
    }
  }

  /** The schema version in effect: 10, 9, 8 or 7 once committed, otherwise what the file had (or the legacy steps reached). */
  get schemaVersion(): number { return this.version; }

  /** True only at v7 to v10 with the exact v7 shape (the v7 post-check, or the reopen shape check) passed. */
  get platformAvailable(): boolean { return this.db !== null && this.version >= V7 && this.version <= V10 && this.platformOk; }

  /** True only at v8 to v10 with the v8 post-check (or the reopen v8 shape check) passed, and the platform available. */
  get handoffsAvailable(): boolean { return this.platformAvailable && this.version >= V8 && this.version <= V10 && this.handoffsOk; }

  /**
   * True only when v9 is enabled for this open(), the store is at v9 or v10 with the v9 post-check (or the
   * reopen v9 shape check) passed, and handoffs are available (v9 sits on v8). v10 leaves execution as it is.
   */
  get executionAvailable(): boolean { return this.handoffsAvailable && this.version >= V9 && this.version <= V10 && this.executionOk && this.v9Enabled; }

  /** The v9 step's outcome; null before open(). */
  get lastMigrationV9(): MigrationOutcome | null { return this.outcomeV9; }

  /**
   * True only when v10 is enabled for this open(), the store is at v10 with the v10 post-check (or the reopen
   * v10 shape check) passed, and execution is available (v10 sits on v9). Read by the platform composition and,
   * from Task 14, by the IPC getter; nothing in this task exposes it to the renderer.
   */
  get agentsAvailable(): boolean { return this.executionAvailable && this.version >= V10 && this.agentsOk && this.v10Enabled; }

  /** The v10 step's outcome; null before open(). */
  get lastMigrationV10(): MigrationOutcomeV10 | null { return this.outcomeV10; }

  /**
   * Why agents alone are off while the platform is on. null when agents are available, and also when the
   * whole platform is off (that reason is the v7 side's).
   *   not_enabled   v10 was not enabled for this open() (PersistOpenOptions.enableV10; the default until verified),
   *                 and execution is in place
   *   held          NEXUS_DB_HOLD_V10=1 (or the v9, v8 or v7 hold) kept the database at v9
   *   auto_held     the v10 failure marker reached V10_FAILURE_LIMIT
   *   backup_failed the harness-v9 backup could not be written or verified
   *   failed        the v10 transaction rolled back, the v10 post-check failed, a pre-check or the disk
   *                 check skipped v10, or the v10 step threw unexpectedly
   *   shape         the database is at v10 but the v10 shape check failed on reopen
   * When execution is not in place (v10 skipped as v9_unavailable), the reason is executionUnavailableReason
   * (agents need execution), checked before not_enabled; that one is not_enabled when v9 is not enabled.
   */
  get agentsUnavailableReason(): AgentsUnavailableReason | null {
    if (!this.platformAvailable || this.agentsAvailable) return null;
    const o = this.outcomeV10;
    // Execution not in place comes first: agents need execution, whether or not v10 is enabled.
    if (o && o.state === 'skipped' && o.reason === 'v9_unavailable') return this.executionUnavailableReason ?? 'failed';
    if (!this.v10Enabled) return 'not_enabled';
    if (!o) return 'failed';
    if (o.state === 'skipped') {
      if (o.reason === 'held') return o.detail.startsWith('repeated_failure') ? 'auto_held' : 'held';
      if (o.reason === 'backup_failed') return 'backup_failed';
      return 'failed';
    }
    if (o.state === 'not_needed') return 'shape';
    return 'failed';
  }

  /**
   * Why execution alone is off while the platform is on. null when execution is available, and also
   * when the whole platform is off (that reason is the v7 side's). The same at v9 and at v10: v10 leaves
   * the v9 outcome as it is, so every reason below reads the v9 step's outcome at either version.
   *   not_enabled   v9 was not enabled for this open() (PersistOpenOptions.enableV9; the default until verified),
   *                 and v8 is in place (at a v10 file too: execution stays off and agents report not_enabled)
   *   held          NEXUS_DB_HOLD_V9=1 (or the v8 or v7 hold) kept the database at v8; also when v8 itself is held
   *   auto_held     the v9 failure marker reached V9_FAILURE_LIMIT (or v8 is auto-held)
   *   backup_failed the harness-v8 backup could not be written or verified (or the harness-v7 one, for v8)
   *   failed        the v9 transaction rolled back, the v9 post-check failed, a pre-check or the disk
   *                 check skipped v9, or the v9 step threw unexpectedly (or v8 failed)
   *   shape         the database is at v9 or v10 but the v9 shape check failed on reopen (or the v8 one did)
   * When v8 is not in place, the reason is handoffsUnavailableReason (execution needs handoffs), checked
   * before not_enabled.
   */
  get executionUnavailableReason(): ExecutionUnavailableReason | null {
    if (!this.platformAvailable || this.executionAvailable) return null;
    const o = this.outcomeV9;
    // v8 not in place comes first: execution needs handoffs, whether or not v9 is enabled.
    if (o && o.state === 'skipped' && o.reason === 'v8_unavailable') return this.handoffsUnavailableReason ?? 'failed';
    if (!this.v9Enabled) return 'not_enabled';
    if (!o) return 'failed';
    if (o.state === 'skipped') {
      if (o.reason === 'held') return o.detail.startsWith('repeated_failure') ? 'auto_held' : 'held';
      if (o.reason === 'backup_failed') return 'backup_failed';
      return 'failed';
    }
    if (o.state === 'not_needed') return 'shape';
    return 'failed';
  }

  /** The v7 step's outcome (unchanged contract). */
  get lastMigration(): MigrationOutcome | null { return this.outcome; }

  /** The v8 step's outcome; null before open(). */
  get lastMigrationV8(): MigrationOutcome | null { return this.outcomeV8; }

  /**
   * Why handoffs alone are off while the platform is on, from the v8 outcome. null when
   * handoffs are available, and also when the whole platform is off (that reason is the v7 side's).
   * The same at v8, v9 and v10: the later steps leave the v8 outcome as it is.
   *   held          NEXUS_DB_HOLD_V8=1 (or NEXUS_DB_HOLD_V7=1) kept the database at v7
   *   auto_held     the v8 failure marker reached V8_FAILURE_LIMIT
   *   backup_failed the harness-v7 backup could not be written or verified
   *   failed        the v8 transaction rolled back, the v8 post-check failed, a pre-check or the
   *                 disk check skipped v8, or the v8 step threw unexpectedly
   *   shape         the database is at v8, v9 or v10 but the v8 shape check failed on reopen
   */
  get handoffsUnavailableReason(): HandoffsUnavailableReason | null {
    if (!this.platformAvailable || this.handoffsAvailable) return null;
    const o = this.outcomeV8;
    if (!o) return 'failed';
    if (o.state === 'skipped') {
      if (o.reason === 'held') return o.detail.startsWith('repeated_failure') ? 'auto_held' : 'held';
      if (o.reason === 'backup_failed') return 'backup_failed';
      return 'failed';
    }
    if (o.state === 'not_needed') return 'shape';
    return 'failed';
  }

  /** The shared connection for the platform services (main process only); null unless the platform is available. */
  platformDatabase(): Database.Database | null { return this.platformAvailable ? this.db : null; }

  /** Close the handle (checkpoints WAL). Safe to call when already closed. */
  close(): void {
    // One last synchronous attempt (it stops at the first failure, so shutdown is
    // bounded by one busy_timeout), then say what could not be saved.
    // Worst case the final flush waits one busy_timeout (500ms here, lowered from 5s) on
    // its first failing write, because the flush stops at the first failure.
    try { this.db?.pragma('busy_timeout = 500'); } catch { /* best-effort */ }
    try { this.queue.flush(() => this.db !== null); } catch (e) { console.error('[legacy-store] final flush failed:', e); }
    this.queue.dispose();
    if (this.queue.size > 0) {
      console.error(`[legacy-store] closing with ${this.queue.size} unsaved write(s): ${this.queue.pendingLabels().join(', ')}`);
    }
    try { this.db?.close(); } catch { /* best-effort on shutdown */ }
    this.db = null;
    this.closed = true;
  }

  get isOpen(): boolean { return this.db !== null; }

  /** Number of writes waiting to be (re)tried. */
  get pendingWrites(): number { return this.queue.size; }

  /** Hold all writes (a migration is running). They queue and flush on resumeWrites(). */
  pauseWrites(): void { this.queue.pause(); }

  resumeWrites(): { written: number; remaining: number } {
    return this.queue.resume(() => this.db !== null);
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error('database is not open');
    return this.db;
  }

  private write(label: string, run: (db: Database.Database) => void, key?: string): void {
    if (this.closed) console.error(`[legacy-store] write "${label}" submitted after close(); it will not be flushed unless the store is reopened`);
    this.queue.submit(label, () => {
      if (!this.db) throw new Error('database is not open');
      run(this.db);
    }, this.db !== null, key);
  }

  // ─── kv (scalar app state) ─────────────────────────────────────────────────

  /** Read a JSON-decoded scalar, or undefined if absent/unparseable. */
  getKv<T = unknown>(key: string): T | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value) as T; } catch { return undefined; }
  }

  /** Upsert a JSON-encoded scalar. */
  setKv(key: string, value: unknown): void {
    // Serialize now so a retry writes this value, not whatever the object became later.
    const json = JSON.stringify(value);
    const at = Date.now();
    this.write(`setKv:${key}`, (db) => {
      db.prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(key, json, at);
    }, `kv:${key}`);
  }

  // ─── command history (net-new) ─────────────────────────────────────────────

  /** Record one submitted prompt. Empty text or missing agent id are ignored. */
  addHistory(entry: { agentId: string; cwd?: string | null; text: string }): void {
    const text = (entry.text ?? '').trim();
    if (!text || !entry.agentId) return;
    const ts = Date.now();
    this.write(`addHistory:${entry.agentId}`, (db) => {
      db.prepare('INSERT INTO command_history (agent_id, cwd, text, ts) VALUES (?, ?, ?, ?)')
        .run(entry.agentId, entry.cwd ?? null, text, ts);
    });
  }

  /** Most-recent-first history, optionally scoped to one agent. */
  listHistory(agentId?: string, limit = 100): CommandHistoryRow[] {
    if (!this.db) return [];
    const lim = clampLimit(limit, 100);
    const rows = agentId
      ? this.db.prepare(
          'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE agent_id = ? ORDER BY ts DESC, id DESC LIMIT ?'
        ).all(agentId, lim)
      : this.db.prepare(
          'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history ORDER BY ts DESC, id DESC LIMIT ?'
        ).all(lim);
    return rows as CommandHistoryRow[];
  }

  searchHistory(query: string, limit = 50): CommandHistoryRow[] {
    if (!this.db) return [];
    const q = (query ?? '').trim();
    if (!q) return [];
    const lim = clampLimit(limit, 50);
    // Escape LIKE wildcards so a literal % or _ in the query isn't a metachar.
    const needle = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.prepare(
      "SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC, id DESC LIMIT ?"
    ).all(needle, lim) as CommandHistoryRow[];
  }

  // ─── projects (domain-specialized workspaces) ─────────────────────────────

  /** Save or overwrite a project. */
  saveProject(project: Project): void {
    const snap: Project = { ...project };
    this.write(`saveProject:${project.id}`, (db) => this.saveProjectNow(db, snap), `project:${project.id}`);
  }

  private saveProjectNow(db: Database.Database, project: Project): void {
    const metadata = {
      secondaryDomains: project.secondaryDomains ?? [],
      detectedLanguages: project.detectedLanguages ?? [],
      frameworks: project.frameworks ?? [],
      dependencies: project.dependencies ?? [],
      entryPoints: project.entryPoints ?? [],
      importantFiles: project.importantFiles ?? [],
      testSuites: project.testSuites ?? [],
      documentationFiles: project.documentationFiles ?? [],
      gitInfo: project.gitInfo
    };

    const healthJson = JSON.stringify(project.health ?? { healthScore: 0 });
    const metadataJson = JSON.stringify(metadata);
    const upsert = (): void => { db.prepare(`
      INSERT INTO projects (
        id, name, root_path, domain_id, project_type, description,
        metadata_json, health_json, created_at, updated_at, last_analyzed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        root_path = excluded.root_path,
        domain_id = excluded.domain_id,
        project_type = excluded.project_type,
        description = excluded.description,
        metadata_json = excluded.metadata_json,
        health_json = excluded.health_json,
        updated_at = excluded.updated_at,
        last_analyzed_at = excluded.last_analyzed_at
    `).run(
      project.id,
      project.name,
      project.rootPath,
      project.domainId,
      project.projectType,
      project.description ?? null,
      metadataJson,
      healthJson,
      project.createdAt || Date.now(),
      project.updatedAt || Date.now(),
      project.lastAnalyzedAt || Date.now()
    ); };
    if (!this.platformAvailable) { upsert(); return; }
    // v7: the upsert and the primary participation change in one IMMEDIATE transaction.
    const callerTx = db.inTransaction;
    let aborted = false;
    const run = (): void => {
      upsert();
      if (this.syncPrimaryCaught(db, project.id, project.domainId ?? null) === 'aborted') {
        aborted = true;
        throw new Error('primary sync aborted the transaction');
      }
    };
    try {
      if (callerTx) run(); else db.transaction(run).immediate();
    } catch (err) {
      if (!aborted) throw err;
      // The whole transaction (with the upsert) is gone. Inside a caller's transaction
      // there is nothing safe to redo: the caller's work was rolled back too, so the
      // error goes up the legacy path. Otherwise save once more, without the platform.
      if (callerTx) throw err;
      this.nexusLogLine('[nexus] primary sync aborted the transaction; saved without sync');
      upsert();
    }
  }

  /**
   * The primary-participation sync, in a SAVEPOINT nested in the save's transaction.
   * It never fails the legacy save: on a throw the savepoint rolls back, the line is
   * logged, the project row still commits, and nothing is queued for retry. The
   * platform's startup reconcile repairs the primary later.
   */
  private syncPrimaryCaught(db: Database.Database, projectId: string, domainId: string | null): 'ok' | 'failed' | 'aborted' {
    try {
      db.transaction(() => syncPrimaryFromLegacyDomain(db, projectId, domainId, this.nexusNow(), (l) => this.nexusLogLine(this.nexusScrub(l))))();
      return 'ok';
    } catch (err) {
      this.nexusLogLine(`[nexus] primary sync failed project=${this.nexusScrub(String(projectId))} error=${this.nexusScrub(errorMessage(err))}`);
      // RAISE(ROLLBACK) and some FULL/IOERR/NOMEM errors end the whole transaction, not just the savepoint.
      return db.inTransaction ? 'failed' : 'aborted';
    }
  }

  private nexusLogLine(line: string): void {
    try { this.nexusLog(line); } catch { /* logging never breaks a save */ }
  }

  /**
   * True when the project owns platform records (artifacts, jobs, agent sessions,
   * handoffs, deployments or approvals), which reference it with ON DELETE RESTRICT. False below v7. A failing check
   * answers true, so a project is kept rather than half-deleted.
   */
  hasPlatformRecords(projectId: string): boolean {
    if (!this.db || this.version < V7 || !projectId) return false;
    try {
      // A missing table holds no records; the query covers only the tables that exist.
      const present = (this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
          AND name IN ('artifacts', 'jobs', 'agent_sessions', 'handoffs', 'deployments', 'approvals')`).pluck().all() as string[])
        .filter((t) => PLATFORM_RECORD_TABLES.includes(t));
      if (present.length === 0) return false;
      const sql = `SELECT ${present.map((t) => `EXISTS (SELECT 1 FROM ${t} WHERE project_id = ?)`).join(' OR ')} AS has`;
      return this.db.prepare(sql).pluck().get(...present.map(() => projectId)) === 1;
    } catch (err) {
      this.nexusLogLine(`[nexus] platform record check failed project=${this.nexusScrub(projectId)} error=${this.nexusScrub(errorMessage(err))}; treating as present`);
      return true;
    }
  }

  /** Read a project by ID. */
  getProject(id: string): Project | null {
    if (!this.db || !id) return null;
    const row = this.db.prepare(
      'SELECT * FROM projects WHERE id = ?'
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return deserializeProjectRow(row);
  }

  /** List all projects ordered by most recently updated. */
  listProjects(): Project[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM projects ORDER BY updated_at DESC'
    ).all() as Record<string, unknown>[];
    return rows.map(deserializeProjectRow).filter((p): p is Project => p !== null);
  }

  /** Update an existing project partially. */
  updateProject(id: string, patch: Partial<Project>): Project | null {
    // Read-modify-write. When the DB is not open this returns null (as before)
    // and logs. When it is open and the read or write throws, the WHOLE operation
    // is queued, so the retry re-reads and applies the patch to the latest row.
    if (!this.db) { console.error(`[legacy-store] updateProject(${id}) skipped: database is not open`); return null; }
    let result: Project | null = null;
    const patchCopy: Partial<Project> = { ...patch };
    const outcome = this.queue.submit(`updateProject:${id}`, () => {
      const existing = this.getProject(id);
      if (!existing) { result = null; return; }
      const updated: Project = { ...existing, ...patchCopy, id: existing.id, updatedAt: Date.now() };
      this.saveProjectNow(this.requireDb(), updated);
      result = updated;
    }, true);
    if (outcome === 'written') return result;
    // Queued: hand back the best-known optimistic value (null when it cannot be read).
    try {
      const existing = this.getProject(id);
      return existing ? { ...existing, ...patchCopy, id: existing.id, updatedAt: Date.now() } : null;
    } catch { return null; }
  }

  /**
   * Delete a project by ID. Returns true if removed. With `withGraph`, the project's
   * knowledge graph is deleted in the SAME transaction, only when the project row is
   * actually removed, and only after the (queued) platform-record re-check passed:
   * a delete refused at any point keeps the graph.
   */
  deleteProject(id: string, o?: { withGraph?: boolean }): boolean {
    // Same contract as updateProject: not open -> false + log; open and the
    // write throws -> the whole operation is queued (returns whether the row was seen).
    if (!id) return false;
    if (!this.db) { console.error(`[legacy-store] deleteProject(${id}) skipped: database is not open`); return false; }
    if (this.hasPlatformRecords(id)) {
      this.nexusLogLine(`[nexus] deleteProject refused project=${this.nexusScrub(id)}: it has platform records (artifacts, jobs or agent sessions)`);
      return false;
    }
    let removed = false;
    const outcome = this.queue.submit(`deleteProject:${id}`, () => {
      const db = this.db;
      if (!db) throw new Error('database is not open');
      // A queued delete runs later: platform records may have appeared since. Refuse
      // without throwing, so the queue does not retry it forever.
      if (this.hasPlatformRecords(id)) {
        this.nexusLogLine(`[nexus] queued deleteProject refused project=${this.nexusScrub(id)}: it has platform records`);
        removed = false;
        return;
      }
      // One transaction: the row, the active-project pointer and (withGraph) the graph change together or not at all.
      db.transaction(() => {
        const res = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
        if (res.changes > 0 && o?.withGraph) {
          db.prepare('DELETE FROM project_graph_nodes WHERE project_id = ?').run(id);
          db.prepare('DELETE FROM project_graph_edges WHERE project_id = ?').run(id);
        }
        if (this.getActiveProjectId() === id) db.prepare(
          `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run('active_project_id', 'null', Date.now());
        removed = res.changes > 0;
      })();
    }, true);
    if (outcome === 'written') return removed;
    try { return this.getProject(id) !== null; } catch { return false; }
  }

  /** Get active project ID from kv store. */
  getActiveProjectId(): string | null {
    return this.getKv<string>('active_project_id') ?? null;
  }

  /** Set active project ID in kv store. */
  setActiveProjectId(id: string | null): void {
    this.setKv('active_project_id', id); // queued (coalesced per key) like every kv write
  }

  // ─── project knowledge graph ──────────────────────────────────────────────

  /**
   * Save a project's knowledge graph (nodes + edges) in an atomic transaction.
   * Replaces any existing graph for this projectId.
   */
  saveProjectGraph(projectId: string, nodes: ProjectGraphNode[], edges: ProjectGraphEdge[]): void {
    if (!projectId) return;
    this.write(`saveProjectGraph:${projectId}`, (db) => this.saveProjectGraphNow(db, projectId, nodes, edges), `graph:${projectId}`);
  }

  private saveProjectGraphNow(db: Database.Database, projectId: string, nodes: ProjectGraphNode[], edges: ProjectGraphEdge[]): void {
    const deleteNodes = db.prepare('DELETE FROM project_graph_nodes WHERE project_id = ?');
    const deleteEdges = db.prepare('DELETE FROM project_graph_edges WHERE project_id = ?');

    const insertNode = db.prepare(`
      INSERT INTO project_graph_nodes (id, project_id, kind, name, path, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertEdge = db.prepare(`
      INSERT INTO project_graph_edges (id, project_id, source_id, target_id, kind, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      deleteNodes.run(projectId);
      deleteEdges.run(projectId);

      for (const node of nodes) {
        insertNode.run(
          node.id,
          projectId,
          node.kind,
          node.name,
          node.path ?? null,
          JSON.stringify(node.metadata ?? {})
        );
      }

      for (const edge of edges) {
        insertEdge.run(
          edge.id,
          projectId,
          edge.source,
          edge.target,
          edge.kind,
          JSON.stringify(edge.metadata ?? {})
        );
      }
    });

    tx();
  }

  /** Get a single graph node by ID. */
  getProjectGraphNode(projectId: string, nodeId: string): ProjectGraphNode | null {
    if (!this.db || !projectId || !nodeId) return null;
    const row = this.db.prepare(
      'SELECT id, project_id AS projectId, kind, name, path, metadata_json FROM project_graph_nodes WHERE project_id = ? AND id = ?'
    ).get(projectId, nodeId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return deserializeGraphNodeRow(row);
  }

  /** Get nodes for a project with optional filtering. */
  getProjectGraphNodes(projectId: string, filter?: ProjectGraphQueryFilter): ProjectGraphNode[] {
    if (!this.db || !projectId) return [];
    let query = 'SELECT id, project_id AS projectId, kind, name, path, metadata_json FROM project_graph_nodes WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (filter?.kind) {
      query += ' AND kind = ?';
      params.push(filter.kind);
    }
    if (filter?.path) {
      query += ' AND path = ?';
      params.push(filter.path);
    }
    if (filter?.name) {
      query += ' AND name LIKE ?';
      params.push(`%${filter.name}%`);
    }

    query += ' ORDER BY kind ASC, name ASC';
    if (filter?.limit) {
      query += ' LIMIT ?';
      params.push(clampLimit(filter.limit, 100));
    }

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(deserializeGraphNodeRow).filter((n): n is ProjectGraphNode => n !== null);
  }

  /** Get edges for a project with optional filtering. */
  getProjectGraphEdges(
    projectId: string,
    filter?: { sourceId?: string; targetId?: string; kind?: ProjectGraphRelationKind; limit?: number }
  ): ProjectGraphEdge[] {
    if (!this.db || !projectId) return [];
    let query = 'SELECT id, project_id AS projectId, source_id AS source, target_id AS target, kind, metadata_json FROM project_graph_edges WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (filter?.sourceId) {
      query += ' AND source_id = ?';
      params.push(filter.sourceId);
    }
    if (filter?.targetId) {
      query += ' AND target_id = ?';
      params.push(filter.targetId);
    }
    if (filter?.kind) {
      query += ' AND kind = ?';
      params.push(filter.kind);
    }

    if (filter?.limit) {
      query += ' LIMIT ?';
      params.push(clampLimit(filter.limit, 500));
    }

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(deserializeGraphEdgeRow).filter((e): e is ProjectGraphEdge => e !== null);
  }

  /** Get direct neighbors and edges connected to a node. */
  getProjectGraphNeighbors(
    projectId: string,
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'both'
  ): { nodes: ProjectGraphNode[]; edges: ProjectGraphEdge[] } {
    if (!this.db || !projectId || !nodeId) return { nodes: [], edges: [] };

    let edgeQuery = 'SELECT id, project_id AS projectId, source_id AS source, target_id AS target, kind, metadata_json FROM project_graph_edges WHERE project_id = ? AND ';
    if (direction === 'outgoing') {
      edgeQuery += 'source_id = ?';
    } else if (direction === 'incoming') {
      edgeQuery += 'target_id = ?';
    } else {
      edgeQuery += '(source_id = ? OR target_id = ?)';
    }

    const edgeParams = direction === 'both' ? [projectId, nodeId, nodeId] : [projectId, nodeId];
    const edgeRows = this.db.prepare(edgeQuery).all(...edgeParams) as Record<string, unknown>[];
    const edges = edgeRows.map(deserializeGraphEdgeRow).filter((e): e is ProjectGraphEdge => e !== null);

    const neighborIds = new Set<string>();
    for (const e of edges) {
      if (e.source !== nodeId) neighborIds.add(e.source);
      if (e.target !== nodeId) neighborIds.add(e.target);
    }

    if (neighborIds.size === 0) return { nodes: [], edges };

    const placeholders = Array.from(neighborIds).map(() => '?').join(',');
    const nodeRows = this.db.prepare(
      `SELECT id, project_id AS projectId, kind, name, path, metadata_json FROM project_graph_nodes WHERE project_id = ? AND id IN (${placeholders})`
    ).all(projectId, ...neighborIds) as Record<string, unknown>[];

    const nodes = nodeRows.map(deserializeGraphNodeRow).filter((n): n is ProjectGraphNode => n !== null);
    return { nodes, edges };
  }

  /**
   * Traverse a subgraph up to N depth levels around a root node.
   */
  getProjectSubgraph(projectId: string, rootNodeId: string, depth = 1): ProjectSubgraph {
    if (!this.db || !projectId || !rootNodeId) {
      return { rootNodeId, depth, nodes: [], edges: [] };
    }

    const maxDepth = Math.max(1, Math.min(5, depth));
    const visitedNodeIds = new Set<string>([rootNodeId]);
    const collectedEdges = new Map<string, ProjectGraphEdge>();
    let currentFrontier = new Set<string>([rootNodeId]);

    for (let d = 0; d < maxDepth; d++) {
      if (currentFrontier.size === 0) break;
      const nextFrontier = new Set<string>();

      const placeholders = Array.from(currentFrontier).map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT id, project_id AS projectId, source_id AS source, target_id AS target, kind, metadata_json
        FROM project_graph_edges
        WHERE project_id = ? AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
      `).all(projectId, ...currentFrontier, ...currentFrontier) as Record<string, unknown>[];

      for (const row of rows) {
        const edge = deserializeGraphEdgeRow(row);
        if (!edge) continue;
        collectedEdges.set(edge.id, edge);

        if (!visitedNodeIds.has(edge.source)) {
          visitedNodeIds.add(edge.source);
          nextFrontier.add(edge.source);
        }
        if (!visitedNodeIds.has(edge.target)) {
          visitedNodeIds.add(edge.target);
          nextFrontier.add(edge.target);
        }
      }

      currentFrontier = nextFrontier;
    }

    // Retrieve all visited nodes
    const nodePlaceholders = Array.from(visitedNodeIds).map(() => '?').join(',');
    const nodeRows = this.db.prepare(`
      SELECT id, project_id AS projectId, kind, name, path, metadata_json
      FROM project_graph_nodes
      WHERE project_id = ? AND id IN (${nodePlaceholders})
    `).all(projectId, ...visitedNodeIds) as Record<string, unknown>[];

    const nodes = nodeRows.map(deserializeGraphNodeRow).filter((n): n is ProjectGraphNode => n !== null);
    return {
      rootNodeId,
      depth: maxDepth,
      nodes,
      edges: Array.from(collectedEdges.values())
    };
  }

  /** Get statistical overview of a project's knowledge graph. */
  getProjectGraphStats(projectId: string): ProjectGraphStats {
    const emptyStats: ProjectGraphStats = {
      projectId,
      nodeCount: 0,
      edgeCount: 0,
      fileCount: 0,
      functionCount: 0,
      classCount: 0,
      testCount: 0,
      docCount: 0,
      byKind: {},
      byRelation: {}
    };

    if (!this.db || !projectId) return emptyStats;

    // Node statistics
    const nodeKinds = this.db.prepare(`
      SELECT kind, COUNT(*) AS count
      FROM project_graph_nodes
      WHERE project_id = ?
      GROUP BY kind
    `).all(projectId) as { kind: string; count: number }[];

    let totalNodes = 0;
    const byKind: Record<string, number> = {};
    for (const r of nodeKinds) {
      byKind[r.kind] = Number(r.count);
      totalNodes += Number(r.count);
    }

    // Edge statistics
    const edgeKinds = this.db.prepare(`
      SELECT kind, COUNT(*) AS count
      FROM project_graph_edges
      WHERE project_id = ?
      GROUP BY kind
    `).all(projectId) as { kind: string; count: number }[];

    let totalEdges = 0;
    const byRelation: Record<string, number> = {};
    for (const r of edgeKinds) {
      byRelation[r.kind] = Number(r.count);
      totalEdges += Number(r.count);
    }

    return {
      projectId,
      nodeCount: totalNodes,
      edgeCount: totalEdges,
      fileCount: byKind['file'] ?? 0,
      functionCount: byKind['function'] ?? 0,
      classCount: byKind['class'] ?? 0,
      testCount: (byKind['test_suite'] ?? 0) + (byKind['test_case'] ?? 0),
      docCount: byKind['documentation'] ?? 0,
      byKind,
      byRelation
    };
  }

  /** Delete a project's knowledge graph entirely. */
  deleteProjectGraph(projectId: string): void {
    if (!projectId) return;
    this.write(`deleteProjectGraph:${projectId}`, (db) => db.transaction(() => {
      db.prepare('DELETE FROM project_graph_nodes WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM project_graph_edges WHERE project_id = ?').run(projectId);
    })(), `graph:${projectId}`);
  }

  // ─── Phase 8A: Project Plans ──────────────────────────────────────────────

  /** Retrieve the persisted milestone and task graph plan for a project. */
  getProjectPlan(projectId: string): ProjectPlan | null {
    if (!this.db || !projectId) return null;
    const row = this.db
      .prepare('SELECT plan_json FROM project_plans WHERE project_id = ?')
      .get(projectId) as { plan_json?: string } | undefined;

    if (!row?.plan_json) return null;
    try {
      return JSON.parse(row.plan_json) as ProjectPlan;
    } catch {
      return null;
    }
  }

  /** Save or update a project's milestone and task graph plan. */
  saveProjectPlan(plan: ProjectPlan): void {
    if (!plan?.projectId) return;
    const json = JSON.stringify(plan);
    const at = Date.now();
    this.write(`saveProjectPlan:${plan.projectId}`, (db) => db
      .prepare(
        `INSERT INTO project_plans (project_id, plan_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           plan_json  = excluded.plan_json,
           updated_at = excluded.updated_at`
      )
      .run(plan.projectId, json, at), `plan:${plan.projectId}`);
  }

  /** Delete a project's plan. */
  deleteProjectPlan(projectId: string): void {
    if (!projectId) return;
    this.write(`deleteProjectPlan:${projectId}`, (db) => db.prepare('DELETE FROM project_plans WHERE project_id = ?').run(projectId), `plan:${projectId}`);
  }

  // ─── Phase 8B: Project Gap Analysis Records ───────────────────────────────

  /** Retrieve the persisted gap analysis result for a project. */
  getProjectGapAnalysis(projectId: string): ProjectGapAnalysisResult | null {
    if (!this.db || !projectId) return null;
    const row = this.db
      .prepare('SELECT gaps_json FROM project_gaps WHERE project_id = ?')
      .get(projectId) as { gaps_json?: string } | undefined;

    if (!row?.gaps_json) return null;
    try {
      return JSON.parse(row.gaps_json) as ProjectGapAnalysisResult;
    } catch {
      return null;
    }
  }

  /** Save or update a project's gap analysis result. */
  saveProjectGapAnalysis(result: ProjectGapAnalysisResult): void {
    if (!result?.projectId) return;
    const json = JSON.stringify(result);
    const at = Date.now();
    this.write(`saveProjectGapAnalysis:${result.projectId}`, (db) => db
      .prepare(
        `INSERT INTO project_gaps (project_id, gaps_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           gaps_json  = excluded.gaps_json,
           updated_at = excluded.updated_at`
      )
      .run(result.projectId, json, at), `gaps:${result.projectId}`);
  }

  /** Delete a project's gap analysis records. */
  deleteProjectGapAnalysis(projectId: string): void {
    if (!projectId) return;
    this.write(`deleteProjectGapAnalysis:${projectId}`, (db) => db.prepare('DELETE FROM project_gaps WHERE project_id = ?').run(projectId), `gaps:${projectId}`);
  }

  // ─── Phase 8C: Project Goals & Required Capabilities ──────────────────────

  /** Retrieve the persisted project goal. */
  getProjectGoal(projectId: string): ProjectGoal | null {
    if (!this.db || !projectId) return null;
    const row = this.db
      .prepare('SELECT goal_json FROM project_goals WHERE project_id = ?')
      .get(projectId) as { goal_json?: string } | undefined;

    if (!row?.goal_json) return null;
    try {
      return JSON.parse(row.goal_json) as ProjectGoal;
    } catch {
      return null;
    }
  }

  /** Save or update a project's goal definition. */
  saveProjectGoal(goal: ProjectGoal): void {
    if (!goal?.projectId) return;
    const json = JSON.stringify(goal);
    const at = Date.now();
    this.write(`saveProjectGoal:${goal.projectId}`, (db) => db
      .prepare(
        `INSERT INTO project_goals (project_id, goal_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           goal_json  = excluded.goal_json,
           updated_at = excluded.updated_at`
      )
      .run(goal.projectId, json, at), `goal:${goal.projectId}`);
  }

  /** Delete a project's goal records. */
  deleteProjectGoal(projectId: string): void {
    if (!projectId) return;
    this.write(`deleteProjectGoal:${projectId}`, (db) => db.prepare('DELETE FROM project_goals WHERE project_id = ?').run(projectId), `goal:${projectId}`);
  }
}

function deserializeGraphNodeRow(row: Record<string, unknown>): ProjectGraphNode | null {
  try {
    const meta = JSON.parse(String(row.metadata_json || '{}'));
    return {
      id: String(row.id),
      projectId: String(row.projectId || row.project_id),
      kind: String(row.kind) as ProjectGraphNodeKind,
      name: String(row.name),
      path: row.path ? String(row.path) : undefined,
      metadata: meta && typeof meta === 'object' ? meta : undefined
    };
  } catch {
    return null;
  }
}

function deserializeGraphEdgeRow(row: Record<string, unknown>): ProjectGraphEdge | null {
  try {
    const meta = JSON.parse(String(row.metadata_json || '{}'));
    return {
      id: String(row.id),
      projectId: String(row.projectId || row.project_id),
      source: String(row.source || row.source_id),
      target: String(row.target || row.target_id),
      kind: String(row.kind) as ProjectGraphRelationKind,
      metadata: meta && typeof meta === 'object' ? meta : undefined
    };
  } catch {
    return null;
  }
}

function deserializeProjectRow(row: Record<string, unknown>): Project | null {
  try {
    const meta = JSON.parse(String(row.metadata_json || '{}')) as Record<string, unknown>;
    const health = JSON.parse(String(row.health_json || '{}'));
    return {
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      domainId: String(row.domain_id),
      secondaryDomains: Array.isArray(meta.secondaryDomains) ? meta.secondaryDomains as string[] : [],
      projectType: row.project_type as Project['projectType'],
      description: row.description ? String(row.description) : undefined,
      detectedLanguages: Array.isArray(meta.detectedLanguages) ? meta.detectedLanguages as Project['detectedLanguages'] : [],
      frameworks: Array.isArray(meta.frameworks) ? meta.frameworks as string[] : [],
      dependencies: Array.isArray(meta.dependencies) ? meta.dependencies as Project['dependencies'] : [],
      entryPoints: Array.isArray(meta.entryPoints) ? meta.entryPoints as string[] : [],
      importantFiles: Array.isArray(meta.importantFiles) ? meta.importantFiles as string[] : [],
      testSuites: Array.isArray(meta.testSuites) ? meta.testSuites as Project['testSuites'] : [],
      documentationFiles: Array.isArray(meta.documentationFiles) ? meta.documentationFiles as string[] : [],
      gitInfo: (meta.gitInfo && typeof meta.gitInfo === 'object') ? meta.gitInfo as Project['gitInfo'] : undefined,
      health: health && typeof health === 'object' ? health : { healthScore: 0 },
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastAnalyzedAt: Number(row.last_analyzed_at)
    };
  } catch {
    return null;
  }
}

/** Coerce an untrusted limit into [1, 1000] with a sane fallback. */
function clampLimit(n: number, fallback: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(1000, v);
}
