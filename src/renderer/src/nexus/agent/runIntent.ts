import { create } from 'zustand';

/**
 * "Run this": a message that is only a request to run what is there ("run", "run this", "try it", "run the tests", "please start it") is not work
 * for the AI helper: Nexus runs the project itself, in the safe space, from the Try it page. Pure matcher plus the small store the dock reads.
 *
 * Only the whole message counts: "run a migration that adds a column", "add a run button" and "run the tests and fix what fails" are work for the
 * AI helper and go to it as before.
 */

const OBJECTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  run: ['', 'this', 'it', 'that', 'the tests', 'the test', 'tests', 'the program', 'the app', 'the project', 'my project', 'my app', 'the code'],
  start: ['it', 'this', 'that', 'the program', 'the app', 'the project', 'my project', 'my app'],
  test: ['it', 'this', 'that', 'the program', 'the app', 'the project', 'my project', 'my app', 'the code'],
  try: ['it', 'this', 'that', 'the program', 'the app', 'the project', 'my project', 'my app']
});
const RUN_PHRASES: ReadonlySet<string> = new Set(Object.entries(OBJECTS).flatMap(([verb, objs]) => objs.map((o) => (o === '' ? verb : `${verb} ${o}`))));

/** The message in lower case, punctuation and extra spaces dropped, and a leading or trailing "please" removed. */
export function normalizeRunText(text: string): string {
  let t = String(text ?? '').toLowerCase().replace(/[.,!?;:"'`()[\]{}]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(please|pls|plz|ok|okay|now)\s+/, '').replace(/\s+(please|pls|plz|now)$/, '').trim();
  return t;
}

/** True when the whole message is a request to run, start, test or try what is there. */
export function isRunRequest(text: string): boolean {
  const t = normalizeRunText(text);
  return t.length > 0 && t.length <= 40 && RUN_PHRASES.has(t);
}

/** The words Nexus says itself (never as the AI helper's) when it takes a run request. */
export const RUN_REPLY_TEXT = 'That is a request to run it. Nexus can run it here for you, in the safe space, without the AI helper.';
export const RUN_REPLY_BUTTON = 'Try it';

interface RunReplyState {
  /** The project whose dock shows the reply; null when none. */
  projectId: string | null;
  show: (projectId: string) => void;
  clear: () => void;
}
export const useRunReply = create<RunReplyState>((set) => ({
  projectId: null,
  show: (projectId) => set({ projectId }),
  clear: () => set({ projectId: null })
}));
