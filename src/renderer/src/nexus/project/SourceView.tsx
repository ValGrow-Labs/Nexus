import { useEffect, useState, type ReactNode } from 'react';
import type { Project } from '@shared/project';
import type { GitState, SpineNode } from './spineModel';
import { provenanceLine } from './sourceProvenance';
import { primaryViewOf } from '../workspaces/participation';
import { useParticipationIndex } from '../data/useParticipations';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { Button } from '../ui/Button';

function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(t); }, [ms]);
  return now;
}

function Provenance({ node, git, onRetry }: { node: SpineNode; git: GitState; onRetry: () => void }) {
  const now = useNow();
  if (node.kind !== 'source') return null;
  if (node.vcs === 'none') return <p className="nx-surface__prov">This folder is not set up with Git, the program that keeps track of changes. Looking at changes needs it.</p>;
  if (node.vcs === 'error') {
    return (
      <div className="nx-surface__prov" role="status">
        <span>Nexus could not read this folder's changes.</span>
        <Button variant="quiet" icon="refresh" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (node.vcs === 'unknown') return <p className="nx-surface__prov nx-muted" role="status">Looking at this folder's changes…</p>;
  const line = provenanceLine(node, git, now);
  return line ? <p className="nx-surface__prov">{line}</p> : null;
}

function Fact({ title, children }: { title: string; children: ReactNode }) {
  return <section className="nx-fact"><h2 className="nx-fact__title">{title}</h2>{children}</section>;
}

/** The work area: what Nexus actually knows about the project. */
export function SourceView({ project, node, git, onRetry }: { project: Project; node: SpineNode; git: GitState; onRetry: () => void }) {
  const ws = primaryViewOf(useParticipationIndex(), project.id);
  const langs = project.detectedLanguages.filter((l) => l.language);
  const entries = project.entryPoints.slice(0, 6);
  const suites = project.testSuites;
  const docs = project.documentationFiles;
  // "Nothing found" means something only for a project of code (a data project has no languages or tests to find).
  const empty = ws?.id === 'sde' && !langs.length && !project.frameworks.length && !entries.length && !suites.length && !docs.length;
  return (
    <section className="nx-surface" aria-labelledby="nx-surface-title">
      <header className="nx-surface__head">
        <h1 id="nx-surface-title" className="nx-surface__title" tabIndex={-1}>{project.name}</h1>
        {node.kind === 'source' && (node.branch || node.head) && (
          <span className="nx-id nx-surface__ref">{[node.branch, node.head?.shortSha].filter(Boolean).join(' · ')}</span>
        )}
      </header>
      <div className="nx-surface__provline">
        <ProvenanceMark slot={ws ? ws.hueSlot : null} />
        <Provenance node={node} git={git} onRetry={onRetry} />
      </div>
      {empty && <p className="nx-muted">No code, tests or notes found in this folder yet.</p>}
      {langs.length > 0 && (
        <Fact title="Languages">
          <ul className="nx-fact__list">{langs.map((l) => <li key={l.language}>{l.language}{l.fileCount > 0 ? <span className="nx-muted"> {l.fileCount} {l.fileCount === 1 ? 'file' : 'files'}</span> : null}</li>)}</ul>
        </Fact>
      )}
      {project.frameworks.length > 0 && (
        <Fact title="Frameworks"><ul className="nx-fact__list">{project.frameworks.map((f) => <li key={f}>{f}</li>)}</ul></Fact>
      )}
      {entries.length > 0 && (
        <Fact title="Main files"><ul className="nx-fact__list">{entries.map((e) => <li key={e} className="nx-id">{e}</li>)}</ul></Fact>
      )}
      {suites.length > 0 && (
        <Fact title="Tests">
          <ul className="nx-fact__list">
            {suites.map((s, i) => (
              <li key={`${s.framework}-${i}`}>{s.framework}{s.testCommand ? <> <code className="nx-id">{s.testCommand}</code></> : null}</li>
            ))}
          </ul>
        </Fact>
      )}
      {docs.length > 0 && (
        <Fact title="Notes and guides"><ul className="nx-fact__list">{docs.map((d) => <li key={d} className="nx-id">{d}</li>)}</ul></Fact>
      )}
    </section>
  );
}
