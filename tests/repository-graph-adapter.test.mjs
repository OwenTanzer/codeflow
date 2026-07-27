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
const ANALYZER = { name: 'codeflow-repository-adapter', version: '1.2.0' };

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

// MOO-72 Commit 1A: folder tree and exclude-pattern display are cheap,
// deterministic derivatives of the file set/request options -- preserved
// during the server cutover rather than dropped, per the confirmed scope
// decision that only *expensive* enrichment (real per-file churn) defers.
test('folder tree and exclude patterns survive under graph metadata', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  assert.deepEqual(graph.metadata.folders, analysisData.folders);
  assert.deepEqual(graph.metadata.tree, analysisData.tree);
  assert.deepEqual(graph.metadata.excludePatterns, analysisData.excludePatterns);
});

// MOO-72 Commit 1A: the file-detail panel's "Functions" card is a primary,
// constantly-used UI feature (not an optional enrichment like churn), so
// full per-function detail and call-count stats are carried forward
// verbatim rather than reduced to the per-node functionCount summary.
test('full function list and per-function call stats survive under graph metadata', async () => {
  const analysisData = await analyzeFixture('golden-world');
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  assert.deepEqual(graph.metadata.functions, analysisData.functions);
  assert.ok(graph.metadata.functions.length > 0, 'fixture must have real functions to compare');
  assert.ok(graph.metadata.functions.every((fn) => typeof fn.file === 'string'), 'each function must carry its owning file path');

  // MOO-72 Commit 1A review: fnStats deliberately does NOT carry `.code`
  // verbatim -- it's an exact duplicate of the matching functions[] entry's
  // own `.code`, stripped here to avoid serializing every function's
  // source text twice (rehydrated client-side by
  // repositoryGraphToViewModel.js, see tests/repository-graph-to-view-model.test.mjs).
  const { code: _unusedA, ...analysisFnStatWithoutCode } = Object.values(analysisData.fnStats)[0];
  const { code: _unusedB, ...adaptedFnStatWithoutCode } = Object.values(graph.metadata.fnStats)[0];
  assert.deepEqual(adaptedFnStatWithoutCode, analysisFnStatWithoutCode, 'every field except code must survive verbatim');
  assert.ok(
    Object.values(graph.metadata.fnStats).every((stat) => !('code' in stat)),
    'fnStats entries must not carry a code field at all'
  );
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

// MOO-72 Commit 1A: server-sourced analysis reports churn as null (not
// computed) rather than a fabricated 0, since it never fetches per-file
// commit history. A prior version of this adapter used `file.churn || 0`,
// which silently converted that null back into a fake zero via JS
// truthiness -- exactly the bug this regression test exists to catch.
// Uses a minimal synthetic analysisData rather than the fixture pipeline,
// since the fixture harness always produces real numeric churn and can't
// exercise the null case.
test('churn: null is preserved, not coerced back into a fabricated 0', () => {
  const analysisData = {
    folders: [''],
    files: [
      { path: 'a.py', name: 'a.py', folder: '', functions: [], lines: 1, layer: 'ui', churn: null },
      { path: 'b.py', name: 'b.py', folder: '', functions: [], lines: 1, layer: 'ui', churn: 0 },
      { path: 'c.py', name: 'c.py', folder: '', functions: [], lines: 1, layer: 'ui', churn: 5 },
    ],
    connections: [],
  };
  const graph = adaptRepositoryAnalysis({ analysisData, context: CONTEXT, analyzer: ANALYZER });
  const churnByPath = Object.fromEntries(
    graph.nodes.map((n) => [n.coordinate.path, n.metadata.churn])
  );
  assert.equal(churnByPath['a.py'], null, 'not-computed churn must stay null, not become 0');
  assert.equal(churnByPath['b.py'], 0, 'a real zero-churn file must stay 0');
  assert.equal(churnByPath['c.py'], 5, 'a real positive churn count must pass through unchanged');
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
