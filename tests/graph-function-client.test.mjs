// Unit tests for src/state/graphFunctionClient.js (MOO-71 Commit 7).
//
// Mirrors tests/graph-file-client.test.mjs's coverage (request shaping and
// response mapping, no real network) plus the two function-specific
// contract points: symbolPath is sent verbatim, and `depth` is never sent.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGraphFunctionRequest,
  mapGraphFunctionResponse,
  GraphFunctionClientError,
} from '../src/state/graphFunctionClient.js';
import { ServerRequestError } from '../src/state/serverRequest.js';

const SHA = 'a'.repeat(40);

function baseInput(overrides = {}) {
  return {
    owner: 'octocat',
    repo: 'Hello-World',
    resolvedSha: SHA,
    path: 'src/service.py',
    symbolPath: ['Service', 'run'],
    ...overrides,
  };
}

test('buildGraphFunctionRequest posts to /api/graph/function with a JSON content type', () => {
  const { url, init } = buildGraphFunctionRequest(baseInput());
  assert.equal(url, '/api/graph/function');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
});

test('buildGraphFunctionRequest sends symbolPath verbatim as an array', () => {
  const { init } = buildGraphFunctionRequest(baseInput({ symbolPath: ['Outer', 'inner', 'deepest'] }));
  const body = JSON.parse(init.body);
  assert.deepEqual(body.symbolPath, ['Outer', 'inner', 'deepest']);
  assert.equal(body.path, 'src/service.py');
});

test('buildGraphFunctionRequest never sends depth -- it is meaningless at function granularity', () => {
  const { init } = buildGraphFunctionRequest(baseInput({ depth: 'symbols' }));
  const body = JSON.parse(init.body);
  assert.equal(body.depth, undefined);
});

test('buildGraphFunctionRequest sends the parent resolvedSha as `ref` outside PR mode', () => {
  const { init } = buildGraphFunctionRequest(baseInput());
  const body = JSON.parse(init.body);
  assert.equal(body.ref, SHA);
  assert.equal(body.resolvedSha, undefined, 'resolvedSha itself is not a request field -- it becomes ref');
  assert.equal(body.pr, undefined);
});

test('buildGraphFunctionRequest sends `pr` instead of `ref` in PR mode, keeping the base owner/repo', () => {
  const { init } = buildGraphFunctionRequest(baseInput({ pr: 42, sourceOwner: 'contributor', sourceRepo: 'Hello-World' }));
  const body = JSON.parse(init.body);
  assert.equal(body.pr, 42);
  assert.equal(body.ref, undefined, 'ref must not also be sent -- the server re-resolves the fork/head sha from pr');
  assert.equal(body.owner, 'octocat', 'must be the base owner, never the resolved fork');
  assert.equal(body.repo, 'Hello-World');
});

test('buildGraphFunctionRequest sends expected* revision fields in PR mode so a moved PR head is rejected server-side', () => {
  const { init } = buildGraphFunctionRequest(baseInput({ pr: 42, sourceOwner: 'contributor', sourceRepo: 'Hello-World' }));
  const body = JSON.parse(init.body);
  assert.equal(body.expectedResolvedSha, SHA);
  assert.equal(body.expectedSourceOwner, 'contributor');
  assert.equal(body.expectedSourceRepo, 'Hello-World');
});

test('buildGraphFunctionRequest does not send expected* fields outside PR mode', () => {
  const { init } = buildGraphFunctionRequest(baseInput());
  const body = JSON.parse(init.body);
  assert.equal(body.expectedResolvedSha, undefined);
  assert.equal(body.expectedSourceOwner, undefined);
  assert.equal(body.expectedSourceRepo, undefined);
});

test('mapGraphFunctionResponse returns the body as-is on success', () => {
  const body = { graph: { layer: 'function' } };
  assert.deepEqual(mapGraphFunctionResponse(true, 200, body), body);
});

test('mapGraphFunctionResponse throws GraphFunctionClientError carrying status/category/diagnostics', () => {
  const body = {
    error: 'Symbol path did not resolve to a function in this file',
    diagnostics: [{ category: 'unresolved_symbol', message: 'no match for ["Service","run"]' }],
  };
  assert.throws(
    () => mapGraphFunctionResponse(false, 404, body),
    (err) => {
      assert.ok(err instanceof GraphFunctionClientError);
      assert.ok(err instanceof ServerRequestError, 'shares the base class both graph clients use');
      assert.equal(err.name, 'GraphFunctionClientError');
      assert.equal(err.message, 'Symbol path did not resolve to a function in this file');
      assert.equal(err.status, 404);
      assert.equal(err.category, 'unresolved_symbol');
      assert.equal(err.diagnostics.length, 1);
      return true;
    }
  );
});

test('mapGraphFunctionResponse surfaces a 401 status so the panel can clear the token and re-prompt', () => {
  assert.throws(
    () => mapGraphFunctionResponse(false, 401, { error: 'Unauthorized' }),
    (err) => {
      assert.equal(err.status, 401);
      return true;
    }
  );
});

test('mapGraphFunctionResponse falls back to a generic message when the body has no error field', () => {
  assert.throws(
    () => mapGraphFunctionResponse(false, 500, {}),
    (err) => {
      assert.match(err.message, /Request failed with status 500/);
      assert.deepEqual(err.diagnostics, []);
      return true;
    }
  );
});
