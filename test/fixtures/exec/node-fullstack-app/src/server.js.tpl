'use strict';
// One process: the page (dist), the API (/api/notes) and the database. /health also asks the database.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const PORT = 3000;
const send = (res, status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
http.createServer((req, res) => {
  const p = new URL(req.url, 'http://app').pathname;
  try {
    if (p === '/health') return send(res, db.ping() ? 200 : 500, 'text/plain', db.ping() ? 'ok' : 'database not answering');
    if (p === '/api/notes' && req.method === 'GET') return send(res, 200, 'application/json', JSON.stringify(db.all()));
    if (p === '/api/notes' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 10_000) req.destroy(); });
      req.on('end', () => {
        let text = '';
        try { text = String(JSON.parse(raw).text ?? '').slice(0, 500); } catch { /* not json */ }
        if (!text) return send(res, 400, 'application/json', '{"error":"a note needs text"}');
        db.add(text);
        send(res, 201, 'application/json', '{"ok":true}');
      });
      return undefined;
    }
    const file = path.join(__dirname, '..', 'dist', 'index.html');
    if (!fs.existsSync(file)) return send(res, 404, 'text/plain', 'not built');
    return send(res, 200, 'text/html', fs.readFileSync(file));
  } catch (e) { return send(res, 500, 'text/plain', 'error'); }
}).listen(PORT, '0.0.0.0', () => { console.log(`node-fullstack-app listening on ${PORT}`); });
