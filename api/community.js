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
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://bzvkadttywgszovbowch.supabase.co',
  'sb_publishable_UQXeqJ_OE-Zhl51qrHVF3w_UXOxKk2O'
);

module.exports = async (req, res) => {
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
        if (!expo_token || !device_id) {
          return res.status(400).json({ error: 'Missing expo_token or device_id' });
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
        if (!device_id || !Array.isArray(subscriptions)) {
          return res.status(400).json({ error: 'Missing device_id or subscriptions array' });
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
        if (!device_id) return res.status(400).json({ error: 'Missing device_id' });

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
        if (!stop_id || !category || !device_id) {
          return res.status(400).json({ error: 'Missing stop_id, category, or device_id' });
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

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error(`Community ${action} error:`, err);
    return res.status(500).json({ error: `${action} failed`, detail: err.message || String(err) });
  }
};
