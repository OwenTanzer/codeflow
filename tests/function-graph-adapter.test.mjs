// Unit tests for src/adapters/functionGraphAdapter.js (MOO-71 Commit 6).
//
// Runs the real pipeline end-to-end (real pythonSymbolIndex ->
// lineColumnToCodeUnitOffset -> real analyzePythonFunction from
// @codevisualizer/core -> adaptFunctionAnalysis), matching
// tests/file-graph-adapter.test.mjs's own convention of testing against
// real analyzer output rather than hand-built FlowchartIR fakes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

import { indexPythonSymbols } from '../server/lib/pythonSymbolIndex.js';
import { lineColumnToCodeUnitOffset } from '../src/graph-ir/codeUnitOffset.js';
import { adaptFunctionAnalysis } from '../src/adapters/functionGraphAdapter.js';
import { validateGraphIR } from '../src/graph-ir/graphIR.js';
import { normalizeContext } from '../src/graph-ir/githubContext.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/python-symbols');
const require = createRequire(import.meta.url);

const SHA = 'a'.repeat(40);
const CONTEXT = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });
const ANALYZER = { name: 'codeflow-codevisualizer-adapter', version: '1.0.0' };

async function analyzeRealFunction(fixtureName, symbolPath) {
  const path = fixtureName;
  const fullPath = join(FIXTURES, fixtureName);
  const source = readFileSync(fullPath, 'utf8');
  const { entries } = await indexPythonSymbols({ path, content: source });
  const entrySymbol = entries.find((e) => e.symbolPath.length === symbolPath.length && e.symbolPath.every((s, i) => s === symbolPath[i]));
  assert.ok(entrySymbol, `fixture ${fixtureName} should have a symbol at ${symbolPath.join('.')}`);

  const { initPythonLanguageService, analyzePythonFunction } = require('@codevisualizer/core');
  await initPythonLanguageService();
  const startByte = lineColumnToCodeUnitOffset(source, entrySymbol.startLine, entrySymbol.startColumn);
  const endByte = lineColumnToCodeUnitOffset(source, entrySymbol.endLine, entrySymbol.endColumn);
  const flowchartIR = await analyzePythonFunction(source, { startByte, endByte });

  return { source, entrySymbol, flowchartIR };
}

test('adaptFunctionAnalysis produces a schema-valid GraphIR for a real function with a branch and a multi-byte docstring', async () => {
  const { source, entrySymbol, flowchartIR } = await analyzeRealFunction('unicode_docstring.py', ['has_unicode_docstring']);
  const graph = adaptFunctionAnalysis({ context: CONTEXT, entrySymbol, source, flowchartIR, analyzer: ANALYZER });

  const { valid, errors } = validateGraphIR(graph);
  assert.ok(valid, `GraphIR should be schema-valid: ${JSON.stringify(errors)}`);
  assert.equal(graph.layer, 'function');
  assert.equal(graph.confidence, 1);
  assert.deepEqual(graph.groups, []);
});

test('adaptFunctionAnalysis: rootCoordinate matches the function symbol exactly', async () => {
  const { source, entrySymbol, flowchartIR } = await analyzeRealFunction('unicode_docstring.py', ['has_unicode_docstring']);
  const graph = adaptFunctionAnalysis({ context: CONTEXT, entrySymbol, source, flowchartIR, analyzer: ANALYZER });

  assert.equal(graph.rootCoordinate.path, 'unicode_docstring.py');
  assert.deepEqual(graph.rootCoordinate.symbolPath, ['has_unicode_docstring']);
  assert.equal(graph.rootCoordinate.symbolKind, 'function');
});

test('adaptFunctionAnalysis: entry/exit nodes are synthetic circles with no coordinate, matching tests/fixtures/graph-ir/function-codevisualizer.json', async () => {
  const { source, entrySymbol, flowchartIR } = await analyzeRealFunction('unicode_docstring.py', ['has_unicode_docstring']);
  const graph = adaptFunctionAnalysis({ context: CONTEXT, entrySymbol, source, flowchartIR, analyzer: ANALYZER });

  const entryNode = graph.nodes.find((n) => n.kind === 'entry');
  const exitNode = graph.nodes.find((n) => n.kind === 'exit');
  assert.ok(entryNode && exitNode);
  assert.equal(entryNode.coordinate, null);
  assert.equal(entryNode.origin, 'synthetic');
  assert.equal(entryNode.hints.shape, 'circle');
  assert.equal(entryNode.hints.isEntry, true);
  assert.equal(exitNode.coordinate, null);
  assert.equal(exitNode.hints.isExit, true);
});

