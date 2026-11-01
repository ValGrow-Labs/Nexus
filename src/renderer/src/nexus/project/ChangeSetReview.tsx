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
import { TryIt } from './TryIt';
import { useNexusUi } from '../state/uiStore';
import {
  BUTTON_LABEL, DIFF_REDACTED_NOTE, acceptedText, changeCounts, changeSetModel, previewProof, proofLines, railLine, changeSetRows, classifyDiff, diffHasRedaction, diffSummary, headLine, headTitle, mergeModel, mergedOnBranch, mergedText, mergedTitle, reviewOf,
  type ChangeSetButton, type ChangeSetRow, type MergeModel, type RailStep
} from './changeSetModel';

const PAGE_BYTES = 64 * 1024;
const TOO_LARGE_TEXT = 'These changes are too big to show here. Look at them in your own tools, or ask the AI helper to split the work into smaller pieces.';

interface DiffState {
  text: string | null; error: string | null; loaded: boolean; more: (() => void) | null;
  /** Every page is loaded (an approval needs the whole patch). */
  whole: boolean; readBytes: number; totalBytes: number | null;
  /** A page could not be read (or none could): Approve stays hidden. */
  failed: boolean;
}

/** The change's patch (#34 `diff`), paged by text page like the version's content. Read-only; main redacts it whole. */
function useDiff(versionId: string): DiffState {
  const [pages, setPages] = useState<PreviewView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [unread, setUnread] = useState(false);
  const read = async (from: PreviewView | null, alive: () => boolean) => {
    const r = await nexusClient.versionPreview(versionId, { part: 'diff', page: from?.nextPage ?? 0, maxBytes: PAGE_BYTES });
    if (!alive()) return;
    setLoaded(true);
    if (!r.ok) {
      // Execution off: the notice says so. A change too large is said so; any other refusal is its sentence. Either way nothing
      // more is known of the patch, so the whole of it has not been read.
      setUnread(true);
      setError(r.code === 'platform_unavailable' ? null : r.code === 'too_large' ? TOO_LARGE_TEXT : agentFailText(r));
      return;
    }
    setError(null); setUnread(false);
    setPages((p) => (from ? [...p, r.data] : [r.data]));
  };
  useEffect(() => {
    let alive = true;
    setPages([]); setLoaded(false); setError(null); setUnread(false);
    void read(null, () => alive);
    return () => { alive = false; };
  }, [versionId]);
  const last = pages[pages.length - 1] ?? null;
  // "Show more" ends with the view: a page that arrives after the change was left is dropped.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [versionId]);
  const text = pages.length ? pages.map((p) => p.text ?? '').join('') : null;
  const more = last && last.nextPage !== null ? () => { const v = versionId; void read(last, () => mounted.current && v === versionId); } : null;
  return {
    text, error, loaded, more,
    whole: loaded && last !== null && last.nextPage === null && !unread,
    readBytes: text === null ? 0 : new TextEncoder().encode(text).length, totalBytes: pages[0]?.totalBytes ?? null,
    failed: unread
  };
}

function Diff({ d }: { d: DiffState }) {
  const lines = useMemo(() => (d.text === null ? [] : classifyDiff(d.text)), [d.text]);
  if (!d.loaded) return <p className="nx-muted" role="status">Loading what changed…</p>;
  return (
    <>
      {d.error && <p className="nx-muted" role="status">{d.error}</p>}
      {d.text !== null && d.text.trim() === '' && <p className="nx-muted">There are no edits to show. Ask the AI helper to try again.</p>}
      {d.text !== null && d.text.trim() !== '' && (
        <>
          <p className="nx-cs__summary">{diffSummary(d.text, d.whole)}</p>
          {diffHasRedaction(d.text) && <p className="nx-muted" role="status">{DIFF_REDACTED_NOTE}</p>}
          <pre className="nx-cs__diff" tabIndex={0} aria-label="What changed (read only)">
            {lines.map((l, i) => <span key={i} className="nx-cs__ln" data-k={l.kind}>{l.text}{'\n'}</span>)}
          </pre>
        </>
      )}
      {d.more && <Button variant="quiet" onClick={d.more}>{d.error ? 'Try again' : 'Show more of the changes'}</Button>}
    </>
  );
}

/** "Add to my project": asks the channel; the real confirmation is a native window from main. Shows main's answer as a sentence. */
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
    <section className="nx-cs__merge" aria-label="Add to my project">
      <p className="nx-cs__line">{model.line}</p>
      {model.button && (
        <>
          <div className="nx-passport__actions">
            <Button variant="primary" disabled={busy} onClick={() => { void merge(); }}>{busy ? 'Waiting for you to confirm in the other window…' : model.button.label}</Button>
          </div>
          <p className="nx-muted">Nexus asks you to confirm in a separate window. Your project’s main version and its files change only if you confirm. New files you have not saved, and your other versions, are not touched.</p>
        </>
      )}
      {model.sentence && <p className="nx-muted" role="status">{model.sentence}</p>}
      {note && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'} title={note.title}>{note.text}</p>}
    </section>
  );
}

