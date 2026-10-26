'use strict';
// B2b Task 16: the code the scripted agent "writes" into its worktree in the end-to-end flows, for both fixtures. Plain text:
// nothing here is ever run on the host (the fake sandbox driver plays test reports from the test titles in these files;
// a title ending ` [fails]` (node) or a function ending `_fails` (python) is played as failing).

/** The node fixture (test/fixtures/exec/node-test-app): a CSV export of the ledger, then a paginated one. */
const NODE = {
  ledger: {
    'src/ledger.js': `'use strict';
// Exports ledger rows as CSV (one line per row, commas and quotes escaped).
function cell(v) { const s = String(v); return /[",\\n]/.test(s) ? \`"\${s.replace(/"/g, '""')}"\` : s; }
function toCsv(rows) { return rows.map((r) => r.map(cell).join(',')).join('\\n') + '\\n'; }
module.exports = { toCsv };
`,
    'test/ledger.test.js': `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toCsv } = require('../src/ledger');
test('exports one line per row', () => { assert.equal(toCsv([[1, 'a'], [2, 'b']]), '1,a\\n2,b\\n'); });
test('escapes commas and quotes', () => { assert.equal(toCsv([['a,b', 'say "hi"']]), '"a,b","say ""hi"""\\n'); });
`
  },
  /** The first try of the pagination helper (reviewed: "add the edge cases"). */
  pageV1: {
    'src/page.js': `'use strict';
function page(rows, n, size) { return rows.slice(n * size, n * size + size); }
module.exports = { page };
`,
    'test/page.test.js': `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../src/page');
test('returns the first page', () => { assert.deepEqual(page([1, 2, 3, 4, 5], 0, 2), [1, 2]); });
`
  },
  /** The revision after the review comment: the edge cases are handled and tested. */
  pageV2: {
    'src/page.js': `'use strict';
function page(rows, n, size) {
  if (!Array.isArray(rows) || rows.length === 0 || size < 1 || n < 0) return [];
  return rows.slice(n * size, n * size + size);
}
module.exports = { page };
`,
    'test/page.test.js': `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../src/page');
test('returns the first page', () => { assert.deepEqual(page([1, 2, 3, 4, 5], 0, 2), [1, 2]); });
test('returns a short last page', () => { assert.deepEqual(page([1, 2, 3, 4, 5], 2, 2), [5]); });
test('an empty ledger has no pages', () => { assert.deepEqual(page([], 0, 2), []); });
`
  }
};

/** The python fixture (test/fixtures/exec/pytest-app). */
const PY = {
  ledger: {
    'src/pytest_app/ledger.py': `"""Exports ledger rows as CSV."""


def _cell(v):
    s = str(v)
    return '"' + s.replace('"', '""') + '"' if any(c in s for c in ',"\\n') else s


def to_csv(rows):
    return "".join(",".join(_cell(v) for v in row) + "\\n" for row in rows)
`,
    'tests/test_ledger.py': `from pytest_app.ledger import to_csv


def test_one_line_per_row():
    assert to_csv([[1, "a"], [2, "b"]]) == "1,a\\n2,b\\n"


def test_escapes_commas_and_quotes():
    assert to_csv([["a,b", 'say "hi"']]) == '"a,b","say ""hi"""\\n'
`
  },
  pageV1: {
    'src/pytest_app/page.py': `def page(rows, n, size):
    return rows[n * size:n * size + size]
`,
    'tests/test_page.py': `from pytest_app.page import page


def test_first_page():
    assert page([1, 2, 3, 4, 5], 0, 2) == [1, 2]
`
  },
  pageV2: {
    'src/pytest_app/page.py': `def page(rows, n, size):
    if not rows or size < 1 or n < 0:
        return []
    return rows[n * size:n * size + size]
`,
    'tests/test_page.py': `from pytest_app.page import page


def test_first_page():
    assert page([1, 2, 3, 4, 5], 0, 2) == [1, 2]


def test_short_last_page():
    assert page([1, 2, 3, 4, 5], 2, 2) == [5]


def test_empty_ledger_has_no_pages():
    assert page([], 0, 2) == []
`
  }
};


/**
 * The REAL tests the gated real-Docker suite (XA6) has run in the sde images: no fake driver plays them, node:test and pytest do.
 * `fail` is a change whose test genuinely fails; `fixed` replaces its test with one that passes (the iteration).
 */
const REAL = {
  node: {
    fail: {
      'src/sum.js': `'use strict';
module.exports = { sum: (a, b) => a + b };
`,
      'test/sum.test.js': `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sum } = require('../src/sum');
test('sums two numbers', () => { assert.equal(sum(1, 1), 3); });
test('sums zero', () => { assert.equal(sum(0, 0), 0); });
`
    },
    fixed: {
      'test/sum.test.js': `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sum } = require('../src/sum');
test('sums two numbers', () => { assert.equal(sum(1, 1), 2); });
test('sums zero', () => { assert.equal(sum(0, 0), 0); });
`
    }
  },
  python: {
    fail: {
      'src/pytest_app/total.py': `def total(a, b):
    return a + b
`,
      'tests/test_total.py': `from pytest_app.total import total


def test_total_adds():
    assert total(1, 1) == 3


def test_total_zero():
    assert total(0, 0) == 0
`
    },
    fixed: {
      'tests/test_total.py': `from pytest_app.total import total


def test_total_adds():
    assert total(1, 1) == 2


def test_total_zero():
    assert total(0, 0) == 0
`
    }
  }
};

module.exports = { NODE, PY, REAL };
