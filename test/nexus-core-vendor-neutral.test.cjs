'use strict';
// The execution model is vendor-neutral: agent engines sit behind the AgentRuntime
// interface, and no shared type, schema or job kind is named after one. V1 scans
// every file under src/shared/nexus (runtime.ts through V2) plus the files in
// LATER that exist; the required ones must exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-/i;
const REQUIRED = ['src/shared/nexus/execution.ts', 'src/shared/nexus/runnerProtocol.ts', 'src/shared/nexus/evidence.ts',
  'src/shared/nexus/resourceGate.ts', 'src/shared/nexus/preflightCheck.ts', 'src/shared/nexus/secretShape.ts', 'src/shared/nexus/ipc.ts'];
const LATER = ['src/main/nexus/db/schemaV9.ts', 'src/main/nexus/db/schemaV10.ts'];
/** Every file under src/shared/nexus (fix round 1 of B2a Task 2): new contract files are scanned without editing this list. */
const walkShared = (dir, re = /\.(ts|cjs|js)$/) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walkShared(dir + '/' + e.name, re) : re.test(e.name) ? [dir + '/' + e.name] : []);
/**
 * B2b Task 1, the named edit (Global Constraints, "Vendor-neutral scan"): the scan also covers the agent, repository and
 * review code of main, the renderer's agent panel (each walked once it exists) and the Nexus-owned skills. The skills
 * are `resources/skills/nexus-*` only: the other folders under resources/skills are the legacy app's bundled skills,
 * which are not Nexus code. Engine names may appear only in src/runner/runtimes/cliAgent/**, the agent harness, the
 * runtime tests, the probe tool and their fixtures.
 */
const B2B_DIRS = ['src/main/nexus/agents', 'src/main/nexus/repo', 'src/main/nexus/review', 'src/renderer/src/nexus/agent'];
const SKILLS_ROOT = 'resources/skills';
const nexusSkills = () => fs.readdirSync(path.join(ROOT, SKILLS_ROOT), { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('nexus-')).flatMap((e) => walkShared(`${SKILLS_ROOT}/${e.name}`, /./));
const b2bScanned = () => [...B2B_DIRS.filter((d) => fs.existsSync(path.join(ROOT, d))).flatMap((d) => walkShared(d, /\.(ts|tsx|cjs|js)$/)),
  ...nexusSkills()];
const RUNTIME = 'src/shared/nexus/runtime.ts';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const hits = (text) => text.split(/\r?\n/).map((line, i) => [i + 1, line]).filter(([, l]) => VENDOR.test(l));
/** Source text with every comment removed (via the TypeScript scanner, so strings stay intact). */
function codeOnly(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  let out = '';
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k === ts.SyntaxKind.SingleLineCommentTrivia || k === ts.SyntaxKind.MultiLineCommentTrivia) continue;
    out += scanner.getTokenText();
  }
  return out;
}

