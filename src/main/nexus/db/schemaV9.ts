/**
 * Schema v9: execution records (job attempts, job events), the content-addressed blob
 * index (blobs, version_blobs), the producing attempt of each ingested version
 * (version_attempts), validator results, approvals, image builds, local dev deployments,
 * their state vocabularies as lookup tables, four lineage relation rows (D12), seven
 * indexes on v7 tables used by the execution core, and three backstop triggers on the v7
 * jobs table (constraint 4: a tool or validate job completes only when its current
 * attempt succeeded; the attempt count never decreases; no job ends or goes back to
 * waiting while an attempt is live). Additive only: every statement is
 * CREATE ... IF NOT EXISTS or INSERT OR IGNORE; nothing in v1-v8 is altered and no FK
 * is added to a v1-v8 table.
 *
 * V9_DDL is copied verbatim from the approved B2a plan ("Schema v9 / Full DDL").
 * It is shipped migration text: never edit it - later changes go in a new migration.
 * (One change before v9 ever ran on a real database, B2a Task 9 fix round 2: the `deployments.stop_reason` vocabulary
 * gained 'refused', 'preflight_failed', 'runner_lost' and 'exit_not_reported', so the row stores a deployment's true
 * end cause. V9_ENABLED_BY_DEFAULT was false and no database had v9 at the time.)
 * (The two `'%\%'` LIKE patterns are written `\\%` below so the SQL text keeps its backslash.)
 *
 * applyV9 runs inside the caller's single BEGIN IMMEDIATE transaction:
 *   exact v7 shape -> exact v8 shape -> v9 shape pre-check -> DDL -> seeds ->
 *   nexus_migrations record -> one activity row (only when the record is new) -> verifyV9.
 * Any throw rolls the whole step back, including user_version.
 *
 * Ordering: image_builds references approvals and job_events references image_builds.
 * SQLite resolves FK targets at use, not at CREATE, so the order is valid; the
 * foreign_key_check in verifyV9 confirms it.
 *
 * Known limit of the triggers (as v8): recursive_triggers is off, so INSERT OR REPLACE
 * (and an upsert's DO UPDATE) on a protected table deletes or rewrites the old row
 * without firing its BEFORE DELETE / BEFORE UPDATE guard. That is closed as a pinned
 * source rule: test/nexus-core-append-only-writes.test.cjs derives its protected set
 * from V7_DDL, V8_DDL and V9_DDL. INSERT OR IGNORE is fine: it never deletes.
 */
import type Database from 'better-sqlite3';
import type { MigrationContext } from './migrationTypes';
import {
  V9_APPROVAL_STATES, V9_APPROVAL_TRANSITIONS, V9_ATTEMPT_STATES, V9_ATTEMPT_TRANSITIONS,
  V9_DEPLOYMENT_STATES, V9_DEPLOYMENT_TRANSITIONS, V9_LINEAGE_RELATIONS
} from './v9Seed';
import { ddlObjects, normaliseSql, v7ShapeProblem, type V7DdlObject } from './schemaV7';
import { v8ShapeProblem } from './schemaV8';
import { V11_TRIGGER_NAME, V11_TRIGGER_SQL } from './schemaV11Trigger';
import { appendActivityRow } from '../activity/writer';

