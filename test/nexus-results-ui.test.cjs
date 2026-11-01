'use strict';
// "Results" in a Machine learning project's work area (phase 3), the renderer side. Plain node: the model's words and rows, the report
// reader (very light markdown as plain blocks), the failure sentences, a REAL render of the report component with a hostile report (it
// comes out as escaped text), and source pins of the wiring (no location ever crosses; only an ML project; refreshed when a job changes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/renderer/src/nexus/project/resultsModel.ts');
const { RESULT_REASON_MESSAGES } = loadTs('src/shared/nexus/results.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const res = (o = {}) => ({ id: 'a'.repeat(32), name: 'report.md', kind: 'report', bytes: 2048, modifiedAt: NOW - 5 * 60_000, shown: true, tooBig: false, ...o });
const view = (results) => ({ applies: true, results, skipped: 0, more: 0, totalBytes: 0, overLimit: false });

/** Results.tsx compiled for node (JSX to react/jsx-runtime), its data imports stubbed: only the pure report component is rendered. */
function loadResultsTsx() {
  const file = path.join(__dirname, '..', 'src/renderer/src/nexus/project/Results.tsx');
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: file });
  const stubs = { '../data/nexusClient': { nexusClient: {} }, '../data/useExecution': { useExecStore: () => 0, useHints: () => {} }, '../ui/Button': { Button: () => null } };
  const mod = { exports: {} };
  const req = (r) => (r === './resultsModel' ? M : Object.prototype.hasOwnProperty.call(stubs, r) ? stubs[r] : require(r));
  new Function('module', 'exports', 'require', out.outputText)(mod, mod.exports, req);
  return mod.exports;
}

test('RU1 the words: the title, the empty line, the model note and the line under the block, exactly as agreed', () => {
  assert.equal(M.RESULTS_TITLE, 'Results');
  assert.equal(M.EMPTY_LINE, 'Nothing here yet. Ask a question about your data and the results will show up here.');
  assert.equal(M.MODEL_NOTE, 'A saved model file can only be opened safely by code you trust. Nexus never opens it for you.');
  assert.match(M.STAYS_LINE, /^Results stay on this computer\./);
  assert.deepEqual([M.SAVE_LABEL, M.REMOVE_LABEL, M.REMOVE_ALL_LABEL], ['Save', 'Remove', 'Remove all']);
  assert.equal(M.savedLine('report.md'), 'Saved a copy of “report.md”.');
  assert.equal(M.clearedLine(0), 'There was nothing to remove.'); assert.equal(M.clearedLine(3), 'Removed 3 results.');
  assert.match(M.skippedLine(2), /^Nexus left out 2 files it does not show here/);
  assert.match(M.moreLine(1), /^1 older result is not listed/);
  const all = [M.RESULTS_TITLE, M.EMPTY_LINE, M.STAYS_LINE, M.MODEL_NOTE, M.TRUNCATED_LINE, M.OVER_LIMIT_LINE, M.CLEAR_CONFIRM, M.NOT_READY_LINE, M.GENERIC_FAILURE,
    M.REPORT_TITLE, M.CHARTS_TITLE, M.FILES_TITLE, M.skippedLine(2), M.moreLine(2), ...Object.values(RESULT_REASON_MESSAGES)].join('\n');
  assert.doesNotMatch(all, /\bcard\b|dashboard|gradient|docker|container|sandbox|mount|ml-python|pandas|joblib|matplotlib|\/results|\/data|cloud|server|claude|anthropic/i,
    'plain words, no tool or vendor word');
});

