// src/state/analysisSession.js -- MOO-72 Commit 1B.
//
// Covers the pure-logic invariants that make "cancelled or superseded
// requests cannot update the active view" actually hold: generation
// bumping on both a new request AND a plain abort, per-layer independence,
// hierarchical invalidation (a new file request invalidates any in-flight
// function request), session-wide epoch invalidation on a new repository
// request, and the deterministic out-of-order/cleanup-then-late-resolution
// races an earlier draft of this commit got wrong.
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisSession } from '../src/state/analysisSession.js';

function makeContext(overrides) {
  return {
    owner: 'octocat',
    repo: 'Hello-World',
    resolvedSha: 'a'.repeat(40),
    sourceOwner: 'octocat',
    sourceRepo: 'Hello-World',
    prNumber: null,
    ...overrides,
  };
}

function adoptedSession() {
  const session = new AnalysisSession();
  const repoDescriptor = session.describeRepositoryRequest(null, null, []);
  session.adoptRepositoryContext(makeContext(), repoDescriptor);
  return { session, repoDescriptor };
}

test('describeFileRequest throws before a repository context has been adopted', () => {
  const session = new AnalysisSession();
  assert.throws(() => session.describeFileRequest('a.py'), /no repository context adopted/);
});

test('describeFunctionRequest throws before a repository context has been adopted', () => {
  const session = new AnalysisSession();
  assert.throws(() => session.describeFunctionRequest('a.py', ['f']), /no repository context adopted/);
});

test('describeFileRequest derives revision fields from the adopted context without the caller supplying them', () => {
  const { session } = adoptedSession();
  const descriptor = session.describeFileRequest('a.py', 'full');
  assert.equal(descriptor.params.owner, 'octocat');
  assert.equal(descriptor.params.repo, 'Hello-World');
  assert.equal(descriptor.params.resolvedSha, 'a'.repeat(40));
  assert.equal(descriptor.params.sourceOwner, 'octocat');
  assert.equal(descriptor.params.sourceRepo, 'Hello-World');
  assert.equal(descriptor.params.pr, null);
  assert.equal(descriptor.params.path, 'a.py');
  assert.equal(descriptor.params.depth, 'full');
  assert.equal(descriptor.params.sessionId, session.sessionId);
});

test('adoptRepositoryContext returns false and does not adopt a stale/superseded descriptor', () => {
  const session = new AnalysisSession();
  const first = session.describeRepositoryRequest(null, null, []);
  const second = session.describeRepositoryRequest(null, null, []); // supersedes `first`
  const adopted = session.adoptRepositoryContext(makeContext(), first);
  assert.equal(adopted, false);
  assert.equal(session.repositoryContext, null, 'a stale resolution must never become the session\'s context');

  const adoptedCurrent = session.adoptRepositoryContext(makeContext(), second);
  assert.equal(adoptedCurrent, true);
  assert.ok(session.repositoryContext);
});

test('a second _begin for the same layer invalidates the first without an explicit abort call', () => {
  const { session } = adoptedSession();
  const first = session.describeFileRequest('a.py');
  const second = session.describeFileRequest('b.py');
  assert.equal(session.isCurrent('file', first.generation, first.epoch), false);
  assert.equal(session.isCurrent('file', second.generation, second.epoch), true);
  assert.equal(first.signal.aborted, true);
});

// The exact race an earlier draft of this commit got wrong: two requests
// for the same layer, but the *older* one's promise resolves *after* the
// newer one has already begun. Deterministic and synchronously testable --
// no real timers/fetches needed to prove only the newer generation applies.
test('out-of-order resolution: an older generation resolving after a newer one has begun is never current', () => {
  const { session } = adoptedSession();
  const older = session.describeFileRequest('a.py');
  const newer = session.describeFileRequest('b.py');
  // Simulate older's network response finally arriving, after newer already started.
  assert.equal(session.isCurrent('file', older.generation, older.epoch), false, 'older must not be current even though it resolves last');
  assert.equal(session.isCurrent('file', newer.generation, newer.epoch), true);
});

test('cleanup-then-late-resolution: abortCurrent invalidates a generation that later resolves anyway', () => {
  const { session } = adoptedSession();
  const descriptor = session.describeFileRequest('a.py');
  session.abortCurrent('file'); // e.g. the effect unmounted with no new request following
  // The original fetch's promise settling after cleanup must not be applicable.
  assert.equal(session.isCurrent('file', descriptor.generation, descriptor.epoch), false);
});

test('per-layer independence: describing a function request does not abort file\'s controller', () => {
  const { session } = adoptedSession();
  const file = session.describeFileRequest('a.py');
  session.describeFunctionRequest('a.py', ['f']);
  assert.equal(file.signal.aborted, false, 'function and file are independent slots -- only file->function invalidation is hierarchical, not the reverse');
  assert.equal(session.isCurrent('file', file.generation, file.epoch), true);
});

test('hierarchical invalidation: a new file request invalidates any in-flight function request', () => {
  const { session } = adoptedSession();
  const fn = session.describeFunctionRequest('a.py', ['f']);
  session.describeFileRequest('a.py'); // navigating to a (possibly different) file target
  assert.equal(fn.signal.aborted, true);
  assert.equal(session.isCurrent('function', fn.generation, fn.epoch), false);
});

test('a new repository request invalidates every child layer via the session-wide epoch', () => {
  const { session, repoDescriptor } = adoptedSession();
  const file = session.describeFileRequest('a.py');
  const fn = session.describeFunctionRequest('a.py', ['f']);

  const secondRepo = session.describeRepositoryRequest('main', null, []);
  assert.notEqual(secondRepo.epoch, repoDescriptor.epoch);
  assert.equal(session.isCurrent('file', file.generation, file.epoch), false);
  assert.equal(session.isCurrent('function', fn.generation, fn.epoch), false);
  assert.equal(file.signal.aborted, true);
  assert.equal(fn.signal.aborted, true);
});

// Cross-session case: session A's in-flight work must never apply once
// something else (a new session B replacing A) has cancelled it -- the
// mechanism a caller uses (index.html's resetAnalysisState) is
// session.cancelAll() on the outgoing session, simulated directly here.
test('cancelAll invalidates all in-flight work, simulating session A being replaced by session B', () => {
  const { session: sessionA } = adoptedSession();
  const fileA = sessionA.describeFileRequest('a.py');
  const fnA = sessionA.describeFunctionRequest('a.py', ['f']);

  sessionA.cancelAll(); // caller is replacing sessionA with a fresh session B

  assert.equal(sessionA.isCurrent('file', fileA.generation, fileA.epoch), false);
  assert.equal(sessionA.isCurrent('function', fnA.generation, fnA.epoch), false);
  assert.equal(fileA.signal.aborted, true);
  assert.equal(fnA.signal.aborted, true);
});

test('each session has its own sessionId, defaulting to a fresh UUID', () => {
  const a = new AnalysisSession();
  const b = new AnalysisSession();
  assert.notEqual(a.sessionId, b.sessionId);
  assert.match(a.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});
