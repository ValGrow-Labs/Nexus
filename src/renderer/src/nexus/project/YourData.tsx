import { useCallback, useEffect, useRef, useState } from 'react';
import type { DatasetsView } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { Button } from '../ui/Button';
import {
  DAMAGED_LINE, EMPTY_LINE, REMOVE_LABEL, REMOVE_NOTE, UPLOADING_LABEL, UPLOAD_LABEL, YOUR_DATA_TITLE, dataFailureText, dataRows,
  privacyLine, useProjectData
} from './yourDataModel';

/**
 * "Your data" (a Machine learning project's work area): upload a file through main's own window, see the files, remove Nexus's copy.
 * Nothing at all for any other project (main answers `applies: false`, by the same rule the safe space uses) or while it cannot be read.
 * The renderer never sends or receives a location: "Upload a dataset" only asks main to open its window.
 */
export function YourData({ projectId }: { projectId: string }) {
  const [view, setView] = useState<DatasetsView | null>(null);
  const [busy, setBusy] = useState<'add' | string | null>(null);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  const setCount = useProjectData((s) => s.set);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const take = useCallback((v: DatasetsView) => { setView(v); setCount(projectId, v.applies ? v.datasets.length : 0); }, [projectId, setCount]);
  useEffect(() => {
    setView(null); setNote(null);
    void nexusClient.datasets({ op: 'list', projectId }).then((r) => { if (alive.current && r.ok) take(r.data); });
  }, [projectId, take]);

  if (!view || !view.applies) return null;
  const rows = dataRows(view, Date.now());

  const upload = async () => {
    if (busy) return;
    setBusy('add'); setNote(null);
    const r = await nexusClient.datasets({ op: 'add', projectId });
    if (!alive.current) return;
    setBusy(null);
    if (!r.ok) { setNote({ text: dataFailureText(r), alert: true }); return; }
    take(r.data);
  };
  const remove = async (datasetId: string) => {
    if (busy) return;
    setBusy(datasetId); setNote(null);
    const r = await nexusClient.datasets({ op: 'remove', projectId, datasetId });
    if (!alive.current) return;
    setBusy(null);
    if (!r.ok) { setNote({ text: dataFailureText(r), alert: true }); return; }
    take(r.data);
  };

  return (
    <section className="nx-data" aria-labelledby="nx-data-title">
      <div className="nx-data__head">
        <h2 id="nx-data-title" className="nx-data__title">{YOUR_DATA_TITLE}</h2>
        <Button variant="primary" disabled={busy !== null} onClick={() => { void upload(); }}>{busy === 'add' ? UPLOADING_LABEL : UPLOAD_LABEL}</Button>
      </div>
      <p className="nx-muted nx-data__privacy">{privacyLine(view.aiOnThisComputer)}</p>
      {view.damaged && <p className="nx-passport__note" role="alert">{DAMAGED_LINE}</p>}
      {rows.length === 0
        ? <p className="nx-data__empty">{EMPTY_LINE}</p>
        : (
          <ul className="nx-data__list" aria-label="Your data files">
              {rows.map((d) => (
                <li key={d.id} className="nx-data__row">
                  <div className="nx-data__text">
                    <b className="nx-data__name">{d.name}</b>
                    <span className="nx-data__facts">{d.facts}</span>
                    <span className="nx-muted nx-data__added">{d.added}</span>
                  </div>
                  <Button disabled={busy !== null} ariaLabel={d.removeLabel} title={REMOVE_NOTE} onClick={() => { void remove(d.id); }}>{busy === d.id ? 'Removing…' : REMOVE_LABEL}</Button>
                </li>
              ))}
          </ul>
        )}
      {note && <p className="nx-passport__note" role="alert">{note.text}</p>}
    </section>
  );
}
