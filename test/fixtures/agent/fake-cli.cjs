'use strict';
// The test CLI stand-in (B2b Tasks 11 and 13). The cli-agent adapter (src/runner/runtimes/cliAgent) spawns it in place
// of a real engine's executable: `process.execPath`, this script's path as an `argvPrefix` entry, then the adapter's
// own pinned argv. It speaks the engine's stream-json output (one JSON object per line on stdout), so the adapter's own
// parser runs on it, and it gives the process-tree tests (AT7, AT8, AT17, CR7, CR9) a real, killable OS process.
//
// Its knobs are `--fake-*` arguments in the argv prefix (the adapter's environment is an allow-list, so an environment
// knob would not reach it); `FAKE_CLI_QUICK=1` in the environment is kept for the Task 11 tests.
//
//   --version                 prints a version line (`--fake-version=<v>`, default 2.1.0)
//   --help                    lists the pinned flags (`--fake-omit-flag=<flag>` leaves one out)
//   auth status               prints the file `--fake-auth=<path>` (an email may be in it) or a signed-in answer
//   <a turn>                  reads stdin to the end, prints `system/init`, then:
//     --fake-quick            an assistant text, a result (success)           (also FAKE_CLI_QUICK=1)
//     --fake-dump-env         one assistant text holding the process environment as JSON, then the result
//     --fake-echo-stdin       one assistant text with the byte count and sha256 of what arrived on stdin
//     --fake-child            starts a grandchild process (idle) and reports both pids, then idles
//     --fake-dump-argv        one assistant text holding the whole argv as JSON, then the result
//     --fake-marker=<file>    appends a line to the file when a turn starts (a version or flag refusal must leave it unwritten)
//     --fake-no-cost          a result without `total_cost_usd`
//     --fake-big-line         a stream line over 1 MiB
//     FAKE_CLI_COMPLETE_HANG=1  the result, then it stays alive anyway (an engine that hangs on exit)
//     (none of these)         idles until killed
const crypto = require('node:crypto');
const cp = require('node:child_process');

const argv = process.argv.slice(2);
// Run with no argument at all, it has nothing to stand in for: the adapter always passes its pinned argv, so a bare start is not a turn. A
// plain `node --test test/` collects every file under test/ as a test file and would otherwise wait on this one for ever (B2b Task 16).
if (argv.length === 0 && process.env.FAKE_CLI_QUICK === undefined) { process.exit(0); }
const flag = (n) => argv.includes(n);
const value = (n) => { const a = argv.find((x) => x.startsWith(`${n}=`)); return a ? a.slice(n.length + 1) : null; };
const done = () => process.stdout.write('', () => process.exit(0));
const emit = (obj) => { try { process.stdout.write(`${JSON.stringify(obj)}\n`); } catch { /* the pipe may be gone */ } };

const PINNED = ['-p', '--output-format', '--verbose', '--input-format', '--restricted', '--strict-mcp-config', '--mcp-config', '--settings',
  '--setting-sources', '--tools', '--allowedTools', '--disallowedTools', '--permission-mode', '--permission-prompts', '--no-session-persistence',
  '--disable-slash-commands', '--no-chrome', '--max-budget-usd', '--append-system-prompt'];

if (flag('--version')) { process.stdout.write(`${value('--fake-version') ?? '2.1.0'} (fake)\n`); done(); return; }
if (flag('--help')) {
  const omit = value('--fake-omit-flag');
  const lines = ['Usage: fake [options] [command]', '', 'Options:'];
  for (const f of PINNED) if (f !== omit) lines.push(`  ${f}${f.startsWith('--') ? ' <value>' : ''}      the ${f} option`);
  process.stdout.write(`${lines.join('\n')}\n`);
  done(); return;
}
if (argv.includes('auth') && argv.includes('status')) {
  const file = value('--fake-auth');
  if (file) process.stdout.write(require('node:fs').readFileSync(file, 'utf8'));
  else process.stdout.write(`${JSON.stringify({ loggedIn: true })}\n`);
  done(); return;
}

const text = (t) => emit({ type: 'assistant', message: { id: `msg_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: t }],
  usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, parent_tool_use_id: null });
const result = () => {
  const r = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', terminal_reason: 'completed', result: 'done',
    usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  if (!flag('--fake-no-cost')) r.total_cost_usd = 0.00012;
  emit(r);
};

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('error', () => {});
const turn = () => {
  const stdin = Buffer.concat(chunks);
  const marker = value('--fake-marker');
  if (marker) { try { require('node:fs').appendFileSync(marker, 'turn\n'); } catch { /* none */ } }
  emit({ type: 'system', subtype: 'init', session_id: 'fake-session', tools: [], mcp_servers: [{ name: 'nexus', status: 'connected' }], model: 'fake-model' });
  if (flag('--fake-dump-env')) { text(JSON.stringify(process.env)); result(); return done(); }
  if (flag('--fake-dump-argv')) { text(JSON.stringify(process.argv.slice(2))); result(); return done(); }
  if (flag('--fake-echo-stdin')) { text(`stdin ${stdin.length} ${crypto.createHash('sha256').update(stdin).digest('hex')}`); result(); return done(); }
  if (flag('--fake-big-line')) { emit({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 10) }] } }); setInterval(() => {}, 0x7fffffff); return; }
  if (flag('--fake-child')) {
    const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},0x7fffffff)'], { stdio: 'ignore', windowsHide: true, env: { ELECTRON_RUN_AS_NODE: '1' } });
    text(`pids ${process.pid} ${child.pid}`);
    setInterval(() => {}, 0x7fffffff);
    return;
  }
  if (process.env.FAKE_CLI_COMPLETE_HANG === '1') { text('done'); result(); setInterval(() => {}, 0x7fffffff); return; }
  if (flag('--fake-quick') || process.env.FAKE_CLI_QUICK === '1') { text('done'); result(); return done(); }
  setInterval(() => {}, 0x7fffffff); // idles until killed
};
process.stdin.on('end', turn);
// A harness that never closes stdin still gets a turn.
setTimeout(() => { if (!process.stdin.readableEnded) turn(); }, 5000).unref();
