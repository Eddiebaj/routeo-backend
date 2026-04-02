/**
 * RouteO — Shared GTFS helpers
 */

/**
 * Convert a GTFS time string (HH:MM or HH:MM:SS) to minutes since midnight.
 * Returns 9999 for invalid/missing input.
 */
function timeToMins(t) {
  if (!t) return 9999;
  const parts = t.split(':').map(Number);
  return parts[0] * 60 + (parts[1] || 0);
}

module.exports = { timeToMins };
