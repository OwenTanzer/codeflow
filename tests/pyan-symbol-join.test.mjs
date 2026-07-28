// Unit tests for server/lib/pyanSymbolJoin.js (MOO-70 Commit 4).
//
// Runs the real Commit 1-3 pipeline (tree-sitter index -> pyan3 subprocess
// -> DOT parse) wherever a real Python fixture can exercise the join
// outcome, and falls back to hand-built synthetic inputs only for the two
// failure modes that can't be triggered from valid Python source
// (unresolved, ambiguous).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { relative } from 'node:path';
import { WorkspaceManager } from '../server/lib/workspace.js';
import { stagePythonFiles, runPyan3 } from '../server/lib/pyan3Adapter.js';
import { parseDotGraph, extractPyanNodes, extractPyanEdges } from '../server/lib/dotGraph.js';
import { indexPythonSymbols } from '../server/lib/pythonSymbolIndex.js';
import { joinPyanToSymbols } from '../server/lib/pyanSymbolJoin.js';
import { normalizePath } from '../src/graph-ir/sourceCoordinate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/python-symbols');
const PACKAGE_FIXTURES = join(__dirname, 'fixtures/python-symbols-package');
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

async function runPipeline(files) {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-join-test-'));
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-1');
    const absolutePaths = await stagePythonFiles(ws, files);
    const result = await runPyan3({ pythonBin: PYTHON_BIN, workspace: ws, absolutePaths, timeoutMs: 15_000 });
    const digraph = parseDotGraph(result.dot);
    const pyanNodes = extractPyanNodes(digraph);
    const pyanEdges = extractPyanEdges(digraph);

    const symbolEntries = [];
    for (const file of files) {
      const indexed = await indexPythonSymbols({ path: file.path, content: file.content });
      symbolEntries.push(...indexed.entries);
    }

    return joinPyanToSymbols({ pyanNodes, pyanEdges, symbolEntries, workspaceDir: ws.dir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fileOf(name) {
  return { path: name, content: readFileSync(join(FIXTURES, name), 'utf8') };
}

// MOO-72 Commit 4: the shared in-flight pyan3 registry (server/routes/graph-file.js's
// runSharedPyan3Analysis) converts pyanNodes' workspace-absolute paths to
// repo-relative before its shared workspace is torn down, then joins with
// no workspaceDir at all. This proves that pre-relativized join is
// identical to the existing workspaceDir-based join, not a silent behavior
// change for the (still fully supported) per-caller workspace path.
test('joinPyanToSymbols: pre-relativized paths + no workspaceDir match the workspaceDir-based join exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-join-relative-test-'));
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-1');
    const files = [fileOf('nested.py')];
    const absolutePaths = await stagePythonFiles(ws, files);
    const result = await runPyan3({ pythonBin: PYTHON_BIN, workspace: ws, absolutePaths, timeoutMs: 15_000 });
    const digraph = parseDotGraph(result.dot);
    const pyanNodes = extractPyanNodes(digraph);
    const pyanEdges = extractPyanEdges(digraph);
    const symbolEntries = [];
    for (const file of files) {
      const indexed = await indexPythonSymbols({ path: file.path, content: file.content });
      symbolEntries.push(...indexed.entries);
    }

    const viaWorkspaceDir = joinPyanToSymbols({ pyanNodes, pyanEdges, symbolEntries, workspaceDir: ws.dir });

    const relativized = pyanNodes.map((n) => (n.path ? { ...n, path: normalizePath(relative(ws.dir, n.path)) } : n));
    const viaPreRelativized = joinPyanToSymbols({ pyanNodes: relativized, pyanEdges, symbolEntries });

    assert.equal(viaPreRelativized.stats.matchedCount, viaWorkspaceDir.stats.matchedCount);
    assert.equal(viaPreRelativized.stats.unresolvedCount, viaWorkspaceDir.stats.unresolvedCount);
    assert.equal(viaPreRelativized.stats.ambiguousCount, viaWorkspaceDir.stats.ambiguousCount);
    assert.deepEqual(
      viaPreRelativized.resolved.map((r) => r.matchState),
      viaWorkspaceDir.resolved.map((r) => r.matchState)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nested.py: every symbol matches, no unresolved/ambiguous entries', async () => {
  const joined = await runPipeline([fileOf('nested.py')]);
  assert.equal(joined.stats.unresolvedCount, 0);
  assert.equal(joined.stats.ambiguousCount, 0);
  assert.equal(joined.stats.symbolOnlyCount, 0);
  assert.equal(joined.stats.warnings.length, 0);

  const helper = joined.resolved.find((r) => r.symbol && r.symbol.qualifiedName === 'nested.Outer.run.helper');
  assert.equal(helper.matchState, 'matched');
  assert.equal(helper.pyanNode.qualifiedName, 'nested.Outer.run.helper');
});

test('repeated_names.py: same short name in different scopes both match distinctly', async () => {
  const joined = await runPipeline([fileOf('repeated_names.py')]);
  assert.equal(joined.stats.matchedCount, joined.resolved.length);

  const alphaRun = joined.resolved.find((r) => r.symbol && r.symbol.qualifiedName === 'repeated_names.Alpha.run');
  const betaRun = joined.resolved.find((r) => r.symbol && r.symbol.qualifiedName === 'repeated_names.Beta.run');
  assert.equal(alphaRun.matchState, 'matched');
  assert.equal(betaRun.matchState, 'matched');
  assert.notEqual(alphaRun.pyanNode.id, betaRun.pyanNode.id);
});

test('calls.py: the real uses edge survives the join unchanged', async () => {
  const joined = await runPipeline([fileOf('calls.py')]);
  const usesEdges = joined.edges.filter((e) => e.kind === 'uses');
  assert.equal(usesEdges.length, 1);

  const bySymbolId = new Map(joined.resolved.filter((r) => r.pyanNode).map((r) => [r.pyanNode.id, r.symbol]));
  assert.equal(bySymbolId.get(usesEdges[0].source).qualifiedName, 'calls.Greeter.greet');
  assert.equal(bySymbolId.get(usesEdges[0].target).qualifiedName, 'calls.Greeter.build_message');
});

test('package fixture: cross-file uses edge (mod_b.make_widget -> mod_a.Widget) resolves correctly', async () => {
  const files = readdirSync(PACKAGE_FIXTURES)
    .filter((name) => name.endsWith('.py'))
    .map((name) => ({ path: join('pkg', name), content: readFileSync(join(PACKAGE_FIXTURES, name), 'utf8') }));
  const joined = await runPipeline(files);

  assert.equal(joined.stats.unresolvedCount, 0);
  assert.equal(joined.stats.ambiguousCount, 0);

  const bySymbolId = new Map(joined.resolved.filter((r) => r.pyanNode).map((r) => [r.pyanNode.id, r.symbol]));
  const crossFileEdge = joined.edges.find(
    (e) => e.kind === 'uses' && bySymbolId.get(e.source)?.qualifiedName === 'pkg.mod_b.make_widget'
  );
  assert.ok(crossFileEdge, 'expected a uses edge from mod_b.make_widget');
  assert.equal(bySymbolId.get(crossFileEdge.target).qualifiedName, 'pkg.mod_a.Widget');
});

test('external_refs.py: unresolvable imports/undefined calls produce no extra node, no error', async () => {
  const joined = await runPipeline([fileOf('external_refs.py')]);

  // Only the module + its two real defined functions -- nothing for
  // requests.get, helper_func, or totally_undefined_name.
  assert.equal(joined.resolved.length, 3);
  assert.equal(joined.stats.unresolvedCount, 0);
  assert.equal(joined.stats.ambiguousCount, 0);
  assert.equal(joined.stats.symbolOnlyCount, 0);

  const qualifiedNames = joined.resolved.map((r) => r.symbol.qualifiedName).sort();
  assert.deepEqual(qualifiedNames, ['external_refs', 'external_refs.call_undefined', 'external_refs.fetch_data']);
});

test('synthetic: a pyan3 node with no matching symbol-index entry is unresolved', () => {
  const joined = joinPyanToSymbols({
    pyanNodes: [{ id: 'mod__ghost', label: 'ghost', qualifiedName: 'mod.ghost', path: null, line: null, kind: 'function', parentScope: 'mod' }],
    pyanEdges: [],
    symbolEntries: [],
    workspaceDir: '/workspace',
  });
  assert.equal(joined.stats.unresolvedCount, 1);
  assert.equal(joined.resolved[0].matchState, 'unresolved');
  assert.equal(joined.resolved[0].symbol, null);
});

test('synthetic: two symbol-index entries sharing one qualifiedName make the pyan3 node ambiguous', () => {
  const dupSymbol = (path) => ({
    path,
    moduleId: 'mod',
    qualifiedName: 'mod.dup',
    shortName: 'dup',
    symbolKind: 'function',
    symbolPath: ['dup'],
    parentScope: 'mod',
    startLine: 1,
    startColumn: 0,
    endLine: 2,
    endColumn: 0,
    decorators: [],
    isAsync: false,
  });
  const joined = joinPyanToSymbols({
    pyanNodes: [{ id: 'mod__dup', label: 'dup', qualifiedName: 'mod.dup', path: null, line: null, kind: 'function', parentScope: 'mod' }],
    pyanEdges: [],
    symbolEntries: [dupSymbol('mod.py'), dupSymbol('mod_copy.py')],
    workspaceDir: '/workspace',
  });
  assert.equal(joined.stats.ambiguousCount, 1);
  assert.equal(joined.resolved.find((r) => r.pyanNode).matchState, 'ambiguous');
});

test('synthetic: same-name redefinitions at different lines (typing.overload/@property stubs) tie-break to the last one, not ambiguous', () => {
  // Confirmed necessary against a real fixture (psf/requests' models.py:
  // typing.overload stubs for _encode_params/iter_content/iter_lines,
  // each a distinct function_definition tree-sitter sees but which pyan3
  // collapses to one node -- Python's own last-definition-wins semantics
  // for a repeated name in one scope, matched here rather than treating
  // every such case as ambiguous.
  const overloadStub = (startLine) => ({
    path: 'mod.py',
    moduleId: 'mod',
    qualifiedName: 'mod.Widget.encode',
    shortName: 'encode',
    symbolKind: 'method',
    symbolPath: ['Widget', 'encode'],
    parentScope: 'mod.Widget',
    startLine,
    startColumn: 4,
    endLine: startLine + 1,
    endColumn: 0,
    decorators: ['@overload'],
    isAsync: false,
  });
  const joined = joinPyanToSymbols({
    pyanNodes: [{ id: 'mod__Widget__encode', label: 'encode', qualifiedName: 'mod.Widget.encode', path: null, line: null, kind: 'method', parentScope: 'mod.Widget' }],
    pyanEdges: [],
    symbolEntries: [overloadStub(10), overloadStub(14), overloadStub(18)],
    workspaceDir: '/workspace',
  });

  assert.equal(joined.stats.ambiguousCount, 0);
  assert.equal(joined.stats.matchedCount, 1);
  assert.equal(joined.stats.symbolOnlyCount, 0, 'the two earlier overload stubs must not surface as duplicate symbolOnly nodes');
  const matched = joined.resolved.find((r) => r.pyanNode);
  assert.equal(matched.matchState, 'matched');
  assert.equal(matched.symbol.startLine, 18, 'the last-defined stub wins, matching Python\'s actual name-shadowing semantics');
});

test('synthetic: a genuine path mismatch is unresolved, not matched-with-a-warning', () => {
  // PR review finding: a prior version matched purely on qualifiedName and
  // only warned on a path/kind disagreement, still returning matchState:
  // 'matched' with that candidate's exact (wrong) coordinate. A real path
  // mismatch must now correctly fail to match at all.
  const joined = joinPyanToSymbols({
    pyanNodes: [{ id: 'mod__thing', label: 'thing', qualifiedName: 'mod.thing', path: '/workspace/mod.py', line: 3, kind: 'function', parentScope: 'mod' }],
    pyanEdges: [],
    symbolEntries: [
      {
        path: 'different_file.py', // disagrees with pyan3's reported path
        moduleId: 'mod',
        qualifiedName: 'mod.thing',
        shortName: 'thing',
        symbolKind: 'function',
        symbolPath: ['thing'],
        parentScope: 'mod',
        startLine: 3,
        startColumn: 0,
        endLine: 4,
        endColumn: 0,
        decorators: [],
        isAsync: false,
      },
    ],
    workspaceDir: '/workspace',
  });
  assert.equal(joined.stats.matchedCount, 0);
  assert.equal(joined.stats.unresolvedCount, 1);
  assert.equal(joined.resolved[0].matchState, 'unresolved');
  assert.equal(joined.resolved[0].symbol, null, 'no coordinate is attached when the only candidate disagreed with pyan3');
});

test('synthetic: a genuine kind mismatch (incompatible kind, not staticmethod/classmethod) is unresolved, not matched-with-a-warning', () => {
  const joined = joinPyanToSymbols({
    pyanNodes: [{ id: 'mod__Thing', label: 'Thing', qualifiedName: 'mod.Thing', path: '/workspace/mod.py', line: 1, kind: 'class', parentScope: null }],
    pyanEdges: [],
    symbolEntries: [
      {
        path: 'mod.py',
        moduleId: 'mod',
        qualifiedName: 'mod.Thing',
        shortName: 'Thing',
        symbolKind: 'function', // pyan3 says class, tree-sitter says function -- a real mismatch
        symbolPath: ['Thing'],
        parentScope: 'mod',
        startLine: 1,
        startColumn: 0,
        endLine: 2,
        endColumn: 0,
        decorators: [],
        isAsync: false,
      },
    ],
    workspaceDir: '/workspace',
  });
  assert.equal(joined.stats.matchedCount, 0);
  assert.equal(joined.stats.unresolvedCount, 1);
});

test('synthetic: staticmethod/classmethod are compatible with our canonical "method" kind, not treated as a mismatch', () => {
  const joined = joinPyanToSymbols({
    pyanNodes: [{ id: 'mod__Thing__build', label: 'build', qualifiedName: 'mod.Thing.build', path: '/workspace/mod.py', line: 2, kind: 'staticmethod', parentScope: 'mod.Thing' }],
    pyanEdges: [],
    symbolEntries: [
      {
        path: 'mod.py',
        moduleId: 'mod',
        qualifiedName: 'mod.Thing.build',
        shortName: 'build',
        symbolKind: 'method',
        symbolPath: ['Thing', 'build'],
        parentScope: 'mod.Thing',
        startLine: 2,
        startColumn: 4,
        endLine: 3,
        endColumn: 0,
        decorators: ['@staticmethod'],
        isAsync: false,
      },
    ],
    workspaceDir: '/workspace',
  });
  assert.equal(joined.stats.matchedCount, 1);
  assert.equal(joined.resolved[0].matchState, 'matched');
});

test('symbolOnly: tree-sitter succeeds on syntax_error.py while pyan3 produces nothing for it', async () => {
  const content = readFileSync(join(FIXTURES, 'syntax_error.py'), 'utf8');
  const indexed = await indexPythonSymbols({ path: 'syntax_error.py', content });

  const joined = joinPyanToSymbols({
    pyanNodes: [],
    pyanEdges: [],
    symbolEntries: indexed.entries,
    workspaceDir: '/workspace',
  });

  assert.equal(joined.stats.symbolOnlyCount, indexed.entries.length);
  const solo = joined.resolved.find((r) => r.symbol && r.symbol.qualifiedName === 'syntax_error.solo');
  assert.equal(solo.matchState, 'symbolOnly');
  assert.equal(solo.pyanNode, null);
});
