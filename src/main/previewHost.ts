/**
 * The live preview's view (main process only): shows the app of ONE live dev deployment inside the Nexus window, isolated from Nexus.
 *
 * - A main-owned `WebContentsView` (never a `<webview>` or an `<iframe>` of the Nexus page), on its own in-memory session partition that is wiped
 *   when the preview closes: no preload, no Node, `sandbox`, `contextIsolation`, no `webviewTag`, nothing shared with the Nexus renderer.
 * - It can load ONE origin, `http://127.0.0.1:<port>` (src/shared/nexus/previewPolicy.ts): navigation, redirects and every sub-request to any other
 *   address (including the other loopback servers on this computer) are cancelled; new windows, downloads and every permission are refused.
 * - The renderer never names the port: it names a deployment, and main reads that deployment's published port from its own records (live, on
 *   127.0.0.1) before it loads anything. The renderer only reports where on the window the panel sits (checked bounds).
 * - One preview at a time; opening another closes the first. It closes with the window, when the deployment ends, and when Nexus quits.
 */
import { WebContentsView, session, type BrowserWindow, type Session } from 'electron';
import {
  checkPreviewBounds, isPreviewNavigationAllowed, isPreviewPermissionAllowed, isPreviewRequestAllowed, previewOrigin, type PreviewBounds
} from '../shared/nexus/previewPolicy';

export type PreviewState = 'loading' | 'ready' | 'failed' | 'closed';

export interface PreviewTarget { deploymentId: string; port: number }

interface Open { view: WebContentsView; win: BrowserWindow; ses: Session; target: PreviewTarget; closed: boolean }

let current: Open | null = null;
let seq = 0;
let onState: (s: PreviewState, t: PreviewTarget | null) => void = () => undefined;

/** Main registers where the state of the preview goes (the Nexus window's renderer, as a push). */
export function setPreviewStateSink(fn: (s: PreviewState, t: PreviewTarget | null) => void): void { onState = fn; }

export function currentPreview(): PreviewTarget | null { return current && !current.closed ? { ...current.target } : null; }

/** Closes the view, wipes its session and tells the sink. Safe to call at any time. */
export function closePreview(): void {
  const o = current;
  if (!o || o.closed) { current = null; return; }
  o.closed = true; current = null;
  try { o.win.contentView.removeChildView(o.view); } catch { /* the window is gone */ }
  try { o.view.webContents.close(); } catch { /* already closed */ }
  void o.ses.clearStorageData().catch(() => undefined);
  void o.ses.clearCache().catch(() => undefined);
  try { onState('closed', o.target); } catch { /* the sink never breaks closing */ }
}

/**
 * Shows the preview of `target` in `win` at `bounds`. The caller (main's IPC handler) has already checked that the deployment is live on 127.0.0.1
 * with this port. Returns false for bounds that are not a rectangle.
 */
export function openPreview(win: BrowserWindow, target: PreviewTarget, boundsIn: unknown): boolean {
  const bounds = checkPreviewBounds(boundsIn);
  if (!bounds) return false;
  closePreview();
  // In memory only (no `persist:` prefix), a fresh partition for every preview.
  const ses = session.fromPartition(`nexus-preview-${++seq}`);
  const port = target.port;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(isPreviewPermissionAllowed(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => isPreviewPermissionAllowed(permission));
  // Every request the page makes: only its own origin gets through.
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isPreviewRequestAllowed(details.url, port) }));
  ses.on('will-download', (e) => e.preventDefault());
  const view = new WebContentsView({
    webPreferences: {
      session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, spellcheck: false, enableWebSQL: false, backgroundThrottling: true
    }
  });
  const o: Open = { view, win, ses, target: { ...target }, closed: false };
  current = o;
  const wc = view.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (e: { preventDefault(): void }, url: string): void => { if (!isPreviewNavigationAllowed(url, port)) e.preventDefault(); };
  wc.on('will-navigate', (e, url) => guard(e, url));
  wc.on('will-redirect', (e, url) => guard(e, url));
  wc.on('will-frame-navigate', (e) => guard(e, e.url));
  wc.on('did-start-loading', () => { if (!o.closed) onState('loading', o.target); });
  wc.on('did-finish-load', () => { if (!o.closed) onState('ready', o.target); });
  wc.on('did-fail-load', (_e, code, _d, _url, isMain) => { if (!o.closed && isMain && code !== -3) onState('failed', o.target); });
  wc.on('render-process-gone', () => { if (!o.closed) onState('failed', o.target); });
  wc.setAudioMuted(true);
  win.contentView.addChildView(view);
  view.setBounds(bounds);
  win.once('closed', () => { if (current === o) closePreview(); });
  void wc.loadURL(`${previewOrigin(port)}/`).catch(() => { if (!o.closed) onState('failed', o.target); });
  return true;
}

export function setPreviewBounds(boundsIn: unknown): boolean {
  const o = current; const b: PreviewBounds | null = checkPreviewBounds(boundsIn);
  if (!o || o.closed || !b) return false;
  o.view.setBounds(b);
  return true;
}

/** Hides or shows the view without closing it (a modal of Nexus opens over the window: a native view would paint above it). */
export function setPreviewVisible(visible: boolean): boolean {
  const o = current;
  if (!o || o.closed) return false;
  o.view.setVisible(visible === true);
  return true;
}

export function reloadPreview(): boolean {
  const o = current;
  if (!o || o.closed) return false;
  o.view.webContents.reloadIgnoringCache();
  return true;
}