export const V9_DDL: string = `
-- ===== attempt vocabulary =====
CREATE TABLE IF NOT EXISTS attempt_states (
  state       TEXT PRIMARY KEY CHECK (state GLOB '[a-z]*' AND length(state) BETWEEN 2 AND 32),
  terminal    INTEGER NOT NULL CHECK (terminal IN (0,1)),
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempt_transitions (
  from_state TEXT NOT NULL REFERENCES attempt_states(state),
  to_state   TEXT NOT NULL REFERENCES attempt_states(state),
  PRIMARY KEY (from_state, to_state),
  CHECK (from_state <> to_state)
);

-- ===== job attempts: what actually executed, one row per try =====
CREATE TABLE IF NOT EXISTS job_attempts (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  n                INTEGER NOT NULL CHECK (n >= 1),
  state            TEXT NOT NULL REFERENCES attempt_states(state),
  boot_id          TEXT NOT NULL CHECK (length(boot_id) = 26),          -- the boot that created it (immutable)
  lease_owner      TEXT NOT NULL CHECK (length(lease_owner) = 26),      -- the boot that owns it now (adoption moves it)
  lease_expires_at INTEGER NOT NULL,
  heartbeat_at     INTEGER,
  container_id     TEXT CHECK (container_id IS NULL OR (length(container_id) = 64 AND container_id NOT GLOB '*[^0-9a-f]*')),
  exit_code        INTEGER,
  signal           TEXT CHECK (signal IS NULL OR length(signal) BETWEEN 1 AND 32),
  oom_killed       INTEGER CHECK (oom_killed IS NULL OR oom_killed IN (0,1)),
  outcome          TEXT CHECK (outcome IS NULL OR (outcome GLOB '[a-z]*' AND length(outcome) <= 32)),
  error_json       TEXT CHECK (error_json IS NULL OR json_valid(error_json)),          -- redacted {code,message}
  sandbox_json     TEXT CHECK (sandbox_json IS NULL OR (json_valid(sandbox_json) AND length(sandbox_json) <= 32768)),
  environment_json TEXT CHECK (environment_json IS NULL OR (json_valid(environment_json) AND length(environment_json) <= 8192)),
  runtime_kind     TEXT CHECK (runtime_kind IS NULL OR length(runtime_kind) BETWEEN 1 AND 32),
  runtime_ref      TEXT CHECK (runtime_ref IS NULL OR length(runtime_ref) BETWEEN 1 AND 128),
  log_path         TEXT CHECK (log_path IS NULL OR (length(log_path) <= 200 AND log_path NOT LIKE '/%'
                     AND log_path NOT LIKE '%:%' AND log_path NOT LIKE '%..%' AND log_path NOT LIKE '%\\%')),
  log_bytes        INTEGER NOT NULL DEFAULT 0 CHECK (log_bytes >= 0),
  out_bytes        INTEGER NOT NULL DEFAULT 0 CHECK (out_bytes >= 0),
  usage_json       TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER,
  updated_at       INTEGER NOT NULL,
  UNIQUE (job_id, n),
  CHECK ((state IN ('starting','running')) = (finished_at IS NULL)),
  CHECK (state <> 'running' OR started_at IS NOT NULL),
  CHECK (state <> 'succeeded' OR (exit_code IS NOT NULL AND outcome IS NOT NULL)),
  CHECK (state NOT IN ('running','succeeded') OR (sandbox_json IS NOT NULL AND environment_json IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_attempts_live      ON job_attempts(job_id) WHERE state IN ('starting','running');
CREATE INDEX        IF NOT EXISTS ix_attempts_lease     ON job_attempts(state, lease_expires_at) WHERE state IN ('starting','running');
CREATE INDEX        IF NOT EXISTS ix_attempts_container ON job_attempts(container_id) WHERE container_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tr_attempts_insert BEFORE INSERT ON job_attempts
BEGIN
  SELECT RAISE(ABORT, 'an attempt starts as starting, unfinished and without a container')
    WHERE NEW.state <> 'starting' OR NEW.finished_at IS NOT NULL OR NEW.container_id IS NOT NULL OR NEW.exit_code IS NOT NULL;
  SELECT RAISE(ABORT, 'an attempt is inserted with the lease of its job and carries the job attempt count')
    WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = NEW.job_id AND j.state = 'leased' AND j.attempts = NEW.n);
  SELECT RAISE(ABORT, 'a new attempt is owned by the boot that created it')
    WHERE NEW.lease_owner <> NEW.boot_id;
END;
CREATE TRIGGER IF NOT EXISTS tr_attempts_transition BEFORE UPDATE OF state ON job_attempts
WHEN NEW.state IS NOT OLD.state
BEGIN
  SELECT RAISE(ABORT, 'illegal attempt transition')
    WHERE NOT EXISTS (SELECT 1 FROM attempt_transitions t WHERE t.from_state = OLD.state AND t.to_state = NEW.state);
END;
CREATE TRIGGER IF NOT EXISTS tr_attempts_identity BEFORE UPDATE ON job_attempts
WHEN NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.n IS NOT OLD.n
  OR NEW.boot_id IS NOT OLD.boot_id OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.container_id IS NOT NULL AND NEW.container_id IS NOT OLD.container_id)
  OR (OLD.log_path IS NOT NULL AND NEW.log_path IS NOT OLD.log_path)
BEGIN SELECT RAISE(ABORT, 'attempt identity, container and log path are immutable once set'); END;
CREATE TRIGGER IF NOT EXISTS tr_attempts_terminal_frozen BEFORE UPDATE ON job_attempts
WHEN OLD.state IN ('succeeded','failed','cancelled','timed_out','abandoned')
BEGIN SELECT RAISE(ABORT, 'a finished attempt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_attempts_no_delete BEFORE DELETE ON job_attempts
BEGIN SELECT RAISE(ABORT, 'attempts are never deleted'); END;

-- ===== image builds: approved image preparations (not project-scoped, so not jobs) =====
CREATE TABLE IF NOT EXISTS image_builds (
  id             TEXT PRIMARY KEY,
  profile_id     TEXT NOT NULL CHECK (profile_id GLOB '[a-z]*' AND length(profile_id) BETWEEN 3 AND 32),
  approval_id    TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  status         TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','interrupted')),
  context_sha256 TEXT NOT NULL CHECK (length(context_sha256) = 64 AND context_sha256 NOT GLOB '*[^0-9a-f]*'),
  base_digest    TEXT NOT NULL CHECK (base_digest GLOB 'sha256:*' AND length(base_digest) = 71),
  image_id       TEXT CHECK (image_id IS NULL OR (image_id GLOB 'sha256:*' AND length(image_id) = 71)),
  size_bytes     INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  log_path       TEXT CHECK (log_path IS NULL OR (length(log_path) <= 200 AND log_path NOT LIKE '/%' AND log_path NOT LIKE '%..%' AND log_path NOT LIKE '%:%'
                   AND log_path NOT LIKE '%\\%')),
  error_json     TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  requested_by   TEXT NOT NULL REFERENCES principals(id),
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK (status <> 'succeeded' OR (image_id IS NOT NULL AND size_bytes IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_image_builds_profile ON image_builds(profile_id, started_at DESC);
CREATE TRIGGER IF NOT EXISTS tr_image_builds_insert BEFORE INSERT ON image_builds
BEGIN
  SELECT RAISE(ABORT, 'an image build starts running') WHERE NEW.status <> 'running' OR NEW.image_id IS NOT NULL;
  SELECT RAISE(ABORT, 'an image build needs an approved, consumed image.prepare approval for this profile and context')
    WHERE NOT EXISTS (SELECT 1 FROM approvals a WHERE a.id = NEW.approval_id AND a.reason = 'image.prepare'
      AND a.status = 'approved' AND a.consumed_at IS NOT NULL
      AND json_extract(a.request_json, '$.profileId') = NEW.profile_id
      AND json_extract(a.request_json, '$.contextSha256') = NEW.context_sha256);
  SELECT RAISE(ABORT, 'an image build is requested by the principal its approval was requested for')
    WHERE NEW.requested_by IS NOT (SELECT a.on_behalf_of FROM approvals a WHERE a.id = NEW.approval_id);
END;
CREATE TRIGGER IF NOT EXISTS tr_image_builds_update BEFORE UPDATE ON image_builds
BEGIN
  SELECT RAISE(ABORT, 'a finished image build is immutable') WHERE OLD.status <> 'running';
  SELECT RAISE(ABORT, 'image build identity is immutable')
    WHERE NEW.id IS NOT OLD.id OR NEW.profile_id IS NOT OLD.profile_id OR NEW.approval_id IS NOT OLD.approval_id
       OR NEW.context_sha256 IS NOT OLD.context_sha256 OR NEW.base_digest IS NOT OLD.base_digest
       OR NEW.requested_by IS NOT OLD.requested_by OR NEW.started_at IS NOT OLD.started_at;
END;
CREATE TRIGGER IF NOT EXISTS tr_image_builds_no_delete BEFORE DELETE ON image_builds
BEGIN SELECT RAISE(ABORT, 'image builds are never deleted'); END;

-- ===== job events: append-only, redacted execution facts (heartbeats are not events) =====
CREATE TABLE IF NOT EXISTS job_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  project_id     TEXT REFERENCES projects(id),
  job_id         TEXT REFERENCES jobs(id),
  attempt_n      INTEGER CHECK (attempt_n IS NULL OR attempt_n >= 1),
  image_build_id TEXT REFERENCES image_builds(id),
  approval_id    TEXT REFERENCES approvals(id),
  deployment_id  TEXT REFERENCES deployments(id),
  type           TEXT NOT NULL CHECK (type IN ('job.transition','attempt.transition','attempt.provisioned','attempt.progress',
                   'attempt.output','attempt.heartbeat_gap','approval','deployment','validation','image_build','recovery','preflight')),
  summary        TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 200),
  data_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json) AND length(data_json) <= 4096),
  CHECK (job_id IS NOT NULL OR image_build_id IS NOT NULL OR approval_id IS NOT NULL),
  CHECK (attempt_n IS NULL OR job_id IS NOT NULL),
  FOREIGN KEY (job_id, attempt_n) REFERENCES job_attempts(job_id, n)
);
CREATE INDEX IF NOT EXISTS ix_job_events_job     ON job_events(job_id, seq) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_job_events_project ON job_events(project_id, seq) WHERE project_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tr_job_events_insert BEFORE INSERT ON job_events
BEGIN
  SELECT RAISE(ABORT, 'a job event names the project of its job')
    WHERE NEW.job_id IS NOT NULL AND (SELECT project_id FROM jobs WHERE id = NEW.job_id) IS NOT NEW.project_id;
  SELECT RAISE(ABORT, 'a job event names the project of its approval')
    WHERE NEW.approval_id IS NOT NULL AND (SELECT project_id FROM approvals WHERE id = NEW.approval_id) IS NOT NEW.project_id;
  SELECT RAISE(ABORT, 'a job event names the project of its deployment')
    WHERE NEW.deployment_id IS NOT NULL AND (SELECT project_id FROM deployments WHERE id = NEW.deployment_id) IS NOT NEW.project_id;
  SELECT RAISE(ABORT, 'an event without a job, approval or deployment names no project')
    WHERE NEW.project_id IS NOT NULL AND NEW.job_id IS NULL AND NEW.approval_id IS NULL AND NEW.deployment_id IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS tr_job_events_no_update BEFORE UPDATE ON job_events
BEGIN SELECT RAISE(ABORT, 'job events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS tr_job_events_no_delete BEFORE DELETE ON job_events
BEGIN SELECT RAISE(ABORT, 'job events are append-only'); END;

-- ===== content-addressed blobs and the versions that hold them =====
CREATE TABLE IF NOT EXISTS blobs (
  sha256             TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  bytes              INTEGER NOT NULL CHECK (bytes >= 0),
  media_type         TEXT NOT NULL CHECK (length(media_type) BETWEEN 3 AND 100),
  created_at         INTEGER NOT NULL,
  last_referenced_at INTEGER NOT NULL,
  verified_at        INTEGER
);
CREATE TRIGGER IF NOT EXISTS tr_blobs_identity BEFORE UPDATE ON blobs
WHEN NEW.sha256 IS NOT OLD.sha256 OR NEW.bytes IS NOT OLD.bytes OR NEW.media_type IS NOT OLD.media_type OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'blob identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_blobs_delete BEFORE DELETE ON blobs
WHEN EXISTS (SELECT 1 FROM version_blobs vb WHERE vb.sha256 = OLD.sha256)
BEGIN SELECT RAISE(ABORT, 'a blob held by a version is never deleted'); END;
CREATE TABLE IF NOT EXISTS version_blobs (
  version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  sha256     TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
  role       TEXT NOT NULL CHECK (role IN ('content','manifest','file','discovery','junit','report','log')),
  path       TEXT NOT NULL DEFAULT '' CHECK (length(path) <= 1024 AND path NOT LIKE '/%' AND path NOT LIKE '%\\%'
               AND path <> '..' AND path NOT LIKE '../%' AND path NOT LIKE '%/../%' AND path NOT LIKE '%/..'
               AND instr(path, char(0)) = 0),
  PRIMARY KEY (version_id, sha256, role, path)
);
CREATE INDEX IF NOT EXISTS ix_version_blobs_sha ON version_blobs(sha256);
CREATE TRIGGER IF NOT EXISTS tr_version_blobs_insert BEFORE INSERT ON version_blobs
BEGIN
  SELECT RAISE(ABORT, 'bytes are attached to a version only while it is a draft')
    WHERE (SELECT status FROM artifact_versions WHERE id = NEW.version_id) IS NOT 'draft';
END;
CREATE TRIGGER IF NOT EXISTS tr_version_blobs_no_update BEFORE UPDATE ON version_blobs
BEGIN SELECT RAISE(ABORT, 'version blobs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tr_version_blobs_no_delete BEFORE DELETE ON version_blobs
BEGIN SELECT RAISE(ABORT, 'version blobs are immutable'); END;

-- ===== version attempts: the attempt that produced each ingested version (written by ingest) =====
CREATE TABLE IF NOT EXISTS version_attempts (
  version_id TEXT PRIMARY KEY REFERENCES artifact_versions(id),
  job_id     TEXT NOT NULL,
  attempt_n  INTEGER NOT NULL,
  FOREIGN KEY (job_id, attempt_n) REFERENCES job_attempts(job_id, n)
);
CREATE TRIGGER IF NOT EXISTS tr_version_attempts_insert BEFORE INSERT ON version_attempts
BEGIN
  SELECT RAISE(ABORT, 'a version is bound to an attempt of the job that produced it')
    WHERE (SELECT produced_by_job_id FROM artifact_versions WHERE id = NEW.version_id) IS NOT NEW.job_id;
END;
CREATE TRIGGER IF NOT EXISTS tr_version_attempts_no_update BEFORE UPDATE ON version_attempts
BEGIN SELECT RAISE(ABORT, 'version attempts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS tr_version_attempts_no_delete BEFORE DELETE ON version_attempts
BEGIN SELECT RAISE(ABORT, 'version attempts are append-only'); END;

-- ===== validations: append-only validator results with their evidence =====
CREATE TABLE IF NOT EXISTS validations (
  id                TEXT PRIMARY KEY,
  version_id        TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  validator_id      TEXT NOT NULL CHECK (validator_id GLOB '[a-z]*' AND length(validator_id) BETWEEN 3 AND 64),
  validator_version TEXT NOT NULL CHECK (length(validator_version) BETWEEN 1 AND 16),
  stage             TEXT NOT NULL CHECK (stage IN ('register','candidate','promote')),
  status            TEXT NOT NULL CHECK (status IN ('passed','failed','error','skipped')),
  blocking          INTEGER NOT NULL CHECK (blocking IN (0,1)),
  advisory          INTEGER NOT NULL CHECK (advisory IN (0,1)),
  summary           TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  evidence_json     TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array' AND length(evidence_json) <= 65536),
  job_id            TEXT REFERENCES jobs(id),
  attempt_n         INTEGER CHECK (attempt_n IS NULL OR attempt_n >= 1),
  created_by        TEXT NOT NULL REFERENCES principals(id),
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER NOT NULL,
  CHECK (finished_at >= started_at),
  CHECK (NOT (blocking = 1 AND advisory = 1)),
  CHECK (attempt_n IS NULL OR job_id IS NOT NULL),
  FOREIGN KEY (job_id, attempt_n) REFERENCES job_attempts(job_id, n)
);
CREATE INDEX IF NOT EXISTS ix_validations_version ON validations(version_id, validator_id, finished_at);
CREATE INDEX IF NOT EXISTS ix_validations_job     ON validations(job_id) WHERE job_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tr_validations_insert BEFORE INSERT ON validations
BEGIN
  SELECT RAISE(ABORT, 'a validation job belongs to the project of the version')
    WHERE NEW.job_id IS NOT NULL AND (SELECT project_id FROM jobs WHERE id = NEW.job_id)
       IS NOT (SELECT project_id FROM artifact_versions WHERE id = NEW.version_id);
  SELECT RAISE(ABORT, 'a passed or failed blocking result is recorded only by the system')
    WHERE NEW.blocking = 1 AND NEW.status IN ('passed','failed')
      AND (SELECT kind FROM principals WHERE id = NEW.created_by) IS NOT 'system';
END;
CREATE TRIGGER IF NOT EXISTS tr_validations_no_update BEFORE UPDATE ON validations
BEGIN SELECT RAISE(ABORT, 'validations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS tr_validations_no_delete BEFORE DELETE ON validations
BEGIN SELECT RAISE(ABORT, 'validations are append-only'); END;

-- ===== approvals: once-only user consent =====
CREATE TABLE IF NOT EXISTS approval_states (
  state       TEXT PRIMARY KEY CHECK (state GLOB '[a-z]*' AND length(state) BETWEEN 2 AND 32),
  terminal    INTEGER NOT NULL CHECK (terminal IN (0,1)),
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_transitions (
  from_state TEXT NOT NULL REFERENCES approval_states(state),
  to_state   TEXT NOT NULL REFERENCES approval_states(state),
  PRIMARY KEY (from_state, to_state),
  CHECK (from_state <> to_state)
);
CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  job_id            TEXT REFERENCES jobs(id),
  session_id        TEXT REFERENCES agent_sessions(id),
  reason            TEXT NOT NULL CHECK (reason IN ('egress.deps','egress.weights','image.prepare','repo.write_refs','training.long','blobs.gc')),
  summary           TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  request_json      TEXT NOT NULL CHECK (json_valid(request_json) AND length(request_json) <= 8192),
  request_sha256    TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  status            TEXT NOT NULL REFERENCES approval_states(state),
  requested_by      TEXT NOT NULL REFERENCES principals(id),
  on_behalf_of      TEXT NOT NULL REFERENCES principals(id),
  requested_at      INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  decided_by        TEXT REFERENCES principals(id),
  decided_at        INTEGER,
  decision          TEXT CHECK (decision IS NULL OR decision IN ('once','deny')),
  consumed_at       INTEGER,
  consumed_by_job_id    TEXT,
  consumed_by_attempt_n INTEGER,
  status_changed_at INTEGER NOT NULL,
  CHECK (expires_at > requested_at),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK (consumed_at IS NULL OR status = 'approved'),
  CHECK (reason NOT IN ('egress.deps','egress.weights') OR (job_id IS NOT NULL AND project_id IS NOT NULL)),
  CHECK (reason <> 'image.prepare' OR (job_id IS NULL AND project_id IS NULL)),
  CHECK ((decided_at IS NOT NULL) = (status IN ('approved','denied'))),
  CHECK ((consumed_by_job_id IS NULL) = (consumed_by_attempt_n IS NULL)),
  CHECK (consumed_by_job_id IS NULL OR consumed_at IS NOT NULL),
  CHECK (consumed_at IS NULL OR consumed_by_job_id IS job_id),
  FOREIGN KEY (consumed_by_job_id, consumed_by_attempt_n) REFERENCES job_attempts(job_id, n)
);
CREATE INDEX IF NOT EXISTS ix_approvals_status ON approvals(status, expires_at);
CREATE INDEX IF NOT EXISTS ix_approvals_project ON approvals(project_id, requested_at DESC) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_approvals_job_pending ON approvals(job_id) WHERE job_id IS NOT NULL AND status = 'pending';
CREATE TRIGGER IF NOT EXISTS tr_approvals_insert BEFORE INSERT ON approvals
BEGIN
  SELECT RAISE(ABORT, 'an approval starts pending, undecided and unconsumed')
    WHERE NEW.status <> 'pending' OR NEW.decided_at IS NOT NULL OR NEW.consumed_at IS NOT NULL;
  SELECT RAISE(ABORT, 'an approval job belongs to its project')
    WHERE NEW.job_id IS NOT NULL AND (SELECT project_id FROM jobs WHERE id = NEW.job_id) IS NOT NEW.project_id;
  SELECT RAISE(ABORT, 'an approval session belongs to its project')
    WHERE NEW.session_id IS NOT NULL AND (SELECT project_id FROM agent_sessions WHERE id = NEW.session_id) IS NOT NEW.project_id;
END;
CREATE TRIGGER IF NOT EXISTS tr_approvals_transition BEFORE UPDATE OF status ON approvals
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'illegal approval transition')
    WHERE NOT EXISTS (SELECT 1 FROM approval_transitions t WHERE t.from_state = OLD.status AND t.to_state = NEW.status);
  SELECT RAISE(ABORT, 'only a user approves or denies, once, recording who and when')
    WHERE NEW.status IN ('approved','denied') AND (NEW.decided_by IS NULL
      OR (SELECT kind FROM principals WHERE id = NEW.decided_by) IS NOT 'user'
      OR NEW.decision IS NOT (CASE NEW.status WHEN 'approved' THEN 'once' ELSE 'deny' END));
  SELECT RAISE(ABORT, 'expiry and withdrawal are not decisions')
    WHERE NEW.status IN ('expired','withdrawn') AND (NEW.decided_by IS NOT NULL OR NEW.decision IS NOT NULL);
END;
CREATE TRIGGER IF NOT EXISTS tr_approvals_once BEFORE UPDATE ON approvals
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.job_id IS NOT OLD.job_id
  OR NEW.session_id IS NOT OLD.session_id OR NEW.reason IS NOT OLD.reason OR NEW.summary IS NOT OLD.summary
  OR NEW.request_json IS NOT OLD.request_json OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.requested_by IS NOT OLD.requested_by OR NEW.on_behalf_of IS NOT OLD.on_behalf_of
  OR NEW.requested_at IS NOT OLD.requested_at OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.decided_at IS NOT NULL AND (NEW.decided_by IS NOT OLD.decided_by OR NEW.decided_at IS NOT OLD.decided_at OR NEW.decision IS NOT OLD.decision))
  OR (OLD.consumed_at IS NOT NULL AND (NEW.consumed_at IS NOT OLD.consumed_at
    OR NEW.consumed_by_job_id IS NOT OLD.consumed_by_job_id OR NEW.consumed_by_attempt_n IS NOT OLD.consumed_by_attempt_n))
  OR (OLD.status <> 'pending' AND NEW.status IS NOT OLD.status)
BEGIN SELECT RAISE(ABORT, 'an approval request is immutable; its decision and its consumption are recorded once'); END;
CREATE TRIGGER IF NOT EXISTS tr_approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are never deleted'); END;

-- ===== deployments: local dev deployments of an application version =====
CREATE TABLE IF NOT EXISTS deployment_states (
  state       TEXT PRIMARY KEY CHECK (state GLOB '[a-z]*' AND length(state) BETWEEN 2 AND 32),
  terminal    INTEGER NOT NULL CHECK (terminal IN (0,1)),
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deployment_transitions (
  from_state TEXT NOT NULL REFERENCES deployment_states(state),
  to_state   TEXT NOT NULL REFERENCES deployment_states(state),
  PRIMARY KEY (from_state, to_state),
  CHECK (from_state <> to_state)
);
CREATE TABLE IF NOT EXISTS deployments (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  participation_id   TEXT NOT NULL REFERENCES project_workspaces(id) ON DELETE RESTRICT,
  subject_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  job_id             TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  environment        TEXT NOT NULL CHECK (environment = 'local-preview'),
  bind_address       TEXT NOT NULL DEFAULT '127.0.0.1' CHECK (bind_address = '127.0.0.1'),
  host_port          INTEGER CHECK (host_port IS NULL OR host_port BETWEEN 1024 AND 65535),
  status             TEXT NOT NULL REFERENCES deployment_states(state),
  health_json        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(health_json) AND json_type(health_json) = 'array' AND length(health_json) <= 16384),
  stop_reason        TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('user','idle','cancel','app_quit','recovery','exited','probe_failed','start_timeout',
                       'refused','preflight_failed','runner_lost','exit_not_reported')),
  stopped_by         TEXT REFERENCES principals(id),
  created_by         TEXT NOT NULL REFERENCES principals(id),
  started_at         INTEGER NOT NULL,
  stopped_at         INTEGER,
  status_changed_at  INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK ((status IN ('stopped','failed')) = (stopped_at IS NOT NULL)),
  CHECK ((status IN ('stopped','failed')) = (stop_reason IS NOT NULL)),
  CHECK ((status = 'stopped') = (stopped_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_deployments_project ON deployments(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_deployments_live    ON deployments(status) WHERE status IN ('starting','healthy','unhealthy');
CREATE INDEX IF NOT EXISTS ix_deployments_subject ON deployments(subject_version_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_deployments_port_live ON deployments(host_port)
  WHERE host_port IS NOT NULL AND status IN ('starting','healthy','unhealthy');
CREATE TRIGGER IF NOT EXISTS tr_deployments_insert BEFORE INSERT ON deployments
BEGIN
  SELECT RAISE(ABORT, 'a deployment starts as starting') WHERE NEW.status <> 'starting' OR NEW.stopped_at IS NOT NULL;
  SELECT RAISE(ABORT, 'the deploying participation must be active and in this project')
    WHERE NOT EXISTS (SELECT 1 FROM project_workspaces p WHERE p.id = NEW.participation_id AND p.project_id = NEW.project_id AND p.status = 'active');
  SELECT RAISE(ABORT, 'a deployment subject is an application or inference service version of this project')
    WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE v.id = NEW.subject_version_id AND v.project_id = NEW.project_id AND a.kind IN ('application','inference_service')
        AND v.status IN ('draft','candidate','active'));
  SELECT RAISE(ABORT, 'a deployment is run by a tool job of this project and participation')
    WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = NEW.job_id AND j.kind = 'tool.run'
      AND j.project_id = NEW.project_id AND j.participation_id = NEW.participation_id);
END;
CREATE TRIGGER IF NOT EXISTS tr_deployments_transition BEFORE UPDATE OF status ON deployments
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'illegal deployment transition')
    WHERE NOT EXISTS (SELECT 1 FROM deployment_transitions t WHERE t.from_state = OLD.status AND t.to_state = NEW.status);
END;
CREATE TRIGGER IF NOT EXISTS tr_deployments_identity BEFORE UPDATE ON deployments
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.participation_id IS NOT OLD.participation_id
  OR NEW.subject_version_id IS NOT OLD.subject_version_id OR NEW.job_id IS NOT OLD.job_id OR NEW.environment IS NOT OLD.environment
  OR NEW.bind_address IS NOT OLD.bind_address OR NEW.created_by IS NOT OLD.created_by OR NEW.started_at IS NOT OLD.started_at
  OR (OLD.host_port IS NOT NULL AND NEW.host_port IS NOT OLD.host_port)
  OR OLD.status IN ('stopped','failed')
BEGIN SELECT RAISE(ABORT, 'deployment identity is immutable and a finished deployment is frozen'); END;
CREATE TRIGGER IF NOT EXISTS tr_deployments_no_delete BEFORE DELETE ON deployments
BEGIN SELECT RAISE(ABORT, 'deployments are never deleted'); END;

-- ===== execution backstops on the v7 jobs table (additive triggers; constraint 4) =====
CREATE TRIGGER IF NOT EXISTS tr_jobs_completed_needs_attempt BEFORE UPDATE OF state ON jobs
WHEN NEW.state IS NOT OLD.state AND NEW.state IN ('completed','partial') AND NEW.kind IN ('tool.run','validate')
BEGIN
  SELECT RAISE(ABORT, 'a tool or validate job completes only when its current attempt succeeded')
    WHERE NEW.state = 'completed' AND NOT EXISTS (SELECT 1 FROM job_attempts a
      WHERE a.job_id = NEW.id AND a.n = NEW.attempts AND a.state = 'succeeded');
  SELECT RAISE(ABORT, 'a tool or validate job ends partial only when its current attempt finished')
    WHERE NEW.state = 'partial' AND NOT EXISTS (SELECT 1 FROM job_attempts a
      WHERE a.job_id = NEW.id AND a.n = NEW.attempts AND a.state IN ('succeeded','failed'));
END;
CREATE TRIGGER IF NOT EXISTS tr_jobs_attempts_monotonic BEFORE UPDATE OF attempts ON jobs
WHEN NEW.attempts < OLD.attempts
BEGIN SELECT RAISE(ABORT, 'a job attempt count never decreases'); END;
CREATE TRIGGER IF NOT EXISTS tr_jobs_end_after_attempts BEFORE UPDATE OF state ON jobs
WHEN NEW.state IS NOT OLD.state AND NEW.state IN ('queued','retry_scheduled','completed','partial','failed','cancelled','timed_out','interrupted')
BEGIN
  SELECT RAISE(ABORT, 'a job ends or goes back to waiting only after its live attempt has ended')
    WHERE EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id = NEW.id AND a.state IN ('starting','running'));
END;

-- ===== indexes on v7 tables used by the execution core (additive) =====
CREATE INDEX IF NOT EXISTS ix_jobs_sched       ON jobs(state, priority, created_at);
CREATE INDEX IF NOT EXISTS ix_jobs_retry_due   ON jobs(next_attempt_at) WHERE state = 'retry_scheduled';
CREATE INDEX IF NOT EXISTS ix_jobs_parent      ON jobs(parent_job_id) WHERE parent_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_versions_job_path ON artifact_versions(produced_by_job_id, output_path)
  WHERE output_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_versions_job     ON artifact_versions(produced_by_job_id) WHERE produced_by_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_versions_hash    ON artifact_versions(content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS ux_repository_per_project ON artifacts(project_id) WHERE kind = 'repository';
`;

