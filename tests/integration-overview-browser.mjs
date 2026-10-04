// Local integration acceptance: real retrieval and explicitly labelled replay/fault injection.
// Usage: node tests/integration-overview-browser.mjs http://127.0.0.1:PORT/ [evidence-dir]
// Ref pinning uses the existing fetchRepositoryGraph bridge seam. This does NOT
// establish pasted /tree/ref support. Chromium viewport/touch emulation is not a
// physical iOS/Android result. Backend cold/warm benchmarking is a separate gate.
// Optional alternate-view gate: set OVERVIEW_TREEMAP=1.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const [base, out = 'test-results/integration-overview'] = process.argv.slice(2);
if (!base || !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) {
  throw new Error('Pass the actual local app URL; remote/production execution is prohibited.');
}
const SHA = '9f630ae2d7304e316dc13b27399787251a5953aa';
const startedAt = new Date().toISOString();
const results = [], requests = [], errors = [], captures = [], artifactTasks = [];
const timeout = 300000;
let phase = '', page, liveResult;
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const version = browser.version();
const digest = text => createHash('sha256').update(text).digest('hex');
const endpoint = request => new URL(request.url()).pathname;
const bodyOf = request => request.postData() ? request.postDataJSON() : null;
const isRepository = (response, owner, repo) => {
  if (endpoint(response.request()) !== '/api/graph/repository') return false;
  const body = bodyOf(response.request());
  return body?.owner === owner && body?.repo === repo;
};

