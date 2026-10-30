'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const p = loadTs('src/main/configPolicy.ts');
const s = loadTs('src/main/configSecrets.ts');
const { writeFileAtomic } = loadTs('src/main/atomicWrite.ts');
const { restoreClaudeSettings } = loadTs('src/main/claudeSettings.ts');
const { CONFIG_DEFAULTS } = loadTs('src/main/configDefaults.ts');
const { autoModeNeedsReview } = loadTs('src/shared/autoModeReview.ts');
// Working trees may be CRLF (core.autocrlf); source assertions read LF.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const cur = { onboardingComplete: true, autoMode: false, harnessHome: 'C:\\H', defaultCommand: 'claude', trustedEngineCommands: ['aider'] };

test('O.9 #22: cosmetic keys apply directly', () => {
  const r = p.classifyConfigPatch({ notifications: true, terminalTheme: 'dark' }, cur);
  assert.deepEqual(r.apply, { notifications: true, terminalTheme: 'dark' });
  assert.deepEqual([r.confirm, r.secrets, r.rejected], [[], [], []]);
});
test('O.9 #22: auto mode on, home, engine and ports need a main-process confirmation', () => {
  const r = p.classifyConfigPatch({ autoMode: true, harnessHome: 'D:\\x', defaultCommand: 'C:\\x\\agent.exe', slackPort: 4000 }, cur);
  assert.deepEqual(r.confirm.map((c) => c.key).sort(), ['autoMode', 'defaultCommand', 'harnessHome', 'slackPort']);
  assert.deepEqual(r.apply, {});
});
test('turning auto mode off and closing a tunnel are always allowed', () => {
  assert.deepEqual(p.classifyConfigPatch({ autoMode: false }, { ...cur, autoMode: true }).apply, { autoMode: false });
  assert.deepEqual(p.classifyConfigPatch({ slackPublicTunnel: false }, cur).apply, { slackPublicTunnel: false });
  assert.deepEqual(p.classifyConfigPatch({ webhookPublicTunnel: true }, cur).confirm.map((c) => c.key), ['webhookPublicTunnel']);
});
test('onboarding may set home and auto mode before it completes', () => {
  assert.deepEqual(p.classifyConfigPatch({ harnessHome: 'C:\\H', autoMode: true, onboardingComplete: true }, { ...cur, onboardingComplete: false }).confirm, []);
});
test('O.9 #22: internal and unknown keys are rejected', () => {
  assert.deepEqual(p.classifyConfigPatch({ triggersMigratedV1: false, secretsMigratedV1: false, evil: 1 }, cur).rejected.sort(), ['evil', 'secretsMigratedV1', 'triggersMigratedV1']);
});
test('confirmed engines can only be removed from the renderer', () => {
  assert.deepEqual(p.classifyConfigPatch({ trustedEngineCommands: [] }, cur).apply, { trustedEngineCommands: [] });
  assert.deepEqual(p.classifyConfigPatch({ trustedEngineCommands: ['aider', 'calc'] }, cur).rejected, ['trustedEngineCommands']);
});
test('secrets go to the secret store; an empty string means unchanged; null removes', () => {
  const r = p.classifyConfigPatch({ slackSigningSecret: 'abc', groqApiKey: '', slackBotToken: null }, cur);
  assert.deepEqual(r.secrets, [{ field: 'slackSigningSecret', value: 'abc' }, { field: 'slackBotToken', value: null }]);
  assert.deepEqual(r.apply, {});
});

const SECRET_CFG = { slackSigningSecret: 'SLACK-SECRET-1', slackBotToken: 'xoxb-SECRET-2', groqApiKey: 'gsk_SECRET-3', webhookSecret: 'WH-SECRET-4',
  webhookTriggers: [{ id: 'a', name: 'A', secret: 'WH-SECRET-5', enabled: true }], orgTrigger: { apiKey: 'ORG-SECRET-6', mode: 'strict' }, notifications: true };
const VALUES = ['SLACK-SECRET-1', 'xoxb-SECRET-2', 'gsk_SECRET-3', 'WH-SECRET-4', 'WH-SECRET-5', 'ORG-SECRET-6'];

