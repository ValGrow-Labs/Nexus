import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '@/store/store';
import type { ArtifactDetail } from '@shared/nexus/ipc';
import { useArtifactDetail, useArtifactList } from '../data/useArtifacts';
import { useProjectArtifacts } from '../data/useProjectArtifacts';
import { useProjectsLoader } from '../data/useProjects';
import { relativeTime } from '../data/selectors';
import { PlatformNotice } from '../components/PlatformNotice';
import { ArtifactPassport } from '../project/ArtifactPassport';
import { SendHandoffSheet } from '../handoffs/SendHandoffSheet';
import type { HandoffStart } from '../handoffs/handoffModel';
import { usePlatform, selectCanWrite } from '../data/platformStore';
import { kindLabel } from '../project/artifactModel';
import { navigate } from '../router/useRoute';
import { Icon } from '../icons';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { WORKSPACES } from '../workspaces/registry';
import {
  ARTIFACT_KINDS, CAPPED_TEXT, EMPTY_BODY, EMPTY_TITLE, MISSING_BODY, MISSING_TITLE, NO_FILTERS, NO_MATCH_TEXT,
  detailNode, listNotice, pagingOf, projectChoices, sortedRows, staleError, type ArtifactFilters, type ArtifactSort
} from './artifactsPageModel';

const UNAVAILABLE_DETAIL_TEXT = 'Nexus cannot read its saved information right now, so this saved item cannot be shown. Restart the app to try again.';

/** The Saved items page: every saved item the person may read (nexus:artifacts:list) with filters for project,
 *  workspace, kind and status, and, at `#/artifacts/<id>`, a detail pane that reuses the artifact Passport
 *  (its version actions render only while platform writes are on). Nothing is shown that the platform did not
 *  return: no artifacts gives an honest empty state, an unavailable platform the platform notice. */
