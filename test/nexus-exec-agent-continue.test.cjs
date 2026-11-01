'use strict';
// A new conversation continues an earlier blocked suggested change on REAL Docker (XA8): turn 1's test genuinely fails; turn 2 (a new conversation) already has
// turn 1's files and an earlier-conversation note, fixes the test, runs the tests in its container, and the change set it registers is the next version of the
// earlier one and passes its real checks. Same gate and world as test/nexus-exec-agent.test.cjs; a file of its own so none nears the runner's 30-minute limit.
const test = require('node:test');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const { xa } = require('./helpers/agentRealFlows.cjs');
  const LONG = { timeout: 25 * 60_000 };
  test('XA8 a new conversation continues the earlier blocked change: its files are there, it fixes the test, runs the tests, and the next version passes its real checks', LONG, () => xa.XA8());
}
