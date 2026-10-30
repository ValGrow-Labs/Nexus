import { useId, useState, type KeyboardEvent } from 'react';
import { useStore, type Agent } from '@/store/store';
import { useFleetTelemetry, type BreakerState } from '@/hooks/useTelemetry';
import { displayNameForId, leadAgentId, visibleAgents } from '@shared/agentDisplay';
import { canReceiveInbox } from '@shared/agentProvider';
import {
  decodeProviderModel,
  encodeProviderModel,
  inferAgentProvider,
  modelProvidersForAgent,
  modelsForProvider,
  providerPreset,
  AGENT_PROVIDER_PRESETS,
  type AgentProvider
} from '@/store/config';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { useAgentDisplay } from '../agentIdentity';
import { useRestartAgent } from './useRestartAgent';
import { useFleetRoster } from './useFleetRoster';
import { fmtTokens, tokenMeter } from './teamModel';

/** A GitHub issue as returned by `window.cth.githubIssues` (labels/assignees flattened). */
interface GHIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
}

/** What the usage limit is doing to an AI helper, in words. */
const BREAKER_WORDS: Record<BreakerState['level'], string> = {
  healthy: 'fine',
  steering: 'being nudged to use less',
  constrained: 'slowed down',
  stopped: 'stopped'
};

type Restart = ReturnType<typeof useRestartAgent>;
type Roster = ReturnType<typeof useFleetRoster>;
type Telemetry = ReturnType<typeof useFleetTelemetry>;

/** The lead AI helper's Team section: every visible agent with its live telemetry,
 *  token limit and model, then archived agents, folders and GitHub issues.
 *  Telemetry is shown only once it has actually arrived. */
export function TeamSection() {
  const allAgents = useStore((s) => s.agents);
  const { display, hint } = useAgentDisplay();
  // Display-time only: the dead legacy seed records are hidden, never deleted.
  const agents = visibleAgents(allAgents, hint);
  const leadId = leadAgentId(allAgents, hint);
  const ordered = [...agents].sort((a, b) => Number(b.id === leadId) - Number(a.id === leadId));
  const labelOf = (a: Agent): string => display.get(a.id)?.label ?? 'AI helper';

  const telemetry = useFleetTelemetry();
  const roster = useFleetRoster();
  const restart = useRestartAgent();
  const toolCounts = useStore((s) => s.toolCounts);

  // Fleet totals across the roster, from agents that have reported usage.
  let reported = 0, sumTokens = 0, sumInput = 0, sumCacheRead = 0, sumRate = 0;
  for (const a of agents) {
    const s = telemetry.samples[a.id];
    if (s) {
      reported++;
      sumTokens += s.input + s.output + s.cacheRead + s.cacheCreation;
      sumInput += s.input + s.cacheRead + s.cacheCreation;
      sumCacheRead += s.cacheRead;
    }
    sumRate += telemetry.rate[a.id] ?? 0;
  }
  const fleetCachePct = sumInput > 0 ? Math.round((sumCacheRead / sumInput) * 100) : 0;

  return (
    <div className="nxs">
      <div className="nxs__inner">
        <header className="nxs__head">
          <h3 className="nxs__title">Team</h3>
          <p className="nxs__lede">Every running AI helper, and how much each one has used.</p>
        </header>

        {telemetry.error && (
          <p className="nxs__error" role="alert">Nexus could not read the usage numbers: {telemetry.error}</p>
        )}

        {ordered.length === 0 ? (
          <EmptyState level={4} icon="agents" title="No AI helpers" body="No AI helpers are running." />
        ) : (
          <ul className="nxs__list" aria-label="AI helpers">
            {ordered.map((a) => (
              <li key={a.id}>
                <TeamMember
                  agent={a}
                  label={labelOf(a)}
                  role={display.get(a.id)?.role ?? ''}
                  isLead={a.id === leadId}
                  toolCount={toolCounts[a.id] ?? 0}
                  telemetry={telemetry}
                  roster={roster}
                  restart={restart}
                />
              </li>
            ))}
          </ul>
        )}

        <section className="nxs__group" aria-label="All AI helpers together">
          <h4 className="nxs__subtitle">All AI helpers together</h4>
          {reported === 0 ? (
            <p className="nxs__note">No usage has been reported yet. Totals appear once an AI helper reports.</p>
          ) : (
            <p className="nxt-total">
              <span><strong>{fmtTokens(sumTokens)}</strong> tokens</span>
              <span>read in {fmtTokens(sumInput)} ({fleetCachePct}% reused)</span>
              <span>{Math.round(sumRate).toLocaleString()} tokens/min</span>
              <span className="nxs__note">from {reported} of {agents.length} AI helper{agents.length === 1 ? '' : 's'}</span>
            </p>
          )}
          <p className="nxs__note">
            Each bar shows how many tokens an AI helper has used, against its own limit, or else against the total budget
            {roster.tokenCap && roster.tokenCap > 0 ? ` of ${fmtTokens(roster.tokenCap)}` : ' (none is set; you can set one in Settings)'}. A token is a small piece of text that an AI reads or writes.
          </p>
        </section>

        <ArchivedAgents />
        <Folders repos={roster.repos} />
        <GitHubIssues repos={roster.repos} />
      </div>
    </div>
  );
}

