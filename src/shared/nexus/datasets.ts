/**
 * The data a person adds to a Machine learning project (phase 2 of the machine learning data agent: upload and delivery). Pure: main
 * (storage, the AI helper's context block), the runner (the one host folder a `/data` mount may name) and the renderer (plain words)
 * share these rules. No I/O here.
 *
 * Where it lives (main derives every path from the project id; the renderer and the model never name one):
 *   datasets/<projectId>/manifest.json      Nexus's record of the project's data (atomic write; validated on every read)
 *   datasets/<projectId>/files/<safe name>  Nexus's own copy of each file, under a name main makes (never the person's raw name)
 *   datasets/<projectId>/tmp/<id>.part      a copy in progress (renamed into files/ only once it is complete and checked)
 * The files folder is the one folder the sandbox sees, read-only, at `/data`, so a script reads `/data/<safe name>` the same way in
 * the AI helper's container and in a run of the project. The person's original file is read once and never touched.
 */

/** The data home folder of every project's data. */
export const DATASETS_DIR = 'datasets';
/** The one place a Machine learning project's data appears inside the sandbox, always read-only. */
export const DATA_CONTAINER_PATH = '/data';
export const DATASET_MAX_BYTES = 200 * 1024 * 1024;
export const DATASETS_MAX_PER_PROJECT = 20;
export const DATASETS_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const MAX_COLUMNS = 200;
export const MAX_COLUMN_CHARS = 100;
export const MAX_DISPLAY_NAME_CHARS = 100;
export const MAX_SAFE_STEM_CHARS = 60;
/** How much of a file's start main keeps to check what it is and to read the header row. */
export const SNIFF_BYTES = 1024 * 1024;
/** Counting rows stops after this long (the row count is then not known); the copy itself always finishes. */
export const ROW_COUNT_MAX_MS = 30_000;
/** The manifest is small (20 records of at most 200 short column names); a bigger one is damaged. */
export const MANIFEST_MAX_BYTES = 1024 * 1024;

export const DATASET_EXTENSIONS = Object.freeze(['csv', 'tsv', 'txt', 'json', 'jsonl', 'xlsx', 'parquet'] as const);
export type DatasetExt = (typeof DATASET_EXTENSIONS)[number];
/** The delimited text kinds: they get column names (from the header row) and a row count. */
export const DELIMITED_EXTENSIONS: readonly DatasetExt[] = Object.freeze(['csv', 'tsv', 'txt']);
/** What a person sees for each kind (no tool or vendor words beyond the file kind's own common name). */
export const DATASET_TYPE_LABEL: Readonly<Record<DatasetExt, string>> = Object.freeze({
  csv: 'CSV', tsv: 'TSV', txt: 'Text table', json: 'JSON', jsonl: 'JSON lines', xlsx: 'Excel', parquet: 'Parquet'
});

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/** A stored file name: ASCII letters, digits, `_` and `-`, then one dot and an allowed extension. */
export const SAFE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(csv|tsv|txt|json|jsonl|xlsx|parquet)$/;
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** The reasons a dataset request is refused, each with the one plain sentence the person sees (main and the renderer use these). */
export const DATASET_REASON_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  dataset_not_ml: 'Data can be added only to a Machine learning project.',
  dataset_type: 'Nexus cannot use that kind of file. Choose a CSV, TSV, text table, Excel, JSON or Parquet file.',
  dataset_link: 'That is a shortcut or a link to another file. Choose the file itself.',
  dataset_not_file: 'That is not a single file. Choose one file.',
  dataset_empty: 'That file is empty.',
  dataset_too_big: 'That file is larger than 200 MB, the most Nexus can take for one file.',
  dataset_too_many: 'This project already holds 20 files of data, the most it can take. Remove one first.',
  dataset_total: 'With that file, this project\'s data would be over 1 GB in all, the most it can take. Remove a file first.',
  dataset_unreadable: 'Nexus could not read that file. Check that another program is not using it, then try again.',
  dataset_content: 'That file is not what its name says inside (a CSV, TSV, text table, Excel, JSON or Parquet file), so Nexus did not add it.',
  dataset_busy: 'Nexus is already adding a file. Wait for it to finish, then try again.',
  dataset_not_found: 'That file is no longer in this project\'s data.',
  dataset_store: 'Nexus could not keep a copy of that file. Check that the disk has free space, then try again.',
  dataset_in_use: 'Nexus could not remove that file right now because it is in use. Try again when the AI helper has finished.',
  dataset_no_window: 'Nexus could not open a window to choose a file. Try again.',
  dataset_rate: 'That was asked too many times in a short while. Wait a moment, then try again.'
});

