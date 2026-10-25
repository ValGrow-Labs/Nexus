/**
 * The runner's loopback Streamable-HTTP MCP server (B2b Task 6): it decides nothing. It speaks the wire protocol an
 * agent CLI's MCP client expects — JSON-RPC over one HTTP endpoint, a session id minted at `initialize` — and relays
 * every `tools/call` to main (`onCall`) and every granted `sandbox_exec` to the runner's own exec relay
 * (`onExecGrant`). Anti-DNS-rebinding: only `Host: 127.0.0.1:<this server's own port>` is accepted, and a request
 * carrying an `Origin` header (a browser tab; this agent process never sends one) is refused. A call's body (the
 * tool's arguments, the agent's bearer) is never logged here: the optional `log` callback is given method names and
 * outcomes only, never a call's bearer or arguments.
 */
import * as http from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { MCP_TOOLS } from '../shared/nexus/mcpTools';
import { parseExecGrant, type McpReplyResult, type SandboxExecGrant } from '../shared/nexus/runnerProtocol';
import { isTokenShape } from '../shared/nexus/tokens';
import { scrub } from './logs';

/** The one path this server answers; everything else is a plain 404. */
export const MCP_PATH = '/mcp';
/** The single protocol version this server speaks (the Task 0 recording of the agent harness pins this value). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
/** The most bytes a request body may hold before the server refuses it (413), unread past this point. */
export const MCP_MAX_BODY_BYTES = 1024 * 1024;

export interface McpServerOptions {
  /** One relayed `tools/call`: mints nothing of the result itself, just forwards and awaits main's answer. */
  onCall: (callId: string, bearer: string, tool: string, args: unknown) => Promise<McpReplyResult>;
  /** A granted `sandbox_exec`'s argv, run by the runner against the turn's own container. */
  onExecGrant: (bearer: string, grant: SandboxExecGrant) => Promise<McpReplyResult>;
  /** Method names and outcomes only; never a call's bearer, arguments or result. */
  log?: (line: string) => void;
}

export interface McpServerHandle { url: string; close: () => Promise<void> }

interface JsonRpcIn { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
interface HandleOutcome { reply: unknown | null; sessionId?: string }

const JSON_CONTENT_TYPE_RE = /^application\/json(?:\s*;.*)?$/i;
const BEARER_RE = /^Bearer\s+(.+)$/i;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function rpcResult(id: unknown, result: unknown): unknown { return { jsonrpc: '2.0', id: id ?? null, result }; }
function rpcError(id: unknown, code: number, message: string): unknown { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

/** One MCP tool-call result: the value (or the failure message) as a single text content item. Scrubbed defensively. */
function toolResult(value: unknown, isError: boolean): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null) ?? 'null';
  return { content: [{ type: 'text', text: scrub(text) }], isError };
}

/** One JSON-RPC message of a request (or of a batch): never throws; an invalid shape always answers, a notification never does. */
async function handleOne(raw: unknown, bearer: string | null, opts: McpServerOptions): Promise<HandleOutcome> {
  const msg = raw as JsonRpcIn;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    const id = msg && typeof msg === 'object' && !Array.isArray(msg) ? msg.id : undefined;
    // A response-shaped message (an id, no method): the client answering a server request we never send; never replied to.
    if (msg && typeof msg === 'object' && !Array.isArray(msg) && id !== undefined && typeof msg.method !== 'string' && 'result' in msg) return { reply: null };
    return { reply: rpcError(id, -32600, 'invalid request') };
  }
  const id = msg.id;
  const isNotification = id === undefined || id === null;
  if (isNotification) return { reply: null }; // never replied to, whatever it asks
  const params = (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {}) as Record<string, unknown>;
  switch (msg.method) {
    case 'initialize': {
      const sessionId = randomUUID();
      return {
        reply: rpcResult(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'nexus-runner', version: '1.0.0' } }),
        sessionId
      };
    }
    case 'ping':
      return { reply: rpcResult(id, {}) };
    case 'tools/list':
      return { reply: rpcResult(id, { tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.name.replace(/_/g, ' '), inputSchema: t.args })) }) };
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) return { reply: rpcError(id, -32602, 'invalid tool name') };
      if (!bearer) return { reply: rpcResult(id, toolResult('no bearer token was presented', true)) };
      opts.log?.(`mcp: tools/call ${name}`);
      const callId = randomUUID();
      let result: McpReplyResult;
      try { result = await opts.onCall(callId, bearer, name, params.arguments ?? {}); }
      catch { result = { ok: false, code: 'relay_failed', message: 'the call could not be relayed' }; }
      if (!result.ok) return { reply: rpcResult(id, toolResult(result.message, true)) };
      if (name === 'sandbox_exec') {
        const grant = parseExecGrant(result.value);
        if (!grant) return { reply: rpcResult(id, toolResult('the exec grant was malformed', true)) };
        let execResult: McpReplyResult;
        try { execResult = await opts.onExecGrant(bearer, grant); }
        catch { execResult = { ok: false, code: 'exec_failed', message: 'the command could not be run' }; }
        return { reply: rpcResult(id, toolResult(execResult.ok ? execResult.value : execResult.message, !execResult.ok)) };
      }
      return { reply: rpcResult(id, toolResult(result.value, false)) };
    }
    default:
      return { reply: rpcError(id, -32601, `method not found: ${msg.method}`) };
  }
}