const DECISION_KEY: Record<ReviewDecision, string> = { approve: 'approve', request_changes: 'request', reject: 'reject' };

/** The three steps in plain words, with the next one marked in words (never by colour alone) and what it will do. */
function Rail({ steps }: { steps: RailStep[] }) {
  return (
    <>
      <ol className="nx-cs__rail" aria-label="Your three steps">
        {steps.map((x) => (
          <li key={x.id} className="nx-cs__step" data-state={x.state} aria-current={x.state === 'current' ? 'step' : undefined}>
            <span className="nx-cs__stepn" aria-hidden="true">{x.n}</span>
            <span className="nx-cs__stepl">{x.label}</span>
            <span className="nx-cs__stepw">{x.state === 'done' ? 'Done' : x.state === 'current' ? 'Next' : 'Later'}</span>
          </li>
        ))}
      </ol>
      {railLine(steps) && <p className="nx-cs__instruction">{railLine(steps)}</p>}
    </>
  );
}

/**
 * One set of suggested changes: where it stands (the headline), the 3-step rail (Looks good, Keep these changes, Add to my
 * project) with one main button at a time, what changed (read only), and the checks. "Looks good" needs all of what changed loaded.
 * `withEvidence`: also list the checks (the Folio's own evidence section already does, so it asks for none).
 */
