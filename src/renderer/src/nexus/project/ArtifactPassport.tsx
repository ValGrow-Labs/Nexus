import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { ArtifactDetail, LineageView, NexusFail, NexusResult, VersionContent, VersionView } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { usePlatform, selectCanWrite } from '../data/platformStore';
import { useParticipationIndex } from '../data/useParticipations';
import { useArtifactHandoffs } from '../data/useHandoffs';
import { errorCopy } from '../data/errorCopy';
import { viewOf } from '../workspaces/participation';
import { navigate } from '../router/useRoute';
import { PASSPORT_HANDOFF_READS, canHandOff, hasReceiver, type HandoffStart } from '../handoffs/handoffModel';
import { Button } from '../ui/Button';
import { Popover } from '../ui/Sheet';
import { projectOwned, type ArtifactNode, type ArtifactSummary } from './spineModel';
import { ActionBar } from './ActionBar';
import { DeploymentsSection } from './DeploymentsSection';
import { EvidenceSection } from './EvidenceSection';
import { KindViewer } from './kindViewers';
import { applicationChecksWord, checksWord, type CheckStatus, type PreviewDeployment } from './evidenceModel';
import { useDeployments, useJobs, useValidations } from '../data/useExecution';
import { livePreviewsOf } from '../runs/jobRunModel';
import { workspacesActingOn } from './actionModel';
import {
  IDLE_ACTIONS, LINK_CANDIDATE_ARTIFACTS, actionDoneText, actionsFor, actionPendingText, actionFailed, actionFailureText, actionLabel, actionSucceeded, artifactPassportView,
  askActionConfirm, beginAction, canLinkSources, candidateArtifactIds, cancelActionConfirm, confirmText, kindIsChecked, kindLabelIn, passportActionsFor,
  shouldReloadAfterAction, sourceChoices, type ActionState, type PassportActionKind, type PassportLink, type SourceChoice
} from './artifactModel';

/** How many versions get their content read (newest first). */
const CONTENT_READS = 12;

const INTERNAL: NexusFail = { ok: false, code: 'internal', message: 'The request could not be completed.' };

type Loaded = {
  detail: ArtifactDetail;
  contents: Map<string, VersionContent>;
  subjects: Map<string, string>;
  up: LineageView | null;
  down: LineageView | null;
};

/** Everything the Passport shows, read over nexus:* (and the project's own git log for commit subjects). */
function useArtifactPassport(artifactId: string, shownVersionNo: number, rootPath: string): { loaded: Loaded | null; error: string | null } {
  const rev = usePlatform((s) => s.rev);
  const [state, setState] = useState<{ loaded: Loaded | null; error: string | null }>({ loaded: null, error: null });
  useEffect(() => { setState({ loaded: null, error: null }); }, [artifactId]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = await nexusClient.artifactGet(artifactId);
        if (!alive) return;
        if (!d.ok) { setState((s) => ({ loaded: d.code === 'not_found' ? null : s.loaded, error: errorCopy(d.code, d.reason, d.subReason).text })); return; }
        const detail = d.data;
        const newest = [...detail.versions].sort((a, b) => b.versionNo - a.versionNo).slice(0, CONTENT_READS);
        const shown = detail.versions.find((v) => v.versionNo === shownVersionNo) ?? null;
        const [reads, up, down] = await Promise.all([
          Promise.all(newest.map((v) => nexusClient.versionGet(v.id))),
          shown ? nexusClient.lineageGet(shown.id, { direction: 'up', depth: 1 }) : Promise.resolve(null),
          shown ? nexusClient.lineageGet(shown.id, { direction: 'down', depth: 1 }) : Promise.resolve(null)
        ]);
        if (!alive) return;
        const contents = new Map<string, VersionContent>();
        for (const r of reads) if (r.ok) contents.set(r.data.id, r.data.content);
        // Commit subjects come only from the project's own git log: the allow-list for that text.
        const subjects = new Map<string, string>();
        // No folder (a project the list no longer has): no git read, the SHA stands alone.
        if (rootPath && [...contents.values()].some((c) => c.type === 'git')) {
          const log = await window.cth.gitLog(rootPath, 200).catch(() => null);
          if (!alive) return;
          if (Array.isArray(log)) for (const c of log) subjects.set(c.sha, c.subject);
        }
        setState({
          loaded: { detail, contents, subjects, up: up && up.ok ? up.data : null, down: down && down.ok ? down.data : null },
          error: (up && !up.ok) || (down && !down.ok) ? 'Some links of this version could not be read.' : null
        });
      } catch {
        // An unexpected throw (for example from the git log read): never an unhandled rejection.
        if (alive) setState((s) => ({ loaded: s.loaded, error: errorCopy('internal').text }));
      }
    })();
    return () => { alive = false; };
  }, [artifactId, shownVersionNo, rootPath, rev]);
  return state;
}

