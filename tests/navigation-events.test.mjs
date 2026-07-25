// Unit tests for src/graph-ir/navigation.js (MOO-68 Commit 5).
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  classifyPointerInteraction,
  isDrillDownEligible,
  createSelectionEvent,
  createDrillDownEvent,
  createOpenSourceEvent,
  makeBreadcrumbEntry,
  NavigationHistory,
  NavigationError,
} = await import('../src/graph-ir/navigation.js');
const { makeCoordinate } = await import('../src/graph-ir/sourceCoordinate.js');

const REPO = { host: 'github.com', owner: 'octocat', name: 'Hello-World' };
const SHA = 'a'.repeat(40);

function coord(overrides) {
  return makeCoordinate({ repository: REPO, revision: SHA, path: 'src/app.py', symbolKind: 'module', ...overrides });
}

test('classifyPointerInteraction distinguishes single-click, double-click, and treats detail:2 click as drillDown too', () => {
  assert.equal(classifyPointerInteraction({ type: 'click', detail: 1 }), 'select');
  assert.equal(classifyPointerInteraction({ type: 'dblclick' }), 'drillDown');
  assert.equal(classifyPointerInteraction({ type: 'click', detail: 2 }), 'drillDown');
});

test('createSelectionEvent emits selection/focus only', () => {
  const evt = createSelectionEvent('node-1', coord());
  assert.equal(evt.type, 'select');
  assert.equal(evt.nodeId, 'node-1');
});

test('createSelectionEvent requires a nodeId', () => {
  assert.throws(() => createSelectionEvent(null, coord()), NavigationError);
});

test('repository -> file drill-down succeeds for a resolved coordinate with a path', () => {
  const evt = createDrillDownEvent(coord(), 'repository');
  assert.equal(evt.type, 'drillDown');
  assert.equal(evt.targetLayer, 'file');
});

test('a bare coordinate (no origin) defaults to origin "local" and intent "localDrillDown"', () => {
  const evt = createDrillDownEvent(coord(), 'repository');
  assert.equal(evt.origin, 'local');
  assert.equal(evt.intent, 'localDrillDown');
});

test('a node object {coordinate, origin: "local"} produces an ordinary localDrillDown intent', () => {
  const evt = createDrillDownEvent({ coordinate: coord(), origin: 'local' }, 'repository');
  assert.equal(evt.intent, 'localDrillDown');
});

test('a node object with origin "external" produces a newContext intent, not an ordinary drill-down', () => {
  const evt = createDrillDownEvent({ coordinate: coord(), origin: 'external' }, 'repository');
  assert.equal(evt.origin, 'external');
  assert.equal(evt.intent, 'newContext');
});

test('a node object with origin "cached" produces a cachedContext intent', () => {
  const evt = createDrillDownEvent({ coordinate: coord(), origin: 'cached' }, 'repository');
  assert.equal(evt.origin, 'cached');
  assert.equal(evt.intent, 'cachedContext');
});

test('a synthetic node cannot drill down using its own (typically absent) coordinate', () => {
  assert.throws(() => createDrillDownEvent({ coordinate: coord(), origin: 'synthetic' }, 'repository'), NavigationError);
  assert.throws(() => createDrillDownEvent({ coordinate: null, origin: 'synthetic' }, 'repository'), NavigationError);
});

test('a synthetic node can drill down when the caller supplies an explicit anchorCoordinate', () => {
  const anchor = coord({ path: 'src/real-target.py' });
  const evt = createDrillDownEvent({ coordinate: null, origin: 'synthetic' }, 'repository', { anchorCoordinate: anchor });
  assert.deepEqual(evt.coordinate, anchor);
  assert.equal(evt.intent, 'localDrillDown');
});

test('file -> function drill-down requires a resolved function/method symbolPath', () => {
  const fnCoord = coord({ symbolPath: ['Service', 'run'], symbolKind: 'method' });
  const evt = createDrillDownEvent(fnCoord, 'file');
  assert.equal(evt.targetLayer, 'function');
});

test('function layer has no further drill-down target', () => {
  assert.throws(() => createDrillDownEvent(coord(), 'function'), NavigationError);
});

test('an ambiguous coordinate never triggers drill-down (unresolved-target behavior)', () => {
  const ambiguous = coord({ symbolPath: ['maybe_this'], symbolKind: 'function', ambiguous: true });
  assert.equal(isDrillDownEligible(ambiguous, 'file'), false);
  assert.throws(() => createDrillDownEvent(ambiguous, 'repository'), NavigationError);
});

test('a module-level coordinate (no function scope) is not eligible for a function drill-down', () => {
  const moduleCoord = coord({ symbolKind: 'module' });
  assert.equal(isDrillDownEligible(moduleCoord, 'function'), false);
  assert.throws(() => createDrillDownEvent(moduleCoord, 'file'), NavigationError);
});

test('createOpenSourceEvent allows an ambiguous coordinate as long as it has a path', () => {
  const ambiguous = coord({ symbolPath: ['maybe_this'], ambiguous: true });
  const evt = createOpenSourceEvent(ambiguous);
  assert.equal(evt.type, 'openSource');
});