test('O.9 #8: config:get never returns a secret value', () => {
  const red = s.redactConfig(SECRET_CFG, () => true);
  const json = JSON.stringify(red);
  for (const v of VALUES) assert.ok(!json.includes(v), v);
  assert.deepEqual(red.secretsPresent, { slackSigningSecret: true, slackBotToken: true, groqApiKey: true, webhookSecret: true, orgApiKey: true });
  assert.equal(red.webhookTriggers[0].hasSecret, true);
  assert.equal(red.notifications, true);
  assert.match(read('src/main/index.ts'), /ipcMain\.handle\('config:get',[^\n]*redactConfig\(/);
});
test('O.9 #8: migration moves every plaintext secret and strips it', () => {
  const { moves, stripped } = s.planSecretMigration(SECRET_CFG);
  assert.deepEqual(moves.map((m) => m.ref).sort(), ['config:groqApiKey', 'config:org:apiKey', 'config:slackBotToken', 'config:slackSigningSecret', 'config:webhook:a', 'config:webhookSecret']);
  const json = JSON.stringify(stripped);
  for (const v of VALUES) assert.ok(!json.includes(v), v);
  assert.equal(stripped.secretsMigratedV1, true);
  assert.deepEqual(s.planSecretMigration({ notifications: true, webhookTriggers: [], orgTrigger: { mode: 'strict' } }).moves, []);
});
test('O.9 #8: migration backs up first and only strips after every secret verifies', () => {
  const calls = []; const store = new Map();
  const deps = { encryptionAvailable: () => true, backup: () => { calls.push('backup'); return 'C:\\U\\config.pre-secrets.json'; },
    setSecret: (ref, v) => { calls.push('set'); store.set(ref, v); return { ok: true }; }, getSecret: (ref) => store.get(ref),
    write: () => calls.push('write') };
  const r = s.migrateConfigSecrets(SECRET_CFG, deps);
  assert.equal(r.status, 'migrated'); assert.equal(calls[0], 'backup'); assert.equal(calls.at(-1), 'write');
  assert.equal(s.migrateConfigSecrets(SECRET_CFG, { ...deps, getSecret: () => 'wrong', write: () => { throw new Error('must not write'); } }).status, 'verify-failed');
  assert.equal(s.migrateConfigSecrets(SECRET_CFG, { ...deps, encryptionAvailable: () => false, backup: () => { throw new Error('must not back up'); } }).status, 'encryption-unavailable');
  assert.equal(s.migrateConfigSecrets({ notifications: true }, deps).status, 'nothing');
});

test('O.9 #8: atomic write replaces the file and leaves no temp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-atomic-')); const f = path.join(dir, 'config.json');
  writeFileAtomic(f, '{"a":1}'); writeFileAtomic(f, '{"a":2}');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":2}');
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});
test('O.9 #8: a rename that keeps failing leaves the old file intact; a transient lock is retried', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-atomic-')); const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, 'old');
  let n = 0;
  const flaky = { ...fs, renameSync: (a, b) => { if (++n <= 2) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } fs.renameSync(a, b); } };
  writeFileAtomic(f, 'new', flaky);
  assert.equal(fs.readFileSync(f, 'utf8'), 'new');
  fs.writeFileSync(f, 'old');
  const broken = { ...fs, renameSync: () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; } };
  assert.throws(() => writeFileAtomic(f, 'new', broken));
  assert.equal(fs.readFileSync(f, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('O.9 #9: restore removes exactly the two Nexus keys and keeps a backup', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-home-')); fs.mkdirSync(path.join(home, '.claude'));
  const f = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ theme: 'dark', skipDangerousModePermissionPrompt: true, skipAutoPermissionPrompt: true, model: 'x' }));
  const r = restoreClaudeSettings(home);
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed.sort(), ['skipAutoPermissionPrompt', 'skipDangerousModePermissionPrompt']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { theme: 'dark', model: 'x' });
  assert.ok(fs.existsSync(r.backup));
  assert.deepEqual(restoreClaudeSettings(home).removed, []);
  assert.deepEqual(restoreClaudeSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'nx-home-'))), { ok: true, removed: [] });
});
test('O.9 #9: no main-process code writes the global Claude config any more', () => {
  for (const f of ['src/main/config.ts', 'src/main/index.ts']) assert.doesNotMatch(read(f), /ensureClaudePermissionsAccepted|'\.claude\.json'/, f);
});

test('O.9 #10: new installs start with auto mode off; existing auto mode is reviewed, not flipped', () => {
  assert.equal(CONFIG_DEFAULTS.autoMode, false);
  assert.equal(autoModeNeedsReview({ autoMode: true }), true);
  assert.equal(autoModeNeedsReview({ autoMode: true, autoModeReviewedV1: true }), false);
  assert.equal(autoModeNeedsReview({ autoMode: false }), false);
  assert.match(read('src/renderer/src/components/OnboardingWizard.tsx'), /useState<boolean>\(false\)/);
});

// ─── Additional coverage (task 12) ──────────────────────────────────────────

