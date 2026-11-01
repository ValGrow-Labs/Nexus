'use strict';
// The machine learning kit's lock (tools/nexus-lock-images.cjs, ml-python): which wheel of a release the lock pins for the pinned
// base (CPython 3.11, manylinux x86_64, glibc up to 2.36), which release it chooses, and the image environment names a Dockerfile
// adds. Pure functions only: plain node, no Docker, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const tool = require(path.join(__dirname, '..', 'tools', 'nexus-lock-images.cjs'));
const { supportedTags, normalizePlatform, wheelTags, wheelRank, pythonAllowed, lockWheels, pickVersion, dockerfileEnvNames, imageEnvOf, PROFILES, PY_TARGET } = tool;

const PY = '3.11.17';
const whl = (filename, o = {}) => ({ filename, packagetype: 'bdist_wheel', yanked: false, requires_python: o.rp ?? null, size: o.size ?? 1,
  digests: { sha256: (o.sha ?? 'a').repeat(64).slice(0, 64) }, ...(o.yanked ? { yanked: true } : {}) });
const sdist = (filename) => ({ filename, packagetype: 'sdist', yanked: false, requires_python: null, size: 1, digests: { sha256: 'f'.repeat(64) } });

test('LW1 the target is the pinned base: CPython 3.11, manylinux x86_64, glibc up to 2.36 (Debian bookworm)', () => {
  assert.deepEqual({ ...PY_TARGET }, { major: 3, minor: 11, glibcMinor: 36, arch: 'x86_64' });
  assert.equal(PROFILES['ml-python'].baseFrom, 'sde-python', 'the ML kit reuses the Python kit\'s pinned base');
  assert.equal(PROFILES['ml-python'].base, PROFILES['sde-python'].base);
  assert.equal(PROFILES['ml-python'].python.wheels, 'binary');
  assert.equal(PROFILES['sde-python'].python.wheels, 'pure', 'the Python kit still pins pure-Python wheels only');
  assert.deepEqual(PROFILES['ml-python'].lockfiles, ['ml-python/requirements.lock']);
  for (const n of ['numpy', 'scipy', 'pandas', 'scikit-learn', 'matplotlib', 'seaborn', 'openpyxl', 'pyarrow', 'joblib', 'pytest']) {
    assert.ok(PROFILES['ml-python'].python.label.includes(n), `the label names ${n}`);
  }
});

test('LW2 supportedTags follows pip\'s order: cp311 ABI first (newest glibc first), then abi3, then none, then older abi3, then py3 platform wheels, then pure', () => {
  const r = supportedTags();
  const at = (t) => { assert.ok(r.has(t), t); return r.get(t); };
  assert.equal(at('cp311-cp311-manylinux_2_36_x86_64'), 0);
  assert.ok(at('cp311-cp311-manylinux_2_36_x86_64') < at('cp311-cp311-manylinux_2_28_x86_64'));
  assert.ok(at('cp311-cp311-manylinux_2_17_x86_64') < at('cp311-cp311-manylinux_2_5_x86_64'));
  assert.ok(at('cp311-cp311-manylinux_2_5_x86_64') < at('cp311-abi3-manylinux_2_36_x86_64'), 'the exact ABI before abi3');
  assert.ok(at('cp311-abi3-manylinux_2_5_x86_64') < at('cp311-none-manylinux_2_36_x86_64'));
  assert.ok(at('cp311-none-manylinux_2_5_x86_64') < at('cp310-abi3-manylinux_2_36_x86_64'));
  assert.ok(at('cp32-abi3-manylinux_2_5_x86_64') < at('py311-none-manylinux_2_36_x86_64'));
  assert.ok(at('py3-none-manylinux_2_17_x86_64') < at('cp311-none-any'));
  assert.ok(at('cp311-none-any') < at('py311-none-any'));
  assert.ok(at('py311-none-any') < at('py3-none-any'));
  assert.ok(at('py3-none-any') < at('py30-none-any'));
  for (const no of ['cp311-cp311-manylinux_2_37_x86_64', 'cp311-cp311-linux_x86_64', 'cp311-cp311-musllinux_1_2_x86_64', 'cp312-cp312-manylinux_2_17_x86_64',
    'cp312-abi3-manylinux_2_17_x86_64', 'cp311-cp311-manylinux_2_17_aarch64', 'cp311-cp311-win_amd64', 'py2-none-any', 'cp311-cp311-manylinux2014_x86_64']) {
    assert.equal(r.has(no), false, no);
  }
});

