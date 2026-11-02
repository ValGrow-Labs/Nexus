import type { ReactNode } from 'react';
import type { ProjectTool } from '../router/routes';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { Icon, type NexusIconName } from '../icons';

const ROUTES: { tool: ProjectTool; label: string; icon: NexusIconName }[] = [
  { tool: 'bench', label: 'Work area', icon: 'bench' },
  { tool: 'changes', label: 'Suggested changes', icon: 'changes' },
  { tool: 'completion', label: 'Checklist', icon: 'completion' },
  { tool: 'runs', label: 'Tasks', icon: 'runs' },
  { tool: 'try', label: 'Try it', icon: 'rocket' }
];

/** Vertical project tools: the routed tools, then the two app actions. */
export function ToolRail({ projectId, rootPath, tool, hasChanges, canTry = true, codeTools = true, onOpenTerminal, extra }: { extra?: ReactNode; canTry?: boolean; codeTools?: boolean; projectId: string; rootPath: string; tool: ProjectTool; hasChanges: boolean; onOpenTerminal: () => void }) {
  const actions = useShellActions();
  // The task list is engine output a person rarely needs: it is out of the rail unless it is the page being shown (it is in Details, and a running request links to it).
  // The checklist has nothing on it yet (it comes later): it is out of the rail too, unless it is the page being shown (an old plan link opens it).
  const items = ROUTES.filter((r) => (r.tool !== 'changes' || hasChanges || tool === 'changes') && (r.tool !== 'try' || canTry || tool === 'try') && (r.tool !== 'runs' || tool === 'runs')
    && (r.tool !== 'completion' || tool === 'completion'));
  return (
    <nav className="nx-rail" aria-label="Project tools">
      {items.map((r) => (
        <button key={r.tool} type="button" className="nx-rail__item" title={r.label} aria-label={r.label}
          aria-current={r.tool === tool ? 'page' : undefined}
          onClick={() => navigate({ name: 'project', id: projectId, tool: r.tool })}>
          <Icon name={r.icon} size={17} />
        </button>
      ))}
      {/* A person working with data has no use for a code editor or a terminal: they are for projects of code. */}
      {codeTools && (<>
      <span className="nx-rail__sep" data-desktop-only aria-hidden="true" />
      <button type="button" className="nx-rail__item" data-desktop-only title="Files" aria-label="Open your project's files" onClick={() => actions.openIde(rootPath)}>
        <Icon name="files" size={17} />
      </button>
      <button type="button" className="nx-rail__item" data-desktop-only title="Terminal" aria-label="Open a terminal in this project" onClick={onOpenTerminal}>
        <Icon name="terminal" size={17} />
      </button>
      </>)}
      {extra}
    </nav>
  );
}
