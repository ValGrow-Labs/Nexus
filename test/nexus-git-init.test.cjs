'use strict';
// "Set it up": git in a NEW project folder (initRepository). Real temporary folders and the real git; a private global config so the
// user's own is never touched and the identity rules can be seen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');

let G;
try { G = loadTs('src/main/git.ts'); } catch (e) { console.log('skip: git.ts needs the Electron runner:', e.message); process.exit(0); }
const hasGit = (() => { try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!hasGit) { console.log('skip: no git'); process.exit(0); }

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-init-'));
const git = (cwd, args, env = {}) => cp.execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'none');

test('GI1 a new empty folder becomes a repository on main with one empty first commit; the repository-local identity is Nexus when the user has none; the global config is never written', async () => {
  const home = tmp(); const globalCfg = path.join(home, 'gitconfig-global'); fs.writeFileSync(globalCfg, '[core]\n\tautocrlf = false\n');
  const before = sha(globalCfg);
  const env = { GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_SYSTEM: path.join(home, 'none'), HOME: home, USERPROFILE: home };
  Object.assign(process.env, env);
  const dir = tmp();
  const r = await G.initRepository(dir);
  assert.deepEqual(r, { ok: true, branch: 'main' });
  assert.equal(git(dir, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(git(dir, ['rev-list', '--count', 'HEAD']), '1');
  assert.equal(git(dir, ['log', '-1', '--format=%s']), 'Start of this project');
  assert.equal(git(dir, ['log', '-1', '--format=%an <%ae>']), 'Nexus <nexus@localhost.invalid>');
  assert.equal(git(dir, ['ls-tree', '-r', 'HEAD']), '', 'an empty commit: no files');
  assert.equal(sha(globalCfg), before, 'the global config is untouched');
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit.sample')), 'no hooks or samples are copied (empty template)');
});

test('GI2 with the user\'s own identity set, it is used and no identity is written to the repository', async () => {
  const home = tmp(); const globalCfg = path.join(home, 'gitconfig-global'); fs.writeFileSync(globalCfg, '[user]\n\tname = Ada\n\temail = ada@example.test\n');
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_SYSTEM: path.join(home, 'none'), HOME: home, USERPROFILE: home });
  const dir = tmp();
  assert.equal((await G.initRepository(dir)).ok, true);
  assert.equal(git(dir, ['log', '-1', '--format=%an <%ae>']), 'Ada <ada@example.test>');
  assert.equal(fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8').includes('Nexus'), false);
});

test('GI3 it refuses an existing repository, a folder inside one, a link, a file, a relative or missing path, and changes nothing', async () => {
  const dir = tmp(); cp.execFileSync('git', ['init', '-q', dir]);
  const marker = path.join(dir, '.git', 'HEAD'); const head = fs.readFileSync(marker, 'utf8');
  assert.deepEqual(await G.initRepository(dir), { ok: false, reason: 'already_a_repository' });
  assert.equal(fs.readFileSync(marker, 'utf8'), head);
  const sub = path.join(dir, 'sub'); fs.mkdirSync(sub);
  assert.deepEqual(await G.initRepository(sub), { ok: false, reason: 'already_a_repository' });
  assert.equal(fs.existsSync(path.join(sub, '.git')), false);
  const file = path.join(tmp(), 'f.txt'); fs.writeFileSync(file, 'x');
  assert.deepEqual(await G.initRepository(file), { ok: false, reason: 'not_a_folder' });
  assert.deepEqual(await G.initRepository('relative/path'), { ok: false, reason: 'not_absolute' });
  assert.deepEqual(await G.initRepository(path.join(tmp(), 'nope')), { ok: false, reason: 'not_a_folder' });
  const target = tmp(); const link = path.join(tmp(), 'link');
  try { fs.symlinkSync(target, link, 'junction'); assert.deepEqual(await G.initRepository(link), { ok: false, reason: 'is_link' }); assert.equal(fs.existsSync(path.join(target, '.git')), false); } catch (e) { if (e.code !== 'EPERM') throw e; }
});

test('GI4 the channel takes a project id only (main looks up the registered root); the renderer sends nothing else', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.ok(idx.includes("ipcMain.handle('git:initProject', async (_evt, projectId: unknown) => {"));
  assert.ok(idx.includes('projectManager.getProject(projectId)?.rootPath'));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.ts'), 'utf8').includes("gitInitProject: (projectId: string)"));
});
