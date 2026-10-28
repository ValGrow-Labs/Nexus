/**
 * Reading what a small local model calls, tolerantly and safely. A model of a few billion parameters often gets the
 * tool-call protocol almost right: a namespaced or mis-cased tool name, arguments as a JSON string (or a list given as a
 * string inside the arguments), or the whole call written as JSON in its text reply. This module turns those near misses
 * into one clean call when the intent is unambiguous, and says no otherwise. It decides nothing about what a call may do:
 * the file tools and the runner's MCP server check every argument themselves.
 */

export interface NamedCall { name: string; args: Record<string, unknown> }

const isPlain = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The known tool a model's name means (exact, then namespace-stripped and case/hyphen-folded), or null. */
export function canonicalToolName(raw: unknown, known: readonly string[]): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/^`+|`+$/g, '');
  if (t.length === 0 || t.length > 128) return null;
  if (known.includes(t)) return t;
  const bare = t.split(/(?:\.|__|::|\/)/).pop() ?? t;
  const fold = (s: string): string => s.toLowerCase().replace(/-/g, '_');
  const hit = known.filter((k) => fold(k) === fold(bare));
  return hit.length === 1 ? hit[0] : null;
}

/** A call's arguments as an object: an object, a JSON string of one, or nothing (a call with no arguments). */
export function coerceArgs(raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, args: {} };
  if (isPlain(raw)) return { ok: true, args: raw };
  if (typeof raw === 'string' && raw.length <= 1024 * 1024) {
    try { const v = JSON.parse(raw) as unknown; if (isPlain(v)) return { ok: true, args: v }; } catch { /* not JSON */ }
  }
  return { ok: false };
}

/**
 * The arguments as the tool's own schema wants them, for the one slip small models make most: a value given as a string where the
 * schema asks for an array, an object, an integer or a boolean (`"argv": "[\"npm\",\"test\"]"`, `"timeoutMs": "60000"`). Only
 * top-level properties, only when the string parses to exactly that type; anything else is left for the tool to refuse.
 */
export function coerceBySchema(args: Record<string, unknown>, schema: unknown): Record<string, unknown> {
  const props = isPlain(schema) && isPlain(schema.properties) ? schema.properties : null;
  if (!props) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [k, v] of Object.entries(args)) {
    const type = isPlain(props[k]) ? props[k].type : undefined;
    if (typeof v !== 'string') continue;
    if (type === 'integer' || type === 'number') { if (/^-?\d{1,15}$/.test(v.trim())) out[k] = Number(v.trim()); continue; }
    if (type === 'boolean') { if (v === 'true' || v === 'false') out[k] = v === 'true'; continue; }
    if (type === 'array' || type === 'object') {
      try {
        const p = JSON.parse(v) as unknown;
        if (type === 'array' ? Array.isArray(p) : isPlain(p)) out[k] = p;
      } catch { /* left as given */ }
    }
  }
  return out;
}

function candidates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)```/g)) out.push(m[1].trim());
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) out.push(m[1].trim());
  const whole = text.trim();
  if (out.length === 0 && (whole.startsWith('{') || whole.startsWith('['))) out.push(whole);
  return out;
}

function asCall(x: unknown, known: readonly string[]): NamedCall | null {
  if (!isPlain(x)) return null;
  const fn = isPlain(x.function) ? x.function : null;
  const nameRaw = fn?.name ?? x.name ?? x.tool ?? x.tool_name ?? (typeof x.function === 'string' ? x.function : undefined);
  const name = canonicalToolName(nameRaw, known);
  if (!name) return null;
  const a = coerceArgs(fn?.arguments ?? fn?.parameters ?? x.arguments ?? x.parameters ?? x.args ?? x.input);
  return a.ok ? { name, args: a.args } : null;
}

/**
 * Tool calls written as JSON in a text reply (a fenced block, `<tool_call>` tags, or the whole reply), when EVERY JSON value
 * found names a known tool; null when the text holds none (it is then an ordinary message). At most four.
 */
export function recoverTextCalls(text: string, known: readonly string[]): NamedCall[] | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 256 * 1024) return null;
  const calls: NamedCall[] = [];
  for (const c of candidates(text)) {
    let v: unknown;
    try { v = JSON.parse(c); } catch { continue; }
    const items = Array.isArray(v) ? v : [v];
    for (const it of items) {
      const call = asCall(it, known);
      if (call) calls.push(call);
    }
  }
  return calls.length > 0 && calls.length <= 4 ? calls : null;
}
