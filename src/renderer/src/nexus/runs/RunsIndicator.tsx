import { formatRoute } from '../router/routes';
import { isRunLive } from './runModel';
import { useRuns } from './useRuns';

/** A pill in the context bar while any request is waiting, being worked on, or
 *  waiting for the user. Renders nothing otherwise. */
export function RunsIndicator() {
  const live = useRuns().filter((e) => isRunLive(e.run));
  if (live.length === 0) return null;
  const newest = live[live.length - 1].request;
  const href = newest.projectId ? formatRoute({ name: 'project', id: newest.projectId, tool: 'runs' }) : formatRoute({ name: 'agents' });
  const needsInput = live.some((e) => e.run.needsInput);
  const text = `${live.length} ${live.length === 1 ? 'request' : 'requests'}`;
  return (
    <a className={`nx-runpill cth-titlebar-nodrag${needsInput ? ' nx-runpill--input' : ''}`} href={href}
      aria-label={`${live.length} open ${live.length === 1 ? 'request' : 'requests'}${needsInput ? ', waiting for you' : ''}. Open Runs`}>
      {text}
    </a>
  );
}
