// Function-layer graph (layered control-flow) renderer — MOO-71 Commit 7.
//
// MOO-71's governing decision is "prefer the shared renderer and interaction
// contract, but allow a specialized function renderer if usability requires
// it." The shared file-layer renderer (src/render/fileGraph.js) was actually
// run against a real function graph before this file was written, and the
// comparison is recorded in docs/function-layer-renderer.md: a force
// simulation has no way to express that a control-flow graph has a correct
// reading order, and loop back-edges become indistinguishable from forward
// flow. That is the "materially worse" the ticket allows specializing for.
//
// What is deliberately NOT specialized -- so the fallback stays "swappable
// and route-compatible" as the ticket requires:
//   - Input is the same function-layer GraphIR the adapter already produces;
//     no renderer-specific analysis, and no data is altered by the choice of
//     renderer.
//   - The option contract matches renderFileGraph exactly (svgEl, graph,
//     theme, zoomRef, selectSymbolRef, activateSymbolRef, onHover,
//     onBackgroundClick) and it returns the same cleanup function, so either
//     renderer can be dropped into the other's call site.
//   - Interaction goes through src/graph-ir/navigation.js's contract:
//     single click selects, double click carries drill-down intent.
//
// The returned cleanup function carries two extra imperative helpers
// (`applySearch`, `applySelection`) so the panel can highlight without
// re-rendering the whole SVG and throwing away the user's zoom/pan on every
// keystroke. Callers that only ever invoke the cleanup function -- like the
// file layer's -- are unaffected.
//
// `d3` is read as an ambient global (window.d3), same pattern
// repositoryGraph.js, fileGraph.js and src/analyzer.js use.
/* eslint-disable no-undef */
import { buildFunctionRenderModel } from './functionRenderModel.js';

// One palette entry per *semantic kind*, not per shape: entry/exit read as
// terminals, branches as decisions, calls as outward jumps, everything else
// as ordinary statements. Deliberately small, matching fileGraph.js's own
// "small palette instead of colorMode variants" precedent.
const COLOR_BY_KIND = {
  entry: '#34d399',
  exit: '#f87171',
  branch: '#fbbf24',
  call: '#a78bfa',
  process: '#60a5fa',
};
const NODE_W = 132;
const NODE_H = 34;
const TERMINAL_R = 15;
const BRANCH_R = 24;
const MAX_LABEL = 20;

// MOO-86: process/call (rect) node labels wrap onto a second line instead of
// being hard-truncated at MAX_LABEL -- entry/exit and branch (diamond) nodes
// keep single-line truncation, since their fixed circular/diamond footprint
// (TERMINAL_R/BRANCH_R) has no extra room to grow into without colliding with
// the shape's own point. MAX_CHARS_PER_LINE tracks MAX_LABEL (the width both
// were tuned against is the same NODE_W), and LINE_H is small enough that a
// wrapped two-line box (NODE_H + LINE_H) still fits inside RANK_HEIGHT's
// (functionRenderModel.js) existing 60px-34px = 26px of slack per rank.
const MAX_CHARS_PER_LINE = 18;
const LINE_H = 12;
const WORD_BREAK_PATTERN = /[\s_.\-(),:]/;

function colorFor(d) {
  return COLOR_BY_KIND[d.kind] || COLOR_BY_KIND.process;
}

function isWrappable(d) {
  return !d.isEntry && !d.isExit && d.shape !== 'diamond';
}

/**
 * Split a label into at most two lines for a rect node, breaking near the
 * midpoint on a word/punctuation boundary when one exists close by so a
 * split doesn't land mid-identifier more than necessary. Each line is
 * independently capped at MAX_CHARS_PER_LINE with an ellipsis, so a label
 * that's still too long after wrapping degrades the same way single-line
 * truncation always did, rather than overflowing the box.
 * @returns {string[]} one entry (unwrapped) or two (wrapped)
 */
function wrapLabel(label) {
  if (!label) return [''];
  if (label.length <= MAX_CHARS_PER_LINE) return [label];
  var mid = Math.ceil(label.length / 2);
  var breakIndex = -1;
  for (var offset = 0; offset <= 8; offset++) {
    if (mid + offset < label.length && WORD_BREAK_PATTERN.test(label[mid + offset])) { breakIndex = mid + offset; break; }
    if (mid - offset >= 0 && WORD_BREAK_PATTERN.test(label[mid - offset])) { breakIndex = mid - offset; break; }
  }
  var first = breakIndex > 0 ? label.slice(0, breakIndex).trim() : label.slice(0, MAX_CHARS_PER_LINE);
  var rest = breakIndex > 0 ? label.slice(breakIndex + 1).trim() : label.slice(MAX_CHARS_PER_LINE);
  if (first.length > MAX_CHARS_PER_LINE) first = first.slice(0, MAX_CHARS_PER_LINE - 1) + '…';
  if (rest.length > MAX_CHARS_PER_LINE) rest = rest.slice(0, MAX_CHARS_PER_LINE - 1) + '…';
  return [first, rest];
}

