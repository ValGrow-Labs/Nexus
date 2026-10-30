'use strict';
// B2b Task 17: docs/nexus/platform-core.md Part IV names the v10 objects exactly as the code does, and states the facts
// the code holds. DOC10-1: the name list in section 51.6 equals V10_EXPECTED (same names, same order), and the DDL block in
// section 51.2 equals V10_DDL byte for byte. The other tests pin the trigger and index tables, the part's structure, the
// two corrections to Part III, the tool, cap and channel tables to their source, and the limits section.
// Plain node: the TypeScript sources load through load-ts without opening a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/nexus/platform-core.md'), 'utf8').replace(/\r\n/g, '\n');
const { V10_EXPECTED, V10_DDL } = loadTs('src/main/nexus/db/schemaV10.ts');
const { V10_CONSENT_CEILINGS, V10_REVOKE_REASONS } = loadTs('src/main/nexus/db/v10Seed.ts');
const { MCP_TOOLS } = loadTs('src/shared/nexus/mcpTools.ts');
const { AGENT_DEFAULTS } = loadTs('src/shared/nexus/agentPolicy.ts');
const { BUILTIN_TOOLS, DISALLOWED_TOOLS } = loadTs('src/runner/runtimes/cliAgent/args.ts');

const PART4_HEAD = '\n# Part IV: Schema v10 and B2b\n';
const PART4 = DOC.slice(DOC.indexOf(PART4_HEAD));

