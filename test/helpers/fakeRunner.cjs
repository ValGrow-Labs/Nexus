'use strict';
// A RunnerPort for tests: records every MainToRunner message main sends (deep-copied, so later
// mutation by main cannot change what was sent) and replays RunnerToMain reports the test scripts
// with `report(msg)`. It runs no process, no Docker and no file system work.
//
// Options: { state: 'ready' | 'starting' | 'unavailable' | 'crashed' (default 'ready'),
//            neverAnswers: true  -> it never replies on its own (a hung runner; reports still flow),
//            failSend: (msg) => boolean -> send throws for the messages it selects (a dead port),
//            quiet: true -> it sends nothing unprompted (no `ready`),
//            probeReply: () => msg -> it answers each `probe` with this report (as the real runner does) }
// On its own (unless neverAnswers) it answers `hello` with `ready`. Probe results are pushed by the
// test world (execWorld), not invented here.
class FakeRunner {
  constructor(o = {}) {
    this.o = o;
    this.sent = [];
    this.listeners = [];
    this.currentState = o.state ?? 'ready';
  }
  state() { return this.currentState; }
  setState(s) { this.currentState = s; }
  send(msg) {
    if (typeof this.o.failSend === 'function' && this.o.failSend(msg)) throw new Error('the runner is gone');
    this.sent.push(JSON.parse(JSON.stringify(msg)));
    // `probeReply(msg)` may answer with one report or a list of them (the sandbox probe first, then the runtimes, as the real runner does).
    if (msg.op === 'probe' && typeof this.o.probeReply === 'function') for (const r of [].concat(this.o.probeReply(msg))) this.report(r);
    if (this.o.neverAnswers || this.o.quiet) return;
    if (msg.op === 'hello') this.report({ op: 'ready', bootId: msg.bootId });
  }
  onMessage(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
  }
  /** Deliver one report to main, synchronously, as the real port would deliver one message. */
  report(msg) { for (const f of [...this.listeners]) f(msg); }
  sentOf(op) { return this.sent.filter((m) => m.op === op); }
  lastStart() { const s = this.sentOf('attempt.start'); return s[s.length - 1] ?? null; }
}

module.exports = { FakeRunner };
