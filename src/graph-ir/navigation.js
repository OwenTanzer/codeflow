// Navigation and selection events — MOO-68 Commit 5.
//
// The interaction contract every renderer (D3 repository graph today,
// pyan3/CodeVisualizer renderers later) emits through, so drill-down
// behavior is defined once instead of once per layer. Governing decision
// carried over from MOO-66/MOO-67: single click selects/focuses only;
// double click carries drill-down *intent* (the selected coordinate and
// target layer) — it does not itself perform navigation. MOO-67 Commit 4E
// already wired a `node-activate` seam (src/render/repositoryGraph.js) as
// a no-op specifically so this module's real drill-down dispatch can be
// plugged into it later without touching the renderer again.
import { normalizePath } from './sourceCoordinate.js';

/** @typedef {'select'|'drillDown'|'openSource'} NavigationEventType */

export class NavigationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NavigationError';
  }
}

/**
 * Classify a raw pointer interaction into 'select' or 'drillDown'. Exists
 * so every renderer maps its native click/dblclick handling through one
 * shared rule rather than each reimplementing "detail === 2 means
 * double-click."
 * @param {{type: 'click'|'dblclick', detail?: number}} interaction
 * @returns {'select'|'drillDown'}
 */
export function classifyPointerInteraction(interaction) {
  if (interaction.type === 'dblclick') return 'drillDown';
  if (interaction.type === 'click' && interaction.detail === 2) return 'drillDown';
  return 'select';
}

/**
 * The valid layer a drill-down from a given layer may target. `function`
 * has no further layer to drill into — a double-click there stays within
 * open-source/selection only.
 */
const DRILL_DOWN_TARGET = { repository: 'file', file: 'function', function: null };

/**
 * Whether a coordinate is a legitimate drill-down target for a given
 * target layer. An ambiguous coordinate, or one missing the identity a
 * target layer requires (a path for 'file'; a resolved function/method
 * scope for 'function'), is never eligible — this is the single place
 * that rule is enforced, rather than trusting every future renderer to
 * check it independently.
 * @param {import('./sourceCoordinate.js').SourceCoordinate} coordinate
 * @param {import('./graphIR.js').GraphLayer} targetLayer
 * @returns {boolean}
 */
export function isDrillDownEligible(coordinate, targetLayer) {
  if (!coordinate || coordinate.ambiguous) return false;
  if (targetLayer === 'file') return !!normalizePath(coordinate.path);
  if (targetLayer === 'function') {
    return coordinate.symbolPath.length > 0 && (coordinate.symbolKind === 'function' || coordinate.symbolKind === 'method');
  }
  return false;
}

/**
 * @typedef {Object} SelectionEvent
 * @property {'select'} type
 * @property {string} nodeId
 * @property {import('./sourceCoordinate.js').SourceCoordinate|null} coordinate
 */

/**
 * Single-click intent: selection/focus only, no navigation.
 * @param {string} nodeId
 * @param {import('./sourceCoordinate.js').SourceCoordinate|null} coordinate
 * @returns {SelectionEvent}
 */
export function createSelectionEvent(nodeId, coordinate) {
  if (!nodeId) throw new NavigationError('createSelectionEvent requires a nodeId');
  return { type: 'select', nodeId, coordinate: coordinate || null };
}

/**
 * @typedef {'localDrillDown'|'newContext'|'cachedContext'} DrillDownIntent
 * The behavioral distinction a renderer must actually branch on — this is
 * `node.origin` (see graphIR.js) carried from validation into the one place
 * that distinction is supposed to govern, rather than being stranded in
 * schema validation and re-invented (or ignored) per renderer:
 * - 'localDrillDown' (from origin 'local') — ordinary same-context
 *   drill-down: request the next layer's graph using the *same*
 *   AnalysisContext the current graph already has.
 * - 'newContext' (from origin 'external') — the target lives in a
 *   different repository/revision; the renderer must establish a new
 *   AnalysisContext (a new top-level navigation, not a same-context
 *   drill-down) rather than silently reusing the current one.
 * - 'cachedContext' (from origin 'cached') — the target should be resolved
 *   through cache lookup/revalidation against its own (possibly different)
 *   context rather than assumed identical to the current graph's.
 */

