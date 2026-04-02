/**
 * RouteO — Push Notification Cron
 *
 * Vercel Cron hits this endpoint on schedule to send push notifications:
 *   - Garbage day reminders (7pm night before collection)
 *   - Game day alerts (noon if saved team plays tonight)
 *   - LRT disruption alerts (every 5 min, on new critical alerts)
 *
 * GET /api/cron-push?job=garbage    — garbage day reminders
 * GET /api/cron-push?job=gameday   — game day alerts
 * GET /api/cron-push?job=lrt       — LRT disruption push
 * GET /api/cron-push?job=departures — arrival alerts for saved stops
 */

const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Shared helpers ──────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'RouteO/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'RouteO/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed')); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Send Expo push notifications via the Expo Push API.
 * Chunks into batches of 100 (Expo limit).
 */
async function sendExpoPush(messages) {
  if (!messages.length) return { sent: 0 };
  const BATCH = 100;
  let totalSent = 0;

  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    const body = JSON.stringify(batch);

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'exp.host',
        path: '/--/api/v2/push/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    totalSent += batch.length;
  }

  return { sent: totalSent };
}

/**
 * Get all tokens subscribed to a given notification type.
 * Joins push_tokens with push_subscriptions.
 */
async function getSubscribedTokens(type) {
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('device_id')
    .eq('type', type)
    .eq('enabled', true);

  if (!subs || subs.length === 0) return [];

  const deviceIds = subs.map(s => s.device_id);
  const { data: tokens } = await supabase
    .from('push_tokens')
    .select('expo_token, language')
    .in('device_id', deviceIds);

  return tokens || [];
}


// ── Job: Garbage Day Reminder ───────────────────────────────────

