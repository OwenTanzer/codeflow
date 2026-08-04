// Regression coverage for the production failure where an old deployment
// still rendered a server-token field and disabled Analyze until it was set.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const appSource = readFileSync(join(repoRoot, 'index.html'), 'utf8');

test('the application shell contains no app-auth credential UI or state', () => {
  const removedContracts = [
    'CodeFlow Server Token',
    'Enter the CodeFlow server token',
    'AppPasswordPrompt',
    'appPassword',
    "aria-label':'App Password'",
  ];

  for (const contract of removedContracts) {
    assert.equal(appSource.includes(contract), false, `removed auth contract returned to index.html: ${contract}`);
  }
});
