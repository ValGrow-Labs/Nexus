'use strict';
// When the AI helper cannot start for want of a starting point, the person presses the one button that saves it. The request they already
// typed then starts again by itself (once), instead of telling them to type it again. Source pins, plain node.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus', 'agent', 'AgentPanel.tsx'), 'utf8').replace(/\r\n/g, '\n');

test('RS1 saving the starting point sends the same request again, once, only after the starting point is saved', () => {
  assert.match(panel, /const lastAsk = \[\.\.\.items\]\.reverse\(\)\.find\(\(i\) => i\.kind === 'you'\)\?\.text \?\? null;/, 'the words come from what the person already sent');
  assert.match(panel, /setResend\(\{ text: lastAsk, ok: false \}\)/);
  assert.match(panel, /if \(!resend \|\| !resend\.ok \|\| !ready \|\| running \|\| tail\?\.button\?\.kind === 'snapshot'\) return;/, 'not before a short wait, not while the helper is busy, not while the starting point is still being asked for');
  assert.match(panel, /const text = resend\.text;\n\s+setResend\(null\);/, 'taken out before sending, so it is never sent twice');
  assert.match(panel, /Your request starts again by itself\./);
});
