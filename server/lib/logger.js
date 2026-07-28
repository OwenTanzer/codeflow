// Structured logging with request IDs and sanitized output — MOO-67 Commit 5,
// extended in MOO-72 Commit 3 with level gating and value-level redaction.
import { randomUUID } from 'node:crypto';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const SENSITIVE_KEY_PATTERN = /token|authorization|secret|password|api[_-]?key|cookie/i;

// Defense in depth for secrets this process doesn't itself hold (e.g. a
// different token embedded in a proxied error message) -- the exact-string
// pass below (driven by `secrets`) is the primary guard for AUTH_TOKEN and
// GITHUB_TOKEN specifically.
const TOKEN_SHAPE_PATTERNS = [
  /\bgh[poursu]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+\S+/gi,
  /([?&](?:token|access_token|api[_-]?key|secret)=)[^&\s]+/gi,
];

let currentLevel = LEVELS.info;
let currentSecrets = [];

/**
 * Configure global logger behavior. Called once at startup from
 * server/index.js with the loaded config -- logger.js deliberately never
 * reads process.env itself, matching the DI style GraphCache/RateLimiter/
 * WorkspaceManager already use.
 * @param {{level?: string, secrets?: string[]}} [options]
 */
export function configureLogger({ level, secrets } = {}) {
  if (level != null) {
    if (!(level in LEVELS)) throw new Error(`Invalid log level: ${JSON.stringify(level)}`);
    currentLevel = LEVELS[level];
  }
  // Filter falsy/empty entries -- an unset token must never become a
  // zero-length "redact everything" pattern.
  currentSecrets = (secrets || []).filter((s) => typeof s === 'string' && s.length > 0);
}

function redactString(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const secret of currentSecrets) {
    out = out.split(secret).join('[redacted]');
  }
  for (const pattern of TOKEN_SHAPE_PATTERNS) {
    // Only the query-string pattern has a capturing group (the `?key=`
    // prefix to preserve); for the others, replace()'s second callback
    // argument is the match offset (a number), not a capture group --
    // treating it as one would silently splice that offset into the
    // redacted output (e.g. "23[redacted]" instead of "[redacted]").
    out = out.replace(pattern, (match, ...rest) => {
      const group1 = typeof rest[0] === 'string' ? rest[0] : null;
      return group1 ? group1 + '[redacted]' : '[redacted]';
    });
  }
  return out;
}

// Shallow by design: every call site in this codebase logs a flat meta
// object (confirmed across all three route handlers), so there is no
// nested-object case to handle.
function sanitize(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = redactString(value);
    }
  }
  return out;
}

/** One JSON object per line to stdout (or stderr for errors) — Railway-friendly. */
export function log(level, message, meta) {
  if (LEVELS[level] < currentLevel) return;
  // Reserved fields are spread last so per-call meta can never clobber them
  // -- previously `{ time, level, message, ...sanitize(meta) }` let any
  // meta.message (every `{ message: err.message }` call site in the
  // routes) silently overwrite the real event description.
  const entry = {
    ...sanitize(meta),
    time: new Date().toISOString(),
    level,
    message: redactString(message),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export function generateRequestId() {
  return randomUUID();
}

/**
 * A logger bound to one request ID (and optionally other default fields,
 * e.g. { layer: 'repository' }), so every log line from that request
 * carries them. Bound fields are reserved -- a per-call meta object cannot
 * override requestId/layer/etc., for the same reason message/time/level
 * can't be overridden above.
 */
export function createRequestLogger(requestId, defaultMeta = {}) {
  const bound = { ...defaultMeta, requestId };
  const call = (level) => (message, meta) => log(level, message, { ...meta, ...bound });
  return {
    debug: call('debug'),
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
  };
}
