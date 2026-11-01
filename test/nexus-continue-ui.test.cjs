'use strict';
// "Continuing from your earlier suggested changes: <title>": one plain line on the building page and in the dock, only when the conversation really started that way; no ids.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('CU1 the line is plain, has the title and no id; none without a continuation', () => {
  const { continuingLine } = loadTs('src/renderer/src/nexus/agent/agentModel.ts');
  assert.equal(continuingLine({ continuesFrom: { title: 'Weather module' } }), 'Continuing from your earlier suggested changes: Weather module');
  assert.equal(continuingLine({ continuesFrom: { title: 'Fix 01HZZZZZZZZZZZZZZZZZZZZZZZ now' } }), 'Continuing from your earlier suggested changes: Fix now', 'an id is removed');
  for (const none of [null, undefined, {}, { continuesFrom: null }, { continuesFrom: { title: '  ' } }]) assert.equal(continuingLine(none), null);
});

test('CU2 both places show it; the conversation view carries the title only (no ids), read from main\'s records', () => {
  assert.match(read('src/renderer/src/nexus/agent/AgentPanel.tsx'), /continuingLine\(detail\.data\) && <p className="nx-ag__hint" data-continuing="true">/);
  assert.match(read('src/renderer/src/nexus/agent/BuildStage.tsx'), /continuingLine\(detail\.data\) && <p className="nx-build__next" data-continuing="true">/);
  assert.match(read('src/shared/nexus/ipc.ts'), /continuesFrom\?: \{ title: string \} \| null;/);
  const svc = read('src/main/nexus/agents/agentService.ts');
  assert.match(svc, /private continuedTitle\(sessionId: string, first: JobRow \| undefined\)/);
  assert.match(svc, /wt\.b === cont\.commit \? \{ title: cont\.title \} : null/, 'said only when the working copy really started from that change');
});
