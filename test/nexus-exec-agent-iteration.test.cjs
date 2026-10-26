'use strict';
// B2b Task 16 (fix round 1): XA6 and XA6b, the real cs.tests_pass runs, in a file of their own so that no single real-Docker file nears the
// test:exec runner's 30-minute per-file limit (tools/run-exec-tests.cjs FILE_TIMEOUT_MS). Same gate, same world as test/nexus-exec-agent.test.cjs.
// Estimated wall time (NOT measured: Docker was not available when this was written): each test builds a world (a snapshot and the consent,
// about a minute) and runs two turns whose change sets each start a real discovery container and a real test container (a few minutes each
// on the pinned images), so about 8-12 minutes per test and 16-24 minutes for the file: under the limit with a margin, which is why the
// two tests are not merged with the six of the other file (about 15 minutes). ScriptedRuntime is not a real model (Verification V5).
const test = require('node:test');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const { xa } = require('./helpers/agentRealFlows.cjs');
  const LONG = { timeout: 25 * 60_000 };

  test('XA6 e2e.sde.iteration cs.tests_pass fails on a real failing node:test, then passes on the iteration that fixes it (v2 derived from v1)', LONG, () => xa.XA6('node'));
  test('XA6b cs.tests_pass fails on a real failing pytest, then passes on the iteration that fixes it (v2 derived from v1)', LONG, () => xa.XA6('python'));
}
