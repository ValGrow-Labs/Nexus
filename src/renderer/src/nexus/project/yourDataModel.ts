import { create } from 'zustand';
import type { DatasetView, DatasetsView } from '@shared/nexus/ipc';
import { DATASET_REASON_MESSAGES, DATASET_TYPE_LABEL, countText, sizeText } from '@shared/nexus/datasets';

/**
 * "Your data" in a Machine learning project's work area (phase 2: upload and delivery): the words, one row per file, the failure sentences,
 * and the small store the request box reads (whether the open project has data, for its placeholder). Pure apart from the store. Shown only
 * when main answers that the project is a Machine learning project (`applies`: the same rule the safe space uses).
 */

export const YOUR_DATA_TITLE = 'Your data';
export const UPLOAD_LABEL = 'Upload a dataset';
export const UPLOADING_LABEL = 'Uploading…';
export const REMOVE_LABEL = 'Remove';
export const EMPTY_LINE = 'No data yet.';
/** Always near the button. */
export const PRIVACY_LINE = 'Stays on this computer. The AI helper sees column names and anything its code prints.';
/** When the AI service in use runs on this computer. */
export const PRIVACY_LINE_LOCAL = 'Nothing leaves this computer.';
export const REMOVE_NOTE = 'Remove deletes only Nexus’s copy.';
export const DAMAGED_LINE = 'Nexus could not read its list of your data, so none is shown. Upload your files again; the earlier copies are cleared when you do.';
export const REMOVED_LINE = 'Removed. Your original file is untouched.';
export const NOT_READY_LINE = 'Data can be added once this computer is ready to run tasks. Open “Get this computer ready”.';
export const GENERIC_FAILURE = 'Nexus could not do that. Try again.';

export const privacyLine = (aiOnThisComputer: boolean): string => (aiOnThisComputer ? PRIVACY_LINE_LOCAL : PRIVACY_LINE);
export const addedLine = (name: string): string => `Added “${name}”.`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** When a file was added, in plain words. */
export function addedText(addedAt: number, now: number): string {
  const ago = Math.max(0, now - addedAt);
  const min = Math.floor(ago / 60_000);
  if (min < 1) return 'Added just now';
  if (min < 60) return `Added ${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Added ${h} hour${h === 1 ? '' : 's'} ago`;
  const d = new Date(addedAt);
  return `Added on ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** The shape of a file's rows and columns (delimited text only), or null. */
export function shapeText(v: Pick<DatasetView, 'rows' | 'columns'>): string | null {
  const rows = v.rows === null ? null : `${countText(v.rows)} row${v.rows === 1 ? '' : 's'}`;
  const cols = v.columns === null ? null : `${countText(v.columns)} column${v.columns === 1 ? '' : 's'}`;
  if (rows && cols) return `${rows} × ${cols}`;
  return rows ?? cols;
}

export interface DataRow { id: string; name: string; facts: string; added: string; removeLabel: string }
/** One row per file: its name, then kind, size and shape, then when it was added. */
export function dataRows(view: Pick<DatasetsView, 'datasets'>, now: number): DataRow[] {
  return view.datasets.map((d) => ({
    id: d.id, name: d.name,
    facts: [DATASET_TYPE_LABEL[d.type] ?? d.type, sizeText(d.bytes), shapeText(d)].filter((x): x is string => !!x).join(' · '),
    added: addedText(d.addedAt, now),
    removeLabel: `${REMOVE_LABEL} ${d.name}`
  }));
}

/** The plain sentence of a refused request: main's own dataset sentence, the "not ready" line, or a general one. */
export function dataFailureText(r: { code: string; reason?: string | null; message?: string | null }): string {
  if (typeof r.reason === 'string' && Object.prototype.hasOwnProperty.call(DATASET_REASON_MESSAGES, r.reason)) return DATASET_REASON_MESSAGES[r.reason];
  if (r.code === 'platform_unavailable') return NOT_READY_LINE;
  return GENERIC_FAILURE;
}

/** Whether a project has data, per project id (set by "Your data"; the request box reads it for its placeholder). */
export const useProjectData = create<{ counts: Record<string, number>; set: (projectId: string, n: number) => void }>((set) => ({
  counts: {},
  set: (projectId, n) => set((s) => (s.counts[projectId] === n ? s : { counts: { ...s.counts, [projectId]: n } }))
}));
