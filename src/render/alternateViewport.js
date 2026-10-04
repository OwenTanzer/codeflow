// Complete alternate views can be much larger than the viewport. Measure the
// actual SVG content (including labels), fit it, and offer a readable 1x view.
// All lifecycle resources belong to the caller's effect and are disposable.
export function makeAlternateSelectable(selection, { path, select, prefix = 'Select file: ' }) {
  selection.attr('role', 'button').attr('tabindex', 0).attr('data-alt-selectable', 'true')
    .attr('aria-label', datum => prefix + path(datum))
    .on('keydown.alt-select', function(event, datum) {
      if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        select(path(datum));
      }
    });
}
export function installAlternateViewport({ container, svg, content, onMeasure, topInset = 90 }) {
  const d3 = globalThis.d3;
  const el = svg.node(), group = content.node(), host = container.node();
  const doc = el.ownerDocument, win = doc.defaultView;
  let disposed = false, userMoved = false, frame = null;
  let width = host.clientWidth || 800, height = host.clientHeight || 600;
  const zoom = d3.zoom().scaleExtent([0.000001, 8]).on('zoom.alt-view', event => {
    if (event.sourceEvent) userMoved = true;
    content.attr('transform', event.transform);
    content.selectAll('text').attr('opacity', event.transform.k < 0.45 ? 0 : 1);
  });
  svg.style('touch-action', 'none').call(zoom);
  const controls = container.append('div').attr('class', 'alternate-view-controls')
    .style('position', 'absolute').style('top', '52px').style('left', '12px')
    .style('z-index', '4').style('display', 'flex').style('gap', '6px');
  function bounds() {
    const box = group.getBBox();
    return [box.x, box.y, Math.max(box.width, 1), Math.max(box.height, 1)];
  }
  function fit(readable = false) {
    if (disposed || !el.isConnected) return;
    const [x, y, w, h] = bounds();
    const availableWidth = Math.max(1, width - 32), availableHeight = Math.max(1, height - topInset - 20);
    const scale = readable ? 1 : Math.min(1, availableWidth / w, availableHeight / h);
    svg.interrupt().call(zoom.transform, d3.zoomIdentity
      .translate(width / 2 - scale * (x + w / 2), topInset + availableHeight / 2 - scale * (y + h / 2)).scale(scale));
  }
  controls.append('button').attr('type', 'button').attr('class', 'top-btn')
    .attr('aria-label', 'Fit complete view').text('Fit complete view')
    .on('click', () => { userMoved = false; fit(); });
  controls.append('button').attr('type', 'button').attr('class', 'top-btn')
    .attr('aria-label', 'Readable labels').text('Readable labels')
    .on('click', () => { userMoved = true; fit(true); });
  // A keyboard user can reach every item even when the complete fit hides its
  // tiny label. Focus brings its measured bounds into a readable viewport.
  const focus = event => {
    const target = event.target.closest?.('[data-alt-selectable]');
    if (!target || !group.contains(target)) return;
    const b = target.getBBox(), matrix = group.getCTM()?.inverse().multiply(target.getCTM());
    if (!matrix) return;
    const center = new win.DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(matrix);
    userMoved = true;
    svg.interrupt().call(zoom.transform, d3.zoomIdentity.translate(width / 2 - center.x, height / 2 - center.y));
  };
  el.addEventListener('focusin', focus);
  // Capture before D3 drag can stop propagation: a deliberate drag must not
  // be replaced by a later font, resize, or simulation-completion auto-fit.
  const pointerIntent = () => { userMoved = true; };
  el.addEventListener('pointerdown', pointerIntent, true);
  function measure() {
    if (disposed) return;
    width = host.clientWidth || 800;
    height = host.clientHeight || 600;
    svg.attr('width', width).attr('height', height);
    onMeasure?.();
    if (!userMoved) fit();
  }
  function scheduleMeasure() {
    if (disposed) return;
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(measure);
  }
  const fonts = doc.fonts;
  fonts?.addEventListener('loadingdone', scheduleMeasure);
  fonts?.ready.then(() => { if (!disposed) scheduleMeasure(); });
  const resize = win.ResizeObserver ? new win.ResizeObserver(scheduleMeasure) : null;
  resize?.observe(host);
  measure();
  return {
    fit: () => { if (!userMoved) fit(); },
    dispose() {
      disposed = true;
      win.cancelAnimationFrame(frame);
      resize?.disconnect();
      fonts?.removeEventListener('loadingdone', scheduleMeasure);
      el.removeEventListener('focusin', focus);
      el.removeEventListener('pointerdown', pointerIntent, true);
      svg.interrupt().on('.zoom', null);
      content.selectAll('*').interrupt().on('.alt-select', null);
      controls.remove();
    },
  };
}
