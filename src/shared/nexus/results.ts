/**
 * The results of a Machine learning project (phase 3 of the machine learning data agent: results and the AI helper's analyst work). Pure:
 * main (the listing, the reads, the copies out), the runner (the one host folder a `/results` mount may name) and the renderer (plain words)
 * share these rules. No I/O here.
 *
 * Where it lives (main derives every path from the project id; the renderer and the model never name one):
 *   results/<projectId>/files/<name>   what the AI helper's code (or a run of the project in the machine learning kit) wrote to /results
 * The files folder is bound READ-WRITE at `/results`, only into a Machine learning project's own sandbox containers (the AI helper's turn and
 * its runs in the machine learning kit, never with a network). It is OUTSIDE the project's files, so a chart or a model never enters the
 * reviewed change (a binary file there would make the change impossible to approve); the analysis script itself goes into the change.
 *
 * The folder is FLAT: only its top-level regular files are results. A folder, a link (symbolic, junction or a second hard link), a file
 * whose name is not plain, or a kind Nexus does not keep is never listed, read or copied (it is counted as "left out"). Everything in the
 * folder was written by sandboxed code, so every byte is treated as untrusted: a chart is shown only when it is a real PNG image of a sane
 * size, a report only as inert text (never HTML), and a model file is never opened by Nexus.
 */

/** The data home folder of every project's results. */
export const RESULTS_DIR = 'results';
/** The one place a Machine learning project's results folder appears inside the sandbox, read-write. */
export const RESULTS_CONTAINER_PATH = '/results';
/** At most this many results are listed (the newest ones); the rest are counted. */
export const RESULTS_MAX_LISTED = 200;
/** At most this many folder entries are looked at for one listing (a folder the sandbox filled with millions of names stays cheap). */
export const RESULTS_SCAN_MAX = 5000;
/** A file over this size is listed but cannot be saved (it can be removed). */
export const RESULT_MAX_BYTES = 100 * 1024 * 1024;
/** A report or a table over this size is not shown in Nexus (it can still be saved). */
export const RESULT_DISPLAY_MAX_BYTES = 25 * 1024 * 1024;
/** The most of a report Nexus reads to show it (a longer one is shown cut, and says so). */
export const REPORT_READ_MAX_BYTES = 256 * 1024;
/** A chart is shown only up to this size (a bigger one is a download-only row). */
export const CHART_SHOW_MAX_BYTES = 2 * 1024 * 1024;
/** A chart's width and height are each at most this many pixels, and its area at most CHART_MAX_PIXELS. */
export const CHART_MAX_SIDE = 10_000;
export const CHART_MAX_PIXELS = 40_000_000;
/** All results of one project together: over this, the listing says so (and the AI helper is told to clear old outputs). */
export const RESULTS_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** How much of a file's start main reads to tell what it is. */
export const RESULT_SNIFF_BYTES = 4096;
export const MAX_RESULT_NAME_CHARS = 100;

export type ResultKind = 'report' | 'chart' | 'table' | 'model' | 'spreadsheet' | 'file';
/** The kinds Nexus keeps, by extension. Anything else (HTML, scripts, programs, archives...) is never listed. */
export const RESULT_EXTENSIONS: Readonly<Record<string, ResultKind>> = Object.freeze({
  md: 'report', txt: 'report',
  png: 'chart',
  csv: 'table', tsv: 'table',
  joblib: 'model', pkl: 'model', pickle: 'model', onnx: 'model',
  xlsx: 'spreadsheet',
  json: 'file', parquet: 'file', svg: 'file', pdf: 'file'
});
/** What a person sees for each kind. */
export const RESULT_KIND_LABEL: Readonly<Record<ResultKind, string>> = Object.freeze({
  report: 'Report', chart: 'Chart', table: 'Table', model: 'Trained model', spreadsheet: 'Spreadsheet', file: 'File'
});

/** A result id: 32 lower-case hex characters main derives from the file's name (the name itself stays in main when it is not shown). */
export const RESULT_ID_RE = /^[0-9a-f]{32}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A plain result name: ASCII letters, digits, space, dot, dash, underscore and parentheses, starting with a letter or digit. */
const PLAIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/;
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** The reasons a results request is refused, each with the one plain sentence the person sees (main and the renderer use these). */
export const RESULT_REASON_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  results_not_ml: 'Results are kept only for a Machine learning project.',
  results_not_found: 'That result is no longer there. It may have been removed or replaced.',
  results_too_big: 'That file is larger than 100 MB, so Nexus cannot save a copy of it. Remove it if you do not need it.',
  results_not_shown: 'Nexus does not show this file here. Use Save to keep a copy.',
  results_changed: 'That file changed while Nexus was reading it. Try again in a moment.',
  results_save_failed: 'Nexus could not save the file there. Check that the folder exists and has free space, then try again.',
  results_save_inside: 'Choose a place outside the folder where Nexus keeps its own data.',
  results_no_window: 'Nexus could not open a window to choose where to save. Try again.',
  results_in_use: 'Nexus could not remove that file right now because it is in use. Try again when the AI helper has finished.',
  results_rate: 'That was asked too many times in a short while. Wait a moment, then try again.'
});

