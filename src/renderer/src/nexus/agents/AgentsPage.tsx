import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { AgentWorkbench } from './workbench/AgentWorkbench';
import { MemoryPanel } from '@/components/MemoryPanel';
import { Icon } from '../icons';
import { agentRows } from './agentList';
import { useRegistryIds } from './agentIdentity';
import { leadAgentId } from '@shared/agentDisplay';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { restoreStatusLine, type RestoreStatus } from '@/hooks/restoreTeamPolicy';
import { AutoModeBanner } from './AutoModeBanner';
import { useNexusUi } from '../state/uiStore';

/** The last palette request to open Semantic memory that was honoured, so a
 *  later visit to the page does not reopen it on its own. */
let handledMemoryTick = 0;

/** Agents: a plain list plus the selected agent's real terminal. */
export function AgentsPage({ config }: { config: HarnessConfig }) {
  const agents = useStore((s) => s.agents);
  const queues = useStore((s) => s.messageQueues);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const godStatus = useStore((s) => s.godStatus);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  // Semantic memory (the model picker) is one click away: the summary below,
  // or the palette's "Agents: Semantic memory" entry, which opens it here.
  const memoryTick = useNexusUi((s) => s.memoryTick);
  const memRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    if (memoryTick === handledMemoryTick || !memRef.current) return;
    handledMemoryTick = memoryTick;
    memRef.current.open = true;
    memRef.current.querySelector('summary')?.focus();
  }, [memoryTick]);

  const hint = useRegistryIds();
  // App's config prop is read once at launch; the auto mode line follows main
  // (fresh read here, and the banner's answer) so it never goes stale.
  const [autoOn, setAutoOn] = useState<boolean>(config.autoMode === true);
  useEffect(() => {
    let alive = true;
    window.cth.getConfig().then((c) => { if (alive) setAutoOn(c.autoMode === true); }).catch(() => { /* keep the prop value */ });
    return () => { alive = false; };
  }, []);
  const restorable = useStore((s) => s.restorableAgents);
  const archived = useStore((s) => s.archivedAgents);
  const { restoring, autoRestoring, pendingCount, restoreNote } = useRestoreTeam(config);
  const restoreStatus: RestoreStatus = restoring
    ? { kind: 'running', auto: autoRestoring }
    : pendingCount > 0
      ? { kind: 'pending', count: pendingCount }
      : restoreNote
        ? { kind: 'done', note: restoreNote }
        : { kind: 'idle' };
  const restoreLine = restoreStatusLine(restoreStatus);

  const rows = useMemo(() => agentRows(agents, queues as Record<string, unknown[]>, hint, [...restorable, ...archived]), [agents, queues, hint, restorable, archived]);
  const current = rows.find((r) => r.id === selectedId);
  const agent = current ? agents.find((a) => a.id === current.id) : undefined;

  // Single source of selection: when nothing valid is selected, pick the lead
  // agent (rows are lead-first), else the first row.
  useEffect(() => {
    if (!current && rows.length > 0) select(rows[0].id);
  }, [current, rows, select]);

  const toggleFullscreen = () => {
    const s = useStore.getState();
    if (fullscreenAgentId) { s.setFullscreen(null); return; }
    const target = s.agents.find((x) => x.id === s.selectedId && x.ptyId) ?? s.agents.find((x) => x.id === leadAgentId(s.agents, hint) && x.ptyId) ?? s.agents.find((x) => x.ptyId);
    if (target) s.setFullscreen(target.id);
  };

  const memory = (
    <details className="nxa__mem" ref={memRef}>
      <summary className="nxa__mem-sum nx-focusable">Semantic memory</summary>
      <div className="nxa__mem-body"><MemoryPanel defaultOpen /></div>
    </details>
  );

  // A new install starts no lead agent by itself (it is an agent program running in a terminal): it starts only from here.
  const requestLeadStart = useStore((s) => s.requestLeadStart);
  const startLeadButton = (primary: boolean) => (
    <button type="button" className={`nx-btn nx-focusable${primary ? ' nx-btn--primary' : ''}`} onClick={requestLeadStart}>
      <Icon name="terminal" /> Start the lead agent
    </button>
  );

  const addButton = (primary: boolean) => (
    <button type="button" className={`nx-btn nx-focusable${primary ? ' nx-btn--primary' : ''}`} onClick={() => setAddAgentOpen(true)}>
      <Icon name="plus" /> Add agent
    </button>
  );

  return (
    <div className="nxa">
      <div className="nxa__bar">
        <h1 className="nxa__title">Agents</h1>
        <span className="nxa__auto">{autoOn ? 'Auto mode is on: agents skip their CLI approval prompts' : 'Auto mode is off: agents use their CLI approval prompts'}</span>
        <div className="nxa__actions">
          {godStatus === 'off' && rows.length > 0 && startLeadButton(false)}
          {addButton(false)}
          <button type="button" className="nx-btn nx-btn--quiet nx-focusable" onClick={toggleFullscreen}>
            <Icon name="panel" /> {fullscreenAgentId ? 'Exit fullscreen' : 'Fullscreen terminal'}
          </button>
        </div>
      </div>

      <AutoModeBanner onAnswered={setAutoOn} />

      {restoreLine ? <p className="nxa__restore" role="status">{restoreLine}</p> : null}

      {rows.length === 0 ? (
        godStatus === 'booting' ? (
          <div className="nxa__empty">
            <p className="nxa__note" role="status">The lead agent is starting. Its terminal appears here when it is ready.</p>
            {memory}
          </div>
        ) : godStatus === 'off' ? (
          <div className="nxa__empty">
            <div className="nx-empty">
              <h2 className="nx-empty__title">The lead agent is not running</h2>
              <p className="nx-empty__body">Nothing starts by itself. The lead agent takes your requests in the terminal and hands work to other agents. It needs an agent program that is installed and signed in on this computer, which you choose in Settings. Start it only if you want it. Building in a project does not need it.</p>
              <div className="nx-empty__actions">{startLeadButton(true)}{addButton(false)}</div>
            </div>
            {memory}
          </div>
        ) : (
          <div className="nxa__empty">
            <div className="nx-empty">
              <h2 className="nx-empty__title">No agents yet</h2>
              <p className="nx-empty__body">No agents are running. Add one to see its terminal here.</p>
              <div className="nx-empty__actions">{addButton(true)}</div>
            </div>
            {memory}
          </div>
        )
      ) : (
        <div className="nxa__body">
          <div className="nxa__side">
          <ul className="nxa__list" aria-label="Agents">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="nxa__row nx-focusable"
                  aria-current={r.id === current?.id ? 'true' : undefined}
                  onClick={() => select(r.id)}
                >
                  <span className="nxa__row-title">{r.title}</span>
                  <span className="nxa__row-role">{r.role}</span>
                  <span className="nxa__row-meta">
                    <span>{r.provider}</span>
                    <span>Status: {r.status}</span>
                    {r.queued > 0 && <span>{r.queued} queued</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {memory}
          </div>
          <section className="nxa__term" role="region" aria-label={`${current?.title ?? 'Agent'} panel`}>
            {agent ? <AgentWorkbench agent={agent} /> : null}
          </section>
        </div>
      )}
    </div>
  );
}
