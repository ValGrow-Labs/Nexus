/**
 * The words the local-model runtime gives its model: one system prompt (the workflow, the rules, the tools by name) and the
 * user message (the job's own message, with the context and the skills main wrote into the job's config dir). Small models
 * follow short, concrete, numbered instructions better than long ones, so this is deliberately plain. No secret is ever put
 * here: the bearer is not an argument of this module.
 */

/** One-line hints for the runner's tools: the server's own descriptions are only the tool's name. */
const TOOL_HINTS: Readonly<Record<string, string>> = Object.freeze({
  sandbox_exec: 'Run ONE command in the isolated sandbox, where the project is at /workspace. argv is a list such as ["npm","test"] (never one string with spaces, never a shell line); cwd is /workspace or a folder below it; timeoutMs is milliseconds (for example 120000). It returns the exit code and the output. Use it to install, build and run tests; it is the only way to run anything.',
  changeset_register: 'Register the finished change for review. Call it ONCE, as your last action, after the tests pass. title is a short name, summary says what changed and why, clientKey is a short id of letters and digits such as "cs1".',
  context_get: 'Read the context of this job (the requirement, the project facts).',
  artifact_list: 'List the saved artifacts of the project.',
  artifact_read: 'Read one saved artifact by versionId.',
  validations_get: 'Read the validation results of one artifact version.',
  job_status: 'Read the status of a job by jobId.',
  job_logs: 'Read a page of a job\'s log by jobId.',
  job_request: 'Ask for a standard job (for example installing dependencies) by recipeId.',
  requirement_draft: 'Draft a requirement with acceptance criteria.',
  review_request: 'Ask for a review of an artifact version.'
});

export function toolDescription(name: string, fromServer: string): string {
  return TOOL_HINTS[name] ?? (fromServer.length > 0 ? fromServer : name.replace(/_/g, ' '));
}

export interface PromptInput {
  message: string;
  context: string | null;
  skills: string | null;
  hasSandbox: boolean;
  hasChangeset: boolean;
  /** Files the task names that do not exist yet (see `namedFiles`). */
  newFiles?: readonly string[];
}

/** For a capable model that decides for itself whether the person asked for work or only talked, like any coding agent: it may answer in words. */
export const CONVERSATION_RULES = [
  'You are also a friendly assistant to the person you work for. If they only greet you, chat, or ask a question, answer in one or two plain, friendly sentences (for a greeting, ask what they would like to build or change) and do not call any tool.',
  'Only when they ask for a change to the project, work through the steps below.'
];

export function systemPrompt(i: Pick<PromptInput, 'hasSandbox' | 'hasChangeset'> & { conversational?: boolean }): string {
  const steps = [
    'If the task names files to create, your FIRST action is write_file for them (the WHOLE file each time). Do not explore first. Otherwise look at the project with list_files and read_file, then write the files the task needs.',
    i.hasSandbox
      ? 'Then run the tests or the build with sandbox_exec (the project is at /workspace) and read the result: exit code 0 means it passed.'
      : 'Then check your work by reading the files back.',
    'If something fails, fix the file with write_file (the whole file again) and run it again. Do not repeat a call that already failed; change something first.',
    i.hasChangeset
      ? 'When it passes, call changeset_register once with a title, a summary and a clientKey (for example "cs1"). That is your last action; then stop.'
      : 'When it works, say so briefly.'
  ];
  return [
    'You are a software engineer working inside a project through tools. You can only act by calling tools.',
    ...(i.conversational ? ['', ...CONVERSATION_RULES] : []),
    '',
    'How to work:',
    ...steps.map((s, n) => `${n + 1}. ${s}`),
    '',
    'Rules:',
    '- Call one tool at a time. Do not explain at length: act.',
    '- Paths are relative to the project, with forward slashes (src/app.js). Never use absolute paths, drive letters or "..".',
    '- Do not touch .git, .env files, keys, or anything under .claude or .nexus.',
    '- Keep every file short and simple (a test file of six to eight short tests is enough). Match the project\'s module style: CommonJS (require, module.exports) unless its package.json says "type": "module".',
    '- Tests use the built-in runner: const test = require(\'node:test\'); const assert = require(\'node:assert/strict\'); then test(\'name\', () => { assert.equal(a, b); }); and assert.throws(() => f(), TypeError). There is no describe, suite or setup unless you import them.',
    '- Exports: a source file ends with module.exports = { nameA, nameB }; (an object with the names, even for one function) and the tests import with const { nameA } = require(\'../src/file\'); so both sides always agree.',
    '- If a test fails because it expects something the task does not ask for (a particular id value, say), fix the test, not the code.',
    '- You cannot use the network. Do not try to install from the internet unless the task says it is allowed.',
    '- When the work is done, stop calling tools.'
  ].join('\n');
}

const FILE_EXT = 'js|cjs|mjs|jsx|ts|tsx|py|json|md|txt|html|css|sh|go|rs|java|yml|yaml|toml|sql';
const PATH_RE = new RegExp(String.raw`(?<![\w./:-])((?:[\w.-]+/)*[\w-]+(?:\.[\w-]+)*\.(?:${FILE_EXT}))(?![\w/-])`, 'g');
const NOT_A_FILE_RE = /^(?:node|next|vue|react|three|d3|express|chart|socket|nuxt|alpine)\.js$/i;

/**
 * The files a task names (paths such as `src/todo.js` or `package.json` written in the message), in order, once each, at most eight. Only
 * the shape of a path is judged here; whether one exists is the caller's look.
 */
