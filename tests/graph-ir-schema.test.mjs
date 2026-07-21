// Unit tests for src/graph-ir/graphIR.js (MOO-68 Commit 3).
import assert from 'node:assert/strict';
import test from 'node:test';

const { makeGraphIR, validateGraphIR, GraphIRError, GRAPH_IR_SCHEMA_VERSION } = await import('../src/graph-ir/graphIR.js');
const { makeCoordinate } = await import('../src/graph-ir/sourceCoordinate.js');
const { normalizeContext } = await import('../src/graph-ir/githubContext.js');

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const CONTEXT = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });
const REPOSITORY = { host: 'github.com', owner: 'octocat', name: 'Hello-World' };
const OTHER_REPOSITORY = { host: 'github.com', owner: 'someone-else', name: 'Other-Repo' };

function coord(overrides) {
  return makeCoordinate({ repository: REPOSITORY, revision: SHA, path: 'src/app.py', symbolKind: 'module', ...overrides });
}

function baseGraphInput(layer, overrides) {
  return {
    layer,
    context: CONTEXT,
    analyzer: { name: 'pyan3', version: '1.2.3' },
    confidence: 1,
    nodes: [],
    edges: [],
    ...overrides,
  };
}

test('a minimal repository-layer graph validates', () => {
  const graph = makeGraphIR(
    baseGraphInput('repository', {
      nodes: [{ id: 'n1', layer: 'repository', kind: 'directory', label: 'src', coordinate: null, groupId: null }],
    })
  );
  assert.equal(validateGraphIR(graph).valid, true);
  assert.equal(graph.schemaVersion, GRAPH_IR_SCHEMA_VERSION);
});

test('a minimal file-layer (pyan-style) graph validates', () => {
  const graph = makeGraphIR(
    baseGraphInput('file', {
      rootCoordinate: coord(),
      nodes: [
        { id: 'fn1', layer: 'file', kind: 'function', label: 'run', coordinate: coord({ symbolPath: ['run'], symbolKind: 'function' }), groupId: null },
      ],
    })
  );
  assert.equal(validateGraphIR(graph).valid, true);
});

test('a minimal function-layer (CodeVisualizer-style) graph validates', () => {
  const graph = makeGraphIR(
    baseGraphInput('function', {
      rootCoordinate: coord({ symbolPath: ['run'], symbolKind: 'function' }),
      nodes: [
        { id: 'entry', layer: 'function', kind: 'entry', label: 'entry', coordinate: null, groupId: null, hints: { isEntry: true } },
        { id: 'exit', layer: 'function', kind: 'exit', label: 'exit', coordinate: null, groupId: null, hints: { isExit: true } },
      ],
      edges: [{ id: 'e1', layer: 'function', kind: 'flow', source: 'entry', target: 'exit' }],
    })
  );
  assert.equal(validateGraphIR(graph).valid, true);
});

test('unknown/extra fields anywhere in the tree are safely ignored, not rejected', () => {
  const graph = makeGraphIR(
    baseGraphInput('repository', {
      nodes: [{ id: 'n1', layer: 'repository', kind: 'file', label: 'a.py', coordinate: null, groupId: null, metadata: { futureField: 42 } }],
      futureTopLevelField: 'anything',
    })
  );
  assert.equal(validateGraphIR(graph).valid, true);
});

test('rejects a wrong schemaVersion', () => {
  const result = validateGraphIR({ ...baseGraphInput('repository'), schemaVersion: 999, generatedAt: new Date().toISOString(), groups: [], rootCoordinate: null, warnings: [] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('schemaVersion')));
});

test('rejects an edge referencing a node id not present in this graph (invalid cross-layer/dangling edge)', () => {
  assert.throws(
    () =>
      makeGraphIR(
        baseGraphInput('function', {
          nodes: [{ id: 'a', layer: 'function', kind: 'entry', label: 'a', coordinate: null, groupId: null }],
          edges: [{ id: 'e1', layer: 'function', kind: 'flow', source: 'a', target: 'does-not-exist' }],
        })
      ),
    (err) => err instanceof GraphIRError && err.errors.some((e) => e.includes('unknown target node'))
  );
});

test('rejects a node whose layer does not match the graph layer', () => {
  assert.throws(
    () =>
      makeGraphIR(
        baseGraphInput('file', {
          nodes: [{ id: 'a', layer: 'repository', kind: 'file', label: 'a', coordinate: null, groupId: null }],
        })
      ),
    (err) => err instanceof GraphIRError && err.errors.some((e) => e.includes('invalid cross-layer node'))
  );
});

test('rejects duplicate node ids', () => {
  assert.throws(
    () =>
      makeGraphIR(
        baseGraphInput('repository', {
          nodes: [
            { id: 'dup', layer: 'repository', kind: 'file', label: 'a', coordinate: null, groupId: null },
            { id: 'dup', layer: 'repository', kind: 'file', label: 'b', coordinate: null, groupId: null },
          ],
        })
      ),
    GraphIRError
  );
});

test('rejects a group referencing an unknown parentGroupId', () => {
  assert.throws(
    () =>
      makeGraphIR(
        baseGraphInput('repository', {
          groups: [{ id: 'g1', layer: 'repository', label: 'src', parentGroupId: 'missing' }],
        })
      ),
    GraphIRError
  );
});

