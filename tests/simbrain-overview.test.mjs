import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createGraphRepositoryHandler } from '../server/routes/graph-repository.js';
import { selectAnalyzableFiles, fetchTree, fetchAllContents } from '../server/lib/github-analyzer-bridge.js';
import { withTimeout } from '../server/lib/request-work.js';
import { GraphCache } from '../server/lib/graph-cache.js';
import { Metrics } from '../server/lib/metrics.js';
import { ConcurrencyLimiter } from '../server/lib/concurrency-limiter.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const config = { allowedOwners: ['fixture'], allowedRepos: [], githubToken: 'test',
  maxRequestBodyBytes: 16384, graphAnalysisTimeoutMs: 5000, githubFetchConcurrency: 3,
  maxFileBytes: 1024, maxRepoBytes: 1000000 };
const json = data => ({ ok: true, status: 200, headers: new Headers(), json: async () => data });
const blob = () => json({ encoding: 'base64', content: Buffer.from('x').toString('base64') });
const tree = n => Array.from({ length: n }, (_, i) => ({ type: 'blob', path: 'f' + i + '.txt', sha: String(i), size: 1 }));
function response() {
  const r = new EventEmitter();
  r.writableEnded = false;
  r.writeHead = code => { r.status = code; };
  r.end = raw => { r.body = JSON.parse(raw); r.writableEnded = true; };
  return r;
}
function harness(overrides = {}) {
  const cache = new GraphCache({ maxItems: 8, maxBytes: 10000000, ttlMs: 60000, enabled: true });
  const limiter = new ConcurrencyLimiter(1);
  const handler = createGraphRepositoryHandler({ config: { ...config, ...overrides }, cache,
    concurrencyLimiter: limiter, metrics: new Metrics() });
  const start = (repo = 'one', res = response()) => ({ res, done: handler(
    Readable.from([Buffer.from(JSON.stringify({ owner: 'fixture', repo, ref: 'main' }))]), res, repo) });
  return { start, cache, limiter };
}
function install(t, fn) {
  const old = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => { globalThis.fetch = old; });
}
for (const count of [750, 751, 2500]) {
  test('complete route returns all ' + count + ' eligible files', async t => {
    let calls = 0;
    install(t, async url => {
      calls++;
      if (url.includes('/commits/')) return json({ sha: A });
      if (url.includes('/trees/')) { assert.ok(url.includes(A)); return json({ truncated: false, tree: tree(count) }); }
      return blob();
    });
    const h = harness();
    const req = h.start(); await req.done;
    assert.equal(req.res.status, 200, JSON.stringify(req.res.body));
    const c = req.res.body.graph.metadata.coverage;
    assert.equal(c.analyzed, count);
    assert.equal(c.treeBlobs, c.analyzed + c.skipped + c.failed);
    assert.equal(req.res.body.graph.nodes.length, count);
    assert.equal(calls, count + 2);
  });
}

