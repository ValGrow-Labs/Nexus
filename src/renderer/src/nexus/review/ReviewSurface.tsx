import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { MonacoDiff } from '@/ide/MonacoDiff';
import type { GitState } from '../project/spineModel';
import { groupChanges, REVIEW_PHASE_NOTE } from './reviewModel';
import { useNexusUi } from '../state/uiStore';
import { useShellActions } from '../shellActions';
import { Button } from '../ui/Button';
import { useMedia } from '../ui/useMedia';
import { ChangeSets } from '../project/ChangeSetReview';

type DiffResult =
  | { key: string; status: 'error'; message: string }
  | { key: string; status: 'binary' }
  | { key: string; status: 'ready'; head: string; working: string };

const NO_CHANGES: { path: string; kind: 'modified' }[] = [];

/** Read-only review of the project's uncommitted changes: real diff, no accept/discard. */
export function ReviewSurface({ root, git, refresh }: { root: string; git: GitState; refresh: () => void }) {
  const actions = useShellActions();
  // Below 768px the diff editor is not mounted at all, and no diff is fetched.
  const mobile = useMedia('(max-width: 767px)');
  const setSelection = useNexusUi((s) => s.setSelection);
  const focusIntent = useNexusUi((s) => s.focusIntent);
  const changed = git.status === 'ready' && git.isRepo ? git.changed : NO_CHANGES;
  const groups = useMemo(() => groupChanges(changed), [changed]);
  const [picked, setPicked] = useState<string | null>(null);
  // Bumped by Refresh and Retry so an explicit request refetches; unrelated git re-reads do not.
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<DiffResult | null>(null);

  // The selected file always resolves to a file that is still changed.
  const selected = picked && changed.some((c) => c.path === picked) ? picked : (groups[0]?.paths[0] ?? null);
  const sig = changed.find((c) => c.path === selected)?.kind ?? '';
  const key = selected ? `${root}\u0000${selected}\u0000${attempt}` : null;

  // A result is only shown when its key matches the current file/attempt, and a
  // superseded request is ignored, so a quick file switch never shows a stale diff.
  useEffect(() => {
    if (!selected || !key || mobile) return;
    let cancelled = false;
    window.cth.gitDiff(root, selected).then((res) => {
      if (cancelled) return;
      if (!('ok' in res) || res.ok !== true) {
        setResult({ key, status: 'error', message: 'error' in res && typeof res.error === 'string' ? res.error : 'The diff could not be read.' });
      } else if (res.isBinary) setResult({ key, status: 'binary' });
      else setResult({ key, status: 'ready', head: res.head, working: res.working });
    }).catch((e: unknown) => {
      if (!cancelled) setResult({ key, status: 'error', message: e instanceof Error ? e.message : 'The diff could not be read.' });
    });
    return () => { cancelled = true; };
  }, [root, selected, sig, key, mobile]);

  const frame = (body: ReactNode) => (
    <section className="nx-surface nx-review" aria-labelledby="nx-surface-title">
      <h1 id="nx-surface-title" className="nx-surface__title" tabIndex={-1}>Changes</h1>
      {/* B2b: the changes the agent made (decide, accept, merge) come first; your own uncommitted changes follow. */}
      <ChangeSets />
      {body}
    </section>
  );

  if (git.status === 'loading') return frame(<p className="nx-muted" role="status">Reading git status…</p>);
  if (git.status === 'error') {
    return frame(
      <div className="nx-review__empty" role="status">
        <span>Git status is unavailable for this folder{git.message ? `: ${git.message}` : '.'}</span>
        <Button variant="quiet" icon="refresh" onClick={refresh}>Retry</Button>
      </div>
    );
  }
  if (!git.isRepo) return frame(<p className="nx-muted">This folder is not a git repository, so there is nothing to review.</p>);
  if (changed.length === 0) {
    return frame(
      <>
        <p className="nx-muted">No uncommitted changes. When an agent or you edit files in this project, the changes appear here for review.</p>
        <div className="nx-review__actions"><Button variant="quiet" icon="refresh" onClick={() => { setAttempt((n) => n + 1); refresh(); }}>Refresh</Button></div>
      </>
    );
  }

  const current = result && result.key === key ? result : null;
  return frame(
    <>
      <p className="nx-review__note">{REVIEW_PHASE_NOTE}</p>
      <div className="nx-review__layout">
        <nav className="nx-review__files" aria-label="Changed files">
          {groups.map((g) => (
            <section key={g.kind} className="nx-review__group" aria-labelledby={`nx-review-g-${g.kind}`}>
              <h2 id={`nx-review-g-${g.kind}`} className="nx-review__heading">{g.title} <span className="nx-id">{g.paths.length}</span></h2>
              <ul className="nx-review__list">
                {g.paths.map((p) => (
                  <li key={p}>
                    <button type="button" className="nx-review__file" aria-current={p === selected ? 'true' : undefined} title={p} onClick={() => setPicked(p)}>{p}</button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        <div className="nx-review__main">
          <div className="nx-review__actions">
            <Button onClick={() => actions.openIde(root)}>Open in Files</Button>
            <Button onClick={() => { if (selected) { setSelection({ kind: 'file', label: selected }); focusIntent(); } }}>Ask an agent to revise</Button>
            <Button variant="quiet" icon="refresh" onClick={() => { setAttempt((n) => n + 1); refresh(); }}>Refresh</Button>
          </div>
          {mobile ? <p className="nx-muted">Diffs are available on desktop.</p> : (
          <div className="nx-review__diff" role="region" aria-label={selected ? `Diff of ${selected}` : 'Diff'}>
            {!current && <p className="nx-muted" role="status">Loading diff…</p>}
            {current?.status === 'error' && (
              <div className="nx-review__empty" role="alert">
                <span>{current.message}</span>
                <Button variant="quiet" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
              </div>
            )}
            {current?.status === 'binary' && <p className="nx-muted">Binary file, not shown</p>}
            {current?.status === 'ready' && selected && <MonacoDiff key={selected} path={selected} original={current.head} modified={current.working} />}
          </div>
          )}
        </div>
      </div>
    </>
  );
}
