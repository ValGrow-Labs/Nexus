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
}

export function systemPrompt(i: Pick<PromptInput, 'hasSandbox' | 'hasChangeset'>): string {
  const steps = [
    'Read the task. Look at the project with list_files and read_file before you change anything.',
    'Write the files the task needs with write_file (the WHOLE file each time).',
    i.hasSandbox ? 'Run the tests or the build with sandbox_exec (the project is at /workspace). Read the output carefully.' : 'Check your work by reading the files back.',
    'If something fails, fix the files and run it again. Do not repeat a call that already failed; change something first.',
    i.hasChangeset ? 'When it works, call changeset_register once with a title, a summary and a clientKey. That is your last action.' : 'When it works, say so briefly.'
  ];
  return [
    'You are a software engineer working inside a project through tools. You can only act by calling tools.',
    '',
    'How to work:',
    ...steps.map((s, n) => `${n + 1}. ${s}`),
    '',
    'Rules:',
    '- Call tools with the tool-calling interface, one tool at a time. Do not write tool calls as text and do not explain at length.',
    '- Paths are relative to the project, with forward slashes (src/app.js). Never use absolute paths, drive letters or "..".',
    '- Do not touch .git, .env files, keys, or anything under .claude or .nexus.',
    '- Keep the project small and simple; a test must be runnable with the project\'s own tooling.',
    '- You cannot use the network. Do not try to install from the internet unless the task says it is allowed.',
    '- When the work is done, stop calling tools.'
  ].join('\n');
}

/** The first user message: the task, then the context and skills the job carries (each cut to a size a small context window can hold). */
export function userMessage(i: PromptInput): string {
  const parts: string[] = [];
  if (i.skills) parts.push(`<skills>\n${i.skills}\n</skills>`);
  if (i.context) parts.push(`<context>\n${i.context}\n</context>`);
  parts.push(`Task:\n${i.message}`);
  return parts.join('\n\n');
}

export const NUDGE_NO_TOOLS = 'You answered with text but did not call a tool. Use the tools: write the files with write_file, run them with sandbox_exec, and finish with changeset_register.';
export const NUDGE_EMPTY = 'Your reply was empty. Call a tool to continue, or stop if the work is finished.';
export const NUDGE_REGISTER = 'You wrote files but have not registered the change. If the work is finished and the tests pass, call changeset_register now with a title, a summary and a clientKey.';
export const NOTE_TEXT_CALL = 'Note: that call was written as text and was run anyway. Next time use the tool-calling interface, not text.';
