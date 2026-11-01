/**
 * The pinned sandbox profiles (B2a Task 12, amendment A3): main loads them from `infra/images/lock.json` (packaged:
 * `<resources>/images/lock.json`, electron-builder's extraResources) at platform construction and hands them to the
 * execution core (`profiles`) and to image preparation (`imageContexts`). Without them nothing can be planned (a job
 * waits `waiting:image`, image preparation is refused `unknown_profile`): the app never invents a profile.
 *
 * - `image`: the pinned base `{ repository, digest }`, `source: 'built'` (Nexus builds every B2a image locally, so a
 *   container is created by the local image id the probe reports, never by a tag or the base digest: amendment A2).
 * - `entrypoint`: the Nexus entry the image's ENTRYPOINT names (one element: the Docker CLI sets it too, preflight
 *   compares it exactly).
 * - `imageEnv`: the ENV names the image config declares (the base image's, plus the names a Nexus Dockerfile declares itself:
 *   only ml-python's MPLBACKEND and MPLCONFIGDIR). Preflight refuses a container carrying any other name the plan did not set.
 * - `imageContexts`: `{ contextSha256, baseDigest, estimatedBytes }` per profile, what the A2 approval shows and binds.
 * A lock that does not parse, or names a profile with a malformed field, yields NO profiles and a problem (logged once by
 * the caller), never a partial set.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ResourceLimits, SandboxProfile, SandboxProfileId } from '../../shared/nexus/execution';
import type { ImageContext } from '../nexus/approvals/approvalService';

export const IMAGE_LOCK_FILE = 'lock.json';
/**
 * The profiles the lock pins (the order main hands them over): B2a's three, then `ml-python`, the machine learning kit (the Python
 * kit's tools plus the locked ML packages; used by Machine learning projects, see src/main/nexus/exec/sandboxProfile.ts).
 */
export const LOCKED_PROFILE_IDS: readonly SandboxProfileId[] = Object.freeze(['sde-node', 'sde-python', 'nexus-fwd', 'ml-python']);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const REPO_RE = /^[a-z0-9][a-z0-9._/-]{0,200}$/;
const MIN = 60_000;
const MIB = 2 ** 20;

/** Per-profile defaults (a recipe's own limits win; these describe the profile). */
const DEFAULTS: Readonly<Record<string, ResourceLimits>> = Object.freeze({
  'sde-node': { cpus: 2, memoryMb: 2048, pids: 512, wallClockMs: 15 * MIN, outputMaxBytes: 64 * MIB, tmpfsMb: 512 },
  'sde-python': { cpus: 2, memoryMb: 2048, pids: 512, wallClockMs: 15 * MIN, outputMaxBytes: 64 * MIB, tmpfsMb: 512 },
  'nexus-fwd': { cpus: 0.5, memoryMb: 128, pids: 512, wallClockMs: 120 * MIN, outputMaxBytes: 1 * MIB, tmpfsMb: 16 },
  'ml-python': { cpus: 2, memoryMb: 2048, pids: 512, wallClockMs: 15 * MIN, outputMaxBytes: 64 * MIB, tmpfsMb: 512 }
});

export interface LockedProfile {
  base: { ref: string; repository: string; digest: string; platformDigest?: string };
  baseEnv: string[]; imageEnv: string[]; entrypoint: string[];
  lockfiles: Record<string, string>; contextSha256: string; estimatedBytes: number; versions: Record<string, string>;
}
export interface ImageLock { version: 1; platform?: string; profiles: Record<string, LockedProfile> }

export interface LoadedProfiles {
  profiles: SandboxProfile[];
  imageContexts: (profileId: string) => ImageContext | null;
  /** Why no profile was loaded (null when all were). */
  problem: string | null;
}

/** The folder holding the image contexts and lock.json: `<resources>/images` packaged, else the repository's `infra/images`. */
export function imagesDirFor(o: { packaged: boolean; resourcesPath?: string | null; appPath: string }): string {
  return o.packaged && o.resourcesPath ? path.join(o.resourcesPath, 'images') : path.join(o.appPath, 'infra', 'images');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strList = (v: unknown, re: RegExp, max: number): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && re.test(x)) ? [...v as string[]] : null;

