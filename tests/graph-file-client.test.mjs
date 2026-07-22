// Unit tests for src/state/graphFileClient.js (MOO-70 Commit 8).
//
// Covers the pure request-shaping/response-mapping logic without a real
// network round-trip, matching how the rest of this codebase avoids
// network dependencies in unit tests wherever possible.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGraphFileRequest, mapGraphFileResponse, GraphFileClientError } from '../src/state/graphFileClient.js';

test('buildGraphFileRequest sends the parent resolvedSha as `ref`, not a separate field', () => {
  const { url, init } = buildGraphFileRequest({
    owner: 'octocat',
    repo: 'Hello-World',
    resolvedSha: 'a'.repeat(40),
    path: 'src/app.py',
    depth: 'symbols',
    serverAuthToken: 'secret-token',
  });
  assert.equal(url, '/api/graph/file');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer secret-token');
  const body = JSON.parse(init.body);
  assert.equal(body.ref, 'a'.repeat(40));
  assert.equal(body.path, 'src/app.py');
  assert.equal(body.depth, 'symbols');
  assert.equal(body.resolvedSha, undefined, 'resolvedSha itself is not a request field -- it becomes ref');
});

test('buildGraphFileRequest omits depth when not provided', () => {
  const { init } = buildGraphFileRequest({
    owner: 'octocat',
    repo: 'Hello-World',
    resolvedSha: 'a'.repeat(40),
    path: 'src/app.py',
    serverAuthToken: 'secret-token',
  });
  const body = JSON.parse(init.body);
  assert.equal(body.depth, undefined);
});

test('buildGraphFileRequest sends `pr` (not `ref`) when a PR number is given, per the base-repository allowlist fix', () => {
  const { init } = buildGraphFileRequest({
    owner: 'octocat',
    repo: 'Hello-World',
    resolvedSha: 'a'.repeat(40),
    pr: 42,
    path: 'src/app.py',
    serverAuthToken: 'secret-token',
  });
  const body = JSON.parse(init.body);
  assert.equal(body.pr, 42);
  assert.equal(body.ref, undefined, 'ref must not also be sent -- the server re-resolves the fork/head sha from pr');
  assert.equal(body.owner, 'octocat', 'must be the base owner, never the resolved fork');
});

test('mapGraphFileResponse returns the body as-is on a successful response', () => {
  const body = { graph: { layer: 'file' } };
  assert.deepEqual(mapGraphFileResponse(true, 200, body), body);
});

test('mapGraphFileResponse throws GraphFileClientError with the response error/diagnostics on failure', () => {
  const body = {
    error: 'Repository not on the allowlist',
    diagnostics: [{ category: 'unsupported_input', message: 'Repository not on the allowlist' }],
  };
  assert.throws(
    () => mapGraphFileResponse(false, 403, body),
    (err) => {
      assert.ok(err instanceof GraphFileClientError);
      assert.equal(err.message, 'Repository not on the allowlist');
      assert.equal(err.status, 403);
      assert.equal(err.category, 'unsupported_input');
      return true;
    }
  );
});

test('mapGraphFileResponse falls back to a generic message when the body has no error field', () => {
  assert.throws(
    () => mapGraphFileResponse(false, 500, {}),
    (err) => {
      assert.match(err.message, /Request failed with status 500/);
      return true;
    }
  );
});