test('RU2 one row per result: name, kind and size, when it was made, the model note, too big to save', () => {
  const rows = M.resultRows(view([
    res({ id: '1'.repeat(32), name: 'model.joblib', kind: 'model', bytes: 4_370_000, modifiedAt: NOW - 30_000, shown: false }),
    res({ id: '2'.repeat(32), name: 'chart.png', kind: 'chart', bytes: 17_600, modifiedAt: NOW - 3 * 3600_000 }),
    res({ id: '3'.repeat(32), name: 'big.png', kind: 'chart', bytes: 3 * 2 ** 20, shown: false }),
    res({ id: '4'.repeat(32), name: 'huge.csv', kind: 'table', bytes: 101 * 2 ** 20, shown: false, tooBig: true })]), NOW);
  assert.deepEqual(rows[0], { id: '1'.repeat(32), name: 'model.joblib', facts: 'Trained model · 4.2 MB', made: 'Made just now', isModel: true, canSave: true,
    saveLabel: 'Save model.joblib', removeLabel: 'Remove model.joblib', note: null });
  assert.deepEqual([rows[1].facts, rows[1].made, rows[1].isModel], ['Chart · 17 KB', 'Made 3 hours ago', false]);
  assert.match(rows[2].note, /Too big to show here/);
  assert.deepEqual([rows[3].canSave, rows[3].note], [false, 'Too big to save from Nexus (over 100 MB).']);
  assert.equal(M.madeText(Date.UTC(2026, 9, 5, 12), NOW), 'Made on 5 Oct 2026');
  // The newest report Nexus can show, and the charts it can show (at most MAX_CHARTS).
  const v = view([res({ id: 'b'.repeat(32), name: 'notes.txt', shown: false }), res({ id: 'c'.repeat(32), name: 'report.md' }), res({ id: 'd'.repeat(32), name: 'old.md' })]);
  assert.equal(M.newestReport(v).name, 'report.md');
  assert.equal(M.newestReport(view([])), null);
  const many = view(Array.from({ length: 20 }, (_, i) => res({ id: String(i).padStart(32, '0'), name: `c${i}.png`, kind: 'chart' })));
  assert.equal(M.shownCharts(many).length, M.MAX_CHARTS);
  assert.deepEqual(M.shownCharts(view([res({ kind: 'chart', shown: false })])), []);
});

test('RU3 the report reader: headings, lists, bold, tables as fixed-width lines; tags, links and images stay plain words', () => {
  const text = ['# Who is likely to leave', '', 'We trained a **random forest** on `customers.csv`.', 'It scored well.', '', '## Key findings',
    '- Monthly plans leave **3x** more often', '* Support calls matter', '1. First', '2) Second', '', '| plan | rate |', '|---|---|', '| basic | 0.31 |', '',
    '```', 'print("x")', '```', '---', '<script>alert(1)</script> and [a link](http://evil.example) and ![img](http://evil.example/x.png)', '###### deep'].join('\n');
  const b = M.reportBlocks(text);
  assert.deepEqual(b[0], { type: 'heading', level: 1, spans: [{ text: 'Who is likely to leave', bold: false }] });
  assert.deepEqual(b[1], { type: 'paragraph', spans: [{ text: 'We trained a ', bold: false }, { text: 'random forest', bold: true }, { text: ' on customers.csv. It scored well.', bold: false }] });
  assert.deepEqual(b[2], { type: 'heading', level: 2, spans: [{ text: 'Key findings', bold: false }] });
  assert.equal(b[3].type, 'list'); assert.equal(b[3].ordered, false); assert.equal(b[3].items.length, 2);
  assert.deepEqual(b[3].items[0], [{ text: 'Monthly plans leave ', bold: false }, { text: '3x', bold: true }, { text: ' more often', bold: false }]);
  assert.deepEqual([b[4].type, b[4].ordered, b[4].items.length], ['list', true, 2]);
  assert.deepEqual(b[5], { type: 'pre', text: '| plan | rate |\n|---|---|\n| basic | 0.31 |' });
  assert.deepEqual(b[6], { type: 'pre', text: 'print("x")' });
  assert.deepEqual(b[7], { type: 'paragraph', spans: [{ text: '<script>alert(1)</script> and a link and img', bold: false }] }, 'tags are letters; a link and an image keep only their words');
  assert.deepEqual(b[8], { type: 'heading', level: 3, spans: [{ text: 'deep', bold: false }] });
  assert.ok(JSON.stringify(b).indexOf('http') < 0, 'no address survives');
  assert.deepEqual(M.reportBlocks(''), []);
  assert.ok(M.reportBlocks('x\n\n'.repeat(5000)).length <= M.MAX_REPORT_BLOCKS);
});

