import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DomainId } from '@shared/domain';
import { useStore } from '@/store/store';
import { WORKSPACES, getWorkspace } from '../workspaces/registry';
import { projectsInWorkspace } from '../workspaces/participation';
import { useParticipationIndex } from '../data/useParticipations';
import { recentProjects } from '../data/selectors';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { provenanceStyle } from '../ui/ProvenanceMark';
import { emblemPath } from '../launcher/emblems';
import { detectEnvironment, IDEAS, PLAIN_IDEAS, buildStartRequest, chosenEnvironment, DELIVERED_WORKSPACES, startBlocker, startDomainId, startTarget } from './startModel';
import { nexusClient } from '../data/nexusClient';
import { markHandoff } from '../intent/IntentLine';
import { usePendingStart } from '../agent/pendingStart';
import { withIntent } from '../data/useExecution';
import { usePlatform } from '../data/platformStore';

type Folder = { path: string; name: string };
/** Which project the request goes to: an existing one, a new folder, or
 *  "follow the environment" (most recent project there) until the person
 *  picks. */
type ProjectPick = { kind: 'auto' } | { kind: 'existing'; id: string } | { kind: 'new'; folder: Folder };

function Emblem({ id }: { id: string }) {
  return (
    <svg viewBox="0 0 100 100" className="nx-wb__emblem" aria-hidden="true">
      <path style={{ d: `path("${emblemPath(id)}")` } as CSSProperties} />
    </svg>
  );
}

/** Start, as one screen: the request on the left with what will happen,
 *  where it goes on the right. Nothing runs until Start is pressed. */
