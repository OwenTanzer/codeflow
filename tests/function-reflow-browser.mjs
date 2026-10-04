// Isolated renderer lifetime regression against the actual local app's D3.
// Start Vite, then: node tests/function-reflow-browser.mjs http://127.0.0.1:5128/
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.argv[2] || process.env.LABEL_TEST_URL || 'http://127.0.0.1:5128/';
const out = process.env.CODEFLOW_REFLOW_OUT || 'test-results/function-reflow';
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const result = { mode: 'synthetic graph in actual local app; font-event injection and actual resize', checks: [] };
let failure;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.d3);
  await page.evaluate(async () => {
    await document.fonts.ready;
    const { renderFunctionGraph } = await import('/src/render/functionGraph.js');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'reflow-regression';
    svg.style.cssText = 'position:fixed;inset:0;width:90vw;height:80vh;background:#101218;z-index:9999';
    document.body.append(svg);
    const counts = { observersCreated: 0, observersActive: 0, fontsAdded: 0, fontsActive: 0, callbacks: 0 };
    const NativeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
      observe(target, options) {
        if (target === svg && !this.tracked) {
          this.tracked = true; counts.observersCreated++; counts.observersActive++;
        }
        return super.observe(target, options);
      }
      disconnect() {
        if (this.tracked) { this.tracked = false; counts.observersActive--; }
        return super.disconnect();
      }
    };
    const addFont = document.fonts.addEventListener.bind(document.fonts);
    const removeFont = document.fonts.removeEventListener.bind(document.fonts);
    const listeners = new Set();
    document.fonts.addEventListener = function (type, fn, options) {
      if (type === 'loadingdone' && !listeners.has(fn)) {
        listeners.add(fn); counts.fontsAdded++; counts.fontsActive++;
      }
      return addFont(type, fn, options);
    };
    document.fonts.removeEventListener = function (type, fn, options) {
      if (type === 'loadingdone' && listeners.delete(fn)) counts.fontsActive--;
      return removeFont(type, fn, options);
    };
    const graph = {
      nodes: [
        { id: 'a', label: 'entry', kind: 'entry', hints: { isEntry: true } },
        { id: 'b', label: 'purged_headers = [' + 'complete_identifier_'.repeat(25) + ']', kind: 'process' },
        { id: 'c', label: 'resp = requests.get(url)', kind: 'call' },
        { id: 'd', label: 'exit', kind: 'exit', hints: { isExit: true } },
      ],
      edges: ['ab', 'bc', 'cd'].map(pair => ({ source: pair[0], target: pair[1], kind: 'flow' })),
    };
    const zoomRef = {};
    const handle = renderFunctionGraph({
      svgEl: svg, graph, theme: 'dark', zoomRef,
      selectSymbolRef: { current: () => counts.callbacks++ },
      activateSymbolRef: { current: () => counts.callbacks++ },
      onHover: () => counts.callbacks++, onBackgroundClick: () => counts.callbacks++,
    });
    handle.applySelection('b');
    handle.applySearch('purged_headers');
    d3.select(svg).call(zoomRef.current.transform, d3.zoomIdentity.translate(71, 39).scale(.72));
    window.reflowTest = {
      svg, handle, zoomRef, counts, retired: [],
      snapshot() {
        return {
          text: [...svg.querySelectorAll('.fn-nl')].map(t => [t.__data__.id, t.textContent]),
          nodes: svg.querySelectorAll('.fn-nl').length,
          appearance: [...svg.querySelectorAll('.fn-nc')].map(p => ({
            id: p.__data__.id, opacity: p.parentNode.getAttribute('opacity'),
            stroke: p.getAttribute('stroke'), width: p.getAttribute('stroke-width'),
          })),
          search: [...svg.querySelectorAll('.fn-nc')].filter(p => p.getAttribute('stroke') === '#f0abfc').length,
          edges: [...svg.querySelectorAll('path[marker-end]')].map(p => p.getAttribute('stroke-opacity')),
          zoom: { x: svg.__zoom.x, y: svg.__zoom.y, k: svg.__zoom.k },
        };
      },
    };
  });
  const composed = await page.evaluate(() => {
    const t = reflowTest;
    t.handle.applySearch('');
    const selectionOnly = t.snapshot();
    t.handle.applySearch('resp');
    const searchThenSelection = t.snapshot();
    t.handle.applySelection(null);
    const searchOnly = t.snapshot();
    t.handle.applySelection('b');
    const selectionThenSearch = t.snapshot();
    t.handle.applySearch('');
    const clearedSearch = t.snapshot();
    t.handle.applySelection(null);
    const clearedBoth = t.snapshot();
    t.handle.applySelection('b');
    t.handle.applySearch('purged_headers');
    return { selectionOnly, searchThenSelection, searchOnly, selectionThenSearch, clearedSearch, clearedBoth };
  });
  const selectionOnly = composed.selectionOnly;
  assert.deepEqual(selectionOnly.appearance.map(n => [n.id, n.opacity, n.width]),
    [['a','1','1.6'], ['b','1','3'], ['c','1','1.6'], ['d','0.18','1.6']]);
  assert.deepEqual(composed.clearedSearch, selectionOnly, 'clearing search restores selected neighborhood and border');
  assert.deepEqual(composed.searchThenSelection, composed.selectionThenSearch, 'input update order is immaterial');
  assert.equal(composed.searchOnly.search, 1, 'clearing selection preserves search');
  assert.equal(composed.searchOnly.appearance.find(n => n.id === 'c').opacity, '1');
  assert.equal(composed.searchThenSelection.appearance.find(n => n.id === 'b').opacity, '1', 'selected nonmatch remains readable');
  assert.equal(composed.searchThenSelection.appearance.find(n => n.id === 'c').stroke, '#f0abfc');
  assert.ok(composed.clearedBoth.appearance.every(n => n.opacity === '1' && n.width === '1.6'));
  assert.equal(composed.clearedBoth.search, 0);
  result.checks.push({ name: 'selection and search composition', status: 'PASS' });
  const baseline = await page.evaluate(() => reflowTest.snapshot());
  assert.equal(baseline.nodes, 4);
  assert.equal(baseline.search, 1);
  // Retain only WeakRefs to prior DOM. Old forwarding-handle chains keep
  // these detached nodes alive even after explicit browser garbage collection.
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => {
      reflowTest.retired.push(new WeakRef(reflowTest.svg.querySelector('.fn-nl')));
      document.fonts.dispatchEvent(new Event('loadingdone'));
    });
    await page.setViewportSize({ width: i % 2 ? 1200 : 720, height: 900 });
    await page.waitForFunction(() => {
      const t = reflowTest.retired.at(-1).deref();
      return !t || !t.isConnected;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const state = await page.evaluate(() => reflowTest.snapshot());
    assert.deepEqual(state, baseline, 'font/resize preserves text, selection links, search and transform');
    const afterClear = await page.evaluate(() => {
      reflowTest.handle.applySearch('');
      document.fonts.dispatchEvent(new Event('loadingdone'));
      const state = reflowTest.snapshot();
      reflowTest.handle.applySearch('purged_headers');
      return state;
    });
    assert.deepEqual(afterClear, selectionOnly, 'selection survives clearing search and another reflow');
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const lifetime = await page.evaluate(() => ({
    ...reflowTest.counts,
    retainedDetachedLabels: reflowTest.retired.filter(ref => ref.deref()).length,
  }));
  assert.equal(lifetime.observersCreated, 1, 'one observer owns the renderer lifetime');
  assert.equal(lifetime.observersActive, 1);
  assert.equal(lifetime.fontsAdded, 1, 'one font listener owns the renderer lifetime');
  assert.equal(lifetime.fontsActive, 1);
  assert.equal(lifetime.retainedDetachedLabels, 0, 'disposed frames release their detached DOM');
  result.checks.push({ name: 'repeated font and resize reflow', ...lifetime });
  const controls = await page.evaluate(() => {
    reflowTest.handle.fit();
    const fit = reflowTest.svg.__zoom.k;
    reflowTest.handle.readable();
    return { fit, readable: reflowTest.svg.__zoom.k };
  });
  assert.ok(controls.fit > 0 && Number.isFinite(controls.fit));
  assert.ok(controls.readable >= .55);
  await page.screenshot({ path: out + '/function-reflow.png' });
  const disposed = await page.evaluate(async () => {
    const t = reflowTest;
    t.handle(); t.handle();
    const before = t.svg.innerHTML;
    const callbacks = t.counts.callbacks;
    t.svg.querySelector('.fn-nl').parentNode.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    t.svg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.fonts.dispatchEvent(new Event('loadingdone'));
    t.svg.style.width = '50vw';
    t.handle.fit(); t.handle.readable(); t.handle.applySearch('resp'); t.handle.applySelection('a');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { ...t.counts, noRedraw: t.svg.innerHTML === before, noCallbacks: t.counts.callbacks === callbacks,
      zoomReleased: t.zoomRef.current === null };
  });
  assert.equal(disposed.observersActive, 0);
  assert.equal(disposed.fontsActive, 0);
  assert.ok(disposed.noRedraw && disposed.noCallbacks && disposed.zoomReleased);
  result.checks.push({ name: 'idempotent disposal', ...disposed });
  assert.deepEqual(errors, [], 'unexpected browser errors');
  result.status = 'PASS';
} catch (error) {
  failure = error;
  result.status = 'FAIL';
  result.error = error.stack || String(error);
} finally {
  result.browser = browser.version();
  result.errors = errors;
  await writeFile(out + '/results.json', JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
if (failure) throw failure;
