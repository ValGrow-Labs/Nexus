/**
 * The words Nexus uses with people (the plain-words glossary). One plain name per idea, everywhere a person reads it, plus
 * one short line that can sit in a tooltip or a help line. Written for someone with no developer background: short words,
 * no internal names. Code, routes and ids keep their technical names; only what a person reads uses these.
 *
 * Rules for user-facing copy: use these names; never show an id, a check name, a phase code or a git word; say what a button
 * will do; say what to do next. Main's fixed sentences (src/main/nexusIpc/envelope.ts) and the renderer's errorCopy are mirrored
 * word for word, so a change to one is made in both.
 */
export interface Term {
  /** The name people see, as it appears inside a sentence. */
  name: string;
  /** The same name for one of them, where it differs. */
  one?: string;
  /** One line of plain help for a tooltip. */
  help: string;
}

const t = (name: string, help: string, one?: string): Term => ({ name, help, ...(one ? { one } : {}) });

export const GLOSSARY = Object.freeze({
  suggestedChanges: t('suggested changes', 'Edits the AI helper suggests. Nothing changes in your files until you say so.', 'suggested change'),
  aiHelper: t('AI helper', 'The AI that builds things for you. It works in a safe copy and never in your real files.'),
  leadHelper: t('lead AI helper', 'The AI helper that takes your requests and passes the work on to others.'),
  aiService: t('AI service', 'The service that does the thinking for the AI helper.'),
  freeOnlineAi: t('Free online AI', 'An AI service on the internet that you can use for free with a key you create yourself.'),
  aiOnThisComputer: t('AI on this computer', 'An AI that runs on your own computer. It is free and private, but it can be slow.'),
  yourOwnPlan: t('Your own plan', 'An AI service you already pay for, such as a subscription you signed up for.'),
  accessKey: t('access key', 'A secret code that lets Nexus use an AI service for you. Keep it private.'),
  internetPermission: t('internet permission', 'You choose which online address the AI helper may talk to. You can take it back at any time.'),
  allowOnce: t('Allow once', 'Nexus asks before it does something with a side effect. This allows just this one time.'),
  safeCopy: t('safe copy of your project', 'A separate copy where the AI helper works, so your real files stay untouched.'),
  startingPoint: t('starting point', 'Nexus remembers how your project looks right now, so it can compare later.'),
  hiddenNotes: t('hidden Nexus notes', 'A small hidden area where Nexus keeps its own notes. Your files and your main version are never changed.'),
  mainVersion: t("your project's main version", 'The line of saved work you normally use.'),
  nexusCopy: t("Nexus's saved copy", 'Where Nexus keeps the changes you kept, until you add them to your project.'),
  looksGood: t('Looks good', 'Say that you read the suggested changes and they are fine.'),
  keepChanges: t('Keep these changes', "Save the suggested changes in Nexus's copy. Your own files are not touched yet."),
  addToProject: t('Add to my project', "Copy the kept changes into your project's main version. You confirm in a separate window first."),
  savedVersion: t('saved version', "A saved point in your project's history."),
  whatChanged: t('what changed', 'The lines that were added and removed.'),
  task: t('task', 'One piece of work Nexus runs for you, like building or testing.'),
  request: t('request', 'One message you sent and the work the AI helper did for it.'),
  conversation: t('conversation', 'A back-and-forth with the AI helper.'),
  safeSpace: t('safe space', 'A closed box on your computer where code can run without touching anything else.'),
  docker: t('Docker', 'A free program that makes safe spaces. Install Docker Desktop so Nexus can run code safely.'),
  getReady: t('Get this computer ready', 'Checks the things Nexus needs on this computer.'),
  check: t('check', 'Nexus asks the app a simple question to see if it is working.'),
  testRun: t('test run of your app', 'Starts your app on this computer only, so you can try it.'),
  savedItem: t('saved item', 'Anything your projects produce: notes, builds, suggested changes.'),
  madeFrom: t('made from', 'What this item came from, and what uses it.'),
  workspace: t('workspace', 'A set of tools for one kind of work, like building software or analysing data.'),
  handoff: t('handoff', 'Pass a finished item to another workspace in the same project.'),
  requiredCheck: t('required check', 'A check that must pass before you can go on.'),
  autoChecks: t('checks', 'Automatic tests Nexus runs on a version.')
});

export type TermId = keyof typeof GLOSSARY;

/** The workspaces' full names for people (the short codes stay in code and routes). */
export const WORKSPACE_PLAIN_NAMES = Object.freeze({
  sde: 'Software', ml: 'Machine learning', dl: 'Deep learning', qa: 'Testing'
} as const);

/** The name of an idea for use in copy; throws for an unknown id at test time rather than showing a blank. */
export const termName = (id: TermId): string => GLOSSARY[id].name;
export const termHelp = (id: TermId): string => GLOSSARY[id].help;