test('layers genuinely retain distinct hint vocabularies (renderer freedom) while sharing the same envelope', () => {
  const repoGraph = makeGraphIR(
    baseGraphInput('repository', {
      nodes: [{ id: 'n1', layer: 'repository', kind: 'directory', label: 'src', coordinate: null, groupId: null, hints: { layoutPreference: 'treemap' } }],
    })
  );
  const fnGraph = makeGraphIR(
    baseGraphInput('function', {
      nodes: [{ id: 'n1', layer: 'function', kind: 'entry', label: 'entry', coordinate: null, groupId: null, hints: { layoutPreference: 'hierarchical', isEntry: true } }],
    })
  );
  assert.notEqual(repoGraph.nodes[0].hints.layoutPreference, fnGraph.nodes[0].hints.layoutPreference);
});

test('rejects a node whose (default-local) coordinate is pinned to a different revision than the graph context', () => {
  assert.throws(
    () =>
      makeGraphIR(
        baseGraphInput('repository', {
          nodes: [{ id: 'n1', layer: 'repository', kind: 'file', label: 'a.py', coordinate: coord({ revision: OTHER_SHA }), groupId: null }],
        })
      ),
    (err) => err instanceof GraphIRError && err.errors.some((e) => e.includes("does not match the graph's analyzed context"))
  );
});

test('rejects a node whose (default-local) coordinate is pinned to a different repository than the graph context', () => {
  assert.throws(
    () =>
      makeGraphIR(
        baseGraphInput('repository', {
          nodes: [{ id: 'n1', layer: 'repository', kind: 'file', label: 'a.py', coordinate: coord({ repository: OTHER_REPOSITORY }), groupId: null }],
        })
      ),
    GraphIRError
  );
});

test("rejects a rootCoordinate pinned to a different revision than the graph's context", () => {
  assert.throws(
    () =>
      makeGraphIR(
        baseGraphInput('repository', {
          rootCoordinate: coord({ revision: OTHER_SHA }),
        })
      ),
    (err) => err instanceof GraphIRError && err.errors.some((e) => e.includes('rootCoordinate does not match'))
  );
});

test("a node explicitly marked origin: 'external' may reference a different repository/revision", () => {
  const graph = makeGraphIR(
    baseGraphInput('repository', {
      nodes: [
        {
          id: 'dep',
          layer: 'repository',
          kind: 'dependency',
          label: 'other-project',
          coordinate: coord({ repository: OTHER_REPOSITORY, revision: OTHER_SHA }),
          groupId: null,
          origin: 'external',
        },
      ],
    })
  );
  assert.equal(validateGraphIR(graph).valid, true);
});

test("a node marked origin: 'cached' may also reference a different revision", () => {
  const graph = makeGraphIR(
    baseGraphInput('file', {
      nodes: [
        { id: 'n1', layer: 'file', kind: 'function', label: 'run', coordinate: coord({ revision: OTHER_SHA, symbolPath: ['run'], symbolKind: 'function' }), groupId: null, origin: 'cached' },
      ],
    })
  );
  assert.equal(validateGraphIR(graph).valid, true);
});

test("a node marked origin: 'synthetic' may have no coordinate at all", () => {
  const graph = makeGraphIR(
    baseGraphInput('function', {
      nodes: [{ id: 'entry', layer: 'function', kind: 'entry', label: 'entry', coordinate: null, groupId: null, origin: 'synthetic', hints: { isEntry: true } }],
    })
  );
  assert.equal(validateGraphIR(graph).valid, true);
});

test("rejects a node marked origin: 'external' with no coordinate (nothing to identify what it references)", () => {
  assert.throws(
    () =>
      makeGraphIR(
        baseGraphInput('repository', {
          nodes: [{ id: 'dep', layer: 'repository', kind: 'dependency', label: 'mystery', coordinate: null, groupId: null, origin: 'external' }],
        })
      ),
    (err) => err instanceof GraphIRError && err.errors.some((e) => e.includes('has no coordinate identifying what it references'))
  );
});

test('rejects an invalid origin value', () => {
  assert.throws(
    () =>
      makeGraphIR(
        baseGraphInput('repository', {
          nodes: [{ id: 'n1', layer: 'repository', kind: 'file', label: 'a.py', coordinate: coord(), groupId: null, origin: 'bogus' }],
        })
      ),
    GraphIRError
  );
});

test('a node with no coordinate at all is fine regardless of origin (e.g. a directory node)', () => {
  const graph = makeGraphIR(
    baseGraphInput('repository', {
      nodes: [{ id: 'dir', layer: 'repository', kind: 'directory', label: 'src', coordinate: null, groupId: null }],
    })
  );
  assert.equal(validateGraphIR(graph).valid, true);
});

test('coordinate/context matching keys off the resolved source repository, so a forked-PR context accepts coordinates naming the fork', () => {
  const forkedContext = normalizeContext({
    owner: 'octocat',
    repo: 'Hello-World',
    prNumber: 42,
    resolvedSha: SHA,
    sourceOwner: 'a-contributor',
    sourceRepo: 'Hello-World',
  });
  const forkCoordinate = makeCoordinate({
    repository: { host: 'github.com', owner: 'a-contributor', name: 'Hello-World' },
    revision: SHA,
    path: 'src/app.py',
    symbolKind: 'module',
  });
  const graph = makeGraphIR({
    layer: 'repository',
    context: forkedContext,
    analyzer: { name: 'pyan3', version: '1.2.3' },
    confidence: 1,
    nodes: [{ id: 'n1', layer: 'repository', kind: 'file', label: 'app.py', coordinate: forkCoordinate, groupId: null }],
    edges: [],
  });
  assert.equal(validateGraphIR(graph).valid, true);
});
