/**
 * RouteO — Bus Route Detail
 * GET /api/route?id=95                — stops, directions, first/last bus
 * GET /api/route?id=95&stop=3017      — frequency at a specific stop
 */

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

function minsToTime(m) {
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Determine the current OC Transpo service_id pattern.
 * Weekday services typically contain schedule codes like 'JAN25-...-Weekday-01'.
 */
function getDayType() {
  const day = new Date().getDay();
  if (day === 0) return 'Sunday';
  if (day === 6) return 'Saturday';
  return 'Weekday';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600');

  const routeId = (req.query.id || '').trim();
  if (!routeId) return res.status(400).json({ error: 'Missing id param' });

  const stopId = (req.query.stop || '').trim();

  try {
    // If a specific stop is requested, return frequency at that stop
    if (stopId) {
      return await handleStopFrequency(res, routeId, stopId);
    }

    return await handleRouteDetail(res, routeId);
  } catch (err) {
    console.error('Route API error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Full route detail: all stops grouped by direction, first/last bus, avg frequency.
 */
async function handleRouteDetail(res, routeId) {
  const dayType = getDayType();

  // Get all stop_times for this route, ordered by trip + arrival
  const { data: stopTimes, error } = await supabase
    .from('stop_times')
    .select('stop_id, trip_id, arrival_time, headsign, service_id')
    .eq('route_id', routeId)
    .order('trip_id')
    .order('arrival_time')
    .limit(10000);

  if (error) throw new Error(error.message);
  if (!stopTimes || stopTimes.length === 0) {
    return res.json({ routeId, directions: [], frequency: null });
  }

  // Filter to current day type service IDs
  const dayFiltered = stopTimes.filter(st =>
    st.service_id && st.service_id.includes(dayType)
  );
  const rows = dayFiltered.length > 0 ? dayFiltered : stopTimes;

  // Group by headsign (direction)
  const byHeadsign = {};
  for (const st of rows) {
    const hs = st.headsign || 'Unknown';
    if (!byHeadsign[hs]) byHeadsign[hs] = { trips: {}, stops: new Map() };
    if (!byHeadsign[hs].trips[st.trip_id]) byHeadsign[hs].trips[st.trip_id] = [];
    byHeadsign[hs].trips[st.trip_id].push(st);
  }

  const directions = [];

  for (const [headsign, data] of Object.entries(byHeadsign)) {
    const tripIds = Object.keys(data.trips);

    // Extract ordered stop list from the first trip
    const sampleTrip = data.trips[tripIds[0]].sort((a, b) => timeToMins(a.arrival_time) - timeToMins(b.arrival_time));
    const stopList = sampleTrip.map(st => st.stop_id);

    // Compute first and last bus across all trips
    let firstBus = 9999;
    let lastBus = 0;
    const firstStopTimes = [];

    for (const tripId of tripIds) {
      const tripStops = data.trips[tripId];
      const sorted = tripStops.sort((a, b) => timeToMins(a.arrival_time) - timeToMins(b.arrival_time));
      if (sorted.length > 0) {
        const startMins = timeToMins(sorted[0].arrival_time);
        const endMins = timeToMins(sorted[sorted.length - 1].arrival_time);
        if (startMins < firstBus) firstBus = startMins;
        if (endMins > lastBus) lastBus = endMins;
        firstStopTimes.push(startMins);
      }
    }

    // Average frequency = average gap between consecutive trips at the first stop
    firstStopTimes.sort((a, b) => a - b);
    let avgFreqMin = null;
    if (firstStopTimes.length >= 2) {
      let totalGap = 0;
      for (let i = 1; i < firstStopTimes.length; i++) {
        totalGap += firstStopTimes[i] - firstStopTimes[i - 1];
      }
      avgFreqMin = Math.round(totalGap / (firstStopTimes.length - 1));
    }

    directions.push({
      headsign,
      tripCount: tripIds.length,
      stops: stopList,
      firstBus: minsToTime(firstBus),
      lastBus: minsToTime(lastBus),
      avgFrequencyMin: avgFreqMin,
    });
  }

  res.json({ routeId, directions });
}

/**
 * Frequency at a specific stop for a given route.
 * Returns average headway for the current time period (peak/off-peak).
 */
async function handleStopFrequency(res, routeId, stopId) {
  const dayType = getDayType();

  const { data, error } = await supabase
    .from('stop_times')
    .select('arrival_time, service_id')
    .eq('route_id', routeId)
    .eq('stop_id', stopId)
    .limit(500);

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    return res.json({ routeId, stopId, frequency: null });
  }

  // Filter to current day type
  const dayFiltered = data.filter(st => st.service_id && st.service_id.includes(dayType));
  const rows = dayFiltered.length > 0 ? dayFiltered : data;

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  // Get times within a 2-hour window around now
  const windowStart = nowMins - 60;
  const windowEnd = nowMins + 60;

  const times = rows
    .map(r => timeToMins(r.arrival_time))
    .filter(m => m >= windowStart && m <= windowEnd)
    .sort((a, b) => a - b);

  let frequencyMin = null;
  if (times.length >= 2) {
    let totalGap = 0;
    for (let i = 1; i < times.length; i++) {
      totalGap += times[i] - times[i - 1];
    }
    frequencyMin = Math.round(totalGap / (times.length - 1));
  }

  // Also get all-day frequency
  const allTimes = rows.map(r => timeToMins(r.arrival_time)).sort((a, b) => a - b);
  let allDayFreq = null;
  if (allTimes.length >= 2) {
    let totalGap = 0;
    for (let i = 1; i < allTimes.length; i++) {
      totalGap += allTimes[i] - allTimes[i - 1];
    }
    allDayFreq = Math.round(totalGap / (allTimes.length - 1));
  }

  res.json({
    routeId,
    stopId,
    frequency: {
      currentMin: frequencyMin,
      allDayMin: allDayFreq,
      tripsInWindow: times.length,
      totalTrips: allTimes.length,
    },
  });
}
