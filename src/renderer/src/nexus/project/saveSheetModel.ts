// Pure: the Save sheet's choices and state. It saves a git commit or a small
// text file of the project as an artifact version. The renderer sends only ids
// and small values ({ projectId, workspaceId, commit | relPath, target }); main
// resolves the project folder, reads the file or verifies the commit, and refuses
// anything unsafe. No React, so tests load it directly.
import type { NexusFail, SaveCommitArgs, SaveTargetArg, SaveTextFileArgs } from '@shared/nexus/ipc';
import { activeWorkspacesOf, viewOf, type ParticipationIndex } from '../workspaces/participation';
import { errorCopy } from '../data/errorCopy';
import type { ArtifactSummary } from './spineModel';

/** What is being saved. A file source starts with no file chosen. */
export type SaveSource = { kind: 'commit'; sha: string; subject: string } | { kind: 'file'; relPath: string | null };

export interface WorkspaceChoice { participationId: string; workspaceId: string; label: string; hueSlot: number | null; isPrimary: boolean }

/** The project's ACTIVE participations, primary first; none while writes are off or the index is the legacy one. */
export function workspaceChoices(idx: ParticipationIndex, projectId: string, canWrite: boolean): WorkspaceChoice[] {
  if (!canWrite || idx.mode !== 'db') return [];
  return activeWorkspacesOf(idx, projectId).map(({ row }) => {
    const v = viewOf(row.workspaceId);
    return { participationId: row.id, workspaceId: row.workspaceId, label: v.label, hueSlot: v.hueSlot, isPrimary: row.isPrimary };
  });
}

export const kindForSource = (s: SaveSource): 'git_commit' | 'text_file' => (s.kind === 'commit' ? 'git_commit' : 'text_file');

export interface ExistingTarget { artifactId: string; name: string; latestVersionNo: number | null }

