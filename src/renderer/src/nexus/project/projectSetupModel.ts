// What a project still needs before the AI helper can work in it, as ONE plain card (never a dead end). Pure.
export type SetupCard =
  | { kind: 'workspace'; title: string; text: string; button: string }
  | { kind: 'git'; title: string; text: string; button: string };

/**
 * The AI helper works in Software projects, in a folder that tracks its changes (git). A project that is not in Software yet gets the first
 * card (nothing is re-filed silently: the button adds it to Software and the project stays where it is), a folder that is not a repository
 * the second ("Set it up"). Null when neither is missing; unknown git state (still reading) shows nothing yet.
 */
export function setupCard(i: { inSoftware: boolean; git: 'loading' | 'error' | 'ready'; isRepo: boolean }): SetupCard | null {
  if (!i.inSoftware) {
    return { kind: 'workspace', title: 'The AI helper works in Software projects', text: 'Add this project to Software and the AI helper can work in it. The project stays where it is.', button: 'Add to Software' };
  }
  if (i.git === 'ready' && !i.isRepo) {
    return { kind: 'git', title: 'Start tracking changes in this folder', text: 'Nexus sets up Git here so it can keep track of changes. Your files are not changed.', button: 'Set it up' };
  }
  return null;
}

/** The plain reasons a setup step did not work (never git's own text). */
export const SETUP_FAIL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  already_a_repository: 'This folder already tracks changes. Press “Look at the project again”.',
  git_missing: 'Git is not installed on this computer. Install it, then try again.',
  is_link: 'This folder is a link, so Nexus will not set it up. Choose the real folder.',
  not_a_folder: 'This folder could not be found.',
  unknown_project: 'This project could not be found.'
});
export const setupFailText = (reason: string): string => SETUP_FAIL_TEXT[reason] ?? 'It did not work. Try again.';
