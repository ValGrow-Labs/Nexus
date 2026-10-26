'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { redactDetails, REDACTED } = loadTs('src/main/nexus/activity/redact.ts');
const { verifyChainRows, activityHash } = loadTs('src/main/nexus/activity/chain.ts');

test('secret-named keys are redacted at any depth', () => {
  const out = redactDetails({ apiKey: 'abc', nested: { password: 'p', Authorization: 'Bearer z' }, list: [{ token: 't' }], session_key: 'k' });
  assert.equal(out.apiKey, REDACTED); assert.equal(out.nested.password, REDACTED);
  assert.equal(out.nested.Authorization, REDACTED); assert.equal(out.list[0].token, REDACTED); assert.equal(out.session_key, REDACTED);
});
test('secret-shaped values inside ordinary keys are redacted', () => {
  const out = JSON.stringify(redactDetails({ note: 'failed with sk-ant-abcdefghijklmnopqrstuv', url: 'https://u:pw123456@h.example/x' }));
  assert.doesNotMatch(out, /sk-ant-abc|pw123456/); assert.match(out, /redacted/);
});
test('contents are never stored: long strings and binaries become markers', () => {
  const out = redactDetails({ content: 'a'.repeat(5000), file: Buffer.from('xyz') });
  assert.equal(out.content, '[omitted: 5000 chars]'); assert.equal(out.file, '[binary: 3 bytes]');
});
test('limits and odd values', () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  assert.equal(redactDetails(deep).a.b.c.d, '[truncated]');
  assert.equal(redactDetails({ xs: Array.from({ length: 80 }, (_, i) => i) }).xs.length, 51);
  const out = redactDetails({ d: new Date(0), n: NaN, f() {}, s: Symbol('x') });
  assert.deepEqual(out, { d: '1970-01-01T00:00:00.000Z', n: null });
  assert.deepEqual(redactDetails(null), {}); assert.deepEqual(redactDetails(undefined), {});
  assert.deepEqual(redactDetails('plain'), { value: 'plain' });
});
test('ordinary details pass unchanged', () => {
  const d = { from: 6, to: 7, backupFile: 'harness-v6-20261006T120000Z.db', counts: { projects: 0 } };
  assert.deepEqual(redactDetails(d), d);
});
test('chain verification finds the first tampered row', () => {
  const rows = []; let prev = '0'.repeat(64);
  for (let i = 1; i <= 3; i++) {
    const r = { seq: i, id: `a${i}`, ts: i, actorKind: 'system', actorId: 'system', onBehalfOf: null, jobId: null, workspaceId: null,
      projectId: 'p', artifactId: null, versionId: null, entityType: 'x', entityId: null, action: 'x.y', status: 'succeeded', details: {} };
    const hash = activityHash(prev, { ...r, detailsJson: '{}' }); rows.push({ ...r, prevHash: prev, hash }); prev = hash;
  }
  assert.deepEqual(verifyChainRows(rows), { ok: true, rows: 3 });
  rows[1] = { ...rows[1], action: 'x.z' };
  assert.deepEqual(verifyChainRows(rows), { ok: false, brokenAtSeq: 2 });
});

