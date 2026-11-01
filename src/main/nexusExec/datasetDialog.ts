/**
 * "Upload a dataset" (#53, nexus:datasets op add): MAIN's own file window. index.ts hands `pickDatasetOn` Electron's `dialog.showOpenDialog`
 * and the focused window; the IPC layer passes the result to DatasetService.add as its `pick`. The renderer never sends a location and
 * never receives one: what the person chose stays in main, which reads the file once and keeps a copy.
 *
 * The window lists only the kinds Nexus takes (a filter, for the person's convenience; main checks the extension and the content again),
 * one file at a time, never a folder. With no window to parent it (none focused, no main window, or a destroyed one) nothing is shown and
 * the answer is "no choice". Pure apart from the `show` it is given, so a test can drive it without Electron.
 */
import { DATASET_EXTENSIONS } from '../../shared/nexus/datasets';

export interface DatasetDialogOptions {
  title: string; buttonLabel: string; properties: ['openFile', 'dontAddToRecent']; filters: { name: string; extensions: string[] }[];
}

export function datasetDialogOptions(): DatasetDialogOptions {
  return {
    title: 'Upload a dataset', buttonLabel: 'Upload', properties: ['openFile', 'dontAddToRecent'],
    filters: [{ name: 'Data files (CSV, TSV, text, Excel, JSON, Parquet)', extensions: [...DATASET_EXTENSIONS] }]
  };
}

/** A window a dialog can be parented to (an Electron BrowserWindow has this). */
export interface DialogParent { isDestroyed(): boolean }

/** The chosen file's location, or null (closed, nothing chosen, more than one, no live window, or the window failed). */
export async function pickDatasetOn<W extends DialogParent>(parent: W | null | undefined,
  show: (parent: W, o: DatasetDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>): Promise<string | null> {
  try { if (!parent || parent.isDestroyed()) return null; } catch { return null; }
  try {
    const r = await show(parent, datasetDialogOptions());
    if (!r || r.canceled || !Array.isArray(r.filePaths) || r.filePaths.length !== 1) return null;
    const p = r.filePaths[0];
    return typeof p === 'string' && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}
