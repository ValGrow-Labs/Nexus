// "Try it": running a suggested change in the safe space, started by the person pressing a button.
//
// Pure helpers shared by main (which builds the argv, never the renderer) and the renderer (which words the buttons). Nothing here
// runs anything. A command is always an ARRAY of arguments: it is never handed to a shell, in Nexus or in the container (the Nexus entry
// runs the arguments as given). What the person types for "Try your own command" is cut into that array here, with quotes but no shell
// meaning: `|`, `&&`, `>`, `$(...)` and `*` are just letters of an argument.

/** The ways to start a try run: the two buttons main detects, and the person's own command. */
export const TRY_WHATS = ['tests', 'program', 'custom'] as const;
export type TryWhat = (typeof TRY_WHATS)[number];

/** The longest command the box takes (characters), and the most arguments and characters per argument a run may have. */
export const TRY_COMMAND_MAX_CHARS = 1000;
export const TRY_MAX_ARGS = 32;
export const TRY_ARG_MAX_CHARS = 512;

/** The token the Nexus entry splits steps on: an argument may never be it. */
const STEP_TOKEN = '--nexus-then';

export type TryArgvResult = { ok: true; argv: string[] } | { ok: false; reason: 'empty' | 'too_long' | 'quote' | 'bad_text' | 'too_many' | 'helper' };

/**
 * One typed command as an argument array. Whitespace separates arguments; 'single quotes' keep everything literal; "double quotes" keep
 * everything literal except that a backslash before a quote or a backslash is an escape. Anything else is refused: an empty command, a
 * line break or other control character, an unclosed quote, more than TRY_MAX_ARGS arguments, an argument over TRY_ARG_MAX_CHARS, the
 * entry's step token, or a first word that names one of Nexus's own helpers (`nexus-...`).
 */
export function tokenizeCommand(text: unknown): TryArgvResult {
  if (typeof text !== 'string') return { ok: false, reason: 'empty' };
  if (text.length > TRY_COMMAND_MAX_CHARS) return { ok: false, reason: 'too_long' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(text)) return { ok: false, reason: 'bad_text' };
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) { cur += text[i + 1]; i++; }
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === ' ' || c === '\t') { if (has || cur !== '') { out.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (quote !== null) return { ok: false, reason: 'quote' };
  if (has || cur !== '') out.push(cur);
  return checkTryArgv(out);
}

/** An argument array a try run may hold (also what main checks again before it plans the run). */
export function checkTryArgv(argv: unknown): TryArgvResult {
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, reason: 'empty' };
  if (argv.length > TRY_MAX_ARGS) return { ok: false, reason: 'too_many' };
  for (const a of argv) {
    if (typeof a !== 'string' || a.length === 0 || a.includes('\0')) return { ok: false, reason: 'bad_text' };
    if (a.length > TRY_ARG_MAX_CHARS) return { ok: false, reason: 'too_long' };
    if (a === STEP_TOKEN) return { ok: false, reason: 'bad_text' };
  }
  if ((argv[0] as string).startsWith('nexus-')) return { ok: false, reason: 'helper' };
  return { ok: true, argv: [...(argv as string[])] };
}

/** What main found in a suggested change: the two parts of package.json it reads, and which plain files exist. */
export interface TryFacts {
  packageJson: { scripts?: unknown; main?: unknown } | null;
  /** Relative paths that exist in the change (only those main looked for). */
  has: readonly string[];
}

export interface TryOption { what: 'tests' | 'program'; label: string; /** The command that will run, in plain text, so nothing is hidden. */ shows: string; argv: string[] }

/** The npm placeholder `npm init` writes: it is not a test. */
const NPM_NO_TEST = /no test specified/i;
const PLAIN_FILE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$/;
const scriptOf = (p: TryFacts['packageJson'], name: string): string | null => {
  const s = p && typeof p.scripts === 'object' && p.scripts !== null && !Array.isArray(p.scripts) ? (p.scripts as Record<string, unknown>)[name] : undefined;
  return typeof s === 'string' && s.trim() !== '' ? s : null;
};

/** The files main looks for (so it never reads more than these from a change). */
export const TRY_LOOK_FOR: readonly string[] = Object.freeze(['package.json', 'pyproject.toml', 'requirements.txt', 'pytest.ini', 'main.py', 'app.py', 'index.js', 'src/index.js', 'tests', 'test']);

/** The main file a package.json names, when it is a plain relative path with no `..`. */
export function plainMain(p: TryFacts['packageJson']): string | null {
  const m = p && typeof p.main === 'string' ? p.main.replace(/^\.\//, '') : null;
  return m && PLAIN_FILE.test(m) && !m.split('/').includes('..') && !m.startsWith('-') ? m : null;
}

/**
 * The buttons a suggested change gets, from what it holds. A button whose command is not there is not offered. Node: `npm test` for a
 * real test script, `npm start` or `node <main file>` for the program. Python: pytest when there are tests, `python main.py` (or
 * `app.py`) for the program.
 */
export function tryOptions(f: TryFacts): TryOption[] {
  const out: TryOption[] = [];
  const has = new Set(f.has);
  const opt = (what: 'tests' | 'program', argv: string[]): void => { out.push({ what, label: what === 'tests' ? 'Run the tests' : 'Run the program', shows: argv.join(' '), argv }); };
  if (f.packageJson !== null) {
    const test = scriptOf(f.packageJson, 'test');
    if (test !== null && !NPM_NO_TEST.test(test)) opt('tests', ['npm', 'test']);
    if (scriptOf(f.packageJson, 'start') !== null) opt('program', ['npm', 'start']);
    else {
      const main = plainMain(f.packageJson);
      if (main !== null && has.has(main)) opt('program', ['node', main]);
      else if (has.has('src/index.js')) opt('program', ['node', 'src/index.js']);
      else if (has.has('index.js')) opt('program', ['node', 'index.js']);
    }
    return out;
  }
  const python = has.has('pyproject.toml') || has.has('requirements.txt') || has.has('pytest.ini') || has.has('main.py') || has.has('app.py');
  if (python) {
    if (has.has('tests') || has.has('test') || has.has('pytest.ini')) opt('tests', ['python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider']);
    if (has.has('main.py')) opt('program', ['python', 'main.py']);
    else if (has.has('app.py')) opt('program', ['python', 'app.py']);
  }
  return out;
}