test('policy table classifies every HarnessConfig key, and nothing else', () => {
  const src = read('src/main/config.ts');
  const body = src.slice(src.indexOf('export interface HarnessConfig {'), src.indexOf('\n}\n', src.indexOf('export interface HarnessConfig {')));
  const keys = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(p.CONFIG_KEY_POLICY).sort(), keys);
  for (const k of ['harnessHome', 'autoMode', 'defaultCommand', 'slackPort', 'webhookPort', 'slackPublicTunnel', 'webhookPublicTunnel', 'freeflowEnabled', 'realtimeVoiceEnabled', 'providerBaseUrls']) {
    assert.equal(p.CONFIG_KEY_POLICY[k], 'confirm', k);
  }
  for (const k of ['slackSigningSecret', 'slackBotToken', 'groqApiKey', 'webhookSecret']) assert.equal(p.CONFIG_KEY_POLICY[k], 'secret', k);
  for (const k of ['webhookTriggers', 'orgTrigger', 'integrations', 'contextTrigger', 'recentHives', 'micConfirmedFreeflowV1', 'micConfirmedRealtimeV1', 'serverPostureV1']) {
    assert.equal(p.CONFIG_KEY_POLICY[k], 'internal', k);
  }
  assert.equal(p.CONFIG_KEY_POLICY.trustedEngineCommands, 'shrink-only');
  assert.equal(p.CONFIG_KEY_POLICY.autoModeReviewedV1, 'renderer');
});

test('defaultCommand: a preset CLI applies, a program asks, a shell is refused, unchanged is a no-op', () => {
  assert.deepEqual(p.classifyConfigPatch({ defaultCommand: 'codex' }, cur).apply, { defaultCommand: 'codex' });
  assert.deepEqual(p.classifyConfigPatch({ defaultCommand: 'claude --model claude-fable-5' }, cur).apply, { defaultCommand: 'claude --model claude-fable-5' });
  // A preset with a flag that is not on its allow-list is shown in the dialog.
  assert.deepEqual(p.classifyConfigPatch({ defaultCommand: 'claude --settings x.json' }, cur).confirm.map((c) => c.key), ['defaultCommand']);
  // The bypass flag is on the list only while auto mode is on; with auto mode
  // off it is refused outright, not offered (B0a final review, finding 1b).
  assert.deepEqual(p.classifyConfigPatch({ defaultCommand: 'claude --permission-mode bypassPermissions' }, cur).rejected, ['defaultCommand']);
  assert.deepEqual(p.classifyConfigPatch({ defaultCommand: 'claude --permission-mode bypassPermissions' }, { ...cur, autoMode: true }).confirm, []);
  for (const bad of ['cmd /c calc', 'powershell', 'claude & calc', '', 42]) {
    assert.deepEqual(p.classifyConfigPatch({ defaultCommand: bad }, cur).rejected, ['defaultCommand'], String(bad));
  }
  const same = p.classifyConfigPatch({ defaultCommand: 'claude' }, cur);
  assert.deepEqual([same.apply, same.confirm, same.rejected], [{}, [], []]);
});

test('ports: the effective current port applies, a new one asks, junk is refused', () => {
  assert.deepEqual(p.classifyConfigPatch({ slackPort: 3847 }, cur).apply, { slackPort: 3847 });
  assert.deepEqual(p.classifyConfigPatch({ webhookPort: 3849 }, cur).apply, { webhookPort: 3849 });
  assert.deepEqual(p.classifyConfigPatch({ slackPort: 4000 }, { ...cur, slackPort: 4000 }).apply, { slackPort: 4000 });
  assert.deepEqual(p.classifyConfigPatch({ webhookPort: 5000 }, cur).confirm.map((c) => c.key), ['webhookPort']);
  for (const bad of [0, 70000, 3.5, '4000']) assert.deepEqual(p.classifyConfigPatch({ slackPort: bad }, cur).rejected, ['slackPort'], String(bad));
});

test('auto mode: off never asks; on asks unless already on; onboarding counts as the review', () => {
  assert.deepEqual(p.classifyConfigPatch({ autoMode: true }, { ...cur, autoMode: true }).confirm, []);
  assert.deepEqual(p.classifyConfigPatch({ autoMode: 'yes' }, cur).rejected, ['autoMode']);
  const onb = p.classifyConfigPatch({ autoMode: true }, { ...cur, onboardingComplete: false });
  assert.deepEqual(onb.apply, { autoMode: true, autoModeReviewedV1: true });
  assert.deepEqual(p.confirmedPatch('autoMode', true), { autoMode: true, autoModeReviewedV1: true });
  assert.deepEqual(p.confirmedPatch('autoMode', false), { autoMode: false });
  // The banner's two answers are plain renderer writes.
  assert.deepEqual(p.classifyConfigPatch({ autoMode: false, autoModeReviewedV1: true }, { ...cur, autoMode: true }).apply, { autoMode: false, autoModeReviewedV1: true });
  assert.deepEqual(p.classifyConfigPatch({ autoModeReviewedV1: true }, { ...cur, autoMode: true }).apply, { autoModeReviewedV1: true });
});