/** Every v9 table with its columns in declaration order (checked against PRAGMA table_info). */
export const V9_EXPECTED: { tables: Record<string, string[]>; indexes: string[]; triggers: string[] } = {
  tables: {
    attempt_states: ['state', 'terminal', 'description'],
    attempt_transitions: ['from_state', 'to_state'],
    job_attempts: ['id', 'job_id', 'n', 'state', 'boot_id', 'lease_owner', 'lease_expires_at', 'heartbeat_at', 'container_id',
      'exit_code', 'signal', 'oom_killed', 'outcome', 'error_json', 'sandbox_json', 'environment_json', 'runtime_kind', 'runtime_ref',
      'log_path', 'log_bytes', 'out_bytes', 'usage_json', 'created_at', 'started_at', 'finished_at', 'updated_at'],
    image_builds: ['id', 'profile_id', 'approval_id', 'status', 'context_sha256', 'base_digest', 'image_id', 'size_bytes', 'log_path',
      'error_json', 'requested_by', 'started_at', 'finished_at'],
    job_events: ['seq', 'ts', 'project_id', 'job_id', 'attempt_n', 'image_build_id', 'approval_id', 'deployment_id', 'type', 'summary',
      'data_json'],
    blobs: ['sha256', 'bytes', 'media_type', 'created_at', 'last_referenced_at', 'verified_at'],
    version_blobs: ['version_id', 'sha256', 'role', 'path'],
    version_attempts: ['version_id', 'job_id', 'attempt_n'],
    validations: ['id', 'version_id', 'validator_id', 'validator_version', 'stage', 'status', 'blocking', 'advisory', 'summary',
      'evidence_json', 'job_id', 'attempt_n', 'created_by', 'started_at', 'finished_at'],
    approval_states: ['state', 'terminal', 'description'],
    approval_transitions: ['from_state', 'to_state'],
    approvals: ['id', 'project_id', 'job_id', 'session_id', 'reason', 'summary', 'request_json', 'request_sha256', 'status',
      'requested_by', 'on_behalf_of', 'requested_at', 'expires_at', 'decided_by', 'decided_at', 'decision', 'consumed_at',
      'consumed_by_job_id', 'consumed_by_attempt_n', 'status_changed_at'],
    deployment_states: ['state', 'terminal', 'description'],
    deployment_transitions: ['from_state', 'to_state'],
    deployments: ['id', 'project_id', 'participation_id', 'subject_version_id', 'job_id', 'environment', 'bind_address', 'host_port',
      'status', 'health_json', 'stop_reason', 'stopped_by', 'created_by', 'started_at', 'stopped_at', 'status_changed_at', 'updated_at']
  },
  indexes: [
    'ux_attempts_live', 'ix_attempts_lease', 'ix_attempts_container', 'ix_image_builds_profile', 'ix_job_events_job',
    'ix_job_events_project', 'ix_version_blobs_sha', 'ix_validations_version', 'ix_validations_job', 'ix_approvals_status',
    'ix_approvals_project', 'ux_approvals_job_pending', 'ix_deployments_project', 'ix_deployments_live', 'ix_deployments_subject',
    'ux_deployments_port_live',
    'ix_jobs_sched', 'ix_jobs_retry_due', 'ix_jobs_parent', 'ux_versions_job_path', 'ix_versions_job', 'ix_versions_hash',
    'ux_repository_per_project'
  ],
  triggers: [
    'tr_attempts_insert', 'tr_attempts_transition', 'tr_attempts_identity', 'tr_attempts_terminal_frozen', 'tr_attempts_no_delete',
    'tr_image_builds_insert', 'tr_image_builds_update', 'tr_image_builds_no_delete',
    'tr_job_events_insert', 'tr_job_events_no_update', 'tr_job_events_no_delete',
    'tr_blobs_identity', 'tr_blobs_delete',
    'tr_version_blobs_insert', 'tr_version_blobs_no_update', 'tr_version_blobs_no_delete',
    'tr_version_attempts_insert', 'tr_version_attempts_no_update', 'tr_version_attempts_no_delete',
    'tr_validations_insert', 'tr_validations_no_update', 'tr_validations_no_delete',
    'tr_approvals_insert', 'tr_approvals_transition', 'tr_approvals_once', 'tr_approvals_no_delete',
    'tr_deployments_insert', 'tr_deployments_transition', 'tr_deployments_identity', 'tr_deployments_no_delete',
    'tr_jobs_completed_needs_attempt', 'tr_jobs_attempts_monotonic', 'tr_jobs_end_after_attempts'
  ]
};

