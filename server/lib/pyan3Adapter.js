// pyan3 subprocess adapter — MOO-70 Commit 2.
//
// Wraps the pinned `pyan3==2.6.2` Python package as a server-side,
// execFile-only (never shell-interpolated) subprocess. Real-environment
// spikes (this pyan3 version, run locally) established the design here:
//   - pyan3 takes an explicit file-argument list, not a directory — so
//     package requests must enumerate every .py file themselves rather
//     than relying on shell globbing (execFile has no shell to glob with).
//   - DOT comes back clean on stdout; diagnostic warnings land on stderr,
//     verified to never bleed into stdout.
//   - Without an explicit --root, pyan3 warns and may mis-infer module
//     names when the invocation directory has no __init__.py/project
//     marker — our staged workspace dir always gets passed as --root.
//   - pyan3 is NOT tolerant of syntax errors in its input: a broken file
//     crashes it with an uncaught Python traceback (unlike
//     server/lib/pythonSymbolIndex.js's error-tolerant tree-sitter parse),
//     so that failure mode is detected and categorized separately
//     (parser_failure) from other subprocess failures.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AdapterError } from '../../src/graph-ir/adapterResult.js';

const PINNED_VERSION = '2.6.2';
const VERSION_PATTERN = /pyan3\s+(\d+\.\d+\.\d+)/;

let verifyPromise = null;

function runExecFile(pythonBin, args, options) {
  return new Promise((resolvePromise) => {
    // MOO-72 Commit 4: `signal` (when provided) is the InFlightRegistry's
    // internal AbortController -- distinct from the per-request
    // cancellation signal in server/lib/cancellation.js. execFile kills the
    // subprocess itself when it fires, which is what makes the registry's
    // "cancel the subprocess only when the last waiter leaves" guarantee
    // real rather than just an in-Node promise race.
    execFile(pythonBin, args, { timeout: options.timeoutMs, maxBuffer: options.maxBuffer, signal: options.signal }, (error, stdout, stderr) => {
      resolvePromise({ error, stdout, stderr });
    });
  });
}

/**
 * Verify the pinned pyan3 is actually installed and runnable, once,
 * caching the result. Meant to be called at server startup (fail fast)
 * rather than deferred to the first real request.
 * @param {object} input
 * @param {string} input.pythonBin
 * @returns {Promise<void>}
 */
export function verifyPyan3Available({ pythonBin }) {
  if (!verifyPromise) {
    verifyPromise = (async () => {
      const { error, stdout, stderr } = await runExecFile(pythonBin, ['-m', 'pyan', '--version'], { timeoutMs: 10_000, maxBuffer: 1024 * 1024 });
      if (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`pyan3 unavailable: "${pythonBin}" was not found on PATH. Set PYTHON_BIN to a valid Python 3 interpreter with pyan3==${PINNED_VERSION} installed.`);
        }
        throw new Error(`pyan3 unavailable: "${pythonBin} -m pyan --version" failed: ${stderr || error.message}`);
      }
      const match = VERSION_PATTERN.exec(stdout);
      if (!match) {
        throw new Error(`pyan3 unavailable: could not parse version from output: ${JSON.stringify(stdout)}`);
      }
      if (match[1] !== PINNED_VERSION) {
        throw new Error(`pyan3 version mismatch: expected ${PINNED_VERSION}, found ${match[1]}. Run \`pip install pyan3==${PINNED_VERSION}\`.`);
      }
    })();
  }
  return verifyPromise;
}

/** Test-only: forces the next verifyPyan3Available call to re-check. */
export function _resetVerifyCacheForTests() {
  verifyPromise = null;
}

/**
 * Write already-fetched file contents into a request workspace, preserving
 * their repo-relative directory structure, using the workspace's own
 * escape-safe path resolution (server/lib/workspace.js) — the "write
 * fetched content to disk" step pyan3 needs that nothing before this
 * commit ever did (github-analyzer-bridge.js only ever holds content in
 * memory).
 * @param {{resolve: (relativePath: string) => string}} workspace
 * @param {{path: string, content: string}[]} files
 * @returns {Promise<string[]>} absolute paths written, same order as `files`
 */
export async function stagePythonFiles(workspace, files) {
  const written = [];
  for (const file of files) {
    const target = workspace.resolve(file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
    written.push(target);
  }
  return written;
}

// MOO-72 Commit 4: subprocess_failure defaults to non-retryable (see
// RETRYABLE_BY_CATEGORY in adapterResult.js) because most causes here --
// bad arguments, a deterministic pyan3 crash, a missing interpreter -- won't
// change on retry. Only recognized transient signals (a resource-pressure
// errno, or the process being killed by a signal rather than exiting
// cleanly) opt in explicitly.
export function isTransientSubprocessFailure(error) {
  if (!error) return false;
  if (error.code === 'EAGAIN' || error.code === 'ENOMEM') return true;
  if (error.signal) return true;
  return false;
}

function categorizeFailure({ error, stderr }) {
  if (error && error.killed) {
    return new AdapterError('timeout', 'pyan3 subprocess timed out', { details: { stderr: truncate(stderr) }, retryable: true });
  }
  if (/SyntaxError/.test(stderr)) {
    return new AdapterError('parser_failure', 'pyan3 could not parse the given Python source (SyntaxError)', { details: { stderr: truncate(stderr) } });
  }
  return new AdapterError('subprocess_failure', `pyan3 exited with an error: ${error ? error.message : 'unknown'}`, {
    details: { stderr: truncate(stderr) },
    retryable: isTransientSubprocessFailure(error),
  });
}

function truncate(text, max = 4000) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…[truncated]' : text;
}

/**
 * Run pyan3 over one or more already-staged files within a request
 * workspace and return its raw DOT output. Throws AdapterError on any
 * failure, categorized per the shared ErrorCategory set
 * (src/graph-ir/adapterResult.js) so callers can build a consistent
 * AdapterResult regardless of which layer/analyzer failed.
 * @param {object} input
 * @param {string} input.pythonBin
 * @param {{dir: string}} input.workspace
 * @param {string[]} input.absolutePaths - files already staged via stagePythonFiles
 * @param {number} input.timeoutMs
 * @param {number} [input.maxBuffer]
 * @param {AbortSignal} [input.signal] - MOO-72 Commit 4: kills the subprocess if it fires
 * @returns {Promise<{dot: string, stderrDiagnostic: string, durationMs: number}>}
 */
export async function runPyan3({ pythonBin, workspace, absolutePaths, timeoutMs, maxBuffer = 20 * 1024 * 1024, signal }) {
  const args = [
    '-m', 'pyan',
    ...absolutePaths,
    '--dot', '--colored', '--grouped',
    '--root', workspace.dir,
  ];
  const startedAt = Date.now();
  const { error, stdout, stderr } = await runExecFile(pythonBin, args, { timeoutMs, maxBuffer, signal });
  const durationMs = Date.now() - startedAt;
  if (error) {
    throw categorizeFailure({ error, stderr });
  }
  return { dot: stdout, stderrDiagnostic: truncate(stderr), durationMs };
}
