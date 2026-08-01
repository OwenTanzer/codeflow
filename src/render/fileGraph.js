// File-layer graph (2D D3 force layout) renderer — MOO-70 Commit 8.
//
// Mirrors src/render/repositoryGraph.js's D3 skeleton (zoom/drag/
// force-sim/click-dblclick dispatch) but reads GraphIR's own
// hints.shape/hints.colorRole directly -- repositoryGraph.js never
// consults `hints` at all, despite GraphIR carrying them since MOO-68,
// because its node schema (files/folders) predates the file layer's
// (module/class/function/method). Adapting it in place for a
// structurally different node schema would strain reuse enough that
// MOO-70's own "specialized renderer fallback" allowance applies here --
// a new, deliberately simpler file, not a rewrite of the repository one.
//
// Deliberately simpler than the repository renderer: one force layout
// (no viewMode alternatives -- the ticket doesn't ask for those at the
// file layer), groupId-based cluster attraction instead of folder convex
// hulls, and no colorMode variants (a small 2-entry colorRole palette
// instead). Convex-hull group visualization and viewMode alternatives are
// explicitly deferred, mirroring docs/repository-layer-density.md's own
// precedent of documenting rather than speculatively building
// unvalidated UI.
//
// `d3` is read as an ambient global (window.d3), same pattern
// repositoryGraph.js and src/analyzer.js use.
/* eslint-disable no-undef */
import { buildFileRenderModel } from './fileRenderModel.js';

const COLOR_BY_ROLE = { default: '#60a5fa', warning: '#f59e0b' };
const KIND_RADIUS = { module: 16, class: 13, method: 9, function: 9 };

function radiusFor(d) {
  return KIND_RADIUS[d.kind] || 9;
}

function colorFor(d) {
  return COLOR_BY_ROLE[d.colorRole] || COLOR_BY_ROLE.default;
}

// One element type (path) handles every node shape via its `d` attribute,
// rather than needing a different SVG element per datum in one D3 join.
function shapePath(shape, r) {
  if (shape === 'diamond') return 'M0,' + -r + 'L' + r + ',0L0,' + r + 'L' + -r + ',0Z';
  if (shape === 'circle') return 'M' + -r + ',0A' + r + ',' + r + ' 0 1,0 ' + r + ',0A' + r + ',' + r + ' 0 1,0 ' + -r + ',0';
  return 'M' + -r + ',' + -r + 'L' + r + ',' + -r + 'L' + r + ',' + r + 'L' + -r + ',' + r + 'Z';
}

/**
 * @param {object} options
 * @param {SVGSVGElement} options.svgEl
 * @param {import('../graph-ir/graphIR.js').GraphIR} options.graph
 * @param {'light'|'dark'} options.theme
 * @param {{current: any}} options.zoomRef
 * @param {{current: any}} options.simRef
 * @param {{current: (id: string) => void}} options.selectSymbolRef - single-click ("select")
 * @param {{current: (id: string) => void}} options.activateSymbolRef - double-click (drill-down intent)
 * @param {(info: {x:number,y:number,title:string,content:string}|null) => void} options.onHover
 * @param {() => void} options.onBackgroundClick
 * @returns {() => void} cleanup function (stops the force simulation)
 */