// ─── One agent ───────────────────────────────────────────────────────────────

function TeamMember({ agent: a, label, role, isLead, toolCount, telemetry, roster, restart }: {
  agent: Agent;
  label: string;
  role: string;
  isLead: boolean;
  toolCount: number;
  telemetry: Telemetry;
  roster: Roster;
  restart: Restart;
}) {
  const uid = useId();
  const select = useStore((s) => s.select);
  const agentProvider = inferAgentProvider(a.command, a.provider);
  const agentPreset = providerPreset(agentProvider);
  const sample = telemetry.samples[a.id];
  const breaker: BreakerState | undefined = telemetry.breakers[a.id];
  const armed = !!breaker && (breaker.level === 'constrained' || breaker.level === 'stopped');
  const agentCap = roster.agentTokenCaps[a.id];
  const busy = restart.restarting === a.id;
  const canResume = agentProvider === 'claude' || !!agentPreset.resumeFlag || !!agentPreset.resumeSubcommand;
  const titleId = `${uid}-name`;

  return (
    <article className={`nxt-card${isLead ? ' nxt-card--lead' : ''}${armed ? ' nxt-card--armed' : ''}`} aria-labelledby={titleId}>
      <div className="nxt-card__top">
        <h4 className="nxt-card__name" id={titleId}>{label}</h4>
        <span className="nxt-chip">Status: {armed ? 'held back because it used too much' : a.status}</span>
        <span className="nxt-card__meta">{agentPreset.label}{a.model ? ` · ${a.model}` : ''}</span>
        <span className="nxt-card__meta nxt-card__end">{toolCount} tool call{toolCount === 1 ? '' : 's'}</span>
      </div>
      {role && <p className="nxt-card__meta">{role}</p>}
      {a.cwd && <p className="nxt-card__path" title={a.cwd}>{a.cwd}</p>}

      {breaker && breaker.level !== 'healthy' && (
        <p className="nxt-warn" role="status">
          Usage limit: {BREAKER_WORDS[breaker.level]}{breaker.reason ? `. ${breaker.reason}` : ''}
        </p>
      )}

      <TokenUsage agentId={a.id} sample={sample} telemetry={telemetry} agentCap={agentCap} totalCap={roster.tokenCap} armed={armed} />
      <ContextGauge agent={a} />

      <div className="nxt-controls">
        <TokenLimitEditor label={label} value={agentCap} onSet={(t) => roster.setAgentCap(a.id, t)} />
        {!isLead && a.ptyId && (
          <ModelPicker agent={a} label={label} provider={agentProvider} busy={busy} defaultModel={roster.defaultModel} restart={restart} />
        )}
        {/* No pty needed: saving the engine is the recovery path when the lead
            failed to spawn on a bad one (the restart step no-ops without a pty). */}
        {isLead && <EnginePicker agent={a} busy={busy} roster={roster} restart={restart} />}
        {a.ptyId && (isLead || canResume) && (
          <Button
            disabled={busy}
            title={`Stops ${label} and starts it again, and keeps its conversation. Use this if the terminal looks garbled.`}
            onClick={() => { void restart.restartWithModel(a, a.model, { resume: true }); }}
          >
            {busy ? 'Restarting…' : 'Restart and keep the conversation'}
          </Button>
        )}
        <Button variant="quiet" onClick={() => select(a.id)} ariaLabel={`Open ${label}'s workbench`}>Open</Button>
      </div>
      {restart.restartErrors[a.id] && <p className="nxs__error" role="alert">{restart.restartErrors[a.id]}</p>}
    </article>
  );
}

function Bar({ fraction, level, label }: { fraction: number; level: 'ok' | 'warn' | 'bad'; label: string }) {
  return (
    <span className="nxt-bar" role="img" aria-label={label}>
      <span className="nxt-bar__fill" data-level={level} style={{ width: `${Math.round(fraction * 100)}%` }} />
    </span>
  );
}