test('onboarding cannot be re-opened from the renderer to skip the dialogs', () => {
  assert.deepEqual(p.classifyConfigPatch({ onboardingComplete: false }, cur).rejected, ['onboardingComplete']);
  const r = p.classifyConfigPatch({ onboardingComplete: false, harnessHome: 'D:\\evil' }, cur);
  assert.deepEqual(r.confirm.map((c) => c.key), ['harnessHome']);
  assert.deepEqual(p.classifyConfigPatch({ harnessHome: '' }, cur).rejected, ['harnessHome']);
});

test('microphone: Free Flow and realtime voice ask the first time they turn on, never to turn off', () => {
  const off = { ...cur, freeflowEnabled: false, realtimeVoiceEnabled: false };
  assert.deepEqual(p.classifyConfigPatch({ freeflowEnabled: true }, off).confirm.map((c) => c.key), ['freeflowEnabled']);
  assert.deepEqual(p.classifyConfigPatch({ realtimeVoiceEnabled: true }, off).confirm.map((c) => c.key), ['realtimeVoiceEnabled']);
  assert.deepEqual(p.classifyConfigPatch({ freeflowEnabled: false, realtimeVoiceEnabled: false }, { ...off, freeflowEnabled: true }).apply, { freeflowEnabled: false, realtimeVoiceEnabled: false });
  // After the user allowed it once, the toggle (or a voice session start) applies directly.
  assert.deepEqual(p.classifyConfigPatch({ freeflowEnabled: true }, { ...off, micConfirmedFreeflowV1: true }).apply, { freeflowEnabled: true });
  assert.deepEqual(p.classifyConfigPatch({ realtimeVoiceEnabled: true }, { ...off, micConfirmedRealtimeV1: true }).apply, { realtimeVoiceEnabled: true });
  assert.deepEqual(p.confirmedPatch('freeflowEnabled', true), { freeflowEnabled: true, micConfirmedFreeflowV1: true });
  assert.deepEqual(p.confirmedPatch('realtimeVoiceEnabled', true), { realtimeVoiceEnabled: true, micConfirmedRealtimeV1: true });
  // The renderer cannot set the latch itself.
  assert.deepEqual(p.classifyConfigPatch({ micConfirmedFreeflowV1: true, micConfirmedRealtimeV1: true }, off).rejected.sort(), ['micConfirmedFreeflowV1', 'micConfirmedRealtimeV1']);
});

test('registered folders: removals apply; additions must be existing absolute folders; no UNC lookups', () => {
  const seen = [];
  const env = { isDirectory: (q) => { seen.push(q); return q === 'C:\\work\\proj' || q === '/home/u/proj'; } };
  const base = { ...cur, registeredRepos: ['C:\\a', 'C:\\b'] };
  assert.deepEqual(p.classifyConfigPatch({ registeredRepos: ['C:\\b'] }, base, env).apply, { registeredRepos: ['C:\\b'] });
  assert.deepEqual(p.classifyConfigPatch({ registeredRepos: ['C:\\work\\proj', 'C:\\a'] }, base, env).apply, { registeredRepos: ['C:\\work\\proj', 'C:\\a'] });
  const r = p.classifyConfigPatch({ registeredRepos: ['C:\\nope', 'relative\\dir', '\\\\evil\\share', 'C:\\a'] }, base, env);
  assert.deepEqual(r.apply, { registeredRepos: ['C:\\a'] });
  assert.deepEqual(r.rejected, ['registeredRepos']);
  assert.ok(!seen.some((q) => q.startsWith('\\\\')), 'never stats a UNC path');
  assert.deepEqual(p.classifyConfigPatch({ registeredRepos: 'C:\\x' }, base, env).rejected, ['registeredRepos']);
});

test('lead engine picker: godProvider must be a provider id, godModel/defaultModel a model id', () => {
  assert.deepEqual(p.classifyConfigPatch({ godProvider: 'codex', godModel: 'gpt-5.5' }, cur).apply, { godProvider: 'codex', godModel: 'gpt-5.5' });
  assert.deepEqual(p.classifyConfigPatch({ godModel: 'Gemini 3.1 Pro (High)', defaultModel: 'claude-sonnet-4-6[1m]' }, cur).apply, { godModel: 'Gemini 3.1 Pro (High)', defaultModel: 'claude-sonnet-4-6[1m]' });
  assert.deepEqual(p.classifyConfigPatch({ godModel: undefined }, cur).apply, { godModel: undefined });
  for (const bad of [{ godProvider: 'calc' }, { godModel: '--settings=x' }, { godModel: '-x' }, { defaultModel: 'a;b' }, { godModel: 7 }]) {
    assert.deepEqual(p.classifyConfigPatch(bad, cur).rejected, Object.keys(bad), JSON.stringify(bad));
  }
});