/** Saved items a new version may be added to: same kind, not archived, owned by that participation. */
export function existingTargets(artifacts: ArtifactSummary[], ws: Pick<WorkspaceChoice, 'participationId' | 'workspaceId'> | null, kind: string): ExistingTarget[] {
  if (!ws) return [];
  return artifacts
    .filter((s) => s.artifact.kind === kind && s.artifact.status === 'active' && s.artifact.ownerScope === 'participation'
      && (s.artifact.ownerParticipationId === ws.participationId || (!s.artifact.ownerParticipationId && s.artifact.ownerWorkspaceId === ws.workspaceId)))
    .map((s) => ({ artifactId: s.artifact.id, name: s.artifact.name, latestVersionNo: s.latest ? s.latest.versionNo : null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const NAME_MAX = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The platform's name rule: trimmed, 1 to 200 characters, no control characters. */
export function validName(name: string): boolean {
  const t = name.trim();
  return t.length >= 1 && t.length <= NAME_MAX && !CONTROL.test(t);
}

/** The name a new artifact starts with: the commit subject, or the file's name. */
export function defaultName(s: SaveSource): string {
  const clean = (t: string) => t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  if (s.kind === 'commit') return clean(s.subject);
  if (!s.relPath) return '';
  const parts = s.relPath.split('/');
  return clean(parts[parts.length - 1] ?? '');
}

/** An existing artifact of the same kind in that workspace with this name (case and spacing ignored). */
export function sameNameTarget(targets: ExistingTarget[], name: string): ExistingTarget | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return targets.find((t) => t.name.trim().toLowerCase() === key) ?? null;
}

export type TargetChoice = { mode: 'new'; name: string } | { mode: 'existing'; artifactId: string | null };

export interface SaveSheetState {
  workspaceId: string | null;
  target: TargetChoice;
  pending: boolean;
  error: string | null;
}

/**
 * The opening state: the primary workspace, and a new artifact named after the
 * source; but when an artifact of that name already exists there, a new version of it.
 */
export function initialSaveState(source: SaveSource, choices: WorkspaceChoice[], artifacts: ArtifactSummary[]): SaveSheetState {
  const ws = choices[0] ?? null;
  return { workspaceId: ws ? ws.workspaceId : null, target: targetFor(source, ws, artifacts), pending: false, error: null };
}

function targetFor(source: SaveSource, ws: WorkspaceChoice | null, artifacts: ArtifactSummary[]): TargetChoice {
  const name = defaultName(source);
  const same = sameNameTarget(existingTargets(artifacts, ws, kindForSource(source)), name);
  return same ? { mode: 'existing', artifactId: same.artifactId } : { mode: 'new', name };
}

/** Another workspace: an existing-artifact target that is not owned there starts over. */
export function selectWorkspace(s: SaveSheetState, workspaceId: string, source: SaveSource, choices: WorkspaceChoice[], artifacts: ArtifactSummary[]): SaveSheetState {
  if (s.pending) return s;
  const ws = choices.find((c) => c.workspaceId === workspaceId) ?? null;
  if (!ws) return s;
  const targets = existingTargets(artifacts, ws, kindForSource(source));
  const t = s.target;
  let target: TargetChoice = t;
  if (t.mode === 'existing' && !targets.some((x) => x.artifactId === t.artifactId)) target = targetFor(source, ws, artifacts);
  else if (t.mode === 'new' && !t.name) target = targetFor(source, ws, artifacts);
  return { ...s, workspaceId, target, error: null };
}

export function setTarget(s: SaveSheetState, target: TargetChoice): SaveSheetState {
  return s.pending ? s : { ...s, target, error: null };
}

/** A new source (another commit, another file): the name follows it when it was still the old default. */
export function sourceChanged(s: SaveSheetState, prev: SaveSource, next: SaveSource, choices: WorkspaceChoice[], artifacts: ArtifactSummary[]): SaveSheetState {
  if (s.pending) return s;
  const ws = choices.find((c) => c.workspaceId === s.workspaceId) ?? null;
  if (s.target.mode === 'new' && s.target.name.trim() !== defaultName(prev)) return { ...s, error: null };
  if (s.target.mode === 'existing' && s.target.artifactId) return { ...s, error: null };
  return { ...s, target: targetFor(next, ws, artifacts), error: null };
}

/**
 * The steer toward "add a version to an existing artifact": the existing artifact
 * a new-artifact name collides with, or null.
 */
export function steerTarget(s: SaveSheetState, source: SaveSource, choices: WorkspaceChoice[], artifacts: ArtifactSummary[]): ExistingTarget | null {
  if (s.target.mode !== 'new') return null;
  const ws = choices.find((c) => c.workspaceId === s.workspaceId) ?? null;
  return sameNameTarget(existingTargets(artifacts, ws, kindForSource(source)), s.target.name);
}

export const steerText = (name: string, workspaceLabel: string): string =>
  `A saved item named “${name}” already exists in ${workspaceLabel}. Add this as a new version of it instead of making a second one.`;

// ---------- the request ----------

const COMMIT = /^[0-9a-f]{40}$/;

/** A project-relative path the platform would accept: no NUL, not absolute, no ".." segment; "/" separators. */
export function safeRelPath(p: string | null): string | null {
  if (typeof p !== 'string') return null;
  const s = p.replace(/\\/g, '/');
  if (s.length < 1 || s.length > 1024 || s.includes('\0')) return null;
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  const segs = s.split('/');
  if (segs.some((x) => x === '..' || x === '')) return null;
  return segs.filter((x) => x !== '.').join('/') || null;
}

export type SaveRequest = { kind: 'commit'; args: SaveCommitArgs } | { kind: 'file'; args: SaveTextFileArgs };

/** Exactly { projectId, workspaceId, commit | relPath, target }, or null while the sheet is incomplete. */
export function buildRequest(projectId: string, s: SaveSheetState, source: SaveSource): SaveRequest | null {
  if (!s.workspaceId) return null;
  let target: SaveTargetArg;
  if (s.target.mode === 'new') {
    if (!validName(s.target.name)) return null;
    target = { name: s.target.name.trim() };
  } else {
    if (!s.target.artifactId) return null;
    target = { artifactId: s.target.artifactId };
  }
  if (source.kind === 'commit') {
    const commit = source.sha.toLowerCase();
    if (!COMMIT.test(commit)) return null;
    return { kind: 'commit', args: { projectId, workspaceId: s.workspaceId, commit, target } };
  }
  const relPath = safeRelPath(source.relPath);
  if (!relPath) return null;
  return { kind: 'file', args: { projectId, workspaceId: s.workspaceId, relPath, target } };
}

/** Start a save; null while one is already running (no double submit) or the sheet is incomplete. */
export function beginSave(s: SaveSheetState, ready: boolean): SaveSheetState | null {
  if (s.pending || !ready) return null;
  return { ...s, pending: true, error: null };
}

export function saveFailed(s: SaveSheetState, error: string): SaveSheetState {
  return { ...s, pending: false, error };
}

/** Every refusal reads through errorCopy (sensitive_name, secret_in_content, too_large, not_text, path_refused, not_a_commit, ...). */
export function saveFailureText(r: NexusFail): string {
  return errorCopy(r.code, r.reason, r.subReason).text;
}

/** Whether what the screens show may be stale after this failure, so they should read again. */
export function shouldReloadAfterSave(r: NexusFail): boolean {
  if (r.code === 'not_found' || r.code === 'conflict' || r.code === 'not_participating' || r.code === 'participation_inactive') return true;
  return r.code === 'platform_unavailable' && r.reason !== 'busy' && r.reason !== 'handoffs_unavailable';
}

// ---------- choosing a file (through the existing fs:listDir channel, rooted at the project) ----------

/** The platform refuses a raw file over 64 KiB; the chooser says so up front. */
export const MAX_TEXT_BYTES = 65536;

export interface FileChoice { name: string; relPath: string; isDir: boolean; size: number; tooLarge: boolean }

/** A folder's entries as choices, relative to the project root. ".git" and any odd name are left out. */
export function fileChoices(dir: string, entries: { name: string; isDir: boolean; size: number }[]): FileChoice[] {
  const base = dir ? safeRelPath(dir) : '';
  if (base === null) return [];
  const out: FileChoice[] = [];
  for (const e of entries) {
    if (typeof e.name !== 'string' || !e.name || e.name === '.' || e.name === '..' || e.name === '.git' || /[\\/\0]/.test(e.name)) continue;
    const relPath = base ? `${base}/${e.name}` : e.name;
    out.push({ name: e.name, relPath, isDir: !!e.isDir, size: e.size, tooLarge: !e.isDir && e.size > MAX_TEXT_BYTES });
  }
  return out;
}

/** The folder above `dir` ('' is the project root). */
export function parentDir(dir: string): string {
  const i = dir.lastIndexOf('/');
  return i < 0 ? '' : dir.slice(0, i);
}
