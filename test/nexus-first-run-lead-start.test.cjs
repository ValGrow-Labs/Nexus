'use strict';
// Track D (first-run experience): finishing the setup wizard starts NO process. The legacy lead agent (a vendor CLI in a terminal) starts only
// when the person asked: the wizard's engine step (an explicit pick), or the Start button. The V9 click-through found that finishing onboarding
// started a real vendor CLI before any consent in the new setup sheet. Plain node: the decision is a pure function (shared/leadStart.ts) and the
// rest is source pins on the finish path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const L = loadTs('src/shared/leadStart.ts');
const P = loadTs('src/main/configPolicy.ts');

const done = (o = {}) => ({ onboardingComplete: true, harnessHome: '/home/x/HarnessAgents', ...o });

test('FR1 leadMayStart: nothing starts by itself unless the person chose it; an install from before the choice keeps working', () => {
  // A new install (the wizard always writes the setting): the default writes false, so nothing starts.
  assert.equal(L.leadMayStart(done({ leadAutoStart: false }), false), false);
  // The wizard's engine pick writes true: starts.
  assert.equal(L.leadMayStart(done({ leadAutoStart: true }), false), true);
  // The Start button starts it whatever the stored choice.
  assert.equal(L.leadMayStart(done({ leadAutoStart: false }), true), true);
  // An existing install (no value stored) keeps its old behaviour: it already was set up and started its lead agent.
  assert.equal(L.leadMayStart(done(), false), true);
  // Not set up yet, no home folder, or no config: never, even when asked.
  assert.equal(L.leadMayStart({ onboardingComplete: false, harnessHome: '/h' }, true), false);
  assert.equal(L.leadMayStart({ onboardingComplete: true, harnessHome: null }, true), false);
  assert.equal(L.leadMayStart({ onboardingComplete: true, harnessHome: '' }, true), false);
  assert.equal(L.leadMayStart(null, true), false);
  assert.equal(L.leadMayStart(undefined, false), false);
  // A value that is not a boolean is not "true": only an explicit true starts it on its own.
  assert.equal(L.leadMayStart(done({ leadAutoStart: 'yes' }), false), false);
  assert.equal(L.leadMayStart(done({ leadAutoStart: 1 }), false), false);
});

test('FR2 the wizard\'s first-run default is "not now": it writes leadAutoStart false; only the engine pick writes true', () => {
  assert.deepEqual(L.wizardLeadConfig('later'), { leadAutoStart: false });
  assert.deepEqual(L.wizardLeadConfig('engine'), { leadAutoStart: true });
  // The decision a finished default wizard produces: a fresh config with its output starts nothing.
  const fresh = done({ ...L.wizardLeadConfig('later') });
  assert.equal(L.leadMayStart(fresh, false), false);
  assert.equal(L.isLeadAutoStart(true), true);
  assert.equal(L.isLeadAutoStart('true'), false);
  assert.equal(L.isLeadAutoStart(undefined), false);
});

test('FR3 the setting is a renderer-editable boolean in main\'s config policy (a non-boolean is refused, so the wizard cannot be spoofed into a start)', () => {
  assert.equal(P.CONFIG_KEY_POLICY.leadAutoStart, 'renderer');
  const cur = { onboardingComplete: false };
  const ok = P.classifyConfigPatch({ onboardingComplete: true, leadAutoStart: false }, cur);
  assert.equal(ok.apply.leadAutoStart, false);
  const bad = P.classifyConfigPatch({ leadAutoStart: 'yes' }, { onboardingComplete: true });
  assert.ok(bad.rejected.includes('leadAutoStart'));
  assert.equal('leadAutoStart' in bad.apply, false);
  // The default config does NOT carry it: an absent value is what marks an install from before the choice.
  assert.equal('leadAutoStart' in loadTs('src/main/configDefaults.ts').CONFIG_DEFAULTS, false);
});