const V9_OBJECTS: V7DdlObject[] = ddlObjects(V9_DDL);
const V9_TABLES = new Set(Object.keys(V9_EXPECTED.tables));
/** Not compared with the pre-counts: the migration itself writes them (or SQLite does). */
const COUNT_EXEMPT = new Set(['activity', 'nexus_migrations', 'sqlite_sequence']);
/** The one v7 table v9 adds rows to; its count is checked against the rows v9 adds (see verifyV9 and applyV9). */
const SEEDED_V7_TABLE = 'lineage_relations';
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const countOf = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n;

const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>).map((c) => c.name);

/**
 * The first difference between the database and the v9 definition, or null.
 * Same rules as v7ShapeProblem and v8ShapeProblem: tables by columns (in order), every
 * table, index and trigger by its stored definition (the seven indexes on v7 tables
 * included). With `requireAll` false only the v9 objects that already exist are checked
 * (the pre-check before IF NOT EXISTS). It checks only v9 objects; v7 and v8 have their own.
 */
export function v9ShapeProblem(db: Database.Database, requireAll = true, opts?: { v11?: boolean }): string | null {
  // Schema v11 replaces exactly one v9 trigger (tr_deployments_insert: the subject may also be a change set). That one stored definition is accepted when the
  // database is at v11 (user_version >= 11) or the caller is the v11 step itself; every other v9 object is still compared exactly.
  const v11Trigger = opts?.v11 === true || (db.pragma('user_version', { simple: true }) as number) >= 11;
  const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL').all() as
    Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const [table, cols] of Object.entries(V9_EXPECTED.tables)) {
    const row = byName.get(table);
    if (!row) { if (requireAll) return `table ${table} is missing`; continue; }
    if (row.type !== 'table') return `${table} exists as a ${row.type}, not a table`;
    const found = columnsOf(db, table);
    if (found.join(',') !== cols.join(',')) return `table ${table} has columns (${found.join(', ')}), expected (${cols.join(', ')})`;
  }
  for (const obj of V9_OBJECTS) {
    const row = byName.get(obj.name);
    if (!row) { if (requireAll) return `${obj.type} ${obj.name} is missing`; continue; }
    if (row.type !== obj.type || row.tbl_name !== obj.table) {
      return `${obj.name} exists as a ${row.type} on ${row.tbl_name}, expected a ${obj.type} on ${obj.table}`;
    }
    if (normaliseSql(row.sql) !== obj.sql && !(v11Trigger && obj.name === V11_TRIGGER_NAME && normaliseSql(row.sql) === V11_TRIGGER_SQL)) {
      return `${obj.type} ${obj.name} has a different definition`;
    }
  }
  return null;
}

