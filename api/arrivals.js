const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://bzvkadttywgszovbowch.supabase.co',
  'sb_publishable_UQXeqJ_OE-Zhl51qrHVF3w_UXOxKk2O'
);

function timeToMins(t) {
  if (!t) return 9999;
  const parts = t.split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

// Fallback cleanup for any headsigns that are still garbage
function cleanHeadsign(headsign, routeId) {
  if (!headsign || headsign.trim() === '') return `Route ${routeId}`;
  // Strip leading route number if duplicated e.g. "95 - Barrhaven Centre" → "Barrhaven Centre"
  const cleaned = headsign.replace(/^\d+\s*[-–]\s*/, '').trim();
  return cleaned || `Route ${routeId}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { stop } = req.query;
  if (!stop) return res.status(400).json({ error: 'stop param required' });

  try {
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const maxMins = currentMins + 120;

    // Fetch stop_times with trip_id so we can join headsign
    const { data, error } = await supabase
      .from('stop_times')
      .select('arrival_time, route_id, headsign, service_id, trip_id')
      .eq('stop_id', stop)
      .order('arrival_time', { ascending: true });

    if (error) throw new Error(error.message);

    // Collect unique trip_ids that are in the upcoming window
    const windowRows = (data || []).map(row => ({
      ...row,
      mins: timeToMins(row.arrival_time),
    })).filter(row => row.mins >= currentMins && row.mins <= maxMins);

    const tripIds = [...new Set(windowRows.map(r => r.trip_id).filter(Boolean))];

    // Fetch accurate headsigns from trips table
    let tripsMap = {};
    if (tripIds.length > 0) {
      const { data: tripData, error: tripError } = await supabase
        .from('trips')
        .select('trip_id, headsign, route_id')
        .in('trip_id', tripIds);

      if (!tripError && tripData) {
        for (const t of tripData) {
          tripsMap[t.trip_id] = t;
        }
      }
    }

    // Deduplicate and build response
    const seen = new Set();
    const upcoming = windowRows
      .filter(row => {
        const key = `${row.route_id}-${row.arrival_time}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8)
      .map(row => {
        const trip = tripsMap[row.trip_id] || {};
        // Prefer trips table headsign, fall back to stop_times headsign
        const rawHeadsign = trip.headsign || row.headsign || '';
        return {
          stopId: stop,
          routeId: row.route_id,
          tripId: row.trip_id,
          headsign: cleanHeadsign(rawHeadsign, row.route_id),
          scheduledTime: row.arrival_time,
          minsAway: row.mins - currentMins,
        };
      });

    res.json({ stop, arrivals: upcoming, source: 'gtfs-static' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
