// Unit tests for src/render/functionRenderModel.js (MOO-71 Commit 7).
//
// Runs the real pipeline (pythonSymbolIndex -> @codevisualizer/core ->
// adaptFunctionAnalysis -> buildFunctionRenderModel) rather than hand-built
// GraphIR, matching tests/function-graph-adapter.test.mjs's convention. The
// layout has to survive what the real analyzer actually emits -- cycles,
// unordered edge arrays, synthetic entry/exit -- so testing it against a
// fake would test the wrong thing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

import { indexPythonSymbols } from '../server/lib/pythonSymbolIndex.js';
import { lineColumnToCodeUnitOffset } from '../src/graph-ir/codeUnitOffset.js';
import { adaptFunctionAnalysis } from '../src/adapters/functionGraphAdapter.js';
import { normalizeContext } from '../src/graph-ir/githubContext.js';
import { buildFunctionRenderModel } from '../src/render/functionRenderModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/python-symbols');
const require = createRequire(import.meta.url);

const SHA = 'a'.repeat(40);
const CONTEXT = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });
const ANALYZER = { name: 'codeflow-codevisualizer-adapter', version: '1.0.0' };

async function realGraph(fixtureName, symbolPath) {
  const source = readFileSync(join(FIXTURES, fixtureName), 'utf8');
  const { entries } = await indexPythonSymbols({ path: fixtureName, content: source });
  const entrySymbol = entries.find(
    (e) => e.symbolPath.length === symbolPath.length && e.symbolPath.every((s, i) => s === symbolPath[i])
  );
  assert.ok(entrySymbol, `fixture ${fixtureName} should have a symbol at ${symbolPath.join('.')}`);

  const { initPythonLanguageService, analyzePythonFunction } = require('@codevisualizer/core');
  await initPythonLanguageService();
  const startByte = lineColumnToCodeUnitOffset(source, entrySymbol.startLine, entrySymbol.startColumn);
  const endByte = lineColumnToCodeUnitOffset(source, entrySymbol.endLine, entrySymbol.endColumn);
  const flowchartIR = await analyzePythonFunction(source, { startByte, endByte });

  return adaptFunctionAnalysis({ context: CONTEXT, entrySymbol, source, flowchartIR, analyzer: ANALYZER });
}

test('buildFunctionRenderModel returns an empty model for an absent or empty graph', () => {
  assert.deepEqual(buildFunctionRenderModel(null), { nodes: [], links: [], width: 0, height: 0, maxRank: 0 });
  assert.deepEqual(buildFunctionRenderModel({ nodes: [] }), { nodes: [], links: [], width: 0, height: 0, maxRank: 0 });
});

test('entry sits at rank 0 and exit at maxRank, so the flow reads top to bottom', async () => {
  const model = buildFunctionRenderModel(await realGraph('control_flow.py', ['process']));

  const entry = model.nodes.find((n) => n.isEntry);
  const exit = model.nodes.find((n) => n.isExit);
  assert.ok(entry, 'the real analyzer emits an entry node');
  assert.ok(exit, 'the real analyzer emits an exit node');
  assert.equal(entry.rank, 0);
  assert.equal(exit.rank, model.maxRank);
  assert.ok(exit.y > entry.y, 'exit is drawn below entry');
});

test('back-edges from loops are classified rather than laid out as forward flow', async () => {
  const model = buildFunctionRenderModel(await realGraph('control_flow.py', ['process']));

  const backEdges = model.links.filter((l) => l.isBackEdge);
  assert.ok(backEdges.length > 0, 'a for loop plus a while loop must produce real back-edges');

  // Every back-edge must point at a node at the same rank or higher up the
  // page -- that is what makes it a back-edge rather than mis-detected flow.
  const rankById = new Map(model.nodes.map((n) => [n.id, n.rank]));
  for (const link of backEdges) {
    assert.ok(
      rankById.get(link.target) <= rankById.get(link.source),
      `back-edge ${link.source} -> ${link.target} should not descend the page`
    );
  }
});

test('every forward edge descends at least one rank, so no forward flow is drawn sideways or upward', async () => {
  const model = buildFunctionRenderModel(await realGraph('control_flow.py', ['process']));
  const rankById = new Map(model.nodes.map((n) => [n.id, n.rank]));

  for (const link of model.links.filter((l) => !l.isBackEdge)) {
    assert.ok(
      rankById.get(link.target) > rankById.get(link.source),
      `forward edge ${link.source} -> ${link.target} must descend a rank`
    );
  }
});

