// The live preview's isolation rules, as pure decisions (no Electron here: main wires them in, src/main/previewHost.ts; test/nexus-preview.test.cjs pins them).
//
// A preview shows an app the AI helper wrote, served by a dev deployment on 127.0.0.1:<port> and nowhere else. The view that shows it can load ONE
// origin, `http://127.0.0.1:<port>`: every other request is cancelled, so the page cannot call the other loopback servers on this computer (the
// integration broker, the telemetry collector, the AI helper's gateway, the runner) nor any outside address, and it can never be sent anywhere else.
// The port is never a renderer value: main reads it from the deployments table for a live deployment.

/** The port range of a dev deployment's published port (the runner picks it from the ephemeral range). */
export const PREVIEW_PORT_MIN = 1024;
export const PREVIEW_PORT_MAX = 65535;

export function isPreviewPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= PREVIEW_PORT_MIN && p <= PREVIEW_PORT_MAX;
}

/** The one origin a preview may load. */
export function previewOrigin(port: number): string { return `http://127.0.0.1:${port}`; }

const parse = (url: unknown): URL | null => { try { return typeof url === 'string' ? new URL(url) : null; } catch { return null; } };

/** A navigation (address change, redirect, link, form) is allowed only inside the preview's own origin, without credentials. */
export function isPreviewNavigationAllowed(url: unknown, port: number): boolean {
  const u = parse(url);
  return u !== null && u.origin === previewOrigin(port) && u.username === '' && u.password === '';
}

/**
 * A network request of the preview page (a script, a style, an image, a fetch, a socket) is allowed only to its own origin. A `data:` URL (an inline
 * image or font, no network) and a `blob:` URL made by the page itself are allowed; a web socket to its own origin is allowed. Everything else is cancelled.
 */
export function isPreviewRequestAllowed(url: unknown, port: number): boolean {
  const u = parse(url);
  if (u === null) return false;
  if (u.protocol === 'data:') return true;
  if (u.protocol === 'blob:') { const inner = parse(u.pathname); return inner !== null && inner.origin === previewOrigin(port); }
  if (u.protocol === 'ws:') return u.host === `127.0.0.1:${port}` && u.username === '' && u.password === '';
  return isPreviewNavigationAllowed(url, port);
}

/** Every permission a page can ask for (camera, microphone, location, notifications, clipboard, ...) is refused. */
export function isPreviewPermissionAllowed(_permission: string): boolean { return false; }

/** What a live deployment must look like for a preview to be shown: running on this computer's loopback, with its published port. */
export function isDeploymentPreviewable(d: { status: string; bindAddress: string; hostPort: number | null }): boolean {
  return (d.status === 'healthy' || d.status === 'starting' || d.status === 'unhealthy') && d.bindAddress === '127.0.0.1' && isPreviewPort(d.hostPort);
}

/** The bounds the renderer reports for the panel (CSS pixels in the window), checked before use: finite, non-negative, bounded. */
export interface PreviewBounds { x: number; y: number; width: number; height: number }
export function checkPreviewBounds(b: unknown): PreviewBounds | null {
  if (typeof b !== 'object' || b === null) return null;
  const o = b as Record<string, unknown>;
  const n = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);
  const x = n(o.x, 20000); const y = n(o.y, 20000); const width = n(o.width, 20000); const height = n(o.height, 20000);
  return x !== null && y !== null && width !== null && height !== null && width >= 1 && height >= 1 ? { x, y, width, height } : null;
}
