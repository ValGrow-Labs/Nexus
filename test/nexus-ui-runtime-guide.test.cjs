'use strict';
// Track D: the first-run guide "Choose your AI helper" (step 2 of "Your first build" in "Get this computer ready") (the pure model, through load-ts) and source pins on where it is shown
// (the execution setup sheet) and on the agent panel's pointer to it. Plain node, no jsdom. Free first; no vendor, provider or address in
// Nexus-owned code: the provider labels and the program's label are the probe's own (here: invented test labels).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const G = loadTs('src/renderer/src/nexus/data/runtimeGuideModel.ts');
const X = loadTs('src/renderer/src/nexus/data/executionModel.ts');
const E = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
const A = loadTs('src/renderer/src/nexus/agent/agentModel.ts');

const VENDOR = /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-|ollama|qwen|llama|groq|gemini|google/i;
const HOSTLIKE = /\b[a-z0-9-]+(\.[a-z0-9-]+)+:\d{2,5}\b|https?:\/\/|www\.|\bapi\.[a-z]+\.[a-z]+/i;

const opt = (o = {}) => ({ kind: 'cli-agent', label: 'Test Engine', version: '1', state: 'ready', signedIn: 'yes', selected: false, models: null, model: null, problem: null, hosts: ['cli.example.com:443'], ...o });
const local = (o = {}) => opt({ kind: 'local-model', label: 'Local model (Test)', version: null, signedIn: 'yes', models: [{ name: 'coder:7b', tools: true }], model: null, problem: 'model_not_chosen', hosts: ['127.0.0.1:11434'], ...o });
const hosted = (o = {}) => opt({ kind: 'hosted-model', label: 'Hosted models (Test)', version: null, models: null, model: null, problem: null, provider: null, hosts: ['one.example.com:443', 'two.example.com:443'],
  providers: [{ id: 'one', label: 'Provider One', hosts: ['one.example.com:443'], models: [{ name: 'fast', tools: true }, { name: 'plain', tools: false }], keyPresent: false },
    { id: 'two', label: 'Provider Two', hosts: ['two.example.com:443'], models: [{ name: 'big', tools: true }], keyPresent: false }], ...o });
const view = (runtimes, live = false, extra = {}) => ({ state: 'ready', runtimes, consent: { live, caps: null, hostsCount: 0, grantedAt: null, hosts: [] }, ...extra });
const guideOf = (v, memory = {}) => G.runtimeGuide(v, X.runtimeChoices(v, memory.models ?? {}, null, memory.providers ?? {}));
const way = (g, id) => g.ways.find((w) => w.id === id);
const withKey = (id) => (h) => ({ ...h, providers: h.providers.map((p) => (p.id === id ? { ...p, keyPresent: true } : p)) });

test('RG1 the guide is shown only while no permission is granted (and agent work is not off); free first, always three ways', () => {
  assert.equal(G.runtimeGuide(view([opt(), local(), hosted()], true), []), null, 'a live permission: the picker, not the guide');
  assert.equal(G.runtimeGuide(view([opt(), local(), hosted()], false, { state: 'off' }), []), null, 'agent work off: nothing to choose');
  const g = guideOf(view([opt(), local(), hosted()]));
  assert.equal(g.title, 'Choose your AI helper');
  assert.deepEqual(g.ways.map((w) => w.id), ['hosted', 'local', 'program'], 'free ways first, the paid one last, whatever order the probe listed them');
  assert.deepEqual(g.ways.map((w) => w.free), [true, true, false]);
  assert.match(g.ways[0].title, /^Free online AI \(needs a free access key\)$/);
  assert.match(g.ways[1].title, /^AI on this computer \(free, private\)$/);
  assert.match(g.ways[2].title, /optional/i);
  // Before anything was read: the same three ways, all "not checked", and a line that Nexus is reading.
  const waiting = G.runtimeGuide(null, []);
  assert.deepEqual(waiting.ways.map((w) => w.state), ['unchecked', 'unchecked', 'unchecked']);
  assert.equal(waiting.note, G.GUIDE_READING);
  assert.equal(g.note, G.GUIDE_NONE_YET);
  assert.ok(waiting.ways.every((w) => w.action === null));
});