test('secret values: whitespace is unchanged, non-strings are refused, values are trimmed', () => {
  const r = p.classifyConfigPatch({ groqApiKey: '   ', slackBotToken: '  xoxb-1  ', webhookSecret: 5 }, cur);
  assert.deepEqual(r.secrets, [{ field: 'slackBotToken', value: 'xoxb-1' }]);
  assert.deepEqual(r.rejected, ['webhookSecret']);
  assert.deepEqual(p.classifyConfigPatch({ __proto__: { autoMode: true } }, cur).apply, {});
  assert.deepEqual(p.classifyConfigPatch(null, cur), { apply: {}, confirm: [], secrets: [], rejected: [] });
});

test('confirm dialogs use the brief copy', () => {
  assert.deepEqual(p.confirmPrompt('autoMode', true), {
    message: 'Turn on auto mode?',
    detail: 'Agents will skip their CLI approval prompts: they can run commands and change files in their folders without asking you first. You can turn it off again in Settings.',
    confirmLabel: 'Turn on auto mode'
  });
  assert.deepEqual(p.confirmPrompt('harnessHome', 'D:\\x'), { message: 'Change the Nexus home folder to D:\\x?', detail: 'Agents, memory and tasks live in the home folder. Nexus relaunches after the change.', confirmLabel: 'Change folder' });
  assert.deepEqual(p.confirmPrompt('defaultCommand', 'aider'), { message: 'Use “aider” to start agents?', detail: 'Every new agent will run this program. Only continue if you trust it.', confirmLabel: 'Use this program' });
  assert.deepEqual(p.confirmPrompt('slackPort', 4000), { message: 'Change the Slack port to 4000?', detail: 'Callers must use the new port. Nexus restarts the server.', confirmLabel: 'Change port' });
  assert.equal(p.confirmPrompt('webhookPort', 5000).message, 'Change the webhook port to 5000?');
  for (const k of ['slackPublicTunnel', 'webhookPublicTunnel', 'freeflowEnabled', 'realtimeVoiceEnabled']) assert.ok(p.confirmPrompt(k, true).detail, k);
});

test('redaction: plaintext still counts as present; nothing secret survives; empty config is fine', () => {
  const red = s.redactConfig(SECRET_CFG, () => false);
  assert.deepEqual(red.secretsPresent, { slackSigningSecret: true, slackBotToken: true, groqApiKey: true, webhookSecret: true, orgApiKey: true });
  assert.equal(red.orgTrigger.hasApiKey, true);
  assert.equal(red.orgTrigger.apiKey, '');
  for (const f of ['slackSigningSecret', 'slackBotToken', 'groqApiKey', 'webhookSecret']) assert.ok(!(f in red), f);
  const none = s.redactConfig({ notifications: false, webhookTriggers: [{ id: 'b', secret: '' }], orgTrigger: { apiKey: '' } }, () => false);
  assert.deepEqual(none.secretsPresent, { slackSigningSecret: false, slackBotToken: false, groqApiKey: false, webhookSecret: false, orgApiKey: false });
  assert.equal(none.webhookTriggers[0].hasSecret, false);
  const stored = s.redactConfig({ webhookTriggers: [{ id: 'b', secret: '' }] }, (ref) => ref === 'config:webhook:b');
  assert.equal(stored.webhookTriggers[0].hasSecret, true);
});

test('migration failure paths never write and report the backup', () => {
  const store = new Map();
  const base = { encryptionAvailable: () => true, backup: () => 'B', setSecret: (r, v) => { store.set(r, v); return { ok: true }; }, getSecret: (r) => store.get(r), write: () => { throw new Error('must not write'); } };
  const failSet = s.migrateConfigSecrets(SECRET_CFG, { ...base, setSecret: () => ({ ok: false, error: 'locked' }) });
  assert.deepEqual(failSet, { status: 'error', backup: 'B', error: 'locked' });
  const failBackup = s.migrateConfigSecrets(SECRET_CFG, { ...base, backup: () => { throw new Error('disk full'); }, setSecret: () => { throw new Error('must not store'); } });
  assert.equal(failBackup.status, 'error');
  assert.equal(failBackup.backup, undefined);
  const failWrite = s.migrateConfigSecrets(SECRET_CFG, { ...base });
  assert.equal(failWrite.status, 'error');
  assert.equal(failWrite.backup, 'B');
  const nothing = s.migrateConfigSecrets({ notifications: true }, { ...base, backup: () => { throw new Error('must not back up'); } });
  assert.equal(nothing.status, 'nothing');
  // Error text never carries a secret value.
  const verify = s.migrateConfigSecrets(SECRET_CFG, { ...base, getSecret: () => undefined });
  assert.equal(verify.status, 'verify-failed');
  for (const v of VALUES) assert.ok(!JSON.stringify(verify).includes(v), v);
});

