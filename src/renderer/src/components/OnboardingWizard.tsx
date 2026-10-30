import { useEffect, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon, type IconName } from './Icon';
import { ProviderLogo } from './ProviderLogo';
import { AGENT_PROVIDER_PRESETS, modelsForProvider, type AgentProvider, type HarnessConfig } from '@/store/config';
import { canReceiveInbox, providerPreset } from '@shared/agentProvider';
import { wizardLeadConfig, type WizardLeadChoice } from '@shared/leadStart';
import { termHelp, termName } from '@/nexus/data/glossary';

export interface OnboardingWizardProps {
  onComplete: (config: HarnessConfig) => void;
}

type Step = 'welcome' | 'home' | 'orchestrator' | 'repos' | 'permissions' | 'done';

// First-run showcase: the highest-value features a brand-new user should grasp before any setup. One register, in plain words for a
// reader with no developer background (the old "technical" copy was never shown: Nexus's Welcome page asks who you are, not this wizard).
interface Feature {
  icon: IconName;
  label: string;
  desc: string;
  tint: string;       // tile background token
  edge: string;       // tile border token
}
const FEATURES: Feature[] = [
  {
    icon: 'mcp',
    label: 'AI FOR EVERY BUDGET',
    desc: 'Use a free online AI, an AI on this computer, or a plan you already have. Several AI helpers can work side by side.',
    tint: 'var(--cth-lilac-light)', edge: 'var(--cth-lilac)'
  },
  {
    icon: 'gear',
    label: 'A LEAD AI HELPER COORDINATES',
    desc: 'The lead AI helper takes your requests, gives the work to the right AI helper, and only interrupts you when it matters.',
    tint: 'var(--cth-sky-light)', edge: 'var(--cth-sky)'
  },
  {
    icon: 'web',
    label: 'AI HELPERS REMEMBER',
    desc: 'AI helpers remember what they did, so they do not start from zero each time.',
    tint: 'var(--cth-mint-light)', edge: 'var(--cth-mint)'
  },
  {
    icon: 'terminal',
    label: 'ONE PLACE TO WATCH THE WORK',
    desc: 'See what each AI helper is doing, what is waiting for you, and what each one remembers.',
    tint: 'var(--cth-lemon-light)', edge: 'var(--cth-lemon)'
  },
  {
    icon: 'pause',
    label: 'YOU STAY IN CHARGE',
    desc: 'Spending limits and safety stops keep AI helpers in check. They can ask you before big actions.',
    tint: 'var(--cth-coral-light)', edge: 'var(--cth-coral)'
  },
  {
    icon: 'sparkle',
    label: 'READY-MADE AI HELPERS',
    desc: 'Add a ready-made AI helper from the gallery in one click. No setup needed.',
    tint: 'var(--cth-peach-light)', edge: 'var(--cth-peach)'
  }
];

// One line of what each helper program is, shown under its row on the lead AI helper step, so a person knows what they are picking.
const PROVIDER_BLURB: Partial<Record<AgentProvider, string>> = {
  claude: 'Claude Code, from Anthropic. It uses your own Claude plan.',
  codex: 'Codex, from OpenAI. It uses your own OpenAI plan.',
  antigravity: 'Antigravity, from Google (it uses Gemini). It uses your own Google plan.',
  qwen: 'Qwen. It runs a Qwen model on this computer.'
};

// The three ways to get AI, free ones first (the same names as everywhere else in Nexus).
const AI_WAYS: ReadonlyArray<{ name: string; help: string }> = [
  { name: termName('freeOnlineAi'), help: termHelp('freeOnlineAi') },
  { name: termName('aiOnThisComputer'), help: termHelp('aiOnThisComputer') },
  { name: termName('yourOwnPlan'), help: termHelp('yourOwnPlan') }
];