async function handleGarbage() {
  // Get tokens subscribed to garbage day notifications
  const tokens = await getSubscribedTokens('garbageDay');
  if (!tokens.length) return { job: 'garbage', sent: 0, reason: 'no subscribers' };

  // Tomorrow's date in Ottawa timezone (ET)
  const now = new Date();
  const etOffset = now.toLocaleString('en-US', { timeZone: 'America/Toronto' });
  const etNow = new Date(etOffset);
  const tomorrow = new Date(etNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('en-CA'); // YYYY-MM-DD

  // Check if tomorrow is a collection day using Ottawa's ReCollect API
  // We need a place ID — use a known central Ottawa place for general reminders
  // Individual garbage schedules are stored per-device in the app
  // For push, we send a generic reminder to all subscribers — the app filters locally

  const messages = tokens.map(t => ({
    to: t.expo_token,
    sound: 'default',
    title: t.language === 'fr' ? 'Collecte demain' : 'Collection Tomorrow',
    body: t.language === 'fr'
      ? 'N\'oubliez pas de sortir vos bacs ce soir!'
      : 'Don\'t forget to put your bins out tonight!',
    data: { type: 'garbage', date: tomorrowStr },
  }));

  const result = await sendExpoPush(messages);
  return { job: 'garbage', ...result };
}


// ── Job: Game Day Alerts ────────────────────────────────────────

const OTTAWA_TEAMS = {
  sens: { nhlId: 'OTT', name: 'Ottawa Senators', name_fr: 'Senateurs d\'Ottawa' },
  redblacks: { name: 'Ottawa REDBLACKS', name_fr: 'REDBLACKS d\'Ottawa' },
  atletico: { name: 'Atletico Ottawa', name_fr: 'Atletico Ottawa' },
  blackjacks: { name: 'Ottawa BlackJacks', name_fr: 'BlackJacks d\'Ottawa' },
  charge: { name: 'Ottawa Charge', name_fr: 'Charge d\'Ottawa' },
};

async function handleGameDay() {
  const tokens = await getSubscribedTokens('sportsGameDay');
  if (!tokens.length) return { job: 'gameday', sent: 0, reason: 'no subscribers' };

  // Check NHL API for Sens game today
  const todayGames = [];

  try {
    const nhlData = await fetchJson('https://api-web.nhle.com/v1/schedule/now');
    const gameWeek = nhlData.gameWeek || [];
    const today = new Date().toLocaleDateString('en-CA');

    for (const day of gameWeek) {
      if (day.date === today) {
        for (const game of (day.games || [])) {
          const home = game.homeTeam?.abbrev;
          const away = game.awayTeam?.abbrev;
          if (home === 'OTT' || away === 'OTT') {
            const opponent = home === 'OTT' ? game.awayTeam : game.homeTeam;
            const isHome = home === 'OTT';
            const time = new Date(game.startTimeUTC).toLocaleTimeString('en-US', {
              hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto',
            });
            todayGames.push({
              team: 'sens',
              opponent: opponent?.placeName?.default || 'Opponent',
              isHome,
              time,
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('NHL API error:', e.message);
  }

  if (!todayGames.length) return { job: 'gameday', sent: 0, reason: 'no games today' };

  const messages = [];
  for (const game of todayGames) {
    const teamInfo = OTTAWA_TEAMS[game.team];
    for (const t of tokens) {
      const isFr = t.language === 'fr';
      const teamName = isFr ? teamInfo.name_fr : teamInfo.name;
      const homeAway = game.isHome
        ? (isFr ? 'a domicile' : 'at home')
        : (isFr ? 'a l\'exterieur' : 'away');

      messages.push({
        to: t.expo_token,
        sound: 'default',
        title: isFr ? `Jour de match! ${teamName}` : `Game Day! ${teamName}`,
        body: isFr
          ? `${teamName} vs ${game.opponent} ${homeAway} a ${game.time}`
          : `${teamName} vs ${game.opponent} ${homeAway} at ${game.time}`,
        data: { type: 'gameday', team: game.team },
      });
    }
  }

  const result = await sendExpoPush(messages);
  return { job: 'gameday', ...result };
}


// ── Job: LRT Disruption Alerts ──────────────────────────────────

// In-memory store for previously seen incidents (resets on cold start)
let previousIncidentDescs = new Set();

async function handleLrt() {
  const tokens = await getSubscribedTokens('lrtDisruption');
  if (!tokens.length) return { job: 'lrt', sent: 0, reason: 'no subscribers' };

  // Fetch current LRT status from our own alerts endpoint
  let lrtData;
  try {
    lrtData = await fetchJson('https://routeo-backend.vercel.app/api/alerts?action=lrt');
  } catch (e) {
    return { job: 'lrt', sent: 0, error: 'Failed to fetch LRT status' };
  }

  // Check for disrupted lines
  const disruptions = [];
  for (const [lineKey, lineLabel] of [['line1', 'Line 1'], ['line2', 'Line 2'], ['line4', 'Line 4']]) {
    const line = lrtData[lineKey];
    if (line && line.status === 'disrupted') {
      const badStations = line.stations.filter(s => !s.ok).map(s => s.name);
      disruptions.push({ line: lineLabel, stations: badStations });
    }
  }

  // Check for new incidents
  const incidents = lrtData.incidents || [];
  const newIncidents = incidents.filter(inc => {
    return inc.hoursAgo < 2 && !previousIncidentDescs.has(inc.description);
  });

  // Update seen incidents
  previousIncidentDescs = new Set(incidents.map(i => i.description));

  if (!newIncidents.length && !disruptions.length) {
    return { job: 'lrt', sent: 0, reason: 'no new disruptions' };
  }

  // Build notification
  const messages = [];
  for (const t of tokens) {
    const isFr = t.language === 'fr';

    if (newIncidents.length > 0) {
      const inc = newIncidents[0]; // Lead with most recent
      messages.push({
        to: t.expo_token,
        sound: 'default',
        title: isFr ? 'Alerte TLR' : 'LRT Alert',
        body: inc.description.slice(0, 200),
        data: { type: 'lrt', incidentCount: newIncidents.length },
      });
    } else if (disruptions.length > 0) {
      const d = disruptions[0];
      const stationList = d.stations.slice(0, 3).join(', ');
      messages.push({
        to: t.expo_token,
        sound: 'default',
        title: isFr ? `Perturbation ${d.line}` : `${d.line} Disruption`,
        body: isFr
          ? `Stations affectees: ${stationList}`
          : `Affected stations: ${stationList}`,
        data: { type: 'lrt', line: d.line },
      });
    }
  }

  const result = await sendExpoPush(messages);
  return { job: 'lrt', ...result, newIncidents: newIncidents.length, disruptions: disruptions.length };
}


// ── Job: Departure / Arrival Alerts ──────────────────────────

// Track recently notified arrivals to avoid duplicates (resets on cold start)
const recentlyNotified = new Map(); // key → timestamp

async function handleDepartures() {
  // Get all devices subscribed to arrivalAlerts
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('device_id, metadata')
    .eq('type', 'arrivalAlerts')
    .eq('enabled', true);

  if (!subs || subs.length === 0) return { job: 'departures', sent: 0, reason: 'no subscribers' };

  // Build device_id → stop_ids map
  const deviceStops = {};
  const allStopIds = new Set();
  for (const sub of subs) {
    const stopIds = sub.metadata?.stop_ids || [];
    if (stopIds.length === 0) continue;
    deviceStops[sub.device_id] = stopIds;
    stopIds.forEach(id => allStopIds.add(id));
  }

  if (allStopIds.size === 0) return { job: 'departures', sent: 0, reason: 'no stops configured' };

  // Get tokens for subscribed devices
  const deviceIds = Object.keys(deviceStops);
  const { data: tokens } = await supabase
    .from('push_tokens')
    .select('expo_token, device_id, language')
    .in('device_id', deviceIds);

  if (!tokens || tokens.length === 0) return { job: 'departures', sent: 0, reason: 'no tokens' };

  const tokenMap = {};
  for (const t of tokens) {
    tokenMap[t.device_id] = t;
  }

  // Fetch arrivals for each unique stop (deduplicated)
  const stopArrivals = {};
  const uniqueStops = [...allStopIds];

  // Process stops in parallel batches of 5
  for (let i = 0; i < uniqueStops.length; i += 5) {
    const batch = uniqueStops.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(async (stopId) => {
        const resp = await fetch(
          `https://routeo-backend.vercel.app/api/arrivals?stop=${stopId}`,
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        return { stopId, arrivals: data.arrivals || [], stopName: data.stopName || stopId };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        stopArrivals[r.value.stopId] = r.value;
      }
    }
  }

  // Build notifications
  const messages = [];
  const now = Date.now();

  // Prune old entries from dedup cache (older than 10 min)
  for (const [key, ts] of recentlyNotified) {
    if (now - ts > 600000) recentlyNotified.delete(key);
  }

  for (const deviceId of deviceIds) {
    const token = tokenMap[deviceId];
    if (!token) continue;
    const stops = deviceStops[deviceId] || [];
    const isFr = token.language === 'fr';

    for (const stopId of stops) {
      const stopData = stopArrivals[stopId];
      if (!stopData || !stopData.arrivals.length) continue;

      for (const arr of stopData.arrivals.slice(0, 3)) {
        if (arr.minsAway == null || arr.minsAway > 5 || arr.minsAway < 0) continue;

        // Dedup key: device + stop + route + 5-min window
        const window5 = Math.floor(now / 300000);
        const dedupKey = `${deviceId}-${stopId}-${arr.routeId}-${window5}`;
        if (recentlyNotified.has(dedupKey)) continue;
        recentlyNotified.set(dedupKey, now);

        const cleanStop = (stopData.stopName || '').replace(/\s*\(\d+\)$/, '');

        messages.push({
          to: token.expo_token,
          sound: 'default',
          title: isFr
            ? `Route ${arr.routeId} dans ~${arr.minsAway} min`
            : `Route ${arr.routeId} in ~${arr.minsAway} min`,
          body: isFr
            ? `${arr.headsign || ''} — ${cleanStop}`
            : `${arr.headsign || ''} — ${cleanStop}`,
          data: { type: 'arrival_alert', stopId, routeId: arr.routeId },
        });

        break; // One notification per stop per cycle
      }
    }
  }

  if (messages.length === 0) return { job: 'departures', sent: 0, reason: 'no imminent arrivals' };

  const result = await sendExpoPush(messages);
  return { job: 'departures', ...result, stopsChecked: uniqueStops.length };
}


// ── Handler ─────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Verify cron secret for scheduled invocations
  const auth = req.headers['authorization'];
  const isCron = auth === `Bearer ${process.env.CRON_SECRET}`;

  // Allow manual trigger without auth in dev, but require auth in prod
  if (!isCron && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const job = req.query.job || 'all';

  try {
    const results = {};

    if (job === 'garbage' || job === 'all') {
      results.garbage = await handleGarbage();
    }

    if (job === 'gameday' || job === 'all') {
      results.gameday = await handleGameDay();
    }

    if (job === 'lrt' || job === 'all') {
      results.lrt = await handleLrt();
    }

    if (job === 'departures' || job === 'all') {
      results.departures = await handleDepartures();
    }

    return res.json({ ok: true, results, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Cron-push error:', err);
    return res.status(500).json({ error: err.message });
  }
};
