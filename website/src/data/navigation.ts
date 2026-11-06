export interface NavLink {
  label: string;
  href: string;
  isExternal?: boolean;
}

export const NAV_LINKS: NavLink[] = [
  { label: 'Product', href: '#product' },
  { label: 'Experience', href: '#experience' },
  { label: 'Workspaces', href: '#workspaces' },
  { label: 'AI Agents', href: '#agents' },
  { label: 'Local-First', href: '#local-first' },
  { label: 'Toolkit', href: '#toolkit' }
];

export const GITHUB_REPO_URL = 'https://github.com/ValGrow-Labs/Nexus';

