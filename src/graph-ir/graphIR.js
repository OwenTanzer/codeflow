// Versioned GraphIR — MOO-68 Commit 3.
//
// The one schema repository/file/function graphs all validate against.
// "One shared architecture does not imply visual sameness" (MOO-68's
// governing decision): every layer emits the same envelope (nodes, edges,
// groups, provenance, rendering hints) but is free to choose its own
// `kind` vocabulary, colors (via `hints.colorRole`, a semantic role — not a
// literal color, so each layer's theme can still differ), and layout
// preference. Validation intentionally does not reject unknown extra
// fields anywhere in the tree — layer-specific metadata and future schema
// growth must be safely ignorable by older consumers rather than rejected.
import { makeCoordinate } from './sourceCoordinate.js';

export const GRAPH_IR_SCHEMA_VERSION = 1;

/** @typedef {'repository'|'file'|'function'} GraphLayer */

/**
 * @typedef {Object} RenderHints
 * @property {string} [shape] - e.g. 'circle', 'rect', 'diamond' — renderer-interpreted, not enumerated here so a new layer can introduce a new shape without a schema bump
 * @property {string} [colorRole] - semantic role (e.g. 'entryPoint', 'external', 'warning'), not a literal color — the renderer's theme maps roles to actual colors, so repository/file/function layers can use different palettes for the same role
 * @property {string} [icon]
 * @property {string} [groupHint] - suggested visual grouping key, independent of `groupId`'s structural membership
 * @property {'force'|'hierarchical'|'grid'|'treemap'} [layoutPreference]
 * @property {boolean} [isEntry]
 * @property {boolean} [isExit]
 */

/**
 * @typedef {'local'|'external'|'cached'|'synthetic'} CoordinateOrigin
 * - 'local' (default): coordinate must belong to the graph's own analyzed
 *   context — same source repository (context.sourceOwner/sourceRepo) and
 *   same context.resolvedSha. This is the invariant MOO-68 exists to
 *   protect: a graph pinned to one revision must not silently carry
 *   drill-down coordinates from another.
 * - 'external': an intentional cross-repository reference (e.g. a
 *   repository-layer dependency edge into another project) — the
 *   coordinate may name a different repository/revision, but must still
 *   name one concretely (not null).
 * - 'cached': resolved from a previously cached, compatible analysis rather
 *   than the current one — may differ from the current context for the
 *   same reason 'external' may; must still be concrete.
 * - 'synthetic': the node has no single real source location (e.g. a
 *   control-flow entry/exit marker, or a synthetic PR/diff summary node) —
 *   coordinate is typically null, but is not required to be.
 */

/**
 * @typedef {Object} GraphNode
 * @property {string} id - unique within this graph
 * @property {GraphLayer} layer - must match the parent graph's layer; present per-node (not just once on the graph) so a node retains identity if ever extracted/logged independently
 * @property {string} kind - layer-defined semantic type (e.g. 'file', 'class', 'function', 'call') — free-form on purpose, not a closed enum, so each layer keeps its own vocabulary
 * @property {string} label
 * @property {import('./sourceCoordinate.js').SourceCoordinate|null} coordinate
 * @property {string|null} groupId - references a Group.id in the same graph, or null
 * @property {CoordinateOrigin} [origin] - defaults to 'local' when omitted
 * @property {RenderHints} [hints]
 * @property {object} [metadata] - layer-specific, arbitrary, safely ignorable by other layers
 */

/**
 * @typedef {Object} GraphEdge
 * @property {string} id - unique within this graph
 * @property {GraphLayer} layer
 * @property {string} kind - e.g. 'imports', 'calls', 'inherits'
 * @property {string} source - a Node.id in the same graph
 * @property {string} target - a Node.id in the same graph
 * @property {RenderHints} [hints]
 * @property {object} [metadata]
 */

/**
 * @typedef {Object} GraphGroup
 * @property {string} id - unique within this graph
 * @property {GraphLayer} layer
 * @property {string} label
 * @property {string|null} parentGroupId - references another Group.id in the same graph, or null for a top-level group
 */

/**
 * @typedef {Object} GraphIR
 * @property {number} schemaVersion
 * @property {GraphLayer} layer
 * @property {import('./githubContext.js').AnalysisContext} context
 * @property {import('./sourceCoordinate.js').SourceCoordinate|null} rootCoordinate - what this graph is "of" (null for a whole-repository graph with no single anchor)
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 * @property {GraphGroup[]} groups
 * @property {{name: string, version: string}} analyzer
 * @property {number} confidence - 0 (unreliable) to 1 (fully resolved)
 * @property {string[]} warnings
 * @property {string} generatedAt - ISO 8601 timestamp
 */