/** `datasets/<projectId>`: a project's data folder (manifest, files, copies in progress). Refuses an id that is not a plain project id. */
export function datasetsProjectRel(projectId: string): string {
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) throw new Error('not a project id');
  return `${DATASETS_DIR}/${projectId}`;
}
/** `datasets/<projectId>/files`: the one folder the sandbox sees, read-only, at /data. */
export function datasetsFilesRel(projectId: string): string { return `${datasetsProjectRel(projectId)}/files`; }

/** The allowed extension of a file name (lower case), or null. */
export function extensionOf(name: string): DatasetExt | null {
  if (typeof name !== 'string') return null;
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  return (DATASET_EXTENSIONS as readonly string[]).includes(ext) ? (ext as DatasetExt) : null;
}
/** True for a Windows shortcut or internet shortcut name: refused as a link, never followed. */
export const isShortcutName = (name: string): boolean => /\.(lnk|url)$/i.test(String(name));

/**
 * The name a person sees: the original base name with only letters, digits, space, dot, dash, underscore and parentheses kept (any
 * other character becomes `_`), no leading dot, whitespace collapsed, at most MAX_DISPLAY_NAME_CHARS (the extension kept). Shown only.
 */
export function displayNameOf(baseName: string, ext: DatasetExt): string {
  const raw = String(baseName ?? '');
  const suffix = `.${ext}`;
  const stemRaw = raw.toLowerCase().endsWith(suffix) ? raw.slice(0, -suffix.length) : raw;
  const stem = [...stemRaw].map((ch) => (/[\p{L}\p{N} ._()-]/u.test(ch) ? ch : '_')).join('')
    .replace(/_+/g, '_').replace(/\s+/g, ' ').trim().replace(/^[.\s_]+/, '').slice(0, MAX_DISPLAY_NAME_CHARS - suffix.length).trim();
  return /[\p{L}\p{N}]/u.test(stem) ? `${stem}${suffix}` : `dataset${suffix}`;
}

/**
 * The stored name (and the name under /data): made by main from the shown name, ASCII letters, digits, `_` and `-` only, at most
 * MAX_SAFE_STEM_CHARS, never a Windows device name, then the allowed extension; `_2`, `_3`... when the name is taken (`taken` holds lower-case
 * names: the host folder may not tell case apart).
 */
