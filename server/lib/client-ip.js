// Resolve the identity used by the public API rate limiter.
//
// Railway documents X-Real-IP as the client address it adds at the trusted
// edge. Never use X-Forwarded-For here: its left-most entry can be supplied
// by the caller, which would let an unauthenticated client rotate limiter
// keys and grow the in-memory window map without bound.
import { isIP } from 'node:net';

function validIp(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isIP(trimmed) ? trimmed : null;
}

/** @param {import('node:http').IncomingMessage|{headers?: object, socket?: object}} req */
export function clientKey(req) {
  const railwayClientIp = validIp(req.headers && req.headers['x-real-ip']);
  if (railwayClientIp) return railwayClientIp;

  // Local/direct connections do not pass through Railway, so use the
  // kernel-provided peer address rather than accepting another header.
  return validIp(req.socket && req.socket.remoteAddress) || 'unknown';
}
