// Pure: what a person may start, answer or stop, from what main says (#24 action
// availability, #38 approvals, #36 dev deployments) and from what this computer
// can do now. An available action is a button; an unavailable one is a sentence
// that says why (with "How to set up" when the fix is on this computer); an action
// whose step is not in this release is not shown at all.
import type { ActionAvailabilityView, ApprovalView, DeploymentView } from '@shared/nexus/ipc';
import type { DeploymentStatus } from '@shared/nexus/platform';
import { USER_ACTIONS, getUserAction } from '@shared/nexus/actions';
import { getDomain } from '@shared/nexus/domains';
import { isAtOrBefore } from '@shared/nexus/domainSpec';
import { AGENT_ACTION_OFF_TEXT, setupText } from '../data/errorCopy';
import { gb, type ExecAvailability } from '../data/executionModel';
import { livePreviewsOf, type PreviewSubject } from '../runs/jobRunModel';

/** Actions with their own place: Stop and Diagnose live on the dev deployment row. A run row does not offer
 *  Diagnose in this release. */
export const PLACED_ACTIONS: readonly string[] = Object.freeze(['sde.preview.stop', 'sde.diagnose']);
/** Prerequisites that need this computer's execution setup (Docker, an image, disk). */
const MACHINE_PREREQS = /^(docker|disk:|image:)/;

export interface ActionButton {
  actionId: string; label: string; needsApproval: boolean;
  /** The input slot the context version fills (null for an action that takes none). */
  slot: string | null;
  /** True for an inline authoring action (a requirement or a problem statement): it opens the writing sheet. */
  inline: boolean;
}
export interface ActionSentence { actionId: string; text: string; setup: boolean }
export interface ActionBarView { buttons: ActionButton[]; sentences: ActionSentence[] }

export interface ActionContext {
  workspaceId: string;
  availability: ExecAvailability;
  /**
   * The version this bar acts on (its kind and status): the bar then lists only actions that take that version as an
   * input. Null for the project-level bar: it lists actions that take no input, and the reasons input-taking actions
   * cannot start (an available one is offered on its input version instead).
   */
  version: { kind: string; status: string } | null;
  /**
   * A dev deployment of this version that is live now (or the job starting one): `starting` or `running`. Main refuses
   * a second start (`deployment_live`), so the bar offers no second "Start a dev deployment" while one is live.
   */
  liveDeployment?: 'starting' | 'running' | null;
}

function stepLabel(workspaceId: string, stepId: string): string {
  return getDomain(workspaceId)?.lifecycle.find((s) => s.id === stepId)?.label ?? stepId;
}

/** The sentence for an action #24 says is unavailable (null: not shown at all). */
export function reasonSentence(a: Pick<ActionAvailabilityView, 'label' | 'reason'>, workspaceId: string): ActionSentence['text'] | null {
  const r = a.reason ?? '';
  if (r === 'future' || r === 'planned') return null;
  if (r.startsWith('setup:')) return `${a.label}: ${setupText(r)}`;
  if (r.startsWith('blocked_by_step:')) return `${a.label}: needs a ready version from the ${stepLabel(workspaceId, r.slice(16))} step first.`;
  // B2b: an agent flow while agent work is off says why in the one agent-off sentence (not "not available right now").
  if (r === 'agents_unavailable') return `${a.label}: ${AGENT_ACTION_OFF_TEXT}`;
  if (r === 'permission') return `${a.label}: you do not have permission to do that here.`;
  if (r === 'withdrawn' || r === 'complete') return `${a.label}: this project no longer takes part in this workspace.`;
  if (r === 'not_applicable') return null;
  return `${a.label}: not available right now.`;
}

/**
 * The bar. Main's answer is trusted for what it refuses and checked again for what it allows. The step is derived
 * from the registry (the step whose `via` names the action), never from the answer's `stepId`; an action that is not
 * one of this workspace's own, has no step, or whose step is not in this release is never listed. A machine
 * prerequisite while the setup is not ready, or a version that is not usable as an input, never gives a button.
 */