/** @type {Record<import('./graphIR.js').CoordinateOrigin, DrillDownIntent>} */
const INTENT_BY_ORIGIN = { local: 'localDrillDown', external: 'newContext', cached: 'cachedContext' };

/**
 * @typedef {Object} DrillDownEvent
 * @property {'drillDown'} type
 * @property {import('./sourceCoordinate.js').SourceCoordinate} coordinate
 * @property {import('./graphIR.js').GraphLayer} sourceLayer
 * @property {import('./graphIR.js').GraphLayer} targetLayer
 * @property {import('./graphIR.js').CoordinateOrigin} origin
 * @property {DrillDownIntent} intent
 */

/**
 * Double-click intent: carries the selected coordinate, the layer it should
 * open into, and — carrying graphIR.js's local/external/cached/synthetic
 * node classification into the one place it's meant to govern — an
 * `intent` a renderer must branch on rather than treating every drill-down
 * identically. Throws rather than producing an event when the coordinate is
 * unresolved/ineligible, so an unresolved-symbol double-click never
 * silently dispatches an incorrect drill-down.
 *
 * @param {import('./sourceCoordinate.js').SourceCoordinate | {coordinate: import('./sourceCoordinate.js').SourceCoordinate, origin?: import('./graphIR.js').CoordinateOrigin}} node
 *   Either a bare coordinate (treated as `origin: 'local'`, matching the
 *   pre-origin call shape), or `{coordinate, origin}` — typically the
 *   selected GraphNode itself, since GraphNode already has both fields.
 * @param {import('./graphIR.js').GraphLayer} sourceLayer
 * @param {object} [options]
 * @param {import('./sourceCoordinate.js').SourceCoordinate} [options.anchorCoordinate]
 *   Required when the node's origin is 'synthetic' — a synthetic node (e.g.
 *   a control-flow entry/exit marker) has no source location of its own to
 *   drill down to, so the caller must separately supply a concrete
 *   navigation target.
 * @param {import('./graphIR.js').CoordinateOrigin} [options.anchorOrigin] - origin of options.anchorCoordinate; defaults to 'local'
 * @returns {DrillDownEvent}
 */
export function createDrillDownEvent(node, sourceLayer, options = {}) {
  let coordinate;
  let origin;
  if (node && typeof node === 'object' && 'coordinate' in node) {
    coordinate = node.coordinate;
    origin = node.origin || 'local';
  } else {
    coordinate = node;
    origin = 'local';
  }

  if (origin === 'synthetic') {
    if (!options.anchorCoordinate) {
      throw new NavigationError(
        "a synthetic node has no source location of its own to drill down to; supply options.anchorCoordinate naming a concrete navigation target"
      );
    }
    coordinate = options.anchorCoordinate;
    origin = options.anchorOrigin || 'local';
  }

  const targetLayer = DRILL_DOWN_TARGET[sourceLayer];
  if (!targetLayer) {
    throw new NavigationError(`layer ${JSON.stringify(sourceLayer)} has no drill-down target`);
  }
  if (!isDrillDownEligible(coordinate, targetLayer)) {
    throw new NavigationError(
      `coordinate is not a valid drill-down target for layer ${JSON.stringify(targetLayer)} (ambiguous or missing required identity)`
    );
  }
  const intent = INTENT_BY_ORIGIN[origin];
  if (!intent) {
    throw new NavigationError(`unknown coordinate origin ${JSON.stringify(origin)} for drill-down`);
  }

  return { type: 'drillDown', coordinate, sourceLayer, targetLayer, origin, intent };
}

/**
 * @typedef {Object} OpenSourceEvent
 * @property {'openSource'} type
 * @property {import('./sourceCoordinate.js').SourceCoordinate} coordinate
 */

/**
 * "View on GitHub"-style intent — opens the raw source at this coordinate's
 * repository/revision/path/range without changing the active graph layer.
 * Unlike drill-down, an ambiguous coordinate is still allowed here (you can
 * always view the file even if the exact symbol couldn't be resolved) as
 * long as it at least names a path.
 * @param {import('./sourceCoordinate.js').SourceCoordinate} coordinate
 * @returns {OpenSourceEvent}
 */
