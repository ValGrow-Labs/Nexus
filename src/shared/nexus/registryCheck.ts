// Checks for the domain registry (§12.9) and its projections. Pure and total:
// the caller passes the specs, the ids this build implements and (optionally)
// the tables, and gets back a list of problems (empty = sound). It never throws;
// a malformed input is a problem, not an exception. The unit test runs it on
// every change. Main runs it at startup (src/main/nexus/registryImpl.ts) with
// B2B_IMPL; any problem keeps execution off (`registry_invalid`).

import {
  CURRENT_SUB_PHASE, HANDOFF_ACTIONS, STEP_STATUSES, isAtOrBefore, isSubPhase,
  type DomainSpec, type LifecycleStep, type ParamsSchema, type SubPhase
} from './domainSpec';
import { KINDS, type KindDef } from './kinds';
import { CAPABILITIES, SKILLS, type CapabilityDef, type SkillDef } from './capabilities';
import { RECIPES, type RecipeDef } from './recipes';
import { VALIDATORS, type ValidatorDef } from './validators';
import { PLATFORM_FLOWS, USER_ACTIONS, type UserActionDef } from './actions';
import { SANDBOX_PROFILE_IDS } from './execution';
import { deepFreeze } from './freeze';

/** The ids this build has real implementations for. `e2eTests: null` checks the e2e id format only. */
export interface RegistryImpl {
  recipes: readonly string[];
  validators: readonly string[];
  viewers: readonly string[];
  e2eTests: readonly string[] | null;
}

/** The tables the specs refer to. Tests pass altered copies; everyone else uses the defaults. */
export interface RegistryTables {
  kinds: readonly KindDef[];
  recipes: readonly RecipeDef[];
  validators: readonly ValidatorDef[];
  actions: readonly UserActionDef[];
  capabilities: readonly CapabilityDef[];
  skills: readonly SkillDef[];
  platformFlows: readonly string[];
}
export const REGISTRY_TABLES: RegistryTables = deepFreeze({
  kinds: KINDS, recipes: RECIPES, validators: VALIDATORS, actions: USER_ACTIONS, capabilities: CAPABILITIES, skills: SKILLS,
  platformFlows: PLATFORM_FLOWS
});

/**
 * What B2a implements. Task 13 pins main's recipe runners, validators and the Folio viewers to these. `e2eTests` (B2a
 * Task 12): the end-to-end test of every REAL step, each a test title in test/nexus-platform-exec-recipes.test.cjs (the
 * fake sandbox driver, run by test:db) or test/nexus-exec-recipes.test.cjs (real Docker, behind the test:exec gate); a
 * REAL step whose id is not listed here fails the registry check, and the registry test checks each is a title.
 */
export const B2A_IMPL: RegistryImpl = deepFreeze({
  recipes: ['repo.snapshot', 'sde.deps.node', 'sde.deps.python', 'sde.test.discover', 'sde.test.node', 'sde.test.pytest',
    'sde.build.node', 'sde.build.python', 'sde.app.assemble', 'sde.preview.start', 'sde.diagnose'],
  validators: ['git.head_resolves', 'req.schema', 'problem.schema', 'suite.discovered', 'sde.tests_pass', 'build.exit_zero',
    'build.manifest_present', 'build.output_hashed', 'blob.integrity', 'app.manifest_schema', 'app.preview_health', 'diag.schema',
    'sde.deps.lock_matches'],
  viewers: ['viewer.git_commit', 'viewer.text_file', 'viewer.handoff_receipt', 'viewer.repository', 'viewer.requirement',
    'viewer.problem_statement', 'viewer.test_suite', 'viewer.build', 'viewer.application', 'viewer.diagnostic_report'],
  e2eTests: ['e2e.sde.requirement', 'e2e.sde.project', 'e2e.sde.repository', 'e2e.sde.code', 'e2e.sde.tests', 'e2e.sde.build',
    'e2e.sde.application', 'e2e.sde.dev-deployment', 'e2e.sde.diagnostics', 'e2e.data.business-question', 'e2e.ml.problem', 'e2e.dl.problem']
});

