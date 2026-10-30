import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useStore } from '@/store/store';
import { WORKSPACES, getWorkspace } from '../workspaces/registry';
import { projectsInWorkspace } from '../workspaces/participation';
import { useParticipationIndex } from '../data/useParticipations';
import { recentProjects, relativeTime } from '../data/selectors';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { useShellActions } from '../shellActions';
import { provenanceStyle } from '../ui/ProvenanceMark';
import type { WorkspaceId } from '../workspaces/types';
import { entriesFromRegistry, matchEntries, resolveEnter } from './indexModel';
import { highlightSegments } from './highlight';
import { typewriterText } from './typewriter';
import { gridMove } from './gridNav';
import { slugOf, digitIndex } from './wallModel';
import { TileScene } from './TileScene';

const STATIC_PLACEHOLDER = 'Search: a kind of work, or a word like "model"';

function useReducedMotion(): boolean {
  const q = '(prefers-reduced-motion: reduce)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const on = () => setM(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, []);
  return m;
}

/** While the filter is empty and idle it types example searches. */
function useTypedPlaceholder(active: boolean): string {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => setTick((t) => t + 1), 95);
    return () => clearInterval(iv);
  }, [active]);
  return active ? `Search, e.g. "${typewriterText(tick)}"` : STATIC_PLACEHOLDER;
}

/** The workspace picker as an instrument wall: a dense dark console of
 *  panels, each a live readout of its kind of work, with the selection's
 *  details on a status bar. Keyboard: type to filter, arrows move, 1–9 jump,
 *  Enter opens. */
export function LauncherPage() {
  const entries = useMemo(() => entriesFromRegistry(WORKSPACES), []);
  const projects = useStore((s) => s.projects);
  const idx = useParticipationIndex();
  const last = useNexusUi((s) => s.lastWorkspace);
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  const actions = useShellActions();
  const reduced = useReducedMotion();
  const listId = useId();
  const grid = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const shown = useMemo(() => matchEntries(entries, query), [entries, query]);
  const [active, setActive] = useState(() => Math.max(0, entries.findIndex((e) => e.id === last)));
  const placeholder = useTypedPlaceholder(!reduced && !focused && query === '');

  const open = (id: string) => { setLast(id); navigate({ name: 'workspace', id: id as WorkspaceId }); };
  const onQuery = (q: string) => { setQuery(q); setActive(matchEntries(entries, q).length ? 0 : -1); };
  const columns = () => (grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(' ').filter(Boolean).length : 1);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { const id = resolveEnter(shown, active); if (id) open(id); return; }
    if (e.key === 'Escape') { onQuery(''); return; }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && query) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    setActive(gridMove(active, e.key, columns(), shown.length));
  };

  // Number keys jump straight to a panel (and Enter opens it) when focus is
  // not in a text field.
  useEffect(() => {
    const onDoc = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const i = digitIndex(e.key, shown.length);
      if (i >= 0) { e.preventDefault(); setActive(i); return; }
      if (e.key === 'Enter' && shown[active]) { e.preventDefault(); open(shown[active].id); }
      if (e.key === '/') { e.preventDefault(); input.current?.focus(); }
    };
    document.addEventListener('keydown', onDoc);
    return () => document.removeEventListener('keydown', onDoc);
  });

  const sel = shown[active] ? getWorkspace(shown[active].id) : null;
  const selProjects = sel ? recentProjects(projectsInWorkspace(idx, projects, sel.id).map((x) => x.project), projects.length) : [];
  const optionId = (id: string) => `${listId}-${id}`;

  return (
    <div className="nx-wall">
      <header className="nx-wall__head">
        <div>
          <p className="nx-wall__kicker">Workspaces</p>
          <h1 className="nx-wall__title" tabIndex={-1}>What are you working on?</h1>
        </div>
        <label className="nx-wall__find">
          <span aria-hidden="true">⌕</span>
          <span className="nx-visually-hidden">Search workspaces</span>
          <input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={shown[active] ? optionId(shown[active].id) : undefined}
            value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={onKey}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} placeholder={placeholder} />
          <span className="nx-wall__count" aria-hidden="true">{shown.length}/{entries.length}</span>
          <kbd className="nx-wall__kbd" aria-hidden="true">/</kbd>
        </label>
      </header>

      <div ref={grid} id={listId} role="listbox" aria-label="Workspaces" className="nx-wall__grid">
        {shown.map((e, i) => {
          const ws = getWorkspace(e.id);
          const count = ws ? projectsInWorkspace(idx, projects, ws.id).length : 0;
          return (
            <div key={e.id} id={optionId(e.id)} role="option" aria-selected={i === active}
              className={`nx-panel nx-prov${ws ? '' : ' nx-prov--none'}`}
              style={{ ['--i' as string]: i, ...provenanceStyle(ws?.hueSlot ?? null) } as CSSProperties}
              onMouseEnter={() => setActive(i)} onClick={() => open(e.id)}>
              <div className="nx-panel__head">
                <i className="nx-panel__led" aria-hidden="true" />
                <b>{slugOf(e.name)}</b>
                <span className="nx-panel__stat">{count ? `${count} project${count === 1 ? '' : 's'}` : 'no projects'}</span>
                <kbd aria-hidden="true">{i + 1 <= 9 ? i + 1 : ''}</kbd>
              </div>
              <div className="nx-panel__body"><TileScene id={e.id} /></div>
              <div className="nx-panel__foot">
                <b>{highlightSegments(e.name, query).map((s, k) => (s.hit ? <mark key={k} className="nx-hit">{s.text}</mark> : <span key={k}>{s.text}</span>))}</b>
                <span>{e.vocabulary.join(' · ').toLowerCase()}</span>
              </div>
            </div>
          );
        })}
      </div>
      {shown.length === 0 && <p className="nx-wall__none" role="status">No workspace matches "{query.trim()}". Press Escape to see them all.</p>}

      {sel && (
        <footer className="nx-wall__bar nx-prov" style={provenanceStyle(sel.hueSlot)} aria-live="polite">
          <span className="nx-wall__sel"><i className="nx-panel__led" aria-hidden="true" />selected <b>{sel.name}</b></span>
          <span className="nx-wall__desc">{sel.description}</span>
          <span className="nx-wall__stat">
            {selProjects.length ? <>{selProjects.length} project{selProjects.length === 1 ? '' : 's'} · last active {relativeTime(selProjects[0].updatedAt, Date.now())}</> : 'no projects yet'}
          </span>
          <span className="nx-wall__actions">
            <button type="button" className="nx-wall__btn" onClick={() => actions.openNewProject(sel.defaultDomainId)}>New project</button>
            <button type="button" className="nx-wall__btn nx-wall__btn--go" onClick={() => open(sel.id)}>Open {sel.label} ↵</button>
          </span>
        </footer>
      )}
    </div>
  );
}
