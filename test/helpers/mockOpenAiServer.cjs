'use strict';
// A mock hosted model API (the Nexus hosted-model runtime's tests). It speaks the subset of the chat-completions wire shape the
// runtime uses: POST <anything>/chat/completions with messages, tools, tool_calls and usage, on 127.0.0.1 only (plain HTTP, or HTTPS
// when given a key and a certificate). No real provider, no key that works anywhere, no network beyond loopback. Every request is
// recorded (method, url, headers, body text, parsed body).
//
//   start({ script, requireKey, tls, onChat }) -> { url, port, host, requests, chats(), setScript(s), stop() }
//
// `requireKey`: when set, a request whose `authorization` is not `Bearer <requireKey>` gets the provider's 401 (as the real one does).
// `tls`: { key, cert } serves HTTPS instead of HTTP.
// `script`: an array (one entry per chat call, in order; the last repeats when `repeatLast`) or a function (body, n) -> entry. An entry:
//   { text, in?, out?, finish? }                         a text-only reply (usage prompt_tokens/completion_tokens = in/out)
//   { calls: [{ name, args }], text?, in?, out? }        tool calls (arguments as the JSON text the wire carries; args may be a string)
//   { raw: <json> }                                       the response body as given
//   { status, code?, type?, message?, retryAfter?, headers?, body? }   an error answer (a fixed secret-looking message: the runtime must never show it)
//   { redirect: '<url>', status?: 302 }                   a redirect (must never be followed)
//   { delayMs, then: <entry> }                            answer after a delay
//   { hang: true }                                        never answers (until the socket is closed)
//   { huge: <bytes> }                                     a valid-looking JSON body of that many bytes
//   { malformed: true }                                   a body that is not JSON
const http = require('node:http');
const https = require('node:https');

const SECRET_TEXT = 'SECRET-PROVIDER-ERROR-TEXT /home/secret/path quota details';

function start(opts = {}) {
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
    const calls = (entry.calls ?? []).map((c, i) => ({ id: `call_${n}_${i}`, type: 'function',
      function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}) } }));
    const inT = entry.in ?? 10; const outT = entry.out ?? 5;
    return {
      id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: entry.text ?? (calls.length > 0 ? null : ''), ...(calls.length > 0 ? { tool_calls: calls } : {}) },
        finish_reason: entry.finish ?? (calls.length > 0 ? 'tool_calls' : 'stop') }],
      usage: { prompt_tokens: inT, completion_tokens: outT, total_tokens: inT + outT }
    };
  }

  function answer(res, entry) {
    if (entry.delayMs) { const t = setTimeout(() => answer(res, entry.then ?? { text: 'late' }), entry.delayMs); res.on('close', () => clearTimeout(t)); return; }
    if (entry.hang) return;
    if (entry.redirect) return send(res, entry.status ?? 302, '', { location: entry.redirect });
    if (entry.status) {
      const headers = { ...(entry.retryAfter !== undefined ? { 'retry-after': String(entry.retryAfter) } : {}), ...(entry.headers ?? {}) };
      const body = entry.body ?? { error: { message: entry.message ?? SECRET_TEXT, type: entry.type ?? 'error', code: entry.code ?? null } };
      return send(res, entry.status, body, headers);
    }
    if (entry.malformed) return send(res, 200, '<<< not json');
    if (entry.huge) return send(res, 200, JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x'.repeat(entry.huge) } }] }));
    if (entry.raw !== undefined) return send(res, 200, entry.raw);
    return send(res, 200, chatBody(entry));
  }

  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const rec = { method: req.method, url: req.url, headers: { ...req.headers }, body: text };
      requests.push(rec);
      const url = (req.url ?? '').split('?')[0];
      if (req.method === 'POST' && url.endsWith('/chat/completions')) {
        try { rec.json = JSON.parse(text); } catch { rec.json = null; }
        rec.chat = true;
        if (opts.requireKey && req.headers.authorization !== `Bearer ${opts.requireKey}`) return send(res, 401, { error: { message: SECRET_TEXT, type: 'invalid_request_error', code: 'invalid_api_key' } });
        const i = n++;
        opts.onChat?.(rec.json, i, rec);
        let entry = typeof script === 'function' ? script(rec.json, i) : (script[i] ?? (opts.repeatLast ? script[script.length - 1] : undefined));
        if (!entry) entry = { text: 'done' };
        return answer(res, entry);
      }
      send(res, 404, { error: { message: 'not found', code: 'not_found' } });
    });
  };
  const server = opts.tls ? https.createServer({ key: opts.tls.key, cert: opts.tls.cert }, handler) : http.createServer(handler);
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('secureConnection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        host: '127.0.0.1', port, url: `${opts.tls ? 'https' : 'http'}://127.0.0.1:${port}`, requests,
        /** The parsed bodies of the chat requests. */
        chats: () => requests.filter((r) => r.chat).map((r) => r.json),
        chatRecords: () => requests.filter((r) => r.chat),
        setScript: (s) => { script = s; n = 0; },
        stop: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); })
      });
    });
  });
}

/**
 * A fake host egress proxy on 127.0.0.1: answers CONNECT only. `map`: 'host:port' -> { host, port } (where the tunnel really goes, a
 * loopback origin); `refuse`: an HTTP status to answer every CONNECT with (the real proxy answers 403 for a host it does not allow).
 * Records every request line's authority and any plain (non-CONNECT) request it is sent.
 *   startFakeProxy({ map, refuse }) -> { url, port, connects, plain, stop() }
 */
function startFakeProxy(opts = {}) {
  const connects = [];
  const plain = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => { plain.push({ method: req.method, url: req.url }); res.writeHead(400); res.end(); });
  server.on('connect', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    connects.push(req.url);
    const head = (status, reason) => `HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
    if (opts.refuse) { socket.end(head(opts.refuse, 'Forbidden')); return; }
    const to = (opts.map ?? {})[req.url];
    if (!to) { socket.end(head(403, 'Forbidden')); return; }
    const up = require('node:net').connect(to.port, to.host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(socket); socket.pipe(up); });
    sockets.add(up); up.on('close', () => sockets.delete(up)); up.on('error', () => socket.destroy()); socket.on('close', () => up.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, port, connects, plain, stop: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) });
    });
  });
}

module.exports = { start, startFakeProxy, SECRET_TEXT };
