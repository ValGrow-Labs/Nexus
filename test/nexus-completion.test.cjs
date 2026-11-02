'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { parseHash, formatRoute, PROJECT_TOOLS } = loadTs('src/renderer/src/nexus/router/routes.ts');
const { completionCopy } = loadTs('src/renderer/src/nexus/project/completionModel.ts');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

test('the plan tool is gone; old plan links open Completion', () => {
  // "Try it" joined the project tools (it runs the project as it stands, or a suggested change, in the safe space); the plan tool is still gone.
  assert.deepEqual([...PROJECT_TOOLS], ['bench', 'changes', 'completion', 'runs', 'try']);
  assert.deepEqual(parseHash('#/p/proj-1/plan'), { name: 'project', id: 'proj-1', tool: 'completion' });
  assert.equal(formatRoute({ name: 'project', id: 'proj-1', tool: 'completion' }), '#/p/proj-1/completion');
});

test('completion copy never claims anything is complete or verified', () => {
  const c = completionCopy({ domainLabel: 'Software engineering' });
  // The page says one line now (the three paragraphs were cut): the same honesty rules hold for every word it shows.
  const all = [c.title, c.badge, c.lead, ...c.facts.map((f) => `${f.label} ${f.value}`)].join(' ');
  assert.equal(c.lead, 'Nothing is tracked here yet.');
  assert.doesNotMatch(all, /\b(completed?|verified|progress|tests? pass(ed)?|confidence)\b|\d+\s*%/i);
  // C9: nothing real backs the checklist yet, so the badge says it comes later and names no phase.
  assert.equal(c.badge, 'Coming later');
  assert.equal(c.title, 'Checklist', 'the tool is called Checklist for people (the route id stays completion)');
  assert.doesNotMatch(all, /\bB\d\b|phase B/);
  assert.deepEqual(completionCopy({}).facts, [{ label: 'Workspace', value: 'Unassigned' }]);
});

test('no legacy plan execution path survives (O.9 #5)', () => {
  for (const f of walk(path.join(ROOT, 'src')).filter((f) => /\.(ts|tsx|cjs)$/.test(f))) {
    const s = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /customCmd|customVerificationCommand/, f);
    assert.doesNotMatch(s, /project:(task:(verify|execute)|complete:(next|step|contract)|plan:updateTaskStatus|gaps:reconcile|goal:reconcile)/, f);
  }
  for (const f of walk(path.join(ROOT, 'src', 'main')).filter((f) => /\.ts$/.test(f)))
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\bexecSync\b/, f);
});

test('neither the tool rail nor the project manager mounts plan panels', () => {
  assert.doesNotMatch(read('src/renderer/src/nexus/project/ToolRail.tsx'), /tool: 'plan'/);
  assert.doesNotMatch(read('src/renderer/src/project/ProjectSummaryCard.tsx'), /ProjectPlanCard|ProjectGapsCard|ProjectGoalCard|ProjectCompletionPanel|Phase 5/);
  assert.doesNotMatch(read('src/renderer/src/project/NewProjectWizardModal.tsx'), /projectGoalReconcile/);
});
