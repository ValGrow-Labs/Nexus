import type { GitState, SpineNode } from './spineModel';
import { relativeTime } from '../data/selectors';

/** One sentence about a project's saved work: its line of work and the last saved version. A read that
 *  failed is "unknown", never mistaken for "no line of work" or "nothing saved". Returns null for anything that is not a readable source. */
export function provenanceLine(node: SpineNode, git: GitState, now: number): string | null {
  if (node.kind !== 'source' || node.vcs !== 'git' || git.status !== 'ready') return null;
  const unknown = git.unknown ?? {};
  const lead = git.branch ? `Current line of work: ${git.branch}.` : unknown.branch ? 'Current line of work unknown.' : 'Not on a named line of work.';
  const h = git.head;
  const last = h
    ? `Last saved version: ${h.shortSha} ${h.subject}${h.time ? `, ${relativeTime(h.time * 1000, now)}` : ''}.`
    : unknown.head ? 'Last saved version unknown.' : 'Nothing saved yet.';
  return `${lead} ${last}`;
}
