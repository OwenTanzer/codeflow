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
const ANALYZER = { name: 'codeflow-repository-adapter', version: '1.2.0' };

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

// MOO-72 Commit 1A review: a `Set` of `fn:count` pairs can pass with a
// swapped source/target (since source/target were never part of the key),
// and a `Set` collapses genuine duplicate connections (e.g. two distinct
// file pairs that happen to call the same function the same number of
// times) into one, silently hiding a dropped connection. Canonicalize each
// connection with every distinguishing field and compare sorted multisets
// (arrays, not Sets) instead.
// Normalizes `kind`/`functionKey` the same way the adapter intentionally
// does (repositoryGraphAdapter.js: `conn.kind || 'calls'`,
// `conn.functionKey || null`) so this comparison isn't tripped up by that
// deliberate normalization -- the original analysisData.connections leaves
// call-graph edges' `kind`/`functionKey` unset entirely.
function canonicalizeConnection(c) {
  return `${c.source}|${c.target}|${c.kind || 'calls'}|${c.functionKey || null}|${c.fn}|${c.count}`;
}

test('connections: source/target/kind/functionKey/fn/count survive the round trip as a multiset (as real file paths, not node ids)', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const viewModel = repositoryGraphToViewModel(graph);

  assert.equal(viewModel.connections.length, analysisData.connections.length);
  const paths = new Set(analysisData.files.map((f) => f.path));
  for (const conn of viewModel.connections) {
    assert.ok(paths.has(conn.source), `connection source ${conn.source} must be a real file path, not a node id`);
    assert.ok(paths.has(conn.target), `connection target ${conn.target} must be a real file path, not a node id`);
  }

  const originalKeys = analysisData.connections.map(canonicalizeConnection).sort();
  const reconstructedKeys = viewModel.connections.map(canonicalizeConnection).sort();
  assert.deepEqual(reconstructedKeys, originalKeys, 'the full multiset of connections (including duplicates and correct source/target pairing) must survive the round trip');
});

test('fnStats and functions survive verbatim (needed by the file-detail Functions card)', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const viewModel = repositoryGraphToViewModel(graph);

  assert.deepEqual(viewModel.fnStats, analysisData.fnStats);
  assert.ok(Object.keys(analysisData.fnStats).length > 0, 'fixture must have real fnStats to compare');

  // MOO-72 Commit 1A review: a bare length check can pass even if the
  // reconstructed functions are a different set (e.g. duplicates, or one
  // function's full record swapped for another's) -- deep-compare each
  // function by its stable key instead.
  assert.equal(viewModel.functions.length, analysisData.functions.length);
  const originalByKey = new Map(analysisData.functions.map((fn) => [fn.key, fn]));
  const reconstructedByKey = new Map(viewModel.functions.map((fn) => [fn.key, fn]));
  assert.equal(reconstructedByKey.size, originalByKey.size, 'no duplicate or dropped function keys');
  for (const [key, original] of originalByKey) {
    assert.deepEqual(reconstructedByKey.get(key), original, `function ${key} must survive verbatim`);
  }
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
