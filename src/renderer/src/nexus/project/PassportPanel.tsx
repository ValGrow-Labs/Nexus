import { Fragment, useEffect, useState } from 'react';
import type { Project } from '@shared/project';
import type { SpineNode } from './spineModel';
import { passportFor, type PassportAction } from './passport';
import { useShellActions } from '../shellActions';
import { useParticipationIndex } from '../data/useParticipations';
import { useNexusUi } from '../state/uiStore';
import { Button } from '../ui/Button';
import { WorkspacesSection } from './WorkspacesSection';
import { ArtifactPassport } from './ArtifactPassport';
import { ActivitySection } from './ActivitySection';
import { ProjectActions } from './ActionBar';
import type { ArtifactSummary } from './spineModel';
import type { SaveSource } from './saveSheetModel';
import type { HandoffStart } from '../handoffs/handoffModel';
import type { NexusIconName } from '../icons';

type Commit = { sha: string; shortSha: string; subject: string; time: number };

const ACTION_LABEL: Record<PassportAction, string> = { ask: 'Ask the AI helper', files: 'Open files', terminal: 'Open terminal', refresh: 'Look at the project again' };
const ACTION_ICON: Record<PassportAction, NexusIconName> = { ask: 'assistant', files: 'files', terminal: 'terminal', refresh: 'refresh' };

/** Recent commits for a git source node; empty for anything else. */
function useCommits(root: string, isGit: boolean, headSha: string | null): Commit[] {
  const [commits, setCommits] = useState<Commit[]>([]);
  useEffect(() => {
    if (!isGit) { setCommits([]); return; }
    let alive = true;
    window.cth.gitLog(root, 8)
      .then((log) => { if (alive) setCommits(Array.isArray(log) ? log.map((c) => ({ sha: c.sha, shortSha: c.shortSha, subject: c.subject, time: c.time })) : []); })
      .catch(() => { if (alive) setCommits([]); });
    return () => { alive = false; };
  }, [root, isGit, headSha]);
  return commits;
}

type PassportProps = {
  project: Project; node: SpineNode; headSha: string | null; onRefreshProject: () => Promise<void>; onOpenTerminal: () => void; notice: string | null;
  /** Called before an action runs; the modal sheet uses it to close first. */
  onBeforeAction?: () => void;
  /** The project's artifact summaries (real rows from nexus:artifacts:byProject). */
  artifacts: ArtifactSummary[];
  /** Opens the Save sheet; absent while platform writes are off, so no save control renders. */
  onSave?: (source: SaveSource) => void;
  /** Opens the send sheet at the bench; absent while platform writes are off. */
  onHandOff?: (start: HandoffStart) => void;
};

/** An artifact node gets the artifact Passport; the source and changes nodes get the project Passport. */
export function Passport(props: PassportProps) {
  if (props.node.kind === 'artifact') {
    const { onHandOff, onBeforeAction } = props;
    // The send sheet lives at the bench; the modal Details sheet closes first.
    const handOff = onHandOff
      ? (start: HandoffStart) => { if (onBeforeAction) { onBeforeAction(); setTimeout(() => onHandOff(start), 0); } else onHandOff(start); }
      : undefined;
    return <ArtifactPassport key={props.node.artifactId} project={props.project} node={props.node} artifacts={props.artifacts} onHandOff={handOff} />;
  }
  return <SourcePassport {...props} />;
}

/** `notice` carries bench-level errors (opening the terminal from the rail or
 *  from here), shown in the same alert line as the passport's own errors. */
function SourcePassport({ project, node, headSha, onRefreshProject, onOpenTerminal, notice, onBeforeAction, artifacts, onSave }: PassportProps) {
  const actions = useShellActions();
  const focusIntent = useNexusUi((s) => s.focusIntent);
  const isGit = node.kind === 'source' && node.vcs === 'git';
  const commits = useCommits(project.rootPath, isGit, headSha);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const idx = useParticipationIndex();
  const p = passportFor({ project, idx, node, commits, hasArtifacts: artifacts.length > 0 });

  const run = (a: PassportAction) => {
    if (onBeforeAction) {
      // Close the modal sheet first; run on the next tick so its focus return
      // does not steal focus from where the action sends it.
      onBeforeAction();
      setTimeout(() => act(a), 0);
    } else act(a);
  };
  // Saving opens a sheet at the bench; the modal Details sheet closes first.
  const save = (source: SaveSource) => {
    if (!onSave) return;
    if (onBeforeAction) { onBeforeAction(); setTimeout(() => onSave(source), 0); } else onSave(source);
  };
  const act = (a: PassportAction) => {
    setNote(null);
    if (a === 'ask') focusIntent();
    else if (a === 'files') actions.openIde(project.rootPath);
    else if (a === 'terminal') onOpenTerminal();
    else {
      setBusy(true);
      onRefreshProject()
        .catch((e) => setNote(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    }
  };

  return (
    <aside className="nx-passport" aria-labelledby="nx-passport-title">
      <header>
        <p className="nx-passport__kind">{p.kind}</p>
        <h2 id="nx-passport-title" className="nx-passport__title">{p.title}</h2>
      </header>
      {p.sections.map((s) => (
        <section key={s.title}>
          <h2>{s.title}</h2>
          <dl>{s.rows.map((r) => <Fragment key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></Fragment>)}</dl>
        </section>
      ))}
      {node.kind === 'source' && <WorkspacesSection key={project.id} projectId={project.id} />}
      {node.kind === 'source' && <ProjectActions projectId={project.id} />}
      {p.versions.length > 0 && (
        <section>
          <h2>Saved versions</h2>
          <ol className="nx-versions">
            {p.versions.map((v, i) => {
              const c = commits[i];
              return (
                <li key={v.id} aria-current={v.current ? 'true' : undefined} className={onSave && c ? 'nx-svx-commit' : undefined}>
                  <span className="nx-id">{v.id}</span><span>{v.label}</span>
                  {onSave && c && (
                    <Button variant="quiet" ariaLabel={`Add saved version ${c.shortSha} to your saved items`} onClick={() => save({ kind: 'commit', sha: c.sha, subject: c.subject })}>Add to saved items</Button>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {p.relationshipsNote && <p className="nx-muted">{p.relationshipsNote}</p>}
      {node.kind === 'source' && <ActivitySection key={project.id} projectId={project.id} artifacts={artifacts} />}
      <div className="nx-passport__actions">
        {p.actions.map((a) => (
          <Button key={a} variant={a === 'ask' ? 'primary' : 'secondary'} icon={ACTION_ICON[a]} disabled={a === 'refresh' && busy} onClick={() => run(a)}>
            {a === 'refresh' && busy ? 'Looking again…' : ACTION_LABEL[a]}
          </Button>
        ))}
        {onSave && node.kind === 'source' && <Button icon="files" onClick={() => save({ kind: 'file', relPath: null })}>Add a file to saved items…</Button>}
      </div>
      {(note ?? notice) && <p className="nx-passport__note" role="alert">{note ?? notice}</p>}
    </aside>
  );
}
