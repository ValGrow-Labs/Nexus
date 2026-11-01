import type { ResultView, ResultsView } from '@shared/nexus/ipc';
import { RESULT_KIND_LABEL, RESULT_REASON_MESSAGES } from '@shared/nexus/results';
import { sizeText } from '@shared/nexus/datasets';

/**
 * "Results" in a Machine learning project's work area (phase 3): the words, the rows, the failure sentences and a very small reader for the
 * report's text. Pure. Shown only when main answers that the project is a Machine learning project (`applies`: the same rule the safe space
 * uses). The report is turned into plain blocks (headings, paragraphs, lists, bold) that the component renders as React text: nothing in it
 * is ever HTML, a link or an image.
 */

export const RESULTS_TITLE = 'Results';
export const EMPTY_LINE = 'Nothing here yet. Ask a question about your data.';
/** Always under the block. */
export const STAYS_LINE = 'Results stay on this computer.';
/** Next to every model file. */
export const MODEL_NOTE = 'Only open a saved model with code you trust.';
export const SAVE_LABEL = 'Save';
export const REMOVE_LABEL = 'Remove';
export const REMOVE_ALL_LABEL = 'Remove all';
export const REPORT_TITLE = 'Newest report';
export const CHARTS_TITLE = 'Charts';
export const FILES_TITLE = 'Files';
export const TRUNCATED_LINE = 'This report is long, so only its beginning is shown. Save it to read all of it.';
export const OVER_LIMIT_LINE = 'Your results take up more than 1 GB. Remove the ones you no longer need.';
export const CLEAR_CONFIRM = 'Remove all results of this project? Copies you saved elsewhere are not touched.';
export const NOT_READY_LINE = 'Results can be shown once this computer is ready to run tasks. Open “Get this computer ready”.';
export const GENERIC_FAILURE = 'Nexus could not do that. Try again.';
/** The most charts shown at once (the rest are rows in the file list). */
export const MAX_CHARTS = 12;

export const savedLine = (name: string): string => `Saved a copy of “${name}”.`;
export const removedLine = (name: string): string => `Removed “${name}”.`;
export const clearedLine = (n: number): string => (n === 0 ? 'There was nothing to remove.' : `Removed ${n} result${n === 1 ? '' : 's'}.`);
export const skippedLine = (n: number): string =>
  `Nexus left out ${n} file${n === 1 ? '' : 's'} it does not show here (a folder, a link, a name with unusual characters, or a kind of file it does not keep).`;