// The battery tip only makes sense on a Mac.
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  // The wizard does not ask "which sounds like you?": Nexus's own Welcome page asks it (once). The first screen is "meet Nexus".
  const [step, setStep] = useState<Step>('welcome');

  const [home, setHome] = useState<string>('');
  const [repos, setRepos] = useState<string[]>([]);
  // O.9 #10: auto mode starts off; onboarding is where the user may opt in.
  const [autoMode, setAutoMode] = useState<boolean>(false);
  // Anonymous usage stats (TELEMETRY.md). Default ON (opt-out); persisted by
  // finish() so unchecking before finishing means nothing is ever sent.
  const [shareStats, setShareStats] = useState<boolean>(true);
  // The engine step's first-run default is "not now": nothing is started when setup finishes. An engine is started only when the
  // person picks one here (the pick is the consent). The provider kept below is only the engine a later explicit Start uses.
  const [leadChoice, setLeadChoice] = useState<WizardLeadChoice>('later');
  const [godProvider, setGodProvider] = useState<AgentProvider>('claude');
  const [godModel, setGodModel] = useState<string | undefined>(
    providerPreset('claude').recommendedOrchestratorModel
  );
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Permissions & reliability toggles. These apply IMMEDIATELY on change (their
  // own IPC / OS state) — they are NOT part of finish()'s config write. First-run
  // defaults: notifications off (config default), login-item off (fresh install);
  // each reconciles to the real state the IPC returns.
  const [strongKeepalive, setStrongKeepalive] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [openAtLogin, setOpenAtLogin] = useState(false);

  const toggleStrongKeepalive = async (v: boolean) => {
    setStrongKeepalive(v); // optimistic
    try { setStrongKeepalive((await window.cth.updateConfig({ strongKeepalive: v })).strongKeepalive === true); }
    catch { setStrongKeepalive(!v); }
  };
  const toggleNotifications = async (v: boolean) => {
    setNotifications(v); // optimistic
    try { await window.cth.setNotifications(v); }
    catch { setNotifications(!v); } // revert on failure
  };
  const toggleOpenAtLogin = async (v: boolean) => {
    setOpenAtLogin(v); // optimistic
    try { setOpenAtLogin(await window.cth.setLoginItem(v)); } // reconcile to OS truth
    catch { setOpenAtLogin(!v); }
  };
  const openSettings = (url: string) => { void window.cth.openExternal(url); };

  // Default-suggest a sensible home folder on first render.
  //
  // This used to read `window.process.env.HOME`, which is ALWAYS undefined here:
  // the window runs with `contextIsolation: true` / `nodeIntegration: false` and
  // the preload bridges exactly one object (`cth`), so the renderer's main world
  // has no `process`. The suggestion therefore always collapsed to '' and the
  // field rendered empty — leaving the copy above promising a default the user
  // could not accept, and Finish failing with "Pick a harness home folder first."
  //
  // Suggest the literal `~/Nexus` instead. That is exactly the kind of string
  // #140's normalizeHiveHome()/expandTilde() were built to absorb: it is expanded
  // at the config-write boundary AND at ensureHarnessHome's mkdir, so every
  // downstream reader still sees one absolute path. No new IPC surface.
  useEffect(() => {
    if (!home) setHome('~/Nexus');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickHome = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setHome(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  const pickRepo = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok && !repos.includes(res.path)) setRepos([...repos, res.path]);
    else if (!res.ok && res.error !== 'cancelled') setError(res.error);
  };

  const removeRepo = (path: string) => setRepos(repos.filter(r => r !== path));

  const finish = async () => {
    setBusy(true);
    setError(undefined);
    const harnessHome = home.trim(); // whitespace-only is not a folder
    if (!harnessHome) { setError('Pick a folder for Nexus first.'); setBusy(false); setStep('home'); return; }
    const ensure = await window.cth.ensureHarnessHome(harnessHome);
    if (!ensure.ok) {
      setError(ensure.error ?? 'Nexus could not create that folder.');
      setBusy(false);
      return;
    }
    const next = await window.cth.updateConfig({
      onboardingComplete: true,
      audience: 'technical',
      harnessHome, // the same trimmed value we just mkdir'd, not the raw field
      registeredRepos: repos,
      autoMode,
      godProvider,
      godModel,
      // Written every time, so a new install never falls under the "install from before this choice" rule that starts the lead agent.
      ...wizardLeadConfig(leadChoice),
      telemetryEnabled: shareStats
    });
    setBusy(false);
    onComplete(next);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-200)',
      backgroundImage:
        `repeating-linear-gradient(45deg, rgba(232, 217, 160, 0.4) 0 1px, transparent 1px 8px)`,
      // Scroll the overlay rather than clip the wizard. Step 2 lists every
      // installed CLI engine (8 rows + a model select), which is taller than a
      // 1080p-class window once the OS chrome is subtracted — the panel was
      // being cut off at BOTH edges with no way to reach the buttons.
      display: 'flex',
      overflowY: 'auto',
      zIndex: 200,
      padding: 32
    }}>
      {/* `margin: auto` centers, NOT `align-items: center`. A centered flex item
          that overflows its container is clipped at the TOP and unreachable by
          scrolling (the overflow spills past the scroll origin); auto margins
          center while it fits and collapse to a normal scroll once it doesn't. */}
      <div style={{ width: 640, maxWidth: '94vw', margin: 'auto' }}>
        <PixelPanel
          variant="dialog"
          title={
            step === 'welcome' ? 'MEET NEXUS'
            : step === 'home' ? 'STEP 1 OF 4 · A FOLDER FOR NEXUS'
            : step === 'orchestrator' ? 'STEP 2 OF 4 · YOUR AI HELPERS'
            : step === 'repos' ? 'STEP 3 OF 4 · YOUR PROJECTS'
            : step === 'permissions' ? 'STEP 4 OF 4 · SAFETY AND KEEPING WORK GOING'
            : 'ALL SET'
          }
          noPadding
        >
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

            {step === 'welcome' && (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div>
                    <div style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 12, lineHeight: '18px'
                    }}>NEXUS LETS AI HELPERS BUILD FOR YOU</div>
                    <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
                      You stay in charge and watch it all from one screen. Everything runs on this computer, except the AI service you choose to use. Here is what is inside:
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {FEATURES.map((f) => (
                    <div key={f.label} style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                      padding: 10,
                      background: f.tint,
                      boxShadow: `inset 0 0 0 2px ${f.edge}`
                    }}>
                      <div style={{
                        width: 28, height: 28, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'var(--cth-paper-100)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                      }}>
                        <Icon name={f.icon} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)',
                          fontSize: 10, lineHeight: '14px', marginBottom: 3
                        }}>{f.label}</div>
                        <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                          {f.desc}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {step === 'home' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  Nexus needs one folder where it keeps its own notes: its settings and what your AI helpers remember.
                  You can keep the folder suggested here, or pick another one. Something like{' '}
                  <code style={{ fontFamily: 'var(--cth-font-mono)', background: 'var(--cth-paper-100)', padding: '0 4px' }}>
                    ~/Nexus
                  </code>{' '}
                  works well. Nexus makes the folder for you if it does not exist yet.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={home}
                    onChange={(e) => setHome(e.target.value)}
                    placeholder="/path/to/Nexus"
                    aria-label="Folder for Nexus"
                    style={inputStyle}
                  />
                  <PixelButton variant="secondary" size="md" onClick={pickHome}>
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <Icon name="folder" /> choose a folder
                    </span>
                  </PixelButton>
                </div>
                <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                  You will not need to open this folder day to day. It is only where Nexus keeps its notes, so nothing is lost when you restart.
                </div>
              </>
            )}

            {step === 'orchestrator' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  <strong>The lead AI helper is optional.</strong> It reads your requests, splits them into tasks and passes them to
                  other AI helpers. You do not need it to build in a project. Building in a project works with any of the three kinds
                  of AI below, and you choose one later under “Get this computer ready”.
                </p>

                {/* The three ways to get AI, free first. */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
                  <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                    THREE WAYS TO GET AI, FREE ONES FIRST
                  </div>
                  <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {AI_WAYS.map((w) => (
                      <li key={w.name}><strong>{w.name}.</strong> {w.help}</li>
                    ))}
                  </ol>
                </div>

                <div style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start', padding: 10,
                  background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)'
                }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="sparkle" /></span>
                  <span>
                    <strong>Nothing starts until you say so.</strong> “Not now” is the safe choice and it costs nothing. The other
                    choices start the lead AI helper with a plan you already have. That helper program must already be installed and
                    signed in on this computer. Nexus never installs it and never signs in for you. If you pick one, it starts when setup
                    finishes. You can also start it later from Agents, or change it in Settings.
                  </span>
                </div>

                <div role="radiogroup" aria-label="Start the lead AI helper" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px',
                    background: leadChoice === 'later' ? 'var(--cth-mint-light)' : 'var(--cth-paper-100)',
                    boxShadow: `inset 0 0 0 ${leadChoice === 'later' ? 2 : 1}px ${leadChoice === 'later' ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`,
                    cursor: 'pointer'
                  }}>
                    <input
                      type="radio"
                      name="godProvider"
                      value="none"
                      checked={leadChoice === 'later'}
                      onChange={() => setLeadChoice('later')}
                      style={{ width: 16, height: 16, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontFamily: 'var(--cth-font-display)', fontSize: 11 }}>
                        NOT NOW
                      </span>
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                        Do not start a lead AI helper now. You can start one later from Agents.
                      </span>
                    </span>
                    <span style={{
                      fontSize: 10, padding: '1px 5px', lineHeight: '16px',
                      background: 'var(--cth-lemon)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      fontFamily: 'var(--cth-font-display)', flexShrink: 0
                    }}>DEFAULT</span>
                  </label>
                  {AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id)).map((p) => {
                    const sel = leadChoice === 'engine' && godProvider === p.id;
                    return (
                      <label key={p.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 10px',
                        background: sel ? 'var(--cth-mint-light)' : 'var(--cth-paper-100)',
                        boxShadow: `inset 0 0 0 ${sel ? 2 : 1}px ${sel ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`,
                        cursor: 'pointer'
                      }}>
                        <input
                          type="radio"
                          name="godProvider"
                          value={p.id}
                          checked={sel}
                          onChange={() => {
                            setLeadChoice('engine');
                            setGodProvider(p.id);
                            // Reset the model to the new provider's recommended pick so the
                            // dropdown below always shows a valid model for the chosen engine.
                            setGodModel(p.recommendedOrchestratorModel);
                          }}
                          style={{ width: 16, height: 16, flexShrink: 0 }}
                        />
                        <span style={{
                          width: 22, height: 22, flexShrink: 0, display: 'flex',
                          alignItems: 'center', justifyContent: 'center', color: 'var(--cth-ink-900)'
                        }}>
                          <ProviderLogo provider={p.id} size={18} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontFamily: 'var(--cth-font-display)', fontSize: 11 }}>
                            {p.label.toUpperCase()}
                          </span>
                          {PROVIDER_BLURB[p.id] && (
                            <span style={{ display: 'block', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                              {PROVIDER_BLURB[p.id]}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {leadChoice === 'engine' && <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>Which model should the lead AI helper use?</div>
                  <select
                    value={godModel ?? ''}
                    onChange={(e) => setGodModel(e.target.value || undefined)}
                    style={inputStyle}
                  >
                    {modelsForProvider(godProvider).map((m) => (
                      <option key={m.label} value={m.id ?? ''}>{m.label}</option>
                    ))}
                  </select>
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                    This only sets the lead AI helper. Other AI helpers can use other AI services later.
                  </div>
                </div>}
              </>
            )}

            {step === 'repos' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  Add your <strong>projects</strong>. A project is simply a folder. It can hold code, documents, notes, or any files you
                  want your AI helpers to work with. You can pick a folder you already have, and add more at any time.
                </p>
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 6,
                  maxHeight: 200, overflowY: 'auto'
                }}>
                  {repos.length === 0 && (
                    <div style={{
                      padding: 12,
                      fontSize: 13,
                      color: 'var(--cth-ink-500)',
                      background: 'var(--cth-paper-200)',
                      textAlign: 'center'
                    }}>
                      No projects added yet. This step is optional. You can add one later.
                    </div>
                  )}
                  {repos.map((r) => (
                    <div key={r} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px',
                      background: 'var(--cth-paper-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                    }}>
                      <Icon name="folder" />
                      <span style={{
                        flex: 1,
                        fontFamily: 'var(--cth-font-mono)', fontSize: 13,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                      }}>{r}</span>
                      <PixelButton variant="ghost" size="sm" onClick={() => removeRepo(r)}>
                        <Icon name="x" />
                      </PixelButton>
                    </div>
                  ))}
                </div>
                <PixelButton variant="secondary" size="md" onClick={pickRepo}>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <Icon name="plus" /> add a project
                  </span>
                </PixelButton>
              </>
            )}

            {step === 'permissions' && (
              <>
                {/* AUTONOMY: one choice. On, each helper program skips its own ask-first questions; off, each asks first (the default). */}
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                  HOW MUCH MAY AI HELPERS DO ON THEIR OWN?
                </div>
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: 12,
                  background: autoMode ? 'var(--cth-mint-light)' : 'var(--cth-cream-200)',
                  boxShadow: `inset 0 0 0 2px ${autoMode ? 'var(--cth-mint)' : 'var(--cth-ink-500)'}`,
                  cursor: 'pointer'
                }}>
                  <input
                    type="checkbox"
                    checked={autoMode}
                    onChange={(e) => setAutoMode(e.target.checked)}
                    style={{ width: 18, height: 18, flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px' }}>
                      LET AI HELPERS WORK WITHOUT ASKING
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--cth-ink-700)' }}>
                      {autoMode
                        ? 'On. AI helpers change your files and run commands without asking you first. It is faster, but a mistake is not caught before it happens.'
                        : 'Off (the safe choice). AI helpers stop and ask you before they change your files or run commands.'}
                    </div>
                  </div>
                </label>
                <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                  Off is the default. Turn it on only for projects you can afford to break, such as a copy or a test folder. You can change
                  it later in Settings, and for one AI helper at a time when you add it.
                </div>

                <div style={{ height: 1, background: 'var(--cth-ink-300)', margin: '2px 0' }} />

                {/* RELIABILITY — keeping work firing while you're away. */}
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                  KEEP WORK GOING WHILE YOU ARE AWAY
                </div>
                <p style={{ margin: 0, lineHeight: '20px', fontSize: 12, color: 'var(--cth-ink-700)' }}>
                  AI helpers can keep working on a schedule while you step away. If your computer goes to sleep, the work waits and
                  catches up when you are back. Nothing is lost, it may just run late. These switches are all optional.
                </p>

                <ToggleRow
                  icon="clock"
                  label="KEEP THIS COMPUTER AWAKE"
                  desc="Stops this computer from going to sleep while an AI helper is running, so scheduled work starts on time. It uses more battery, so it works best when plugged in. Off by default."
                  on={strongKeepalive}
                  tint="var(--cth-mint-light)"
                  edge="var(--cth-mint)"
                  onChange={toggleStrongKeepalive}
                />

                <ToggleRow
                  icon="bell"
                  label="DESKTOP NOTIFICATIONS"
                  desc="Shows a message when an AI helper needs you, even while you are away. Your computer may ask for your permission the first time."
                  on={notifications}
                  tint="var(--cth-peach-light)"
                  edge="var(--cth-peach)"
                  onChange={toggleNotifications}
                />

                <ToggleRow
                  icon="play"
                  label="OPEN AT LOGIN"
                  desc="Opens Nexus again after you restart or sign in to your computer, so scheduled work carries on by itself. It takes effect right away."
                  on={openAtLogin}
                  tint="var(--cth-sky-light)"
                  edge="var(--cth-sky)"
                  onChange={toggleOpenAtLogin}
                />

                <ToggleRow
                  icon="info"
                  label="SHARE ANONYMOUS USAGE STATS"
                  desc="Sends a few anonymous counts, such as “the app was opened”, to help improve Nexus. It never sends your requests, your code, your file names, or what an AI helper wrote. The full list is in TELEMETRY.md. You can change this at any time in Settings."
                  on={shareStats}
                  tint="var(--cth-lemon-light)"
                  edge="var(--cth-lemon)"
                  onChange={() => setShareStats(!shareStats)}
                />

                {/* Instruction only, and only on a Mac: macOS will not let the app flip this setting, so we open the pane. */}
                {IS_MAC && <div style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
                  background: 'var(--cth-lemon-light)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}>
                  <span style={{
                    width: 28, height: 28, flexShrink: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                  }}>
                    <Icon name="gear" />
                  </span>
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', marginBottom: 3 }}>
                        STAY AWAKE WHEN PLUGGED IN (YOU SET THIS)
                      </div>
                      <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                        Your Mac only lets you change this one yourself. Open Battery settings, go to Options, and turn on
                        “Prevent automatic sleeping when the display is off” for when it is plugged in. Then scheduled work keeps
                        running with the screen off. Without it, your Mac may fall asleep, and the work catches up when it wakes.
                      </div>
                    </div>
                    <PixelButton variant="secondary" size="sm"
                      onClick={() => openSettings('x-apple.systempreferences:com.apple.preference.battery')}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="arrow-right" /> open Battery settings
                      </span>
                    </PixelButton>
                  </div>
                </div>}
              </>
            )}

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 13,
                color: 'var(--cth-ink-900)'
              }}>{error}</div>
            )}

            {/* Footer / nav */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <Dots step={step} />
              <div style={{ display: 'flex', gap: 8 }}>
                {step !== 'welcome' && (
                  <PixelButton variant="ghost" size="md" onClick={() => setStep(prevStep(step))} disabled={busy}>
                    back
                  </PixelButton>
                )}
                {step !== 'permissions' && (
                  <PixelButton
                    variant="primary"
                    size="md"
                    onClick={() => {
                      // Validate the home step HERE. Without this the only check
                      // lives in finish(), so an empty field walks you through all
                      // four steps and then bounces you back to step 1 to be told.
                      if (step === 'home' && !home.trim()) {
                        setError('Pick a folder for Nexus first.');
                        return;
                      }
                      setError(undefined);
                      setStep(nextStep(step));
                    }}
                  >
                    {step === 'welcome' ? 'start setup' : 'next'}
                  </PixelButton>
                )}
                {step === 'permissions' && (
                  <PixelButton variant="primary" size="md" onClick={finish} disabled={busy}>
                    {busy ? 'saving...' : 'finish'}
                  </PixelButton>
                )}
              </div>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function ToggleRow({ icon, label, desc, on, tint, edge, onChange }: {
  icon: IconName;
  label: string;
  desc: string;
  on: boolean;
  tint: string; // background token when on
  edge: string; // border token when on
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
      background: on ? tint : 'var(--cth-paper-100)',
      boxShadow: `inset 0 0 0 ${on ? 2 : 1}px ${on ? edge : 'var(--cth-ink-300)'}`,
      cursor: 'pointer'
    }}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, flexShrink: 0, marginTop: 5 }}
      />
      <span style={{
        width: 28, height: 28, flexShrink: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}>
        <Icon name={icon} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', marginBottom: 3 }}>
          {label}
        </span>
        <span style={{ display: 'block', fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
          {desc}
        </span>
      </span>
    </label>
  );
}

function Dots({ step }: { step: Step }) {
  const order: Step[] = ['welcome', 'home', 'orchestrator', 'repos', 'permissions'];
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {order.map((s) => (
        <span key={s} style={{
          width: 8, height: 8,
          background: s === step ? 'var(--cth-ink-900)' : 'var(--cth-cream-300)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }} />
      ))}
    </div>
  );
}

function nextStep(s: Step): Step {
  return s === 'welcome' ? 'home'
    : s === 'home' ? 'orchestrator'
    : s === 'orchestrator' ? 'repos'
    : s === 'repos' ? 'permissions'
    : 'done';
}
function prevStep(s: Step): Step {
  return s === 'permissions' ? 'repos'
    : s === 'repos' ? 'orchestrator'
    : s === 'orchestrator' ? 'home'
    : s === 'home' ? 'welcome'
    : 'welcome';
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};
