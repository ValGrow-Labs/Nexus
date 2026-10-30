'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { WORKSPACES, UNMAPPED_DOMAINS, getWorkspace, WORKSPACE_IDS } =
  loadTs('src/renderer/src/nexus/workspaces/registry.ts');
const { workspaceForDomain } = loadTs('src/renderer/src/nexus/workspaces/mapping.ts');
// projectsForWorkspace and countsByWorkspace moved to participation.ts and take an index (Task 8).
const { legacyIndex, projectsInWorkspace, countsByWorkspace: countsByIndex } = loadTs('src/renderer/src/nexus/workspaces/participation.ts');
const projectsForWorkspace = (projects, id) => projectsInWorkspace(legacyIndex(projects), projects, id).map((x) => x.project);
const countsByWorkspace = (projects) => countsByIndex(legacyIndex(projects), projects);
const { NEXUS_ICON_NAMES } = loadTs('src/renderer/src/nexus/iconNames.ts');
const { listDomainDefinitions } = loadTs('src/shared/domain.ts');

const ALL_DOMAINS = listDomainDefinitions().map((d) => d.id);

test('registry: phase A workspaces, in order, with unique ids', () => {
  assert.deepEqual(WORKSPACES.map((w) => w.id), ['sde', 'ml', 'dl', 'data', 'research', 'qa', 'uiux', 'devops']);
  assert.equal(new Set(WORKSPACES.map((w) => w.id)).size, WORKSPACES.length);
  assert.deepEqual([...WORKSPACE_IDS].sort(), WORKSPACES.map((w) => w.id).sort());
});

test('registry: every DomainId is mapped to exactly one workspace or explicitly unmapped', () => {
  for (const d of ALL_DOMAINS) {
    const owners = WORKSPACES.filter((w) => w.domainIds.includes(d));
    const unmapped = UNMAPPED_DOMAINS.includes(d);
    assert.ok(owners.length + (unmapped ? 1 : 0) === 1, `${d}: owners=${owners.map((w) => w.id)} unmapped=${unmapped}`);
  }
  for (const w of WORKSPACES) for (const d of w.domainIds) assert.ok(ALL_DOMAINS.includes(d), `${w.id} lists unknown domain ${d}`);
});

test('registry: defaultDomainId is one of the workspace domains', () => {
  for (const w of WORKSPACES) if (w.defaultDomainId) assert.ok(w.domainIds.includes(w.defaultDomainId), w.id);
});

test('registry: icons are known; copy fields are non-empty', () => {
  for (const w of WORKSPACES) {
    assert.ok(NEXUS_ICON_NAMES.includes(w.icon), `${w.id} icon ${w.icon}`);
    for (const k of ['label', 'name', 'tagline', 'description']) assert.ok(w[k] && w[k].trim(), `${w.id}.${k}`);
  }
});

test('registry: no launcher-scene fields remain', () => {
  for (const w of WORKSPACES) {
    const known = ['id', 'label', 'name', 'tagline', 'description', 'icon', 'hueSlot', 'domainIds', 'defaultDomainId', 'order', 'plannedModules'];
    assert.deepEqual(Object.keys(w).filter((k) => !known.includes(k)), [], `${w.id} has fields outside the config`);
    assert.equal('hue' in w, false);
    assert.ok(Array.isArray(w.plannedModules) && w.plannedModules.length > 0, `${w.id} has vocabulary`);
  }
});

test('getWorkspace: known id → config, unknown → null', () => {
  // The short names people read are the plain words (the glossary's WORKSPACE_PLAIN_NAMES), never SDE / ML / DL / QA.
  assert.equal(getWorkspace('ml').label, 'Machine learning');
  assert.deepEqual(['sde', 'ml', 'dl', 'qa'].map((id) => getWorkspace(id).label), ['Software', 'Machine learning', 'Deep learning', 'Testing']);
  for (const w of WORKSPACES) assert.doesNotMatch(`${w.label} ${w.name}`, /\b(SDE|ML|DL|QA)\b/, w.id);
  assert.equal(getWorkspace('nope'), null);
  assert.equal(getWorkspace(''), null);
});

test('workspaceForDomain: mapped, unmapped and unknown domains', () => {
  assert.equal(workspaceForDomain('ai-ml').id, 'ml');
  assert.equal(workspaceForDomain('web-app-dev').id, 'sde');
  assert.equal(workspaceForDomain('cybersecurity'), null);
  assert.equal(workspaceForDomain('nope'), null);
  assert.equal(workspaceForDomain(undefined), null);
});

test('projectsForWorkspace / countsByWorkspace use only real projects', () => {
  const projects = [
    { id: 'a', domainId: 'ai-ml' }, { id: 'b', domainId: 'ai-ml' },
    { id: 'c', domainId: 'web-app-dev' }, { id: 'd', domainId: 'cybersecurity' }, { id: 'e', domainId: 'zzz' }
  ];
  assert.deepEqual(projectsForWorkspace(projects, 'ml').map((p) => p.id), ['a', 'b']);
  assert.deepEqual(projectsForWorkspace(projects, 'qa'), []);
  const counts = countsByWorkspace(projects);
  assert.equal(counts.ml, 2);
  assert.equal(counts.sde, 1);
  assert.equal(counts.qa, 0);
  assert.equal(Object.keys(counts).length, WORKSPACES.length);
});
