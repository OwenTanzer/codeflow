// Unit tests for src/state/graphRepositoryClient.js (MOO-72 Commit 1A).
//
// Covers the pure request-shaping/response-mapping logic without a real
// network round-trip, matching tests/graph-file-client.test.mjs's own scope.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGraphRepositoryRequest, mapGraphRepositoryResponse, GraphRepositoryClientError } from '../src/state/graphRepositoryClient.js';

test('buildGraphRepositoryRequest sends owner/repo/ref/excludePatterns as given', () => {
  const { url, init } = buildGraphRepositoryRequest({
    owner: 'octocat',
    repo: 'Hello-World',
    ref: 'main',
    excludePatterns: ['node_modules', '*.test.js'],
    appPassword: 'secret-token',
  });
  assert.equal(url, '/api/graph/repository');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer secret-token');
  const body = JSON.parse(init.body);
  assert.equal(body.owner, 'octocat');
  assert.equal(body.repo, 'Hello-World');
  assert.equal(body.ref, 'main');
  assert.deepEqual(body.excludePatterns, ['node_modules', '*.test.js']);
  assert.equal(body.pr, undefined);
});

test('buildGraphRepositoryRequest sends `pr` instead of `ref` when a PR number is given', () => {
  const { init } = buildGraphRepositoryRequest({
    owner: 'octocat',
    repo: 'Hello-World',
    pr: 42,
    appPassword: 'secret-token',
  });
  const body = JSON.parse(init.body);
  assert.equal(body.pr, 42);
  assert.equal(body.ref, undefined);
});

test('buildGraphRepositoryRequest omits ref/pr entirely for a whole-repository (default branch) request', () => {
  const { init } = buildGraphRepositoryRequest({
    owner: 'octocat',
    repo: 'Hello-World',
    appPassword: 'secret-token',
  });
  const body = JSON.parse(init.body);
  assert.equal(body.ref, undefined);
  assert.equal(body.pr, undefined);
});

test('buildGraphRepositoryRequest omits excludePatterns entirely when empty or not provided, rather than sending []', () => {
  const { init: init1 } = buildGraphRepositoryRequest({ owner: 'octocat', repo: 'Hello-World', appPassword: 't' });
  assert.equal(JSON.parse(init1.body).excludePatterns, undefined);

  const { init: init2 } = buildGraphRepositoryRequest({ owner: 'octocat', repo: 'Hello-World', excludePatterns: [], appPassword: 't' });
  assert.equal(JSON.parse(init2.body).excludePatterns, undefined);
});

test('mapGraphRepositoryResponse returns the body as-is on a successful response', () => {
  const body = { graph: { layer: 'repository' } };
  assert.deepEqual(mapGraphRepositoryResponse(true, 200, body), body);
});

test('mapGraphRepositoryResponse throws GraphRepositoryClientError with the response error/diagnostics on failure', () => {
  const body = {
    error: 'Repository not on the allowlist',
    diagnostics: [{ category: 'unsupported_input', message: 'Repository not on the allowlist' }],
  };
  assert.throws(
    () => mapGraphRepositoryResponse(false, 403, body),
    (err) => {
      assert.ok(err instanceof GraphRepositoryClientError);
      assert.equal(err.message, 'Repository not on the allowlist');
      assert.equal(err.status, 403);
      assert.equal(err.category, 'unsupported_input');
      return true;
    }
  );
});

test('mapGraphRepositoryResponse falls back to a generic message when the body has no error field', () => {
  assert.throws(
    () => mapGraphRepositoryResponse(false, 500, {}),
    (err) => {
      assert.match(err.message, /Request failed with status 500/);
      return true;
    }
  );
});
