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

/** Read-only look at the project's own unsaved changes: what changed in each file, with no keep or undo here. */
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
        setResult({ key, status: 'error', message: 'error' in res && typeof res.error === 'string' ? res.error : 'Nexus could not read what changed in this file. Press Retry.' });
      } else if (res.isBinary) setResult({ key, status: 'binary' });
      else setResult({ key, status: 'ready', head: res.head, working: res.working });
    }).catch((e: unknown) => {
      if (!cancelled) setResult({ key, status: 'error', message: e instanceof Error ? e.message : 'Nexus could not read what changed in this file. Press Retry.' });
    });
    return () => { cancelled = true; };
  }, [root, selected, sig, key, mobile]);

  const frame = (body: ReactNode) => (
    <section className="nx-surface nx-review" aria-labelledby="nx-surface-title">
      <h1 id="nx-surface-title" className="nx-surface__title" tabIndex={-1}>Suggested changes</h1>
      {/* The AI helper's suggested changes (Looks good, Keep these changes, Add to my project) come first; your own unsaved changes follow. */}
      <ChangeSets />
      {body}
    </section>
  );

  if (git.status === 'loading') return frame(<p className="nx-muted" role="status">Looking at your project’s files…</p>);
  if (git.status === 'error') {
    return frame(
      <div className="nx-review__empty" role="status">
        <span title={git.message || undefined}>Nexus could not check this folder for changes. Press Retry. If this keeps happening, check that Git is installed.</span>
        <Button variant="quiet" icon="refresh" onClick={refresh}>Retry</Button>
      </div>
    );
  }
  if (!git.isRepo) return frame(<p className="nx-muted">This folder is not set up with Git, the program that tracks changes, so there is nothing to look at here. Set up Git in this folder to see changes here.</p>);
  if (changed.length === 0) {
    return frame(
      <>
        <p className="nx-muted">No changes yet. When the AI helper or you edit files in this project, the changes show up here so you can look at them.</p>
        <div className="nx-review__actions"><Button variant="quiet" icon="refresh" onClick={() => { setAttempt((n) => n + 1); refresh(); }}>Refresh</Button></div>
      </>
    );
  }

  const current = result && result.key === key ? result : null;
  return frame(
    <>
      <p className="nx-review__note">{REVIEW_PHASE_NOTE}</p>
      <div className="nx-review__layout">
        <nav className="nx-review__files" aria-label="Files that changed">
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
            <Button onClick={() => { if (selected) { setSelection({ kind: 'file', label: selected }); focusIntent(); } }}>Ask the AI helper to change this</Button>
            <Button variant="quiet" icon="refresh" onClick={() => { setAttempt((n) => n + 1); refresh(); }}>Refresh</Button>
          </div>
          {mobile ? <p className="nx-muted">What changed in a file shows on a wider screen. Open Nexus on a computer to see it.</p> : (
          <div className="nx-review__diff" role="region" aria-label={selected ? `What changed in ${selected}` : 'What changed'}>
            {!current && <p className="nx-muted" role="status">Loading what changed…</p>}
            {current?.status === 'error' && (
              <div className="nx-review__empty" role="alert">
                <span>{current.message}</span>
                <Button variant="quiet" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
              </div>
            )}
            {current?.status === 'binary' && <p className="nx-muted">This file is not text (for example a picture), so it cannot be shown here.</p>}
            {current?.status === 'ready' && selected && <MonacoDiff key={selected} path={selected} original={current.head} modified={current.working} />}
          </div>
          )}
        </div>
      </div>
    </>
  );
}
