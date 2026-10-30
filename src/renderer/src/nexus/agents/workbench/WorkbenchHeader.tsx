import { useState } from 'react';
import { disposeTerminal } from '@/components/terminalPool';
import { useStore, type Agent } from '@/store/store';
import { Button } from '../../ui/Button';
import { deliveryLabel } from './workbenchModel';

/** Workbench header: who the agent is (label, role, folder, status) and the
 *  actions that really exist for it. Nothing is shown that the app cannot do. */
export function WorkbenchHeader({ agent, label, role, isLead, fullscreen, delivery, titleId }: {
  agent: Agent;
  label: string;
  role: string;
  isLead: boolean;
  fullscreen: boolean;
  /** The every-agent delivery switch; passed for the lead agent only. */
  delivery: { paused: boolean; toggle: () => Promise<void> } | null;
  titleId: string;
}) {
  const [openTerminalState, setOpenTerminalState] = useState<'idle' | 'opening' | 'ok' | 'error'>('idle');
  const [openTerminalError, setOpenTerminalError] = useState<string | undefined>();
  const archiveAgent = useStore((s) => s.archiveAgent);
  const setFullscreen = useStore((s) => s.setFullscreen);

  const openTerminal = async () => {
    setOpenTerminalState('opening');
    setOpenTerminalError(undefined);
    try {
      const result = await window.cth.openTerminalAt(agent.cwd);
      if (result.ok) {
        setOpenTerminalState('ok');
        setTimeout(() => setOpenTerminalState('idle'), 1500);
      } else {
        setOpenTerminalState('error');
        setOpenTerminalError(result.error ?? 'something went wrong');
        setTimeout(() => setOpenTerminalState('idle'), 4000);
      }
    } catch (e) {
      setOpenTerminalState('error');
      setOpenTerminalError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setOpenTerminalState('idle'), 4000);
    }
  };

  // Kill, dispose the pooled xterm, archive (history is kept). Not offered for
  // the lead agent: it is restarted rather than closed.
  const onKill = async () => {
    if (!agent.ptyId) return;
    if (!confirm(`Close ${label}? It stops running and moves to the archive. Its history is kept.`)) return;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    archiveAgent(agent.id);
  };

  const dl = delivery ? deliveryLabel(delivery.paused) : null;

  return (
    <>
      <header className="nxw__head">
        <div className="nxw__id">
          <div className="nxw__title-row">
            <h2 className="nxw__title" id={titleId}>{label}</h2>
            <span className="nxw__chip">Status: {agent.status}</span>
          </div>
          <div className="nxw__meta">
            {role && <span className="nxw__role">{role}</span>}
            {agent.cwd && <span className="nxw__folder" title={agent.cwd}>{agent.cwd}</span>}
          </div>
        </div>
        <div className="nxw__controls" role="group" aria-label={`${label} actions`}>
          {isLead && delivery && dl && (
            <Button variant={delivery.paused ? 'primary' : 'secondary'} title={dl.title} onClick={() => { void delivery.toggle(); }}>
              {dl.text}
            </Button>
          )}
          <Button icon="files" title={`Open ${label}'s folder in the editor`} onClick={() => useStore.getState().setIdeOpen(true, agent.id)}>
            Open files
          </Button>
          <Button icon="terminal" title={`Open your terminal app at ${agent.cwd}`} disabled={openTerminalState === 'opening'} onClick={() => { void openTerminal(); }}>
            {openTerminalState === 'opening' ? 'Opening…' : openTerminalState === 'ok' ? 'Opened' : 'Open folder in terminal'}
          </Button>
          {agent.ptyId && (
            <Button icon="panel" onClick={() => setFullscreen(fullscreen ? null : agent.id)}>
              {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            </Button>
          )}
          {!isLead && agent.ptyId && (
            <Button icon="close" title={`Close ${label}: it stops running and moves to the archive`} onClick={() => { void onKill(); }}>
              Close AI helper
            </Button>
          )}
        </div>
      </header>
      {openTerminalError && (
        <p className="nxw__alert" role="alert">Nexus could not open a terminal: {openTerminalError}</p>
      )}
    </>
  );
}
