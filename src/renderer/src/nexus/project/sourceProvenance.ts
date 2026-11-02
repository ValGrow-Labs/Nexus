import type { GitState, SpineNode } from './spineModel';
import { relativeTime } from '../data/selectors';

/** One short line about a project's saved work: the last saved version (its line of work and short id are already next to the
 *  title, so they are said here only when they are not known). A read that failed is "unknown", never mistaken for "no line of work"
 *  or "nothing saved". Returns null for anything that is not a readable source. */
export function provenanceLine(node: SpineNode, git: GitState, now: number): string | null {
  if (node.kind !== 'source' || node.vcs !== 'git' || git.status !== 'ready') return null;
  const unknown = git.unknown ?? {};
  const lead = git.branch ? null : unknown.branch ? 'Current line of work unknown.' : 'Not on a named line of work.';
  const h = git.head;
  const last = h
    ? `Last saved: ${h.subject || h.shortSha}${h.time ? `, ${relativeTime(h.time * 1000, now)}` : ''}.`
    : unknown.head ? 'Last saved version unknown.' : 'Nothing saved yet.';
  return lead ? `${lead} ${last}` : last;
}
