/**
 * `sec.secret_scan` v1 (change_set, register, blocking). Pure. Fails on any `secretHits` the collect reported (a
 * provider-key shape or a private-key header on an added line, `diffLineSecret`, computed in the runner over the
 * diff). The evidence holds the path and line only (`location` evidence): the secret text itself never leaves the
 * runner process and never reaches a validation row, activity row, job event or log (D-B14).
 */
import { COMMIT_RE, errored, failed, passed, type ValidatorOutcome } from '../normalized';

export const ID = 'sec.secret_scan';
export const VERSION = '1';
/** The most hits named as `location` evidence (the count is still exact; the rest are just not listed). */
export const MAX_LISTED = 100;

export interface SecretHit { path: string; line: number; rule: 'provider_key' | 'private_key' }
/** `scanTruncated`: the runner's patch was cut at its cap, so not every added line was scanned (never a pass). */
export interface SecretScanFacts { head: string; secretHits: SecretHit[]; scanTruncated: boolean }

const isHit = (x: unknown): x is SecretHit => !!x && typeof x === 'object'
  && typeof (x as SecretHit).path === 'string' && Number.isSafeInteger((x as SecretHit).line) && (x as SecretHit).line >= 1
  && ((x as SecretHit).rule === 'provider_key' || (x as SecretHit).rule === 'private_key');

export function run(f: SecretScanFacts): ValidatorOutcome {
  if (!f || typeof f.head !== 'string' || !COMMIT_RE.test(f.head) || !Array.isArray(f.secretHits) || !f.secretHits.every(isHit)) {
    return errored('parser_contract', 'Checks could not run: the secret scan facts were not usable.');
  }
  if (f.scanTruncated !== false) {
    // A secret past the cut could not be seen (and an absent flag says nothing was checked): the scan fails (the agent
    // revises a smaller change), it never passes. Large binary files fill the scan's cap too, so a change holding one
    // fails here; keep large binaries out of a change set.
    return failed('scan_truncated', 'The change is too large to scan for secrets in full (large or binary files count against the scan); split it into smaller changes.',
      f.secretHits.slice(0, MAX_LISTED).map((h) => ({ type: 'location' as const, path: h.path, line: h.line, rule: h.rule })));
  }
  const evidence = f.secretHits.slice(0, MAX_LISTED).map((h) => ({ type: 'location' as const, path: h.path, line: h.line, rule: h.rule }));
  if (f.secretHits.length > 0) {
    return failed('secret_shaped_line', `${f.secretHits.length} added line(s) hold a provider key or a private-key header.`, evidence);
  }
  return passed('No added line holds a provider key or a private-key header.', evidence);
}
