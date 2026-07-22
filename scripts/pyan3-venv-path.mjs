// Shared venv-path logic for the pyan3 postinstall step (install-pyan3.mjs)
// and server config (server/lib/config.js) — both need to agree on exactly
// where the venv lives and which python binary inside it to use, so this
// is a single source of truth rather than two independently-maintained
// path computations.
import { join } from 'node:path';

export const PYAN3_VENV_DIR = '.venv-pyan3';

export function venvPythonPath(repoRoot) {
  return process.platform === 'win32'
    ? join(repoRoot, PYAN3_VENV_DIR, 'Scripts', 'python.exe')
    : join(repoRoot, PYAN3_VENV_DIR, 'bin', 'python3');
}
