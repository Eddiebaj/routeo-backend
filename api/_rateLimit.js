/**
 * RouteO — In-memory rate limiter for Vercel serverless functions
 * 60 requests per minute per IP. Resets on cold start — acceptable
 * since this is abuse prevention, not security.
 *
 * Usage (CJS):
 *   const { checkRateLimit } = require('./_rateLimit');
 *
 * Inside handler (must be async):
 *   if (await checkRateLimit(req, res)) return;
 */

const WINDOW_MS = 60 * 1000;       // 1 minute window
const MAX_REQUESTS = 60;            // requests per window

const hits = new Map();

/**
 * Check rate limit for the incoming request.
 * @returns {Promise<boolean>} true if the request was rate-limited (response already sent)
 */
async function checkRateLimit(req, res) {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown';

  const now = Date.now();
  const windowKey = `${ip}:${Math.floor(now / WINDOW_MS)}`;
  const count = (hits.get(windowKey) ?? 0) + 1;
  hits.set(windowKey, count);

  // Cleanup old keys periodically to prevent memory leak
  if (hits.size > 10000) {
    const cutoff = Math.floor(now / WINDOW_MS) - 1;
    for (const k of hits.keys()) {
      const ts = parseInt(k.split(':').pop(), 10);
      if (ts < cutoff) hits.delete(k);
    }
  }

  const remaining = Math.max(0, MAX_REQUESTS - count);
  res.setHeader('X-RateLimit-Limit', String(MAX_REQUESTS));
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  if (count > MAX_REQUESTS) {
    const windowEnd = (Math.floor(now / WINDOW_MS) + 1) * WINDOW_MS;
    const retryAfter = Math.ceil((windowEnd - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    return true;
  }

  return false;
}

module.exports = { checkRateLimit };