test('LW3 wheelTags expands dotted tag sets and reads the legacy manylinux names as their glibc versions; anything else is not a wheel name', () => {
  assert.equal(normalizePlatform('manylinux1_x86_64'), 'manylinux_2_5_x86_64');
  assert.equal(normalizePlatform('manylinux2010_x86_64'), 'manylinux_2_12_x86_64');
  assert.equal(normalizePlatform('manylinux2014_x86_64'), 'manylinux_2_17_x86_64');
  assert.equal(normalizePlatform('musllinux_1_2_x86_64'), 'musllinux_1_2_x86_64');
  assert.deepEqual(wheelTags('numpy-2.4.6-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl'),
    ['cp311-cp311-manylinux_2_27_x86_64', 'cp311-cp311-manylinux_2_28_x86_64']);
  assert.deepEqual(wheelTags('six-1.17.0-py2.py3-none-any.whl'), ['py2-none-any', 'py3-none-any']);
  assert.deepEqual(wheelTags('pkg-1.0-1build-cp311-abi3-manylinux2014_x86_64.whl'), ['cp311-abi3-manylinux_2_17_x86_64'], 'a build tag is allowed');
  for (const bad of ['numpy-2.4.6.tar.gz', 'not-a-wheel.whl', 'a-b-c-d-e-f-g.whl', '', null]) assert.equal(wheelTags(bad), null, String(bad));
});

test('LW4 wheelRank: what the base can install gets its best rank; another Python, another libc, a newer glibc, another machine or OS cannot be installed', () => {
  const r = supportedTags();
  assert.equal(wheelRank('numpy-2.4.6-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl', r), r.get('cp311-cp311-manylinux_2_28_x86_64'), 'the better of its two tags');
  assert.equal(wheelRank('pyarrow-1-cp311-cp311-manylinux_2_28_x86_64.whl', r), r.get('cp311-cp311-manylinux_2_28_x86_64'));
  assert.equal(wheelRank('six-1.17.0-py2.py3-none-any.whl', r), r.get('py3-none-any'));
  assert.ok(wheelRank('six-1.17.0-py2.py3-none-any.whl', r) > wheelRank('scipy-1-cp311-cp311-manylinux2014_x86_64.whl', r), 'a compiled wheel is preferred over a pure one');
  for (const no of ['numpy-2-cp312-cp312-manylinux_2_28_x86_64.whl', 'numpy-2-cp311-cp311-musllinux_1_2_x86_64.whl', 'numpy-2-cp311-cp311-manylinux_2_39_x86_64.whl',
    'numpy-2-cp311-cp311-manylinux_2_28_aarch64.whl', 'numpy-2-cp311-cp311-win_amd64.whl', 'numpy-2-cp311-cp311-macosx_11_0_arm64.whl', 'numpy-2-cp311-cp311-linux_x86_64.whl',
    'numpy-2-pp311-pypy311_pp73-manylinux_2_28_x86_64.whl', 'old-1-py2-none-any.whl', 'numpy-2.tar.gz']) {
    assert.equal(wheelRank(no, r), null, no);
  }
});

test('LW5 pythonAllowed reads requires_python against 3.11.17; an unreadable one admits nothing', () => {
  for (const ok of [null, undefined, '', '>=3', '>=3.9', '>=3.8,<4', '>=3.11', '~=3.10', '!=3.0.*,!=3.1.*,>=2.7', '<3.14,>=3.11', '==3.11.*', '>=3.10, <3.13']) {
    assert.equal(pythonAllowed(ok, PY), true, String(ok));
  }
  for (const no of ['>=3.12', '<3.11', '!=3.11.*', '>=3.11.18', '==3.10.*', 'python3', '>=3.x', '~=3', '>=3.*']) assert.equal(pythonAllowed(no, PY), false, no);
});

