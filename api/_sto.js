/**
 * RouteO — Shared STO auth helper
 * Builds authenticated STO GTFS API URLs using SHA256(private_key + UTC timestamp).
 */

const crypto = require('crypto');

const STO_PUBLIC_KEY = process.env.STO_API_KEY;
const STO_PRIVATE_KEY = process.env.STO_PRIVATE_KEY;

function buildStoUrl(fileType) {
  if (!STO_PUBLIC_KEY || !STO_PRIVATE_KEY) return null;
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const dateIso = `${y}${mo}${d}T${h}${mi}Z`;
  const salted = STO_PRIVATE_KEY + dateIso;
  const hash = crypto.createHash('sha256').update(salted, 'utf8').digest('hex').toUpperCase();
  return `https://gtfs.sto.ca/download.php?hash=${hash}&file=${fileType}&key=${STO_PUBLIC_KEY}`;
}

module.exports = { buildStoUrl };
