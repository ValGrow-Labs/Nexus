// Pure: the Saved items page (pages/ArtifactsPage.tsx; route name: artifacts). The filters and the
// nexus:artifacts:list request they make, the list read state with paging,
// the rows as people read them, the one line or empty state to show, and the
// detail read (nexus:artifact:get) with the node the artifact Passport shows.
// No React, no zustand, so tests load it directly.
import type { ArtifactDetail, ArtifactSummaryView, ArtifactsListFilter, NexusResult } from '@shared/nexus/ipc';
import { errorCopy } from '../data/errorCopy';
import { kindLabel, statusLabel } from '../project/artifactModel';
import type { ArtifactNode } from '../project/spineModel';
import { viewOf } from '../workspaces/participation';

// ---------- filters ----------

/** The kinds a person can save or receive in this phase; the kind filter offers these only. */
export const ARTIFACT_KINDS = ['git_commit', 'text_file', 'handoff_receipt'] as const;
export type ArtifactSort = 'recent' | 'name';

export interface ArtifactFilters {
  /** '' means any. */
  projectId: string;
  workspaceId: string;
  kind: string;
  status: '' | 'active' | 'archived';
  sort: ArtifactSort;
}

export const NO_FILTERS: ArtifactFilters = { projectId: '', workspaceId: '', kind: '', status: '', sort: 'recent' };

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WORKSPACE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** True when any filter narrows the list (sorting never does). */
export function filtersActive(f: ArtifactFilters): boolean {
  return f.projectId !== '' || f.workspaceId !== '' || f.kind !== '' || f.status !== '';
}

/** The nexus:artifacts:list argument: only the keys a filter sets, each in the shape main accepts. A value
 *  that does not fit that shape is left out rather than sent. */
export function listRequest(f: ArtifactFilters, limit: number): ArtifactsListFilter {
  const out: ArtifactsListFilter = { limit: clampLimit(limit) };
  if (PROJECT_ID_RE.test(f.projectId)) out.projectId = f.projectId;
  if (WORKSPACE_ID_RE.test(f.workspaceId)) out.workspaceId = f.workspaceId;
  if ((ARTIFACT_KINDS as readonly string[]).includes(f.kind)) out.kind = f.kind;
  if (f.status === 'active' || f.status === 'archived') out.status = f.status;
  return out;
}

/** What identifies one list read apart from its size: a change starts over from the first page. */
export function filterKey(f: ArtifactFilters): string {
  const r = listRequest(f, ARTIFACT_PAGE);
  return [r.projectId ?? '', r.workspaceId ?? '', r.kind ?? '', r.status ?? ''].join('|');
}

// ---------- paging ----------

/** Rows asked for at first and added by each "Show more". */
export const ARTIFACT_PAGE = 100;
/** The most nexus:artifacts:list returns in one answer. */
export const ARTIFACT_LIST_MAX = 500;

function clampLimit(n: number): number {
  return Number.isInteger(n) && n >= 1 ? Math.min(n, ARTIFACT_LIST_MAX) : ARTIFACT_PAGE;
}

export function nextLimit(limit: number): number {
  return Math.min(clampLimit(limit) + ARTIFACT_PAGE, ARTIFACT_LIST_MAX);
}

/** After a truncated answer: offer more while the channel allows it, else say the list is capped. */
export function pagingOf(s: Pick<ArtifactListState, 'truncated' | 'loaded'>, limit: number): 'more' | 'capped' | null {
  if (!s.loaded || !s.truncated) return null;
  return clampLimit(limit) < ARTIFACT_LIST_MAX ? 'more' : 'capped';
}

export const CAPPED_TEXT = `Only the ${ARTIFACT_LIST_MAX} saved items changed most recently are listed. Narrow the filters to find others.`;

// ---------- the list read ----------