export function ArtifactsPage({ id }: { id: string | null }) {
  const projects = useStore((s) => s.projects);
  const { status: projectsStatus } = useProjectsLoader();
  const projectsRead = projectsStatus === 'ready';
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const [filters, setFilters] = useState<ArtifactFilters>(NO_FILTERS);
  const set = <K extends keyof ArtifactFilters>(k: K, v: ArtifactFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const list = useArtifactList(filters);
  const rows = useMemo(() => sortedRows(list.rows, projectNames, filters.sort, projectsRead), [list.rows, projectNames, filters.sort, projectsRead]);
  const notice = listNotice(list, filters);
  const stale = staleError(list);
  const paging = pagingOf(list, list.limit);
  const now = Date.now();

  // "Show more" keeps focus: on the button while more can come, else on the count line once the button is gone.
  const countRef = useRef<HTMLParagraphElement | null>(null);
  const [moreAsked, setMoreAsked] = useState(false);
  useEffect(() => {
    if (!moreAsked || list.loading) return;
    setMoreAsked(false);
    if (paging !== 'more') countRef.current?.focus();
  }, [moreAsked, list.loading, paging]);
  const showMore = () => { if (list.loading) return; setMoreAsked(true); list.showMore(); };

  return (
    <div className="nx-page">
      <header className="nx-pagehead">
        <span className="nx-pagehead__icon"><Icon name="artifacts" size={20} /></span>
        <h1 tabIndex={-1}>Saved items</h1>
      </header>
      <PlatformNotice />
      <div className="nx-toolbar" role="group" aria-label="Filter saved items">
        <select className="nx-input nx-focusable" value={filters.projectId} onChange={(e) => set('projectId', e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projectChoices(projects).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="nx-input nx-focusable" value={filters.workspaceId} onChange={(e) => set('workspaceId', e.target.value)} aria-label="Workspace">
          <option value="">All workspaces</option>
          {WORKSPACES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        </select>
        <select className="nx-input nx-focusable" value={filters.kind} onChange={(e) => set('kind', e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {ARTIFACT_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </select>
        <select className="nx-input nx-focusable" value={filters.status} onChange={(e) => set('status', e.target.value as ArtifactFilters['status'])} aria-label="Archived or not">
          <option value="">Archived or not</option>
          <option value="active">Not archived</option>
          <option value="archived">Archived</option>
        </select>
        <select className="nx-input nx-focusable" value={filters.sort} onChange={(e) => set('sort', e.target.value as ArtifactSort)} aria-label="Sort">
          <option value="recent">Recently changed</option>
          <option value="name">Name</option>
        </select>
      </div>
      <div className="nx-afx" data-detail={id ? 'open' : undefined}>
        <section className="nx-afx__list" aria-label="List of saved items">
          {notice?.kind === 'loading' && <p className="nx-muted" role="status">Reading your saved items…</p>}
          {/* While the platform is off the PlatformNotice above says why; the list adds nothing (notice kind 'unavailable'). */}
          {notice?.kind === 'error' && (
            <div className="nx-afx__line" role="alert">
              <span>{notice.text}</span>
              {notice.retry && <Button variant="quiet" icon="refresh" onClick={list.reload}>Try again</Button>}
            </div>
          )}
          {notice?.kind === 'empty' && (
            <EmptyState level={2} icon="artifacts" title={EMPTY_TITLE} body={EMPTY_BODY}
              actions={<Button variant="primary" icon="projects" onClick={() => navigate({ name: 'projects' })}>Open your projects</Button>} />
          )}
          {notice?.kind === 'no-match' && (
            <div className="nx-afx__line" role="status">
              <span>{NO_MATCH_TEXT}</span>
              <Button variant="quiet" onClick={() => setFilters((f) => ({ ...NO_FILTERS, sort: f.sort }))}>Clear filters</Button>
            </div>
          )}
          {stale && (
            <div className="nx-afx__line" role="alert">
              <span>{stale.text}</span>
              {stale.retry && <Button variant="quiet" icon="refresh" onClick={list.reload}>Try again</Button>}
            </div>
          )}
          {rows.length > 0 && (
            <ul className="nx-afx__rows">
              {rows.map((r) => (
                <li key={r.id}>
                  <button type="button" className="nx-row nx-focusable nx-afx__row" aria-current={r.id === id ? 'true' : undefined}
                    onClick={() => navigate({ name: 'artifacts', id: r.id })}>
                    <ProvenanceMark slot={r.hueSlot} size={10} />
                    <span className="nx-row__main">
                      <span className="nx-afx__name">{r.name}</span>
                      <span className="nx-row__meta">{r.kind} · {r.workspace}{r.project && <> · {r.project}</>}</span>
                    </span>
                    <span className="nx-row__side">
                      <span className="nx-afx__version">{r.version}{r.archived ? ', archived' : ''}</span>
                      <span className="nx-row__time nx-id">Changed {relativeTime(r.updatedAt, now)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {rows.length > 0 && (
            <div className="nx-afx__foot">
              <p ref={countRef} tabIndex={-1} className="nx-muted nx-afx__count" role="status">
                {list.loading ? 'Reading your saved items…' : `${rows.length} ${rows.length === 1 ? 'saved item' : 'saved items'}${list.truncated ? ' shown' : ''}`}
              </p>
              {paging === 'more' && <Button onClick={showMore}>{list.loading && moreAsked ? 'Showing more…' : 'Show more'}</Button>}
              {paging === 'capped' && <p className="nx-muted">{CAPPED_TEXT}</p>}
            </div>
          )}
        </section>
        {id && (
          <section className="nx-afx__detail" aria-label="Saved item details">
            <ArtifactDetailPane key={id} id={id} projects={projects} projectsRead={projectsRead} />
          </section>
        )}
      </div>
    </div>
  );
}

type P = { id: string; name: string; rootPath: string };

function ArtifactDetailPane({ id, projects, projectsRead }: { id: string; projects: P[]; projectsRead: boolean }) {
  const d = useArtifactDetail(id);
  const back = <Button variant="quiet" icon="chevronLeft" onClick={() => navigate({ name: 'artifacts' })}>All saved items</Button>;
  if (d.status === 'ready' && d.detail) {
    return <ArtifactDetailBody detail={d.detail} projects={projects} projectsRead={projectsRead} back={back} stale={d.error ? { text: d.error, retry: d.retry, reload: d.reload } : null} />;
  }
  return (
    <div className="nx-afx__pane">
      <div className="nx-afx__bar">{back}</div>
      {d.status === 'loading' && <p className="nx-muted" role="status">Reading this saved item…</p>}
      {d.status === 'missing' && <EmptyState level={2} icon="artifacts" title={MISSING_TITLE} body={MISSING_BODY} />}
      {d.status === 'unavailable' && <p className="nx-muted" role="status">{UNAVAILABLE_DETAIL_TEXT}</p>}
      {d.status === 'error' && (
        <div className="nx-afx__line" role="alert">
          <span>{d.error}</span>
          {d.retry && <Button variant="quiet" icon="refresh" onClick={d.reload}>Try again</Button>}
        </div>
      )}
    </div>
  );
}

function ArtifactDetailBody({ detail, projects, projectsRead, back, stale }: {
  detail: ArtifactDetail; projects: P[]; projectsRead: boolean; back: ReactNode;
  stale: { text: string; retry: boolean; reload: () => void } | null;
}) {
  const projectId = detail.artifact.projectId;
  const project = projects.find((p) => p.id === projectId) ?? null;
  // The project's other artifacts: names for the lineage links and the Passport's link picker.
  const summaries = useProjectArtifacts(projectId);
  const node = useMemo(() => detailNode(detail), [detail]);
  const canWrite = usePlatform(selectCanWrite);
  // The send sheet opens from the details' "Send to another workspace…" and is hosted here.
  const [handoffStart, setHandoffStart] = useState<HandoffStart | null>(null);
  useEffect(() => { if (!canWrite) setHandoffStart(null); }, [canWrite]);
  return (
    <div className="nx-afx__pane">
      <div className="nx-afx__bar">
        {back}
        {project
          ? <Button icon="projects" onClick={() => navigate({ name: 'project', id: project.id, tool: 'bench' })}>Open project</Button>
          : projectsRead && <span className="nx-muted">Removed project</span>}
      </div>
      {stale && (
        <div className="nx-afx__line" role="alert">
          <span>{stale.text}</span>
          {stale.retry && <Button variant="quiet" icon="refresh" onClick={stale.reload}>Try again</Button>}
        </div>
      )}
      <ArtifactPassport key={detail.artifact.id} project={{ id: projectId, rootPath: project ? project.rootPath : '' }} node={node} artifacts={summaries.artifacts} onSpine={false}
        onHandOff={canWrite ? setHandoffStart : undefined} />
      {handoffStart && canWrite && <SendHandoffSheet start={handoffStart} artifacts={summaries.artifacts} onClose={() => setHandoffStart(null)} />}
    </div>
  );
}
