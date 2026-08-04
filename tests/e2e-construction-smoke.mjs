// End-to-end construction smoke test — MOO-72 Commit 7.
//
// Not part of the zero-setup `node --test tests/*.test.mjs` suite (same
// reason as server-smoke.mjs/function-layer-smoke.mjs — this needs dist/
// already built and a real GitHub credential). Spawns its own isolated real
// server process (own port, own WORKSPACE_ROOT, own APP_PASSWORD) rather than
// sharing server-smoke.mjs's, so the two scripts never fight over the same
// process or rate-limit budget.
//
// Scope, deliberately distinct from server-smoke.mjs (which already owns
// repository-layer ref-mode coverage — branch/commit/PR) and from
// function-layer-smoke.mjs (which already owns the Playwright-driven,
// browser-rendered visual smoke path): this proves the actual
// repository -> file -> function *chain* end-to-end at the HTTP/JSON level,
// structurally -- schema validity, revision propagation, cross-layer cache
// hits, error isolation, and that the existing render-model builders don't
// throw against a really-fetched graph. Never a judgment about
// visualization quality.
//
// Usage: node tests/e2e-construction-smoke.mjs (run `npm run build` first;
// either set GITHUB_TOKEN or be signed in via `gh auth login`; optionally
// set PRIVATE_FIXTURE_REPO=owner/repo to also exercise a private fixture)
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateGraphIR } from '../src/graph-ir/graphIR.js';
import { buildRepositoryRenderModel } from '../src/render/repositoryRenderModel.js';
import { buildFileRenderModel } from '../src/render/fileRenderModel.js';
import { buildFunctionRenderModel } from '../src/render/functionRenderModel.js';
import { repositoryGraphToViewModel } from '../src/adapters/repositoryGraphToViewModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const port = 3998; // distinct from server-smoke.mjs's 3999 -- own isolated process
const baseUrl = `http://localhost:${port}`;
const APP_PASSWORD = 'e2e-construction-smoke-secret';

// Same fixture function-layer-smoke.mjs already uses -- proven to work,
// avoids inventing a second one just for this script.
const REPO_OWNER = 'octocat';
const REPO_NAME = 'Hello-World';
const CHAIN_OWNER = 'psf';
const CHAIN_REPO = 'requests';
const CHAIN_FILE = 'src/requests/sessions.py';
const CHAIN_SYMBOL_PATH = ['SessionRedirectMixin', 'resolve_redirects'];
// Pinned to a specific commit (not the mutable default branch) -- an
// upstream rename/removal of sessions.py or resolve_redirects would
// otherwise make this required CI check fail with no change on our side.
// Verified this SHA has the file and symbol as of 2026-07-29:
// https://github.com/psf/requests/blob/414f0513c33883adf6f2b46901d4f0b38a455851/src/requests/sessions.py
const CHAIN_REF = '414f0513c33883adf6f2b46901d4f0b38a455851';

function assert(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + message);
}

const failures = [];
async function step(name, fn) {
  try {
    await fn();
    console.log('ok   - ' + name);
  } catch (err) {
    failures.push({ name, error: err });
    console.log('FAIL - ' + name + ': ' + err.message);
  }
}

async function waitForReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/readyz');
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready in time');
}

function authed(headers = {}) {
  return { Authorization: `Bearer ${APP_PASSWORD}`, ...headers };
}

