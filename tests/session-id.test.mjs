// server/lib/session-id.js -- MOO-72 Commit 1B.
import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidSessionId } from '../server/lib/session-id.js';

test('isValidSessionId accepts a well-formed UUID, case-insensitively', () => {
  assert.equal(isValidSessionId('a1b2c3d4-e5f6-4789-a012-3456789abcde'), true);
  assert.equal(isValidSessionId('A1B2C3D4-E5F6-4789-A012-3456789ABCDE'), true);
});

test('isValidSessionId rejects non-UUID-shaped strings, null/undefined, and non-strings', () => {
  assert.equal(isValidSessionId('not-a-uuid'), false);
  assert.equal(isValidSessionId(''), false);
  assert.equal(isValidSessionId(null), false);
  assert.equal(isValidSessionId(undefined), false);
  assert.equal(isValidSessionId(12345), false);
  assert.equal(isValidSessionId('a1b2c3d4-e5f6-4789-a012-3456789abcd'), false); // one char short
});
