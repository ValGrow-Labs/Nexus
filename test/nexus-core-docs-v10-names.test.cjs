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

test('DOC10-4 Part IV has sections 49 to 61 in order, and the contents list links each of them', () => {
  const heads = PART4.split('\n').filter((l) => /^## \d+\. /.test(l)).map((l) => Number(/^## (\d+)\./.exec(l)[1]));
  assert.deepEqual(heads, [49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61]);
  const contents = between('## Contents', '---');
  for (const n of heads) assert.ok(new RegExp(`^${n}\\. \\[`, 'm').test(contents), `section ${n} is in the contents`);
  assert.ok(contents.includes('[Part IV: Schema v10 and B2b](#part-iv-schema-v10-and-b2b)'));
  // Every in-document link of Part IV points at a heading that exists.
  const slug = (h) => h.replace(/^#+\s*/, '').toLowerCase().replace(/[^a-z0-9 _\-]/g, '').replace(/ /g, '-');
  const slugs = new Set(DOC.split('\n').filter((l) => /^#{1,3} /.test(l)).map(slug));
  for (const m of PART4.matchAll(/\]\(#([a-z0-9-]+)\)/g)) assert.ok(slugs.has(m[1]), `link target #${m[1]} exists`);
  // The probe section is added to the Revision 0 list, after section 60.
  assert.match(PART4, /## 61\. The Task 0 probe results and the STOP rules/);
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
  for (let n = 49; n <= 61; n++) {
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
    [/host proxy routes traffic; it is not an OS-level enforcement/i, 'the proxy routes, no OS enforcement'],
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
    [/B2b is \*\*built, not verified\*\*/, 'built, not verified']
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
  assert.match(s49, /`DELIVERED_SUB_PHASE`[\s\S]*It stays `'B2a'`/);
  const spec = fs.readFileSync(path.join(ROOT, 'src/shared/nexus/domainSpec.ts'), 'utf8');
  assert.match(spec, /export const CURRENT_SUB_PHASE: SubPhase = 'B2b';/);
});
