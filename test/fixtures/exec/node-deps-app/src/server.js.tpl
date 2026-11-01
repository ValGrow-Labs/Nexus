'use strict';
// The dev deployment's app: it needs its add-on at run time too (ms), listens on the manifest's port, answers /health, serves dist.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ms = require('ms');
const PORT = 3000;
http.createServer((req, res) => {
  const p = new URL(req.url, 'http://app').pathname;
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (p === '/uptime') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`running for ${ms(Math.round(process.uptime() * 1000))} (ms ${ms('1m')})`); return; }
  const file = path.join(__dirname, '..', 'dist', 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not built'); return; }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(file));
}).listen(PORT, '0.0.0.0', () => { console.log(`node-deps-app listening on ${PORT}`); });