// ---- additions beyond the brief's pinned cases ----
const HEX64 = 'ab'.repeat(32);
test('known integrity hash fields keep their hex value (controller ruling)', () => {
  const d = { backupSha256: HEX64, sha256: HEX64, contentHash: HEX64, content_hash: HEX64, nested: { storage: { sha256: HEX64 } } };
  assert.deepEqual(redactDetails(d), d);
});
test('the same hex under any other key is still redacted', () => {
  const out = redactDetails({ hookSecretHex: HEX64, note: `hook ${HEX64}`, hash: HEX64 });
  assert.equal(out.hookSecretHex, REDACTED);
  assert.doesNotMatch(JSON.stringify(out), new RegExp(HEX64));
});
test('an exempt hash key does not exempt a non-hex or secret-shaped value', () => {
  const out = redactDetails({ sha256: 'token=sk-ant-abcdefghijklmnopqrstuv', contentHash: 'x'.repeat(600) });
  assert.doesNotMatch(JSON.stringify(out), /sk-ant-abc/);
  assert.equal(out.contentHash, '[omitted: 600 chars]');
});
test('more secret key shapes and secret-shaped keys', () => {
  const out = redactDetails({ client_secret: 's', refreshToken: 'r', cookie: 'c', credentials: { u: 1 }, private_key: 'pk',
    'api-key': 'x', passwd: 'y', [`sk-ant-${'q'.repeat(20)}`]: 1 });
  for (const k of ['client_secret', 'refreshToken', 'cookie', 'credentials', 'private_key', 'api-key', 'passwd']) assert.equal(out[k], REDACTED, k);
  assert.doesNotMatch(JSON.stringify(out), /sk-ant-q/);
});
test('key count, cycles, errors, typed arrays and bigints are bounded and serialisable', () => {
  const many = {}; for (let i = 0; i < 80; i++) many[`k${i}`] = i;
  const outMany = redactDetails(many);
  assert.equal(Object.keys(outMany).length, 51); assert.equal(outMany.__truncated, '[truncated]');
  const cyc = { name: 'c' }; cyc.self = cyc;
  const outCyc = redactDetails(cyc);
  assert.doesNotThrow(() => JSON.stringify(outCyc));
  const outErr = redactDetails({ err: new Error('auth failed: token=abc123secret'), u8: new Uint8Array(7), big: 10n, inf: Infinity, nd: new Date(NaN) });
  assert.equal(outErr.err.message.includes('abc123secret'), false);
  assert.equal(outErr.u8, '[binary: 7 bytes]'); assert.equal(outErr.big, '10'); assert.equal(outErr.inf, null); assert.equal(outErr.nd, null);
  assert.deepEqual(redactDetails([1, 'a']), { value: [1, 'a'] });
  assert.deepEqual(redactDetails(5), { value: 5 });
  assert.deepEqual(redactDetails('Bearer abcdefghijkl'), { value: 'Bearer [redacted]' });
});
test('chain verification catches a broken link, a bad genesis and a details edit', () => {
  const mk = () => {
    const rows = []; let prev = '0'.repeat(64);
    for (let i = 1; i <= 3; i++) {
      const r = { seq: i, id: `a${i}`, ts: i, actorKind: 'user', actorId: 'u', onBehalfOf: null, sessionId: null, jobId: null, workspaceId: null,
        projectId: 'p', artifactId: null, versionId: null, entityType: 'x', entityId: null, action: 'x.y', status: 'succeeded', details: { n: i } };
      const hash = activityHash(prev, { ...r, detailsJson: JSON.stringify(r.details) }); rows.push({ ...r, prevHash: prev, hash }); prev = hash;
    }
    return rows;
  };
  assert.deepEqual(verifyChainRows(mk()), { ok: true, rows: 3 });
  const removed = mk(); removed.splice(1, 1);
  assert.deepEqual(verifyChainRows(removed), { ok: false, brokenAtSeq: 3 });
  const edited = mk(); edited[2] = { ...edited[2], details: { n: 99 } };
  assert.deepEqual(verifyChainRows(edited), { ok: false, brokenAtSeq: 3 });
  assert.deepEqual(verifyChainRows(mk().slice(1)), { ok: false, brokenAtSeq: 2 });
  assert.deepEqual(verifyChainRows([]), { ok: true, rows: 0 });
});

