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
 *   POST /api/community?action=deal.vote         — Vote on a community deal
 *   GET  /api/community?action=deal.votes&neighbourhood_id=X — Get votes for deals
 *   POST /api/community?action=deal.notify       — Log new deal submission (admin notification)
 *
 * Crowding:
 *   POST /api/community?action=crowding.report   — Submit a crowding report
 *   GET  /api/community?action=crowding.predict&route_id=X&stop_id=Y — Get prediction
 *
 * Ghost bus:
 *   POST /api/community?action=ghost.report       — Submit ghost bus / confirmed arrival
 *   GET  /api/community?action=ghost.stats&stop_id=X — Aggregated ghost reports (last 60min)
 *   GET  /api/community?action=ghost.device_stats&device_id=X — Weekly stats for device
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function isValidDeviceId(id) {
  return typeof id === 'string' && id.length >= 5 && id.length <= 200;
}

module.exports = async (req, res) => {
  if (checkRateLimit(req, res)) return;
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
        if (!Array.isArray(subscriptions)) {
          return res.status(400).json({ error: 'Missing subscriptions array' });
        }

        // Upsert each subscription
        for (const sub of subscriptions) {
          const { error } = await supabase
            .from('push_subscriptions')
            .upsert({
              device_id,
              type: sub.type,
              enabled: sub.enabled,
              metadata: sub.metadata || {},
            }, { onConflict: 'device_id,type' });
          if (error) throw error;
        }

        return res.json({ ok: true, count: subscriptions.length });
      }

      // ── Push: Check registration ────────────────────────────────
      case 'push.check': {
        const device_id = req.query.device_id;
        if (!isValidDeviceId(device_id)) return res.status(400).json({ error: 'Valid device_id required' });

        const { data: token } = await supabase
          .from('push_tokens')
          .select('expo_token, updated_at')
          .eq('device_id', device_id)
          .single();

        const { data: subs } = await supabase
          .from('push_subscriptions')
          .select('type, enabled, metadata')
          .eq('device_id', device_id);

        return res.json({
          registered: !!token,
          token: token?.expo_token || null,
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
          .insert({ stop_id, category, description: description || '', device_id });

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
        const { route_id, stop_id, direction_id, vehicle_id, crowding_level } = req.body || {};
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

        if (error) return res.status(500).json({ error: error.message });
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

        if (error) return res.status(500).json({ error: error.message });

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

      // ── Deal: Notify admin of new community submission ─────────
      case 'deal.notify': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const { venue_name, deal_type, deal_description, address } = req.body || {};
        if (!venue_name) return res.status(400).json({ error: 'Missing venue_name' });

        const timestamp = new Date().toISOString();
        const summary = [
          `New community deal submitted`,
          `Venue: ${venue_name}`,
          `Type: ${deal_type || 'N/A'}`,
          `Details: ${deal_description || 'N/A'}`,
          address ? `Address: ${address}` : null,
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
        const { stop_id, route_id, report_type, notes, device_id } = req.body || {};
        if (!isValidDeviceId(device_id)) {
          return res.status(400).json({ error: 'Valid device_id required' });
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
            description: notes || '',
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

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error(`Community ${action} error:`, err);
    return res.status(500).json({ error: `${action} failed`, detail: err.message || String(err) });
  }
};
