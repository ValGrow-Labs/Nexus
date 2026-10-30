import { useCallback, useEffect, useRef, useState } from 'react';
import { checkedOutHead, kindOf } from './spineModel';
import type { ChangeKind, GitState } from './spineModel';

export function useProjectGit(rootPath: string | null): { git: GitState; refresh: () => void } {
  const [git, setGit] = useState<GitState>({ status: 'loading' });
  const reqId = useRef(0);
  const read = useCallback(async () => {
    const id = ++reqId.current;
    const live = () => reqId.current === id;
    if (!rootPath) { setGit({ status: 'loading' }); return; }
    try {
      const isRepo = await window.cth.gitIsRepo(rootPath);
      if (!live()) return;
      if (!isRepo) { setGit({ status: 'ready', isRepo: false, branch: null, head: null, changed: [] }); return; }
      const [b, log, st] = await Promise.all([window.cth.gitBranch(rootPath), window.cth.gitLog(rootPath, 40), window.cth.gitStatus(rootPath)]);
      if (!live()) return;
      const branch = 'error' in b ? null : b.current;
      const tip = Array.isArray(log) ? checkedOutHead(log) : null;
      const head = tip ? { sha: tip.sha, shortSha: tip.shortSha, subject: tip.subject, time: tip.time } : null;
      if ('error' in st) { setGit({ status: 'error', message: st.error }); return; }
      const seen = new Map<string, ChangeKind>();
      for (const e of [...st.staged, ...st.unstaged]) seen.set(e.path, kindOf(e.index, e.worktree));
      for (const p of st.untracked) seen.set(p, 'untracked');
      const branchUnknown = 'error' in b;
      const headUnknown = !Array.isArray(log);
      const changed = [...seen].map(([path, kind]) => ({ path, kind }));
      setGit(branchUnknown || headUnknown
        ? { status: 'ready', isRepo: true, branch, head, changed, unknown: { branch: branchUnknown, head: headUnknown } }
        : { status: 'ready', isRepo: true, branch, head, changed });
    } catch (e) {
      if (live()) setGit({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [rootPath]);
  useEffect(() => {
    setGit({ status: 'loading' });
    void read();
    const onFocus = () => void read();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      reqId.current += 1; // invalidate in-flight reads (older path or unmount)
    };
  }, [read]);
  const refresh = useCallback(() => void read(), [read]);
  return { git, refresh };
}
