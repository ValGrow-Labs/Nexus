import { create } from 'zustand';
import { browserStorage, readPref, writePref } from './prefs';
import type { Selection } from '../intent/intentContext';
import { DEFAULT_HANDOFF_VIEW, type HandoffView } from '../handoffs/handoffModel';

export type Audience = 'nontechnical' | 'technical';
const readAudience = (v: string | null): Audience | null => (v === 'nontechnical' || v === 'technical' ? v : null);

export type SentRequest = { id: string; agentId: string; queuedMessageId: string; text: string; projectId: string | null; selectionLabel: string | null; sentAt: number };

interface NexusUi {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  railExpanded: boolean;
  setRailExpanded: (b: boolean) => void;
  lastWorkspace: string | null;
  setLastWorkspace: (id: string) => void;
  lastProject: string | null;
  setLastProject: (id: string) => void;
  setupDismissed: boolean;
  /** Whether the Welcome intro has been passed this session (not persisted): every launch starts on Welcome. */
  /** Whether the launch intro's Get started has been pressed this session (not persisted). */
  introSeen: boolean;
  seeIntro: () => void;
  welcomed: boolean;
  finishWelcome: () => void;
  /** The answer to Welcome's "Which sounds like you?" (persisted); null until answered. */
  audience: Audience | null;
  setAudience: (a: Audience) => void;
  dismissSetup: () => void;
  draft: string;
  /** A request carried over to Start (from Welcome); Start takes it once (not persisted). */
  startPrefill: string | null;
  setStartPrefill: (s: string | null) => void;
  setDraft: (s: string) => void;
  /** Requests sent from the intent line this session (not persisted). */
  requests: SentRequest[];
  addRequest: (r: SentRequest) => void;
  /** Bumped to ask the intent line to take focus (Ctrl/Cmd+J, "Ask" buttons). */
  intentFocusTick: number;
  focusIntent: () => void;
  /** Bumped to open the Agents page's Semantic memory panel (palette entry). */
  memoryTick: number;
  openSemanticMemory: () => void;
  /** What the user has selected on the current surface (not persisted). */
  selection: Selection | null;
  setSelection: (s: Selection | null) => void;
  /** The Handoffs page's box, workspace and status (not persisted): kept across list and detail, and set by
   *  the send sheet so a sent handoff opens on the sending side. */
  handoffView: HandoffView;
  setHandoffView: (v: HandoffView) => void;
}

const storage = browserStorage();

export const useNexusUi = create<NexusUi>((set) => ({
  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  railExpanded: false,
  setRailExpanded: (b) => set({ railExpanded: b }),
  lastWorkspace: readPref(storage, 'lastWorkspace'),
  setLastWorkspace: (id) => { writePref(storage, 'lastWorkspace', id); set({ lastWorkspace: id }); },
  lastProject: readPref(storage, 'lastProject'),
  setLastProject: (id) => { writePref(storage, 'lastProject', id); set({ lastProject: id }); },
  setupDismissed: readPref(storage, 'setupDismissed') === '1',
  dismissSetup: () => { writePref(storage, 'setupDismissed', '1'); set({ setupDismissed: true }); },
  introSeen: false,
  seeIntro: () => set({ introSeen: true }),
  // Kept between launches: once Welcome is finished, later launches go straight to Start instead of asking the same questions again.
  welcomed: readPref(storage, 'welcomed') === '1',
  finishWelcome: () => { writePref(storage, 'welcomed', '1'); set({ welcomed: true }); },
  audience: readAudience(readPref(storage, 'audience')),
  setAudience: (a) => { writePref(storage, 'audience', a); set({ audience: a }); },
  draft: '',
  startPrefill: null,
  setStartPrefill: (s) => set({ startPrefill: s }),
  setDraft: (s) => set({ draft: s }),
  requests: [],
  addRequest: (r) => set((s) => ({ requests: [...s.requests, r] })),
  intentFocusTick: 0,
  focusIntent: () => set((s) => ({ intentFocusTick: s.intentFocusTick + 1 })),
  memoryTick: 0,
  openSemanticMemory: () => set((s) => ({ memoryTick: s.memoryTick + 1 })),
  selection: null,
  setSelection: (s) => set({ selection: s }),
  handoffView: DEFAULT_HANDOFF_VIEW,
  setHandoffView: (v) => set({ handoffView: v })
}));