test('RG2 free online AI: no key -> "Add my key"; a key saved -> the picker\'s use action with its controls; labels come from the probe', () => {
  const none = way(guideOf(view([opt(), local(), hosted()])), 'hosted');
  assert.equal(none.state, 'needs_key');
  assert.equal(none.word, 'Needs an access key');
  assert.deepEqual(none.providers, ['Provider One', 'Provider Two'], 'the providers are the probe\'s list, in its order');
  assert.deepEqual(none.action, { op: 'add-key', label: 'Add my key', disabled: false });
  assert.equal(none.controls, false, 'no key: nothing to pick yet');
  assert.match(none.lead, /few minutes/);
  assert.match(none.lead, /key/);
  assert.equal(none.steps.length, 4);
  assert.match(none.steps.join(' '), /Add my key/);
  assert.match(none.status, /You have not added an access key yet/);
  assert.match(none.steps.join(' '), /Settings > Agents & Models > access keys/, 'the full path to the keys is stated in the steps');
  assert.match(none.cost, /^Free\./);
  assert.match(none.safety, /locked on this computer/);
  // A key for one provider: the guide offers it (the picker preselects that provider and its first tool-capable model).
  const hv = withKey('one')(hosted());
  const ready = way(guideOf(view([opt(), local(), hv])), 'hosted');
  assert.equal(ready.state, 'ready');
  assert.equal(ready.word, 'Ready');
  assert.deepEqual(ready.action, { op: 'use', label: 'Use this AI service', disabled: false });
  assert.deepEqual(ready.secondary, { op: 'add-key', label: 'Add or change my key', disabled: false });
  assert.equal(ready.controls, true);
  assert.equal(ready.choice.kind, 'hosted-model');
  assert.equal(ready.choice.provider, 'one');
  assert.deepEqual(ready.steps, []);
  // A key for a provider that is not the picked one: the picker's own sentence, and "Add my key".
  const otherKey = view([opt(), local(), withKey('two')(hosted())]);
  const wrong = way(guideOf(otherKey), 'hosted');
  assert.equal(wrong.state, 'needs_key');
  assert.equal(wrong.action.op, 'add-key');
  assert.equal(wrong.controls, true, 'the provider list is on the card so the keyed provider can be picked');
  assert.match(wrong.status, /^Your access key is saved for Provider Two. Pick that service below/);
  // Picking the provider that has the key makes it ready.
  const pickedTwo = way(guideOf(otherKey, { providers: { 'hosted-model': 'two' } }), 'hosted');
  assert.deepEqual([pickedTwo.state, pickedTwo.action.op, pickedTwo.choice.provider], ['ready', 'use', 'two']);
  // The probe has no providers (runner not reporting yet): not checked, nothing to press.
  const missing = way(guideOf(view([opt(), local(), hosted({ providers: [] })])), 'hosted');
  assert.deepEqual([missing.state, missing.action], ['unchecked', null]);
  assert.equal(way(guideOf(view([opt(), local()])), 'hosted').state, 'unchecked', 'not reported at all');
  // A rejected key says so and offers to enter it again.
  const rej = way(guideOf(view([opt(), local(), withKey('one')(hosted({ problem: 'key_rejected' }))])), 'hosted');
  assert.deepEqual([rej.state, rej.word, rej.status, rej.action.label], ['key_rejected', 'Key refused', E.AGENT_REASON_TEXT.hosted_key_rejected, 'Enter my key again']);
  // The runtime itself not ready: the picker's sentence, not a button.
  const down = way(guideOf(view([opt(), local(), hosted({ state: 'unavailable' })])), 'hosted');
  assert.deepEqual([down.state, down.action], ['unchecked', null]);
});

