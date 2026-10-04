// Local preview regression. Repository retrieval is real (live/cache as server reports).
// File-content responses are controlled fixtures. A document-response-only hook
// exposes openFilePreview(path,line) for the otherwise hard-to-time scroll race.
// No product source on disk, credentials or authentication settings are changed.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://127.0.0.1:5128/';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local app only');
const out = process.argv[3] || 'test-results/integration-preview';
await mkdir(out, { recursive: true });
const SHA = '611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60';
const PATH = 'src/requests/sessions.py', OTHER = 'src/requests/models.py';
const payloads = [
  { name: 'empty', source: '' },
  { name: 'empty-lines', source: '\n\n' },
  { name: 'markup-and-literals', source: [
    'value = "<img src=x onerror=window.__previewExecuted=1>"',
    'literal = "<span class=\\\"syn-kw\\\">return</span> &lt; &amp; #quot;"',
    'text = "return class def 123 \\\\ \\"quoted\\""',
    "# return class def 123 <script>window.__previewExecuted=2</script>",
    "other = 'if else 321 \\\\ slash'",
    'if value < other and value > 0:',
    '    return value',
    '', '',
  ].join('\n') },
  { name: 'multiline-and-escapes', source: [
    'text = """first <b>line</b>',
    "second 'quote' & \\t \\n \\x41",
    'return class def third"""',
    'path = "C:\\\\source\\\\example.py"',
    '\t# literal ellipses ... and punctuation _.-(),:',
    '',
  ].join('\n') },
];
const replacement = 'replacement line 1\nreplacement line 2\n';
const errors = [], requests = [], responses = [], checks = [];
const browser = await chromium.launch();
const result = {
  mode: 'real pinned repository retrieval; controlled file-content HTTP fixtures; local document hook for scroll races',
  refInput: 'SHA injected at existing fetchRepositoryGraph bridge; pasted /tree/ref support not asserted',
  hook: 'window.__integrationPreview.open exposes existing App openFilePreview only',
  realDevice: false,
  checks, requests, responses, errors,
};
let page, failure, phase = 'setup', activeSource = '', delayMs = 0;
const responseTasks = [];
try {
  page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.setDefaultTimeout(20000);
  page.on('pageerror', e => errors.push({ phase, kind: 'pageerror', message: e.message }));
  page.on('console', m => {
    if (m.type() === 'error') errors.push({ phase, kind: 'console', message: m.text() });
  });
  page.on('request', r => {
    if (!new URL(r.url()).pathname.startsWith('/api/')) return;
    const body = r.postData() ? r.postDataJSON() : null;
    const authorizationPresent = !!r.headers().authorization;
    requests.push({ phase, endpoint: new URL(r.url()).pathname, body, authorizationPresent });
    if (authorizationPresent) errors.push({ phase, kind: 'identity', message: 'Browser Authorization header' });
  });
  page.on('response', r => {
    if (!new URL(r.url()).pathname.startsWith('/api/')) return;
    const responsePhase = phase;
    responseTasks.push((async () => {
      const endpoint = new URL(r.url()).pathname;
      const entry = { phase: responsePhase, endpoint, status: r.status(),
        controlled: endpoint === '/api/github/file-content' };
      if (endpoint === '/api/graph/repository') {
        const body = await r.json();
        entry.context = body.graph?.context;
        entry.cache = body.cache ?? body.cacheHit ?? null;
      }
      responses.push(entry);
    })().catch(e => errors.push({ phase: responsePhase, kind: 'response', message: e.message })));
  });
  await page.route(base, async route => {
    const response = await route.fetch();
    const html = await response.text();
    const marker = /^[ \t]*\/\/ Open file preview\r?$/gm;
    assert.equal([...html.matchAll(marker)].length, 1, 'one exact App preview instrumentation point');
    await route.fulfill({ response, body: html.replace(marker, comment =>
      '    window.__integrationPreview={open:openFilePreview};\n' + comment) });
  });
  await page.route('**/api/github/file-content', async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.owner, 'psf');
    assert.equal(body.repo, 'requests');
    assert.equal(body.ref, SHA);
    assert.ok([PATH, OTHER].includes(body.path));
    const source = body.path === OTHER ? replacement : activeSource;
    const wait = delayMs;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    try { await route.fulfill({ status: 200, json: { content: source } }); }
    catch (e) {
      // A deliberately cancelled request may already have lost its route.
      // Record the outcome rather than pretending its response succeeded.
      responses.push({ phase, endpoint: '/api/github/file-content', controlled: true,
        outcome: 'fulfill rejected after cancellation', message: e.message });
    }
  });
  await page.goto(base);
  await page.waitForFunction(() => typeof window.fetchRepositoryGraph === 'function');
  await page.evaluate(ref => {
    const original = window.fetchRepositoryGraph;
    window.fetchRepositoryGraph = input => original({ ...input, ref });
  }, SHA);
  const repoInput = page.getByRole('textbox', { name: 'Repository URL', exact: true }).first();
  await repoInput.fill('psf/requests');
  await repoInput.press('Enter');
  await page.getByTestId('revision-badge').waitFor({ state: 'attached', timeout: 300000 });
  await page.getByRole('button', { name: 'Open file: ' + PATH, exact: true }).click();
  await page.getByRole('button', { name: 'View Source', exact: true }).waitFor();
  await Promise.all(responseTasks);
  const repository = responses.find(r => r.endpoint === '/api/graph/repository' && r.context);
  assert.ok(repository, 'observed successful real repository response');
  assert.equal(repository.status, 200);
  assert.equal(repository.context.owner, 'psf');
  assert.equal(repository.context.repo, 'requests');
  assert.equal(repository.context.resolvedSha, SHA);
  result.repository = repository;
  checks.push({ name: 'real pinned repository identity', status: 'PASS' });

  async function exactPreview(source, path = PATH) {
    await page.locator('.file-preview-code').waitFor();
    assert.equal(await page.locator('.file-preview-loading').count(), 0);
    assert.equal(await page.locator('.file-preview-error').count(), 0);
    assert.equal(await page.locator('.file-preview-path').textContent(), path);
    assert.deepEqual(await page.locator('.file-preview-text').allTextContents(), source.split('\n'));
    assert.equal(await page.locator('.file-preview-text img,.file-preview-text script,.file-preview-text iframe').count(), 0);
    assert.equal(await page.evaluate(() => window.__previewExecuted), undefined);
  }
  for (const fixture of payloads) {
    phase = fixture.name;
    activeSource = fixture.source;
    const before = requests.length;
    await page.getByRole('button', { name: 'View Source', exact: true }).click();
    await exactPreview(fixture.source);
    assert.ok(requests.slice(before).some(r => r.endpoint === '/api/github/file-content'),
      'GitHub view-model empty placeholder triggers HTTP fallback');
    if (fixture.name === 'markup-and-literals') {
      assert.equal(await page.locator('.file-preview-text .syn-str .syn-kw,.file-preview-text .syn-com .syn-kw').count(), 0);
    }
    await page.screenshot({ path: join(out, fixture.name + '.png') });
    checks.push({ name: fixture.name, status: 'PASS', lines: fixture.source.split('\n').length });
    await page.locator('.file-preview-close').click();
    await page.locator('.file-preview-overlay').waitFor({ state: 'hidden' });
  }

  // Observe code insertion and trigger the real close control or next preview
  // in the browser 10ms later, before the product's 100ms scroll timer.
  activeSource = Array.from({ length: 100 }, (_, i) => 'source line ' + (i + 1)).join('\n');
  for (const action of ['dismiss', 'supersede']) {
    phase = 'loaded-line-scroll-' + action;
    await page.evaluate(({ path, other, action }) => {
      window.__previewRace = { action, scrolls: [], ready: false };
      const race = window.__previewRace;
      const originalScroll = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) {
        if (this.matches('.file-preview-line')) race.scrolls.push({
          path: document.querySelector('.file-preview-path')?.textContent, at: performance.now(),
        });
        return originalScroll.apply(this, args);
      };
      race.restore = () => { Element.prototype.scrollIntoView = originalScroll; };
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.file-preview-line.highlighted')) return;
        observer.disconnect();
        race.loadedAt = performance.now();
        setTimeout(() => {
          race.actedAt = performance.now();
          if (action === 'dismiss') document.querySelector('.file-preview-close').click();
          else window.__integrationPreview.open(other);
          race.ready = true;
        }, 10);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.__integrationPreview.open(path, 70);
    }, { path: PATH, other: OTHER, action });
    await page.waitForFunction(() => window.__previewRace.ready);
    if (action === 'dismiss') await page.locator('.file-preview-overlay').waitFor({ state: 'hidden' });
    else await exactPreview(replacement, OTHER);
    await page.waitForTimeout(180);
    const race = await page.evaluate(() => {
      const r = window.__previewRace; r.restore();
      return { action: r.action, elapsedMs: r.actedAt - r.loadedAt, scrolls: r.scrolls };
    });
    assert.ok(race.elapsedMs < 100, 'race actually exercised before scroll deadline');
    assert.deepEqual(race.scrolls, [], 'dismissed/replaced line preview must not scroll');
    if (action === 'dismiss') assert.equal(await page.locator('.file-preview-overlay').count(), 0);
    else {
      await exactPreview(replacement, OTHER);
      await page.locator('.file-preview-close').click();
    }
    checks.push({ name: phase, status: 'PASS', ...race });
  }

  phase = 'dismiss-pending-response';
  delayMs = 250;
  const pending = page.waitForRequest(r => new URL(r.url()).pathname === '/api/github/file-content');
  await page.evaluate(path => window.__integrationPreview.open(path, 70), PATH);
  await pending;
  await page.locator('.file-preview-close').click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.file-preview-overlay').count(), 0, 'late HTTP response cannot restore dismissed modal');
  checks.push({ name: phase, status: 'PASS' });
  await Promise.all(responseTasks);
  assert.deepEqual(errors, [], 'unexpected console/page errors');
  result.status = 'PASS';
} catch (e) {
  failure = e;
  result.status = 'FAIL';
  result.error = e.stack || String(e);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  await Promise.all(responseTasks);
  result.browser = browser.version();
  await writeFile(join(out, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
if (failure) throw failure;
