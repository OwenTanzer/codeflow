// Unit tests for server/routes/graph-repository.js's pure context-building
// logic (MOO-69 Commit 2). The full HTTP handler needs a real GitHub
// credential to exercise end-to-end (same as /api/analyze-repo) -- see
// tests/server-smoke.mjs's "graph-repository" steps for that coverage; this
// file covers what's unit-testable without network access.
import assert from 'node:assert/strict';
import test from 'node:test';

const { buildRequestContext } = await import('../server/routes/graph-repository.js');

const SHA = 'a'.repeat(40);

test('a whole-repository request (no ref, no pr) normalizes to mode "repository"', () => {
  const request = { owner: 'octocat', repo: 'Hello-World', ref: null, pr: null };
  const resolved = { sourceOwner: 'octocat', sourceRepo: 'Hello-World', resolvedSha: SHA };
  const context = buildRequestContext(request, resolved);
  assert.equal(context.mode, 'repository');
  assert.equal(context.resolvedSha, SHA);
});

test('a branch request normalizes to mode "branch" and preserves the ref', () => {
  const request = { owner: 'octocat', repo: 'Hello-World', ref: 'main', pr: null };
  const resolved = { sourceOwner: 'octocat', sourceRepo: 'Hello-World', resolvedSha: SHA };
  const context = buildRequestContext(request, resolved);
  assert.equal(context.mode, 'branch');
  assert.equal(context.ref, 'main');
});

test('a PR request normalizes to mode "pr" and carries the resolved fork source repository', () => {
  const request = { owner: 'octocat', repo: 'Hello-World', ref: null, pr: 10590 };
  const resolved = { sourceOwner: 'angelg84', sourceRepo: 'Hello-World', resolvedSha: SHA };
  const context = buildRequestContext(request, resolved);
  assert.equal(context.mode, 'pr');
  assert.equal(context.prNumber, 10590);
  assert.equal(context.owner, 'octocat', 'base repository preserved for provenance/allowlist identity');
  assert.equal(context.sourceOwner, 'angelg84', 'source repository is the resolved fork');
});

test('a same-repository PR (no fork) still normalizes cleanly with sourceOwner/sourceRepo equal to the base', () => {
  const request = { owner: 'octocat', repo: 'Hello-World', ref: null, pr: 5 };
  const resolved = { sourceOwner: 'octocat', sourceRepo: 'Hello-World', resolvedSha: SHA };
  const context = buildRequestContext(request, resolved);
  assert.equal(context.sourceOwner, 'octocat');
  assert.equal(context.sourceRepo, 'Hello-World');
});
