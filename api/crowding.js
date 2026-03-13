/**
 * RouteO — Bus Crowding Reports
 *
 * POST /api/crowding — Submit a crowding report
 *   body: { route_id, stop_id, direction_id?, vehicle_id?, crowding_level }
 *
 * GET /api/crowding?route_id=X&stop_id=Y — Get crowding prediction
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://bzvkadttywgszovbowch.supabase.co',
  'sb_publishable_UQXeqJ_OE-Zhl51qrHVF3w_UXOxKk2O'
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'POST') {
      const { route_id, stop_id, direction_id, vehicle_id, crowding_level } = req.body || {};
      if (!route_id || !stop_id || crowding_level == null) {
        return res.status(400).json({ error: 'route_id, stop_id, and crowding_level are required' });
      }
      if (crowding_level < 0 || crowding_level > 3) {
        return res.status(400).json({ error: 'crowding_level must be 0-3' });
      }

      const now = new Date();
      const { error } = await supabase.from('bus_crowding_reports').insert({
        route_id,
        stop_id,
        direction_id: direction_id || null,
        vehicle_id: vehicle_id || null,
        crowding_level,
        hour_of_day: now.getUTCHours() - 5 < 0 ? now.getUTCHours() + 19 : now.getUTCHours() - 5, // EST approximation
        day_of_week: now.getDay(),
      });

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    // GET — prediction
    const { route_id, stop_id } = req.query;
    if (!route_id || !stop_id) {
      return res.status(400).json({ error: 'route_id and stop_id are required' });
    }

    const now = new Date();
    const hour = now.getUTCHours() - 5 < 0 ? now.getUTCHours() + 19 : now.getUTCHours() - 5;
    const dow = now.getDay();

    // Query the aggregated view for current hour ±1
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

    // Prefer exact hour match, fall back to ±1 hour average
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
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
};
