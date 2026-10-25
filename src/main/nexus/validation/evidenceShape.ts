/**
 * The shape of stored evidence (constraint 4): every item a validation stores is one member of the
 * `Evidence` union (src/shared/nexus/evidence.ts), with exactly its fields, bounded. Pure; no I/O.
 *
 * - `checkEvidence` re-validates a list against the union and returns a fresh, typed copy, or why it
 *   is refused (`bad_evidence`): an unknown type, a missing or extra field, a value of the wrong type
 *   or out of bounds. Nothing is coerced.
 * - `secretCheckView` is the list as the secret check sees it: the TYPED digest positions of the union
 *   (`hash.sha256`, `number.source.blobSha256`, `junit.sha256`, `file.sha256`, `http.bodySha256`,
 *   `git.commit`, `log.sha256`), which `checkEvidence` has already proved to be hex digests, are
 *   blanked; everything else is checked as is. A digest-named key anywhere else is not exempt: the
 *   union has no free-form members that could hold one.
 */
import type { Evidence } from '../../../shared/nexus/evidence';

export const MAX_EVIDENCE_ITEMS = 500;
const MAX_TEXT = 1024;
const MAX_LABEL = 128;
const MAX_SCHEMA_ERRORS = 200;
/** A `case` item's name, class and file (each already redacted and capped by the ingest that lists them). */
export const MAX_CASE_TEXT = 200;

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const NUMBER_OPS = ['>=', '<=', '==', '<', '>'] as const;
const GIT_CHECKS = ['resolves', 'ancestor', 'merge_tree_clean', 'paths_in_scope', 'diff_nonempty'] as const;
const LOCATION_RULES = ['provider_key', 'private_key', 'high_entropy'] as const;