test('createOpenSourceEvent requires a path', () => {
  assert.throws(() => createOpenSourceEvent(null), NavigationError);
});

test('NavigationHistory restores prior graph (via cache key), selection, and coordinate on back/forward', () => {
  const repoEntry = makeBreadcrumbEntry('repository', null, { graphCacheKey: 'k-repo', selectedNodeId: 'n1' });
  const fileEntry = makeBreadcrumbEntry('file', coord(), { graphCacheKey: 'k-file', selectedNodeId: 'n2' });
  const history = new NavigationHistory(repoEntry);
  history.push(fileEntry);

  assert.equal(history.current(), fileEntry);
  assert.equal(history.canGoBack, true);
  assert.equal(history.canGoForward, false);

  const restored = history.back();
  assert.equal(restored.graphCacheKey, 'k-repo');
  assert.equal(restored.selectedNodeId, 'n1');
  assert.equal(history.canGoForward, true);

  const forwardAgain = history.forward();
  assert.equal(forwardAgain.graphCacheKey, 'k-file');
  assert.deepEqual(forwardAgain.coordinate, coord());
});

test('NavigationHistory push after going back truncates the discarded forward branch', () => {
  const a = makeBreadcrumbEntry('repository', null, { graphCacheKey: 'a' });
  const b = makeBreadcrumbEntry('file', null, { graphCacheKey: 'b' });
  const c = makeBreadcrumbEntry('function', null, { graphCacheKey: 'c' });
  const history = new NavigationHistory(a);
  history.push(b);
  history.back();
  history.push(c);
  assert.equal(history.canGoForward, false);
  assert.deepEqual(history.trail().map((e) => e.graphCacheKey), ['a', 'c']);
});

test('NavigationHistory.back/forward throw at the boundaries', () => {
  const history = new NavigationHistory(makeBreadcrumbEntry('repository', null, {}));
  assert.throws(() => history.back(), NavigationError);
  assert.throws(() => history.forward(), NavigationError);
});

// MOO-71 Commit 8: BreadcrumbEntry.graphCacheKey/selectedNodeId have existed
// since MOO-68 Commit 5 so back/forward could restore a view from cache
// instead of re-running analysis, but nothing ever wrote them until the file
// and function panels did. updateCurrent is that write path.
test('NavigationHistory.updateCurrent records panel state onto the active entry', () => {
  const history = new NavigationHistory(makeBreadcrumbEntry('repository', null, { label: 'Repository' }));
  history.push(makeBreadcrumbEntry('file', null, { label: 'sessions.py' }));

  const updated = history.updateCurrent({ graphCacheKey: 'graphir:v1:abc', selectedNodeId: 'n7' });

  assert.equal(updated.graphCacheKey, 'graphir:v1:abc');
  assert.equal(updated.selectedNodeId, 'n7');
  assert.equal(history.current().graphCacheKey, 'graphir:v1:abc');
  assert.equal(history.current().label, 'sessions.py', 'unpatched fields survive');
  assert.equal(history.trail()[0].graphCacheKey, null, 'only the current entry is touched');
});

test('NavigationHistory.updateCurrent replaces rather than mutates, so stale references cannot read new state', () => {
  const history = new NavigationHistory(makeBreadcrumbEntry('file', null, { label: 'a.py' }));
  const before = history.current();
  history.updateCurrent({ graphCacheKey: 'k1' });

  assert.notEqual(history.current(), before, 'a new object identity signals the change to React');
  assert.equal(before.graphCacheKey, null, 'the previously held entry is not mutated underneath its holder');
});

test('NavigationHistory.updateCurrent does not truncate forward history -- it records, it does not navigate', () => {
  const history = new NavigationHistory(makeBreadcrumbEntry('repository', null, { label: 'Repository' }));
  history.push(makeBreadcrumbEntry('file', null, { label: 'a.py' }));
  history.push(makeBreadcrumbEntry('function', null, { label: 'a.run' }));
  history.back();

  history.updateCurrent({ graphCacheKey: 'k-file' });

  assert.equal(history.canGoForward, true, 'the function entry is still reachable');
  assert.equal(history.forward().label, 'a.run');
});

test('repository -> file -> function -> back restores the file entry and its recorded graph', () => {
  const history = new NavigationHistory(makeBreadcrumbEntry('repository', null, { label: 'Repository' }));

  history.push(makeBreadcrumbEntry('file', null, { label: 'sessions.py' }));
  history.updateCurrent({ graphCacheKey: 'key-file' });
  history.push(makeBreadcrumbEntry('function', null, { label: 'Session.request' }));
  history.updateCurrent({ graphCacheKey: 'key-function', selectedNodeId: 'stmt_3' });

  const back = history.back();
  assert.equal(back.layer, 'file');
  assert.equal(back.graphCacheKey, 'key-file', 'the file view is restorable without re-analysis');

  const forward = history.forward();
  assert.equal(forward.layer, 'function');
  assert.equal(forward.graphCacheKey, 'key-function');
  assert.equal(forward.selectedNodeId, 'stmt_3', 'selection is part of restored state');
});