test('LW6 lockWheels: binary mode pins the ONE wheel pip would install (yanked files, sources, other platforms and refused requires_python skipped); pure mode is unchanged', () => {
  const files = [
    sdist('numpy-2.4.6.tar.gz'),
    whl('numpy-2.4.6-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl', { sha: '1' }),
    whl('numpy-2.4.6-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl', { sha: '2' }),
    whl('numpy-2.4.6-cp311-cp311-manylinux_2_38_x86_64.whl', { sha: '3' }),
    whl('numpy-2.4.6-cp311-cp311-musllinux_1_2_x86_64.whl', { sha: '4' }),
    whl('numpy-2.4.6-cp312-cp312-manylinux_2_28_x86_64.whl', { sha: '5' }),
    whl('numpy-2.4.6-cp311-cp311-win_amd64.whl', { sha: '6' }),
    whl('numpy-2.4.6-cp311-cp311-manylinux_2_34_x86_64.whl', { sha: '7', yanked: true })
  ];
  assert.deepEqual(lockWheels(files, 'binary', PY).map((f) => f.digests.sha256[0]), ['2'], 'glibc 2.28 beats 2.17; 2.38 is too new; a yanked file never');
  assert.deepEqual(lockWheels([whl('x-1-cp311-cp311-manylinux_2_28_x86_64.whl', { rp: '>=3.12', sha: '1' }), whl('x-1-py3-none-any.whl', { sha: '2' })], 'binary', PY)
    .map((f) => f.digests.sha256[0]), ['2'], 'a wheel whose requires_python refuses 3.11 is skipped');
  assert.deepEqual(lockWheels([whl('x-1-py3-none-any.whl', { rp: '>=3.12' })], 'binary', PY), [], 'nothing usable');
  assert.deepEqual(lockWheels([sdist('x-1.tar.gz')], 'binary', PY), []);
  assert.deepEqual(lockWheels([whl('x-1-py3-none-any.whl', { sha: '1' }), whl('x-1-py3-none-any.whl', { sha: '2' })], 'binary', PY).map((f) => f.digests.sha256[0]), ['1'], 'the first wins a tie');
  // pure: every pure-Python wheel of the release, exactly what the sde-python lock has always pinned (requires_python not read).
  const pure = [whl('pytest-9-py3-none-any.whl', { sha: '1', rp: '>=3.12' }), whl('six-1-py2.py3-none-any.whl', { sha: '2' }), whl('np-1-cp311-cp311-manylinux_2_28_x86_64.whl', { sha: '3' }), sdist('pytest-9.tar.gz')];
  assert.deepEqual(lockWheels(pure, 'pure', PY).map((f) => f.digests.sha256[0]), ['1', '2']);
});

test('LW7 pickVersion chooses the newest final release whose wheels the base can install and every requirement allows', () => {
  const releases = {
    '2.5.0': [whl('numpy-2.5.0-cp312-cp312-manylinux_2_28_x86_64.whl'), sdist('numpy-2.5.0.tar.gz')],
    '2.4.6': [whl('numpy-2.4.6-cp311-cp311-manylinux_2_28_x86_64.whl')],
    '2.4.5': [whl('numpy-2.4.5-cp311-cp311-manylinux_2_28_x86_64.whl')],
    '2.6.0rc1': [whl('numpy-2.6.0rc1-cp311-cp311-manylinux_2_28_x86_64.whl')],
    '2.6.0.dev0': [whl('numpy-2.6.0.dev0-cp311-cp311-manylinux_2_28_x86_64.whl')],
    '1.26.4': [whl('numpy-1.26.4-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl')]
  };
  assert.equal(pickVersion('numpy', releases, [], 'binary', PY), '2.4.6', 'no cp311 wheel in 2.5.0; no pre-release, no dev release');
  assert.equal(pickVersion('numpy', releases, ['<2.4.6'], 'binary', PY), '2.4.5');
  assert.equal(pickVersion('numpy', releases, ['>=1.23', '<2'], 'binary', PY), '1.26.4');
  // pure mode: a compiled-only release is never picked (the sde-python behaviour).
  const mixed = { '2.0': [whl('a-2.0-cp311-cp311-manylinux_2_28_x86_64.whl')], '1.0': [whl('a-1.0-py3-none-any.whl')] };
  assert.equal(pickVersion('a', mixed, [], 'pure', PY), '1.0');
  assert.equal(pickVersion('a', mixed, [], 'binary', PY), '2.0');
});

test('LW8 dockerfileEnvNames reads the ENV names a Dockerfile declares; imageEnv is the base\'s names plus those (sorted, unique)', () => {
  assert.deepEqual(dockerfileEnvNames('FROM x\nENV MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib\nRUN echo ENV=1\n'), ['MPLBACKEND', 'MPLCONFIGDIR']);
  assert.deepEqual(dockerfileEnvNames('FROM x\r\nENV B=1\r\nENV A="two words" C=3\r\n'), ['A', 'B', 'C']);
  assert.deepEqual(dockerfileEnvNames('FROM x\nRUN true\n'), []);
  assert.deepEqual(imageEnvOf(['LANG', 'PATH', 'PYTHON_VERSION'], 'ENV MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib PATH=/x'), ['LANG', 'MPLBACKEND', 'MPLCONFIGDIR', 'PATH', 'PYTHON_VERSION']);
  assert.deepEqual(imageEnvOf(['B', 'A'], ''), ['A', 'B']);
});
