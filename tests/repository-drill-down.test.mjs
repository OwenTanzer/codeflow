// Unit tests for src/state/repositoryDrillDown.js (MOO-69 Commit 4).
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  findNodeByPath,
  tryCreateDrillDown,
  createSelectionEventForPath,
  githubBlobUrl,
  tryCreateOpenSourceEvent,
} = await import('../src/state/repositoryDrillDown.js');
const { makeGraphIR } = await import('../src/graph-ir/graphIR.js');
const { makeCoordinate } = await import('../src/graph-ir/sourceCoordinate.js');
const { normalizeContext } = await import('../src/graph-ir/githubContext.js');

const SHA = 'a'.repeat(40);
const REPOSITORY = { host: 'github.com', owner: 'octocat', name: 'Hello-World' };
const CONTEXT = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });

function coord(path) {
  return makeCoordinate({ repository: REPOSITORY, revision: SHA, path, symbolKind: 'module' });
}

function graphWithNode(path, overrides) {
  return makeGraphIR({
    layer: 'repository',
    context: CONTEXT,
    analyzer: { name: 'test', version: '1.0.0' },
    confidence: 1,
    nodes: [{ id: `file:${path}`, layer: 'repository', kind: 'file', label: path, coordinate: coord(path), groupId: null, ...overrides }],
    edges: [],
  });
}

test('findNodeByPath returns null when graph is null (local-folder analysis, no GraphIR context)', () => {
  assert.equal(findNodeByPath(null, 'src/app.py'), null);
});

test('findNodeByPath finds a node by its coordinate path', () => {
  const graph = graphWithNode('src/app.py');
  const node = findNodeByPath(graph, 'src/app.py');
  assert.ok(node);
  assert.equal(node.coordinate.path, 'src/app.py');
});

test('tryCreateDrillDown reports ineligible with a clear reason when graph is null', () => {
  const result = tryCreateDrillDown(null, 'src/app.py');
  assert.equal(result.eligible, false);
  assert.match(result.reason, /No GitHub revision context/);
});

test('tryCreateDrillDown reports ineligible when the path has no matching node', () => {
  const graph = graphWithNode('src/app.py');
  const result = tryCreateDrillDown(graph, 'src/missing.py');
  assert.equal(result.eligible, false);
});

test('tryCreateDrillDown succeeds for an eligible (resolved) coordinate, producing a localDrillDown intent', () => {
  const graph = graphWithNode('src/app.py');
  const result = tryCreateDrillDown(graph, 'src/app.py');
  assert.equal(result.eligible, true);
  assert.equal(result.event.type, 'drillDown');
  assert.equal(result.event.intent, 'localDrillDown');
  assert.equal(result.event.targetLayer, 'file');
});

test('tryCreateDrillDown reports ineligible (not throwing) for an ambiguous coordinate', () => {
  const graph = makeGraphIR({
    layer: 'repository',
    context: CONTEXT,
    analyzer: { name: 'test', version: '1.0.0' },
    confidence: 1,
    nodes: [
      {
        id: 'file:src/mystery.py',
        layer: 'repository',
        kind: 'file',
        label: 'mystery.py',
        coordinate: makeCoordinate({ repository: REPOSITORY, revision: SHA, path: 'src/mystery.py', symbolKind: 'module', ambiguous: true }),
        groupId: null,
      },
    ],
    edges: [],
  });
  const result = tryCreateDrillDown(graph, 'src/mystery.py');
  assert.equal(result.eligible, false);
});

test('createSelectionEventForPath works even without a GraphIR context (local-folder analysis)', () => {
  const evt = createSelectionEventForPath(null, 'src/app.py');
  assert.equal(evt.type, 'select');
  assert.equal(evt.nodeId, 'src/app.py');
  assert.equal(evt.coordinate, null);
});

test('createSelectionEventForPath attaches the real coordinate when a GraphIR context exists', () => {
  const graph = graphWithNode('src/app.py');
  const evt = createSelectionEventForPath(graph, 'src/app.py');
  assert.equal(evt.coordinate.path, 'src/app.py');
});

test('githubBlobUrl builds a real GitHub blob URL from a coordinate', () => {
  const url = githubBlobUrl(coord('src/app.py'));
  assert.equal(url, `https://github.com/octocat/Hello-World/blob/${SHA}/src/app.py`);
});

test('tryCreateOpenSourceEvent returns null when there is no GraphIR context', () => {
  assert.equal(tryCreateOpenSourceEvent(null, 'src/app.py'), null);
});

test('tryCreateOpenSourceEvent returns a real event when a coordinate exists', () => {
  const graph = graphWithNode('src/app.py');
  const evt = tryCreateOpenSourceEvent(graph, 'src/app.py');
  assert.equal(evt.type, 'openSource');
  assert.equal(evt.coordinate.path, 'src/app.py');
});
