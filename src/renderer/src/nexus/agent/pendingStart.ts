import { create } from 'zustand';

/** How long a request waits for its project to get ready before it is given up (the words stay in the request box either way). */
export const PENDING_START_MAX_MS = 60 * 60 * 1000;

export interface PendingStart { projectId: string; text: string; at: number }

interface PendingStartState {
  /** A request the Home page's Start has handed over and that is not sent yet (the project is not ready, or the page is still opening). */
  pending: PendingStart | null;
  /** The project a handed-over request is being sent for right now (the sending is under way). */
  sending: { projectId: string; text: string } | null;
  /** The last handed-over request that could not start: its words and the sentence why. */
  failed: { projectId: string; text: string; error: string } | null;
  hand: (projectId: string, text: string) => void;
  /** Takes the pending request out for sending: afterwards it is not pending, so it is never sent twice. */
  begin: () => PendingStart | null;
  finish: (error: string | null) => void;
  drop: () => void;
  clearFailed: () => void;
}

export const usePendingStart = create<PendingStartState>((set, get) => ({
  pending: null,
  sending: null,
  failed: null,
  hand: (projectId, text) => set({ pending: { projectId, text: text.trim(), at: Date.now() }, failed: null }),
  begin: () => {
    const p = get().pending;
    if (!p || get().sending) return null;
    set({ pending: null, sending: { projectId: p.projectId, text: p.text }, failed: null });
    return p;
  },
  finish: (error) => {
    const s = get().sending;
    set({ sending: null, failed: s && error ? { projectId: s.projectId, text: s.text, error } : null });
  },
  drop: () => set({ pending: null }),
  clearFailed: () => set({ failed: null })
}));

/**
 * What to do with a handed-over request on a project page: `send` when this project's AI helper can take it now and the request box
 * still holds exactly those words; `drop` when the words were changed or cleared (the person took over) or it waited too long;
 * `wait` otherwise (setup is still in the way, or this is another project's page).
 */
export function pendingAction(i: { pending: PendingStart | null; projectId: string; ready: boolean; draft: string; now: number }): 'send' | 'drop' | 'wait' {
  const p = i.pending;
  if (!p || p.projectId !== i.projectId) return 'wait';
  if (i.draft.trim() !== p.text || i.now - p.at > PENDING_START_MAX_MS) return 'drop';
  return i.ready ? 'send' : 'wait';
}
