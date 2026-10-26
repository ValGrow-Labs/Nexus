'use strict';
// Task 10 review carry-over (Task 11): caller-path validation for handlers that
// take a filesystem path, and normalised URLs for shell.openExternal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const skills = loadTs('src/main/skills.ts');
const wp = loadTs('src/main/windowPolicy.ts');

const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
const handler = (channel) => {
  const start = idx.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start >= 0, channel);
  const next = idx.indexOf('ipcMain.handle(', start + 10);
  return idx.slice(start, next < 0 ? undefined : next);
};

test('externalUrlForShell hands the shell the normalised href of allowed URLs only', () => {
  assert.equal(wp.externalUrlForShell('https://github.com/a b'), 'https://github.com/a%20b');
  assert.equal(wp.externalUrlForShell('HTTPS://GitHub.com/x'), 'https://github.com/x');
  assert.equal(wp.externalUrlForShell('http://localhost:3000'), 'http://localhost:3000/');
  assert.equal(wp.externalUrlForShell('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'),
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  for (const u of ['http://example.com', 'file:///C:/x', 'javascript:alert(1)', 'https://user@github.com/', '', null, 3])
    assert.equal(wp.externalUrlForShell(u), null, String(u));
});

test('index.ts never hands the shell a raw URL string', () => {
  assert.doesNotMatch(idx, /shell\.openExternal\(url\)/);
  assert.match(idx, /function openExternalNormalised[\s\S]{0,200}externalUrlForShell\(url\)[\s\S]{0,80}shell\.openExternal\(href\)/);
  assert.match(handler('app:openExternal'), /externalUrlForShell\(url\)[\s\S]*shell\.openExternal\(href\)/);
});

test('every git handler checks its cwd against the known roots', () => {
  const channels = ['git:isRepo', 'git:mainRepo', 'git:branch', 'git:status', 'git:log', 'git:branches', 'git:aheadBehind', 'git:diff',
    'git:logGraph', 'git:commitFiles', 'git:showFile', 'git:compareRefs', 'git:worktrees', 'git:checkout'];
  for (const c of channels) assert.match(handler(c), /acceptGitCwd\(cwd\)/, c);
  assert.match(handler('git:mainRepo'), /gitDerivedRoots\.add\(root\)/);
  const gitHandlers = idx.match(/ipcMain\.handle\('git:[A-Za-z]+'/g) ?? [];
  assert.equal(gitHandlers.length, channels.length, 'a new git handler must be validated too');
});

test('fs:statAbs, kg:ingestFiles, hive:agentUsage and github:* check their paths', () => {
  assert.match(handler('fs:statAbs'), /acceptFsRoot\(target\)[\s\S]*error: FS_ROOT_REFUSED/);
  assert.match(handler('kg:ingestFiles'), /acceptFsRoot\(srcPath\)[\s\S]*error: FS_ROOT_REFUSED/);
  assert.match(handler('hive:agentUsage'), /acceptFsRoot\(cwd\)/);
  assert.match(handler('github:issues'), /acceptFsRoot\(cwd\)[\s\S]*FS_ROOT_REFUSED/);
  assert.match(handler('github:ciRuns'), /acceptFsRoot\(cwd\)[\s\S]*FS_ROOT_REFUSED/);
  assert.match(handler('skills:local'), /acceptFsRoot\(own\)/);
  assert.match(handler('skills:uninstall'), /uninstallSkill\(path, \{ cwds: allowedFsRoots\(\) \}\)/);
  assert.match(handler('skills:reveal'), /isManagedSkillPath\(target, allowedFsRoots\(\)/);
});

test('user-chosen folders stay unrestricted by design, with a comment saying so', () => {
  assert.match(handler('pty:spawn'), /cwd is deliberately NOT restricted/);
  assert.match(handler('terminal:openAtFolder'), /Deliberately not restricted to known roots/);
  assert.match(handler('project:import'), /Deliberately not restricted to known roots/);
});

test('the terminal opens the preview for a refused path so the error is shown', () => {
  const pool = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/terminalPool.ts'), 'utf8');
  assert.match(pool, /if \(res\.error && res\.path\) \{\s*storeApi\?\.getState\(\)\.setFullscreenFile\(res\.path, 'preview'\)/);
});

test('managedSkillRoots: user homes plus the skill folders of each known root', () => {
  const home = path.resolve('/home/u');
  const roots = skills.managedSkillRoots([path.resolve('/w/proj'), '', null], home);
  assert.deepEqual(roots, [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.config', 'opencode', 'plugin'),
    path.join(home, '.codex', 'plugins'),
    path.resolve('/w/proj/.claude/skills'),
    path.resolve('/w/proj/.opencode/plugin')
  ]);
});

test('isManagedSkillPath: entries inside a skills root only, never the root or outside', () => {
  const home = path.resolve('/home/u');
  const proj = path.resolve('/w/proj');
  const bundled = path.resolve('/app/resources/skills');
  const yes = [
    path.join(home, '.claude', 'skills', 'docx'),
    path.join(home, '.codex', 'plugins', 'p.js'),
    path.join(proj, '.claude', 'skills', 'demo'),
    path.join(proj, '.opencode', 'plugin', 'x.js'),
    path.join(bundled, 'capabilities')
  ];
  for (const t of yes) assert.equal(skills.isManagedSkillPath(t, [proj], [bundled], home), true, t);
  const no = [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(proj, 'src', 'index.ts'),
    path.join(proj, '.claude', 'skills', '..', '..', 'src'),
    path.resolve('/w/other/.claude/skills/demo'),
    '',
    'a\0b'
  ];
  for (const t of no) assert.equal(skills.isManagedSkillPath(t, [proj], [bundled], home), false, JSON.stringify(t));
  if (process.platform === 'win32') {
    assert.equal(skills.isManagedSkillPath(path.join(proj.toUpperCase(), '.CLAUDE', 'SKILLS', 'demo'), [proj], [], home), true);
  }
});

test('uninstallSkill: a project skill under a junction that leads outside is refused', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-skill-junction-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const proj = path.join(tmp, 'proj');
  const outside = path.join(tmp, 'outside');
  const victim = path.join(outside, 'victim');
  fs.mkdirSync(path.join(proj, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'SKILL.md'), '---\nname: v\n---\n');
  const link = path.join(proj, '.claude', 'skills', 'evil');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('cannot create a junction here'); return; }
  const res = skills.uninstallSkill(path.join(link, 'victim'), { cwds: [proj] });
  assert.equal(res.ok, false);
  assert.ok(fs.existsSync(path.join(victim, 'SKILL.md')), 'the outside folder must survive');
});

// B1 Task 6: the nexus:* IPC layer never takes a folder from the renderer.
test('nexus sources take a project root only from the stored project row, through acceptFsRoot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/nexusIpc/sources.ts'), 'utf8');
  // One lookup of the stored row, its rootPath, and that path through acceptFsRoot: the only source of a root.
  assert.equal((src.match(/deps\.getProject\(/g) || []).length, 1);
  assert.equal((src.match(/deps\.acceptFsRoot\(/g) || []).length, 1);
  assert.match(src, /row = deps\.getProject\(projectId\);[\s\S]{0,80}const rootPath = row\?\.rootPath;[\s\S]{0,200}accepted = deps\.acceptFsRoot\(rootPath\)/);
  assert.match(idx, /createSourcePorts\(\{ acceptFsRoot, getProject: \(id\) => projectManager\.getProject\(id\) \}\)/);
});

test('no nexus:* request schema has a folder field (only relPath)', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  const validate = read('src/main/nexusIpc/validate.ts');
  // Every object schema: the key list passed to V.object(...) or optionalObject(...).
  const lists = [...mod.matchAll(/(?:V\.object|optionalObject)\([^,]+,\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(lists.length >= 4, 'the schemas were found');
  const keys = lists.flatMap((l) => [...l.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]));
  for (const k of keys) assert.ok(k === 'relPath' || !/^(root|rootPath|cwd|path|dir|folder)$|Path$|Root$|Dir$/i.test(k), k);
  for (const text of [mod, validate]) assert.doesNotMatch(text, /['"`](root|rootPath|cwd|path|folder)['"`]/);
  // A parsed request never names a root or a cwd field either.
  assert.doesNotMatch(mod, /\.(root|rootPath|cwd)\b/);
});

// B2a Task 13 (pinned-test extension): the same scan over the execution request shapes (#22-#41), and wider keys.
test('no nexus:* request schema (B1 or B2a) names a folder, file, image, network, argv, command or env; relPath only in #10', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  const validate = read('src/main/nexusIpc/validate.ts');
  const schemaLists = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
  const lists = [...schemaLists(mod, /(?:V\.object|optionalObject)\([^,]+,\s*\[([^\]]*)\]/g), ...schemaLists(validate, /V\.object\([^,]+,\s*\[([^\]]*)\]/g)];
  assert.ok(lists.length >= 18, `the B1 and B2a schemas were found (${lists.length})`);
  const keysOf = (l) => [...l.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  const banned = /^(root|rootPath|cwd|path|dir|folder|file|image|network|argv|command|env)$|Path$|Root$|Dir$|File$/i;
  for (const k of lists.flatMap(keysOf)) assert.ok(k === 'relPath' || !banned.test(k), k);
  // relPath is the one path-like key, in exactly one schema: #10 (saveTextFile).
  const withRel = lists.filter((l) => keysOf(l).includes('relPath'));
  assert.equal(withRel.length, 1);
  assert.match(mod, /reg\('nexus:artifact:saveTextFile'[\s\S]{0,200}V\.object\(args\[0\], \['projectId', 'workspaceId', 'relPath', 'target'\]/);
  // The request types the preload sends: no such key in any of them (relPath only in SaveTextFileArgs).
  const ipc = read('src/shared/nexus/ipc.ts');
  const requests = ipc.slice(ipc.indexOf('// ---------- requests'));
  const typeKeys = [...requests.matchAll(/\b([A-Za-z]+)\??:\s/g)].map((m) => m[1]);
  for (const k of typeKeys) assert.ok(k === 'relPath' || !banned.test(k), k);
  assert.equal((requests.match(/\brelPath\??:/g) || []).length, 1);
});

// B2b Task 14: the agent channels #42-#51 keep the same promise: ids and small values from the renderer, everything else in main.
test('the agent request schemas (#42-#51) name no folder, command, image, network, host, model, principal or role; each key set is exact', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  const validate = read('src/main/nexusIpc/validate.ts');
  const block = mod.slice(mod.indexOf('// ---------- B2b Task 14: the agent channels #42-#51'));
  assert.ok(block.length > 2000);
  const lists = [...block.matchAll(/V\.object\([^,]+,\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.equal(lists.length, 5, `the agent schemas were found (${lists.length})`);
  const keysOf = (l) => [...l.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  const banned = /^(root|rootPath|cwd|path|dir|folder|file|image|network|argv|command|env|host|hosts|hostname|url|proxy|model|modelId|provider|runtime|principal|principalId|actor|actorId|role|token|secret|worktree)$|Path$|Root$|Dir$|File$/i;
  for (const k of [...lists.flatMap(keysOf), ...[...validate.matchAll(/CONSENT_CAP_KEYS = \[([^\]]*)\]/g)].flatMap((m) => keysOf(m[1]))]) assert.ok(!banned.test(k), k);
  assert.deepEqual(lists.map(keysOf).sort(), [
    ['decision', 'comment'], ['op', 'caps'], ['branch', 'expectedAcceptedHead'], ['projectId', 'statuses'],
    ['projectId', 'workspaceId', 'sessionId', 'skillId', 'focusVersionIds', 'message', 'intentId']
  ].sort());
  // The one place a destination enters a consent is the runtime probe's cache, never a request field.
  assert.match(block, /nx\.budget!\.grant\(me, \{ runtimeKind: seen\.kind, hosts, caps: q\.caps \}\)/);
  assert.match(block, /const hosts = probe\?\.cache\.egressHosts\(\) \?\? null;/);
  assert.doesNotMatch(block, /\b(o|q|a)\.hosts?\b/);
  // The request types the preload sends (B2b part): the same ban.
  const ipc = read('src/shared/nexus/ipc.ts');
  const b2b = ipc.slice(ipc.indexOf('// ---------- B2b requests'));
  assert.ok(b2b.length > 300);
  for (const k of [...b2b.matchAll(/\b([A-Za-z]+)\??:\s/g)].map((m) => m[1])) assert.ok(!banned.test(k), k);
  // The preload takes no principal or function: each agent method forwards its ids and values and nothing else.
  const preload = read('src/preload/index.ts');
  for (const m of preload.matchAll(/^  (nexus(?:AgentStart|SessionsList|SessionGet|SessionEnd|SessionCancel|ReviewDecide|ChangeSetAccept|RepoStatus|RepoMergeAccepted|AgentConsent)):[^\n]*\n[^\n]*\n/gm)) {
    assert.doesNotMatch(m[0], /principal|actor|role|=>\s*\w+\s*\(/i, m[1]);
  }
});

test('"Merge accepted work" is confirmed only by main\'s own dialog, and only through the execution handle: one call, one dependency, Cancel by default', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  // Exactly one mergeAccepted call in all of src/main (outside the service's own definition), and its confirm is the dependency.
  const calls = [];
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src/main'), { recursive: true }).map(String).filter((x) => x.endsWith('.ts'))) {
    for (const m of read(path.join('src/main', f)).matchAll(/\.mergeAccepted\(([^;]*)\);/g)) calls.push([f.replace(/\\/g, '/'), m[0]]);
  }
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0][0], 'nexusIpc/registerNexusIpc.ts');
  assert.match(calls[0][1], /, confirmMerge\)/);
  assert.match(mod, /const confirmMerge: \(info: MergeConfirmInfo\) => Promise<boolean> = deps\.confirmMerge \?\? \(async \(\) => false\);/);
  // main wires the dependency from the execution handle and builds the dialog in one place.
  const idx = read('src/main/index.ts');
  assert.equal((idx.match(/confirmMerge: \(info\) =>/g) || []).length, 1);
  assert.match(idx, /confirmMerge: \(info\) => \(nexusExecution \? nexusExecution\.confirmMerge\(info\) : Promise\.resolve\(false\)\)/);
  assert.equal((idx.match(/mergeDialog:/g) || []).length, 1);
  assert.equal((idx.match(/showMessageBox/g) || []).length >= 2, true);
  assert.doesNotMatch(idx, /confirm(ed)?Via|\.accepts\b|mergeAccepted/);
  const wiring = read('src/main/nexusExec/execWiring.ts');
  assert.match(wiring, /async confirmMerge\(info\) \{\s*if \(!o\.mergeDialog\) return false;\s*try \{ return \(await o\.mergeDialog\(info\)\) === true;/);
  const dlg = read('src/main/nexusExec/mergeDialog.ts');
  assert.match(dlg, /defaultId: 0, cancelId: 0/);
  assert.match(dlg, /MERGE_BUTTONS = \['Cancel', 'Merge'\]/);
  // The accept service is the only place that writes `confirmedVia`, and only after an exact true.
  const svc = read('src/main/nexus/repo/acceptService.ts');
  assert.match(svc, /confirmed = \(await confirm\(this\.mergeInfo\(projectId, s, sha\)\)\) === true;/);
  assert.equal((svc.match(/mergedBy: user\.id, confirmedVia: 'dialog'/g) || []).length, 1, 'the one place the merge job is told a dialog confirmed it');
});

test('the diff preview takes its commits and folder only from the stored change set and project (never from the request)', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const svc = read('src/main/nexus/repo/acceptService.ts');
  const diff = svc.slice(svc.indexOf('async diff('), svc.indexOf('// ---------- merge accepted work'));
  assert.ok(diff.length > 500);
  assert.match(diff, /const storage = parse\(v\.storage_ref_json\); const meta = parse\(v\.metadata_json\);/);
  assert.match(diff, /typeof meta\.base === 'string'/);
  assert.match(diff, /const repoPath = this\.repoPathOf\(v\.project_id\);/);
  assert.match(diff, /read: 'diff', repoPath, base, head, maxBytesPerSide: GIT_DIFF_MAX_BYTES_PER_SIDE/);
  assert.match(diff, /redactSecretText\(r\.patch\)/);
  // The wiring hands it only the principal, the version id and nothing else.
  const wiring = read('src/main/nexusExec/execWiring.ts');
  assert.match(wiring, /await accepts\.diff\(p, versionId\)/);
});
