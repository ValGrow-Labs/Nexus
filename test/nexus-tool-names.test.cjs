'use strict';
// The steps of a conversation keep the name the program wrote: Nexus's own tools are lower case (`sandbox_exec`), the AI program's own start with a
// capital (`Read`, `Edit`, `Glob`). A capitalised plain name must reach the screen (so it reads "Writing a file"), not be replaced by a generic word;
// anything that is not a plain name still is. Plain node (the pure view and the pure labels, through load-ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const D = loadTs('src/main/nexusIpc/dto.ts');
const A = loadTs('src/renderer/src/nexus/agent/agentModel.ts');

const detail = (tools) => ({ id: 's1', projectId: 'p1', workspaceId: 'w1', status: 'running', turns: 1, liveJobId: null, createdAt: 1, updatedAt: 2,
  turnHistory: [], messages: [], versions: [], approvals: [], continuesFrom: null,
  toolCalls: tools.map((tool, n) => ({ seq: n + 1, ts: n + 1, jobId: 'j1', tool, ok: true, resultBytes: null })) });

test('TN1 a capitalised plain tool name reaches the screen and reads in plain words; a name that is not plain is replaced', () => {
  const names = ['sandbox_exec', 'mcp__nexus__context_get', 'Read', 'Glob', 'Edit', 'Write', 'ToolSearch', 'bad name', '<script>', '', '9lives', 'x'.repeat(80)];
  const out = D.sessionDetailView(detail(names)).toolCalls.map((c) => c.tool);
  assert.deepEqual(out, ['sandbox_exec', 'mcp__nexus__context_get', 'Read', 'Glob', 'Edit', 'Write', 'ToolSearch', 'tool', 'tool', 'tool', 'tool', 'tool']);
  const said = out.slice(0, 7).map((t) => A.toolLabel(t));
  assert.deepEqual(said, ['Running a command in the safe space', 'Reading the details of your request', 'Reading a file', 'Looking at the project’s files',
    'Writing a file', 'Writing a file', 'Getting its tools ready']);
  assert.ok(said.every((w) => w !== 'A step'));
});