function TokenUsage({ agentId, sample, telemetry, agentCap, totalCap, armed }: {
  agentId: string;
  sample: Telemetry['samples'][string] | undefined;
  telemetry: Telemetry;
  agentCap?: number;
  totalCap?: number;
  armed: boolean;
}) {
  if (!sample) {
    return (
      <div className="nxt-gauge">
        <span className="nxt-gauge__label">Tokens</span>
        <span className="nxs__note nxt-gauge__wide">No usage reported yet.</span>
      </div>
    );
  }
  const tokens = sample.input + sample.output + sample.cacheRead + sample.cacheCreation;
  const meter = tokenMeter(tokens, { agentCap, totalCap });
  const pct = Math.round(meter.fraction * 100);
  const level = armed || pct >= 90 ? 'bad' : pct >= 60 ? 'warn' : 'ok';
  // Sparkline only when the agent is actually burning tokens.
  const series = telemetry.spark[agentId] ?? [];
  const hasSpark = series.some((v) => v > 0);
  const rate = Math.round(telemetry.rate[agentId] ?? 0);
  const last = telemetry.lastTool[agentId];
  return (
    <>
      <div className="nxt-gauge">
        <span className="nxt-gauge__label">Tokens</span>
        <Bar fraction={meter.fraction} level={level} label={`${tokens.toLocaleString()} tokens used, ${pct}% ${meter.capLabel}`} />
        <span className="nxt-gauge__value">{fmtTokens(tokens)} {meter.capLabel} · {pct}%</span>
      </div>
      {(hasSpark || last) && (
        <div className="nxt-gauge">
          <span className="nxt-gauge__label">Rate</span>
          <span className="nxt-gauge__wide nxt-rate">
            {hasSpark && <span className="nxt-spark" aria-hidden="true">{sparkText(series)}</span>}
            {rate > 0 && <span className="nxt-gauge__value">{fmtTokens(rate)} tokens/min</span>}
            {last && <span className="nxt-tool">Last tool: {last}</span>}
          </span>
        </div>
      )}
    </>
  );
}

/** Context window: tokens currently in the window against its real size, fed by
 *  the status line. Distinct from cumulative usage: this is headroom before
 *  compaction. */
function ContextGauge({ agent: a }: { agent: Agent }) {
  if (a.contextTokens === undefined || !a.contextLimit) {
    return (
      <div className="nxt-gauge">
        <span className="nxt-gauge__label">Context</span>
        <span className="nxs__note nxt-gauge__wide">Not reported yet.</span>
      </div>
    );
  }
  const fraction = Math.min(1, a.contextTokens / a.contextLimit);
  const pct = Math.round(fraction * 100);
  return (
    <div className="nxt-gauge">
      <span className="nxt-gauge__label">Context</span>
      <Bar fraction={fraction} level={pct >= 88 ? 'bad' : pct >= 75 ? 'warn' : 'ok'} label={`Context window ${pct}% full`} />
      <span className="nxt-gauge__value">{fmtTokens(a.contextTokens)} of {fmtTokens(a.contextLimit)} · {pct}%</span>
    </div>
  );
}

/** Block-character sparkline of recent token deltas. */
function sparkText(series: number[]): string {
  const blocks = '▁▂▃▄▅▆▇█';
  const max = Math.max(1, ...series);
  return series.map((v) => blocks[Math.min(blocks.length - 1, Math.round((v / max) * (blocks.length - 1)))]).join('');
}

/** Per-agent token limit. Enter or Save commits, Escape or Cancel discards; an
 *  empty value clears the limit. */
