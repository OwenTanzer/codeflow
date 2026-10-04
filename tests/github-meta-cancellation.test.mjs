import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createGithubBlameHandler, createGithubFileContentHandler } from '../server/routes/github-meta.js';

const SHA = 'a'.repeat(40);
const config = { allowedOwners: ['fixture'], allowedRepos: [], githubToken: 'test',
  maxRequestBodyBytes: 16384, graphAnalysisTimeoutMs: 5000,
  maxFileBytes: 1024, maxRepoBytes: 4096 };
const json = data => ({ ok: true, status: 200, headers: new Headers(), json: async () => data });
const rootTree = () => json({ tree: [{ type: 'tree', path: 'src', sha: 'subtree' }] });
const fileTree = () => json({ tree: [{ type: 'blob', path: 'file.py', sha: 'blob', size: 1 }] });
const blob = () => json({ encoding: 'base64', content: 'eA==' });
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function response() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.writeHead = status => { res.status = status; };
  res.end = raw => { res.body = JSON.parse(raw); res.writableEnded = true; };
  return res;
}
function start(kind, overrides = {}, requestBody) {
  const handler = (kind === 'blame' ? createGithubBlameHandler : createGithubFileContentHandler)(
    { config: { ...config, ...overrides } });
  const req = requestBody ?? Readable.from([Buffer.from(JSON.stringify({
    owner: 'fixture', repo: 'one', ref: SHA, path: 'src/file.py',
  }))]);
  const res = response();
  return { req, res, done: handler(req, res, 'metadata-test') };
}
function install(t, fetchImpl) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => { globalThis.fetch = previous; });
}

for (const stage of ['root-tree', 'nested-tree', 'blob', 'commits']) {
  test('metadata disconnect aborts and drains ' + stage + ' without later requests', { timeout: 5000 }, async t => {
    const started = deferred(), drain = deferred(), aborted = deferred();
    const calls = [];
    let workSignal;
    const blockedCall = stage === 'root-tree' || stage === 'commits' ? 1 : stage === 'nested-tree' ? 2 : 3;
    install(t, async (url, { signal }) => {
      calls.push(url);
      if (calls.length === blockedCall) {
        workSignal = signal;
        signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        started.resolve();
        // Model an upstream that notices abort but settles only after cleanup.
        await drain.promise;
        return stage === 'commits' ? json([]) : stage === 'blob' ? blob() :
          stage === 'root-tree' ? rootTree() : fileTree();
      }
      return calls.length === 1 ? rootTree() : fileTree();
    });
    const run = start(stage === 'commits' ? 'blame' : 'content');
    let settled = false;
    run.done.then(() => { settled = true; });
    await started.promise;
    run.res.emit('close');
    await aborted.promise;
    await nextTurn();
    assert.equal(workSignal.aborted, true);
    assert.equal(settled, false, 'handler must drain noncooperative work');
    drain.resolve();
    await run.done;
    assert.equal(calls.length, blockedCall, 'no next tree/blob request after cancellation');
    assert.equal(run.res.status, undefined, 'no response after disconnection');
    assert.equal(run.res.listenerCount('close'), 0);
  });
}

test('metadata disconnect aborts a blob body read and waits for its cleanup', { timeout: 5000 }, async t => {
  const reading = deferred(), aborted = deferred(), drain = deferred();
  let calls = 0, cancelled = false, released = false;
  install(t, async (_url, { signal }) => {
    calls++;
    if (calls === 1) return rootTree();
    if (calls === 2) return fileTree();
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    return { ok: true, body: { getReader: () => ({
      async read() { reading.resolve(); await drain.promise; throw signal.reason; },
      async cancel() { cancelled = true; },
      releaseLock() { released = true; },
    }) } };
  });
  const run = start('content');
  let settled = false;
  run.done.then(() => { settled = true; });
  await reading.promise;
  run.res.emit('close');
  await aborted.promise;
  await nextTurn();
  assert.equal(settled, false);
  drain.resolve();
  await run.done;
  assert.equal(cancelled, true);
  assert.equal(released, true);
  assert.equal(calls, 3);
  assert.equal(run.res.status, undefined);
  assert.equal(run.res.listenerCount('close'), 0);
});

test('metadata deadline aborts upstream work and returns 504 only after draining', { timeout: 5000 }, async t => {
  const aborted = deferred(), drain = deferred();
  install(t, async (_url, { signal }) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    await drain.promise;
    return json([]);
  });
  const run = start('blame', { graphAnalysisTimeoutMs: 30 });
  await aborted.promise;
  assert.equal(run.res.status, undefined);
  drain.resolve();
  await run.done;
  assert.equal(run.res.status, 504);
  assert.match(run.res.body.error, /timed out/);
  assert.equal(run.res.listenerCount('close'), 0);
});

for (const kind of ['blame', 'content']) {
  test('metadata ' + kind + ' still succeeds and removes its disconnect listener', async t => {
    let calls = 0;
    install(t, async () => {
      calls++;
      if (kind === 'blame') return json([{ commit: { author: { name: 'Fixture' } } }]);
      return calls === 1 ? rootTree() : calls === 2 ? fileTree() : blob();
    });
    const run = start(kind);
    await run.done;
    assert.equal(run.res.status, 200);
    if (kind === 'content') assert.equal(run.res.body.content, 'x');
    else assert.deepEqual(run.res.body.authors, [{ name: 'Fixture', commits: 1, percent: 100 }]);
    assert.equal(run.res.listenerCount('close'), 0);
  });
}

test('metadata disconnection while reading request body does no GitHub work or response', async t => {
  let calls = 0;
  install(t, async () => { calls++; return json([]); });
  const req = new Readable({ read() {} });
  const run = start('blame', {}, req);
  run.res.emit('close');
  req.destroy(new Error('client disconnected'));
  await run.done;
  assert.equal(calls, 0);
  assert.equal(run.res.status, undefined);
  assert.equal(run.res.listenerCount('close'), 0);
});

test('metadata validation failure keeps its error and removes the disconnect listener', async t => {
  let calls = 0;
  install(t, async () => { calls++; return json([]); });
  const run = start('content', {}, Readable.from([Buffer.from('{}')]));
  await run.done;
  assert.equal(run.res.status, 400);
  assert.equal(calls, 0);
  assert.equal(run.res.listenerCount('close'), 0);
});
