// Repository render model — MOO-69 Commit 3.
//
// Pure, DOM-free translation from either shape a repository analysis can
// arrive in today -- the legacy buildAnalysisData() output (still what
// local-folder analysis produces, since it has no GitHub repository/
// revision identity to build an AnalysisContext from; MOO-66 declares
// GitHub context canonical for v1, so local-folder analysis stays on this
// path rather than a synthetic/fake context) or a repository-layer GraphIR
// (src/graph-ir/graphIR.js, produced by src/adapters/repositoryGraphAdapter.js
// for GitHub-backed analysis) -- into the flat {nodes, links} shape
// src/render/repositoryGraph.js's D3 force layout already builds.
//
// Extracted out of renderRepositoryGraph() itself (rather than left as an
// inline mapping) specifically so it's testable without a DOM/SVG element,
// and so the renderer's own D3 code doesn't need to know about either input
// shape directly — "keep rendering concerns isolated from analyzer and
// adapter logic" (MOO-69 Commit 3's own checklist item).
//
// Node `id` is always the file's repo-relative path, matching what
// index.html's selectFileRef/activateFileRef/`data.files.find(...)` already
// expect — deliberately NOT GraphIR's own `node.id` (`file:${path}`), so
// nothing else in App() needs to change to consume this.

function isGraphIR(input) {
  return !!input && typeof input === 'object' && Array.isArray(input.nodes) && Array.isArray(input.edges) && typeof input.layer === 'string';
}

function fromGraphIR(graph, folderFilter) {
  const pathByGraphNodeId = new Map();
  const allNodes = [];
  graph.nodes.forEach((n) => {
    if (!n.coordinate) return;
    pathByGraphNodeId.set(n.id, n.coordinate.path);
    allNodes.push({
      id: n.coordinate.path,
      name: n.label,
      folder: (n.metadata && n.metadata.folder) || 'root',
      fnCount: (n.metadata && n.metadata.functionCount) || 0,
      layer: (n.metadata && n.metadata.layer) || 'util',
      churn: (n.metadata && n.metadata.churn) || 0,
    });
  });

  const filtered = folderFilter
    ? allNodes.filter((n) => n.folder === folderFilter || n.folder.startsWith(folderFilter + '/'))
    : allNodes;
  const nodeIds = new Set(filtered.map((n) => n.id));

  const linkMap = new Map();
  graph.edges.forEach((edge) => {
    const sourcePath = pathByGraphNodeId.get(edge.source);
    const targetPath = pathByGraphNodeId.get(edge.target);
    if (!sourcePath || !targetPath) return;
    if (!nodeIds.has(sourcePath) || !nodeIds.has(targetPath)) return;
    if (sourcePath === targetPath) return;
    const key = sourcePath + '|' + targetPath;
    const count = (edge.metadata && edge.metadata.count) || 1;
    if (!linkMap.has(key)) linkMap.set(key, { source: sourcePath, target: targetPath, count: 0 });
    linkMap.get(key).count += count;
  });

  return { nodes: filtered, links: Array.from(linkMap.values()) };
}

function fromLegacyAnalysisData(data, folderFilter) {
  const filteredFiles = folderFilter
    ? data.files.filter((f) => f.folder === folderFilter || f.folder.startsWith(folderFilter + '/'))
    : data.files;
  const fileIds = new Set(filteredFiles.map((f) => f.path));
  const nodes = filteredFiles.map((f) => ({
    id: f.path,
    name: f.name,
    folder: f.folder,
    fnCount: f.functions.length,
    layer: f.layer,
    churn: f.churn || 0,
  }));
  const linkMap = new Map();
  data.connections.forEach((c) => {
    if (!fileIds.has(c.source) || !fileIds.has(c.target)) return;
    if (c.source === c.target) return;
    const key = c.source + '|' + c.target;
    if (!linkMap.has(key)) linkMap.set(key, { source: c.source, target: c.target, count: 0 });
    linkMap.get(key).count += c.count;
  });
  return { nodes, links: Array.from(linkMap.values()) };
}

/**
 * @param {object} data - either buildAnalysisData()'s legacy output, or a repository-layer GraphIR
 * @param {string|null} [folderFilter]
 * @returns {{nodes: Array<{id:string,name:string,folder:string,fnCount:number,layer:string,churn:number}>, links: Array<{source:string,target:string,count:number}>}}
 */
export function buildRepositoryRenderModel(data, folderFilter) {
  if (!data) return { nodes: [], links: [] };
  return isGraphIR(data) ? fromGraphIR(data, folderFilter) : fromLegacyAnalysisData(data, folderFilter);
}