test('V1 no engine or vendor name anywhere in the shared execution contracts (code or comments)', () => {
  for (const rel of REQUIRED) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} exists`);
  // runtime.ts may name engines in comments only; V2 scans its code. Everything else is scanned whole.
  const shared = walkShared('src/shared/nexus').filter((rel) => rel !== RUNTIME);
  assert.ok(shared.length >= REQUIRED.length + 10, 'the walk sees the shared contracts');
  const scanned = [...new Set([...REQUIRED, ...shared, ...LATER.filter((rel) => fs.existsSync(path.join(ROOT, rel))), ...b2bScanned()])];
  // The widened scan sees the four Nexus skills (B2b Task 1).
  const skills = nexusSkills();
  for (const id of ['nexus-sde-change', 'nexus-sde-tests-first', 'nexus-sde-requirement-draft', 'nexus-sde-app-manifest'])
    assert.ok(skills.includes(`${SKILLS_ROOT}/${id}/SKILL.md`), `the scan covers ${id}`);
  const found = scanned.flatMap((rel) => hits(read(rel)).map(([n, l]) => `${rel}:${n}: ${l.trim()}`));
  assert.deepEqual(found, []);
});

test('V2 runtime.ts names engines only inside comments describing the adapters', () => {
  const text = read(RUNTIME);
  const code = codeOnly(text);
  assert.ok(code.includes('AgentRuntime') && code.includes('RunRequest'), 'the scanner kept the code');
  assert.equal(VENDOR.test(code), false, 'no engine name in a type or value');
  assert.equal(VENDOR.test(codeOnly('// claude\nconst a = 1;')), false, 'comment stripping works');
  assert.equal(VENDOR.test(codeOnly('const a = "claude";')), true, 'strings are kept');
});

test('V3 RuntimeKind is a branded string, not a union of engine literals; RunRequest assumes no provider', () => {
  const sf = ts.createSourceFile('runtime.ts', read(RUNTIME), ts.ScriptTarget.Latest, true);
  const alias = sf.statements.find((s) => ts.isTypeAliasDeclaration(s) && s.name.text === 'RuntimeKind');
  assert.ok(alias, 'RuntimeKind is declared');
  assert.ok(ts.isIntersectionTypeNode(alias.type), 'string & brand');
  assert.ok(alias.type.types.some((t) => t.kind === ts.SyntaxKind.StringKeyword));
  assert.equal(alias.type.types.some((t) => ts.isLiteralTypeNode(t)), false);
  const code = codeOnly(read(RUNTIME)).replace(/\s+/g, '');
  assert.match(code, /model:\{provider:string;model:string\}/);
  assert.match(code, /credential:\{ref:string\}/);
  assert.equal(Object.keys(loadTs(RUNTIME)).length, 0, 'types only: no runtime value');
});

test('V4 the runner protocol accepts any well-formed runtime kind and favours none', () => {
  const { parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');
  const msg = (kind) => ({ op: 'probe.result', freeBytes: null, images: [],
    probe: { docker: 'missing', gpu: { detected: false, usableInContainers: false } },
    runtimes: [{ kind, health: { ok: false, reason: 'not_installed', detail: 'not in this release' } }] });
  for (const kind of ['scripted', 'engine-a', 'x2']) assert.ok(parseRunnerMessage(msg(kind)), kind);
  for (const kind of ['', 'Engine', 'has space', 'a'.repeat(33), 7]) assert.equal(parseRunnerMessage(msg(kind)), null, String(kind));
  const execution = loadTs('src/shared/nexus/execution.ts');
  const values = JSON.stringify(Object.values(execution));
  assert.equal(VENDOR.test(values), false, 'no engine name in a profile, parser or output code');
});

/**
 * V5 (B2b final review I7): the engine's name stays at the engine boundary. Every Nexus file of main, the runner, the IPC layer, the
 * execution wiring and the renderer is scanned (code and comments); the ONLY hits allowed are listed here, each with its exact
 * count, so any NEW engine word anywhere fails this test (and a removed one asks for the entry to be removed).
 * Not scanned: src/runner/runtimes/cliAgent/** (the one adapter that names the engine), which is the boundary itself.
 */
const V5_DIRS = ['src/main/nexus', 'src/main/nexusIpc', 'src/main/nexusExec', 'src/runner', 'src/renderer/src/nexus', 'src/shared/nexus'];
const V5_SKIP = (rel) => rel.startsWith('src/runner/runtimes/cliAgent/') || rel === 'src/shared/nexus/runtime.ts';
/**
 * file -> the sha256 (first 16 hex) of each trimmed line that carries an engine word, in file order. A word that moves to another
 * line, or a new line with one, changes the hashes and fails; the comment after each hash is the line's start, for the reader.
 * Why each is allowed: the schema comments name an example runtime kind; the `.claude` rule excludes the agent CLI's own per-worktree
 * settings folder from every change (its folder name is the only way to name it); the legacy lead-agent workbench and its assistant
 * port have the provider choice of the old app as their subject.
 */
const V5_ALLOWED = {
  'src/main/nexus/db/schemaV7.ts': [
    'cd03605e9d5fc7be',  // runtime_kind        TEXT,                                         -- provider/ru
    'f790d5404ba40cba',  // runtime_kind        TEXT,                          -- e.g. 'claude-cli'; provide
  ],
  'src/main/nexus/validation/validators/pathsInScope.ts': [
    '8077bba16c26f4c0',  // /** A `.claude` path segment at any depth (case-insensitive: the folder name is 
    '59d5d704efbd649a',  // export const AGENT_CONFIG_SEGMENT_RE = /(?:^|\/)\.claude[. ]*(?:\/|$)/i;
    '6c88bf0372babb77',  // // The agent CLI's own per-worktree settings folder (`.claude/`): never part of 
  ],
  'src/runner/gitWrite.ts': [
    'e86d7c5f197d5a45',  // * `<worktree>/.claude/` (Task 0), which must never be staged or committed.
    '869a23fdbe8a3bc9',  // ':(glob,icase,exclude).claude', ':(glob,icase,exclude).claude/**', ':(glob,icase
  ],
  'src/renderer/src/nexus/agents/agentList.ts': [
    'c8a3e331ed1dd9ae',  // provider: a.provider ?? 'claude',
  ],
  'src/renderer/src/nexus/agents/workbench/TeamSection.tsx': [
    '680d683e33d505f1',  // const canResume = agentProvider === 'claude' || !!agentPreset.resumeFlag || !!ag
    'dd1cf86422eeaa8c',  // // `defaultModel` is a Claude model id, so it can only mark an entry in the Clau
    'f86313423c3e2803',  // const isAppDefault = p.id === 'claude' && !!defaultModel && model.id === default
    'f6f04d3c0947309f',  // <option key={p.id} value={p.id}>{p.label}{p.id === 'claude' ? ' (recommended)' :
  ],
  'src/renderer/src/nexus/agents/workbench/useFleetRoster.ts': [
    '596d5e6300ee0425',  // const [engineProvider, setEngineProvider] = useState<AgentProvider>('claude');
    '2fd101ca13ceeba9',  // setEngineProvider(c.godProvider ?? 'claude');
  ],
  'src/renderer/src/nexus/agents/workbench/useRestartAgent.ts': [
    '3f05adc1e15d8f95',  // // Restart an agent's PTY in place. `resume:true` reattaches its prior Claude
    '9d7eafb71835a524',  // } else if (provider === 'claude' && !(await window.cth.resolveSessionCwd(resumeS
  ],
  'src/renderer/src/nexus/assistant/port.ts': [
    '2d17b6acd073bf07',  // *  agent. A future provider (e.g. Hermes) implements this same interface and
  ]
};
const v5Files = () => V5_DIRS.flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? walkShared(d, /\.(ts|tsx|cjs|js|mjs|json|md)$/) : [])).filter((rel) => !V5_SKIP(rel));

test('V5 no engine name outside the cliAgent adapter except an explicit, exact allow-list (main, runner, IPC, renderer, shared)', () => {
  const files = v5Files();
  assert.ok(files.length > 300, `the walk sees the Nexus code (${files.length})`);
  const found = {};
  const sha = (l) => require('node:crypto').createHash('sha256').update(l, 'utf8').digest('hex').slice(0, 16);
  for (const rel of files) { const ls = hits(read(rel)).map(([, l]) => sha(l.trim())); if (ls.length > 0) found[rel] = ls; }
  // Compare the hashes only (the comments in V5_ALLOWED are for the reader).
  assert.deepEqual(found, V5_ALLOWED);
  // The boundary exists and is where the engine is named.
  assert.ok(fs.existsSync(path.join(ROOT, 'src/runner/runtimes/cliAgent')), 'the adapter folder');
  // The allow-listed shared hits are none: shared contracts stay vendor-neutral (V1), so no allow-list entry may name src/shared.
  assert.ok(Object.keys(V5_ALLOWED).every((rel) => !rel.startsWith('src/shared/')));
});
