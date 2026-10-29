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

/**
 * Every top-level JSON object or array written in `text`, in order: balanced `{...}` / `[...]` spans found by a string-aware scan, so
 * several calls written one after another (one per line, or glued together) and calls with prose around them are all seen. A span that
 * is not valid JSON is skipped, and the scan resumes inside it (a stray brace before a real call must not hide the call).
 * One slip small models make is repaired: the text ends with the closing braces or brackets missing after a string that did close
 * (`...","content":"..."}` for `...}}`); they are added. A text that ends inside a string is never repaired (the content is cut).
 */
function jsonValues(text: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  let work = 0;
  // A bounded amount of scanning, whatever the text is (a long run of unclosed braces must not cost a quadratic scan).
  while (i < text.length && out.length < 64 && work < 2_000_000) {
    const c = text[i];
    if (c !== '{' && c !== '[') { i++; continue; }
    const stack: string[] = []; let inStr = false; let esc = false; let end = -1;
    for (let j = i; j < text.length; j++) {
      work++;
      const d = text[j];
      if (inStr) { if (esc) esc = false; else if (d === '\\') esc = true; else if (d === '"') inStr = false; continue; }
      if (d === '"') inStr = true;
      else if (d === '{') stack.push('}');
      else if (d === '[') stack.push(']');
      else if (d === '}' || d === ']') { stack.pop(); if (stack.length === 0) { end = j; break; } }
    }
    if (end < 0) {
      // Never balanced: repair the missing closers when the text stopped between values (not inside a string), at most four.
      if (!inStr && stack.length > 0 && stack.length <= 4) {
        try { out.push(JSON.parse(`${text.slice(i).trimEnd()}${stack.reverse().join('')}`) as unknown); break; } catch { /* not repairable */ }
      }
      i++; continue;
    }
    try { out.push(JSON.parse(text.slice(i, end + 1)) as unknown); i = end + 1; } catch { i++; }
  }
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
 * Tool calls written as JSON in a text reply (a fenced block, `<tool_call>` tags, several objects one after another, or the whole
 * reply), when EVERY JSON value found names a known tool; null when the text holds none (it is then an ordinary message), or holds a
 * value that is not a call (an example in prose). At most eight.
 */
export function recoverTextCalls(text: string, known: readonly string[]): NamedCall[] | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 256 * 1024) return null;
  const calls: NamedCall[] = [];
  for (const v of jsonValues(text)) {
    const items = Array.isArray(v) ? v : [v];
    for (const it of items) {
      const call = asCall(it, known);
      if (!call) return null;
      calls.push(call);
    }
  }
  return calls.length > 0 && calls.length <= 8 ? calls : null;
}

/** Whether a text reads as an attempt at a call (it names a known tool the way a call does) although none could be read. */
export function looksLikeCall(text: string, known: readonly string[]): boolean {
  if (typeof text !== 'string' || text.length === 0 || text.length > 256 * 1024) return false;
  for (const m of text.matchAll(/"(?:name|tool|function)"\s*:\s*"([^"]{1,128})"/g)) if (canonicalToolName(m[1], known) !== null) return true;
  return false;
}
