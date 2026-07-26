// Unit tests for src/graph-ir/blastRadius.js (MOO-72 Commit 1A).
//
// Proves calcBlastFromGraph is a faithful GraphIR-native port of
// src/analyzer.js's calcBlast: same fixture-harness pattern as
// tests/repository-graph-adapter.test.mjs, run through both the legacy
// calcBlast(fileId, conns, files) and calcBlastFromGraph(path, graph) for
// every file in the fixture, and diffed field-by-field -- catches any
// drift in the port's adjacency-building or scoring logic that a
// hand-picked example wouldn't.
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

if (!('TreeSitter' in globalThis)) globalThis.TreeSitter = undefined;
if (!('Babel' in globalThis)) globalThis.Babel = undefined;
if (!('acorn' in globalThis)) globalThis.acorn = undefined;

const __dirname = dirname(fileURLToPath(import.meta.url));

const { Parser, buildAnalysisData, calcBlast } = await import('../src/analyzer.js');
const { buildAnalyzed } = await import('../card/lib/collect.js');
const { adaptRepositoryAnalysis } = await import('../src/adapters/repositoryGraphAdapter.js');
const { normalizeContext } = await import('../src/graph-ir/githubContext.js');
const { calcBlastFromGraph } = await import('../src/graph-ir/blastRadius.js');

const SHA = 'a'.repeat(40);
const CONTEXT = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });
const ANALYZER = { name: 'codeflow-repository-adapter', version: '1.1.0' };

async function analyzeFixture(name) {
  const root = join(__dirname, 'fixtures', name);
  const { analyzed, allFns } = await buildAnalyzed(root, Parser, []);
  return buildAnalysisData({ analyzed, allFns, excludePatterns: [], progress() {}, yieldFn: async () => {} });
}

for (const fixture of ['golden-world', 'web-app-world']) {
  test(`calcBlastFromGraph matches legacy calcBlast for every file in ${fixture}`, async () => {
    const analysisData = await analyzeFixture(fixture);
    const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
    assert.ok(analysisData.files.length > 0, 'fixture must have files to compare');

    for (const file of analysisData.files) {
      const legacy = calcBlast(file.path, analysisData.connections, analysisData.files);
      const ported = calcBlastFromGraph(file.path, graph);

      assert.deepEqual(new Set(ported.affected), new Set(legacy.affected), `${file.path}: affected`);
      assert.deepEqual(new Set(ported.transitive), new Set(legacy.transitive), `${file.path}: transitive`);
      assert.equal(ported.count, legacy.count, `${file.path}: count`);
      assert.equal(ported.transitiveCount, legacy.transitiveCount, `${file.path}: transitiveCount`);
      assert.equal(ported.percent, legacy.percent, `${file.path}: percent`);
      assert.equal(ported.level, legacy.level, `${file.path}: level`);
      assert.equal(ported.depth, legacy.depth, `${file.path}: depth`);
      assert.equal(ported.fnsUsed, legacy.fnsUsed, `${file.path}: fnsUsed`);
      assert.equal(ported.totalCalls, legacy.totalCalls, `${file.path}: totalCalls`);
      assert.deepEqual(new Set(ported.dependencies), new Set(legacy.dependencies), `${file.path}: dependencies`);
      assert.equal(ported.impactScore, legacy.impactScore, `${file.path}: impactScore`);
      assert.equal(ported.centrality, legacy.centrality, `${file.path}: centrality`);
    }
  });
}

test('calcBlastFromGraph returns a low-impact zero result for a file with no connections', async () => {
  const analysisData = {
    folders: [''],
    files: [{ path: 'lonely.py', name: 'lonely.py', folder: '', functions: [], lines: 1, layer: 'ui', churn: null }],
    connections: [],
  };
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const result = calcBlastFromGraph('lonely.py', graph);
  assert.equal(result.count, 0);
  assert.equal(result.level, 'low');
  assert.equal(result.impactScore, 0);
});
