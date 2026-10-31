// Pure: how suggested changes (a change set) read and what a person may do with them, from what main says (the version, #32 checks,
// the newest review, #49 repository status). No React, so tests load it directly. The decision is a plain 3-step rail: "Looks good"
// (the underlying `approve`), "Keep these changes" (`accept`), "Add to my project" (`merge`, confirmed in main's own window).
// Only the words changed; the actions, their order and the fail-closed rules did not. Rules this file keeps:
// - the headline says how many required checks are not in order, and a failing check never reads "passed";
// - "Keep these changes" is offered only on a candidate whose newest review approves, and only when the accepted branch's head is known;
// - "Add to my project" is shown only while kept work is not yet on the branch, and is a sentence while the tree has uncommitted
//   changes to TRACKED files (new, untracked files never block it);
// - "Looks good" needs the WHOLE preview shown and the WHOLE patch loaded (fail closed);
// - no host, model or engine name; the review and the merge are the person's, never the AI helper's.
import type {
  ArtifactSummaryView, MergeView, RepoStatusView, ReviewDecision, ValidationResultView, VersionContent, VersionView
} from '@shared/nexus/ipc';
import { blockingValidatorsFor } from '@shared/nexus/validators';
import { AGENT_REASON_TEXT } from '../data/errorCopy';
import { GLOSSARY } from '../data/glossary';
import { sizeLabel } from '../data/executionModel';
import { statusWord, validatorLabel, validatorLine } from './evidenceModel';

export const REVIEW_DECISION_WORDS = ['approve', 'request_changes', 'reject'] as const;

/** The newest review from a version view's `latestReview`: its decision, `null` when never reviewed, `undefined` when the field is absent (not read yet, or not a change set). */
export function reviewOf(latest: { decision: ReviewDecision } | null | undefined): ReviewDecision | null | undefined {
  return latest === undefined ? undefined : latest === null ? null : isDecision(latest.decision) ? latest.decision : null;
}
const isDecision = (v: unknown): v is ReviewDecision => typeof v === 'string' && (REVIEW_DECISION_WORDS as readonly string[]).includes(v);

/**
 * Why "Looks good" is not offered: one fixed sentence per reason (main refuses the approval too, `preview_incomplete`). Each says what
 * is wrong, that the person cannot say "Looks good" until they can read all of it, and what to do next. A reason this build does not
 * know reads as the generic one: the check fails closed, never a raw code.
 */
export const PREVIEW_INCOMPLETE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  hidden_lines: 'Part of these changes is hidden because it looks like a secret key or password. You cannot say “Looks good” unless you can read all of it. Press “Ask for different changes” so the AI helper tries again without it.',
  too_large: 'These changes are too big to show here, so you cannot say “Looks good” here. Press “Ask for different changes” and ask the AI helper to split the work into smaller pieces.',
  truncated: 'Only the first part of these changes can be shown, so you cannot say “Looks good” here. Press “Ask for different changes” and ask the AI helper to split the work into smaller pieces.',
  unsafe_characters: 'These changes contain invisible or unusual characters that can make code look different from what it does, so you cannot say “Looks good” here. Press “Ask for different changes” and ask the AI helper to remove them.',
  binary_file: 'One file in these changes is not text (for example a picture), so it cannot be shown here and you cannot say “Looks good” here. Press “Ask for different changes” and ask the AI helper to leave that file out.',
  unknown: 'Nexus could not confirm that all of these changes can be shown here, so you cannot say “Looks good” here. Press “Ask for different changes” and ask the AI helper to try again.'
});
export function previewIncompleteText(reason: unknown): string {
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(PREVIEW_INCOMPLETE_TEXT, reason) ? PREVIEW_INCOMPLETE_TEXT[reason] : PREVIEW_INCOMPLETE_TEXT.unknown;
}
/** What stands in place of "Looks good" while the patch is only partly loaded (or its load failed). */
export function loadWholeText(d: ChangeSetInput['diffRead']): string {
  if (d && d.failed === true) return 'Nexus could not load all of these changes, so you cannot say “Looks good” yet. Press “Try again” under what changed.';
  const of = d && d.totalBytes !== null ? ` (${sizeLabel(d.readBytes)} of ${sizeLabel(d.totalBytes)} shown so far)` : d ? ` (${sizeLabel(d.readBytes)} shown so far)` : '';
  return `Show all of what changed to say “Looks good”${of}.`;
}
/** True when the change's diff text carries a redacted part (main redacts the diff whole before it is shown). */
export const diffHasRedaction = (text: string | null | undefined): boolean => typeof text === 'string' && text.includes('[redacted]');
export const DIFF_REDACTED_NOTE = 'Part of what changed is hidden here as [redacted] because it looks like a secret. What you see is not all of the changes.';