const STATE_TABLES = [
  { table: 'attempt_states', moves: 'attempt_transitions', label: 'attempt', states: V9_ATTEMPT_STATES, transitions: V9_ATTEMPT_TRANSITIONS },
  { table: 'approval_states', moves: 'approval_transitions', label: 'approval', states: V9_APPROVAL_STATES, transitions: V9_APPROVAL_TRANSITIONS },
  { table: 'deployment_states', moves: 'deployment_transitions', label: 'deployment', states: V9_DEPLOYMENT_STATES, transitions: V9_DEPLOYMENT_TRANSITIONS }
] as const;

/** Returns the number of lineage relation rows this call inserted (0 on a re-run). */
function seedV9(db: Database.Database): number {
  for (const s of STATE_TABLES) {
    const state = db.prepare(`INSERT OR IGNORE INTO ${s.table} (state, terminal, description) VALUES (?, ?, ?)`);
    for (const r of s.states) state.run(r.state, r.terminal, r.description);
    const move = db.prepare(`INSERT OR IGNORE INTO ${s.moves} (from_state, to_state) VALUES (?, ?)`);
    for (const [from, to] of s.transitions) move.run(from, to);
  }
  const relation = db.prepare('INSERT OR IGNORE INTO lineage_relations (relation, description, planned_phase) VALUES (?, ?, ?)');
  let added = 0;
  for (const r of V9_LINEAGE_RELATIONS) added += relation.run(r.relation, r.description, r.plannedPhase).changes;
  return added;
}

