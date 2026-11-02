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
  // The checklist has nothing on it yet: like Tasks, its icon shows only while that page is the one open (its route stays).
  assert.match(rail, /\(r\.tool !== 'completion' \|\| tool === 'completion'\)/);
  assert.ok(loadTs('src/renderer/src/nexus/router/routes.ts').PROJECT_TOOLS.includes('completion'), 'the checklist page and its route still exist');
  const bench = src('src/renderer/src/nexus/project/ProjectBench.tsx');
  assert.match(bench, /See all tasks/);
  assert.match(bench, /tool: 'runs' \}\); \}\}>See all tasks/, 'Details opens the task list');
  const { PROJECT_TOOLS } = loadTs('src/renderer/src/nexus/router/routes.ts');
  assert.ok(PROJECT_TOOLS.includes('runs'), 'the page and its route still exist');
  assert.match(src('src/renderer/src/nexus/runs/RunsIndicator.tsx'), /tool: 'runs'/, 'a running request still links to it');
  assert.match(src('src/renderer/src/nexus/intent/IntentLine.tsx'), /tool: 'runs'/);
});

test('TR2 a Machine learning project has no code editor, no terminal and no Try it in its rail; every other project keeps them', () => {
  const rail = src('src/renderer/src/nexus/project/ToolRail.tsx');
  assert.match(rail, /codeTools = true/, 'the default keeps the editor and the terminal');
  assert.match(rail, /\{codeTools && \(<>[\s\S]*openIde\(rootPath\)[\s\S]*onOpenTerminal[\s\S]*<\/>\)\}/, 'the editor and the terminal are inside the one switch');
  const bench = src('src/renderer/src/nexus/project/ProjectBench.tsx');
  assert.match(bench, /const isMl = .*r\.isPrimary && r\.workspaceId === 'ml'/, 'only a project whose main kind of work is Machine learning');
  assert.match(bench, /canTry=\{hasSde && !card && !isMl\} codeTools=\{!isMl\}/);
});

test('TR3 Details is a symbol in the rail (with a name for tools that read it), not a word', () => {
  const bench = src('src/renderer/src/nexus/project/ProjectBench.tsx');
  assert.match(bench, /className="nx-rail__item" title="Details" aria-label="Details".*?><Icon name="panel" size=\{17\} \/><\/button>/);
  assert.ok(!/>Details<\/button>/.test(bench), 'no word-button called Details in the rail');
});