export type ChangeSetButton = 'approve' | 'request_changes' | 'reject' | 'accept';
export const BUTTON_LABEL: Readonly<Record<ChangeSetButton, string>> = Object.freeze({
  approve: GLOSSARY.looksGood.name, request_changes: 'Ask for different changes', reject: 'Not these changes', accept: GLOSSARY.keepChanges.name
});

/**
 * A kept change is added to the project once the kept work is in the project's main version: the repository status knows Nexus's
 * saved copy (`acceptedHead`) and nothing kept is waiting to be added (`acceptedNotMerged` 0). Unread status: not known, so not added.
 */
export const mergedOnBranch = (repo: Pick<RepoStatusView, 'acceptedNotMerged' | 'acceptedHead'> | null | undefined): boolean =>
  !!repo && repo.acceptedHead !== null && repo.acceptedNotMerged === 0;

/** A required check that is not in order: `label` is its plain line for this result ("Some of your tests failed"), never its id. */
export interface BlockingCheck { id: string; label: string; word: string }

export type RailStepId = 'looks_good' | 'keep' | 'add';
/** One step of the plain 3-step rail: `current` is the one thing to do next, `waiting` comes later, `done` is finished. */
export interface RailStep { id: RailStepId; n: 1 | 2 | 3; label: string; state: 'done' | 'current' | 'waiting'; help: string }
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
  /** The plain status ("Looks good: done. Next: Keep these changes", "Added to your project"). */
  headline: string;
  /** The 3-step rail, only where a decision is in play (null for a change being checked, blocked, replaced, rejected or sent back). */
  rail: RailStep[] | null;
  /** Every blocking check that is not in order, by name and word. */
  blocking: BlockingCheck[];
  /** The newest saved version (short id) these changes end at. The starting point is the repository's recorded one and is read with what changed. */
  diff: { base: string | null; head: string | null };
  buttons: ChangeSetButton[];
  /** What cannot be done and why, in sentences, with a next step. */
  sentences: string[];
  /** Kept work not yet in the project's main version (the same for every change of the project); null when there is none. */
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
    out.push({ id: d.id, label: validatorLine(d.id, status), word: statusWord(status) });
  }
  return out;
}

/** What the required checks that are not in order amount to, in a sentence: one check says its own plain line; several are counted. */
const blockedText = (b: readonly BlockingCheck[]): string =>
  b.length === 1 ? b[0].label : `${b.length} required checks need attention`;

const RAIL_ORDER: readonly RailStepId[] = ['looks_good', 'keep', 'add'];
const RAIL_TERM = { looks_good: GLOSSARY.looksGood, keep: GLOSSARY.keepChanges, add: GLOSSARY.addToProject } as const;
/** The rail with `done` steps before `current`, the rest waiting (`current` null: every step is done). */
export function railOf(current: RailStepId | null): RailStep[] {
  const at = current === null ? RAIL_ORDER.length : RAIL_ORDER.indexOf(current);
  return RAIL_ORDER.map((id, i) => ({ id, n: (i + 1) as 1 | 2 | 3, label: RAIL_TERM[id].name, help: RAIL_TERM[id].help, state: i < at ? 'done' : i === at ? 'current' : 'waiting' }));
}

