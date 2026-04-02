/**
 * RouteO — In-memory rate limiter for Vercel serverless functions
 * 60 requests per minute per IP, with periodic cleanup of expired entries.
 *
 * Usage (CJS):
 *   const { checkRateLimit } = require('./_rateLimit');
 *
 * Usage (ESM):
 *   import { checkRateLimit } from './_rateLimit.js';
 *
 * Inside handler:
 *   if (checkRateLimit(req, res)) return;
 */

const WINDOW_MS = 60 * 1000;       // 1 minute window
const MAX_REQUESTS = 60;            // requests per window
const CLEANUP_INTERVAL = 5 * 60 * 1000; // purge stale entries every 5 min

const hits = new Map(); // IP -> { count, resetTime }
let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [ip, entry] of hits) {
    if (now >= entry.resetTime) hits.delete(ip);
  }
}

/**
 * Check rate limit for the incoming request.
 * @returns {boolean} true if the request was rate-limited (response already sent)
 */
function checkRateLimit(req, res) {
  cleanup();

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown';

  const now = Date.now();
  let entry = hits.get(ip);

  if (!entry || now >= entry.resetTime) {
    entry = { count: 1, resetTime: now + WINDOW_MS };
    hits.set(ip, entry);
  } else {
    entry.count++;
  }

  const remaining = Math.max(0, MAX_REQUESTS - entry.count);
  const retryAfter = Math.ceil((entry.resetTime - now) / 1000);

  res.setHeader('X-RateLimit-Limit', String(MAX_REQUESTS));
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  if (entry.count > MAX_REQUESTS) {
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    return true;
  }

  return false;
}

module.exports = { checkRateLimit };
