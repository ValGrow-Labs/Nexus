import { useEffect, useRef, useState } from 'react';
import type { DeploymentView } from '@shared/nexus/ipc';
import { Button } from '../ui/Button';
import { openLoopbackUrl } from '../data/nexusClient';
import { PREVIEW_EMBED_LABEL, PREVIEW_NOT_ANSWERING, deploymentWord, isLive } from './previewModel';

/** A Nexus overlay (a sheet, the search) is open: the native view would paint above it, so the preview is hidden meanwhile. */
const OVERLAY = '.nx-sheet-layer, .nx-palette, [role="dialog"][aria-modal="true"]';

/**
 * The running app inside Nexus. The app itself is drawn by a main-owned, isolated view (src/main/previewHost.ts) placed over the empty frame below;
 * this component only reports where the frame is and shows the toolbar: Reload, Open in browser, Stop and the plain state. It names the deployment,
 * never an address: main reads the port itself.
 */
export function PreviewPanel({ deployment, onStop, stopping }: { deployment: DeploymentView; onStop: () => void; stopping: boolean }) {
  const frame = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [refused, setRefused] = useState(false);
  const live = isLive(deployment);
  const id = deployment.id;
  // Shown once the app answers (or stopped answering) and its published port is known; while it starts the frame says so (main refuses a view before the port exists).
  const showing = live && (deployment.status === 'healthy' || deployment.status === 'unhealthy') && deployment.hostPort !== null;

  useEffect(() => {
    if (!showing) return undefined;
    const api = window.cth;
    let alive = true;
    const bounds = () => {
      const el = frame.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
    };
    const b0 = bounds();
    if (!b0) return undefined;
    void api.previewOpen(id, b0).then((r) => { if (alive && !r.ok) setRefused(true); });
    const sync = () => {
      const b = bounds();
      if (b) void api.previewBounds(b);
      void api.previewVisible(!document.querySelector(OVERLAY));
    };
    const ro = new ResizeObserver(sync);
    if (frame.current) ro.observe(frame.current);
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    const off = api.onPreviewState((s) => {
      if (s.deploymentId !== id) return;
      if (s.state === 'ready') setView('ready'); else if (s.state === 'failed') setView('failed'); else if (s.state === 'loading') setView('loading');
    });
    return () => {
      alive = false;
      ro.disconnect(); mo.disconnect();
      window.removeEventListener('resize', sync); window.removeEventListener('scroll', sync, true);
      off();
      void api.previewClose();
    };
  }, [id, showing]);

  const openOutside = () => { try { if (deployment.url) void openLoopbackUrl(new URL(deployment.url).origin); } catch { /* no address */ } };
  const word = deploymentWord(deployment);
  return (
    <section className="nx-preview" aria-label="Preview of your app" data-state={deployment.status}>
      <div className="nx-preview__bar">
        <span className="nx-preview__word" role="status"><span className="nx-preview__dot" aria-hidden="true" />{word}</span>
        <span className="nx-preview__acts">
          <Button variant="quiet" disabled={!showing} onClick={() => { void window.cth.previewReload(); }}>Reload</Button>
          <Button variant="quiet" disabled={!showing || !deployment.url} onClick={openOutside}>Open in browser</Button>
          {live && <Button variant="secondary" disabled={stopping} onClick={onStop}>{stopping ? 'Stopping…' : 'Stop'}</Button>}
        </span>
      </div>
      {showing && !refused && (deployment.status === 'unhealthy' || view === 'failed') && <p className="nx-muted" role="status">{PREVIEW_NOT_ANSWERING}</p>}
      <div ref={frame} className="nx-preview__frame" role="region" aria-label={PREVIEW_EMBED_LABEL} data-view={showing ? view : 'none'}>
        {!showing && <p className="nx-muted nx-preview__empty">{live ? 'Starting your app…' : `${word}. Press Preview to run it again.`}</p>}
        {showing && refused && <p className="nx-muted nx-preview__empty">Nexus could not show the app here. Open it in your browser instead.</p>}
      </div>
    </section>
  );
}
