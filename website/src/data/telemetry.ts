export interface TelemetryEntry {
  category: string;
  items: string[];
  status: 'allowed' | 'forbidden';
}

export const TELEMETRY_ALLOWLIST: TelemetryEntry[] = [
  {
    category: 'Common Metadata (Anonymous)',
    items: [
      'app_version (e.g. "0.4.4")',
      'os ("darwin" / "win32" / "linux")',
      'arch ("arm64" / "x64")'
    ],
    status: 'allowed'
  },
  {
    category: 'Strictly Prohibited & Never Sent',
    items: [
      'Zero prompts, transcripts, or agent chats',
      'Zero file contents, code diffs, or filenames',
      'Zero repository names, branch names, or remotes',
      'Zero API keys, credentials, tokens, or emails',
      'Zero machine hostnames or hardware signatures'
    ],
    status: 'forbidden'
  }
];

export const TELEMETRY_EVENTS = [
  { event: 'first_run', payload: 'None', when: 'Once, on first application start' },
  { event: 'app_launched', payload: 'None', when: 'Each app launch' },
  { event: 'agent_spawned', payload: 'provider ("claude", "codex")', when: 'When an agent terminal spawns' },
  { event: 'feature_used', payload: 'feature identifier', when: 'At most once per session for key tools' },
  { event: 'session_ended', payload: 'bucket ("<5m", "5-30m", "30m-2h", ...)', when: 'On quit (coarse bucket only)' }
];

