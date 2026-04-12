const { checkRateLimit } = require('./_rateLimit');

/**
 * RouteO — Community & Push Notifications (multi-action endpoint)
 *
 * Push:
 *   POST /api/community?action=push.register    — Register Expo push token
 *   POST /api/community?action=push.subscribe   — Sync notification subscriptions
 *   GET  /api/community?action=push.check&device_id=X — Check registration status
 *
 * Reports:
 *   POST /api/community?action=report           — Submit a stop issue report
 *   GET  /api/community?action=reports&stop_id=X — Get reports for a stop
 *
 * Parking:
 *   GET  /api/community?action=parking           — Ottawa garage occupancy
 *
 * Transit scores:
 *   GET  /api/community?action=transit_score&neighbourhood=byward
 *   GET  /api/community?action=transit_scores    — All neighbourhood scores
 *
 * Deal votes:
 *   POST /api/community?action=deal.submit        — Submit deal with optional photo + Claude moderation
 *   POST /api/community?action=deal.vote          — Vote on a community deal
 *   GET  /api/community?action=deal.votes&neighbourhood_id=X — Get votes for deals
 *   POST /api/community?action=deal.notify        — Log new deal submission (admin notification)
 *
 * Crowding:
 *   POST /api/community?action=crowding.report   — Submit a crowding report
 *   GET  /api/community?action=crowding.predict&route_id=X&stop_id=Y — Get prediction
 *
 * Ghost bus:
 *   POST /api/community?action=ghost.report       — Submit ghost bus / confirmed arrival
 *   GET  /api/community?action=ghost.stats&stop_id=X — Aggregated ghost reports (last 60min)
 *   GET  /api/community?action=ghost.device_stats&device_id=X — Weekly stats for device
 *
 * Business membership (B2B partner deals):
 *   POST /api/community?action=business.register  — Create/upsert business_member by email
 *   POST /api/community?action=business.onboard   — Update details + Claude moderation → is_active
 *   GET  /api/community?action=business.deals[&lat=X&lng=Y&radius=N] — Active partner deals
 *   POST /api/community?action=stripe.webhook     — Stripe subscription lifecycle (activate/deactivate)
 *
 * Health:
 *   GET  /api/community?action=health              — Health check (no auth required)
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Claude deal moderation ──────────────────────────────────────────
async function moderateDealWithClaude(venueName, description, photoBase64) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { approved: false, confidence: 0, reason: 'Moderation unavailable', flags: ['no_api_key'] };

  const client = new Anthropic({ apiKey });
  const content = [];

  if (photoBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: photoBase64 },
    });
  }

  content.push({
    type: 'text',
    text: `You are a content moderator for RouteO, an Ottawa transit & community app. Review this community deal submission and respond ONLY with valid JSON (no markdown).

Venue: ${venueName}
Deal: ${description}
${photoBase64 ? 'A photo is attached.' : 'No photo attached.'}

Check for:
1. Is this a plausible deal at a real Ottawa business?
2. Does the photo (if any) match the venue/deal described?
3. Any inappropriate, offensive, or spam content?
4. Any personal information, phone numbers, or suspicious URLs?

Respond with JSON:
{
  "approved": true/false,
  "confidence": 0-100,
  "reason": "brief explanation",
  "flags": ["flag1", "flag2"],
  "category": "food_drink" | "retail" | "service" | "entertainment" | "other"
}`,
  });

  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content }],
    });
    const text = resp.content[0]?.text || '';
    return JSON.parse(text);
  } catch (e) {
    console.error('Claude moderation error:', e);
    return { approved: false, confidence: 0, reason: 'Moderation error', flags: ['api_error'] };
  }
}

function isValidDeviceId(id) {
  return typeof id === 'string' && id.length >= 5 && id.length <= 200;
}

const sanitize = (s) => String(s).replace(/[<>]/g, '');

const deviceCooldowns = new Map();
const COOLDOWN_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const COOLDOWN_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
let lastCooldownCleanup = Date.now();

function checkDeviceCooldown(deviceId, action, cooldownMs = 5000) {
  const now = Date.now();
  // Periodic cleanup: remove entries older than 24 hours, at most once per 5 min
  if (now - lastCooldownCleanup >= COOLDOWN_CLEANUP_INTERVAL) {
    lastCooldownCleanup = now;
    for (const [k, ts] of deviceCooldowns) {
      if (now - ts > COOLDOWN_MAX_AGE) deviceCooldowns.delete(k);
    }
  }
  const key = `${deviceId}:${action}`;
  const last = deviceCooldowns.get(key);
  if (last && now - last < cooldownMs) return true;
  deviceCooldowns.set(key, now);
  return false;
}

module.exports = async (req, res) => {
  if (await checkRateLimit(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || '';
  if (!action) return res.status(400).json({ error: 'Missing action param' });

  try {
    switch (action) {

      // ── Push: Register token ────────────────────────────────────
      case 'push.register': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const { expo_token, device_id, platform, language } = req.body || {};
        if (!isValidDeviceId(device_id)) {
          return res.status(400).json({ error: 'Valid device_id required' });
        }
        if (!expo_token) {
          return res.status(400).json({ error: 'Missing expo_token' });
        }

        const { error } = await supabase
          .from('push_tokens')
          .upsert({
            expo_token,
            device_id,
            platform: platform || 'ios',
            language: language || 'en',
            updated_at: new Date().toISOString(),
          }, { onConflict: 'device_id' });

        if (error) throw error;
        return res.json({ ok: true });
      }

      // ── Push: Sync subscriptions ────────────────────────────────
      case 'push.subscribe': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const { device_id, subscriptions } = req.body || {};
        if (!isValidDeviceId(device_id)) {
          return res.status(400).json({ error: 'Valid device_id required' });
        }
        if (!Array.isArray(subscriptions) || subscriptions.length > 50) {
          return res.status(400).json({ error: 'Invalid subscriptions' });
        }

        // Bulk upsert all subscriptions in a single call
        const allRows = subscriptions.map(sub => ({
          device_id,
          type: sub.type,
          enabled: sub.enabled,
          metadata: sub.metadata || {},
        }));
        const { error } = await supabase
          .from('push_subscriptions')
          .upsert(allRows, { onConflict: 'device_id,type' });
        if (error) throw error;

        return res.json({ ok: true, count: subscriptions.length });
      }

      // ── Push: Check registration ────────────────────────────────
      case 'push.check': {
        const device_id = req.query.device_id;
        if (!isValidDeviceId(device_id)) return res.status(400).json({ error: 'Valid device_id required' });

        const { data: token } = await supabase
          .from('push_tokens')
          .select('updated_at')
          .eq('device_id', device_id)
          .single();

        const { data: subs } = await supabase
          .from('push_subscriptions')
          .select('type, enabled, metadata')
          .eq('device_id', device_id);

        return res.json({
          registered: !!token,
          subscriptions: subs || [],
        });
      }

      // ── Report: Submit stop issue ───────────────────────────────
      case 'report': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const { stop_id, category, description, device_id } = req.body || {};
        if (!isValidDeviceId(device_id)) {
          return res.status(400).json({ error: 'Valid device_id required' });
        }
        if (checkDeviceCooldown(device_id, 'report')) {
          return res.status(429).json({ error: 'Too many requests, please wait' });
        }
        if (!stop_id || !category) {
          return res.status(400).json({ error: 'Missing stop_id or category' });
        }
        if (description && description.length > 500) {
          return res.status(400).json({ error: 'Description too long (max 500 chars)' });
        }

        const validCategories = ['bench_broken', 'shelter_missing', 'accessibility', 'cleanliness', 'schedule_missing', 'other'];
        if (!validCategories.includes(category)) {
          return res.status(400).json({ error: `Invalid category. Must be one of: ${validCategories.join(', ')}` });
        }

        const { error } = await supabase
          .from('stop_reports')
          .insert({ stop_id, category, description: sanitize(description || ''), device_id });

        if (error) throw error;
        return res.json({ ok: true });
      }

      // ── Report: Get reports for a stop ──────────────────────────
      case 'reports': {
        const stop_id = req.query.stop_id;
        if (!stop_id) return res.status(400).json({ error: 'Missing stop_id' });

        const { data, error } = await supabase
          .from('stop_reports')
          .select('id, category, description, status, created_at')
          .eq('stop_id', stop_id)
          .order('created_at', { ascending: false })
          .limit(20);

        if (error) throw error;
        return res.json({ reports: data || [], count: (data || []).length });
      }

      // ── Parking: Ottawa garage occupancy ────────────────────────
      case 'parking': {
        // Ottawa ParkSmart / City parking API
        // Returns real-time garage occupancy for municipal garages
        const parkingUrl = 'https://open.ottawa.ca/api/explore/v2.1/catalog/datasets/parking-garage-availability/records?limit=20';
        const resp = await fetch(parkingUrl, {
          headers: { 'User-Agent': 'RouteO/1.0' },
          signal: AbortSignal.timeout(8000),
        });

        if (!resp.ok) {
          // Fallback: return static list of known garages with no live data
          return res.json({
            garages: [],
            source: 'unavailable',
            note: 'Ottawa parking data temporarily unavailable',
          });
        }

        const data = await resp.json();
        const garages = (data.results || []).map(r => ({
          name: r.garage_name || r.name || 'Garage',
          address: r.address || '',
          total: r.total_capacity || r.capacity || 0,
          available: r.available_spaces || r.available || 0,
          occupancy: r.occupancy_pct || (r.total_capacity
            ? Math.round(((r.total_capacity - (r.available_spaces || 0)) / r.total_capacity) * 100)
            : null),
          lat: r.geo_point_2d?.lat || r.latitude || null,
          lng: r.geo_point_2d?.lon || r.longitude || null,
        }));

        return res.json({ garages, source: 'ottawa_open_data' });
      }

      // ── Transit score: Single neighbourhood ─────────────────────
      case 'transit_score': {
        const hood = req.query.neighbourhood;
        if (!hood) return res.status(400).json({ error: 'Missing neighbourhood param' });

        const { data, error } = await supabase
          .from('neighbourhood_scores')
          .select('*')
          .eq('neighbourhood_id', hood)
          .single();

        if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
        return res.json({ score: data || null });
      }

      // ── Transit scores: All neighbourhoods ──────────────────────
      case 'transit_scores': {
        const { data, error } = await supabase
          .from('neighbourhood_scores')
          .select('*')
          .order('transit_score', { ascending: false });

        if (error) throw error;
        return res.json({ scores: data || [] });
      }

      // ── Deal: Vote on a community deal ─────────────────────────
      case 'deal.vote': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const { deal_id, device_id, vote_type } = req.body || {};
        if (!isValidDeviceId(device_id)) {
          return res.status(400).json({ error: 'Valid device_id required' });
        }
        if (checkDeviceCooldown(device_id, 'deal.vote')) {
          return res.status(429).json({ error: 'Too many requests, please wait' });
        }
        if (!deal_id || !['up', 'down'].includes(vote_type)) {
          return res.status(400).json({ error: 'Missing deal_id or invalid vote_type (up|down)' });
        }

        const { error } = await supabase
          .from('community_deal_votes')
          .upsert({
            deal_id,
            device_id,
            vote_type,
            created_at: new Date().toISOString(),
          }, { onConflict: 'deal_id,device_id' });

        if (error) throw error;
        return res.json({ ok: true });
      }

      // ── Deal: Get votes for all deals in a neighbourhood ──────
      case 'deal.votes': {
        const neighbourhood_id = req.query.neighbourhood_id;
        if (!neighbourhood_id) return res.status(400).json({ error: 'Missing neighbourhood_id' });

        // Get all deal IDs for this neighbourhood
        const { data: deals, error: dealsErr } = await supabase
          .from('community_deals')
          .select('id')
          .eq('neighbourhood_id', neighbourhood_id)
          .eq('approved', true);

        if (dealsErr) throw dealsErr;

        const dealIds = (deals || []).map(d => d.id);
        if (dealIds.length === 0) return res.json({ votes: {} });

        const { data: votes, error: votesErr } = await supabase
          .from('community_deal_votes')
          .select('deal_id, vote_type')
          .in('deal_id', dealIds);

        if (votesErr) throw votesErr;

        // Aggregate votes by deal_id
        const result = {};
        for (const v of (votes || [])) {
          if (!result[v.deal_id]) result[v.deal_id] = { up: 0, down: 0 };
          if (v.vote_type === 'up') result[v.deal_id].up++;
          else if (v.vote_type === 'down') result[v.deal_id].down++;
        }

        return res.json({ votes: result });
      }

      // ── Crowding: Submit a report ────────────────────────────────
      case 'crowding.report': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const { route_id, stop_id, direction_id, vehicle_id, crowding_level, device_id: crDeviceId } = req.body || {};
        if (!crDeviceId || !isValidDeviceId(crDeviceId)) {
          return res.status(400).json({ error: 'device_id required' });
        }
        if (checkDeviceCooldown(crDeviceId, 'crowding.report')) {
          return res.status(429).json({ error: 'Too many requests, please wait' });
        }
        if (!route_id || !stop_id || crowding_level == null) {
          return res.status(400).json({ error: 'route_id, stop_id, and crowding_level are required' });
        }
        const level = parseInt(crowding_level, 10);
        if (isNaN(level) || level < 1 || level > 5) {
          return res.status(400).json({ error: 'crowding_level must be 1-5' });
        }

        const ottawaNow = new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false });
        const crParts = ottawaNow.split(':').map(Number);
        const crH = crParts.length > 0 && !isNaN(crParts[0]) ? crParts[0] : new Date().getUTCHours();
        const ottawaDay = new Date(new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' })).getDay();
        const { error } = await supabase.from('bus_crowding_reports').insert({
          route_id,
          stop_id,
          direction_id: direction_id || null,
          vehicle_id: vehicle_id || null,
          crowding_level: level,
          hour_of_day: crH,
          day_of_week: ottawaDay,
        });

        if (error) return res.status(500).json({ error: 'Internal server error' });
        return res.json({ success: true });
      }

      // ── Crowding: Get prediction ──────────────────────────────────
      case 'crowding.predict': {
        const { route_id, stop_id } = req.query;
        if (!route_id || !stop_id) {
          return res.status(400).json({ error: 'route_id and stop_id are required' });
        }

        const predNow = new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false });
        const [hour] = predNow.split(':').map(Number);
        const dow = new Date(new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' })).getDay();
        const hours = [(hour - 1 + 24) % 24, hour, (hour + 1) % 24];

        const { data, error } = await supabase
          .from('crowding_averages')
          .select('*')
          .eq('route_id', route_id)
          .eq('stop_id', stop_id)
          .eq('day_of_week', dow)
          .in('hour_of_day', hours);

        if (error) return res.status(500).json({ error: 'Internal server error' });

        if (!data || data.length === 0) {
          return res.json({ avg_crowding: null, report_count: 0, confidence: 'none' });
        }

        const exact = data.find(d => d.hour_of_day === hour);
        const totalReports = data.reduce((s, d) => s + Number(d.report_count), 0);
        const avgCrowding = exact
          ? Number(exact.avg_crowding)
          : data.reduce((s, d) => s + Number(d.avg_crowding) * Number(d.report_count), 0) / totalReports;

        const confidence = totalReports < 5 ? 'low' : totalReports <= 20 ? 'medium' : 'high';

        return res.json({
          avg_crowding: Math.round(avgCrowding * 100) / 100,
          report_count: totalReports,
          confidence,
        });
      }

      // ── Deal: Submit with optional photo + Claude moderation ──
      case 'deal.submit': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const { venue_name, deal_description, neighbourhood_id, device_id: dsDeviceId, photo_base64 } = req.body || {};
        if (!isValidDeviceId(dsDeviceId)) {
          return res.status(400).json({ error: 'Valid device_id required' });
        }
        if (checkDeviceCooldown(dsDeviceId, 'deal.submit', 60000)) {
          return res.status(429).json({ error: 'Too many submissions, please wait' });
        }
        if (!venue_name || !deal_description || !neighbourhood_id) {
          return res.status(400).json({ error: 'Missing venue_name, deal_description, or neighbourhood_id' });
        }
        if (venue_name.length > 100 || deal_description.length > 500) {
          return res.status(400).json({ error: 'venue_name max 100 chars, deal_description max 500 chars' });
        }
        // Validate photo size (max ~2MB base64 ≈ 2.7M chars)
        if (photo_base64 && photo_base64.length > 2800000) {
          return res.status(400).json({ error: 'Photo too large (max 2MB)' });
        }

        // Upload photo to Supabase Storage if provided
        let photoUrl = null;
        if (photo_base64) {
          try {
            const buf = Buffer.from(photo_base64, 'base64');
            const filename = `deals/${Date.now()}_${dsDeviceId.slice(0, 8)}.jpg`;
            const { error: uploadErr } = await supabase.storage
              .from('deal-photos')
              .upload(filename, buf, { contentType: 'image/jpeg', upsert: false });
            if (!uploadErr) {
              const { data: urlData } = supabase.storage.from('deal-photos').getPublicUrl(filename);
              photoUrl = urlData?.publicUrl || null;
            }
          } catch (e) {
            console.error('Photo upload error:', e);
          }
        }

        // Geocode venue name for map pin
        let lat = null, lng = null;
        try {
          const geoResp = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(venue_name + ' Ottawa Canada')}&format=json&limit=1`,
            { headers: { 'User-Agent': 'RouteO/1.0' }, signal: AbortSignal.timeout(5000) }
          );
          if (geoResp.ok) {
            const geoData = await geoResp.json();
            if (geoData[0]) {
              lat = parseFloat(geoData[0].lat);
              lng = parseFloat(geoData[0].lon);
            }
          }
        } catch (e) {
          console.error('Deal geocode error:', e);
        }

        // Moderate with Claude
        const moderation = await moderateDealWithClaude(
          sanitize(venue_name),
          sanitize(deal_description),
          photo_base64 || null,
        );

        const autoApprove = moderation.approved && moderation.confidence > 85;
        const needsReview = moderation.confidence >= 50 && moderation.confidence <= 85;
        const rejected = moderation.confidence < 50 && !moderation.approved;

        const { data: insertedDeal, error: insertErr } = await supabase
          .from('community_deals')
          .insert({
            neighbourhood_id,
            venue_name: sanitize(venue_name),
            deal_description: sanitize(deal_description),
            device_id: dsDeviceId,
            photo_url: photoUrl,
            lat,
            lng,
            approved: autoApprove,
            moderation_confidence: moderation.confidence || 0,
            moderation_reason: sanitize(moderation.reason || ''),
            moderation_flags: moderation.flags || [],
            category: moderation.category || 'other',
          })
          .select('id')
          .single();

        if (insertErr) throw insertErr;

        const status = autoApprove ? 'approved' : rejected ? 'rejected' : 'pending_review';
        console.log(`Deal ${insertedDeal?.id} moderated: ${status} (confidence: ${moderation.confidence})`);

        return res.json({
          ok: true,
          deal_id: insertedDeal?.id,
          status,
          moderation_reason: moderation.reason,
          photo_url: photoUrl,
        });
      }

      // ── Deal: Notify admin of new community submission ─────────
      case 'deal.notify': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const { venue_name, deal_type, deal_description, address } = req.body || {};
        if (!venue_name) return res.status(400).json({ error: 'Missing venue_name' });

        const timestamp = new Date().toISOString();
        const summary = [
          `New community deal submitted`,
          `Venue: ${sanitize(venue_name)}`,
          `Type: ${sanitize(deal_type || 'N/A')}`,
          `Details: ${sanitize(deal_description || 'N/A')}`,
          address ? `Address: ${sanitize(address)}` : null,
          `Time: ${timestamp}`,
        ].filter(Boolean).join('\n');

        // Log for Vercel function logs (always visible in dashboard)
        console.log('=== NEW COMMUNITY DEAL ===');
        console.log(summary);
        console.log('==========================');

        return res.json({ ok: true, logged: true });
      }

      // ── Ghost bus: Submit report ─────────────────────────────────
      case 'ghost.report': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const { stop_id, route_id, report_type, device_id } = req.body || {};
        const notes = (String(req.body?.notes || '')).slice(0, 500);
        if (!isValidDeviceId(device_id)) {
          return res.status(400).json({ error: 'Valid device_id required' });
        }
        if (checkDeviceCooldown(device_id, 'ghost.report')) {
          return res.status(429).json({ error: 'Too many requests, please wait' });
        }
        if (!stop_id || !route_id || !report_type) {
          return res.status(400).json({ error: 'Missing stop_id, route_id, or report_type' });
        }
        const validTypes = ['drove_past', 'out_of_service', 'never_showed', 'wrong_destination', 'confirmed_arrived'];
        if (!validTypes.includes(report_type)) {
          return res.status(400).json({ error: `Invalid report_type. Must be one of: ${validTypes.join(', ')}` });
        }

        const { error } = await supabase
          .from('stop_reports')
          .insert({
            stop_id,
            category: report_type,
            route_id: route_id,
            description: sanitize(notes),
            device_id,
          });

        if (error) throw error;
        return res.json({ ok: true });
      }

      // ── Ghost bus: Get aggregation for a stop ───────────────────
      case 'ghost.stats': {
        const stop_id = req.query.stop_id;
        if (!stop_id) return res.status(400).json({ error: 'Missing stop_id' });

        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        const { data, error } = await supabase
          .from('stop_reports')
          .select('route_id, category, device_id')
          .eq('stop_id', stop_id)
          .gte('created_at', oneHourAgo);

        if (error) throw error;

        const ghostReports = {};
        for (const row of (data || [])) {
          const rid = row.route_id;
          if (!rid) continue;
          if (!ghostReports[rid]) ghostReports[rid] = { ghost: [], confirmed: [], devices: new Set() };
          if (row.category === 'confirmed_arrived') {
            ghostReports[rid].confirmed.push(row);
          } else {
            ghostReports[rid].ghost.push(row);
            ghostReports[rid].devices.add(row.device_id);
          }
        }

        const result = {};
        for (const [rid, agg] of Object.entries(ghostReports)) {
          const total = agg.ghost.length;
          const uniqueDevices = agg.devices.size;
          const confirmedCount = agg.confirmed.length;
          const netScore = total - (confirmedCount * 2);
          result[rid] = {
            total,
            uniqueDevices,
            confirmedCount,
            netScore,
            likelyGhost: netScore >= 3,
          };
        }

        return res.json({ ghostReports: result });
      }

      // ── Ghost bus: Weekly stats for a device ────────────────────
      case 'ghost.device_stats': {
        const device_id = req.query.device_id;
        if (!isValidDeviceId(device_id)) return res.status(400).json({ error: 'Valid device_id required' });

        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        const { data, error } = await supabase
          .from('stop_reports')
          .select('route_id, category, created_at')
          .eq('device_id', device_id)
          .neq('category', 'confirmed_arrived')
          .gte('created_at', oneWeekAgo);

        if (error) throw error;

        const rows = data || [];
        const routeCounts = {};
        for (const r of rows) {
          if (r.route_id) routeCounts[r.route_id] = (routeCounts[r.route_id] || 0) + 1;
        }
        let mostAffected = null;
        let maxCount = 0;
        for (const [rid, cnt] of Object.entries(routeCounts)) {
          if (cnt > maxCount) { maxCount = cnt; mostAffected = rid; }
        }

        return res.json({
          totalThisWeek: rows.length,
          mostAffectedRoute: mostAffected,
          mostAffectedCount: maxCount,
        });
      }

      // ── Business: Register email ────────────────────────────────
      case 'business.register': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const { email } = req.body || {};
        if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
          return res.status(400).json({ error: 'Valid email required' });
        }
        const { data: biz, error: bizErr } = await supabase
          .from('business_members')
          .upsert({ email: sanitize(email.toLowerCase().trim()) }, { onConflict: 'email' })
          .select('id, is_onboarded, is_active')
          .single();
        if (bizErr) throw bizErr;
        return res.json({ ok: true, id: biz.id, is_onboarded: biz.is_onboarded, is_active: biz.is_active });
      }

      // ── Business: Onboard (fill details + Claude moderation) ────
      case 'business.onboard': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const {
          email, business_name, deal_title, deal_description,
          lat, lng, address, category,
        } = req.body || {};
        if (!email || !business_name || !deal_title || !deal_description) {
          return res.status(400).json({ error: 'email, business_name, deal_title, and deal_description are required' });
        }
        if (String(business_name).length > 100 || String(deal_title).length > 100 || String(deal_description).length > 500) {
          return res.status(400).json({ error: 'Fields too long (business_name/deal_title ≤100, deal_description ≤500)' });
        }
        const bizMod = await moderateDealWithClaude(sanitize(String(business_name)), sanitize(String(deal_description)), null);
        const isActive = bizMod.approved && bizMod.confidence >= 70;
        const { error: onboardErr } = await supabase
          .from('business_members')
          .update({
            business_name:    sanitize(String(business_name)),
            deal_title:       sanitize(String(deal_title)),
            deal_description: sanitize(String(deal_description)),
            lat:    typeof lat === 'number' ? lat : null,
            lng:    typeof lng === 'number' ? lng : null,
            address:  sanitize(String(address || '')),
            category: sanitize(String(category || 'other')),
            is_onboarded: true,
            is_active: isActive,
          })
          .eq('email', String(email).toLowerCase().trim());
        if (onboardErr) throw onboardErr;
        console.log(`Business onboarded: ${email}, is_active=${isActive}, confidence=${bizMod.confidence}`);
        return res.json({ ok: true, is_active: isActive, moderation_reason: bizMod.reason });
      }

      // ── Business: Get active partner deals (radius-filtered) ────
      case 'business.deals': {
        const userLat = parseFloat(req.query.lat) || 45.4215;
        const userLng = parseFloat(req.query.lng) || -75.6972;
        const radiusM = Math.min(parseInt(req.query.radius) || 10000, 50000);

        const { data: bizDeals, error: bizDealsErr } = await supabase
          .from('business_members')
          .select('id, business_name, deal_title, deal_description, photo_url, lat, lng, address, category')
          .eq('is_active', true)
          .eq('is_onboarded', true);
        if (bizDealsErr) throw bizDealsErr;

        const R = 6371000;
        const latRad = userLat * Math.PI / 180;
        const filtered = (bizDeals || []).filter(d => {
          if (!d.lat || !d.lng) return true; // no location = show city-wide
          const dLat = (d.lat - userLat) * Math.PI / 180;
          const dLng = (d.lng - userLng) * Math.PI / 180;
          const a = Math.sin(dLat / 2) ** 2
            + Math.cos(latRad) * Math.cos(d.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
          return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= radiusM;
        });
        return res.json({ deals: filtered });
      }

      // ── Stripe webhook: activate / deactivate business memberships
      // Webhook URL: POST /api/community?action=stripe.webhook
      // Set STRIPE_WEBHOOK_TOKEN in Vercel env and pass it as x-stripe-token header
      // in Stripe's webhook dashboard for shared-secret verification.
      // TODO: upgrade to full Stripe-Signature HMAC verification (requires raw body).
      case 'stripe.webhook': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const webhookToken = process.env.STRIPE_WEBHOOK_TOKEN;
        if (webhookToken && req.headers['x-stripe-token'] !== webhookToken) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        const stripeEvent = req.body;
        if (!stripeEvent?.type || !stripeEvent?.data?.object) {
          return res.status(400).json({ error: 'Invalid Stripe event' });
        }

        const obj = stripeEvent.data.object;
        const customerId    = obj.customer || null;
        const subscriptionId = obj.id || null;
        const customerEmail = obj.customer_email || obj.metadata?.email || null;

        if (
          stripeEvent.type === 'customer.subscription.created' ||
          stripeEvent.type === 'customer.subscription.updated'
        ) {
          const isActive = obj.status === 'active' || obj.status === 'trialing';
          if (customerId) {
            await supabase.from('business_members')
              .update({ is_active: isActive, stripe_subscription_id: subscriptionId })
              .eq('stripe_customer_id', customerId);
          }
          // On first subscription, match by email to set stripe_customer_id
          if (customerEmail && isActive) {
            await supabase.from('business_members')
              .update({ is_active: true, stripe_customer_id: customerId, stripe_subscription_id: subscriptionId })
              .eq('email', customerEmail.toLowerCase())
              .is('stripe_customer_id', null);
          }
          // Log for onboarding email trigger — integrate Resend/SendGrid here
          if (isActive && customerEmail) {
            console.log(`=== BUSINESS ACTIVATED: ${customerEmail} — send onboarding link ===`);
          }
        } else if (stripeEvent.type === 'customer.subscription.deleted') {
          if (customerId) {
            await supabase.from('business_members')
              .update({ is_active: false })
              .eq('stripe_customer_id', customerId);
          }
        }
        return res.status(200).json({ received: true });
      }

      // ── Health check ─────────────────────────────────────────────
      case 'health': {
        let supabaseOk = false;
        try {
          const healthCheck = await Promise.race([
            supabase.from('stops').select('stop_id').limit(1),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
          ]);
          supabaseOk = !healthCheck.error;
        } catch (e) {
          supabaseOk = false;
        }

        return res.json({
          status: 'ok',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          supabase: supabaseOk,
          version: '1.0.0',
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error(`Community ${action} error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
