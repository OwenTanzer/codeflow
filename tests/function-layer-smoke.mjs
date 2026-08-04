// Browser smoke coverage for the function layer — MOO-71 Commits 7-8.
//
// Not part of the zero-setup `node --test tests/*.test.mjs` suite (same as
// tests/ui-smoke.mjs, codeflow-repo-smoke.mjs): this needs a running server
// and real credentials. Drives the whole repository -> file -> function ->
// back path through the real UI, because the panels' fetch/render/restore
// wiring is exactly the part unit tests cannot reach.
//
// Usage:
//   GITHUB_TOKEN=... npm start           # in one shell
//   node tests/function-layer-smoke.mjs <url>
//
// MOO-86: the client-side GitHub PAT/App toolbar fields this script used to
// fill in were removed -- ownership/blame and file-preview-fallback now run
// server-side too. The app's own APP_PASSWORD gate was later removed
// entirely as well, so there's no credential of any kind left to supply here.
import { chromium } from 'playwright';

const [url = 'http://localhost:3000/'] = process.argv.slice(2);

// Same known-benign Babel Standalone notice tests/ui-smoke.mjs filters.
const KNOWN_NOISE = /\[BABEL\] Note: The code generator has deoptimised the styling/;
const REPO = 'psf/requests';
// The repository renderer labels file nodes by stem, not filename -- the node
// for src/requests/sessions.py reads "sessions".
const FILE_LABEL = 'sessions';
// SessionRedirectMixin.resolve_redirects: for loop, while loop, try/except
// with multiple handlers, continue, break, and several returns -- the case the
// layered renderer exists for. The file layer truncates labels at 16 chars.
const TARGET_FUNCTION = 'resolve_redirects';
// fileGraph.js truncates at 16: label.slice(0, 15) + '…'
const TARGET_LABEL = 'resolve_redirec…';