type Candidates = { details: ArtifactDetail[]; loaded: boolean; error: string | null };
const NO_CANDIDATES: Candidates = { details: [], loaded: false, error: null };

/** The project's other artifacts with every version: the picker's choices come from these answers.
 *  `enabled` turns true only once the picker was first opened (and linking is allowed); from then on
 *  the choices refresh on every rev while the Passport stays mounted. */
function useLinkCandidates(enabled: boolean, artifactId: string, artifacts: ArtifactSummary[]): Candidates & { capped: boolean } {
  const rev = usePlatform((s) => s.rev);
  const { ids, capped } = useMemo(() => candidateArtifactIds(artifactId, artifacts), [artifactId, artifacts]);
  const key = ids.join(',');
  const [state, setState] = useState<Candidates>(NO_CANDIDATES);
  useEffect(() => {
    if (!enabled) { setState(NO_CANDIDATES); return; }
    let alive = true;
    void (async () => {
      try {
        const reads = await Promise.all(key ? key.split(',').map((id) => nexusClient.artifactGet(id)) : []);
        if (!alive) return;
        const details = reads.flatMap((r) => (r.ok ? [r.data] : []));
        setState({ details, loaded: true, error: reads.some((r) => !r.ok) ? 'Some versions could not be read, so they are not offered.' : null });
      } catch {
        if (alive) setState((s) => ({ details: s.details, loaded: true, error: errorCopy('internal').text }));
      }
    })();
    return () => { alive = false; };
  }, [enabled, key, rev]);
  return { ...state, capped };
}

function Links({ title, links, truncated, empty, children }: { title: string; links: PassportLink[] | null; truncated: boolean; empty: string; children?: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {links === null ? <p className="nx-muted">Not available.</p> : links.length === 0 ? <p className="nx-muted">{empty}</p> : (
        <ul className="nx-apx__links">
          {links.map((l) => <li key={l.versionId}><span>{l.label}</span> <span className="nx-muted">{l.relation}, {l.status}</span></li>)}
        </ul>
      )}
      {truncated && <p className="nx-muted">More links exist than are shown here.</p>}
      {children}
    </section>
  );
}

/** The artifact Passport: the artifact, its versions with their statuses (the
 *  current one marked), what each version holds, its sources and uses, and the
 *  version actions the platform allows (mark ready, make current, roll back,
 *  discard, link a source). The actions render only while platform writes are on. */
