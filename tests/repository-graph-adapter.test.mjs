// Unit tests for src/adapters/repositoryGraphAdapter.js (MOO-69 Commit 1).
//
// Runs the *real* analyzer pipeline (buildAnalysisData, via
// card/lib/collect.js's buildAnalyzed — same fixture-harness pattern
// tests/codeflow-golden.test.mjs uses) against tests/fixtures/golden-world,
// then adapts the real output, rather than adapting a hand-written fake
// analysis object — so this test would actually catch a field-name
// mismatch against src/analyzer.js's real shape.
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

if (!('TreeSitter' in globalThis)) globalThis.TreeSitter = undefined;
if (!('Babel' in globalThis)) globalThis.Babel = undefined;
if (!('acorn' in globalThis)) globalThis.acorn = undefined;

const __dirname = dirname(fileURLToPath(import.meta.url));

const { Parser, buildAnalysisData } = await import('../src/analyzer.js');
const { buildAnalyzed } = await import('../card/lib/collect.js');
const { adaptRepositoryAnalysis } = await import('../src/adapters/repositoryGraphAdapter.js');
const { validateGraphIR } = await import('../src/graph-ir/graphIR.js');
const { normalizeContext } = await import('../src/graph-ir/githubContext.js');

const SHA = 'a'.repeat(40);
const CONTEXT = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });
const ANALYZER = { name: 'codeflow-repository-adapter', version: '1.0.0' };

async function analyzeFixture(name) {
  const root = join(__dirname, 'fixtures', name);
  const { analyzed, allFns } = await buildAnalyzed(root, Parser, []);
  return buildAnalysisData({ analyzed, allFns, excludePatterns: [], progress() {}, yieldFn: async () => {} });
}

test('golden-world adapts into a schema-valid repository GraphIR', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const { valid, errors } = validateGraphIR(graph);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
  assert.equal(graph.layer, 'repository');
});

test('file and connection counts match the pre-adapter baseline (nothing silently dropped)', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  assert.equal(graph.nodes.length, analysisData.files.length);
  assert.equal(graph.edges.length, analysisData.connections.length);
});

test('every file becomes a node whose coordinate names its real repo-relative path', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const paths = new Set(analysisData.files.map((f) => f.path));
  for (const node of graph.nodes) {
    assert.ok(paths.has(node.coordinate.path), `node ${node.id} coordinate.path ${node.coordinate.path} should be a real file path`);
    assert.equal(node.coordinate.revision, SHA);
  }
});

test('folders become groups, and files are attached to their folder group', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  assert.equal(graph.groups.length, analysisData.folders.length);
  for (const file of analysisData.files) {
    const node = graph.nodes.find((n) => n.id === `file:${file.path}`);
    assert.equal(node.groupId, `folder:${file.folder}`);
  }
});

test('markdown-link connections keep their distinct edge kind, separate from call-graph edges', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const linkConns = analysisData.connections.filter((c) => c.kind);
  if (linkConns.length > 0) {
    const linkEdges = graph.edges.filter((e) => e.kind !== 'calls');
    assert.equal(linkEdges.length, linkConns.length);
  }
});

test('repository-wide summaries (issues, patterns, architecture diagram, stats) survive under graph metadata', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  assert.deepEqual(graph.metadata.stats, analysisData.stats);
  assert.deepEqual(graph.metadata.issues, analysisData.issues);
  assert.deepEqual(graph.metadata.architectureDiagram, analysisData.architectureDiagram);
});

test('node metadata carries forward function count, lines, and layer the existing renderer/detail-panel reads', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const file = analysisData.files[0];
  const node = graph.nodes.find((n) => n.id === `file:${file.path}`);
  assert.equal(node.metadata.functionCount, file.functions.length);
  assert.equal(node.metadata.lines, file.lines);
  assert.equal(node.metadata.layer, file.layer);
});

test('rootCoordinate is null for a whole-repository graph', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  assert.equal(graph.rootCoordinate, null);
});

test('a second fixture (web-app-world) also adapts to a schema-valid graph', async () => {
  const analysisData = await analyzeFixture('web-app-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  assert.equal(validateGraphIR(graph).valid, true);
  assert.equal(graph.nodes.length, analysisData.files.length);
});
