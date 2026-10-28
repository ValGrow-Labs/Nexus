/**
 * The local-model runtime's MCP client: `tools/list` and `tools/call` over HTTP to the runner's own loopback MCP server,
 * with the turn's bearer, exactly the wire path ScriptedRuntime and a real engine adapter use. The bearer lives in the
 * `Authorization` header of these requests and nowhere else: it is not in the URL, a body, a prompt, an event or a result
 * (a result that held it is redacted before it can reach the model). The URL must be `http://127.0.0.1:<port>` (checked
 * by the caller with `loopbackMcpUrl`), redirects are never followed, and every response is size-capped.
 */
import { BEARER_TOKEN_RE } from '../../logs';

export interface McpToolInfo { name: string; description: string; inputSchema: unknown }
export interface McpCallResult { ok: boolean; text: string; bytes: number }

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface McpClientOptions {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/** The text with the turn's bearer (and anything shaped like a capability token) replaced; applied to everything that goes to the model. */
export function redactToken(text: string, token: string): string {
  let t = text;
  if (token.length >= 8) t = t.split(token).join('[redacted]');
  return t.replace(BEARER_TOKEN_RE, '[redacted]');
}

export class McpClient {
  private id = 0;
  constructor(private readonly o: McpClientOptions) {}

  private async rpc(method: string, params: unknown, signal: AbortSignal): Promise<{ result?: unknown; error?: unknown } | null> {
    const fetchFn = this.o.fetchImpl ?? globalThis.fetch;
    try {
      const res = await fetchFn(this.o.url, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.o.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params })
      });
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) return null;
      const json = JSON.parse(text) as { result?: unknown; error?: unknown };
      return json && typeof json === 'object' ? json : null;
    } catch { return null; }
  }

  /** The tools the server lists, or null when it did not answer. */
  async listTools(signal: AbortSignal): Promise<McpToolInfo[] | null> {
    const r = await this.rpc('tools/list', {}, signal);
    const list = (r?.result as { tools?: unknown } | undefined)?.tools;
    if (!Array.isArray(list)) return null;
    const out: McpToolInfo[] = [];
    for (const t of list as { name?: unknown; description?: unknown; inputSchema?: unknown }[]) {
      if (typeof t?.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) continue;
      out.push({ name: t.name, description: typeof t.description === 'string' ? t.description.slice(0, 500) : '', inputSchema: t.inputSchema ?? { type: 'object', properties: {} } });
    }
    return out;
  }

  /** One `tools/call`. A transport failure or a JSON-RPC error is `ok: false` with a fixed sentence. */
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const r = await this.rpc('tools/call', { name, arguments: args }, signal);
    if (!r) return { ok: false, text: 'the tool call could not be completed', bytes: 0 };
    if (r.error) return { ok: false, text: 'the tool call was refused', bytes: 0 };
    const res = r.result as { content?: { type?: string; text?: unknown }[]; isError?: unknown } | undefined;
    const text = (res?.content ?? []).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
    return { ok: res?.isError !== true, text: redactToken(text, this.o.token), bytes: Buffer.byteLength(text, 'utf8') };
  }
}
