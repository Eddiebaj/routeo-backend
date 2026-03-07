const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://bzvkadttywgszovbowch.supabase.co',
  'sb_publishable_UQXeqJ_OE-Zhl51qrHVF3w_UXOxKk2O'
);

function timeToMins(t) {
  if (!t) return 9999;
  const parts = t.split(':').map(Number);
  return parts[0] * 60 + (parts[1] || 0);
}

function cleanHeadsign(headsign, routeId) {
  if (!headsign || headsign.trim() === '') return `Route ${routeId}`;
  const cleaned = headsign.replace(/^\d+\s*[-–]\s*/, '').trim();
  return cleaned || `Route ${routeId}`;
}

// OC Transpo uses e.g. "JAN26-FRIRED-Weekday-10", "JAN26-CFDSAT-Saturday-01", "JAN26-xSUN-Sunday-01"
function getTodayServiceKeyword() {
  const day = new Date().getDay(); // 0=Sun, 6=Sat
  if (day === 0) return 'sunday';
  if (day === 6) return 'saturday';
  return 'weekday';
}

function serviceMatchesToday(serviceId) {
  if (!serviceId) return true;
  return serviceId.toLowerCase().includes(getTodayServiceKeyword());
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { stop } = req.query;
  if (!stop) return res.status(400).json({ error: 'stop param required' });

  try {
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const maxMins = currentMins + 90;

    const { data, error } = await supabase
      .from('stop_times')
      .select('arrival_time, route_id, headsign, service_id, trip_id')
      .eq('stop_id', stop)
      .order('arrival_time', { ascending: true });

    if (error) throw new Error(error.message);

    const allRows = (data || []).map(row => ({ ...row, mins: timeToMins(row.arrival_time) }));
    const inWindow = allRows.filter(row => row.mins >= currentMins && row.mins <= maxMins);

    // Filter by today's service keyword, fall back to unfiltered if empty
    let finalRows = inWindow.filter(row => serviceMatchesToday(row.service_id));
    if (finalRows.length === 0) finalRows = inWindow;

    // Headsign lookup from trips table
    const tripIds = [...new Set(finalRows.map(r => r.trip_id).filter(Boolean))];
    let tripsMap = {};
    if (tripIds.length > 0) {
      const { data: tripData } = await supabase
        .from('trips')
        .select('trip_id, headsign, route_id')
        .in('trip_id', tripIds);
      if (tripData) for (const t of tripData) tripsMap[t.trip_id] = t;
    }

    const seen = new Set();
    const upcoming = finalRows
      .filter(row => {
        const key = `${row.route_id}-${row.arrival_time}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8)
      .map(row => {
        const trip = tripsMap[row.trip_id] || {};
        return {
          stopId: stop,
          routeId: row.route_id,
          tripId: row.trip_id,
          headsign: cleanHeadsign(trip.headsign || row.headsign || '', row.route_id),
          scheduledTime: row.arrival_time,
          minsAway: row.mins - currentMins,
        };
      });

    res.json({ stop, arrivals: upcoming, source: 'gtfs-static' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
