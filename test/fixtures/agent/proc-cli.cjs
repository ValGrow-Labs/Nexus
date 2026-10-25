'use strict';
// The process stand-in for src/runner/runtimes/registry.ts's `CliAgentRuntime` (B2b Task 11; its wire is the registry's
// own newline-delimited JSON `RuntimeEvent`s on stdout). It gives the process-tree tests (AT7, AT8, AT17, I2) a real,
// killable OS process with no engine protocol involved. (The real CLI adapter's own stand-in is fake-cli.cjs.)
//
//   (default)                    prints `run.started`, then idles until killed
//   PROC_CLI_QUICK=1             prints a message and `run.completed`, then exits
//   PROC_CLI_COMPLETE_HANG=1     prints `run.completed`, then stays alive anyway (a CLI that hangs on exit)
const emit = (ev) => { try { process.stdout.write(`${JSON.stringify(ev)}\n`); } catch { /* the pipe may already be gone */ } };

emit({ t: 'run.started', runRef: 'proc-cli-run', at: Date.now() });

if (process.env.PROC_CLI_QUICK === '1') {
  emit({ t: 'message.delta', text: 'done' });
  emit({ t: 'run.completed', at: Date.now(), stopReason: 'end_turn' });
  process.exit(0);
}
if (process.env.PROC_CLI_COMPLETE_HANG === '1') emit({ t: 'run.completed', at: Date.now(), stopReason: 'end_turn' });

// Never returns on its own; SIGKILL (via taskkill /F) is the only way out.
setInterval(() => { /* kept alive */ }, 0x7fffffff);