async function postJson(path, body) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: authed({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Asserts a graph is schema-valid, throwing with the real validation errors if not. */
function assertValidGraph(graph, label) {
  const { valid, errors } = validateGraphIR(graph);
  assert(valid, `${label}: graph failed schema validation: ${JSON.stringify(errors)}`);
}

let githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  try {
    githubToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error('Could not get a GitHub token via GITHUB_TOKEN or `gh auth token`. Set GITHUB_TOKEN or run `gh auth login` first.');
    process.exit(1);
  }
}

const workspaceRoot = await mkdtemp(join(tmpdir(), 'codeflow-e2e-smoke-'));
const child = spawn(process.execPath, [join(repoRoot, 'server', 'index.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    WORKSPACE_ROOT: workspaceRoot,
    APP_PASSWORD,
    GITHUB_TOKEN: githubToken,
    ALLOWED_OWNERS: [REPO_OWNER, CHAIN_OWNER, ...(process.env.PRIVATE_FIXTURE_REPO ? [process.env.PRIVATE_FIXTURE_REPO.split('/')[0]] : [])].join(','),
    RATE_LIMIT_PER_MINUTE: '30', // generous -- this script's own budget, unrelated to server-smoke.mjs's
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));

try {
  await waitForReady(15_000);

  let repositoryResolvedSha;
  let fileCacheKeyFirstHit;
  let functionCacheKeyFirstHit;

  await step('repository-only: schema-valid graph, real renderability', async () => {
    const { status, json } = await postJson('/api/graph/repository', { owner: REPO_OWNER, repo: REPO_NAME });
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
    assertValidGraph(json.graph, 'repository');
    repositoryResolvedSha = json.graph.context.resolvedSha;
    assert(/^[0-9a-f]{7,40}$/i.test(repositoryResolvedSha), 'expected a real resolved commit SHA');
    // Structural renderability -- headless, no browser: the same
    // render-model builder the real UI calls must not throw against a
    // really-fetched graph, and must yield at least one node.
    const viewModel = repositoryGraphToViewModel(json.graph);
    const renderModel = buildRepositoryRenderModel(viewModel, null);
    assert(renderModel && renderModel.nodes && renderModel.nodes.length >= 1, 'expected buildRepositoryRenderModel to produce at least one node');
  });

  let chainResolvedSha;
  await step('repository -> file: revision-pinned, schema-valid, renderable', async () => {
    // Establish the chain's own pinned revision from a fresh repository
    // call against the fixture the file/function steps actually use --
    // deliberately not reusing repositoryResolvedSha above, which is a
    // different repo (octocat/Hello-World). Requests CHAIN_REF (a pinned
    // commit, not the mutable default branch) so this required CI check
    // can't fail from an unrelated upstream change to psf/requests.
    const repoRes = await postJson('/api/graph/repository', { owner: CHAIN_OWNER, repo: CHAIN_REPO, ref: CHAIN_REF });
    assert(repoRes.status === 200, `expected 200, got ${repoRes.status}: ${JSON.stringify(repoRes.json)}`);
    chainResolvedSha = repoRes.json.graph.context.resolvedSha;
    assert(chainResolvedSha === CHAIN_REF, `expected the pinned SHA to resolve to itself unchanged, got ${chainResolvedSha}`);

    const { status, json } = await postJson('/api/graph/file', { owner: CHAIN_OWNER, repo: CHAIN_REPO, ref: chainResolvedSha, path: CHAIN_FILE });
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
    assertValidGraph(json.graph, 'file');
    assert(json.graph.context.resolvedSha === chainResolvedSha, `expected revision propagation: file layer resolvedSha (${json.graph.context.resolvedSha}) must equal the parent repository's (${chainResolvedSha})`);
    const renderModel = buildFileRenderModel(json.graph);
    assert(renderModel && renderModel.nodes && renderModel.nodes.length >= 1, 'expected buildFileRenderModel to produce at least one node');
    assert(typeof json.cache.key === 'string', 'expected a cache key');
    assert(json.cache.hit === false, 'expected a cache miss on the first request');
    fileCacheKeyFirstHit = json.cache.key;
  });

  await step('repository -> file -> function: revision-pinned, schema-valid, renderable', async () => {
    const { status, json } = await postJson('/api/graph/function', {
      owner: CHAIN_OWNER,
      repo: CHAIN_REPO,
      ref: chainResolvedSha,
      path: CHAIN_FILE,
      symbolPath: CHAIN_SYMBOL_PATH,
    });
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
    assertValidGraph(json.graph, 'function');
    assert(json.graph.context.resolvedSha === chainResolvedSha, `expected revision propagation: function layer resolvedSha (${json.graph.context.resolvedSha}) must equal the parent repository's (${chainResolvedSha})`);
    const renderModel = buildFunctionRenderModel(json.graph);
    assert(renderModel && renderModel.nodes && renderModel.nodes.length >= 1, 'expected buildFunctionRenderModel to produce at least one node');
    assert(json.cache.hit === false, 'expected a cache miss on the first request');
    functionCacheKeyFirstHit = json.cache.key;
  });

  await step('central caching survives the full chain: repeating file and function requests hits the cache at both layers', async () => {
    const fileRepeat = await postJson('/api/graph/file', { owner: CHAIN_OWNER, repo: CHAIN_REPO, ref: chainResolvedSha, path: CHAIN_FILE });
    assert(fileRepeat.status === 200, `expected 200, got ${fileRepeat.status}`);
    assert(fileRepeat.json.cache.hit === true, 'expected a cache hit on the repeated file request');
    assert(fileRepeat.json.cache.key === fileCacheKeyFirstHit, 'expected the same cache key on repeat');

    const functionRepeat = await postJson('/api/graph/function', {
      owner: CHAIN_OWNER,
      repo: CHAIN_REPO,
      ref: chainResolvedSha,
      path: CHAIN_FILE,
      symbolPath: CHAIN_SYMBOL_PATH,
    });
    assert(functionRepeat.status === 200, `expected 200, got ${functionRepeat.status}`);
    assert(functionRepeat.json.cache.hit === true, 'expected a cache hit on the repeated function request');
    assert(functionRepeat.json.cache.key === functionCacheKeyFirstHit, 'expected the same cache key on repeat');
  });

  await step('error isolation: a failed file-layer request does not corrupt state for the next legitimate one', async () => {
    const bad = await postJson('/api/graph/file', { owner: CHAIN_OWNER, repo: CHAIN_REPO, ref: chainResolvedSha, path: 'this/path/does/not/exist.py' });
    assert(bad.status >= 400 && bad.status < 500, `expected a 4xx rejection for a nonexistent path, got ${bad.status}`);

    const good = await postJson('/api/graph/file', { owner: CHAIN_OWNER, repo: CHAIN_REPO, ref: chainResolvedSha, path: CHAIN_FILE });
    assert(good.status === 200, `expected the next legitimate file request to still succeed after the failure, got ${good.status}: ${JSON.stringify(good.json)}`);
    // Cache survives too, from the earlier steps -- the failed request must
    // not have evicted or corrupted the existing entry.
    assert(good.json.cache.hit === true, 'expected the legitimate request after the failure to still be served from cache');
  });

  const privateFixture = process.env.PRIVATE_FIXTURE_REPO;
  await step('private fixture repository (where feasible)', async () => {
    if (!privateFixture) {
      console.log('       skipped -- no private fixture configured. Set PRIVATE_FIXTURE_REPO=owner/repo to exercise this.');
      return;
    }
    const [owner, repo] = privateFixture.split('/');
    const { status, json } = await postJson('/api/graph/repository', { owner, repo });
    assert(status === 200, `expected 200 against the configured private fixture, got ${status}: ${JSON.stringify(json)}`);
    assertValidGraph(json.graph, 'private-fixture repository');
  });
} finally {
  child.kill();
  await rm(workspaceRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\n${failures.length} step(s) failed:`);
  for (const f of failures) console.log(' - ' + f.name + ': ' + f.error.message);
  process.exit(1);
}
console.log('\nEnd-to-end construction smoke suite passed.');
