/** Examples the search line "types" while it is empty and idle, so it reads
 *  as alive and shows what can be searched for. Each word is a real term the
 *  index matches (see indexModel). */
export const TYPE_EXAMPLES = ['a model', 'a dashboard', 'a service', 'test plans', 'a prototype', 'publishing'];

const HOLD = 14;  // ticks a finished example stays on screen
const GAP = 3;    // ticks of empty line between examples

/** Pure frame function: what the placeholder shows at a given tick. Typing
 *  and erasing run one character per tick. */
export function typewriterText(tick: number): string {
  const lengths = TYPE_EXAMPLES.map((e) => e.length * 2 + HOLD + GAP);
  const total = lengths.reduce((a, b) => a + b, 0);
  let t = ((tick % total) + total) % total;
  for (let i = 0; i < TYPE_EXAMPLES.length; i++) {
    const e = TYPE_EXAMPLES[i];
    if (t < lengths[i]) {
      if (t <= e.length) return e.slice(0, t);
      if (t <= e.length + HOLD) return e;
      const erased = t - e.length - HOLD;
      return e.slice(0, Math.max(0, e.length - erased));
    }
    t -= lengths[i];
  }
  return '';
}