test('FR4 source pin: the wizard\'s finish path starts no process and writes the choice; its engine step defaults to "not now"', () => {
  const w = read('src/renderer/src/components/OnboardingWizard.tsx');
  assert.match(w, /useState<WizardLeadChoice>\('later'\)/, 'default choice is later');
  assert.match(w, /\.\.\.wizardLeadConfig\(leadChoice\)/, 'finish writes the choice, every time');
  // Nothing in the wizard spawns, starts or restores an agent.
  assert.doesNotMatch(w, /spawnPty|startAgent|agentStart|spawnAgent|restoreTeam|createAgent|window\.cth\.[a-zA-Z]*[Ss]pawn/);
  // The finish function itself: config writes and the completion callback only.
  const finish = w.slice(w.indexOf('const finish = async'), w.indexOf('return (', w.indexOf('const finish = async')));
  const calls = [...finish.matchAll(/window\.cth\.(\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(calls, ['ensureHarnessHome', 'updateConfig']);
  assert.match(finish, /onComplete\(next\)/);
  // Picking an engine is the consent: only the engine radios set 'engine', "not now" sets 'later'.
  assert.equal((w.match(/setLeadChoice\('engine'\)/g) || []).length, 1);
  assert.match(w, /onChange=\{\(\) => setLeadChoice\('later'\)\}/);
  // No engine carries a "recommended" badge any more, and the step names no default engine as the one to take.
  assert.doesNotMatch(w, /RECOMMENDED/);
  assert.doesNotMatch(w, /We recommend Claude/);
  assert.match(w, /Nothing starts until you say so\./);
  // App only stores the finished config and opens the hive: it starts nothing (that is the boot effect, gated below).
  const app = read('src/renderer/src/App.tsx');
  assert.match(app, /<OnboardingWizard onComplete=\{\(next\) => \{ setConfig\(next\); setHiveOpened\(true\); \}\} \/>/);
});

test('FR5 source pin: the only place that spawns the lead agent is the boot effect, behind leadMayStart, and the Start button asks it', () => {
  const h = read('src/renderer/src/hooks/useHive.ts');
  assert.match(h, /import \{ leadMayStart \} from '\.\.\/\.\.\/\.\.\/shared\/leadStart';/);
  assert.match(h, /const leadAllowed = leadMayStart\(config, leadStartRequests > 0\);/);
  const spawns = [...h.matchAll(/window\.cth\.spawnPty\(\{\s*id: GOD_PTY/g)];
  assert.equal(spawns.length, 1, 'one place spawns the lead agent');
  const guard = h.indexOf('if (!leadAllowed) return;');
  assert.ok(guard > 0, 'the guard exists');
  assert.ok(guard < spawns[0].index, 'the guard comes before the spawn');
  // The guard is also before the stale entry is cleared and the spawn latch is taken.
  assert.ok(guard < h.indexOf('godSpawning.current = true;'));
  assert.ok(guard < h.indexOf('useStore.getState().removeAgent(GOD_ID);'));
  // The status says so: off, not "starting".
  assert.match(h, /setGodStatus\(leadAllowed \? 'booting' : 'off'\)/);
  // The effect re-runs when the Start button was pressed (and only then starts it).
  assert.match(h, /\}, \[config\?\.onboardingComplete, config\?\.harnessHome, leadAllowed\]\);/);
  const s = read('src/renderer/src/store/store.ts');
  assert.match(s, /export type GodStatus = 'booting' \| 'ready' \| 'failed' \| 'off';/);
  assert.match(s, /requestLeadStart: \(\) => set\(\(s\) => \(\{ leadStartRequests: s\.leadStartRequests \+ 1 \}\)\)/);
  // The Start button is the clear, explicit control: on the Agents page (empty state, and the bar when the lead is missing).
  const a = read('src/renderer/src/nexus/agents/AgentsPage.tsx');
  assert.match(a, /onClick=\{requestLeadStart\}>/);
  assert.match(a, /Start the lead agent/);
  assert.match(a, /godStatus === 'off'/);
  // The only other legacy spawn on launch restores the previous session's workers (it never includes the lead agent and needs a saved team).
  assert.doesNotMatch(read('src/renderer/src/hooks/useRestoreTeam.ts'), /GOD_PTY|isGod: true/);
});

test('FR6 nothing on the main side starts the lead agent either (the boot spawn is the renderer effect above)', () => {
  const main = read('src/main/index.ts');
  // main spawns agents only for a spawn request (IPC) or a god-triggered worker; no boot-time spawn names the lead agent's pty.
  assert.doesNotMatch(main, /pty-god/);
  assert.doesNotMatch(main, /spawnLead|startLead|bootGod|ensureGod/i);
});
