'use strict';
// A mock local model server (the Nexus local-model runtime's tests). It speaks the subset of Ollama's native API the
// runtime uses: GET /api/version, GET /api/tags, POST /api/show, POST /api/chat (non-stream), on 127.0.0.1 only. No real
// model, no network beyond loopback. Every request is recorded (method, url, headers, body text).
//
//   start({ version, models, script, onChat }) -> { url, port, host, requests, chats(), setScript(s), stop() }
//
// `models`: [{ name, capabilities?: string[] , template?: string }] (default one model that supports tools).
// `script`: an array (one entry per /api/chat call, in order; the last repeats when `repeatLast`) or a function
//           (body, n) -> entry. An entry is one of:
//   { text, in?, out?, doneReason? }                    a text-only reply
//   { calls: [{ name, args }], text?, in?, out? }       native tool calls (args may be an object or a string)
//   { raw: <json> }                                      the response body as given
//   { status: 500 | 404 | 400 }                          an error status (a fixed body: the runtime must never show it)
//   { redirect: '<url>', status?: 302 }                  a redirect (must never be followed)
//   { delayMs, then: <entry> }                           answer after a delay
//   { hang: true }                                       never answers (until the socket is closed)
//   { huge: <bytes> }                                    a valid-looking JSON body of that many bytes
//   { malformed: true }                                  a body that is not JSON
const http = require('node:http');

const DEFAULT_MODELS = [{ name: 'qwen2.5-coder:7b', capabilities: ['completion', 'tools'] }];

function start(opts = {}) {
  const models = opts.models ?? DEFAULT_MODELS;
  const requests = [];
  const sockets = new Set();
  let script = opts.script ?? [];
  let n = 0;

  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  };

  function chatBody(entry) {
    const toolCalls = (entry.calls ?? []).map((c) => ({ function: { name: c.name, arguments: c.args ?? {} } }));
    return {
      model: 'mock', created_at: new Date().toISOString(),
      message: { role: 'assistant', content: entry.text ?? '', ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
      done: true, done_reason: entry.doneReason ?? 'stop', prompt_eval_count: entry.in ?? 10, eval_count: entry.out ?? 5
    };
  }

  function answer(res, entry, req) {
    if (entry.delayMs) { const t = setTimeout(() => answer(res, entry.then ?? { text: 'late' }, req), entry.delayMs); res.on('close', () => clearTimeout(t)); return; }
    if (entry.hang) return;
    if (entry.status && !entry.redirect) return send(res, entry.status, { error: 'SECRET-SERVER-ERROR-TEXT /home/secret/path' });
    if (entry.redirect) return send(res, entry.status ?? 302, '', { location: entry.redirect });
    if (entry.malformed) return send(res, 200, '<<< not json');
    if (entry.huge) {
      const text = JSON.stringify({ message: { role: 'assistant', content: 'x'.repeat(entry.huge) }, done: true });
      return send(res, 200, text);
    }
    if (entry.raw !== undefined) return send(res, 200, entry.raw);
    return send(res, 200, chatBody(entry));
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const rec = { method: req.method, url: req.url, headers: { ...req.headers }, body: text };
      requests.push(rec);
      const url = (req.url ?? '').split('?')[0];
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      if (req.method === 'GET' && url === '/api/version') {
        if (opts.versionStatus) return send(res, opts.versionStatus, { error: 'x' });
        return send(res, 200, { version: opts.version ?? '0.5.7' });
      }
      if (req.method === 'GET' && url === '/api/tags') {
        if (opts.tagsStatus) return send(res, opts.tagsStatus, { error: 'x' });
        return send(res, 200, { models: models.map((m) => ({ name: m.name, model: m.name, size: 1, digest: 'd' })) });
      }
      if (req.method === 'POST' && url === '/api/show') {
        const m = models.find((x) => x.name === body?.model);
        if (!m) return send(res, 404, { error: 'model not found' });
        return send(res, 200, { ...(m.capabilities ? { capabilities: m.capabilities } : {}), ...(m.template ? { template: m.template } : {}), details: {} });
      }
      if (req.method === 'POST' && url === '/api/chat') {
        const i = n++;
        rec.chat = true;
        opts.onChat?.(body, i, rec);
        let entry = typeof script === 'function' ? script(body, i) : (script[i] ?? (opts.repeatLast ? script[script.length - 1] : undefined));
        if (!entry) entry = { text: 'done' };
        return answer(res, entry, req);
      }
      send(res, 404, { error: 'not found' });
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        host: '127.0.0.1', port, url: `http://127.0.0.1:${port}`, requests,
        /** The parsed bodies of the /api/chat requests. */
        chats: () => requests.filter((r) => r.chat).map((r) => JSON.parse(r.body)),
        setScript: (s) => { script = s; n = 0; },
        stop: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); })
      });
    });
  });
}

module.exports = { start, DEFAULT_MODELS };