export function renderFileGraph(options) {
  const { svgEl, graph, theme, zoomRef, simRef, selectSymbolRef, activateSymbolRef, onHover, onBackgroundClick } = options;

  if (!graph || !svgEl) return function () {};
  var svg = d3.select(svgEl);
  svg.selectAll('*').remove();
  try {
    var w = svgEl.clientWidth;
    var h = svgEl.clientHeight;
    var renderModel = buildFileRenderModel(graph);
    var nodes = renderModel.nodes;
    var links = renderModel.links;

    var groupIds = [...new Set(nodes.map(function (n) { return n.groupId; }).filter(Boolean))];
    var cols = Math.max(2, Math.ceil(Math.sqrt(groupIds.length || 1)));
    var cw = w / (cols + 1);
    var ch = h / (Math.ceil((groupIds.length || 1) / cols) + 1);
    var centers = {};
    groupIds.forEach(function (g, i) { centers[g] = { x: (i % cols + 1) * cw, y: (Math.floor(i / cols) + 1) * ch }; });

    var zoom = d3.zoom().scaleExtent([0.2, 5]).on('zoom', function (e) { container.attr('transform', e.transform); });
    svg.call(zoom);
    zoomRef.current = zoom;
    var container = svg.append('g');
    var defs = svg.append('defs');
    defs.append('marker').attr('id', 'file-arr').attr('viewBox', '0 -5 10 10').attr('refX', 14).attr('markerWidth', 4).attr('markerHeight', 4).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L10,0L0,4').attr('fill', theme === 'light' ? '#aaa' : '#444');
    var linkLayer = container.append('g');
    var nodeLayer = container.append('g');

    // MOO-86 review: nodes read as a homogeneous mass at default D3 force
    // parameters -- widened collision padding and stronger charge repulsion
    // give individual nodes real breathing room, and a stronger groupId pull
    // (0.2 -> 0.34) makes each file's own cluster visually cohere against its
    // neighbors instead of every node drifting toward one shared center of
    // mass. Convex-hull group outlines remain out of scope (see this file's
    // header comment) -- this is force tuning, not new UI.
    var sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(function (d) { return d.id; }).distance(80).strength(0.25))
      .force('charge', d3.forceManyBody().strength(-260).distanceMax(500))
      .force('collision', d3.forceCollide().radius(function (d) { return radiusFor(d) + 18; }))
      .force('x', d3.forceX(function (d) { return d.groupId && centers[d.groupId] ? centers[d.groupId].x : w / 2; }).strength(function (d) { return d.groupId ? 0.34 : 0.05; }))
      .force('y', d3.forceY(function (d) { return d.groupId && centers[d.groupId] ? centers[d.groupId].y : h / 2; }).strength(function (d) { return d.groupId ? 0.34 : 0.05; }));
    simRef.current = sim;

    var link = linkLayer.selectAll('path').data(links).join('path')
      .attr('fill', 'none')
      .attr('stroke', theme === 'light' ? '#ccc' : '#333')
      .attr('stroke-width', function (d) { return d.kind === 'uses' ? 1.5 : 1; })
      .attr('stroke-dasharray', function (d) { return d.kind === 'defines' ? '3,2' : null; })
      .attr('stroke-opacity', 0.5)
      .attr('marker-end', 'url(#file-arr)');

    var node = nodeLayer.selectAll('g').data(nodes).join('g').style('cursor', 'pointer');
    node.call(d3.drag()
      .on('start', function (e, d) { if (!e.active) sim.alphaTarget(0.1).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', function (e, d) { d.fx = e.x; d.fy = e.y; })
      .on('end', function (e, d) { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
    // MOO-86: single-click-to-highlight-relations, matching the repository
    // layer's own click-highlight behavior -- this layer had none before,
    // only hover tooltips and a select callback with no visual feedback on
    // the graph itself.
    var neighbors = new Map(nodes.map(function (n) { return [n.id, new Set([n.id])]; }));
    links.forEach(function (l) {
      var s = l.source && l.source.id ? l.source.id : l.source;
      var t = l.target && l.target.id ? l.target.id : l.target;
      if (neighbors.has(s)) neighbors.get(s).add(t);
      if (neighbors.has(t)) neighbors.get(t).add(s);
    });
    function highlightRelations(id) {
      var keep = id ? neighbors.get(id) : null;
      node.attr('opacity', function (d) { return !keep || keep.has(d.id) ? 1 : 0.15; });
      link.attr('stroke-opacity', function (d) {
        if (!keep) return 0.5;
        var s = d.source.id || d.source, t = d.target.id || d.target;
        return s === id || t === id ? 0.9 : 0.05;
      });
    }

    node.on('click', function (e, d) { e.stopPropagation(); highlightRelations(d.id); if (selectSymbolRef.current) selectSymbolRef.current(d.id); });
    node.on('dblclick', function (e, d) { e.stopPropagation(); if (activateSymbolRef && activateSymbolRef.current) activateSymbolRef.current(d.id); });
    node.on('mouseenter', function (e, d) {
      var r = svgEl.getBoundingClientRect();
      onHover({ x: e.clientX - r.left + 10, y: e.clientY - r.top, title: d.label, content: d.kind + (d.noRelationshipData ? ' (no relationship data)' : '') });
    }).on('mouseleave', function () { onHover(null); });
    svg.on('click', function (e) { if (e.target === svgEl) { onBackgroundClick(); highlightRelations(null); } });

    node.append('path').attr('class', 'nc')
      .attr('d', function (d) { return shapePath(d.shape, radiusFor(d)); })
      .attr('fill', colorFor)
      .attr('stroke', function (d) { var c = d3.color(colorFor(d)); return c ? c.brighter(0.3) : '#fff'; })
      .attr('stroke-width', function (d) { return d.noRelationshipData ? 1 : 1.5; })
      .attr('stroke-dasharray', function (d) { return d.noRelationshipData ? '2,2' : null; });

    node.append('text').attr('text-anchor', 'middle').attr('dy', function (d) { return radiusFor(d) + 12; })
      .attr('fill', theme === 'light' ? '#333' : '#eee')
      .attr('font-size', '9px').attr('font-family', 'JetBrains Mono').attr('font-weight', '500')
      .attr('pointer-events', 'none')
      .text(function (d) { return d.label.length > 16 ? d.label.slice(0, 15) + '…' : d.label; });

    sim.on('tick', function () {
      link.attr('d', function (d) { return 'M' + d.source.x + ',' + d.source.y + 'L' + d.target.x + ',' + d.target.y; });
      node.attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; });
    });
  } catch (e) {
    console.error('File graph render error:', e);
    svg.selectAll('*').remove();
    svg.append('text').attr('x', 20).attr('y', 30).attr('fill', 'var(--t3)').text('File graph rendering error: ' + e.message);
  }
  return function () { if (simRef.current) simRef.current.stop(); };
}