test('RU4 a hostile report, rendered by the real component, comes out as escaped text: no tag, no handler, no link, no raw HTML', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { Report } = loadResultsTsx();
  const hostile = ['# <img src=x onerror=alert(1)>', '<script>alert(2)</script>', '- **<b onclick="x()">bold</b>**', '[click](javascript:alert(3))',
    '<iframe src="http://evil.example"></iframe>', '| <svg onload=alert(4)> |'].join('\n\n');
  const html = renderToStaticMarkup(React.createElement(Report, { blocks: M.reportBlocks(hostile) }));
  // Every element in the output is one the reader makes (div, h3-h5, p, ul, ol, li, b, span, pre), with a class attribute at most.
  const tags = [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)];
  assert.ok(tags.length > 5);
  for (const t of tags) {
    assert.match(t[1], /^(div|h3|h4|h5|p|ul|ol|li|b|span|pre)$/, t[0]);
    assert.match(t[2], /^(\s+class="[a-z0-9_ -]+")?$/, t[0]);
  }
  assert.doesNotMatch(html, /<script|<img|<iframe|<svg|<a\b|href=|src=["']/i, html);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(html, /<h3 class="nx-results__h nx-results__h--1">/);
  assert.match(html, /<b>&lt;b onclick=&quot;x\(\)&quot;&gt;bold&lt;\/b&gt;<\/b>/, 'bold is the one element the reader makes; its words stay text');
});

test('RU5 failures read as plain sentences; anything else in general words', () => {
  for (const reason of Object.keys(RESULT_REASON_MESSAGES)) assert.equal(M.resultsFailureText({ code: 'invalid', reason, message: 'ignored' }), RESULT_REASON_MESSAGES[reason], reason);
  assert.equal(M.resultsFailureText({ code: 'platform_unavailable', reason: 'execution_unavailable' }), M.NOT_READY_LINE);
  assert.equal(M.resultsFailureText({ code: 'internal', message: 'C:/Users/x/boom' }), M.GENERIC_FAILURE, 'never a raw message');
});