export function safeFileName(displayName: string, ext: DatasetExt, taken: ReadonlySet<string>): string {
  const suffix = `.${ext}`;
  const base = String(displayName ?? '');
  const stem0 = base.toLowerCase().endsWith(suffix) ? base.slice(0, -suffix.length) : base;
  let stem = stem0.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\s.]+/g, '_').replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/_+/g, '_').replace(/^[_-]+/, '').slice(0, MAX_SAFE_STEM_CHARS).replace(/[_-]+$/, '');
  if (stem.length === 0) stem = 'dataset';
  if (RESERVED_RE.test(stem)) stem = `data_${stem}`;
  let name = `${stem}${suffix}`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}_${n}${suffix}`;
  return name;
}

/** Whether the start (and, for Parquet, the end) of a file is what its extension says. Never decides from the name alone. */
export function sniffOk(ext: DatasetExt, head: Uint8Array, tail: Uint8Array | null, size: number): boolean {
  if (!(head instanceof Uint8Array) || head.length === 0) return false;
  const starts = (sig: number[]): boolean => sig.every((b, i) => head[i] === b);
  switch (ext) {
    case 'xlsx': return head.length >= 4 && starts([0x50, 0x4b, 0x03, 0x04]);
    case 'parquet': {
      const magic = [0x50, 0x41, 0x52, 0x31];
      return size >= 12 && head.length >= 4 && starts(magic) && tail !== null && tail.length >= 4 && magic.every((b, i) => tail[tail.length - 4 + i] === b);
    }
    default: break;
  }
  if (head.includes(0)) return false;
  const text = decodeText(head);
  let control = 0;
  for (const ch of text) { const c = ch.charCodeAt(0); if ((c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) || c === 0xfffd) control++; }
  if (control > Math.max(2, text.length * 0.01)) return false;
  const body = text.replace(/^\ufeff/, '').trimStart();
  if (ext === 'json' || ext === 'jsonl') return body.startsWith('{') || body.startsWith('[');
  if (body.length === 0) return false;
  if (ext === 'txt') return delimiterOf('txt', firstLineOf(head) ?? '') !== null;
  return true;
}

/** UTF-8 text of some bytes; a character cut at the end is dropped, a byte that is not UTF-8 becomes U+FFFD. */
export function decodeText(bytes: Uint8Array): string {
  let end = bytes.length;
  // Drop a trailing partial UTF-8 sequence (at most 3 bytes back).
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = bytes[end - i];
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (need > i) end -= i;
    break;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, end));
}

/** The first line of a file's start (without its line break), or null when no line break is in the bytes given and they may go on. */
export function firstLineOf(head: Uint8Array, wholeFile = false): string | null {
  const nl = head.indexOf(0x0a);
  if (nl < 0 && !wholeFile) return null;
  return decodeText(head.subarray(0, nl < 0 ? head.length : nl)).replace(/^\ufeff/, '').replace(/\r$/, '');
}

const CANDIDATES = [',', '\t', ';', '|'];
/** The delimiter of a delimited file from its header line: tab for TSV; for CSV a comma (a semicolon when it has none); for text the most used. */
export function delimiterOf(ext: DatasetExt, line: string): string | null {
  if (ext === 'tsv') return '\t';
  const count = (d: string): number => { let n = 0; let q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === d && !q) n++; } return n; };
  if (ext === 'csv') return count(',') === 0 && count(';') > 0 ? ';' : ',';
  if (ext !== 'txt') return null;
  let best: string | null = null; let most = 0;
  for (const d of CANDIDATES) { const n = count(d); if (n > most) { most = n; best = d; } }
  return best;
}

/** One column name as kept: control characters become spaces, whitespace collapsed, at most MAX_COLUMN_CHARS. */
export function cleanColumnName(raw: string): string {
  return String(raw ?? '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_COLUMN_CHARS).trim();
}

/** The column names of a header line (quoted fields and doubled quotes understood), at most MAX_COLUMNS, each cleaned. */
export function parseHeader(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = ''; let quoted = false; let i = 0;
  const text = String(line ?? '').replace(/^\ufeff/, '');
  while (i < text.length && out.length < MAX_COLUMNS) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === '"' && cur.trim() === '') { quoted = true; cur = ''; i++; continue; }
    if (ch === delimiter) { out.push(cleanColumnName(cur)); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (out.length < MAX_COLUMNS && (cur.length > 0 || text.endsWith(delimiter))) out.push(cleanColumnName(cur));
  return out;
}

/**
 * Counts the rows of a delimited file while it streams past (the header row not counted, blank lines not counted). A line break inside a
 * quoted field is not a new row; a quote only opens a field at its start. Stops counting at its deadline (`rows()` is then null).
 */
export class RowCounter {
  private lines = 0;
  private content = false;
  private inQuote = false;
  private pending = false;
  private prev = 0x0a;
  private stopped = false;
  private readonly delim: number;
  constructor(delimiter: string, private readonly deadline: number, private readonly now: () => number = Date.now) {
    this.delim = delimiter.length === 1 ? delimiter.charCodeAt(0) : -1;
  }
  push(chunk: Uint8Array): void {
    if (this.stopped) return;
    if (this.now() > this.deadline) { this.stopped = true; return; }
    const Q = 0x22; const LF = 0x0a; const CR = 0x0d;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (this.inQuote) {
        if (this.pending) {
          this.pending = false;
          if (b === Q) { this.prev = b; continue; }
          this.inQuote = false;
        } else {
          if (b === Q) this.pending = true;
          this.prev = b;
          continue;
        }
      }
      if (b === Q && (this.prev === this.delim || this.prev === LF || this.prev === CR)) { this.inQuote = true; this.content = true; this.prev = b; continue; }
      if (b === LF) { if (this.content) this.lines++; this.content = false; }
      else if (b !== CR) this.content = true;
      this.prev = b;
    }
  }
  /** The rows counted (the header row taken off), or null when counting stopped at its deadline. */
  rows(): number | null {
    if (this.stopped) return null;
    return Math.max(0, this.lines + (this.content ? 1 : 0) - 1);
  }
}

/** One dataset as the manifest records it. `file` is the stored name (and the name under /data); `name` is what the person sees. */
export interface DatasetRecord {
  id: string; name: string; file: string; ext: DatasetExt; bytes: number; sha256: string; addedAt: number;
  /** Delimited text only (null otherwise, or when the header could not be read). */
  columns: string[] | null;
  /** Delimited text only (null otherwise, or when counting stopped). */
  rows: number | null;
}

const RECORD_KEYS = ['id', 'name', 'file', 'ext', 'bytes', 'sha256', 'addedAt', 'columns', 'rows'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.prototype.hasOwnProperty.call(o, x));
};

function recordOf(v: unknown): DatasetRecord | null {
  if (!isObj(v) || !exactKeys(v, RECORD_KEYS)) return null;
  const { id, name, file, ext, bytes, sha256, addedAt, columns, rows } = v;
  if (typeof id !== 'string' || !ULID_RE.test(id)) return null;
  if (typeof ext !== 'string' || !(DATASET_EXTENSIONS as readonly string[]).includes(ext)) return null;
  if (typeof name !== 'string' || name.length === 0 || displayNameOf(name, ext as DatasetExt) !== name) return null;
  if (typeof file !== 'string' || !SAFE_FILE_RE.test(file) || extensionOf(file) !== ext) return null;
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 1 || (bytes as number) > DATASET_MAX_BYTES) return null;
  if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) return null;
  if (!Number.isSafeInteger(addedAt) || (addedAt as number) < 0) return null;
  if (columns !== null && (!Array.isArray(columns) || columns.length > MAX_COLUMNS
    || !columns.every((c) => typeof c === 'string' && c === cleanColumnName(c)))) return null;
  if (rows !== null && (!Number.isSafeInteger(rows) || (rows as number) < 0)) return null;
  const delimited = (DELIMITED_EXTENSIONS as readonly string[]).includes(ext);
  if (!delimited && (columns !== null || rows !== null)) return null;
  return { id, name, file, ext: ext as DatasetExt, bytes: bytes as number, sha256, addedAt: addedAt as number,
    columns: columns === null ? null : [...(columns as string[])], rows: rows as number | null };
}

/**
 * A manifest's records, validated whole: any record out of shape, a repeated id or stored name, too many files or too many bytes, and the
 * manifest is damaged and reads as empty (`damaged: true`, so the person is told). No manifest yet (null) is simply empty.
 */
export function parseManifest(text: string | null): { datasets: DatasetRecord[]; damaged: boolean } {
  if (text === null) return { datasets: [], damaged: false };
  const damaged = { datasets: [] as DatasetRecord[], damaged: true };
  if (typeof text !== 'string' || text.length > MANIFEST_MAX_BYTES) return damaged;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return damaged; }
  if (!isObj(v) || !exactKeys(v, ['version', 'datasets']) || v.version !== 1 || !Array.isArray(v.datasets) || v.datasets.length > DATASETS_MAX_PER_PROJECT) return damaged;
  const out: DatasetRecord[] = [];
  const ids = new Set<string>(); const files = new Set<string>();
  let total = 0;
  for (const raw of v.datasets) {
    const r = recordOf(raw);
    if (!r || ids.has(r.id) || files.has(r.file.toLowerCase())) return damaged;
    ids.add(r.id); files.add(r.file.toLowerCase()); total += r.bytes;
    out.push(r);
  }
  if (total > DATASETS_MAX_TOTAL_BYTES) return damaged;
  return { datasets: out, damaged: false };
}

/** The manifest text of these records (what parseManifest reads back). */
export function manifestText(datasets: readonly DatasetRecord[]): string {
  return `${JSON.stringify({ version: 1, datasets: datasets.map((d) => ({ id: d.id, name: d.name, file: d.file, ext: d.ext, bytes: d.bytes, sha256: d.sha256,
    addedAt: d.addedAt, columns: d.columns, rows: d.rows })) }, null, 1)}\n`;
}

/** A size in plain words: bytes, KB, MB or GB (1024-based, one decimal under 10). */
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024; let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** A whole number with thousands separators (10,000). */
export const countText = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
