import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useStore } from '@/store/store';
import type { HandoffDetailView, NexusResult } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { usePlatform, selectCanWrite } from '../data/platformStore';
import { useHandoffDetail, useHandoffList, useReceiptArtifact } from '../data/useHandoffs';
import { useProjectsLoader } from '../data/useProjects';
import { relativeTime } from '../data/selectors';
import { PlatformNotice } from '../components/PlatformNotice';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { Icon } from '../icons';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { WORKSPACES } from '../workspaces/registry';
import {
  BOX_LABEL, CAPPED_TEXT, EMPTY_BODY, EMPTY_TITLE, HANDOFFS_LEAD, HANDOFF_BOXES, HANDOFF_STATUSES, IDLE_HANDOFF_ACTIONS, MISSING_BODY,
  MISSING_TITLE, NOTE_MAX, NO_MATCH_TEXT, REMOVED_PROJECT, UNAVAILABLE_LIST_TEXT, askHandoffConfirm, beginHandoffAction, cancelHandoffConfirm,
  declineNoteArg, detailActions, handoffActionFailed, handoffActionLabel, handoffActionSucceeded, handoffConfirmText, handoffDetailRows,
  handoffDoneText, handoffFailureText, handoffGroups, handoffListNotice, handoffPaging, handoffPendingText, handoffRow, handoffStatusOption,
  receiptText, setDeclineNote, shouldReloadAfterHandoffAction, sidesFor, sideText, staleHandoffError, validNote,
  type HandoffActionKind, type HandoffActionState, type HandoffBox, type HandoffView
} from '../handoffs/handoffModel';

const INTERNAL_FAIL = { ok: false as const, code: 'internal' as const, message: 'The request could not be completed.' };

/** The Handoffs page: the inbox and sent box of each workspace (nexus:handoffs:list), and, at
 *  `#/handoffs/<id>`, one handoff with its subjects shown by reference and the answers the viewed side may
 *  give. With handoffs off (schema v8 not in place) only this page says so; the rest of the app is unaffected. */
