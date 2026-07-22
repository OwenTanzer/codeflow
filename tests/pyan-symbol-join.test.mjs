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

import { WorkspaceManager } from '../server/lib/workspace.js';
import { stagePythonFiles, runPyan3 } from '../server/lib/pyan3Adapter.js';
import { parseDotGraph, extractPyanNodes, extractPyanEdges } from '../server/lib/dotGraph.js';
import { indexPythonSymbols } from '../server/lib/pythonSymbolIndex.js';
import { joinPyanToSymbols } from '../server/lib/pyanSymbolJoin.js';

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
