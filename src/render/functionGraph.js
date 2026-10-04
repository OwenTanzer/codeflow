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
import { LABEL_FONT, LINE_HEIGHT, routeFunctionLinks } from './labelGeometry.js';

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
function colorFor(d) { return COLOR_BY_KIND[d.kind] || COLOR_BY_KIND.process; }
function linesFor(d) { return d.lines; }
function halfHeight(d) { return d.height / 2; }
function halfWidth(d) { return d.width / 2; }
export function shapePath(d) {
  var hw = halfWidth(d), hh = halfHeight(d);
  if (d.isEntry || d.isExit) {
    return 'M' + -hw + ',0A' + hw + ',' + hh + ' 0 1,0 ' + hw + ',0A' + hw + ',' + hh + ' 0 1,0 ' + -hw + ',0';
  }
  if (d.shape === 'diamond') return 'M0,' + -hh + 'L' + hw + ',0L0,' + hh + 'L' + -hw + ',0Z';
  return 'M' + -hw + ',' + -hh + 'H' + hw + 'V' + hh + 'H' + -hw + 'Z';
}

// Forward flow: straight down when the ranks line up, otherwise an elbow
// (down, across, down). Orthogonal rather than curved because a flowchart's
// value is in reading execution order, and right angles make the rank
// structure legible.
export function forwardPath(s, t) {
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
export function backPath(s, t, lane, laneBaseX) {
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
  const { svgEl, graph, zoomRef } = options;
  if (!graph || !svgEl) return function () {};

  // One public handle and one pair of observers own the lifetime. Reflow
  // replaces only the current drawing; it never chains historical handles.
  var disposed = false;
  var frame = renderFunctionFrame(options);
  var previousWidth = svgEl.clientWidth, previousHeight = svgEl.clientHeight;
  function reflow() {
    if (disposed) return;
    var transform = d3.zoomTransform(svgEl);
    var state = frame.getState?.();
    frame();
    frame = renderFunctionFrame(options);
    if (zoomRef.current) d3.select(svgEl).call(zoomRef.current.transform, transform);
    if (state) {
      frame.applySelection?.(state.selection);
      if (state.query) frame.applySearch?.(state.query);
    }
  }
  var observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(function () {
    if (svgEl.clientWidth === previousWidth && svgEl.clientHeight === previousHeight) return;
    previousWidth = svgEl.clientWidth;
    previousHeight = svgEl.clientHeight;
    reflow();
  });
  observer?.observe(svgEl);
  if (document.fonts) document.fonts.addEventListener('loadingdone', reflow);
  var cleanup = function () {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    if (document.fonts) document.fonts.removeEventListener('loadingdone', reflow);
    frame();
    frame = null;
  };
  cleanup.fit = function () { if (!disposed) frame.fit?.(); };
  cleanup.readable = function () { if (!disposed) frame.readable?.(); };
  cleanup.applySearch = function (q) { if (!disposed) frame.applySearch?.(q); };
  cleanup.applySelection = function (id) { if (!disposed) frame.applySelection?.(id); };
  return cleanup;
}

function renderFunctionFrame(options) {
  const { svgEl, graph, theme, zoomRef, selectSymbolRef, activateSymbolRef, onHover, onBackgroundClick } = options;

  var cleanup = function () {};
  if (!graph || !svgEl) return cleanup;

  var svg = d3.select(svgEl);
  svg.selectAll('*').remove();
  cleanup = function () {
    svg.on('.zoom', null).on('.functionGraph', null);
    svg.selectAll('*').on('.functionGraph', null);
    if (zoomRef.current === zoom) zoomRef.current = null;
  };

  try {
    // Measure with the actual SVG font, including the current fallback font.
    var probe = svg.append('text').style('font', LABEL_FONT).style('white-space', 'pre')
      .attr('visibility', 'hidden');
    var measureCache = new Map();
    function measureText(text) {
      if (!measureCache.has(text)) {
        probe.text(text);
        measureCache.set(text, probe.node().getComputedTextLength());
      }
      return measureCache.get(text);
    }
    var model = buildFunctionRenderModel(graph, {
      measureText, maxTextWidth: Math.max(140, Math.min(360, (svgEl.clientWidth || 800) * 0.4)),
    });
    probe.remove();
    if (model.nodes.length === 0) return cleanup;

    var edgeColor = theme === 'light' ? '#b8b8b8' : '#4a4a4a';
    var textColor = theme === 'light' ? '#333' : '#eee';

    var zoom = d3.zoom().scaleExtent([0.15, 4]).on('zoom', function (e) { container.attr('transform', e.transform); });
    svg.call(zoom);
    zoomRef.current = zoom;
    var container = svg.append('g');

    var defs = svg.append('defs');
    defs.append('marker').attr('id', 'fn-arr').attr('viewBox', '0 -5 10 10').attr('refX', 10)
      .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L10,0L0,4').attr('fill', edgeColor);
    defs.append('marker').attr('id', 'fn-arr-back').attr('viewBox', '0 -5 10 10').attr('refX', 10)
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
    var links = routeFunctionLinks(model);
    var drawnWidth = Math.max(model.width,...links.map(l=>Math.max(
      ...l.points.map(p=>p[0]), l.labelX+(l.data.label||'false').length*7+16)));
    var w = svgEl.clientWidth || drawnWidth;
    var scale = Math.max(MIN_SCALE, Math.min(1, w / (drawnWidth + 40)));
    var initial = d3.zoomIdentity.translate(w / 2 - model.nodes[0].x * scale, 16).scale(scale);
    svg.call(zoom.transform, initial);

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
      .attr('x', function (l) { return l.labelX; })
      .attr('y', function (l) { return l.labelY; })
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

    node.append('text').attr('class', 'fn-nl')
      .attr('text-anchor', 'middle').attr('fill', textColor)
      .style('font', LABEL_FONT).style('white-space', 'pre')
      .attr('pointer-events', 'none')
      .each(function (d) {
        var textSel = d3.select(this);
        d.lines.forEach(function (line, i) {
          textSel.append('tspan').attr('x', 0)
            .attr('y', (i - (d.lines.length - 1) / 2) * LINE_HEIGHT + 4)
            .text(line);
        });
      });

    node.on('click.functionGraph', function (e, d) {
      e.stopPropagation();
      applySelection(d.id);
      if (selectSymbolRef && selectSymbolRef.current) selectSymbolRef.current(d.id);
    });
    node.on('dblclick.functionGraph', function (e, d) {
      e.stopPropagation();
      if (activateSymbolRef && activateSymbolRef.current) activateSymbolRef.current(d.id);
    });
    node.on('mouseenter.functionGraph', function (e, d) {
      var r = svgEl.getBoundingClientRect();
      onHover({
        x: e.clientX - r.left + 10,
        y: e.clientY - r.top,
        title: d.label,
        content: d.kind + (d.flowchartNodeType && d.flowchartNodeType !== d.kind ? ' · ' + d.flowchartNodeType : ''),
      });
    }).on('mouseleave.functionGraph', function () { onHover(null); });

    svg.on('click.functionGraph', function (e) {
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

    var currentSelection = null, currentQuery = '';
    // Both inputs describe one visual state. Clearing either input restores
    // the other, independent of update order (including resize/font reflow).
    function applyHighlightState() {
      var q = (currentQuery || '').trim().toLowerCase();
      var keep = currentSelection ? neighbors.get(currentSelection) : null;
      function matches(d) { return !!q && !!d.label && d.label.toLowerCase().includes(q); }
      node.selectAll('.fn-nc')
        .attr('stroke', function (d) { return matches(d) ? '#f0abfc' : colorFor(d); })
        .attr('stroke-width', function (d) {
          return currentSelection === d.id || matches(d) ? 3 : q ? 1 : 1.6;
        });
      node.attr('opacity', function (d) {
        // The selected node and search matches remain readable together.
        if (currentSelection === d.id || matches(d)) return 1;
        if (keep && !keep.has(d.id)) return 0.18;
        return q ? 0.3 : 1;
      });
      linkLayer.selectAll('path').attr('stroke-opacity', function (l) {
        var base = l.data.isBackEdge ? 0.85 : 0.6;
        if (!currentSelection) return base;
        return l.source.id === currentSelection || l.target.id === currentSelection ? 1 : 0.1;
      });
    }
    function applySelection(selectedId) {
      currentSelection = selectedId;
      applyHighlightState();
    }

    // Search highlights in place so control-flow context remains visible.
    function applySearch(query) {
      currentQuery = query;
      applyHighlightState();
    }

    cleanup.fit = function() {
      var b=container.node().getBBox(), padding=20;
      var k=Math.min(1,(svgEl.clientWidth-2*padding)/b.width,(svgEl.clientHeight-2*padding)/b.height);
      if(!(k>0))return;
      zoom.scaleExtent([Math.min(0.15,k),4]);
      svg.call(zoom.transform,d3.zoomIdentity.translate(
        (svgEl.clientWidth-b.width*k)/2-b.x*k,
        (svgEl.clientHeight-b.height*k)/2-b.y*k).scale(k));
    };
    cleanup.readable = function() {
      svg.call(zoom.transform,initial);
    };
    cleanup.applySearch = applySearch;
    cleanup.applySelection = applySelection;
    cleanup.getState = function() { return {selection:currentSelection,query:currentQuery}; };
    return cleanup;
  } catch (e) {
    cleanup();
    console.error('Function graph render error:', e);
    svg.selectAll('*').remove();
    svg.append('text').attr('x', 20).attr('y', 30).attr('fill', 'var(--t3)')
      .text('Function graph rendering error: ' + e.message);
    return cleanup;
  }
}
