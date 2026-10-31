import { useCallback, useEffect, useRef, useState, type ReactNode, type PointerEvent as RPointerEvent } from 'react';
import { Icon } from '../icons';
import { useMedia } from '../ui/useMedia';
import { useNexusUi } from '../state/uiStore';
import { AgentPanel } from './AgentPanel';
import { clampDockWidth, DOCK_DEFAULT_WIDTH, DOCK_NARROW_QUERY, readDock, writeDock } from './dockModel';

/**
 * The AI helper, docked on the right of the project page like a chat side panel: a conversation with the request box pinned at its
 * bottom. Collapsible (the edge button, Ctrl+L), resizable by dragging its left edge (double-click resets), remembered in
 * localStorage, opening by itself when a request starts, needs you or ends with a reply. On a narrow window it is a drawer over
 * the page instead of squeezing the work area.
 */
export function AiDock({ projectId, workspaceId, reviewReady, onReview }: { projectId: string; workspaceId: string; reviewReady: number; onReview: () => void }): ReactNode {
  const narrow = useMedia(DOCK_NARROW_QUERY);
  const [state, setState] = useState(() => readDock(typeof window === 'undefined' ? null : window.localStorage));
  const [tone, setTone] = useState('ready');
  const [attention, setAttention] = useState(false);
  const [vw, setVw] = useState(() => window.innerWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const save = useCallback((next: { width: number; collapsed: boolean }) => { setState(next); writeDock(window.localStorage, next); }, []);
  useEffect(() => { const f = () => setVw(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  // A narrow window starts with the drawer closed; a wide one uses what was remembered.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const open = narrow ? drawerOpen : !state.collapsed;
  const toggle = useCallback(() => { if (narrow) setDrawerOpen((o) => !o); else save({ ...state, collapsed: !state.collapsed }); }, [narrow, state, save]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') { e.preventDefault(); toggle(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
  // Opens by itself when the AI helper needs a look (attention turns on), once per change.
  const wasAttention = useRef(false);
  useEffect(() => {
    if (attention && !wasAttention.current) { if (narrow) setDrawerOpen(true); else if (state.collapsed) save({ ...state, collapsed: false }); }
    wasAttention.current = attention;
  }, [attention]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Focus the request box" (the Home page's Start, the Ask buttons) also opens the dock if it was closed.
  const focusTick = useNexusUi((s) => s.intentFocusTick);
  const seenTick = useRef(focusTick);
  useEffect(() => {
    if (focusTick === seenTick.current) return;
    seenTick.current = focusTick;
    if (narrow) setDrawerOpen(true); else if (state.collapsed) save({ ...state, collapsed: false });
  }, [focusTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const width = clampDockWidth(state.width, vw);
  const onDown = (e: RPointerEvent<HTMLDivElement>) => { drag.current = { x: e.clientX, w: width }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => { if (drag.current) setState((s) => ({ ...s, width: clampDockWidth(drag.current!.w + (drag.current!.x - e.clientX), vw) })); };
  const onUp = () => { if (drag.current) { drag.current = null; writeDock(window.localStorage, { width: state.width, collapsed: state.collapsed }); } };
  const onResizeKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); save({ ...state, width: clampDockWidth(width + 24, vw) }); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); save({ ...state, width: clampDockWidth(width - 24, vw) }); }
  };
  return (
    <>
      {!open && (
        <div className="nx-dock-rail" role="complementary" aria-label="AI helper, closed">
          <button type="button" className="nx-dock-rail__btn" aria-label="Open the AI helper (Ctrl+L)" title="Open the AI helper (Ctrl+L)" onClick={toggle}>
            <Icon name="sparkles" size={18} />
            <span className="nx-dock-rail__dot" data-tone={tone} data-attention={attention ? 'true' : undefined} aria-hidden="true" />
          </button>
        </div>
      )}
      <aside className={`nx-dock${narrow ? ' nx-dock--drawer' : ''}`} data-open={open ? 'true' : 'false'} hidden={!open} style={narrow ? undefined : { width }} aria-label="AI helper">
        {!narrow && (
          <div className="nx-dock__edge" role="separator" aria-orientation="vertical" aria-label="Resize the AI helper (arrow keys; double-click resets)" aria-valuenow={width}
            tabIndex={0} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onKeyDown={onResizeKey} onDoubleClick={() => save({ ...state, width: DOCK_DEFAULT_WIDTH })} />
        )}
        <AgentPanel projectId={projectId} workspaceId={workspaceId} reviewReady={reviewReady} onReview={onReview} onClose={toggle}
          onDock={(s) => { setTone(s.tone); setAttention(s.attention); }} />
      </aside>
    </>
  );
}
