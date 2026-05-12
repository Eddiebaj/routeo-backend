// api/plan.js — OTP trip planning proxy for RouteO
const { checkRateLimit } = require('./_rateLimit');
const OTP_BASE = 'https://routeo-otp-production.up.railway.app';
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

const GENERIC_NAMES = new Set(['path', 'sidewalk', 'footway', 'steps', 'pedestrian', 'service', 'track', 'cycleway', 'residential']);

module.exports = async function handler(req, res) {
  if (await checkRateLimit(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { fromLat, fromLng, fromLabel, toLat, toLng, toLabel, time, date, arriveBy, mode, wheelchair, maxWalk, walkSpeed } = req.query;

  if (!fromLat || !fromLng || !toLat || !toLng) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  if (isNaN(parseFloat(fromLat)) || isNaN(parseFloat(fromLng)) || isNaN(parseFloat(toLat)) || isNaN(parseFloat(toLng))) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  let tripDate = date;
  if (!tripDate) {
    const now = new Date();
    const ottawaDate = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
    // ottawaDate is YYYY-MM-DD, reformat to MM-DD-YYYY for OTP
    const [y, m, d] = ottawaDate.split('-');
    tripDate = `${m}-${d}-${y}`;
  }
  const tripTime = time || (() => { const n = new Date(); return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`; })();

  // Map client mode to OTP mode string
  const MODE_MAP = { transit: 'TRANSIT,WALK', driving: 'CAR', bicycling: 'BICYCLE', walking: 'WALK' };
  const otpMode = MODE_MAP[mode] || MODE_MAP.transit;
  const isTransit = !mode || mode === 'transit';

  const otpUrl = `${OTP_BASE}/otp/routers/default/plan` +
    `?fromPlace=${fromLat},${fromLng}&toPlace=${toLat},${toLng}` +
    `&time=${encodeURIComponent(tripTime)}&date=${encodeURIComponent(tripDate)}` +
    `&mode=${otpMode}&numItineraries=${isTransit ? 8 : 3}` +
    (isTransit ? `&maxWalkDistance=${Math.min(Math.max(parseInt(maxWalk, 10) || 1000, 200), 5000)}` : '') +
    (isTransit || mode === 'walking' ? `&walkSpeed=${walkSpeed === 'slow' ? '1.0' : walkSpeed === 'fast' ? '1.8' : '1.4'}` : '') +
    `&arriveBy=${arriveBy === 'true' ? 'true' : 'false'}` +
    (wheelchair === 'true' ? '&wheelchair=true' : '');

  try {
    const otpResp = await fetch(otpUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!otpResp.ok) {
      return res.status(502).json({ error: 'OTP returned an error' });
    }
    const data = await otpResp.json();
    let rawItineraries = data?.plan?.itineraries || [];

    // Nearby departures fallback: if transit mode returns 0 or only walk-only results,
    // retry with ±15 min departure windows to find routes OTP missed
    let accessibilityWarning = false;
    if (isTransit && rawItineraries.length > 0) {
      const hasTransitLegs = rawItineraries.some(it => it.legs?.some(l => l.mode !== 'WALK'));
      if (!hasTransitLegs) {
        // Wheelchair fallback: if wheelchair=true produced walk-only results,
        // retry without wheelchair param to get standard transit routes
        if (wheelchair === 'true') {
          try {
            const noWheelchairUrl = otpUrl.replace('&wheelchair=true', '');
            const wcResp = await fetch(noWheelchairUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
            if (wcResp.ok) {
              const wcData = await wcResp.json();
              const wcItins = wcData?.plan?.itineraries || [];
              const wcTransit = wcItins.filter(it => it.legs?.some(l => l.mode !== 'WALK'));
              if (wcTransit.length > 0) {
                rawItineraries = [...wcTransit, ...rawItineraries];
                accessibilityWarning = true;
              }
            }
          } catch (e) { console.warn('Wheelchair fallback error:', e.message); }
        }

        // Time-offset fallback (try ±15 min)
        if (!accessibilityWarning) {
          const offsets = [15, -15];
          for (const offset of offsets) {
            try {
              const [h, m] = tripTime.split(':').map(Number);
              const adjMin = h * 60 + m + offset;
              const adjH = String(Math.floor(((adjMin % 1440) + 1440) % 1440 / 60)).padStart(2, '0');
              const adjM = String(((adjMin % 60) + 60) % 60).padStart(2, '0');
              const retryUrl = otpUrl.replace(`time=${encodeURIComponent(tripTime)}`, `time=${encodeURIComponent(`${adjH}:${adjM}`)}`);
              const retryResp = await fetch(retryUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
              if (retryResp.ok) {
                const retryData = await retryResp.json();
                const retryItins = retryData?.plan?.itineraries || [];
                const retryTransit = retryItins.filter(it => it.legs?.some(l => l.mode !== 'WALK'));
                if (retryTransit.length > 0) {
                  rawItineraries = [...retryTransit, ...rawItineraries];
                  break;
                }
              }
            } catch (e) { console.warn('Time-offset fallback error:', e.message); }
          }
        }
      }
    }

    const itineraries = await Promise.all(rawItineraries.map(async (itin, itinIdx) => {
      const legs = await Promise.all(itin.legs.map(async (leg) => {
        let steps = (leg.steps || []).map(step => ({
          distance: Math.round(step.distance),
          relativeDirection: step.relativeDirection,
          absoluteDirection: step.absoluteDirection || null,
          streetName: step.streetName,
        }));

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
          from: { name: leg.from.name, lat: leg.from.lat, lon: leg.from.lon, stopCode: leg.from.stopCode || null, stopId: leg.from.stopId || null },
          to: { name: leg.to.name, lat: leg.to.lat, lon: leg.to.lon, stopCode: leg.to.stopCode || null, stopId: leg.to.stopId || null },
          routeShortName: leg.routeShortName || null,
          routeLongName: leg.routeLongName || null,
          headsign: leg.headsign || null,
          agencyName: leg.agencyName || null,
          agencyId: leg.agencyId || null,
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
      ...(accessibilityWarning && { accessibilityWarning: true }),
    });

  } catch (err) {
    console.error('Plan fetch error:', err);
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'OTP request timed out' });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function enrichWalkSteps(from, to, otpSteps) {
  if (!GOOGLE_KEY) return otpSteps;
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&mode=walking&key=${GOOGLE_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) return otpSteps;
  const data = await resp.json();
  const gSteps = data?.routes?.[0]?.legs?.[0]?.steps;
  if (!gSteps?.length) return otpSteps;

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
      streetName: (isGeneric && g?.streetName) ? g.streetName : step.streetName,
      instruction: (isGeneric && g?.instruction) ? g.instruction : null,
    };
  });
}

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