export function namedFiles(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, '');
    if (NOT_A_FILE_RE.test(p) || out.includes(p)) continue;
    out.push(p);
    if (out.length >= 8) break;
  }
  return out;
}

/** The first user message: the task, then the context and skills the job carries (each cut to a size a small context window can hold). */
export function userMessage(i: PromptInput): string {
  const parts: string[] = [];
  if (i.skills) parts.push(`<skills>\n${i.skills}\n</skills>`);
  if (i.context) parts.push(`<context>\n${i.context}\n</context>`);
  parts.push(`Task:\n${i.message}`);
  if (i.newFiles && i.newFiles.length > 0) parts.push(`Files to create: ${i.newFiles.join(', ')}. Start now: your first action is write_file for ${i.newFiles[0]}.`);
  return parts.join('\n\n');
}

// ---- nudges: a reply with no tool call, when work is left; each says the one thing to do next ----

/** The reply was text only, before any tool was used. */
export const nudgeNoTools = (missing: readonly string[]): string => (missing.length > 0
  ? `You did not call a tool. Call write_file now to create ${missing[0]} (the whole file). Files still to create: ${missing.join(', ')}.`
  : 'You did not call a tool. Use the tools: write the files with write_file, run them with sandbox_exec, and finish with changeset_register.');
/** The form a small model writes a call in when it does not use the server's own interface (the loop reads it). Ends every nudge. */
export const NUDGE_FORMAT = ' Reply with only the tool call, no explanation and no code outside it, for example {"name": "write_file", "arguments": {"path": "src/a.js", "content": "..."}}.';
/** A reply that looks like a call but is not valid JSON (a brace, a quote or a comma wrong, or the text cut off). */
export const NUDGE_BAD_CALL = 'Your tool call was not valid JSON, so it was not run. Write it again as ONE JSON object with every brace closed: {"name": "<tool>", "arguments": {...}}. Put the file content in one JSON string (write \\n for a new line and \\" for a quote). Keep the file shorter if needed.';
export const NUDGE_EMPTY = 'Your reply was empty. Call a tool to continue, or stop if the work is finished.';
/** The model stopped with files the task named still not written. */
export const nudgeMissing = (missing: readonly string[]): string =>
  `You are not done: ${missing.length === 1 ? 'this file is' : 'these files are'} still missing: ${missing.join(', ')}. Call write_file now for ${missing[0]} (the whole file).`;
export const NUDGE_RUN = 'You wrote the files but have not run them. Call sandbox_exec now to run the tests (for example argv ["node","--test"], timeoutMs 120000); when they pass, finish with changeset_register.';
const fixWhere = (where: string | null, failing: readonly string[]): string =>
  `${where ? ` The first error is in ${where}: look at that file first; the file you wrote last may be fine.` : ''}${failing.length > 0 ? ` Failing: ${failing.join('; ')}.` : ''}`;
const FIX_HOW = 'If a test expects something the task does not ask for (a particular id value, say), change the test, not the code.';
export const nudgeFix = (where: string | null, failing: readonly string[] = []): string =>
  `The last run failed.${fixWhere(where, failing)} Do not read the files again: fix the one that is wrong with write_file (the whole file), then run sandbox_exec again. ${FIX_HOW}`;
/** The fixes did not work: register the work as it is, saying what fails, so it is kept and reviewed rather than lost. */
export const nudgeGiveUp = (failing: readonly string[] = []): string =>
  `Your fixes did not make the tests pass. Do not lose the work: register the change anyway so it can be reviewed. Call changeset_register now with a title, a summary that says which tests still fail${failing.length > 0 ? ` (${failing.join('; ')})` : ''}, and a clientKey (for example "cs1").`;
/** The model repeats one call: keep the work by registering it as it is. */
export const NUDGE_STUCK = 'You are repeating the same call and it leads nowhere. Do not lose the work: call changeset_register now with a title, a summary that says what works and what still fails, and a clientKey (for example "cs1").';
/** The turn's time is nearly used up with work written and not registered. */
export const NUDGE_TIME = 'Time is almost up. Do not lose the work: call changeset_register now with a title, a summary that says what works and what still fails, and a clientKey (for example "cs1").';
export const NUDGE_FINISH = 'The work is done and the tests pass. Call changeset_register now with a title, a summary and a clientKey (for example "cs1"). That is the last step.';
export const NUDGE_REGISTER = 'You wrote files but have not registered the change. If the work is finished and the tests pass, call changeset_register now with a title, a summary and a clientKey.';
export const NOTE_TEXT_CALL = 'Note: that call was written as text and was run anyway. Next time use the tool-calling interface, not text.';

// ---- hints: appended to a tool result so a small model need not work out the protocol ----

export const hintMissing = (missing: readonly string[]): string => `Next: still to create: ${missing.join(', ')}. Call write_file for ${missing[0]}.`;
export const HINT_RUN = 'Next: run the tests now with sandbox_exec.';
export const hintFix = (where: string | null, failing: readonly string[] = []): string =>
  `Next: the run failed.${fixWhere(where, failing)} Fix the file that is wrong with write_file (the whole file), then run sandbox_exec again. ${FIX_HOW}`;
export const HINT_READ_FIX = 'Next: you have seen the file. Now fix what is wrong and call write_file with the whole new content.';
export const HINT_FINISH = 'Next: it passed. Call changeset_register now (title, summary, clientKey). That is the last step.';