const LAYERS = new Set(['repository', 'file', 'function']);
const NODE_ORIGINS = new Set(['local', 'external', 'cached', 'synthetic']);

/**
 * Whether a coordinate belongs to the graph's own analyzed context — same
 * resolved source repository (not the requested base repository, which can
 * differ for a forked PR — see githubContext.js) and same resolved
 * revision. This is the check a 'local' (the default) node/rootCoordinate
 * must pass.
 * @param {import('./sourceCoordinate.js').SourceCoordinate} coordinate
 * @param {import('./githubContext.js').AnalysisContext} context
 * @returns {boolean}
 */
function coordinateMatchesContext(coordinate, context) {
  return (
    coordinate.repository.owner.toLowerCase() === context.sourceOwner.toLowerCase() &&
    coordinate.repository.name.toLowerCase() === context.sourceRepo.toLowerCase() &&
    coordinate.revision === context.resolvedSha
  );
}

/**
 * Validate a GraphIR object structurally. Returns a result object rather
 * than throwing, since callers (adapters producing partial results per
 * Commit 4) need to inspect specific errors without a try/catch, and a
 * fixture-validation test suite wants to assert on error content.
 * @param {object} graph
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateGraphIR(graph) {
  const errors = [];
  if (!graph || typeof graph !== 'object') {
    return { valid: false, errors: ['graph must be an object'] };
  }

  if (graph.schemaVersion !== GRAPH_IR_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${GRAPH_IR_SCHEMA_VERSION}, got: ${JSON.stringify(graph.schemaVersion)}`);
  }
  if (!LAYERS.has(graph.layer)) {
    errors.push(`layer must be one of ${[...LAYERS].join(', ')}, got: ${JSON.stringify(graph.layer)}`);
  }
  const contextValid =
    !!graph.context &&
    typeof graph.context === 'object' &&
    !!graph.context.resolvedSha &&
    !!graph.context.owner &&
    !!graph.context.repo &&
    !!graph.context.sourceOwner &&
    !!graph.context.sourceRepo;
  if (!contextValid) {
    errors.push('context is required and must be a normalized AnalysisContext (see githubContext.js)');
  }
  if (graph.rootCoordinate !== null) {
    try {
      const rootCoordinate = makeCoordinate(graph.rootCoordinate);
      // rootCoordinate defines what this graph is "of" — it must always be
      // local to the graph's own analyzed context; there is no legitimate
      // "external rootCoordinate" the way an individual node can reference
      // something outside the graph.
      if (contextValid && !coordinateMatchesContext(rootCoordinate, graph.context)) {
        errors.push(
          "rootCoordinate does not match the graph's analyzed context (source repository/revision) — a graph pinned to one revision must not be anchored to a coordinate from another"
        );
      }
    } catch (err) {
      errors.push(`rootCoordinate is invalid: ${err.message}`);
    }
  }
  if (!graph.analyzer || typeof graph.analyzer.name !== 'string' || typeof graph.analyzer.version !== 'string') {
    errors.push('analyzer.name and analyzer.version are required strings');
  }
  if (typeof graph.confidence !== 'number' || graph.confidence < 0 || graph.confidence > 1) {
    errors.push(`confidence must be a number between 0 and 1, got: ${JSON.stringify(graph.confidence)}`);
  }
  if (!Array.isArray(graph.warnings) || graph.warnings.some((w) => typeof w !== 'string')) {
    errors.push('warnings must be an array of strings');
  }
  if (typeof graph.generatedAt !== 'string' || Number.isNaN(Date.parse(graph.generatedAt))) {
    errors.push('generatedAt must be an ISO 8601 timestamp string');
  }

  if (!Array.isArray(graph.groups)) {
    errors.push('groups must be an array');
  }
  const groupIds = new Set();
  if (Array.isArray(graph.groups)) {
    for (const group of graph.groups) {
      if (!group || typeof group.id !== 'string' || !group.id) {
        errors.push('every group must have a non-empty string id');
        continue;
      }
      if (groupIds.has(group.id)) errors.push(`duplicate group id: ${group.id}`);
      groupIds.add(group.id);
      if (group.layer !== graph.layer) errors.push(`group ${group.id} has layer ${JSON.stringify(group.layer)}, expected ${JSON.stringify(graph.layer)}`);
    }
    for (const group of graph.groups) {
      if (group && group.parentGroupId != null && !groupIds.has(group.parentGroupId)) {
        errors.push(`group ${group.id} references unknown parentGroupId: ${group.parentGroupId}`);
      }
    }
  }

  if (!Array.isArray(graph.nodes)) {
    errors.push('nodes must be an array');
  }
  const nodeIds = new Set();
  if (Array.isArray(graph.nodes)) {
    for (const node of graph.nodes) {
      if (!node || typeof node.id !== 'string' || !node.id) {
        errors.push('every node must have a non-empty string id');
        continue;
      }
      if (nodeIds.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
      nodeIds.add(node.id);
      if (node.layer !== graph.layer) errors.push(`node ${node.id} has layer ${JSON.stringify(node.layer)}, expected ${JSON.stringify(graph.layer)} — invalid cross-layer node`);
      if (typeof node.kind !== 'string' || !node.kind) errors.push(`node ${node.id} must have a non-empty string kind`);
      if (typeof node.label !== 'string') errors.push(`node ${node.id} must have a string label`);

      const origin = node.origin != null ? node.origin : 'local';
      if (!NODE_ORIGINS.has(origin)) {
        errors.push(`node ${node.id} has an invalid origin ${JSON.stringify(node.origin)} (must be one of ${[...NODE_ORIGINS].join(', ')})`);
      }

      if (node.coordinate !== null) {
        try {
          const coordinate = makeCoordinate(node.coordinate);
          if (origin === 'local' && contextValid && !coordinateMatchesContext(coordinate, graph.context)) {
            errors.push(
              `node ${node.id} coordinate does not match the graph's analyzed context (source repository/revision) — this is only valid for a node explicitly marked origin: 'external'/'cached'/'synthetic'; a 'local' (the default) node cannot silently point outside the analyzed revision`
            );
          }
        } catch (err) {
          errors.push(`node ${node.id} has an invalid coordinate: ${err.message}`);
        }
      } else if (origin === 'external' || origin === 'cached') {
        errors.push(`node ${node.id} declares origin ${JSON.stringify(origin)} but has no coordinate identifying what it references`);
      }

      if (node.groupId != null && !groupIds.has(node.groupId)) {
        errors.push(`node ${node.id} references unknown groupId: ${node.groupId}`);
      }
    }
  }

  if (!Array.isArray(graph.edges)) {
    errors.push('edges must be an array');
  }
  if (Array.isArray(graph.edges)) {
    const edgeIds = new Set();
    for (const edge of graph.edges) {
      if (!edge || typeof edge.id !== 'string' || !edge.id) {
        errors.push('every edge must have a non-empty string id');
        continue;
      }
      if (edgeIds.has(edge.id)) errors.push(`duplicate edge id: ${edge.id}`);
      edgeIds.add(edge.id);
      if (edge.layer !== graph.layer) errors.push(`edge ${edge.id} has layer ${JSON.stringify(edge.layer)}, expected ${JSON.stringify(graph.layer)} — invalid cross-layer edge`);
      if (typeof edge.kind !== 'string' || !edge.kind) errors.push(`edge ${edge.id} must have a non-empty string kind`);
      if (!nodeIds.has(edge.source)) errors.push(`edge ${edge.id} references unknown source node: ${JSON.stringify(edge.source)} — cross-layer or dangling edge reference`);
      if (!nodeIds.has(edge.target)) errors.push(`edge ${edge.id} references unknown target node: ${JSON.stringify(edge.target)} — cross-layer or dangling edge reference`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export class GraphIRError extends Error {
  constructor(errors) {
    super('Invalid GraphIR:\n' + errors.map((e) => ' - ' + e).join('\n'));
    this.name = 'GraphIRError';
    this.errors = errors;
  }
}

/**
 * Construct a GraphIR, throwing GraphIRError on any structural violation.
 * Fills in schemaVersion/generatedAt when omitted, since every producer
 * would otherwise repeat the same two lines.
 * @param {object} input
 * @returns {GraphIR}
 */
export function makeGraphIR(input) {
  const graph = {
    schemaVersion: GRAPH_IR_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    warnings: [],
    groups: [],
    rootCoordinate: null,
    ...input,
  };
  const { valid, errors } = validateGraphIR(graph);
  if (!valid) throw new GraphIRError(errors);
  return graph;
}
