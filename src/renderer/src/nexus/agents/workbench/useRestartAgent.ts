import { useState } from 'react';
import { acquireTerminal, disposeTerminal, resetTerminal } from '@/components/terminalPool';
import { useStore, type Agent } from '@/store/store';
import { LEAD_HIVE_NAME, LEAD_HIVE_ROLE } from '@shared/agentDisplay';
import { normalizeAutoFlagCommand } from '@shared/autoModeFlag';
import {
  buildSpawnCommand,
  inferAgentProvider,
  providerPreset,
  tokenizeCommand,
  type AgentProvider
} from '@/store/config';

export interface RestartOptions {
  resume?: boolean;
  provider?: AgentProvider;
  /** Resume if we can, start fresh if we can't, instead of refusing. */
  resumeOptional?: boolean;
}

/** In-place agent restart (model switch, "Restart & continue", lead engine
 *  change). Moved verbatim from the retired lead panel's roster; only the
 *  enclosing hook is new. `restarting` is the agent id mid-restart. */
export function useRestartAgent(): {
  restarting: string | null;
  restartErrors: Record<string, string>;
  restartWithModel: (a: Agent, model: string | undefined, opts?: RestartOptions) => Promise<void>;
} {
  const updateAgent = useStore((s) => s.updateAgent);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [restartErrors, setRestartErrors] = useState<Record<string, string>>({});

  // Restart an agent's PTY in place. `resume:true` reattaches its prior Claude
  // conversation (`--resume <sessionId>`, resolved in the main process from the
  // hive registry by agent id) — this is "Restart & Continue": a clean re-draw
  // of the TUI in a fresh process WITHOUT losing the thread, which is the escape
  // hatch for a corrupted/garbled terminal (e.g. xterm reflow after dragging the
  // window between displays of different sizes). With `resume` unset it's the
  // old behavior: a model change that starts a fresh session.
  const restartWithModel = async (
    a: Agent,
    model: string | undefined,
    opts: {
      resume?: boolean;
      provider?: AgentProvider;
      /** Resume if we can, start fresh if we can't, instead of refusing.
       *  "Restart & Continue" wants the hard failure — continuing is the entire
       *  point, so silently starting a blank session would be worse than an
       *  error. A model change wants the soft one: the user asked to change
       *  model, and an agent with no recorded session still has to get one. */
      resumeOptional?: boolean;
    } = {}
  ) => {
    if (!a.ptyId) return;
    setRestarting(a.id);
    setRestartErrors((errors) => ({ ...errors, [a.id]: '' }));
    try {
      const cfg = await window.cth.getConfig();
      // Respawn on the same CLI this agent already runs on (inferred from its
      // command if not explicitly tagged) so an Antigravity/Codex worker stays
      // on its own binary. tokenizeCommand keeps quoted model labels one arg.
      // opts.provider overrides the inferred provider — used when changing GOD's engine.
      const previousProvider = inferAgentProvider(a.command, a.provider);
      const provider = opts.provider ?? previousProvider;
      let resume = opts.resume === true && provider === previousProvider;
      if (opts.resume && !resume && !opts.resumeOptional) {
        throw new Error('A conversation cannot move to a different program, so it cannot be continued there.');
      }
      let resumeSessionId: string | undefined;
      if (resume) {
        // A precondition miss is fatal for an explicit "continue", and merely
        // means "start fresh" for an opportunistic one (see resumeOptional).
        const giveUpOnResume = (reason: string) => {
          if (!opts.resumeOptional) throw new Error(reason);
          resume = false;
          resumeSessionId = undefined;
        };
        const registry = await window.cth.hiveRegistry();
        resumeSessionId = registry.agents[a.id]?.sessionId;
        if (!resumeSessionId) {
          giveUpOnResume('Nexus has no saved conversation for this AI helper, so it was left running as it is.');
        } else if (provider === 'claude' && !(await window.cth.resolveSessionCwd(resumeSessionId))) {
          giveUpOnResume('Nexus could not find the saved conversation, so the AI helper was left running as it is.');
        }
      }
      // Capture the live grid before replacing anything. Restart & Continue
      // recreates only this agent's xterm; model changes retain the old
      // in-place reset behavior.
      const oldEntry = acquireTerminal(a.ptyId);
      let cols = oldEntry.term.cols || 100;
      let rows = oldEntry.term.rows || 30;
      try {
        oldEntry.fit.fit();
        cols = oldEntry.term.cols;
        rows = oldEntry.term.rows;
      } catch { /* host not sized yet */ }

      const killed = await window.cth.killPty(a.ptyId);
      // A pty that is ALREADY gone is the state this kill was trying to reach, so
      // it is not a failure. This is the single most common way to arrive at
      // "Restart & Continue": the session died on its own — a crash, or Ctrl-C
      // twice — main dropped it from the session map, and kill then answers
      // `no pty: <id>`. Treating that as fatal aborted before the respawn and
      // turned the one situation the button exists for into a dead end.
      if (!killed.ok && !/^no pty:/.test(killed.error ?? '')) {
        throw new Error(killed.error ?? 'Nexus could not stop the AI helper to restart it.');
      }
      if (resume) {
        // A blank xterm can retain corrupt renderer/DOM/subscription state even
        // after its PTY is healthy. Throw that one terminal away, acquire its
        // replacement BEFORE spawning (so startup output has a listener), then
        // bump the key so React remounts only this agent's terminal card.
        disposeTerminal(a.ptyId);
        acquireTerminal(a.ptyId);
        updateAgent(a.id, {
          terminalGeneration: (a.terminalGeneration ?? 0) + 1,
          status: 'idle',
          action: 'recreating terminal…'
        });
      } else {
        resetTerminal(a.ptyId);
      }
      // The auto flag always follows the current auto mode (finding 1).
      const command = normalizeAutoFlagCommand(buildSpawnCommand(cfg, model, provider), cfg.autoMode === true, provider);
      const [exe, ...args] = tokenizeCommand(command.trim());
      const hive = a.isGod
        ? { id: a.id, name: LEAD_HIVE_NAME, cwd: a.cwd, provider, isGod: true, role: LEAD_HIVE_ROLE }
        : a.isAssistant
        ? { id: a.id, name: a.name, cwd: a.cwd, provider, isAssistant: true, role: "Lead agent's prep assistant" }
        : { id: a.id, name: a.name, cwd: a.cwd, provider, role: a.description };
      const res = await window.cth.spawnPty({
        id: a.ptyId,
        cwd: a.cwd,
        command: exe,
        args,
        provider,
        cols,
        rows,
        hive,
        resume,
        resumeSessionId,
        requireResume: resume
      });
      if (!res.ok) throw new Error(res.error ?? 'The restart did not work.');
      if (resume && res.resumed !== true) {
        throw new Error('The AI helper did not accept its old conversation, so it could not continue it.');
      }
      if (res.ok) {
        // Record the model even on a resume. A same-provider model change now
        // RESUMES the session (that is the point — you keep the conversation and
        // just swap the model), so "resume ⇒ the model is unchanged" stopped
        // being true. Skipping the patch left the live process on the new model
        // while the selector and the persisted agent kept the old one, and the
        // next restore relaunched the old command. `command` is rebuilt from the
        // selected model above, so on a genuine no-change restart this is a no-op.
        const patch = resume
          ? {
              command: command.trim(),
              provider,
              model,
              status: 'idle' as const,
              action: 'continuing…'
            }
          : {
              command: command.trim(),
              provider,
              model,
              status: 'idle' as const,
              action: provider === previousProvider ? 'restarting…' : `switching to ${providerPreset(provider).label}…`
            };
        updateAgent(a.id, patch);
      }
    } catch (error) {
      setRestartErrors((errors) => ({
        ...errors,
        [a.id]: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setRestarting(null);
    }
  };

  return { restarting, restartErrors, restartWithModel };
}
