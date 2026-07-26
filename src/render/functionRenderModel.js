// Function-layer render model — MOO-71 Commit 7.
//
// Pure, DOM-free translation from a function-layer GraphIR
// (src/adapters/functionGraphAdapter.js) into a *positioned* {nodes, links}
// shape for src/render/functionGraph.js.
//
// Why this file computes layout when src/render/fileRenderModel.js does not:
// the file layer hands its nodes to a D3 force simulation, which does the
// placing. A control-flow graph has a correct reading order -- entry at the
// top, exit at the bottom, one rank per step of execution -- and a force
// simulation cannot express that (see docs/function-layer-renderer.md for
// the real side-by-side comparison this conclusion came from). Layout is
// therefore deterministic and lives here, in a pure function, which also
// makes it unit-testable without a browser.
//
// Structure verified by running the real pipeline (pythonSymbolIndex ->
// @codevisualizer/core -> functionGraphAdapter) over a function containing
// a for loop, a while loop, try/except with two handlers, continue, break,
// and two returns. That output is what the algorithm below is built for,
// not an assumed shape:
//   - Cycles are real. `continue` and end-of-body edges point back to the
//     loop header (continue_7 -> for_header_4), and a while body points
//     back to its condition (stmt_15 -> while_cond_13). Ranking must
//     therefore break cycles first rather than assuming a DAG.
//   - The edge array is NOT in topological or source order, so nothing here
//     may depend on edge ordering for correctness -- only for tie-breaking.
//
// Determinism is a hard requirement (tests assert byte-identical output
// across runs): every traversal follows the graph's own node/edge array
// order, ties break on those indices, and no Math.random / Date / object-key
// iteration influences a position.

// Tightened from 84 after the first real screenshot: a 55-node function
// (psf/requests SessionRedirectMixin.resolve_redirects) runs ~40 ranks deep,
// and the extra vertical spacing bought nothing except height that then had to
// be zoomed away, which is what made the labels unreadable.
const RANK_HEIGHT = 60;
const NODE_SPACING = 150;
const MARGIN_X = 90;
const MARGIN_Y = 50;

/**
 * @typedef {Object} FunctionRenderNode
 * @property {string} id
 * @property {string} label
 * @property {string} kind - GraphIR's semantic kind (entry/exit/branch/call/process)
 * @property {string} shape - hints.shape, a presentation recommendation only
 * @property {string} colorRole
 * @property {number} rank - 0 = entry; execution depth
 * @property {number} order - position within its rank, left to right
 * @property {number} x
 * @property {number} y
 * @property {boolean} isSynthetic - origin === 'synthetic' (entry/exit markers with no source location)
 * @property {boolean} isEntry
 * @property {boolean} isExit
 * @property {string|null} flowchartNodeType - preserved original CodeVisualizer NodeType, for metadata inspection
 * @property {object|null} coordinate
 */

/**
 * @typedef {Object} FunctionRenderLink
 * @property {string} source
 * @property {string} target
 * @property {string} kind - flow | flow-true | flow-false
 * @property {string|null} label - loop/exception edge labels ("Loop", "on ValueError"), preserved by the adapter
 * @property {boolean} isBackEdge - a loop's return edge; drawn as a routed curve rather than as forward flow
 */

function pickEntry(nodes) {
  const flagged = nodes.find((n) => n.hints && n.hints.isEntry);
  if (flagged) return flagged;
  // Defensive: a graph with no isEntry hint still gets a stable starting
  // point rather than no layout at all.
  return nodes[0] || null;
}

/**
 * Classify back-edges by iterative DFS with gray-node detection: an edge
 * reaching a node currently on the DFS stack closes a cycle.
 *
 * Nodes unreachable from the entry are visited afterwards in node-array
 * order, so their edges get classified too instead of being left unranked.
 * (Not expected from the real analyzer, but a renderer must not silently
 * drop nodes it was handed.)
 *
 * @returns {Set<string>} keys of the form `${sourceId}|${targetId}|${edgeIndex}`
 */
