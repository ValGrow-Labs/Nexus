import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { SpineGroup, SpineLine } from './spineModel';
import { nodeLabel, tabStopId } from './spineModel';
import { SPINE_TRUNCATED_TEXT, kindLabel, statusLabel } from './artifactModel';
import { provenanceStyle } from '../ui/ProvenanceMark';
import { LifecycleRail } from '../workspaces/LifecycleRail';
import type { RailView } from '../workspaces/lifecycleModel';

/** A group that is no longer active says so in words: its project was removed from that workspace, or closed it. */
const MUTED_WORD: Record<NonNullable<SpineGroup['muted']>, string> = { withdrawn: 'removed', complete: 'closed' };

export function Spine({ groups, selectedId, onSelect, line, onRetryLine, truncated = false, focusRequest, onFocused, checks, rails }: {
  groups: SpineGroup[]; selectedId: string; onSelect: (id: string, el?: HTMLElement) => void;
  /** What the line under the nodes says about artifacts (see spineLine). */
  line: SpineLine;
  onRetryLine: () => void;
  /** The project has more artifacts than the read returned: a note says which are drawn. */
  truncated?: boolean;
  /** A node to focus once it renders (a freshly saved artifact); cleared through onFocused. */
  focusRequest?: string | null;
  onFocused?: () => void;
  /** Node id -> the checks word of its shown version ("Checks passed", "Checking…"), for kinds that are checked. */
  checks?: ReadonlyMap<string, string>;
  /** Workspace id -> its domain's lifecycle rail, drawn compact under the group label. */
  rails?: ReadonlyMap<string, RailView>;
}) {
  const flat = groups.flatMap((g) => g.nodes.map((n) => n.id));
  const active = tabStopId(flat, selectedId);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const flatKey = flat.join('|');
  useEffect(() => {
    if (!focusRequest) return;
    const el = refs.current.get(focusRequest);
    if (el && el.isConnected) { el.focus(); onFocused?.(); }
  }, [focusRequest, flatKey, onFocused]);
  const focusAt = (i: number) => { const id = flat[Math.max(0, Math.min(flat.length - 1, i))]; refs.current.get(id)?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(flat.length - 1); }
  };
  let i = -1;
  return (
    <nav className="nx-spine" aria-label="Project timeline">
      {groups.map((g) => (
        <div key={g.workspaceId} className={`${g.hueSlot === null ? 'nx-spine__group nx-prov nx-prov--none' : 'nx-spine__group nx-prov'}${g.muted ? ' nx-spx-muted' : ''}`} style={provenanceStyle(g.hueSlot)}>
          <p className="nx-spine__label">{g.label}{g.muted && <span className="nx-spx-state">{MUTED_WORD[g.muted]}</span>}</p>
          {!g.muted && rails?.get(g.workspaceId) && <LifecycleRail rail={rails.get(g.workspaceId)!} compact />}
          <ol className="nx-spine__nodes">
            {g.nodes.map((n) => {
              i += 1; const idx = i;
              const sel = n.id === selectedId;
              if (n.kind === 'artifact') {
                return (
                  <li key={n.id} className="nx-spine__item">
                    {idx > 0 && <span className="nx-spine__link" aria-hidden="true" />}
                    <button type="button" ref={(el) => { if (el) refs.current.set(n.id, el); }}
                      className={`nx-node${n.status === 'draft' ? ' nx-node--draft' : ''}`} aria-current={sel ? 'true' : undefined}
                      aria-label={checks?.get(n.id) ? `${nodeLabel(n)}, ${checks.get(n.id)}` : nodeLabel(n)} tabIndex={n.id === active ? 0 : -1} onClick={(e) => onSelect(n.id, e.currentTarget)} onKeyDown={(e) => onKey(e, idx)}>
                      <span className="nx-node__k">{kindLabel(n.artifactKind)} · {statusLabel(n.status)}{checks?.get(n.id) ? ` · ${checks.get(n.id)}` : ''}</span>
                      <span className="nx-node__n" title={n.name}>{n.name}</span>
                      <span className="nx-node__v nx-id">v{n.versionNo}</span>
                    </button>
                  </li>
                );
              }
              const nodeName = n.kind === 'changes' ? `${n.fileCount} ${n.fileCount === 1 ? 'file' : 'files'}` : n.kind === 'source' && n.branch ? n.branch : 'Project files';
              return (
                <li key={n.id} className="nx-spine__item">
                  {idx > 0 && <span className="nx-spine__link" aria-hidden="true" />}
                  <button type="button" ref={(el) => { if (el) refs.current.set(n.id, el); }}
                    className={`nx-node${n.kind === 'changes' ? ' nx-node--draft' : ''}`} aria-current={sel ? 'true' : undefined}
                    aria-label={nodeLabel(n)} tabIndex={n.id === active ? 0 : -1} onClick={(e) => onSelect(n.id, e.currentTarget)} onKeyDown={(e) => onKey(e, idx)}>
                    <span className="nx-node__k">{n.kind === 'changes' ? 'not saved yet' : n.vcs === 'git' ? 'your project' : 'folder'}</span>
                    <span className="nx-node__n" title={nodeName}>{nodeName}</span>
                    {n.kind === 'source' && n.head && <span className="nx-node__v nx-id">{n.head.shortSha}</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      {truncated && <p className="nx-spine__future" role="status">{SPINE_TRUNCATED_TEXT}</p>}
      {line?.kind === 'empty' && <p className="nx-spine__future">Nothing has been saved yet. Items your project makes will show up here, in order.</p>}
      {line?.kind === 'loading' && <p className="nx-spine__future" role="status">Reading your saved items…</p>}
      {line?.kind === 'error' && (
        <p className="nx-spine__future nx-spx-line" role="status">
          <span>{line.text}</span>
          {line.retry && <button type="button" className="nx-btn nx-btn--quiet" onClick={onRetryLine}><span>Try again</span></button>}
        </p>
      )}
    </nav>
  );
}
