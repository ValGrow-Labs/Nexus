'use strict';
// Plain words, Track C: "Get this computer ready" and "Your first build" (the pure model through load-ts, plus source pins on the sheet, the
// access keys block and the approval rows). Plain node, no jsdom. What is pinned: three steps, each Done / Next / Waiting; the first step that
// is not done is the only one with something to press; nothing is claimed that is not known (Git, the starting point); no number, id or
// engineering word in the lines of the steps; the permission disclosure is two short sentences with its honest limits behind "More details".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const X = loadTs('src/renderer/src/nexus/data/executionModel.ts');
const F = loadTs('src/renderer/src/nexus/data/firstBuildModel.ts');
const G = loadTs('src/renderer/src/nexus/data/glossary.ts');
const GIB = 2 ** 30;
const NOW = 1_800_000_000_000;

const health = (o = {}) => ({
  db: { version: 10, platform: true, handoffs: true, execution: true }, registry: { valid: true, problems: 0 },
  runner: { state: 'ready', attached: true, restarts: 0 },
  docker: { state: 'running', version: '29.1.3', cpus: 8, memoryBytes: 8 * GIB },
  images: [{ profile: 'sde-node', present: true, matches: true, sizeBytes: GIB, imageIdShort: 'sha256:0123456789ab' },
    { profile: 'sde-python', present: true, matches: true, sizeBytes: GIB }, { profile: 'nexus-fwd', present: true, matches: true, sizeBytes: 4 * 2 ** 20 }],
  disk: { dataHomeFreeBytes: 52 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'ok' },
  problems: [], gpu: { detected: false, supported: false }, checkedAt: NOW, ...o
});
const missing = (profiles) => profiles.map((p) => ({ profile: p, present: false, matches: false }));
const build = (h, extra = {}) => {
  const a = X.availabilityFrom({ unavailable: null }, { ok: true, data: h });
  const rows = X.setupSheet(h, extra.ctx);
  return { a, rows, fb: F.firstBuild({ availability: a, rows, helperReady: false, ...extra.input }) };
};
const step = (fb, id) => fb.steps.find((s) => s.id === id);

test('PC1 three steps in order, each Done / Next / Waiting, named in the glossary\'s words', () => {
  const { fb } = build(health());
  assert.equal(fb.title, 'Your first build');
  assert.deepEqual(fb.steps.map((s) => s.number), [1, 2, 3]);
  assert.deepEqual(fb.steps.map((s) => s.title), ['Get this computer ready', 'Choose your AI helper', 'Save a starting point']);
  assert.equal(fb.steps[0].title, G.termName('getReady'));
  for (const s of fb.steps) assert.ok(['Done', 'Next', 'Waiting'].includes(s.word), s.id);
});

test('PC2 the first step that is not done is the only one with something to press', () => {
  // Docker stopped: step 1 is next (nothing to press from here: Docker is another program), steps 2 and 3 wait.
  const stopped = build(health({ docker: { state: 'stopped' }, problems: ['docker_stopped'] }));
  assert.deepEqual(stopped.fb.steps.map((s) => s.word), ['Next', 'Waiting', 'Waiting']);
  assert.equal(stopped.fb.current, 'computer');
  assert.equal(stopped.fb.steps.filter((s) => s.action).length, 0);
  const docker = step(stopped.fb, 'computer').items.find((i) => i.id === 'docker');
  assert.deepEqual([docker.state, docker.word], ['problem', 'Needs attention']);
  assert.match(docker.line, /Open Docker Desktop and wait until it says it is running\. Then press Check again\./);
  assert.match(step(stopped.fb, 'helper').line, /^Finish step 1 first\./);
  assert.match(step(stopped.fb, 'starting-point').line, /^Finish step 1 first\.$/);
  // Kits missing while Docker runs: ONE button asks for all of them.
  const kits = build(health({ images: missing(['sde-node', 'sde-python', 'nexus-fwd']), problems: ['image_missing:sde-node', 'image_missing:sde-python', 'image_missing:nexus-fwd'] }));
  assert.deepEqual(step(kits.fb, 'computer').action, { op: 'prepare-kits', label: 'Prepare the safe-space kits' });
  assert.equal(kits.fb.steps.filter((s) => s.action).length, 1);
  assert.equal(kits.rows.filter((r) => r.prepare).length, 3, 'the three kits are still three separate requests, each answered on its own');
  const kitItem = step(kits.fb, 'computer').items.find((i) => i.id === 'kits');
  assert.match(kitItem.line, /^3 of 3 kits are not ready\. Press “Prepare the safe-space kits”\. Nexus asks you before each download\.$/);
  // A kit already waiting for an answer: no second button, the line says where to answer.
  const asked = build(health({ images: missing(['sde-node']), problems: ['image_missing:sde-node'] }), { ctx: { pending: new Set(['sde-node']) } });
  assert.equal(step(asked.fb, 'computer').action, null);
  assert.match(step(asked.fb, 'computer').items.find((i) => i.id === 'kits').line, /Waiting for your answer below\./);
  // Ready computer, nothing chosen yet: step 2 is next and nothing is pressed from step 1 or 3.
  const ready = build(health());
  assert.deepEqual(ready.fb.steps.map((s) => s.word), ['Done', 'Next', 'Waiting']);
  assert.equal(ready.fb.current, 'helper');
  assert.equal(ready.fb.steps.filter((s) => s.action).length, 0);
  assert.equal(step(ready.fb, 'computer').line, 'This computer is ready.');
  assert.match(ready.fb.lead, /^Nexus needs three things before your AI helper can build for you\. Do step 2 now\./);
});

