import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nexusClient } from '../data/nexusClient';
import { usePlatform, selectCanWrite } from '../data/platformStore';
import { useParticipationIndex } from '../data/useParticipations';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import type { ArtifactSummary } from './spineModel';
import {
  beginSave, buildRequest, existingTargets, fileChoices, initialSaveState, kindForSource, parentDir, saveFailed, saveFailureText,
  selectWorkspace, setTarget, shouldReloadAfterSave, sourceChanged, steerTarget, steerText, workspaceChoices,
  type FileChoice, type SaveSheetState, type SaveSource
} from './saveSheetModel';

type Commit = { sha: string; shortSha: string; subject: string };

/** Recent commits, from the existing git:log channel on the project folder. */
function useRecentCommits(root: string, enabled: boolean, pinned: Commit | null): Commit[] {
  const [commits, setCommits] = useState<Commit[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    window.cth.gitLog(root, 30)
      .then((log) => { if (alive) setCommits(Array.isArray(log) ? log.map((c) => ({ sha: c.sha, shortSha: c.shortSha, subject: c.subject })) : []); })
      .catch(() => { if (alive) setCommits([]); });
    return () => { alive = false; };
  }, [root, enabled]);
  return pinned && !commits.some((c) => c.sha === pinned.sha) ? [pinned, ...commits] : commits;
}

/** One folder of the project, from the existing fs:listDir channel rooted at the project (main confines it). */
function useFolder(root: string, dir: string, enabled: boolean): { entries: FileChoice[]; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ entries: FileChoice[]; error: string | null; loading: boolean }>({ entries: [], error: null, loading: true });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    window.cth.listDir(root, dir)
      .then((r) => { if (alive) setState(r.ok ? { entries: fileChoices(dir, r.entries), error: null, loading: false } : { entries: [], error: 'This folder could not be read.', loading: false }); })
      .catch(() => { if (alive) setState({ entries: [], error: 'This folder could not be read.', loading: false }); });
    return () => { alive = false; };
  }, [root, dir, enabled]);
  return state;
}

