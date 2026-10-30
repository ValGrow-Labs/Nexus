import type { ExecAvailability } from '../data/executionModel';
import { noticeFor } from '../data/executionModel';
import { Button } from '../ui/Button';
import { termName } from '../data/glossary';

/** One role="status" line while tasks cannot run here (a held upgrade, execution off, Docker stopped, disk below
 *  the gate), with "Get this computer ready" when the fix is on this computer. Renders nothing when tasks can run. */
export function ExecutionNotice({ availability, onSetup }: { availability: ExecAvailability; onSetup?: () => void }) {
  // A recommendation ("40 GB is better") blocks nothing: it is said inside "Get this computer ready", not on the project page.
  if (availability.kind === 'ready') return null;
  const n = noticeFor(availability);
  if (!n) return null;
  return (
    <div className="nx-platform-notice nx-exn" role="status">
      <span className="nx-platform-notice__text">{n.text}</span>
      {n.setup && onSetup && <Button variant="quiet" onClick={onSetup}>{termName('getReady')}</Button>}
    </div>
  );
}
