// Credentialed, local-only acceptance against the actual server and both asset modes.
// Uses an existing server-side token (CI supplies its read-only Actions token).
// No synthetic API responses; interaction replay is captured by that suite live.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.env.GITHUB_TOKEN) throw Error('GITHUB_TOKEN is required for live browser acceptance');
const out = '.git/browser-acceptance';
await mkdir(out, { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), 'codeflow-browser-'));
const { GITHUB_TOKEN, ...browserEnv } = process.env;
const children = new Set();
const checks = [];
function start(args, env = browserEnv) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
async function ready(url, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error('Acceptance server exited before readiness');
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await delay(250);
  }
  throw Error('Timed out waiting for ' + url);
}
async function run(name, args, env = {}) {
  console.log('\nBROWSER ACCEPTANCE: ' + name);
  const child = start(args, { ...browserEnv, ...env });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? signal));
  });
  checks.push({ name, exit: code });
  await writeFile(join(out, 'checks.json'), JSON.stringify(checks, null, 2));
  if (code !== 0) throw Error(name + ' failed: ' + code);
}
function stop() { for (const child of children) child.kill('SIGTERM'); }
process.once('SIGINT', () => { stop(); process.exitCode = 130; });
process.once('SIGTERM', () => { stop(); process.exitCode = 143; });
try {
  const server = start(['server/index.js'], { ...process.env, PORT: '3000', ALLOWED_REPOS: 'psf/requests', ALLOWED_OWNERS: '', WORKSPACE_ROOT: workspace });
  await ready('http://127.0.0.1:3000/readyz', server);
  const dev = start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
  await ready('http://127.0.0.1:5173/', dev);
  for (const [mode, url] of [['dev','http://127.0.0.1:5173/'],['built','http://127.0.0.1:3000/']]) {
    await run(mode + ' startup/worker/fallback/disposal', ['tests/startup-bridge-browser.mjs', url]);
    await run(mode + ' Python worker', ['scripts/verify-worker-analysis.mjs', url]);
    await run(mode + ' local UI', ['tests/ui-smoke.mjs', url]);
  }
  await run('full labels', ['tests/full-labels-browser.mjs'], { LABEL_TEST_URL: 'http://127.0.0.1:5173/' });
  await run('renderer cleanup', ['tests/function-reflow-browser.mjs', 'http://127.0.0.1:5173/'], { CODEFLOW_REFLOW_OUT: join(out, 'reflow') });
  await run('live pinned Requests navigation', ['tests/function-layer-smoke.mjs', 'http://127.0.0.1:3000/']);
  // Respect the existing server budget; do not raise resource/rate limits.
  console.log('Waiting for the normal request-rate window before preview acceptance');
  await delay(60_050);
  await run('live Requests / controlled preview races', ['tests/integration-preview-browser.mjs', 'http://127.0.0.1:3000/', join(out, 'preview')]);
  // This suite waits its own normal windows and captures real responses before replay.
  await run('live Requests / captured interaction replay', ['tests/interaction-repairs-smoke.mjs', 'http://127.0.0.1:3000/', join(out, 'interactions')]);
} finally {
  const exits = [...children].map(child => new Promise(resolve => child.once('exit', resolve)));
  stop();
  await Promise.all(exits);
  await rm(workspace, { recursive: true, force: true });
}
