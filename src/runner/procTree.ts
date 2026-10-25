/**
 * The runner's own process trees (B2b Task 11, F13): the host OS process an agent turn's runtime adapter spawns (a
 * `cli-agent` runtime runs the agent's own CLI on the host; `sandbox_exec` itself always runs inside the turn's
 * container, through the driver, never here). Every live tree is recorded to a pidfile under `<dataHome>/pids/` the
 * moment it is spawned, so a runner crash leaves evidence a later `hello` can clean up:
 *
 * - `record`: one pidfile per spawned process, `{ jobId, pid, imageName, mainBootId, runnerPid }`.
 * - `killRecorded(currentMainBootId)`: runs at `hello`. A pidfile from THIS main boot (main is the same app session;
 *   only the runner utilityProcess crashed and was respawned) is killed and its pidfile removed. A pidfile from
 *   ANOTHER main boot (main itself restarted) is only deleted: its process is never touched. Such an orphan is inert
 *   — its proxy port, MCP port and capability token all died with the old runner, so it can reach nothing.
 * - `shutdownTrees`: app quit (or a deliberate "end everything"). Kills every tree this runner instance still tracks.
 * - `kill`: a single turn's own cancel (or its natural end): kills (or just forgets, see `forget`) one tracked tree.
 *
 * The only new program this file spawns is Windows' own `taskkill.exe`, by its resolved absolute path, never a shell,
 * with a fixed argv that includes an IMAGENAME filter: a PID recycled by an unrelated process after the tracked one
 * exited is never killed (the filter must still match before taskkill acts).
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { ensureDirUnder, errCode } from './paths';
import type { RunnerFs } from './types';

/** What `record` is given about one spawned process. */
export interface ProcRecord { jobId: string; pid: number; imageName: string; mainBootId: string; runnerPid: number }
interface PidFile extends ProcRecord { at: number }

const PID_RE = /^[1-9][0-9]{0,9}$/;
/** An executable's file name as Windows reports it (`node.exe`, `electron.exe`, ...): letters, digits, space, `._-`. */
const IMAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;
const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const PID_FILE_RE = /^([1-9][0-9]*)\.json$/;

/** Windows' `taskkill.exe`, by its file name only (the runner never launches anything else under this path). */
export function isTaskkillBinary(bin: string): boolean {
  if (typeof bin !== 'string' || bin.length === 0 || bin.includes('\0') || !path.isAbsolute(bin)) return false;
  return path.basename(bin).toLowerCase() === 'taskkill.exe';
}

/** `%SystemRoot%\System32\taskkill.exe` (or `%windir%`, or `C:\Windows` as a last resort). */
export function defaultTaskkillBin(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'taskkill.exe');
}

/**
 * `taskkill /PID <pid> /T /F /FI "IMAGENAME eq <imageName>"`: the whole tree, forced, only while the image name still
 * matches what was recorded. Never throws; a bad input or a launch failure resolves quietly (best-effort cleanup).
 */
export function killProcessTree(pid: number, imageName: string, taskkillBin: string = defaultTaskkillBin()): Promise<void> {
  return new Promise((resolve) => {
    if (!isTaskkillBinary(taskkillBin) || !PID_RE.test(String(pid)) || !IMAGE_NAME_RE.test(imageName)) { resolve(); return; }
    try {
      const child = spawn(taskkillBin, ['/PID', String(pid), '/T', '/F', '/FI', `IMAGENAME eq ${imageName}`],
        { windowsHide: true, shell: false, stdio: 'ignore' });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    } catch { resolve(); }
  });
}

export interface ProcTreeDeps {
  fs: RunnerFs;
  /** The data home root (pidfiles live under `<root>/pids`; folders are created one step at a time, never through a link). */
  root: string;
  /** Overridden in tests only; production always uses `defaultTaskkillBin()`. */
  taskkillBin?: string;
  log?: (line: string) => void;
}

export class ProcTree {
  private readonly dir: string;
  private readonly live = new Map<number, PidFile>();

  constructor(private readonly o: ProcTreeDeps) { this.dir = path.join(o.root, 'pids'); }

  private file(pid: number): string { return path.join(this.dir, `${pid}.json`); }

  /** Writes a pidfile for a newly spawned process. Best-effort: a write failure is logged, never thrown. */
  async record(r: ProcRecord): Promise<void> {
    if (!PID_RE.test(String(r.pid)) || !ID_RE.test(r.jobId) || !ID_RE.test(r.mainBootId) || !IMAGE_NAME_RE.test(r.imageName) || !PID_RE.test(String(r.runnerPid))) {
      return;
    }
    const rec: PidFile = { jobId: r.jobId, pid: r.pid, imageName: r.imageName, mainBootId: r.mainBootId, runnerPid: r.runnerPid, at: Date.now() };
    this.live.set(r.pid, rec);
    try {
      if (!(await ensureDirUnder(this.o.fs, this.o.root, this.dir))) return;
      await this.o.fs.writeFile(this.file(r.pid), JSON.stringify(rec), 'utf8');
    } catch (e) { this.o.log?.(`[runner] a process pidfile was not written: ${String((e as Error)?.message ?? e)}`); }
  }

  /** The process ended on its own, or was already killed deliberately: forget it (no kill). */
  async forget(pid: number): Promise<void> {
    this.live.delete(pid);
    try { await this.o.fs.unlink(this.file(pid)); } catch { /* already gone */ }
  }

  /** Kills `pid`'s whole tree and forgets it (a turn's own cancel, or ending it early). */
  async kill(pid: number, imageName: string): Promise<void> {
    await killProcessTree(pid, imageName, this.o.taskkillBin);
    await this.forget(pid);
  }

  /**
   * At `hello`: a pidfile from `currentMainBootId` is killed then removed (a runner crash within this main boot);
   * a pidfile from another main boot is only removed, its process never touched.
   */
  async killRecorded(currentMainBootId: string): Promise<void> {
    let names: string[];
    try { names = await this.o.fs.readdir(this.dir); } catch (e) {
      if (errCode(e) !== 'ENOENT') this.o.log?.(`[runner] pidfiles could not be listed: ${String((e as Error)?.message ?? e)}`);
      return;
    }
    for (const name of names) {
      const m = PID_FILE_RE.exec(name);
      if (!m) continue;
      const file = path.join(this.dir, name);
      let rec: PidFile | null = null;
      try { rec = JSON.parse(await this.o.fs.readFile(file, 'utf8')) as PidFile; } catch { rec = null; }
      const pid = Number(m[1]);
      if (rec && typeof rec.mainBootId === 'string' && rec.mainBootId === currentMainBootId
        && PID_RE.test(String(rec.pid)) && rec.pid === pid && IMAGE_NAME_RE.test(rec.imageName)) {
        await killProcessTree(rec.pid, rec.imageName, this.o.taskkillBin);
      }
      try { await this.o.fs.unlink(file); } catch { /* already gone */ }
      this.live.delete(pid);
    }
  }

  /** App quit (or ending every agent process this runner holds): kills every tree still tracked, then forgets it. */
  async shutdownTrees(): Promise<void> {
    for (const [pid, rec] of [...this.live]) {
      await killProcessTree(pid, rec.imageName, this.o.taskkillBin);
      this.live.delete(pid);
      try { await this.o.fs.unlink(this.file(pid)); } catch { /* already gone */ }
    }
  }
}