/**
 * INSERT OR IGNORE also swallows CHECK failures, so every seed row is confirmed present
 * with every column, and each v9 lookup table holds exactly its seed (nothing extra).
 */
function seedProblem(db: Database.Database): string | null {
  const has = (sql: string, ...args: unknown[]): boolean => db.prepare(sql).get(...args) !== undefined;
  for (const s of STATE_TABLES) {
    for (const r of s.states) {
      if (!has(`SELECT 1 FROM ${s.table} WHERE state = ? AND terminal = ? AND description = ?`, r.state, r.terminal, r.description)) {
        return `seed ${s.label} state ${r.state} is missing`;
      }
    }
    for (const [f, t] of s.transitions) {
      if (!has(`SELECT 1 FROM ${s.moves} WHERE from_state = ? AND to_state = ?`, f, t)) return `seed ${s.label} transition ${f}>${t} is missing`;
    }
    if (countOf(db, s.table) !== s.states.length) return `${s.table} has ${countOf(db, s.table)} rows, expected ${s.states.length}`;
    if (countOf(db, s.moves) !== s.transitions.length) return `${s.moves} has ${countOf(db, s.moves)} rows, expected ${s.transitions.length}`;
  }
  for (const r of V9_LINEAGE_RELATIONS) {
    if (!has('SELECT 1 FROM lineage_relations WHERE relation = ? AND description = ? AND planned_phase = ?', r.relation, r.description, r.plannedPhase)) {
      return `seed lineage relation ${r.relation} is missing`;
    }
  }
  return null;
}

