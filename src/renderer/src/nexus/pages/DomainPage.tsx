// A registry domain that has no workspace yet (data science): an honest
// page that draws the domain's steps from the registry. It offers no action, no way to create a project and no
// project list, and it writes nothing: no workspace row is created for it.
import { useDomains } from '../data/useExecution';
import { navigate } from '../router/useRoute';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { domainOnlyLead, railFor } from '../workspaces/lifecycleModel';
import { LifecycleRail } from '../workspaces/LifecycleRail';
import { plainView } from '../workspaces/plainDomainCopy';

export function DomainPage({ id }: { id: string }) {
  const raw = useDomains().list.find((d) => d.id === id) ?? null;
  const view = raw ? plainView(raw) : null;
  if (!view) {
    return (
      <div className="nx-page">
        <EmptyState level={1} icon="close" title="We can't find that page" body="That workspace is not part of this version of Nexus."
          actions={<Button variant="primary" onClick={() => navigate({ name: 'workspaces' })}>Go to Workspaces</Button>} />
      </div>
    );
  }
  return (
    <div className="nx-page">
      <header className="nx-pagehead">
        <div className="nx-pagehead__text">
          <h1 tabIndex={-1}>{view.label}</h1>
          <p className="nx-lead">{domainOnlyLead(view)}</p>
        </div>
        <div className="nx-pagehead__actions">
          <Button onClick={() => navigate({ name: 'workspaces' })}>Back to Workspaces</Button>
        </div>
      </header>
      <p className="nx-muted">What it will be for: {view.description}</p>
      <LifecycleRail rail={railFor(view)} />
    </div>
  );
}
