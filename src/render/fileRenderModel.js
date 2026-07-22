// File-layer render model — MOO-70 Commit 8.
//
// Pure, DOM-free translation from a file-layer GraphIR
// (src/adapters/fileGraphAdapter.js) into the flat {nodes, links} shape
// src/render/fileGraph.js's D3 force layout builds. No legacy-shape
// dispatch is needed here (unlike repositoryRenderModel.js) -- the file
// layer has no pre-GraphIR legacy format to support.

/**
 * @param {import('../graph-ir/graphIR.js').GraphIR} graph
 * @returns {{
 *   nodes: Array<{id: string, label: string, kind: string, groupId: string|null, shape: string, colorRole: string, noRelationshipData: boolean}>,
 *   links: Array<{source: string, target: string, kind: string}>
 * }}
 */
export function buildFileRenderModel(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return { nodes: [], links: [] };

  const nodes = graph.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    kind: n.kind,
    groupId: n.groupId || null,
    shape: (n.hints && n.hints.shape) || 'rect',
    colorRole: (n.hints && n.hints.colorRole) || 'default',
    noRelationshipData: !!(n.metadata && n.metadata.noRelationshipData),
  }));
  const nodeIds = new Set(nodes.map((n) => n.id));

  const links = (graph.edges || [])
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target)
    .map((e) => ({ source: e.source, target: e.target, kind: e.kind }));

  return { nodes, links };
}
