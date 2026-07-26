// Blast-radius computation over repository GraphIR — MOO-72 Commit 1A.
//
// A pure-function port of src/analyzer.js's calcBlast(fileId, conns, files),
// operating on the repository layer's GraphIR (nodes/edges) instead of the
// legacy analyzer's flat {files, connections} shape -- so blast radius keeps
// working for GitHub-sourced repositories once their analysis moves
// server-side, without inventing a new response field. Deliberately kept
// out of GraphIR's own core (src/graph-ir/graphIR.js) and out of the
// repository adapter itself: blast radius is a per-selection *query* over
// an already-built graph, not a static property of the graph the way
// nodes/edges/groups are (see repositoryGraphAdapter.js's own comment on
// why it excludes blast radius from `metadata`).
//
// Algorithm, scoring thresholds, and return shape are unchanged from
// calcBlast -- this only changes what it reads adjacency from (GraphIR
// edges keyed by node id, e.g. "file:src/app.py", rather of the legacy
// connections array keyed by raw file path) and translates back to file
// paths at the boundary so callers (index.html's blast-radius UI) don't
// need to change what they read.
//
// @param {string} path - the repo-relative file path blast radius is being computed for
// @param {import('./graphIR.js').GraphIR} graph - a repository-layer GraphIR (nodes/edges)
// @returns {{affected: string[], transitive: string[], count: number, transitiveCount: number, percent: number, level: string, depth: number, fnsUsed: number, totalCalls: number, dependencies: string[], impactScore: number, centrality: number}}
export function calcBlastFromGraph(path, graph) {
  const pathByNodeId = new Map(graph.nodes.map((n) => [n.id, n.coordinate ? n.coordinate.path : null]));
  const targetNode = graph.nodes.find((n) => n.coordinate && n.coordinate.path === path);
  const fileId = targetNode ? targetNode.id : `file:${path}`;

  // Build adjacency lists for fast lookups, same shape as calcBlast's own
  // exportedTo/importedFrom/exportedFns, just keyed by GraphIR node id
  // instead of raw path.
  const exportedTo = new Map(); // nodeId -> Set of nodeIds that import from it
  const importedFrom = new Map(); // nodeId -> Set of nodeIds it imports from
  const exportedFns = new Map(); // nodeId -> Map of fn -> count of external calls

  for (const edge of graph.edges) {
    const src = edge.source;
    const tgt = edge.target;
    if (!exportedTo.has(src)) exportedTo.set(src, new Set());
    exportedTo.get(src).add(tgt);
    if (!importedFrom.has(tgt)) importedFrom.set(tgt, new Set());
    importedFrom.get(tgt).add(src);
    if (!exportedFns.has(src)) exportedFns.set(src, new Map());
    const fnMap = exportedFns.get(src);
    const fn = edge.metadata && edge.metadata.fn;
    const count = (edge.metadata && edge.metadata.count) || 1;
    fnMap.set(fn, (fnMap.get(fn) || 0) + count);
  }

  const toPaths = (nodeIds) =>
    Array.from(nodeIds)
      .map((id) => pathByNodeId.get(id))
      .filter((p) => p != null);

  // 1. Direct dependents (nodes that directly import from this one)
  const directDepIds = exportedTo.get(fileId) ? Array.from(exportedTo.get(fileId)) : [];

  // 2. Transitive dependents (BFS with depth tracking)
  const transitive = new Map(); // nodeId -> depth
  const queue = directDepIds.map((id) => ({ id, depth: 1 }));
  const visited = new Set([fileId, ...directDepIds]);
  while (queue.length > 0) {
    const item = queue.shift();
    if (item.depth > 3) continue; // Limit depth to 3 for transitive
    transitive.set(item.id, item.depth);
    const nextDeps = exportedTo.get(item.id) || new Set();
    nextDeps.forEach((id) => {
      if (!visited.has(id)) {
        visited.add(id);
        queue.push({ id, depth: item.depth + 1 });
      }
    });
  }

  // 3. Functions exported (how many of this file's functions are used)
  const fnUsage = exportedFns.get(fileId) || new Map();
  const fnsUsed = fnUsage.size;
  let totalCalls = 0;
  fnUsage.forEach((cnt) => {
    totalCalls += cnt;
  });

  // 4. Dependencies (nodes this file imports from - its risk)
  const dependencyIds = importedFrom.get(fileId) ? Array.from(importedFrom.get(fileId)) : [];

  // 5. Weighted impact score -- direct deps count fully, transitive with decay
  let impactScore = directDepIds.length;
  transitive.forEach((depth) => {
    if (depth > 1) impactScore += 1 / depth; // 0.5 for depth 2, 0.33 for depth 3
  });

  // 6. Centrality (how connected is this file)
  const centrality = directDepIds.length + dependencyIds.length + fnsUsed;

  // Determine level based on direct dependents and functions used
  let level = 'low';
  const connectedNodeCount = graph.nodes.filter((n) => exportedTo.has(n.id) || importedFrom.has(n.id)).length;
  const relativePct = connectedNodeCount > 0 ? Math.round((directDepIds.length / connectedNodeCount) * 100) : 0;

  if (directDepIds.length >= 8 || fnsUsed >= 5) level = 'critical';
  else if (directDepIds.length >= 4 || fnsUsed >= 3) level = 'high';
  else if (directDepIds.length >= 2 || fnsUsed >= 1) level = 'medium';

  return {
    affected: toPaths(directDepIds),
    transitive: toPaths(transitive.keys()),
    count: directDepIds.length,
    transitiveCount: transitive.size,
    percent: relativePct,
    level,
    depth: transitive.size > 0 ? Math.max(...transitive.values()) : 0,
    fnsUsed,
    totalCalls,
    dependencies: toPaths(dependencyIds),
    impactScore: Math.round(impactScore * 10) / 10,
    centrality,
  };
}
