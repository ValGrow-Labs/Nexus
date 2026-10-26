import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Project } from '@shared/project';
import { useStore } from '@/store/store';
import type { ProjectTool } from '../router/routes';
import { navigate } from '../router/useRoute';
import { useProjectsLoader } from '../data/useProjects';
import { useParticipationIndex } from '../data/useParticipations';
import { useProjectArtifacts } from '../data/useProjectArtifacts';
import { usePlatform, selectCanWrite } from '../data/platformStore';
import { SendHandoffSheet } from '../handoffs/SendHandoffSheet';
import type { HandoffStart } from '../handoffs/handoffModel';
import { useNexusUi } from '../state/uiStore';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { useMedia } from '../ui/useMedia';
import { withViewTransition } from '../ui/viewTransition';
import { MobileRuns } from './MobileRuns';
import { buildSpine, nodeLabel, spineLine } from './spineModel';
import type { SpineNode } from './spineModel';
import { useProjectGit } from './useProjectGit';
import { Spine } from './Spine';
import { ToolRail } from './ToolRail';
import { FocusSurface } from './FocusSurface';
import { Passport } from './PassportPanel';
import { SaveArtifactSheet } from './SaveArtifactSheet';
import type { SaveSource } from './saveSheetModel';
import { nexusClient } from '../data/nexusClient';
import { useDeployments, useDomains, useExecStore, useHealth, useJobs } from '../data/useExecution';
import { liveActionsOf, railFor, type RailView } from '../workspaces/lifecycleModel';
import { ExecutionNotice } from '../components/ExecutionNotice';
import { ExecutionSetupSheet } from '../components/ExecutionSetupSheet';
import { JobLogSheet } from '../runs/JobLogSheet';
import { ApprovalsSection } from './ApprovalsSection';
import { AgentPanel } from '../agent/AgentPanel';
import { RequirementSheet } from './RequirementSheet';
import { ExecutionUiContext, type ExecutionUi } from './execContext';
import type { LogRange } from './evidenceModel';
import { applicationDrafts, checkedVersionIds, railRecordsFor, spineChecks, versionsToRead, withApplicationWords, type SpineGroup, type ValidatorStatuses } from './spineModel';
import { livePreviewsOf } from '../runs/jobRunModel';
import type { VersionStatus } from '@shared/nexus/platform';
import type { ArtifactSummary } from './spineModel';

type VersionCheck = { status: VersionStatus; word: string | null; validators: ValidatorStatuses | null };

/**
 * The checks of each checked artifact node: its word (nexus:version:get, B1, so it works with execution off) and the
 * latest blocking result per validator (#32, null while execution is off). Only versions that are new, changed status
 * or are still drafts are read again on a change (versionsToRead).
 */
function useVersionChecks(artifacts: ArtifactSummary[]): { words: Map<string, string>; validators: Map<string, ValidatorStatuses> | null } {
  const rev = usePlatform((s) => s.rev);
  const tick = useExecStore((s) => s.ticks.validations);
  const wanted = useMemo(() => checkedVersionIds(artifacts), [artifacts]);
  const cache = useRef(new Map<string, VersionCheck>());
  const lastTick = useRef(tick);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    // Checks unread while execution was off are read again once execution events arrive (a validations tick).
    const ticked = tick !== lastTick.current;
    lastTick.current = tick;
    const readAt = new Map([...cache.current].filter(([, c]) => !(ticked && c.validators === null)).map(([id, c]) => [id, c.status]));
    const todo = versionsToRead(wanted, readAt);
    if (todo.length === 0) { setVersion((n) => n + 1); return; }
    void Promise.all(todo.map(async (w) => {
      const [g, v] = await Promise.all([nexusClient.versionGet(w.versionId), nexusClient.versionValidations(w.versionId)]);
      const statuses: Record<string, 'passed' | 'failed' | 'error' | 'skipped'> = {};
      if (v.ok) for (const x of v.data) if (x.blocking && x.status) statuses[x.validatorId] = x.status;
      return { w, word: g.ok ? spineChecks([{ nodeId: w.nodeId, validationState: g.data.validationState, status: g.data.status }]).get(w.nodeId) ?? null : null,
        validators: v.ok ? statuses : null };
    })).then((rs) => {
      if (!alive) return;
      for (const r of rs) cache.current.set(r.w.versionId, { status: r.w.status, word: r.word, validators: r.validators });
      setVersion((n) => n + 1);
    });
    return () => { alive = false; };
  }, [wanted, rev, tick]);
  return useMemo(() => {
    const words = new Map<string, string>();
    const validators = new Map<string, ValidatorStatuses>();
    let readable = true;
    for (const w of wanted) {
      const c = cache.current.get(w.versionId);
      if (!c) { readable = false; continue; }
      if (c.word) words.set(w.nodeId, c.word);
      if (c.validators) validators.set(w.versionId, c.validators); else readable = false;
    }
    return { words, validators: readable ? validators : null };
  }, [wanted, version]);
}

