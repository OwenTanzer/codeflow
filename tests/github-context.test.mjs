// Unit tests for src/graph-ir/githubContext.js (MOO-68 Commit 2).
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  normalizeContext,
  sameRevision,
  assertContextPropagation,
  contextIdentityKey,
  AnalysisContextError,
} = await import('../src/graph-ir/githubContext.js');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('repository-mode fixture normalizes correctly', () => {
  const ctx = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA_A });
  assert.equal(ctx.mode, 'commit');
  assert.equal(ctx.ref, null);
  assert.equal(ctx.resolvedSha, SHA_A);
  assert.equal(ctx.sourceOwner, 'octocat');
  assert.equal(ctx.sourceRepo, 'Hello-World');
});

test('branch-mode fixture normalizes correctly', () => {
  const ctx = normalizeContext({ owner: 'octocat', repo: 'Hello-World', ref: 'main', resolvedSha: SHA_A });
  assert.equal(ctx.mode, 'branch');
  assert.equal(ctx.ref, 'main');
});

test('commit-mode fixture normalizes correctly', () => {
  const ctx = normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'commit', resolvedSha: SHA_A });
  assert.equal(ctx.mode, 'commit');
  assert.equal(ctx.ref, null);
  assert.equal(ctx.prNumber, null);
});

test('PR-mode fixture normalizes correctly, including base/head', () => {
  const ctx = normalizeContext({
    owner: 'octocat',
    repo: 'Hello-World',
    prNumber: 42,
    resolvedSha: SHA_A,
    baseSha: SHA_B,
    headSha: SHA_A,
  });
  assert.equal(ctx.mode, 'pr');
  assert.equal(ctx.prNumber, 42);
  assert.equal(ctx.baseSha, SHA_B);
  assert.equal(ctx.headSha, SHA_A);
  assert.equal(ctx.sourceOwner, 'octocat', 'same-repository PR: source defaults to the base repository');
  assert.equal(ctx.sourceRepo, 'Hello-World');
});

test('a forked PR carries a distinct resolved source repository (the fork), separate from the requested base repository', () => {
  const ctx = normalizeContext({
    owner: 'octocat',
    repo: 'Hello-World',
    prNumber: 10590,
    resolvedSha: SHA_A,
    sourceOwner: 'angelg84',
    sourceRepo: 'Hello-World',
  });
  assert.equal(ctx.owner, 'octocat', 'base repository is preserved for provenance/allowlist checks');
  assert.equal(ctx.repo, 'Hello-World');
  assert.equal(ctx.sourceOwner, 'angelg84', 'source repository is the fork the SHA actually resolved in');
  assert.equal(ctx.sourceRepo, 'Hello-World');
});

test('sourceOwner/sourceRepo may only be set in pr mode', () => {
  assert.throws(
    () => normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'commit', resolvedSha: SHA_A, sourceOwner: 'someone-else' }),
    AnalysisContextError
  );
});

test('rejects a non-SHA resolvedSha (this module never resolves refs itself)', () => {
  assert.throws(() => normalizeContext({ owner: 'octocat', repo: 'Hello-World', ref: 'main', resolvedSha: 'main' }), AnalysisContextError);
});

test('rejects mixed/contradictory revision fields: prNumber outside pr mode', () => {
  assert.throws(
    () => normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'branch', ref: 'main', resolvedSha: SHA_A, prNumber: 1 }),
    AnalysisContextError
  );
});

test('rejects mixed/contradictory revision fields: ref outside branch mode', () => {
  assert.throws(
    () => normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'commit', ref: 'main', resolvedSha: SHA_A }),
    AnalysisContextError
  );
});

test('rejects baseSha/headSha outside pr mode', () => {
  assert.throws(
    () => normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'commit', resolvedSha: SHA_A, baseSha: SHA_B }),
    AnalysisContextError
  );
});

test('rejects pr mode missing prNumber', () => {
  assert.throws(() => normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'pr', resolvedSha: SHA_A }), AnalysisContextError);
});

test('sameRevision is case-insensitive on owner/repo, exact on resolvedSha', () => {
  const a = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA_A });
  const b = normalizeContext({ owner: 'OctoCat', repo: 'hello-world', resolvedSha: SHA_A });
  const c = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA_B });
  assert.equal(sameRevision(a, b), true);
  assert.equal(sameRevision(a, c), false);
});

