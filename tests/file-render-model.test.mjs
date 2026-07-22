// Unit tests for src/render/fileRenderModel.js (MOO-70 Commit 8).
//
// Mirrors tests/repository-render-model.test.mjs's scope: pure
// GraphIR->render-model conversion. No legacy-shape test (unlike the
// repository layer, the file layer has no pre-GraphIR legacy format).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { buildFileRenderModel } from '../src/render/fileRenderModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/python-symbols');
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

const SHA = 'a'.repeat(40);
const CONTEXT = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });
const ANALYZER = { name: 'codeflow-pyan3-adapter', version: '1.0.0' };

async function buildGraph(fileName, { skipPyan = false } = {}) {
  const content = readFileSync(join(FIXTURES, fileName), 'utf8');
  const root = await mkdtemp(join(tmpdir(), 'codeflow-render-model-test-'));
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-1');
    const [absPath] = await stagePythonFiles(ws, [{ path: fileName, content }]);

    let pyanNodes = [];
    let pyanEdges = [];
    if (!skipPyan) {
      const result = await runPyan3({ pythonBin: PYTHON_BIN, workspace: ws, absolutePaths: [absPath], timeoutMs: 15_000 });
      const digraph = parseDotGraph(result.dot);
      pyanNodes = extractPyanNodes(digraph);
      pyanEdges = extractPyanEdges(digraph);
    }

    const indexed = await indexPythonSymbols({ path: fileName, content });
    const joined = joinPyanToSymbols({ pyanNodes, pyanEdges, symbolEntries: indexed.entries, workspaceDir: ws.dir });
    return adaptFileAnalysis({ context: CONTEXT, requestPath: fileName, joined, analyzer: ANALYZER });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('buildFileRenderModel returns empty arrays for null/undefined input', () => {
  assert.deepEqual(buildFileRenderModel(null), { nodes: [], links: [] });
  assert.deepEqual(buildFileRenderModel(undefined), { nodes: [], links: [] });
});

test('nested.py: node count matches the source graph, shape/colorRole pass through', async () => {
  const graph = await buildGraph('nested.py');
  const model = buildFileRenderModel(graph);
  assert.equal(model.nodes.length, graph.nodes.length);

  const outer = model.nodes.find((n) => n.label === 'Outer');
  assert.equal(outer.shape, 'diamond');
  assert.equal(outer.colorRole, 'default');

  const helper = model.nodes.find((n) => n.label === 'helper');
  assert.equal(helper.shape, 'rect');
});

test('nested.py: groupId nesting survives into the render model', async () => {
  const graph = await buildGraph('nested.py');
  const model = buildFileRenderModel(graph);

  const findByPath = (symbolPath) => graph.nodes.find((n) => n.coordinate && n.coordinate.symbolPath.join('.') === symbolPath);
  const innerNode = findByPath('Outer.Inner');
  const innerRunNode = findByPath('Outer.Inner.run');
  const innerGroup = graph.groups.find((g) => g.label === 'Inner');
  assert.ok(innerNode.groupId, 'Inner is itself grouped (nested under Outer)');
  assert.equal(innerRunNode.groupId, innerGroup.id, "Inner.run's groupId is Inner's own group, not Outer's");

  const modelInnerRun = model.nodes.find((n) => n.id === innerRunNode.id);
  assert.equal(modelInnerRun.groupId, innerRunNode.groupId, 'groupId passes through the render model unchanged');
});

test('self-links are dropped', async () => {
  const graph = await buildGraph('calls.py');
  const model = buildFileRenderModel(graph);
  for (const link of model.links) {
    assert.notEqual(link.source, link.target);
  }
});

test('symbolOnly nodes carry noRelationshipData through to the render model', async () => {
  const graph = await buildGraph('syntax_error.py', { skipPyan: true });
  const model = buildFileRenderModel(graph);
  const solo = model.nodes.find((n) => n.label === 'solo');
  assert.equal(solo.noRelationshipData, true);
});

test('links reference real node ids and carry their edge kind', async () => {
  const graph = await buildGraph('calls.py');
  const model = buildFileRenderModel(graph);
  const nodeIds = new Set(model.nodes.map((n) => n.id));
  assert.ok(model.links.length > 0);
  for (const link of model.links) {
    assert.ok(nodeIds.has(link.source));
    assert.ok(nodeIds.has(link.target));
    assert.ok(['defines', 'uses'].includes(link.kind));
  }
});