export function createOpenSourceEvent(coordinate) {
  if (!coordinate || !normalizePath(coordinate.path)) {
    throw new NavigationError('createOpenSourceEvent requires a coordinate with a path');
  }
  return { type: 'openSource', coordinate };
}

/**
 * @typedef {Object} BreadcrumbEntry
 * @property {import('./graphIR.js').GraphLayer} layer
 * @property {import('./sourceCoordinate.js').SourceCoordinate|null} coordinate
 * @property {string|null} selectedNodeId
 * @property {string|null} graphCacheKey - the cache key (see cacheKey.js) identifying the graph shown at this history entry, so back/forward can restore it from cache rather than re-running analysis
 * @property {string} label
 */

/**
 * @param {import('./graphIR.js').GraphLayer} layer
 * @param {import('./sourceCoordinate.js').SourceCoordinate|null} coordinate
 * @param {object} [options]
 * @param {string|null} [options.selectedNodeId]
 * @param {string|null} [options.graphCacheKey]
 * @param {string} [options.label]
 * @returns {BreadcrumbEntry}
 */
export function makeBreadcrumbEntry(layer, coordinate, options = {}) {
  return {
    layer,
    coordinate: coordinate || null,
    selectedNodeId: options.selectedNodeId || null,
    graphCacheKey: options.graphCacheKey || null,
    label: options.label || layer,
  };
}

/**
 * Deep-linkable navigation history: an ordinary back/forward stack of
 * BreadcrumbEntry values. Pushing after navigating back truncates the
 * discarded forward entries, matching standard browser history semantics
 * (and `window.history`'s own behavior, which src/state/route.js already
 * defers to for the repository-view-only URL it manages).
 */
export class NavigationHistory {
  /** @param {BreadcrumbEntry} initialEntry */
  constructor(initialEntry) {
    this._stack = [initialEntry];
    this._index = 0;
  }

  /** @param {BreadcrumbEntry} entry */
  push(entry) {
    this._stack = this._stack.slice(0, this._index + 1);
    this._stack.push(entry);
    this._index = this._stack.length - 1;
  }

  /** @returns {BreadcrumbEntry} */
  current() {
    return this._stack[this._index];
  }

  /**
   * Replace the current entry with a patched copy — how a panel records the
   * state it should be restored to (MOO-71 Commit 8): the cache key of the
   * graph it actually loaded, and which node was selected.
   *
   * `graphCacheKey` and `selectedNodeId` have existed on BreadcrumbEntry
   * since MOO-68 Commit 5 precisely so back/forward could restore a view
   * from cache instead of re-running analysis; nothing had ever written them
   * until now, so they were always null.
   *
   * Replaces rather than mutates so a caller holding a previous entry (React
   * props, a memo dependency) sees a changed identity instead of silently
   * reading a mutated object. Forward history is deliberately NOT truncated:
   * this records what is already being shown, it is not a navigation.
   *
   * @param {Partial<BreadcrumbEntry>} patch
   * @returns {BreadcrumbEntry} the updated entry
   */
  updateCurrent(patch) {
    const updated = { ...this._stack[this._index], ...patch };
    this._stack = this._stack.slice();
    this._stack[this._index] = updated;
    return updated;
  }

  get canGoBack() {
    return this._index > 0;
  }

  get canGoForward() {
    return this._index < this._stack.length - 1;
  }

  /** @returns {BreadcrumbEntry} */
  back() {
    if (!this.canGoBack) throw new NavigationError('cannot go back: already at the start of history');
    this._index -= 1;
    return this.current();
  }

  /** @returns {BreadcrumbEntry} */
  forward() {
    if (!this.canGoForward) throw new NavigationError('cannot go forward: already at the end of history');
    this._index += 1;
    return this.current();
  }

  /** @returns {BreadcrumbEntry[]} full breadcrumb trail up to and including the current entry */
  trail() {
    return this._stack.slice(0, this._index + 1);
  }
}