function findBackEdges(nodes, outgoing, entry) {
  const backEdges = new Set();
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(nodes.map((n) => [n.id, WHITE]));

  function dfs(rootId) {
    // Each frame tracks how many of the node's outgoing edges it has taken,
    // so the traversal is iterative (no recursion depth limit on a large
    // generated flowchart) while preserving DFS colouring semantics.
    const stack = [{ id: rootId, edgeIndex: 0 }];
    color.set(rootId, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const edges = outgoing.get(frame.id) || [];
      if (frame.edgeIndex >= edges.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const edge = edges[frame.edgeIndex];
      frame.edgeIndex += 1;
      const targetColor = color.get(edge.target);
      if (targetColor === GRAY) {
        backEdges.add(edge.key);
      } else if (targetColor === WHITE) {
        color.set(edge.target, GRAY);
        stack.push({ id: edge.target, edgeIndex: 0 });
      }
    }
  }

  if (entry) dfs(entry.id);
  for (const node of nodes) {
    if (color.get(node.id) === WHITE) dfs(node.id);
  }
  return backEdges;
}

/**
 * Longest-path ranking over the graph minus its back-edges: rank(v) =
 * max(rank(u) + 1) over forward predecessors. Longest-path rather than BFS
 * so a node never sits above something that must execute before it (a
 * shorter branch reaching a join first would otherwise pull the join up
 * past the longer branch still feeding it).
 */
function assignRanks(nodes, forwardEdges, entry) {
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const forwardOut = new Map(nodes.map((n) => [n.id, []]));
  for (const edge of forwardEdges) {
    if (!forwardOut.has(edge.source) || !rank.has(edge.target)) continue;
    forwardOut.get(edge.source).push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target) + 1);
  }

  // Kahn's algorithm. Seeded entry-first so the entry leads the order even
  // if some other node also has indegree 0; remaining seeds follow
  // node-array order, keeping the queue deterministic.
  const queue = [];
  if (entry && indegree.get(entry.id) === 0) queue.push(entry.id);
  for (const node of nodes) {
    if (indegree.get(node.id) === 0 && node.id !== (entry && entry.id)) queue.push(node.id);
  }

  let head = 0;
  let processed = 0;
  while (head < queue.length) {
    const id = queue[head++];
    processed += 1;
    for (const target of forwardOut.get(id) || []) {
      rank.set(target, Math.max(rank.get(target), rank.get(id) + 1));
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }

  // Defensive: if back-edge removal somehow left a cycle, the nodes inside
  // it never drain. Rank them after everything that did drain, in node-array
  // order, so they are still drawn rather than stacked at rank 0.
  if (processed < nodes.length) {
    let maxDrained = 0;
    for (const node of nodes) {
      if (indegree.get(node.id) === 0) maxDrained = Math.max(maxDrained, rank.get(node.id));
    }
    let next = maxDrained + 1;
    for (const node of nodes) {
      if (indegree.get(node.id) !== 0) rank.set(node.id, next++);
    }
  }

  return rank;
}

/**
 * One barycenter pass: within each rank (top to bottom), sort nodes by the
 * mean order-position of their forward predecessors, which pulls a branch's
 * children under the branch itself instead of leaving them in discovery
 * order. Nodes with no forward predecessor keep their incoming position.
 * Single pass and stable-sorted, so the result stays deterministic.
 */
function orderWithinRanks(nodes, forwardEdges, rank, discoveryIndex) {
  const byRank = new Map();
  for (const node of nodes) {
    const r = rank.get(node.id);
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r).push(node);
  }

  const predecessors = new Map(nodes.map((n) => [n.id, []]));
  for (const edge of forwardEdges) {
    if (predecessors.has(edge.target)) predecessors.get(edge.target).push(edge.source);
  }

  const position = new Map();
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  for (const r of ranks) {
    const group = byRank.get(r);
    group.sort((a, b) => {
      const ba = barycenter(a.id);
      const bb = barycenter(b.id);
      if (ba !== bb) return ba - bb;
      return discoveryIndex.get(a.id) - discoveryIndex.get(b.id);
    });
    group.forEach((node, i) => position.set(node.id, i));
  }

  function barycenter(id) {
    const preds = predecessors.get(id) || [];
    const placed = preds.map((p) => position.get(p)).filter((v) => v !== undefined);
    if (placed.length === 0) return discoveryIndex.get(id);
    return placed.reduce((sum, v) => sum + v, 0) / placed.length;
  }

  return { byRank, ranks, position };
}

