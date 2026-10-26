// Pure: the agent panel, the session log and the intent line's route, from what main says (#23's `agent` row, #43 sessions,
// #44 session detail, #26 jobs). No React, so tests load it directly. Rules this file keeps:
// - every refusal is one plain sentence from errorCopy (never a reason code, a git message or a sha);
// - no host, model or engine name: the setup sheet's own row is the only place that carries the adapter's label and the hosts;
// - usage and cost are labelled "reported by the agent runtime", or "estimated" when Nexus charged the cap; never a percentage;
// - what the agent writes is display only, never evidence; a turn with no change reads "The agent made no change".
import type {
  AgentSetupView, AgentStartArgs, AgentUsageView, HealthView, JobView, SessionDetailView, SessionView
} from '@shared/nexus/ipc';
import { AGENT_REASON_TEXT, ROLLBACK_OWED_TEXT, errorCopy } from '../data/errorCopy';
import { noticeFor, sizeLabel, type ExecAvailability } from '../data/executionModel';
import { agentTurnHeadline, waitPhaseText } from '../runs/jobRunModel';
import { kindLabel, statusLabel } from '../project/artifactModel';

/** The one sentence for missing permission (F24): no host is named outside the setup sheet's consent row. */
export const CONSENT_MISSING_TEXT = AGENT_REASON_TEXT.consent_missing;
export const USAGE_LABEL = 'reported by the agent runtime';
export const USAGE_ESTIMATED_LABEL = 'estimated by Nexus: the runtime did not report one';
export const DISPLAY_ONLY_NOTE = 'What the agent wrote is shown for reading only. It is not evidence: only the checks and records are.';
export const ISOLATION_NOTE = 'The agent works in its own copy of the repository. Your files change only when you accept a change and merge it.';
export const MAX_MESSAGE_CHARS = 8000;

