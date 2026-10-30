import { createContext, useContext } from 'react';
import type { DomainId } from '@shared/domain';
import type { Section as SettingsSection } from '@/components/SettingsModal';

export interface ShellActions {
  openSettings: (section?: SettingsSection) => void;
  openNewProject: (domainId?: DomainId) => void;
  openImport: () => void;
  openIde: (root?: string) => void;
  openProjectManager: () => void;
}

export const ShellActionsContext = createContext<ShellActions | null>(null);

/** The shell's actions when there are any (a surface that may also render outside the shell uses this one); null otherwise. */
export function useOptionalShellActions(): ShellActions | null {
  return useContext(ShellActionsContext);
}

export function useShellActions(): ShellActions {
  const a = useContext(ShellActionsContext);
  if (!a) throw new Error('useShellActions outside NexusShell');
  return a;
}
