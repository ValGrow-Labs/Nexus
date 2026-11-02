import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import { startMockLoop, stopMockLoop } from '@/store/mockEvents';
import type { HarnessConfig } from '@/store/config';
import { DEFAULT_ORG_TRIGGER } from '@shared/triggers';
import type { DomainId } from '@shared/domain';
import { leadAgentId } from '@shared/agentDisplay';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useHive } from '@/hooks/useHive';
import { AddAgentModal } from '@/components/AddAgentModal';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { HivePicker } from '@/components/HivePicker';
import { WelcomeIntro } from '@/nexus/pages/WelcomePage';
import { useNexusUi } from '@/nexus/state/uiStore';
import { QuitWarningModal, type ClosingTimeState } from '@/components/QuitWarningModal';
import { CompletionToast } from '@/realtime/CompletionToast';
import { UpdateToast } from '@/components/UpdateToast';
import { SettingsModal, type Section as SettingsSection } from '@/components/SettingsModal';
import { acquireTerminal } from '@/components/terminalPool';
import { FullscreenTerminal } from '@/components/FullscreenTerminal';
import { TaskDetailOverlay } from '@/components/TaskDetailOverlay';
import { FullscreenFileEditor } from '@/components/FullscreenFileEditor';
import { IdePanel } from '@/ide/IdePanel';
import { useHoldOptionToTalk } from '@/freeflow/holdOption';
import { ProjectDashboardModal } from '@/project/ProjectDashboardModal';
import { NewProjectWizardModal } from '@/project/NewProjectWizardModal';
import { ProjectImportModal } from '@/project/ProjectImportModal';
import { NexusShell } from '@/nexus/NexusShell';
import type { ShellActions } from '@/nexus/shellActions';
import { navigate } from '@/nexus/router/useRoute';

// Injected at build time from package.json (see electron.vite.config.ts).
declare const __APP_VERSION__: string;