/**
 * The build each shown application draft was assembled from (its assembled_from source, nexus:lineage:get): a preview
 * job's input is that build, so a job not yet leased (no deployment row naming the version) counts for its own version.
 */
function useDraftBuilds(artifacts: ArtifactSummary[]): Map<string, string> {
  const rev = usePlatform((s) => s.rev);
  const ids = useMemo(() => applicationDrafts(artifacts), [artifacts]);
  const key = ids.join(',');
  const [builds, setBuilds] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    if (!key) { setBuilds(new Map()); return; }
    void Promise.all(key.split(',').map(async (id) => {
      const r = await nexusClient.lineageGet(id, { direction: 'up', depth: 1 });
      const b = r.ok ? r.data.nodes.find((n) => n.relation === 'assembled_from' && n.kind === 'build') : undefined;
      return [id, b?.versionId ?? null] as const;
    })).then((rs) => {
      if (!alive) return;
      const m = new Map<string, string>();
      for (const [id, b] of rs) if (b) m.set(id, b);
      setBuilds(m);
    });
    return () => { alive = false; };
  }, [key, rev]);
  return builds;
}

/** Each active group's lifecycle rail, from records only (versions and their checks, live jobs, dev deployments). */
function useGroupRails(projectId: string, groups: SpineGroup[], artifacts: ArtifactSummary[], checks: Map<string, ValidatorStatuses> | null,
  builds: ReadonlyMap<string, string>): Map<string, RailView> {
  const domains = useDomains().list;
  const jobs = useJobs(projectId);
  const deployments = useDeployments(projectId);
  return useMemo(() => {
    const m = new Map<string, RailView>();
    const liveActions = liveActionsOf(jobs.data ?? []);
    const healthy = (deployments.data ?? []).some((d) => d.status === 'healthy');
    // Live dev deployments: a check that runs on one (app.preview_health) can be running only while one is.
    const live = (deployments.data ?? []).filter((d) => d.status === 'starting' || d.status === 'healthy' || d.status === 'unhealthy');
    const liveDeployments = live.length;
    const liveDeploymentStatuses = live.map((d) => d.status);
    // Per version: the live previews of the shown application draft(s) only (a deployment row naming the version, or a
    // not-yet-leased preview job of its build); another version's live preview never counts for this draft.
    const draftPreviews = applicationDrafts(artifacts).flatMap((versionId) =>
      livePreviewsOf({ versionId, buildVersionId: builds.get(versionId) ?? null }, deployments.data ?? [], jobs.data ?? []).map((p) => p.status));
    for (const g of groups) {
      if (g.muted) continue;
      const view = domains.find((d) => d.id === g.workspaceId);
      if (!view) continue;
      // Jobs or deployments unread (execution off): no state is claimed, only the steps and their status in this release.
      const records = jobs.data && deployments.data
        ? railRecordsFor({ workspaceId: g.workspaceId, artifacts, checks, liveActions, deploymentHealthy: healthy, participating: true }) : null;
      m.set(g.workspaceId, railFor(view, records ? { ...records, liveDeployments, liveDeploymentStatuses, draftPreviews } : null));
    }
    return m;
  }, [groups, domains, checks, jobs.data, deployments.data, artifacts, builds]);
}