/** `results/<projectId>`: a project's results folder. Refuses an id that is not a plain project id. */
export function resultsProjectRel(projectId: string): string {
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) throw new Error('not a project id');
  return `${RESULTS_DIR}/${projectId}`;
}
/** `results/<projectId>/files`: the one folder the sandbox sees, read-write, at /results. */
export function resultsFilesRel(projectId: string): string { return `${resultsProjectRel(projectId)}/files`; }

/** The lower-case extension of a name when Nexus keeps that kind, else null. */
export function resultExtensionOf(name: string): string | null {
  if (typeof name !== 'string') return null;
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(RESULT_EXTENSIONS, ext) ? ext : null;
}

/**
 * Whether a name written by the sandbox may be listed and shown as it is: plain ASCII (see PLAIN_NAME_RE), at most MAX_RESULT_NAME_CHARS,
 * no `..`, not ending in a dot or a space, not a Windows device name (with or without an extension), and an extension Nexus keeps. A name
 * that is not plain is never shown, never sent to the renderer and never used: that file is left out.
 */
export function isPlainResultName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_RESULT_NAME_CHARS) return false;
  if (!PLAIN_NAME_RE.test(name) || name.includes('..') || /[. ]$/.test(name)) return false;
  const stem = name.split('.')[0].trim();
  if (RESERVED_RE.test(stem)) return false;
  return resultExtensionOf(name) !== null;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A PNG image's size from its first 24 bytes (the signature, then an IHDR chunk), or null when it is not a PNG. */
export function pngSize(head: Uint8Array): { width: number; height: number } | null {
  if (!(head instanceof Uint8Array) || head.length < 24) return null;
  if (!PNG_MAGIC.every((b, i) => head[i] === b)) return null;
  // The first chunk is IHDR, 13 bytes long.
  if (head[8] !== 0 || head[9] !== 0 || head[10] !== 0 || head[11] !== 13) return null;
  if (head[12] !== 0x49 || head[13] !== 0x48 || head[14] !== 0x44 || head[15] !== 0x52) return null;
  const u32 = (o: number): number => ((head[o] << 24) >>> 0) + (head[o + 1] << 16) + (head[o + 2] << 8) + head[o + 3];
  return { width: u32(16), height: u32(20) };
}
/** Whether these bytes start a PNG image of a sane size (a chart Nexus may show). */
export function isShowablePng(head: Uint8Array): boolean {
  const s = pngSize(head);
  return s !== null && s.width >= 1 && s.height >= 1 && s.width <= CHART_MAX_SIDE && s.height <= CHART_MAX_SIDE && s.width * s.height <= CHART_MAX_PIXELS;
}

/** Whether a file's start looks like text (no NUL byte, few control characters). */
export function looksLikeText(head: Uint8Array): boolean {
  if (!(head instanceof Uint8Array)) return false;
  let control = 0;
  for (let i = 0; i < head.length; i++) {
    const b = head[i];
    if (b === 0) return false;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12) control++;
  }
  return control <= Math.max(2, head.length * 0.01);
}

/**
 * What a result is (by its extension AND its content) and whether Nexus may show it. A file whose content is not what its name says becomes
 * a plain `file` that can only be saved: a fake PNG is never shown as a chart, a binary "report" never as text.
 */
export function classifyResult(name: string, head: Uint8Array, size: number): { kind: ResultKind; shown: boolean } {
  const ext = resultExtensionOf(name);
  const kind = ext ? RESULT_EXTENSIONS[ext] : 'file';
  switch (kind) {
    case 'chart':
      return isShowablePng(head) ? { kind: 'chart', shown: size <= CHART_SHOW_MAX_BYTES } : { kind: 'file', shown: false };
    case 'report':
      return looksLikeText(head) ? { kind: 'report', shown: size <= RESULT_DISPLAY_MAX_BYTES } : { kind: 'file', shown: false };
    case 'table':
      return looksLikeText(head) ? { kind: 'table', shown: false } : { kind: 'file', shown: false };
    case 'spreadsheet':
      return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04 ? { kind: 'spreadsheet', shown: false } : { kind: 'file', shown: false };
    case 'model':
      // Never opened, never shown: a saved model is code-like (a pickle runs code when loaded).
      return { kind: 'model', shown: false };
    default:
      return { kind: 'file', shown: false };
  }
}

// Control, format and invisible characters (zero-width, bidirectional overrides, separators); tab and line feed are kept.
// eslint-disable-next-line no-control-regex
const REPORT_STRIP_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
/** A report's text as Nexus shows it: line breaks made plain, every control and invisible character removed. Shown as text, never HTML. */
export function cleanReportText(raw: string): string {
  return String(raw ?? '').replace(/\r\n?/g, '\n').replace(REPORT_STRIP_RE, '');
}

/** A whole number of bytes over the total cap. */
export const overResultsLimit = (totalBytes: number): boolean => Number.isFinite(totalBytes) && totalBytes > RESULTS_MAX_TOTAL_BYTES;