export function App() {
  const agents = useStore(s => s.agents);
  const addAgentOpen = useStore(s => s.addAgentOpen);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const fullscreenFilePath = useStore(s => s.fullscreenFilePath);
  const ideOpen = useStore(s => s.ideOpen);
  const setActiveProject = useStore(s => s.setActiveProject);
  const setProjects = useStore(s => s.setProjects);

  const [newProjectWizardOpen, setNewProjectWizardOpen] = useState(false);
  const [newProjectDomain, setNewProjectDomain] = useState<DomainId | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [projectDashboardOpen, setProjectDashboardOpen] = useState(false);
  const [config, setConfig] = useState<HarnessConfig | null>(null);
  const introSeen = useNexusUi((s) => s.introSeen);
  const seeIntro = useNexusUi((s) => s.seeIntro);
  // Whether the user has passed the launch-time hive picker this session. Starts
  // true (skip the picker) right after a hive SWITCH — changeHome relaunches and
  // leaves a one-shot localStorage flag so we don't bounce back onto the picker for
  // the hive we just chose. Also set true on onboarding completion (below).
  const [hiveOpened, setHiveOpened] = useState<boolean>(() => {
    try {
      if (window.localStorage.getItem('cth.skipHivePickerOnce')) {
        window.localStorage.removeItem('cth.skipHivePickerOnce');
        return true;
      }
    } catch { /* localStorage unavailable — show the picker */ }
    return false;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Which tab Settings opens on. Set by a `cth:open-settings` deep link, reset
   *  to undefined (→ General) whenever the modal is opened the normal way. */
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [quitWarn, setQuitWarn] = useState<{ ptyCount: number } | null>(null);
  const [closing, setClosing] = useState<ClosingTimeState | null>(null);

  // Deep link into Settings from anywhere in the tree. Settings' open state is
  // local to App, so a nested control (e.g. "set it now" beside a disabled Talk
  // button) has no path to it without threading a prop through every layer
  // between; a window event keeps that plumbing out of the components in
  // between, matching the existing `cth:` CustomEvent convention.
  useEffect(() => {
    const onOpenSettings = (e: Event): void => {
      const section = (e as CustomEvent<{ section?: SettingsSection }>).detail?.section;
      setSettingsSection(section);
      setSettingsOpen(true);
    };
    window.addEventListener('cth:open-settings', onOpenSettings);
    return () => window.removeEventListener('cth:open-settings', onOpenSettings);
  }, []);

  // Initial config load
  useEffect(() => {
    let cancelled = false;
    window.cth.getConfig().then(c => {
      if (cancelled) return;
      setConfig(c);
      // Mirror the Free Flow flag into the store so the composer mic button shows
      // only when enabled (Settings keeps this in sync on save).
      useStore.getState().setFreeflowEnabled(!!c.freeflowEnabled);
      // Mirror boolean key-presence ONLY (never the key value) so the composer can
      // show the voice button disabled-with-tooltip when Free Flow is on but no
      // Groq key is set (Settings keeps this in sync on save).
      useStore.getState().setHasGroqKey(!!c.secretsPresent?.groqApiKey);
      // Mirror the active office theme so OfficeFloor renders it (gated on the
      // tvShowOffices flag; off = always the office). Settings keeps this synced.
      useStore.getState().setOfficeTheme(c.tvShowOffices ? (c.officeTheme ?? 'office') : 'office');
      // Mirror the triggers so Settings → Connections and the workbench's
      // Triggers tab read one list, not two copies that drift — whichever surface
      // saves calls these same setters and the other repaints. No extra IPC: main
      // deep-fills both fields on every config read (withTriggerDefaults), so
      // getConfig() already serves what listWebhooks()/getOrgTrigger() would.
      // `c` is typed as the PRELOAD's HarnessConfig, which hasn't picked the two
      // fields up yet (another lane's file); the renderer mirror type declares them.
      const withTriggers = c as HarnessConfig;
      useStore.getState().setWebhookTriggers(withTriggers.webhookTriggers ?? []);
      useStore.getState().setOrgTrigger(withTriggers.orgTrigger ?? DEFAULT_ORG_TRIGGER);
    });
    // Mirror BYOK OpenAI key presence (boolean only; the key never leaves main) so the
    // Realtime Michael voice toggle can gate on it. Lives in the secret broker, not
    // config — so fetch it rather than derive from c.
    window.cth.realtimeHasOpenAiKey().then(has => {
      if (!cancelled) useStore.getState().setHasOpenAiKey(has);
    });
    window.cth.projectGetActive().then(p => {
      if (!cancelled && p) useStore.getState().setActiveProject(p);
    });
    window.cth.projectList().then(list => {
      if (!cancelled && list) useStore.getState().setProjects(list);
    });
    return () => { cancelled = true; };
  }, []);

  // Free Flow entry point B — hold-Option (⌥) to talk. In-renderer push-to-talk
  // for whichever agent the user is viewing; gated on the flag, terminal-safe
  // (solo-hold threshold, aborts on any other key). See freeflow/holdOption.ts.
  useHoldOptionToTalk();

  // Quit warning subscription
  useEffect(() => window.cth?.onCloseRequested?.((info) => setQuitWarn(info)) || (() => {}), []);

  // Shareable hires: a validated manifest arriving via the munderdifflin://
  // deep link (or file import) pre-fills the Add-Agent modal. Never spawns by itself.
  const setPendingHire = useStore(s => s.setPendingHire);
  useEffect(() => {
    const unsub = window.cth.onHireImport?.((m) => {
      setPendingHire(m);
      setAddAgentOpen(true);
    });
    // Pull anything that arrived before this subscription existed (cold-start
    // deep links; packaged renderers load too fast for push-on-load).
    void window.cth.drainPendingHires?.().then((queued) => {
      if (queued && queued.length > 0) {
        setPendingHire(queued[queued.length - 1]);
        setAddAgentOpen(true);
      }
    });
    return unsub;
  }, [setPendingHire, setAddAgentOpen]);
  useEffect(() => window.cth.onHireError?.((info) => {
    console.error('[hire] import failed:', info.error);
  }), []);

  // Closing-time progress: drives the quit dialog's "wrapping up" view. The
  // dialog stays up through the whole protocol; on 'complete' the main process
  // tears down and quits by itself moments later.
  useEffect(() => window.cth.onClosingTime?.((ev) => {
    if (ev.phase === 'cancelled') { setClosing(null); return; }
    setClosing({ phase: ev.phase, acked: ev.acked, total: ev.total });
    if (ev.phase === 'started' || ev.phase === 'progress') setQuitWarn((w) => w ?? { ptyCount: 0 });
  }), []);

  const startClosingTime = async () => {
    const res = await window.cth.startClosingTime();
    if (!res.ok) setClosing({ phase: 'error', acked: 0, total: 0, error: res.error });
  };
  const cancelClosingTime = () => {
    void window.cth.cancelClosingTime();
    setClosing(null);
  };

  // The hive: god-agent bootstrap, hook-driven avatars, idle-agent waking. Held
  // off until the user opens a hive in the launch picker (passing null no-ops the
  // hook) so Michael doesn't boot against the current home while the user may be
  // about to switch to a different one.
  useHive(hiveOpened ? config : null);
  // Boot-time restore of the last session's team lives here, never in fullscreen.
  useRestoreTeam(hiveOpened ? config : null, { autoRestore: true });

  // Pre-warm a persistent terminal for every live agent so its output is
  // buffered from spawn. Switching agents then re-attaches an already-rendered
  // terminal instantly (with full history) instead of building a blank one.
  useEffect(() => {
    for (const a of agents) if (a.ptyId) acquireTerminal(a.ptyId);
  }, [agents]);

  // Synthetic demo loop. DEMO ONLY: it runs solely as an explicit dev showcase
  // (VITE_CTH_DEMO=1) and never against a real floor, empty or not, so the UI
  // never shows fabricated agent activity.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    if (!(import.meta.env.DEV && import.meta.env.VITE_CTH_DEMO === '1')) return;
    startMockLoop();
    return () => stopMockLoop();
  }, [config?.onboardingComplete]);

  // Reconcile restored agents against the PTYs still alive in the main process.
  // After a renderer reload (e.g. the laptop slept and Vite reloaded the page),
  // this keeps agents whose process survived and drops any that truly died.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    let cancelled = false;
    window.cth.listPtys().then((list) => {
      if (cancelled) return;
      useStore.getState().reconcileWithLivePtys(list.map((p) => p.id));
    }).catch(() => { /* ignore — keep restored agents as-is */ });
    return () => { cancelled = true; };
  }, [config?.onboardingComplete]);

  const shellActions: ShellActions = useMemo(() => ({
    openSettings: (section) => { setSettingsSection(section); setSettingsOpen(true); },
    openNewProject: (domainId) => { setNewProjectDomain(domainId); setNewProjectWizardOpen(true); },
    openImport: () => setImportOpen(true),
    openIde: (root?: string) => {
      const s = useStore.getState();
      // A folder was named: open it without claiming any agent owns it.
      if (root) { s.setIdeOpen(true, null, root); return; }
      const target = s.agents.find((a) => a.id === s.selectedId) ?? s.agents.find((a) => a.id === leadAgentId(s.agents)) ?? null;
      s.setIdeOpen(true, target?.id ?? null);
    },
    openProjectManager: () => setProjectDashboardOpen(true)
  }), []);

  if (!config) {
    return <div style={{ width: '100vw', height: '100vh', background: 'var(--nx-ground)' }} />;
  }

  // Every launch starts on the Welcome intro; Get started goes on to the config picker (or onboarding).
  if (!introSeen) {
    return <div className="nx-launch"><WelcomeIntro onStart={seeIntro} /></div>;
  }

  if (!config.onboardingComplete) {
    // Just-onboarded users go straight into the hive they set up — skip the picker.
    return <OnboardingWizard onComplete={(next) => { setConfig(next); setHiveOpened(true); }} />;
  }

  // Launch-time hive picker: on reopen, let the user open their current hive,
  // switch to a recent one, or open/create another. Skipped right after onboarding
  // and right after a switch-relaunch (see hiveOpened init).
  if (!hiveOpened) {
    return <HivePicker config={config} onOpenCurrent={() => setHiveOpened(true)} />;
  }

  return (
    <>
      <CompletionToast />
      <UpdateToast />
      <NexusShell config={config} actions={shellActions} />

      {newProjectWizardOpen && (
        <NewProjectWizardModal
          isOpen={newProjectWizardOpen}
          initialDomainId={newProjectDomain}
          onClose={() => setNewProjectWizardOpen(false)}
          onProjectCreated={(p) => {
            setActiveProject(p);
            void window.cth.projectList().then((l) => setProjects(l ?? []));
            navigate({ name: 'project', id: p.id, tool: 'bench' });
          }}
        />
      )}

      <ProjectImportModal
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        onImportSuccess={async () => {
          const [list, act] = await Promise.all([window.cth.projectList(), window.cth.projectGetActive()]);
          setProjects(list ?? []);
          if (act) { setActiveProject(act); navigate({ name: 'project', id: act.id, tool: 'bench' }); }
        }}
      />

      {addAgentOpen && (
        <AddAgentModal
          onClose={() => setAddAgentOpen(false)}
          config={config}
          onConfigChange={setConfig}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          config={config}
          initialSection={settingsSection}
          onClose={() => { setSettingsOpen(false); setSettingsSection(undefined); }}
        />
      )}

      {quitWarn && (
        <QuitWarningModal
          ptyCount={quitWarn.ptyCount}
          closing={closing}
          onCancel={() => {
            if (closing) cancelClosingTime();
            window.cth.cancelClose();
            setQuitWarn(null);
          }}
          onConfirm={async () => { await window.cth.confirmClose(); }}
          onClosingTime={startClosingTime}
        />
      )}

      {fullscreenAgentId && <FullscreenTerminal config={config} />}
      {fullscreenFilePath && <FullscreenFileEditor />}
      {ideOpen && <IdePanel />}
      <TaskDetailOverlay />
      <ProjectDashboardModal
        isOpen={projectDashboardOpen}
        onClose={() => setProjectDashboardOpen(false)}
        onNewProject={() => { setProjectDashboardOpen(false); setNewProjectWizardOpen(true); }}
        onOpenProject={() => {
          setProjectDashboardOpen(false);
          const p = useStore.getState().activeProject;
          if (p) navigate({ name: 'project', id: p.id, tool: 'bench' });
        }}
      />
    </>
  );
}
