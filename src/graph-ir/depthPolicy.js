// Adaptive depth policy for the file layer — MOO-70 Commit 6.
//
// The repository layer's equivalent density work (MOO-69) deliberately
// built nothing beyond documenting existing behavior — see
// docs/repository-layer-density.md — deferring clustering/node-budgets/
// blast-radius reduction to the Garrison Step (MOO-44) per MOO-66's own
// scoping rule. MOO-70's ticket requires *some* depth policy now, so this
// module is intentionally the minimal version that satisfies it: a pure
// post-processing filter over an already-built full-detail file-layer
// GraphIR (Commits 1-5), keyed on the already-structural
// `coordinate.symbolPath.length` — no clustering, no relevance scoring,
// no re-invoking pyan3 at a different depth. pyan3 itself has no generic
// numeric depth flag (only --namespace/--function + --direction, which
// focus around one symbol rather than offer a whole-graph coarse/fine
// toggle), so filtering the already-computed graph is both simpler and
// keeps Commits 1-5 untouched.
//
// nodeBudget/edgeBudget/the file-size cutoff below are explicitly initial,
// tunable guesses (not validated against a real large repository — no
// fixture in this repo is large enough to do that), matching the same
// caveat repository-layer-density.md gives its own 300-node threshold.

/** @typedef {'modules'|'symbols'|'methods'|'full'} DepthMode */

const MODE_ORDER = ['modules', 'symbols', 'methods', 'full'];
const MAX_DEPTH_BY_MODE = { modules: 0, symbols: 1, methods: 2, full: Infinity };

const DEFAULT_NODE_BUDGET = 60;
const DEFAULT_EDGE_BUDGET = 120;
const SMALL_FILE_SYMBOL_THRESHOLD = 20;

/**
 * Whether a node is visible at a given depth mode. Unresolved/ambiguous
 * nodes (coordinate: null) are always visible regardless of mode -- they
 * are rare relationship-derived warnings, not deep symbols, and hiding
 * them would hide real analysis warnings the user should see regardless
 * of the chosen depth.
 * @param {import('./graphIR.js').GraphNode} node
 * @param {DepthMode} mode
 * @returns {boolean}
 */
export function isNodeVisibleAtDepth(node, mode) {
  if (!node.coordinate) return true;
  return node.coordinate.symbolPath.length <= MAX_DEPTH_BY_MODE[mode];
}

/**
 * Pick the mode a request should start at, before any auto-increase.
 * @param {object} input
 * @param {'file'|'package'} input.requestKind
 * @param {number} input.totalSymbolCount - Commit 1's already-computed entry count for the request
 * @returns {DepthMode}
 */
export function selectInitialMode({ requestKind, totalSymbolCount }) {
  if (requestKind === 'package') return 'modules';
  return totalSymbolCount <= SMALL_FILE_SYMBOL_THRESHOLD ? 'methods' : 'symbols';
}

/**
 * Filter an already-built GraphIR down to one depth mode. Groups are left
 * untouched (may end up referencing only hidden nodes) -- pruning
 * now-empty/orphaned groups is a rendering nicety left to Commit 8, not
 * this filter's job.
 * @param {import('./graphIR.js').GraphIR} graph
 * @param {DepthMode} mode
 * @returns {import('./graphIR.js').GraphIR}
 */
export function applyDepthMode(graph, mode) {
  const nodes = graph.nodes.filter((node) => isNodeVisibleAtDepth(node, mode));
  const visibleIds = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  return { ...graph, nodes, edges };
}

/**
 * Choose the final depth mode for a request: either the caller's explicit
 * override (respected exactly, no auto-increase on top of it), or an
 * auto-selected mode that starts at selectInitialMode(...) and advances
 * toward 'full' while the next mode's filtered node/edge counts both stay
 * within budget.
 * @param {object} input
 * @param {import('./graphIR.js').GraphIR} input.graph - the full-detail graph (Commit 5's output)
 * @param {'file'|'package'} input.requestKind
 * @param {number} input.totalSymbolCount
 * @param {DepthMode} [input.override]
 * @param {number} [input.nodeBudget]
 * @param {number} [input.edgeBudget]
 * @returns {{mode: DepthMode, graph: import('./graphIR.js').GraphIR, nodeCount: number, edgeCount: number, manualOverride: boolean}}
 */
export function chooseDepthMode({
  graph,
  requestKind,
  totalSymbolCount,
  override,
  nodeBudget = DEFAULT_NODE_BUDGET,
  edgeBudget = DEFAULT_EDGE_BUDGET,
}) {
  if (override && MODE_ORDER.includes(override)) {
    const filtered = applyDepthMode(graph, override);
    return { mode: override, graph: filtered, nodeCount: filtered.nodes.length, edgeCount: filtered.edges.length, manualOverride: true };
  }

  let mode = selectInitialMode({ requestKind, totalSymbolCount });
  let filtered = applyDepthMode(graph, mode);
  let index = MODE_ORDER.indexOf(mode);

  while (index < MODE_ORDER.length - 1) {
    const nextMode = MODE_ORDER[index + 1];
    const nextFiltered = applyDepthMode(graph, nextMode);
    if (nextFiltered.nodes.length > nodeBudget || nextFiltered.edges.length > edgeBudget) break;
    mode = nextMode;
    filtered = nextFiltered;
    index += 1;
  }

  return { mode, graph: filtered, nodeCount: filtered.nodes.length, edgeCount: filtered.edges.length, manualOverride: false };
}