export function changeSetModel(i: ChangeSetInput): ChangeSetView {
  const head = i.version.content && i.version.content.type === 'git' ? short(i.version.content.commit) : null;
  const diff = { base: null, head };
  const blocking = i.validations ? blockingChecks(i.validations) : [];
  const merge = mergeModel(i.repo);
  const status = i.version.status;
  const base = { diff, blocking, merge, rail: null as RailStep[] | null, buttons: [] as ChangeSetButton[], sentences: [] as string[] };
  if (status === 'failed') {
    return { ...base, headline: blocking.length ? `Blocked: ${blockedText(blocking)}` : 'These suggested changes did not pass their checks',
      sentences: ['They cannot be looked at or kept. Ask the AI helper to try again.'] };
  }
  if (status === 'deprecated') return { ...base, headline: 'These suggested changes were replaced or dropped', sentences: ['They can no longer be looked at or kept.'] };
  if (status === 'active') {
    if (mergedOnBranch(i.repo)) return { ...base, rail: railOf(null), headline: 'Added to your project', sentences: [] };
    const next = merge && merge.button ? 'Next: press “Add to my project”. Nexus asks you to confirm in a separate window first.' : 'Your own files change only after you press “Add to my project”.';
    return { ...base, rail: railOf('add'), headline: 'Kept: saved in Nexus’s copy. Your own files are not changed yet.', sentences: [next] };
  }
  if (status === 'draft') {
    if (i.validations === null) return { ...base, headline: 'Nexus cannot read the checks right now', sentences: ['You can look at these changes once the checks are in. Try again in a moment.'] };
    const failing = blocking.filter((b) => b.word !== 'Not run yet');
    if (failing.length) return { ...base, headline: `Blocked: ${blockedText(blocking)}`, sentences: ['You cannot look at these changes while a required check needs attention. Ask the AI helper to try again.'] };
    return { ...base, headline: blocking.length ? `Being checked: ${blocking.length === 1 ? '1 required check is' : `${blocking.length} required checks are`} not finished yet` : 'Being checked',
      sentences: ['You can look at these changes once the checks are in.'] };
  }
  // candidate: every blocking check is in order by definition; if the checks disagree, say so and offer nothing.
  if (i.validations !== null && blocking.length > 0) {
    return { ...base, headline: `Blocked: ${blockedText(blocking)}`, sentences: ['You cannot decide on these changes while a required check needs attention.'] };
  }
  if (i.review === undefined) return { ...base, headline: 'Checking where this stands…', sentences: [] };
  // "Looks good" only when Nexus shows the whole change (an explicit `true`); asking for changes and saying no never need that.
  const complete = i.version.previewComplete === true;
  // ... and only after the whole patch has been loaded here: the person says it about what they could read.
  const d = i.diffRead;
  const whole = complete && d !== undefined && d.whole === true && d.failed !== true;
  // Once approved, "Looks good" is gone (the decision is made); "Keep these changes", when it can be offered, comes first as the next step.
  const buttons: ChangeSetButton[] = whole && i.review !== 'approve' ? ['approve', 'request_changes', 'reject'] : ['request_changes', 'reject'];
  const sentences: string[] = complete ? [] : [previewIncompleteText(i.version.previewReason)];
  if (complete && !whole) sentences.push(loadWholeText(d));
  let headline: string;
  let rail: RailStep[] | null = null;
  switch (i.review) {
    case 'approve': headline = 'Looks good: done. Next: Keep these changes'; rail = railOf('keep'); break;
    case 'request_changes': headline = 'You asked the AI helper for different changes'; break;
    case 'reject': headline = 'You said no to these changes'; break;
    default: headline = 'Waiting for you: read what changed, then decide'; rail = railOf('looks_good');
  }
  if (i.review === 'approve') {
    if (i.repo && i.repo.acceptedHead) buttons.unshift('accept');
    else if (i.repo && i.repo.reason && ['git_missing', 'branch_unknown', 'runner_unavailable'].includes(i.repo.reason)) sentences.push(AGENT_REASON_TEXT[i.repo.reason]);
    else sentences.push('Nexus has not read its saved copy yet, so “Keep these changes” is not ready. Look again in a moment.');
  } else {
    if (complete) sentences.push('“Keep these changes” appears after you say “Looks good”.');
  }
  return { ...base, headline, rail, buttons, sentences };
}

