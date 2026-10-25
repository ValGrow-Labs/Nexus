'use strict';
// Small builders for ScriptedRuntime step scripts (B2b Task 11 tests): the shapes
// src/runner/runtimes/scripted.ts's `ScriptedStep` understands, kept here so a test reads as a scenario, not a
// hand-built array of op objects.

/** A turn that says `text` then ends. */
function textTurn(text) { return [{ op: 'delta', text }, { op: 'complete' }]; }

/** A turn that runs one `sandbox_exec` (the real MCP round trip) then ends. */
function execTurn(argv, o = {}) {
  return [{ op: 'call', tool: 'sandbox_exec', args: { argv, cwd: o.cwd ?? '/workspace', timeoutMs: o.timeoutMs ?? 5000 } }, { op: 'complete' }];
}

/** A turn that fails outright. */
function failTurn(message, code = 'runtime_error') { return [{ op: 'fail', code, message }]; }

module.exports = { textTurn, execTurn, failTurn };
