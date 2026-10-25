/**
 * The bounded `git.read` port (B2b Task 7): main asks the runner for a status or a diff and waits for its
 * `git.read.result`, at most `timeoutMs` (default 10 s). A read writes nothing and runs as no job: no job row, no
 * attempt, no activity (the callers that show a read, Task 9's status and Task 14's diff preview, record what they need).
 *
 * The transport is a port: `send` hands a `git.read` message to the runner (false when it is not attached), and the
 * wiring passes every `git.read.result` the runner reports to `handle` (already checked by `parseRunnerMessage`). A
 * result for an unknown or expired request is dropped. A read that cannot be sent, or is not answered in time, answers
 * `{ ok: false, code: 'error' }` with a sentence; nothing waits forever and nothing throws.
 */
import type { GitReadTask } from '../../../shared/nexus/execution';
import type { GitReadResult, MainToRunner } from '../../../shared/nexus/runnerProtocol';
import { newId } from '../db/ids';

export const GIT_READ_TIMEOUT_MS = 10_000;
/** The most reads waiting at once (a burst beyond it is answered at once, never queued without bound). */
export const GIT_READ_MAX_PENDING = 32;

export interface GitReadDeps {
  send: (m: MainToRunner) => boolean;
  now: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class GitRead {
  private readonly pending = new Map<string, { resolve: (r: GitReadResult) => void; timer: unknown }>();
  constructor(private readonly deps: GitReadDeps) {}

  request(task: GitReadTask, timeoutMs: number = GIT_READ_TIMEOUT_MS): Promise<GitReadResult> {
    if (this.pending.size >= GIT_READ_MAX_PENDING) return Promise.resolve({ ok: false, code: 'error', message: 'too many git reads are waiting; try again' });
    const reqId = newId(this.deps.now());
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    return new Promise<GitReadResult>((resolve) => {
      const timer = set(() => {
        if (!this.pending.delete(reqId)) return;
        resolve({ ok: false, code: 'error', message: 'the repository did not answer in time' });
      }, Math.max(1, Math.min(timeoutMs, 60_000)));
      this.pending.set(reqId, { resolve, timer });
      let sent = false;
      try { sent = this.deps.send({ op: 'git.read', reqId, task }); } catch { sent = false; }
      if (!sent) {
        this.finish(reqId);
        resolve({ ok: false, code: 'error', message: 'the runner is not available right now' });
      }
    });
  }

  /** A `git.read.result` from the runner (parsed). Returns whether it answered a waiting read. */
  handle(m: { reqId: string; result: GitReadResult }): boolean {
    const p = this.pending.get(m?.reqId);
    if (!p) return false;
    this.finish(m.reqId);
    p.resolve(m.result);
    return true;
  }

  /** Every waiting read answers `error` (the runner went away). */
  failAll(message = 'the runner stopped before it answered'): void {
    for (const [id, p] of [...this.pending]) { this.finish(id); p.resolve({ ok: false, code: 'error', message }); }
  }

  get waiting(): number { return this.pending.size; }

  private finish(reqId: string): void {
    const p = this.pending.get(reqId);
    if (!p) return;
    this.pending.delete(reqId);
    (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(p.timer);
  }
}