// ---------- adding kept work to the project ----------

export interface MergeModel {
  /** "2 kept changes are not in your project yet." */
  line: string;
  /** The button, only when the project can simply move to Nexus's saved copy now. */
  button: { label: string; args: { branch: string; expectedAcceptedHead: string } } | null;
  /** Why not, in one sentence, when there is no button. */
  sentence: string | null;
}

/** "Add to my project" is shown only while kept work is not in the project's main version. A dirty tree (tracked files only) makes it a sentence. */
export function mergeModel(repo: RepoStatusView | null): MergeModel | null {
  if (!repo || repo.acceptedNotMerged <= 0) return null;
  const n = repo.acceptedNotMerged;
  const line = n === 1 ? '1 kept change is not in your project yet.' : `${n} kept changes are not in your project yet.`;
  if (repo.dirty === true) return { line, button: null, sentence: AGENT_REASON_TEXT.tree_dirty };
  if (repo.canFastForward && repo.branch && repo.acceptedHead) {
    return { line, button: { label: GLOSSARY.addToProject.name, args: { branch: repo.branch, expectedAcceptedHead: repo.acceptedHead } }, sentence: null };
  }
  const why = repo.reason && Object.prototype.hasOwnProperty.call(AGENT_REASON_TEXT, repo.reason) ? AGENT_REASON_TEXT[repo.reason] : 'The changes cannot be added to your project right now. Try again in a moment.';
  return { line, button: null, sentence: why };
}

export function acceptedText(): string {
  return 'Kept. The changes are saved in Nexus’s copy. Your own files change only when you press “Add to my project”.';
}

/** The result of adding to the project in words: no saved-version id in the text (it is in `mergedTitle`, for a hover). */
export function mergedText(m: Pick<MergeView, 'branch'>): string {
  return `Added to your project. Your project’s main version (“${m.branch}”) now has the kept changes.`;
}
/** The two saved versions the main version moved between, for a title attribute only. */
export function mergedTitle(m: Pick<MergeView, 'before' | 'after'>): string | undefined {
  const b = short(m.before); const a = short(m.after);
  return b && a ? `Moved from saved version [${b}] to the newest saved version [${a}]` : undefined;
}
/** The newest saved version these changes end at, as one plain line with its short id in brackets. */
export function headLine(head: string | null): string | null {
  return head ? `Newest saved version of these changes: [${head}]` : null;
}
/** What a saved version is, for a hover on that line. */
export function headTitle(head: string | null): string | undefined {
  return head ? GLOSSARY.savedVersion.help : undefined;
}

// ---------- the list of suggested changes ----------

export interface ChangeSetRow { artifactId: string; name: string; versionId: string; versionNo: number; status: VersionView['status']; word: string; reviewable: boolean }

const ROW_WORD: Record<VersionView['status'], string> = {
  draft: 'Being checked', candidate: 'Ready for review', active: 'Kept', failed: 'Blocked', deprecated: 'Replaced or dropped'
};

/** The project's suggested changes, newest first: the latest version of each active change-set artifact. */
export function changeSetRows(summaries: readonly ArtifactSummaryView[], repo?: Pick<RepoStatusView, 'acceptedNotMerged' | 'acceptedHead'> | null): ChangeSetRow[] {
  return summaries.filter((s) => s.artifact.kind === 'change_set' && s.artifact.status === 'active' && s.latest)
    .sort((x, y) => y.artifact.createdAt - x.artifact.createdAt)
    .map((s) => ({ artifactId: s.artifact.id, name: s.artifact.name, versionId: s.latest!.id, versionNo: s.latest!.versionNo, status: s.latest!.status,
      word: s.latest!.status === 'active' && mergedOnBranch(repo) ? 'Added to your project' : ROW_WORD[s.latest!.status] ?? s.latest!.status, reviewable: s.latest!.status === 'candidate' }));
}

// ---------- what changed (read only) ----------

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

