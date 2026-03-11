// api/plan.js — OTP trip planning proxy for RouteO
// Enriches WALK leg steps with Google Directions street names

const OTP_BASE = process.env.OTP_URL || 'https://routeo-otp-production.up.railway.app';
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

const GENERIC_NAMES = new Set(['path', 'sidewalk', 'footway', 'steps', 'pedestrian', 'service', 'track', 'cycleway', 'residential']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { fromLat, fromLng, fromLabel, toLat, toLng, toLabel, time, date, arriveBy } = req.query;

  if (!fromLat || !fromLng || !toLat || !toLng) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const tripDate = date || formatDate(new Date());
  const tripTime = time || formatTime(new Date());

  const otpUrl = `${OTP_BASE}/otp/routers/default/plan` +
    `?fromPlace=${fromLat},${fromLng}&toPlace=${toLat},${toLng}` +
    `&time=${encodeURIComponent(tripTime)}&date=${encodeURIComponent(tripDate)}` +
    `&mode=TRANSIT,WALK&numItineraries=5&maxWalkDistance=1200&walkSpeed=1.4` +
    `&arriveBy=${arriveBy === 'true' ? 'true' : 'false'}`;

  try {
    const otpResp = await fetch(otpUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!otpResp.ok) {
      const text = await otpResp.text();
      return res.status(502).json({ error: 'OTP returned an error', detail: text });
    }
    const data = await otpResp.json();
    const rawItineraries = data?.plan?.itineraries || [];

    const itineraries = await Promise.all(rawItineraries.map(async (itin, itinIdx) => {
      const legs = await Promise.all(itin.legs.map(async (leg) => {
        let steps = (leg.steps || []).map(step => ({
          distance: Math.round(step.distance),
          relativeDirection: step.relativeDirection,
          absoluteDirection: step.absoluteDirection || null,
          streetName: step.streetName,
        }));

        // Only enrich the best itinerary's walk legs to avoid excess API calls
        if (itinIdx === 0 && leg.mode === 'WALK' && steps.length > 0) {
          const hasGeneric = steps.some(s => !s.streetName || GENERIC_NAMES.has(s.streetName?.toLowerCase()));
          if (hasGeneric) {
            try {
              steps = await enrichWalkSteps({ lat: leg.from.lat, lng: leg.from.lon }, { lat: leg.to.lat, lng: leg.to.lon }, steps);
            } catch (e) {
              console.warn('Google enrichment failed:', e.message);
            }
          }
        }

        return {
          mode: leg.mode,
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
          steps,
          legGeometry: leg.legGeometry ? { points: leg.legGeometry.points } : null,
        };
      }));

      return { duration: itin.duration, startTime: itin.startTime, endTime: itin.endTime, transfers: itin.transfers, walkDistance: Math.round(itin.walkDistance), legs };
    }));

    return res.status(200).json({
      itineraries,
      from: { label: fromLabel || `${fromLat},${fromLng}`, lat: fromLat, lng: fromLng },
      to: { label: toLabel || `${toLat},${toLng}`, lat: toLat, lng: toLng },
    });

  } catch (err) {
    console.error('Plan fetch error:', err);
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'OTP request timed out' });
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}

async function enrichWalkSteps(from, to, otpSteps) {
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&mode=walking&key=${GOOGLE_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const data = await resp.json();
  const gSteps = data?.routes?.[0]?.legs?.[0]?.steps;
  if (!gSteps?.length) return otpSteps;

  // Build Google steps with both full instruction and street name
  const gStepData = gSteps.map(s => ({
    instruction: cleanInstruction(s.html_instructions),
    streetName: extractStreetName(s.html_instructions),
    distance: s.distance?.value || 0,
  }));

  let gIdx = 0, gCum = 0, otpCum = 0;
  return otpSteps.map((step) => {
    otpCum += step.distance;
    while (gIdx < gStepData.length - 1 && gCum + gStepData[gIdx].distance / 2 < otpCum) {
      gCum += gStepData[gIdx].distance;
      gIdx++;
    }
    const g = gStepData[gIdx];
    const isGeneric = !step.streetName || GENERIC_NAMES.has(step.streetName?.toLowerCase());
    return {
      ...step,
      // Use Google street name if OTP has a generic one
      streetName: (isGeneric && g?.streetName) ? g.streetName : step.streetName,
      // Always store the full Google instruction for unnamed segments
      instruction: (isGeneric && g?.instruction) ? g.instruction : null,
    };
  });
}

// Returns plain text instruction (e.g. "Turn left toward Queen Street")
function cleanInstruction(html) {
  if (!html) return null;
  return html.replace(/<b>/g, '').replace(/<\/b>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractStreetName(html) {
  if (!html) return null;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const patterns = [
    /\bonto\s+(.+?)(?:\s+toward|\s+Destination|$)/i,
    /\bon\s+(.+?)(?:\s+toward|\s+Destination|$)/i,
    /^Head\s+\w+\s+on\s+(.+?)(?:\s+toward|$)/i,
    /^Turn\s+\w+\s+onto\s+(.+?)(?:\s+toward|$)/i,
    /^(.+?)(?:\s+toward|\s+Destination|$)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1] && m[1].length < 60) return m[1].trim();
  }
  return null;
}

function formatDate(d) {
  return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}-${d.getFullYear()}`;
}
function formatTime(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
