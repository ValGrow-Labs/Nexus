#!/usr/bin/env node
'use strict';
/**
 * tools/nexus-prepare-images.cjs (B2a Task 12; Verification only, after the user's go-ahead): builds the four pinned
 * sandbox images exactly as the app does, through RunnerCore's image builder (src/runner/imageBuilder.ts): the context is
 * EXACTLY `<profile>/` and `common/` of infra/images, its hash recomputed and compared with infra/images/lock.json, the
 * labels `nexus.profile` and `nexus.context-sha256`, the tag `nexus-local/<profile>:<context12>`. Prints each image's
 * local id and size. Needs the network (Docker downloads the pinned base images and the build installs the pinned
 * packages) and disk.
 *
 *   node tools/nexus-prepare-images.cjs            shows what would be built, the sizes and the free space; builds nothing
 *   node tools/nexus-prepare-images.cjs --build    checks the resource gate (>= 30 GiB free, Docker running), then builds
 *   ... --build --profile sde-node                 one profile only
 *
 * It never continues silently below the gate: it prints why and exits 3.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MessageChannel } = require('node:worker_threads');

const ROOT = path.resolve(__dirname, '..');
const IMAGES = path.join(ROOT, 'infra', 'images');
const GIB = 2 ** 30;
// ml-python (the machine learning kit) is the largest: about 1.1 GB on disk. `--profile` builds one profile only.
const PROFILES = ['sde-node', 'sde-python', 'nexus-fwd', 'ml-python'];

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  const loadTs = require(path.join(ROOT, 'test', 'load-ts.cjs'));
  const { RunnerCore } = loadTs('src/runner/core.ts');
  const { dockerCli } = loadTs('src/runner/sandbox/dockerCli.ts');
  const { DockerDriver } = loadTs('src/runner/sandbox/dockerDriver.ts');
  const { contextSha256 } = loadTs('src/runner/imageBuilder.ts');
  const { newId } = loadTs('src/main/nexus/db/ids.ts');
  const { runPreflight, REAL_PROBES } = require('./run-exec-tests.cjs');
  const lock = JSON.parse(fs.readFileSync(path.join(IMAGES, 'lock.json'), 'utf8'));
  const only = arg('--profile');
  const profiles = only ? [only] : PROFILES;
  for (const p of profiles) if (!lock.profiles[p]) { console.error(`[prepare] ${p} is not pinned in infra/images/lock.json`); return 1; }
  let total = 0;
  for (const p of profiles) {
    const l = lock.profiles[p];
    const ctx = await contextSha256(fsp, IMAGES, p);
    if (ctx !== l.contextSha256) { console.error(`[prepare] ${p}: the context changed since lock.json (${String(ctx).slice(0, 12)} != ${l.contextSha256.slice(0, 12)}); run node tools/nexus-lock-images.cjs --rehash`); return 1; }
    total += l.estimatedBytes;
    console.log(`[prepare] ${p}: FROM ${l.base.ref}@${l.base.digest}, context ${l.contextSha256.slice(0, 12)}, ~${Math.round(l.estimatedBytes / 2 ** 20)} MiB`);
  }
  // The disk part of the test:exec preflight (the same 30 GiB gate as image preparation in the app).
  const pre = runPreflight({ ...REAL_PROBES, imageLabels: () => ({ id: 'n/a', labels: {} }), lock: () => ({ profiles: {} }) });
  const blocking = pre.checks.filter((c) => !c.ok && (c.id === 'disk' || c.id === 'docker' || c.id === 'memory'));
  for (const c of blocking) console.log(`[prepare] NOT READY: ${c.notRun} ${c.action}`);
  if (!process.argv.includes('--build')) {
    console.log(`[prepare] nothing built (about ${(total / GIB).toFixed(1)} GiB to download and unpack). Run again with --build after the go-ahead.`);
    return blocking.length ? 3 : 0;
  }
  if (blocking.length) { console.log('[prepare] NOT RUN: the resource gate is not met (see above); nothing was built.'); return 3; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-prepare-'));
  const root = path.join(home, 'nexus');
  for (const d of ['objects/tmp', 'logs/jobs', 'logs/images', 'work']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const cli = dockerCli(fsp);
  const { port1, port2 } = new MessageChannel();
  const got = [];
  port1.on('message', (m) => {
    got.push(m);
    if (m.op === 'image.build.progress') process.stdout.write(`[prepare]   ${m.phase.slice(0, 160)}\n`);
  });
  const core = new RunnerCore(port2, { driver: new DockerDriver(cli, { now: Date.now }), now: Date.now, fs: fsp, docker: cli, imagesDir: IMAGES });
  port1.postMessage({ op: 'hello', bootId: newId(Date.now()), dataHome: root, home: '', profiles: [] });
  const wait = async (pred) => { for (;;) { const m = got.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 200)); } };
  await wait((m) => m.op === 'ready');
  let failed = 0;
  for (const p of profiles) {
    const buildId = newId(Date.now());
    console.log(`[prepare] building ${p} (build ${buildId})`);
    port1.postMessage({ op: 'image.build.start', buildId, profile: p, approvalId: 'tools/nexus-prepare-images.cjs', contextSha256: lock.profiles[p].contextSha256 });
    const done = await wait((m) => m.op === 'image.build.done' && m.buildId === buildId);
    if (done.outcome === 'succeeded') console.log(`[prepare] ${p}: ${done.imageId} (${(done.sizeBytes / 2 ** 20).toFixed(0)} MiB)`);
    else { failed++; console.log(`[prepare] ${p}: ${done.outcome}${done.error ? `: ${done.error}` : ''} (log: ${path.join(root, 'logs', 'images', `${buildId}.log`)})`); }
  }
  await core.shutdown();
  port1.close();
  if (!failed) fs.rmSync(home, { recursive: true, force: true });
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(`[prepare] failed: ${e && e.stack ? e.stack : e}`); process.exit(1); });
