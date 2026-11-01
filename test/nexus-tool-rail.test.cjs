'use strict';
// The task list is engine output a person rarely needs: it is not an icon in the project's tool rail (unless it is the page being shown), it is one press away
// in Details, and a running request still links to it. The page itself and its route are unchanged. Source pins, plain node.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

test('TR1 Tasks is out of the rail unless shown; it is in Details; the route and the running-request links stay', () => {
  const rail = src('src/renderer/src/nexus/project/ToolRail.tsx');
  assert.match(rail, /\(r\.tool !== 'runs' \|\| tool === 'runs'\)/, 'the Tasks icon only shows while that page is the one open');
  for (const t of ['bench', 'changes', 'completion', 'try']) assert.ok(rail.includes(`tool: '${t}'`), `${t} is still in the rail`);
  const bench = src('src/renderer/src/nexus/project/ProjectBench.tsx');
  assert.match(bench, /See all tasks/);
  assert.match(bench, /tool: 'runs' \}\); \}\}>See all tasks/, 'Details opens the task list');
  const { PROJECT_TOOLS } = loadTs('src/renderer/src/nexus/router/routes.ts');
  assert.ok(PROJECT_TOOLS.includes('runs'), 'the page and its route still exist');
  assert.match(src('src/renderer/src/nexus/runs/RunsIndicator.tsx'), /tool: 'runs'/, 'a running request still links to it');
  assert.match(src('src/renderer/src/nexus/intent/IntentLine.tsx'), /tool: 'runs'/);
});
