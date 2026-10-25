/**
 * Attempt and image-build logs (B2a Task 11): one JSON frame per line, `{"ts":<ms>,"stream":"stdout"|"stderr"|"nexus",
 * "text":"..."}`, every text redacted on write with `redactSecretText` (main's redactor: provider keys, bearer tokens,
 * URL credentials, private keys, key=value secrets). A log is capped (50 MiB): once the head is full, ONE marker frame
 * (`"truncatedMiddle":true`) is written and the newest frames are kept in a bounded tail that is appended when the log
 * closes, so the middle is dropped, never the start or the end. Writes are serialized and never block the loop.
 */
import * as path from 'node:path';
import { redactSecretText, scrubHostPaths } from '../main/nexus/activity/redact';
import { ensureDirUnder } from './paths';
import type { RunnerFs } from './types';

export const LOG_CAP_BYTES = 50 * 2 ** 20;
export const MAX_LINE_CHARS = 16_384;
/** What an over-long unterminated line keeps back when it is flushed early (longer than any credential shape). */
export const OVERLAP_CHARS = 512;
/** A forced flush cuts inside a run of token characters only when the run before the cut point is longer than this. */
export const MAX_TOKEN_RUN = 4096;
/** Cut points a forced flush checks against the redactor (each over a window of 2 x CUT_WINDOW characters). */
const CUT_TRIES = 32;
const CUT_WINDOW = 1024;
export const TRUNCATED_TEXT = '[output truncated: the middle of the output was dropped]';

/**
 * A character of a key or token: letters, digits and `. _ ~ + / = -` (provider keys, JWTs, base64 and base64url;
 * `=` counts because it is base64 padding). Everything else separates (whitespace, `" : , ; & { } [ ]`, ...).
 */
export function isTokenChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    || c === 46 || c === 95 || c === 126 || c === 43 || c === 47 || c === 61 || c === 45;
}

/** Whether cutting `p` at `i` leaves the redaction of the text around the cut unchanged (no phrase straddles it). */
function cutKeepsRedaction(p: string, i: number): boolean {
  const a = Math.max(0, i - CUT_WINDOW);
  const b = Math.min(p.length, i + CUT_WINDOW);
  return redactSecretText(p.slice(a, i)) + redactSecretText(p.slice(i, b)) === redactSecretText(p.slice(a, b));
}

/**
 * Where an unterminated line longer than MAX_LINE_CHARS is cut when it is flushed early. The last OVERLAP_CHARS stay
 * buffered (a token still being written stays whole), and the cut lands ON a separator (a character outside the token
 * alphabet, see isTokenChar), so no key or token of up to MAX_TOKEN_RUN characters is ever split, in minified JSON
 * (`"`, `:`, `,`) as in text. Of the latest CUT_TRIES separators within MAX_TOKEN_RUN before the limit, the latest one
 * whose cut keeps the redaction of the surrounding text unchanged is taken (a `"password":"<value>"`, `Bearer <value>`
 * or URL credential phrase is not split either), else the latest separator. Only when the MAX_TOKEN_RUN characters
 * before the limit are all token characters is the line cut at the limit itself.
 */
export function forcedCut(p: string): number {
  const limit = p.length - OVERLAP_CHARS;
  const floor = Math.max(1, limit - MAX_TOKEN_RUN);
  let latest = -1;
  let tries = 0;
  for (let i = limit; i >= floor && tries < CUT_TRIES; i--) {
    if (isTokenChar(p.charCodeAt(i))) continue;
    if (latest < 0) latest = i;
    tries++;
    if (cutKeepsRedaction(p, i)) return i;
  }
  return latest > 0 ? latest : limit;
}

/**
 * A capability token exactly as it travels on the wire (shared/nexus/tokens.ts's TOKEN_RE), unanchored: redacted
 * wherever it appears in a log line, the word "bearer" present or not. `redactSecretText`'s own bearer rule only
 * catches `Bearer <value>` text; a sandboxed command that echoes the bare token (e.g. `echo $TOKEN`) would not match
 * it, so this runs first (B2b Task 6).
 */
export const BEARER_TOKEN_RE = /[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g;

/** A line of text before it is framed: a capability token is redacted first, then the general redactor. Never logged unredacted. */
export function scrub(text: string): string {
  return redactSecretText(text.replace(BEARER_TOKEN_RE, '[redacted]'));
}

type Stream = 'stdout' | 'stderr' | 'nexus';
type FileHandle = Awaited<ReturnType<RunnerFs['open']>>;

/** How much of a log's end `lastFrameTs` reads. */
export const LAST_FRAME_READ_BYTES = 64 * 1024;

/**
 * The `ts` of the last whole frame of a log (from its last LAST_FRAME_READ_BYTES), or undefined (no log, no frame). An
 * adopted attempt resumes `docker logs --since` from it (B2a final review B3): read BEFORE anything new is written, so
 * what the container printed while main was closed is followed, never skipped.
 */
export async function lastFrameTs(fs: RunnerFs, file: string): Promise<number | undefined> {
  let fh: FileHandle | null = null;
  try {
    fh = await fs.open(file, 'r');
    const size = (await fh.stat()).size;
    const len = Math.min(size, LAST_FRAME_READ_BYTES);
    if (len <= 0) return undefined;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, size - len);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      try {
        const f = JSON.parse(line) as { ts?: unknown };
        if (typeof f.ts === 'number' && Number.isFinite(f.ts) && f.ts > 0) return f.ts;
      } catch { /* a partial first line */ }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fh) { try { await fh.close(); } catch { /* closed */ } }
  }
}