export function ArtifactPassport({ project, node, artifacts, onSpine = true, onHandOff }: {
  project: { id: string; rootPath: string }; node: ArtifactNode; artifacts: ArtifactSummary[];
  /** False on the Artifacts page, where no Spine is shown: the shown version is then not called "shown on the spine". */
  onSpine?: boolean;
  /** Opens the send sheet where it is hosted; without it no "Hand off…" control renders. */
  onHandOff?: (start: HandoffStart) => void;
}) {
  const idx = useParticipationIndex();
  const canWrite = usePlatform(selectCanWrite);
  const handoffsAvailable = usePlatform((s) => s.handoffsAvailable);
  const bumpRev = usePlatform((s) => s.bumpRev);
  // The project's handoffs that carry a version of this artifact (read while the database is the authority).
  const carrying = useArtifactHandoffs(canWrite, project.id, node.artifactId);
  const { loaded, error } = useArtifactPassport(node.artifactId, node.versionNo, project.rootPath);
  const names = useMemo(() => new Map(artifacts.map((s) => [s.artifact.id, s.artifact.name])), [artifacts]);

  const [acts, setActs] = useState<ActionState>(IDLE_ACTIONS);
  // The guard against a second submit before React re-renders.
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Opening a confirmation focuses Cancel, never the destructive button.
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (acts.confirming && !acts.pending) cancelRef.current?.focus();
  }, [acts.confirming, acts.pending]);
  // Focus never falls to the page: while an action runs and when it ends it rests on the status
  // (or alert) line; after a confirmation is cancelled it returns to that version's actions.
  const resultRef = useRef<HTMLParagraphElement | null>(null);
  const rowActs = useRef(new Map<string, HTMLSpanElement>());
  const [focusReq, setFocusReq] = useState<{ to: 'result' | 'row'; versionId: string | null; n: number } | null>(null);
  const requestFocus = (to: 'result' | 'row', versionId: string | null = null) => setFocusReq((f) => ({ to, versionId, n: (f?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!focusReq) return;
    if (focusReq.to === 'result') resultRef.current?.focus();
    else if (focusReq.versionId) rowActs.current.get(focusReq.versionId)?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [focusReq]);
  // The picker's choices are read only once it was first opened.
  const [pickerOpened, setPickerOpened] = useState(false);

  const artifact = loaded ? loaded.detail.artifact : null;
  // An application's health check runs only on a dev deployment: its version words read the deployments of each
  // version and the shown version's blocking results, so a draft never reads "Checking…" while nothing checks it.
  const isApp = artifact?.kind === 'application';
  const deployments = useDeployments(project.id);
  const shownForChecks = loaded ? loaded.detail.versions.find((v) => v.versionNo === node.versionNo) ?? null : null;
  const shownValidations = useValidations(isApp && shownForChecks ? shownForChecks.id : null);
  const jobs = useJobs(project.id);
  // The shown version's build (its assembled_from source, read with the Passport's lineage): a preview job of it that
  // has no deployment row yet still counts for this version, and only for it.
  const shownBuildId = isApp ? loaded?.up?.nodes.find((n) => n.relation === 'assembled_from' && n.kind === 'build')?.versionId ?? null : null;
  const deploymentsOf = (versionId: string): PreviewDeployment[] | null => {
    if (!deployments.data) return null;
    const rows = deployments.data.filter((d) => d.subjectVersionId === versionId).map((d) => ({ status: d.status, startedAt: d.startedAt }));
    // Live rows are already in `rows`; add the version's not-yet-leased preview jobs (per version, never the project's).
    const pending = versionId === shownForChecks?.id && jobs.data
      ? livePreviewsOf({ versionId, buildVersionId: shownBuildId }, deployments.data, jobs.data).filter((p) => !rows.some((r) => r.startedAt === p.startedAt && r.status === p.status))
      : [];
    return [...rows, ...pending];
  };
  const validatorsOf = (versionId: string): Record<string, CheckStatus> | null => {
    if (!shownForChecks || versionId !== shownForChecks.id || !shownValidations.data) return null;
    const m: Record<string, CheckStatus> = {};
    for (const r of shownValidations.data) if (r.blocking) m[r.validatorId] = r.status;
    return m;
  };
  const wordOf = (v: VersionView): string | null => (isApp
    ? applicationChecksWord({ status: v.status, validationState: v.validationState, validators: validatorsOf(v.id), deployments: deploymentsOf(v.id) })
    : checksWord(v.validationState, v.status));
  const ownerRow = artifact && artifact.ownerParticipationId
    ? (idx.byProject.get(project.id) ?? []).find((r) => r.id === artifact.ownerParticipationId) ?? null
    : null;
  // Writes need the owner participation known to be active; an unknown owner offers nothing.
  const ownerActive = ownerRow !== null && ownerRow.status === 'active';
  // Hand off needs someone to receive it: another active participation of this project (the send sheet's choices).
  const receiver = ownerRow !== null && hasReceiver(idx, project.id, ownerRow.id);
  // A project-owned version (a repository snapshot) is acted on from each active workspace whose actions take it.
  const activeWorkspaces = (idx.byProject.get(project.id) ?? []).filter((r) => r.status === 'active').map((r) => r.workspaceId);
  const versionsById = useMemo(() => new Map((loaded?.detail.versions ?? []).map((v) => [v.id, v])), [loaded]);
  const shownVersion = loaded ? loaded.detail.versions.find((v) => v.versionNo === node.versionNo) ?? null : null;
  const linkable = artifact !== null && shownVersion !== null && canLinkSources(artifact, ownerActive, canWrite);
  const candidates = useLinkCandidates(linkable && pickerOpened, node.artifactId, artifacts);
  const choices = useMemo(() => {
    if (!linkable || !loaded) return [];
    const linked = new Set((loaded.up?.nodes ?? []).map((n) => n.versionId));
    return sourceChoices(node.artifactId, project.id, candidates.details, linked);
  }, [linkable, loaded, node.artifactId, project.id, candidates.details]);

  const view = useMemo(() => {
    if (!loaded) return null;
    const a = loaded.detail.artifact;
    const owner = a.ownerWorkspaceId ? { label: viewOf(a.ownerWorkspaceId).label, active: ownerRow ? ownerRow.status === 'active' : true } : null;
    return artifactPassportView({ detail: loaded.detail, shownVersionId: shownVersion ? shownVersion.id : null, owner, contents: loaded.contents, subjects: loaded.subjects, names, up: loaded.up, down: loaded.down });
  }, [loaded, ownerRow, shownVersion, names]);

  /** One IPC call per action. Promote and roll back send the current version this Passport shows as the compare-and-set value. */
  const send = async (kind: PassportActionKind, v: VersionView, source: SourceChoice | null): Promise<NexusResult<unknown>> => {
    switch (kind) {
      case 'markReady': return nexusClient.versionMarkReady(v.id);
      case 'promote':
      case 'rollback': return nexusClient.versionPromote(v.id, loaded?.detail.artifact.currentVersionId ?? null);
      case 'discard': return nexusClient.versionDiscard(v.id);
      case 'link': return source ? nexusClient.versionLinkSources(v.id, [source.versionId]) : INTERNAL;
    }
  };

  const act = async (kind: PassportActionKind, v: VersionView, source: SourceChoice | null = null) => {
    if (running.current) return;
    const next = beginAction(acts, kind, v.id);
    if (!next) return;
    running.current = true;
    setActs(next);
    requestFocus('result');
    const r = await send(kind, v, source).catch((): NexusResult<unknown> => INTERNAL);
    running.current = false;
    // Refresh every reader even when this Passport has gone (the node changed mid-call).
    if (r.ok || shouldReloadAfterAction(r)) bumpRev();
    if (!alive.current) return;
    if (r.ok) {
      const created = kind === 'link' ? (r.data as { created?: unknown } | null)?.created : undefined;
      setActs((s) => actionSucceeded(s, actionDoneText(kind, v.versionNo, { created: typeof created === 'number' ? created : undefined, sourceLabel: source?.label })));
    } else {
      setActs((s) => actionFailed(s, actionFailureText(kind, r)));
    }
    requestFocus('result');
  };

  /** Cancel (button or Escape) closes the confirmation while nothing runs; focus returns to that version's actions. */
  const cancelConfirm = (versionId: string) => {
    if (acts.pending) return;
    setActs((s) => cancelActionConfirm(s));
    requestFocus('row', versionId);
  };
  const onConfirmKey = (versionId: string) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || acts.pending) return;
    e.preventDefault();
    e.stopPropagation();
    cancelConfirm(versionId);
  };

  if (!view || !loaded || !artifact) {
    return (
      <aside className="nx-passport" aria-labelledby="nx-passport-title">
        <header>
          <p className="nx-passport__kind">Artifact</p>
          <h2 id="nx-passport-title" className="nx-passport__title">{node.name}</h2>
        </header>
        {error ? <p className="nx-passport__note" role="alert">{error}</p> : <p className="nx-muted" role="status">Reading the artifact…</p>}
      </aside>
    );
  }

  const pending = acts.pending;
  const current = artifact.currentVersionId ? versionsById.get(artifact.currentVersionId) ?? null : null;
  return (
    <aside className="nx-passport" aria-labelledby="nx-passport-title">
      <header>
        <p className="nx-passport__kind">{kindLabelIn(artifact.kind, artifact.ownerWorkspaceId)}</p>
        <h2 id="nx-passport-title" className="nx-passport__title">{view.title}</h2>
      </header>
      <section>
        <h2>Artifact</h2>
        <dl>{view.rows.map((r) => <Fragment key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></Fragment>)}</dl>
      </section>
      <section>
        <h2>Versions</h2>
        <ol className="nx-versions">
          {view.versions.map((row) => {
            const v = versionsById.get(row.id) ?? null;
            const allowed = v ? passportActionsFor(v, artifact, ownerActive, canWrite) : [];
            // Hand off: exactly where actionsFor allows it, with writes on, handoffs known to be on, and a receiver.
            const handOff = v !== null && onHandOff !== undefined && ownerRow !== null && canHandOff(actionsFor(v, artifact, ownerActive), canWrite, handoffsAvailable, receiver);
            const confirming = acts.confirming && acts.confirming.versionId === row.id ? acts.confirming : null;
            return (
              <li key={row.id} aria-current={row.current ? 'true' : undefined}>
                <span className="nx-id">v{row.versionNo}</span>
                <span className="nx-apx__version">
                  <span>{row.status}{row.current ? ', current' : ''}{row.shown && !row.current ? (onSpine ? ', shown on the spine' : ', shown here') : ''}</span>
                  {v && kindIsChecked(artifact.kind) && wordOf(v) && <span className="nx-muted">{wordOf(v)}</span>}
                  {row.content && <span className="nx-apx__content">{row.content}</span>}
                  {row.subject && <span className="nx-muted">{row.subject}</span>}
                  {v && (allowed.length > 0 || handOff) && !confirming && (
                    <span className="nx-apx__acts" ref={(el) => { if (el) rowActs.current.set(v.id, el); else rowActs.current.delete(v.id); }}>
                      {allowed.map((a) => {
                        const mine = pending !== null && pending.kind === a.kind && pending.versionId === v.id;
                        const onClick = a.kind === 'discard' || a.kind === 'rollback'
                          ? () => setActs((s) => askActionConfirm(s, a.kind as 'discard' | 'rollback', v.id))
                          : () => { void act(a.kind, v); };
                        return (
                          <Button key={a.kind} variant={a.kind === 'promote' ? 'primary' : 'secondary'} disabled={pending !== null} onClick={onClick}
                            ariaLabel={`${actionLabel(a.kind, mine)} version ${v.versionNo}`}>
                            {actionLabel(a.kind, mine)}
                          </Button>
                        );
                      })}
                      {handOff && ownerRow && (
                        <Button disabled={pending !== null} ariaLabel={`Hand off version ${v.versionNo}`}
                          onClick={() => onHandOff?.({ projectId: project.id, ownerParticipationId: ownerRow.id, artifactId: artifact.id, artifactName: artifact.name, versionId: v.id, versionNo: v.versionNo })}>
                          Hand off…
                        </Button>
                      )}
                    </span>
                  )}
                  {v && confirming && (
                    <div className="nx-apx__confirm" role="group" aria-label={`${actionLabel(confirming.kind, false)} version ${v.versionNo}`} onKeyDown={onConfirmKey(v.id)}>
                      <p>{confirmText(confirming.kind, v.versionNo, current ? current.versionNo : null)}</p>
                      <div className="nx-apx__confirm-actions">
                        <Button variant="primary" disabled={pending !== null} onClick={() => { void act(confirming.kind, v); }}>
                          {actionLabel(confirming.kind, pending !== null && pending.versionId === v.id)}
                        </Button>
                        <button ref={cancelRef} type="button" className="nx-btn" disabled={pending !== null} onClick={() => cancelConfirm(v.id)}><span>Cancel</span></button>
                      </div>
                    </div>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
      {shownVersion && <KindViewer key={shownVersion.id} kind={artifact.kind} version={shownVersion} />}
      {shownVersion && !isApp && <EvidenceSection key={shownVersion.id} version={shownVersion} kind={artifact.kind} checked={kindIsChecked(artifact.kind)} />}
      {shownVersion && isApp && <EvidenceSection key={shownVersion.id} version={shownVersion} kind={artifact.kind} checked preview={{ deployments: deploymentsOf(shownVersion.id) }} />}
      {shownVersion && artifact.ownerWorkspaceId && ownerActive && artifact.status === 'active' && (
        <ActionBar projectId={project.id} workspaceId={artifact.ownerWorkspaceId} title="Actions"
          version={{ id: shownVersion.id, kind: artifact.kind, status: shownVersion.status, buildId: shownBuildId }} />
      )}
      {shownVersion && projectOwned(artifact) && artifact.status === 'active' && workspacesActingOn(artifact.kind, activeWorkspaces).map((w) => (
        <ActionBar key={w} projectId={project.id} workspaceId={w} title={`${viewOf(w).label} actions`}
          version={{ id: shownVersion.id, kind: artifact.kind, status: shownVersion.status }} />
      ))}
      {artifact.kind === 'application' && artifact.ownerWorkspaceId && (
        <DeploymentsSection projectId={project.id} workspaceId={artifact.ownerWorkspaceId} versionIds={loaded.detail.versions.map((x) => x.id)} />
      )}
      <Links title="Sources" links={view.upstream} truncated={view.upstreamTruncated} empty="No sources recorded for this version.">
        {linkable && shownVersion && (
          <div className="nx-apx__link">
            {pending !== null ? (
              <Button disabled>{actionLabel('link', pending.kind === 'link')}</Button>
            ) : (
              <Popover kind="listbox" label={`Versions to link as sources of version ${shownVersion.versionNo}`} triggerClassName="nx-btn" trigger={<span>{actionLabel('link', false)}</span>}
                onOpen={() => setPickerOpened(true)} itemsKey={`${candidates.loaded}:${choices.map((c) => c.versionId).join(',')}`}>
                {(close) => !candidates.loaded ? (
                  <p className="nx-muted nx-apx__pick-note" role="status">Reading versions to link…</p>
                ) : choices.length === 0 ? (
                  <p className="nx-muted nx-apx__pick-note">No ready or active version of another artifact is available to link.</p>
                ) : choices.map((c) => (
                  <button key={c.versionId} type="button" role="option" tabIndex={-1} aria-selected={false} className="nx-menu__item"
                    disabled={pending !== null} onClick={() => { close(); void act('link', shownVersion, c); }}>
                    <span className="nx-menu__text">{c.label}</span>
                    <span className="nx-muted">{c.status}</span>
                  </button>
                ))}
              </Popover>
            )}
            {pickerOpened && candidates.error && <p className="nx-muted">{candidates.error}</p>}
            {pickerOpened && candidates.capped && <p className="nx-muted">Only the {LINK_CANDIDATE_ARTIFACTS} most recently changed artifacts are offered.</p>}
          </div>
        )}
      </Links>
      <Links title="Used by" links={view.downstream} truncated={view.downstreamTruncated} empty="Nothing uses this version yet." />
      {canWrite && (
        <section>
          <h2>Handoffs</h2>
          {!carrying.loaded ? <p className="nx-muted" role="status">Reading handoffs…</p>
            : carrying.rows.length === 0 ? (carrying.ok && !carrying.error && <p className="nx-muted">No handoff carries a version of this artifact.</p>) : (
              <ul className="nx-apx__links">
                {carrying.rows.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="nx-apx__handoff" onClick={() => navigate({ name: 'handoffs', id: c.id })}>{c.title}</button>
                    {' '}<span className="nx-muted">{c.route}, {c.versions}. {c.status}</span>
                  </li>
                ))}
              </ul>
            )}
          {carrying.error && <p className="nx-muted">{carrying.error}</p>}
          {carrying.capped && <p className="nx-muted">Only the {PASSPORT_HANDOFF_READS} most recent handoffs of this project are checked.</p>}
        </section>
      )}
      {pending && <p ref={resultRef} tabIndex={-1} className="nx-apx__status" role="status">{actionPendingText(pending.kind, versionsById.get(pending.versionId)?.versionNo ?? 0)}</p>}
      {!pending && acts.announce && <p ref={resultRef} tabIndex={-1} className="nx-apx__status" role="status">{acts.announce}</p>}
      {!pending && acts.error && <p ref={resultRef} tabIndex={-1} className="nx-passport__note" role="alert">{acts.error}</p>}
      {error && <p className="nx-passport__note" role="alert">{error}</p>}
    </aside>
  );
}