export function HandoffsPage({ id }: { id: string | null }) {
  const projects = useStore((s) => s.projects);
  const { status: projectsStatus } = useProjectsLoader();
  const projectsRead = projectsStatus === 'ready';
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const view = useNexusUi((s) => s.handoffView);
  const setView = useNexusUi((s) => s.setHandoffView);
  const set = <K extends keyof HandoffView>(k: K, v: HandoffView[K]) => setView({ ...view, [k]: v });
  const list = useHandoffList(view);
  const groups = useMemo(() => handoffGroups(list.rows, view), [list.rows, view]);
  const notice = handoffListNotice(list, view);
  const stale = staleHandoffError(list);
  const paging = handoffPaging(list, list.limit);
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const now = Date.now();

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
        <span className="nx-pagehead__icon"><Icon name="handoffs" size={20} /></span>
        <h1 tabIndex={-1}>Handoffs</h1>
      </header>
      <p className="nx-hfx__lead">{HANDOFFS_LEAD}</p>
      <PlatformNotice />
      <div className="nx-toolbar" role="group" aria-label="Choose which handoffs to see">
        <div className="nx-hfx__boxes" role="group" aria-label="Received or sent">
          {HANDOFF_BOXES.map((b: HandoffBox) => (
            <button key={b} type="button" className="nx-btn nx-hfx__box" aria-pressed={view.box === b} onClick={() => set('box', b)}><span>{BOX_LABEL[b]}</span></button>
          ))}
        </div>
        <select className="nx-input nx-focusable" value={view.workspaceId} onChange={(e) => set('workspaceId', e.target.value)} aria-label="Workspace">
          <option value="">All workspaces</option>
          {WORKSPACES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        </select>
        <select className="nx-input nx-focusable" value={view.status} onChange={(e) => set('status', e.target.value as HandoffView['status'])} aria-label="Answer">
          <option value="">Any answer</option>
          {HANDOFF_STATUSES.map((s) => <option key={s} value={s}>{handoffStatusOption(s)}</option>)}
        </select>
      </div>
      <div className="nx-hfx" data-detail={id ? 'open' : undefined}>
        <section className="nx-hfx__list" aria-label="Handoff list">
          {notice?.kind === 'loading' && <p className="nx-muted" role="status">Reading the handoffs…</p>}
          {notice?.kind === 'handoffs-off' && <p className="nx-hfx__off" role="status">{notice.text}</p>}
          {notice?.kind === 'unavailable' && <p className="nx-muted" role="status">{UNAVAILABLE_LIST_TEXT}</p>}
          {notice?.kind === 'error' && (
            <div className="nx-hfx__line" role="alert">
              <span>{notice.text}</span>
              {notice.retry && <Button variant="quiet" icon="refresh" onClick={list.reload}>Try again</Button>}
            </div>
          )}
          {notice?.kind === 'empty' && (
            <EmptyState level={2} icon="handoffs" title={EMPTY_TITLE} body={EMPTY_BODY[view.box]}
              actions={<Button variant="primary" icon="artifacts" onClick={() => navigate({ name: 'artifacts' })}>Open saved items</Button>} />
          )}
          {notice?.kind === 'no-match' && (
            <div className="nx-hfx__line" role="status">
              <span>{NO_MATCH_TEXT}</span>
              <Button variant="quiet" onClick={() => setView({ box: view.box, workspaceId: '', status: '' })}>Show every workspace and answer</Button>
            </div>
          )}
          {stale && (
            <div className="nx-hfx__line" role="alert">
              <span>{stale.text}</span>
              {stale.retry && <Button variant="quiet" icon="refresh" onClick={list.reload}>Try again</Button>}
            </div>
          )}
          {groups.map((g) => (
            <section key={g.workspaceId ?? 'all'} className="nx-hfx__group" aria-label={g.title}>
              <h2 className="nx-hfx__group-title">{g.workspaceId && <ProvenanceMark slot={g.hueSlot} size={10} />}{g.title}</h2>
              <ul className="nx-hfx__rows">
                {g.rows.map((h) => {
                  const r = handoffRow(h, projectNames, projectsRead);
                  return (
                    <li key={h.id}>
                      <button type="button" className="nx-row nx-focusable nx-hfx__row" aria-current={h.id === id ? 'true' : undefined}
                        onClick={() => navigate({ name: 'handoffs', id: h.id })}>
                        <span className="nx-row__main">
                          <span className="nx-hfx__name">{r.title}</span>
                          <span className="nx-row__meta">{r.fromLabel} to {r.toLabel} · {r.subjects}{r.project && <> · {r.project}</>}</span>
                        </span>
                        <span className="nx-row__side">
                          <span className="nx-hfx__status">{r.status}</span>
                          <span className="nx-row__time nx-id">{relativeTime(r.changedAt, now)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {shown > 0 && (
            <div className="nx-hfx__foot">
              <p ref={countRef} tabIndex={-1} className="nx-muted nx-hfx__count" role="status">
                {list.loading ? 'Reading handoffs…' : `${shown} ${shown === 1 ? 'handoff' : 'handoffs'}${list.truncated ? ' shown' : ''}`}
              </p>
              {paging === 'more' && <Button onClick={showMore}>{list.loading && moreAsked ? 'Showing more…' : 'Show more'}</Button>}
              {paging === 'capped' && <p className="nx-muted">{CAPPED_TEXT}</p>}
            </div>
          )}
        </section>
        {id && (
          <section className="nx-hfx__detail" aria-label="Handoff details">
            <HandoffDetailPane key={id} id={id} view={view} projects={projects} projectsRead={projectsRead} />
          </section>
        )}
      </div>
    </div>
  );
}

type P = { id: string; name: string };

function HandoffDetailPane({ id, view, projects, projectsRead }: { id: string; view: HandoffView; projects: P[]; projectsRead: boolean }) {
  const d = useHandoffDetail(id);
  const back = <Button variant="quiet" icon="chevronLeft" onClick={() => navigate({ name: 'handoffs' })}>All handoffs</Button>;
  if (d.status === 'ready' && d.detail) {
    return <HandoffDetailBody h={d.detail} view={view} projects={projects} projectsRead={projectsRead} back={back} apply={d.apply}
      stale={d.error ? { text: d.error, retry: d.retry, reload: d.reload } : null} />;
  }
  return (
    <div className="nx-hfx__pane">
      <div className="nx-hfx__bar">{back}</div>
      {d.status === 'loading' && <p className="nx-muted" role="status">Reading the handoff…</p>}
      {d.status === 'missing' && <EmptyState level={2} icon="handoffs" title={MISSING_TITLE} body={MISSING_BODY} />}
      {d.status === 'unavailable' && <p className="nx-hfx__off" role="status">{d.notice}</p>}
      {d.status === 'error' && (
        <div className="nx-hfx__line" role="alert">
          <span>{d.error}</span>
          {d.retry && <Button variant="quiet" icon="refresh" onClick={d.reload}>Try again</Button>}
        </div>
      )}
    </div>
  );
}

function HandoffDetailBody({ h, view, projects, projectsRead, back, apply, stale }: {
  h: HandoffDetailView; view: HandoffView; projects: P[]; projectsRead: boolean; back: ReactNode;
  apply: (r: NexusResult<HandoffDetailView>) => void;
  stale: { text: string; retry: boolean; reload: () => void } | null;
}) {
  const canWrite = usePlatform(selectCanWrite);
  const bumpRev = usePlatform((s) => s.bumpRev);
  const noteHandoffs = usePlatform((s) => s.noteHandoffs);
  const rows = useMemo(() => handoffDetailRows(h), [h]);
  const project = projects.find((p) => p.id === h.projectId) ?? null;
  const receiptId = useReceiptArtifact(h.status === 'accepted' ? h.receiptVersionId : null);
  const sides = sidesFor(h, view);
  const actions = detailActions(h, view, canWrite);
  const now = Date.now();

  const [acts, setActs] = useState<HandoffActionState>(IDLE_HANDOFF_ACTIONS);
  // The guard against a second submit before React re-renders.
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Opening a confirmation focuses Cancel, never the final button.
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (acts.confirming && !acts.pending) cancelRef.current?.focus(); }, [acts.confirming, acts.pending]);
  // While an answer runs and once it ends, focus rests on the status (or alert) line; a cancelled
  // confirmation returns it to the answers.
  const resultRef = useRef<HTMLParagraphElement | null>(null);
  const actsRef = useRef<HTMLDivElement | null>(null);
  const [focusReq, setFocusReq] = useState<{ to: 'result' | 'acts'; n: number } | null>(null);
  const requestFocus = (to: 'result' | 'acts') => setFocusReq((f) => ({ to, n: (f?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!focusReq) return;
    if (focusReq.to === 'result') resultRef.current?.focus();
    else actsRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [focusReq]);

  /** One IPC call per answer. */
  const send = (kind: HandoffActionKind, note: string): Promise<NexusResult<HandoffDetailView>> => {
    switch (kind) {
      case 'accept': return nexusClient.handoffAccept(h.id);
      case 'decline': return nexusClient.handoffDecline(h.id, declineNoteArg(note));
      case 'withdraw': return nexusClient.handoffWithdraw(h.id);
    }
  };

  const act = async (kind: HandoffActionKind) => {
    if (running.current) return;
    const next = beginHandoffAction(acts, kind);
    if (!next) return;
    running.current = true;
    setActs(next);
    requestFocus('result');
    let r: NexusResult<HandoffDetailView>;
    try {
      r = await send(kind, acts.note);
    } catch {
      r = INTERNAL_FAIL;
    }
    running.current = false;
    noteHandoffs(r);
    // Refresh every reader even when this pane has gone (the address changed mid-call).
    if (r.ok || shouldReloadAfterHandoffAction(r)) bumpRev();
    if (!alive.current) return;
    if (r.ok) {
      apply(r);
      const text = handoffDoneText(kind, rows.toLabel);
      setActs((s) => handoffActionSucceeded(s, text));
    } else {
      const text = handoffFailureText(r);
      setActs((s) => handoffActionFailed(s, text));
    }
    requestFocus('result');
  };

  /** Cancel (button or Escape) closes the confirmation while nothing runs; focus returns to the answers. */
  const cancelConfirm = () => {
    if (acts.pending) return;
    setActs((s) => cancelHandoffConfirm(s));
    requestFocus('acts');
  };
  const onConfirmKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || acts.pending) return;
    e.preventDefault();
    e.stopPropagation();
    cancelConfirm();
  };

  const pending = acts.pending;
  const confirming = acts.confirming;
  const hint = actions.length > 0 ? sideText(sides, rows.fromLabel, rows.toLabel) : null;
  return (
    <div className="nx-hfx__pane">
      <div className="nx-hfx__bar">
        {back}
        {project
          ? <Button icon="projects" onClick={() => navigate({ name: 'project', id: project.id, tool: 'bench' })}>Open project</Button>
          : projectsRead && <span className="nx-muted">{REMOVED_PROJECT}</span>}
      </div>
      {stale && (
        <div className="nx-hfx__line" role="alert">
          <span>{stale.text}</span>
          {stale.retry && <Button variant="quiet" icon="refresh" onClick={stale.reload}>Try again</Button>}
        </div>
      )}
      <article className="nx-hfx__card" aria-labelledby="nx-hfx-title">
        <header className="nx-hfx__head">
          <p className="nx-hfx__kind">Handoff</p>
          <h2 id="nx-hfx-title" className="nx-hfx__title">{rows.title}</h2>
          <p className="nx-hfx__state">{rows.status}</p>
        </header>
        <dl className="nx-hfx__facts">
          <dt>From</dt><dd><ProvenanceMark slot={rows.fromHue} size={10} /> {rows.fromLabel}</dd>
          <dt>To</dt><dd><ProvenanceMark slot={rows.toHue} size={10} /> {rows.toLabel}</dd>
          {project && <><dt>Project</dt><dd>{project.name}</dd></>}
          <dt>Sent</dt><dd><time dateTime={new Date(rows.sentAt).toISOString()}>{relativeTime(rows.sentAt, now)}</time></dd>
          {rows.respondedAt !== null && <><dt>Answered</dt><dd><time dateTime={new Date(rows.respondedAt).toISOString()}>{relativeTime(rows.respondedAt, now)}</time></dd></>}
          {rows.note && <><dt>Note</dt><dd className="nx-hfx__text">{rows.note}</dd></>}
          {rows.responseNote && <><dt>Answer note</dt><dd className="nx-hfx__text">{rows.responseNote}</dd></>}
        </dl>
        <section>
          <h3 className="nx-hfx__sub">Versions in this handoff</h3>
          <ol className="nx-hfx__subjects">
            {rows.subjects.map((s) => (
              <li key={s.versionId}>
                <span className="nx-hfx__name">{s.label}</span>
                <span title={`Reference ${s.hash}`}>{s.version}, {s.status}</span>
                {s.newer && <span className="nx-muted">{s.newer}</span>}
              </li>
            ))}
          </ol>
        </section>
        {h.status === 'accepted' && (
          <section className="nx-hfx__receipt">
            <h3 className="nx-hfx__sub">What was received</h3>
            <p>{receiptText(rows.toLabel)}</p>
            <div className="nx-hfx__bar">
              {receiptId && <Button icon="artifacts" onClick={() => navigate({ name: 'artifacts', id: receiptId })}>Open the received item</Button>}
              {project && <Button icon="projects" onClick={() => navigate({ name: 'project', id: project.id, tool: 'bench' })}>See it on the project timeline</Button>}
            </div>
          </section>
        )}
        {actions.length > 0 && !confirming && (
          <div className="nx-hfx__acts" ref={actsRef}>
            {hint && <p className="nx-muted">{hint}</p>}
            {actions.map((k) => (
              <Button key={k} variant={k === 'accept' ? 'primary' : 'secondary'} disabled={pending !== null}
                onClick={k === 'accept' ? () => { void act('accept'); } : () => setActs((s) => askHandoffConfirm(s, k as 'decline' | 'withdraw'))}>
                {handoffActionLabel(k, pending === k)}
              </Button>
            ))}
          </div>
        )}
        {confirming && (
          <div className="nx-hfx__confirm" role="group" aria-label={`${handoffActionLabel(confirming, false)} this handoff`} onKeyDown={onConfirmKey}>
            <p>{handoffConfirmText(confirming, rows.fromLabel, rows.toLabel)}</p>
            {confirming === 'decline' && (
              <label className="nx-hfx__field">
                <span>Note to the sender (optional)</span>
                <textarea className="nx-input" rows={3} maxLength={NOTE_MAX} value={acts.note} disabled={pending !== null}
                  onChange={(e) => { const note = e.target.value; setActs((s) => setDeclineNote(s, note)); }} />
              </label>
            )}
            <div className="nx-hfx__confirm-actions">
              <Button variant="primary" disabled={pending !== null || (confirming === 'decline' && !validNote(acts.note))} onClick={() => { void act(confirming); }}>
                {handoffActionLabel(confirming, pending === confirming)}
              </Button>
              <button ref={cancelRef} type="button" className="nx-btn" disabled={pending !== null} onClick={cancelConfirm}><span>Cancel</span></button>
            </div>
          </div>
        )}
        {pending && <p ref={resultRef} tabIndex={-1} className="nx-hfx__status" role="status">{handoffPendingText(pending)}</p>}
        {!pending && acts.announce && <p ref={resultRef} tabIndex={-1} className="nx-hfx__status" role="status">{acts.announce}</p>}
        {!pending && acts.error && <p ref={resultRef} tabIndex={-1} className="nx-passport__note" role="alert">{acts.error}</p>}
      </article>
    </div>
  );
}
