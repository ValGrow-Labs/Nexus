import type { GitState } from './spineModel';

/** The top of the project page: the project, what kind of work it is, and the project's main version, in one line each. */
export function ProjectHeader({ name, kind, git }: { name: string; kind: string; git: GitState }) {
  const head = git.status === 'ready' && git.isRepo ? git.head : null;
  const branch = git.status === 'ready' && git.isRepo ? git.branch : null;
  return (
    <header className="nx-phead" aria-label="About this project">
      <p className="nx-phead__name">{name}</p>
      <p className="nx-phead__meta">
        <span>Kind of work: {kind}</span>
        {branch && (
          <span>Your project’s main version: {branch}{head ? ` (${head.shortSha}${head.subject ? `, ${head.subject}` : ''})` : ''}</span>
        )}
      </p>
    </header>
  );
}
