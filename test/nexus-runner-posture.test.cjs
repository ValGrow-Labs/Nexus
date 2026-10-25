'use strict';
// B2a Task 11 posture pins for the runner (src/runner) and the execution wiring (src/main/nexusExec). Static scans
// over the source text; plain node.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const walk = (d) => !fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const ts = (dir) => walk(path.join(ROOT, dir)).filter((f) => f.endsWith('.ts'));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const read = (f) => fs.readFileSync(f, 'utf8');
/** The source without comments (a comment may name what the code must not do). */
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const RUNNER = ts('src/runner');
const WIRING = ts('src/main/nexusExec');

test('the runner and the wiring exist', () => {
  for (const f of ['src/runner/index.ts', 'src/runner/core.ts', 'src/runner/proc.ts', 'src/runner/sandbox/dockerCli.ts', 'src/runner/sandbox/dockerDriver.ts',
    'src/main/nexusExec/runnerHost.ts', 'src/main/nexusExec/execWiring.ts']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('no execSync, spawnSync, execFileSync or shell: true under src/runner and src/main/nexusExec', () => {
  for (const f of [...RUNNER, ...WIRING]) {
    const s = code(f);
    assert.doesNotMatch(s, /\b(execSync|spawnSync|execFileSync)\s*\(/, rel(f));
    assert.doesNotMatch(s, /shell\s*:\s*true/, rel(f));
    assert.doesNotMatch(s, /\bexec\s*\(\s*['"`]/, `${rel(f)}: no command string`);
  }
});

/** Relative and package imports of a TS file (static, dynamic and require). */
function importsOf(f) {
  const s = code(f);
  const out = [];
  for (const m of s.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  }
  return out;
}
function resolveRel(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}

test('src/runner reaches no database, no Electron and no main service: better-sqlite3, electron and src/main/nexus/{db,exec,...} are never imported', () => {
  const FORBIDDEN = ['db', 'exec', 'artifact', 'jobs', 'auth', 'workspace', 'lineage', 'handoff', 'validation', 'approvals', 'deployments', 'repo', 'blobs']
    .map((d) => path.join(ROOT, 'src', 'main', 'nexus', d) + path.sep);
  const seen = new Set();
  const stack = [path.join(ROOT, 'src', 'runner', 'index.ts'), ...RUNNER];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of importsOf(f)) {
      assert.notEqual(spec, 'better-sqlite3', `${rel(f)} imports better-sqlite3`);
      assert.ok(spec !== 'electron' && !spec.startsWith('electron/'), `${rel(f)} imports electron`);
      if (!spec.startsWith('.')) continue;
      const r = resolveRel(f, spec);
      assert.ok(r, `${rel(f)}: ${spec} resolves`);
      assert.ok(!FORBIDDEN.some((d) => r.startsWith(d)), `${rel(f)} reaches ${rel(r)}`);
      stack.push(r);
    }
  }
  assert.ok(seen.size >= RUNNER.length);
  // The entry uses Electron's process.parentPort only (no import); no other runner file names it.
  assert.match(read(path.join(ROOT, 'src/runner/index.ts')), /process[^;]*parentPort/);
  for (const f of RUNNER.filter((x) => !x.endsWith(`runner${path.sep}index.ts`))) assert.doesNotMatch(code(f), /parentPort|utilityProcess|MessageChannelMain/, rel(f));
});

test('nothing under src/main or src/runner spawns python, py, pip, uv or pytest', () => {
  const BAD = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(\s*['"`](python3?|py|pip3?|uv|pytest)(\.exe)?['"`]/;
  for (const f of [...ts('src/main'), ...RUNNER]) assert.doesNotMatch(code(f), BAD, rel(f));
});

test('the only programs spawned under src/runner and src/main/nexusExec are docker, git, taskkill and an agent turn\'s resolved CLI (spawn( first arguments)', () => {
  const sites = [];
  for (const f of [...RUNNER, ...WIRING]) {
    for (const m of code(f).matchAll(/\b(spawn|execFile|fork)\s*\(\s*([^,)]+)/g)) sites.push({ file: rel(f), fn: m[1], first: m[2].trim() });
  }
  // Besides docker and git (both by their RESOLVED absolute paths): the runner itself (utilityProcess.fork of
  // out/main/runner.js, pinned exactly below); `taskkill.exe` (src/runner/procTree.ts), the runner's own cleanup of an
  // agent turn's process tree, resolved to `%SystemRoot%\System32\taskkill.exe`; and an agent turn's own CLI, the ONE
  // site of the engine's executable (src/runner/runtimes/cliAgent/adapter.ts, B2b Task 13: health runs and turns alike),
  // by its resolved native executable `bin`, with the environment of `agentEnv` and nothing else (pinned below). The
  // registry spawns nothing. Never spawn('git' (Windows would run a git.exe planted in the cwd).
  assert.deepEqual(sites.map((s) => `${s.file} ${s.fn}(${s.first}`).sort(),
    ['src/runner/proc.ts spawn(gitBin', 'src/runner/proc.ts spawn(dockerBin', 'src/runner/procTree.ts spawn(taskkillBin',
      'src/runner/runtimes/cliAgent/adapter.ts spawn(bin', 'src/main/nexusExec/runnerHost.ts fork(join(__dirname'].sort());
  const { isGitBinary } = loadTs('src/main/gitBinary.ts');
  assert.equal(isGitBinary('C:\\Program Files\\Git\\cmd\\git.exe', 'win32'), true);
  for (const bad of ['git', 'git.exe', 'C:\\repo\\git.cmd', 'C:\\repo\\git.bat', 'C:\\x\\git.exe.bat']) assert.equal(isGitBinary(bad, 'win32'), false, bad);
  // The docker site launches only a path whose file name is docker / docker.exe.
  const { isDockerBinary, runDocker } = loadTs('src/runner/proc.ts');
  assert.equal(isDockerBinary('C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'), true);
  assert.equal(isDockerBinary('/usr/bin/docker'), true);
  for (const bad of ['docker', 'C:\\Windows\\System32\\cmd.exe', '/bin/sh', '/usr/bin/python3', 'C:\\x\\docker.exe.bat', '']) assert.equal(isDockerBinary(bad), false, bad);
  return assert.rejects(runDocker('/bin/sh', ['-c', 'echo'], { env: {}, timeoutMs: 1000, maxStdout: 10, maxStderr: 10 }), /only the resolved docker binary/);
});

test('the agent CLI is spawned only by cliAgent/adapter.ts, with no shell, and with an environment built from the allow-list (agentEnv), never the runner\'s own', () => {
  const adapter = code(path.join(ROOT, 'src/runner/runtimes/cliAgent/adapter.ts'));
  // The one spawn call: the resolved binary, never a shell, an explicit `env` (no inheritance), the turn's own cwd.
  assert.match(adapter, /spawn\(bin, \[\.\.\.\(this\.o\.argvPrefix \?\? \[\]\), \.\.\.args\], \{ cwd, env, windowsHide: true, shell: false, stdio: \['pipe', 'pipe', 'pipe'\] \}\)/);
  assert.equal([...adapter.matchAll(/\bspawn\s*\(/g)].length, 1, 'one spawn site');
  // `launch` is called exactly twice (a health run and a turn), each with a variable named `env` that the line above it built
  // with `mergeOverlay(agentEnv(...))`; a third launch, or one with another environment, fails here. Nothing spreads the
  // runner's environment into it.
  assert.equal([...adapter.matchAll(/\blaunch\(/g)].length, 3, 'the definition and exactly two calls');
  assert.equal([...adapter.matchAll(/this\.launch\(bin, args, env, /g)].length, 2, 'both calls pass the built `env`');
  assert.equal([...adapter.matchAll(/\benv = mergeOverlay\(agentEnv\(/g)].length, 2, 'both environments are built with agentEnv');
  assert.equal([...adapter.matchAll(/\bagentEnv\(/g)].length, 2, 'agentEnv is not called anywhere else');
  // The overlay is a test-seam name: only these files mention it, and the runner's entry never gives a runtime dependency.
  const mentions = ts('src').filter((f) => /\benvOverlay\b/.test(code(f))).map(rel).sort();
  assert.deepEqual(mentions, ['src/runner/runtimes/cliAgent/adapter.ts', 'src/runner/runtimes/cliAgent/testSeam.ts', 'src/runner/runtimes/registry.ts']);
  assert.doesNotMatch(code(path.join(ROOT, 'src/runner/index.ts')), /agentRuntime|agentEnv|agentBin|makeRuntime/);
  for (const f of ts('src/runner/runtimes')) {
    assert.doesNotMatch(code(f), /\.\.\.\s*process\.env|env\s*:\s*process\.env|shell\s*:\s*true/, rel(f));
    if (rel(f) !== 'src/runner/runtimes/cliAgent/adapter.ts') assert.doesNotMatch(code(f), /node:child_process|['"]child_process['"]/, `${rel(f)} launches nothing`);
  }
  // The builder itself: the allow-list only, the turn's proxy, no HTTP_PROXY, no inherited ANTHROPIC_*, CLAUDE_*, *_API_KEY, *_TOKEN or CA bundle.
  const { agentEnv } = loadTs('src/runner/runtimes/cliAgent/env.ts');
  const dirty = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u', APPDATA: 'C:\\a', LOCALAPPDATA: 'C:\\l', TEMP: 'C:\\t',
    ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDE_CONFIG_DIR: 'c', CLAUDE_CODE_OAUTH_TOKEN: 'o', OPENAI_API_KEY: 'k', GITHUB_TOKEN: 't', NODE_EXTRA_CA_CERTS: 'ca',
    HTTP_PROXY: 'http://x:1', HTTPS_PROXY: 'http://y:2', NO_PROXY: 'z', NEXUS_MCP_TOKEN: 'inherited', PATH: 'C:\\evil' };
  const env = agentEnv(dirty, { proxyUrl: 'http://127.0.0.1:4242', token: 'the-turn-token', tempDir: 'C:\\job\\tmp' });
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING', 'DISABLE_TELEMETRY',
    'HOMEDRIVE', 'HOMEPATH', 'HTTPS_PROXY', 'LANG', 'LOCALAPPDATA', 'NEXUS_MCP_TOKEN', 'NO_PROXY', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'windir'].sort());
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:4242');
  assert.equal(env.NO_PROXY, '127.0.0.1');
  assert.equal(env.NEXUS_MCP_TOKEN, 'the-turn-token');
  assert.ok(!env.PATH.includes('evil'));
  assert.throws(() => agentEnv(dirty, { proxyUrl: 'http://example.com:3128' }), /loopback proxy/);
  assert.throws(() => agentEnv(dirty, { proxyUrl: '' }), /loopback proxy/);
  // The binary is the native executable by its exact name, absolute, like taskkill.
  const { isAgentBinary } = loadTs('src/runner/runtimes/cliAgent/binary.ts');
  assert.equal(isAgentBinary('C:\\Users\\u\\.local\\bin\\claude.exe', 'win32'), true);
  for (const bad of ['claude.exe', 'C:\\x\\claude.cmd', 'C:\\x\\claude.exe.bat', 'C:\\Windows\\System32\\cmd.exe', '']) assert.equal(isAgentBinary(bad, 'win32'), false, bad);
});

test('utilityProcess and MessageChannelMain appear only in src/main/nexusExec/runnerHost.ts', () => {
  for (const f of [...ts('src/main'), ...RUNNER]) {
    if (rel(f) === 'src/main/nexusExec/runnerHost.ts') continue;
    assert.doesNotMatch(code(f), /\butilityProcess\b|\bMessageChannelMain\b/, rel(f));
  }
  assert.match(read(path.join(ROOT, 'src/main/nexusExec/runnerHost.ts')), /utilityProcess\.fork\(join\(__dirname, 'runner\.js'\), \[\], \{ serviceName: 'Nexus runner', stdio: 'pipe' \}\)/);
});

test('the runner\'s processes get a filtered environment: DOCKER_HOST only when set, no other host variable', () => {
  const { toolEnv } = loadTs('src/runner/proc.ts');
  const env = toolEnv({ PATH: '/bin', DOCKER_HOST: 'npipe:////./pipe/x', ANTHROPIC_API_KEY: 'sk-ant-xxx', GITHUB_TOKEN: 'ghp_x', HOME: '/h' });
  assert.equal(env.DOCKER_HOST, 'npipe:////./pipe/x');
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(toolEnv({ PATH: '/bin' }).DOCKER_HOST, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

// ---------- Fix round 1 ----------

test('git is launched only by its resolved absolute path, with -C and a safe config, in the runner AND in main (src/main/git.ts)', () => {
  for (const f of [...RUNNER, ...ts('src/main')]) assert.doesNotMatch(code(f), /\bspawn\(\s*['"`]git(\.exe)?['"`]/, rel(f));
  const main = code(path.join(ROOT, 'src/main/git.ts'));
  assert.match(main, /spawn\(bin, \['-C', cwd, \.\.\.SAFE_GIT_CONFIG, \.\.\.args\], \{ cwd: path\.dirname\(bin\)/);
  assert.match(main, /insideFolder\(bin, cwd\)/);
  const runnerGit = code(path.join(ROOT, 'src/runner/git.ts'));
  assert.match(runnerGit, /insideFolder\(bin, repoPath\)/);
  assert.match(runnerGit, /gitPrefix\(repoPath, this\.hooksDir\)/);
  const { SAFE_GIT_CONFIG } = loadTs('src/main/gitBinary.ts');
  assert.deepEqual([...SAFE_GIT_CONFIG], ['-c', 'core.fsmonitor=false']);
  const { gitPrefix } = loadTs('src/runner/git.ts');
  assert.deepEqual(gitPrefix('C:\\repo', 'C:\\home\\.nexus-no-git-hooks'),
    ['-C', 'C:\\repo', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=C:\\home\\.nexus-no-git-hooks']);
});

// ---------- Fix round 2 ----------

test('the git spawn rule also covers src/main/git.ts, src/main/gitBinary.ts and src/main/nexus/**: one spawn site, by the resolved path; no sync spawn, no shell (legacy src/main/hive.ts is out of scope)', () => {
  const files = [path.join(ROOT, 'src/main/git.ts'), path.join(ROOT, 'src/main/gitBinary.ts'), ...ts('src/main/nexus')];
  assert.ok(files.length > 20 && files.every((f) => fs.existsSync(f)));
  const sites = [];
  for (const f of files) {
    const s = code(f);
    for (const m of s.matchAll(/\b(spawn|execFile|fork)\s*\(\s*([^,)]+)/g)) sites.push(`${rel(f)} ${m[1]}(${m[2].trim()}`);
    assert.doesNotMatch(s, /\b(execSync|spawnSync|execFileSync)\s*\(/, rel(f));
    assert.doesNotMatch(s, /shell\s*:\s*true/, rel(f));
    assert.doesNotMatch(s, /\bspawn\(\s*['"`]git(\.exe)?['"`]/, rel(f));
    if (rel(f) !== 'src/main/git.ts') assert.doesNotMatch(s, /node:child_process|['"]child_process['"]/, `${rel(f)} launches nothing`);
  }
  assert.deepEqual(sites, ['src/main/git.ts spawn(bin']);
  // Both callers resolve git with no working-folder rule (an app started from C:\ or the home folder still finds it).
  const main = code(path.join(ROOT, 'src/main/git.ts'));
  const runnerGit = code(path.join(ROOT, 'src/runner/git.ts'));
  for (const [name, s] of [['src/main/git.ts', main], ['src/runner/git.ts', runnerGit]]) {
    assert.doesNotMatch(s, /notInside|process\.cwd\(\)/, `${name}: the launch folder is no rule`);
    assert.match(s, /gitResolver\(/, `${name}: the shared keeping rule`);
  }
  assert.match(main, /gitResolver\(\(\) => resolveGitBinary\(\{ stat \}\)\)/);
  assert.match(runnerGit, /gitResolver\(o\.resolve \?\? \(\(\) => resolveGitBinary\(fsp\)\)\)/);
});

test('the workspace guard runs /usr/bin/du by its full path', () => {
  const { DU_ARGV } = loadTs('src/runner/sandbox/sizeGuard.ts');
  assert.deepEqual([...DU_ARGV], ['/usr/bin/du', '-s', '-x', '-k', '/workspace']);
});
