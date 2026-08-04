// Unit tests for allowlist.js, rate-limit.js, and validate-repo-request.js
// (MOO-67 Commit 6). auth.js's own tests lived here too until the auth gate
// was removed entirely; this file was renamed from server-auth.test.mjs
// accordingly.
import assert from 'node:assert/strict';
import test from 'node:test';

import { isRepoAllowed } from '../server/lib/allowlist.js';
import { RateLimiter } from '../server/lib/rate-limit.js';
import { validateRepoRequest, ValidationError } from '../server/lib/validate-repo-request.js';

test('isRepoAllowed matches an explicit owner/repo entry', () => {
  const config = { allowedRepos: ['octocat/hello-world'], allowedOwners: [] };
  assert.equal(isRepoAllowed('octocat', 'Hello-World', config), true);
  assert.equal(isRepoAllowed('octocat', 'other-repo', config), false);
});

test('isRepoAllowed matches any repo under an allowed owner', () => {
  const config = { allowedRepos: [], allowedOwners: ['octocat'] };
  assert.equal(isRepoAllowed('octocat', 'anything', config), true);
  assert.equal(isRepoAllowed('someone-else', 'anything', config), false);
});

test('isRepoAllowed allows any owner/repo when ALLOWED_OWNERS contains the "*" wildcard', () => {
  const config = { allowedRepos: [], allowedOwners: ['*'] };
  assert.equal(isRepoAllowed('octocat', 'Hello-World', config), true);
  assert.equal(isRepoAllowed('torvalds', 'linux', config), true);
  assert.equal(isRepoAllowed('anyone-at-all', 'any-repo', config), true);
});

test('isRepoAllowed treats the wildcard as just one more owner entry, not exclusive', () => {
  const config = { allowedRepos: [], allowedOwners: ['octocat', '*'] };
  assert.equal(isRepoAllowed('someone-else', 'anything', config), true);
});

test('RateLimiter allows up to the configured limit within a window, then rejects', () => {
  const limiter = new RateLimiter(3);
  assert.equal(limiter.check('client-a').allowed, true);
  assert.equal(limiter.check('client-a').allowed, true);
  assert.equal(limiter.check('client-a').allowed, true);
  assert.equal(limiter.check('client-a').allowed, false);
});

test('RateLimiter tracks separate keys independently', () => {
  const limiter = new RateLimiter(1);
  assert.equal(limiter.check('client-a').allowed, true);
  assert.equal(limiter.check('client-b').allowed, true);
  assert.equal(limiter.check('client-a').allowed, false);
  assert.equal(limiter.check('client-b').allowed, false);
});

// MOO-72 Commit 4 PR review: the server's own rate-limit 429 previously
// carried no Retry-After header at all, so the client's retryAfterMs-based
// Retry gating never actually engaged for this, the one real
// application-generated 429.
test('RateLimiter.check() exposes retryAfterMs only when rejecting, bounded by the fixed window', () => {
  const limiter = new RateLimiter(1);
  const first = limiter.check('client-a');
  assert.equal(first.allowed, true);
  assert.equal(first.retryAfterMs, null);
  const second = limiter.check('client-a');
  assert.equal(second.allowed, false);
  assert.ok(typeof second.retryAfterMs === 'number' && second.retryAfterMs > 0 && second.retryAfterMs <= 60_000, `expected a retryAfterMs within the 60s window, got ${second.retryAfterMs}`);
});

test('validateRepoRequest accepts a well-formed owner/repo with no ref/pr', () => {
  const result = validateRepoRequest({ owner: 'octocat', repo: 'Hello-World' });
  assert.deepEqual(result, { owner: 'octocat', repo: 'Hello-World', ref: null, pr: null, excludePatterns: [], sessionId: null });
});

test('validateRepoRequest accepts a well-formed ref (branch or commit SHA)', () => {
  assert.equal(validateRepoRequest({ owner: 'octocat', repo: 'Hello-World', ref: 'main' }).ref, 'main');
  assert.equal(
    validateRepoRequest({ owner: 'octocat', repo: 'Hello-World', ref: 'feature/x' }).ref,
    'feature/x'
  );
  assert.equal(
    validateRepoRequest({ owner: 'octocat', repo: 'Hello-World', ref: 'a1b2c3d4' }).ref,
    'a1b2c3d4'
  );
});

test('validateRepoRequest accepts a well-formed positive integer pr', () => {
  assert.equal(validateRepoRequest({ owner: 'octocat', repo: 'Hello-World', pr: 42 }).pr, 42);
});