export type EvidenceCheck = { ok: true; value: Evidence[] } | { ok: false; reason: 'bad_evidence'; message: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isText = (v: unknown, max = MAX_TEXT, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max && !v.includes('\0');
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isSha = (v: unknown): v is string => typeof v === 'string' && SHA256_RE.test(v);

class Refused extends Error {}
const no = (message: string): never => { throw new Refused(message); };

/** Exactly these keys (the optional ones may be absent). */
function keys(x: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(x, k)) no(`a ${String(x.type)} item has no ${k}`);
  for (const k of Object.keys(x)) if (!required.includes(k) && !optional.includes(k)) no(`a ${String(x.type)} item has an unknown field`);
}

function item(x: unknown): Evidence {
  if (!isObj(x)) return no('an evidence item is not an object');
  switch (x.type) {
    case 'hash':
      keys(x, ['type', 'label', 'sha256']);
      if (!isText(x.label, MAX_LABEL, 1) || !isSha(x.sha256)) no('a hash item is malformed');
      return { type: 'hash', label: x.label as string, sha256: x.sha256 as string };
    case 'number': {
      keys(x, ['type', 'name', 'value', 'source'], ['bound']);
      if (!isText(x.name, MAX_LABEL, 1) || !isFinite(x.value)) no('a number item is malformed');
      const s = x.source;
      if (!isObj(s) || Object.keys(s).length !== 2 || !isSha(s.blobSha256) || !isText(s.pointer, MAX_TEXT)) no('a number item has a bad source');
      const src = s as { blobSha256: string; pointer: string };
      let bound: { op: (typeof NUMBER_OPS)[number]; value: number } | undefined;
      if (x.bound !== undefined) {
        const b = x.bound;
        if (!isObj(b) || Object.keys(b).length !== 2 || !(NUMBER_OPS as readonly unknown[]).includes(b.op) || !isFinite(b.value)) no('a number item has a bad bound');
        bound = { op: (b as { op: (typeof NUMBER_OPS)[number] }).op, value: (b as { value: number }).value };
      }
      return { type: 'number', name: x.name as string, value: x.value as number, ...(bound ? { bound } : {}),
        source: { blobSha256: src.blobSha256, pointer: src.pointer } };
    }
    case 'exit':
      keys(x, ['type', 'code'], ['signal', 'oomKilled']);
      if (x.code !== null && !(typeof x.code === 'number' && Number.isSafeInteger(x.code))) no('an exit item has a bad code');
      if (x.signal !== undefined && !isText(x.signal, 32, 1)) no('an exit item has a bad signal');
      if (x.oomKilled !== undefined && typeof x.oomKilled !== 'boolean') no('an exit item has a bad oomKilled flag');
      return { type: 'exit', code: x.code as number | null, ...(x.signal !== undefined ? { signal: x.signal as string } : {}),
        ...(x.oomKilled !== undefined ? { oomKilled: x.oomKilled as boolean } : {}) };
    case 'junit':
      keys(x, ['type', 'sha256', 'total', 'passed', 'failed', 'errored', 'skipped']);
      if (!isSha(x.sha256) || ![x.total, x.passed, x.failed, x.errored, x.skipped].every(isCount)) no('a junit item is malformed');
      return { type: 'junit', sha256: x.sha256 as string, total: x.total as number, passed: x.passed as number, failed: x.failed as number,
        errored: x.errored as number, skipped: x.skipped as number };
    case 'schema': {
      keys(x, ['type', 'schemaId', 'errors']);
      if (!isText(x.schemaId, MAX_LABEL, 1) || !Array.isArray(x.errors) || x.errors.length > MAX_SCHEMA_ERRORS) no('a schema item is malformed');
      const errors = (x.errors as unknown[]).map((e) => {
        if (!isObj(e) || Object.keys(e).length !== 2 || !isText(e.path, MAX_TEXT) || !isText(e.message, MAX_TEXT)) return no('a schema error is malformed');
        return { path: e.path as string, message: e.message as string };
      });
      return { type: 'schema', schemaId: x.schemaId as string, errors };
    }
    case 'file':
      keys(x, ['type', 'path', 'sha256', 'bytes']);
      if (!isText(x.path, MAX_TEXT, 1) || !isSha(x.sha256) || !isCount(x.bytes)) no('a file item is malformed');
      return { type: 'file', path: x.path as string, sha256: x.sha256 as string, bytes: x.bytes as number };
    case 'http':
      keys(x, ['type', 'method', 'path', 'status', 'ms'], ['bodySha256']);
      if ((x.method !== 'GET' && x.method !== 'POST') || !isText(x.path, MAX_TEXT, 1)) no('an http item is malformed');
      if (x.status !== null && !(typeof x.status === 'number' && Number.isInteger(x.status) && x.status >= 100 && x.status <= 599)) no('an http item has a bad status');
      if (x.ms !== null && !(isFinite(x.ms) && (x.ms as number) >= 0)) no('an http item has a bad latency');
      if (x.bodySha256 !== undefined && !isSha(x.bodySha256)) no('an http item has a bad body hash');
      return { type: 'http', method: x.method as 'GET' | 'POST', path: x.path as string, status: x.status as number | null, ms: x.ms as number | null,
        ...(x.bodySha256 !== undefined ? { bodySha256: x.bodySha256 as string } : {}) };
    case 'git':
      keys(x, ['type', 'commit', 'check', 'detail']);
      if (typeof x.commit !== 'string' || !COMMIT_RE.test(x.commit) || !(GIT_CHECKS as readonly unknown[]).includes(x.check) || !isText(x.detail, 200)) {
        no('a git item is malformed');
      }
      return { type: 'git', commit: x.commit as string, check: x.check as (typeof GIT_CHECKS)[number], detail: x.detail as string };
    case 'user':
      keys(x, ['type', 'principalKind', 'action', 'at']);
      if (x.principalKind !== 'user' || !isText(x.action, 64, 1) || !isFinite(x.at)) no('a user item is malformed');
      return { type: 'user', principalKind: 'user', action: x.action as string, at: x.at as number };
    case 'inspect':
      keys(x, ['type', 'field', 'value']);
      if (!isText(x.field, MAX_LABEL, 1) || !(isText(x.value, MAX_TEXT) || isFinite(x.value) || typeof x.value === 'boolean')) no('an inspect item is malformed');
      return { type: 'inspect', field: x.field as string, value: x.value as string | number | boolean };
    case 'log':
      keys(x, ['type', 'attemptId', 'stream', 'offset', 'length', 'sha256']);
      if (!isText(x.attemptId, 64, 1) || (x.stream !== 'stdout' && x.stream !== 'stderr') || !isCount(x.offset) || !isCount(x.length) || !isSha(x.sha256)) {
        no('a log item is malformed');
      }
      return { type: 'log', attemptId: x.attemptId as string, stream: x.stream as 'stdout' | 'stderr', offset: x.offset as number, length: x.length as number,
        sha256: x.sha256 as string };
    case 'case':
      keys(x, ['type', 'name', 'classname', 'file', 'outcome']);
      if (!isText(x.name, MAX_CASE_TEXT) || !isText(x.classname, MAX_CASE_TEXT) || !(x.file === null || isText(x.file, MAX_CASE_TEXT))
        || (x.outcome !== 'failed' && x.outcome !== 'errored')) no('a case item is malformed');
      return { type: 'case', name: x.name as string, classname: x.classname as string, file: x.file as string | null, outcome: x.outcome as 'failed' | 'errored' };
    case 'location':
      // Where a change set's secret scan or entropy note hit (B2b): path and line only, never the line's text.
      keys(x, ['type', 'path', 'line', 'rule']);
      if (!isText(x.path, MAX_TEXT, 1) || !isCount(x.line) || x.line < 1 || !(LOCATION_RULES as readonly unknown[]).includes(x.rule)) {
        no('a location item is malformed');
      }
      return { type: 'location', path: x.path as string, line: x.line as number, rule: x.rule as (typeof LOCATION_RULES)[number] };
    default:
      return no('an evidence item has an unknown type');
  }
}

/** The list against the Evidence union: a fresh typed copy, or `bad_evidence`. */
export function checkEvidence(x: unknown): EvidenceCheck {
  if (!Array.isArray(x)) return { ok: false, reason: 'bad_evidence', message: 'the evidence is not a list' };
  if (x.length > MAX_EVIDENCE_ITEMS) return { ok: false, reason: 'bad_evidence', message: 'the evidence list is too long' };
  try {
    return { ok: true, value: x.map(item) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: 'bad_evidence', message: e.message };
    throw e;
  }
}

/** A checked list as the secret check sees it: only the typed digest positions are blanked. */
export function secretCheckView(list: readonly Evidence[]): unknown[] {
  return list.map((e) => {
    switch (e.type) {
      case 'hash': return { ...e, sha256: '' };
      case 'number': return { ...e, source: { ...e.source, blobSha256: '' } };
      case 'junit': return { ...e, sha256: '' };
      case 'file': return { ...e, sha256: '' };
      case 'http': return e.bodySha256 !== undefined ? { ...e, bodySha256: '' } : e;
      case 'git': return { ...e, commit: '' };
      case 'log': return { ...e, sha256: '' };
      default: return e;
    }
  });
}