/**
 * The end-to-end ids of the SDE steps B2b makes REAL, in lifecycle order (implementation, review, iteration). A stub:
 * B2b Task 16 writes them as test titles (test/nexus-platform-b2b-flows-*.test.cjs, and the real-Docker
 * test/nexus-exec-agent.test.cjs for the Docker-dependent ones); until then the registry test exempts exactly these
 * from its title check, and Task 16 empties this list.
 */
export const B2B_E2E_STUB: readonly string[] = deepFreeze(['e2e.sde.ai-implementation', 'e2e.sde.review', 'e2e.sde.iteration']);

/**
 * What B2b implements: B2a plus the six engine git recipes, the six change-set validators and the change-set viewer.
 * Main's startup check pins its registered maps to these (src/main/nexus/registryImpl.ts), with the ids B2b's later
 * tasks have not implemented yet listed there as pending until they land.
 */
export const B2B_IMPL: RegistryImpl = deepFreeze({
  recipes: [...B2A_IMPL.recipes, 'repo.worktree', 'changeset.collect', 'changeset.merge_check', 'changeset.accept',
    'changeset.accept_rollback', 'repo.ff'],
  validators: [...B2A_IMPL.validators, 'git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'sec.entropy_notes',
    'cs.tests_pass', 'git.applies_cleanly'],
  viewers: [...B2A_IMPL.viewers, 'viewer.change_set'],
  e2eTests: [...(B2A_IMPL.e2eTests ?? []), ...B2B_E2E_STUB]
});

/**
 * The ids B2B_IMPL declares that main does not implement yet. B2b Task 7 landed the six git engine recipes; Task 8
 * lands all six change-set validators (the register validators, `cs.tests_pass` and `git.applies_cleanly`'s own
 * candidate check; Task 9 adds its advisory re-check at accept, over the same pure validator). Task 16 asserts this
 * empty. Main's startup check leaves exactly these out of its comparison and reports one that main does implement
 * while it is still listed here (src/main/nexus/registryImpl.ts). The agent flows stay unavailable
 * (`agents_unavailable`) while the agents part is off, so nothing pending can be started.
 */
export const B2B_PENDING: { recipes: readonly string[]; validators: readonly string[] } = deepFreeze({
  recipes: [],
  validators: []
});

/** An end-to-end test id: `e2e.<domain>.<step>`. */
export const E2E_TEST_ID_RE = /^e2e\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
/** A renderer-supplied parameter never names a path, a command, a network, an image or an identity. */
export const BANNED_PARAM_FIELD =
  /path|dir|file|folder|root|command|cmd|argv|exec|script|shell|network|egress|port|host|url|image|principal|user|actor|role|token|secret|env/i;

const ID_RE = /^[a-z][a-z0-9-]*$/;
const EXECUTORS = ['engine', 'tool', 'service'];
const VALIDATOR_EXECUTORS = ['main', 'runner', 'child-job', 'deployment'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** Problems with one action's parameter schema. Never throws. */
export function checkActionParams(action: Pick<UserActionDef, 'id' | 'params'>): string[] {
  try { return checkParams(`action ${action?.id}`, action?.params); } catch (e) { return [`action: params check failed: ${errText(e)}`]; }
}

function checkParams(where: string, p: ParamsSchema | undefined): string[] {
  const out: string[] = [];
  if (!isObj(p) || p.type !== 'object' || p.additionalProperties !== false || !isObj(p.properties) || !isStrArr(p.required)) {
    return [`${where}: params must be a closed object schema`];
  }
  for (const [field, def] of Object.entries(p.properties)) {
    if (BANNED_PARAM_FIELD.test(field)) out.push(`${where}: params field ${field} names a path, command, network, image or identity`);
    if (!isObj(def) || !['string', 'integer', 'boolean'].includes(def.type as string)) out.push(`${where}: params field ${field} has a bad type`);
    else if (def.type === 'string' && !(Number.isInteger(def.maxLength) && (def.maxLength as number) > 0))
      out.push(`${where}: params field ${field} needs a maxLength`);
  }
  for (const r of p.required) if (!(r in p.properties)) out.push(`${where}: required field ${r} is not declared`);
  return out;
}

/** Ids of a table, reporting duplicates and entries without an id (before any Map can drop them). */
function tableIds(name: string, rows: unknown, out: string[]): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(rows)) { out.push(`table ${name}: not a list`); return ids; }
  for (const r of rows) {
    const id = isObj(r) ? r.id : undefined;
    if (typeof id !== 'string' || !id) { out.push(`table ${name}: an entry has no id`); continue; }
    if (ids.has(id)) out.push(`table ${name}: duplicate id ${id}`);
    ids.add(id);
  }
  return ids;
}

