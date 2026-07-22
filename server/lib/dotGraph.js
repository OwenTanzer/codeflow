// pyan3 DOT output parsing — MOO-70 Commit 3.
//
// Wraps `ts-graphviz` (chosen after a bounded maintenance check: it's the
// only actively-maintained DOT parser among the candidates considered —
// graphlib-dot/dotparser/@ts-graphviz/parser are all multi-year-abandoned
// single versions) and separates GraphViz *layout* attributes pyan3 also
// emits (fillcolor, fontcolor, style, group, rankdir — presentation only)
// from the *semantic* content the pyan3 join (Commit 4) actually needs:
// each node's dotted qualified name, source file path, source line, and
// symbol kind, all of which pyan3 packs into its `tooltip` attribute
// rather than exposing structurally.
import { fromDot } from 'ts-graphviz';
import { AdapterError } from '../../src/graph-ir/adapterResult.js';

// pyan3's tooltip is not a documented contract we control — its shape was
// established by inspection of real pyan3 2.6.2 output (see the MOO-70
// Commit 3 plan), not from pyan3's own docs:
//   module node:            "<qualifiedName>\n<path>"
//   class/function/method:  "<qualifiedName>\n<path>:<line>\n<kind> in <parentScope>"
// Note: DOT quoted strings don't do C-style escape processing except for
// Graphviz's own \n/\l/\r line-break markers, which are interpreted at
// render time, not string-parse time — ts-graphviz hands back the
// *literal* two-character "\n" sequence here, not a real newline.
//
// That literal sequence cannot be blindly split on: an absolute Windows
// path segment starting with a name beginning "n" (e.g.
// "...\req-1\nested.py") contains the exact same two characters by
// coincidence (backslash + "n" from the path separator + filename). A
// naive global split silently corrupted the qualifiedName/path boundary
// on real fixture output. Fixed by only ever taking the *first* literal
// "\n" occurrence (safe — a Python dotted qualified name can never
// contain a backslash) and anchoring the kind/line extraction at the
// *end* of the string via regex, rather than a second blind split.
function parseTooltip(tooltip) {
  const empty = { qualifiedName: null, path: null, line: null, kind: 'unknown', parentScope: null };
  if (typeof tooltip !== 'string' || tooltip.length === 0) return empty;

  const firstBreak = tooltip.indexOf('\\n');
  if (firstBreak === -1) {
    return { qualifiedName: tooltip, path: null, line: null, kind: 'module', parentScope: null };
  }
  const qualifiedName = tooltip.slice(0, firstBreak);
  let rest = tooltip.slice(firstBreak + 2);

  let kind = 'module';
  let parentScope = null;
  const kindMatch = /\\n(\w+) in (.+)$/.exec(rest);
  if (kindMatch) {
    kind = kindMatch[1];
    parentScope = kindMatch[2];
    rest = rest.slice(0, kindMatch.index);
  }

  let path = rest || null;
  let line = null;
  const lineMatch = /^(.*):(\d+)$/.exec(rest);
  if (lineMatch) {
    path = lineMatch[1];
    line = Number(lineMatch[2]);
  }

  return { qualifiedName, path, line, kind, parentScope };
}

function attrMap(attributesGroup) {
  const attrs = {};
  for (const [key, value] of attributesGroup.values) attrs[key] = value;
  return attrs;
}

// Confirmed against a dedicated cross-method-call fixture
// (tests/fixtures/python-symbols/calls.py: Greeter.greet calling
// Greeter.build_message), not just the incidental containment edges seen
// in other fixtures.
function classifyEdgeKind(attrs) {
  if (attrs.style === 'dashed' && attrs.color === '#838b8b') return 'defines';
  if (attrs.style === 'solid' && attrs.color === '#000000') return 'uses';
  return 'unknown';
}

function targetId(target) {
  return target && typeof target === 'object' && target.id !== undefined ? target.id : target;
}

function walkNodes(container, out) {
  for (const node of container.nodes) {
    const attrs = attrMap(node.attributes);
    out.push({ id: node.id, label: attrs.label || null, ...parseTooltip(attrs.tooltip) });
  }
  for (const subgraph of container.subgraphs) walkNodes(subgraph, out);
}

function walkEdges(container, out) {
  for (const edge of container.edges) {
    const attrs = attrMap(edge.attributes);
    const targets = edge.targets.map(targetId);
    out.push({ source: targets[0], target: targets[targets.length - 1], kind: classifyEdgeKind(attrs) });
  }
  for (const subgraph of container.subgraphs) walkEdges(subgraph, out);
}

/**
 * Parse raw pyan3 DOT text into a ts-graphviz Digraph model. Any parse
 * failure (malformed DOT) is rethrown as an AdapterError categorized
 * 'malformed_analyzer_output' rather than a generic/untyped exception.
 * @param {string} dotString
 * @returns {import('ts-graphviz').Digraph}
 */
export function parseDotGraph(dotString) {
  try {
    return fromDot(dotString);
  } catch (err) {
    throw new AdapterError('malformed_analyzer_output', `pyan3 produced DOT that could not be parsed: ${err.message}`, { cause: err });
  }
}

/**
 * Flatten every node in the graph (including those nested in pyan3's
 * `--grouped` subgraph clusters) into the semantic fields the Commit 4
 * join needs, dropping presentation-only GraphViz attributes
 * (fillcolor/fontcolor/style/group/rankdir).
 * @param {import('ts-graphviz').Digraph} digraph
 * @returns {{id: string, label: string|null, qualifiedName: string|null, path: string|null, line: number|null, kind: string, parentScope: string|null}[]}
 */
export function extractPyanNodes(digraph) {
  const out = [];
  walkNodes(digraph, out);
  return out;
}

/**
 * Flatten every edge in the graph into {source, target, kind}, where kind
 * is 'defines' (containment: module->class, class->method) or 'uses' (an
 * actual call), derived from pyan3's edge style/color convention.
 * @param {import('ts-graphviz').Digraph} digraph
 * @returns {{source: string, target: string, kind: 'defines'|'uses'|'unknown'}[]}
 */
export function extractPyanEdges(digraph) {
  const out = [];
  walkEdges(digraph, out);
  return out;
}
