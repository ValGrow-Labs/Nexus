'use strict';
// The border scale cannot silently fade again: controls 3:1 (WCAG 1.4.11), cards and panels 2.2:1, rules 1.8:1, in both themes,
// against the ground, the surface and the sunken background. Computed from the oklch values in tokens.css.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, contrast } = require('./helpers/oklchContrast.cjs');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus', 'styles', 'tokens.css'), 'utf8').replace(/\r\n/g, '\n');
const darkAt = css.indexOf(':root[data-cth-theme="dark"]');
const blocks = { light: css.slice(0, darkAt), dark: css.slice(darkAt) };
const token = (theme, name) => {
  const m = new RegExp("--nx-" + name + ": *(oklch[(][^)]*[)])").exec(blocks[theme]);
  assert.ok(m, `${theme}: --nx-${name} is an oklch value`);
  return parse(m[1]);
};
const MIN = { 'border-strong': 3.0, border: 2.2, divider: 1.8 };

for (const theme of ['light', 'dark']) {
  for (const [name, min] of Object.entries(MIN)) {
    test(`${theme}: --nx-${name} is at least ${min}:1 against the ground, the surface and the sunken background`, () => {
      for (const bg of ['ground', 'surface', 'sunken']) {
        const r = contrast(token(theme, name), token(theme, bg));
        assert.ok(r >= min, `${theme} ${name} on ${bg}: ${r.toFixed(2)} < ${min}`);
      }
    });
  }
}

test('the old names are aliases of the one scale, so every existing rule follows it', () => {
  for (const theme of ['light', 'dark']) {
    assert.match(blocks[theme], /--nx-line: var\(--nx-border\);/);
    assert.match(blocks[theme], /--nx-line-strong: var\(--nx-border-strong\);/);
  }
});

test('the focus ring is 2px, solid and in the ink colour (not colour alone: it is also an outline with an offset)', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus', 'styles', 'ui.css'), 'utf8');
  assert.ok(ui.includes('outline: 2px solid var(--nx-ink); outline-offset: 2px;'));
});