test('PC3 once an AI service is in use step 3 is next; it is never "done" (a starting point belongs to one project) and never claims more than is known', () => {
  const { fb } = build(health(), { input: { helperReady: true, helperLabel: 'Probe Label X' } });
  assert.deepEqual(fb.steps.map((s) => s.word), ['Done', 'Done', 'Next']);
  assert.equal(step(fb, 'helper').line, 'Your AI helper uses Probe Label X.');
  assert.equal(fb.current, 'starting-point');
  assert.equal(fb.lead, 'Your computer and your AI helper are ready. Open a project and ask for something to build.');
  const sp = step(fb, 'starting-point');
  assert.equal(sp.line, 'Nexus saves how your project looks right now, as a starting point, so it can compare later.');
  assert.match(sp.help, /hidden Nexus notes in your project: a small hidden area\. Your files and your main version are never changed\./);
  assert.match(sp.help, /Your AI helper tells you when a project needs it\./, 'honest: it is not run by itself from here');
  assert.equal(sp.action, null);
  assert.match(step(build(health(), { input: { helperReady: true, startingPointWaiting: true } }).fb, 'starting-point').line, /^Nexus is waiting for your answer about keeping hidden Nexus notes in your project\.$/);
  // Git: Nexus is only told when it is missing, so it never says "ready".
  const git = step(build(health({ docker: { state: 'stopped' }, problems: ['docker_stopped'] })).fb, 'computer').items.find((i) => i.id === 'git');
  assert.deepEqual([git.state, git.word, git.line], ['ok', 'No problem found', 'Nexus has not found a problem with Git.']);
  const noGit = build(health({ problems: ['git_missing'] }));
  const g = step(noGit.fb, 'computer').items.find((i) => i.id === 'git');
  assert.deepEqual([g.state, g.line], ['problem', 'Git is not installed. It is a free program that keeps the history of your project. Install Git, then restart Nexus.']);
  assert.equal(noGit.fb.steps[0].state, 'next');
  // AI helper work not in place at all: step 2 waits with the one sentence, and step 3 waits too.
  const off = F.firstBuild({ availability: { kind: 'ready', advisories: [] }, rows: X.setupSheet(health()), helperReady: false, helperOff: 'The AI helper is not available.' });
  assert.deepEqual(off.steps.map((s) => s.word), ['Done', 'Waiting', 'Waiting']);
  assert.equal(step(off, 'helper').line, 'The AI helper is not available.');
});

test('PC4 execution off or not read yet: step 1 says why in the notice\'s words and lists nothing to do', () => {
  const unknown = F.firstBuild({ availability: { kind: 'unknown', text: X.NOT_CHECKED, retry: false, checking: true }, rows: [], helperReady: false });
  assert.deepEqual(unknown.steps.map((s) => s.word), ['Next', 'Waiting', 'Waiting']);
  assert.equal(step(unknown, 'computer').line, X.NOT_CHECKED);
  assert.deepEqual(step(unknown, 'computer').items, []);
  const off = F.firstBuild({ availability: { kind: 'execution_off', subReason: 'held', text: 'It is off.' }, rows: [], helperReady: false });
  assert.equal(step(off, 'computer').line, 'It is off.');
});