test('validateRepoRequest rejects a malformed owner', () => {
  assert.throws(() => validateRepoRequest({ owner: '-bad', repo: 'x' }), ValidationError);
  assert.throws(() => validateRepoRequest({ owner: 'has space', repo: 'x' }), ValidationError);
  assert.throws(() => validateRepoRequest({ owner: '', repo: 'x' }), ValidationError);
});

test('validateRepoRequest rejects a malformed repo', () => {
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: '..' }), ValidationError);
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'has space' }), ValidationError);
});

test('validateRepoRequest rejects a ref containing ".." or a leading slash/dash', () => {
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'x', ref: '../escape' }), ValidationError);
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'x', ref: '/abs' }), ValidationError);
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'x', ref: '-flag' }), ValidationError);
});

test('validateRepoRequest rejects a non-positive or non-integer pr', () => {
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'x', pr: 0 }), ValidationError);
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'x', pr: -1 }), ValidationError);
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'x', pr: 1.5 }), ValidationError);
});

test('validateRepoRequest rejects specifying both ref and pr', () => {
  assert.throws(
    () => validateRepoRequest({ owner: 'octocat', repo: 'x', ref: 'main', pr: 1 }),
    ValidationError
  );
});

test('validateRepoRequest rejects a missing/non-object body', () => {
  assert.throws(() => validateRepoRequest(null), ValidationError);
  assert.throws(() => validateRepoRequest(undefined), ValidationError);
  assert.throws(() => validateRepoRequest('not an object'), ValidationError);
});

// MOO-72 Commit 1A: exclude patterns are part of the request now (what the
// user asked to analyze), so they're validated the same way owner/repo/ref
// already are -- untrusted text that gets compiled into regexes and
// hashed into the cache key downstream.
test('validateRepoRequest defaults excludePatterns to an empty array when omitted', () => {
  assert.deepEqual(validateRepoRequest({ owner: 'octocat', repo: 'x' }).excludePatterns, []);
});

test('validateRepoRequest accepts a well-formed excludePatterns array', () => {
  const result = validateRepoRequest({ owner: 'octocat', repo: 'x', excludePatterns: ['node_modules', '*.test.js'] });
  assert.deepEqual(result.excludePatterns, ['node_modules', '*.test.js']);
});

test('validateRepoRequest rejects a non-array excludePatterns', () => {
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'x', excludePatterns: 'node_modules' }), ValidationError);
});

test('validateRepoRequest rejects excludePatterns containing a non-string entry', () => {
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'x', excludePatterns: ['ok', 42] }), ValidationError);
});

test('validateRepoRequest rejects more than 50 excludePatterns entries', () => {
  const many = Array.from({ length: 51 }, (_, i) => `pattern-${i}`);
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'x', excludePatterns: many }), ValidationError);
});

test('validateRepoRequest rejects a single excludePatterns entry over 200 characters', () => {
  const tooLong = 'a'.repeat(201);
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'x', excludePatterns: [tooLong] }), ValidationError);
});

test('validateRepoRequest rejects excludePatterns whose combined length exceeds 4000 characters', () => {
  // 50 entries of 100 chars each = 5000, under the per-entry cap but over
  // the aggregate cap -- proves the two limits are checked independently.
  const many = Array.from({ length: 50 }, () => 'a'.repeat(100));
  assert.throws(() => validateRepoRequest({ owner: 'octocat', repo: 'x', excludePatterns: many }), ValidationError);
});

// MOO-72 Commit 1B: sessionId is optional and diagnostic-only -- it is
// never a reason to reject the whole request, only ever normalized to
// null when absent or malformed.
test('validateRepoRequest accepts and echoes a UUID-shaped sessionId', () => {
  const id = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
  const result = validateRepoRequest({ owner: 'octocat', repo: 'Hello-World', sessionId: id });
  assert.equal(result.sessionId, id);
});

test('validateRepoRequest normalizes a malformed sessionId to null rather than rejecting the request', () => {
  const result = validateRepoRequest({ owner: 'octocat', repo: 'Hello-World', sessionId: 'not-a-uuid' });
  assert.equal(result.sessionId, null);
});

test('validateRepoRequest defaults sessionId to null when omitted', () => {
  const result = validateRepoRequest({ owner: 'octocat', repo: 'Hello-World' });
  assert.equal(result.sessionId, null);
});