const failures = [];
function ok(name) { console.log('ok   - ' + name); }
function fail(name, err) { failures.push(name); console.log('FAIL - ' + name + ': ' + err); }
async function step(name, fn) {
  try { await fn(); ok(name); return true; } catch (err) { fail(name, err.message); return false; }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !KNOWN_NOISE.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

// Track the function-graph requests so we can prove the back-navigation
// restore actually avoided a refetch rather than merely looking instant.
let functionRequests = 0;
let fileRequests = 0;
page.on('request', (r) => {
  if (r.url().endsWith('/api/graph/function')) functionRequests += 1;
  if (r.url().endsWith('/api/graph/file')) fileRequests += 1;
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// --- repository layer -------------------------------------------------------
await step('app-auth controls are absent', async () => {
  const tokenInputs = await page.locator('input[aria-label="CodeFlow Server Token"], input[aria-label="App Password"]').count();
  if (tokenInputs !== 0) throw new Error(`expected no app-auth input, found ${tokenInputs}`);
  const tokenErrors = await page.getByText('Enter the CodeFlow server token before analyzing a repository.').count();
  if (tokenErrors !== 0) throw new Error('legacy server-token error is still rendered');
});

await step('enter the repository URL', async () => {
  await page.locator('input[aria-label="Repository URL"]:visible').first().fill(REPO);
});

await step('repository analysis completes and the graph renders', async () => {
  await page.keyboard.press('Enter');
  // The breadcrumb header only appears once repositoryGraph exists, and it
  // shows the resolved ref@sha -- a far more specific signal than "some svg
  // has children".
  await page.waitForSelector('text=/@[0-9a-f]{7}/', { timeout: 300000 });
});

await page.screenshot({ path: 'docs/img/smoke-1-repository.png' });

// --- repository -> file -----------------------------------------------------
await step(`double-click ${FILE_LABEL} to drill into the file layer`, async () => {
  // Target the node group, not the text: the label is drawn below the shape,
  // so clicking the text's own box can miss the node's hit area.
  const node = page.locator(`svg g:has(> text:text-is("${FILE_LABEL}"))`).first();
  await node.waitFor({ timeout: 20000 });
  await node.dblclick();
});

await step('file graph renders', async () => {
  await page.waitForFunction(() => {
    const svgs = [...document.querySelectorAll('svg')];
    return svgs.some((s) => s.querySelectorAll('path.nc').length > 2);
  }, { timeout: 120000 });
});

await page.screenshot({ path: 'docs/img/smoke-2-file.png' });

// --- file -> function -------------------------------------------------------
await step(`double-click ${TARGET_FUNCTION} to drill into the function layer`, async () => {
  const before = functionRequests;
  // Target a deliberately branch/loop-heavy method rather than whichever node
  // happens to come first: a trivial one-statement method renders a valid but
  // meaningless three-node graph, which would let the loop/branch assertions
  // below pass without ever exercising them. The file-layer renderer
  // truncates labels at 16 characters, hence the prefix match.
  const target = page.locator(`svg g:has(> text:text-is("${TARGET_LABEL}"))`).first();
  await target.waitFor({ timeout: 20000 });
  await target.dblclick();
  await page.waitForTimeout(1200);
  if (functionRequests === before) throw new Error(`double-clicking ${TARGET_FUNCTION} issued no function-layer request`);
  await page.waitForFunction(() => document.querySelector('svg path.fn-nc') !== null, { timeout: 120000 });
});

await step('function graph renders entry/exit, branches, loop back-edges and edge labels', async () => {
  const shape = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('svg path')];
    const texts = [...document.querySelectorAll('svg text')].map((t) => t.textContent);
    return {
      nodes: document.querySelectorAll('svg path.fn-nc').length,
      dashedBackEdges: paths.filter((p) => p.getAttribute('stroke-dasharray') === '5,3').length,
      trueFalseLabels: texts.filter((t) => t === 'true' || t === 'false').length,
      exceptionLabels: texts.filter((t) => t && t.startsWith('on ')).length,
      mermaidEntities: texts.filter((t) => t && /#quot;|#60;|#62;|#96;/.test(t)).length,
    };
  });
  console.log('       function graph:', JSON.stringify(shape));
  if (shape.nodes < 20) throw new Error('expected a substantial control-flow graph, got ' + shape.nodes + ' nodes');
  if (shape.dashedBackEdges === 0) throw new Error('a loop-bearing function must render back-edges');
  if (shape.trueFalseLabels === 0) throw new Error('branch edges must be labelled true/false');
  if (shape.mermaidEntities > 0) throw new Error('Mermaid escape entities leaked into rendered labels');
});

await page.screenshot({ path: 'docs/img/smoke-3-function.png' });

await step('search highlights matching nodes without re-rendering the graph', async () => {
  const search = page.locator('input[aria-label="Search control-flow nodes"]');
  await search.fill('resp');
  await page.waitForTimeout(400);
  const dimmed = await page.evaluate(() =>
    [...document.querySelectorAll('svg g')].filter((g) => g.getAttribute('opacity') === '0.3').length
  );
  if (dimmed === 0) throw new Error('search did not dim any non-matching node');
  await search.fill('');
});

await step('selecting a node shows its metadata', async () => {
  const node = page.locator('svg path.fn-nc').nth(2);
  const box = await node.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('text=/kind: /', { timeout: 10000 });
});

// --- back navigation --------------------------------------------------------
await step('back restores the file view from cache without re-running analysis', async () => {
  const fileRequestsBefore = fileRequests;
  // Exact: the detail panel also has a "← Back to Issues" button.
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await page.waitForFunction(() => {
    const svgs = [...document.querySelectorAll('svg')];
    return svgs.some((s) => s.querySelectorAll('path.nc').length > 2);
  }, { timeout: 30000 });
  await page.waitForTimeout(1200);
  if (fileRequests > fileRequestsBefore) {
    throw new Error(`expected no new /api/graph/file request on back, saw ${fileRequests - fileRequestsBefore}`);
  }
});

await page.screenshot({ path: 'docs/img/smoke-4-back.png' });

console.log('\nrequests issued: file=' + fileRequests + ' function=' + functionRequests);
console.log('console errors: ' + (consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 6), null, 2) : 'none'));
await browser.close();

if (failures.length || consoleErrors.length) {
  console.error('\nFAILED: ' + (failures.length ? failures.join(', ') : '') + (consoleErrors.length ? ' (console errors)' : ''));
  process.exit(1);
}
console.log('\nAll function-layer smoke checks passed.');
