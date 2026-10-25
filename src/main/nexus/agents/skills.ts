/**
 * The agent's skill bundle (B2b): main reads the bundled `SKILL.md` of each requested skill id and writes them, one
 * after another, to `<dataHome>/jobs/<jobId>/agent/skills.md`. Main is the single writer of this file too (F23, the
 * same folder as the context file).
 *
 * - Every id must be a known skill (`SKILLS`, shared/nexus/capabilities.ts), of the job's own domain and already
 *   available in this build (`availableFrom` at or before `CURRENT_SUB_PHASE`): an unknown, foreign or unavailable id
 *   is dropped from the bundle (never written, never thrown for).
 * - Each skill file is bounded (SC6 pins it at 8 KiB); the bundle itself is capped well above that so one write can
 *   never grow unbounded from a future skill set.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { SKILLS, skillDir, type SkillDef } from '../../../shared/nexus/capabilities';
import { isAtOrBefore } from '../../../shared/nexus/domainSpec';
import { PlatformError } from '../errors';
import type { AgentDataHome } from './contextResolver';

export interface SkillsJob { id: string; workspaceId: string }
export interface SkillsDeps {
  dataHome: AgentDataHome | null;
  /** Absolute path to the app's `resources` folder (dev or packaged); a skill's file is `<resourcesDir>/skills/<id>/SKILL.md`. */
  resourcesDir: string | null;
}
export interface WrittenSkill { id: string; version: string; sha256: string }

const MAX_SKILL_FILE_BYTES = 8 * 1024;
const MAX_BUNDLE_BYTES = 128 * 1024;

export class Skills {
  constructor(private readonly deps: SkillsDeps) {}

  /** Writes the bundle of the requested skill ids that are valid for this job's domain, in the order given. */
  async write(job: SkillsJob, ids: readonly string[]): Promise<WrittenSkill[]> {
    if (typeof job?.id !== 'string' || job.id.length === 0) throw new PlatformError('invalid', 'a job is required');
    if (!this.deps.dataHome) throw new PlatformError('platform_unavailable', 'no data home: the skill bundle cannot be written');
    if (!this.deps.resourcesDir) throw new PlatformError('platform_unavailable', 'no skills resource folder is configured');
    const dataHome = this.deps.dataHome;
    const seen = new Set<string>();
    const defs: SkillDef[] = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      const def = SKILLS.find((s) => s.id === id);
      if (!def || def.domain !== job.workspaceId || !isAtOrBefore(def.availableFrom)) continue;
      seen.add(id);
      defs.push(def);
    }
    const written: WrittenSkill[] = [];
    const parts: string[] = [];
    let bytes = 0;
    for (const def of defs) {
      const file = path.join(this.deps.resourcesDir, ...skillDir(def.id).split('/'), 'SKILL.md');
      let text: string;
      try { text = await readFile(file, 'utf8'); } catch { continue; }
      if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_FILE_BYTES) continue;
      const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
      const block = `${text.trim()}\n`;
      if (bytes + Buffer.byteLength(block, 'utf8') > MAX_BUNDLE_BYTES) break;
      bytes += Buffer.byteLength(block, 'utf8');
      parts.push(block);
      written.push({ id: def.id, version: def.version, sha256 });
    }
    const rel = `${dataHome.jobRel(job.id)}/agent/skills.md`;
    const abs = await dataHome.confineToDataHome(rel);
    if (!abs) throw new PlatformError('invalid', 'the skills path could not be confined to the data home');
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, parts.length > 0 ? parts.join('\n---\n\n') : '', 'utf8');
    return written;
  }
}
