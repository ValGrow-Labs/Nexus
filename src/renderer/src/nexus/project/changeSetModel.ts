// Pure: how a change made by the agent reads and what a person may do with it, from what main says (the version, #32 checks,
// the newest review, #49 repository status). No React, so tests load it directly. Rules this file keeps:
// - the headline names every blocking check that is not in order, and a failing check never reads "passed";
// - Accept is offered only on a candidate whose newest review approves, and only when the accepted branch's head is known;
// - Merge is shown only while accepted work is not yet on the branch, and is a sentence while the tree has uncommitted changes
//   to TRACKED files (new, untracked files never block it);
// - no host, model or engine name; the review and the merge are the person's, never the agent's.
import type {
  ArtifactSummaryView, MergeView, RepoStatusView, ReviewDecision, ValidationResultView, VersionContent, VersionView
} from '@shared/nexus/ipc';
import { blockingValidatorsFor } from '@shared/nexus/validators';
import { AGENT_REASON_TEXT } from '../data/errorCopy';
import { sizeLabel } from '../data/executionModel';
import { statusWord, validatorLabel } from './evidenceModel';

export const REVIEW_DECISION_WORDS = ['approve', 'request_changes', 'reject'] as const;

/** The newest review from a version view's `latestReview`: its decision, `null` when never reviewed, `undefined` when the field is absent (not read yet, or not a change set). */
export function reviewOf(latest: { decision: ReviewDecision } | null | undefined): ReviewDecision | null | undefined {
  return latest === undefined ? undefined : latest === null ? null : isDecision(latest.decision) ? latest.decision : null;
}
const isDecision = (v: unknown): v is ReviewDecision => typeof v === 'string' && (REVIEW_DECISION_WORDS as readonly string[]).includes(v);

/**
 * Why a change cannot be approved from Nexus: one fixed sentence per reason (main refuses the approval too, `preview_incomplete`).
 * A reason this build does not know reads as the generic one: the check fails closed, never a raw code.
 */
export const PREVIEW_INCOMPLETE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  hidden_lines: 'Part of this change is hidden here because it looks like a secret, so it can’t be approved from Nexus. Review it in your own tools, or ask the agent to rewrite it.',
  too_large: 'This change is too large to show here, so it can’t be approved from Nexus. Review it in your own tools, or ask the agent to split it up.',
  truncated: 'This change is too large to show here in full, so it can’t be approved from Nexus. Review it in your own tools, or ask the agent to split it up.',
  unsafe_characters: 'This change contains characters that can make code look different from what it does (hidden or reordering characters), so it can’t be approved from Nexus. Review it in your own tools, or ask the agent to remove them.',
  binary_file: 'A file in this change is binary, so it can’t be shown here and can’t be approved from Nexus. Review it in your own tools, or ask the agent to leave it out.',
  unknown: 'Nexus could not confirm that the whole change can be shown here, so it can’t be approved from Nexus. Review it in your own tools, or ask the agent to rewrite it.'
});
export function previewIncompleteText(reason: unknown): string {
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(PREVIEW_INCOMPLETE_TEXT, reason) ? PREVIEW_INCOMPLETE_TEXT[reason] : PREVIEW_INCOMPLETE_TEXT.unknown;
}
/** What stands in place of Approve while the patch is only partly loaded (or its load failed). */
export function loadWholeText(d: ChangeSetInput['diffRead']): string {
  if (d && d.failed === true) return 'The whole change could not be read, so it can’t be approved from Nexus. Try loading it again.';
  const of = d && d.totalBytes !== null ? ` (${sizeLabel(d.readBytes)} of ${sizeLabel(d.totalBytes)} loaded)` : d ? ` (${sizeLabel(d.readBytes)} loaded)` : '';
  return `Load the whole change to approve it${of}.`;
}
/** True when the change's diff text carries a redacted part (main redacts the diff whole before it is shown). */
export const diffHasRedaction = (text: string | null | undefined): boolean => typeof text === 'string' && text.includes('[redacted]');
export const DIFF_REDACTED_NOTE = 'Part of this diff is hidden here as [redacted] because it looks like a secret. What you see is not the whole change.';

export type ChangeSetButton = 'approve' | 'request_changes' | 'reject' | 'accept';
export const BUTTON_LABEL: Readonly<Record<ChangeSetButton, string>> = Object.freeze({
  approve: 'Approve', request_changes: 'Request changes', reject: 'Reject', accept: 'Accept the change'
});

