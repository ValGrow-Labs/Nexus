'use strict';
// The test CLI stand-in (B2b Task 11): src/runner/runtimes/registry.ts's `cli-agent` runtime spawns it in place of a
// real engine's CLI — `process.execPath`, `ELECTRON_RUN_AS_NODE=1`, this script's path, the turn's config dir as the
// only argv. It prints newline-delimited JSON `RuntimeEvent`s on stdout (the registry's own wire format, not any real
// CLI's), so the process-tree tests (AT7, AT8, AT17) have a real, killable OS process to exercise, with no real agent
// CLI protocol involved at all.
//
// `FAKE_CLI_QUICK=1` ends the turn immediately (`run.completed`); otherwise it idles forever (until killed), the
// shape a cancel, a runner crash's pidfile cleanup, or an app-quit shutdown all need something real to act on.
const emit = (ev) => { try { process.stdout.write(`${JSON.stringify(ev)}\n`); } catch { /* the pipe may already be gone */ } };

emit({ t: 'run.started', runRef: 'fake-cli-run', at: Date.now() });

if (process.env.FAKE_CLI_QUICK === '1') {
  emit({ t: 'message.delta', text: 'done' });
  emit({ t: 'run.completed', at: Date.now(), stopReason: 'end_turn' });
  process.exit(0);
}

// Never returns on its own; SIGKILL (via taskkill /F) is the only way out.
setInterval(() => { /* kept alive */ }, 0x7fffffff);
