// Function-layer GraphIR adapter — MOO-71 Commit 6.
//
// Converts @codevisualizer/core's FlowchartIR (MOO-71 Commit 5's real
// output) into a function-layer GraphIR, mirroring
// src/adapters/fileGraphAdapter.js's pattern exactly: a pure function
// producing a bare GraphIR via makeGraphIR, not an AdapterResult --
// wrapping in buildAdapterResult (provenance/timing/cache) is the
// service endpoint's job (server/routes/graph-function.js), same as
// fileGraphAdapter.js leaves that to graph-file.js.
//
// Target shape verified against the real fixture
// tests/fixtures/graph-ir/function-codevisualizer.json, not just
// schema-illustrative inspiration -- its node kinds/hints (entry/exit as
// circles, decision as a diamond "branch", a call as a rect) and edge
// kind vocabulary (flow/flow-true/flow-false) are treated as the actual
// target for this adapter.
import { makeCoordinate } from '../graph-ir/sourceCoordinate.js';
import { makeGraphIR } from '../graph-ir/graphIR.js';
import { codeUnitOffsetToLineColumn } from '../graph-ir/codeUnitOffset.js';

function repositoryIdentity(context) {
  return { host: 'github.com', owner: context.sourceOwner, name: context.sourceRepo };
}

// FlowchartNode.location/functionRange are flat UTF-16 code unit offsets
// (MOO-71 Commit 5's real, verified finding -- NOT UTF-8 bytes, despite
// @codevisualizer/core's own startByte/endByte naming). Converts one to
// a SourceRange via codeUnitOffsetToLineColumn.
function locationToRange(source, location) {
  if (!location) return null;
  const start = codeUnitOffsetToLineColumn(source, location.start);
  const end = codeUnitOffsetToLineColumn(source, location.end);
  return { startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column };
}

// A statement/decision/call inside a function isn't a new symbol -- it
// shares the enclosing function's own identity (path/symbolPath/
// symbolKind), just with a different range. Coordinate is null for
// synthetic (entry/exit, or any node genuinely missing a location) --
// never fabricated from a guess.
function nodeCoordinate(context, entrySymbol, source, node) {
  if (!node.location) return null;
  return makeCoordinate({
    repository: repositoryIdentity(context),
    revision: context.resolvedSha,
    path: entrySymbol.path,
    symbolPath: entrySymbol.symbolPath,
    symbolKind: entrySymbol.symbolKind,
    range: locationToRange(source, node.location),
  });
}

// nodeType -> {kind, hints}. Derived from the semantic nodeType field,
// never from FlowchartNode.shape/style (CodeVisualizer's own Mermaid-
// presentation fields) -- the same "don't rely on presentation labels as
// source metadata" principle already established for the file layer.
//
// Deliberately NOT an exhaustive enumeration of all 19 NodeType values.
// Only the ones whose *rendering semantics* actually differ get an
// explicit entry, verified against the real
// tests/fixtures/graph-ir/function-codevisualizer.json fixture; every
// other NodeType -- including any @codevisualizer/core adds upstream in
// the future -- inherits DEFAULT_NODE_KIND rather than needing this
// table updated first. `kind` is GraphIR's own semantic classification
// (e.g. 'branch'); `hints.shape` is only ever a renderer's current
// presentation recommendation for that kind, not a GraphIR semantic
// itself -- keep those two concepts separate even where a hint's value
// happens to look like the kind's name.
const NODE_TYPE_MAP = {
  entry: { kind: 'entry', hints: { shape: 'circle', isEntry: true, layoutPreference: 'hierarchical' } },
  exit: { kind: 'exit', hints: { shape: 'circle', isExit: true } },
  decision: { kind: 'branch', hints: { shape: 'diamond', colorRole: 'default' } },
  function_call: { kind: 'call', hints: { shape: 'rect', colorRole: 'default' } },
  method_call: { kind: 'call', hints: { shape: 'rect', colorRole: 'default' } },
  macro_call: { kind: 'call', hints: { shape: 'rect', colorRole: 'default' } },
};
const DEFAULT_NODE_KIND = { kind: 'process', hints: { shape: 'rect', colorRole: 'default' } };

function edgeKind(label) {
  if (label === 'True') return 'flow-true';
  if (label === 'False') return 'flow-false';
  return 'flow';
}

