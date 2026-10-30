// Pure: the project page's "Your first build" line. A brand-new project gets the three plain steps (get this computer ready, choose
// your AI helper, save a starting point) with one button that opens the setup sheet ("Get this computer ready"), the same sheet the
// rest of the page opens. It carries no state of its own: the sheet knows what is done, so this line never claims a step is done.
// It shows only where the AI helper can work (Software) and only until the project has any suggested changes.
import type { ArtifactSummaryView } from '@shared/nexus/ipc';
import { FIRST_BUILD_TITLE, STEP_TITLES } from '../data/firstBuildModel';
import { termName } from '../data/glossary';

export interface FirstBuildLine {
  title: string;
  lead: string;
  steps: { number: 1 | 2 | 3; title: string }[];
  /** The one button: opens the setup sheet. */
  button: string;
}

export const FIRST_BUILD_LEAD = 'Nexus needs these three things before your AI helper can build for you. The steps open in one place, and Nexus tells you what is done.';

/** The line for a project, or null when it should not show: not a place the AI helper works, still reading the saved items, or suggested changes already exist. */
export function firstBuildLine(i: { hasAiHelper: boolean; loaded: boolean; artifacts: readonly Pick<ArtifactSummaryView, 'artifact'>[] }): FirstBuildLine | null {
  if (!i.hasAiHelper || !i.loaded) return null;
  if (i.artifacts.some((s) => s.artifact.kind === 'change_set')) return null;
  return {
    title: FIRST_BUILD_TITLE,
    lead: FIRST_BUILD_LEAD,
    steps: [
      { number: 1, title: STEP_TITLES.computer },
      { number: 2, title: STEP_TITLES.helper },
      { number: 3, title: STEP_TITLES['starting-point'] }
    ],
    button: `Open “${termName('getReady')}”`
  };
}
