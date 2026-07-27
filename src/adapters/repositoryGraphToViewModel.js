// Repository GraphIR -> legacy view-model boundary — MOO-72 Commit 1A.
//
// The inverse of adaptRepositoryAnalysis: reconstructs the shape every
// existing repository-layer UI consumer already reads (index.html's `data`
// state -- stats sidebar, patterns/security/duplicates/dead-functions tabs,
// report export, D3 visualizations, the file-detail panel's Functions
// card, ...) from a server-returned repository GraphIR, so migrating the
// repository layer's *fetch* onto the server doesn't require rewiring a
// dozen-plus UI read sites in the same commit. Local-folder/ZIP analysis
// keeps producing this shape directly in-browser (via buildAnalysisData/
// adaptRepositoryAnalysis called locally) and never goes through this
// mapper at all.
//
// Deliberately partial in one place: `content` is always '' here, since
// server-sourced analysis never ships raw file content to the client (see
// docs/upstream-compatibility equivalent reasoning for the function layer --
// file preview for GitHub-sourced repositories stays on the existing
// legacy GitHub-PAT fallback path, unmigrated in this commit).
//
// @param {import('../graph-ir/graphIR.js').GraphIR} graph - a repository-layer GraphIR from adaptRepositoryAnalysis, as returned by POST /api/graph/repository
// @returns {object} the legacy analyzer.js buildAnalysisData()-shaped view model
export function repositoryGraphToViewModel(graph) {
  const metadata = graph.metadata || {};
  const allFunctions = metadata.functions || [];

  const functionsByFile = new Map();
  const functionsByKey = new Map();
  for (const fn of allFunctions) {
    if (!functionsByFile.has(fn.file)) functionsByFile.set(fn.file, []);
    functionsByFile.get(fn.file).push(fn);
    if (fn.key) functionsByKey.set(fn.key, fn);
  }

  // MOO-72 Commit 1A review: the server strips `.code` from each fnStats
  // entry before sending it (repositoryGraphAdapter.js's
  // stripCodeFromFnStats) since it's an exact duplicate of the matching
  // `functions[]` entry's own `.code` -- rehydrated here, at the view-model
  // boundary, so the legacy Functions card/detailed export (which read
  // `fnStats[key].code` directly) see the same shape they always have.
  const fnStats = Object.create(null);
  for (const [key, stat] of Object.entries(metadata.fnStats || {})) {
    const fn = functionsByKey.get(key);
    fnStats[key] = fn ? { ...stat, code: fn.code } : stat;
  }

  const pathByNodeId = new Map(graph.nodes.map((n) => [n.id, n.coordinate ? n.coordinate.path : null]));

  const files = graph.nodes.map((node) => {
    const path = node.coordinate.path;
    const nodeMetadata = node.metadata || {};
    return {
      path,
      name: node.label,
      folder: nodeMetadata.folder,
      // Never fetched to the client for server-sourced analysis -- see
      // module doc comment.
      content: '',
      functions: functionsByFile.get(path) || [],
      lines: nodeMetadata.lines,
      layer: nodeMetadata.layer,
      churn: nodeMetadata.churn,
      isCode: nodeMetadata.isCode !== false,
      complexity: nodeMetadata.complexity,
      parserProvenance: nodeMetadata.parserProvenance,
      dependencies: nodeMetadata.dependencies,
    };
  });

  const connections = graph.edges.map((edge) => ({
    source: pathByNodeId.get(edge.source),
    target: pathByNodeId.get(edge.target),
    fn: edge.metadata && edge.metadata.fn,
    count: edge.metadata && edge.metadata.count,
    functionKey: edge.metadata && edge.metadata.functionKey,
    kind: edge.kind,
  }));

  return {
    files,
    functions: allFunctions,
    connections,
    fnStats,
    folders: metadata.folders || [],
    tree: metadata.tree,
    issues: metadata.issues || [],
    patterns: metadata.patterns || [],
    securityIssues: metadata.securityIssues || [],
    duplicates: metadata.duplicates || [],
    layerViolations: metadata.layerViolations || [],
    architectureDiagram: metadata.architectureDiagram,
    deadFunctions: metadata.deadFunctions || [],
    excludePatterns: metadata.excludePatterns || [],
    stats: metadata.stats,
    suggestions: metadata.suggestions || [],
  };
}
