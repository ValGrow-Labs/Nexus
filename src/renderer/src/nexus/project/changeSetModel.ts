// Pure: how a change made by the agent reads and what a person may do with it, from what main says (the version, #32 checks,
// the newest review, #49 repository status). No React, so tests load it directly. Rules this file keeps:
// - the headline names every blocking check that is not in order, and a failing check never reads "passed";
// - Accept is offered only on a candidate whose newest review approves, and only when the accepted branch's head is known;
// - Merge is shown only while accepted work is not yet on the branch, and is a sentence while the tree has uncommitted changes
//   to TRACKED files (new, untracked files never block it);
// - no host, model or engine name; the review and the merge are the person's, never the agent's.
import type {
  ActivityView, ArtifactSummaryView, MergeView, RepoStatusView, ReviewDecision, ValidationResultView, VersionContent, VersionView
} from '@shared/nexus/ipc';
import { blockingValidatorsFor } from '@shared/nexus/validators';
import { AGENT_REASON_TEXT } from '../data/errorCopy';
import { statusWord, validatorLabel } from './evidenceModel';

export const REVIEW_DECISION_WORDS = ['approve', 'request_changes', 'reject'] as const;
const isDecision = (v: unknown): v is ReviewDecision => typeof v === 'string' && (REVIEW_DECISION_WORDS as readonly string[]).includes(v);

/** A change's newest recorded review per version, from the project's activity (`review.decide` rows carry only the decision word). */
export function latestReviews(rows: readonly ActivityView[]): Map<string, ReviewDecision> {
  const best = new Map<string, { seq: number; decision: ReviewDecision }>();
  for (const r of rows) {
    if (r.action !== 'review.decide' || r.status !== 'succeeded' || !r.versionId) continue;
    const d = r.details?.decision;
    if (!isDecision(d)) continue;
    const prev = best.get(r.versionId);
    if (!prev || r.seq > prev.seq) best.set(r.versionId, { seq: r.seq, decision: d });
  }
  return new Map([...best].map(([k, v]) => [k, v.decision]));
}

export type ChangeSetButton = 'approve' | 'request_changes' | 'reject' | 'accept';
export const BUTTON_LABEL: Readonly<Record<ChangeSetButton, string>> = Object.freeze({
  approve: 'Approve', request_changes: 'Request changes', reject: 'Reject', accept: 'Accept the change'
});

export interface BlockingCheck { id: string; label: string; word: string }
export interface ChangeSetInput {
  version: Pick<VersionView, 'status'> & { content?: VersionContent };
  /** #32 for the version; null while unread or when execution is off. */
  validations: readonly ValidationResultView[] | null;
  /** The newest review on this version, if one is known. */
  review: ReviewDecision | null;
  /** #49; null while unread. */
  repo: RepoStatusView | null;
}
export interface ChangeSetView {
  headline: string;
  /** Every blocking check that is not in order, by name and word. */
  blocking: BlockingCheck[];
  /** The diff to show: the head commit (short) the change records. The base is the repository's recorded one and is read with the diff. */
  diff: { base: string | null; head: string | null };
  buttons: ChangeSetButton[];
  /** What cannot be done and why, in sentences. */
  sentences: string[];
  /** Accepted work not yet on the branch (the same for every change of the project); null when there is none. */
  merge: MergeModel | null;
}

const short = (sha: string | null | undefined): string | null => (typeof sha === 'string' && /^[0-9a-f]{7,64}$/i.test(sha) ? sha.slice(0, 8) : null);

/** The blocking checks of a change that are not in order, in the registry's order. Unread checks (null) give none: they are unknown. */
export function blockingChecks(validations: readonly ValidationResultView[]): BlockingCheck[] {
  const have = new Map(validations.filter((r) => r.blocking).map((r) => [r.validatorId, r]));
  const out: BlockingCheck[] = [];
  for (const d of blockingValidatorsFor('change_set')) {
    const r = have.get(d.id);
    const status = r ? r.status : null;
    if (status === 'passed') continue;
    out.push({ id: d.id, label: validatorLabel(d.id), word: statusWord(status) });
  }
  return out;
}

const list = (b: readonly BlockingCheck[]): string => b.map((c) => `${c.label}: ${c.word.toLowerCase()}`).join('; ');

