// PlannedPage.tsx
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Icon } from '../icons';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { useNexusUi } from '../state/uiStore';
import { PLANNED } from './plannedContent';

export function PlannedPage({ which }: { which: keyof typeof PLANNED }) {
  const c = PLANNED[which];
  const actions = useShellActions();
  const focusIntent = useNexusUi((s) => s.focusIntent);
  const go = { files: () => actions.openIde(), projects: () => navigate({ name: 'projects' }), assistant: focusIntent, agents: () => navigate({ name: 'agents' }) }[c.todayAction];
  const label = { files: 'Open Files', projects: 'Open Projects', assistant: 'Ask the lead AI helper', agents: 'Open Agents' }[c.todayAction];
  return (
    <div className="nx-page">
      <header className="nx-pagehead">
        <span className="nx-pagehead__icon"><Icon name={c.icon} size={20} /></span>
        <h1 tabIndex={-1}>{c.title}</h1>
        <Badge>Coming later · not available yet</Badge>
      </header>
      <section className="nx-planned">
        <div><h2 className="nx-h3">What this will do</h2><p>{c.what}</p></div>
        <div><h2 className="nx-h3">How it fits</h2><p>{c.fits}</p></div>
        <div><h2 className="nx-h3">What you can do today</h2><p>{c.today}</p><Button variant="primary" onClick={go}>{label}</Button></div>
      </section>
    </div>
  );
}
