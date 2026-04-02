/**
 * RouteO — Shared fetch helpers
 * fetchUrl: HTTP/HTTPS fetch with redirect support, 2MB size limit, and timeout.
 * fetchJson: Same as fetchUrl but parses JSON.
 */

const https = require('https');
const http = require('http');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB

function fetchUrl(url, timeoutMs = 8000, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'RouteO/1.0' } }, (res) => {
      // Follow redirects (with depth limit)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        let nextUrl = res.headers.location;
        if (nextUrl.startsWith('/')) {
          const base = new URL(url);
          nextUrl = base.origin + nextUrl;
        }
        return fetchUrl(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve).catch(reject);
      }
      let data = '';
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) { req.destroy(); return reject(new Error('Response body too large')); }
        data += chunk;
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchJson(url, timeoutMs = 8000) {
  const data = await fetchUrl(url, timeoutMs);
  try {
    return JSON.parse(data);
  } catch (e) {
    throw new Error('JSON parse failed');
  }
}

module.exports = { fetchUrl, fetchJson };
