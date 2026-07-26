// Unit tests for src/adapters/repositoryGraphToViewModel.js (MOO-72 Commit 1A).
//
// Round-trips a real fixture through adaptRepositoryAnalysis (the server's
// own conversion) and back through repositoryGraphToViewModel, then
// compares the reconstructed view model against the original
// buildAnalysisData() output every legacy UI consumer already reads --
// proving the boundary mapper doesn't silently drop or reshape anything
// those consumers depend on. Same fixture-harness pattern as
// tests/repository-graph-adapter.test.mjs.
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
const { repositoryGraphToViewModel } = await import('../src/adapters/repositoryGraphToViewModel.js');
const { normalizeContext } = await import('../src/graph-ir/githubContext.js');

const SHA = 'a'.repeat(40);
const CONTEXT = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });
const ANALYZER = { name: 'codeflow-repository-adapter', version: '1.0.0' };

async function analyzeFixture(name) {
  const root = join(__dirname, 'fixtures', name);
  const { analyzed, allFns } = await buildAnalyzed(root, Parser, []);
  return buildAnalysisData({ analyzed, allFns, excludePatterns: [], progress() {}, yieldFn: async () => {} });
}

test('files: path/name/folder/layer/lines/complexity/parserProvenance/dependencies/isCode survive the round trip', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const viewModel = repositoryGraphToViewModel(graph);

  assert.equal(viewModel.files.length, analysisData.files.length);
  const byPath = new Map(viewModel.files.map((f) => [f.path, f]));
  for (const original of analysisData.files) {
    const reconstructed = byPath.get(original.path);
    assert.ok(reconstructed, `${original.path} must survive the round trip`);
    assert.equal(reconstructed.name, original.name);
    assert.equal(reconstructed.folder, original.folder);
    assert.equal(reconstructed.layer, original.layer);
    assert.equal(reconstructed.lines, original.lines);
    assert.equal(reconstructed.isCode, original.isCode !== false);
    assert.deepEqual(reconstructed.complexity, original.complexity || null);
    assert.deepEqual(reconstructed.parserProvenance, original.parserProvenance || null);
    assert.deepEqual(reconstructed.dependencies, original.dependencies || []);
    assert.equal(reconstructed.functions.length, original.functions.length, `${original.path}: function count`);
  }
});

test('connections: source/target/fn/count survive the round trip (as real file paths, not node ids)', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const viewModel = repositoryGraphToViewModel(graph);

  assert.equal(viewModel.connections.length, analysisData.connections.length);
  const paths = new Set(analysisData.files.map((f) => f.path));
  for (const conn of viewModel.connections) {
    assert.ok(paths.has(conn.source), `connection source ${conn.source} must be a real file path, not a node id`);
    assert.ok(paths.has(conn.target), `connection target ${conn.target} must be a real file path, not a node id`);
  }
  // Every original connection's (fn, count) pair must appear somewhere in
  // the reconstructed list -- order isn't guaranteed to match since the
  // adapter/mapper don't promise stable ordering.
  const reconstructedPairs = new Set(viewModel.connections.map((c) => `${c.fn}:${c.count}`));
  for (const original of analysisData.connections) {
    assert.ok(reconstructedPairs.has(`${original.fn}:${original.count}`), `connection ${original.fn}:${original.count} must survive`);
  }
});

test('fnStats and functions survive verbatim (needed by the file-detail Functions card)', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const viewModel = repositoryGraphToViewModel(graph);

  assert.deepEqual(viewModel.fnStats, analysisData.fnStats);
  assert.equal(viewModel.functions.length, analysisData.functions.length);
});

test('repository-wide summaries (stats, patterns, security, duplicates, dead functions, architecture diagram, folders, tree, excludePatterns) survive', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const viewModel = repositoryGraphToViewModel(graph);

  assert.deepEqual(viewModel.stats, analysisData.stats);
  assert.deepEqual(viewModel.patterns, analysisData.patterns);
  assert.deepEqual(viewModel.securityIssues, analysisData.securityIssues);
  assert.deepEqual(viewModel.duplicates, analysisData.duplicates);
  assert.deepEqual(viewModel.deadFunctions, analysisData.deadFunctions);
  assert.deepEqual(viewModel.architectureDiagram, analysisData.architectureDiagram);
  assert.deepEqual(viewModel.folders, analysisData.folders);
  assert.deepEqual(viewModel.tree, analysisData.tree);
  assert.deepEqual(viewModel.excludePatterns, analysisData.excludePatterns);
  assert.deepEqual(viewModel.suggestions, analysisData.suggestions);
});

test('file content is always empty (never shipped to the client for server-sourced analysis)', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const viewModel = repositoryGraphToViewModel(graph);
  assert.ok(viewModel.files.every((f) => f.content === ''));
});