// @codevisualizer/core runs every label through StringProcessor.escapeString
// before it reaches FlowchartIR, which rewrites Mermaid-hostile characters
// into Mermaid's own numeric-entity forms: `"` -> #quot;, `<` -> #60;,
// `>` -> #62;, backtick -> #96;, and `\` -> `\\`. Those are *presentation*
// escapes for a Mermaid code fence, and this adapter's whole premise
// (MOO-71's governing decision: "treat FlowchartIR as semantic input, not
// Mermaid text as the canonical architecture") is that GraphIR carries
// semantics, not another renderer's escaping. Left alone, a real condition
// renders on screen as `value #62; limit` instead of `value > limit` --
// found by running the real pipeline over a loop/exception-heavy function
// while building MOO-71 Commit 7's renderer, the first consumer that
// actually displays these labels.
//
// Reversed here rather than in the renderer because the escaping is a data
// defect at this boundary, not a drawing concern -- any future consumer
// (search, metadata inspection, an LLM annotation pass) would otherwise
// have to re-discover and re-fix it. Deliberately NOT fixed upstream in
// StringProcessor: the CodeVisualizer extension's own Mermaid output
// depends on that escaping, and MOO-71 must preserve extension behavior.
//
// escapeString's other transforms are lossy and intentionally NOT reversed:
// whitespace collapsing, trailing-colon stripping, and truncation to 80
// characters are reasonable label shortening, and no inverse exists.
const MERMAID_ENTITY_PATTERN = /#quot;|#60;|#62;|#96;|\\\\/g;
const MERMAID_ENTITY_MAP = { '#quot;': '"', '#60;': '<', '#62;': '>', '#96;': '`', '\\\\': '\\' };

function decodeFlowchartLabel(label) {
  if (typeof label !== 'string' || label.length === 0) return label;
  return label.replace(MERMAID_ENTITY_PATTERN, (match) => MERMAID_ENTITY_MAP[match]);
}

/**
 * Adapt a MOO-71 Commit 5 FlowchartIR result into a function-layer GraphIR.
 * @param {object} input
 * @param {import('../graph-ir/githubContext.js').AnalysisContext} input.context
 * @param {object} input.entrySymbol - the resolved pythonSymbolIndex.js entry identifying the function
 * @param {string} input.source - the file's full source text (needed for offset->line/column conversion)
 * @param {import('@codevisualizer/core').FlowchartIR} input.flowchartIR
 * @param {{name: string, version: string}} input.analyzer
 * @returns {import('../graph-ir/graphIR.js').GraphIR}
 */
export function adaptFunctionAnalysis({ context, entrySymbol, source, flowchartIR, analyzer }) {
  const rootCoordinate = makeCoordinate({
    repository: repositoryIdentity(context),
    revision: context.resolvedSha,
    path: entrySymbol.path,
    symbolPath: entrySymbol.symbolPath,
    symbolKind: entrySymbol.symbolKind,
    range: {
      startLine: entrySymbol.startLine,
      startColumn: entrySymbol.startColumn,
      endLine: entrySymbol.endLine,
      endColumn: entrySymbol.endColumn,
    },
  });

  const warnings = [];
  const isSynthetic = (nodeType) => nodeType === 'entry' || nodeType === 'exit';

  const nodes = flowchartIR.nodes.map((node) => {
    const mapping = (node.nodeType && NODE_TYPE_MAP[node.nodeType]) || DEFAULT_NODE_KIND;
    const synthetic = isSynthetic(node.nodeType);
    const coordinate = synthetic ? null : nodeCoordinate(context, entrySymbol, source, node);
    const label = decodeFlowchartLabel(node.label);
    if (!synthetic && !node.location) {
      warnings.push(`Node "${node.id}" (${label}) has no source location; its coordinate could not be attached.`);
    }
    return {
      id: node.id,
      layer: 'function',
      kind: mapping.kind,
      label,
      coordinate,
      groupId: null,
      origin: coordinate ? 'local' : 'synthetic',
      hints: mapping.hints,
      // Preserves the original FlowchartIR id and NodeType even where
      // this adapter collapses several NodeTypes into one GraphIR kind
      // (function_call/method_call/macro_call -> 'call', or any
      // unmapped type -> the 'process' default) -- costs almost nothing
      // and makes debugging a rendering discrepancy much easier than
      // reasoning backward from the collapsed kind alone.
      metadata: { flowchartNodeId: node.id, flowchartNodeType: node.nodeType || null },
    };
  });

  const edges = flowchartIR.edges.map((edge, i) => {
    const kind = edgeKind(edge.label);
    const graphEdge = {
      id: `edge:${i}`,
      layer: 'function',
      kind,
      source: edge.from,
      target: edge.to,
    };
    if (edge.label && kind === 'flow') {
      // A non-True/False label (loop labels like "Loop"/"End Loop",
      // exception labels like "on ValueError") still carries real
      // information -- preserved rather than silently dropped just
      // because it doesn't fit the flow/flow-true/flow-false triad.
      graphEdge.metadata = { label: decodeFlowchartLabel(edge.label) };
    }
    return graphEdge;
  });

  return makeGraphIR({
    layer: 'function',
    context,
    rootCoordinate,
    analyzer,
    // No partial-match concept at this layer (unlike the file layer's
    // pyan3-join blend): @codevisualizer/core either successfully
    // parses the exact requested range or Commit 5 rejects the request
    // outright via FunctionRangeNotFoundError -- there's no "partially
    // confident" graph to build here.
    confidence: 1,
    groups: [],
    nodes,
    edges,
    warnings,
    // Preserves FlowchartIR's own top-level provenance fields that don't
    // map to any GraphIR field directly ("preserve original FlowchartIR
    // identifiers and provenance for diagnostics").
    metadata: { flowchartTitle: decodeFlowchartLabel(flowchartIR.title) || null, functionRange: flowchartIR.functionRange || null },
  });
}
