import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactDetail, NexusResult, SendHandoffView } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { usePlatform, selectCanWrite } from '../data/platformStore';
import { useParticipationIndex } from '../data/useParticipations';
import { errorCopy } from '../data/errorCopy';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import type { ArtifactSummary } from '../project/spineModel';
import {
  NOTE_MAX, SEND_MAX_SUBJECTS, SUBJECT_CANDIDATE_ARTIFACTS, TITLE_MAX, beginSend, buildSendRequest, defaultHandoffTitle, fromChoice,
  initialSendState, keepOffered, offeredIds, sendBlocker, sendFailed, sendFailureText, sendSucceeded, sentText, shouldReloadAfterHandoffAction, subjectArtifactIds,
  subjectChoices, toChoices, toggleSubject, type HandoffStart, type SendState
} from './handoffModel';

type Subjects = { details: ArtifactDetail[]; loaded: boolean; error: string | null };
const NO_SUBJECTS: Subjects = { details: [], loaded: false, error: null };

/** The sender's artifacts with every version, read when the sheet opens (and again on rev): the subject
 *  choices come only from these answers. Never rejects. */
function useSubjectDetails(ids: string[]): Subjects {
  const rev = usePlatform((s) => s.rev);
  const key = ids.join(',');
  const [state, setState] = useState<Subjects>(NO_SUBJECTS);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const reads = await Promise.all(key ? key.split(',').map((id) => nexusClient.artifactGet(id)) : []);
        if (!alive) return;
        setState({ details: reads.flatMap((r) => (r.ok ? [r.data] : [])), loaded: true,
          error: reads.some((r) => !r.ok) ? 'Nexus could not read some versions, so they are not offered.' : null });
      } catch {
        if (alive) setState((s) => ({ details: s.details, loaded: true, error: errorCopy('internal').text }));
      }
    })();
    return () => { alive = false; };
  }, [key, rev]);
  return state;
}

/** Send versions of the owner workspace's artifacts to another active workspace of the same project, by
 *  reference. Renders only while platform writes are on and handoffs are on. */