/** The project route: opens the project, then shows the Spine workbench. */
export function ProjectBench({ id, tool }: { id: string; tool: ProjectTool }) {
  const { status, error: loadError, refresh: reloadProjects } = useProjectsLoader();
  const projectCount = useStore((s) => s.projects.length);
  const known = useStore((s) => s.projects.find((p) => p.id === id) ?? null);
  const active = useStore((s) => s.activeProject);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // A new project id starts clean: no error carried over from another project.
  useEffect(() => { setErr(null); }, [id]);

  useEffect(() => {
    if (!known || active?.id === id) return;
    let alive = true;
    setErr(null);
    window.cth.projectSetActive(id)
      .then((p) => { if (alive) { if (p) setActiveProject(p); else setErr('The project could not be opened.'); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [id, known, active?.id, setActiveProject, attempt]);

  if (!known && status === 'error' && projectCount === 0) {
    return <div className="nx-page"><EmptyState level={1} icon="refresh" title="Couldn't load your projects" body={loadError ?? 'The project list could not be loaded.'} actions={<Button variant="primary" onClick={() => { void reloadProjects(); }}>Retry</Button>} /></div>;
  }
  if (!known && status !== 'loading') {
    return <div className="nx-page"><EmptyState level={1} icon="projects" title="That project isn't in your list" body="It may have been removed. Open Projects to pick another."
      actions={<Button variant="primary" onClick={() => navigate({ name: 'projects' })}>Back to Projects</Button>} /></div>;
  }
  if (err) {
    return <div className="nx-page"><EmptyState level={1} icon="refresh" title="Couldn't open the project" body={err} actions={<Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>} /></div>;
  }
  if (!active || active.id !== id) {
    return <div className="nx-page"><p className="nx-muted" role="status">Opening {known?.name ?? 'project'}…</p></div>;
  }
  return <Workbench key={active.id} project={active} tool={tool} />;
}

function Workbench({ project, tool }: { project: Project; tool: ProjectTool }) {
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setLastProject = useNexusUi((s) => s.setLastProject);
  const setSelection = useNexusUi((s) => s.setSelection);
  const { git, refresh } = useProjectGit(project.rootPath);
  const idx = useParticipationIndex();
  const { artifacts, loaded: artifactsLoaded, error: artifactsError, retry: artifactsRetry, truncated: artifactsTruncated, reload: reloadArtifacts } = useProjectArtifacts(project.id);
  const canWrite = usePlatform(selectCanWrite);
  const groups = useMemo(() => buildSpine({ idx, projectId: project.id, git, artifacts }), [idx, project.id, git, artifacts]);
  const nodes = groups.flatMap((g) => g.nodes);
  const line = spineLine({ loaded: artifactsLoaded, error: artifactsError, retry: artifactsRetry }, groups);
  const [selected, setSelected] = useState<string>(tool === 'changes' ? 'changes' : 'source');

  // The project opened successfully: remember it for the launcher.
  useEffect(() => { setLastProject(project.id); }, [project.id, setLastProject]);

  // Follow the URL: the changes tool selects the changes node, the bench selects source.
  useEffect(() => {
    if (tool === 'changes') setSelected('changes');
    // The bench keeps an artifact selection; only the changes node gives way to source.
    else if (tool === 'bench') setSelected((s) => (s === 'changes' ? 'source' : s));
  }, [tool]);

  const node: SpineNode = nodes.find((n) => n.id === selected) ?? nodes[0];
  const sourceNode = nodes.find((n) => n.kind === 'source') ?? nodes[0];
  // The Changes tool is offered for your uncommitted changes and for the changes the agent made (B2b).
  const hasChanges = nodes.some((n) => n.kind === 'changes') || artifacts.some((s) => s.artifact.kind === 'change_set' && s.artifact.status === 'active');
  const label = nodeLabel(node);

  useEffect(() => { setSelection({ kind: node.kind, label }); }, [node.kind, label, setSelection]);
  useEffect(() => () => setSelection(null), [setSelection]);

  const wide = !useMedia('(max-width: 1279px)');
  const mobile = useMedia('(max-width: 767px)');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);
  useEffect(() => {
    if (!wide) return;
    setDetailsOpen((open) => {
      // Widening with the sheet open: focus would otherwise drop to body.
      if (open) setTimeout(() => document.getElementById('nx-surface-title')?.focus(), 0);
      return false;
    });
  }, [wide]);

  // The clicked node carries the shared transition name only for this one
  // transition; the surface title carries it in steady state. The router is
  // hash-based, so the hashchange is dispatched synchronously inside flushSync
  // and the new snapshot shows the rendered surface.
  const onSelect = (nodeId: string, el?: HTMLElement) => {
    const root = document.documentElement;
    // Old snapshot: only the node is named (the surface title is suppressed).
    root.dataset.nxVt = '1';
    el?.style.setProperty('view-transition-name', 'nx-focus');
    withViewTransition(() => {
      // New snapshot: only the title is named. Cleared on every path.
      delete root.dataset.nxVt;
      el?.style.removeProperty('view-transition-name');
      flushSync(() => {
        setSelected(nodeId);
        navigate({ name: 'project', id: project.id, tool: nodeId === 'changes' ? 'changes' : 'bench' });
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
    });
  };

  const refreshProject = useCallback(async () => {
    const r = await window.cth.projectRefresh(project.id);
    if (r) setActiveProject(r);
    refresh();
  }, [project.id, setActiveProject, refresh]);

  const head = git.status === 'ready' ? git.head : null;
  const [notice, setNotice] = useState<string | null>(null);
  const openTerminal = useCallback(() => {
    setNotice(null);
    window.cth.openTerminalAt(project.rootPath)
      .then((r) => { if (!r.ok) setNotice(r.error ?? 'The terminal could not be opened.'); })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)));
  }, [project.rootPath]);
  // The sheet's Passport unmounts when the sheet closes, so its own error line
  // cannot show a failed refresh: route it to the bench-level notice instead.
  const refreshFromSheet = useCallback(() => {
    setNotice(null);
    return refreshProject().catch((e) => setNotice(e instanceof Error ? e.message : String(e)));
  }, [refreshProject]);
  // The Save sheet lives at the bench, so it outlives the Details sheet that may open it.
  const [saveSource, setSaveSource] = useState<SaveSource | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const focused = useCallback(() => setFocusRequest(null), []);
  const openSave = useCallback((s: SaveSource) => setSaveSource(s), []);
  const closeSave = useCallback(() => setSaveSource(null), []);
  const onSaved = useCallback((artifactId: string) => {
    setSaveSource(null);
    setSelected(`artifact:${artifactId}`);
    // Focus the new node once the reload draws it (the sheet that had focus is gone).
    setFocusRequest(`artifact:${artifactId}`);
    navigate({ name: 'project', id: project.id, tool: 'bench' });
  }, [project.id]);
  const onSave = canWrite ? openSave : undefined;
  // The send sheet also lives at the bench, so it outlives the Details sheet that may open it.
  const [handoffStart, setHandoffStart] = useState<HandoffStart | null>(null);
  const openHandoff = useCallback((s: HandoffStart) => setHandoffStart(s), []);
  const closeHandoff = useCallback(() => setHandoffStart(null), []);
  const onHandOff = canWrite ? openHandoff : undefined;
  // Writes turned off (the platform became unavailable): the sheets go and do not come back by themselves.
  useEffect(() => { if (!canWrite) { setSaveSource(null); setHandoffStart(null); } }, [canWrite]);
  // B2a execution: the setup sheet, the writing sheet and the log reader live at the bench; the Folio opens them.
  const { availability } = useHealth();
  const versionChecks = useVersionChecks(artifacts);
  const projectDeployments = useDeployments(project.id);
  const projectJobs = useJobs(project.id);
  const draftBuilds = useDraftBuilds(artifacts);
  const checks = useMemo(() => withApplicationWords(versionChecks.words, artifacts, versionChecks.validators, projectDeployments.data,
    projectJobs.data ? { jobs: projectJobs.data, builds: draftBuilds } : null),
  [versionChecks.words, versionChecks.validators, artifacts, projectDeployments.data, projectJobs.data, draftBuilds]);
  const rails = useGroupRails(project.id, groups, artifacts, versionChecks.validators, draftBuilds);
  const hasSde = (idx.byProject.get(project.id) ?? []).some((r) => r.status === 'active' && r.workspaceId === 'sde');
  const [setupOpen, setSetupOpen] = useState(false);
  const [write, setWrite] = useState<{ workspaceId: string; kind: 'requirement' | 'problem_statement' } | null>(null);
  const [log, setLog] = useState<{ jobId: string; range?: LogRange | null } | null>(null);
  const closeSetup = useCallback(() => setSetupOpen(false), []);
  const execUi = useMemo<ExecutionUi>(() => ({
    projectId: project.id,
    openSetup: () => setSetupOpen(true),
    openWrite: (w) => { if (canWrite) setWrite({ workspaceId: w.workspaceId, kind: w.kind }); },
    openLog: (l) => setLog(l)
  }), [project.id, canWrite]);

  return (
    <ExecutionUiContext.Provider value={execUi}>
    <div className="nx-workbench">
      {mobile && <MobileRuns projectId={project.id} />}
      <Spine groups={groups} selectedId={tool === 'completion' || tool === 'runs' ? '' : node.id} onSelect={onSelect}
        line={line} onRetryLine={reloadArtifacts} truncated={artifactsTruncated} focusRequest={focusRequest} onFocused={focused} checks={checks} rails={rails} />
      <div className="nx-xstrip">
        <ExecutionNotice availability={availability} onSetup={execUi.openSetup} />
        <ApprovalsSection projectId={project.id} />
        {/* B2b: the agent is offered only where SDE takes part: no other domain claims to work yet. */}
        {hasSde && <AgentPanel projectId={project.id} workspaceId="sde" />}
      </div>
      <div className="nx-bench">
        <ToolRail projectId={project.id} rootPath={project.rootPath} tool={tool} hasChanges={hasChanges} onOpenTerminal={openTerminal}
          extra={!wide && (
            <button type="button" className="nx-passport-btn" aria-haspopup="dialog" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(true)}>Details</button>
          )} />
        {!wide && notice && <p className="nx-passport__note" role="alert">{notice}</p>}
        <FocusSurface tool={tool} project={project} node={sourceNode} git={git} onRetryGit={refresh} />
        {wide && <Passport project={project} node={node} headSha={head?.sha ?? null} onRefreshProject={refreshProject} onOpenTerminal={openTerminal} notice={notice} artifacts={artifacts} onSave={onSave} onHandOff={onHandOff} />}
      </div>
      {!wide && (
        <Sheet open={detailsOpen} onClose={closeDetails} side={mobile ? 'bottom' : 'right'} labelledBy="nx-passport-title" focusHeading>
          <Passport project={project} node={node} headSha={head?.sha ?? null} onRefreshProject={refreshFromSheet} onOpenTerminal={openTerminal} notice={null} onBeforeAction={closeDetails} artifacts={artifacts} onSave={onSave} onHandOff={onHandOff} />
        </Sheet>
      )}
      {saveSource && canWrite && (
        <SaveArtifactSheet project={project} initial={saveSource} artifacts={artifacts} onClose={closeSave} onSaved={onSaved} />
      )}
      {handoffStart && canWrite && <SendHandoffSheet start={handoffStart} artifacts={artifacts} onClose={closeHandoff} />}
      <ExecutionSetupSheet open={setupOpen} onClose={closeSetup} />
      {write && canWrite && (
        <RequirementSheet projectId={project.id} workspaceId={write.workspaceId} kind={write.kind} onClose={() => setWrite(null)}
          onSaved={(artifactId) => { setWrite(null); onSaved(artifactId); }} />
      )}
      {log && <JobLogSheet jobId={log.jobId} range={log.range ?? null} onClose={() => setLog(null)} />}
    </div>
    </ExecutionUiContext.Provider>
  );
}
