// Regression coverage for MOO-114. The React application is compiled from a
// classic Babel script, while its dependencies are imported by the preceding
// ES-module script. Every dependency used by the Babel application therefore
// has to be exposed explicitly through the module-to-window bridge.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const appSource = readFileSync(join(repoRoot, 'index.html'), 'utf8');

function moduleBridgeBody(source) {
  const start = source.indexOf('Object.assign(window, analyzer, {');
  assert.notEqual(start, -1, 'module-to-window bridge is missing');
  const end = source.indexOf('});', start);
  assert.notEqual(end, -1, 'module-to-window bridge is unterminated');
  return source.slice(start, end);
}

test('drill-down capability client is available to the Babel application', () => {
  assert.match(
    appSource,
    /import\s*\{\s*fetchCapabilities\s*\}\s*from\s*['"]\.\/src\/state\/capabilitiesClient\.js['"]/,
    'fetchCapabilities must remain an ES-module import',
  );
  assert.match(
    moduleBridgeBody(appSource),
    /(?:^|[,\s])fetchCapabilities(?:[,\s]|$)/,
    'fetchCapabilities must be exposed through the module-to-window bridge',
  );

  const calls = appSource.match(/fetchCapabilities\s*\(\s*\)/g) ?? [];
  assert.equal(calls.length, 2, 'both file and function drill-down must check capabilities');
});

test('fatal application errors are not unconditionally described as memory failures', () => {
  assert.equal(
    appSource.includes("The codebase may be too large for your browser's available memory."),
    false,
  );
  assert.match(appSource, /An unexpected error prevented CodeFlow from continuing\./);
});