export function actionBar(list: readonly ActionAvailabilityView[], ctx: ActionContext): ActionBarView {
  const buttons: ActionButton[] = [];
  const sentences: ActionSentence[] = [];
  const domain = getDomain(ctx.workspaceId);
  if (!domain) return { buttons, sentences };
  for (const a of list) {
    if (PLACED_ACTIONS.includes(a.actionId) || !domain.actions.includes(a.actionId)) continue;
    const def = getUserAction(a.actionId);
    const step = domain.lifecycle.find((s) => s.via.some((v) => 'userAction' in v && v.userAction === a.actionId)) ?? null;
    if (!def || !step || step.status === 'FUTURE' || !isAtOrBefore(step.subPhase) || a.reason === 'future' || a.reason === 'planned') continue;
    // B2b: an agent flow has its own channel and place (the agent panel, the change in the Folio, the Changes tool). It is
    // never a job start, so an available one is not a button here; an unavailable one still says why, as a sentence.
    if (a.available && 'flow' in def.run) continue;
    const inline = 'inlineKind' in def.run;
    const takesInput = def.inputs.some((s) => s.min >= 1);
    // The input slot this version fills, from the registry's own slots.
    const fit = ctx.version ? def.inputs.find((s) => s.kinds.includes(ctx.version!.kind)) ?? null : null;
    if (ctx.version && !fit) continue; // the version bar: only actions on this version
    if (!ctx.version && takesInput && a.available) continue; // offered on its input version
    if (!a.available) {
      const text = reasonSentence(a, ctx.workspaceId);
      if (text) sentences.push({ actionId: a.actionId, text, setup: (a.reason ?? '').startsWith('setup:') });
      continue;
    }
    // Free disk below the 30 GB gate is an advisory (availability stays ready; only image preparation and the
    // execution checks need 30 GB), so heavy actions are never held for it here. Below the lease floor the
    // availability is `setup` (no job starts), and main answers `setup:disk_low` itself.
    if (def.prerequisites.some((p) => MACHINE_PREREQS.test(p)) && ctx.availability.kind !== 'ready') {
      sentences.push({ actionId: a.actionId, text: `${a.label}: this computer is not ready to run it yet.`, setup: true });
      continue;
    }
    // The step a healthy dev deployment completes: one live deployment per version is enough (no double start).
    if (fit && ctx.liveDeployment && 'record' in step.doneWhen && step.doneWhen.record === 'deployment_healthy') {
      sentences.push({ actionId: a.actionId, setup: false, text: ctx.liveDeployment === 'starting'
        ? `${a.label}: one is starting for this version. Follow it under Dev deployments.`
        : `${a.label}: one is running for this version. Stop it to start another.` });
      continue;
    }
    if (fit) {
      const preview = a.actionId === 'sde.preview.start';
      const st = ctx.version!.status;
      if (!(st === 'candidate' || st === 'active' || (preview && st === 'draft'))) {
        sentences.push({ actionId: a.actionId, text: `${a.label}: this version is not ready to be used yet.`, setup: false });
        continue;
      }
    }
    buttons.push({ actionId: a.actionId, label: a.label, needsApproval: a.needsApproval, slot: fit ? fit.slot : null, inline });
  }
  return { buttons, sentences };
}

/** The line after a start: the job is followed in Runs (main answered an existing job for a repeated intent). */
export function startedNote(label: string, created: boolean): string {
  return created ? `${label}: started. Follow it in Runs.` : `${label}: already started. Follow it in Runs.`;
}

/**
 * The workspaces, among a project's active ones, whose own actions take a version of `kind` as an input. A
 * project-owned version (a repository snapshot: no participation owns it) gets one version bar per such workspace,
 * so "Find tests on a commit" and "Build" are offered on it; each bar still shows a button only where main's #24
 * answer for that version says the action is available.
 */
export function workspacesActingOn(kind: string, workspaceIds: readonly string[]): string[] {
  return workspaceIds.filter((w) => {
    const d = getDomain(w);
    return !!d && USER_ACTIONS.some((a) => d.actions.includes(a.id) && a.inputs.some((s) => s.kinds.includes(kind)));
  });
}