export function changeSetModel(i: ChangeSetInput): ChangeSetView {
  const head = i.version.content && i.version.content.type === 'git' ? short(i.version.content.commit) : null;
  const diff = { base: null, head };
  const blocking = i.validations ? blockingChecks(i.validations) : [];
  const merge = mergeModel(i.repo);
  const status = i.version.status;
  const base = { diff, blocking, merge, buttons: [] as ChangeSetButton[], sentences: [] as string[] };
  if (status === 'failed') {
    return { ...base, headline: blocking.length ? `Blocked: ${list(blocking)}` : 'This change did not pass its checks',
      sentences: ['It cannot be reviewed or accepted. Ask the agent to try again.'] };
  }
  if (status === 'deprecated') return { ...base, headline: 'This change was replaced or discarded', sentences: ['It can no longer be reviewed or accepted.'] };
  if (status === 'active') {
    return { ...base, headline: 'Accepted: it is on the Nexus branch', sentences: ['Your own branch changes only when you merge accepted work.'] };
  }
  if (status === 'draft') {
    if (i.validations === null) return { ...base, headline: 'Its checks cannot be read right now', sentences: ['It can be reviewed once its checks are in.'] };
    const failing = blocking.filter((b) => b.word !== 'Not run yet');
    if (failing.length) return { ...base, headline: `Blocked: ${list(blocking)}`, sentences: ['It cannot be reviewed while a check is blocking it.'] };
    return { ...base, headline: blocking.length ? `Being checked: ${blocking.map((b) => b.label).join('; ')}` : 'Being checked', sentences: ['It can be reviewed once its checks are in.'] };
  }
  // candidate: every blocking check is in order by definition; if the checks disagree, say so and offer nothing.
  if (i.validations !== null && blocking.length > 0) {
    return { ...base, headline: `Blocked: ${list(blocking)}`, sentences: ['It cannot be decided on while a check is blocking it.'] };
  }
  const buttons: ChangeSetButton[] = ['approve', 'request_changes', 'reject'];
  const sentences: string[] = [];
  let headline: string;
  switch (i.review) {
    case 'approve': headline = 'Approved by you: ready to accept'; break;
    case 'request_changes': headline = 'You asked the agent for changes'; break;
    case 'reject': headline = 'You rejected this change'; break;
    default: headline = 'Waiting for your decision';
  }
  if (i.review === 'approve') {
    if (i.repo && i.repo.acceptedHead) buttons.push('accept');
    else sentences.push('The accepted branch has not been read yet, so the change cannot be accepted. Look again in a moment.');
  } else {
    sentences.push('Accept appears once you have approved the change.');
  }
  return { ...base, headline, buttons, sentences };
}

// ---------- merging accepted work ----------

export interface MergeModel {
  /** "2 accepted changes are not on your branch yet." */
  line: string;
  /** The button, only when a fast-forward is possible now. */
  button: { label: string; args: { branch: string; expectedAcceptedHead: string } } | null;
  /** Why not, in one sentence, when there is no button. */
  sentence: string | null;
}

/** Merge is shown only while accepted work is not on the branch. A dirty tree (tracked files only) makes it a sentence. */
export function mergeModel(repo: RepoStatusView | null): MergeModel | null {
  if (!repo || repo.acceptedNotMerged <= 0) return null;
  const n = repo.acceptedNotMerged;
  const line = n === 1 ? '1 accepted change is not on your branch yet.' : `${n} accepted changes are not on your branch yet.`;
  if (repo.dirty === true) return { line, button: null, sentence: AGENT_REASON_TEXT.tree_dirty };
  if (repo.canFastForward && repo.branch && repo.acceptedHead) {
    return { line, button: { label: 'Merge accepted work', args: { branch: repo.branch, expectedAcceptedHead: repo.acceptedHead } }, sentence: null };
  }
  const why = repo.reason && Object.prototype.hasOwnProperty.call(AGENT_REASON_TEXT, repo.reason) ? AGENT_REASON_TEXT[repo.reason] : 'Merging is not possible right now.';
  return { line, button: null, sentence: why };
}

export function acceptedText(): string {
  return 'Accepted. The change is on the Nexus branch; your own branch changes only when you merge accepted work.';
}

export function mergedText(m: Pick<MergeView, 'branch' | 'before' | 'after'>): string {
  const b = short(m.before); const a = short(m.after);
  return b && a ? `Merged: ${m.branch} moved from ${b} to ${a}.` : `Merged into ${m.branch}.`;
}

// ---------- the list in the Changes tool ----------

export interface ChangeSetRow { artifactId: string; name: string; versionId: string; versionNo: number; status: VersionView['status']; word: string; reviewable: boolean }

const ROW_WORD: Record<VersionView['status'], string> = {
  draft: 'Being checked', candidate: 'Ready for your decision', active: 'Accepted', failed: 'Blocked', deprecated: 'Replaced or discarded'
};

/** The project's changes made by the agent, newest first: the latest version of each active change-set artifact. */
export function changeSetRows(summaries: readonly ArtifactSummaryView[]): ChangeSetRow[] {
  return summaries.filter((s) => s.artifact.kind === 'change_set' && s.artifact.status === 'active' && s.latest)
    .sort((x, y) => y.artifact.createdAt - x.artifact.createdAt)
    .map((s) => ({ artifactId: s.artifact.id, name: s.artifact.name, versionId: s.latest!.id, versionNo: s.latest!.versionNo, status: s.latest!.status,
      word: ROW_WORD[s.latest!.status] ?? s.latest!.status, reviewable: s.latest!.status === 'candidate' }));
}

// ---------- the read-only diff ----------

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';
const META = /^(diff --git |index [0-9a-f]|--- (a\/|\/dev\/null)|\+\+\+ (b\/|\/dev\/null)|new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode|Binary files )/;

/** One patch line's kind, for the reader's marks (a word, never colour alone: the line keeps its +/- sign). */
export function diffLineKind(line: string): DiffLineKind {
  if (META.test(line)) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}