// ---- fix round 1 ----
const { MAX_DETAILS_BYTES } = loadTs('src/main/nexus/activity/redact.ts');
test('more secret key names are redacted, including keys with spaces', () => {
  const keys = ['pwd', 'dbPwd', 'passphrase', 'auth', 'Auth', 'auth_token', 'authHeader', 'auth-header', 'accessKey', 'aws_access_key_id',
    'signature', 'requestSignature', 'dsn', 'sentryDsn', 'connStr', 'conn_string', 'connectionString', 'connection-str',
    'api key', 'private key', 'session key', 'access key', 'auth token'];
  const input = {}; for (const k of keys) input[k] = 'v';
  const out = redactDetails(input);
  for (const k of keys) assert.equal(out[k], REDACTED, k);
  const keep = redactDetails({ author: 'a', authored: 'b', status: 'c' });
  assert.deepEqual(keep, { author: 'a', authored: 'b', status: 'c' });
});
test('URL user names are redacted even without a password, and sig/signature values', () => {
  const out = JSON.stringify(redactDetails({ a: 'clone https://alice@git.example/r.git', b: 'ssh://deploy@h.example/x',
    c: 'https://h.example/f?sig=AbC123xyz&X-Amz-Signature=deadbeef01&n=1', d: 'signature: "q1w2e3r4"' }));
  assert.doesNotMatch(out, /alice|deploy@|AbC123xyz|deadbeef01|q1w2e3r4/);
  assert.match(out, /https:\/\/\[redacted\]@git\.example/); assert.match(out, /n=1/);
});
test('hash values must look like a digest (40..128 hex, optional git:)', () => {
  const sha1 = 'a'.repeat(40);
  assert.deepEqual(redactDetails({ contentHash: `git:${sha1}`, sha256: sha1 }), { contentHash: `git:${sha1}`, sha256: sha1 });
  const short = redactDetails({ sha256: 'abcdef0123456789abcdef', contentHash: 'GIT:' + 'b'.repeat(130) });
  assert.equal(short.sha256, 'abcdef0123456789abcdef');                         // not a digest: ordinary string path (not secret-shaped)
  assert.doesNotMatch(JSON.stringify(short), /b{130}/);
});
test('a __proto__ key is kept as data and colliding redacted keys never overwrite each other', () => {
  const out = redactDetails(JSON.parse('{"__proto__": {"polluted": 1}, "a": 1}'));
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), JSON.parse('{"__proto__": {"polluted": 1}, "a": 1}'));
  assert.equal({}.polluted, undefined);
  const k1 = `sk-ant-${'a'.repeat(20)}`; const k2 = `sk-ant-${'b'.repeat(20)}`;
  const col = redactDetails({ [k1]: 1, [k2]: 2 });
  assert.deepEqual(Object.values(col).sort(), [1, 2]);
  assert.equal(Object.keys(col).length, 2);
  assert.doesNotMatch(JSON.stringify(col), /sk-ant-/);
});
test('total size is capped and huge nested, wide input stays fast', () => {
  const wide = (d) => { const child = d === 0 ? 'x'.repeat(500) : wide(d - 1); const o = {}; for (let i = 0; i < 60; i++) o[`key_${i}_${'k'.repeat(20)}`] = child; return o; };  // shared subtree: cheap to build, 60^5 paths to walk
  const big = wide(5);
  const t0 = Date.now();
  const out = redactDetails(big);
  const ms = Date.now() - t0;
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  assert.ok(bytes <= MAX_DETAILS_BYTES, `bytes ${bytes}`);
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.match(JSON.stringify(out), /\[truncated\]/);
  const arr = redactDetails({ xs: Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => 'y'.repeat(500))) });
  assert.ok(Buffer.byteLength(JSON.stringify(arr), 'utf8') <= MAX_DETAILS_BYTES);
  const multibyte = redactDetails({ xs: Array.from({ length: 50 }, () => '\u{1F600}'.repeat(200)) });
  assert.ok(Buffer.byteLength(JSON.stringify(multibyte), 'utf8') <= MAX_DETAILS_BYTES);
  assert.equal(MAX_DETAILS_BYTES, 16384);
});
test('attempt_n is part of the hash chain', () => {
  const rows = []; let prev = '0'.repeat(64);
  for (let i = 1; i <= 2; i++) {
    const r = { seq: i, id: `a${i}`, ts: i, actorKind: 'system', actorId: 'system', onBehalfOf: null, sessionId: null, jobId: 'j', attemptN: i,
      workspaceId: null, projectId: 'p', artifactId: null, versionId: null, entityType: 'job', entityId: 'j', action: 'job.transition', status: 'succeeded', details: {} };
    const hash = activityHash(prev, { ...r, detailsJson: '{}' }); rows.push({ ...r, prevHash: prev, hash }); prev = hash;
  }
  assert.deepEqual(verifyChainRows(rows), { ok: true, rows: 2 });
  rows[0] = { ...rows[0], attemptN: 7 };
  assert.deepEqual(verifyChainRows(rows), { ok: false, brokenAtSeq: 1 });
});