/**
 * Whether a dev deployment of THIS version is live (livePreviewsOf, per version): `running` while one is up (answering
 * or not yet), `starting` while one starts or a live preview job of its build has no row yet, else null. Main refuses
 * a second start (`deployment_live`); the bar shows why instead of a button that would be refused.
 */
export function liveDeploymentOf(subject: PreviewSubject, deployments: Parameters<typeof livePreviewsOf>[1],
  jobs: Parameters<typeof livePreviewsOf>[2]): 'starting' | 'running' | null {
  const live = livePreviewsOf(subject, deployments, jobs);
  if (live.some((d) => d.status === 'healthy' || d.status === 'unhealthy')) return 'running';
  return live.length > 0 ? 'starting' : null;
}

// ---------- approvals ----------

export interface ApprovalRow {
  id: string;
  title: string;
  /** The DTO's own sentence, as main wrote it. */
  summary: string;
  /** Exactly what is reached or downloaded: registries, size, the hashes it is bound to. */
  facts: { label: string; value: string }[];
  expires: string;
  word: string;
  /** Only "Approve once" and "Deny", and only while it waits. */
  answers: ('Approve once' | 'Deny')[];
}

const APPROVAL_WORD: Record<ApprovalView['status'], string> = {
  pending: 'Waiting for your answer', approved: 'Approved once', denied: 'Denied', expired: 'Expired', withdrawn: 'Withdrawn'
};

const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function approvalRow(a: ApprovalView, now: number, fmt: (t: number) => string = clock): ApprovalRow {
  const r = a.request;
  const facts: { label: string; value: string }[] = [];
  if (r.registries && r.registries.length > 0) facts.push({ label: 'Reaches', value: r.registries.join(', ') });
  if (typeof r.estimatedBytes === 'number') facts.push({ label: 'Download size', value: `about ${gb(r.estimatedBytes)}` });
  if (typeof r.freeBytesNow === 'number') facts.push({ label: 'Free disk now', value: gb(r.freeBytesNow) });
  if (r.lockfileSha256) facts.push({ label: 'Lockfile', value: `sha256:${r.lockfileSha256.slice(0, 12)}` });
  if (r.contextSha256) facts.push({ label: 'Image recipe', value: `sha256:${r.contextSha256.slice(0, 12)}` });
  if (r.baseDigest) facts.push({ label: 'Pinned base', value: `sha256:${r.baseDigest.replace(/^sha256:/, '').slice(0, 12)}` });
  if (r.profile) facts.push({ label: 'Sandbox', value: r.profile });
  const title = a.reason === 'egress.deps' ? 'Download dependencies'
    : a.reason === 'image.prepare' ? `Prepare the ${r.profile ?? 'sandbox'} image`
      : a.reason === 'repo.write_refs' ? 'Let Nexus write hidden refs in this repository' : 'Approval';
  const pending = a.status === 'pending' && a.expiresAt > now;
  const mins = Math.max(0, Math.ceil((a.expiresAt - now) / 60_000));
  const expires = a.status !== 'pending' ? (a.decidedAt ? `Answered at ${fmt(a.decidedAt)}` : `Requested at ${fmt(a.requestedAt)}`)
    : pending ? `Expires at ${fmt(a.expiresAt)} (in ${mins} min)` : `Expired at ${fmt(a.expiresAt)}`;
  return { id: a.id, title, summary: a.summary, facts, expires, word: pending || a.status !== 'pending' ? APPROVAL_WORD[a.status] : 'Expired',
    answers: pending ? ['Approve once', 'Deny'] : [] };
}

// ---------- dev deployments ----------

export interface DeploymentRow {
  id: string;
  word: string;
  /** `http://127.0.0.1:<port>` only while it is healthy or not answering; never another host. */
  url: string | null;
  facts: { label: string; value: string }[];
  canStop: boolean;
  live: boolean;
}

const DEPLOYMENT_WORD: Record<DeploymentStatus, string> = {
  starting: 'Starting', healthy: 'Healthy', unhealthy: 'Not answering its health check', stopped: 'Stopped', failed: 'Failed'
};
const LIVE: readonly DeploymentStatus[] = ['starting', 'healthy', 'unhealthy'];

