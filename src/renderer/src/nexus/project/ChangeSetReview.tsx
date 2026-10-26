import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PreviewView, ReviewDecision } from '@shared/nexus/ipc';
import type { VersionStatus } from '@shared/nexus/platform';
import { nexusClient } from '../data/nexusClient';
import { agentFailText } from '../agent/agentModel';
import { useProjectArtifacts } from '../data/useProjectArtifacts';
import { usePlatform } from '../data/platformStore';
import { useChangeChecks, useRepoStatus } from '../data/useAgents';
import { useExecStore, useRead, withIntent } from '../data/useExecution';
import { Button } from '../ui/Button';
import { EvidenceSection } from './EvidenceSection';
import { useExecutionUi } from './execContext';
import {
  BUTTON_LABEL, DIFF_REDACTED_NOTE, acceptedText, changeSetModel, changeSetRows, diffHasRedaction, diffLineKind, headTitle, mergeModel, mergedText, mergedTitle, reviewOf, type ChangeSetButton, type ChangeSetRow, type MergeModel
} from './changeSetModel';

const PAGE_BYTES = 64 * 1024;
const TOO_LARGE_TEXT = 'This change is too large to show here. Review it in your repository.';

/** The change's patch (#34 `diff`), paged by text page like the version's content. Read-only; main redacts it whole. */
function useDiff(versionId: string): { text: string | null; error: string | null; loaded: boolean; more: (() => void) | null } {
  const [pages, setPages] = useState<PreviewView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const read = async (from: PreviewView | null, alive: () => boolean) => {
    const r = await nexusClient.versionPreview(versionId, { part: 'diff', page: from?.nextPage ?? 0, maxBytes: PAGE_BYTES });
    if (!alive()) return;
    setLoaded(true);
    if (!r.ok) {
      // Execution off: the notice says so. A change too large is said so; any other refusal is its sentence.
      setError(r.code === 'platform_unavailable' ? null : r.code === 'too_large' ? TOO_LARGE_TEXT : agentFailText(r));
      return;
    }
    setError(null);
    setPages((p) => (from ? [...p, r.data] : [r.data]));
  };
  useEffect(() => {
    let alive = true;
    setPages([]); setLoaded(false); setError(null);
    void read(null, () => alive);
    return () => { alive = false; };
  }, [versionId]);
  const last = pages[pages.length - 1] ?? null;
  // "Show more" ends with the view: a page that arrives after the change was left is dropped.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [versionId]);
  return { text: pages.length ? pages.map((p) => p.text ?? '').join('') : null, error, loaded, more: last && last.nextPage !== null ? () => { const v = versionId; void read(last, () => mounted.current && v === versionId); } : null };
}

function Diff({ versionId }: { versionId: string }) {
  const d = useDiff(versionId);
  const lines = useMemo(() => (d.text === null ? [] : d.text.split('\n')), [d.text]);
  if (!d.loaded) return <p className="nx-muted" role="status">Reading the change…</p>;
  if (d.error) return <p className="nx-muted" role="status">{d.error}</p>;
  if (d.text === null) return null;
  if (d.text.trim() === '') return <p className="nx-muted">The change contains no file changes to show.</p>;
  return (
    <>
      {diffHasRedaction(d.text) && <p className="nx-muted" role="status">{DIFF_REDACTED_NOTE}</p>}
      <pre className="nx-cs__diff" tabIndex={0} aria-label="Diff of the change, read only">
        {lines.map((l, i) => <span key={i} className="nx-cs__ln" data-k={diffLineKind(l)}>{l}{'\n'}</span>)}
      </pre>
      {d.more && <Button variant="quiet" onClick={d.more}>Show more of the change</Button>}
    </>
  );
}