test('a file/function request cannot silently use a different revision from its parent graph', () => {
  const parent = normalizeContext({ owner: 'octocat', repo: 'Hello-World', ref: 'main', resolvedSha: SHA_A });
  const sameRevChild = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA_A });
  const driftedChild = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA_B });
  assert.doesNotThrow(() => assertContextPropagation(parent, sameRevChild));
  assert.throws(() => assertContextPropagation(parent, driftedChild), AnalysisContextError);
});

test('assertContextPropagation rejects a mismatched repository even with the same SHA', () => {
  const parent = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA_A });
  const other = normalizeContext({ owner: 'octocat', repo: 'Spoon-Knife', resolvedSha: SHA_A });
  assert.throws(() => assertContextPropagation(parent, other), AnalysisContextError);
});

test('contextIdentityKey is stable for equivalent normalized contexts and distinct across revisions/PRs', () => {
  const a1 = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA_A });
  const a2 = normalizeContext({ owner: 'OctoCat', repo: 'Hello-World', mode: 'commit', resolvedSha: SHA_A.toUpperCase() });
  const b = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA_B });
  const pr = normalizeContext({ owner: 'octocat', repo: 'Hello-World', prNumber: 7, resolvedSha: SHA_A });
  assert.equal(contextIdentityKey(a1), contextIdentityKey(a2));
  assert.notEqual(contextIdentityKey(a1), contextIdentityKey(b));
  assert.notEqual(contextIdentityKey(a1), contextIdentityKey(pr));
});

test('contextIdentityKey keys off the resolved source repository, not the requested base repository, for a forked PR', () => {
  const forkedPr = normalizeContext({
    owner: 'octocat',
    repo: 'Hello-World',
    prNumber: 10590,
    resolvedSha: SHA_A,
    sourceOwner: 'angelg84',
    sourceRepo: 'Hello-World',
  });
  const sameRepoPr = normalizeContext({ owner: 'octocat', repo: 'Hello-World', prNumber: 10590, resolvedSha: SHA_A });
  assert.match(contextIdentityKey(forkedPr), /^angelg84\//);
  assert.notEqual(contextIdentityKey(forkedPr), contextIdentityKey(sameRepoPr));
});

test('sameRevision compares the resolved source repository, so two different-fork resolutions of the same base repo/SHA are not the same revision', () => {
  const forkA = normalizeContext({ owner: 'octocat', repo: 'Hello-World', prNumber: 1, resolvedSha: SHA_A, sourceOwner: 'contributor-a', sourceRepo: 'Hello-World' });
  const forkB = normalizeContext({ owner: 'octocat', repo: 'Hello-World', prNumber: 2, resolvedSha: SHA_A, sourceOwner: 'contributor-b', sourceRepo: 'Hello-World' });
  assert.equal(sameRevision(forkA, forkB), false);
});

test('assertContextPropagation rejects a child resolving to a different fork even when the base repository and SHA match', () => {
  const parent = normalizeContext({ owner: 'octocat', repo: 'Hello-World', prNumber: 1, resolvedSha: SHA_A, sourceOwner: 'contributor-a', sourceRepo: 'Hello-World' });
  const child = normalizeContext({ owner: 'octocat', repo: 'Hello-World', prNumber: 1, resolvedSha: SHA_A, sourceOwner: 'contributor-b', sourceRepo: 'Hello-World' });
  assert.throws(() => assertContextPropagation(parent, child), AnalysisContextError);
});

test('assertContextPropagation allows a child that resolves to the same fork as its parent', () => {
  const parent = normalizeContext({ owner: 'octocat', repo: 'Hello-World', prNumber: 1, resolvedSha: SHA_A, sourceOwner: 'contributor-a', sourceRepo: 'Hello-World' });
  const child = normalizeContext({ owner: 'octocat', repo: 'Hello-World', prNumber: 1, resolvedSha: SHA_A, sourceOwner: 'contributor-a', sourceRepo: 'Hello-World' });
  assert.doesNotThrow(() => assertContextPropagation(parent, child));
});