test('RU6 the wiring: only for a Machine learning project, never a location or HTML, refreshed when a job changes, mounted after "Your data"', () => {
  const ui = read('src/renderer/src/nexus/project/Results.tsx');
  assert.match(ui, /if \(!view \|\| !view\.applies\) return null;/, 'nothing for any other project');
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|innerHTML|__html|createContextualFragment|DOMParser|srcDoc|<iframe|<a\s|href=/, 'the report is never HTML');
  assert.doesNotMatch(ui, /path|showSaveDialog|showOpenDialog|<input[^>]*type="file"|FileReader|webUtils|download=/i, 'no location: main opens its own Save window');
  for (const op of ['list', 'read', 'save', 'remove', 'clear']) assert.match(ui, new RegExp(`nexusClient\\.results\\(\\{ op: '${op}', projectId`), op);
  assert.match(ui, /useHints\(\);\s+const jobsTick = useExecStore\(\(s\) => s\.ticks\.jobs\);/, 'one shared hint subscription; the jobs tick');
  assert.match(ui, /\}, \[projectId, jobsTick\]\);/, 'listed again whenever a job changes (an AI helper turn finishing)');
  assert.match(ui, /dataUrl\.startsWith\('data:image\/png;base64,'\)/, 'an image is only ever a PNG data URL main sent');
  assert.match(ui, /<img src=\{url\} alt=\{`Chart: \$\{c\.name\}`\} \/>/);
  assert.match(ui, /\{d\.isModel && <span className="nx-muted nx-results__model">\{MODEL_NOTE\}<\/span>\}/);
  assert.match(ui, /<p className="nx-muted nx-results__note">\{STAYS_LINE\}<\/p>/);
  const bench = read('src/renderer/src/nexus/project/ProjectBench.tsx');
  assert.ok(bench.indexOf('<YourData projectId={project.id} />') < bench.indexOf('<Results projectId={project.id} />'), 'after "Your data"');
  const client = read('src/renderer/src/nexus/data/nexusClient.ts');
  assert.match(client, /results: \(args: ResultsArgs\): Promise<NexusResult<ResultsView>> => execCall\(\(\) => window\.cth\.nexusResults\(args\)\)/);
  const ipc = read('src/shared/nexus/ipc.ts');
  const argsType = ipc.slice(ipc.indexOf('export type ResultsArgs'), ipc.indexOf('/**', ipc.indexOf('export type ResultsArgs')));
  assert.deepEqual([...new Set([...argsType.matchAll(/\b([A-Za-z]+)\??:\s/g)].map((m) => m[1]))].sort(), ['op', 'projectId', 'resultId'], 'ids and a choice only');
  // The views name no host, path, folder, model id or token (the SC9 rule, over these views and the content union).
  const sf = ts.createSourceFile('ipc.ts', ipc, ts.ScriptTarget.Latest, true);
  const BANNED = /(?:^|[a-z])(?:host|hosts|model|models|token|bearer|path|paths|dir|folder|pid|container|principal|file)(?:Id|Ids|Name)?$/i;
  const names = [];
  const visit = (n) => { if (ts.isPropertySignature(n) && n.name) names.push(n.name.getText(sf)); ts.forEachChild(n, visit); };
  for (const s of sf.statements) {
    if ((ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && ['ResultView', 'ResultsView', 'ResultContentView', 'ResultsArgs'].includes(s.name.text)) visit(s);
  }
  assert.ok(names.length >= 20, names.join(','));
  assert.deepEqual(names.filter((n) => BANNED.test(n)), []);
});

test('RU7 the new renderer files hold no card, dashboard, gradient or percentage words, no peer import; the CSS uses existing tokens only', () => {
  const { copyItems, scanText } = require('./helpers/identityGuard.cjs');
  const NEXUS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
  for (const f of ['project/Results.tsx', 'project/resultsModel.ts']) {
    const s = fs.readFileSync(path.join(NEXUS, f), 'utf8');
    assert.doesNotMatch(s, /\bcards?\b|-card\b|Card\b|dashboard|gradient/i, f);
    assert.doesNotMatch(s, /routes\/RouteView|WelcomePage|hairline|state\/uiStore|start\/Start/, `${f}: no peer import`);
    for (const it of copyItems(path.join(NEXUS, f))) {
      assert.deepEqual(scanText(it.text, true), [], `${f}: ${it.text}`);
      assert.doesNotMatch(it.text, /\d\s*%|^%|percent/i, `${f}: ${it.text}`);
    }
  }
  const css = read('src/renderer/src/nexus/styles/execution.css');
  const tokens = read('src/renderer/src/nexus/styles/tokens.css');
  const block = css.slice(css.indexOf('/* "Results"'), css.indexOf('/* The setup sheet'));
  assert.ok(block.length > 200, 'the Results styles are there');
  for (const v of new Set(block.match(/var\(--nx-[a-z0-9-]+\)/g) || [])) assert.ok(tokens.includes(`${v.slice(4, -1)}:`), v);
  assert.doesNotMatch(block, /card|gradient/i);
  // The one fixed colour: a chart keeps the white it was drawn on, in both themes (its labels stay readable).
  assert.deepEqual(block.match(/#[0-9a-fA-F]{3,6}\b/g), ['#fff']);
});
