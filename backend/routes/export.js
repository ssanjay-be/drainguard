// ============================================================
// routes/export.js - CSV Data Export Endpoints
//
// GET /api/export/readings.csv?device_id&from&to
//   Downloads all matching readings as a CSV file.
//
// GET /api/export/rod-events.csv?device_id&from&to
//   Downloads all matching rod_events as a CSV file.
//
// These endpoints stream the response as plain text/CSV so the
// browser's download dialog opens automatically.
// ============================================================

const express  = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

// ─── Helper: Escape CSV Cell ──────────────────────────────────
// Wraps a value in double-quotes if it contains commas, quotes,
// or newlines. Escapes internal double-quotes by doubling them.
function csvCell(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ─── Helper: Array of objects -> CSV string ───────────────────
function toCsv(headers, rows) {
  const headerLine = headers.join(',');
  const dataLines  = rows.map(row =>
    headers.map(h => csvCell(row[h])).join(',')
  );
  return [headerLine, ...dataLines].join('\n');
}

// ─── GET /api/export/readings.csv ────────────────────────────
router.get('/readings.csv', async (req, res, next) => {
  try {
    const { device_id, from, to } = req.query;

    // Build query with optional filters
    let query = supabase
      .from('readings')
      .select('id, device_id, created_at, type, state, distance_cm, water_cm, flood_risk, rssi, uptime_s')
      .order('created_at', { ascending: true });

    if (device_id) query = query.eq('device_id', device_id);
    if (from)      query = query.gte('created_at', from);
    if (to)        query = query.lte('created_at', to);

    // Limit to prevent accidental huge downloads
    query = query.limit(100000);

    const { data, error } = await query;
    if (error) throw error;

    // Set headers to trigger browser download
    const filename = `readings_${device_id || 'all'}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Define column order for the CSV
    const headers = ['id', 'device_id', 'created_at', 'type', 'state',
                     'distance_cm', 'water_cm', 'flood_risk', 'rssi', 'uptime_s'];

    res.send(toCsv(headers, data));

  } catch (err) {
    next(err);
  }
});

// ─── GET /api/export/rod-events.csv ──────────────────────────
router.get('/rod-events.csv', async (req, res, next) => {
  try {
    const { device_id, from, to } = req.query;

    let query = supabase
      .from('rod_events')
      .select('id, device_id, created_at, state, h1_cm, h2_cm, duration_s, rod_cm_min, baseline_rod, ratio, status, calibration, low_confidence, rssi')
      .order('created_at', { ascending: true });

    if (device_id) query = query.eq('device_id', device_id);
    if (from)      query = query.gte('created_at', from);
    if (to)        query = query.lte('created_at', to);

    query = query.limit(100000);

    const { data, error } = await query;
    if (error) throw error;

    const filename = `rod_events_${device_id || 'all'}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const headers = ['id', 'device_id', 'created_at', 'state', 'h1_cm', 'h2_cm',
                     'duration_s', 'rod_cm_min', 'baseline_rod', 'ratio', 'status',
                     'calibration', 'low_confidence', 'rssi'];

    res.send(toCsv(headers, data));

  } catch (err) {
    next(err);
  }
});

module.exports = router;