/** "Merge accepted work": asks the channel; the real confirmation is a native dialog in main. Shows main's answer as a sentence. */
export function MergeBlock({ projectId, model, onDone }: { projectId: string; model: MergeModel; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; alert: boolean; title?: string } | null>(null);
  const merge = async () => {
    if (!model.button || busy) return;
    setBusy(true); setNote(null);
    const r = await nexusClient.repoMergeAccepted(projectId, model.button.args);
    setBusy(false);
    setNote(r.ok ? { text: mergedText(r.data), alert: false, title: mergedTitle(r.data) } : { text: agentFailText(r), alert: r.code !== 'conflict' || r.reason !== 'cancelled' });
    usePlatform.getState().bumpRev();
    useExecStore.getState().bump(['jobs']);
    onDone();
  };
  return (
    <section className="nx-cs__merge" aria-label="Merge accepted work">
      <p className="nx-cs__line">{model.line}</p>
      {model.button && (
        <>
          <div className="nx-passport__actions">
            <Button variant="primary" disabled={busy} onClick={() => { void merge(); }}>{busy ? 'Waiting for your confirmation…' : model.button.label}</Button>
          </div>
          <p className="nx-muted">Nexus asks you to confirm in a separate window. Your branch and the files git tracks move to the accepted work only if you confirm; untracked files and other branches are not touched.</p>
        </>
      )}
      {model.sentence && <p className="nx-muted" role="status">{model.sentence}</p>}
      {note && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'} title={note.title}>{note.text}</p>}
    </section>
  );
}

const DECISION_KEY: Record<ReviewDecision, string> = { approve: 'approve', request_changes: 'request', reject: 'reject' };

/**
 * One change made by the agent: what it is waiting for (the headline names every blocking check), the read-only diff, your
 * decision (Approve, Request changes, Reject), Accept once approved, and Merge once accepted work is not on your branch.
 * `withEvidence`: also list the checks (the Folio's own evidence section already does, so it asks for none).
 */
export function ChangeSetReview({ versionId, projectId, status, name, withEvidence = false }: {
  versionId: string; projectId: string; status: VersionStatus; name?: string; withEvidence?: boolean;
}) {
  const rev = usePlatform((s) => s.rev);
  const detail = useRead(versionId, () => nexusClient.versionGet(versionId), [rev]);
  const checks = useChangeChecks(versionId);
  const repo = useRepoStatus(projectId);
  const [local, setLocal] = useState<ReviewDecision | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<'request_changes' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  const commentId = useId();
  const commentBox = useRef<HTMLTextAreaElement | null>(null);
  // Asking for a comment moves focus into the box (a keyboard user would otherwise have to find it).
  useEffect(() => { if (asking) commentBox.current?.focus(); }, [asking]);
  // Your decision shows at once; the version's own newest review (latestReview) replaces it as soon as the version is read again.
  useEffect(() => { setLocal(null); }, [detail.data]);

  const shown = detail.data?.status ?? status;
  const review: ReviewDecision | null | undefined = local ?? reviewOf(detail.data?.latestReview);
  const view = changeSetModel({ version: { status: shown, content: detail.data?.content, previewComplete: detail.data?.previewComplete, previewReason: detail.data?.previewReason }, validations: checks.data, review, repo: repo.data });
  const refresh = () => { usePlatform.getState().bumpRev(); useExecStore.getState().bump(['jobs', 'validations']); repo.reload(); detail.reload(); };

  const decide = async (decision: ReviewDecision, text?: string) => {
    if (busy) return;
    setBusy(decision); setNote(null);
    const body = text && text.trim() ? { decision, comment: text.trim() } : { decision };
    const r = await withIntent(`review:${versionId}:${DECISION_KEY[decision]}`, (intentId) => nexusClient.reviewDecide(versionId, body, intentId));
    setBusy(null);
    if (r.ok) {
      setLocal(decision); setAsking(null); setComment('');
      setNote({ text: decision === 'approve' ? 'Approved. Accept the change to put it on the Nexus branch.'
        : decision === 'reject' ? 'Rejected. Nothing was accepted.'
          : r.data.job ? 'Sent to the agent. It works on the change in the same conversation; follow it in the agent panel.' : 'Your request for changes was recorded.', alert: false });
    } else setNote({ text: agentFailText(r), alert: true });
    refresh();
  };
  const accept = async () => {
    const head = repo.data?.acceptedHead;
    if (busy || !head) return;
    setBusy('accept'); setNote(null);
    const r = await nexusClient.changeSetAccept(versionId, head);
    setBusy(null);
    setNote(r.ok ? { text: acceptedText(), alert: false } : { text: agentFailText(r), alert: true });
    refresh();
  };
  const press = (b: ChangeSetButton) => {
    if (b === 'approve') void decide('approve');
    else if (b === 'accept') void accept();
    else { setAsking(b); setNote(null); }
  };

  return (
    <section className="nx-cs" aria-label={name ? `Change ${name}` : 'Change made by the agent'}>
      <p className="nx-cs__headline">{view.headline}</p>
      {view.blocking.length > 0 && (
        <ul className="nx-cs__blocking" aria-label="Checks that are blocking this change">
          {view.blocking.map((b) => <li key={b.id}><span>{b.label}</span> <span className="nx-xe__word">{b.word}</span></li>)}
        </ul>
      )}
      {view.diff.head && <p className="nx-muted" title={headTitle(view.diff.head)}>The change is recorded at one head commit (hover to see it).</p>}
      {view.buttons.length > 0 && (
        <div className="nx-passport__actions">
          {view.buttons.map((b) => (
            <Button key={b} variant={b === 'accept' ? 'primary' : 'secondary'} disabled={busy !== null} onClick={() => press(b)}>
              {busy === b ? 'Working…' : BUTTON_LABEL[b]}
            </Button>
          ))}
        </div>
      )}
      {asking && (
        <div className="nx-xq__confirm">
          <label htmlFor={commentId}>{asking === 'reject' ? 'Why are you rejecting this change?' : 'What should the agent change?'}</label>
          <textarea id={commentId} ref={commentBox} className="nx-cs__comment" rows={3} maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="nx-xq__acts">
            <Button variant="primary" disabled={busy !== null || comment.trim() === ''} onClick={() => { void decide(asking, comment); }}>
              {asking === 'reject' ? 'Reject the change' : 'Send to the agent'}
            </Button>
            <Button variant="quiet" disabled={busy !== null} onClick={() => { setAsking(null); setComment(''); }}>Cancel</Button>
          </div>
          {comment.trim() === '' && <p className="nx-muted">A comment is needed for this decision.</p>}
        </div>
      )}
      {view.sentences.length > 0 && <ul className="nx-xa__why">{view.sentences.map((s) => <li key={s}>{s}</li>)}</ul>}
      {note && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
      {view.merge && shown === 'active' && <MergeBlock projectId={projectId} model={view.merge} onDone={refresh} />}
      {withEvidence && detail.data && <EvidenceSection key={versionId} version={detail.data} kind="change_set" checked />}
      <h3 className="nx-cs__sub">The change</h3>
      <Diff versionId={versionId} />
    </section>
  );
}

/** The Changes tool's section: accepted work to merge, then each change the agent made (the first one waiting for you is open).
 *  With no change set it renders nothing and reads nothing from the repository. */
export function ChangeSets() {
  const ui = useExecutionUi();
  const projectId = ui?.projectId ?? null;
  const artifacts = useProjectArtifacts(projectId ?? '');
  const rows = useMemo(() => (projectId ? changeSetRows(artifacts.artifacts) : []), [projectId, artifacts.artifacts]);
  if (!projectId || rows.length === 0) return null;
  return <ChangeSetList projectId={projectId} rows={rows} />;
}

function ChangeSetList({ projectId, rows }: { projectId: string; rows: ChangeSetRow[] }) {
  // The repository status (a git read through the runner) is asked only once there is a change to show.
  const repo = useRepoStatus(projectId);
  const firstWaiting = rows.find((r) => r.reviewable)?.versionId ?? null;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const merge = mergeModel(repo.data);
  return (
    <section className="nx-cs__list" aria-labelledby="nx-cs-title">
      <h2 id="nx-cs-title" className="nx-cs__title">Changes made by the agent</h2>
      <p className="nx-review__note">Each change was made in a separate copy of your repository. Nothing here touches your files until you merge accepted work.</p>
      {merge && <MergeBlock projectId={projectId} model={merge} onDone={repo.reload} />}
      <ul className="nx-cs__rows">
        {rows.map((r) => {
          const expanded = open[r.versionId] ?? r.versionId === firstWaiting;
          return (
            <li key={r.versionId} className="nx-cs__row">
              <p className="nx-cs__rowhead">
                <span className="nx-cs__name" title={r.name}>{r.name}</span> <span className="nx-id">v{r.versionNo}</span> <span className="nx-xe__word">{r.word}</span>
                <Button variant="quiet" onClick={() => setOpen((o) => ({ ...o, [r.versionId]: !expanded }))} ariaLabel={`${expanded ? 'Hide' : 'Show'} ${r.name}`} ariaExpanded={expanded}>
                  {expanded ? 'Hide' : 'Show'}
                </Button>
              </p>
              {expanded && <ChangeSetReview versionId={r.versionId} projectId={projectId} status={r.status} name={r.name} withEvidence />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
