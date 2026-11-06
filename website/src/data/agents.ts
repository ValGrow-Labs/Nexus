export interface AgentFeature {
  title: string;
  tagline: string;
  description: string;
  badge: string;
}

export const AGENT_FEATURES: AgentFeature[] = [
  {
    title: 'Real Terminal Execution',
    tagline: 'pty · xterm.js · subprocesses',
    description: 'Runs real CLI tools like Claude Code and Codex directly inside native pseudo-terminals on your OS. No simulated web chatbots or hidden proxies.',
    badge: 'Native PTY'
  },
  {
    title: 'Local Hive Orchestration',
    tagline: 'Lead agent · Task dispatch · 1.5s pulse',
    description: 'A lead agent interprets requirements, plans execution stages, and delegates tasks to worker agents via an on-device local message queue.',
    badge: 'Zero Cloud Relay'
  },
  {
    title: 'Context-Bound Intent Line',
    tagline: 'Ctrl+J · Git branch · Dirty files',
    description: 'Docked instructions automatically bind active workspace metadata, current git commit SHA, uncommitted changes, and project dependencies.',
    badge: 'Precision Context'
  },
  {
    title: 'Reviewed Diff Verification',
    tagline: 'Git review · Hunk inspection · Human signoff',
    description: 'You inspect every modification before anything is committed to your repository. Nexus never executes destructive operations without explicit visibility.',
    badge: 'Human in the Loop'
  }
];

export interface TerminalLogLine {
  type: 'prompt' | 'info' | 'agent' | 'success' | 'code' | 'diff-add' | 'diff-del';
  text: string;
  prefix?: string;
}

export const DEMO_AGENT_SESSION: TerminalLogLine[] = [
  { type: 'prompt', text: 'nexus intent "Add WAL mode and safe transaction retry to database layer"', prefix: '$' },
  { type: 'info', text: 'Context attached: workspace=sde project=nexus-core branch=main dirty=0' },
  { type: 'agent', text: 'Lead agent [Claude 3.7 Sonnet] analyzing schema and concurrency requirements...' },
  { type: 'agent', text: 'Dispatching task #108 to worker-1: "Configure SQLite PRAGMA journal_mode = WAL"' },
  { type: 'code', text: '  db.pragma(\'journal_mode = WAL\');' },
  { type: 'code', text: '  db.pragma(\'busy_timeout = 5000\');' },
  { type: 'agent', text: 'Dispatching task #109 to worker-2: "Generate concurrent stress test for transaction rollback"' },
  { type: 'success', text: 'worker-2 executed: test/nexus-db-concurrency.test.cjs (14 tests passed, 0 failures)' },
  { type: 'info', text: 'Uncommitted working tree: 2 files changed, +38 lines, -4 lines' },
  { type: 'success', text: 'Stage ready for inspection. Focus surface opened on Reviewed Diff.' }
];

