// ============================================================
// routes/devices.js - Device Dashboard Endpoints
// All endpoints here are dashboard-facing (read-only, no auth).
// CORS is restricted to the frontend origin via server.js.
//
// GET /api/devices              - list all devices with status
// GET /api/devices/:id/overview - detailed overview for one device
// ============================================================

const express  = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

// Normalize legacy seed names so production hardware never shows placeholder "Demo" text
function normalizeDeviceName(name, id) {
  if (!name || /demo drain|mock pvc/i.test(name)) {
    return id === 'drain-01' ? 'DrainGuard Unit 01' : `DrainGuard Unit (${id})`;
  }
  return name;
}

// ─── GET /api/devices ────────────────────────────────────────
// Returns a list of all devices with their current online status
// and latest diagnostic status (from their most recent rod_event).
router.get('/', async (req, res, next) => {
  try {
    // Fetch devices, configs, and recent rod events in parallel (3 queries total)
    const [devicesRes, configsRes, rodEventsRes] = await Promise.all([
      supabase.from('devices').select('id, name, location, lat, lng, last_seen'),
      supabase.from('device_config').select('device_id, offline_after_min'),
      supabase
        .from('rod_events')
        .select('device_id, status, created_at')
        .eq('calibration', false)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    if (devicesRes.error) throw devicesRes.error;
    const devices = devicesRes.data || [];

    const configMap = new Map();
    for (const cfg of (configsRes.data || [])) {
      configMap.set(cfg.device_id, cfg);
    }

    const latestRodMap = new Map();
    for (const ev of (rodEventsRes.data || [])) {
      if (!latestRodMap.has(ev.device_id)) {
        latestRodMap.set(ev.device_id, ev);
      }
    }

    const result = devices.map((device) => {
      const cfg = configMap.get(device.id);
      const offlineAfterMin = cfg?.offline_after_min ?? 10;

      const lastSeen = device.last_seen ? new Date(device.last_seen) : null;
      const online = lastSeen
        ? (Date.now() - lastSeen.getTime()) < offlineAfterMin * 60 * 1000
        : false;

      const latestRod = latestRodMap.get(device.id);

      return {
        id:             device.id,
        name:           normalizeDeviceName(device.name, device.id),
        location:       device.location,
        lat:            device.lat,
        lng:            device.lng,
        last_seen:      device.last_seen,
        online,
        current_status: latestRod?.status ?? 'UNKNOWN',
      };
    });

    res.json(result);

  } catch (err) {
    next(err);
  }
});

// ─── GET /api/devices/:id/overview ───────────────────────────
// Returns a comprehensive overview for a single device in a single
// parallel batch: device info, latest reading, recent readings,
// rod events, full config, health score, and alert counts.
router.get('/:id/overview', async (req, res, next) => {
  try {
    const { id } = req.params;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();

    // Run all queries in parallel to minimize response latency
    const [
      deviceRes,
      configRes,
      recentReadingsRes,
      latestRodRes,
      openAlertsRes,
      todayRainRes,
      todayAlertsRes,
    ] = await Promise.all([
      supabase
        .from('devices')
        .select('id, name, location, lat, lng, last_seen')
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('device_config')
        .select('*')
        .eq('device_id', id)
        .maybeSingle(),
      supabase
        .from('readings')
        .select('*')
        .eq('device_id', id)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase
        .from('rod_events')
        .select('*')
        .eq('device_id', id)
        .eq('calibration', false)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('alerts')
        .select('*', { count: 'exact' })
        .eq('device_id', id)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('rod_events')
        .select('id', { count: 'exact', head: true })
        .eq('device_id', id)
        .eq('calibration', false)
        .gte('created_at', todayIso),
      supabase
        .from('alerts')
        .select('id', { count: 'exact', head: true })
        .eq('device_id', id)
        .gte('created_at', todayIso),
    ]);

    if (deviceRes.error || !deviceRes.data) {
      return res.status(404).json({ error: `Device not found: ${id}` });
    }

    const device = {
      ...deviceRes.data,
      name: normalizeDeviceName(deviceRes.data.name, deviceRes.data.id),
    };
    const config = configRes.data || {};
    const recentReadings = recentReadingsRes.data || [];
    const latestReading = recentReadings[0] || null;
    const latestRodEvent = latestRodRes.data || null;
    const offlineAfterMin = config.offline_after_min ?? 10;

    // ── Determine online status ───────────────────────────
    const lastSeen = device.last_seen ? new Date(device.last_seen) : null;
    const online = lastSeen
      ? (Date.now() - lastSeen.getTime()) < offlineAfterMin * 60 * 1000
      : false;

    // ── Compute Health Score (0-100) ──────────────────────
    let healthScore = 50;
    if (latestRodEvent) {
      healthScore = Math.round((latestRodEvent.ratio ?? 0.5) * 100);
      healthScore = Math.min(100, Math.max(0, healthScore));
    }
    if (!online) {
      healthScore = Math.max(0, healthScore - 10);
    }

    // ── Build and send response ───────────────────────────
    res.json({
      device,
      config,
      latest_reading:    latestReading,
      recent_readings:   recentReadings,
      online,
      last_seen:         device.last_seen,
      latest_rod_event:  latestRodEvent,
      baseline_rod:      config.baseline_rod ?? null,
      health_score:      healthScore,
      current_state:     latestReading?.state ?? null,
      open_alerts:       openAlertsRes.data || [],
      open_alert_count:  openAlertsRes.count ?? 0,
      today_rain_events: todayRainRes.count ?? 0,
      today_alerts:      todayAlertsRes.count ?? 0,
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