/**
 * Build the positioned render model for a function-layer GraphIR.
 * @param {import('../graph-ir/graphIR.js').GraphIR} graph
 * @returns {{nodes: FunctionRenderNode[], links: FunctionRenderLink[], width: number, height: number, maxRank: number}}
 */
export function buildFunctionRenderModel(graph) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return { nodes: [], links: [], width: 0, height: 0, maxRank: 0 };
  }

  const nodes = graph.nodes;
  const nodeIds = new Set(nodes.map((n) => n.id));
  const entry = pickEntry(nodes);

  // Self-loops and edges pointing outside this graph are dropped: neither
  // can be laid out as flow, and the file layer drops the same cases.
  const edges = (graph.edges || [])
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target)
    .map((e, i) => ({
      source: e.source,
      target: e.target,
      kind: e.kind,
      label: (e.metadata && e.metadata.label) || null,
      key: `${e.source}|${e.target}|${i}`,
    }));

  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  for (const edge of edges) outgoing.get(edge.source).push(edge);

  const backEdges = findBackEdges(nodes, outgoing, entry);
  const forwardEdges = edges.filter((e) => !backEdges.has(e.key));

  const rank = assignRanks(nodes, forwardEdges, entry);

  // The exit marker belongs at the bottom regardless of which return
  // statement happened to reach it by the shortest path. Safe by
  // construction: maxRank is >= every other node's rank, so this can never
  // lift the exit above one of its own predecessors.
  const exitNode = nodes.find((n) => n.hints && n.hints.isExit);
  let maxRank = 0;
  for (const node of nodes) maxRank = Math.max(maxRank, rank.get(node.id));
  if (exitNode && rank.get(exitNode.id) < maxRank) rank.set(exitNode.id, maxRank);

  // Discovery order = the graph's own node array order, the one ordering
  // guaranteed stable across runs for a given analysis.
  const discoveryIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const { byRank, ranks, position } = orderWithinRanks(nodes, forwardEdges, rank, discoveryIndex);

  let widestRank = 1;
  for (const r of ranks) widestRank = Math.max(widestRank, byRank.get(r).length);
  const width = MARGIN_X * 2 + (widestRank - 1) * NODE_SPACING;
  const height = MARGIN_Y * 2 + maxRank * RANK_HEIGHT;

  const renderNodes = nodes.map((node) => {
    const r = rank.get(node.id);
    const group = byRank.get(r);
    const order = position.get(node.id);
    // Each rank is centered on the widest rank, so the flow reads down a
    // consistent spine instead of being left-aligned.
    const rowWidth = (group.length - 1) * NODE_SPACING;
    const x = MARGIN_X + (width - MARGIN_X * 2 - rowWidth) / 2 + order * NODE_SPACING;
    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      shape: (node.hints && node.hints.shape) || 'rect',
      colorRole: (node.hints && node.hints.colorRole) || 'default',
      rank: r,
      order,
      x,
      y: MARGIN_Y + r * RANK_HEIGHT,
      isSynthetic: node.origin === 'synthetic',
      isEntry: !!(node.hints && node.hints.isEntry),
      isExit: !!(node.hints && node.hints.isExit),
      flowchartNodeType: (node.metadata && node.metadata.flowchartNodeType) || null,
      coordinate: node.coordinate || null,
    };
  });

  const links = edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    label: edge.label,
    isBackEdge: backEdges.has(edge.key),
  }));

  return { nodes: renderNodes, links, width, height, maxRank };
}