export interface ArtifactListState {
  /** The filter key these rows answer. */
  key: string;
  rows: ArtifactSummaryView[];
  /** True once an answer for this key arrived (success or not). */
  loaded: boolean;
  /** A read is in flight (the first one, or "Show more" while the rows stay). */
  loading: boolean;
  /** More rows exist than were returned. */
  truncated: boolean;
  /** The platform is unavailable: nothing can be listed; the platform notice says why. */
  unavailable: boolean;
  /** A sentence from errorCopy; null on success. */
  error: string | null;
  /** True when sending the same read again may help (busy, internal). */
  retry: boolean;
}

export const NO_LIST: ArtifactListState = { key: '', rows: [], loaded: false, loading: false, truncated: false, unavailable: false, error: null, retry: false };

/** A read starts: a new filter key starts over; the same key keeps its rows while it reads. */
export function startListRead(prev: ArtifactListState, key: string): ArtifactListState {
  if (prev.key !== key) return { ...NO_LIST, key, loading: true };
  return { ...prev, loading: true };
}

/** The next state after a nexus:artifacts:list answer for `key`. An answer for another key changes nothing. */
export function nextArtifactList(prev: ArtifactListState, key: string, r: NexusResult<ArtifactSummaryView[]>): ArtifactListState {
  if (prev.key !== key) return prev;
  if (r.ok) {
    return { key, rows: Array.isArray(r.data) ? r.data : [], loaded: true, loading: false, truncated: r.truncated === true, unavailable: false, error: null, retry: false };
  }
  const copy = errorCopy(r.code, r.reason, r.subReason);
  if (copy.kind === 'unavailable') return { ...NO_LIST, key, loaded: true, unavailable: true };
  // A passing failure keeps what was last read; a refusal shows nothing stale.
  if (copy.retry) return { ...prev, loaded: true, loading: false, error: copy.text, retry: true };
  return { ...NO_LIST, key, loaded: true, error: copy.text };
}

/** The one thing the list area shows instead of (or above) rows. */
export type ListNotice =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; text: string; retry: boolean }
  | { kind: 'empty' }
  | { kind: 'no-match' }
  | null;

export function listNotice(s: ArtifactListState, f: ArtifactFilters): ListNotice {
  if (!s.loaded) return { kind: 'loading' };
  if (s.unavailable) return { kind: 'unavailable' };
  if (s.error !== null && s.rows.length === 0) return { kind: 'error', text: s.error, retry: s.retry };
  if (s.rows.length === 0) return filtersActive(f) ? { kind: 'no-match' } : { kind: 'empty' };
  return null;
}

/** A passing failure while earlier rows are still shown: one line above them (with "Try again" when it may help). */
export function staleError(s: ArtifactListState): { text: string; retry: boolean } | null {
  return s.error !== null && s.rows.length > 0 ? { text: s.error, retry: s.retry } : null;
}

/** The empty state says what a saved item is and what to do next. */
export const EMPTY_TITLE = 'No saved items yet';
export const EMPTY_BODY = 'Saved items are the things your projects make or keep: notes, builds, suggested changes. Open a project and press "Add a file to saved items" in its details to keep your first one.';
export const NO_MATCH_TEXT = 'No saved items match these filters.';

// ---------- rows ----------

export const REMOVED_PROJECT = 'Removed project';

export interface ArtifactRowView {
  id: string;
  name: string;
  kind: string;
  /** The project's name; "Removed project" when the project list no longer has it; '' before that list is read. */
  project: string;
  projectKnown: boolean;
  /** The owner workspace's label; "Whole project" for a project-owned artifact. */
  workspace: string;
  hueSlot: number | null;
  /** "Version 3, in use", "Version 2, draft", "No versions". */
  version: string;
  archived: boolean;
  updatedAt: number;
}

/** `projectsRead`: false while the project list has not been read; a project missing from it is then not
 *  called removed (its segment is left empty) because that would not be known yet. */
