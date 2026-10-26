/**
 * The runner utilityProcess entry (B2a Task 11), built to `out/main/runner.js`. It binds RunnerCore to the MessagePort
 * main transfers through `process.parentPort` (the only Electron API used here, and only here); it opens no database.
 * The Docker CLI is resolved once; the image build contexts are `<resources>/images` when packaged, else the
 * repository's `infra/images`.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { RunnerCore } from './core';
import { probeAdapters } from './runtimes/registry';
import { dockerCli } from './sandbox/dockerCli';
import { DockerDriver } from './sandbox/dockerDriver';
import type { RunnerTransport } from './types';

interface PortLike {
  postMessage(msg: unknown): void;
  on(event: 'message', fn: (e: { data: unknown }) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
  start(): void;
}
interface ParentPortLike { once(event: 'message', fn: (e: { data: unknown; ports: PortLike[] }) => void): unknown }

function imagesDir(): string {
  const packaged = __dirname.includes('app.asar');
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath;
  return packaged && resources ? path.join(resources, 'images') : path.resolve(__dirname, '..', '..', 'infra', 'images');
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (!parentPort) {
  process.stderr.write('[runner] not started as a utility process\n');
  process.exit(2);
} else {
  parentPort.once('message', (e) => {
    const port = Array.isArray(e?.ports) ? e.ports[0] : undefined;
    if (!port) { process.stderr.write('[runner] no port was transferred\n'); process.exit(2); return; }
    const transport: RunnerTransport = {
      postMessage: (m) => port.postMessage(m),
      on: (_event, fn) => port.on('message', (ev) => fn(ev?.data))
    };
    const cli = dockerCli(fsp);
    const core = new RunnerCore(transport, {
      driver: new DockerDriver(cli, { now: Date.now }), now: Date.now, fs: fsp, docker: cli, imagesDir: imagesDir(),
      onShutdown: () => process.exit(0), runtimeProbe: { adapters: probeAdapters }
    });
    port.on('close', () => { void core.shutdown().finally(() => process.exit(0)); });
    port.start();
    // After `shutdown` main kills the process; until then the open port keeps it alive.
  });
}
