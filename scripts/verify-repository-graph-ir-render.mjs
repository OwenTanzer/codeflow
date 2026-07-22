// Headless verification for MOO-69 Commit 3's own check: "GraphIR fixture
// renders without requiring live GitHub access."
//
// Drives window.renderRepositoryGraph() (bridged from
// src/render/repositoryGraph.js, same pattern as
// scripts/verify-worker-analysis.mjs) directly against a bare <svg> element
// and the committed repository-layer GraphIR fixture
// (tests/fixtures/graph-ir/repository.json) -- no App(), no data loading UI,
// no GitHub network access, just the renderer consuming a GraphIR object
// exactly as src/render/repositoryRenderModel.js's fromGraphIR() path
// expects.
//
// Usage: node scripts/verify-repository-graph-ir-render.mjs [url]
// Requires the target URL to already be serving the built (or dev) app.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || 'http://localhost:3000/';
const fixture = JSON.parse(readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'graph-ir', 'repository.json'), 'utf8'));

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleMessages = [];
page.on('console', (msg) => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => consoleMessages.push(`[pageerror] ${err.stack || err.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
// The module-script bridge (index.html's <script type="module">, which sets
// window.renderRepositoryGraph) can still be finishing its own bundled
// module graph fractionally after `networkidle` fires -- wait for the
// specific global this script depends on rather than assuming load order.
await page.waitForFunction(() => typeof window.renderRepositoryGraph === 'function', { timeout: 10000 });

const result = await page.evaluate(async (graph) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '800');
  svg.setAttribute('height', '600');
  document.body.appendChild(svg);

  const noop = () => {};
  const cleanup = window.renderRepositoryGraph({
    svgEl: svg,
    data: graph,
    colorMap: {},
    colorMode: 'folder',
    theme: 'dark',
    folderFilter: null,
    graphConfig: { viewMode: 'force', linkDist: 80, spacing: 200, curvedLinks: false, showLabels: true },
    COLORS: ['#22c55e', '#3b82f6', '#f59e0b'],
    LAYER_COLORS: {},
    zoomRef: { current: null },
    simRef: { current: null },
    linksRef: { current: null },
    nodesRef: { current: null },
    selectFileRef: { current: null },
    activateFileRef: { current: null },
    onHover: noop,
    onBackgroundClick: noop,
  });

  // Let the force simulation tick at least once so nodes get positioned.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const nodeCount = svg.querySelectorAll('circle.nc').length;
  const linkCount = svg.querySelectorAll('path').length; // includes the arrow marker's own <path>, subtracted below
  const markerPaths = svg.querySelectorAll('marker path').length;

  if (typeof cleanup === 'function') cleanup();
  svg.remove();

  return { nodeCount, linkPathCount: linkCount - markerPaths, expectedNodeCount: graph.nodes.filter((n) => n.coordinate).length };
}, fixture);

console.log('renderRepositoryGraph(GraphIR fixture) result:', JSON.stringify(result, null, 2));
consoleMessages.forEach((m) => console.log(m));
await browser.close();

const consoleErrors = consoleMessages.filter((m) => m.startsWith('[error]') || m.startsWith('[pageerror]'));
const ok = result.nodeCount === result.expectedNodeCount && consoleErrors.length === 0;

console.log('---');
console.log('summary: ok=' + ok + ' nodeCount=' + result.nodeCount + '/' + result.expectedNodeCount + ' consoleErrors=' + consoleErrors.length);

if (!ok) process.exit(1);