/**
 * Throws on the first mismatch. Runs inside the v9 transaction, so a throw rolls everything back.
 * Pre-counts: every pre-existing table keeps its row count, except lineage_relations, which may
 * grow by at most the four v9 rows (applyV9 then pins the exact growth to the rows it inserted).
 */
export function verifyV9(db: Database.Database, ctx: MigrationContext): void {
  const v7 = v7ShapeProblem(db, true);
  if (v7) throw new Error(`v9 verification failed: the v7 shape changed: ${v7}`);
  const v8 = v8ShapeProblem(db, true);
  if (v8) throw new Error(`v9 verification failed: the v8 shape changed: ${v8}`);
  const shape = v9ShapeProblem(db, true);
  if (shape) throw new Error(`v9 verification failed: ${shape}`);
  const seeds = seedProblem(db);
  if (seeds) throw new Error(`v9 verification failed: ${seeds}`);
  const fk = db.pragma('foreign_key_check') as Array<{ table: string }>;
  if (fk.length) {
    throw new Error(`v9 verification failed: foreign_key_check reports ${fk.length} row(s) in ${[...new Set(fk.map((r) => r.table))].join(', ')}`);
  }
  if (ctx.preCounts) {
    for (const [table, before] of Object.entries(ctx.preCounts)) {
      if (V9_TABLES.has(table) || COUNT_EXEMPT.has(table)) continue;
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        throw new Error(`v9 verification failed: table ${table} is missing`);
      }
      const after = countOf(db, table);
      if (table === SEEDED_V7_TABLE) {
        if (after < before || after > before + V9_LINEAGE_RELATIONS.length) {
          throw new Error(`v9 verification failed: ${table} has ${after} rows, expected ${before} to ${before + V9_LINEAGE_RELATIONS.length}`);
        }
        continue;
      }
      if (after !== before) throw new Error(`v9 verification failed: ${table} has ${after} rows, expected ${before}`);
    }
  }
}

