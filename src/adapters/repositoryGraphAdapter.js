// Repository-layer GraphIR adapter — MOO-69 Commit 1.
//
// Normalizes CodeFlow's existing `buildAnalysisData()` output (src/analyzer.js
// — files, functions, connections, folders, tree, architectureDiagram,
// issues, patterns, stats, ...) into the shared GraphIR contract MOO-68
// defined, without changing what the analyzer itself computes. This is a
// pure normalization step: every existing repository relationship the
// analyzer already found is either represented as a node/edge, or carried
// forward verbatim under `metadata` (see below) — nothing is silently
// dropped, and nothing new is computed here.
//
// Node granularity matches what the current D3 repository renderer already
// visualizes (src/render/repositoryGraph.js): one node per file, one group
// per folder. Per-function detail (fnStats, individual symbols) belongs to
// the file/function layers (MOO-70/71), not repurposed as repository-layer
// nodes here — folding hundreds of functions into the top-level graph would
// blow past what "preserve current D3 behavior" (Commit 3's own checklist
// item) actually means.
import { makeCoordinate } from '../graph-ir/sourceCoordinate.js';
import { makeGraphIR } from '../graph-ir/graphIR.js';

/**
 * @param {import('../graph-ir/githubContext.js').AnalysisContext} context
 * @param {string} path
 * @returns {import('../graph-ir/sourceCoordinate.js').SourceCoordinate}
 */
function fileCoordinate(context, path) {
  return makeCoordinate({
    repository: { host: 'github.com', owner: context.sourceOwner, name: context.sourceRepo },
    revision: context.resolvedSha,
    path,
    symbolKind: 'module',
  });
}

/**
 * Adapt `buildAnalysisData()`'s output into a repository-layer GraphIR.
 *
 * @param {object} input
 * @param {object} input.analysisData - the object `buildAnalysisData()` (src/analyzer.js) returned
 * @param {import('../graph-ir/githubContext.js').AnalysisContext} input.context - the normalized, resolved-SHA-pinned context this analysis ran against
 * @param {{name: string, version: string}} input.analyzer
 * @returns {import('../graph-ir/graphIR.js').GraphIR}
 */
export function adaptRepositoryAnalysis({ analysisData, context, analyzer }) {
  const groups = analysisData.folders.map((folder) => ({
    id: `folder:${folder}`,
    layer: 'repository',
    label: folder,
    parentGroupId: null,
  }));
  const groupIdByFolder = new Map(analysisData.folders.map((folder) => [folder, `folder:${folder}`]));

  const nodeIdByPath = new Map();
  const nodes = analysisData.files.map((file) => {
    const id = `file:${file.path}`;
    nodeIdByPath.set(file.path, id);
    return {
      id,
      layer: 'repository',
      kind: 'file',
      label: file.name,
      coordinate: fileCoordinate(context, file.path),
      groupId: groupIdByFolder.get(file.folder) || null,
      hints: {
        shape: 'circle',
        colorRole: file.layer === 'test' ? 'test' : 'default',
        layoutPreference: 'force',
      },
      // Everything the existing D3 node object + detail panel reads
      // (src/render/repositoryGraph.js, index.html's selected-file panel),
      // carried forward verbatim rather than recomputed.
      metadata: {
        folder: file.folder,
        layer: file.layer,
        functionCount: file.functions.length,
        lines: file.lines,
        churn: file.churn || 0,
        complexity: file.complexity || null,
        parserProvenance: file.parserProvenance || null,
        dependencies: file.dependencies || [],
      },
    };
  });

  // One edge per connection entry, not pre-aggregated by (source,target) the
  // way the D3 renderer sums counts for display — that aggregation is a
  // rendering concern the renderer can still apply, and collapsing it here
  // would throw away which specific function/link each connection
  // represents (functionKey, individual markdown-link kind), i.e. exactly
  // the "no existing repository relationship silently disappears" check.
  let edgeSeq = 0;
  const edges = [];
  for (const conn of analysisData.connections) {
    const sourceId = nodeIdByPath.get(conn.source);
    const targetId = nodeIdByPath.get(conn.target);
    if (!sourceId || !targetId) continue;
    // Call-graph edges have no `kind` (semantic: a function call/import);
    // markdown-link edges carry Parser.extractMarkdownLinks' `kind` — kept
    // distinct rather than merged into one generic edge type, since they're
    // genuinely different relationships (a semantic call vs. a doc
    // reference), not just a visual variation of the same thing.
    const kind = conn.kind || 'calls';
    edges.push({
      id: `edge:${edgeSeq++}`,
      layer: 'repository',
      kind,
      source: sourceId,
      target: targetId,
      hints: { colorRole: conn.kind ? 'reference' : 'default' },
      metadata: { fn: conn.fn, count: conn.count, functionKey: conn.functionKey || null },
    });
  }

  return makeGraphIR({
    layer: 'repository',
    context,
    rootCoordinate: null,
    analyzer,
    // File-granularity resolution here is exact (every file/folder is a
    // real filesystem entity, not a heuristically-resolved symbol) — the
    // heuristic part of the analyzer (resolveCallDefinitions' ambiguous-
    // overload handling) affects which *edges* exist, not node identity, so
    // it doesn't lower node-level confidence the way an unresolved symbol
    // would at the file/function layers.
    confidence: 1,
    groups,
    nodes,
    edges,
    warnings: [],
    // Repository-wide summaries that aren't individually node/edge-shaped
    // (issue lists, detected patterns/security/duplicates/violations,
    // the architecture diagram, and aggregate stats) — carried forward
    // under graph-level `metadata` (an intentionally open extension point;
    // GraphIR's schema doesn't enumerate this field and validateGraphIR
    // never rejects unknown top-level keys) rather than invented as
    // synthetic nodes. Blast-radius is deliberately excluded: it's a
    // per-selection computed value (calcBlast), not a static property of
    // the graph itself.
    metadata: {
      stats: analysisData.stats,
      issues: analysisData.issues,
      patterns: analysisData.patterns,
      securityIssues: analysisData.securityIssues,
      duplicates: analysisData.duplicates,
      layerViolations: analysisData.layerViolations,
      architectureDiagram: analysisData.architectureDiagram,
      suggestions: analysisData.suggestions,
      deadFunctions: analysisData.deadFunctions,
    },
  });
}
