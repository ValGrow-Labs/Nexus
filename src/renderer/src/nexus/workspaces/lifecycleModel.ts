// Pure: a domain's lifecycle as a rail, in the domain's own words, from the
// registry (DomainSpecView, #22; the same registry is bundled with this build) and,
// inside a project, from records only: versions with their check results, live
// jobs and dev deployments. A step state comes from shared/nexus/stepState.ts;
// nothing is ticked by hand, a FUTURE step is never offered, and no domain is
// ever called complete.
import type { DomainSpecView, JobView } from '@shared/nexus/ipc';
import type { DomainSpec, StepStatus, SubPhase } from '@shared/nexus/domainSpec';
import { DELIVERED_SUB_PHASE, isAtOrBefore, isExecutableEndToEnd } from '@shared/nexus/domainSpec';
import { DOMAINS, getDomain } from '@shared/nexus/domains';
import { getWorkspace } from './registry';
import { stepStateFrom, type StepState } from '@shared/nexus/stepState';

/** The same projection main sends over #22 (nexusIpc/dto.ts domainView), for when that channel has not answered. */
export function domainViewOf(d: DomainSpec): DomainSpecView {
  const vocabulary: DomainSpecView['vocabulary'] = {};
  for (const [k, v] of Object.entries(d.vocabulary)) if (v) vocabulary[k] = { singular: v.singular, plural: v.plural };
  return {
    id: d.id, label: d.label, shortLabel: d.shortLabel, description: d.description, tier: d.tier, hueSlot: d.hueSlot, icon: d.icon, order: d.order,
    statusNote: d.statusNote, vocabulary,
    lifecycle: d.lifecycle.map((s) => ({
      id: s.id, label: s.label, status: s.status, scopeNote: s.scopeNote ?? null, subPhase: s.subPhase,
      delivered: s.status !== 'FUTURE' && isAtOrBefore(s.subPhase, DELIVERED_SUB_PHASE),
      consumes: [...s.consumes], produces: [...s.produces], prerequisites: [...s.prerequisites],
      actions: s.via.flatMap((v) => ('userAction' in v ? [v.userAction] : []))
    })),
    modules: d.modules.map((m) => ({ id: m.id, label: m.label, kinds: [...m.kinds], subPhase: m.subPhase })),
    availableFromSubPhase: d.participationFromSubPhase, currentSubPhase: DELIVERED_SUB_PHASE, executableEndToEnd: isExecutableEndToEnd(d)
  };
}

export const bundledDomainViews = (): DomainSpecView[] => DOMAINS.map(domainViewOf);

/** What a later sub-phase brings, in plain words (the FUTURE line: "Not in this release: arrives with ..."). */
export const ARRIVES_WITH: Readonly<Record<SubPhase, string>> = Object.freeze({
  B1: 'the platform', B2a: 'execution', B2b: 'AI-assisted changes', B2c: 'QA workflows (B2c)', B3: 'Data Analyst workflows (B3)',
  B4: 'Data Scientist workflows (B4)', B5: 'ML Engineer workflows (B5)', B6: 'DL Engineer workflows (B6)'
});
export const futureLine = (sub: SubPhase): string => `Not in this release: arrives with ${ARRIVES_WITH[sub] ?? sub}`;
export const NOT_SUPPORTED = 'Not yet a supported workflow';

const STATE_WORD: Record<StepState, string> = {
  unavailable: 'Not in this release', blocked: 'Needs an earlier step', ready: 'Ready to start', in_progress: 'In progress',
  // Only a check that runs on a dev deployment waits for the user (stepState): its word says which action.
  awaiting_check: 'Ready to check — start a preview', checking: 'Checking', done: 'Done', failed: 'Needs attention'
};
const STATUS_WORD: Record<StepStatus, string> = { REAL: 'In this release', PARTIAL: 'In this release, with limits', FUTURE: 'Not in this release' };

