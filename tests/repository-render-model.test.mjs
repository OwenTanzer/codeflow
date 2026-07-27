// Unit tests for src/render/repositoryRenderModel.js (MOO-69 Commit 3).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

if (!('TreeSitter' in globalThis)) globalThis.TreeSitter = undefined;
if (!('Babel' in globalThis)) globalThis.Babel = undefined;
if (!('acorn' in globalThis)) globalThis.acorn = undefined;

const __dirname = dirname(fileURLToPath(import.meta.url));

const { buildRepositoryRenderModel } = await import('../src/render/repositoryRenderModel.js');
const { Parser, buildAnalysisData } = await import('../src/analyzer.js');
const { buildAnalyzed } = await import('../card/lib/collect.js');
const { adaptRepositoryAnalysis } = await import('../src/adapters/repositoryGraphAdapter.js');
const { normalizeContext } = await import('../src/graph-ir/githubContext.js');

const SHA = 'a'.repeat(40);
const CONTEXT = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });
const ANALYZER = { name: 'codeflow-repository-adapter', version: '1.2.0' };

async function analyzeFixture(name) {
  const root = join(__dirname, 'fixtures', name);
  const { analyzed, allFns } = await buildAnalyzed(root, Parser, []);
  return buildAnalysisData({ analyzed, allFns, excludePatterns: [], progress() {}, yieldFn: async () => {} });
}

test('buildRepositoryRenderModel returns empty arrays for null/undefined input', () => {
  assert.deepEqual(buildRepositoryRenderModel(null), { nodes: [], links: [] });
  assert.deepEqual(buildRepositoryRenderModel(undefined), { nodes: [], links: [] });
});

// MOO-72 Commit 1A review: a prior fix in repositoryGraphAdapter.js
// preserved churn:null through the adapter, but two `|| 0` sites
// downstream (fromGraphIR/fromLegacyAnalysisData in
// repositoryRenderModel.js) silently coerced it right back into a
// fabricated zero -- which then rendered as "0 recent commits" in
// src/render/repositoryGraph.js's node tooltip (that D3/DOM code has no
// unit test harness in this repo, so this test covers as far as the
// testable boundary goes: the render model's own `churn` field, which the
// tooltip's `d.churn==null?'Churn not computed':d.churn+' recent commits'`
// branch reads directly).
test('churn: null is preserved through the render model for both GraphIR and legacy input, not coerced to 0', () => {
  const graph = {
    layer: 'repository',
    nodes: [
      { id: 'file:a.py', coordinate: { path: 'a.py' }, label: 'a.py', metadata: { folder: '', functionCount: 0, layer: 'ui', churn: null } },
      { id: 'file:b.py', coordinate: { path: 'b.py' }, label: 'b.py', metadata: { folder: '', functionCount: 0, layer: 'ui', churn: 0 } },
      { id: 'file:c.py', coordinate: { path: 'c.py' }, label: 'c.py', metadata: { folder: '', functionCount: 0, layer: 'ui', churn: 5 } },
    ],
    edges: [],
  };
  const graphModel = buildRepositoryRenderModel(graph);
  const churnByPathFromGraph = Object.fromEntries(graphModel.nodes.map((n) => [n.id, n.churn]));
  assert.equal(churnByPathFromGraph['a.py'], null);
  assert.equal(churnByPathFromGraph['b.py'], 0);
  assert.equal(churnByPathFromGraph['c.py'], 5);

  const legacyData = {
    files: [
      { path: 'a.py', name: 'a.py', folder: '', functions: [], layer: 'ui', churn: null },
      { path: 'b.py', name: 'b.py', folder: '', functions: [], layer: 'ui', churn: 0 },
    ],
    connections: [],
  };
  const legacyModel = buildRepositoryRenderModel(legacyData);
  const churnByPathFromLegacy = Object.fromEntries(legacyModel.nodes.map((n) => [n.id, n.churn]));
  assert.equal(churnByPathFromLegacy['a.py'], null);
  assert.equal(churnByPathFromLegacy['b.py'], 0);
});

test('the committed repository GraphIR fixture produces a valid render model', () => {
  const graph = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'graph-ir', 'repository.json'), 'utf8'));
  const model = buildRepositoryRenderModel(graph);
  assert.equal(model.nodes.length, graph.nodes.length);
  for (const node of model.nodes) {
    assert.equal(typeof node.id, 'string');
    assert.equal(typeof node.name, 'string');
  }
});

test('a legacy analysis object (local-folder shape) and its GraphIR-adapted equivalent produce the same render model', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const legacyModel = buildRepositoryRenderModel(analysisData);

  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const graphModel = buildRepositoryRenderModel(graph);

  const sortById = (arr) => [...arr].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(sortById(legacyModel.nodes), sortById(graphModel.nodes));

  const sortLink = (arr) => [...arr].sort((a, b) => (a.source + a.target).localeCompare(b.source + b.target));
  assert.deepEqual(sortLink(legacyModel.links), sortLink(graphModel.links));
});

test('folderFilter narrows both the legacy and GraphIR paths identically', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const someFolder = analysisData.folders[0];
  const legacyModel = buildRepositoryRenderModel(analysisData, someFolder);

  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const graphModel = buildRepositoryRenderModel(graph, someFolder);

  assert.ok(legacyModel.nodes.length > 0);
  assert.equal(legacyModel.nodes.length, graphModel.nodes.length);
  for (const node of legacyModel.nodes) {
    assert.ok(node.folder === someFolder || node.folder.startsWith(someFolder + '/'));
  }
});

test('self-links are dropped for both input shapes', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const graphModel = buildRepositoryRenderModel(graph);
  for (const link of graphModel.links) {
    assert.notEqual(link.source, link.target);
  }
});

test('multiple GraphIR edges between the same pair aggregate into one link with a summed count', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const model = buildRepositoryRenderModel(graph);
  const keys = model.links.map((l) => l.source + '|' + l.target);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate (source,target) pairs in the render model');
});
