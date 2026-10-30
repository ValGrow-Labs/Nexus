import { useEffect, useRef, useState } from 'react';
import type { HarnessConfig } from '@/store/config';
import { CommandPalette } from './chrome/CommandPalette';
import { useShortcuts } from './chrome/useShortcuts';
import { ShellActionsContext, type ShellActions } from './shellActions';
import { ContextBar } from './chrome/ContextBar';
import { MobileTabs } from './chrome/MobileTabs';
import { RouteView } from './routes/RouteView';
import { useProjectsLoader } from './data/useProjects';
import { useParticipations } from './data/useParticipations';
import { IntentLine } from './intent/IntentLine';
import { useRoute } from './router/useRoute';
import { formatRoute } from './router/routes';
import { useNexusUi } from './state/uiStore';

/** The intent line docks on workspace and project routes. Elsewhere it appears
 *  only when summoned (Ctrl/Cmd+J or an "Ask the lead agent" button), for the
 *  route it was summoned on, until closed. */
function IntentSlot() {
  const route = useRoute();
  const key = formatRoute(route);
  const tick = useNexusUi((s) => s.intentFocusTick);
  const lastTick = useRef(tick);
  const [summonedOn, setSummonedOn] = useState<string | null>(null);
  useEffect(() => {
    if (tick !== lastTick.current) { lastTick.current = tick; setSummonedOn(key); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  // A summoned line belongs to the route it was summoned on; leaving clears it.
  useEffect(() => { setSummonedOn((cur) => (cur === key ? cur : null)); }, [key]);
  // The project page asks inside its own next-step box (inline), so only the workspace page docks the line.
  const docked = route.name === 'workspace';
  if (docked) return <IntentLine key="docked" />;
  if (summonedOn === key) return <IntentLine key={`summoned:${key}`} summoned onClose={() => setSummonedOn(null)} />;
  return null;
}

export function NexusShell({ config, actions }: { config: HarnessConfig; actions: ShellActions }) {
  useProjectsLoader();
  useParticipations();
  useShortcuts();
  return (
    <ShellActionsContext.Provider value={actions}>
      <div className="nx-shell">
        <a className="nx-skip" href="#nx-main" onClick={(e) => { e.preventDefault(); document.getElementById('nx-main')?.focus(); }}>Skip to content</a>
        <ContextBar />
        <RouteView config={config} />
        <IntentSlot />
        <MobileTabs />
        <CommandPalette />
      </div>
    </ShellActionsContext.Provider>
  );
}
