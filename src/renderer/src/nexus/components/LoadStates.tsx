import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';

export function RowsSkeleton({ count = 4 }: { count?: number }) {
  return <div className="nx-rows" aria-busy="true" aria-label="Loading projects">{Array.from({ length: count }, (_, i) => <Skeleton key={i} className="nx-skel-row" />)}</div>;
}

export function LoadError({ error, onRetry, level = 2 }: { error: string | null; onRetry: () => void; level?: 1 | 2 | 3 | 4 }) {
  return <EmptyState level={level} icon="refresh" title="Couldn't load your projects" body={error ?? 'Nexus could not read your list of projects. Press Retry. If it keeps happening, restart the app.'} actions={<Button variant="primary" icon="refresh" onClick={onRetry}>Retry</Button>} />;
}