// Cached on the datum (one render pass per node) so shapePath/halfHeight and
// the actual text rendering never compute -- and never disagree on -- the
// line count independently.
function linesFor(d) {
  if (d._wrappedLines) return d._wrappedLines;
  d._wrappedLines = isWrappable(d) ? wrapLabel(d.label) : [truncate(d.label)];
  return d._wrappedLines;
}

function boxHeight(d) {
  return linesFor(d).length > 1 ? NODE_H + LINE_H : NODE_H;
}

// Half-height of a node, needed to anchor edges on its boundary rather than
// its center so arrowheads don't disappear under the shape.
function halfHeight(d) {
  if (d.isEntry || d.isExit) return TERMINAL_R;
  if (d.shape === 'diamond') return BRANCH_R;
  return boxHeight(d) / 2;
}

function halfWidth(d) {
  if (d.isEntry || d.isExit) return TERMINAL_R;
  if (d.shape === 'diamond') return BRANCH_R;
  return NODE_W / 2;
}

function shapePath(d) {
  if (d.isEntry || d.isExit) {
    var r = TERMINAL_R;
    return 'M' + -r + ',0A' + r + ',' + r + ' 0 1,0 ' + r + ',0A' + r + ',' + r + ' 0 1,0 ' + -r + ',0';
  }
  if (d.shape === 'diamond') {
    var b = BRANCH_R;
    return 'M0,' + -b + 'L' + b + ',0L0,' + b + 'L' + -b + ',0Z';
  }
  var hw = NODE_W / 2;
  var hh = boxHeight(d) / 2;
  return 'M' + -hw + ',' + -hh + 'H' + hw + 'V' + hh + 'H' + -hw + 'Z';
}

function truncate(label) {
  if (!label) return '';
  return label.length > MAX_LABEL ? label.slice(0, MAX_LABEL - 1) + '…' : label;
}

// Forward flow: straight down when the ranks line up, otherwise an elbow
// (down, across, down). Orthogonal rather than curved because a flowchart's
// value is in reading execution order, and right angles make the rank
// structure legible.
function forwardPath(s, t) {
  var sy = s.y + halfHeight(s);
  var ty = t.y - halfHeight(t);
  if (Math.abs(s.x - t.x) < 1) return 'M' + s.x + ',' + sy + 'V' + ty;
  var mid = sy + (ty - sy) / 2;
  return 'M' + s.x + ',' + sy + 'V' + mid + 'H' + t.x + 'V' + ty;
}

// Back-edges (a loop returning to its header) are routed into a lane to the
// RIGHT of the entire drawing and drawn as a dashed curve, so a cycle is
// visually obvious instead of looking like flow that inexplicably points
// upward. Lanes are staggered per edge so multiple `continue` paths into one
// loop header don't overlap into a single thick smear.
//
// The lane sits outside every node rather than just outside the two endpoints
// (the first implementation): a long back-edge -- and a real `continue` from
// rank ~35 to a loop header at rank ~6 is long -- otherwise swept diagonally
// across the middle of the graph and crossed everything between, which the
// first screenshot showed as a large X over the node column.
function backPath(s, t, lane, laneBaseX) {
  var laneX = laneBaseX + lane * 20;
  var sx = s.x + halfWidth(s);
  var tx = t.x + halfWidth(t);
  return 'M' + sx + ',' + s.y +
    'C' + laneX + ',' + s.y + ' ' + laneX + ',' + t.y + ' ' + tx + ',' + t.y;
}

/**
 * @param {object} options
 * @param {SVGSVGElement} options.svgEl
 * @param {import('../graph-ir/graphIR.js').GraphIR} options.graph
 * @param {'light'|'dark'} options.theme
 * @param {{current: any}} options.zoomRef
 * @param {{current: (id: string) => void}} options.selectSymbolRef - single-click ("select")
 * @param {{current: (id: string) => void}} options.activateSymbolRef - double-click (drill-down intent)
 * @param {(info: {x:number,y:number,title:string,content:string}|null) => void} options.onHover
 * @param {() => void} options.onBackgroundClick
 * @returns {(() => void) & {applySearch?: (q: string) => void, applySelection?: (id: string|null) => void}}
 */
