import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as legacy from '../server/routes/graph-repository.js';
import * as current from '../server/lib/graph-request-context.js';
import { AnalysisContextError } from '../src/graph-ir/githubContext.js';
import { buildCacheKey } from '../src/graph-ir/cacheKey.js';
import { GRAPH_IR_SCHEMA_VERSION } from '../src/graph-ir/graphIR.js';
import { makeCoordinate } from '../src/graph-ir/sourceCoordinate.js';

// Captured from the unmodified route at 21e48a246210af76b302ef83f65a4645ad884e9b.
// Literal keys protect byte parity, not just agreement between two new imports.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/graph-request-context/baseline.json', import.meta.url)));

function cacheKeys(context, identity) {
  const coordinate = {
    repository: { host: 'github.com', owner: context.sourceOwner, name: context.sourceRepo },
    revision: context.resolvedSha, path: 'src/example.py', symbolKind: 'module',
  };
  const key = (analyzerName, analyzerVersion, options, coordinate) => buildCacheKey({
    context, analyzerName, analyzerVersion, graphSchemaVersion: GRAPH_IR_SCHEMA_VERSION,
    options: { ...options, ...identity }, ...(coordinate ? { coordinate } : {}),
  });
  const repositoryOptions = { maxFileBytes: 1048576, maxRepoBytes: 26214400, excludePatterns: ['vendor'] };
  return {
    repository: key('codeflow-repository-adapter', '1.3.0', { ...repositoryOptions, pythonTreeSitter: true }),
    repositoryDegraded: key('codeflow-repository-adapter', '1.3.0', repositoryOptions),
    fileAuto: key('codeflow-pyan3-adapter', '1.0.0', { depthMode: 'auto' }, makeCoordinate(coordinate)),
    fileDepth2: key('codeflow-pyan3-adapter', '1.0.0', { depthMode: 2 }, makeCoordinate(coordinate)),
    fileInflight: key('codeflow-pyan3-adapter', '1.0.0', {}, makeCoordinate(coordinate)),
    function: key('codeflow-codevisualizer-adapter', '1.0.0', {}, makeCoordinate({
      ...coordinate, symbolKind: 'function', symbolPath: ['example'],
      range: { startLine: 1, startColumn: 0, endLine: 3, endColumn: 12 },
    })),
  };
}

test('legacy route exports are the exact lower-level functions', () => {
  assert.strictEqual(legacy.buildRequestContext, current.buildRequestContext);
  assert.strictEqual(legacy.cacheKeyRequestIdentity, current.cacheKeyRequestIdentity);
});

for (const fixture of fixtures) {
  test(`request-context baseline parity: ${fixture.name}`, () => {
    for (const surface of [legacy, current]) {
      const request = structuredClone(fixture.request);
      const resolved = structuredClone(fixture.resolved);
      if (fixture.error) {
        assert.throws(() => surface.buildRequestContext(request, resolved), (error) => {
          assert.ok(error instanceof AnalysisContextError);
          assert.equal(error.name, fixture.error.name);
          assert.equal(error.message, fixture.error.message);
          assert.deepEqual(error.errors, fixture.error.errors);
          return true;
        });
      } else {
        const context = surface.buildRequestContext(request, resolved);
        assert.deepEqual(context, fixture.context);
        assert.ok(Object.isFrozen(context));
        const identity = surface.cacheKeyRequestIdentity(context);
        assert.deepEqual(identity, fixture.identity);
        assert.deepEqual(cacheKeys(context, identity), fixture.keys);
      }
      assert.deepEqual(request, fixture.request);
      assert.deepEqual(resolved, fixture.resolved);
    }
  });
}

test('same source SHA retains distinct response provenance in every cache surface', () => {
  const valid = fixtures.filter((fixture) => fixture.keys);
  for (const key of Object.keys(valid[0].keys)) {
    const keys = valid.map(({ request, resolved }) => {
      const context = current.buildRequestContext(request, resolved);
      return cacheKeys(context, current.cacheKeyRequestIdentity(context))[key];
    });
    assert.equal(new Set(keys).size, valid.length, key);
  }
});
