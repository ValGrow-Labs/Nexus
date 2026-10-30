/** Helpers for the instrument wall (the workspace picker at #/browse). */

/** "UI / UX Design" → "ui-ux-design": the path shown in a panel header. */
export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Number keys 1–9 pick a visible panel; anything else picks nothing. */
export function digitIndex(key: string, count: number): number {
  if (!/^[1-9]$/.test(key)) return -1;
  const i = Number(key) - 1;
  return i < count ? i : -1;
}