test('PC5 no number, id, fingerprint or engineering word in the lines of the steps (the numbers stay in the rows behind More details)', () => {
  const BANNED = /sha256|sde-|nexus-fwd|\bimage\b|sandbox|\bproxy\b|\btokens?\b|child job|\bCPU|registry|lockfile|_[a-z]+|\bB2|\bjobs?\b|\bruntime\b|\bagent\b/i;
  const states = [health(), health({ docker: { state: 'stopped' }, problems: ['docker_stopped'] }), health({ docker: { state: 'missing' }, problems: ['docker_missing'] }),
    health({ docker: { state: 'running', cpus: 1, memoryBytes: 2 * GIB }, problems: ['docker_memory_low', 'docker_cpus_low'] }),
    health({ images: missing(['sde-node', 'sde-python', 'nexus-fwd']), problems: ['image_missing:sde-node'] }), health({ problems: ['git_missing'] }),
    health({ disk: { dataHomeFreeBytes: 18 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'below_required' }, problems: ['disk_low'] }),
    health({ disk: { dataHomeFreeBytes: 3 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'below_required' }, problems: ['disk_low'] }),
    health({ runner: { state: 'x', attached: false, restarts: 0 } })];
  for (const h of states) for (const input of [{ helperReady: false }, { helperReady: true, helperLabel: 'Probe Label X' }]) {
    const { fb } = build(h, { input });
    const text = [fb.title, fb.lead, ...fb.steps.flatMap((s) => [s.title, s.line, s.help, s.action?.label, ...s.items.flatMap((i) => [i.label, i.word, i.what, i.line])])].filter(Boolean).join('\n');
    // The probe-labelled name is test data; everything else Nexus words must be clean.
    assert.doesNotMatch(text.replace(/Probe Label X/g, ''), BANNED, JSON.stringify(h.problems));
    assert.doesNotMatch(text, /\d\s*%/);
  }
});

test('PC6 the rows kept for "More details" are plain too: kits named for what they are for, "Settings > Resources" named, no kit id or fingerprint', () => {
  const h = health({ docker: { state: 'running', cpus: 1, memoryBytes: 2 * GIB }, images: [{ profile: 'sde-node', present: true, matches: true, sizeBytes: GIB, imageIdShort: 'sha256:0123456789ab' }, ...missing(['sde-python', 'nexus-fwd'])], problems: [] });
  const rows = X.setupSheet(h);
  assert.deepEqual(rows.filter((r) => r.id.startsWith('image:')).map((r) => r.label), ['Safe-space kit for JavaScript (Node) projects', 'Safe-space kit for Python projects', 'Safe-space kit for trying your app']);
  assert.equal(X.PROFILE_LABEL['sde-node'], 'Safe-space kit for JavaScript (Node) projects');
  assert.equal(X.kitTitle('sde-python'), 'Prepare the safe-space kit for Python projects');
  assert.equal(X.kitTitle('whatever'), 'Prepare a safe-space kit', 'an unknown profile never prints its id');
  assert.equal(rows.find((r) => r.id === 'cpus').action, 'Open Docker Desktop and go to Settings > Resources. Give Docker more processors, then press Check again.');
  assert.doesNotMatch(rows.map((r) => `${r.label} ${r.text} ${r.action ?? ''}`).join('\n'), /sha256|sde-|nexus-fwd|\bimage\b|\bCPUs?\b|execution|runner|job/i);
});

test('PC7 the permission disclosures are two short sentences; the caps read "up to $2.00 per request, $10.00 per day"; the other limits and the honest caveats sit behind More details', () => {
  for (const d of [X.AGENT_STATE_DISCLOSURE, X.LOCAL_MODEL_DISCLOSURE, X.HOSTED_MODEL_DISCLOSURE]) {
    assert.equal(d.split('. ').length, 2, d);
    assert.doesNotMatch(d, /proxy|sandbox|token|firewall|registry|egress|\bturns?\b|\bagent\b|runtime|API/i, d);
  }
  const agent = (o = {}) => ({ state: 'ready', label: 'Hosted (Test)', version: 'presets-1', signedIn: 'unknown', flagsOk: true, kind: 'hosted-model', consent: { live: false, caps: null, hostsCount: 0, grantedAt: null },
    usageToday: { usdCents: 0, turns: 0, estimated: false }, ...o });
  const rows = X.agentSetupRows(agent(), { hosts: ['alpha.example.com:443'] });
  const consent = rows.find((r) => r.id === 'agent-consent');
  assert.equal(consent.label, 'Internet permission');
  assert.match(consent.text, /Limits: up to \$2\.00 per request, \$10\.00 per day\./);
  assert.doesNotMatch(consent.text, /\d+k|tool|child|hour/, 'no engineering terms on the row');
  assert.match(consent.more, /Other limits: 6 requests an hour and 1 at a time\./);
  assert.match(consent.more, /not a wall your computer enforces/, 'the honest caveat is kept, one click away');
  assert.match(X.PERMISSION_NOTE, /^You choose which online address the AI helper may talk to\. You can take it back at any time\. Pressing “Use this AI service” gives it\. Limits: up to \$2\.00 per request, \$10\.00 per day\.$/);
  assert.equal(X.agentSetupRows(agent({ consent: { live: true, caps: null, hostsCount: 1, grantedAt: 1 } }), { hosts: ['alpha.example.com:443'], fmt: () => '10:00' }).find((r) => r.id === 'agent-consent').text, 'Allowed at 10:00. Your AI helper may reach only alpha.example.com:443.');
  const usage = (u) => X.agentSetupRows(agent({ usageToday: u })).find((r) => r.id === 'agent-usage');
  assert.equal(usage({ usdCents: 0, turns: 0, estimated: false }).text, 'No request has started today.');
  assert.equal(usage({ usdCents: 42, turns: 3, estimated: true }).text, '3 requests started today, costing about $0.42 (Nexus’s own estimate: the AI service did not report a cost).');
});

