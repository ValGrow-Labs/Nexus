'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the platform runs on the store connection and startup is idempotent', () => {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const nx = createNexusPlatform(s.platformDatabase(), { now: () => h.NOW });
  assert.deepEqual(nx.startup(), { catalogAdded: 0, primaries: { set: 0, cleared: 0 }, sessions: { interrupted: 0 }, jobs: { interrupted: 0, requeued: 0 } });
  assert.deepEqual(nx.startup(), { catalogAdded: 0, primaries: { set: 0, cleared: 0 }, sessions: { interrupted: 0 }, jobs: { interrupted: 0, requeued: 0 } });
  s.close();
});
test('no platform below v7: platformDatabase is null and Phase A keeps working', () => {
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, holdV7: true });
  assert.equal(s.platformAvailable, false); assert.equal(s.platformDatabase(), null);
  assert.equal(s.listProjects().length, 5); assert.equal(s.hasPlatformRecords('p-ledger'), false);
  s.setKv('x', 1); assert.equal(s.getKv('x'), 1);
  s.close();
});
test('main wiring: no IPC channel outside nexus:*, the nexus:* channels only through registerNexusIpc, the principal never from the renderer', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /createNexusPlatform\(/);
  // 'session:resolveCwd' is the pre-Nexus agent-transcript channel (already at e1fd80f); it is the one
  // exemption, pinned to exactly one handler and one preload call so nothing else hides behind it.
  const preload = read('src/preload/index.ts');
  // Every quote style and every registration form counts, so a second handler cannot hide behind another spelling.
  assert.equal((idx.match(/ipcMain\.(handle|handleOnce|on|once)\(\s*['"`]session:resolveCwd['"`]/g) || []).length, 1);
  assert.equal((idx.match(/['"`]session:resolveCwd['"`]/g) || []).length, 1);
  assert.equal((preload.match(/['"`]session:resolveCwd['"`]/g) || []).length, 1);
  assert.doesNotMatch(idx, /ipcMain\.(handle|handleOnce|on|once)\(\s*['"`](nexus|platform|artifact|lineage|job|session(?!:resolveCwd['"`])|activity)[:.]/);
  // B1 Task 6: the preload now carries the nexus:* family (pinned exactly in the next test). Outside its literals the old ban holds.
  const preloadOutsideNexus = preload.replace(/(['"`])nexus:[A-Za-z:]+\1/g, "''");
  assert.doesNotMatch(preloadOutsideNexus, /nexus:|platform:|artifact:|lineage:|session:(?!resolveCwd['"`])/);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src/main/nexus'), { recursive: true }).filter((x) => String(x).endsWith('.ts')))
    assert.doesNotMatch(read(path.join('src/main/nexus', String(f))), /ipcMain|ipcRenderer|webContents/, String(f));
});
// B1 Task 6: the nexus:* family. The exact channel list, the exact preload methods, one registration call in main,
// every handler through the one wrapper, and no identity read from request arguments.
const NEXUS_CHANNEL_LIST = [
  'nexus:participations:list', 'nexus:participation:attach', 'nexus:participation:withdraw',
  'nexus:artifacts:list', 'nexus:artifacts:byProject', 'nexus:artifact:get', 'nexus:version:get', 'nexus:lineage:get',
  'nexus:artifact:saveCommit', 'nexus:artifact:saveTextFile', 'nexus:version:markReady', 'nexus:version:promote',
  'nexus:version:discard', 'nexus:version:linkSources',
  'nexus:handoffs:list', 'nexus:handoff:get', 'nexus:handoff:send', 'nexus:handoff:accept', 'nexus:handoff:decline', 'nexus:handoff:withdraw',
  'nexus:activity:byProject',
  // B2a Task 13 (pinned-test extension): the twenty execution channels #22-#41.
  'nexus:domains:list', 'nexus:platform:health', 'nexus:actions:available', 'nexus:job:start', 'nexus:jobs:list', 'nexus:job:get',
  'nexus:job:logs', 'nexus:job:cancel', 'nexus:job:retry', 'nexus:events:since', 'nexus:version:validations', 'nexus:version:revalidate',
  'nexus:version:preview', 'nexus:artifact:saveInline', 'nexus:deployments:list', 'nexus:deployment:stop', 'nexus:approvals:list',
  'nexus:approval:respond', 'nexus:setup:prepareImage', 'nexus:blobs:gc'
];
// B2a Task 13 (pinned-test extension): the one push of the family, main -> renderer.
const NEXUS_PUSH = ['nexus:hint'];
// Task 7: every channel is registered and exposed (the read channels came in Task 6, the writes in Task 7).
const NEXUS_REGISTERED = [...NEXUS_CHANNEL_LIST];
const NEXUS_PRELOAD_METHODS = [
  'nexusParticipationsList', 'nexusParticipationAttach', 'nexusParticipationWithdraw',
  'nexusArtifactsList', 'nexusArtifactsByProject', 'nexusArtifactGet', 'nexusVersionGet', 'nexusLineageGet',
  'nexusArtifactSaveCommit', 'nexusArtifactSaveTextFile', 'nexusVersionMarkReady', 'nexusVersionPromote',
  'nexusVersionDiscard', 'nexusVersionLinkSources',
  'nexusHandoffsList', 'nexusHandoffGet', 'nexusHandoffSend', 'nexusHandoffAccept', 'nexusHandoffDecline', 'nexusHandoffWithdraw',
  'nexusActivityByProject',
  // B2a Task 13 (pinned-test extension).
  'nexusDomainsList', 'nexusPlatformHealth', 'nexusActionsAvailable', 'nexusJobStart', 'nexusJobsList', 'nexusJobGet',
  'nexusJobLogs', 'nexusJobCancel', 'nexusJobRetry', 'nexusEventsSince', 'nexusVersionValidations', 'nexusVersionRevalidate',
  'nexusVersionPreview', 'nexusArtifactSaveInline', 'nexusDeploymentsList', 'nexusDeploymentStop', 'nexusApprovalsList',
  'nexusApprovalRespond', 'nexusSetupPrepareImage', 'nexusBlobsGc'
];
const literals = (text) => new Set((text.match(/['"`]nexus:[A-Za-z:]+['"`]/g) || []).map((x) => x.slice(1, -1)));
const sorted = (xs) => [...xs].sort();
const walkTs = (dir) => fs.readdirSync(path.join(__dirname, '..', dir), { recursive: true }).map(String).filter((x) => x.endsWith('.ts')).map((x) => path.join(dir, x));

test('nexus:* channels: one module, the exact list, the exact preload surface', () => {
  const idx = read('src/main/index.ts');
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  const preload = read('src/preload/index.ts');
  // index.ts registers no nexus:* handler inline and calls registerNexusIpc exactly once, with ipcMain.
  assert.equal(literals(idx).size, 0, 'no nexus: literal in index.ts');
  assert.equal((idx.match(/registerNexusIpc\(/g) || []).length, 1);
  assert.match(idx, /registerNexusIpc\(ipcMain, \{/);
  assert.match(idx, /unavailableReason: \(\) => nexusUnavailableReason/);
  assert.match(idx, /handoffsUnavailableReason: \(\) => handoffsUnavailableReason/);
  // The module's literals are NEXUS_CHANNELS (B1, 21) and NEXUS_EXEC_CHANNELS (B2a, 20), which are the literal list
  // here, plus the one push (B2a Task 13 pinned-test extension: literals(mod) == NEXUS_CHANNEL_LIST + NEXUS_PUSH).
  const { NEXUS_CHANNELS, NEXUS_EXEC_CHANNELS, NEXUS_ALL_CHANNELS, registerNexusIpc } = loadTs('src/main/nexusIpc/registerNexusIpc.ts');
  assert.deepEqual([...NEXUS_CHANNELS, ...NEXUS_EXEC_CHANNELS], NEXUS_CHANNEL_LIST);
  assert.deepEqual([...NEXUS_ALL_CHANNELS], NEXUS_CHANNEL_LIST);
  assert.deepEqual(sorted(literals(mod)), sorted([...NEXUS_CHANNEL_LIST, ...NEXUS_PUSH]));
  // The channels actually registered (a fake registrar, with main's execution deps) equal the preload's literals and the full list (41).
  const registered = [];
  registerNexusIpc({ handle: (c) => registered.push(c) }, { platform: () => null, unavailableReason: () => 'not_open',
    sources: { projectRoot: async () => null, readFile: async () => ({ error: 'not_found' }), resolveCommit: async () => ({ error: 'not_a_commit' }) },
    log: () => {}, executionUnavailableReason: () => null });
  assert.deepEqual(sorted(registered), sorted(NEXUS_REGISTERED));
  assert.deepEqual(sorted(literals(preload)), sorted([...NEXUS_REGISTERED, ...NEXUS_PUSH]));
  for (const c of registered) assert.ok(NEXUS_CHANNEL_LIST.includes(c), c);
  // The exact preload methods, each invoking its own channel once.
  const methods = (preload.match(/^\s{2}(nexus[A-Z][A-Za-z]*):/gm) || []).map((x) => x.trim().slice(0, -1));
  assert.deepEqual(methods, NEXUS_PRELOAD_METHODS);
  // B2a Task 13 (pinned-test extension): one more, exactly one ipcRenderer.on of the hint push.
  assert.equal((preload.match(/ipcRenderer\.(invoke|send|sendSync|on)\(\s*['"`]nexus:/g) || []).length, NEXUS_REGISTERED.length + 1);
  assert.equal((preload.match(/ipcRenderer\.on\(\s*['"`]nexus:/g) || []).length, 1);
  assert.equal((preload.match(/ipcRenderer\.on\('nexus:hint'/g) || []).length, 1);
  assert.equal((preload.match(/ipcRenderer\.invoke\(\s*['"`]nexus:/g) || []).length, NEXUS_REGISTERED.length);
  assert.match(preload, /^import type \{[^}]*NexusResult[^}]*\} from '\.\.\/shared\/nexus\/ipc';/m);
  // No nexus: literal anywhere else under src/main.
  for (const f of walkTs('src/main')) {
    if (f.split(path.sep).join('/') === 'src/main/nexusIpc/registerNexusIpc.ts') continue;
    assert.equal(literals(read(f)).size, 0, f);
  }
});

test('nexusIpc: every registration goes through the one wrapper; no identity from request arguments', () => {
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  // Exactly one registrar.handle call, and it wraps the channel's handler.
  assert.deepEqual(mod.match(/registrar\.handle\([^;]*;/g), ['registrar.handle(channel, handler(channel, parse, run));']);
  assert.equal((mod.match(/\bipcMain\b/g) || []).length, 0, 'the module takes a registrar, never ipcMain itself');
  // The principal is resolved once, in the wrapper, as the local user; no other resolver is used.
  assert.equal((mod.match(/principals\.localUser\(\)/g) || []).length, 1);
  assert.match(mod, /const me = nx\.principals\.localUser\(\);/);
  assert.doesNotMatch(mod, /principals\.(system|get)\(/);
  for (const f of walkTs('src/main/nexusIpc')) {
    const text = read(f);
    // No request field names a principal, an actor or a role ...
    assert.doesNotMatch(text, /['"`](principal|principalId|actor|actorId|actorKind|role|onBehalfOf|createdBy)['"`]/, f);
    assert.doesNotMatch(text, /\b(o|a|q|f|args?\[\d\])\.(principal|principalId|actor|actorId|role|onBehalfOf)\b/, f);
  }
  // Task 7: in the handler module and the validator, no identity-shaped property is read on ANY receiver (dto.ts maps
  // stored service results and is pinned by the quoted-name ban above and the view tests instead).
  for (const f of ['src/main/nexusIpc/registerNexusIpc.ts', 'src/main/nexusIpc/validate.ts']) {
    assert.doesNotMatch(read(f), /\.(principal|principalId|actor|actorId|role|onBehalfOf)\b/, f);
  }
  assert.equal(NEXUS_REGISTERED.length, 41);
  assert.equal(NEXUS_PRELOAD_METHODS.length, 41);
  // ... and 'kind' is read from a request only as the artifact-kind filter of nexus:artifacts:list and (B2a Task 13
  // pinned-test extension) as saveInline's user-authorable kind.
  assert.deepEqual(mod.match(/\bo\.kind\b[^\n]*/g), ["o.kind === undefined ? undefined : V.artifactKind(o.kind, 'kind'),", "o.kind, 'kind'),"]);
  assert.match(mod, /kind: V\.userAuthorableKind\(o\.kind, 'kind'\),/);
  assert.equal((mod.match(/['"`]kind['"`]/g) || []).length, 4, "the 'kind' keys of the artifacts filter and of saveInline, and their field names");
  // The ban on transport inside the platform core keeps its meaning: the IPC layer lives in src/main/nexusIpc.
  for (const f of walkTs('src/main/nexus')) assert.doesNotMatch(read(f), /ipcMain|ipcRenderer|webContents/, f);
});
test('NEXUS_DB_HOLD_V7 is honoured by main', () => assert.match(read('src/main/index.ts'), /NEXUS_DB_HOLD_V7/));
test('NEXUS_DB_HOLD_V8 is honoured by main', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /holdV8: process\.env\.NEXUS_DB_HOLD_V8 === '1'/);
  assert.match(idx, /handoffs: persist\.handoffsAvailable/);
  // Inside the one persist.open call, next to the v7 hold.
  const call = idx.slice(idx.indexOf('persist.open({'), idx.indexOf('});', idx.indexOf('persist.open({')));
  assert.match(call, /holdV7: process\.env\.NEXUS_DB_HOLD_V7 === '1'/); assert.match(call, /holdV8: process\.env\.NEXUS_DB_HOLD_V8 === '1'/);
});
test('a second instance that lost the single-instance lock never opens the store', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /const gotInstanceLock = app\.requestSingleInstanceLock\(\);/);
  // The very first line of the whenReady callback returns when the lock was not obtained ...
  const m = idx.match(/app\.whenReady\(\)\.then\(\(\) => \{\r?\n([^\r\n]*)/);
  assert.ok(m, 'whenReady callback not found');
  assert.match(m[1], /^\s*if \(!gotInstanceLock\) return;/);
  assert.equal((idx.match(/app\.whenReady\(/g) || []).length, 1);
  // ... and that return comes before the store is opened.
  const ready = idx.indexOf('app.whenReady().then(');
  assert.ok(idx.indexOf('if (!gotInstanceLock) return;', ready) < idx.indexOf('persist.open(', ready));
});

// B2a Task 11 (additive): the runner utilityProcess is forked only by the runner host; the platform core stays transport-free.
test('utilityProcess appears only in src/main/nexusExec/runnerHost.ts; src/main/nexus has no utilityProcess or MessageChannelMain', () => {
  for (const f of walkTs('src/main')) {
    if (f.split(path.sep).join('/') === 'src/main/nexusExec/runnerHost.ts') continue;
    assert.doesNotMatch(read(f), /utilityProcess/, f);
  }
  assert.match(read('src/main/nexusExec/runnerHost.ts'), /utilityProcess\.fork\(/);
  for (const f of walkTs('src/main/nexus')) {
    assert.doesNotMatch(read(f), /ipcMain|ipcRenderer|webContents/, f);
    assert.doesNotMatch(read(f), /utilityProcess|MessageChannelMain/, f);
  }
});

// B2a integration (platform-core §45.3): main starts execution once, after the platform startup, and hands the IPC
// layer its execution deps.
test('index.ts starts execution exactly once, after the platform startup, and hands the IPC layer its execution deps', () => {
  const idx = read('src/main/index.ts');
  assert.equal((idx.match(/startExecution\(/g) || []).length, 1);
  assert.ok(idx.indexOf('startExecution(') > idx.indexOf('nexusPlatform?.startup();'));
  assert.match(idx, /executionUnavailableReason: \(\) => executionUnavailableReason/);
  assert.match(idx, /exec: \(\) => nexusExecution/);
  assert.match(idx, /isRepository: repositoryCheck/);
  assert.match(idx, /execution: persist\.executionAvailable/);
});
test('teardownAndQuit stops execution (bounded) before it closes the store', () => {
  const idx = read('src/main/index.ts');
  const fn = idx.slice(idx.indexOf('function teardownAndQuit('), idx.indexOf("ipcMain.handle('app:confirmClose'"));
  assert.ok(fn.indexOf('h.stop()') !== -1, 'teardownAndQuit stops execution');
  assert.ok(fn.indexOf('try { persist.close(); }') !== -1);
  assert.ok(fn.indexOf('h.stop()') < fn.indexOf('try { persist.close(); }'), 'execution stops before persist.close()');
  assert.match(fn, /setTimeout\(resolve, 10_000\)/);
});
test('NEXUS_DB_HOLD_V9 is honoured by main', () => {
  const idx = read('src/main/index.ts');
  const call = idx.slice(idx.indexOf('persist.open({'), idx.indexOf('});', idx.indexOf('persist.open({')));
  assert.match(call, /holdV9: process\.env\.NEXUS_DB_HOLD_V9 === '1'/);
});
test('main enables v9 only through NEXUS_ENABLE_V9 and never passes an explicit enableV9: false (ruling F1)', () => {
  const idx = read('src/main/index.ts');
  const call = idx.slice(idx.indexOf('persist.open({'), idx.indexOf('});', idx.indexOf('persist.open({')));
  assert.match(call, /enableV9: process\.env\.NEXUS_ENABLE_V9 === '1' \? true : undefined/);
  assert.doesNotMatch(idx, /enableV9:\s*false/);
});
// B2b Task 3 (PC-10): v10 is opt-in. main enables it only through NEXUS_ENABLE_V10, never passes an explicit
// enableV10 (true or false) any other way, honours NEXUS_DB_HOLD_V10 inside the one persist.open call, and the store's
// default stays off.
test('PC-10 main enables v10 only through NEXUS_ENABLE_V10, honours NEXUS_DB_HOLD_V10, and the v10 default stays off', () => {
  const idx = read('src/main/index.ts');
  const call = idx.slice(idx.indexOf('persist.open({'), idx.indexOf('});', idx.indexOf('persist.open({')));
  assert.match(call, /holdV10: process\.env\.NEXUS_DB_HOLD_V10 === '1'/);
  assert.match(call, /enableV10: process\.env\.NEXUS_ENABLE_V10 === '1' \? true : undefined/);
  assert.equal((idx.match(/enableV10:/g) || []).length, 1, 'one enableV10 key in main, the env-gated one');
  assert.doesNotMatch(idx, /enableV10:\s*(false|true)\b/);
  assert.equal((idx.match(/persist\.open\(/g) || []).length, 1);
  // No other main module turns v10 on.
  for (const f of walkTs('src/main')) {
    if (f.split(path.sep).join('/') === 'src/main/index.ts') continue;
    assert.doesNotMatch(read(f), /enableV10:\s*true\b/, f);
  }
  const db = loadTs('src/main/db.ts');
  assert.equal(db.V10_ENABLED_BY_DEFAULT, false);
  assert.equal(db.V9_ENABLED_BY_DEFAULT, false);
  assert.match(read('src/main/db.ts'), /^export const V10_ENABLED_BY_DEFAULT = false;\r?$/m);
  // Opened with no v10 option, a v9 store stays at v9 with agents not_enabled.
  const { file } = h.v6Fixture(); const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, enableV9: true });
  assert.equal(s.schemaVersion, 9); assert.equal(s.agentsAvailable, false); assert.equal(s.agentsUnavailableReason, 'not_enabled');
  s.close();
});