/** Records of one project in one domain. Versions are the shown versions of the project's artifacts. */
export interface RailRecords {
  versions: { kind: string; status: 'draft' | 'candidate' | 'active' | 'failed' | 'deprecated'; validators: Readonly<Record<string, 'passed' | 'failed' | 'error' | 'skipped'>>;
    /** True when this version's checks were not read (past the Spine's read cap): a step of its kind claims no state. */
    unread?: boolean }[];
  /** Action ids of this project's live jobs (queued, leased, running, awaiting approval, retry scheduled). */
  liveActions: readonly string[];
  participation: boolean;
  deploymentHealthy: boolean;
  /**
   * Dev deployments live now (starting, healthy or not answering yet). Undefined when they were not read: a draft
   * waiting on a deployment-run check then reads in progress, never "Ready to check".
   */
  liveDeployments?: number;
  /** The statuses of the live dev deployments (`starting`, `healthy`, `unhealthy`): the reason a "Checking" step gives. */
  liveDeploymentStatuses?: readonly string[];
  /**
   * Per version (never the project's): the live previews of the shown application draft(s) only, with their statuses.
   * A step done on a kind (Application) counts these; the Dev deployment step (a healthy deployment record) counts the
   * project's. Undefined: not read, and the project's count stands.
   */
  draftPreviews?: readonly string[];
}

export interface RailStep {
  /** The step's place in the lifecycle, from 1. */
  n: number;
  id: string; label: string; status: StepStatus; subPhase: SubPhase; future: boolean;
  /** Derived from records inside a project; null on a workspace page (no project, so no state). */
  state: StepState | null;
  /** Always a word: the state's, or the step's status in this release. */
  word: string;
  /** For a FUTURE step "Not in this release: arrives with ..."; otherwise the registry's scope note. */
  note: string | null;
  /** Set only in a domain a project cannot take part in yet (DS before B4): "Available from <its sub-phase>". */
  when: string | null;
}

export interface RailView {
  domainId: string; label: string;
  /** The registry's own sentence on what works in this release. */
  statusNote: string;
  /** Set when a project cannot take part yet (DS before B4), or the domain is registry-only. */
  availability: string | null;
  supported: boolean;
  steps: RailStep[];
  /** The domain's modules in its words: delivered now, or the sub-phase they arrive in. */
  modules: { id: string; label: string; delivered: boolean; note: string | null }[];
}

const LIVE = new Set(['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled']);
export const liveActionsOf = (jobs: readonly Pick<JobView, 'state' | 'actionId'>[]): string[] =>
  jobs.filter((j) => LIVE.has(j.state) && j.actionId).map((j) => j.actionId!) ;

/**
 * The `review` record (B2b): a change set was reviewed AND accepted. Main makes a change set current (status `active`) only through
 * Accept, and Accept refuses unless the change's newest review approves it (a later review cannot be made once it is no longer a
 * candidate; promote and rollback refuse a change set). So an ACTIVE change set is exactly one whose newest review approved it and
 * that was accepted. A candidate that is only approved, rejected, or sent back for changes, or one never reviewed, is not.
 */
export function reviewRecorded(records: Pick<RailRecords, 'versions'>): boolean {
  return records.versions.some((v) => v.kind === 'change_set' && v.status === 'active');
}

/** The rail of one domain; `records` only inside a project (null: no state is claimed). */
export function railFor(view: DomainSpecView, records: RailRecords | null = null): RailView {
  const spec = getDomain(view.id);
  const supported = view.tier === 'first-class' && view.lifecycle.length > 0;
  const availability = !supported ? NOT_SUPPORTED
    : !isAtOrBefore(view.availableFromSubPhase, view.currentSubPhase) ? `Available from ${view.availableFromSubPhase}; it cannot be added to a project yet` : null;
  // The actions that start a dev deployment: the via of the step done by a healthy deployment record.
  const deploymentActions = view.lifecycle.filter((s) => spec?.lifecycle.find((x) => x.id === s.id && 'record' in x.doneWhen && x.doneWhen.record === 'deployment_healthy'))
    .flatMap((s) => s.actions);
  const steps: RailStep[] = view.lifecycle.map((s, i) => {
    const future = s.status === 'FUTURE' || !isAtOrBefore(s.subPhase, view.currentSubPhase);
    const full = spec?.lifecycle.find((x) => x.id === s.id) ?? null;
    let state: StepState | null = null;
    // A step whose produced kind has a version with unread checks claims no state: its checks are not known, so it
    // must not read "In progress" (or anything else) from an empty result list.
    const doneKind = full && 'kind' in full.doneWhen ? full.doneWhen.kind : null;
    const unread = !!records && doneKind !== null && records.versions.some((v) => v.unread === true && v.kind === doneKind);
    if (records && full && availability === null && !unread) {
      const done = full.doneWhen;
      state = stepStateFrom(full, {
        versions: 'kind' in done ? records.versions.filter((v) => v.kind === done.kind).map((v) => ({ status: v.status, validators: v.validators })) : [],
        liveJobs: records.liveActions.filter((a) => s.actions.includes(a)).length,
        inputsAvailable: s.consumes.every((k) => records.versions.some((v) => v.kind === k && (v.status === 'candidate' || v.status === 'active'))),
        // A Dev deployment step counts the project's live previews (a preview job still starting counts too); a step
        // done on a version (Application) counts only the previews of that version (draftPreviews), never another's.
        liveDeployments: records.liveDeployments === undefined ? undefined
          : 'kind' in done && records.draftPreviews !== undefined ? records.draftPreviews.length
            : records.liveDeployments + records.liveActions.filter((a) => deploymentActions.includes(a)).length,
        recordPresent: 'record' in done ? (done.record === 'participation' ? records.participation : done.record === 'deployment_healthy' ? records.deploymentHealthy
          : done.record === 'review' ? reviewRecorded(records) : false) : undefined
      }, view.currentSubPhase);
    }
    return {
      n: i + 1, id: s.id, label: s.label, status: s.status, subPhase: s.subPhase, future, state,
      word: future ? STATUS_WORD.FUTURE : state === 'checking' && records
        ? `Checking — ${checkingReason(full && 'kind' in full.doneWhen && records.draftPreviews !== undefined ? { liveDeploymentStatuses: records.draftPreviews } : records)}`
        : state ? STATE_WORD[state] : STATUS_WORD[s.status],
      note: future ? futureLine(s.subPhase) : s.scopeNote,
      when: supported && availability !== null ? `Available from ${s.subPhase}` : null
    };
  });
  const modules = view.modules.map((m) => {
    const delivered = isAtOrBefore(m.subPhase, view.currentSubPhase) && availability === null;
    return { id: m.id, label: m.label, delivered, note: delivered ? null : `arrives in ${m.subPhase}` };
  });
  return { domainId: view.id, label: view.label, statusNote: view.statusNote, availability, supported, steps, modules };
}

