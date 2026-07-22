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
// Deliberately never fails the parent `npm install`: the runtime
// (server/index.js) already handles pyan3 being unavailable gracefully
// (logs a warning, serves /api/graph/file in degraded tree-sitter-only
// mode) rather than crashing — a failed Python install here follows the
// same philosophy rather than breaking deployment of the rest of the app.
import { spawnSync } from 'node:child_process';

const CANDIDATES = [
  ['pip3', ['install', '--break-system-packages', '-r', 'requirements.txt']],
  ['pip3', ['install', '-r', 'requirements.txt']],
  ['pip', ['install', '--break-system-packages', '-r', 'requirements.txt']],
  ['pip', ['install', '-r', 'requirements.txt']],
];

let installed = false;
for (const [cmd, args] of CANDIDATES) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status === 0) {
    installed = true;
    break;
  }
}

if (!installed) {
  console.warn(
    '[postinstall] Could not install requirements.txt (pyan3) with pip3/pip — ' +
      'the file layer (/api/graph/file) will run in degraded tree-sitter-only mode until this is fixed. ' +
      'See docs/file-layer-limitations.md and requirements.txt.'
  );
}