export function deploymentRow(d: DeploymentView, fmt: (t: number) => string = clock): DeploymentRow {
  const port = d.hostPort;
  const url = (d.status === 'healthy' || d.status === 'unhealthy') && typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
    ? `http://127.0.0.1:${port}` : null;
  const facts: { label: string; value: string }[] = [];
  if (d.lastProbe) {
    facts.push({ label: 'Last health check', value: `${d.lastProbe.status === null ? 'no answer' : `answered ${d.lastProbe.status}`}`
      + `${d.lastProbe.ms !== null ? ` in ${d.lastProbe.ms} ms` : ''} at ${fmt(d.lastProbe.at)}${d.healthPath ? ` (${d.healthPath})` : ''}` });
  }
  facts.push({ label: 'Health checks', value: String(d.probes) });
  facts.push({ label: 'Started', value: fmt(d.startedAt) });
  if (LIVE.includes(d.status)) facts.push({ label: 'Stops by itself', value: fmt(d.endsAt) });
  if (d.stoppedAt) facts.push({ label: 'Stopped', value: `${fmt(d.stoppedAt)}${d.stopReason ? ` (${d.stopReason.replace(/_/g, ' ')})` : ''}` });
  return { id: d.id, word: DEPLOYMENT_WORD[d.status] ?? d.status, url, facts, canStop: LIVE.includes(d.status), live: LIVE.includes(d.status) };
}

// ---------- writing a requirement or a problem statement (#35) ----------

/**
 * The artifact name a save uses: the name typed, else the title or question, with every run of whitespace (a newline
 * included) collapsed to one space, trimmed, at most 120 characters. A name is one line, so a newline in the question
 * can never break the save.
 */
export function derivedName(name: string, fallback: string): string {
  const one = (s: string) => s.replace(/\s+/g, ' ').trim();
  return (one(name) || one(fallback)).slice(0, 120).trim();
}

export interface RequirementDraft { title: string; body: string; criteria: { id: string; text: string }[] }
export interface ProblemDraft { question: string; context: string; audience: string; successCriteria: string[]; constraints: string[] }

/** The next free criterion id (C1, C2, ...): stable once given, never reused within the draft. */
export function nextCriterionId(criteria: readonly { id: string }[]): string {
  let n = criteria.length + 1;
  while (criteria.some((c) => c.id === `C${n}`)) n += 1;
  return `C${n}`;
}

/** The requirement content main checks (`req.schema`): what is missing, or the content. */
export function requirementContent(d: RequirementDraft): { content: Record<string, unknown> } | { problem: string } {
  const title = d.title.trim();
  const criteria = d.criteria.map((c) => ({ id: c.id, text: c.text.trim() })).filter((c) => c.text.length > 0);
  if (!title) return { problem: 'Give the requirement a title.' };
  if (title.length > 200) return { problem: 'Keep the title to 200 characters.' };
  if (criteria.length === 0) return { problem: 'Add at least one acceptance criterion.' };
  if (criteria.some((c) => c.text.length > 2000)) return { problem: 'Keep each criterion to 2000 characters.' };
  const body = d.body.trim();
  return { content: body ? { title, body, criteria } : { title, criteria } };
}

/** The problem statement content main checks (`problem.schema`). */
export function problemContent(d: ProblemDraft): { content: Record<string, unknown> } | { problem: string } {
  const question = d.question.trim();
  if (!question) return { problem: 'Write the question.' };
  if (question.length > 2000) return { problem: 'Keep the question to 2000 characters.' };
  const list = (xs: string[]) => xs.map((x) => x.trim()).filter((x) => x.length > 0);
  const out: Record<string, unknown> = { question };
  if (d.context.trim()) out.context = d.context.trim();
  if (d.audience.trim()) out.audience = d.audience.trim().slice(0, 200);
  const sc = list(d.successCriteria); const cs = list(d.constraints);
  if (sc.length > 20 || cs.length > 20) return { problem: 'Keep each list to 20 lines.' };
  if (sc.some((x) => x.length > 500) || cs.some((x) => x.length > 500)) return { problem: 'Keep each line to 500 characters.' };
  if (sc.length) out.successCriteria = sc;
  if (cs.length) out.constraints = cs;
  return { content: out };
}