export interface BlockingCheck { id: string; label: string; word: string }
export interface ChangeSetInput {
  version: Pick<VersionView, 'status'> & { content?: VersionContent;
    /** Whether Nexus's own preview shows the WHOLE change (change sets only). Only an explicit `true` is complete; anything else is not. */
    previewComplete?: boolean | null;
    /** Why not, as main's closed code; any other value is read as unknown. */
    previewReason?: unknown };
  /** #32 for the version; null while unread or when execution is off. */
  validations: readonly ValidationResultView[] | null;
  /**
   * The newest review of this change (the version's own `latestReview`): `null` when it was never reviewed, `undefined` when it
   * is not known (the version is not read yet, or it is not a change set): no review UI is offered then.
   */
  review: ReviewDecision | null | undefined;
  /** #49; null while unread. */
  repo: RepoStatusView | null;
  /**
   * How much of the change's patch the reader has loaded (it is paged; a patch can be up to 2 MiB). An approval needs ALL of it:
   * `undefined` (not supplied) or anything short of whole is not enough, and a failed page keeps Approve hidden.
   */
  diffRead?: { whole: boolean; readBytes: number; totalBytes: number | null; failed?: boolean };
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
  if (i.review === undefined) return { ...base, headline: 'Reading the change’s review state…', sentences: [] };
  // Approve only when Nexus shows the whole change (an explicit `true`); asking for changes and rejecting never need that.
  const complete = i.version.previewComplete === true;
  // ... and only after the whole patch has been loaded here: the person approves what they could read.
  const d = i.diffRead;
  const whole = complete && d !== undefined && d.whole === true && d.failed !== true;
  const buttons: ChangeSetButton[] = whole ? ['approve', 'request_changes', 'reject'] : ['request_changes', 'reject'];
  const sentences: string[] = complete ? [] : [previewIncompleteText(i.version.previewReason)];
  if (complete && !whole) sentences.push(loadWholeText(d));
  let headline: string;
  switch (i.review) {
    case 'approve': headline = 'Approved by you: ready to accept'; break;
    case 'request_changes': headline = 'You asked the agent for changes'; break;
    case 'reject': headline = 'You rejected this change'; break;
    default: headline = 'Waiting for your decision';
  }
  if (i.review === 'approve') {
    if (i.repo && i.repo.acceptedHead) buttons.push('accept');
    else if (i.repo && i.repo.reason && ['git_missing', 'branch_unknown', 'runner_unavailable'].includes(i.repo.reason)) sentences.push(AGENT_REASON_TEXT[i.repo.reason]);
    else sentences.push('The accepted branch has not been read yet, so the change cannot be accepted. Look again in a moment.');
  } else {
    if (complete) sentences.push('Accept appears once you have approved the change.');
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

/** The result of a merge in words: no commit id in the text (it is in `mergedTitle`, for a hover). */
export function mergedText(m: Pick<MergeView, 'branch'>): string {
  return `Merged: ${m.branch} now holds the accepted work.`;
}
/** The two commits a merge moved the branch between, for a title attribute only. */
export function mergedTitle(m: Pick<MergeView, 'before' | 'after'>): string | undefined {
  const b = short(m.before); const a = short(m.after);
  return b && a ? `The branch moved from ${b} to ${a}` : undefined;
}
/** The commit a change records as its head, for a title attribute only. */
export function headTitle(head: string | null): string | undefined {
  return head ? `Head commit ${head}` : undefined;
}

// ---------- the list in the Changes tool ----------

export interface ChangeSetRow { artifactId: string; name: string; versionId: string; versionNo: number; status: VersionView['status']; word: string; reviewable: boolean }

const ROW_WORD: Record<VersionView['status'], string> = {
  draft: 'Being checked', candidate: 'Ready for review', active: 'Accepted', failed: 'Blocked', deprecated: 'Replaced or discarded'
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
export interface DiffLine { text: string; kind: DiffLineKind }
const HUNK_HEAD = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Each line of a unified patch with its kind, by HUNK CONTEXT, exactly as the runner's secret scan reads a patch (`scanAddedLines`):
 * a hunk header `@@ -a,b +c,d @@` says how many old and new lines follow, and while any are left EVERY line is content (`+` added,
 * `-` removed, a space context), so an added line whose text is `++ b/README.md` is an added line, never a file header. Headers are
 * recognised only outside a hunk. A line that does not fit the counts ends the hunk (the same fail-safe as the scan) and is read as a
 * header line. The kinds only add a mark and weight; every line keeps its own +/- sign, so nothing relies on a colour.
 */
export function classifyDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLeft = 0; let newLeft = 0;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) { out.push({ text: raw, kind: 'ctx' }); continue; }            // "\ No newline at end of file"
      if (line.startsWith('-') && oldLeft > 0) { oldLeft--; out.push({ text: raw, kind: 'del' }); continue; }
      if (line.startsWith('+') && newLeft > 0) { newLeft--; out.push({ text: raw, kind: 'add' }); continue; }
      if (line.startsWith(' ') && oldLeft > 0 && newLeft > 0) { oldLeft--; newLeft--; out.push({ text: raw, kind: 'ctx' }); continue; }
      oldLeft = 0; newLeft = 0;                                                            // malformed: leave the hunk
    }
    // git writes the "no newline" marker right after the last line of a side, which may be the last line of the hunk.
    if (line.startsWith('\\')) { out.push({ text: raw, kind: 'ctx' }); continue; }
    const m = HUNK_HEAD.exec(line);
    if (m) { oldLeft = m[1] === undefined ? 1 : Number(m[1]); newLeft = m[2] === undefined ? 1 : Number(m[2]); out.push({ text: raw, kind: 'hunk' }); continue; }
    // Outside a hunk: the patch's own header lines (diff --git, index, ---, +++, mode and rename lines) and anything else.
    out.push({ text: raw, kind: line === '' ? 'ctx' : 'meta' });
  }
  return out;
}
