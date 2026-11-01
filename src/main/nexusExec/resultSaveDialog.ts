/**
 * "Save" of one result (#54, nexus:results op save): MAIN's own Save window. index.ts hands `pickResultSaveOn` Electron's
 * `dialog.showSaveDialog` and the focused window; the IPC layer passes the result to ResultsService.save as its `pick`. The renderer never
 * sends a location and never receives one: the window starts at the result's plain name, and what the person chose stays in main.
 *
 * The window asks before replacing an existing file (`showOverwriteConfirmation`), so main's copy never overwrites silently. With no window to
 * parent it (none focused, no main window, or a destroyed one) nothing is shown and the answer is "no choice". Pure apart from the `show` it is
 * given, so a test can drive it without Electron.
 */
import { isPlainResultName, resultExtensionOf } from '../../shared/nexus/results';

export interface ResultSaveDialogOptions {
  title: string; buttonLabel: string; defaultPath: string;
  properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'];
  filters: { name: string; extensions: string[] }[];
}

export function resultSaveDialogOptions(defaultName: string): ResultSaveDialogOptions {
  const name = isPlainResultName(defaultName) ? defaultName : 'result';
  const ext = resultExtensionOf(name);
  return {
    title: 'Save a copy', buttonLabel: 'Save', defaultPath: name,
    properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
    filters: ext ? [{ name: `${ext.toUpperCase()} file`, extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : [{ name: 'All files', extensions: ['*'] }]
  };
}

/** A window a dialog can be parented to (an Electron BrowserWindow has this). */
export interface DialogParent { isDestroyed(): boolean }

/** The chosen location, or null (closed, nothing chosen, no live window, or the window failed). */
export async function pickResultSaveOn<W extends DialogParent>(parent: W | null | undefined, defaultName: string,
  show: (parent: W, o: ResultSaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>): Promise<string | null> {
  try { if (!parent || parent.isDestroyed()) return null; } catch { return null; }
  try {
    const r = await show(parent, resultSaveDialogOptions(defaultName));
    if (!r || r.canceled || typeof r.filePath !== 'string' || r.filePath.length === 0) return null;
    return r.filePath;
  } catch {
    return null;
  }
}