/** The lock, checked field by field; any problem refuses the whole lock. */
export function parseImageLock(text: string): { ok: true; lock: ImageLock } | { ok: false; problem: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, problem: 'lock.json is not JSON' }; }
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.profiles)) return { ok: false, problem: 'lock.json is not a version 1 image lock' };
  const profiles: Record<string, LockedProfile> = {};
  for (const id of LOCKED_PROFILE_IDS) {
    const p = raw.profiles[id];
    if (!isObj(p)) return { ok: false, problem: `lock.json does not pin ${id}` };
    const b = p.base;
    if (!isObj(b) || typeof b.ref !== 'string' || typeof b.repository !== 'string' || !REPO_RE.test(b.repository)
      || typeof b.digest !== 'string' || !DIGEST_RE.test(b.digest)) return { ok: false, problem: `${id}: the base image is not pinned by digest` };
    const imageEnv = strList(p.imageEnv, ENV_NAME_RE, 64);
    const baseEnv = strList(p.baseEnv, ENV_NAME_RE, 64);
    const entrypoint = strList(p.entrypoint, /^\/[A-Za-z0-9/_.-]{1,200}$/, 1);
    if (!imageEnv || !baseEnv) return { ok: false, problem: `${id}: the image environment names are malformed` };
    if (!entrypoint || entrypoint.length !== 1) return { ok: false, problem: `${id}: the entrypoint is not one absolute path` };
    if (typeof p.contextSha256 !== 'string' || !SHA_RE.test(p.contextSha256)) return { ok: false, problem: `${id}: no context hash` };
    if (!Number.isSafeInteger(p.estimatedBytes) || (p.estimatedBytes as number) < 0) return { ok: false, problem: `${id}: no size estimate` };
    if (!isObj(p.lockfiles) || !Object.values(p.lockfiles).every((x) => typeof x === 'string' && SHA_RE.test(x))) return { ok: false, problem: `${id}: lockfile hashes are malformed` };
    if (!isObj(p.versions) || !Object.values(p.versions).every((x) => typeof x === 'string' && x.length <= 64)) return { ok: false, problem: `${id}: versions are malformed` };
    profiles[id] = { base: { ref: b.ref, repository: b.repository, digest: b.digest, ...(typeof b.platformDigest === 'string' ? { platformDigest: b.platformDigest } : {}) },
      baseEnv, imageEnv, entrypoint, lockfiles: { ...(p.lockfiles as Record<string, string>) }, contextSha256: p.contextSha256,
      estimatedBytes: p.estimatedBytes as number, versions: { ...(p.versions as Record<string, string>) } };
  }
  return { ok: true, lock: { version: 1, ...(typeof raw.platform === 'string' ? { platform: raw.platform } : {}), profiles } };
}

/** The sandbox profiles a lock pins. */
export function profilesFromLock(lock: ImageLock): SandboxProfile[] {
  return LOCKED_PROFILE_IDS.map((id) => {
    const p = lock.profiles[id];
    return {
      id, image: { repository: p.base.repository, digest: p.base.digest as `sha256:${string}`, source: 'built' as const },
      user: { uid: 10001 as const, gid: 10001 as const }, defaults: { ...DEFAULTS[id] }, entrypoint: [...p.entrypoint], imageEnv: [...p.imageEnv]
    };
  });
}

/** Image preparation's view of a lock (approval A2): the context to build, its pinned base and a size estimate. */
export function imageContextsFromLock(lock: ImageLock): (profileId: string) => ImageContext | null {
  return (profileId) => {
    const p = (LOCKED_PROFILE_IDS as readonly string[]).includes(profileId) ? lock.profiles[profileId] : undefined;
    return p ? { contextSha256: p.contextSha256, baseDigest: p.base.digest, estimatedBytes: p.estimatedBytes } : null;
  };
}

/** Reads `<imagesDir>/lock.json` (sync: once, at platform construction, before the window). */
export function loadImageProfiles(imagesDir: string, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): LoadedProfiles {
  const none = (problem: string): LoadedProfiles => ({ profiles: [], imageContexts: () => null, problem });
  let text: string;
  try { text = read(path.join(imagesDir, IMAGE_LOCK_FILE)); } catch { return none('lock.json is not readable'); }
  const parsed = parseImageLock(text);
  if (!parsed.ok) return none(parsed.problem);
  return { profiles: profilesFromLock(parsed.lock), imageContexts: imageContextsFromLock(parsed.lock), problem: null };
}
