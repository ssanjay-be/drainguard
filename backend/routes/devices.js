// ============================================================
// routes/devices.js - Device Dashboard Endpoints
// All endpoints here are dashboard-facing (read-only, no auth).
// CORS is restricted to the frontend origin via server.js.
//
// GET /api/devices           - list all devices with status
// GET /api/devices/:id/overview - detailed overview for one device
// ============================================================

const express  = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

// ─── GET /api/devices ────────────────────────────────────────
// Returns a list of all devices with their current online status
// and latest diagnostic status (from their most recent rod_event).
router.get('/', async (req, res, next) => {
  try {
    // Fetch all devices
    const { data: devices, error: devicesError } = await supabase
      .from('devices')
      .select('id, name, location, lat, lng, last_seen');

    if (devicesError) throw devicesError;

    // For each device, determine online status and current rod status
    const result = await Promise.all(devices.map(async (device) => {
      // Get the offline threshold from device_config (default 10 minutes)
      const { data: config } = await supabase
        .from('device_config')
        .select('offline_after_min')
        .eq('device_id', device.id)
        .maybeSingle();

      const offlineAfterMin = config?.offline_after_min ?? 10;

      // Online = last_seen within the offline threshold
      const lastSeen = device.last_seen ? new Date(device.last_seen) : null;
      const online = lastSeen
        ? (Date.now() - lastSeen.getTime()) < offlineAfterMin * 60 * 1000
        : false;

      // Get the most recent non-calibration rod_event status
      const { data: latestRod } = await supabase
        .from('rod_events')
        .select('status')
        .eq('device_id', device.id)
        .eq('calibration', false)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return {
        id:             device.id,
        name:           device.name,
        location:       device.location,
        lat:            device.lat,
        lng:            device.lng,
        last_seen:      device.last_seen,
        online,
        current_status: latestRod?.status ?? 'UNKNOWN',
      };
    }));

    res.json(result);

  } catch (err) {
    next(err);
  }
});

// ─── GET /api/devices/:id/overview ───────────────────────────
// Returns a comprehensive overview for a single device,
// including latest readings, rod events, health score, and alert counts.
router.get('/:id/overview', async (req, res, next) => {
  try {
    const { id } = req.params;

    // ── Fetch latest reading ──────────────────────────────
    const { data: latestReading } = await supabase
      .from('readings')
      .select('*')
      .eq('device_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // ── Fetch device info (last_seen) ─────────────────────
    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('last_seen')
      .eq('id', id)
      .maybeSingle();

    if (deviceError || !device) {
      return res.status(404).json({ error: `Device not found: ${id}` });
    }

    // ── Fetch device config ───────────────────────────────
    const { data: config } = await supabase
      .from('device_config')
      .select('offline_after_min, baseline_rod')
      .eq('device_id', id)
      .maybeSingle();

    const offlineAfterMin = config?.offline_after_min ?? 10;

    // ── Determine online status ───────────────────────────
    const lastSeen = device.last_seen ? new Date(device.last_seen) : null;
    const online = lastSeen
      ? (Date.now() - lastSeen.getTime()) < offlineAfterMin * 60 * 1000
      : false;

    // ── Fetch latest (non-calibration) rod event ──────────
    const { data: latestRodEvent } = await supabase
      .from('rod_events')
      .select('*')
      .eq('device_id', id)
      .eq('calibration', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // ── Compute Health Score (0-100) ──────────────────────
    // If no rod events yet, return a neutral 50 (not enough data).
    // Otherwise use the ratio (how close to baseline) * 100,
    // then penalize 10 points if the device is currently offline.
    let healthScore = 50;
    if (latestRodEvent) {
      healthScore = Math.round((latestRodEvent.ratio ?? 0.5) * 100);
      healthScore = Math.min(100, Math.max(0, healthScore)); // clamp 0–100
    }
    if (!online) {
      healthScore = Math.max(0, healthScore - 10); // offline penalty
    }

    // ── Count open alerts ─────────────────────────────────
    const { count: openAlertCount } = await supabase
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('device_id', id)
      .eq('status', 'open');

    // ── Count today's rain events (rod_events where calibration=false) ──
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { count: todayRainEvents } = await supabase
      .from('rod_events')
      .select('id', { count: 'exact', head: true })
      .eq('device_id', id)
      .eq('calibration', false)
      .gte('created_at', todayStart.toISOString());

    // ── Count today's alerts ──────────────────────────────
    const { count: todayAlerts } = await supabase
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('device_id', id)
      .gte('created_at', todayStart.toISOString());

    // ── Build and send response ───────────────────────────
    res.json({
      latest_reading:    latestReading  ?? null,
      online,
      last_seen:         device.last_seen,
      latest_rod_event:  latestRodEvent ?? null,
      baseline_rod:      config?.baseline_rod ?? null,
      health_score:      healthScore,
      current_state:     latestReading?.state ?? null,
      open_alert_count:  openAlertCount  ?? 0,
      today_rain_events: todayRainEvents ?? 0,
      today_alerts:      todayAlerts     ?? 0,
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
