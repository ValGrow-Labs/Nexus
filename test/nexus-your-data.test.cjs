'use strict';
// "Your data" in a Machine learning project's work area (phase 2: upload and delivery), the renderer side. Plain node: the model's words
// and rows, the failure sentences, the request box placeholder, and source pins of the wiring (no location ever crosses; only an ML project).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/renderer/src/nexus/project/yourDataModel.ts');
const { intentWords, DATA_REQUEST_PLACEHOLDER } = loadTs('src/renderer/src/nexus/agent/agentModel.ts');
const { DATASET_REASON_MESSAGES } = loadTs('src/shared/nexus/datasets.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const view = (datasets) => ({ applies: true, datasets, damaged: false, aiOnThisComputer: false });
const ds = (o = {}) => ({ id: '01K7A0J0B000000000000000AA', name: 'customers.csv', type: 'csv', bytes: 1_300_000, rows: 10000, columns: 9, addedAt: NOW - 5 * 60_000, ...o });

test('YD1 the words: the title, the button, the empty line and the privacy sentence, exactly as agreed', () => {
  assert.equal(M.YOUR_DATA_TITLE, 'Your data');
  assert.equal(M.UPLOAD_LABEL, 'Upload a dataset');
  assert.equal(M.REMOVE_LABEL, 'Remove');
  assert.equal(M.EMPTY_LINE, 'No data yet.');
  assert.equal(M.privacyLine(false), 'Stays on this computer. The AI helper sees column names and anything its code prints.');
  assert.equal(M.privacyLine(true), 'Nothing leaves this computer.', 'when the AI service in use runs on this computer');
  assert.match(M.REMOVE_NOTE, /^Remove deletes only Nexus’s copy\.$/);
  assert.match(M.REMOVED_LINE, /original file is untouched/);
  assert.equal(DATA_REQUEST_PLACEHOLDER, 'Ask about your data, for example: which customers are likely to leave?');
  const all = [M.YOUR_DATA_TITLE, M.UPLOAD_LABEL, M.UPLOADING_LABEL, M.EMPTY_LINE, M.PRIVACY_LINE, M.PRIVACY_LINE_LOCAL, M.REMOVE_NOTE, M.DAMAGED_LINE, M.REMOVED_LINE,
    M.NOT_READY_LINE, M.GENERIC_FAILURE, M.addedLine('x.csv'), DATA_REQUEST_PLACEHOLDER, ...Object.values(DATASET_REASON_MESSAGES)].join('\n');
  assert.doesNotMatch(all, /\bcard\b|dashboard|gradient|docker|container|sandbox|mount|ml-python|pandas|manifest|upload(ed)? to|cloud|server|\/data/i, 'plain words, no tool or vendor word');
});

test('YD2 one row per file: name, kind, size, rows x columns, when it was added, and a Remove that names the file', () => {
  const rows = M.dataRows(view([ds(), ds({ id: 'B', name: 'book.xlsx', type: 'xlsx', bytes: 4096, rows: null, columns: null, addedAt: NOW - 3 * 3600_000 }),
    ds({ id: 'C', name: 'one.tsv', type: 'tsv', bytes: 10, rows: 1, columns: 1, addedAt: NOW - 30_000 })]), NOW);
  assert.deepEqual(rows[0], { id: '01K7A0J0B000000000000000AA', name: 'customers.csv', facts: 'CSV · 1.2 MB · 10,000 rows × 9 columns', added: 'Added 5 minutes ago', removeLabel: 'Remove customers.csv' });
  assert.deepEqual([rows[1].facts, rows[1].added], ['Excel · 4.0 KB', 'Added 3 hours ago']);
  assert.deepEqual([rows[2].facts, rows[2].added], ['TSV · 10 bytes · 1 row × 1 column', 'Added just now']);
  assert.equal(M.addedText(Date.UTC(2026, 9, 5, 12), NOW), 'Added on 5 Oct 2026');
  assert.equal(M.shapeText({ rows: 7, columns: null }), '7 rows');
  assert.deepEqual(M.dataRows(view([]), NOW), []);
});

test('YD3 failures read as plain sentences: too big, wrong kind, too many files, could not read it; anything else in general words', () => {
  for (const reason of ['dataset_too_big', 'dataset_type', 'dataset_content', 'dataset_too_many', 'dataset_total', 'dataset_unreadable', 'dataset_link', 'dataset_busy', 'dataset_rate']) {
    assert.equal(M.dataFailureText({ code: 'invalid', reason, message: 'ignored' }), DATASET_REASON_MESSAGES[reason], reason);
  }
  assert.match(DATASET_REASON_MESSAGES.dataset_too_big, /larger than 200 MB/);
  assert.match(DATASET_REASON_MESSAGES.dataset_type, /CSV, TSV, text table, Excel, JSON or Parquet/);
  assert.match(DATASET_REASON_MESSAGES.dataset_too_many, /20 files/);
  assert.match(DATASET_REASON_MESSAGES.dataset_unreadable, /could not read that file/);
  assert.equal(M.dataFailureText({ code: 'platform_unavailable', reason: 'execution_unavailable' }), M.NOT_READY_LINE);
  assert.equal(M.dataFailureText({ code: 'internal', message: 'C:\\Users\\x\\boom' }), M.GENERIC_FAILURE, 'never a raw message');
});

test('YD4 the request box asks about the data only in a project with data, only when it goes to the project\'s AI helper', () => {
  const lead = { state: 'ready' };
  assert.equal(intentWords({ mode: 'agent', lead, onSoftwareProject: false, hasData: true }).placeholder, DATA_REQUEST_PLACEHOLDER);
  assert.equal(intentWords({ mode: 'agent', lead, onSoftwareProject: false }).placeholder, 'Describe the change you want');
  assert.equal(intentWords({ mode: 'agent', lead, onSoftwareProject: false, hasData: false }).placeholder, 'Describe the change you want');
  assert.equal(intentWords({ mode: 'legacy', lead, onSoftwareProject: false, hasData: true }).placeholder, 'Ask the lead AI helper to plan, build or fix something');
  const store = M.useProjectData;
  store.getState().set('p1', 2);
  assert.equal(store.getState().counts.p1, 2);
  const before = store.getState();
  store.getState().set('p1', 2);
  assert.equal(store.getState(), before, 'an unchanged count does not redraw');
  const line = read('src/renderer/src/nexus/intent/IntentLine.tsx');
  assert.match(line, /useProjectData\(\(st\) => \(ctx\.project \? st\.counts\[ctx\.project\.id\] \?\? 0 : 0\)\)/);
  assert.match(line, /hasData: !lockedBox && dataCount > 0/);
});

test('YD5 the wiring: shown only for a Machine learning project (main\'s answer), the renderer never sends or receives a location, mounted in the work area', () => {
  const ui = read('src/renderer/src/nexus/project/YourData.tsx');
  assert.match(ui, /if \(!view \|\| !view\.applies\) return null;/, 'nothing for any other project');
  assert.match(ui, /nexusClient\.datasets\(\{ op: 'list', projectId \}\)/);
  assert.match(ui, /nexusClient\.datasets\(\{ op: 'add', projectId \}\)/);
  assert.match(ui, /nexusClient\.datasets\(\{ op: 'remove', projectId, datasetId \}\)/);
  assert.doesNotMatch(ui, /path|showOpenDialog|<input[^>]*type="file"|FileReader|webUtils/i, 'no location, no file input: main opens its own window');
  assert.match(ui, /privacyLine\(view\.aiOnThisComputer\)/);
  const bench = read('src/renderer/src/nexus/project/ProjectBench.tsx');
  assert.match(bench, /<YourData projectId=\{project\.id\} \/>/);
  const client = read('src/renderer/src/nexus/data/nexusClient.ts');
  assert.match(client, /datasets: \(args: DatasetsArgs\): Promise<NexusResult<DatasetsView>> => execCall\(\(\) => window\.cth\.nexusDatasets\(args\)\)/);
  const ipc = read('src/shared/nexus/ipc.ts');
  const args = ipc.match(/export type DatasetsArgs = [^\n]*/)[0];
  assert.deepEqual([...new Set([...args.matchAll(/\b([A-Za-z]+)\??:\s/g)].map((m) => m[1]))].sort(), ['datasetId', 'op', 'projectId'], 'ids and a choice only');
  const viewType = ipc.slice(ipc.indexOf('export interface DatasetView'), ipc.indexOf('/**', ipc.indexOf('export interface DatasetView')));
  assert.doesNotMatch(viewType, /path|file\b|folder|sha|columnNames/i, 'no location, no stored name, no hash, no column name reaches the renderer');
});
