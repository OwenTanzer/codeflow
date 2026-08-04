// Server integration smoke test — MOO-67 Commits 5-6.
//
// Not part of the zero-setup `node --test tests/*.test.mjs` suite (same
// reason as codeflow-repo-smoke.mjs and tests/ui-smoke.mjs — this needs
// dist/ already built). Spawns the real server process (not a mock) on an
// isolated port + workspace root, and exercises exactly what Commits 5-6's
// checklists check: static serving, health/readiness, the local-path and
// GitHub-backed analyze endpoints, allowlist rejection, input validation,
// rate limiting, and workspace cleanup. The app-level auth gate this test
// once also covered (Commit 6) was removed entirely in a later change —
// every /api/* route is now unauthenticated.
//
// Requires a real GitHub credential to verify the GitHub-backed path
// end-to-end (not just "didn't crash with a fake token" — GitHub 401s an
// invalid token even for public data). MOO-72 Commit 7: reads GITHUB_TOKEN
// from the environment first (CI supplies the Actions-provided
// secrets.GITHUB_TOKEN this way, sufficient for the public-repo-only reads
// this script makes) — falls back to whatever `gh auth token` already has
// authenticated locally, same PAT decided on for the server's own
// GITHUB_TOKEN, unchanged from before for local dev.
//
// Usage: node tests/server-smoke.mjs (run `npm run build` first; either set
// GITHUB_TOKEN or be signed in via `gh auth login`)
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const port = 3999;
const baseUrl = `http://localhost:${port}`;

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

let githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  try {
    githubToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error(
      'Could not get a GitHub token via GITHUB_TOKEN or `gh auth token` — required to ' +
        'verify the GitHub-backed /api/analyze-repo path end-to-end. Set GITHUB_TOKEN or run `gh auth login` first.'
    );
    process.exit(1);
  }
}