/** Starts the server on an ephemeral loopback port and resolves once it is listening. */
export function McpServer(opts: McpServerOptions): Promise<McpServerHandle> {
  let expectedHost = '';
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const send = (code: number, body?: unknown, headers: Record<string, string> = {}): void => {
      if (body === undefined) { res.writeHead(code, headers); res.end(); return; }
      const text = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers });
      res.end(text);
    };
    const urlPath = (req.url ?? '').split('?')[0];
    if (urlPath !== MCP_PATH) { req.resume(); send(404); return; }
    if (req.method !== 'POST') { req.resume(); send(405, undefined, { allow: 'POST' }); return; }
    // Anti-DNS-rebinding: only this server's own loopback host, and never a browser's Origin.
    if (req.headers.host !== expectedHost) { req.resume(); send(400, rpcError(null, -32600, 'the Host header is not this server')); return; }
    if (req.headers.origin !== undefined) { req.resume(); send(403, rpcError(null, -32600, 'browser requests are refused')); return; }
    const ct = req.headers['content-type'];
    if (typeof ct !== 'string' || !JSON_CONTENT_TYPE_RE.test(ct)) { req.resume(); send(415, rpcError(null, -32600, 'Content-Type must be application/json')); return; }
    const accept = req.headers.accept;
    const acceptsJson = typeof accept === 'string' && accept.split(',').some((p) => p.trim().toLowerCase().startsWith('application/json'));
    if (!acceptsJson) { req.resume(); send(406, rpcError(null, -32600, 'Accept must include application/json')); return; }
    // The bearer never travels further than this extraction: on any error path below, it is never echoed back.
    const auth = req.headers.authorization;
    const bm = typeof auth === 'string' ? BEARER_RE.exec(auth) : null;
    const bearer = bm && isTokenShape(bm[1]) ? bm[1] : null;

    let bytes = 0; let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      bytes += c.length;
      if (bytes > MCP_MAX_BODY_BYTES) { tooLarge = true; send(413, rpcError(null, -32600, 'the request body is too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, rpcError(null, -32700, 'parse error')); return; }
      const batch = Array.isArray(body);
      const msgs = batch ? (body as unknown[]) : [body];
      void (async () => {
        const outcomes: HandleOutcome[] = [];
        for (const one of msgs) outcomes.push(await handleOne(one, bearer, opts));
        const sessionId = [...outcomes].reverse().find((o) => o.sessionId)?.sessionId;
        const headers: Record<string, string> = sessionId ? { 'mcp-session-id': sessionId } : {};
        const replies = outcomes.map((o) => o.reply).filter((r) => r !== null);
        if (replies.length === 0) { send(202, undefined, headers); return; }
        send(200, batch ? replies : replies[0], headers);
      })();
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      expectedHost = `127.0.0.1:${port}`;
      resolve({
        url: `http://127.0.0.1:${port}${MCP_PATH}`,
        close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); })
      });
    });
  });
}
