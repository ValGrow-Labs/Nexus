#!/usr/bin/env node
'use strict';
/**
 * tools/nexus-lock-images.cjs (B2a Task 12): pins the three sandbox images' inputs. Controller-run, with the network for
 * METADATA ONLY: it never pulls an image, never builds one, never downloads a package.
 *
 *   node tools/nexus-lock-images.cjs           resolve and write (network: registry manifests and the npm / PyPI JSON APIs)
 *   node tools/nexus-lock-images.cjs --profile ml-python
 *                                              resolve and write ONE profile (its lockfile, its Dockerfile pins and its
 *                                              lock.json entry); every other profile's files and lock.json entry are kept
 *                                              byte for byte
 *   node tools/nexus-lock-images.cjs --check   no network: verify infra/images/lock.json against the files (exit 1 if stale)
 *   node tools/nexus-lock-images.cjs --rehash  no network: recompute the context and lockfile hashes after a local edit
 *   node tools/nexus-lock-images.cjs --pin-apk socat=<sha256>
 *                                              no network: record the sha256 of a pinned Alpine .apk (B2a final review B7;
 *                                              taken at verification: the APKINDEX is outside the approved network) in
 *                                              lock.json `packages.<name>.apkSha256` and as the Dockerfile's
 *                                              `ARG SOCAT_APK_SHA256` default, then rehash. Until it is set the nexus-fwd
 *                                              build refuses, and --check says so (a warning, not a stale lock).
 *
 * Resolving:
 * - base images: `docker buildx imagetools inspect <ref>` (manifest and config metadata from the registry; nothing is
 *   pulled): the index digest pinned in each Dockerfile's FROM line, the image config's ENV names (a container may carry
 *   only those, the plan's own names aside: preflight's image-environment check), the compressed layer sizes;
 * - sde-node reporters: the npm registry JSON API (abbreviated packuments): the newest jest-junit and
 *   mocha-junit-reporter, their dependency tree resolved with semver and laid out as npm would (hoisted, nested only on a
 *   conflict), written as reporters/package.json (exact versions) and a lockfile v3 with each tarball's `integrity`;
 *   peers are not installed (reporters/.npmrc legacy-peer-deps);
 * - sde-python tools: the PyPI JSON API: every name of requirements.in and its dependency closure for CPython 3.11 on
 *   Linux x86_64 (environment markers evaluated, extras never), the newest release that satisfies every requirement,
 *   written as requirements.lock with the sha256 of each pure-Python wheel;
 * - ml-python packages (the machine learning kit): the same PyPI resolution from ml-python/requirements.in, but compiled
 *   wheels are allowed: for each package the ONE wheel pip itself would install on the pinned base (CPython 3.11,
 *   manylinux x86_64 with glibc up to 2.36 (Debian bookworm), else a pure `py3-none-any` wheel), chosen by pip's own tag
 *   order (`supportedTags`), with its `requires_python` honoured; a release with no such wheel is never chosen. Its base is
 *   sde-python's pinned base (`baseFrom`: the same digest, so the same Python and shared layers on disk).
 * Writing: the lockfiles, the Dockerfiles' FROM digest and `ARG NEXUS_VERSIONS` default (the label the build self-test
 * checks), then infra/images/lock.json: per profile `{ base: { ref, repository, digest }, baseEnv, imageEnv, entrypoint,
 * lockfiles: { <path>: <sha256> }, contextSha256, estimatedBytes, versions }`. `imageEnv` is the base's ENV names plus the
 * names the profile's Dockerfile declares with `ENV` (only ml-python declares any: MPLBACKEND, MPLCONFIGDIR). `contextSha256` is computed with
 * src/runner/imageBuilder.ts `contextSha256` (THE definition: the sorted [path, sha256] list of `<profile>/**` and
 * `common/**`), so main, the runner and this file agree byte for byte.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const IMAGES = path.join(ROOT, 'infra', 'images');
const LOCK = path.join(IMAGES, 'lock.json');
const PLATFORM = 'linux/amd64';
const NPM = 'https://registry.npmjs.org';
const PYPI = 'https://pypi.org/pypi';
const TIMEOUT_MS = 60_000;
/** A pure-Python wheel (the only kind the lock pins: one file for every platform). */
const PURE_WHEEL_RE = /-(?:py2\.)?py3-none-any\.whl$/;

/**
 * The profiles: base reference, entrypoint, the lockfiles in their context. A Python profile names its `python` lock:
 * `wheels: 'pure'` (pure-Python wheels only, every one of a release hashed) or `'binary'` (the one wheel pip installs on
 * the base, compiled or pure), and `label`: the packages its `nexus.versions` label names after python (in order).
 * `baseFrom`: the profile whose locked base digest this one reuses (resolved together in a full run).
 */
const PROFILES = {
  'sde-node': { base: 'docker.io/library/node:20-bookworm-slim', entrypoint: ['/opt/nexus/nexus-entry'],
    lockfiles: ['sde-node/reporters/package.json', 'sde-node/reporters/package-lock.json'] },
  'sde-python': { base: 'docker.io/library/python:3.11-slim-bookworm', entrypoint: ['/opt/nexus/nexus-entry'],
    lockfiles: ['sde-python/requirements.lock'],
    python: { wheels: 'pure', label: ['pytest', 'build', 'wheel', 'setuptools'] } },
  'nexus-fwd': { base: 'docker.io/library/alpine:3.20', entrypoint: ['/opt/nexus/fwd-entry'], lockfiles: [] },
  'ml-python': { base: 'docker.io/library/python:3.11-slim-bookworm', baseFrom: 'sde-python', entrypoint: ['/opt/nexus/nexus-entry'],
    lockfiles: ['ml-python/requirements.lock'],
    // unpackFactor: compiled wheels (numpy, scipy, pyarrow...) unpack to about 6 times their download (measured at the first build:
    // 157 MB of wheels, 905 MB of image beside the shared base; the pure-Python default is 3).
    python: { wheels: 'binary', unpackFactor: 6, label: ['numpy', 'scipy', 'pandas', 'scikit-learn', 'matplotlib', 'seaborn', 'openpyxl', 'pyarrow', 'joblib',
      'pytest', 'build', 'wheel', 'setuptools'] } }
};
/** The platform a binary Python lock targets: the pinned python:3.11-slim-bookworm base (Debian bookworm has glibc 2.36). */
const PY_TARGET = Object.freeze({ major: 3, minor: 11, glibcMinor: 36, arch: 'x86_64' });
/** Alpine packages pinned by the sha256 of their .apk (B7): the lock.json entry and the Dockerfile build argument. */
const APK_PINS = { socat: { profile: 'nexus-fwd', arg: 'SOCAT_APK_SHA256' } };
const APK_SHA_RE = /^[0-9a-f]{64}$/;

