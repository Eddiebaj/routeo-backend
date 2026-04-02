/**
 * RouteO — Supabase-based rate limiter for Vercel serverless functions
 * 60 requests per minute per IP, persisted in Supabase rate_limits table.
 *
 * Usage (CJS):
 *   const { checkRateLimit } = require('./_rateLimit');
 *
 * Inside handler (must be async):
 *   if (await checkRateLimit(req, res)) return;
 */

const { createClient } = require('@supabase/supabase-js');

const WINDOW_MS = 60 * 1000;       // 1 minute window
const MAX_REQUESTS = 60;            // requests per window

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * Check rate limit for the incoming request.
 * Uses Supabase rate_limits table. Fails open on DB errors.
 * @returns {Promise<boolean>} true if the request was rate-limited (response already sent)
 */
async function checkRateLimit(req, res) {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown';

  const now = new Date();
  const nowMs = now.getTime();

  try {
    // Read current entry
    const { data: entry, error: readErr } = await supabase
      .from('rate_limits')
      .select('count, reset_at')
      .eq('ip', ip)
      .single();

    if (readErr && readErr.code !== 'PGRST116') {
      // DB error (not "no rows") — fail open
      return false;
    }

    if (!entry || new Date(entry.reset_at).getTime() <= nowMs) {
      // No entry or window expired — reset count to 1
      const resetAt = new Date(nowMs + WINDOW_MS).toISOString();
      const { error: upsertErr } = await supabase
        .from('rate_limits')
        .upsert({ ip, count: 1, reset_at: resetAt }, { onConflict: 'ip' });

      if (upsertErr) {
        // Fail open
        return false;
      }

      res.setHeader('X-RateLimit-Limit', String(MAX_REQUESTS));
      res.setHeader('X-RateLimit-Remaining', String(MAX_REQUESTS - 1));
      return false;
    }

    // Window still active
    const newCount = entry.count + 1;
    const resetAtMs = new Date(entry.reset_at).getTime();

    if (newCount > MAX_REQUESTS) {
      // Rate limited
      const retryAfter = Math.ceil((resetAtMs - nowMs) / 1000);
      res.setHeader('X-RateLimit-Limit', String(MAX_REQUESTS));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      return true;
    }

    // Increment count
    const { error: updateErr } = await supabase
      .from('rate_limits')
      .update({ count: newCount })
      .eq('ip', ip);

    if (updateErr) {
      // Fail open
      return false;
    }

    const remaining = Math.max(0, MAX_REQUESTS - newCount);
    res.setHeader('X-RateLimit-Limit', String(MAX_REQUESTS));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    return false;
  } catch (err) {
    // Fail open on any unexpected error
    return false;
  }
}

module.exports = { checkRateLimit };
