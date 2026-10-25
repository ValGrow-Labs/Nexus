'use strict';
// A minimal Streamable-HTTP MCP server that records what it is asked (B2b Task 0).
// It listens on 127.0.0.1 only. POST <path> takes one JSON-RPC message (or a batch) and answers with
// application/json. Notifications get 202 with no body. GET (the optional server stream) gets 405, as the
// spec allows. Every message is recorded with its headers: { method, id, params, headers, at }.
//
//   initialize   -> protocolVersion (the client's), capabilities { tools: {} }, serverInfo
//   tools/list   -> the configured tools
//   tools/call   -> onCall(name, args, rec) -> string | { text, isError }; default answers "ok:<name>"
const http = require('node:http');
const crypto = require('node:crypto');

const DEFAULT_TOOLS = [
  {
    name: 'context_get',
    description: 'Read the current work context for this turn.',
    inputSchema: { type: 'object', properties: { part: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'changeset_register',
    description: 'Register the change set made in this turn.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, requirementVersionIds: { type: 'array', items: { type: 'string' } }, reviseArtifactId: { type: 'string' }, clientKey: { type: 'string' } }, required: ['title', 'summary', 'clientKey'], additionalProperties: false }
  }
];

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

/**
 * start({ tools?, onCall?, path? }) -> Promise<{ url, port, path, records, methods(), calls(), stop() }>
 * `url` is the full endpoint URL (http://127.0.0.1:<port><path>).
 */
function start(opts = {}) {
  const tools = opts.tools ?? DEFAULT_TOOLS;
  const onCall = opts.onCall ?? ((name) => `ok:${name}`);
  const route = opts.path ?? '/mcp';
  const sessionId = crypto.randomUUID();
  const records = [];
  const strays = [];
  const sockets = new Set();

  function handle(msg, headers) {
    const rec = { method: msg?.method ?? null, id: msg?.id ?? null, params: msg?.params ?? null, headers: { ...headers }, at: Date.now() };
    records.push(rec);
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && msg.id !== undefined && msg.method === undefined ? null /* a response from the client */ : rpcError(msg?.id, -32600, 'invalid request');
    }
    if (msg.id === undefined || msg.id === null) return null; // a notification
    switch (msg.method) {
      case 'initialize':
        return rpcResult(msg.id, {
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'nexus-recorder', version: '0.0.0' }
        });
      case 'ping':
        return rpcResult(msg.id, {});
      case 'tools/list':
        return rpcResult(msg.id, { tools });
      case 'tools/call': {
        const name = msg.params?.name;
        if (!tools.some((t) => t.name === name)) return rpcError(msg.id, -32602, `unknown tool ${name}`);
        let out;
        try { out = onCall(name, msg.params?.arguments ?? {}, rec); } catch (e) { out = { text: String(e?.message ?? e), isError: true }; }
        const o = typeof out === 'string' ? { text: out } : (out ?? { text: '' });
        return rpcResult(msg.id, { content: [{ type: 'text', text: String(o.text ?? '') }], isError: o.isError === true });
      }
      default:
        return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
    }
  }

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== route) {
      // Any other path (a planted stray server pointed here) is recorded, then refused.
      strays.push({ path: url, method: req.method, headers: { ...req.headers }, at: Date.now() });
      req.resume();
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === 'GET') { res.writeHead(405, { allow: 'POST, DELETE' }); res.end(); return; }
    if (req.method === 'DELETE') { records.push({ method: '(delete)', id: null, params: null, headers: { ...req.headers }, at: Date.now() }); res.writeHead(200); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE' }); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rpcError(null, -32700, 'parse error')));
        return;
      }
      const batch = Array.isArray(body);
      const replies = (batch ? body : [body]).map((m) => handle(m, req.headers)).filter(Boolean);
      const extra = { 'mcp-session-id': sessionId };
      if (replies.length === 0) { res.writeHead(202, extra); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(batch ? replies : replies[0]));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}${route}`,
        port,
        path: route,
        sessionId,
        records,
        /** Requests to any path other than the endpoint: { path, method, headers, at }. */
        strays,
        tools,
        /** The method names seen, in order. */
        methods: () => records.map((r) => r.method),
        /** The tools/call records. */
        calls: () => records.filter((r) => r.method === 'tools/call'),
        stop: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); })
      });
    });
  });
}

module.exports = { start, DEFAULT_TOOLS };
