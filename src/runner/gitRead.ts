/**
 * The runner's bounded git READS (B2b Task 7): `git.read` answers `git.read.result` and runs as no job (main writes no
 * job row for a read). Two reads, both read-only (GIT_OPTIONAL_LOCKS=0: status never takes the index lock), through the
 * write engines' hardened launcher (src/runner/gitWrite.ts HardenedGit: the resolved git binary, `-C`, no hooks, no
 * fsmonitor, every filter and merge driver switched off, inert signature programs):
 * - `status`: the checked-out branch, HEAD, whether tracked files are dirty (the LENGTH of `status --porcelain` only; no
 *   name leaves the runner), the integration head, how many accepted commits the branch lacks, and whether the branch can
 *   fast-forward to the integration head;
 * - `diff`: the patch between two commits main recorded (`--no-ext-diff --no-textconv --ignore-submodules=all`), at most
 *   `maxBytesPerSide` x 2 bytes (cut at a character boundary and `truncated`), redacted before it leaves.
 * Errors are codes only (GIT_READ_ERROR_CODES), never git's text.
 */
import type { GitReadTask } from '../shared/nexus/execution';
import { GIT_DIFF_MAX_BYTES_PER_SIDE } from '../shared/nexus/execution';
import type { GitReadResult } from '../shared/nexus/runnerProtocol';
import { COMMIT_RE } from './git';
import { BRANCH_RE, GitFailure, PREVIEW_DIFF_ARGS, previewText, type HardenedGit } from './gitWrite';

const fail = (code: 'git_missing' | 'not_a_repository' | 'unknown_ref' | 'too_large' | 'error', message: string): GitReadResult => ({ ok: false, code, message });

/** Cuts `buf` to at most `max` bytes without splitting a UTF-8 sequence. */
function cutUtf8(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf;
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

export async function gitRead(g: HardenedGit, task: GitReadTask, o: { signal?: AbortSignal } = {}): Promise<GitReadResult> {
  try {
    if (!task || typeof task !== 'object' || typeof task.repoPath !== 'string') return fail('error', 'the read is malformed');
    if (!(await g.available())) return fail('git_missing', 'git is not installed');
    const repo = task.repoPath;
    const n = await g.neutral(repo, o.signal);
    const top = await g.run(repo, ['rev-parse', '--is-inside-work-tree'], { neutral: n, signal: o.signal });
    if (top.code !== 0 || top.stdout.trim() !== 'true') return fail('not_a_repository', 'the project folder is not a git repository');
    if (task.read === 'status') {
      if (!BRANCH_RE.test(task.branch) || task.integrationRef !== `refs/nexus/accepted/${task.branch}`) return fail('error', 'the read is malformed');
      const b = await g.run(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { neutral: n, signal: o.signal });
      const current = b.code === 0 && BRANCH_RE.test(b.stdout.trim()) ? b.stdout.trim() : null;
      const h = await g.run(repo, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { neutral: n, signal: o.signal });
      const head = h.code === 0 && COMMIT_RE.test(h.stdout.trim()) ? h.stdout.trim() : null;
      const s = await g.run(repo, ['status', '--porcelain=v1', '-z', '--ignore-submodules=all', '--untracked-files=no'], { neutral: n, signal: o.signal, maxStdout: 0 });
      if (s.code !== 0) return fail('error', 'status failed');
      const i = await g.run(repo, ['rev-parse', '--verify', '-q', `${task.integrationRef}^{commit}`], { neutral: n, signal: o.signal });
      const integrationHead = i.code === 0 && COMMIT_RE.test(i.stdout.trim()) ? i.stdout.trim() : null;
      let acceptedNotMerged = 0; let fastForward = false;
      if (integrationHead && head) {
        const c = await g.run(repo, ['rev-list', '--count', `${head}..${integrationHead}`], { neutral: n, signal: o.signal });
        acceptedNotMerged = c.code === 0 && /^\d+$/.test(c.stdout.trim()) ? Number(c.stdout.trim()) : 0;
        const a = await g.run(repo, ['merge-base', '--is-ancestor', head, integrationHead], { neutral: n, signal: o.signal });
        fastForward = a.code === 0;
      }
      return { ok: true, read: 'status', branch: current ?? task.branch, head, dirty: s.stdoutBytes > 0, integrationHead, acceptedNotMerged, fastForward };
    }
    if (task.read === 'diff') {
      if (!COMMIT_RE.test(task.base) || !COMMIT_RE.test(task.head) || task.maxBytesPerSide !== GIT_DIFF_MAX_BYTES_PER_SIDE) return fail('error', 'the read is malformed');
      for (const sha of [task.base, task.head]) {
        const e = await g.run(repo, ['cat-file', '-e', `${sha}^{commit}`], { neutral: n, signal: o.signal });
        if (e.code !== 0) return fail('unknown_ref', 'a recorded commit is not in the repository');
      }
      const max = task.maxBytesPerSide * 2;
      const chunks: Buffer[] = [];
      const d = await g.run(repo, [...PREVIEW_DIFF_ARGS, task.base, task.head], { neutral: n, signal: o.signal, maxStdout: max + 4 });
      if (d.code !== 0) return fail('error', 'diff failed');
      chunks.push(Buffer.from(d.stdout, 'utf8'));
      const raw = cutUtf8(Buffer.concat(chunks), max);
      const truncated = d.truncated || d.stdoutBytes > max;
      const patch = previewText(raw.toString('utf8'));
      const capped = cutUtf8(Buffer.from(patch, 'utf8'), max).toString('utf8');
      return { ok: true, read: 'diff', base: task.base, head: task.head, patch: capped, bytes: d.stdoutBytes, truncated };
    }
    return fail('error', 'the read is malformed');
  } catch (e) {
    if (e instanceof GitFailure && e.code === 'git_missing') return fail('git_missing', 'git is not installed');
    return fail('error', 'the read could not be done');
  }
}
