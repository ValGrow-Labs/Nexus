import { PtyTerminalView } from '@/components/PtyTerminalView';
import { terminalInstanceKey } from '@/components/terminalRecovery';
import { MessageQueueComposer } from '@/components/MessageQueueComposer';
import { useStore, type Agent } from '@/store/store';
import { EmptyState } from '../../ui/EmptyState';

/** The Terminal section, the same for every agent: the live pty and the
 *  message queue. Operator controls sit above the sections, in the frame.
 *  Moved from the old agent panel and lead panel.
 *
 *  @param fullscreen this instance IS the fullscreen overlay, so it owns the pty
 *  and renders the real terminal. The docked instance shows a placeholder
 *  instead: two live xterms on one pty fight over its cols/rows, which corrupts
 *  the display and breaks scrolling. The docked one re-mounts and re-fits when
 *  fullscreen closes.
 *  @param onPtyStream the frame's single `usePtyParser(agent.id)` callback. */
export function WorkbenchTerminal({ agent, fullscreen, isLead, onPtyStream }: {
  agent: Agent;
  fullscreen: boolean;
  isLead: boolean;
  onPtyStream: (data: string) => void;
}) {
  const updateAgent = useStore((s) => s.updateAgent);
  const setFullscreen = useStore((s) => s.setFullscreen);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  // True only for the DOCKED workbench while the overlay holds this agent.
  const isFullscreenedHere = fullscreenAgentId === agent.id && !fullscreen;

  if (!agent.ptyId) {
    return (
      <div className="nxw__state">
        <EmptyState
          icon="terminal"
          title="No live terminal"
          body={isLead
            ? 'The lead AI helper has no live terminal right now. Start it from the Agents page.'
            : 'This AI helper has no live terminal. Add an AI helper to get one.'}
        />
      </div>
    );
  }

  return (
    <div className="nxw__term">
      {isFullscreenedHere ? (
        <div className="nxw__state">
          <EmptyState
            icon="panel"
            title="Open in fullscreen"
            body="This terminal is open in fullscreen. Press Esc or exit fullscreen to bring it back here."
          />
        </div>
      ) : (
        <>
          <div className="nxw__xterm">
            <PtyTerminalView
              key={terminalInstanceKey(agent.ptyId, agent.terminalGeneration)}
              ptyId={agent.ptyId}
              onStreamData={onPtyStream}
              onUserPrompt={(t) => {
                updateAgent(agent.id, { lastPrompt: t });
                if (t.trim().toLowerCase() === '/clear') {
                  updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                }
                void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text: t });
              }}
              onToggleFullscreen={() => setFullscreen(fullscreen ? null : agent.id)}
              fullscreen={fullscreen}
              embedded={!fullscreen}
            />
          </div>
          <MessageQueueComposer agent={agent} />
        </>
      )}
    </div>
  );
}
