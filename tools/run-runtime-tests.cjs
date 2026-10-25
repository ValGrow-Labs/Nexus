#!/usr/bin/env node
'use strict';
// B2b Task 13: the `test:runtime` gate. It runs the AgentRuntime contract tests:
//   1. test/runtime-scripted-contract.test.cjs (SR1-SR3): the ScriptedRuntime, no CLI needed;
//   2. test/runtime-cli-contract.test.cjs (CR0-CR15): the CLI agent adapter, with the installed CLI run ONLY inside the
//      Task 0 harness (fake home, fake key, loopback mock model, deny-all proxy; decision D-B12). It never touches the
//      user's home, login or CLI store, and never the network.
//
// Exit 0: everything ran and passed. Exit 1: a test failed. Exit 3: NOT RUN: the agent CLI is not installed, so the
// CLI contract could not be checked (the scripted part still runs and its result is reported first).
// Set NEXUS_AGENT_CLI to a native executable path to test a CLI that is not on PATH.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const H = require(path.join(ROOT, 'test', 'helpers', 'agentHarness.cjs'));

function runNode(files) {
  const r = spawnSync(process.execPath, ['--test', ...files.map((f) => path.join(ROOT, f))], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  return r.status ?? 1;
}

function main() {
  const scripted = runNode(['test/runtime-scripted-contract.test.cjs']);
  if (scripted !== 0) { console.error('test:runtime FAILED: the ScriptedRuntime contract (SR1-SR3).'); return 1; }
  const cli = H.resolveCli();
  if (!cli) {
    console.error('test:runtime NOT RUN: the agent CLI is not installed, so the CLI contract (CR0-CR15) was not checked. The scripted contract (SR1-SR3) passed.');
    return 3;
  }
  console.log(`test:runtime: running the CLI contract against ${path.basename(cli)} inside the fake-home harness only.`);
  const code = runNode(['test/runtime-cli-contract.test.cjs']);
  if (code !== 0) { console.error('test:runtime FAILED: the CLI contract (CR0-CR15).'); return 1; }
  console.log('test:runtime passed: SR1-SR3 and CR0-CR15.');
  return 0;
}

process.exitCode = main();
