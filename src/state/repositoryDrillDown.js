// Repository-layer drill-down request building — MOO-69 Commit 4.
//
// Pure, DOM-free glue between a repository-layer GraphIR (or its absence)
// and src/graph-ir/navigation.js's event contract. Kept separate from
// index.html's React wiring so the "find the node, check eligibility, build
// the event" logic is unit-testable without a browser.
//
// Invariant this module must never violate: the commit SHA is resolved
// exactly once, when `graph` (the repository GraphIR) is built — see
// index.html's finishAnalysis(), which resolves the ref to a SHA, builds
// the AnalysisContext, then produces the graph, in that order, before any
// coordinate exists. Every function here only ever *reads* a coordinate
// already attached to that graph; none of them re-resolve a ref or fetch
// anything. If the double-click handler resolved its own SHA independently
// (or reused a stale one from a different point in time), a branch could
// advance between the initial analysis and a later drill-down, producing
// exactly the cross-revision mismatch MOO-68's AnalysisContext/coordinate
// contract exists to prevent.
import { createDrillDownEvent, createOpenSourceEvent, createSelectionEvent, NavigationError } from '../graph-ir/navigation.js';

/**
 * @param {import('../graph-ir/graphIR.js').GraphIR|null} graph
 * @param {string} path - repo-relative file path (matches the D3 node id — see src/render/repositoryRenderModel.js)
 * @returns {import('../graph-ir/graphIR.js').GraphNode|null}
 */
export function findNodeByPath(graph, path) {
  if (!graph || !Array.isArray(graph.nodes)) return null;
  return graph.nodes.find((n) => n.coordinate && n.coordinate.path === path) || null;
}

/**
 * @typedef {Object} DrillDownAttempt
 * @property {boolean} eligible
 * @property {string} [reason] - human-readable, only present when !eligible
 * @property {import('../graph-ir/navigation.js').DrillDownEvent} [event] - only present when eligible
 * @property {import('../graph-ir/graphIR.js').GraphNode|null} node
 */

/**
 * Attempt to build a drill-down event for a double-clicked repository node.
 * Never throws — every failure mode (no GraphIR context at all, e.g.
 * local-folder analysis; node not found; coordinate ambiguous/ineligible)
 * comes back as `{eligible: false, reason}` so the caller can show a clear
 * "not drillable" affordance instead of crashing or silently no-op'ing.
 * @param {import('../graph-ir/graphIR.js').GraphIR|null} graph
 * @param {string} path
 * @returns {DrillDownAttempt}
 */
export function tryCreateDrillDown(graph, path) {
  if (!graph) {
    return { eligible: false, reason: 'No GitHub revision context is available for this analysis (local-folder analysis has none — see docs/graph-ir-contract.md).', node: null };
  }
  const node = findNodeByPath(graph, path);
  if (!node) {
    return { eligible: false, reason: 'This file has no resolved coordinate.', node: null };
  }
  try {
    const event = createDrillDownEvent(node, graph.layer);
    return { eligible: true, event, node };
  } catch (err) {
    if (err instanceof NavigationError) {
      return { eligible: false, reason: err.message, node };
    }
    throw err;
  }
}

/**
 * @param {import('../graph-ir/graphIR.js').GraphIR|null} graph
 * @param {string} path
 * @returns {import('../graph-ir/navigation.js').SelectionEvent}
 */
export function createSelectionEventForPath(graph, path) {
  const node = findNodeByPath(graph, path);
  return createSelectionEvent(path, node ? node.coordinate : null);
}

/**
 * Builds the "view on GitHub" URL for a coordinate — used by the explicit
 * open-source action.
 * @param {import('../graph-ir/sourceCoordinate.js').SourceCoordinate} coordinate
 * @returns {string}
 */
export function githubBlobUrl(coordinate) {
  const { repository, revision, path } = coordinate;
  return `https://${repository.host}/${repository.owner}/${repository.name}/blob/${revision}/${path}`;
}

/**
 * @param {import('../graph-ir/graphIR.js').GraphIR|null} graph
 * @param {string} path
 * @returns {import('../graph-ir/navigation.js').OpenSourceEvent|null} - null when there's no coordinate to open (e.g. no GraphIR context)
 */
export function tryCreateOpenSourceEvent(graph, path) {
  const node = findNodeByPath(graph, path);
  if (!node || !node.coordinate) return null;
  return createOpenSourceEvent(node.coordinate);
}