/** The text from the heading line that starts with `start` up to the next heading line that starts with `end`. */
function between(start, end, text = DOC) {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => l.startsWith(start));
  assert.ok(from >= 0, `heading "${start}" not found`);
  const rel = lines.slice(from + 1).findIndex((l) => l.startsWith(end));
  assert.ok(rel >= 0, `heading "${end}" not found after "${start}"`);
  return lines.slice(from + 1, from + 1 + rel).join('\n');
}
/** The text of a Part IV section: from its heading to the next top-level heading of the part (the last one, to the end). */
function section(n) {
  const lines = PART4.split('\n');
  const from = lines.findIndex((l) => l.startsWith(`## ${n}. `));
  assert.ok(from >= 0, `section ${n} not found`);
  const rel = lines.slice(from + 1).findIndex((l) => /^## \d+\. /.test(l));
  return lines.slice(from + 1, rel < 0 ? undefined : from + 1 + rel).join('\n');
}
/** The body of the first fenced block of `lang` in `text`. */
function fenced(text, lang) {
  const m = new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n[ ]*```').exec(text);
  assert.ok(m, `no \`\`\`${lang} block`);
  return m[1];
}
const listOf = (block, key) => {
  const line = block.split('\n').find((l) => l.startsWith(`${key}: `));
  assert.ok(line, `no "${key}:" line in the name list`);
  return line.slice(key.length + 2).split(',').map((s) => s.trim()).filter(Boolean);
};
const rows = (text) => text.split('\n').filter((l) => l.startsWith('| ') && !/^\|[-| ]+\|$/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

// ---------- DOC10-1: the schema ----------

test('DOC10-1 Part IV exists, section 51.6 lists exactly V10_EXPECTED in order, and section 51.2 holds V10_DDL byte for byte', () => {
  assert.ok(DOC.includes(PART4_HEAD));
  assert.ok(DOC.indexOf(PART4_HEAD) > DOC.indexOf('\n# Part III: Schema v9 and B2a\n'), 'Part IV follows Part III');
  const block = fenced(between('### 51.6 ', '## 52. '), 'text');
  assert.deepEqual(listOf(block, 'tables'), Object.keys(V10_EXPECTED.tables));
  assert.deepEqual(listOf(block, 'indexes'), V10_EXPECTED.indexes);
  assert.deepEqual(listOf(block, 'triggers'), V10_EXPECTED.triggers);
  assert.equal(Object.keys(V10_EXPECTED.tables).length, 6);
  assert.equal(V10_EXPECTED.indexes.length, 7);
  assert.equal(V10_EXPECTED.triggers.length, 18);
  const sql = fenced(between('### 51.2 ', '### 51.3 '), 'sql');
  assert.equal(sql, V10_DDL.replace(/^\n/, '').replace(/\n$/, ''), 'the block is V10_DDL, byte for byte');
  assert.ok(sql.includes("NOT LIKE '%\\%'"), 'the one backslash pattern keeps its backslash');
});

test('DOC10-2 sections 51.3 and 51.4 name every v10 trigger and index, and no other ix_, ux_ or tr_ name', () => {
  const triggers = between('### 51.3 ', '### 51.4 ');
  const indexes = between('### 51.4 ', '### 51.5 ');
  const named = (text, re) => [...new Set([...text.matchAll(re)].map((m) => m[1]))];
  assert.deepEqual(named(triggers, /`(tr_[a-z0-9_]+)`/g).sort(), [...V10_EXPECTED.triggers].sort());
  assert.deepEqual(named(indexes, /`((?:ix|ux)_[a-z0-9_]+)`/g).sort(), [...V10_EXPECTED.indexes].sort());
  // A v7, v8 or v9 name in these two sections would be a copy error.
  for (const n of named(triggers + indexes, /`((?:ix|ux|tr)_[a-z0-9_]+)`/g)) {
    assert.ok(V10_EXPECTED.indexes.includes(n) || V10_EXPECTED.triggers.includes(n), `${n} is not a v10 name`);
  }
});

test('DOC10-3 section 51.1 names every v10 table and states the stored ceilings and revoke reasons as the code holds them', () => {
  const tables = between('### 51.1 ', '### 51.2 ');
  for (const t of Object.keys(V10_EXPECTED.tables)) assert.ok(tables.includes(`\`${t}\``), `${t} missing from section 51.1`);
  const c = V10_CONSENT_CEILINGS;
  assert.ok(tables.includes(`\`turn_usd_cents\` 1 to ${c.turnUsdCents}`));
  assert.ok(tables.includes(`\`day_usd_cents\` 1 to ${c.dayUsdCents.toLocaleString('en-US')}`));
  assert.ok(tables.includes(`\`turns_per_hour\` 1 to ${c.turnsPerHour}`));
  assert.ok(tables.includes(`\`concurrent_turns\` exactly ${c.concurrentTurns}`));
  assert.ok(tables.includes(`\`turn_tokens\` 1 to ${c.turnTokens.toLocaleString('en-US')}`));
  assert.ok(tables.includes(`\`tool_calls\` 1 to ${c.toolCalls}`));
  // Never the token text, never its MAC.
  assert.match(tables, /Never the token text and never its MAC/);
  const tokenCols = V10_EXPECTED.tables.capability_tokens;
  assert.ok(!tokenCols.some((col) => /token|mac/i.test(col)), 'the table has no token or MAC column');
  // The revoke reasons the doc says nothing writes are the two the code never passes (section 55.1).
  assert.deepEqual([...V10_REVOKE_REASONS], ['job_ended', 'session_cancelled', 'restart', 'runner_restart', 'budget']);
  const s55 = section(55);
  for (const r of ['job_ended', 'restart', 'runner_restart', 'session_cancelled', 'budget']) assert.ok(s55.includes(r), `${r} in section 55`);
});

// ---------- structure ----------

test('DOC10-4 Part IV has sections 49 to 63 in order, and the contents list links each of them', () => {
  const heads = PART4.split('\n').filter((l) => /^## \d+\. /.test(l)).map((l) => Number(/^## (\d+)\./.exec(l)[1]));
  assert.deepEqual(heads, [49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63]);
  const contents = between('## Contents', '---');
  for (const n of heads) assert.ok(new RegExp(`^${n}\\. \\[`, 'm').test(contents), `section ${n} is in the contents`);
  assert.ok(contents.includes('[Part IV: Schema v10 and B2b](#part-iv-schema-v10-and-b2b)'));
  // Every in-document link of Part IV points at a heading that exists.
  const slug = (h) => h.replace(/^#+\s*/, '').toLowerCase().replace(/[^a-z0-9 _\-]/g, '').replace(/ /g, '-');
  const slugs = new Set(DOC.split('\n').filter((l) => /^#{1,3} /.test(l)).map(slug));
  for (const m of PART4.matchAll(/\]\(#([a-z0-9-]+)\)/g)) assert.ok(slugs.has(m[1]), `link target #${m[1]} exists`);
  // The probe section is added to the Revision 0 list, after section 60.
  assert.match(PART4, /## 61\. The Task 0 probe results and the STOP rules/);
  // The local-model runtime section follows the probe section.
  assert.match(PART4, /## 62\. The local-model runtime/);
  // The hosted-model runtime section follows the local-model section.
  assert.match(PART4, /## 63\. The hosted-model runtime/);
});

test('DOC10-5 the two Part III corrections are made: test:exec passed 39 of 39 in stabilization, and nothing says it never passed', () => {
  const s42 = between('## 42. ', '## 43. ');
  assert.match(s42, /test:exec has passed/);
  assert.match(s42, /39 of 39/);
  assert.doesNotMatch(s42, /has never passed|have never run|never run/i);
  const s46 = between('## 46. ', '## 47. ');
  const row32 = s46.split('\n').find((l) => l.startsWith('| 32 |'));
  assert.ok(row32, 'item 32 is in the section 46 table');
  assert.match(row32, /39 of 39/);
  assert.doesNotMatch(row32, /have not run|never/i);
  // The body of the same item in section 16 agrees with the table.
  const s16 = between('## 16. ', '## 17. ');
  assert.match(s16, /32\. \*\*The real-Docker suites passed in stabilization and have not run since\.\*\*/);
  assert.doesNotMatch(s16, /No image has been built/);
});

test('DOC10-6 Part IV points at no git-ignored report or ledger', () => {
  assert.doesNotMatch(PART4, /\.superpowers|task-\d+-report|progress\.md|b2b-plan|architecture-b2/);
});

test('DOC10-7 the engine is named only in the adapter, change-set, limits, differences and probe sections', () => {
  const VENDOR = /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-/i;
  const allowed = new Set([53, 56, 59, 60, 61]);
  // Sections 62 and 63 (the local-model and hosted-model runtimes) are checked like every neutral section: they name the server and the providers, never the engine.
  for (let n = 49; n <= 63; n++) {
    if (allowed.has(n)) continue;
    assert.doesNotMatch(section(n), VENDOR, `section ${n} names no engine`);
  }
  // Inside section 53 only the adapter subsection (53.5) may.
  const s53 = section(53);
  const adapter = between('### 53.5 ', '### 53.6 ', s53);
  assert.match(adapter, VENDOR);
  assert.doesNotMatch(s53.replace(adapter, ''), VENDOR, 'section 53 names the engine only in 53.5');
});

// ---------- pinned to source ----------

test('DOC10-8 the section 55.2 tool table lists exactly MCP_TOOLS, with their capability and mutates flag', () => {
  const table = rows(between('### 55.2 ', '### 55.3 ', section(55))).filter((r) => /^`[a-z_]+`$/.test(r[0]));
  assert.deepEqual(table.map((r) => r[0].replace(/`/g, '')), MCP_TOOLS.map((t) => t.name));
  for (const t of MCP_TOOLS) {
    const r = table.find((x) => x[0] === `\`${t.name}\``);
    assert.equal(r[1], `\`${t.capability}\``, `${t.name} capability`);
    assert.equal(r[2], t.mutates ? 'yes' : 'no', `${t.name} mutates`);
  }
  assert.match(section(55), /the 11 tools|holds the 11 tools/);
  assert.equal(MCP_TOOLS.length, 11);
});

test('DOC10-9 the section 57 caps table states AGENT_DEFAULTS, and the argv block holds the pinned tool lists', () => {
  const s57 = section(57);
  const d = AGENT_DEFAULTS;
  const n = (x) => x.toLocaleString('en-US');
  assert.ok(s57.includes(`${d.turnUsdCents} cents`));
  assert.ok(s57.includes(`${n(d.dayUsdCents)} cents`));
  assert.ok(s57.includes(`| Turns per hour | ${d.turnsPerHour} |`));
  assert.ok(s57.includes(`| Concurrent turns | ${d.concurrentTurns} |`));
  assert.ok(s57.includes(`| Tokens per turn | ${n(d.turnTokens)} |`));
  assert.ok(s57.includes(`| Tool calls per turn | ${d.toolCalls} |`));
  assert.ok(s57.includes(`| Wall clock | ${d.wallClockMs / 60_000} minutes |`));
  assert.ok(s57.includes(`| Child jobs per turn | ${d.childJobs} |`));
  const argv = fenced(section(53), 'text');
  assert.ok(argv.includes(`--tools ${BUILTIN_TOOLS.join(',')}`));
  assert.ok(argv.includes(`--disallowedTools ${DISALLOWED_TOOLS.join(' ')}`));
  assert.ok(!argv.includes('--safe-mode'), 'the argv has no --safe-mode');
  assert.ok(DISALLOWED_TOOLS.includes('Task') && DISALLOWED_TOOLS.includes('Agent'), 'the subagent tool is listed under both names');
});

test('DOC10-10 the section 58 table lists exactly the agent channels, #42 to #51, in order', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/nexusIpc/registerNexusIpc.ts'), 'utf8');
  const arr = /export const NEXUS_AGENT_CHANNELS[^[]*\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(arr, 'NEXUS_AGENT_CHANNELS found');
  const channels = [...arr[1].matchAll(/'(nexus:[A-Za-z:]+)'/g)].map((m) => m[1]);
  assert.equal(channels.length, 10);
  const table = rows(section(58)).filter((r) => /^\d+$/.test(r[0]));
  assert.deepEqual(table.map((r) => Number(r[0])), [42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
  assert.deepEqual(table.map((r) => r[1].replace(/`/g, '')), channels);
  // The preload carries one literal method per channel.
  const preload = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf8');
  for (const c of channels) assert.ok(preload.includes(`'${c}'`), `${c} is in the preload`);
  const s58 = section(58);
  for (const m of ['nexusAgentStart', 'nexusSessionsList', 'nexusSessionGet', 'nexusSessionEnd', 'nexusSessionCancel', 'nexusReviewDecide',
    'nexusChangeSetAccept', 'nexusRepoStatus', 'nexusRepoMergeAccepted', 'nexusAgentConsent']) {
    assert.ok(s58.includes(m), `${m} is named in section 58`);
    assert.ok(preload.includes(`${m}:`) || preload.includes(`${m}(`) || preload.includes(`${m} `), `${m} exists in the preload`);
  }
});

test('DOC10-11 section 59 numbers its limits 48 on, one after the other, and states each required limit', () => {
  const s59 = section(59);
  const nums = [...s59.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  assert.ok(nums.length >= 17, 'at least the 17 required limits');
  assert.deepEqual(nums, nums.map((_, i) => 48 + i), 'consecutive from 48');
  const need = [
    [/file boundary is policy only, not an OS sandbox/i, 'the file boundary is policy only'],
    [/host proxy routes and records traffic; it is not an OS-level enforcement/i, 'the proxy routes, no OS enforcement'],
    [/Admin-managed CLI settings still apply/i, 'admin-managed settings'],
    [/writes its own files into the user's real home/i, 'the CLI store writes'],
    [/Nexus itself never reads, copies or stores the login/i, 'the login is never read'],
    [/Worktree cleanup is a later feature/i, 'worktree cleanup'],
    [/residual pid-reuse risk/i, 'pid reuse'],
    [/node\.exe/, 'the weak image-name filter'],
    [/accept window \(M8\)/i, 'the accept.prepared window'],
    [/accept\.prepared/, 'accept.prepared'],
    [/16 MiB/, 'the scan cap'],
    [/scan_truncated/, 'scan_truncated'],
    [/tracked files only/i, 'dirty is tracked files only'],
    [/no `node_modules`/i, 'no node_modules in the agent container'],
    [/`cs\.tests_pass`/, 'Nexus validates through cs.tests_pass'],
    [/`job_request`[^.]*approval \(A1\)/i, 'installs through job_request and approval'],
    [/deny-all proxy/i, 'the health check runs through a deny-all proxy'],
    [/`yes`, `no` or `unknown`/, 'auth status becomes yes, no or unknown'],
    [/ScriptedRuntime[^.]*proves the platform wiring/i, 'the scripted runtime proves wiring, not a model'],
    [/real-login smoke test/i, 'the real-login smoke test is not yet run'],
    [/not verified with a real model/, 'built, wiring proven by ScriptedRuntime, not verified with a real model']
  ];
  for (const [re, what] of need) assert.match(s59, re, what);
});

test('DOC10-12 section 49 says what is and is not proven, and the wiring defaults stay off as the code has them', () => {
  const s49 = section(49);
  assert.match(s49, /ScriptedRuntime[^.]*proves the platform wiring/i);
  assert.match(s49, /\*\*A real model turn\.\*\*/);
  assert.match(s49, /\*\*The user's real login, home folder or CLI store\.\*\*/);
  assert.match(s49, /`V10_ENABLED_BY_DEFAULT = false`/);
  const db = fs.readFileSync(path.join(ROOT, 'src/main/db.ts'), 'utf8');
  assert.match(db, /export const V10_ENABLED_BY_DEFAULT = false;/, 'the code default is false, as the doc says');
  assert.match(db, /export const V9_ENABLED_BY_DEFAULT = false;/);
  assert.match(s49, /`NEXUS_ENABLE_V10=1`/);
  assert.match(s49, /`DELIVERED_SUB_PHASE`[\s\S]*`B2B_E2E_STUB`/);
  assert.match(s49, /No real model has been run/);
  // The real-Docker agent suite was run on 2026-10-28 (test:exec PASS 6/6): the doc says so, and still says the model in it is ScriptedRuntime.
  assert.match(s49, /XA1 to XA7 and XA6b[\s\S]{0,200}was run on 2026-10-28 and passes/);
  assert.match(s49, /`ScriptedRuntime`, so this proves the container's isolation[\s\S]{0,200}not a real model/);
  const spec = fs.readFileSync(path.join(ROOT, 'src/shared/nexus/domainSpec.ts'), 'utf8');
  assert.match(spec, /export const CURRENT_SUB_PHASE: SubPhase = 'B2b';/);
});

test('DOC10-13 the proxy records its decisions, a change set is not promotable, and the O-id facts, as the code has them', () => {
  const { EGRESS_EVENT_MAX } = loadTs('src/shared/nexus/runnerProtocol.ts');
  const s54 = section(54);
  assert.equal(EGRESS_EVENT_MAX, 200);
  assert.match(s54, /Every decision is recorded/);
  assert.ok(s54.includes(`At most ${EGRESS_EVENT_MAX} are reported`));
  assert.ok(s54.includes('`egress.truncated { count, at }`'));
  assert.doesNotMatch(s54, /discards them/);
  const s59 = section(59);
  assert.match(s59, /routes and records traffic; it is not an OS-level enforcement/);
  assert.doesNotMatch(s59, /It also does not record/);
  // The code: the runner reports decisions as progress events, and the service refuses a change set.
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src/runner/agentAttempt.ts'), 'utf8'), /onDecision: \(\) => \{/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/main/nexus/artifact/artifactService.ts'), 'utf8'), /change_set_not_promotable/);
  assert.match(s59, /change_set_not_promotable/);
  assert.match(s59, /There is no database trigger/);
  assert.ok(section(58).includes('latestReview { decision, decidedAt } | null'));
  const item66 = s59.split('\n').find((l) => l.startsWith('66. '));
  assert.ok(item66 && !/in progress|not yet refused/.test(item66), 'the promote guard is stated as landed');
  // O-ids: O23 and O24 are defined nowhere in the helper that holds the orphan queries.
  const orphans = fs.readFileSync(path.join(ROOT, 'test/helpers/orphans.cjs'), 'utf8');
  assert.doesNotMatch(orphans, /\bO2[34]\s*:/);
  assert.match(s59, /O23 and O24 are not defined anywhere/);
  assert.match(s59, /about 91 s/);
});

test('DOC10-14 the consent disclosure, the new-in-this-release note and the vendor allow-list are quoted as the code has them', () => {
  // Sources are read with CRLF folded to LF: a Windows checkout (core.autocrlf) holds some of them with CRLF, and the patterns below end at `\n`.
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  // The consent disclosure: the doc quotes the committed string, word for word.
  const model = read('src/renderer/src/nexus/data/executionModel.ts');
  const m = /export const AGENT_STATE_DISCLOSURE =([\s\S]*?);\n/.exec(model);
  assert.ok(m, 'AGENT_STATE_DISCLOSURE found');
  const text = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\'/g, "'")).join('');
  assert.ok(section(54).includes(text), 'section 54 quotes AGENT_STATE_DISCLOSURE exactly');
  assert.doesNotMatch(text, /sandbox with no other network/, 'the false claim is gone from the code');
  assert.match(section(54), /that was false and is gone/);
  // AGENT_NEW_NOTE: the SDE notes carry it, and section 49 quotes it.
  const note = /const AGENT_NEW_NOTE = '([^']*)'/.exec(read('src/shared/nexus/domains/sde.ts'));
  assert.ok(note, 'AGENT_NEW_NOTE found');
  assert.ok(section(49).includes(note[1]), 'section 49 quotes AGENT_NEW_NOTE');
  // The vendor-neutral allow-list: section 59 item 68 states every entry with its count.
  const v5 = /const V5_ALLOWED = \{([\s\S]*?)\};/.exec(read('test/nexus-core-vendor-neutral.test.cjs'));
  assert.ok(v5, 'V5_ALLOWED found');
  // Either format of the allow-list: `'file': 3` (a line count) or `'file': ['hash', ...]` (one hash per allowed line).
  const entries = v5[1].split(/^\s*'(?=src\/)/m).slice(1).map((chunk) => {
    const file = chunk.slice(0, chunk.indexOf("'"));
    const rest = chunk.slice(chunk.indexOf(':') + 1);
    const num = /^\s*(\d+)/.exec(rest);
    return [file, num ? Number(num[1]) : [...rest.matchAll(/^\s*'[0-9a-f]{16}'/gm)].length];
  });
  assert.ok(entries.length >= 8);
  const item68 = section(59).split('\n').find((l) => l.startsWith('68. '));
  for (const [file, n] of entries) {
    const shown = file.startsWith('src/renderer/src/nexus/') ? file.slice('src/renderer/src/nexus/'.length) : file;
    assert.ok(item68.includes(`\`${shown}\` ${n}`), `item 68 lists ${shown} with ${n}`);
  }
  // The final-review behaviours exist in the code the doc describes.
  assert.match(read('src/main/nexus/exec/acceptIngest.ts'), /repo\.integration_resync/);
  assert.match(read('src/main/nexus/review/reviewService.ts'), /preview_incomplete/);
  assert.match(read('src/main/nexus/agents/agentService.ts'), /consent_revoked/);
  for (const w of ['repo.integration_resync', 'preview_incomplete', 'consent_revoked', 'integration_diverged', 'not_cancellable']) {
    assert.ok(PART4.includes(w), `Part IV names ${w}`);
  }
});

test('DOC10-15 the preview verdict, the integration rewrite, the refresh bound and the request_changes rule are stated as the code has them', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const part = PART4;
  // The preview: one shared argv and transform, a closed reason list that includes binary_file.
  const git = read('src/runner/gitWrite.ts');
  for (const name of ['PREVIEW_DIFF_ARGS', 'previewText', 'previewHiddenLines']) {
    assert.ok(git.includes(name), `${name} exists in gitWrite.ts`);
    assert.ok(part.includes(name), `${name} is named in Part IV`);
  }
  assert.match(git, /binary_file/);
  for (const reason of ['truncated', 'too_large', 'binary_file', 'hidden_lines', 'unknown']) assert.ok(section(56).includes('`' + reason + '`'), `section 56 names ${reason}`);
  assert.match(section(56), /password: 'x'/);
  assert.match(section(56), /cannot be approved from Nexus/);
  // The rewrite: main decides, ingest re-checks.
  assert.match(read('src/main/nexus/repo/integrationBaseline.ts'), /rewriteAllowed/);
  for (const w of ['rewriteAllowed()', 'allowRewrite', 'integrationRewrite', 'rewrite_refused', 'rewrite: true']) assert.ok(section(56).includes(w), `section 56 names ${w}`);
  assert.match(section(56), /`entity_id` \(the ref\)/);
  assert.match(read('src/main/nexus/exec/executionService.ts'), /NOT_CANCELLABLE_RECIPES[^\n]*'repo\.worktree'/);
  assert.match(section(56), /`repo\.worktree` cannot be cancelled/);
  // The refresh bound.
  const { MAX_AUTO_REFRESHES } = (() => { const m = /export const MAX_AUTO_REFRESHES = (\d+);/.exec(read('src/main/nexus/agents/agentService.ts')); return { MAX_AUTO_REFRESHES: m ? Number(m[1]) : NaN }; })();
  assert.equal(MAX_AUTO_REFRESHES, 3);
  assert.ok(section(53).includes('`MAX_AUTO_REFRESHES` (3)'));
  assert.match(section(53), /only while a consent is live/);
  // request_changes: no "always recorded" wording anywhere in Part IV, and the structural list is there.
  assert.doesNotMatch(part, /always recorded|it is always recorded/);
  assert.match(section(56), /`turn_running`/);
  assert.match(section(56), /`no_session`/);
});

test('DOC10-16 the off reasons and their sentences, the five preview sentences and the 20 hashed allow-list lines are stated as the code has them', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const copy = read('src/renderer/src/nexus/data/errorCopy.ts');
  const s54 = section(54);
  const quoted = (name) => {
    const reasons = /AGENT_OFF_REASON_TEXT[^{]*\{([\s\S]*?)\}\);/.exec(copy);
    assert.ok(reasons, 'AGENT_OFF_REASON_TEXT found');
    const m = new RegExp(`${name} = '([^']*)'`).exec(copy) || new RegExp(`\\b${name}: '([^']*)'`).exec(reasons[1]);
    assert.ok(m, `${name} found in errorCopy.ts`);
    return m[1];
  };
  for (const name of ['AGENT_OFF_TEXT', 'database', 'held', 'AGENT_ACTION_OFF_TEXT']) assert.ok(s54.includes(quoted(name)), `section 54 quotes ${name}`);
  assert.match(read('src/shared/nexus/ipc.ts'), /offReason\?: 'build' \| 'database' \| 'held' \| 'execution' \| null;/);
  assert.match(read('src/main/nexusIpc/agentSetup.ts'), /export function offReasonOf/);
  assert.ok(s54.includes('`AgentSetupView.offReason`'));
  // The five preview sentences: five distinct fixed sentences, one per closed reason, and the doc names the five reasons.
  const cs = read('src/renderer/src/nexus/project/changeSetModel.ts');
  const block = /PREVIEW_INCOMPLETE_TEXT[^{]*\{([\s\S]*?)\}\);/.exec(cs);
  assert.ok(block, 'PREVIEW_INCOMPLETE_TEXT found');
  const sentences = [...block[1].matchAll(/^\s*(\w+):\s*'([^']*)'/gm)];
  assert.deepEqual(sentences.map((x) => x[1]).sort(), ['binary_file', 'hidden_lines', 'too_large', 'truncated', 'unknown', 'unsafe_characters']);
  assert.equal(new Set(sentences.map((x) => x[2])).size, 6, 'six distinct sentences');
  assert.doesNotMatch(sentences[0][2], /agent (added|wrote)/i, 'hidden_lines makes no claim that the agent added a secret');
  // The vendor allow-list pins each line by hash: 20 lines in all, as the doc says (17 before the local-model adapter's three:
  // 2 in localModel/fileTools.ts and 1 in localModel/prompt.ts, its refusal of the agent CLI's per-worktree settings folder).
  const v5 = /const V5_ALLOWED = \{([\s\S]*?)\n\};/.exec(read('test/nexus-core-vendor-neutral.test.cjs'));
  assert.ok(v5);
  const hashes = [...v5[1].matchAll(/^\s*'[0-9a-f]{16}'/gm)].length;
  assert.equal(hashes, 20);
  assert.ok(section(59).includes('each of the 20 allowed lines'));
  assert.ok(section(53).includes('each of the 20 allowed lines'));
});

test('DOC10-17 the base_moved sentence and the unsafe-character set are stated as the code has them', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // base_moved: main's fixed sentence, word for word, in the doc.
  const env = read('src/main/nexusIpc/envelope.ts');
  const m = /\bbase_moved: '([^']*)'/.exec(env);
  assert.ok(m, 'base_moved found in AGENT_REASON_MESSAGES');
  assert.ok(section(56).includes(m[1]), 'section 56 quotes the base_moved sentence');
  // The renderer mirrors it word for word.
  assert.ok(read('src/renderer/src/nexus/data/errorCopy.ts').includes(m[1]));
  // The unsafe set: the doc's list equals the runner's regex class, code point for code point.
  const git = read('src/runner/gitWrite.ts');
  const re = /const UNSAFE_CHAR_RE = \/\[([^\]]*)\]\/g;/.exec(git);
  assert.ok(re, 'UNSAFE_CHAR_RE found');
  const fromCode = new Set();
  const cls = re[1];
  for (const x of cls.matchAll(/\\u([0-9A-Fa-f]{4})(?:-\\u([0-9A-Fa-f]{4}))?/g)) {
    const a = parseInt(x[1], 16); const b = x[2] ? parseInt(x[2], 16) : a;
    for (let c = a; c <= b; c++) fromCode.add(c);
  }
  const block = /The flagged set is exactly:\n\n```text\n([\s\S]*?)\n```/.exec(section(56));
  assert.ok(block, 'the flagged set is listed in section 56');
  const fromDoc = new Set();
  for (const line of block[1].split('\n')) {
    const r = /^U\+([0-9A-F]{4})(?:-U\+([0-9A-F]{4}))?/.exec(line);
    assert.ok(r, `a code point range: ${line}`);
    const a = parseInt(r[1], 16); const b = r[2] ? parseInt(r[2], 16) : a;
    for (let c = a; c <= b; c++) fromDoc.add(c);
    if (/except/.test(line)) for (const e of [...line.matchAll(/U\+([0-9A-F]{4})/g)].slice(2)) fromDoc.delete(parseInt(e[1], 16));
  }
  assert.deepEqual([...fromDoc].sort((x, y) => x - y), [...fromCode].sort((x, y) => x - y));
  assert.ok(fromDoc.has(0x200c), 'U+200C is flagged');
  assert.ok(!fromDoc.has(0x09) && !fromDoc.has(0x0a) && !fromDoc.has(0x0d));
  // The two exceptions are in the code and in the doc.
  assert.match(git, /200D/i);
  assert.match(section(56), /U\+200D between two emoji/);
  assert.match(section(56), /very first character of a file's first line/);
  // A gitlink-touching change is refused with the existing code; there is no submodule_change reason.
  assert.match(git, /diff-tree/);
  assert.doesNotMatch(git, /submodule_change/);
  assert.match(section(56), /There is no `submodule_change` reason/);
});

// ---------- section 62: the local-model runtime, and the items and the collect rule that came with it ----------

test('DOC10-18 section 62, the collect by-product rule and limits 81 to 88 are stated as the code has them', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const s62 = section(62);
  const lm = loadTs('src/shared/nexus/localModel.ts');
  // The kind, the loopback rule and the five fixed reasons.
  assert.equal(lm.LOCAL_MODEL_KIND, 'local-model');
  assert.ok(s62.includes('`local-model`'));
  assert.deepEqual([lm.normalizeLoopbackHost('localhost'), lm.normalizeLoopbackHost('127.0.0.1'), lm.normalizeLoopbackHost('[::1]'), lm.normalizeLoopbackHost('127.0.0.2'), lm.normalizeLoopbackHost('example.com')],
    ['127.0.0.1', '127.0.0.1', '::1', null, null]);
  for (const r of lm.LOCAL_MODEL_REASONS) assert.ok(s62.includes('`' + r + '`'), `section 62 names ${r}`);
  assert.equal(lm.LOCAL_MODEL_REASONS.length, 5);
  assert.ok(s62.includes('`127.0.0.1:11434`'));
  assert.match(read('src/runner/runtimes/localModel/endpoint.ts'), /DEFAULT_ENDPOINT[^=]*= Object\.freeze\(\{ host: '127\.0\.0\.1', port: 11434 \}\)/);
  // No proxy for this kind; the runner checks loopback and the canonical hash itself.
  assert.match(read('src/runner/agentAttempt.ts'), /if \(plan\.runtime\.kind === LOCAL_MODEL_KIND\) \{[\s\S]*?loopbackConsentOk\(plan\.egress\)[\s\S]*?consent_mismatch/);
  assert.match(s62, /starts \*\*no proxy\*\*/);
  assert.match(s62, /every host must be a loopback address/);
  assert.match(s62, /`consentHostsSha256`/);
  assert.match(s62, /`hosts_sha256`/);
  // The tools, the loop's bounds, the file limits and the tuning, as the code holds them.
  const tools = read('src/runner/runtimes/localModel/fileTools.ts');
  for (const t of ['read_file', 'write_file', 'list_files', 'delete_file']) {
    assert.ok(tools.includes(`'${t}'`));
    assert.ok(s62.includes('`' + t + '`'), `section 62 names ${t}`);
  }
  assert.match(tools, /readMaxBytes: 256 \* 1024, writeMaxBytes: 256 \* 1024, writeTotalBytes: 8 \* 1024 \* 1024, listMaxEntries: 400, listMaxDepth: 8/);
  assert.match(s62, /256 KiB[\s\S]*8 MiB[\s\S]*400 entries and 8 levels/);
  const core = /CORE_MCP_TOOLS: readonly string\[\] = Object\.freeze\(\[([^\]]*)\]\)/.exec(read('src/runner/runtimes/localModel/adapter.ts'));
  assert.ok(core, 'CORE_MCP_TOOLS found');
  const coreNames = [...core[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(coreNames, ['context_get', 'sandbox_exec', 'changeset_register']);
  for (const t of coreNames) assert.ok(s62.includes('`' + t + '`'), `section 62 names ${t}`);
  const loop = read('src/runner/runtimes/localModel/loop.ts');
  const num = (name) => Number(new RegExp(`const ${name} = (\\d+);`).exec(loop)[1]);
  assert.deepEqual([num('MAX_CONSECUTIVE_STRIKES'), num('MAX_TOTAL_STRIKES'), num('REPEAT_FAIL_NOTICE'), num('REPEAT_FAIL_ABORT'), num('REPEAT_SAME_ABORT'), num('MAX_CALLS_PER_REPLY'), num('MAX_NUDGES'), num('MAX_NUDGES_TOTAL')],
    [4, 12, 3, 5, 6, 8, 2, 10]);
  assert.match(loop, /export const MAX_TOOL_CALLS = 200;/);
  assert.match(loop, /numCtx: 16384, numPredict: 4096/);
  assert.match(loop, /costUsdCents: 0, estimated: false/);
  assert.match(s62, /four in a row, or twelve in a turn/);
  assert.match(s62, /failed three times[\s\S]*fifth failure, or six identical calls/);
  assert.match(s62, /at most twice per kind, ten in all/);
  assert.match(s62, /`num_ctx` 16384, `num_predict` 4096/);
  assert.match(s62, /At most 8 calls of a reply are run/);
  assert.match(s62, /`costUsdCents` is `0` and `estimated` is `false`/);
  assert.match(s62, /The runtime registers nothing itself/);
  // The probe asks for kinds, with the closed shape the protocol holds.
  const proto = loadTs('src/shared/nexus/runnerProtocol.ts');
  assert.equal(proto.PROBE_KINDS_MAX, 4);
  assert.equal(proto.PROBE_KIND_RE.source, '^[a-z][a-z0-9_.-]{0,31}$');
  assert.equal(proto.parseProbeKinds([]), null);
  assert.deepEqual(proto.parseProbeKinds(['local-model', 'local-model']), ['local-model']);
  assert.ok(s62.includes('`^[a-z][a-z0-9_.-]{0,31}$`'));
  assert.match(s62, /one to four distinct runtime-kind ids/);
  assert.match(s62, /\*\*checks nothing\*\*/);
  assert.match(s62, /never runs the vendor CLI/);
  assert.match(read('src/main/nexus/platform.ts'), /\.\.\.\(kinds \? \{ kinds \} : \{\}\)/);
  // #51's ops, `turn_live`, and where the model is kept.
  assert.match(read('src/main/nexusIpc/registerNexusIpc.ts'), /\['get', 'grant', 'revoke', 'switch', 'model'\] as const/);
  for (const op of ['grant', 'switch', 'model']) assert.match(s62, new RegExp('\\| `' + op + '` \\|'));
  for (const w of ['turn_live', 'runtime_unknown', 'bad_model']) assert.ok(s62.includes('`' + w + '`'), `section 62 names ${w}`);
  assert.match(read('src/main/nexus/agents/agentService.ts'), /'a turn is running; finish or stop it before switching the runtime', 'turn_live'/);
  assert.match(read('src/main/nexus/agents/budgetService.ts'), /op: 'model'/);
  assert.match(read('src/main/nexus/agents/localModelSettings.ts'), /SETTINGS_ENTRY = 'opencode'/);
  assert.match(s62, /V10_DDL` is unchanged/);
  // The collect by-products: every pathspec of COLLECT_NOISE_EXCLUDE is named in section 56.3, with the reason.
  const git = read('src/runner/gitWrite.ts');
  const noise = /COLLECT_NOISE_EXCLUDE: readonly string\[\] = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(git);
  assert.ok(noise, 'COLLECT_NOISE_EXCLUDE found');
  const specs = [...noise[1].matchAll(/':\(glob,exclude\)([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(specs, ['**/__pycache__', '**/__pycache__/**', '**/*.pyc', '**/.pytest_cache', '**/.pytest_cache/**']);
  const s563 = between('### 56.3 ', '### 56.4 ', section(56));
  for (const p of specs) assert.ok(s563.includes('`' + p + '`'), `section 56.3 names ${p}`);
  assert.match(s563, /`COLLECT_NOISE_EXCLUDE`/);
  assert.match(s563, /binary `\.pyc`[\s\S]*Approve was refused/);
  assert.match(git, /\.\.\.COLLECT_ALWAYS_EXCLUDE, \.\.\.COLLECT_NOISE_EXCLUDE\]/);
  // Limits 81 to 88 exist and say what was ruled they say (DOC10-11 already pins that the numbering is consecutive).
  const s59 = section(59);
  const need = [
    [/81\. \*\*Only the model server's default address can be granted/, '81'], [/127\.0\.0\.1:11434/, '81 names the default address'],
    [/82\. \*\*Switching runtime needs a revoke, then a grant/, '82'],
    [/83\. \*\*The host file tools check a path, then use it/, '83'], [/O_NOFOLLOW/, '83 names O_NOFOLLOW'],
    [/84\. \*\*A server that is not running keeps the vendor reason code/, '84'], [/`runtime_not_installed`/, '84 names the code'],
    [/85\. \*\*The chosen model is stored in the consent's audit rows/, '85'],
    [/86\. \*\*A small local model has not completed a task/, '86'], [/`qwen2\.5-coder:7b`/, '86 names the model'], [/A successful real run is NOT verified/, '86 says not verified'],
    [/87\. \*\*The real CLI runtime is still not verified with a real login/, '87'],
    [/88\. \*\*The weather showcase did not use a model through Nexus/, '88'], [/handed to Nexus through the scripted runtime/, '88 says scripted']
  ];
  for (const [re, what] of need) assert.match(s59, re, what);
  for (const h of ['7a2ae935', '960dc77b', 'ca0be7db']) assert.ok(s59.includes('`' + h + '`'), `item 86 cites ${h}`);
  // The qualification in section 49 keeps the earlier sentence and adds the local-model facts; the caveat of item 64 stays.
  assert.match(section(49), /No real model has been run/);
  assert.match(section(49), /did not complete a task/);
  assert.match(s59, /not verified with a real model/);
});

// ---------- section 63: the hosted-model runtime, and limits 89 to 96 ----------

test('DOC10-19 section 63 states the hosted-model runtime as the code has it (kind, hosts, models, sentences, backoff, key rules, IPC), limits 89 to 96 exist, and providers are named only there', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const s63 = section(63);
  const hm = loadTs('src/shared/nexus/hostedModel.ts');
  const presets = loadTs('src/runner/runtimes/hostedModel/presets.ts');
  const { MSG } = loadTs('src/runner/runtimes/hostedModel/messages.ts');
  const { DEFAULT_BACKOFF } = loadTs('src/runner/runtimes/hostedModel/client.ts');
  const { HOSTED_TUNING } = loadTs('src/runner/runtimes/hostedModel/adapter.ts');
  const proto = loadTs('src/shared/nexus/runnerProtocol.ts');
  const { AGENT_REASON_MESSAGES } = loadTs('src/main/nexusIpc/envelope.ts');
  const { hostedKeyRef } = loadTs('src/main/nexus/agents/hostedModelSettings.ts');
  // The kind and its probe-level facts.
  assert.equal(hm.HOSTED_MODEL_KIND, 'hosted-model');
  assert.ok(s63.includes('`hosted-model`'));
  assert.match(read('src/runner/runtimes/hostedModel/adapter.ts'), /ADAPTER_LABEL = 'Hosted free-API model'/);
  assert.ok(s63.includes('"Hosted free-API model"'));
  assert.equal(proto.RUNTIME_PROVIDERS_MAX, 8); assert.equal(proto.RUNTIME_PROVIDER_HOSTS_MAX, 4);
  assert.match(s63, /at most 8 providers and 4 hosts each/);
  // The preset table: every provider id, host and default model, and the one consent list, as the table holds them (H2).
  assert.equal(presets.PROVIDER_PRESETS.length, 2);
  for (const p of presets.PROVIDER_PRESETS) {
    assert.ok(s63.includes('`' + p.id + '`'), `section 63 names provider ${p.id}`);
    assert.ok(s63.includes('`' + p.host + '`'), `section 63 names host ${p.host}`);
    assert.ok(s63.includes('`' + p.defaultModel + '`'), `section 63 names ${p.defaultModel}`);
    assert.equal(p.port, 443);
  }
  for (const h of presets.allPresetHosts()) assert.ok(s63.includes('`' + h.host + ':' + h.port + '`'), `section 63 names ${h.host}:${h.port} as the consented list`);
  assert.match(s63, /D-B2's rule \(one destination, the adapter's own\) is changed \*\*for this runtime only\*\*/);
  assert.match(s63, /still holds, unchanged, for the CLI runtime/);
  assert.match(s63, /\*\*does\*\* start the turn's host egress proxy/);
  assert.match(s63, /`CONNECT <host>:443`/);
  assert.match(s63, /the model provider is not one that was granted/);
  assert.equal(MSG.notGranted, 'the model provider is not one that was granted');
  assert.match(s63, /V10_DDL` is unchanged/);
  // The six reasons: the runner's sentence and main's sentence, word for word, in one table; and the map between them.
  assert.equal(hm.HOSTED_MODEL_REASONS.length, 6);
  const table = rows(between('### 63.7 ', '### 63.8 ', s63)).filter((r) => /^`hosted_/.test(r[0]));
  assert.deepEqual(table.map((r) => r[0].replace(/`/g, '')), [...hm.HOSTED_MODEL_REASONS], 'the table lists the six reasons in the code\'s order');
  for (const [reason, runner, main] of table.map((r) => [r[0].replace(/`/g, ''), r[1], r[2]])) {
    assert.ok(hm.HOSTED_MODEL_REASONS.includes(reason), reason);
    assert.equal(hm.HOSTED_RUNNER_MESSAGE_REASON[runner], reason, `${reason}: the runner sentence maps to it`);
    assert.equal(AGENT_REASON_MESSAGES[reason], main, `${reason}: main's sentence is quoted word for word`);
  }
  assert.deepEqual(Object.keys(hm.HOSTED_RUNNER_MESSAGE_REASON).sort(), [MSG.keyMissing, MSG.keyRejected, MSG.rateLimited, MSG.quotaExhausted, MSG.modelUnavailable, MSG.notChosen].sort());
  for (const [what, m] of [['the conversation is too long', MSG.contextTooLong], ['no egress proxy is running', MSG.noProxy], ['the proxy refused the connection', MSG.proxyRefused],
    ['the provider could not be reached', MSG.unreachable], ['the connection could not be secured', MSG.tlsFailed], ['the provider did not answer in time', MSG.timeout],
    ['the answer was larger than allowed', MSG.tooLarge], ['the answer was a redirect', MSG.redirect], ['the answer could not be read', MSG.badJson], ['the request was refused (the model may not support tool calls)', MSG.refused]]) {
    assert.ok(s63.includes(what), `section 63 says: ${what}`);
    assert.ok(typeof m === 'string' && m.length > 0);
  }
  assert.match(s63, /`the model provider reported an error \(HTTP n\)`/);
  assert.equal(MSG.server(500), 'the model provider reported an error (HTTP 500)');
  // Free-tier behaviour: the backoff numbers and the tuning, as the code holds them (H4).
  assert.deepEqual([DEFAULT_BACKOFF.baseMs, DEFAULT_BACKOFF.maxWaitMs, DEFAULT_BACKOFF.max429, DEFAULT_BACKOFF.max5xx, DEFAULT_BACKOFF.maxBadGeneration], [1000, 60_000, 4, 3, 2]);
  assert.match(s63, /retried up to 4 times and a 5xx up to 3/);
  assert.match(s63, /doubles from 1 s, capped at 60 s/);
  assert.match(s63, /retried twice, then handed to the loop as an empty reply/);
  assert.deepEqual([HOSTED_TUNING.numCtx, HOSTED_TUNING.numPredict, HOSTED_TUNING.chatTimeoutMs], [16384, 4096, 120_000]);
  assert.match(s63, /`num_ctx` 16384 and `num_predict` 4096/);
  assert.match(s63, /a 120 s timeout per request/);
  assert.match(read('src/runner/runtimes/hostedModel/adapter.ts'), /temperature: 0\.2/);
  assert.match(s63, /temperature 0\.2/);
  assert.match(s63, /`costUsdCents` is `0` and `estimated` is `false`/);
  // The key (H3): where it lives, its shape, the IPC, the plan field, what the audit row holds.
  assert.equal(hostedKeyRef('groq'), 'config:hosted:groq');
  assert.ok(s63.includes('`config:hosted:<providerId>`'));
  assert.equal(proto.RUNTIME_API_KEY_RE.source, '^[\\x21-\\x7e]{8,512}$');
  assert.ok(s63.includes('`^[\\x21-\\x7e]{8,512}$`'));
  assert.match(read('src/main/nexus/agents/hostedModelSettings.ts'), /const PASTE_MAX = 4096;/);
  assert.match(s63, /over 4096 characters is refused whole/);
  const index = read('src/main/index.ts');
  for (const ch of ['hostedKey:set', 'hostedKey:delete', 'hostedKey:present']) {
    assert.ok(index.includes(`ipcMain.handle('${ch}'`), `${ch} is registered`);
    assert.ok(s63.includes('`' + ch + '`'), `section 63 names ${ch}`);
  }
  assert.match(s63, /booleans and fixed sentences only/);
  assert.ok(s63.includes('`plan.runtime.apiKey`'));
  assert.match(read('src/main/nexus/agents/agentService.ts'), /hostedKeys\?\.resolve\(hp\.provider!\)/);
  assert.match(s63, /resolves the key \*\*before it mints anything\*\*/);
  assert.match(read('src/main/nexus/agents/agentService.ts'), /action: 'hosted\.key'/);
  assert.ok(s63.includes('`hosted.key`'));
  assert.match(read('src/main/nexus/agents/agentService.ts'), /reason: 'hosted_key_deleted'/);
  assert.ok(s63.includes('`hosted_key_deleted`'));
  assert.match(s63, /never plaintext/);
  assert.match(s63, /Replacing\*\* a key does not stop a running turn/);
  // The probe is offline and key-blind, and #51 gains `provider`.
  assert.match(s63, /no network call and uses no key/);
  assert.match(s63, /`signedIn` is `unknown`/);
  assert.match(read('src/runner/runtimes/hostedModel/adapter.ts'), /signedIn: 'unknown'/);
  assert.match(read('src/main/nexusIpc/registerNexusIpc.ts'), /\['get', 'grant', 'revoke', 'switch', 'model'\] as const/);
  assert.match(s63, /exactly `op` plus optional `caps`, `runtime`, `model` and `provider`/);
  // Every file the section names exists.
  for (const m of s63.matchAll(/`((?:test|tools|src)\/[A-Za-z0-9_./*-]+)`/g)) {
    const p = m[1];
    if (p.includes('*')) assert.ok(fs.readdirSync(path.join(ROOT, path.dirname(p))).some((n) => n.startsWith(path.basename(p).split('*')[0])) || fs.existsSync(path.join(ROOT, p.replace(/\/\*$/, ''))), `${p} exists`);
    else assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} exists`);
  }
  // Limits 89 to 96, as ruled; item 96 says plainly that nothing real has been run (DOC10-11 pins the numbering).
  const s59 = section(59);
  const need = [
    [/89\. \*\*Switching to or from the hosted runtime needs a revoke, then a grant/, '89'],
    [/90\. \*\*Settings needs the probe to have run before a key can be saved/, '90'],
    [/91\. \*\*Replacing a key does not stop a running turn/, '91'],
    [/92\. \*\*Free-tier quotas and rate limits are the provider's/, '92'],
    [/93\. \*\*The provider quirks in the preset table are unverified against the live APIs/, '93'],
    [/94\. \*\*The sandbox needs Docker Desktop, which is a barrier for casual free users/, '94'],
    [/95\. \*\*Corporate TLS interception fails closed/, '95'],
    [/96\. \*\*No real provider call has been made, and a hosted model has not completed a task/, '96'],
    [/is \*\*NOT verified\*\*; no number of mock passes stands in for it/, '96 says not verified']
  ];
  for (const [re, what] of need) assert.match(s59, re, what);
  const nums = [...s59.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  assert.equal(nums[nums.length - 1], 96);
  // Section 49 and the differences table carry the qualification and the rulings (H2, H3).
  assert.match(section(49), /No real provider call has been made with any key/);
  assert.match(section(49), /first secret Nexus keeps/);
  const s60 = section(60);
  for (const w of ['A third runtime', 'Hosted-model destination (H2)', 'Provider key (H3)']) assert.ok(s60.includes(`| ${w} |`), `section 60 has ${w}`);
  // The vendor-neutral rule for docs (the counterpart of the code's V6): a hosted provider's name or host is written in section 63 only, in Part IV.
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const PROVIDER_WORDS = new RegExp(presets.PROVIDER_PRESETS.flatMap((p) => [p.id, p.host]).map(esc).join('|') + '|googleapis|generativelanguage', 'i');
  for (let n = 49; n <= 62; n++) assert.doesNotMatch(section(n), PROVIDER_WORDS, `section ${n} names no hosted provider`);
});

test('DOC10-20 the README says Nexus works with free AI (hosted free keys, a local model, the installed CLI as an option), keeps the status caveat, the licence and the credits', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(readme, /^## Works with free AI$/m);
  const para = between('## Works with free AI', '## ', readme);
  assert.match(para, /free API key/i); assert.match(para, /Groq/); assert.match(para, /Gemini/); assert.match(para, /Ollama/); assert.match(para, /Claude/);
  assert.match(para, /optional/i); assert.match(para, /Docker/); assert.match(para, /not yet verified|not verified/i);
  assert.match(para, /encrypted/i);
  assert.match(readme, /docs\/nexus\/platform-core\.md/);
  assert.match(readme, /\[`LICENSE`\]\(\.\/LICENSE\)/);
  assert.match(readme, /\[`ATTRIBUTION\.md`\]/);
  assert.match(readme, /MIT-licensed open-source\s+agent harness/);
});