/** Whole US dollars and cents from a cent count ("$0.42"). Not a number the records do not hold: callers pass stored cents. */
export function money(cents: number): string {
  const c = Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0;
  return `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One turn's usage as a sentence; every cost carries its label. Null when the turn recorded none. */
export function usageLine(u: AgentUsageView | null): string | null {
  if (!u) return null;
  const calls = count(u.toolCalls, 'tool call', 'tool calls');
  if (u.estimated) {
    return `${calls}; cost about ${money(u.costUsdCents ?? 0)} (${USAGE_ESTIMATED_LABEL})`;
  }
  const tokens = u.inputTokens + u.outputTokens;
  const cost = u.costUsdCents === null ? 'no cost reported' : `cost ${money(u.costUsdCents)}`;
  return `${count(tokens, 'token', 'tokens')}, ${calls}, ${cost} (${USAGE_LABEL})`;
}

/** Today's usage on the setup row and the panel. */
export function usageTodayLine(u: AgentSetupView['usageToday']): string {
  if (u.turns === 0 && u.usdCents === 0) return 'No agent turn has started today.';
  return `Today: ${count(u.turns, 'turn', 'turns')} started, cost ${u.estimated ? `about ${money(u.usdCents)} (${USAGE_ESTIMATED_LABEL})` : `${money(u.usdCents)} (${USAGE_LABEL})`}.`;
}

// ---------- the panel ----------

const SESSION_WORD: Record<SessionView['status'], string> = {
  open: 'Ready for your next message', running: 'Working', awaiting_approval: 'Waiting for you', completed: 'Ended', failed: 'Stopped: it could not continue',
  cancelled: 'Cancelled', timed_out: 'Timed out', interrupted: 'Interrupted'
};

export interface SessionRowView {
  id: string;
  word: string;
  /** What the live turn is doing or waiting for, from its job ("Waiting for your network permission"); null when none is live. */
  turn: string | null;
  turns: string;
  live: boolean;
  canSend: boolean;
  canStop: boolean;
  canEnd: boolean;
}

export interface AgentPanelView {
  /** off: agent work is not available at all; setup: something must be done first; ready: a message can be sent. */
  kind: 'off' | 'setup' | 'ready';
  lead: string;
  /** Sentences, in order, each an unmet prerequisite (never a disabled button without a reason). */
  blockers: string[];
  canAsk: boolean;
  /** True when "Open Setup" is the way forward. */
  setup: boolean;
  /** "Working" while a turn runs, "Waiting for you" while one asks for an approval; null otherwise. */
  working: 'Working' | 'Waiting for you' | null;
  sessions: SessionRowView[];
  usageToday: string | null;
}

export interface AgentPanelInput {
  health: HealthView | null;
  availability: ExecAvailability;
  /** Null while unread. */
  sessions: readonly SessionView[] | null;
  /** The failure of the sessions read, if it failed. */
  sessionsFail: { code: string; reason?: string; subReason?: string } | null;
  /** The live turn jobs by id (for the waiting reason). */
  jobs?: ReadonlyMap<string, Pick<JobView, 'state' | 'phase' | 'headline' | 'outcome' | 'cancelRequested'>>;
}

function runtimeBlocker(a: AgentSetupView): string | null {
  switch (a.state) {
    case 'ready': return null;
    case 'not_installed': return AGENT_REASON_TEXT.runtime_not_installed;
    case 'not_signed_in': return AGENT_REASON_TEXT.runtime_not_authenticated;
    case 'version_unsupported': return AGENT_REASON_TEXT.runtime_version_unsupported;
    case 'unavailable': return AGENT_REASON_TEXT.runtime_error;
    default: return AGENT_REASON_TEXT.runtime_unknown;
  }
}

export function agentPanelModel(i: AgentPanelInput): AgentPanelView {
  const empty: Omit<AgentPanelView, 'kind' | 'lead' | 'blockers' | 'canAsk' | 'setup'> = { working: null, sessions: [], usageToday: null };
  // Agent work off (the part is not in place): one sentence, no setup to offer.
  if (i.sessionsFail) {
    const c = errorCopy(i.sessionsFail.code, i.sessionsFail.reason, i.sessionsFail.subReason);
    if (c.kind === 'execution_unavailable' || c.kind === 'unavailable') return { kind: 'off', lead: c.text, blockers: [], canAsk: false, setup: false, ...empty };
  }
  if (i.availability.kind === 'platform_off' || i.availability.kind === 'execution_off') {
    return { kind: 'off', lead: i.availability.text, blockers: [], canAsk: false, setup: false, ...empty };
  }
  const blockers: string[] = [];
  const exec = noticeFor(i.availability);
  if (i.availability.kind !== 'ready' && exec) blockers.push(exec.text);
  const a = i.health?.agent ?? null;
  if (!a) blockers.push(AGENT_REASON_TEXT.runtime_unknown);
  else {
    const rt = runtimeBlocker(a);
    if (rt) blockers.push(rt);
    else if (!a.consent.live) blockers.push(CONSENT_MISSING_TEXT);
    else if (a.consent.caps && a.consent.caps.dayUsdCents > 0 && a.usageToday.usdCents >= a.consent.caps.dayUsdCents) blockers.push(AGENT_REASON_TEXT.budget_exhausted);
  }
  const rows: SessionRowView[] = [...(i.sessions ?? [])].sort((x, y) => y.updatedAt - x.updatedAt).map((s) => {
    const job = s.liveJobId ? i.jobs?.get(s.liveJobId) ?? null : null;
    const turn = job ? agentTurnHeadline(job) : s.liveJobId ? 'The agent is working' : null;
    const live = s.status === 'running' || s.status === 'awaiting_approval';
    // A turn the guards hold is waiting, not working.
    const waiting = job && (job.state === 'queued' || job.state === 'retry_scheduled' || job.state === 'leased') && waitPhaseText(job.phase) !== null;
    return {
      id: s.id, word: waiting ? 'Waiting' : SESSION_WORD[s.status] ?? 'Status unknown', turn,
      turns: count(s.turns, 'turn', 'turns'), live, canSend: s.status === 'open', canStop: live, canEnd: s.status === 'open'
    };
  });
  const ss = i.sessions ?? [];
  const working = ss.some((s) => s.status === 'running') && rows.some((r) => r.word === 'Working') ? 'Working'
    : ss.some((s) => s.status === 'awaiting_approval') ? 'Waiting for you' : null;
  const canAsk = blockers.length === 0;
  return {
    kind: canAsk ? 'ready' : 'setup',
    lead: canAsk ? ISOLATION_NOTE : blockers[0],
    blockers, canAsk, setup: !canAsk, working, sessions: rows,
    usageToday: a && a.consent.live ? usageTodayLine(a.usageToday) : null
  };
}

// ---------- starting a turn ----------

/** The #42 request for a message, or the problem with it. Ids and the text only: never a path, host or command. */
export function startArgs(i: { projectId: string; workspaceId: string; sessionId: string | null; message: string; intentId: string }):
  { args: AgentStartArgs } | { problem: string } {
  const message = i.message.trim();
  if (!message) return { problem: 'Write a message for the agent first.' };
  if (message.length > MAX_MESSAGE_CHARS) return { problem: AGENT_REASON_TEXT.message_too_long };
  return { args: { projectId: i.projectId, workspaceId: i.workspaceId, sessionId: i.sessionId, focusVersionIds: [], message, intentId: i.intentId } };
}

/** The intent line sends to the agent (#42) only on an SDE project route and only when the agent can take a message now; every other
 *  route, workspace, or state keeps the legacy lead-agent behaviour. */
export function intentRoute(i: { routeName: string; primaryWorkspaceId: string | null; canAsk: boolean }): 'agent' | 'legacy' {
  return i.routeName === 'project' && i.primaryWorkspaceId === 'sde' && i.canAsk ? 'agent' : 'legacy';
}

// ---------- failures ----------

export interface AgentFailure {
  code: string; reason?: string | null; subReason?: string | null;
  detail?: Partial<Record<string, string | number | boolean | null>>;
}

/** The sentence for a refused agent, review, accept or merge call. A refusal that left an undo owed says so after its sentence. */
export function agentFailText(r: AgentFailure): string {
  const base = errorCopy(r.code, r.reason, r.subReason).text;
  return r.detail && r.detail.rollbackOwed === true ? `${base} ${ROLLBACK_OWED_TEXT}` : base;
}

// ---------- the session log ----------

export interface SessionLogView {
  /** Said once above the messages: they are display only. */
  note: string;
  messages: { key: string; author: string; text: string; when: string }[];
  turns: { key: string; headline: string; usage: string | null; when: string }[];
  toolCalls: { key: string; tool: string; outcome: string; size: string }[];
  versions: { key: string; versionId: string; kind: string; status: string }[];
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const clock = (t: number): string => (Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

/** The log of one conversation. Agent text is labelled display only; a tool call shows its name and result size, never its arguments. */
export function sessionLogModel(d: SessionDetailView): SessionLogView {
  return {
    note: DISPLAY_ONLY_NOTE,
    messages: d.messages.map((m) => ({ key: String(m.seq), author: m.from === 'agent' ? 'Agent (display only)' : 'You', text: m.text, when: clock(m.ts) })),
    turns: d.turnHistory.map((t) => ({
      key: t.jobId,
      headline: agentTurnHeadline({ state: t.state, outcome: t.outcome, phase: null, headline: t.headline, cancelRequested: false }),
      usage: usageLine(t.usage), when: clock(t.createdAt)
    })),
    toolCalls: d.toolCalls.map((c) => ({
      key: String(c.seq), tool: TOOL_NAME.test(c.tool) ? c.tool : 'a tool',
      outcome: c.ok === null ? 'result not recorded' : c.ok ? 'answered' : 'refused or failed',
      size: c.resultBytes === null ? 'size not recorded' : sizeLabel(c.resultBytes)
    })),
    versions: d.versions.map((v) => ({ key: v.versionId, versionId: v.versionId, kind: kindLabel(v.kind), status: statusLabel(v.status) }))
  };
}