/** The pinned version of an Alpine package in its Dockerfile: the `apk fetch ... <name>=<version>` the build checks. */
function apkVersion(docker, name) {
  // The pinned version is the one in the checked file name on the `sha256sum -c` line (`/tmp/nexus-apk/<name>-<ver>.apk`):
  // apk fetch takes a bare name, so that file name plus its sha256 is what decides the version.
  return (new RegExp(`/tmp/nexus-apk/${name}-([0-9][0-9A-Za-z._-]*)\\.apk"?\\s*\\|\\s*sha256sum -c`).exec(docker) ?? [])[1] ?? null;
}
/** The Dockerfile's `ARG <arg>="<value>"` default, or null when the line is missing. */
function argDefault(docker, arg) {
  const m = new RegExp(`^ARG ${arg}="([^"]*)"$`, 'm').exec(docker);
  return m ? m[1] : null;
}
/** Problems (stale) and warnings (not pinned yet) of the .apk pins, against the lock and the Dockerfiles. */
function apkProblems(lock) {
  const problems = []; const warnings = [];
  for (const [name, pin] of Object.entries(APK_PINS)) {
    const docker = fs.readFileSync(path.join(IMAGES, pin.profile, 'Dockerfile'), 'utf8');
    const entry = lock.profiles?.[pin.profile]?.packages?.[name];
    const version = apkVersion(docker, name);
    if (!entry) { problems.push(`${pin.profile}: lock.json records no ${name} package`); continue; }
    if (entry.version !== version) problems.push(`${pin.profile}: lock.json pins ${name} ${entry.version}, the Dockerfile ${version}`);
    const arg = argDefault(docker, pin.arg);
    if (arg === null) { problems.push(`${pin.profile}: the Dockerfile has no ARG ${pin.arg}="..." line`); continue; }
    const want = entry.apkSha256 ?? '';
    if (want !== '' && !APK_SHA_RE.test(want)) problems.push(`${pin.profile}: ${name}.apkSha256 is not a sha256`);
    if (arg !== want) problems.push(`${pin.profile}: the Dockerfile's ${pin.arg} (${arg.slice(0, 12) || 'empty'}) is not lock.json's (${want.slice(0, 12) || 'null'})`);
    if (want === '') warnings.push(`${pin.profile}: the ${name} .apk sha256 is not pinned yet; its build refuses until --pin-apk ${name}=<sha256> runs at verification`);
  }
  return { problems, warnings };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fileSha = (rel) => sha256(fs.readFileSync(path.join(IMAGES, ...rel.split('/'))));
const die = (m) => { console.error(`[lock] ${m}`); process.exit(1); };

function loadImageBuilder() {
  const loadTs = require(path.join(ROOT, 'test', 'load-ts.cjs'));
  return loadTs('src/runner/imageBuilder.ts');
}
async function contextOf(profile) {
  const { contextSha256 } = loadImageBuilder();
  const sha = await contextSha256(fsp, IMAGES, profile);
  if (!sha) die(`the build context of ${profile} is missing or holds a link`);
  return sha;
}

// ---------------------------------------------------------------- --check (no network)

async function check() {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (e) { die(`lock.json is not readable: ${e.message}`); }
  const problems = [];
  for (const id of Object.keys(PROFILES)) {
    const p = lock.profiles?.[id];
    if (!p) { problems.push(`${id}: not in lock.json`); continue; }
    for (const [rel, want] of Object.entries(p.lockfiles ?? {})) if (fileSha(rel) !== want) problems.push(`${id}: ${rel} changed since it was locked`);
    const docker = fs.readFileSync(path.join(IMAGES, id, 'Dockerfile'), 'utf8');
    if (!docker.includes(`FROM ${p.base.ref}@${p.base.digest}`)) problems.push(`${id}: the Dockerfile does not pin ${p.base.ref}@${p.base.digest}`);
    const missingEnv = dockerfileEnvNames(docker).filter((n) => !(p.imageEnv ?? []).includes(n));
    if (missingEnv.length) problems.push(`${id}: the Dockerfile declares ENV ${missingEnv.join(', ')}, which imageEnv does not list`);
    const fromBase = PROFILES[id].baseFrom;
    if (fromBase && lock.profiles?.[fromBase]?.base?.digest !== p.base.digest) problems.push(`${id}: its base is not ${fromBase}'s locked base`);
    const ctx = await contextOf(id);
    if (ctx !== p.contextSha256) problems.push(`${id}: the build context changed (${ctx.slice(0, 12)} != locked ${String(p.contextSha256).slice(0, 12)})`);
  }
  const apk = apkProblems(lock);
  problems.push(...apk.problems);
  if (problems.length) { for (const x of problems) console.error(`[lock] STALE ${x}`); process.exit(1); }
  for (const x of apk.warnings) console.log(`[lock] WARN ${x}`);
  console.log('[lock] lock.json matches the image contexts');
}

// ---------------------------------------------------------------- --pin-apk (no network)

/** Records one .apk sha256 (B7) in lock.json and as its Dockerfile build-argument default, then rehashes the contexts. */
async function pinApk() {
  const spec = process.argv[process.argv.indexOf('--pin-apk') + 1] ?? '';
  const m = /^([a-z0-9-]+)=([0-9a-f]{64})$/.exec(spec);
  if (!m || !APK_PINS[m[1]]) die(`--pin-apk takes <name>=<sha256> for one of: ${Object.keys(APK_PINS).join(', ')}`);
  const [, name, sha] = m;
  const pin = APK_PINS[name];
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const f = path.join(IMAGES, pin.profile, 'Dockerfile');
  let docker = fs.readFileSync(f, 'utf8');
  if (argDefault(docker, pin.arg) === null) die(`${pin.profile}: the Dockerfile has no ARG ${pin.arg}="..." line`);
  docker = docker.replace(new RegExp(`^ARG ${pin.arg}="[^"]*"$`, 'm'), `ARG ${pin.arg}="${sha}"`);
  fs.writeFileSync(f, docker);
  const prof = lock.profiles?.[pin.profile];
  if (!prof) die(`${pin.profile}: not in lock.json`);
  prof.packages = { ...(prof.packages ?? {}), [name]: { version: apkVersion(docker, name), apkSha256: sha } };
  fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`[lock] ${pin.profile}: ${name} .apk pinned to ${sha}`);
  await rehash();
}