test('RG3 on this computer: server not running / model missing / ready, each a plain sentence with instructions and no action until ready', () => {
  const g = (o) => way(guideOf(view([opt(), local(o), hosted()])), 'local');
  const down = g({ state: 'not_installed', models: null, problem: null });
  assert.deepEqual([down.state, down.word, down.status, down.action], ['server_down', 'Not running', E.AGENT_REASON_TEXT.local_model_server_down, null]);
  assert.equal(down.steps.length, 4);
  // The steps name the program with the probe's own label (here the invented "Local model (Test)"): no vendor word in Nexus code.
  assert.match(down.steps.join(' '), /Install Test, a free program that runs AI models/);
  assert.match(down.steps.join(' '), /Start Test\./);
  // No label read: the generic words, same four steps.
  const nameless = g({ state: 'not_installed', label: null, models: null, problem: null });
  assert.equal(nameless.steps.length, 4);
  assert.match(nameless.steps.join(' '), /Install a free program that runs AI models/);
  assert.match(nameless.steps.join(' '), /Start it\./);
  assert.match(down.steps.join(' '), /model that can use tools/);
  const none = g({ models: [], problem: 'model_missing' });
  assert.deepEqual([none.state, none.status, none.action], ['no_model', 'The program that runs AI on this computer is working, but it has no model yet.', null]);
  assert.ok(none.steps.length >= 1);
  const unsup = g({ state: 'version_unsupported', models: [{ name: 'plain:1b', tools: false }], problem: 'model_no_tools' });
  assert.deepEqual([unsup.state, unsup.status, unsup.action], ['model_problem', E.AGENT_REASON_TEXT.local_model_no_tools, null]);
  const notPicked = g({});
  assert.equal(notPicked.state, 'model_problem');
  assert.equal(notPicked.word, 'Pick a model');
  assert.equal(notPicked.controls, true, 'the model list is on the card');
  assert.equal(notPicked.action, null);
  // A model picked in the card makes it ready, and the card ends in the picker's use action.
  const v = view([opt(), local(), hosted()]);
  const picked = way(guideOf(v, { models: { 'local-model': 'coder:7b' } }), 'local');
  assert.deepEqual([picked.state, picked.word, picked.action], ['ready', 'Ready', { op: 'use', label: 'Use this AI service', disabled: false }]);
  assert.equal(picked.choice.model, 'coder:7b');
  assert.deepEqual(picked.steps, []);
  // Not reported: not checked.
  assert.equal(way(guideOf(view([opt(), hosted()])), 'local').state, 'unchecked');
});

test('RG4 a plan you already have: ready only when the probe says installed AND signed in; otherwise one plain line (label from the probe)', () => {
  const g = (o) => way(guideOf(view([opt(o), local(), hosted()])), 'program');
  const ready = g({});
  assert.deepEqual([ready.state, ready.word, ready.status], ['ready', 'Ready', 'Test Engine is installed and signed in.']);
  assert.deepEqual(ready.action, { op: 'use', label: 'Use this AI service', disabled: false });
  const absent = g({ state: 'not_installed' });
  assert.deepEqual([absent.state, absent.status, absent.action], ['not_installed', 'Test Engine is not installed on this computer.', null]);
  const out = g({ state: 'not_signed_in', signedIn: 'no' });
  assert.deepEqual([out.state, out.status, out.action], ['not_signed_in', 'Test Engine is installed but not signed in.', null]);
  assert.match(out.steps.join(' '), /Sign in with it yourself/);
  const unsure = g({ signedIn: 'unknown' });
  assert.deepEqual([unsure.state, unsure.action], ['not_signed_in', null], 'not confirmed signed in is not ready');
  assert.equal(g({ state: 'version_unsupported' }).state, 'unsupported');
  assert.equal(g({ state: 'unavailable' }).state, 'unchecked');
  assert.equal(way(guideOf(view([local(), hosted()])), 'program').state, 'unchecked', 'no program reported');
  assert.match(g({}).lead, /Skip this if you do not have one/);
  // The program alone (the picker is not shown with one runtime): ready still offers the use action (the sheet grants the default runtime).
  const only = way(G.runtimeGuide(view([opt()]), X.runtimeChoices(view([opt()]))), 'program');
  assert.deepEqual([only.state, only.choice, only.action.op], ['ready', null, 'use']);
  // A vendor label from the probe is shown as the probe gave it (the code names none).
  assert.match(way(guideOf(view([opt({ label: 'Probe Label X' }), local(), hosted()])), 'program').status, /^Probe Label X is installed/);
});