export function ChangeSetReview({ versionId, projectId, status, name, withEvidence = false }: {
  versionId: string; projectId: string; status: VersionStatus; name?: string; withEvidence?: boolean;
}) {
  const rev = usePlatform((s) => s.rev);
  const detail = useRead(versionId, () => nexusClient.versionGet(versionId), [rev]);
  const checks = useChangeChecks(versionId);
  const repo = useRepoStatus(projectId);
  const diff = useDiff(versionId);
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
  const view = changeSetModel({ version: { status: shown, content: detail.data?.content, previewComplete: detail.data?.previewComplete, previewReason: detail.data?.previewReason }, diffRead: { whole: diff.whole, readBytes: diff.readBytes, totalBytes: diff.totalBytes, failed: diff.failed }, validations: checks.data, review, repo: repo.data });
  const refresh = () => { usePlatform.getState().bumpRev(); useExecStore.getState().bump(['jobs', 'validations']); repo.reload(); detail.reload(); };

  const decide = async (decision: ReviewDecision, text?: string) => {
    if (busy) return;
    setBusy(decision); setNote(null);
    const body = text && text.trim() ? { decision, comment: text.trim() } : { decision };
    const r = await withIntent(`review:${versionId}:${DECISION_KEY[decision]}`, (intentId) => nexusClient.reviewDecide(versionId, body, intentId));
    setBusy(null);
    if (r.ok) {
      setLocal(decision); setAsking(null); setComment('');
      setNote({ text: decision === 'approve' ? 'Looks good: done. Next: press “Keep these changes”. They are saved in Nexus’s copy, and your own files are not touched yet.'
        : decision === 'reject' ? 'You said no to these changes. Nothing was kept.'
          : r.data.job ? 'Sent to the AI helper. It works on the changes in the same conversation; follow it in the AI helper panel.' : 'Your request for different changes was saved.', alert: false });
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

  const counts = changeCounts(diff.text);
  const fileCount = counts ? Number(counts.split(' ')[1]) || null : null;
  const proof = proofLines(checks.data, fileCount);
  const previewLine = previewProof(checks.data);
  const technical = useNexusUi((x) => x.audience) === 'technical';
  const [showDiff, setShowDiff] = useState<boolean | null>(null);
  const diffOpen = showDiff ?? technical;
  return (
    <section className="nx-cs" aria-label={name ? `Suggested changes: ${name}` : 'Suggested changes'}>
      {view.rail ? <Rail steps={view.rail} /> : <p className="nx-cs__headline">{view.headline}</p>}
      {view.blocking.length > 0 && (
        <ul className="nx-cs__blocking" aria-label="Required checks that need attention">
          {view.blocking.map((b) => <li key={b.id}><span>{b.label}</span> <span className="nx-xe__word">{b.word}</span> <span className="nx-xe__tag">Required</span></li>)}
        </ul>
      )}
      <div className="nx-cs__block">
        <h3 className="nx-cs__sub">What the AI helper did</h3>
        <p className="nx-cs__did"><strong>{name ?? 'Suggested changes'}</strong></p>
        {counts && <p className="nx-muted">{counts}</p>}
      </div>
      {(proof.length > 0 || previewLine) && (
        <div className="nx-cs__block">
          <h3 className="nx-cs__sub">Proof</h3>
          <p className="nx-muted">All of these must pass before you can press “Looks good”.</p>
          <ul className="nx-cs__proof" aria-label="Proof">
            {proof.map((p) => <li key={p.id} data-ok={p.ok ? 'true' : 'false'}><span aria-hidden="true">{p.pending ? '…' : p.ok ? '✓' : '✗'}</span> {p.text}</li>)}
          </ul>
          {previewLine && <p className="nx-muted" data-ok={previewLine.ok ? 'true' : 'false'}><span aria-hidden="true">{previewLine.ok ? '✓' : '✗'}</span> {previewLine.text} (extra: not required)</p>}
        </div>
      )}
      <div className="nx-cs__block"><TryIt projectId={projectId} versionId={versionId} /></div>
      <div className="nx-cs__block">
        <h3 className="nx-cs__sub">What changed</h3>
        <Button variant="quiet" ariaExpanded={diffOpen} onClick={() => setShowDiff(!diffOpen)}>{diffOpen ? 'Hide what changed' : 'Show what changed'}</Button>
        {diffOpen && <Diff d={diff} />}
      </div>
      <details className="nx-cs__details">
        <summary>Technical details (for developers)</summary>
        <p className="nx-muted">Version {detail.data?.versionNo ?? ''}{view.diff.head ? <> · {headLine(view.diff.head)}</> : null}</p>
        {withEvidence && detail.data && <EvidenceSection key={versionId} version={detail.data} kind="change_set" checked />}
      </details>
      {view.sentences.length > 0 && <ul className="nx-xa__why">{view.sentences.map((s) => <li key={s}>{s}</li>)}</ul>}
      {view.merge && shown === 'active' && <MergeBlock projectId={projectId} model={view.merge} onDone={refresh} />}
      <div className="nx-cs__bar">
        {asking && (
          <div className="nx-xq__confirm">
            <label htmlFor={commentId}>{asking === 'reject' ? 'Why are you saying no to these changes?' : 'What should the AI helper change?'}</label>
            <textarea id={commentId} ref={commentBox} className="nx-cs__comment" rows={3} maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} />
            <div className="nx-xq__acts">
              <Button variant="primary" disabled={busy !== null || comment.trim() === ''} onClick={() => { void decide(asking, comment); }}>
                {asking === 'reject' ? 'Say no to these changes' : 'Send to the AI helper'}
              </Button>
              <Button variant="quiet" disabled={busy !== null} onClick={() => { setAsking(null); setComment(''); }}>Cancel</Button>
            </div>
            {comment.trim() === '' && <p className="nx-muted">Write a short note first. The AI helper reads it.</p>}
          </div>
        )}
        {view.buttons.length > 0 && (
          <div className="nx-passport__actions">
            {view.buttons.map((b) => (
              <Button key={b} variant={b === 'accept' || b === 'approve' ? 'primary' : 'quiet'} disabled={busy !== null} onClick={() => press(b)}>
                {busy === b ? 'Working…' : BUTTON_LABEL[b]}
              </Button>
            ))}
          </div>
        )}
        {note && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
      </div>
    </section>
  );
}

/** The Changes tool's section: kept work to add to your project, then each set of suggested changes (the first one waiting for you is open).
 *  With none it renders nothing and reads nothing from the repository. */
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
  // A kept change reads "Added to your project" once the kept work is in the project's main version.
  const shown = useMemo(() => rows.map((r) => (r.status === 'active' && mergedOnBranch(repo.data) ? { ...r, word: 'Added to your project' } : r)), [rows, repo.data]);
  return (
    <section className="nx-cs__list" aria-labelledby="nx-cs-title">
      <h2 id="nx-cs-title" className="nx-cs__title nx-visually-hidden">Suggested changes</h2>
      <p className="nx-review__note">The AI helper made each suggestion in a safe copy of your project. Nothing here touches your files until you press “Add to my project”.</p>
      {merge && <MergeBlock projectId={projectId} model={merge} onDone={repo.reload} />}
      <ul className="nx-cs__rows">
        {shown.map((r) => {
          const expanded = open[r.versionId] ?? r.versionId === firstWaiting;
          return (
            <li key={r.versionId} className="nx-cs__row">
              <p className="nx-cs__rowhead">
                <span className="nx-cs__name" title={r.name}>{r.name}</span> <span className="nx-xe__word">{r.word}</span>
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
