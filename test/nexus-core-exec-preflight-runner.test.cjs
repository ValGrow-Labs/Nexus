'use strict';
// B2a Task 12: the test:exec runner's resource preflight (tools/run-exec-tests.cjs), with injected probes (P1-P6), and
// the comparator over a Docker 29.7.2-shaped inspect (P7: the synthetic stand-in now, the real capture once committed).
// Plain node: no Docker, no Electron, no database. Nothing here starts a container or reads the real disk numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const runner = require('../tools/run-exec-tests.cjs');
const { comparePreflight } = loadTs('src/shared/nexus/preflightCheck.ts');
const GIB = 2 ** 30;
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra', 'images', 'lock.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-pre-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** Probes of a machine that passes every check; `o` overrides any of them. */
function probes(o = {}) {
  const base = {
    dockerDataDir: () => 'C:\\',
    tempDir: () => 'C:\\Users\\nexus\\AppData\\Local\\Temp',
    freeBytes: () => 45 * GIB,
    dockerVersion: () => ({ reachable: true, os: 'linux', version: '29.7.2' }),
    dockerInfo: () => ({ memoryBytes: 8 * GIB, cpus: 8 }),
    imageLabels: (p) => ({ id: `sha256:${'1'.repeat(64)}`, labels: { 'nexus.profile': p, 'nexus.context-sha256': LOCK.profiles[p].contextSha256 } }),
    lock: () => LOCK,
    env: () => ({ PATH: 'x' }),
    userDataDirs: () => ['C:\\Users\\nexus\\AppData\\Roaming\\app-dev', 'C:\\Users\\nexus\\AppData\\Roaming\\App Packaged']
  };
  return { ...base, ...o };
}

let reportN = 0;
async function run(p, extra = {}) {
  const lines = [];
  const spawned = [];
  const reportPath = path.join(TMP, `report-${++reportN}.json`);
  const code = await runner.main({ probes: p, reportPath, log: (l) => lines.push(l), files: extra.files ?? ['test/nexus-exec-a.test.cjs'],
    spawnFile: async (f) => { spawned.push(f); return extra.out ? extra.out(f) : { code: 0, text: '# tests 3\n# pass 3\n# skipped 0\n# todo 0\n', timedOut: false }; } });
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  return { code, lines, spawned, report, notRun: lines.filter((l) => l.startsWith('[test:exec] NOT RUN: ')) };
}

test('P1 free disk below 30 GiB: NOT RUN with the exact numbers and the action, exit 3, the JSON report, nothing runs; 30-40 GiB warns and runs', async () => {
  const free = 3_612_345_678;
  const r = await run(probes({ freeBytes: () => free }));
  assert.equal(r.code, 3);
  assert.equal(r.spawned.length, 0, 'no test file runs');
  assert.equal(r.notRun.length, 1);
  const line = r.notRun[0];
  assert.match(line, /^\[test:exec\] NOT RUN: free disk 3\.4 GiB < 30 GiB at C:\\ /);
  assert.ok(line.includes('3,612,345,678 bytes free'), line);
  assert.ok(line.includes('30 GiB = 32.2 GB') && line.includes('40 GiB = 42.9 GB recommended'), line);
  assert.ok(line.includes('Free space (for example `docker builder prune`, remove unused images), then run again.'), line);
  assert.equal(r.report.ok, false); assert.equal(r.report.result, 'not_run'); assert.equal(r.report.exitCode, 3);
  const disk = r.report.checks.find((c) => c.id === 'disk');
  assert.deepEqual([disk.ok, disk.facts.freeBytes, disk.facts.requiredBytes, disk.facts.recommendedBytes], [false, free, 30 * GIB, 40 * GIB]);
  // A distinct temp volume is checked on its own.
  const two = await run(probes({ tempDir: () => 'D:\\tmp', freeBytes: (d) => (d.startsWith('D') ? 2 * GIB : 50 * GIB) }));
  assert.equal(two.code, 3);
  assert.ok(two.notRun.some((l) => l.includes('at D:\\tmp (the temp data home')), two.notRun.join('\n'));
  // Unmeasurable is never a pass.
  const unknown = await run(probes({ freeBytes: () => null }));
  assert.equal(unknown.code, 3);
  assert.match(unknown.notRun[0], /could not be measured/);
  // 35 GiB: runs, with a warning.
  const warn = await run(probes({ freeBytes: () => 35 * GIB }));
  assert.equal(warn.code, 0);
  assert.ok(warn.lines.some((l) => /warning: free disk 35\.0 GiB .* below the recommended 40 GiB/.test(l)));
});

