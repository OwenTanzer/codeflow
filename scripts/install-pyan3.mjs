#!/usr/bin/env node
// Best-effort install of the pinned pyan3 dependency (requirements.txt)
// during `npm install`/`npm ci` — MOO-70 Commit 9 PR review: production
// (Railway/Railpack) had no Python dependency manifest or install step at
// all, since Railpack detects this as a Node-primary app (package.json
// present) and only provisions Node by default. This piggybacks the
// Python install onto the Node install step Railpack already runs
// (via npm's "postinstall" lifecycle hook), rather than depending on
// Railpack-specific multi-language config syntax this repo has no way to
// verify without a live deployment.
//
// Live-verified finding (2026-07-22, real Railway deployment): installing
// into the system/mise-managed Python's global site-packages does NOT
// survive into the runtime image. Railpack's node provider assembles the
// final runtime image from a fresh copy of its shared Python toolchain
// base image plus a copy of just this project's own build output (/app);
// anything written outside /app during the build (a global `pip install`)
// is discarded. A venv rooted *inside* the repo directory (i.e. under
// /app) is copied forward like any other build artifact — confirmed by
// Railpack's own auto-detected Python provider using exactly this pattern
// (`python -m venv /app/.venv`) before this repo forced the Node provider.
//
// Deliberately never fails the parent `npm install`: the runtime
// (server/index.js) already handles pyan3 being unavailable gracefully
// (logs a warning, serves /api/graph/file in degraded tree-sitter-only
// mode) rather than crashing — a failed Python install here follows the
// same philosophy rather than breaking deployment of the rest of the app.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PYAN3_VENV_DIR, venvPythonPath } from './pyan3-venv-path.mjs';

const venvDir = join(process.cwd(), PYAN3_VENV_DIR);
const venvPython = venvPythonPath(process.cwd());

function tryVenvInstall(pythonBin) {
  if (!existsSync(venvPython)) {
    const created = spawnSync(pythonBin, ['-m', 'venv', venvDir], { stdio: 'inherit' });
    if (created.status !== 0) return false;
  }
  const result = spawnSync(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'], { stdio: 'inherit' });
  return result.status === 0;
}

let installed = tryVenvInstall('python3') || tryVenvInstall('python');

// Fallback for environments where venv creation isn't available at all
// (kept as a last resort — this is the pre-fix behavior, which is known
// not to survive Railway's build, but may still work for other hosts/CI).
if (!installed) {
  const GLOBAL_CANDIDATES = [
    ['pip3', ['install', '--break-system-packages', '-r', 'requirements.txt']],
    ['pip3', ['install', '-r', 'requirements.txt']],
    ['pip', ['install', '--break-system-packages', '-r', 'requirements.txt']],
    ['pip', ['install', '-r', 'requirements.txt']],
  ];
  for (const [cmd, args] of GLOBAL_CANDIDATES) {
    const result = spawnSync(cmd, args, { stdio: 'inherit' });
    if (result.status === 0) {
      installed = true;
      break;
    }
  }
}

if (!installed) {
  console.warn(
    '[postinstall] Could not install requirements.txt (pyan3) into a venv or globally — ' +
      'the file layer (/api/graph/file) will run in degraded tree-sitter-only mode until this is fixed. ' +
      'See docs/file-layer-limitations.md and requirements.txt.'
  );
}
