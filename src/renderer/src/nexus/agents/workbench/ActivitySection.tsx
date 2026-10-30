import { useEffect, useId, useState } from 'react';
import { displayNameForId } from '@shared/agentDisplay';
import { useAgentDisplay } from '../agentIdentity';
import { activityLine, type LogEntry } from './teamModel';

const POLL_MS = 3000;

function timeOf(ts?: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Activity: the agents' event log, newest first, and the shared board. The
 *  board is the agents' own text and is shown untouched. */
export function ActivitySection() {
  const { canon, hint } = useAgentDisplay();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [board, setBoard] = useState('');
  const [loaded, setLoaded] = useState(false);
  const uid = useId();

  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      try { const l = (await window.cth.hiveLog(60)) as LogEntry[]; if (alive) setLog(l); } catch { /* keep last good */ }
      try { const b = await window.cth.hiveBoard(); if (alive) setBoard(b); } catch { /* keep last good */ }
      if (alive) setLoaded(true);
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const name = (id: string): string => displayNameForId(id, canon, hint);
  const entries = [...log].reverse();

  return (
    <div className="nxs">
      <div className="nxs__inner nxs__inner--split">
        <section className="nxs__col" aria-labelledby={`${uid}-log`}>
          <header className="nxs__head">
            <h3 className="nxs__title" id={`${uid}-log`}>Activity</h3>
            <p className="nxs__lede">The last 60 things that happened, newest first.</p>
          </header>
          {loaded && entries.length === 0 ? (
            <p className="nxs__note">No activity yet.</p>
          ) : (
            <ol className="nxact">
              {entries.map((e, i) => (
                <li key={`${e.ts ?? ''}-${i}`} className="nxact__item">
                  <span className="nxact__time">{timeOf(e.ts)}</span>
                  <span className="nxact__text">{activityLine(e, name)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section className="nxs__col" aria-labelledby={`${uid}-board`}>
          <header className="nxs__head">
            <h3 className="nxs__title" id={`${uid}-board`}>Board</h3>
            <p className="nxs__lede">Notes the AI helpers leave for each other.</p>
          </header>
          {loaded && <pre className="nxa-board" tabIndex={0} aria-label="Board">{board || 'The board is empty.'}</pre>}
        </section>
      </div>
    </div>
  );
}