function TokenLimitEditor({ label, value, onSet }: { label: string; value?: number; onSet: (tokens: number | undefined) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const inputId = useId();
  const commit = (): void => {
    const raw = text.trim();
    const n = raw === '' ? undefined : Number(raw);
    onSet(typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
    setEditing(false);
  };
  if (!editing) {
    return (
      <Button
        title={`Set ${label}'s total token limit`}
        onClick={() => { setText(value != null ? String(value) : ''); setEditing(true); }}
      >
        {value && value > 0 ? `Token limit ${fmtTokens(value)}` : 'Set token limit'}
      </Button>
    );
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
  };
  return (
    <span className="nxt-inline">
      <label className="nxs-label" htmlFor={inputId}>Token limit for {label}</label>
      <input
        id={inputId}
        autoFocus
        className="nxs-input nxt-inline__num"
        type="number" min="0" step="100000" value={text}
        placeholder="tokens"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <Button variant="primary" onClick={commit}>Save</Button>
      <Button variant="quiet" onClick={() => setEditing(false)}>Cancel</Button>
    </span>
  );
}

/** Cross-provider model switch for a non-lead agent. Choosing does nothing on
 *  its own; Apply restarts the agent. Same provider resumes the conversation
 *  when it can (falls back to a fresh session); another provider starts fresh. */
function ModelPicker({ agent: a, label, provider, busy, defaultModel, restart }: {
  agent: Agent;
  label: string;
  provider: AgentProvider;
  busy: boolean;
  defaultModel?: string;
  restart: Restart;
}) {
  const preset = providerPreset(provider);
  const current = encodeProviderModel(provider, a.model);
  const [choice, setChoice] = useState(current);
  const selectId = useId();
  const currentModelKnown = modelsForProvider(provider).some((model) => model.id === a.model);
  const apply = (): void => {
    const picked = decodeProviderModel(choice);
    if (!picked) return;
    void restart.restartWithModel(a, picked.model, {
      provider: picked.provider,
      resume: picked.provider === provider,
      resumeOptional: true
    });
  };
  return (
    <span className="nxt-inline">
      <label className="nxs-label" htmlFor={selectId}>Model for {label}</label>
      <select id={selectId} className="nxs-select" value={choice} disabled={busy} onChange={(e) => setChoice(e.target.value)}>
        {(!preset.supportsModel || !currentModelKnown) && (
          <option value={current}>{preset.label} · {a.model ?? 'current'}</option>
        )}
        {modelProvidersForAgent(a.isGod).map((p) => (
          <optgroup key={p.id} label={p.label}>
            {modelsForProvider(p.id).map((model) => {
              // `defaultModel` is a Claude model id, so it can only mark an entry in the Claude group.
              const isAppDefault = p.id === 'claude' && !!defaultModel && model.id === defaultModel;
              return (
                <option key={`${p.id}:${model.id ?? 'cli-default'}`} value={encodeProviderModel(p.id, model.id)}>
                  {model.label}{isAppDefault ? ' · default' : ''}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>
      <Button disabled={busy || choice === current} title="Restarts the AI helper on the model you picked" onClick={apply}>
        {busy ? 'Restarting…' : 'Apply model'}
      </Button>
    </span>
  );
}

/** The lead agent's engine and model (config `godProvider` / `godModel`). */
function EnginePicker({ agent: a, busy, roster, restart }: { agent: Agent; busy: boolean; roster: Roster; restart: Restart }) {
  const providerId = useId();
  const modelId = useId();
  const [note, setNote] = useState<string | null>(null);
  const apply = async (): Promise<void> => {
    setNote(null);
    const currentProvider = inferAgentProvider(a.command, a.provider);
    if (a.ptyId && roster.engineProvider !== currentProvider) {
      if (!window.confirm("This restarts the lead AI helper. A conversation cannot move to a different program, so it starts fresh.")) return;
    }
    try {
      await window.cth.updateConfig({ godProvider: roster.engineProvider, godModel: roster.engineModel });
    } catch (e) {
      setNote(`Nexus could not save your choice: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // Without a live terminal this is a no-op; the saved engine is used at the next start.
    await restart.restartWithModel(a, roster.engineModel, { provider: roster.engineProvider, resume: false });
    if (!a.ptyId) setNote('Saved. The lead AI helper uses this program the next time it starts.');
  };
  return (
    <span className="nxt-inline">
      <label className="nxs-label" htmlFor={providerId}>Program for the lead AI helper</label>
      <select
        id={providerId}
        className="nxs-select"
        value={roster.engineProvider}
        disabled={busy}
        onChange={(e) => {
          const p = e.target.value as AgentProvider;
          roster.setEngineProvider(p);
          roster.setEngineModel(AGENT_PROVIDER_PRESETS.find((x) => x.id === p)?.recommendedOrchestratorModel);
        }}
      >
        {AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id)).map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      <label className="nxs-label" htmlFor={modelId}>Model for the lead AI helper</label>
      <select id={modelId} className="nxs-select" value={roster.engineModel ?? ''} disabled={busy} onChange={(e) => roster.setEngineModel(e.target.value || undefined)}>
        {modelsForProvider(roster.engineProvider).map((m) => (
          <option key={m.label} value={m.id ?? ''}>{m.label}</option>
        ))}
      </select>
      <Button disabled={busy} title="Saves your choice, then restarts the lead AI helper" onClick={() => { void apply(); }}>
        {busy ? 'Restarting…' : a.ptyId ? 'Apply choice' : 'Save choice'}
      </Button>
      {note && <span className="nxs__status" role="status">{note}</span>}
    </span>
  );
}

// ─── Archived, folders, issues ───────────────────────────────────────────────

function ArchivedAgents() {
  const { canon, hint } = useAgentDisplay();
  const archivedAgents = useStore((s) => s.archivedAgents);
  const removeArchivedAgent = useStore((s) => s.removeArchivedAgent);
  if (archivedAgents.length === 0) return null;
  return (
    <details className="nxs__group nxs-details">
      <summary>Closed AI helpers ({archivedAgents.length})</summary>
      <p className="nxs__note">Closed AI helpers keep their history. “Forget” removes one from this list.</p>
      <ul className="nxs__list">
        {archivedAgents.map((a) => {
          const name = displayNameForId(a.id, canon, hint);
          return (
            <li key={a.id} className="nxt-row">
              <span className="nxt-row__main">
                <span className="nxt-row__name">{name}</span>
                {a.cwd && <span className="nxt-card__path">{a.cwd}</span>}
              </span>
              <Button variant="quiet" ariaLabel={`Forget ${name}`} onClick={() => removeArchivedAgent(a.id)}>Forget</Button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function Folders({ repos }: { repos: string[] }) {
  const [error, setError] = useState<string | null>(null);
  const open = async (r: string): Promise<void> => {
    setError(null);
    try {
      const res = await window.cth.openTerminalAt(r);
      if (!res.ok) setError(`Nexus could not open a terminal at ${r}: ${res.error ?? 'something went wrong'}`);
    } catch (e) {
      setError(`Nexus could not open a terminal at ${r}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <details className="nxs__group nxs-details">
      <summary>Folders ({repos.length})</summary>
      {repos.length === 0 ? (
        <p className="nxs__note">No project folders added yet.</p>
      ) : (
        <ul className="nxs__list">
          {repos.map((r) => (
            <li key={r} className="nxt-row">
              <span className="nxt-row__main"><span className="nxt-card__path">{r}</span></span>
              <Button icon="terminal" ariaLabel={`Open ${r} in terminal`} onClick={() => { void open(r); }}>Open in terminal</Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="nxs__error" role="alert">{error}</p>}
    </details>
  );
}

function GitHubIssues({ repos }: { repos: string[] }) {
  const requestDispatchSeed = useStore((s) => s.requestDispatchSeed);
  const [issueRepo, setIssueRepo] = useState('');
  const [issues, setIssues] = useState<GHIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const repo = issueRepo || repos[0];

  const fetchIssues = async (): Promise<void> => {
    if (!repo) { setError('No folder is picked yet.'); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await window.cth.githubIssues(repo);
      if (res.ok) {
        setIssues((res.issues ?? []).slice(0, 10));
      } else {
        setIssues([]);
        setError(res.error ?? 'Nexus could not load the issues.');
      }
    } catch (e) {
      setIssues([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  };

  // Seeds the request box and opens Requests; the lead agent decides the owner.
  const seedRequest = (issue: GHIssue): void => {
    const body = (issue.body ?? '').slice(0, 200);
    requestDispatchSeed(`GitHub Issue #${issue.number}: ${issue.title}\n\n${body}\n\nURL: ${issue.url}`);
  };

  return (
    <details className="nxs__group nxs-details">
      <summary>GitHub issues</summary>
      {repos.length === 0 ? (
        <p className="nxs__note">No project folders added yet.</p>
      ) : (
        <>
          <div className="nxs-actions">
            <label className="nxs-label" htmlFor={selectId}>Folder</label>
            <select id={selectId} className="nxs-select" value={repo} onChange={(e) => setIssueRepo(e.target.value)}>
              {repos.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <Button disabled={loading} onClick={() => { void fetchIssues(); }}>{loading ? 'Loading…' : 'Load issues'}</Button>
          </div>
          {error && <p className="nxs__error" role="alert">{error}</p>}
          {!error && loaded && !loading && issues.length === 0 && <p className="nxs__note">No issues found.</p>}
          {issues.length > 0 && (
            <ul className="nxs__list" aria-label="Issues">
              {issues.map((issue) => (
                <li key={issue.number} className="nxt-row">
                  <span className="nxt-row__main">
                    <span className="nxt-row__name"><span className="nxs-id">#{issue.number}</span> {issue.title}</span>
                    {issue.labels.length > 0 && (
                      <span className="nxt-labels">{issue.labels.map((l) => <span key={l} className="nxt-chip">{l}</span>)}</span>
                    )}
                  </span>
                  <Button ariaLabel={`Use issue ${issue.number} as a request`} onClick={() => seedRequest(issue)}>Use as request</Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </details>
  );
}