test('P2 Docker not running, not installed or not Linux: NOT RUN with the setup action; memory and images say they need Docker (never skipped)', async () => {
  const down = await run(probes({ dockerVersion: () => ({ reachable: false, why: 'not running' }), dockerInfo: () => assert.fail('no info without Docker'),
    imageLabels: () => assert.fail('no image check without Docker') }));
  assert.equal(down.code, 3);
  assert.ok(down.notRun.some((l) => l.includes('Docker Desktop is not running (or not installed)') && l.endsWith('Start Docker Desktop, then run again.')));
  assert.ok(down.notRun.some((l) => l.includes('Docker memory and CPUs were not checked: they need a running Docker.')));
  for (const p of runner.PROFILES) assert.ok(down.notRun.some((l) => l.includes(`Image ${p} was not checked: it needs a running Docker.`)), p);
  const windows = await run(probes({ dockerVersion: () => ({ reachable: true, os: 'windows', version: '29.7.2' }) }));
  assert.equal(windows.code, 3);
  assert.ok(windows.notRun.some((l) => l.includes('the Docker server is windows, not Linux') && l.includes('Switch Docker Desktop to Linux containers')));
});

test('P3 Docker memory or CPUs below 4 GiB / 2: NOT RUN with the numbers and Settings -> Resources', async () => {
  const low = await run(probes({ dockerInfo: () => ({ memoryBytes: 3 * GIB, cpus: 1 }) }));
  assert.equal(low.code, 3);
  const line = low.notRun.find((l) => l.includes('Docker has'));
  assert.ok(line.includes('Docker has 3.0 GiB (3,221,225,472 bytes) / 1 CPUs; the tests need 4 GiB / 2 CPUs.'), line);
  assert.ok(line.endsWith('Docker Desktop -> Settings -> Resources, then run again.'));
  const report = low.report.checks.find((c) => c.id === 'memory');
  assert.deepEqual([report.facts.memoryBytes, report.facts.cpus, report.facts.minMemoryBytes, report.facts.minCpus], [3 * GIB, 1, 4 * GIB, 2]);
  assert.equal((await run(probes({ dockerInfo: () => null }))).code, 3, 'no answer from docker info is not a pass');
});

test('P4 an image missing, out of date (its context label differs from lock.json) or not pinned: NOT RUN naming nexus-prepare-images and its size', async () => {
  const missing = await run(probes({ imageLabels: (p) => (p === 'sde-python' ? null : probes().imageLabels(p)) }));
  assert.equal(missing.code, 3);
  const mb = Math.round(LOCK.profiles['sde-python'].estimatedBytes / 2 ** 20);
  assert.deepEqual(missing.notRun, [`[test:exec] NOT RUN: Image sde-python is missing. Run \`node tools/nexus-prepare-images.cjs\` (needs network; ~${mb} MiB), then run again.`]);
  const stale = await run(probes({ imageLabels: (p) => ({ id: `sha256:${'2'.repeat(64)}`, labels: { 'nexus.context-sha256': p === 'nexus-fwd' ? 'e'.repeat(64) : LOCK.profiles[p].contextSha256 } }) }));
  assert.equal(stale.code, 3);
  assert.ok(stale.notRun[0].includes('Image nexus-fwd is out of date (its context label differs from lock.json)'), stale.notRun[0]);
  assert.equal(stale.report.checks.find((c) => c.id === 'image:nexus-fwd').facts.contextSha256, LOCK.profiles['nexus-fwd'].contextSha256);
  const unpinned = await run(probes({ lock: () => ({ version: 1, profiles: {} }) }));
  assert.equal(unpinned.code, 3);
  assert.equal(unpinned.notRun.filter((l) => l.includes('is not pinned in infra/images/lock.json')).length, 3);
});