test('renderer never reads a secret field from config (only secretsPresent)', () => {
  const root = path.join(__dirname, '..', 'src', 'renderer', 'src');
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const txt = fs.readFileSync(f, 'utf8');
        for (const m of txt.matchAll(/(\w+\??)\.(slackSigningSecret|slackBotToken|groqApiKey|webhookSecret)\b/g)) {
          if (!/^(secretsPresent\??|present)$/.test(m[1])) offenders.push(`${path.relative(root, f)}: ${m[0]}`);
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

test('main reads every config secret through readConfigSecret(s), never the plaintext field', () => {
  const idx = read('src/main/index.ts');
  assert.doesNotMatch(idx, /cfg\.(slackSigningSecret|slackBotToken|groqApiKey)\b/);
  assert.doesNotMatch(idx, /readConfig\(\)\.(slackSigningSecret|slackBotToken|groqApiKey|webhookSecret)\b/);
  assert.match(idx, /signingSecret,\n/);
  assert.match(idx, /getBotToken: \(\) => readConfigSecret\('slackBotToken'\)/);
  assert.match(idx, /const groqApiKey = readConfigSecret\('groqApiKey', cfg\);/);
  assert.match(idx, /filter\(\(t\) => t\.enabled && !!secrets\[t\.id\]\)/);
  // config:update and the setConfig channels share the allow-list.
  assert.match(idx, /ipcMain\.handle\('config:update', async[\s\S]{0,3000}applyRendererConfigPatch\(patch, evt\.sender\)/);
  for (const ch of ['slack:setConfig', 'webhook:setConfig', 'freeflow:setConfig']) {
    const h = idx.slice(idx.indexOf(`ipcMain.handle('${ch}'`), idx.indexOf(`ipcMain.handle('${ch}'`) + 1400);
    assert.match(h, /applyRendererConfigPatch\(next, evt\.sender\)/, ch);
  }
  // Boot: migrate before services start.
  assert.ok(idx.indexOf('runConfigSecretMigration();') < idx.indexOf('bootstrapHiveServices();\n  // Survive sleep'));
  // changeHome asks in main.
  const ch = idx.slice(idx.indexOf("ipcMain.handle('config:changeHome'"), idx.indexOf("ipcMain.handle('config:changeHome'") + 2000);
  assert.match(ch, /confirmConfigChange\('harnessHome', newHome, evt\.sender\)/);
  // The only new channel.
  assert.match(idx, /ipcMain\.handle\('config:restoreClaudeSettings'/);
  assert.match(read('src/preload/index.ts'), /restoreClaudeSettings: \(\): Promise<\{ ok: boolean; removed\?: string\[\]; error\?: string \}> =>\s*ipcRenderer\.invoke\('config:restoreClaudeSettings'\)/);
});

test('copy: autonomy row, banner and restore strings are the brief text', () => {
  const sm = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(sm.includes('Auto mode: AI helpers do not ask before they run commands or change files'));
  assert.ok(sm.includes('AI helpers can run commands and change files in their folders without asking you. Turning it on asks you to confirm.'));
  assert.ok(sm.includes('Restore my Claude settings'));
  assert.ok(sm.includes('Removed ${n} setting(s). A backup is next to the file.'));
  assert.ok(sm.includes("'Nothing to remove.'"));
  assert.ok(sm.includes('Could not update the file: '));
  assert.ok(sm.includes('Secrets stay in config.json because this system has no secure storage available.'));
  assert.ok(sm.includes("'Saved. Enter a new value to replace it.'"));
  const { AUTO_MODE_BANNER } = loadTs('src/shared/autoModeReview.ts');
  assert.deepEqual(AUTO_MODE_BANNER, {
    title: 'Auto mode is on',
    body: 'AI helpers do not ask you before they run commands or change files. New installs now start with auto mode off.',
    turnOff: 'Turn auto mode off',
    keep: 'Keep auto mode on'
  });
  assert.match(read('src/renderer/src/nexus/agents/AgentsPage.tsx'), /<AutoModeBanner /);
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes("message: 'Remove these two settings?'"));
  assert.ok(idx.includes("detail: 'Older Nexus builds added them; you may also have set them yourself. Nexus will remove skipDangerousModePermissionPrompt and skipAutoPermissionPrompt from ~/.claude/settings.json and keep a backup next to it. Nothing else in the file changes.'"));
  assert.ok(idx.includes("buttons: ['Remove them', 'Cancel']"));
});

// ─── Fix round 1 ────────────────────────────────────────────────────────────

test('provider base URLs: unchanged and removed entries apply; each new or changed host asks', () => {
  const base = { ...cur, providerBaseUrls: { opencode: 'http://localhost:11434/v1', qwen: 'http://127.0.0.1:8000' } };
  // Unchanged + one removal: applies directly, no dialog.
  const same = p.classifyConfigPatch({ providerBaseUrls: { opencode: 'http://localhost:11434/v1', qwen: undefined } }, base);
  assert.deepEqual(same.apply, { providerBaseUrls: { opencode: 'http://localhost:11434/v1' } });
  assert.deepEqual(same.confirm, []);
  // A changed host and a new one: two dialogs; meanwhile the old values stay.
  const ch = p.classifyConfigPatch({ providerBaseUrls: { opencode: 'https://evil.example.com/v1', qwen: 'http://127.0.0.1:8000', crush: 'http://10.0.0.5:9000' } }, base);
  assert.deepEqual(ch.apply, { providerBaseUrls: { opencode: 'http://localhost:11434/v1', qwen: 'http://127.0.0.1:8000' } });
  assert.deepEqual(ch.confirm, [
    { key: 'providerBaseUrls', value: { provider: 'opencode', url: 'https://evil.example.com/v1' } },
    { key: 'providerBaseUrls', value: { provider: 'crush', url: 'http://10.0.0.5:9000' } }
  ]);
  // Confirming merges onto what the patch applies (and earlier confirmations).
  const one = p.confirmedPatch('providerBaseUrls', ch.confirm[0].value, ch.apply);
  assert.deepEqual(one, { providerBaseUrls: { opencode: 'https://evil.example.com/v1', qwen: 'http://127.0.0.1:8000' } });
  const two = p.confirmedPatch('providerBaseUrls', ch.confirm[1].value, { ...ch.apply, ...one });
  assert.deepEqual(two.providerBaseUrls, { opencode: 'https://evil.example.com/v1', qwen: 'http://127.0.0.1:8000', crush: 'http://10.0.0.5:9000' });
  // Cancel = nothing confirmed: the stored map is ch.apply, i.e. unchanged.
  // Malformed input is refused outright.
  for (const bad of [{ calc: 'http://x' }, { opencode: 'file:///etc/passwd' }, { opencode: 'not a url' }, { opencode: 5 }, 'http://x', ['http://x']]) {
    assert.deepEqual(p.classifyConfigPatch({ providerBaseUrls: bad }, base).rejected, ['providerBaseUrls'], JSON.stringify(bad));
  }
});

test('provider base URL dialog names the provider and the full host', () => {
  const d = p.confirmPrompt('providerBaseUrls', { provider: 'opencode', url: 'https://evil.example.com:8443/v1' });
  assert.match(d.message, /^Send your .+ key to evil\.example\.com:8443\?$/);
  assert.ok(d.detail.includes('https://evil.example.com:8443/v1'));
  const { providerPreset } = loadTs('src/shared/agentProvider.ts');
  assert.equal(d.message, `Send your ${providerPreset('opencode').label} key to evil.example.com:8443?`);
});

test('Free Flow is off by default for new installs', () => {
  assert.equal(CONFIG_DEFAULTS.freeflowEnabled, false);
});

test('a secret is kept as plaintext only when there is no secure storage; other failures are refused', () => {
  const calls = [];
  const mk = (avail, ok) => ({
    encryptionAvailable: () => avail,
    setSecret: (r, v) => { calls.push(['set', r]); return ok ? { ok: true } : { ok: false, error: 'EACCES' }; },
    deleteSecret: (r) => calls.push(['delete', r])
  });
  assert.deepEqual(s.decideSecretStore(mk(true, true), 'config:groqApiKey', 'gsk_x'), { kind: 'stored' });
  calls.length = 0;
  assert.deepEqual(s.decideSecretStore(mk(false, true), 'config:groqApiKey', 'gsk_x'), { kind: 'plaintext' });
  assert.deepEqual(calls, [['delete', 'config:groqApiKey']], 'no store attempt, the stale copy is dropped');
  calls.length = 0;
  assert.deepEqual(s.decideSecretStore(mk(true, false), 'config:groqApiKey', 'gsk_x'), { kind: 'error', error: 'EACCES' });
  assert.deepEqual(calls, [['set', 'config:groqApiKey']], 'the existing encrypted copy is never deleted on a failed store');
  const idx = read('src/main/index.ts');
  assert.match(idx, /function storeConfigSecret\(ref: string, value: string\): StoreOutcome \{\n  const r = decideSecretStore\(/);
});

test('migration backup: an identical earlier backup is reused, a different config gets a new one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-backup-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, '{"slackBotToken":"xoxb-1"}');
  const a = s.writeConfigBackup(cfgPath, new Date(2026, 9, 6, 12, 0, 0));
  assert.equal(path.basename(a), 'config.pre-secrets-20261006120000.json');
  assert.equal(s.writeConfigBackup(cfgPath, new Date(2026, 9, 6, 12, 0, 5)), a);
  assert.equal(s.listConfigBackups(dir).length, 1);
  fs.writeFileSync(cfgPath, '{"slackBotToken":"xoxb-2"}');
  const b2 = s.writeConfigBackup(cfgPath, new Date(2026, 9, 6, 12, 0, 0));
  assert.equal(path.basename(b2), 'config.pre-secrets-20261006120000-1.json');
  assert.equal(fs.readFileSync(b2, 'utf8'), '{"slackBotToken":"xoxb-2"}');
  assert.equal(fs.readFileSync(a, 'utf8'), '{"slackBotToken":"xoxb-1"}');
  assert.equal(s.listConfigBackups(dir).length, 2);
});

test('full reset erases the plaintext backups; removing the legacy webhook secret switches the endpoint off', () => {
  const idx = read('src/main/index.ts');
  const reset = idx.slice(idx.indexOf("ipcMain.handle('app:resetAll'"), idx.indexOf('resetConfig();', idx.indexOf("ipcMain.handle('app:resetAll'")));
  assert.match(reset, /for \(const f of secretBackups\(\)\) \{\n    try \{ rmSync\(f, \{ force: true \}\); \}/);
  const wh = idx.slice(idx.indexOf("ipcMain.handle('webhook:setConfig'"), idx.indexOf("ipcMain.handle('webhook:setConfig'") + 2400);
  assert.match(wh, /if \(p\.secret === null\) \{[\s\S]*integrations\.deleteSecret\(webhookSecretRef\('legacy'\)\)[\s\S]*secret: '', enabled: false/);
  assert.ok(read('src/renderer/src/components/SettingsModal.tsx').includes('backups of your old settings file'));
});

// ─── Fix round 2 ────────────────────────────────────────────────────────────

test('secret-store refusals reach the renderer and are shown inline', () => {
  const idx = read('src/main/index.ts');
  const save = idx.slice(idx.indexOf("ipcMain.handle('webhooks:save'"), idx.indexOf("ipcMain.handle('webhooks:delete'"));
  assert.match(save, /const unavailable = integrations\.secretStoreReadError\(\);\n  if \(unavailable\) return \{ ok: false as const, error: unavailable, list: redactedWebhooks\(\) \};/);
  assert.match(save, /if \(secretErrors\.length\) return \{ ok: false as const, error: secretErrors\.join\(' '\), list: redactedWebhooks\(\) \};/);
  const org = idx.slice(idx.indexOf("ipcMain.handle('org:setTrigger'"), idx.indexOf("ipcMain.handle('triggerHistory:list'"));
  assert.match(org, /else saveError = `The organisation key was not saved: \$\{r\.error\}`;/);
  assert.match(org, /if \(saveError\) return \{ ok: false as const, error: saveError, trigger: redactedOrgTrigger\(\) \};/);
  const upd = idx.slice(idx.indexOf("ipcMain.handle('config:update'"), idx.indexOf("ipcMain.handle('config:restoreClaudeSettings'"));
  assert.match(upd, /return saveError \? \{ \.\.\.out, saveError \} : out;/);
  // Renderer: Settings uses its note lines, the Triggers tab its Callout.
  const sm = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(sm, /if \(res && res\.ok === false\) \{ setWebhookNote\(res\.error \?\? 'could not save'\); return; \}/);
  assert.match(sm, /if \(res && res\.ok === false\) \{ setOrgNote\(res\.error \?\? 'could not save'\); return; \}/);
  assert.match(sm, /\{secretStorage\.readError\}/);
  assert.match(read('src/renderer/src/components/triggers/WebhooksSection.tsx'), /\{saveError && <Callout>\{saveError\}<\/Callout>\}/);
  assert.match(read('src/renderer/src/components/triggers/OrgSection.tsx'), /\{saveError && <Callout>\{saveError\}<\/Callout>\}/);
  // While the file is unreadable the webhook server is left as it is.
  assert.match(idx, /function reconcileWebhookServer\(\): void \{\n[^\n]*\n[^\n]*\n  if \(integrations\.secretStoreReadError\(\)\)/);
});
