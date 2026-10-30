// Pure: the lead agent's Team, Requests, Tasks and Activity sections' data
// shaping. No React, no window — loadable by test/load-ts.cjs.

/** Fallback denominator for the per-agent token meter when no total token
 *  budget is configured, so the bar reads as an estimate (used + remaining)
 *  rather than pinned to 100% for whichever agent burns the most tokens. */
export const DEFAULT_TOKEN_CAP = 1_000_000;

/** Compact token count: 1K / 10K / 100K / 1M / 100M / 1B (trailing .0 trimmed). */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Cumulative token use against the agent's own limit when set, else the total
 *  token budget, else the default. `fraction` is clamped to 0..1. */
export function tokenMeter(used: number, o: { agentCap?: number; totalCap?: number }): { fraction: number; capLabel: string } {
  let cap: number;
  let why: string;
  if (o.agentCap && o.agentCap > 0) { cap = o.agentCap; why = 'agent limit'; }
  else if (o.totalCap && o.totalCap > 0) { cap = o.totalCap; why = 'total budget'; }
  else { cap = DEFAULT_TOKEN_CAP; why = 'default; set a total token budget in Settings'; }
  const fraction = Math.max(0, Math.min(1, used / cap));
  return { fraction, capLabel: `of ${fmtTokens(cap)} (${why})` };
}

export type TaskColumn = 'todo' | 'doing' | 'blocked' | 'done';

export const TASK_COLUMNS: ReadonlyArray<{ id: TaskColumn; label: string }> = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' }
];

/** Group tasks by status. Unknown statuses land in To do, as parseTasks does. */
export function columnsFor<T extends { status: string }>(tasks: ReadonlyArray<T>): Record<TaskColumn, T[]> {
  const out: Record<TaskColumn, T[]> = { todo: [], doing: [], blocked: [], done: [] };
  for (const t of tasks) {
    const key = (t.status === 'doing' || t.status === 'blocked' || t.status === 'done') ? t.status : 'todo';
    out[key].push(t);
  }
  return out;
}

export interface LogEntry { ts?: number; kind?: string; [k: string]: unknown }

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** One activity-log line. Agents are named through `name` (display labels);
 *  stored names in the log (`e.name`) are never printed. An unknown kind prints
 *  a plain "Something happened", never the raw kind or payload. */
export function activityLine(e: LogEntry, name: (id: string) => string): string {
  const who = (id: unknown): string => {
    const s = str(id);
    return s ? name(s) : 'an AI helper';
  };
  switch (e.kind) {
    case 'spawn': return `Started ${who(e.agentId)}`;
    case 'message':
    case 'terminal-handoff':
      return `${who(e.from)} → ${who(e.to)}: ${str(e.subject) || str(e.act)}`;
    case 'drain': {
      const n = Number(e.count) || 0;
      return `${who(e.agentId)} read ${n} message${n === 1 ? '' : 's'}`;
    }
    case 'escalate': return `Asked you: ${str(e.subject)}`;
    case 'approval': return `Approval ${e.approve ? 'granted' : 'denied'}`;
    case 'archive': return `${e.archived === false ? 'Restored' : 'Archived'} ${who(e.agentId)}`;
    case 'tasks': {
      const n = Number(e.count) || 0;
      return `Task list updated (${n} task${n === 1 ? '' : 's'})`;
    }
    default: return 'Something happened';
  }
}

/** Apply `change` to the open humanQA entries asking `q` (no answer yet; when
 *  `skipDismissed`, not dismissed either), working on the RAW ledger entries so
 *  fields outside the parsed schema survive the write. Non-object entries and
 *  every other entry pass through untouched. */
export function mergeHumanQA(rawQA: unknown, q: string, change: Record<string, unknown>, skipDismissed = false): unknown[] {
  const list: unknown[] = Array.isArray(rawQA) ? rawQA : [];
  return list.map((e) => {
    if (!e || typeof e !== 'object') return e;
    const r = e as Record<string, unknown>;
    const open = r.q === q && !r.a && (!skipDismissed || !r.dismissedAt);
    return open ? { ...r, ...change } : e;
  });
}

/** The message body for a request to the lead agent. A suggested agent is a
 *  hint the lead agent may ignore. The body is persisted and read by agents, so
 *  it names the agent by its STORED name (what the agents know it by) plus its
 *  id, never by a display label; labels belong to the UI only. */
export function requestBody(text: string, suggested?: { id: string; name: string }): string {
  const body = text.trim();
  return suggested
    ? `${body}\n\n(The human suggests ${suggested.name || suggested.id} (${suggested.id}) for this — your call as the lead agent.)`
    : body;
}
