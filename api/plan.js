// api/plan.js — OTP trip planning proxy for RouteO
// Proxies requests to the Railway-hosted OpenTripPlanner instance

const OTP_BASE = process.env.OTP_URL || 'https://opentripplanner-production.up.railway.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const {
    fromLat, fromLng, fromLabel,
    toLat, toLng, toLabel,
    time, date, arriveBy,
  } = req.query;

  if (!fromLat || !fromLng || !toLat || !toLng) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  // Format date for OTP: MM-dd-yyyy
  const tripDate = date || formatDate(new Date());
  const tripTime = time || formatTime(new Date());

  const otpUrl = `${OTP_BASE}/otp/routers/default/plan` +
    `?fromPlace=${fromLat},${fromLng}` +
    `&toPlace=${toLat},${toLng}` +
    `&time=${encodeURIComponent(tripTime)}` +
    `&date=${encodeURIComponent(tripDate)}` +
    `&mode=TRANSIT,WALK` +
    `&numItineraries=5` +
    `&maxWalkDistance=1200` +
    `&walkSpeed=1.4` +
    `&arriveBy=${arriveBy === 'true' ? 'true' : 'false'}`;

  try {
    const otpResp = await fetch(otpUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!otpResp.ok) {
      const text = await otpResp.text();
      console.error('OTP error:', otpResp.status, text);
      return res.status(502).json({ error: 'OTP returned an error', detail: text });
    }

    const data = await otpResp.json();

    // Simplify the OTP response for the app
    const itineraries = (data?.plan?.itineraries || []).map(itin => ({
      duration: itin.duration, // seconds
      startTime: itin.startTime,
      endTime: itin.endTime,
      transfers: itin.transfers,
      walkDistance: Math.round(itin.walkDistance),
      legs: itin.legs.map(leg => ({
        mode: leg.mode, // WALK, BUS, TRAM, RAIL
        startTime: leg.startTime,
        endTime: leg.endTime,
        duration: leg.duration,
        distance: Math.round(leg.distance),
        from: { name: leg.from.name, lat: leg.from.lat, lon: leg.from.lon },
        to: { name: leg.to.name, lat: leg.to.lat, lon: leg.to.lon },
        routeShortName: leg.routeShortName || null,
        routeLongName: leg.routeLongName || null,
        headsign: leg.headsign || null,
        intermediateStops: (leg.intermediateStops || []).map(s => s.name),
        steps: (leg.steps || []).map(step => ({
          distance: Math.round(step.distance),
          relativeDirection: step.relativeDirection,
          streetName: step.streetName,
        })),
        legGeometry: leg.legGeometry ? { points: leg.legGeometry.points } : null,
      })),
    }));

    return res.status(200).json({
      itineraries,
      from: { label: fromLabel || `${fromLat},${fromLng}`, lat: fromLat, lng: fromLng },
      to: { label: toLabel || `${toLat},${toLng}`, lat: toLat, lng: toLng },
    });

  } catch (err) {
    console.error('Plan fetch error:', err);
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'OTP request timed out' });
    }
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}

function formatDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

function formatTime(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
