import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DomainId } from '@shared/domain';
import { useStore } from '@/store/store';
import { WORKSPACES, getWorkspace } from '../workspaces/registry';
import { projectsInWorkspace } from '../workspaces/participation';
import { useParticipationIndex } from '../data/useParticipations';
import { recentProjects } from '../data/selectors';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { useAssistant } from '../assistant/useAssistant';
import { provenanceStyle } from '../ui/ProvenanceMark';
import { emblemPath } from '../launcher/emblems';
import { detectEnvironment, IDEAS, buildStartRequest, chosenEnvironment, startBlocker } from './startModel';

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
  const port = useAssistant();

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

  const status = port.status;
  const blocker = startBlocker({ text, envId, hasProject: !!project || !!folder, assistant: status.state });
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
    if (blocker || !ws) return;
    setBusy(true); setError(null);
    try {
      let target = project;
      if (!target && folder) {
        const domainId = (ws.defaultDomainId ?? 'software-engineering') as DomainId;
        const res = await window.cth.projectCreate({ name: folder.name.trim() || 'New project', rootPath: folder.path, domainId, description: text.trim() || undefined });
        if (!res.ok || !res.project) throw new Error(res.error || 'The project could not be created.');
        setProjects(await window.cth.projectList());
        target = res.project;
        setPick({ kind: 'existing', id: res.project.id });
      }
      if (!target) return;
      const req = buildStartRequest({ text, workspaceLabel: ws.label, project: { name: target.name, rootPath: target.rootPath } });
      const sent = port.send({ text: req.text, contextHeader: req.contextHeader });
      if (!sent.ok) throw new Error(sent.error);
      try { const p = await window.cth.projectSetActive(target.id); if (p) setActiveProject(p); } catch { /* opening still works */ }
      setLast(ws.id);
      navigate({ name: 'project', id: target.id, tool: 'bench' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const agentLine = status.state === 'unavailable' ? 'No lead agent is running'
    : status.state === 'starting' ? `Lead agent · ${status.target.name} (starting; your request waits in its queue)`
    : `Lead agent · ${status.target.name}${status.deliveryPaused ? ' (delivery paused; release it in Agents)' : ''}`;

  return (
    <div className="nx-wb" style={ws ? provenanceStyle(ws.hueSlot) : undefined}>
      {/* Left: the request and what will happen */}
      <section className="nx-wb__doc" aria-labelledby="nx-wb-h">
        <h1 id="nx-wb-h" className="nx-wb__eyebrow" tabIndex={-1}>New work</h1>
        <label className="nx-visually-hidden" htmlFor="nx-wb-req">Describe what you want to work on</label>
        <textarea
          id="nx-wb-req" ref={input} className="nx-wb__req" rows={1} value={text}
          placeholder="What are you working on?"
          onChange={(e) => { setText(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void start(); } }}
        />

        {!text.trim() ? (
          <div className="nx-wb__ideas" aria-label="Examples">
            <span>Try</span>
            {IDEAS.map((idea) => (
              <button key={idea.label} type="button" className="nx-wb__idea" onClick={() => { setText(idea.prompt); setPicked(null); input.current?.focus(); }}>{idea.label}</button>
            ))}
          </div>
        ) : (
          <p className="nx-wb__why" aria-live="polite">
            {picked && ws ? <>Going to <b>{ws.name}</b>, chosen by you.</>
              : ws ? <>Matched <b>{ws.name}</b> from <span className="nx-wb__words">{detection.matched.join(' · ')}</span>.</>
              : <>No environment matched these words yet. Pick one on the right.</>}
          </p>
        )}

        <div className="nx-wb__plan">
          <h2 className="nx-wb__h2">When you press Start</h2>
          <ol>
            <li><span>{folder ? <>A new project is created in <code>{folder.path}</code></> : project ? <>The work happens in <b>{project.name}</b></> : <>The work happens in the project you choose</>}</span></li>
            <li><span>Your request goes to the lead agent{status.state === 'unavailable' ? ' (none is running yet)' : ''}</span></li>
            <li><span>The project opens so you can follow the agent's work</span></li>
          </ol>
        </div>

        {ws && ws.plannedModules.length > 0 && (
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
          <div className="nx-wb__projects" role="radiogroup" aria-label="Project">
            {[...ordered.here, ...ordered.rest].slice(0, 6).map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={project?.id === p.id && !folder}
                className={`nx-wb__proj${project?.id === p.id && !folder ? ' is-on' : ''}`}
                onClick={() => setPick({ kind: 'existing', id: p.id })}>
                <span className="nx-wb__dot" aria-hidden="true" />
                <span className="nx-wb__pname">{p.name}</span>
                <code className="nx-wb__path" title={p.rootPath}>{p.rootPath}</code>
              </button>
            ))}
            {folder ? (
              <div className="nx-wb__proj is-on nx-wb__new" role="radio" aria-checked="true">
                <span className="nx-wb__dot" aria-hidden="true" />
                <label className="nx-visually-hidden" htmlFor="nx-wb-name">New project name</label>
                <input id="nx-wb-name" className="nx-wb__input" value={folder.name} onChange={(e) => setPick({ kind: 'new', folder: { ...folder, name: e.target.value } })} />
                <button type="button" className="nx-wb__link" onClick={chooseFolder}>Change folder</button>
              </div>
            ) : (
              <button type="button" className="nx-wb__proj nx-wb__choose" onClick={chooseFolder}>+ New project in a folder…</button>
            )}
          </div>
          {ws && !ws.defaultDomainId && folder && <p className="nx-wb__note">There is no {ws.label} domain yet, so the new project is filed under Software Engineering.</p>}
        </div>

        <div className="nx-wb__go">
          <p className={`nx-wb__agent nx-wb__agent--${status.state}`}><i aria-hidden="true" />{agentLine}</p>
          {(error || (tried && blocker)) && <p className="nx-wb__err" role="alert">{error ?? blocker}</p>}
          {status.state === 'unavailable'
            ? <button type="button" className="nx-wb__cta" onClick={port.openConversation}>Open Agents to start a lead agent</button>
            : <button type="button" className="nx-wb__cta" disabled={busy} aria-disabled={!!blocker} onClick={start}>
                {busy ? (folder ? 'Creating project…' : 'Sending…') : 'Start with the lead agent'}
              </button>}
          {status.state !== 'unavailable' && <span className="nx-wb__hint">Ctrl + Enter from the request also starts</span>}
        </div>
      </aside>
    </div>
  );
}
