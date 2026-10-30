// When the legacy lead agent (the vendor-CLI terminal agent of the old hive) may be started. Pure, shared by main (config validation)
// and the renderer (the boot effect, the wizard's finish, the Start button), so one decision is tested once.
//
// The rule: nothing starts by itself on a new install. The lead agent starts only when the person asked for it:
//   - the setup wizard recorded the choice `leadAutoStart: true` (they picked an engine in the engine step), or
//   - they pressed the Start button during this session (`requested`), or
//   - the install pre-dates this setting (`leadAutoStart` was never written) and was already set up: it keeps working as before.
// The wizard always writes the setting, so a new install never falls under the third case.

export interface LeadStartConfig {
  onboardingComplete?: boolean;
  harnessHome?: string | null;
  /** True: start the lead agent each time the app opens. False: only on the Start button. Absent: an install from before this setting. */
  leadAutoStart?: boolean;
}

/** The persisted value is a boolean or nothing; anything else is not trusted. */
export function isLeadAutoStart(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** True when the lead agent may be started now. `requested` is the person pressing Start during this session. */
export function leadMayStart(config: LeadStartConfig | null | undefined, requested: boolean): boolean {
  if (!config || config.onboardingComplete !== true) return false;
  if (typeof config.harnessHome !== 'string' || config.harnessHome === '') return false;
  if (requested) return true;
  // Only an explicit `true` starts it on its own; `false` never; an absent value is an existing install and keeps its old behaviour.
  return config.leadAutoStart === undefined ? true : config.leadAutoStart === true;
}

/** What the wizard writes when it finishes: the person's engine-step choice. The default choice ("not now") starts nothing. */
export type WizardLeadChoice = 'later' | 'engine';
export function wizardLeadConfig(choice: WizardLeadChoice): { leadAutoStart: boolean } {
  return { leadAutoStart: choice === 'engine' };
}
