// plannedContent.ts
import type { NexusIconName } from '../iconNames';
export interface PlannedContent { title: string; icon: NexusIconName; what: string; fits: string; today: string; todayAction: 'files' | 'projects' | 'assistant' | 'agents' }
export const PLANNED: Record<'deployments', PlannedContent> = {
  deployments: {
    title: 'Publishing', icon: 'deployments',
    what: 'Build, run and publish what you made, see how it is doing, and go back to an earlier version if something goes wrong.',
    fits: 'Publishing is the last step: you do the work, save the result, hand it on, make an app, then publish it.',
    today: 'The AI helper can build and test your project in a safe space. You can also try your app on this computer.', todayAction: 'agents'
  }
};