test('P5 environment: a NEXUS_DB_HOLD_* variable or a temp data home inside the real userData is NOT RUN with the fix', async () => {
  const held = await run(probes({ env: () => ({ NEXUS_DB_HOLD_V9: '1' }) }));
  assert.equal(held.code, 3);
  assert.deepEqual(held.notRun, ['[test:exec] NOT RUN: NEXUS_DB_HOLD_V9 is set. Unset NEXUS_DB_HOLD_V9 for the execution tests.']);
  const real = await run(probes({ tempDir: () => 'C:\\Users\\nexus\\AppData\\Roaming\\app-dev\\tmp' }));
  assert.equal(real.code, 3);
  assert.ok(real.notRun.some((l) => l.includes("inside the app's real userData")), real.notRun.join('\n'));
  // Every failing check is printed, not only the first.
  const many = await run(probes({ freeBytes: () => GIB, env: () => ({ NEXUS_DB_HOLD_V8: '1' }), dockerInfo: () => ({ memoryBytes: GIB, cpus: 1 }) }));
  assert.deepEqual(many.report.checks.filter((c) => !c.ok).map((c) => c.id).sort(), ['disk', 'env', 'memory']);
  assert.equal(many.notRun.length, 3);
});

test('P6 a passing preflight runs every nexus-exec-* file under the test:db rules: PASS n/n exit 0, FAIL exit 1 (skip, todo, 0 tests, banner, timeout)', async () => {
  const files = runner.listFiles();
  assert.deepEqual(files.map((f) => path.basename(f)),
    ['nexus-exec-agent-iteration.test.cjs', 'nexus-exec-agent.test.cjs', 'nexus-exec-lifecycle.test.cjs', 'nexus-exec-recipes.test.cjs', 'nexus-exec-recovery.test.cjs', 'nexus-exec-sandbox.test.cjs']);
  const ok = await run(probes(), { files });
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.spawned, files, 'every file ran, in order');
  assert.equal(ok.lines[ok.lines.length - 1], `[test:exec] PASS ${files.length}/${files.length}`);
  assert.equal(ok.report.result, 'pass'); assert.equal(ok.report.files.length, files.length);
  const cases = {
    skipped: { code: 0, text: '# tests 3\n# skipped 1\n# todo 0\n' },
    todo: { code: 0, text: '# tests 3\n# skipped 0\n# todo 1\n' },
    empty: { code: 0, text: '# tests 0\n' },
    banner: { code: 0, text: '# tests 1\n# skipped 0\n# todo 0\nneeds the test:exec gate\n' },
    exit: { code: 1, text: '# tests 3\n# skipped 0\n# todo 0\n' },
    timeout: { code: -1, text: '', timedOut: true }
  };
  for (const [name, out] of Object.entries(cases)) {
    const r = await run(probes(), { files: ['test/nexus-exec-x.test.cjs'], out: () => out });
    assert.equal(r.code, 1, name);
    assert.ok(r.lines.some((l) => l.startsWith('[test:exec] FAIL test/nexus-exec-x.test.cjs (')), name);
  }
  // No file at all is a failure, never a pass.
  assert.equal((await run(probes(), { files: [] })).code, 1);
  // Under plain node the real-Docker files print their skip banner (the convention of the real-SQLite files).
  const env = { ...process.env, NEXUS_TEST_EXEC: '' };
  delete env.NODE_TEST_CONTEXT;                       // a plain run of the file, not a child of this test runner
  for (const f of files) {
    const r = spawnSync(process.execPath, [path.join(ROOT, f)], { encoding: 'utf8', timeout: 60_000, cwd: ROOT, env });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.match(r.stdout, /# skipped 1/, f);
    assert.match(r.stdout, /needs Electron as node/, f);
  }
});

