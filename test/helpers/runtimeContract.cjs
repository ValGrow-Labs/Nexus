'use strict';
// The AgentRuntime event contract (B2b Task 13), shared by the ScriptedRuntime tests (SR1-SR3) and the CLI adapter
// tests (CR*): what any runtime's event stream must look like, whatever sits behind the interface.
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');

const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'toolCalls'];

/** Collects a runtime's events for one turn (the iterable ends after its terminal event). */
async function collect(runtime, req, signal = new AbortController().signal) {
  const events = [];
  for await (const e of runtime.start(req, signal)) events.push(e);
  return events;
}

/**
 * - the first event is `run.started`, and there is exactly one terminal event, the last one;
 * - `usage` is cumulative: no field ever goes down;
 * - every `tool.completed` answers an earlier `tool.started` of the same callId;
 * - every event is well-formed under the runner protocol's own parser (`attempt.runtime`).
 */
function assertRuntimeContract(events, { terminal } = {}) {
  assert.ok(events.length >= 2, 'at least a start and an end');
  assert.equal(events[0].t, 'run.started');
  const terminals = events.filter((e) => TERMINAL.has(e.t));
  assert.equal(terminals.length, 1, `exactly one terminal event, saw ${terminals.map((e) => e.t)}`);
  assert.equal(events[events.length - 1], terminals[0], 'the terminal event is the last');
  if (terminal) assert.equal(terminals[0].t, terminal);
  let prev = null;
  for (const e of events.filter((x) => x.t === 'usage')) {
    if (prev) for (const f of USAGE_FIELDS) assert.ok(e[f] >= prev[f], `usage.${f} went down: ${prev[f]} -> ${e[f]}`);
    prev = e;
  }
  const started = new Set();
  for (const e of events) {
    if (e.t === 'tool.started') started.add(e.callId);
    if (e.t === 'tool.completed') assert.ok(started.has(e.callId), `tool.completed ${e.callId} has no tool.started`);
  }
  const { parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');
  const ATTEMPT = '0'.repeat(26);
  events.forEach((event, i) => assert.ok(parseRunnerMessage({ op: 'attempt.runtime', attemptId: ATTEMPT, seq: i + 1, event }), `event ${i} (${event.t}) parses: ${JSON.stringify(event).slice(0, 200)}`));
}

module.exports = { collect, assertRuntimeContract, TERMINAL };