export function artifactRow(s: ArtifactSummaryView, projectNames: ReadonlyMap<string, string>, projectsRead = true): ArtifactRowView {
  const a = s.artifact;
  const name = projectNames.get(a.projectId);
  const ws = a.ownerWorkspaceId ? viewOf(a.ownerWorkspaceId) : null;
  const version = s.current
    ? `Version ${s.current.versionNo}, in use`
    : s.latest ? `Version ${s.latest.versionNo}, ${statusLabel(s.latest.status)}` : 'No versions';
  return {
    id: a.id, name: a.name, kind: kindLabel(a.kind),
    project: name ?? (projectsRead ? REMOVED_PROJECT : ''), projectKnown: name !== undefined,
    workspace: ws ? ws.label : 'Whole project', hueSlot: ws ? ws.hueSlot : null,
    version, archived: a.status === 'archived', updatedAt: a.updatedAt
  };
}

/** Rows in the chosen order. "recent": last changed first; "name": by name, then last changed first. The id
 *  breaks ties so the order never jumps between reads. */
export function sortedRows(summaries: readonly ArtifactSummaryView[], projectNames: ReadonlyMap<string, string>, sort: ArtifactSort, projectsRead = true): ArtifactRowView[] {
  const rows = summaries.map((s) => artifactRow(s, projectNames, projectsRead));
  const byRecent = (a: ArtifactRowView, b: ArtifactRowView) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  if (sort === 'name') return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || byRecent(a, b));
  return rows.sort(byRecent);
}

/** The project choices of the project filter: by name. */
export function projectChoices(projects: readonly { id: string; name: string }[]): { id: string; name: string }[] {
  return [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1)).map((p) => ({ id: p.id, name: p.name }));
}

// ---------- the detail read ----------

export interface ArtifactDetailState {
  id: string;
  status: 'loading' | 'ready' | 'missing' | 'unavailable' | 'error';
  detail: ArtifactDetail | null;
  error: string | null;
  retry: boolean;
}

export function detailLoading(id: string): ArtifactDetailState {
  return { id, status: 'loading', detail: null, error: null, retry: false };
}

export const MISSING_TITLE = 'Saved item not found';
export const MISSING_BODY = 'We cannot find this saved item. It may have been removed, or the link may be wrong.';

/** The next detail state after a nexus:artifact:get answer for `id`. An answer for another id changes nothing. */
export function nextDetail(prev: ArtifactDetailState, id: string, r: NexusResult<ArtifactDetail>): ArtifactDetailState {
  if (prev.id !== id) return prev;
  if (r.ok) {
    const d = r.data;
    if (!d || !d.artifact || d.artifact.id !== id || !Array.isArray(d.versions)) return { id, status: 'error', detail: prev.detail, error: errorCopy('internal').text, retry: true };
    return { id, status: 'ready', detail: d, error: null, retry: false };
  }
  if (r.code === 'not_found') return { id, status: 'missing', detail: null, error: null, retry: false };
  const copy = errorCopy(r.code, r.reason, r.subReason);
  if (copy.kind === 'unavailable') return { id, status: 'unavailable', detail: null, error: null, retry: false };
  // A passing failure keeps an artifact already shown; a refusal shows nothing.
  if (copy.retry && prev.detail) return { id, status: 'ready', detail: prev.detail, error: copy.text, retry: true };
  return { id, status: 'error', detail: null, error: copy.text, retry: copy.retry };
}

/** The node the artifact Passport shows: the current version, else the newest; version 0 when there is none. */
export function detailNode(d: ArtifactDetail): ArtifactNode {
  const a = d.artifact;
  const current = a.currentVersionId ? d.versions.find((v) => v.id === a.currentVersionId) ?? null : null;
  const newest = d.versions.reduce<ArtifactDetail['versions'][number] | null>((m, v) => (m === null || v.versionNo > m.versionNo ? v : m), null);
  const shown = current ?? newest;
  return {
    kind: 'artifact', id: `artifact:${a.id}`, artifactId: a.id, artifactKind: a.kind, name: a.name,
    versionNo: shown ? shown.versionNo : 0, status: shown ? shown.status : 'draft', isCurrent: shown !== null && shown === current
  };
}