test('token usage counts survive as numbers; token-named strings stay redacted', () => {
  const out = redactDetails({ tokensUsed: 1234, inputTokens: 900, outputTokens: 334, maxTokens: 200000, tokenCount: 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.equal(out.tokensUsed, 1234);
  assert.equal(out.inputTokens, 900);
  assert.equal(out.outputTokens, 334);
  assert.equal(out.maxTokens, 200000);
  assert.equal(out.tokenCount, REDACTED);
  assert.equal(redactDetails({ token: 5 }).token, REDACTED);
});
test('T10 fix 1: redactText and containsSecret ignore every size cap; redactDetails keeps its caps', () => {
  const { redactText, containsSecret, redactDetails: rd } = loadTs('src/main/nexus/activity/redact.ts');
  const long = `${'a '.repeat(600)}sk-ant-abcdefghijklmnopqrstuv`;
  assert.match(redactText(long), /^a a .*\[redacted\]$/);
  assert.equal(redactText('plain text'), 'plain text');
  assert.match(String(rd({ m: long }).m), /^\[omitted: \d+ chars\]$/);
  const deep = { a: { b: { c: { d: { e: { f: 'Bearer abcdefghijklmnopqrstuvwxyz0123' } } } } } };
  assert.equal(containsSecret(deep), true);
  assert.equal(containsSecret({ list: Array.from({ length: 200 }, (_, i) => (i === 199 ? 'https://u:p@h.example/x' : 'ok')) }), true);
  assert.equal(containsSecret({ password: '' }), true);
  assert.equal(containsSecret({ tokensUsed: 5, contentHash: 'a'.repeat(64), path: 'src/a.ts', n: [1, null, true] }), false);
});

test('B2b Task 16: the collect result\'s hit lists are scanned but not withheld for their names (the runner sent every collect as secret_in_report)', () => {
  const { containsSecret } = loadTs('src/main/nexus/activity/redact.ts');
  const facts = { ok: true, changed: true, parent: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40), base: 'a'.repeat(40), ref: 'refs/nexus/job/abc',
    diffstat: { files: 1, insertions: 2, deletions: 0 }, paths: ['src/a.ts'], pathsTruncated: false, scanTruncated: false };
  // The names say `secret`, and every collect result carries them, even empty: they are not secrets, the lines they point at might be.
  assert.equal(containsSecret({ ...facts, secretHits: [], entropyHits: [] }), false);
  assert.equal(containsSecret({ ...facts, secretHits: [{ path: 'src/a.ts', line: 3, rule: 'provider_key' }], entropyHits: [{ path: 'src/b.ts', line: 9, rule: 'high_entropy' }] }), false);
  // What is inside them is still scanned: a secret-shaped value, or a key that names one, still withholds the result.
  assert.equal(containsSecret({ ...facts, secretHits: [{ path: 'AKIAABCDEFGHIJKLMNOP', line: 3, rule: 'provider_key' }] }), true);
  assert.equal(containsSecret({ ...facts, secretHits: [{ path: 'src/a.ts', line: 3, token: 'x' }] }), true);
  // Only a list qualifies: the same name holding a string (a value that could carry anything) is still a secret-named key; and so is any other name.
  assert.equal(containsSecret({ ...facts, secretHits: 'src/a.ts:3' }), true);
  assert.equal(containsSecret({ ...facts, secretStuff: [] }), true);
  assert.equal(containsSecret({ ...facts, nested: { secret: [] } }), true);
});