/**
 * A plain count above what changed: how many files, and how many lines were added and removed, from the same line kinds the reader
 * shows. `whole` false says it is only what is loaded so far. A patch with no file lines reads as no edits.
 */
export function diffSummary(text: string, whole = true): string {
  let files = 0; let added = 0; let removed = 0;
  for (const l of classifyDiff(text)) {
    if (l.kind === 'meta' && l.text.startsWith('diff --git ')) files++;
    else if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  if (files === 0 && added === 0 && removed === 0) return 'There are no edits to show.';
  const n = (x: number, one: string, many: string): string => `${x} ${x === 1 ? one : many}`;
  const parts = `${n(files, 'file', 'files')}, ${n(added, 'line', 'lines')} added, ${n(removed, 'line', 'lines')} removed`;
  return whole ? `In all: ${parts}.` : `So far: ${parts}.`;
}

// ---------- the plain review page: what the AI helper did, the proof, one instruction ----------

/** "Changed 2 files: added 1, edited 1" from the patch text; null when the patch names no file. */
export function changeCounts(diffText: string | null | undefined): string | null {
  if (typeof diffText !== 'string') return null;
  let files = 0; let added = 0; let removed = 0;
  const blocks = diffText.split(/^diff --git /m).slice(1);
  for (const b of blocks) {
    files++;
    const head = b.split(/^@@/m)[0];
    if (/^new file mode/m.test(head)) added++; else if (/^deleted file mode/m.test(head)) removed++;
  }
  if (files === 0) return null;
  const edited = files - added - removed;
  const parts = [added ? `added ${added}` : null, edited ? `edited ${edited}` : null, removed ? `removed ${removed}` : null].filter(Boolean);
  return `Changed ${files} ${files === 1 ? 'file' : 'files'}: ${parts.join(', ')}`;
}

/** The proof, one plain line per check with a mark (ok / not ok / not run yet): no evidence rows, no ids, no hashes, no "by Nexus". */
export interface ProofLine { id: string; ok: boolean; pending?: boolean; text: string }
export function proofLines(validations: readonly ValidationResultView[] | null | undefined, fileCount: number | null = null): ProofLine[] {
  const out: ProofLine[] = [];
  if (!validations) return out;
  const by = new Map(validations.filter((r) => r.blocking).map((r) => [r.validatorId, r]));
  for (const d of blockingValidatorsFor('change_set')) {
    const r = by.get(d.id);
    if (!r || r.status === null || r.status === undefined) { out.push({ id: d.id, ok: false, pending: true, text: `${validatorLabel(d.id)}: not run yet` }); continue; }
    const ok = r.status === 'passed';
    if (d.id === 'cs.tests_pass') {
      const counts = r.evidence.find((e) => e.type === 'junit');
      const m = counts && typeof counts.value === 'string' ? new RegExp('([0-9]+)/([0-9]+) passed').exec(counts.value) : null;
      out.push({ id: d.id, ok, text: ok ? (m ? `Your tests passed: ${m[1]} of ${m[2]}` : 'Your tests passed') : validatorLine(d.id, r.status) });
    } else if (d.id === 'git.diff_nonempty') {
      out.push({ id: d.id, ok, text: ok ? `The AI helper really changed files${fileCount ? `: ${fileCount} ${fileCount === 1 ? 'file' : 'files'}` : ''}` : validatorLine(d.id, r.status) });
    } else if (d.id === 'git.paths_in_scope') {
      out.push({ id: d.id, ok, text: ok ? 'Only files that belong to the project were touched' : validatorLine(d.id, r.status) });
    } else out.push({ id: d.id, ok, text: validatorLine(d.id, r.status) });
  }
  return out;
}

/** The ONE instruction under the step rail: what to do now. */
export function railLine(rail: readonly RailStep[] | null): string | null {
  if (!rail) return null;
  const cur = rail.find((x) => x.state === 'current');
  if (!cur) return 'These changes are in your project.';
  return cur.id === 'looks_good' ? 'Read what changed below, then press “Looks good”.'
    : cur.id === 'keep' ? 'Press “Keep these changes” to save them in Nexus’s copy.' : 'Press “Add to my project” to put them in your files.';
}