test('layout is deterministic across repeated builds of the same graph', async () => {
  const graph = await realGraph('control_flow.py', ['process']);
  const a = buildFunctionRenderModel(graph);
  const b = buildFunctionRenderModel(graph);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same input must produce byte-identical layout');
});

test('no node is dropped, and every node receives a real position', async () => {
  const graph = await realGraph('control_flow.py', ['process']);
  const model = buildFunctionRenderModel(graph);

  assert.equal(model.nodes.length, graph.nodes.length, 'every GraphIR node must be laid out');
  for (const node of model.nodes) {
    assert.ok(Number.isFinite(node.x), `${node.id} has a finite x`);
    assert.ok(Number.isFinite(node.y), `${node.id} has a finite y`);
    assert.ok(Number.isInteger(node.rank) && node.rank >= 0);
    assert.ok(Number.isInteger(node.order) && node.order >= 0);
  }
});

test('branch nodes keep their diamond hint and true/false edge kinds survive to the model', async () => {
  const model = buildFunctionRenderModel(await realGraph('control_flow.py', ['process']));

  const branches = model.nodes.filter((n) => n.kind === 'branch');
  assert.ok(branches.length > 0, 'the fixture has if/while conditions');
  for (const branch of branches) assert.equal(branch.shape, 'diamond');

  assert.ok(model.links.some((l) => l.kind === 'flow-true'), 'true branches are distinguishable');
  assert.ok(model.links.some((l) => l.kind === 'flow-false'), 'false branches are distinguishable');
});

test('loop and exception edge labels reach the render model', async () => {
  const model = buildFunctionRenderModel(await realGraph('control_flow.py', ['process']));
  const labels = model.links.map((l) => l.label).filter(Boolean);

  assert.ok(labels.includes('Loop'), 'the for-loop entry edge keeps its label');
  assert.ok(
    labels.some((l) => l.startsWith('on ')),
    `an except handler edge keeps its "on <Error>" label; got ${JSON.stringify(labels)}`
  );
});

test('entry/exit are marked synthetic and carry no coordinate', async () => {
  const model = buildFunctionRenderModel(await realGraph('control_flow.py', ['process']));

  for (const node of model.nodes.filter((n) => n.isEntry || n.isExit)) {
    assert.equal(node.isSynthetic, true, `${node.id} is a synthetic marker`);
    assert.equal(node.coordinate, null, `${node.id} must not claim a source location`);
  }
});

test('the original CodeVisualizer NodeType is preserved for metadata inspection', async () => {
  const model = buildFunctionRenderModel(await realGraph('control_flow.py', ['process']));

  // The adapter collapses several NodeTypes into 'process'; the panel's
  // metadata view needs the original back.
  const collapsed = model.nodes.filter((n) => n.kind === 'process');
  assert.ok(collapsed.length > 0);
  assert.ok(
    collapsed.some((n) => n.flowchartNodeType && n.flowchartNodeType !== 'process'),
    'at least one process-kind node came from a more specific NodeType'
  );
});

test('a straight-line function lays out as a single spine, one node per rank', async () => {
  const model = buildFunctionRenderModel(await realGraph('control_flow.py', ['straight_line']));

  const perRank = new Map();
  for (const node of model.nodes) perRank.set(node.rank, (perRank.get(node.rank) || 0) + 1);
  for (const [rank, count] of perRank) {
    assert.equal(count, 1, `rank ${rank} should hold exactly one node in a branchless function`);
  }
  assert.equal(model.links.filter((l) => l.isBackEdge).length, 0, 'no loops means no back-edges');
});

test('Mermaid escape sequences do not reach rendered labels', async () => {
  const model = buildFunctionRenderModel(await realGraph('control_flow.py', ['process']));
  const labels = model.nodes.map((n) => n.label).join(' | ');

  assert.doesNotMatch(labels, /#quot;|#60;|#62;|#96;/, `Mermaid entities must be decoded by the adapter; got ${labels}`);
  assert.ok(
    model.nodes.some((n) => n.label.includes('>')),
    'the while condition `value > limit` should render with a real > character'
  );
});
