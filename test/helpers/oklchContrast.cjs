'use strict';
// oklch(L C h) -> sRGB -> WCAG relative luminance and contrast ratio. Used by the border-contrast pin.
function oklchToLinear(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180; const a = C * Math.cos(h); const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b; const m_ = L - 0.1055613458 * a - 0.0638541728 * b; const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3; const m = m_ ** 3; const s = s_ ** 3;
  const clamp = (x) => Math.min(1, Math.max(0, x));
  return [clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), clamp(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
}
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function contrast(a, b) { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const parse = (s) => { const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(s); return m ? oklchToLinear(+m[1], +m[2], +m[3]) : null; };
module.exports = { parse, contrast };