test('PC8 source pins: the sheet is "Get this computer ready"; the checklist leads; every number sits in a closed More details; only the current step has a button', () => {
  const sheet = read('src/renderer/src/nexus/components/ExecutionSetupSheet.tsx');
  assert.match(sheet, /<h2 id="nx-xs-title" className="nx-xs__title">\{termName\('getReady'\)\}<\/h2>/);
  assert.match(sheet, /const steps = firstBuild\(\{/);
  assert.ok(sheet.indexOf('nx-fb-title') < sheet.indexOf('nx-fb__more'), 'the steps come before the numbers');
  assert.match(sheet, /<details className="nx-fb__more">/, 'More details is a closed disclosure');
  assert.doesNotMatch(sheet, /<details[^>]*\bopen\b/, 'no disclosure starts open');
  // The kit button comes only from the step (the first not-done step), never from a row of its own in the checklist.
  assert.match(sheet, /\{step\.id === 'computer' && step\.action && \(/);
  assert.match(sheet, /void prepareAll\(\)/);
  assert.equal((sheet.match(/prepareAll/g) || []).length, 2, 'defined once, used once');
  // Buttons of a waiting step are disabled.
  assert.match(sheet, /disabled=\{busy !== null \|\| way\.action\.disabled \|\| locked\}/);
  // Shown text only (string literals and JSX text): none of the old engineering words.
  const { copyItems } = require('./helpers/identityGuard.cjs');
  for (const it of copyItems(path.join(ROOT, 'src/renderer/src/nexus/components/ExecutionSetupSheet.tsx'))) {
    assert.doesNotMatch(it.text, /Execution setup|Agent runtime|Provider|Use this runtime|sandbox|images?|jobs?|agent/i, it.text);
  }
  // Where the numbers are said: the notice and Get ready button elsewhere use the glossary's name.
  for (const f of ['src/renderer/src/nexus/components/ExecutionNotice.tsx', 'src/renderer/src/nexus/project/ActionBar.tsx']) {
    assert.match(read(f), /termName\('getReady'\)/, f);
    assert.doesNotMatch(read(f), /How to set up/, f);
  }
});

test('PC9 "Add my key" lands on the keys: the full path is stated, the block comes first in Settings, scrolls into view and takes the cursor', () => {
  assert.equal(X.KEYS_PATH, 'Settings > Agents & Models > access keys');
  assert.match(X.KEY_HELP_TEXT, /Settings > Agents & Models > access keys/);
  assert.match(X.KEY_HELP_TEXT, /^To get a free access key, open the website of the AI service, sign up for free, and create a key there\./);
  const settings = read('src/renderer/src/components/SettingsModal.tsx');
  const agents = settings.slice(settings.indexOf("activeSection === 'Agents & Models'"));
  assert.ok(agents.indexOf('<HostedKeysSettings />') > 0 && agents.indexOf('<HostedKeysSettings />') < agents.indexOf('Default model for AI helpers'), 'the access keys are first');
  const keys = read('src/renderer/src/components/HostedKeysSettings.tsx');
  assert.match(keys, /export function requestKeysFocus\(\): void/);
  assert.match(keys, /box\.current\?\.scrollIntoView\?\.\(\{ block: 'start' \}\)/);
  assert.match(keys, /document\.getElementById\(`hosted-key-\$\{first\.id\}`\)\?\.focus\(\)/);
  assert.match(keys, /\{KEYS_PATH\}/, 'the block says where it is');
  assert.doesNotMatch(keys, /AI provider keys|API key/);
});

test('PC10 the approval rows: "Allow once" / "Do not allow" (never "Approve once" / "Deny"), a confirmation that promises no more than it does, More details closed', () => {
  const ap = read('src/renderer/src/nexus/project/ApprovalsSection.tsx');
  assert.match(ap, /<span>Allow once<\/span>/);
  assert.match(ap, /'Do not allow'/);
  assert.match(ap, /<p>Allow this one time\? It covers only what is listed above\.<\/p>/);
  assert.doesNotMatch(ap, /Approve once|'Deny'|approve once|for this request only/);
  assert.match(ap, /<details className="nx-xq__more">\s*<summary>More details<\/summary>/);
  assert.doesNotMatch(ap, /<details[^>]*\bopen\b/);
  assert.equal(G.termName('allowOnce'), 'Allow once');
  const am = read('src/renderer/src/nexus/project/actionModel.ts');
  assert.match(am, /answers: \('Allow once' \| 'Do not allow'\)\[\]/);
});