/** Save a commit or a small text file of the project as an artifact version. Renders only while the database is the authority. */
export function SaveArtifactSheet({ project, initial, artifacts, onClose, onSaved }: {
  project: { id: string; rootPath: string };
  initial: SaveSource;
  artifacts: ArtifactSummary[];
  onClose: () => void;
  /** Called with the saved artifact's id once the save succeeded. */
  onSaved: (artifactId: string) => void;
}) {
  const canWrite = usePlatform(selectCanWrite);
  const bumpRev = usePlatform((s) => s.bumpRev);
  const idx = useParticipationIndex();
  const choices = useMemo(() => workspaceChoices(idx, project.id, canWrite), [idx, project.id, canWrite]);
  const [source, setSource] = useState<SaveSource>(initial);
  const [state, setState] = useState<SaveSheetState>(() => initialSaveState(initial, choices, artifacts));
  const [dir, setDir] = useState('');
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Escape, the scrim and Cancel close the sheet, except while a save is running.
  const pendingRef = useRef(false);
  pendingRef.current = state.pending;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const safeClose = useCallback(() => { if (!pendingRef.current) closeRef.current(); }, []);

  // The participations were re-read (an attach or withdraw elsewhere): a workspace that is no longer offered starts over.
  useEffect(() => {
    setState((s) => (s.pending || choices.some((c) => c.workspaceId === s.workspaceId) ? s : initialSaveState(source, choices, artifacts)));
    // Only a change of the offered workspaces resets the choice.
  }, [choices]);

  const pinned = initial.kind === 'commit' ? { sha: initial.sha, shortSha: initial.sha.slice(0, 7), subject: initial.subject } : null;
  const commits = useRecentCommits(project.rootPath, source.kind === 'commit', pinned);
  const folder = useFolder(project.rootPath, dir, source.kind === 'file');

  const ws = choices.find((c) => c.workspaceId === state.workspaceId) ?? null;
  const targets = existingTargets(artifacts, ws, kindForSource(source));
  const steer = steerTarget(state, source, choices, artifacts);
  const request = buildRequest(project.id, state, source);

  const changeSource = (next: SaveSource) => {
    setState((s) => sourceChanged(s, source, next, choices, artifacts));
    setSource(next);
  };

  const submit = async () => {
    if (running.current) return;
    const req = buildRequest(project.id, state, source);
    const next = beginSave(state, req !== null);
    if (!next || !req) return;
    running.current = true;
    setState(next);
    const r = req.kind === 'commit' ? await nexusClient.artifactSaveCommit(req.args) : await nexusClient.artifactSaveTextFile(req.args);
    running.current = false;
    // Refresh every screen even when the sheet has gone in the meantime.
    if (r.ok || shouldReloadAfterSave(r)) bumpRev();
    if (!alive.current) return;
    if (r.ok) { pendingRef.current = false; onSaved(r.data.artifact.id); }
    else setState((s) => saveFailed(s, saveFailureText(r)));
  };

  if (!canWrite) return null;
  const pending = state.pending;
  return (
    <Sheet open onClose={safeClose} side="right" labelledBy="nx-svx-title">
      <form className="nx-svx" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <header className="nx-svx__head">
          <p className="nx-svx__kind">{source.kind === 'commit' ? 'Saved version' : 'File'}</p>
          <h2 id="nx-svx-title" className="nx-svx__title">Add to saved items</h2>
        </header>

        {source.kind === 'commit' ? (
          <label className="nx-svx__field">
            <span className="nx-svx__label">Saved version</span>
            <select className="nx-input nx-svx__control" value={source.sha} disabled={pending}
              onChange={(e) => { const c = commits.find((x) => x.sha === e.target.value); if (c) changeSource({ kind: 'commit', sha: c.sha, subject: c.subject }); }}>
              {commits.map((c) => <option key={c.sha} value={c.sha}>{c.shortSha} {c.subject}</option>)}
            </select>
            <span className="nx-id nx-svx__sha">{source.sha}</span>
          </label>
        ) : (
          <fieldset className="nx-svx__field nx-svx__files" disabled={pending}>
            <legend className="nx-svx__label">File</legend>
            <p className="nx-svx__path">{dir ? `${dir}/` : 'Project folder'}</p>
            <ul className="nx-svx__list" aria-label="Files in this folder">
              {dir && <li><button type="button" className="nx-svx__entry" onClick={() => setDir(parentDir(dir))}>Up one folder</button></li>}
              {folder.entries.map((f) => (
                <li key={f.relPath}>
                  {f.isDir ? (
                    <button type="button" className="nx-svx__entry" onClick={() => setDir(f.relPath)}>{f.name}/</button>
                  ) : (
                    <button type="button" className="nx-svx__entry" aria-pressed={source.relPath === f.relPath} disabled={f.tooLarge}
                      onClick={() => changeSource({ kind: 'file', relPath: f.relPath })}>
                      <span>{f.name}</span>{f.tooLarge && <span className="nx-muted"> too big (over 64 KB)</span>}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {folder.loading && <p className="nx-muted" role="status">Reading the folder…</p>}
            {!folder.loading && !folder.error && folder.entries.length === 0 && <p className="nx-muted">This folder is empty.</p>}
            {folder.error && <p className="nx-muted" role="status">{folder.error}</p>}
            <p className="nx-svx__chosen">{source.relPath ? <>Chosen: <span className="nx-id">{source.relPath}</span></> : 'No file chosen yet.'}</p>
          </fieldset>
        )}

        <label className="nx-svx__field">
          <span className="nx-svx__label">Workspace</span>
          <select className="nx-input nx-svx__control" value={state.workspaceId ?? ''} disabled={pending || choices.length === 0}
            onChange={(e) => setState((s) => selectWorkspace(s, e.target.value, source, choices, artifacts))}>
            {choices.map((c) => <option key={c.workspaceId} value={c.workspaceId}>{c.isPrimary ? `${c.label} (main)` : c.label}</option>)}
          </select>
        </label>
        {choices.length === 0 && <p className="nx-muted">This project is not in any workspace yet, so nothing can be saved. Add it to a workspace first.</p>}

        <fieldset className="nx-svx__field" disabled={pending}>
          <legend className="nx-svx__label">Save to</legend>
          <label className="nx-svx__choice">
            <input type="radio" name="nx-svx-target" checked={state.target.mode === 'new'}
              onChange={() => setState((s) => setTarget(s, { mode: 'new', name: s.target.mode === 'new' ? s.target.name : '' }))} />
            <span>New saved item</span>
          </label>
          {state.target.mode === 'new' && (
            <input className="nx-input nx-svx__control" aria-label="Name of the saved item" maxLength={200} value={state.target.name}
              onChange={(e) => { const name = e.target.value; setState((s) => setTarget(s, { mode: 'new', name })); }} />
          )}
          <label className="nx-svx__choice">
            <input type="radio" name="nx-svx-target" checked={state.target.mode === 'existing'} disabled={targets.length === 0}
              onChange={() => setState((s) => setTarget(s, { mode: 'existing', artifactId: targets[0]?.artifactId ?? null }))} />
            <span>New version of…</span>
          </label>
          {state.target.mode === 'existing' && (
            <select className="nx-input nx-svx__control" aria-label="Saved item to add a version to" value={state.target.artifactId ?? ''}
              onChange={(e) => { const artifactId = e.target.value; setState((s) => setTarget(s, { mode: 'existing', artifactId })); }}>
              {targets.map((t) => <option key={t.artifactId} value={t.artifactId}>{t.latestVersionNo ? `${t.name} (now at version ${t.latestVersionNo})` : t.name}</option>)}
            </select>
          )}
          {targets.length === 0 && <p className="nx-muted">There is no saved item of this type in this workspace yet.</p>}
        </fieldset>

        {steer && ws && (
          <div className="nx-svx__steer" role="note">
            <p>{steerText(steer.name, ws.label)}</p>
            <Button disabled={pending} onClick={() => setState((s) => setTarget(s, { mode: 'existing', artifactId: steer.artifactId }))}>Add as a new version</Button>
          </div>
        )}

        {state.error && <p className="nx-passport__note" role="alert">{state.error}</p>}
        <div className="nx-svx__actions">
          <Button type="submit" variant="primary" disabled={pending || request === null}>{pending ? 'Saving…' : 'Save'}</Button>
          <Button disabled={pending} onClick={safeClose}>Cancel</Button>
        </div>
      </form>
    </Sheet>
  );
}