for (const cause of ['cancel', 'timeout', 'failure', 'rate-limit']) {
  test(cause + ' aborts active retrieval, drains before capacity release, and recovers', async t => {
    let active = 0, peak = 0, started = 0, aborted = 0, settled = false;
    let allStarted;
    const startedGate = new Promise(r => { allStarted = r; });
    const h = harness({ graphAnalysisTimeoutMs: cause === 'timeout' ? 80 : 5000 });
    install(t, async (url, { signal }) => {
      if (url.includes('/commits/')) return json({ sha: A });
      if (url.includes('/trees/')) return json({ truncated: false, tree: tree(25) });
      started++; active++; peak = Math.max(peak, active);
      const mine = started;
      if (started === 3) allStarted();
      try {
        if (mine === 1 && ['failure', 'rate-limit'].includes(cause)) {
          await startedGate;
          if (cause === 'failure') throw new Error('upstream unavailable');
          return { ok: false, status: 429, headers: new Headers(), body: { cancel: async () => {} } };
        }
        await new Promise(resolve => {
          const stop = () => { aborted++; setTimeout(resolve, 60); };
          if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
        });
        return blob();
      } finally { active--; }
    });
    const first = h.start();
    first.done.then(() => { settled = true; });
    await startedGate;
    if (cause === 'cancel') first.res.emit('close');
    // Wait for abort notification but not for deliberately delayed draining.
    const until = Date.now() + 2000;
    while (!aborted && Date.now() < until) await delay(2);
    assert.ok(aborted > 0);
    assert.equal(settled, false);
    assert.equal(h.limiter.active, 1);
    const rejected = h.start('two'); await rejected.done;
    assert.equal(rejected.res.status, 503);
    await first.done;
    assert.equal(active, 0);
    assert.equal(started, 3, 'no worker scheduled more blobs after cancellation/failure');
    assert.equal(peak, 3);
    assert.equal(h.limiter.active, 0);
    assert.equal(h.cache.size, 0);
    if (cause !== 'cancel') assert.equal(first.res.status, cause === 'timeout' ? 504 : cause === 'rate-limit' ? 429 : 502);
    globalThis.fetch = async url => url.includes('/commits/') ? json({ sha: B }) :
      url.includes('/trees/') ? json({ truncated: false, tree: tree(1) }) : blob();
    const next = h.start('two'); await next.done;
    assert.equal(next.res.status, 200);
    assert.equal(next.res.body.graph.context.repo, 'two');
    assert.equal(next.res.body.graph.context.resolvedSha, B);
    const repeat = h.start('two'); await repeat.done;
    assert.equal(repeat.res.body.cache.hit, true);
    assert.equal(h.cache.size, 1, 'cancelled old result cannot populate cache later');
  });
}
test('branch movement cannot change fetched tree and cache is keyed by resolved revision', async t => {
  let branch = A;
  const trees = [];
  install(t, async url => {
    if (url.includes('/commits/')) {
      const resolved = branch;
      branch = B; // Branch advances immediately after resolution.
      return json({ sha: resolved });
    }
    if (url.includes('/trees/')) { trees.push(url); return json({ truncated: false, tree: tree(1) }); }
    return blob();
  });
  const h = harness();
  const first = h.start(); await first.done;
  const second = h.start(); await second.done;
  const repeat = h.start(); await repeat.done;
  assert.equal(first.res.body.graph.context.resolvedSha, A);
  assert.equal(second.res.body.graph.context.resolvedSha, B);
  assert.notEqual(first.res.body.cache.key, second.res.body.cache.key);
  assert.equal(repeat.res.body.cache.hit, true);
  assert.equal(trees.length, 2);
  assert.ok(trees[0].includes(A) && trees[1].includes(B));
  assert.ok(trees.every(u => !u.includes('/main')));
});
for (const data of [{ truncated: true, tree: [] }, {}, { tree: 'invalid' }]) {
  test('incomplete or invalid tree fails explicitly: ' + JSON.stringify(data), async t => {
    install(t, async () => json(data));
    await assert.rejects(fetchTree({ owner: 'fixture', repo: 'one', resolvedRef: A, ...config }), /truncated|Invalid tree/);
  });
}
test('coverage reconciles exclusions and per-file budgets; aggregate remains hard', () => {
  const input = [{ ...tree(1)[0], path: 'ok.js', size: 4 },
    { ...tree(1)[0], path: 'big.js', size: 1025 },
    { ...tree(1)[0], path: 'node_modules/x.js', size: 20 }];
  const { coverage, files } = selectAnalyzableFiles(input, config);
  assert.equal(coverage.selected, 2);
  assert.equal(coverage.selectedBytes, 1029);
  assert.equal(coverage.skippedReasons.per_file_bytes, 1);
  assert.equal(coverage.skippedReasons.excluded_directory, 1);
  assert.equal(coverage.treeBlobs, files.length + coverage.skipped);
  assert.throws(() => selectAnalyzableFiles(tree(100), { ...config, maxRepoBytes: 99 }), /aggregate/);
});
test('blob size and actual aggregate byte budgets cannot be bypassed', async t => {
  install(t, async () => blob());
  await assert.rejects(fetchAllContents('fixture', 'one', [{ path: 'x', sha: 'x', size: 2 }]), /disagrees/);
  await assert.rejects(fetchAllContents('fixture', 'one', tree(4), 2, { maxRepoBytes: 3 }), /aggregate/);
  await assert.rejects(fetchAllContents('fixture', 'one', tree(1), 1, { maxFileBytes: 0 }), /per-file/);
});
test('a noncooperative operation cannot free its timeout capacity early', async () => {
  let drained = false;
  await assert.rejects(withTimeout(async () => { await delay(40); drained = true; },
    { timeoutMs: 5, timeoutMessage: 'deadline' }), /deadline/);
  assert.equal(drained, true);
});

test('oversized streamed blob response is cancelled before JSON decoding', async t => {
  let cancelled = false;
  install(t, async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(70000)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(fetchAllContents('fixture', 'one', tree(1), 1, { maxFileBytes: 1 }), /bounded transfer/);
  assert.equal(cancelled, true);
});
test('single-file source preview uses the same bounded blob retrieval', async t => {
  const { fetchSingleFileContent } = await import('../server/lib/github-analyzer-bridge.js');
  install(t, async url => url.includes('/trees/') ? json({ tree: tree(1), truncated: false }) : blob());
  assert.equal(await fetchSingleFileContent({ owner: 'fixture', repo: 'one', path: 'f0.txt', ref: A }, config), 'x');
});
test('UTF-8 cache accounting enforces actual serialized byte budget', () => {
  const graph = { label: '漢'.repeat(20) };
  const bytes = Buffer.byteLength(JSON.stringify(graph));
  const cache = new GraphCache({ maxItems: 2, maxBytes: bytes - 1, ttlMs: 60000, enabled: true });
  cache.set('unicode', graph);
  assert.equal(cache.size, 0);
});
