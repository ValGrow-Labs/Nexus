'use strict';
// B2a Task 12: the pinned images' inputs (infra/images) and how main loads them (A3). Plain node: no Docker, no network.
// - lock.json agrees with the files: every Dockerfile pins its base by the locked digest, every lockfile hashes as locked,
//   and contextSha256 is THE definition (src/runner/imageBuilder.ts contextSha256: the sorted [path, sha256] list of
//   `<profile>/**` and `common/**`, A4), recomputed here by hand as well;
// - the Dockerfiles: non-root 10001, no healthcheck, the Nexus entry, the label the self-test checks;
// - the profiles main builds from the lock (source `built`: containers by local image id, A2), and the plans and
//   preflight they give.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const IMAGES = path.join(ROOT, 'infra', 'images');
const LOCK = JSON.parse(fs.readFileSync(path.join(IMAGES, 'lock.json'), 'utf8'));
// ml-python (the machine learning kit) is the fourth pinned image: the same base as sde-python, its own hash-pinned wheels.
const PROFILES = ['sde-node', 'sde-python', 'nexus-fwd', 'ml-python'];
const { contextSha256 } = loadTs('src/runner/imageBuilder.ts');
const { loadImageProfiles, parseImageLock, imagesDirFor, LOCKED_PROFILE_IDS } = loadTs('src/main/nexusExec/profiles.ts');
const { buildPlan, ALLOWED_ENV_NAMES, sandboxRecord } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
const { comparePreflight } = loadTs('src/shared/nexus/preflightCheck.ts');
const { inspectFor } = require('./helpers/fakeSandboxDriver.cjs');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (rel) => fs.readFileSync(path.join(IMAGES, ...rel.split('/')));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-lock-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('IL1 lock.json agrees with infra/images: base digests in the FROM lines, lockfile hashes, and contextSha256 by the one definition', async () => {
  assert.equal(LOCK.version, 1);
  assert.deepEqual(Object.keys(LOCK.profiles).sort(), [...PROFILES].sort());
  for (const p of PROFILES) {
    const l = LOCK.profiles[p];
    assert.match(l.base.digest, /^sha256:[0-9a-f]{64}$/, p);
    const docker = read(`${p}/Dockerfile`).toString('utf8');
    const froms = docker.split('\n').filter((x) => /^FROM /.test(x));
    assert.deepEqual(froms, [`FROM ${l.base.ref}@${l.base.digest}`], `${p} pins its one base by digest`);
    for (const [rel, h] of Object.entries(l.lockfiles)) assert.equal(sha(read(rel)), h, `${p}: ${rel}`);
    assert.equal(await contextSha256(fsp, IMAGES, p), l.contextSha256, `${p}: contextSha256`);
  }
  const check = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'nexus-lock-images.cjs'), '--check'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /lock\.json matches the image contexts/);
});

test('IL2 the context hash is sha256 of the canonical JSON of the sorted [path, sha256] list of <profile>/** and common/**; any byte changes it; a link refuses it', async () => {
  const list = (dir, p) => {
    const out = [];
    const walk = (rel) => {
      for (const n of fs.readdirSync(path.join(dir, ...rel.split('/'))).sort()) {
        const r = `${rel}/${n}`; const abs = path.join(dir, ...r.split('/'));
        if (fs.statSync(abs).isDirectory()) walk(r); else out.push([r, sha(fs.readFileSync(abs))]);
      }
    };
    walk(p); walk('common');
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  };
  for (const p of PROFILES) assert.equal(sha(JSON.stringify(list(IMAGES, p))), LOCK.profiles[p].contextSha256, p);
  // Only <profile>/ and common/: lock.json and .gitattributes beside them are in no context.
  const copy = path.join(tmp, 'images');
  fs.cpSync(IMAGES, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'lock.json'), '{}');
  assert.equal(await contextSha256(fsp, copy, 'sde-node'), LOCK.profiles['sde-node'].contextSha256);
  fs.appendFileSync(path.join(copy, 'common', 'nexus-entry'), '\n');
  for (const p of ['sde-node', 'sde-python']) assert.notEqual(await contextSha256(fsp, copy, p), LOCK.profiles[p].contextSha256, `${p} uses common/`);
  assert.equal(await contextSha256(fsp, copy, 'nexus-fwd') === LOCK.profiles['nexus-fwd'].contextSha256, false, 'nexus-fwd carries common/ too');
  assert.equal(await contextSha256(fsp, copy, 'qa-web'), null, 'a profile with no folder has no context');
});