test('adaptFunctionAnalysis: a decision node becomes a "branch" with a diamond hint and a real coordinate', async () => {
  const { source, entrySymbol, flowchartIR } = await analyzeRealFunction('unicode_docstring.py', ['has_unicode_docstring']);
  const graph = adaptFunctionAnalysis({ context: CONTEXT, entrySymbol, source, flowchartIR, analyzer: ANALYZER });

  const branchNode = graph.nodes.find((n) => n.kind === 'branch');
  assert.ok(branchNode, 'expected a branch node from the if statement');
  assert.equal(branchNode.hints.shape, 'diamond');
  assert.equal(branchNode.origin, 'local');
  assert.ok(branchNode.coordinate);
  assert.deepEqual(branchNode.coordinate.symbolPath, ['has_unicode_docstring']);
  // The branch is after the multi-byte docstring line -- if the
  // offset->line/column conversion mishandled the unicode line, this
  // range would be wrong (either off by the UTF-8/UTF-16 drift or
  // pointing at the wrong line entirely).
  assert.ok(branchNode.coordinate.range.startLine > 1);
});

test('adaptFunctionAnalysis: edge kinds follow the flow/flow-true/flow-false vocabulary', async () => {
  const { source, entrySymbol, flowchartIR } = await analyzeRealFunction('unicode_docstring.py', ['has_unicode_docstring']);
  const graph = adaptFunctionAnalysis({ context: CONTEXT, entrySymbol, source, flowchartIR, analyzer: ANALYZER });

  const edgeKinds = new Set(graph.edges.map((e) => e.kind));
  for (const kind of edgeKinds) {
    assert.ok(['flow', 'flow-true', 'flow-false'].includes(kind), `unexpected edge kind: ${kind}`);
  }
  assert.ok(edgeKinds.has('flow-true') || edgeKinds.has('flow-false'), 'expected at least one True/False branch edge');
});

test('adaptFunctionAnalysis: no dangling edges (every source/target references a real node id)', async () => {
  const { source, entrySymbol, flowchartIR } = await analyzeRealFunction('nested.py', ['Outer', 'run', 'helper']);
  const graph = adaptFunctionAnalysis({ context: CONTEXT, entrySymbol, source, flowchartIR, analyzer: ANALYZER });

  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    assert.ok(nodeIds.has(edge.source), `edge source ${edge.source} is not a real node id`);
    assert.ok(nodeIds.has(edge.target), `edge target ${edge.target} is not a real node id`);
  }
});

// MOO-71 Commit 7: @codevisualizer/core runs every label through
// StringProcessor.escapeString, which rewrites Mermaid-hostile characters into
// Mermaid's numeric entities (`"` -> #quot;, `<` -> #60;, `>` -> #62;, backtick
// -> #96;). Those are presentation escapes for a Mermaid code fence, and
// GraphIR is supposed to carry semantics -- left in place, a real condition
// displays as `value #62; limit`. Verified against the real analyzer rather
// than a synthetic label, since the escaping happens upstream of this adapter.
test('adaptFunctionAnalysis: decodes Mermaid escape entities so GraphIR labels carry real source text', async () => {
  const { source, entrySymbol, flowchartIR } = await analyzeRealFunction('control_flow.py', ['process']);

  // Precondition: the raw FlowchartIR really does contain the escaping. If
  // upstream ever stops escaping, this assertion fails loudly rather than
  // letting the decode below silently become dead code.
  const rawLabels = flowchartIR.nodes.map((n) => n.label).join(' | ');
  assert.match(rawLabels, /#quot;|#60;|#62;|#96;/, 'expected raw FlowchartIR labels to still be Mermaid-escaped');

  const graph = adaptFunctionAnalysis({ context: CONTEXT, entrySymbol, source, flowchartIR, analyzer: ANALYZER });
  const labels = graph.nodes.map((n) => n.label).join(' | ');

  assert.doesNotMatch(labels, /#quot;|#60;|#62;|#96;/, `decoded labels should carry no Mermaid entities; got ${labels}`);
  assert.ok(
    graph.nodes.some((n) => n.label.includes('value > limit')),
    'the while condition should read `value > limit`, not `value #62; limit`'
  );
  assert.ok(
    graph.nodes.some((n) => n.label.includes('"')),
    'the docstring statement should carry real double quotes'
  );
});
