// Where the main window may sit: always inside a display's work area (the screen minus the taskbar), whatever was saved.
// Pure (no Electron import) so a test can run it.
export interface Rect { x: number; y: number; width: number; height: number }
export interface Bounds { x?: number; y?: number; width: number; height: number }

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Fit saved bounds into the work area they belong to: the size is at least `min` but never more than the work area, and a
 * position is kept only if it lands on a display, moved just far enough that the whole window is inside that work area.
 * `areas`: every display's work area, the primary first (used when no position was saved or none lands on a display).
 */
export function fitIntoWorkArea(b: Bounds, areas: readonly Rect[], min: { width: number; height: number }): Bounds {
  if (areas.length === 0) return b;
  const hasPos = typeof b.x === 'number' && typeof b.y === 'number';
  let area = areas[0];
  let landed = false;
  if (hasPos) {
    const probe: Rect = { x: b.x as number, y: b.y as number, width: b.width, height: b.height };
    let best = 0;
    for (const a of areas) { const o = overlap(probe, a); if (o > best) { best = o; area = a; landed = true; } }
  }
  const width = Math.min(Math.max(Math.round(b.width), min.width), area.width);
  const height = Math.min(Math.max(Math.round(b.height), min.height), area.height);
  if (!hasPos || !landed) return { width, height };
  const x = Math.min(Math.max(Math.round(b.x as number), area.x), area.x + area.width - width);
  const y = Math.min(Math.max(Math.round(b.y as number), area.y), area.y + area.height - height);
  return { x, y, width, height };
}