/**
 * Registry domains that have no workspace (Data Scientist in B2a: its workspace row arrives with B4). They get an
 * honest domain page (`#/w/<id>`) that draws their rail from the registry, never a workspace row in the database.
 */
export function domainOnlyIds(): string[] {
  return DOMAINS.filter((d) => d.tier === 'first-class' && !getWorkspace(d.id)).map((d) => d.id);
}
export const isDomainOnly = (id: string): boolean => domainOnlyIds().includes(id);

/** What a domain-only page says above its rail, from the registry: when a project can take part, and that nothing runs. */
export function domainOnlyLead(view: DomainSpecView): string {
  const runs = view.lifecycle.filter((s) => s.delivered).length;
  const when = isAtOrBefore(view.availableFromSubPhase, view.currentSubPhase)
    ? 'A project can take part in it.' : `Available from ${view.availableFromSubPhase}: a project cannot take part in it yet.`;
  return runs === 0 ? `${when} None of its steps runs in this release, and it offers no actions.`
    : `${when} ${runs} of its ${view.lifecycle.length} steps run in this release.`;
}

/**
 * Why a "Checking" step is checking, from the live dev deployments: one starting (or a job starting one, before its
 * row exists) reads "the preview is starting"; one that is up and not recorded as answering yet reads "waiting for
 * the preview to answer". The same reason the Spine node and the Folio give ("Checking: the dev deployment is ...").
 */
export function checkingReason(r: Pick<RailRecords, 'liveDeploymentStatuses'>): string {
  const st = r.liveDeploymentStatuses ?? [];
  return st.length === 0 || st.includes('starting') ? 'the preview is starting' : 'waiting for the preview to answer';
}

/** The compact line under a Spine group: counts of the rail's own steps (no other number). */
export function railSummary(r: RailView): string {
  if (r.availability) return r.availability;
  const inRelease = r.steps.filter((s) => !s.future);
  const done = inRelease.filter((s) => s.state === 'done').length;
  const later = r.steps.length - inRelease.length;
  const attention = inRelease.filter((s) => s.state === 'failed').length;
  const moving = inRelease.filter((s) => s.state === 'in_progress').length;
  const checking = inRelease.filter((s) => s.state === 'checking').length;
  const parts = [`${done} of ${inRelease.length} steps in this release done`];
  if (attention > 0) parts.push(`${attention} need${attention === 1 ? 's' : ''} attention`);
  if (moving > 0) parts.push(`${moving} in progress`);
  if (checking > 0) parts.push(`${checking} checking`);
  const checkable = inRelease.filter((s) => s.state === 'awaiting_check').length;
  if (checkable > 0) parts.push(`${checkable} ready to check`);
  if (later > 0) parts.push(`${later} not in this release`);
  return parts.join('; ');
}