test('RG5 every sentence of the guide is plain: no vendor, provider, address, code or percentage in what Nexus words', () => {
  const states = [
    view([opt(), local(), hosted()]), view([opt({ state: 'not_installed' }), local({ state: 'not_installed', models: null, problem: null }), hosted({ providers: [] })]),
    view([opt({ state: 'not_signed_in', signedIn: 'no' }), local({ models: [] }), withKey('one')(hosted())]), view([opt({ signedIn: 'unknown' }), local({ state: 'version_unsupported', problem: 'model_no_tools' }), hosted({ problem: 'key_rejected' })]),
    view([opt({ state: 'version_unsupported' }), local(), hosted({ state: 'unavailable' })]), null
  ];
  for (const v of states) {
    const g = guideOf(v);
    const text = [g.title, g.lead, g.note, ...g.ways.flatMap((w) => [w.title, w.lead, w.cost, w.safety, w.word, w.status, ...w.steps, w.action?.label, w.secondary?.label])].filter(Boolean).join('\n');
    // The probe-labelled ones ("Test Engine", "Provider One") are test data; everything else must be clean.
    assert.doesNotMatch(text, VENDOR);
    assert.doesNotMatch(text, HOSTLIKE);
    assert.doesNotMatch(text, /\b[a-z]+_[a-z_]+\b/, 'no reason code');
    assert.doesNotMatch(text, /\d\s*%/);
  }
  assert.match(G.GUIDE_LEAD, /The first two are free/);
  assert.match(G.GUIDE_LEAD, /do not need a paid plan/);
});

test('RG6 the agent panel with no permission: one sentence and one button that point to the guide (no engine, provider or program named)', () => {
  const NOW = 1_800_000_000_000;
  const agent = (o = {}) => ({ state: 'not_installed', label: 'Test Engine', version: null, signedIn: 'unknown', flagsOk: true, consent: { live: false, caps: null, hostsCount: 0, grantedAt: null },
    usageToday: { usdCents: 0, turns: 0, estimated: false }, ...o });
  const health = (a) => ({ db: { version: 10, platform: true, handoffs: true, execution: true, subReason: null }, checkedAt: NOW, agent: a });
  const panel = (a) => A.agentPanelModel({ health: health(a), availability: { kind: 'ready', advisories: [] }, sessions: [], sessionsFail: null });
  // Even with the default program not installed (a person with no paid plan), the panel leads with the guide, never with that program.
  for (const o of [{ state: 'not_installed' }, { state: 'not_signed_in' }, { state: 'unavailable' }, { state: 'unknown' }, { state: 'ready', signedIn: 'yes' }, { kind: 'local-model', state: 'not_installed' }]) {
    const p = panel(agent(o));
    assert.deepEqual(p.blockers, [A.CHOOSE_RUNTIME_TEXT], JSON.stringify(o));
    assert.equal(p.chooseRuntime, true);
    assert.equal(p.kind, 'setup');
  }
  assert.doesNotMatch(A.CHOOSE_RUNTIME_TEXT, VENDOR);
  assert.equal(A.CHOOSE_RUNTIME_BUTTON, G.GUIDE_TITLE, 'the button is named after the guide it opens');
  // With a live permission the panel is as before (the runtime's own problem, never the guide).
  const live = panel(agent({ state: 'not_installed', consent: { live: true, caps: null, hostsCount: 1, grantedAt: 1 } }));
  assert.deepEqual(live.blockers, [E.AGENT_REASON_TEXT.runtime_not_installed]);
  assert.equal(live.chooseRuntime, false);
  // Agent work off: one sentence, no guide.
  assert.equal(panel(agent({ state: 'off', offReason: 'not_enabled' })).chooseRuntime, false);
  // The panel renders it with exactly one button (the primary one that opens Setup).
  const tsx = read('src/renderer/src/nexus/agent/AgentPanel.tsx');
  assert.match(tsx, /\{panel\.chooseRuntime \? CHOOSE_RUNTIME_BUTTON : 'Open Setup'\}/);
  assert.match(tsx, /onClick=\{ui\.openSetup\}/);
});