export class LogWriter {
  private fh: FileHandle | null = null;
  private written = 0;
  private truncated = false;
  private readonly tail: string[] = [];
  private tailBytes = 0;
  private readonly partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly headLimit: number;
  private readonly tailLimit: number;

  constructor(private readonly fs: RunnerFs, private readonly root: string, readonly file: string,
    private readonly o: { capBytes?: number; now: () => number }) {
    const cap = Math.max(4096, o.capBytes ?? LOG_CAP_BYTES);
    this.tailLimit = Math.floor(cap / 5);
    this.headLimit = cap - this.tailLimit - 256;
  }

  /** Opens (appending: an adopted attempt continues its log). Throws when the folder is refused. */
  async open(): Promise<void> {
    if (!(await ensureDirUnder(this.fs, this.root, path.dirname(this.file)))) throw new Error('the log folder is not a plain folder');
    this.fh = await this.fs.open(this.file, 'a');
    try { this.written = (await this.fh.stat()).size; } catch { this.written = 0; }
    if (this.written >= this.headLimit) this.truncated = true;
  }

  /** Stored bytes so far (what a reader can read). */
  bytes(): number { return this.written; }
  get truncatedMiddle(): boolean { return this.truncated; }

  /**
   * A chunk of container output: split into lines; a partial line waits for its end (or close). An unterminated line
   * that grows past MAX_LINE_CHARS is flushed early, cut by `forcedCut`: at least the last OVERLAP_CHARS stay buffered
   * and the cut lands on a separator, so the token being written stays whole in the buffer and is redacted once it is
   * complete: a key is never split before redaction.
   */
  write(stream: 'stdout' | 'stderr', chunk: string): void {
    if (this.closed) return;
    const text = this.partial[stream] + chunk;
    const lines = text.split('\n');
    this.partial[stream] = lines.pop() ?? '';
    for (const l of lines) this.frame(stream, l.endsWith('\r') ? l.slice(0, -1) : l);
    while (this.partial[stream].length > MAX_LINE_CHARS) {
      const p = this.partial[stream];
      const cut = forcedCut(p);
      this.frame(stream, p.slice(0, cut));
      this.partial[stream] = p.slice(cut);
    }
  }

  /**
   * A line written by the runner itself (redacted like any other). Its text often quotes Docker's own errors, which name
   * host paths (the data home, `\\?\` long paths, Docker Desktop's host mounts): every host path is cut to its basename
   * BEFORE the frame is written (B2a Task 13 fix round 1); main scrubs again on read.
   */
  nexus(text: string): void { if (!this.closed) this.frame('nexus', scrubHostPaths(String(text ?? ''), [this.root, path.dirname(this.root)])); }

  /** One logical line: redacted WHOLE first, then cut into frames (a secret never straddles a frame unredacted). */
  private frame(stream: Stream, line: string): void {
    const clean = scrub(line);
    const MARK = '[redacted]';
    let i = 0;
    do {
      let cut = Math.min(clean.length, i + MAX_LINE_CHARS);
      // A cut never splits a redaction marker (a reader always sees `[redacted]` whole).
      const m = clean.lastIndexOf(MARK, cut - 1);
      if (cut < clean.length && m > i && m < cut && m + MARK.length > cut) cut = m;
      const s = `${JSON.stringify({ ts: this.o.now(), stream, text: clean.slice(i, cut) })}\n`;
      this.enqueue(s);
      i = cut;
    } while (i < clean.length);
  }

  private enqueue(s: string): void {
    const n = Buffer.byteLength(s);
    if (!this.truncated && this.written + n <= this.headLimit) {
      this.written += n;
      this.append(s);
      return;
    }
    if (!this.truncated) {
      this.truncated = true;
      const marker = `${JSON.stringify({ ts: this.o.now(), stream: 'nexus', text: TRUNCATED_TEXT, truncatedMiddle: true })}\n`;
      this.written += Buffer.byteLength(marker);
      this.append(marker);
    }
    this.tail.push(s); this.tailBytes += n;
    while (this.tailBytes > this.tailLimit && this.tail.length > 0) this.tailBytes -= Buffer.byteLength(this.tail.shift()!);
  }

  private append(s: string): void {
    const fh = this.fh;
    if (!fh) return;
    this.chain = this.chain.then(() => fh.write(s).then(() => undefined), () => undefined).catch(() => undefined);
  }

  /** Writes what is pending (partial lines, the kept tail) and closes the file. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) { await this.chain; return; }
    for (const st of ['stdout', 'stderr'] as const) if (this.partial[st]) { this.frame(st, this.partial[st]); this.partial[st] = ''; }
    this.closed = true;
    if (this.truncated && this.tail.length > 0) {
      const t = this.tail.splice(0).join('');
      this.written += Buffer.byteLength(t); this.tailBytes = 0;
      this.append(t);
    }
    await this.chain;
    const fh = this.fh; this.fh = null;
    if (fh) { try { await fh.close(); } catch { /* already closed */ } }
  }

  /** Waits for the writes queued so far (tests). */
  flushed(): Promise<void> { return this.chain; }
}