/** MIGRATIONS[8]. Sits only on an exact v7 + v8. Idempotent: on a database that already has v9 it changes nothing. */
export function applyV9(db: Database.Database, ctx: MigrationContext):
  { attemptStates: number; approvalStates: number; deploymentStates: number; relationsAdded: number } {
  const v7 = v7ShapeProblem(db, true);
  if (v7) throw new Error(`v9 needs an exact v7 shape: ${v7}`);
  const v8 = v8ShapeProblem(db, true);
  if (v8) throw new Error(`v9 needs an exact v8 shape: ${v8}`);
  const conflict = v9ShapeProblem(db, false);
  if (conflict) throw new Error(`v9 cannot be applied over an existing object: ${conflict}`);
  const now = ctx.now();
  db.exec(V9_DDL);
  const relationsAdded = seedV9(db);
  const record = db.prepare(`INSERT OR IGNORE INTO nexus_migrations (version, from_version, applied_at, app_version, backup_file,
      backup_sha256, backup_bytes, row_counts_json, backfill_json) VALUES (9, 8, ?, ?, ?, ?, ?, ?, '{}')`).run(
    now, ctx.appVersion, ctx.backup?.file ?? null, ctx.backup?.sha256 ?? null, ctx.backup?.bytes ?? null,
    JSON.stringify(ctx.preCounts ?? {}));
  if (record.changes === 1) {
    appendActivityRow(db, {
      actorKind: 'system', actorId: 'system', entityType: 'schema', entityId: '9', action: 'db.migrated', status: 'succeeded',
      details: { from: 8, to: 9, backupFile: ctx.backup?.file ?? null, backupSha256: ctx.backup?.sha256 ?? null }
    }, now);
  }
  verifyV9(db, ctx);
  const before = ctx.preCounts?.[SEEDED_V7_TABLE];
  if (typeof before === 'number' && countOf(db, SEEDED_V7_TABLE) !== before + relationsAdded) {
    throw new Error(`v9 verification failed: ${SEEDED_V7_TABLE} has ${countOf(db, SEEDED_V7_TABLE)} rows, expected ${before + relationsAdded}`);
  }
  return {
    attemptStates: countOf(db, 'attempt_states'), approvalStates: countOf(db, 'approval_states'),
    deploymentStates: countOf(db, 'deployment_states'), relationsAdded
  };
}