export function renderFunctionGraph(options) {
  const { svgEl, graph, theme, zoomRef, selectSymbolRef, activateSymbolRef, onHover, onBackgroundClick } = options;

  var cleanup = function () {};
  if (!graph || !svgEl) return cleanup;

  var svg = d3.select(svgEl);
  svg.selectAll('*').remove();

  try {
    var model = buildFunctionRenderModel(graph);
    if (model.nodes.length === 0) return cleanup;

    var nodeById = new Map(model.nodes.map(function (n) { return [n.id, n]; }));
    var edgeColor = theme === 'light' ? '#b8b8b8' : '#4a4a4a';
    var textColor = theme === 'light' ? '#333' : '#eee';

    var zoom = d3.zoom().scaleExtent([0.15, 4]).on('zoom', function (e) { container.attr('transform', e.transform); });
    svg.call(zoom);
    zoomRef.current = zoom;
    var container = svg.append('g');

    var defs = svg.append('defs');
    defs.append('marker').attr('id', 'fn-arr').attr('viewBox', '0 -5 10 10').attr('refX', 9)
      .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L10,0L0,4').attr('fill', edgeColor);
    defs.append('marker').attr('id', 'fn-arr-back').attr('viewBox', '0 -5 10 10').attr('refX', 9)
      .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L10,0L0,4').attr('fill', '#fbbf24');

    var linkLayer = container.append('g');
    var edgeLabelLayer = container.append('g');
    var nodeLayer = container.append('g');

    // Initial view fits the graph's WIDTH and anchors at the top, rather than
    // fitting its height.
    //
    // Fitting height was the first implementation and it was wrong, which only
    // became visible in a real screenshot: a real 55-node function is ~40
    // ranks deep, so fitting that into a 420px panel forced ~0.2 scale and
    // every label became an unreadable smudge. A control-flow graph is
    // legitimately tall; the useful default is to start at the entry, at a
    // scale you can actually read, and let the user pan down -- so MIN_SCALE
    // is a floor the fit is never allowed to go below. This is the ticket's
    // "preserve control-flow readability over visual uniformity" applied to
    // the one decision that actually determines legibility.
    var MIN_SCALE = 0.55;

    // Back-edge lanes live to the right of the rightmost node, so the fitted
    // width has to account for them or the loop curves fall outside the view.
    var rightmost = 0;
    model.nodes.forEach(function (n) { rightmost = Math.max(rightmost, n.x + halfWidth(n)); });
    var laneBaseX = rightmost + 34;
    var backEdgeCount = model.links.filter(function (l) { return l.isBackEdge; }).length;
    var drawnWidth = backEdgeCount > 0 ? laneBaseX + Math.min(backEdgeCount, 4) * 20 + 16 : model.width;

    var w = svgEl.clientWidth || drawnWidth;
    var scale = Math.max(MIN_SCALE, Math.min(1, w / (drawnWidth + 40)));
    var initial = d3.zoomIdentity.translate((w - drawnWidth * scale) / 2, 16).scale(scale);
    svg.call(zoom.transform, initial);

    var backLane = 0;
    var links = model.links.map(function (l) {
      var s = nodeById.get(l.source);
      var t = nodeById.get(l.target);
      var lane = l.isBackEdge ? backLane++ % 4 : 0;
      return {
        data: l,
        source: s,
        target: t,
        d: l.isBackEdge ? backPath(s, t, lane, laneBaseX) : forwardPath(s, t),
      };
    });

    linkLayer.selectAll('path').data(links).join('path')
      .attr('d', function (l) { return l.d; })
      .attr('fill', 'none')
      .attr('stroke', function (l) { return l.data.isBackEdge ? '#fbbf24' : edgeColor; })
      .attr('stroke-width', function (l) { return l.data.isBackEdge ? 1.5 : 1.6; })
      .attr('stroke-dasharray', function (l) { return l.data.isBackEdge ? '5,3' : null; })
      .attr('stroke-opacity', function (l) { return l.data.isBackEdge ? 0.85 : 0.6; })
      .attr('marker-end', function (l) { return l.data.isBackEdge ? 'url(#fn-arr-back)' : 'url(#fn-arr)'; });

    // True/False and loop/exception labels are the part of a control-flow
    // graph that carries the branch semantics, so they are drawn rather than
    // left to hover discovery.
    var labelled = links.filter(function (l) {
      return l.data.label || l.data.kind === 'flow-true' || l.data.kind === 'flow-false';
    });
    edgeLabelLayer.selectAll('text').data(labelled).join('text')
      .attr('x', function (l) { return (l.source.x + l.target.x) / 2 + 6; })
      .attr('y', function (l) { return (l.source.y + l.target.y) / 2; })
      .attr('fill', function (l) {
        if (l.data.kind === 'flow-true') return '#34d399';
        if (l.data.kind === 'flow-false') return '#f87171';
        return theme === 'light' ? '#888' : '#777';
      })
      .attr('font-size', '9px').attr('font-family', 'JetBrains Mono')
      .attr('pointer-events', 'none')
      .text(function (l) {
        if (l.data.label) return l.data.label;
        return l.data.kind === 'flow-true' ? 'true' : 'false';
      });

    var node = nodeLayer.selectAll('g').data(model.nodes).join('g')
      .attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; })
      .style('cursor', 'pointer');

    node.append('path').attr('class', 'fn-nc')
      .attr('d', shapePath)
      .attr('fill', function (d) { return d3.color(colorFor(d)).copy({ opacity: 0.22 }); })
      .attr('stroke', colorFor)
      .attr('stroke-width', 1.6)
      // A synthetic marker (entry/exit) has no source location of its own;
      // the dashed outline is the same "this isn't real source" signal the
      // file layer uses for nodes without relationship data.
      .attr('stroke-dasharray', function (d) { return d.isSynthetic ? '3,2' : null; });

    // MOO-86: a label too wide for a rect node now wraps onto a second
    // tspan (linesFor/wrapLabel above) instead of being cut off -- entry/
    // exit/diamond nodes keep the old single-line truncation, since their
    // shapes have no room to grow into.
    node.append('text').attr('class', 'fn-nl')
      .attr('text-anchor', 'middle')
      .attr('fill', textColor)
      .attr('font-size', '9px').attr('font-family', 'JetBrains Mono').attr('font-weight', '500')
      .attr('pointer-events', 'none')
      .each(function (d) {
        var lines = linesFor(d);
        var textSel = d3.select(this);
        var startDy = lines.length > 1 ? 3 - LINE_H / 2 : 3;
        lines.forEach(function (line, i) {
          textSel.append('tspan').attr('x', 0).attr('dy', i === 0 ? startDy : LINE_H).text(line);
        });
      });

    node.on('click', function (e, d) {
      e.stopPropagation();
      applySelection(d.id);
      if (selectSymbolRef && selectSymbolRef.current) selectSymbolRef.current(d.id);
    });
    node.on('dblclick', function (e, d) {
      e.stopPropagation();
      if (activateSymbolRef && activateSymbolRef.current) activateSymbolRef.current(d.id);
    });
    node.on('mouseenter', function (e, d) {
      var r = svgEl.getBoundingClientRect();
      onHover({
        x: e.clientX - r.left + 10,
        y: e.clientY - r.top,
        title: d.label,
        content: d.kind + (d.flowchartNodeType && d.flowchartNodeType !== d.kind ? ' · ' + d.flowchartNodeType : ''),
      });
    }).on('mouseleave', function () { onHover(null); });

    svg.on('click', function (e) {
      if (e.target === svgEl) {
        applySelection(null);
        onBackgroundClick();
      }
    });

    // Selection dims everything that is not the node itself or one of its
    // direct control-flow neighbors, which is what makes "what can reach
    // this, and what does it reach" answerable at a glance.
    var neighbors = new Map(model.nodes.map(function (n) { return [n.id, new Set([n.id])]; }));
    model.links.forEach(function (l) {
      neighbors.get(l.source).add(l.target);
      neighbors.get(l.target).add(l.source);
    });

    function applySelection(selectedId) {
      var keep = selectedId ? neighbors.get(selectedId) : null;
      node.attr('opacity', function (d) { return !keep || keep.has(d.id) ? 1 : 0.18; });
      node.selectAll('.fn-nc').attr('stroke-width', function (d) { return selectedId === d.id ? 3 : 1.6; });
      linkLayer.selectAll('path').attr('stroke-opacity', function (l) {
        var base = l.data.isBackEdge ? 0.85 : 0.6;
        if (!selectedId) return base;
        return l.source.id === selectedId || l.target.id === selectedId ? 1 : 0.1;
      });
    }

    // Search highlights in place rather than filtering nodes out: in a
    // control-flow graph, removing a matched node's surroundings destroys
    // the very context that makes the match meaningful.
    function applySearch(query) {
      var q = (query || '').trim().toLowerCase();
      node.selectAll('.fn-nc')
        .attr('stroke', function (d) {
          if (!q) return colorFor(d);
          return d.label && d.label.toLowerCase().includes(q) ? '#f0abfc' : colorFor(d);
        })
        .attr('stroke-width', function (d) {
          if (!q) return 1.6;
          return d.label && d.label.toLowerCase().includes(q) ? 3 : 1;
        });
      node.attr('opacity', function (d) {
        if (!q) return 1;
        return d.label && d.label.toLowerCase().includes(q) ? 1 : 0.3;
      });
    }

    cleanup = function () { svg.on('.zoom', null); };
    cleanup.applySearch = applySearch;
    cleanup.applySelection = applySelection;
    return cleanup;
  } catch (e) {
    console.error('Function graph render error:', e);
    svg.selectAll('*').remove();
    svg.append('text').attr('x', 20).attr('y', 30).attr('fill', 'var(--t3)')
      .text('Function graph rendering error: ' + e.message);
    return cleanup;
  }
}
