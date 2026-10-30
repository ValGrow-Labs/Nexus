'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { fitIntoWorkArea } = loadTs('src/main/windowBounds.ts');

const MIN = { width: 1280, height: 800 };
const primary = { x: 0, y: 0, width: 1920, height: 1032 }; // 1080 minus a 48 px taskbar
const second = { x: 1920, y: 0, width: 1600, height: 900 };

test('a window as tall as the screen is cut to the work area (never under the taskbar), and sits inside it', () => {
  assert.deepEqual(fitIntoWorkArea({ x: 0, y: 20, width: 1920, height: 1080 }, [primary], MIN), { x: 0, y: 0, width: 1920, height: 1032 });
  assert.deepEqual(fitIntoWorkArea({ x: 100, y: 500, width: 1440, height: 900 }, [primary], MIN), { x: 100, y: 132, width: 1440, height: 900 });
});

test('a window saved partly off the right or left edge is moved back in; the minimum size holds when it fits', () => {
  assert.deepEqual(fitIntoWorkArea({ x: 1000, y: 0, width: 1440, height: 900 }, [primary], MIN), { x: 480, y: 0, width: 1440, height: 900 });
  assert.deepEqual(fitIntoWorkArea({ x: -300, y: 0, width: 1300, height: 820 }, [primary], MIN), { x: 0, y: 0, width: 1300, height: 820 });
  assert.deepEqual(fitIntoWorkArea({ x: 10, y: 10, width: 800, height: 500 }, [primary], MIN), { x: 10, y: 10, width: 1280, height: 800 });
});

test('a display smaller than the usual minimum wins over the minimum; the second display is used when the window is on it', () => {
  const small = { x: 0, y: 0, width: 1366, height: 728 };
  assert.deepEqual(fitIntoWorkArea({ x: 0, y: 0, width: 1500, height: 900 }, [small], MIN), { x: 0, y: 0, width: 1366, height: 728 });
  assert.deepEqual(fitIntoWorkArea({ x: 2000, y: 100, width: 1440, height: 900 }, [primary, second], MIN), { x: 2000, y: 0, width: 1440, height: 900 });
});

test('a saved position that lands on no display is dropped (the window opens centred, still inside the work area)', () => {
  assert.deepEqual(fitIntoWorkArea({ x: 9000, y: 9000, width: 1440, height: 1300 }, [primary], MIN), { width: 1440, height: 1032 });
  assert.deepEqual(fitIntoWorkArea({ width: 1440, height: 900 }, [primary], MIN), { width: 1440, height: 900 });
});

test('main restores through the pure fit, and refits on display changes; the side panel and the work area have their own room and edge', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.ok(main.includes('fitIntoWorkArea({ x: r.x, y: r.y, width, height }, areas, MIN_WIN)'));
  assert.ok(main.includes("screen.on('display-metrics-changed', refit)"));
  assert.ok(main.includes('minHeight: Math.min(MIN_WIN.height, screen.getPrimaryDisplay().workArea.height)'));
  const pc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus', 'styles', 'project.css'), 'utf8');
  assert.ok(pc.includes('.nx-passport { padding-bottom: calc(var(--nx-s4) + 24px); }'));
  assert.ok(pc.includes('.nx-bench { border-bottom: 1px solid var(--nx-divider); }'));
});