export function checkRegistry(specs: readonly DomainSpec[], impl: RegistryImpl, tables: Partial<RegistryTables> = {}): string[] {
  const out: string[] = [];
  try {
    run(specs, impl, { ...REGISTRY_TABLES, ...tables }, out);
  } catch (e) {
    out.push(`registry check stopped: ${errText(e)}`);
  }
  return out;
}

function run(specs: readonly DomainSpec[], impl: RegistryImpl, t: RegistryTables, out: string[]): void {
  // ----- the tables: ids unique, rows well formed -----
  tableIds('kinds', t.kinds, out); tableIds('recipes', t.recipes, out); tableIds('validators', t.validators, out);
  tableIds('actions', t.actions, out); tableIds('capabilities', t.capabilities, out); tableIds('skills', t.skills, out);
  if (!isStrArr(t.platformFlows) || new Set(t.platformFlows).size !== t.platformFlows.length) out.push('table platformFlows: bad or duplicate ids');
  const kinds = new Map(t.kinds.filter(isObj).map((k) => [k.id, k]));
  const recipes = new Map(t.recipes.filter(isObj).map((r) => [r.id, r]));
  const validators = new Map(t.validators.filter(isObj).map((v) => [v.id, v]));
  const actions = new Map(t.actions.filter(isObj).map((a) => [a.id, a]));
  const capabilities = new Set(t.capabilities.filter(isObj).map((c) => c.id));
  const skills = new Set(t.skills.filter(isObj).map((s) => s.id));
  const flows = new Set(isStrArr(t.platformFlows) ? t.platformFlows : []);
  const viewers = new Set([...kinds.values()].map((k) => k.viewer));
  const kind = (where: string, id: unknown) => { if (typeof id !== 'string' || !kinds.has(id)) out.push(`${where}: unknown kind ${String(id)}`); };

  for (const r of recipes.values()) {
    const rw = `recipe ${r.id}`;
    if (!EXECUTORS.includes(r.executor)) { out.push(`${rw}: bad or missing executor`); continue; }
    if (!isStrArr(r.produces) || !isStrArr(r.profiles) || !isStrArr(r.argvTemplates) || !isStrArr(r.parsers)) {
      out.push(`${rw}: malformed lists`); continue;
    }
    for (const k of r.produces) kind(rw, k);
    for (const p of r.profiles) if (!(SANDBOX_PROFILE_IDS as readonly string[]).includes(p)) out.push(`${rw}: unknown profile ${p}`);
    if (r.executor === 'engine') {
      if (r.network !== 'not-applicable') out.push(`${rw}: an engine recipe runs no container, so it has no network`);
      if (r.profiles.length !== 0) out.push(`${rw}: an engine recipe has no profiles`);
      if (r.limits !== null) out.push(`${rw}: an engine recipe has no container limits`);
    } else {
      if (r.network === 'not-applicable' || !['none', 'egress-approved', 'service-internal'].includes(r.network))
        out.push(`${rw}: a ${r.executor} recipe needs a container network mode`);
      if (r.profiles.length === 0) out.push(`${rw}: a ${r.executor} recipe needs a profile`);
      if (!isObj(r.limits) || !(r.limits.cpus > 0 && r.limits.memoryMb > 0 && r.limits.outputMaxBytes > 0))
        out.push(`${rw}: a ${r.executor} recipe needs limits`);
    }
    if (!isObj(r.retry) || !(Number.isInteger(r.retry.maxAttempts) && r.retry.maxAttempts >= 1)) out.push(`${rw}: bad retry`);
    if (!(Number.isFinite(r.wallClockMs) && r.wallClockMs > 0)) out.push(`${rw}: bad wall clock`);
    out.push(...checkParams(rw, r.params));
  }
  for (const v of validators.values()) {
    const vw = `validator ${v.id}`;
    if (!isStrArr(v.kinds)) { out.push(`${vw}: malformed kinds`); continue; }
    for (const k of v.kinds) kind(vw, k);
    if (!VALIDATOR_EXECUTORS.includes(v.executes)) out.push(`${vw}: bad executor`);
    if (v.executes === 'child-job' && !(isStrArr(v.recipes) && v.recipes.length > 0)) out.push(`${vw}: a child-job validator names its recipes`);
    for (const r of v.recipes ?? []) if (!recipes.has(r)) out.push(`${vw}: unknown recipe ${r}`);
  }
  for (const a of actions.values()) {
    const aw = `action ${a.id}`;
    out.push(...checkParams(aw, a.params));
    if (!Array.isArray(a.inputs) || !isObj(a.run)) { out.push(`${aw}: malformed`); continue; }
    for (const s of a.inputs) if (!isObj(s) || !isStrArr(s.kinds)) out.push(`${aw}: malformed input slot`); else for (const k of s.kinds) kind(aw, k);
    if ('recipes' in a.run) for (const r of a.run.recipes) if (!recipes.has(r)) out.push(`${aw}: unknown recipe ${r}`);
    if ('inlineKind' in a.run) {
      kind(aw, a.run.inlineKind);
      if (!kinds.get(a.run.inlineKind)?.userAuthorable) out.push(`${aw}: ${a.run.inlineKind} is not user-authorable`);
    }
  }
  if (!isObj(impl) || !isStrArr(impl.recipes) || !isStrArr(impl.validators) || !isStrArr(impl.viewers)
    || !(impl.e2eTests === null || isStrArr(impl.e2eTests))) {
    out.push('implementation: malformed');
    return;
  }
  for (const r of impl.recipes) if (!recipes.has(r)) out.push(`implementation: unknown recipe ${r}`);
  for (const v of impl.validators) if (!validators.has(v)) out.push(`implementation: unknown validator ${v}`);
  for (const v of impl.viewers) if (!viewers.has(v)) out.push(`implementation: unknown viewer ${v}`);

  if (!Array.isArray(specs)) { out.push('registry: specs must be a list'); return; }

  // ----- shape of each spec and step; a malformed one is reported and left out of the rest -----
  const valid: DomainSpec[] = [];
  specs.forEach((d, i) => {
    const shape = specShape(d);
    if (shape.length) out.push(...shape.map((p) => `${isObj(d) && typeof d.id === 'string' ? d.id : `spec #${i}`}: ${p}`));
    else valid.push(d);
  });

  // ----- across specs -----
  const ids = new Set<string>();
  const hues = new Map<number, string>();
  const orders = new Map<number, string>();
  const legacy = new Map<string, string>();
  const e2e = new Map<string, string>();
  for (const d of valid) {
    const w = d.id;
    if (d.specVersion !== 3) out.push(`${w}: specVersion must be 3`);
    if (!ID_RE.test(d.id)) out.push(`${w}: bad id`);
    if (ids.has(d.id)) out.push(`${w}: duplicate domain id`);
    ids.add(d.id);
    if (!Number.isInteger(d.hueSlot) || d.hueSlot < 0) out.push(`${w}: bad hue slot`);
    else if (hues.has(d.hueSlot)) out.push(`${w}: hue slot ${d.hueSlot} already used by ${hues.get(d.hueSlot)}`);
    else hues.set(d.hueSlot, d.id);
    if (orders.has(d.order)) out.push(`${w}: order ${d.order} already used by ${orders.get(d.order)}`);
    else orders.set(d.order, d.id);
    if (!isSubPhase(d.participationFromSubPhase)) out.push(`${w}: bad participationFromSubPhase`);
    if (!d.label || !d.shortLabel || !d.statusNote) out.push(`${w}: label, shortLabel and statusNote are required`);
    for (const l of d.legacyDomainIds) {
      if (legacy.has(l)) out.push(`${w}: legacy domain ${l} already maps to ${legacy.get(l)}`);
      else legacy.set(l, d.id);
    }
    for (const s of d.lifecycle) if (typeof s.e2eTestId === 'string') {
      if (e2e.has(s.e2eTestId)) out.push(`${w}/${s.id}: e2eTestId ${s.e2eTestId} is already used by ${e2e.get(s.e2eTestId)}`);
      else e2e.set(s.e2eTestId, `${w}/${s.id}`);
    }
  }

  for (const d of valid) {
    const w = d.id;
    if (d.tier === 'registry-only') {
      const extra = (['lifecycle', 'modules', 'actions', 'recipes', 'skills', 'capabilities', 'kindsProduced', 'kindsAccepted',
        'handoffRoutes', 'completionRules'] as const).filter((f) => d[f].length > 0);
      if (extra.length) out.push(`${w}: a registry-only entry has no ${extra.join(', ')}`);
      continue;
    }
    if (d.tier !== 'first-class') { out.push(`${w}: bad tier`); continue; }
    const participates = isSubPhase(d.participationFromSubPhase) && isAtOrBefore(d.participationFromSubPhase);

    for (const k of [...d.kindsProduced, ...d.kindsAccepted]) kind(w, k);
    for (const k of Object.keys(d.vocabulary)) kind(`${w} vocabulary`, k);
    for (const k of d.kindsProduced) if (!d.vocabulary[k]) out.push(`${w}: vocabulary does not name produced kind ${k}`);
    for (const c of d.capabilities) {
      if (!isObj(c) || !capabilities.has(c.id)) { out.push(`${w}: unknown capability ${isObj(c) ? c.id : String(c)}`); continue; }
      for (const r of c.scope?.recipes ?? []) if (!recipes.has(r)) out.push(`${w}: capability ${c.id}: unknown recipe ${r}`);
      for (const k of c.scope?.kinds ?? []) kind(`${w} capability ${c.id}`, k);
    }
    for (const r of d.recipes) if (!recipes.has(r)) out.push(`${w}: unknown recipe ${r}`);
    for (const s of d.skills) if (!skills.has(s)) out.push(`${w}: unknown skill ${s}`);
    if (!participates) for (const id of d.actions)
      out.push(`${w}: action ${id} exists before projects can take part (${d.participationFromSubPhase})`);
    for (const id of d.actions) {
      const a = actions.get(id);
      if (!a) { out.push(`${w}: unknown action ${id}`); continue; }
      if (a.domain !== d.id) out.push(`${w}: action ${id} belongs to ${a.domain}`);
      if ('recipes' in a.run) for (const r of a.run.recipes) if (!d.recipes.includes(r)) out.push(`${w}: action ${id} runs ${r}, not in its recipes`);
      if ('inlineKind' in a.run && !d.kindsProduced.includes(a.run.inlineKind)) out.push(`${w}: action ${id} saves a kind it does not produce`);
    }
    for (const a of actions.values()) if (a.domain === d.id && !d.actions.includes(a.id)) out.push(`${w}: action ${a.id} is not listed`);

    // lifecycle
    const stepIds = new Set<string>();
    const realActions = new Set<string>();
    for (const s of d.lifecycle) {
      const sw = `${w}/${s.id}`;
      if (!ID_RE.test(s.id) || stepIds.has(s.id)) out.push(`${sw}: bad or duplicate step id`);
      stepIds.add(s.id);
      if (!s.label) out.push(`${sw}: label is required`);
      if (!STEP_STATUSES.includes(s.status)) out.push(`${sw}: bad status`);
      if (!isSubPhase(s.subPhase)) { out.push(`${sw}: bad subPhase`); continue; }
      for (const k of [...s.consumes, ...s.produces]) kind(sw, k);
      for (const k of s.produces) if (!d.kindsProduced.includes(k)) out.push(`${sw}: produces ${k}, which is missing from kindsProduced`);
      out.push(...checkVia(sw, s, recipes, actions, skills, flows, d));
      out.push(...checkDoneWhen(sw, s, kinds, validators));
      if (s.status === 'FUTURE') {
        if (isAtOrBefore(s.subPhase)) out.push(`${sw}: FUTURE but names ${s.subPhase}, which this build (${CURRENT_SUB_PHASE}) has reached`);
        if (s.via.some((v) => isObj(v) && 'userAction' in v)) out.push(`${sw}: a FUTURE step has no user action`);
        continue;
      }
      // REAL or PARTIAL in this build.
      if (!isAtOrBefore(s.subPhase)) out.push(`${sw}: ${s.status} but its sub-phase ${s.subPhase} is after this build (${CURRENT_SUB_PHASE})`);
      if (!participates) out.push(`${sw}: ${s.status} before projects can take part in ${w} (${d.participationFromSubPhase})`);
      if (s.status === 'PARTIAL' && !s.scopeNote) out.push(`${sw}: PARTIAL needs a scopeNote`);
      if (!s.e2eTestId || !E2E_TEST_ID_RE.test(s.e2eTestId)) out.push(`${sw}: e2eTestId missing or malformed`);
      else if (impl.e2eTests && !impl.e2eTests.includes(s.e2eTestId)) out.push(`${sw}: no end-to-end test titled ${s.e2eTestId}`);
      if (s.via.length === 0) out.push(`${sw}: a ${s.status} step names how it runs`);
      for (const k of s.produces) {
        const def = kinds.get(k);
        if (def && !isAtOrBefore(def.availableFrom)) out.push(`${sw}: produces ${k}, which arrives in ${def.availableFrom}`);
        if (def && !impl.viewers.includes(def.viewer)) out.push(`${sw}: no viewer implementation ${def.viewer} for ${k}`);
      }
      for (const v of s.via) {
        if (!isObj(v)) continue;
        if ('recipe' in v && !impl.recipes.includes(v.recipe)) out.push(`${sw}: recipe ${v.recipe} has no implementation`);
        if ('userAction' in v) {
          realActions.add(v.userAction);
          const a = actions.get(v.userAction);
          if (a && 'recipes' in a.run) for (const r of a.run.recipes)
            if (!impl.recipes.includes(r)) out.push(`${sw}: recipe ${r} has no implementation`);
          if (a && !isAtOrBefore(a.subPhase)) out.push(`${sw}: action ${a.id} arrives in ${a.subPhase}`);
        }
      }
      if ('validators' in s.doneWhen) for (const v of s.doneWhen.validators)
        if (!impl.validators.includes(v)) out.push(`${sw}: validator ${v} has no implementation`);
    }
    for (const id of d.actions) if (!realActions.has(id)) out.push(`${w}: action ${id} is not offered by a REAL or PARTIAL step`);

    // handoff routes
    for (const r of d.handoffRoutes) {
      if (!isObj(r) || !isStrArr(r.kinds)) { out.push(`${w}: malformed handoff route`); continue; }
      const rw = `${w} route to ${r.to}`;
      const to = valid.find((x) => x.id === r.to);
      if (!to || to.tier !== 'first-class') { out.push(`${rw}: unknown receiver ${r.to}`); continue; }
      if (!HANDOFF_ACTIONS.includes(r.action)) out.push(`${rw}: bad action ${r.action}`);
      if (!isSubPhase(r.subPhase)) out.push(`${rw}: bad subPhase`);
      for (const k of r.kinds) {
        kind(rw, k);
        if (!d.kindsProduced.includes(k)) out.push(`${rw}: ${w} does not produce ${k}`);
        if (!to.kindsAccepted.includes(k)) out.push(`${rw}: ${r.to} does not accept ${k}`);
      }
    }
    // completion rules: never a claim the build cannot back
    for (const c of d.completionRules) {
      if (!isObj(c) || !isStrArr(c.steps) || !isSubPhase(c.subPhase)) { out.push(`${w} completion: malformed rule`); continue; }
      for (const id of c.steps) if (!stepIds.has(id)) out.push(`${w} completion ${c.id}: unknown step ${id}`);
      if (isAtOrBefore(c.subPhase)) {
        const open = c.steps.filter((id) => d.lifecycle.find((s) => s.id === id)?.status === 'FUTURE');
        if (open.length) out.push(`${w} completion ${c.id}: names ${c.subPhase} while ${open.join(', ')} are FUTURE`);
      }
    }
    // modules
    const moduleIds = new Set<string>();
    for (const m of d.modules) {
      if (!isObj(m) || !isStrArr(m.kinds)) { out.push(`${w}: malformed module`); continue; }
      if (!ID_RE.test(m.id) || moduleIds.has(m.id)) out.push(`${w} module ${m.id}: bad or duplicate id`);
      moduleIds.add(m.id);
      if (!isSubPhase(m.subPhase)) out.push(`${w} module ${m.id}: bad subPhase`);
      else if (!participates && isSubPhase(d.participationFromSubPhase) && !isAtOrBefore(d.participationFromSubPhase, m.subPhase))
        out.push(`${w} module ${m.id}: ${m.subPhase} is before projects can take part (${d.participationFromSubPhase})`);
      for (const k of m.kinds) kind(`${w} module ${m.id}`, k);
    }
  }
}

const SPEC_ARRAYS = ['legacyDomainIds', 'kindsProduced', 'kindsAccepted', 'capabilities', 'recipes', 'skills', 'actions', 'lifecycle',
  'handoffRoutes', 'completionRules', 'modules'] as const;
const STEP_ARRAYS = ['consumes', 'produces', 'via', 'prerequisites'] as const;

/** Shape problems of one spec (empty = the rest of the check can read it safely). */
function specShape(d: unknown): string[] {
  if (!isObj(d)) return ['not an object'];
  const out: string[] = [];
  if (typeof d.id !== 'string') out.push('id must be a string');
  for (const f of ['label', 'shortLabel', 'description', 'statusNote', 'tier', 'icon', 'participationFromSubPhase'] as const)
    if (typeof d[f] !== 'string') out.push(`${f} must be a string`);
  if (typeof d.hueSlot !== 'number' || typeof d.order !== 'number') out.push('hueSlot and order must be numbers');
  if (!isObj(d.vocabulary)) out.push('vocabulary must be an object');
  for (const f of SPEC_ARRAYS) if (!Array.isArray(d[f])) out.push(`${f} must be a list`);
  for (const f of ['legacyDomainIds', 'kindsProduced', 'kindsAccepted', 'recipes', 'skills', 'actions'] as const)
    if (Array.isArray(d[f]) && !isStrArr(d[f])) out.push(`${f} must hold strings`);
  if (Array.isArray(d.lifecycle)) d.lifecycle.forEach((s: unknown, i: number) => {
    if (!isObj(s)) { out.push(`step #${i} is not an object`); return; }
    const sw = `step ${typeof s.id === 'string' ? s.id : `#${i}`}`;
    if (typeof s.id !== 'string' || typeof s.label !== 'string' || typeof s.status !== 'string' || typeof s.subPhase !== 'string')
      out.push(`${sw}: id, label, status and subPhase must be strings`);
    for (const f of STEP_ARRAYS) if (!Array.isArray(s[f])) out.push(`${sw}: ${f} must be a list`);
    for (const f of ['consumes', 'produces', 'prerequisites'] as const) if (Array.isArray(s[f]) && !isStrArr(s[f])) out.push(`${sw}: ${f} must hold strings`);
    const dw = s.doneWhen;
    if (!isObj(dw) || !(typeof dw.record === 'string' || (typeof dw.kind === 'string' && isStrArr(dw.statuses) && isStrArr(dw.validators))))
      out.push(`${sw}: doneWhen is malformed`);
    if (s.e2eTestId !== undefined && typeof s.e2eTestId !== 'string') out.push(`${sw}: e2eTestId must be a string`);
  });
  if (isObj(d.vocabulary)) for (const [k, v] of Object.entries(d.vocabulary))
    if (!isObj(v) || typeof v.singular !== 'string' || typeof v.plural !== 'string') out.push(`vocabulary ${k} is malformed`);
  return out;
}

function checkVia(sw: string, s: LifecycleStep, recipes: Map<string, unknown>, actions: Map<string, UserActionDef>,
  skills: Set<string>, flows: Set<string>, d: DomainSpec): string[] {
  const out: string[] = [];
  for (const v of s.via) {
    if (!isObj(v)) { out.push(`${sw}: bad via entry`); continue; }
    if ('userAction' in v) {
      if (!actions.has(v.userAction)) out.push(`${sw}: unknown action ${v.userAction}`);
      else if (!d.actions.includes(v.userAction)) out.push(`${sw}: action ${v.userAction} is not listed by ${d.id}`);
    } else if ('recipe' in v) {
      if (!recipes.has(v.recipe)) out.push(`${sw}: unknown recipe ${v.recipe}`);
      else if (!d.recipes.includes(v.recipe)) out.push(`${sw}: recipe ${v.recipe} is not listed by ${d.id}`);
    } else if ('skill' in v) {
      if (!skills.has(v.skill)) out.push(`${sw}: unknown skill ${v.skill}`);
    } else if ('platform' in v) {
      if (!flows.has(v.platform)) out.push(`${sw}: unknown platform flow ${v.platform}`);
    } else out.push(`${sw}: bad via entry`);
  }
  return out;
}

function checkDoneWhen(sw: string, s: LifecycleStep, kinds: Map<string, KindDef>, validators: Map<string, ValidatorDef>): string[] {
  const out: string[] = [];
  const dw = s.doneWhen;
  if ('record' in dw) return out;
  if (!kinds.has(dw.kind)) { out.push(`${sw}: doneWhen names unknown kind ${dw.kind}`); return out; }
  if (!s.produces.includes(dw.kind)) out.push(`${sw}: doneWhen kind ${dw.kind} is not produced by the step`);
  if (dw.statuses.length === 0) out.push(`${sw}: doneWhen needs a status`);
  for (const v of dw.validators) {
    const def = validators.get(v);
    if (!def) out.push(`${sw}: doneWhen names unknown validator ${v}`);
    else if (!def.kinds.includes(dw.kind)) out.push(`${sw}: validator ${v} does not apply to ${dw.kind}`);
  }
  // A step that runs in this build cannot be done while a blocking check of its kind is skipped.
  if (s.status !== 'FUTURE') for (const v of validators.values())
    if (v.blocking && v.kinds.includes(dw.kind) && (v.stage === 'register' || v.stage === 'candidate') && !dw.validators.includes(v.id))
      out.push(`${sw}: doneWhen omits the blocking validator ${v.id}`);
  return out;
}

/** The live workspace catalogue: the ids of every domain projects can take part in at `at`, in display order, and the legacy map. */
export function projectWorkspaceCatalog(specs: readonly DomainSpec[], at: SubPhase = CURRENT_SUB_PHASE):
  { ids: string[]; legacyMap: Record<string, string> } {
  const live = specs.filter((d) => isAtOrBefore(d.participationFromSubPhase, at)).slice().sort((a, b) => a.order - b.order);
  const legacyMap: Record<string, string> = {};
  for (const d of live) for (const l of d.legacyDomainIds) legacyMap[l] = d.id;
  return { ids: live.map((d) => d.id), legacyMap };
}