test('P7 Docker 29.7.2 inspect shapes pass the comparator: named volumes Mode z and rw, binds Mode "", none with no endpoint; the captured fixture too once committed', () => {
  const synthetic = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'exec', 'inspect-synthetic-29.7.2.json'), 'utf8'));
  const modes = synthetic.inspect[0].Mounts.map((m) => [m.Type, m.Mode]);
  assert.ok(modes.some(([t, m]) => t === 'volume' && m === 'z') && modes.some(([t, m]) => t === 'volume' && m === 'rw') && modes.some(([t, m]) => t === 'bind' && m === ''));
  assert.deepEqual(comparePreflight(synthetic.spec, synthetic.inspect).problems, []);
  const clone = () => JSON.parse(JSON.stringify(synthetic.inspect));
  const ro = clone(); ro[0].Mounts.find((m) => m.Destination === '/workspace').Mode = 'ro';
  assert.ok(comparePreflight(synthetic.spec, ro).problems.some((p) => /mode ro contradicts/.test(p)));
  const bindZ = clone(); bindZ[0].Mounts.find((m) => m.Destination === '/out').Mode = 'z';
  assert.ok(comparePreflight(synthetic.spec, bindZ).problems.some((p) => /mode "?z"? is not allowed/.test(p)));
  const endpoint = clone(); endpoint[0].NetworkSettings.Networks.none.EndpointID = 'e'.repeat(64);
  assert.ok(comparePreflight(synthetic.spec, endpoint).problems.some((p) => /network none has an endpoint \(EndpointID is set\)/.test(p)));
  // The real capture (Verification step 6) is checked by the same rules the moment it is committed.
  const captured = path.join(ROOT, 'test', 'fixtures', 'exec', 'inspect-29.7.2.json');
  if (fs.existsSync(captured)) {
    const real = JSON.parse(fs.readFileSync(captured, 'utf8'));
    assert.deepEqual(comparePreflight(real.spec, real.inspect).problems, [], 'the captured Docker 29.7.2 inspect passes');
  } else {
    assert.equal(synthetic.synthetic, true, 'until the capture is committed, the stand-in says it is synthetic');
  }
});

// ---------- B2a Task 12 fix round 1 ----------

test('P8 (item 2) no environment variable runs the heavy files: under Electron the gate runs the preflight itself every time; with NEXUS_TEST_EXEC=1 and a failing preflight the file FAILS and prints NOT RUN', () => {
  const gatePath = path.join(ROOT, 'test', 'helpers', 'execGate.cjs');
  const gateSrc = fs.readFileSync(gatePath, 'utf8');
  assert.doesNotMatch(gateSrc.replace(/\/\/.*$/gm, ''), /NEXUS_TEST_EXEC/, 'the gate never reads the variable');
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'tools', 'run-exec-tests.cjs'), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''), /NEXUS_TEST_EXEC/, 'nor sets it');
  for (const f of runner.listFiles()) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(text, /if \(realDockerOrSkip\(\)\) \{/, `${f} calls the gate with no argument`);
    assert.doesNotMatch(text, /\bgate\(|NEXUS_TEST_EXEC|probes\s*:/, `${f} injects nothing into the gate`);
  }
  // A file run with the variable set, as Electron (the runtime check injected), and a preflight that fails on disk.
  const file = path.join(TMP, 'gate-child.test.cjs');
  const failing = `{
    dockerDataDir: () => ({ dir: 'C:\\\\', source: 'test' }), tempDir: () => 'C:\\\\Temp', freeBytes: () => 3 * 2 ** 30,
    dockerVersion: () => ({ reachable: true, os: 'linux', version: '29.7.2' }), dockerInfo: () => ({ memoryBytes: 8 * 2 ** 30, cpus: 8 }),
    imageLabels: (p) => ({ id: 'sha256:' + '1'.repeat(64), labels: { 'nexus.context-sha256': LOCK.profiles[p].contextSha256 } }),
    lock: () => LOCK, env: () => ({}), userDataDirs: () => ['C:\\\\nowhere'] }`;
  fs.writeFileSync(file, `'use strict';
const fs = require('node:fs');
const LOCK = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'infra', 'images', 'lock.json'))}, 'utf8'));
const { gate } = require(${JSON.stringify(gatePath)});
const ran = [];
if (gate({ electron: true, probes: ${failing} })) require('node:test')('a heavy test', () => { ran.push('heavy'); });
process.on('exit', () => { if (ran.length) console.log('HEAVY RAN'); });
`);
  const env = { ...process.env, NEXUS_TEST_EXEC: '1' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 60_000, cwd: ROOT, env });
  assert.notEqual(r.status, 0, `the file fails: ${r.stdout}`);
  assert.match(r.stdout, /\[test:exec\] NOT RUN: free disk 3\.0 GiB < 30 GiB/);
  assert.match(r.stdout, /# fail 1/);
  assert.match(r.stdout, /# skipped 0/, 'a failure, never a skip');
  assert.doesNotMatch(r.stdout, /HEAVY RAN/);
  // The same file with a passing preflight runs its heavy test (the gate itself is the only decision).
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('freeBytes: () => 3 * 2 ** 30', 'freeBytes: () => 45 * 2 ** 30'));
  const ok = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 60_000, cwd: ROOT, env });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /HEAVY RAN/);
  // Plain node (no Electron) is the skip banner, whatever the variable says.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('electron: true', 'electron: false'));
  const plain = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 60_000, cwd: ROOT, env });
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /# skipped 1/); assert.match(plain.stdout, /needs Electron as node/); assert.doesNotMatch(plain.stdout, /HEAVY RAN/);
});