test('IL3 the Dockerfiles: non-root 10001, HEALTHCHECK NONE, the locked entrypoint, the versions label the build self-test checks; the lockfiles are hash-pinned', () => {
  for (const p of PROFILES) {
    const d = read(`${p}/Dockerfile`).toString('utf8');
    const l = LOCK.profiles[p];
    assert.match(d, /^USER 10001:10001$/m, p);
    assert.match(d, /^HEALTHCHECK NONE$/m, p);
    assert.ok(d.includes(`ENTRYPOINT ${JSON.stringify(l.entrypoint)}`), `${p} ENTRYPOINT ${JSON.stringify(l.entrypoint)}`);
    assert.ok(d.includes(`ARG NEXUS_VERSIONS="${Object.entries(l.versions).map(([k, v]) => `${k}=${v}`).join(' ')}"`), `${p} versions`);
    assert.match(d, /^LABEL nexus\.versions="\$NEXUS_VERSIONS"$/m, p);
    assert.doesNotMatch(d, /:latest\b|^ADD /m, p);
    if (p === 'ml-python') {
      // The one image that declares environment names of its own: matplotlib's headless backend and a writable cache folder (/tmp is a
      // tmpfs in every container). imageEnv lists them beside the base's, or preflight would refuse every container of the image.
      assert.deepEqual(d.split('\n').filter((x) => /^ENV /.test(x)), ['ENV MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib'], p);
      assert.deepEqual(l.imageEnv, [...l.baseEnv, 'MPLBACKEND', 'MPLCONFIGDIR'].sort(), p);
    } else {
      assert.doesNotMatch(d, /^ENV /m, `${p}: the image declares no environment of its own (imageEnv is the base's)`);
      assert.deepEqual(l.imageEnv, l.baseEnv, p);
    }
  }
  // ml-python: sde-python's pinned base (same digest), one hash per package (the one wheel pip installs on that base, named beside it),
  // installed wheels-only with hashes and no dependency resolution; the self-test checks the label against what is installed.
  const ml = LOCK.profiles['ml-python'];
  assert.deepEqual(ml.base, LOCK.profiles['sde-python'].base, 'the ML kit is built on the Python kit\'s pinned base');
  const mlReq = read('ml-python/requirements.lock').toString('utf8');
  const mlBlocks = mlReq.split(/\n(?=[a-z0-9-]+==)/).filter((b) => /^[a-z0-9-]+==/.test(b));
  for (const name of ['numpy', 'scipy', 'pandas', 'scikit-learn', 'matplotlib', 'seaborn', 'openpyxl', 'pyarrow', 'joblib', 'pytest']) {
    assert.ok(mlBlocks.some((b) => b.startsWith(`${name}==${ml.versions[name]} `)), `${name} is locked at the labelled version`);
  }
  for (const b of mlBlocks) {
    assert.equal((b.match(/--hash=sha256:[0-9a-f]{64}/g) ?? []).length, 1, `${b.split('\n')[0]}: one wheel, one hash`);
    assert.match(b, /\n {4}# \S+-(?:cp311-cp311-manylinux\S*_x86_64|py2\.py3-none-any|py3-none-any)\.whl\n/, `${b.split('\n')[0]}: the wheel for the base`);
  }
  const mlDocker = read('ml-python/Dockerfile').toString('utf8');
  assert.match(mlDocker, /pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary=:all:/);
  assert.match(mlDocker, /if \[ "\$got" != "\$NEXUS_VERSIONS" \]; then .* exit 1; fi/, 'the build fails unless the label names exactly what is installed');
  const req = read('sde-python/requirements.lock').toString('utf8');
  const pins = req.split('\n').filter((x) => /^[a-z0-9-]+==/.test(x));
  assert.ok(pins.length >= 4);
  for (const name of ['pytest', 'build', 'wheel', 'setuptools']) assert.ok(pins.some((x) => x.startsWith(`${name}==`)), name);
  const blocks = req.split(/\n(?=[a-z0-9-]+==)/).filter((b) => /^[a-z0-9-]+==/.test(b));
  for (const b of blocks) assert.match(b, /--hash=sha256:[0-9a-f]{64}/, b.split('\n')[0]);
  const lock = JSON.parse(read('sde-node/reporters/package-lock.json').toString('utf8'));
  const pkg = JSON.parse(read('sde-node/reporters/package.json').toString('utf8'));
  assert.equal(lock.lockfileVersion, 3);
  for (const [n, v] of Object.entries(pkg.dependencies)) {
    assert.match(v, /^\d+\.\d+\.\d+$/, `${n} is an exact version`);
    assert.equal(lock.packages[`node_modules/${n}`].version, v);
  }
  for (const [k, v] of Object.entries(lock.packages)) if (k) assert.match(v.integrity, /^sha512-/, k);
  assert.match(read('sde-node/reporters/.npmrc').toString('utf8'), /^legacy-peer-deps=true$/m);
  const entry = read('common/nexus-entry').toString('utf8');
  assert.ok(entry.startsWith('#!/bin/sh\n'));
  assert.ok(!entry.includes('\r'), 'LF line endings');
  assert.doesNotMatch(entry.replace(/^#.*$/gm, ''), /\beval\b/, 'the entry never evaluates text');
  assert.match(fs.readFileSync(path.join(IMAGES, '.gitattributes'), 'utf8'), /^\* -text$/m, 'no end-of-line conversion of the contexts');
});

test('IL4 main\'s profiles come from lock.json (A3): built images by local id (A2), the entry, the image env names; a broken lock yields none, never a partial set', () => {
  assert.equal(imagesDirFor({ packaged: true, resourcesPath: 'C:\\app\\resources', appPath: 'x' }), path.join('C:\\app\\resources', 'images'));
  assert.equal(imagesDirFor({ packaged: false, resourcesPath: 'C:\\app\\resources', appPath: ROOT }), IMAGES);
  const r = loadImageProfiles(IMAGES);
  assert.equal(r.problem, null);
  assert.deepEqual(r.profiles.map((p) => p.id), [...LOCKED_PROFILE_IDS]);
  for (const p of r.profiles) {
    const l = LOCK.profiles[p.id];
    assert.deepEqual(p.image, { repository: l.base.repository, digest: l.base.digest, source: 'built' });
    assert.deepEqual([p.entrypoint, p.imageEnv, p.user], [l.entrypoint, l.imageEnv, { uid: 10001, gid: 10001 }]);
    assert.deepEqual(r.imageContexts(p.id), { contextSha256: l.contextSha256, baseDigest: l.base.digest, estimatedBytes: l.estimatedBytes });
  }
  assert.equal(r.imageContexts('qa-web'), null);
  assert.equal(loadImageProfiles(path.join(tmp, 'none')).profiles.length, 0);
  const broken = (mut) => { const x = JSON.parse(JSON.stringify(LOCK)); mut(x); return parseImageLock(JSON.stringify(x)); };
  assert.equal(parseImageLock('nope').ok, false);
  assert.match(broken((x) => { delete x.profiles['nexus-fwd']; }).problem, /does not pin nexus-fwd/);
  assert.match(broken((x) => { x.profiles['sde-node'].base.digest = 'latest'; }).problem, /pinned by digest/);
  assert.match(broken((x) => { x.profiles['sde-node'].entrypoint = ['/a', '/b']; }).problem, /one absolute path/);
  assert.match(broken((x) => { x.profiles['sde-python'].imageEnv = ['BAD NAME']; }).problem, /environment names/);
  assert.match(broken((x) => { x.profiles['sde-python'].contextSha256 = 'x'; }).problem, /context hash/);
  const none = loadImageProfiles(IMAGES, () => JSON.stringify({ version: 1, profiles: {} }));
  assert.deepEqual([none.profiles.length, none.imageContexts('sde-node')], [0, null]);
});

test('IL5 plans with the locked profiles: the entry and its wall clock, node:test per-file (A5), env names allowed; preflight over a Docker-29-shaped inspect with the image\'s own env names passes', () => {
  const { profiles } = loadImageProfiles(IMAGES);
  const node = profiles.find((p) => p.id === 'sde-node');
  const plan = buildPlan({ job: { id: '01K7A0J0B000000000000000AA', projectId: 'p' }, attempt: { id: '01K7A0ATTEMPT0000000000AAA', n: 1 }, bootId: '01K7A0B00T00000000000000AA',
    recipe: getRecipe('sde.test.node'), profile: node, imageId: `sha256:${'a'.repeat(64)}`, dataHomeRoot: path.join(tmp, 'home'), workRel: 'work/01K7A0J0B000000000000000AA/1',
    logRel: 'logs/jobs/01K7A0J0B000000000000000AA/1.log', repoPath: path.join(tmp, 'repo'),
    inputs: [{ versionId: 'V', slot: 'suite', contentHash: 'x', storage: { kind: 'git', commit: 'c'.repeat(40) }, metadata: { framework: 'node-test', files: ['test/a.test.js', 'test/b.test.js'] } }] });
  const c = plan.container;
  assert.deepEqual(c.entrypoint, ['/opt/nexus/nexus-entry']);
  assert.equal(c.image.ref, c.image.id, 'a built image is created by its local id');
  assert.deepEqual(c.argv, ['nexus-node-test', '--out-dir', '/out/junit', '--', 'test/a.test.js', 'test/b.test.js']);
  assert.deepEqual(plan.perFileJunit, { dir: 'junit', files: ['test/a.test.js', 'test/b.test.js'] });
  // Final batch item 2 (the Task 7 R3 ruling): the entry's own backstop is 2x the wall clock (limit + cap); main stays the authority.
  assert.equal(c.env.NEXUS_WALL_SECONDS, String((2 * getRecipe('sde.test.node').wallClockMs) / 1000));
  for (const k of Object.keys(c.env)) assert.ok(ALLOWED_ENV_NAMES.includes(k), k);
  assert.deepEqual(comparePreflight(c, inspectFor(c, 'f'.repeat(64), c.name)).problems, []);
  assert.equal(sandboxRecord(plan).argvCount, 6);
  // jest keeps its single report (no per-file mapping); a dev deployment's app and forwarder carry the lifetime.
  const jest = buildPlan({ ...{ job: { id: '01K7A0J0B000000000000000AB', projectId: 'p' }, attempt: { id: '01K7A0ATTEMPT0000000000AAB', n: 1 }, bootId: '01K7A0B00T00000000000000AA' },
    recipe: getRecipe('sde.test.node'), profile: node, imageId: `sha256:${'a'.repeat(64)}`, dataHomeRoot: path.join(tmp, 'home'), workRel: 'work/01K7A0J0B000000000000000AB/1',
    logRel: 'logs/jobs/01K7A0J0B000000000000000AB/1.log', repoPath: null, framework: 'jest', inputs: [] });
  assert.equal(jest.perFileJunit, undefined);
  assert.equal(jest.container.env.JEST_JUNIT_OUTPUT_FILE, '/out/junit.xml');
});

test('IL6 (final review B7) socat is pinned by its .apk sha256 too: lock.json records it (null until verification), the Dockerfile carries the same value as its build argument, and the build fetches, checks (sha256sum -c) and installs only that file, refusing loudly when no hash is recorded', () => {
  const tool = require(path.join(ROOT, 'tools', 'nexus-lock-images.cjs'));
  const d = read('nexus-fwd/Dockerfile').toString('utf8');
  const pkg = LOCK.profiles['nexus-fwd'].packages.socat;
  assert.equal(pkg.version, LOCK.profiles['nexus-fwd'].versions.socat);
  assert.equal(tool.apkVersion(d, 'socat'), pkg.version, 'the fetched version is the locked one');
  assert.ok(pkg.apkSha256 === null || /^[0-9a-f]{64}$/.test(pkg.apkSha256), 'a sha256, or null until verification records it');
  assert.equal(tool.argDefault(d, 'SOCAT_APK_SHA256'), pkg.apkSha256 ?? '', 'the Dockerfile builds with the recorded value');
  const run = d.split('\nRUN ')[1];
  const at = (s) => { const i = run.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('refusing an unverified package') < at('apk fetch'), 'an empty or malformed hash refuses before anything is fetched');
  assert.ok(at('apk fetch') < at('sha256sum -c -') && at('sha256sum -c -') < at('apk add'), 'checked before it is installed');
  assert.match(run, /apk add --no-cache \/tmp\/nexus-apk\/socat-[0-9A-Za-z._-]+\.apk/, 'only the checked file is installed');
  assert.doesNotMatch(d, /apk add --no-cache socat=/, 'never installed by name from the index');
  // The tool: a missing hash is a warning (the build refuses), a disagreement between the lock and the Dockerfile is stale.
  const clone = JSON.parse(JSON.stringify(LOCK));
  assert.deepEqual(tool.apkProblems(clone).problems, []);
  clone.profiles['nexus-fwd'].packages.socat.apkSha256 = 'e'.repeat(64);
  assert.match(tool.apkProblems(clone).problems.join('\n'), /SOCAT_APK_SHA256 .* is not lock\.json's/);
  delete clone.profiles['nexus-fwd'].packages;
  assert.match(tool.apkProblems(clone).problems.join('\n'), /records no socat package/);
  if (pkg.apkSha256 === null) assert.match(tool.apkProblems(LOCK).warnings.join('\n'), /not pinned yet/);
});
