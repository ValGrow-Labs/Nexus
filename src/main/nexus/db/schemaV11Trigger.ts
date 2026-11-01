/**
 * The one trigger schema v11 replaces: `tr_deployments_insert` (created by v9, frozen there). A leaf module (it imports only the SQL normaliser)
 * so schemaV9's shape check can accept this definition on a database that is at v11 without a cycle (schemaV11 imports schemaV9).
 *
 * v9 let a deployment's subject be an `application` or `inference_service` version. v11 lets it also be a `change_set` version (a live
 * preview of a suggested change, before it is added to the project) and NOTHING broader: every other check is the v9 text word for word.
 */
import { normaliseSql } from './schemaV7';

export const V11_TRIGGER_NAME = 'tr_deployments_insert';

/** The replacement, as shipped migration text once v11 runs on a real database: never edit it then (a later change is a new migration). */
export const V11_TRIGGER_DDL: string = `
CREATE TRIGGER IF NOT EXISTS tr_deployments_insert BEFORE INSERT ON deployments
BEGIN
  SELECT RAISE(ABORT, 'a deployment starts as starting') WHERE NEW.status <> 'starting' OR NEW.stopped_at IS NOT NULL;
  SELECT RAISE(ABORT, 'the deploying participation must be active and in this project')
    WHERE NOT EXISTS (SELECT 1 FROM project_workspaces p WHERE p.id = NEW.participation_id AND p.project_id = NEW.project_id AND p.status = 'active');
  SELECT RAISE(ABORT, 'a deployment subject is an application, inference service or change set version of this project')
    WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE v.id = NEW.subject_version_id AND v.project_id = NEW.project_id AND a.kind IN ('application','inference_service','change_set')
        AND v.status IN ('draft','candidate','active'));
  SELECT RAISE(ABORT, 'a deployment is run by a tool job of this project and participation')
    WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = NEW.job_id AND j.kind = 'tool.run'
      AND j.project_id = NEW.project_id AND j.participation_id = NEW.participation_id);
END;
`;

/** The stored-definition form (what sqlite_master holds, normalised) of the v11 trigger. */
export const V11_TRIGGER_SQL: string = normaliseSql(V11_TRIGGER_DDL);
