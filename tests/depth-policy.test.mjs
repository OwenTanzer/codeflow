// Unit tests for src/graph-ir/depthPolicy.js (MOO-70 Commit 6).
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
import { adaptFileAnalysis } from '../src/adapters/fileGraphAdapter.js';
import { normalizeContext } from '../src/graph-ir/githubContext.js';
import { isNodeVisibleAtDepth, selectInitialMode, applyDepthMode, chooseDepthMode } from '../src/graph-ir/depthPolicy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/python-symbols');
const PACKAGE_FIXTURES = join(__dirname, 'fixtures/python-symbols-package');
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

const SHA = 'a'.repeat(40);
const CONTEXT = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });
const ANALYZER = { name: 'codeflow-pyan3-adapter', version: '1.0.0' };

function fileOf(name) {
  return { path: name, content: readFileSync(join(FIXTURES, name), 'utf8') };
}

async function buildFullGraph(files, requestPath) {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-depth-test-'));
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

    const joined = joinPyanToSymbols({ pyanNodes, pyanEdges, symbolEntries, workspaceDir: ws.dir });
    const graph = adaptFileAnalysis({ context: CONTEXT, requestPath: requestPath || files[0].path, joined, analyzer: ANALYZER });
    return { graph, totalSymbolCount: symbolEntries.length };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('applyDepthMode: nested.py per-mode visibility matches the depth cutoffs', async () => {
  const { graph } = await buildFullGraph([fileOf('nested.py')]);
  const labelsAt = (mode) => applyDepthMode(graph, mode).nodes.map((n) => n.label).sort();

  assert.deepEqual(labelsAt('modules'), ['nested']);
  assert.deepEqual(labelsAt('symbols'), ['Outer', 'nested']);
  assert.deepEqual(labelsAt('methods'), ['Inner', 'Outer', 'nested', 'run']);
  assert.deepEqual(labelsAt('full'), ['Inner', 'Outer', 'helper', 'nested', 'run', 'run']);
});

test('applyDepthMode: edges are dropped when either endpoint is filtered out', async () => {
  const { graph } = await buildFullGraph([fileOf('nested.py')]);
  const modulesOnly = applyDepthMode(graph, 'modules');
  assert.equal(modulesOnly.edges.length, 0);

  const full = applyDepthMode(graph, 'full');
  assert.equal(full.edges.length, graph.edges.length);
});

test('unresolved/ambiguous nodes (coordinate: null) stay visible in every mode', () => {
  const unresolvedNode = { id: 'x', coordinate: null };
  for (const mode of ['modules', 'symbols', 'methods', 'full']) {
    assert.equal(isNodeVisibleAtDepth(unresolvedNode, mode), true);
  }
});

test('selectInitialMode: package requests always start at modules', () => {
  assert.equal(selectInitialMode({ requestKind: 'package', totalSymbolCount: 3 }), 'modules');
  assert.equal(selectInitialMode({ requestKind: 'package', totalSymbolCount: 500 }), 'modules');
});

test('selectInitialMode: file requests split on the small-file symbol-count threshold', () => {
  assert.equal(selectInitialMode({ requestKind: 'file', totalSymbolCount: 5 }), 'methods');
  assert.equal(selectInitialMode({ requestKind: 'file', totalSymbolCount: 20 }), 'methods');
  assert.equal(selectInitialMode({ requestKind: 'file', totalSymbolCount: 21 }), 'symbols');
});

test('chooseDepthMode: small real fixtures auto-advance all the way to full', async () => {
  const { graph, totalSymbolCount } = await buildFullGraph([fileOf('nested.py')]);
  const chosen = chooseDepthMode({ graph, requestKind: 'file', totalSymbolCount });
  assert.equal(chosen.mode, 'full');
  assert.equal(chosen.manualOverride, false);
  assert.equal(chosen.nodeCount, graph.nodes.length);
});

test('chooseDepthMode: package fixture also auto-advances to full (small fixture, expected)', async () => {
  const files = readdirSync(PACKAGE_FIXTURES)
    .filter((name) => name.endsWith('.py'))
    .map((name) => ({ path: join('pkg', name), content: readFileSync(join(PACKAGE_FIXTURES, name), 'utf8') }));
  const { graph, totalSymbolCount } = await buildFullGraph(files, 'pkg');
  const chosen = chooseDepthMode({ graph, requestKind: 'package', totalSymbolCount });
  assert.equal(chosen.mode, 'full');
});

test('chooseDepthMode: an explicit override is respected exactly, with no auto-increase on top of it', async () => {
  const { graph, totalSymbolCount } = await buildFullGraph([fileOf('nested.py')]);
  const chosen = chooseDepthMode({ graph, requestKind: 'file', totalSymbolCount, override: 'modules' });
  assert.equal(chosen.mode, 'modules');
  assert.equal(chosen.manualOverride, true);
  assert.equal(chosen.nodeCount, 1);
});

// No committed fixture is large enough to exercise "stops at a coarser
// mode because the budget was exceeded" -- same limitation
// docs/repository-layer-density.md notes for its own threshold. Tested
// with a hand-built synthetic graph instead, mirroring Commit 4's
// synthetic unresolved/ambiguous tests for the same reason.
function syntheticNode(id, depth) {
  return { id, coordinate: { symbolPath: new Array(depth).fill('x') } };
}

test('chooseDepthMode: a large synthetic graph stops before full once the node budget would be exceeded', () => {
  const nodes = [
    ...Array.from({ length: 5 }, (_, i) => syntheticNode(`mod${i}`, 0)),
    ...Array.from({ length: 20 }, (_, i) => syntheticNode(`class${i}`, 1)),
    ...Array.from({ length: 40 }, (_, i) => syntheticNode(`method${i}`, 2)),
    ...Array.from({ length: 100 }, (_, i) => syntheticNode(`fn${i}`, 3)),
  ];
  const graph = { nodes, edges: [] };

  const chosen = chooseDepthMode({ graph, requestKind: 'package', totalSymbolCount: nodes.length, nodeBudget: 60, edgeBudget: 120 });

  // modules (5) -> symbols (25, within budget) -> methods would be 65 (> 60) -> stop at symbols
  assert.equal(chosen.mode, 'symbols');
  assert.equal(chosen.nodeCount, 25);
});
