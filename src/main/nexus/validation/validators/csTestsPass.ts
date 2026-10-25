/**
 * `cs.tests_pass` v1 (change_set, candidate, blocking; run by the child jobs `sde.test.discover` then `sde.test.node`
 * / `sde.test.pytest`, exactly as `sde.tests_pass` runs for a stand-alone test suite). The checkRunner enqueues
 * discovery at the change set's head commit (ValidationService.enqueueCandidate), which derives a `test_suite` draft
 * version exactly as a user-requested discovery would; once that suite's own `sde.tests_pass` candidate check
 * records a result, ingest mirrors it onto the change set's `cs.tests_pass` row (ingest.ts `testRun`), through
 * `mirrorEvidence` below: the evidence holds the suite version's content hash, the JUnit hash and the counts — never
 * the suite's exit code or image/lockfile hashes (this validator's evidence is `['junit','hash','number']` only).
 */
import type { Evidence } from '../../../../shared/nexus/evidence';
import type { ValidatorOutcome } from '../normalized';

export const ID = 'cs.tests_pass';
export const VERSION = '1';

const KEPT: readonly Evidence['type'][] = ['junit', 'hash', 'number'];

/** The suite's own `sde.tests_pass` outcome, re-shaped for the change set: kept evidence plus the suite's hash. */
export function mirrorEvidence(outcome: ValidatorOutcome, suite: { contentHash: string }): ValidatorOutcome {
  const kept = outcome.evidence.filter((e): e is Evidence => KEPT.includes(e.type));
  const evidence: Evidence[] = [...kept, { type: 'hash', label: 'suite', sha256: suite.contentHash }];
  return { ...outcome, evidence };
}