export function SendHandoffSheet({ start, artifacts, onClose }: {
  start: HandoffStart;
  /** The project's artifact summaries: which artifacts the sending workspace owns. */
  artifacts: ArtifactSummary[];
  onClose: () => void;
}) {
  const canWrite = usePlatform(selectCanWrite);
  // Availability is checked when the sheet opens only: a send refused as handoffs_unavailable flips the store, and the
  // sheet must stay to show that refusal (and keep focus on it).
  const [openable] = useState(() => usePlatform.getState().handoffsAvailable === true);
  const bumpRev = usePlatform((s) => s.bumpRev);
  const noteHandoffs = usePlatform((s) => s.noteHandoffs);
  const setHandoffView = useNexusUi((s) => s.setHandoffView);
  const idx = useParticipationIndex();
  const from = useMemo(() => fromChoice(idx, start.projectId, start.ownerParticipationId), [idx, start.projectId, start.ownerParticipationId]);
  const to = useMemo(() => (from ? toChoices(idx, start.projectId, from.participationId) : []), [idx, start.projectId, from]);
  const { ids, capped } = useMemo(() => {
    const own = subjectArtifactIds(artifacts, start.projectId, start.ownerParticipationId);
    // The artifact in view is always read, even before the project's summaries arrive.
    return own.ids.includes(start.artifactId) ? own : { ids: [start.artifactId, ...own.ids].slice(0, SUBJECT_CANDIDATE_ARTIFACTS), capped: own.capped };
  }, [artifacts, start.projectId, start.ownerParticipationId, start.artifactId]);
  const subjects = useSubjectDetails(ids);
  const choices = useMemo(() => subjectChoices(subjects.details, start.projectId, start.ownerParticipationId), [subjects.details, start.projectId, start.ownerParticipationId]);

  const [state, setState] = useState<SendState>(() => initialSendState(to, start.versionId, defaultHandoffTitle(start.artifactName, start.versionNo)));
  // The participations were re-read: a receiving workspace that is no longer offered falls back to the first one.
  useEffect(() => {
    setState((s) => (s.pending || s.sent || to.some((c) => c.participationId === s.toParticipationId) ? s : { ...s, toParticipationId: to[0]?.participationId ?? null }));
  }, [to]);

  // Once the choices are read, a chosen version that is not offered is dropped: the count and the request agree.
  useEffect(() => { if (subjects.loaded) setState((s) => keepOffered(s, choices)); }, [subjects.loaded, choices]);

  const running = useRef(false);
  const alive = useRef(true);
  // The prefilled title is selected the first time the field takes focus, so typing replaces it.
  const titleSelected = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const pendingRef = useRef(false);
  pendingRef.current = state.pending;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const safeClose = useCallback(() => { if (!pendingRef.current) closeRef.current(); }, []);
  // Focus rests on the status (or alert) line while sending and once the answer is in.
  const resultRef = useRef<HTMLParagraphElement | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => { if (focusTick > 0) resultRef.current?.focus(); }, [focusTick]);

  const blocker = sendBlocker(state, choices, to);
  const request = from ? buildSendRequest(start.projectId, from.participationId, state, choices, to) : null;

  const submit = async () => {
    if (running.current || !from) return;
    const req = buildSendRequest(start.projectId, from.participationId, state, choices, to);
    const next = beginSend(state, req !== null);
    if (!next || !req) return;
    running.current = true;
    setState(next);
    setFocusTick((n) => n + 1);
    let r: NexusResult<SendHandoffView>;
    try {
      r = await nexusClient.handoffSend(req);
    } catch {
      r = { ok: false, code: 'internal', message: 'The request could not be completed.' };
    }
    running.current = false;
    noteHandoffs(r);
    // Refresh every reader even when the sheet has gone in the meantime.
    if (r.ok || shouldReloadAfterHandoffAction(r)) bumpRev();
    if (!alive.current) return;
    if (r.ok) {
      const sent = { handoffId: r.data.handoff.id, toLabel: to.find((c) => c.participationId === req.toParticipationId)?.label ?? 'the other workspace', created: r.data.created };
      setState((s) => sendSucceeded(s, sent));
    } else {
      const text = sendFailureText(r);
      setState((s) => sendFailed(s, text));
    }
    setFocusTick((n) => n + 1);
  };

  const openSent = () => {
    if (!state.sent || !from) return;
    setHandoffView({ box: 'sent', workspaceId: from.workspaceId, status: '' });
    const id = state.sent.handoffId;
    closeRef.current();
    navigate({ name: 'handoffs', id });
  };

  if (!canWrite || !openable) return null;
  const pending = state.pending;
  const done = state.sent !== null;
  const chosen = new Set(state.versionIds);
  const chosenCount = offeredIds(state.versionIds, choices).length;
  const full = chosenCount >= SEND_MAX_SUBJECTS;
  return (
    <Sheet open onClose={safeClose} side="right" labelledBy="nx-shx-title">
      <form className="nx-shx" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <header className="nx-shx__head">
          <p className="nx-shx__kind">Handoff</p>
          <h2 id="nx-shx-title" className="nx-shx__title">Send to another workspace</h2>
          <p className="nx-shx__lead">The other workspace gets a pointer to these versions. Nothing is copied.</p>
        </header>

        <div className="nx-shx__field">
          <span className="nx-shx__label">From</span>
          <p className="nx-shx__value">{from ? from.label : 'The workspace that owns this saved item is no longer part of the project, so it cannot send anything.'}</p>
        </div>

        {from && (
          <label className="nx-shx__field">
            <span className="nx-shx__label">To</span>
            <select className="nx-input nx-shx__control" value={state.toParticipationId ?? ''} disabled={pending || done || to.length === 0}
              onChange={(e) => { const v = e.target.value; setState((s) => (s.pending || s.sent ? s : { ...s, toParticipationId: v, error: null })); }}>
              {to.map((c) => <option key={c.participationId} value={c.participationId}>{c.label}</option>)}
            </select>
            {to.length === 0 && <span className="nx-muted">This project is not in any other workspace. Add it to one from the project page first.</span>}
          </label>
        )}

        {from && (
          <fieldset className="nx-shx__field" disabled={pending || done}>
            <legend className="nx-shx__label">Versions ({chosenCount} of at most {SEND_MAX_SUBJECTS})</legend>
            {!subjects.loaded ? (
              <p className="nx-muted" role="status">Reading the versions…</p>
            ) : choices.length === 0 ? (
              <p className="nx-muted">None of this workspace's saved items has a version that is ready or in use, so there is nothing to send yet.</p>
            ) : (
              <ul className="nx-shx__list" aria-label="Versions to send">
                {choices.map((c) => (
                  <li key={c.versionId}>
                    <label className="nx-shx__choice">
                      <input type="checkbox" checked={chosen.has(c.versionId)} disabled={!chosen.has(c.versionId) && full}
                        onChange={() => setState((s) => toggleSubject(s, c.versionId))} />
                      <span className="nx-shx__subject">
                        <span>{c.label}</span>
                        <span className="nx-muted" title={`Reference ${c.hash}`}>{c.status}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {subjects.error && <p className="nx-muted">{subjects.error}</p>}
            {capped && <p className="nx-muted">Only the {SUBJECT_CANDIDATE_ARTIFACTS} saved items changed most recently in this workspace are offered.</p>}
          </fieldset>
        )}

        {from && (
          <label className="nx-shx__field">
            <span className="nx-shx__label">Title</span>
            <input className="nx-input nx-shx__control" maxLength={TITLE_MAX} value={state.title} disabled={pending || done}
              onFocus={(e) => { if (!titleSelected.current) { titleSelected.current = true; e.currentTarget.select(); } }}
              onChange={(e) => { const title = e.target.value; setState((s) => (s.pending || s.sent ? s : { ...s, title, error: null })); }} />
          </label>
        )}
        {from && (
          <label className="nx-shx__field">
            <span className="nx-shx__label">Note (optional)</span>
            <textarea className="nx-input nx-shx__control nx-shx__note" maxLength={NOTE_MAX} rows={3} value={state.note} disabled={pending || done}
              onChange={(e) => { const note = e.target.value; setState((s) => (s.pending || s.sent ? s : { ...s, note, error: null })); }} />
          </label>
        )}

        {from && !pending && !done && blocker && subjects.loaded && <p className="nx-muted nx-shx__why">{blocker}</p>}
        {pending && <p ref={resultRef} tabIndex={-1} className="nx-shx__status" role="status">Sending…</p>}
        {!pending && state.sent && <p ref={resultRef} tabIndex={-1} className="nx-shx__status" role="status">{sentText(state.sent.toLabel, state.sent.created)}</p>}
        {!pending && state.error && <p ref={resultRef} tabIndex={-1} className="nx-passport__note" role="alert">{state.error}</p>}

        <div className="nx-shx__actions">
          {done ? (
            <>
              <Button variant="primary" onClick={openSent}>Open handoff</Button>
              <Button onClick={safeClose}>Close</Button>
            </>
          ) : (
            <>
              {from && <Button type="submit" variant="primary" disabled={pending || request === null}>{pending ? 'Sending…' : 'Send'}</Button>}
              <Button disabled={pending} onClick={safeClose}>Cancel</Button>
            </>
          )}
        </div>
      </form>
    </Sheet>
  );
}
