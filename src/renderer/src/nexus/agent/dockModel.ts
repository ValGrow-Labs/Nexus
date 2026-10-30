// The AI helper dock's size and remembered state: pure, so a test can run it.
export const DOCK_MIN_WIDTH = 320;
export const DOCK_DEFAULT_WIDTH = 420;
/** Below this window width the dock is a drawer over the page instead of a column beside the work area. */
export const DOCK_NARROW_BREAKPOINT = 1100;
export const DOCK_NARROW_QUERY = `(max-width: ${DOCK_NARROW_BREAKPOINT - 1}px)`;
export const DOCK_STORAGE_KEY = 'nexus.aiDock';

/** The dock is at least 320px and at most half the window. */
export function clampDockWidth(width: number, windowWidth: number): number {
  const max = Math.max(DOCK_MIN_WIDTH, Math.floor(windowWidth / 2));
  const w = Number.isFinite(width) ? Math.round(width) : DOCK_DEFAULT_WIDTH;
  return Math.min(Math.max(w, DOCK_MIN_WIDTH), max);
}

export interface DockState { width: number; collapsed: boolean }
type Store = Pick<Storage, 'getItem' | 'setItem'>;
export function readDock(store: Store | null): DockState {
  try {
    const raw = store ? store.getItem(DOCK_STORAGE_KEY) : null;
    const o = raw ? JSON.parse(raw) as Partial<DockState> : null;
    return { width: typeof o?.width === 'number' ? o.width : DOCK_DEFAULT_WIDTH, collapsed: o?.collapsed === true };
  } catch { return { width: DOCK_DEFAULT_WIDTH, collapsed: false }; }
}
export function writeDock(store: Store | null, s: DockState): void {
  try { store?.setItem(DOCK_STORAGE_KEY, JSON.stringify({ width: Math.round(s.width), collapsed: s.collapsed })); } catch { /* storage may be blocked: the dock still works */ }
}