test('P9 (item 14) the Docker data volume is located (Docker Desktop settings, then its default disk-image folder, Linux: docker info), never assumed; a fallback to C:\\ is printed as a note', async () => {
  const W = 'win32';
  const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const at = (files, dirs) => ({ readJson: (p) => files[p] ?? null, exists: (p) => dirs.includes(p) || p in files });
  const store = 'C:\\Users\\u\\AppData\\Roaming\\Docker\\settings-store.json';
  // A custom disk image location in the settings wins (any letter case of the key).
  let r = runner.locateDockerData({ platform: W, env, ...at({ [store]: { DiskImageLocation: 'D:\\docker-data' } }, ['D:\\docker-data', 'C:\\Users\\u\\AppData\\Local\\Docker\\wsl']) });
  assert.deepEqual([r.dir, r.note], ['D:\\docker-data', undefined]);
  assert.match(r.source, /DiskImageLocation in settings-store\.json/);
  r = runner.locateDockerData({ platform: W, env, ...at({ ['C:\\Users\\u\\AppData\\Roaming\\Docker\\settings.json']: { dataFolder: 'E:\\Hyper-V' } }, ['E:\\Hyper-V']) });
  assert.equal(r.dir, 'E:\\Hyper-V');
  // A setting naming a folder that does not exist is not believed; the default folder is used.
  r = runner.locateDockerData({ platform: W, env, ...at({ [store]: { customWslDistroDir: 'F:\\gone' } }, ['C:\\Users\\u\\AppData\\Local\\Docker\\wsl']) });
  assert.deepEqual([r.dir, r.source], ['C:\\Users\\u\\AppData\\Local\\Docker\\wsl', 'Docker Desktop\'s default disk-image folder']);
  // Nothing found: C:\ with a note.
  r = runner.locateDockerData({ platform: W, env, ...at({}, []) });
  assert.equal(r.dir, 'C:\\'); assert.match(r.note, /not found.*checked at C:\\ instead/);
  // Linux: the daemon's own root.
  r = runner.locateDockerData({ platform: 'linux', env: {}, exists: (p) => p === '/data/docker', readJson: () => null, dockerRootDir: () => '/data/docker' });
  assert.deepEqual([r.dir, r.source], ['/data/docker', 'docker info (DockerRootDir)']);
  // The preflight measures free space at THAT location, and prints the fallback note.
  const seen = [];
  const lines = []; const reportPath = path.join(TMP, 'report-p9.json');
  const code = await runner.main({ probes: probes({ dockerDataDir: () => ({ dir: 'C:\\', source: 'fallback', note: 'the Docker data location was not found (x); free space is checked at C:\\ instead.' }),
    tempDir: () => 'D:\\tmp', freeBytes: (d) => { seen.push(d); return 2 * GIB; } }), reportPath, log: (l) => lines.push(l), files: [], spawnFile: async () => ({ code: 0, text: '' }) });
  assert.equal(code, 3);
  assert.deepEqual(seen, ['C:\\', 'D:\\tmp']);
  assert.ok(lines.includes('[test:exec] note: the Docker data location was not found (x); free space is checked at C:\\ instead.'), lines.join('\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')).notes, ['the Docker data location was not found (x); free space is checked at C:\\ instead.']);
  const located = await runner.main({ probes: probes({ dockerDataDir: () => ({ dir: 'D:\\docker-data', source: 'Docker Desktop settings (x)' }), freeBytes: (d) => (d.startsWith('D') ? 2 * GIB : 50 * GIB) }),
    reportPath, log: () => {}, files: [], spawnFile: async () => ({ code: 0, text: '' }) });
  assert.equal(located, 3, 'the located volume is the one measured');
  const disk = JSON.parse(fs.readFileSync(reportPath, 'utf8')).checks.find((c) => c.id === 'disk' && !c.ok);
  assert.deepEqual([disk.facts.dir, disk.facts.located], ['D:\\docker-data', 'Docker Desktop settings (x)']);
});
