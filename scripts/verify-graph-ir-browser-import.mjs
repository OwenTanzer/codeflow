// Browser-import smoke check for src/graph-ir/index.js — MOO-68 PR review
// follow-up.
//
// docs/graph-ir-contract.md documents src/graph-ir/index.js as the one
// import surface for every consumer, which includes browser-side
// renderer/navigation code, not just the server. This is exactly the gap a
// PR review caught: sourceCoordinate.js's route-token encoding used to
// depend on Node's `Buffer`, and cacheKey.js's hashing used to depend on
// `node:crypto` — both unavailable in a Vite browser bundle with no
// Node-polyfill plugin configured. A `node --test` run never catches that,
// since Node itself provides those globals; only a real browser does not.
// This drives the barrel through an actual headless Chromium page instead.
//
// Usage: node scripts/verify-graph-ir-browser-import.mjs [url]
// Requires the Vite dev server already running (`npm run dev`) — the
// production build doesn't bundle src/graph-ir/ into dist/ yet (MOO-68
// defines the contract; no renderer/adapter imports it into the app bundle
// until MOO-69), so this targets the dev server specifically, which serves
// any project source file as an ES module on request.
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:5173/';

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleMessages = [];
page.on('console', (msg) => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => consoleMessages.push(`[pageerror] ${err.stack || err.message}`));

await page.goto(url, { waitUntil: 'networkidle' });

const result = await page.evaluate(async () => {
  const mod = await import('/src/graph-ir/index.js');
  const context = mod.normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: 'a'.repeat(40) });
  const coord = mod.makeCoordinate({
    repository: { host: 'github.com', owner: 'octocat', name: 'Hello-World' },
    revision: 'a'.repeat(40),
    path: 'src/app.py',
    symbolKind: 'module',
  });
  const token = mod.encodeCoordinateToken(coord);
  const decoded = mod.decodeCoordinateToken(token);
  const cacheKey = mod.buildCacheKey({
    context,
    analyzerName: 'browser-smoke',
    analyzerVersion: '1.0.0',
    graphSchemaVersion: mod.GRAPH_IR_SCHEMA_VERSION,
  });
  return {
    tokenRoundTrips: JSON.stringify(decoded) === JSON.stringify(coord),
    cacheKeyLooksValid: typeof cacheKey === 'string' && /^graphir:v\d+:[0-9a-f]{16}$/.test(cacheKey),
    exportCount: Object.keys(mod).length,
  };
});

console.log('graph-ir browser import result:', JSON.stringify(result, null, 2));
consoleMessages.forEach((m) => console.log(m));
await browser.close();

const consoleErrors = consoleMessages.filter((m) => m.startsWith('[error]') || m.startsWith('[pageerror]'));
console.log('---');
console.log(
  'summary: tokenRoundTrips=' + result.tokenRoundTrips +
    ' cacheKeyLooksValid=' + result.cacheKeyLooksValid +
    ' consoleErrors=' + consoleErrors.length
);

if (!result.tokenRoundTrips || !result.cacheKeyLooksValid || consoleErrors.length > 0) {
  process.exit(1);
}