function watch(p) {
  p.setDefaultTimeout(30000);
  p.on('pageerror', error => errors.push({ phase, kind: 'pageerror', message: error.message }));
  p.on('console', message => {
    if (message.type() === 'error') errors.push({ phase, kind: 'console', message: message.text() });
  });
  p.on('request', request => {
    if (!new URL(request.url()).pathname.startsWith('/api/')) return;
    const headers = request.headers(), body = bodyOf(request);
    const hasCredential = !!headers.authorization || !!headers['x-api-key'] ||
      !!(body && Object.keys(body).some(key => /token|password|credential/i.test(key)));
    requests.push({ phase, endpoint: endpoint(request), method: request.method(), body,
      authorizationPresent: !!headers.authorization, credentialPresent: hasCredential });
    if (hasCredential) errors.push({ phase, kind: 'browser-credentials', message: endpoint(request) });
  });
}
async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true });
  page = await context.newPage();
  // Keep auxiliary protocol capture bounded. Playwright's separate private
  // inspector cache still cannot reliably retain Simbrain's 20.8 MB body;
  // the nonmutating bridge observer below supplies that actual parsed value.
  const network = await context.newCDPSession(page);
  await network.send('Network.enable', {
    maxResourceBufferSize: 64 * 1024 * 1024,
    maxTotalBufferSize: 128 * 1024 * 1024,
  });
  watch(page);
  await page.goto(base);
  await page.waitForFunction(() => typeof window.fetchRepositoryGraph === 'function');
  // Only supplies a ref to the actual bridge; no replacement server responses.
  await page.evaluate(sha => {
    const real = window.fetchRepositoryGraph;
    window.__overviewLiveCapture = { sequence: 0, request: null, result: null };
    window.fetchRepositoryGraph = input => {
      const request = input.owner === 'simbrain' && input.repo === 'simbrain' ? { ...input, ref: sha } : input;
      return real(request).then(result => {
        const state = window.__overviewLiveCapture;
        state.sequence++;
        state.request = { owner: request.owner, repo: request.repo, ref: request.ref || null };
        state.result = result;
        return result; // Observe the app's actual parsed response without altering it.
      });
    };
  }, SHA);
  return page;
}
async function capturedLiveResult(p, owner, repo, sha, afterSequence) {
  // Playwright's private inspector session can evict a 20.8 MB response
  // despite a separately configured CDP buffer. Read the exact parsed value
  // returned by the real bridge, gated by request identity and a fresh sequence.
  await p.waitForFunction(({ owner, repo, sha, afterSequence }) => {
    const capture = window.__overviewLiveCapture;
    return capture?.sequence > afterSequence && capture.request.owner === owner &&
      capture.request.repo === repo && capture.request.ref === sha &&
      capture.result?.graph?.context?.resolvedSha === sha;
  }, { owner, repo, sha, afterSequence }, { timeout });
  return p.evaluate(() => window.__overviewLiveCapture.result);
}
async function submit(p, repository) {
  const input = p.locator('input[aria-label="Repository URL"]:visible').first();
  await input.fill(repository);
  await input.press('Enter');
}
async function ready(p, owner, repo, sha) {
  await p.getByTestId('revision-badge').waitFor({ state: 'attached', timeout });
  await p.waitForFunction(({ owner, repo, sha }) => {
    const title = document.querySelector('[data-testid="revision-badge"]')?.getAttribute('title') || '';
    return title.startsWith(owner + '/' + repo + ' ') && (!sha || title.endsWith('@' + sha));
  }, { owner, repo, sha }, { timeout });
}
async function paint(p) {
  await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function check(name, fn) {
  phase = name;
  const errorStart = errors.length, began = Date.now();
  try {
    await fn();
    await paint(page);
    assert.equal(errors.length, errorStart, JSON.stringify(errors.slice(errorStart)));
    results.push({ name, status: 'PASS', durationMs: Date.now() - began });
    console.log('PASS ' + name);
  } catch (error) {
    const filename = 'failure-' + name.replace(/[^a-z0-9]/gi, '-') + '.png';
    if (page && !page.isClosed()) await page.screenshot({ path: join(out, filename) }).catch(() => {});
    results.push({ name, status: 'FAIL', durationMs: Date.now() - began, error: error.stack, screenshot: filename });
    console.error('FAIL ' + name + ': ' + error.message);
  }
}
function verifyGraph(data, owner, repo, sha) {
  assert.ok(data.graph, 'real successful graph response required');
  const context = data.graph.context;
  assert.equal(context.owner, owner);
  assert.equal(context.repo, repo);
  assert.equal(context.sourceOwner, owner);
  assert.equal(context.sourceRepo, repo);
  if (sha) assert.equal(context.resolvedSha, sha);
  return data.graph;
}
function representativePath(name) {
  assert.ok(liveResult?.graph, 'live Simbrain graph capture is required');
  const paths = liveResult.graph.nodes.map(node => node.coordinate?.path).filter(path => path?.endsWith('/' + name));
  assert.equal(paths.length, 1, 'unique independent graph path for ' + name);
  return paths[0];
}
async function selectSearch(p, filename) {
  const path = representativePath(filename);
  // A prior failed assertion can leave this same file selected. Clear it
  // through the real UI before expecting a new ownership request; otherwise
  // React legitimately reuses that selection and no request is scheduled.
  const dismissPreview = p.locator('.file-preview-close');
  if (await dismissPreview.count()) await dismissPreview.click();
  const backToIssues = p.getByRole('button', { name: '← Back to Issues', exact: true });
  if (await backToIssues.count()) {
    if (p.viewportSize().width <= 980 && !(await p.locator('.right-panel.mobile-visible').count())) {
      await p.locator('button[aria-label="Toggle details panel"]:visible, button[aria-label="Open insights panel"]:visible').first().click();
    }
    await backToIssues.click();
    await backToIssues.waitFor({ state: 'detached' });
    await closeDetails(p);
  }
  const search = p.getByRole('searchbox', { name: 'Search repository files', exact: true });
  // A translated off-screen sidebar is still Playwright-visible. Require
  // its actual mobile-open state before exercising its search controls.
  if (p.viewportSize().width <= 980 && !(await p.locator('.sidebar.mobile-visible').count())) {
    // Current markup has Toggle in mobile-panel-actions and Open in the
    // bottom nav; CSS selects which is exposed at this viewport.
    await p.locator('button[aria-label="Toggle explorer panel"]:visible, button[aria-label="Open explorer panel"]:visible').first().click();
    await p.locator('.sidebar.mobile-visible').waitFor({ state: 'visible' });
  }
  await search.fill(filename);
  const result = p.locator('[aria-label="Repository search results"]').getByRole('button', { name: 'Select file: ' + path, exact: true });
  await result.waitFor({ state: 'visible' });
  await result.focus();
  assert.equal(await result.evaluate(el => el === document.activeElement), true);
  const ownership = p.waitForResponse(response => endpoint(response.request()) === '/api/github/blame' &&
    bodyOf(response.request())?.path === path, { timeout });
  await result.press('Enter');
  const response = await ownership;
  assert.equal(response.status(), 200, 'live ownership response');
  assertIdentity(response.request(), path);
  const authors = await response.json();
  captures.push({ phase, kind: 'live-ownership', path, authorCount: authors.authors?.length, status: response.status() });
  const open = p.getByRole('button', { name: 'Open file', exact: true });
  await open.waitFor({ state: 'visible' });
  assert.equal(await open.isDisabled(), true, 'Kotlin/Java explicit Inspector Open file must be disabled');
  const exactNode = p.locator('svg').getByRole('button', { name: 'Select file: ' + path, exact: true });
  assert.equal(await exactNode.count(), 1, 'unsupported graph node exposes selection rather than Open');
  assert.equal(await exactNode.getAttribute('aria-disabled'), 'false', 'selection fallback remains accessible');
  return path;
}
function assertIdentity(request, path) {
  const body = bodyOf(request);
  assert.equal(body.owner, 'simbrain');
  assert.equal(body.repo, 'simbrain');
  assert.equal(body.ref, SHA);
  assert.equal(body.path, path);
  assert.equal(!!request.headers().authorization, false);
}
async function sourceOracle(p, path, screenshot) {
  const pending = p.waitForResponse(response => endpoint(response.request()) === '/api/github/file-content' &&
    bodyOf(response.request())?.path === path, { timeout });
  await p.getByRole('button', { name: 'View Source', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200, 'live source response');
  assertIdentity(response.request(), path);
  const data = await response.json();
  assert.equal(typeof data.content, 'string');
  await p.locator('.file-preview-code').waitFor({ state: 'visible', timeout });
  const displayed = await p.locator('.file-preview-text').allTextContents();
  const expected = data.content.split('\n');
  assert.deepEqual(displayed, expected, 'source text must preserve punctuation, escapes, empty lines and literal markup');
  const text = displayed.join('\n');
  captures.push({ phase, kind: 'live-source-oracle', path, sourceBytes: Buffer.byteLength(data.content),
    sourceSha256: digest(data.content), displayedSha256: digest(text), lineCount: displayed.length,
    exactTextEqual: text === data.content });
  await p.screenshot({ path: join(out, screenshot) });
  await p.locator('.file-preview-close').click();
}
async function closeDetails(p) {
  if (await p.locator('.right-panel.mobile-visible').count()) {
    await p.getByRole('button', { name: 'Close details panel', exact: true }).click();
    await p.locator('.right-panel.mobile-visible').waitFor({ state: 'detached' });
  }
}
async function transform(p) {
  return p.locator('svg').filter({ has: p.locator('circle.nc') }).first()
    .evaluate(el => ({ x: el.__zoom.x, y: el.__zoom.y, k: el.__zoom.k }));
}
async function settleZoom(p) {
  await p.waitForFunction(() => {
    const svg = [...document.querySelectorAll('svg')].find(el => el.querySelector('circle.nc'));
    return svg && !svg.__transition;
  });
}
async function waitZoomChange(p, before) {
  await p.waitForFunction(before => {
    const svg = [...document.querySelectorAll('svg')].find(el => el.querySelector('circle.nc'));
    return svg?.__zoom && Math.abs(svg.__zoom.k - before.k) > 0.00001;
  }, before);
}

try {
  await check('live pinned Simbrain overview and complete node count', async () => {
    const p = await fresh();
    const initialSequence = await p.evaluate(() => window.__overviewLiveCapture.sequence);
    const responsePromise = p.waitForResponse(response => isRepository(response, 'simbrain', 'simbrain'), { timeout });
    await submit(p, 'simbrain/simbrain');
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    assert.equal(bodyOf(response.request()).ref, SHA);
    const result = await capturedLiveResult(p, 'simbrain', 'simbrain', SHA, initialSequence);
    const graph = verifyGraph(result, 'simbrain', 'simbrain', SHA);
    liveResult = result;
    artifactTasks.push(writeFile(join(out, 'simbrain-live-response.json'), JSON.stringify(result)));
    assert.equal(graph.nodes.length, 1303);
    assert.equal(graph.metadata.coverage.treeBlobs, 2372);
    assert.equal(graph.metadata.coverage.selected, 1304);
    assert.equal(graph.metadata.coverage.analyzed, 1303);
    assert.equal(graph.metadata.coverage.contentBytes, 8993604);
    assert.equal(graph.metadata.coverage.failed, 0);
    captures.push({ phase, kind: 'live-server-response', cache: result.cache, context: graph.context,
      nodeCount: graph.nodes.length, coverage: graph.metadata.coverage, responseBytes: Buffer.byteLength(JSON.stringify(result)) });
    await ready(p, 'simbrain', 'simbrain', SHA);
    await p.waitForFunction(() => document.querySelectorAll('circle.nc').length === 1303, null, { timeout });
    assert.equal(await p.locator('circle.nc').count(), 1303);
    await p.screenshot({ path: join(out, 'desktop-overview.png') });
  });

  await check('live desktop search keyboard selection ownership source and unsupported navigation', async () => {
    assert.ok(liveResult, 'requires live overview');
    for (const filename of ['MathUtils.kt', 'ResourceManager.java']) {
      const path = await selectSearch(page, filename);
      await sourceOracle(page, path, 'desktop-source-' + filename + '.png');
    }
    await page.getByRole('searchbox', { name: 'Search repository files', exact: true }).fill('');
    assert.equal(await page.locator('[aria-label="Repository search results"] button').count(), 0);
  });

  await check('live desktop fit pan zoom and reset', async () => {
    assert.ok(liveResult, 'requires live overview');
    const p = page;
    await p.getByRole('button', { name: 'Fit view', exact: true }).click();
    await settleZoom(p);
    const fitted = await transform(p);
    assert.ok(Number.isFinite(fitted.k) && fitted.k > 0);
    await p.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await waitZoomChange(p, fitted);
    await settleZoom(p);
    const zoomed = await transform(p);
    assert.ok(zoomed.k > fitted.k);
    const graph = p.locator('svg').filter({ has: p.locator('circle.nc') }).first();
    const blank = await graph.evaluate(svg => {
      const r = svg.getBoundingClientRect();
      for (let y = r.top + 100; y < Math.min(r.bottom - 80, innerHeight - 80); y += 30) {
        for (let x = r.left + 30; x < Math.min(r.right - 100, innerWidth - 100); x += 30) {
          if (document.elementFromPoint(x, y) === svg && document.elementFromPoint(x + 50, y + 25) === svg) return { x, y };
        }
      }
      return null;
    });
    assert.ok(blank, 'reachable graph background for an actual pointer pan');
    const beforePan = await transform(p);
    await p.mouse.move(blank.x, blank.y);
    await p.mouse.down();
    await p.mouse.move(blank.x + 50, blank.y + 25, { steps: 10 });
    await p.mouse.up();
    const afterPan = await transform(p);
    assert.ok(Math.abs(afterPan.x - beforePan.x) > 1 || Math.abs(afterPan.y - beforePan.y) > 1);
    await p.getByRole('button', { name: 'Reset zoom', exact: true }).click();
    await p.waitForFunction(() => {
      const svg = [...document.querySelectorAll('svg')].find(el => el.querySelector('circle.nc'));
      return svg && Math.abs(svg.__zoom.k - 1) < 0.001 && Math.abs(svg.__zoom.x) < 0.01 && Math.abs(svg.__zoom.y) < 0.01;
    });
    captures.push({ phase, fitted, zoomed, beforePan, afterPan, reset: await transform(p) });
  });

  await check('live narrow viewport search and source text', async () => {
    assert.ok(liveResult, 'requires live overview');
    await page.setViewportSize({ width: 390, height: 844 });
    await closeDetails(page);
    const path = await selectSearch(page, 'MathUtils.kt');
    await sourceOracle(page, path, 'narrow-source-MathUtils.kt.png');
    await closeDetails(page);
    await page.getByRole('button', { name: 'Fit view', exact: true }).click();
    await paint(page);
    assert.equal(await page.locator('circle.nc').count(), 1303);
    await page.screenshot({ path: join(out, 'narrow-overview.png') });
  });

  if (process.env.OVERVIEW_TREEMAP === '1') {
    await check('live treemap complete scrollable filenames and keyboard selection', async () => {
      assert.ok(liveResult, 'requires real captured graph');
      const p = page;
      await closeDetails(p);
      await p.setViewportSize({ width: 1600, height: 1000 });
      const view = p.getByRole('combobox', { name: 'Visualization type', exact: true });
      try {
        await view.selectOption('treemap');
        const list = p.locator('.treemap-label-list[aria-label="Treemap file labels"]');
        await list.waitFor({ state: 'visible' });
        const actual = await list.getByRole('button').evaluateAll(buttons => buttons.map(button => ({
          path: button.getAttribute('aria-label').replace(/^Select treemap file: /, ''),
          text: button.textContent,
        })).sort((a, b) => a.path.localeCompare(b.path)));
        const expected = liveResult.graph.nodes.map(node => ({
          path: node.coordinate.path,
          text: node.coordinate.path.split('/').at(-1),
        })).sort((a, b) => a.path.localeCompare(b.path));
        assert.deepEqual(actual, expected, 'all 1303 filenames must be complete, including literal punctuation');
        const scrollable = await list.evaluate(el => ({
          clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, overflowY: getComputedStyle(el).overflowY,
        }));
        assert.ok(scrollable.scrollHeight > scrollable.clientHeight);
        assert.ok(['auto', 'scroll'].includes(scrollable.overflowY));
        await list.getByRole('button').last().scrollIntoViewIfNeeded();
        assert.ok(await list.evaluate(el => el.scrollTop > 0), 'actual list scroll');
        const path = representativePath('ResourceManager.java');
        const target = list.getByRole('button', { name: 'Select treemap file: ' + path, exact: true });
        await target.scrollIntoViewIfNeeded();
        await target.focus();
        assert.equal(await target.evaluate(el => document.activeElement === el), true);
        await target.press('Enter');
        await p.locator('.right-panel .panel-header .panel-title').filter({ hasText: 'ResourceManager.java' }).first().waitFor({ state: 'visible' });
        assert.ok((await p.locator('.right-panel .panel-header .panel-subtitle').innerText()).includes(path.slice(0, path.lastIndexOf('/'))));
        await list.getByRole('button', { name: 'Select treemap file: ' + path, exact: true }).scrollIntoViewIfNeeded();
        await p.screenshot({ path: join(out, 'desktop-treemap-complete-labels.png') });
        captures.push({ phase, kind: 'live-graph-alternate-view', filenames: actual.length, scrollable, selectedPath: path });
      } finally {
        await view.selectOption('graph');
      }
    });
  }

  await check('fault injection cancelled obsolete response then live other repository and retry', async () => {
    assert.ok(liveResult, 'requires real captured graph; no synthetic success fixture');
    const p = await fresh();
    // Controlled noncooperative bridge promise: its eventual value is exactly
    // the previously captured real server response. No new GitHub work starts.
    await p.evaluate(captured => {
      const real = window.fetchRepositoryGraph;
      window.__overviewFault = { mode: 'delay', pending: [], captured };
      window.fetchRepositoryGraph = input => {
        const state = window.__overviewFault;
        if (input.owner !== 'simbrain' || input.repo !== 'simbrain' || state.mode === 'live') return real(input);
        if (state.mode === 'fail') return Promise.reject(new Error('Controlled overview retrieval failure'));
        return new Promise(resolve => state.pending.push({ signal: input.signal, resolve }));
      };
    }, liveResult);
    await submit(p, 'simbrain/simbrain');
    await p.waitForFunction(() => window.__overviewFault.pending.length === 1);
    const cancel = p.getByRole('button', { name: 'Cancel repository load', exact: true });
    await cancel.waitFor({ state: 'visible' });
    await p.screenshot({ path: join(out, 'initial-cancel-visible.png') });
    await cancel.click();
    await p.waitForFunction(() => window.__overviewFault.pending[0].signal.aborted);
    await cancel.waitFor({ state: 'detached' });
    const otherResponsePromise = p.waitForResponse(response => isRepository(response, 'octocat', 'Hello-World'), { timeout });
    await submit(p, 'octocat/Hello-World');
    const otherResponse = await otherResponsePromise;
    assert.equal(otherResponse.status(), 200);
    const otherResult = await otherResponse.json();
    const otherGraph = verifyGraph(otherResult, 'octocat', 'Hello-World');
    await ready(p, 'octocat', 'Hello-World', otherGraph.context.resolvedSha);
    const before = await p.getByTestId('revision-badge').getAttribute('title');
    await p.evaluate(() => window.__overviewFault.pending[0].resolve(window.__overviewFault.captured));
    await paint(p);
    assert.equal(await p.getByTestId('revision-badge').getAttribute('title'), before, 'obsolete Simbrain result cannot replace Hello-World');
    assert.equal(await p.locator('circle.nc').count(), otherGraph.nodes.length);
    await p.screenshot({ path: join(out, 'after-obsolete-response.png') });
    captures.push({ phase, kind: 'delayed-replay-fault-injection', capturedRealGraph: 'simbrain-live-response.json',
      signalAborted: true, staleAdoption: false, otherRepository: otherGraph.context, otherCache: otherResult.cache });

    await p.evaluate(() => { window.__overviewFault.mode = 'fail'; });
    await submit(p, 'simbrain/simbrain');
    await p.getByRole('alert').filter({ hasText: 'Controlled overview retrieval failure' }).waitFor({ state: 'visible' });
    await p.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await p.evaluate(() => { window.__overviewFault.mode = 'live'; });
    const beforeRetrySequence = await p.evaluate(() => window.__overviewLiveCapture.sequence);
    const retryPromise = p.waitForResponse(response => isRepository(response, 'simbrain', 'simbrain'), { timeout });
    await submit(p, 'simbrain/simbrain');
    const retryResponse = await retryPromise;
    assert.equal(retryResponse.status(), 200);
    assert.equal(bodyOf(retryResponse.request()).ref, SHA);
    const retryResult = await capturedLiveResult(p, 'simbrain', 'simbrain', SHA, beforeRetrySequence);
    assert.equal(verifyGraph(retryResult, 'simbrain', 'simbrain', SHA).nodes.length, 1303);
    await ready(p, 'simbrain', 'simbrain', SHA);
    await p.waitForFunction(() => document.querySelectorAll('circle.nc').length === 1303, null, { timeout });
    captures.push({ phase, kind: 'live-retry-after-injected-failure', cache: retryResult.cache, nodeCount: retryResult.graph.nodes.length });
    await p.screenshot({ path: join(out, 'retry-success.png') });
  });
} finally {
  await Promise.all(artifactTasks);
  await writeFile(join(out, 'results.json'), JSON.stringify({
    startedAt, completedAt: new Date().toISOString(), base, browserVersion: version,
    evidenceBoundary: { refPinning: 'existing bridge seam; pasted /tree/ref support NOT tested',
      device: 'Chromium with touch capability and viewport resize; no physical iOS/Android',
      retrieval: 'real local server HTTP responses; cache.hit recorded per response; large JSON observed nonmutating at real bridge return with identity/sequence guards',
      faults: 'delayed noncooperative bridge replay of captured real graph plus explicit rejected promise',
      backendBenchmark: 'not measured by this browser harness' },
    results, requests, errors, captures,
  }, null, 2));
  await browser.close();
}
if (results.some(result => result.status !== 'PASS') || errors.length) process.exitCode = 1;
