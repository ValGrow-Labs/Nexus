import { repoHealth } from '../data/selectors';

const TIP = 'A rough score from what Nexus found in this project: tests, notes, the main files, and whether Git is tracking changes.';

export function RepoHealthBar({ project }: { project: unknown }) {
  const v = repoHealth(project);
  if (v === null) return null;
  return (
    <div className="nx-health" title={TIP}>
      <span className="nx-health__label">Project health <strong>{v}</strong></span>
      <span className="nx-health__track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label={`Project health ${v} of 100`}>
        <span className="nx-health__fill" style={{ width: `${v}%` }} />
      </span>
    </div>
  );
}
