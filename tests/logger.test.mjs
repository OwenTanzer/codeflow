// server/lib/logger.js -- MOO-72 Commit 3.
//
// Captures stdout/stderr writes directly rather than mocking log() itself,
// since the behavior under test (level gating, redaction, reserved-field
// protection) all lives inside what actually gets written to the stream.
import assert from 'node:assert/strict';
import test from 'node:test';

import { configureLogger, log, createRequestLogger } from '../server/lib/logger.js';

function captureWrites() {
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stdout.write = (chunk) => { lines.push(JSON.parse(chunk)); return true; };
  process.stderr.write = (chunk) => { lines.push(JSON.parse(chunk)); return true; };
  return {
    lines,
    restore() {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    },
  };
}

test.afterEach(() => {
  // Reset to defaults so one test's configureLogger() call can't leak into
  // the next -- module-level state, same reason GraphCache/Metrics are
  // constructed fresh per test rather than shared.
  configureLogger({ level: 'info', secrets: [] });
});

test('level gating: a warn-configured logger drops info but keeps warn/error', () => {
  configureLogger({ level: 'warn' });
  const capture = captureWrites();
  try {
    log('info', 'should be dropped');
    log('warn', 'should appear');
    log('error', 'should also appear');
  } finally {
    capture.restore();
  }
  assert.equal(capture.lines.length, 2);
  assert.equal(capture.lines[0].message, 'should appear');
  assert.equal(capture.lines[1].message, 'should also appear');
});

test('default level is info: debug is dropped, info is not', () => {
  const capture = captureWrites();
  try {
    log('debug', 'should be dropped');
    log('info', 'should appear');
  } finally {
    capture.restore();
  }
  assert.equal(capture.lines.length, 1);
  assert.equal(capture.lines[0].message, 'should appear');
});

test('exact-secret redaction: a configured secret embedded in a message or meta value is redacted', () => {
  configureLogger({ secrets: ['super-secret-token-123'] });
  const capture = captureWrites();
  try {
    log('info', 'request failed: super-secret-token-123 was rejected', {
      errorMessage: 'auth header contained super-secret-token-123',
    });
  } finally {
    capture.restore();
  }
  const entry = capture.lines[0];
  assert.ok(!entry.message.includes('super-secret-token-123'));
  assert.ok(!entry.errorMessage.includes('super-secret-token-123'));
  assert.match(entry.message, /\[redacted\]/);
  assert.match(entry.errorMessage, /\[redacted\]/);
});

test('empty/falsy secrets are filtered rather than matching everything', () => {
  configureLogger({ secrets: ['', null, undefined, 'real-secret'] });
  const capture = captureWrites();
  try {
    log('info', 'a perfectly ordinary message with no secrets in it');
  } finally {
    capture.restore();
  }
  // An empty-string "secret" would otherwise match (and mangle) every
  // message, since ''.split('') inserts '[redacted]' between every
  // character.
  assert.equal(capture.lines[0].message, 'a perfectly ordinary message with no secrets in it');
});

test('pattern-based redaction covers representative token shapes', () => {
  const capture = captureWrites();
  try {
    log('info', 'github fetch failed', { errorMessage: 'GET failed for token ghp_abcdefghijklmnopqrstuvwxyz012345' });
    log('info', 'auth header leaked', { errorMessage: 'sent header Authorization: Bearer abc123.def456.ghi789' });
    log('info', 'url leaked a token', { errorMessage: 'GET https://api.example.com/x?access_token=abcdef123456&other=1' });
  } finally {
    capture.restore();
  }
  for (const entry of capture.lines) {
    assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(entry.errorMessage), entry.errorMessage);
    assert.ok(!/abc123\.def456\.ghi789/.test(entry.errorMessage), entry.errorMessage);
    assert.ok(!/access_token=abcdef123456/.test(entry.errorMessage), entry.errorMessage);
  }
});

test('existing key-based redaction still works (regression)', () => {
  const capture = captureWrites();
  try {
    log('info', 'request accepted', { token: 'plain-value', authorization: 'Bearer xyz', ok: true });
  } finally {
    capture.restore();
  }
  const entry = capture.lines[0];
  assert.equal(entry.token, '[redacted]');
  assert.equal(entry.authorization, '[redacted]');
  assert.equal(entry.ok, true);
});

test('reserved fields cannot be overridden by per-call meta', () => {
  const capture = captureWrites();
  try {
    log('info', 'the real event description', { message: 'an attacker-controlled or accidental override' });
  } finally {
    capture.restore();
  }
  assert.equal(capture.lines[0].message, 'the real event description');
});

test('createRequestLogger binds requestId/layer, non-overridable by per-call meta', () => {
  const capture = captureWrites();
  try {
    const requestLog = createRequestLogger('req-123', { layer: 'repository' });
    requestLog.info('accepted', { layer: 'file', requestId: 'spoofed', owner: 'octocat' });
  } finally {
    capture.restore();
  }
  const entry = capture.lines[0];
  assert.equal(entry.requestId, 'req-123');
  assert.equal(entry.layer, 'repository');
  assert.equal(entry.owner, 'octocat');
});

test('createRequestLogger supports .debug()', () => {
  configureLogger({ level: 'debug' });
  const capture = captureWrites();
  try {
    const requestLog = createRequestLogger('req-1', { layer: 'file' });
    requestLog.debug('verbose detail');
  } finally {
    capture.restore();
  }
  assert.equal(capture.lines.length, 1);
  assert.equal(capture.lines[0].level, 'debug');
});

test('error level writes to stderr, info to stdout', () => {
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const stdoutLines = [];
  const stderrLines = [];
  process.stdout.write = (chunk) => { stdoutLines.push(chunk); return true; };
  process.stderr.write = (chunk) => { stderrLines.push(chunk); return true; };
  try {
    log('info', 'goes to stdout');
    log('error', 'goes to stderr');
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  assert.equal(stdoutLines.length, 1);
  assert.equal(stderrLines.length, 1);
});
