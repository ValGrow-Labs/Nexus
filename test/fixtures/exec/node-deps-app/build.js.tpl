'use strict';
// A deterministic build that needs its add-on: it fails when `ms` was not installed (the build container mounts the installed add-ons read-only).
const fs = require('node:fs');
const path = require('node:path');
const ms = require('ms');
const out = path.join(__dirname, 'dist');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><title>deps app</title><h1>deps app</h1><p>built with ms: two hours is ${ms(2 * 60 * 60 * 1000)}</p>\n`);
console.log('built dist/index.html with ms', ms(1000));