const workspaceRoot = await mkdtemp(join(tmpdir(), 'codeflow-server-smoke-'));
const child = spawn(process.execPath, [join(repoRoot, 'server', 'index.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    WORKSPACE_ROOT: workspaceRoot,
    GITHUB_TOKEN: githubToken,
    ALLOWED_OWNERS: 'octocat',
    // The rate limiter is keyed per client IP, shared across every request
    // this whole test makes (they all originate from localhost) -- high
    // enough that the budget-consuming functional requests above (every
    // request counts against the budget regardless of its eventual status
    // code, including the /api/graph/repository steps MOO-69 Commit 2
    // added) don't trip it prematurely, low enough that the dedicated
    // rate-limit test (which fires well past the remainder) still
    // exceeds it quickly. 14 requests happen before the
    // dedicated rate-limit test (10 pre-existing + 4 for the MOO-69
    // Commit 2 /api/graph/repository steps); a budget of 18 leaves that
    // test comfortable margin to trip 429 partway through its own 12-request
    // burst rather than right at the boundary.
    RATE_LIMIT_PER_MINUTE: '18',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLogs = [];
child.stdout.on('data', (d) => serverLogs.push(d.toString()));
child.stderr.on('data', (d) => serverLogs.push(d.toString()));

try {
  await waitForReady(10000);

  await step('serves the built application (no auth required)', async () => {
    const res = await fetch(baseUrl + '/');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.text();
    assert(body.includes('<div id="root">'), 'expected the app shell markup');
  });

  await step('/healthz reports ok with runtime info (no auth required)', async () => {
    const res = await fetch(baseUrl + '/healthz');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.status === 'ok', 'expected status ok');
    assert(typeof json.nodeVersion === 'string', 'expected nodeVersion');
  });

  await step('/readyz reports ready with passing checks and full detail (no auth exists)', async () => {
    const res = await fetch(baseUrl + '/readyz');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.status === 'ready', 'expected status ready');
    assert(json.checks.buildOutput.ok === true, 'expected buildOutput check to pass');
    assert(json.checks.workspaceRoot.ok === true, 'expected workspaceRoot check to pass');
    // MOO-72 Commit 5: the new checks, against the real server -- pyan3 and
    // GitHub are real (pinned pyan3 + a real `gh auth token`), so these can
    // assert real ok:true, not just presence.
    assert(json.checks.cacheStorage.ok === true, 'expected cacheStorage check to pass');
    assert(json.checks.nodeRuntime.ok === true, `expected nodeRuntime check to pass under ${process.version}`);
    assert(json.checks.pyan3.ok === true, 'expected the real pinned pyan3 to be available');
    assert(json.checks.pythonRuntime.ok === true, 'expected the real Python interpreter to be available');
    assert(json.checks.githubReachable.ok === true, 'expected the real GitHub token to be valid and reachable');
    assert(json.checks.graphvizDot.applicable === false, 'graphvizDot must read as not-applicable, not a passed check');
    // /readyz has no auth tier to gate detail behind anymore -- always full detail.
    assert(typeof json.checks.pyan3.version === 'string', 'expected the detected pyan3 version');
    assert(typeof json.checks.nodeRuntime.version === 'string', 'expected the Node version');
  });

  await step('/api/analyze matches the known golden-world baseline', async () => {
    const res = await fetch(baseUrl + '/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'tests/fixtures/golden-world' }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.stats.files === 6, `expected 6 files, got ${json.stats.files}`);
    assert(json.stats.functions === 7, `expected 7 functions, got ${json.stats.functions}`);
    assert(json.stats.connections === 6, `expected 6 connections, got ${json.stats.connections}`);
  });

  await step('/api/analyze rejects a path outside the repository', async () => {
    const res = await fetch(baseUrl + '/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../../../../etc' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await step('/api/analyze rejects a request with no path', async () => {
    const res = await fetch(baseUrl + '/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await step('/api/analyze-repo (real GitHub, allowlisted owner) analyzes octocat/Hello-World', async () => {
    const res = await fetch(baseUrl + '/api/analyze-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'octocat', repo: 'Hello-World' }),
    });
    const json = await res.json();
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(json)}`);
    assert(json.stats.files >= 1, `expected at least 1 file, got ${json.stats.files}`);
    assert(typeof json.resolvedRef === 'string' && json.resolvedRef.length > 0, 'expected a resolved ref');
  });

  await step('/api/analyze-repo respects an explicit ref (named branch), not just the default branch', async () => {
    // Regression check: fetchTree/fetchAllContents must use the requested
    // ref, not silently the repo's default branch (GitHub.scanTree, which
    // this deliberately does NOT reuse, has exactly that bug).
    const res = await fetch(baseUrl + '/api/analyze-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'octocat', repo: 'Hello-World', ref: 'test' }),
    });
    const json = await res.json();
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(json)}`);
    assert(json.resolvedRef === 'test', `expected resolvedRef "test", got ${json.resolvedRef}`);
  });

  await step('/api/analyze-repo resolves a PR to its fork\'s tree, not the base repo\'s', async () => {
    // Regression check: a PR's head commit usually lives in a fork
    // (head.repo != the base owner/repo) -- confirmed the hard way while
    // building this endpoint, fetching the base repo's tree for a fork's
    // SHA 404s. PR #10587 against octocat/Hello-World is from
    // XiaoPangDaiMa/Hello-World; if this specific PR/fork ever disappears,
    // this check may need a new example PR, same as any test pinned to
    // real external repo state.
    const res = await fetch(baseUrl + '/api/analyze-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'octocat', repo: 'Hello-World', pr: 10587 }),
    });
    const json = await res.json();
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(json)}`);
    assert(json.resolvedRef === '736d73334223554b9a9501d7a004b9f770ee41ec', `expected the PR's head SHA, got ${json.resolvedRef}`);
  });

  await step('/api/analyze-repo returns a clean 502 (not a generic 500) when a ref genuinely cannot be found', async () => {
    // Regression check: GitHub.request()'s errorMap-driven errors are
    // plain Errors, not GithubFetchError -- without apiRequest() wrapping
    // them, this fell through to a generic 500 "Analysis failed" instead
    // of GitHub's own "not found" message.
    const res = await fetch(baseUrl + '/api/analyze-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'octocat', repo: 'Hello-World', ref: 'no-such-branch-xyz' }),
    });
    const json = await res.json();
    assert(res.status === 502, `expected 502, got ${res.status}`);
    assert(/not found/i.test(json.error), `expected a "not found" message, got: ${json.error}`);
  });

  await step('/api/analyze-repo rejects a repository not on the allowlist, before fetching it', async () => {
    const res = await fetch(baseUrl + '/api/analyze-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'torvalds', repo: 'linux' }),
    });
    assert(res.status === 403, `expected 403, got ${res.status}`);
  });

  await step('/api/analyze-repo rejects a malformed owner before any allowlist/fetch step', async () => {
    const res = await fetch(baseUrl + '/api/analyze-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'in valid!', repo: 'Hello-World' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await step('/api/analyze-repo rejects specifying both ref and pr', async () => {
    const res = await fetch(baseUrl + '/api/analyze-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'octocat', repo: 'Hello-World', ref: 'master', pr: 1 }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await step('/api/graph/repository (real GitHub, allowlisted owner) returns a valid AdapterResult wrapping a repository GraphIR', async () => {
    const res = await fetch(baseUrl + '/api/graph/repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'octocat', repo: 'Hello-World' }),
    });
    const json = await res.json();
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(json)}`);
    assert(json.graph.layer === 'repository', 'expected a repository-layer graph');
    assert(json.graph.context.mode === 'repository', `expected context.mode "repository", got ${json.graph.context.mode}`);
    assert(/^[0-9a-f]{7,40}$/i.test(json.graph.context.resolvedSha), 'expected context.resolvedSha to be a real commit SHA, not a branch name');
    assert(json.graph.nodes.length >= 1, `expected at least 1 node, got ${json.graph.nodes.length}`);
    assert(typeof json.cache.key === 'string' && json.cache.key.startsWith('graphir:v'), 'expected a graphir cache key');
    assert(json.cache.hit === false, 'expected a cache miss (no durable cache store yet -- MOO-72)');
  });

  await step('/api/graph/repository respects an explicit ref, resolving it to a real commit SHA (not the branch name)', async () => {
    const res = await fetch(baseUrl + '/api/graph/repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'octocat', repo: 'Hello-World', ref: 'test' }),
    });
    const json = await res.json();
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(json)}`);
    assert(json.graph.context.mode === 'branch', `expected context.mode "branch", got ${json.graph.context.mode}`);
    assert(json.graph.context.ref === 'test', `expected context.ref "test", got ${json.graph.context.ref}`);
    assert(json.graph.context.resolvedSha !== 'test', 'resolvedSha must be the resolved commit SHA, not the literal branch name');
  });

  // MOO-72 Commit 7: the one ref-mode gap the audit found -- a full commit
  // SHA passed as `ref` is a real, distinct request *shape* (even though
  // graph-repository.js's buildRequestContext routes it through the same
  // mode:'branch' code path as a named branch, confirmed via grep -- there
  // is no separate 'commit' mode anywhere in this codebase). The real
  // assertion worth making here is that resolvedSha comes back byte-identical
  // to what was passed, proving no unnecessary re-resolution happens when
  // the input is already a full SHA.
  await step('/api/graph/repository accepts a full commit SHA as ref (commit-only input), resolving to itself unchanged', async () => {
    const knownSha = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d'; // octocat/Hello-World's real first commit -- stable, will not change
    const res = await fetch(baseUrl + '/api/graph/repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'octocat', repo: 'Hello-World', ref: knownSha }),
    });
    const json = await res.json();
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(json)}`);
    assert(json.graph.context.ref === knownSha, `expected context.ref to echo the SHA verbatim, got ${json.graph.context.ref}`);
    assert(json.graph.context.resolvedSha === knownSha, `expected resolvedSha to equal the input SHA exactly with no re-resolution, got ${json.graph.context.resolvedSha}`);
  });

  await step("/api/graph/repository resolves a PR's context to its fork's source repository, not the base", async () => {
    // Same PR referenced in the /api/analyze-repo fork-resolution check
    // above (PR #10587, octocat/Hello-World, fork XiaoPangDaiMa/Hello-World).
    const res = await fetch(baseUrl + '/api/graph/repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'octocat', repo: 'Hello-World', pr: 10587 }),
    });
    const json = await res.json();
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(json)}`);
    assert(json.graph.context.mode === 'pr', `expected context.mode "pr", got ${json.graph.context.mode}`);
    assert(json.graph.context.owner === 'octocat', 'base owner should be preserved for provenance/allowlist identity');
    assert(json.graph.context.sourceOwner === 'XiaoPangDaiMa', `expected sourceOwner to be the fork owner, got ${json.graph.context.sourceOwner}`);
    assert(json.graph.context.resolvedSha === '736d73334223554b9a9501d7a004b9f770ee41ec', `expected the PR's head SHA, got ${json.graph.context.resolvedSha}`);
  });

  await step('/api/graph/repository rejects a repository not on the allowlist, before fetching it', async () => {
    const res = await fetch(baseUrl + '/api/graph/repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'torvalds', repo: 'linux' }),
    });
    const json = await res.json();
    assert(res.status === 403, `expected 403, got ${res.status}`);
    assert(Array.isArray(json.diagnostics) && json.diagnostics.length === 1, 'expected one sanitized diagnostic');
  });

  await step('rate limiting returns 429 with a Retry-After header once the per-minute budget (configured to 18) is exceeded', async () => {
    // 7 budget-consuming requests already happened above; fire well past
    // the remainder regardless of exact prior count.
    const results = [];
    let rateLimitedRes = null;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(baseUrl + '/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'tests/fixtures/golden-world' }),
      });
      results.push(res.status);
      if (res.status === 429 && !rateLimitedRes) rateLimitedRes = res;
    }
    assert(results.some((s) => s === 429), `expected at least one 429 among ${results.join(',')}`);
    // MOO-72 Commit 4 PR review: the panel-side Retry-After gating is only
    // real if the server's own rate limiter actually emits the header --
    // this is the end-to-end assertion the review asked for, not just the
    // unit-level RateLimiter.check() coverage in tests/rate-limit.test.mjs.
    const retryAfter = rateLimitedRes.headers.get('Retry-After');
    assert(retryAfter !== null, 'expected a Retry-After header on the 429 response');
    const retryAfterSeconds = Number(retryAfter);
    assert(Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0 && retryAfterSeconds <= 60, `expected an integer Retry-After within the 60s window, got ${retryAfter}`);
  });

  // MOO-72 Commit 6: the root itself now legitimately carries the
  // ownership marker and this process's own instances/<bootId>/ namespace
  // for the whole server lifetime -- "empty" now means "no per-request
  // workspace directories left inside this instance's own namespace",
  // not "the root has zero entries at all".
  await step('every per-request workspace was cleaned up (this instance\'s own namespace is empty)', async () => {
    const rootEntries = (await readdir(workspaceRoot)).sort();
    assert(
      rootEntries.length === 2 && rootEntries[0] === '.codeflow-owned-v1' && rootEntries[1] === 'instances',
      `expected only the ownership marker and instances/, found: ${rootEntries.join(', ')}`
    );
    const instancesDir = join(workspaceRoot, 'instances');
    const instanceDirs = await readdir(instancesDir);
    assert(instanceDirs.length === 1, `expected exactly this one running instance, found: ${instanceDirs.join(', ')}`);
    const ownInstanceDir = join(instancesDir, instanceDirs[0]);
    const ownEntries = await readdir(ownInstanceDir);
    assert(
      ownEntries.length === 1 && ownEntries[0] === '.codeflow-instance-lock',
      `expected only the instance lock file (every per-request workspace cleaned up), found: ${ownEntries.join(', ')}`
    );
  });
} finally {
  child.kill();
  await rm(workspaceRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\n${failures.length} step(s) failed:`);
  for (const f of failures) console.log(' - ' + f.name + ': ' + f.error.message);
  console.log('\n--- server logs ---');
  console.log(serverLogs.join(''));
  process.exit(1);
}
console.log('\nServer smoke suite passed.');
