'use strict';
// B2b Task 16: the agent turn on REAL Docker with the pinned images (XA1-XA7). The same main, runner core and handlers as the scripted
// flows (test/nexus-platform-b2b-flows-*.test.cjs), with ScriptedRuntime standing in for the model, but the real Docker driver: what
// only Docker can show. Runs only behind the test:exec resource gate (node tools/run-exec-tests.cjs); anywhere else it prints the skip
// banner, and without Docker or the 30 GiB of free disk it prints NOT RUN and FAILS (it never counts as passed). Each title names the
// registry e2e test id of the step it proves where it proves one. ScriptedRuntime is not a real model: that is Verification V5.
// XA6 and XA6b (the real cs.tests_pass runs) are in test/nexus-exec-agent-iteration.test.cjs, so no file nears the runner's 30-minute limit.
// Estimated wall time of this file (NOT measured: Docker was not available when it was written): each test builds a world (about a minute)
// and holds a container for a minute or two, so XA1-XA5 and XA7 take 2-3 minutes each, about 15 minutes for the file.
const test = require('node:test');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const { xa } = require('./helpers/agentRealFlows.cjs');
  const LONG = { timeout: 25 * 60_000 };

  test('XA1 e2e.sde.ai-implementation the turn container passes preflight with the worktree bind and network none, and Docker\'s own record shows the isolation the plan named', LONG, () => xa.XA1());
  test('XA2 a network probe fails inside the turn container: no route and no name resolution', LONG, () => xa.XA2());
  test('XA3 the turn container sees no host path beyond /workspace', LONG, () => xa.XA3());
  test('XA4 cancel leaves nothing behind: no container, volume or network of the job, the token revoked, the worktree kept', LONG, () => xa.XA4());
  test('XA5 a restart mid-turn interrupts the job and session, and the new runner removes the container in phase B', LONG, () => xa.XA5());
  test('XA7 the worktree bind holds a planted link, which the guard refuses after sandbox_exec (worktree_guard)', LONG, () => xa.XA7());
}