export const moreLine = (n: number): string => `${n} older result${n === 1 ? ' is' : 's are'} not listed. Remove some to see them.`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** When a result was written, in plain words. */
export function madeText(at: number, now: number): string {
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return 'Made just now';
  if (min < 60) return `Made ${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Made ${h} hour${h === 1 ? '' : 's'} ago`;
  const d = new Date(at);
  return `Made on ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export interface ResultRow {
  id: string; name: string; facts: string; made: string; isModel: boolean; canSave: boolean; saveLabel: string; removeLabel: string; note: string | null;
}
/** One row per result (newest first, as main lists them): name, kind and size, when it was made, and what can be done with it. */
export function resultRows(view: Pick<ResultsView, 'results'>, now: number): ResultRow[] {
  return view.results.map((r) => ({
    id: r.id, name: r.name,
    facts: [RESULT_KIND_LABEL[r.kind] ?? 'File', sizeText(r.bytes)].join(' · '),
    made: madeText(r.modifiedAt, now),
    isModel: r.kind === 'model',
    canSave: !r.tooBig,
    saveLabel: `${SAVE_LABEL} ${r.name}`,
    removeLabel: `${REMOVE_LABEL} ${r.name}`,
    note: r.tooBig ? 'Too big to save from Nexus (over 100 MB).' : r.kind === 'chart' && !r.shown ? 'Too big to show here. Save it to look at it.' : null
  }));
}

/** The newest report Nexus can show (main lists newest first), or null. */
export const newestReport = (view: Pick<ResultsView, 'results'>): ResultView | null => view.results.find((r) => r.kind === 'report' && r.shown) ?? null;
/** The charts Nexus can show, newest first, at most MAX_CHARTS. */
export const shownCharts = (view: Pick<ResultsView, 'results'>): ResultView[] => view.results.filter((r) => r.kind === 'chart' && r.shown).slice(0, MAX_CHARTS);

/** The plain sentence of a refused request: main's own results sentence, the "not ready" line, or a general one. */
export function resultsFailureText(r: { code: string; reason?: string | null; message?: string | null }): string {
  if (typeof r.reason === 'string' && Object.prototype.hasOwnProperty.call(RESULT_REASON_MESSAGES, r.reason)) return RESULT_REASON_MESSAGES[r.reason];
  if (r.code === 'platform_unavailable') return NOT_READY_LINE;
  return GENERIC_FAILURE;
}

// ---------- the report: very light markdown, as plain blocks of text ----------

export interface Span { text: string; bold: boolean }
export type ReportBlock =
  | { type: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { type: 'paragraph'; spans: Span[] }
  | { type: 'list'; ordered: boolean; items: Span[][] }
  | { type: 'pre'; text: string };

/** The most blocks of a report shown (the text main sends is already bounded). */
export const MAX_REPORT_BLOCKS = 400;
const MAX_SPAN_CHARS = 4000;

/**
 * The text of one line as spans: `**bold**` (or `__bold__`) is bold; code quotes lose their backticks; a markdown link keeps only its words;
 * an image keeps only its alt words. Everything else is kept as it is, as text: `<b>` or `<script>` stay the letters they are.
 */
export function inlineSpans(line: string): Span[] {
  const plain = String(line ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .slice(0, MAX_SPAN_CHARS);
  const out: Span[] = [];
  const re = /\*\*([^*]+)\*\*|__([^_]+)__/g;
  let at = 0;
  for (let m = re.exec(plain); m; m = re.exec(plain)) {
    if (m.index > at) out.push({ text: plain.slice(at, m.index), bold: false });
    out.push({ text: m[1] ?? m[2] ?? '', bold: true });
    at = m.index + m[0].length;
  }
  if (at < plain.length) out.push({ text: plain.slice(at), bold: false });
  return out.filter((s) => s.text.length > 0);
}

/** A report's text as plain blocks: `#`..`######` headings (shown at three sizes), `-`/`*`/`+` and `1.` lists, fenced and table lines as-is, paragraphs. */
export function reportBlocks(text: string): ReportBlock[] {
  const lines = String(text ?? '').split('\n');
  const blocks: ReportBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: Span[][] } | null = null;
  let pre: string[] | null = null;
  const flushPara = (): void => { if (para.length > 0) { blocks.push({ type: 'paragraph', spans: inlineSpans(para.join(' ')) }); para = []; } };
  const flushList = (): void => { if (list) { blocks.push({ type: 'list', ordered: list.ordered, items: list.items }); list = null; } };
  for (const raw of lines) {
    if (blocks.length >= MAX_REPORT_BLOCKS) break;
    const line = raw.replace(/\s+$/, '');
    if (pre) {
      if (/^\s*(```|~~~)/.test(line)) { blocks.push({ type: 'pre', text: pre.join('\n') }); pre = null; } else pre.push(line);
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) { flushPara(); flushList(); pre = []; continue; }
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flushPara(); flushList(); blocks.push({ type: 'heading', level: (Math.min(h[1].length, 3) as 1 | 2 | 3), spans: inlineSpans(h[2]) }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      // A table row or a rule: kept as it is, in a fixed-width line (a table's dashes row included).
      flushPara(); flushList();
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'pre' && /^\s*\|/.test(line)) last.text += `\n${line.trim()}`;
      else if (/^\s*\|/.test(line)) blocks.push({ type: 'pre', text: line.trim() });
      continue;
    }
    const li = /^\s*(?:([-*+])|(\d{1,4})[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = li[2] !== undefined;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push(inlineSpans(li[3]));
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  if (pre) blocks.push({ type: 'pre', text: (pre as string[]).join('\n') });
  flushPara(); flushList();
  return blocks.slice(0, MAX_REPORT_BLOCKS);
}