// ---------------------------------------------------------------- base images (registry metadata only)

function imagetools(ref, format) {
  const out = execFileSync('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', format], { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
  return JSON.parse(out);
}

/** The base `ref` (a tag reference), resolved to its current index digest, or, with `pinned`, inspected at that digest. */
function inspectBase(ref, pinned = null) {
  if (pinned !== null && !/^sha256:[0-9a-f]{64}$/.test(String(pinned))) die(`${ref}: the pinned digest is not a sha256 digest`);
  const target = pinned ? `${ref.replace(/:[^/:]+$/, '')}@${pinned}` : ref;
  const manifest = imagetools(target, '{{json .Manifest}}');
  let digest = manifest.digest ?? manifest.Digest;
  if (!digest) {
    // A buildx that prints the index without its own digest in the template: the plain output names it.
    const text = execFileSync('docker', ['buildx', 'imagetools', 'inspect', target], { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
    digest = (/^Digest:\s+(sha256:[0-9a-f]{64})/m.exec(text) ?? [])[1];
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(digest))) die(`${ref}: no index digest`);
  if (pinned && digest !== pinned) die(`${ref}: the registry answered ${digest} for the pinned ${pinned}`);
  // The platform manifest (an index lists one per platform; a single-platform image is its own manifest).
  let platformDigest = digest;
  if (Array.isArray(manifest.manifests)) {
    const m = manifest.manifests.find((x) => x.platform && `${x.platform.os}/${x.platform.architecture}` === PLATFORM && !x.platform.variant);
    if (!m) die(`${ref}: no ${PLATFORM} manifest`);
    platformDigest = m.digest;
  }
  const repo = ref.replace(/:[^/:]+$/, '');
  // The platform manifest exactly as the registry serves it (`--raw`): its layers carry their compressed sizes.
  const pmText = execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${repo}@${platformDigest}`],
    { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
  const pm = JSON.parse(pmText);
  const compressed = (pm.layers ?? []).reduce((s, l) => s + (Number(l.size) || 0), 0);
  if (!(compressed > 0)) die(`${ref}: the ${PLATFORM} manifest lists no layer sizes`);
  const raw = imagetools(`${repo}@${platformDigest}`, '{{json .Image}}');
  const img = raw && raw[PLATFORM] ? raw[PLATFORM] : raw;
  const config = img.config ?? img.Config ?? {};
  const env = (config.Env ?? config.env ?? []).map((e) => String(e).split('=')[0]).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  const values = Object.fromEntries((config.Env ?? []).map((e) => { const i = String(e).indexOf('='); return [e.slice(0, i), e.slice(i + 1)]; }));
  return { ref, repository: repo, digest, platformDigest, compressed, env: [...new Set(env)].sort(), values };
}

// ---------------------------------------------------------------- npm (registry JSON API)

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) die(`${url}: HTTP ${r.status}`);
  return r.json();
}
const packuments = new Map();
async function packument(name) {
  if (!packuments.has(name)) packuments.set(name, await getJson(`${NPM}/${name.replace('/', '%2f')}`, { accept: 'application/vnd.npm.install-v1+json' }));
  return packuments.get(name);
}

async function lockNpm() {
  const semver = require('semver');
  const top = ['jest-junit', 'mocha-junit-reporter'];
  const exact = {};
  for (const n of top) exact[n] = (await packument(n))['dist-tags'].latest;
  // Placement: key = install path ('node_modules/a', 'node_modules/a/node_modules/b'); value = { name, version, meta }.
  const placed = new Map();
  const queue = [];
  const place = async (name, range, parent) => {
    // Resolution as node does: the nearest node_modules up from the dependent.
    const chain = [];
    for (let p = parent; ; p = p.includes('/node_modules/') ? p.slice(0, p.lastIndexOf('/node_modules/')) : '') {
      chain.push(p ? `${p}/node_modules/${name}` : `node_modules/${name}`);
      if (!p) break;
    }
    const found = chain.map((k) => [k, placed.get(k)]).find(([, v]) => v);
    if (found && semver.satisfies(found[1].version, range)) return;
    const pk = await packument(name);
    const version = semver.maxSatisfying(Object.keys(pk.versions), range);
    if (!version) die(`npm: no version of ${name} satisfies ${range}`);
    const meta = pk.versions[version];
    if (!meta.dist?.integrity || !meta.dist?.tarball) die(`npm: ${name}@${version} has no integrity`);
    const key = !found && !placed.has(`node_modules/${name}`) ? `node_modules/${name}` : (parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`);
    if (placed.has(key)) die(`npm: cannot place ${name}@${version} at ${key}`);
    placed.set(key, { name, version, meta });
    queue.push(key);
  };
  for (const n of top) await place(n, exact[n], '');
  while (queue.length) {
    const key = queue.shift();
    const { meta } = placed.get(key);
    for (const [dep, range] of Object.entries(meta.dependencies ?? {})) await place(dep, range, key);
  }
  const pkgPath = path.join(IMAGES, 'sde-node', 'reporters', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies = Object.fromEntries(top.map((n) => [n, exact[n]]));
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const packages = { '': { name: pkg.name, version: pkg.version, license: pkg.license, dependencies: { ...pkg.dependencies } } };
  let unpacked = 0;
  for (const key of [...placed.keys()].sort()) {
    const { version, meta } = placed.get(key);
    unpacked += Number(meta.dist.unpackedSize) || 0;
    packages[key] = { version, resolved: meta.dist.tarball, integrity: meta.dist.integrity,
      ...(meta.license ? { license: typeof meta.license === 'string' ? meta.license : undefined } : {}),
      ...(meta.dependencies && Object.keys(meta.dependencies).length ? { dependencies: { ...meta.dependencies } } : {}),
      ...(meta.peerDependencies ? { peerDependencies: { ...meta.peerDependencies } } : {}),
      ...(meta.bin ? { bin: typeof meta.bin === 'string' ? { [meta.name]: meta.bin } : { ...meta.bin } } : {}),
      ...(meta.engines ? { engines: { ...meta.engines } } : {}) };
  }
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages };
  fs.writeFileSync(path.join(IMAGES, 'sde-node', 'reporters', 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  return { versions: exact, packages: placed.size, unpackedBytes: unpacked };
}

// ---------------------------------------------------------------- PyPI (JSON API): PEP 440 and markers, the parts used here

/** A PEP 440 version as a comparable record (release, pre, post, dev); null for anything else. */
function pv(v) {
  const m = /^v?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|rc|alpha|beta|c|pre|preview)[-_.]?(\d*))?(?:[-_.]?(?:post|rev|r)[-_.]?(\d*)|-(\d+))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[a-z0-9.]+)?$/i.exec(String(v).trim());
  if (!m) return null;
  const preKind = m[2] ? ({ alpha: 'a', a: 'a', beta: 'b', b: 'b', c: 'rc', rc: 'rc', pre: 'rc', preview: 'rc' })[m[2].toLowerCase()] : null;
  return { release: m[1].split('.').map(Number), pre: preKind ? [preKind, Number(m[3] || 0)] : null,
    post: m[4] !== undefined || m[5] !== undefined ? Number(m[4] || m[5] || 0) : null, dev: m[6] !== undefined ? Number(m[6] || 0) : null };
}
function cmpRelease(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}
function pvCmp(x, y) {
  const r = cmpRelease(x.release, y.release); if (r) return r;
  // dev < pre < (final) < post, as PEP 440 orders them.
  const key = (v) => [v.pre === null && v.post === null && v.dev !== null ? -2 : v.pre ? -1 : 0,
    v.pre ? ['a', 'b', 'rc'].indexOf(v.pre[0]) : 0, v.pre ? v.pre[1] : 0, v.post ?? -1, v.dev === null ? Infinity : v.dev];
  const a = key(x); const b = key(y);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
/** Whether version `v` satisfies one specifier clause (`>=1.0`, `<3`, `==2.*`, `~=1.4`, `!=1.5`). */
function satisfiesClause(v, clause) {
  const m = /^\s*(===|~=|==|!=|<=|>=|<|>)\s*([^\s]+)\s*$/.exec(clause);
  if (!m) die(`pypi: unsupported specifier ${clause}`);
  const [, op, target] = m;
  const x = pv(v);
  if (op === '===') return v === target;
  if (target.endsWith('.*')) {
    const pre = target.slice(0, -2).split('.').map(Number);
    const eq = pre.every((n, i) => (x.release[i] ?? 0) === n);
    return op === '==' ? eq : op === '!=' ? !eq : die(`pypi: unsupported wildcard ${clause}`);
  }
  const t = pv(target);
  if (!t) die(`pypi: unsupported version ${target}`);
  const c = pvCmp(x, t);
  switch (op) {
    case '==': return c === 0;
    case '!=': return c !== 0;
    case '<=': return c <= 0;
    case '>=': return c >= 0;
    case '<': return c < 0 && !(x.pre && cmpRelease(x.release, t.release) === 0 && !t.pre);
    case '>': return c > 0 && !(x.post !== null && t.post === null && cmpRelease(x.release, t.release) === 0);
    case '~=': {
      if (t.release.length < 2) die(`pypi: ~= needs two release parts (${clause})`);
      return c >= 0 && t.release.slice(0, -1).every((n, i) => (x.release[i] ?? 0) === n);
    }
    default: return false;
  }
}
const satisfies = (v, spec) => !spec || spec.split(',').filter((s) => s.trim()).every((c) => satisfiesClause(v, c));

/** Evaluates a PEP 508 marker for CPython 3.11 on Linux x86_64 (`extra` is never set: no extras are installed). */
function marker(expr, env) {
  const toks = [];
  const re = /\s*(\(|\)|"[^"]*"|'[^']*'|===|==|!=|<=|>=|~=|<|>|not\s+in\b|in\b|and\b|or\b|[A-Za-z_][A-Za-z0-9_.]*)/y;
  let i = 0;
  while (i < expr.length) {
    re.lastIndex = i;
    const m = re.exec(expr);
    if (!m) { if (/^\s*$/.test(expr.slice(i))) break; die(`pypi: unsupported marker ${expr}`); }
    toks.push(m[1].replace(/\s+/g, ' ')); i = re.lastIndex;
  }
  let p = 0;
  const value = () => {
    const t = toks[p++];
    if (/^["']/.test(t)) return { lit: t.slice(1, -1) };
    if (!(t in env)) die(`pypi: unsupported marker variable ${t}`);
    return { lit: env[t], name: t };
  };
  const cmp = () => {
    if (toks[p] === '(') { p++; const v = or(); if (toks[p++] !== ')') die(`pypi: bad marker ${expr}`); return v; }
    const a = value(); const op = toks[p++]; const b = value();
    const versiony = ['python_version', 'python_full_version', 'implementation_version'].includes(a.name ?? b.name ?? '');
    if (op === 'in') return b.lit.includes(a.lit);
    if (op === 'not in') return !b.lit.includes(a.lit);
    if (versiony && op !== '===' && pv(a.lit) && pv(b.lit)) return satisfiesClause(a.lit, `${op}${b.lit}`);
    if (op === '==' || op === '===') return a.lit === b.lit;
    if (op === '!=') return a.lit !== b.lit;
    die(`pypi: unsupported marker comparison ${expr}`);
    return false;
  };
  const and = () => { let v = cmp(); while (toks[p] === 'and') { p++; const w = cmp(); v = v && w; } return v; };
  const or = () => { let v = and(); while (toks[p] === 'or') { p++; const w = and(); v = v || w; } return v; };
  const out = or();
  if (p !== toks.length) die(`pypi: bad marker ${expr}`);
  return out;
}

/** `name [extras] (spec) ; marker` -> { name, spec, marker } (normalized name). */
function parseReq(s) {
  const [main, mk] = String(s).split(';');
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*\(?\s*([^)]*?)\s*\)?\s*$/.exec(main);
  if (!m) die(`pypi: unsupported requirement ${s}`);
  return { name: m[1].toLowerCase().replace(/[-_.]+/g, '-'), spec: m[3].trim(), marker: mk ? mk.trim() : null };
}

// ---------------------------------------------------------------- wheels (pure functions: the binary lock's choice)

const MANYLINUX_ALIASES = { manylinux1: 5, manylinux2010: 12, manylinux2014: 17 };

/**
 * Every tag the target interpreter accepts, best first, as pip orders them (packaging.tags.sys_tags for CPython on
 * manylinux): `cp311-cp311-<plat>`, `cp311-abi3-<plat>`, `cp311-none-<plat>` for each platform from manylinux_2_36 down to
 * manylinux_2_5; then `cp310-abi3-<plat>` ... `cp32-abi3-<plat>`; then `py311`, `py3`, `py310` ... `py30` with `none` and
 * each platform; then `cp311-none-any`; then the same `py*` versions with `none-any`. The plain `linux_x86_64` platform is
 * never accepted (it names no glibc). Returns a Map tag -> rank (0 is best).
 */
function supportedTags(t = PY_TARGET) {
  const cp = `cp${t.major}${t.minor}`;
  const plats = [];
  for (let g = t.glibcMinor; g >= 5; g--) plats.push(`manylinux_2_${g}_${t.arch}`);
  const tags = [];
  for (const abi of [cp, 'abi3', 'none']) for (const p of plats) tags.push(`${cp}-${abi}-${p}`);
  for (let m = t.minor - 1; m >= 2; m--) for (const p of plats) tags.push(`cp${t.major}${m}-abi3-${p}`);
  const pys = [`py${t.major}${t.minor}`, `py${t.major}`];
  for (let m = t.minor - 1; m >= 0; m--) pys.push(`py${t.major}${m}`);
  for (const v of pys) for (const p of plats) tags.push(`${v}-none-${p}`);
  tags.push(`${cp}-none-any`);
  for (const v of pys) tags.push(`${v}-none-any`);
  return new Map(tags.map((tag, i) => [tag, i]));
}

/** A legacy manylinux platform tag as its PEP 600 name (`manylinux2014_x86_64` -> `manylinux_2_17_x86_64`); others unchanged. */
function normalizePlatform(p) {
  const m = /^(manylinux1|manylinux2010|manylinux2014)_(.+)$/.exec(p);
  return m ? `manylinux_2_${MANYLINUX_ALIASES[m[1]]}_${m[2]}` : p;
}

/** The tags of a wheel file name (`name-ver[-build]-py-abi-plat.whl`, each part may be a dotted set), expanded; null if not a wheel name. */
function wheelTags(filename) {
  const m = /^(.+)\.whl$/.exec(String(filename));
  if (!m) return null;
  const parts = m[1].split('-');
  if (parts.length !== 5 && parts.length !== 6) return null;
  const [py, abi, plat] = parts.slice(-3);
  const out = [];
  for (const a of py.split('.')) for (const b of abi.split('.')) for (const c of plat.split('.')) out.push(`${a}-${b}-${normalizePlatform(c)}`);
  return out;
}

/** The best (lowest) rank of a wheel among the supported tags, or null when the target cannot install it. */
function wheelRank(filename, ranks = supportedTags()) {
  const tags = wheelTags(filename);
  if (!tags) return null;
  let best = null;
  for (const tag of tags) { const r = ranks.get(tag); if (r !== undefined && (best === null || r < best)) best = r; }
  return best;
}

/** Whether `requires_python` (a PEP 440 specifier set, or empty) admits the target's Python; an unreadable one admits nothing. */
function pythonAllowed(requiresPython, pythonVersion) {
  if (requiresPython === null || requiresPython === undefined || String(requiresPython).trim() === '') return true;
  const clauses = String(requiresPython).split(',').map((c) => c.trim()).filter(Boolean);
  for (const c of clauses) {
    const m = /^(===|~=|==|!=|<=|>=|<|>)\s*([0-9][0-9A-Za-z.!+-]*(?:\.\*)?)$/.exec(c);
    if (!m) return false;
    if (m[1] === '~=' && m[2].split('.').length < 2) return false;
    if (!m[2].endsWith('.*') && !pv(m[2])) return false;
    if (m[2].endsWith('.*') && m[1] !== '==' && m[1] !== '!=') return false;
  }
  return clauses.every((c) => satisfiesClause(pythonVersion, c));
}

/**
 * The wheels a lock pins for one release (`files`: the PyPI JSON `urls` / `releases[v]` entries):
 * - `pure`: every pure-Python wheel (`py3-none-any`), as the lock always did;
 * - `binary`: the ONE wheel pip would install on the target, by pip's tag order, among the wheels whose `requires_python`
 *   admits the target's Python (`pythonVersion`); the first listed wins a tie.
 * Yanked files and source archives are never pinned. Returns [] when the release has none.
 */
function lockWheels(files, mode, pythonVersion, ranks = supportedTags()) {
  const wheels = (files ?? []).filter((f) => f && !f.yanked && f.packagetype === 'bdist_wheel' && typeof f.filename === 'string');
  if (mode === 'pure') return wheels.filter((f) => PURE_WHEEL_RE.test(f.filename));
  if (mode !== 'binary') die(`pypi: unknown wheel mode ${mode}`);
  let best = null; let bestRank = null;
  for (const f of wheels) {
    if (!pythonAllowed(f.requires_python, pythonVersion)) continue;
    const r = wheelRank(f.filename, ranks);
    if (r !== null && (bestRank === null || r < bestRank)) { best = f; bestRank = r; }
  }
  return best ? [best] : [];
}

const pypiCache = new Map();
async function pypiProject(name) {
  if (!pypiCache.has(name)) pypiCache.set(name, await getJson(`${PYPI}/${name}/json`));
  return pypiCache.get(name);
}
const releaseCache = new Map();
async function pypiRelease(name, version) {
  const k = `${name}@${version}`;
  if (!releaseCache.has(k)) releaseCache.set(k, await getJson(`${PYPI}/${name}/${version}/json`));
  return releaseCache.get(k);
}

/**
 * The newest final release of `name` satisfying every spec in `specs` that has a wheel the lock can pin (`mode`: see
 * `lockWheels`). Pure over `releases` (the PyPI JSON `releases` map): the network part is `pick`.
 */
function pickVersion(name, releases, specs, mode = 'pure', pythonVersion = '3.11.0') {
  if (!releases || typeof releases !== 'object') die(`pypi: ${name} lists no releases in its JSON`);
  const ranks = supportedTags();
  const versions = Object.keys(releases).filter((v) => { const x = pv(v); return x && !x.pre && x.dev === null; })
    .filter((v) => lockWheels(releases[v], mode, pythonVersion, ranks).length > 0)
    .filter((v) => specs.every((s) => satisfies(v, s)))
    .sort((a, b) => pvCmp(pv(b), pv(a)));
  if (!versions.length) die(`pypi: no wheel release of ${name} satisfies ${specs.join(' and ') || 'any version'}`);
  return versions[0];
}
async function pick(name, specs, mode = 'pure', pythonVersion = '3.11.0') {
  const proj = await pypiProject(name);
  return pickVersion(name, proj.releases, specs, mode, pythonVersion);
}

/** Locks one Python profile (`profile`: its `<profile>/requirements.in` -> `<profile>/requirements.lock`). */
async function lockPython(pythonVersion, profile = 'sde-python') {
  const mode = PROFILES[profile]?.python?.wheels;
  if (!mode) die(`${profile} is not a Python profile`);
  const env = { python_version: pythonVersion.split('.').slice(0, 2).join('.'), python_full_version: pythonVersion, os_name: 'posix',
    sys_platform: 'linux', platform_system: 'Linux', platform_machine: 'x86_64', platform_release: '', platform_version: '',
    implementation_name: 'cpython', implementation_version: pythonVersion, platform_python_implementation: 'CPython', extra: '' };
  const tops = fs.readFileSync(path.join(IMAGES, profile, 'requirements.in'), 'utf8').split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map(parseReq);
  const specs = new Map();                  // name -> [spec...]
  const why = new Map();                    // name -> [by...]
  for (const t of tops) { specs.set(t.name, [t.spec].filter(Boolean)); why.set(t.name, ['requirements.in']); }
  let chosen = new Map();
  for (let round = 0; round < 20; round++) {
    const next = new Map();
    const queue = [...specs.keys()];
    const seen = new Set();
    let changed = false;
    while (queue.length) {
      const n = queue.shift();
      if (seen.has(n)) continue; seen.add(n);
      const v = await pick(n, specs.get(n) ?? [], mode, pythonVersion);
      next.set(n, v);
      const rel = await pypiRelease(n, v);
      for (const r of rel.info.requires_dist ?? []) {
        const q = parseReq(r);
        if (q.marker && !marker(q.marker, env)) continue;
        const list = specs.get(q.name) ?? [];
        if (q.spec && !list.includes(q.spec)) { list.push(q.spec); changed = true; }
        if (!specs.has(q.name)) changed = true;
        specs.set(q.name, list);
        why.set(q.name, [...new Set([...(why.get(q.name) ?? []), `${n}==${v}`])]);
        queue.push(q.name);
      }
    }
    const stable = !changed && [...next].every(([n, v]) => chosen.get(n) === v);
    chosen = next;
    if (stable) break;
    if (round === 19) die('pypi: the resolution did not settle');
  }
  // Every chosen release must satisfy every requirement that names it (checked again, whole).
  for (const [n, v] of chosen) for (const s of specs.get(n) ?? []) if (!satisfies(v, s)) die(`pypi: ${n}==${v} does not satisfy ${s}`);
  const lines = ['# Generated by tools/nexus-lock-images.cjs from requirements.in for CPython ' + pythonVersion + ' on Linux x86_64.',
    mode === 'pure'
      ? '# Exact versions and the sha256 of each pure-Python wheel; installed with pip --require-hashes --no-deps --only-binary=:all:.'
      : `# Exact versions and the sha256 of the one wheel pip installs on the base (cp${PY_TARGET.major}${PY_TARGET.minor} manylinux ${PY_TARGET.arch}, glibc <= 2.${PY_TARGET.glibcMinor}, or pure Python); installed with pip --require-hashes --no-deps --only-binary=:all:.`,
    '# Do not edit by hand: change requirements.in and run the lock tool again.'];
  let bytes = 0;
  const versions = {};
  for (const n of [...chosen.keys()].sort()) {
    const v = chosen.get(n);
    versions[n] = v;
    const rel = await pypiRelease(n, v);
    const wheels = lockWheels(rel.urls, mode, pythonVersion);
    if (!wheels.length) die(`pypi: ${n}==${v} has no ${mode === 'pure' ? 'pure-Python wheel' : 'wheel for the pinned base'}`);
    for (const w of wheels) if (!/^[0-9a-f]{64}$/.test(String(w.digests?.sha256))) die(`pypi: ${w.filename} has no sha256`);
    bytes += wheels[0].size || 0;
    lines.push(`${n}==${v} \\`, ...wheels.map((w, i) => `    --hash=sha256:${w.digests.sha256}${i < wheels.length - 1 ? ' \\' : ''}`),
      ...(mode === 'binary' ? [`    # ${wheels[0].filename}`] : []),
      `    # via ${(why.get(n) ?? []).join(', ')}`);
  }
  fs.writeFileSync(path.join(IMAGES, profile, 'requirements.lock'), `${lines.join('\n')}\n`);
  return { versions, wheelBytes: bytes };
}

// ---------------------------------------------------------------- Dockerfiles

function pinDockerfile(profile, ref, digest, versions) {
  const f = path.join(IMAGES, profile, 'Dockerfile');
  let s = fs.readFileSync(f, 'utf8');
  const from = new RegExp(`^FROM ${ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@sha256:[0-9a-f]{64}$`, 'm');
  if (!from.test(s)) die(`${profile}: the Dockerfile has no FROM ${ref}@sha256:<digest> line`);
  s = s.replace(from, `FROM ${ref}@${digest}`);
  if (!/^ARG NEXUS_VERSIONS=".*"$/m.test(s)) die(`${profile}: the Dockerfile has no ARG NEXUS_VERSIONS line`);
  s = s.replace(/^ARG NEXUS_VERSIONS=".*"$/m, `ARG NEXUS_VERSIONS="${versions}"`);
  fs.writeFileSync(f, s);
}

/**
 * The ENV names a Dockerfile declares itself (`ENV A=1 B=2` lines, one line each): the image config carries them beside
 * the base's, so they belong in `imageEnv` (preflight refuses a container carrying a name neither the plan nor
 * `imageEnv` names). Sorted, unique. A continued (`\`) or legacy `ENV NAME value` line is refused: it would be read wrong.
 */
function dockerfileEnvNames(docker) {
  const names = [];
  for (const line of String(docker).split(/\r?\n/)) {
    const m = /^ENV\s+(.*)$/.exec(line);
    if (!m) continue;
    const body = m[1].trim();
    if (body.endsWith('\\') || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(body)) die(`a Dockerfile ENV line must be one line of NAME=value pairs: ${line}`);
    for (const mm of body.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)) names.push(mm[1]);
  }
  return [...new Set(names)].sort();
}
/** A profile's imageEnv: the base's ENV names plus the ones its Dockerfile declares (sorted, unique). */
const imageEnvOf = (baseEnv, docker) => [...new Set([...baseEnv, ...dockerfileEnvNames(docker)])].sort();

/**
 * Resolves and writes every profile, or only `only` (`--profile <id>`): then the other profiles' files are not touched
 * and their lock.json entries are copied as they are (byte for byte: the same JSON, the same key order).
 */
async function resolve(only = null) {
  if (only !== null && !PROFILES[only]) die(`--profile takes one of: ${Object.keys(PROFILES).join(', ')}`);
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { previous = null; }
  if (only !== null && !previous?.profiles) die('--profile needs an existing lock.json (run the tool without --profile first)');
  const ids = only === null ? Object.keys(PROFILES) : [only];
  console.log('[lock] resolving base images (registry metadata only; nothing is pulled)');
  const bases = {};
  for (const id of ids) {
    const p = PROFILES[id];
    let pinned = null;
    if (p.baseFrom) {
      // The same base as another profile, by its digest: resolved in this run, else as that profile is locked.
      if (PROFILES[p.baseFrom].base !== p.base) die(`${id}: baseFrom ${p.baseFrom} names another base reference`);
      pinned = bases[p.baseFrom]?.digest ?? previous?.profiles?.[p.baseFrom]?.base?.digest ?? null;
      if (!pinned) die(`${id}: ${p.baseFrom} has no locked base digest to reuse`);
    }
    bases[id] = inspectBase(p.base, pinned);
    console.log(`[lock]   ${id}: ${p.base}@${bases[id].digest} (${PLATFORM} ${bases[id].platformDigest.slice(0, 19)}, ${(bases[id].compressed / 2 ** 20).toFixed(1)} MiB compressed)`);
  }
  const versions = {};
  const extra = {};
  if (ids.includes('sde-node')) {
    console.log('[lock] resolving the sde-node reporters (npm registry JSON API)');
    const npm = await lockNpm();
    console.log(`[lock]   jest-junit ${npm.versions['jest-junit']}, mocha-junit-reporter ${npm.versions['mocha-junit-reporter']} (${npm.packages} packages)`);
    const nodeVersion = bases['sde-node'].values.NODE_VERSION;
    if (!nodeVersion) die('the base images do not declare NODE_VERSION / PYTHON_VERSION');
    versions['sde-node'] = { node: nodeVersion, 'jest-junit': npm.versions['jest-junit'], 'mocha-junit-reporter': npm.versions['mocha-junit-reporter'] };
    extra['sde-node'] = npm.unpackedBytes;
  }
  for (const id of ids.filter((x) => PROFILES[x].python)) {
    const pythonVersion = bases[id].values.PYTHON_VERSION;
    if (!pythonVersion) die('the base images do not declare NODE_VERSION / PYTHON_VERSION');
    console.log(`[lock] resolving the ${id} packages for CPython ${pythonVersion} (PyPI JSON API)`);
    const py = await lockPython(pythonVersion, id);
    console.log(`[lock]   ${Object.entries(py.versions).map(([n, v]) => `${n}==${v}`).join(', ')}`);
    versions[id] = { python: pythonVersion };
    for (const n of PROFILES[id].python.label) {
      if (!py.versions[n]) die(`${id}: ${n} is named in its label but not locked (add it to ${id}/requirements.in)`);
      versions[id][n] = py.versions[n];
    }
    // Wheels are compressed: unpacked, the installed packages take about this many times their download.
    extra[id] = py.wheelBytes * (PROFILES[id].python.unpackFactor ?? 3);
  }
  if (ids.includes('nexus-fwd')) {
    const fwdDocker = fs.readFileSync(path.join(IMAGES, 'nexus-fwd', 'Dockerfile'), 'utf8');
    const socat = apkVersion(fwdDocker, 'socat');
    if (!socat) die('nexus-fwd: the Dockerfile pins no socat version');
    versions['nexus-fwd'] = { alpine: '3.20', socat };
    extra['nexus-fwd'] = 2 * 2 ** 20;
  }
  for (const id of ids) pinDockerfile(id, PROFILES[id].base, bases[id].digest, Object.entries(versions[id]).map(([k, x]) => `${k}=${x}`).join(' '));
  const lock = { version: 1, generatedBy: 'tools/nexus-lock-images.cjs', platform: PLATFORM, profiles: {} };
  for (const [id, p] of Object.entries(PROFILES)) {
    if (!ids.includes(id)) {
      if (previous?.profiles?.[id]) lock.profiles[id] = previous.profiles[id];
      continue;
    }
    const b = bases[id];
    const docker = fs.readFileSync(path.join(IMAGES, id, 'Dockerfile'), 'utf8');
    lock.profiles[id] = {
      base: { ref: p.base, repository: b.repository, digest: b.digest, platformDigest: b.platformDigest },
      baseEnv: b.env, imageEnv: imageEnvOf(b.env, docker), entrypoint: p.entrypoint,
      lockfiles: Object.fromEntries(p.lockfiles.map((rel) => [rel, fileSha(rel)])),
      contextSha256: await contextOf(id),
      // The download and the unpacked size, roughly: compressed base layers x 3, plus the pinned packages.
      estimatedBytes: Math.round(b.compressed * 3 + extra[id]),
      versions: versions[id]
    };
  }
  // The .apk pins (B7) are not resolved from the network: kept as recorded (a changed version drops its hash).
  for (const [name, pin] of Object.entries(APK_PINS)) {
    if (!ids.includes(pin.profile)) continue;
    const old = previous?.profiles?.[pin.profile]?.packages?.[name];
    const version = versions[pin.profile][name];
    lock.profiles[pin.profile].packages = { ...(lock.profiles[pin.profile].packages ?? {}),
      [name]: { version, apkSha256: old && old.version === version && typeof old.apkSha256 === 'string' ? old.apkSha256 : null } };
  }
  fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  console.log('[lock] wrote infra/images/lock.json');
  for (const id of ids) { const p = lock.profiles[id]; console.log(`[lock]   ${id}: context ${p.contextSha256}, ~${(p.estimatedBytes / 2 ** 20).toFixed(0)} MiB`); }
}

/**
 * `--rehash` (no network): after a local edit of a context file (the entry script, a Dockerfile comment), recompute the
 * lockfile hashes and each profile's contextSha256 into lock.json; everything resolved from the network stays as locked.
 */
async function rehash() {
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  for (const [id, p] of Object.entries(PROFILES)) {
    const l = lock.profiles?.[id];
    if (!l) die(`${id}: not in lock.json (run the tool without --rehash)`);
    const docker = fs.readFileSync(path.join(IMAGES, id, 'Dockerfile'), 'utf8');
    if (!docker.includes(`FROM ${l.base.ref}@${l.base.digest}`)) die(`${id}: the Dockerfile no longer pins the locked base`);
    l.lockfiles = Object.fromEntries(p.lockfiles.map((rel) => [rel, fileSha(rel)]));
    l.contextSha256 = await contextOf(id);
  }
  fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  for (const [id, p] of Object.entries(lock.profiles)) console.log(`[lock] ${id}: context ${p.contextSha256}`);
}

if (require.main === module) {
  const at = process.argv.indexOf('--profile');
  const only = at >= 0 ? (process.argv[at + 1] ?? '') : null;
  const run = process.argv.includes('--check') ? check : process.argv.includes('--rehash') ? rehash : process.argv.includes('--pin-apk') ? pinApk : () => resolve(only);
  run().catch((e) => die(e && e.stack ? e.stack : String(e)));
}

module.exports = { PROFILES, APK_PINS, PY_TARGET, apkVersion, argDefault, apkProblems, pv, pvCmp, satisfies, marker, parseReq,
  supportedTags, normalizePlatform, wheelTags, wheelRank, pythonAllowed, lockWheels, pickVersion, dockerfileEnvNames, imageEnvOf };