export function StartPage() {
  const projects = useStore((s) => s.projects);
  const idx = useParticipationIndex();
  const setProjects = useStore((s) => s.setProjects);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  const plain = useNexusUi((s) => s.audience) === 'nontechnical';

  // A request carried over from Welcome is taken once, then cleared.
  const [text, setText] = useState(() => {
    const carried = useNexusUi.getState().startPrefill;
    if (carried) useNexusUi.getState().setStartPrefill(null);
    return carried ?? '';
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [pick, setPick] = useState<ProjectPick>({ kind: 'auto' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { input.current?.focus(); }, []);

  const detection = useMemo(() => detectEnvironment(text), [text]);
  const envId = chosenEnvironment(text, picked);
  const ws = envId ? getWorkspace(envId) : null;

  const ordered = useMemo(() => {
    const here = ws ? recentProjects(projectsInWorkspace(idx, projects, ws.id).map((x) => x.project), projects.length) : [];
    const rest = recentProjects(projects.filter((p) => !here.includes(p)), projects.length);
    return { here, rest };
  }, [projects, ws, idx]);

  const project = pick.kind === 'existing' ? projects.find((p) => p.id === pick.id) ?? null
    : pick.kind === 'auto' ? ordered.here[0] ?? null
    : null;
  const folder = pick.kind === 'new' ? pick.folder : null;

  const blocker = startBlocker({ text, hasProject: !!project || !!folder });
  const target = startTarget(envId, ws?.name ?? null);
  const startAt = target;
  const request = ws && project ? buildStartRequest({ text, workspaceLabel: ws.label, project: { name: project.name, rootPath: project.rootPath } }) : null;

  const chooseFolder = async () => {
    setError(null);
    try {
      const res = await window.cth.chooseFolder();
      if (res && res.ok && res.path) {
        const name = res.path.split(/[\\/]/).filter(Boolean).pop() ?? 'New project';
        setPick({ kind: 'new', folder: { path: res.path, name } });
      }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  /** Creates the project first when a new folder was chosen, then sends. */
  const start = async () => {
    setTried(true);
    if (blocker) return;
    setBusy(true); setError(null);
    try {
      let target = project;
      if (!target && folder) {
        // A Machine learning request makes a Machine learning project; a workspace that is not delivered yet starts as Software, with the text carried over unchanged.
        const domainId = startDomainId(startAt.workspaceId) as DomainId;
        const res = await window.cth.projectCreate({ name: folder.name.trim() || 'New project', rootPath: folder.path, domainId, description: text.trim() || undefined });
        if (!res.ok || !res.project) throw new Error(res.error || 'The project could not be created.');
        setProjects(await window.cth.projectList());
        target = res.project;
        setPick({ kind: 'existing', id: res.project.id });
        // The AI helper works through the Software workspace, so a new Machine learning project joins it right away (the same step the setup card offers).
        if (startAt.workspaceId !== 'sde') { const joined = await nexusClient.participationAttach(res.project.id, 'sde').catch(() => null); if (joined && joined.ok) usePlatform.getState().bumpRev(); }
        // A new folder is set up to track changes (the line above the button said so), and its starting point is saved, so the AI helper can start.
        const made = await window.cth.gitInitProject(res.project.id).catch(() => null);
        if (made && made.ok) await withIntent(`start:snapshot:${res.project.id}`, (intentId) => nexusClient.jobStart({ projectId: res.project!.id, workspaceId: 'sde', actionId: 'sde.repository.snapshot', inputs: [], params: {}, intentId })).catch(() => null);
      }
      if (!target) return;
      try { const p = await window.cth.projectSetActive(target.id); if (p) setActiveProject(p); } catch { /* opening still works */ }
      if (ws) setLast(ws.id);
      // The typed words go into the AI helper's request box on the project page (prefilled, focused, NOT sent: the person presses Ask).
      useNexusUi.getState().setDraft(text.trim());
      useNexusUi.getState().focusIntent();
      markHandoff();
      // Start begins the build: the project page sends these words to its AI helper as soon as it can take them (right away when it is ready,
      // otherwise after the setup card is done), once.
      usePendingStart.getState().hand(target.id, text);
      navigate({ name: 'project', id: target.id, tool: 'bench' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nx-wb" style={ws ? provenanceStyle(ws.hueSlot) : undefined}>
      {/* Left: the request and what will happen */}
      <section className="nx-wb__doc" aria-labelledby="nx-wb-h">
        <div className="nx-wb__intro">
          <span className="nx-wb__eyebrow">New work</span>
          <h1 id="nx-wb-h" className="nx-wb__title" tabIndex={-1}>{plain ? 'What do you want to build?' : 'What are you working on?'}</h1>
        </div>

        {/* The composer: the request, the workspace it is going to, and Start, in one card */}
        <div className="nx-wb__composer">
          <label className="nx-visually-hidden" htmlFor="nx-wb-req">Describe what you want to work on</label>
          <textarea
            id="nx-wb-req" ref={input} className="nx-wb__req" rows={2} value={text}
            placeholder={plain ? 'Describe it in plain words, the way you would tell a colleague' : 'For example: train a model to classify support emails'}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void start(); } }}
          />
          <div className="nx-wb__bar">
            <p className="nx-wb__chip" aria-live="polite">
              {ws ? <>
                  <i aria-hidden="true" />
                  <b>{ws.name}</b>
                  {picked ? <span className="nx-wb__conf">chosen by you</span>
                    : <span className={`nx-wb__conf nx-wb__conf--${detection.confidence}`}>{detection.confidence === 'strong' ? 'matched' : 'check it'}</span>}
                  {!picked && !plain && detection.matched.length > 0 && <span className="nx-wb__words">{detection.matched.join(' · ')}</span>}
                </>
                : <span className="nx-wb__none">{text.trim() ? 'No workspace matched yet. Pick one on the right.' : 'The workspace appears here as you type'}</span>}
            </p>
            <button type="button" className="nx-wb__send" disabled={busy || !!blocker} data-ready={blocker ? undefined : 'true'} onClick={start}
              aria-label="Start" title={blocker ?? 'Start'}>
              <span>Start</span>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
            </button>
          </div>
        </div>

        {blocker && <p className="nx-wb__why" role="status">{blocker}</p>}

        <div className="nx-wb__ideas" aria-label="Examples">
          <span>Try</span>
          {(plain ? PLAIN_IDEAS : IDEAS).map((idea) => (
            <button key={idea.label} type="button" className="nx-wb__idea" onClick={() => { setText(idea.prompt); setPicked(null); input.current?.focus(); }}>{idea.label}</button>
          ))}
        </div>

        <div className="nx-wb__plan">
          <h2 className="nx-wb__h2">When you press Start</h2>
          <ol>
            <li><span>{folder ? <>A new project is created in <code>{folder.path}</code>. Nexus will set up Git in this new folder so it can track changes.</> : project ? <>The work happens in <b>{project.name}</b></> : <>The work happens in the project you choose</>}</span></li>
            <li><span>Your request goes to the AI helper</span></li>
            <li><span>The project opens so you can follow the AI helper's work</span></li>
          </ol>
        </div>

        {ws && ws.plannedModules.length > 0 && !DELIVERED_WORKSPACES.includes(ws.id) && (
          <div className="nx-wb__planned">
            <h2 className="nx-wb__h2">Coming to {ws.label}</h2>
            <p>{ws.plannedModules.join(' · ')} <span className="nx-wb__tag">Planned</span></p>
          </div>
        )}

        {request && (
          <details className="nx-wb__sent">
            <summary>Exactly what will be sent</summary>
            <pre>{`${request.contextHeader}\n${request.text}`}</pre>
          </details>
        )}
      </section>

      {/* Right: where it goes */}
      <aside className="nx-wb__side" aria-label="Where the work goes">
        <div className="nx-wb__group">
          <div className="nx-wb__grouphead">
            {ws && <Emblem id={ws.id} />}
            <h2 className="nx-wb__h2">Environment</h2>
            {picked && <button type="button" className="nx-wb__link" onClick={() => setPicked(null)}>Use detected</button>}
          </div>
          <div className="nx-wb__envs" role="radiogroup" aria-label="Environment">
            {WORKSPACES.map((w) => (
              <button key={w.id} type="button" role="radio" aria-checked={envId === w.id}
                className={`nx-wb__env${envId === w.id ? ' is-on' : ''}`} style={provenanceStyle(w.hueSlot)}
                onClick={() => setPicked(w.id)}>
                <span className="nx-wb__envname"><i aria-hidden="true" />{w.label}</span>
                <small>{!picked && detection.id === w.id ? 'matched' : w.tagline}</small>
              </button>
            ))}
          </div>
          <button type="button" className="nx-wb__link" onClick={() => navigate({ name: 'workspaces' })}>Browse all environments →</button>
        </div>

        <div className="nx-wb__group">
          <h2 className="nx-wb__h2">Project</h2>
          <p className="nx-wb__note">Pick the project the next request is for, or press Open to go into one.</p>
          <div className="nx-wb__projects" role="radiogroup" aria-label="Project">
            {[...ordered.here, ...ordered.rest].slice(0, 6).map((p) => (
              <div key={p.id} className="nx-wb__projrow">
                <button type="button" role="radio" aria-checked={project?.id === p.id && !folder}
                  className={`nx-wb__proj${project?.id === p.id && !folder ? ' is-on' : ''}`}
                  onClick={() => setPick({ kind: 'existing', id: p.id })}
                  onDoubleClick={() => navigate({ name: 'project', id: p.id, tool: 'bench' })}>
                  <span className="nx-wb__dot" aria-hidden="true" />
                  <span className="nx-wb__pname">{p.name}</span>
                  <code className="nx-wb__path" title={p.rootPath}>{p.rootPath}</code>
                </button>
                <button type="button" className="nx-wb__link nx-wb__open" aria-label={`Open ${p.name}`}
                  onClick={() => navigate({ name: 'project', id: p.id, tool: 'bench' })}>Open</button>
              </div>
            ))}
            {folder && (
              <div className="nx-wb__proj is-on nx-wb__new" role="radio" aria-checked="true">
                <span className="nx-wb__dot" aria-hidden="true" />
                <label className="nx-visually-hidden" htmlFor="nx-wb-name">New project name</label>
                <input id="nx-wb-name" className="nx-wb__input" value={folder.name} onChange={(e) => setPick({ kind: 'new', folder: { ...folder, name: e.target.value } })} />
              </div>
            )}
          </div>
          {ws && !ws.defaultDomainId && folder && <p className="nx-wb__note">There is no {ws.label} domain yet, so the new project is filed under Software Engineering.</p>}
        </div>

        <div className="nx-wb__go">
          {target.note && <p className="nx-wb__note" role="status">{target.note}</p>}
          {error && <p className="nx-wb__err" role="status">{error}</p>}
          <button type="button" className="nx-wb__pick" disabled={busy} onClick={chooseFolder}>
            {folder ? 'Choose a different folder' : 'Choose folder'}
          </button>
        </div>
      </aside>
    </div>
  );
}