test('RG7 source pins: the sheet shows the guide while nothing is granted, the picker only after, and the program rows wait; one set of controls serves both', () => {
  const sheet = read('src/renderer/src/nexus/components/ExecutionSetupSheet.tsx');
  assert.match(sheet, /import \{ runtimeGuide, type GuideWay \} from '\.\.\/data\/runtimeGuideModel';/);
  assert.match(sheet, /const guide = health\?\.agent\?\.state === 'off' \? null : runtimeGuide\(consent\.view, choices\);/);
  assert.match(sheet, /const rows = guide \? shownRows\.filter\(\(r\) => !r\.id\.startsWith\('agent'\)\) : shownRows;/);
  assert.match(sheet, /\{choices\.length > 0 && !guide && \(/, 'the picker list is the guide while nothing is granted');
  assert.match(sheet, /\{guide && \(\s*<section aria-labelledby="nx-xs-guide" className="nx-xg">/);
  assert.match(sheet, /guide\.ways\.map\(\(way\) =>/);
  // The way's button: add a key opens Settings on Agents & Models (the sheet closes first); use goes through the existing grant (picker row or default).
  assert.match(sheet, /const addKey = \(\) => \{ if \(shell\) \{ onClose\(\); requestKeysFocus\(\); shell\.openSettings\('Agents & Models'\); \} \};/, 'Add my key closes the sheet, asks the keys block to take focus, and opens Settings on it');
  assert.match(sheet, /else if \(way\.choice\) void useRuntime\(way\.choice\);\s*else void changeConsent\('grant'\);/);
  // One set of provider/model controls, used by the picker (with the key help) and by the guide (without: the guide has its own words).
  assert.equal((sheet.match(/const runtimeControls = \(/g) || []).length, 1, 'defined once');
  assert.equal((sheet.match(/\{runtimeControls\(/g) || []).length, 2, 'used in the picker and in the guide');
  assert.match(sheet, /runtimeControls\(c, true\)/);
  assert.match(sheet, /runtimeControls\(way\.choice, false\)/);
  // The guide lives above the program rows; both the sheet and the model hold no vendor word.
  assert.ok(sheet.indexOf('nx-xs-guide') < sheet.indexOf('aria-label="Computer details"'), 'the guide comes before the numbers behind More details');
  for (const f of ['src/renderer/src/nexus/components/ExecutionSetupSheet.tsx', 'src/renderer/src/nexus/data/runtimeGuideModel.ts', 'src/renderer/src/nexus/agent/agentModel.ts', 'src/renderer/src/nexus/agent/AgentPanel.tsx']) {
    assert.deepEqual(read(f).split('\n').filter((l) => VENDOR.test(l)), [], f);
  }
  // The identity guard's words: the design has no "card" (the options are "ways" in code), checked here as the exec-models pin does.
  for (const f of ['src/renderer/src/nexus/components/ExecutionSetupSheet.tsx', 'src/renderer/src/nexus/data/runtimeGuideModel.ts', 'src/renderer/src/nexus/styles/execution.css']) {
    assert.doesNotMatch(read(f), /\bcards?\b|-card\b|Card\b|dashboard|gradient/i, f);
  }
});
