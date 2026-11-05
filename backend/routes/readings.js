// ============================================================
// routes/readings.js - Sensor Reading History Endpoint
// GET /api/readings?device_id&from&to&bucket&limit&page&pageSize
//
// Supports two modes:
//   1. Raw mode (bucket='raw' or omitted): returns individual
//      readings with pagination.
//   2. Bucket/aggregation mode (bucket='1m','5m','1h','1d'):
//      returns time-bucketed averages for charting.
// ============================================================

const express  = require('express');
const { z }    = require('zod');
const supabase = require('../lib/supabase');

const router = express.Router();

// Valid bucket sizes supported by this endpoint
const VALID_BUCKETS = ['raw', '1m', '5m', '15m', '1h', '1d'];

// Zod schema for query parameter validation
const querySchema = z.object({
  device_id: z.string().min(1).optional(),
  from:      z.string().optional(), // ISO timestamp
  to:        z.string().optional(), // ISO timestamp
  bucket:    z.enum(['raw', '1m', '5m', '15m', '1h', '1d']).optional(),
  limit:     z.coerce.number().int().min(1).max(500).optional(),
  page:      z.coerce.number().int().min(1).optional().default(1),
  pageSize:  z.coerce.number().int().min(1).max(500).optional().default(50),
});

// GET /api/readings
router.get('/', async (req, res, next) => {
  try {
    // Validate and parse query parameters using zod
    const params = querySchema.parse(req.query);
    const { device_id, from, to, bucket, page, pageSize } = params;

    // ── Bucketed / Aggregated Mode ────────────────────────
    // When a time bucket is requested, we use Supabase's raw SQL
    // to group readings into time intervals and compute averages.
    if (bucket && bucket !== 'raw') {
      // Supabase JS client v2 doesn't expose arbitrary GROUP BY / time-bucketing,
      // so we fetch readings within the range and aggregate in memory with 
      // deterministic interval buckets.
      let query = supabase.from('readings').select('created_at, water_cm, flood_risk');
      if (device_id) query = query.eq('device_id', device_id);
      if (from)      query = query.gte('created_at', from);
      if (to)        query = query.lte('created_at', to);
      query = query.order('created_at', { ascending: true });
      // Apply a reasonable row limit to avoid huge in-memory aggregation
      query = query.limit(50000);

      const { data: rawRows, error: rawError } = await query;
      if (rawError) throw rawError;

      // ── In-process time bucketing ─────────────────────────
      // Group rows into buckets by rounding the timestamp to the
      // nearest interval boundary.
      const intervalMs = {
        '1m':  60 * 1000,
        '5m':  5  * 60 * 1000,
        '15m': 15 * 60 * 1000,
        '1h':  60 * 60 * 1000,
        '1d':  24 * 60 * 60 * 1000,
      }[bucket];

      // Map: bucketTimestamp -> { sum, count, floodRisk }
      const bucketMap = new Map();

      for (const row of rawRows) {
        const ts    = new Date(row.created_at).getTime();
        const bKey  = Math.floor(ts / intervalMs) * intervalMs;
        const entry = bucketMap.get(bKey) || { sum: 0, count: 0, floodRisk: false };
        if (row.water_cm != null) {
          entry.sum   += row.water_cm;
          entry.count += 1;
        }
        if (row.flood_risk) entry.floodRisk = true;
        bucketMap.set(bKey, entry);
      }

      // Convert map to sorted array
      const aggregated = Array.from(bucketMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([ts, entry]) => ({
          created_at:    new Date(ts).toISOString(),
          water_cm_avg:  entry.count > 0 ? entry.sum / entry.count : null,
          flood_risk_max: entry.floodRisk,
        }));

      return res.json({ data: aggregated });
    }

    // ── Raw / Paginated Mode ──────────────────────────────────
    // Calculate the row range for the requested page
    const offset    = (page - 1) * pageSize;
    const rangeEnd  = offset + pageSize - 1;

    // Build the query with optional filters
    let query = supabase
      .from('readings')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, rangeEnd);

    if (device_id) query = query.eq('device_id', device_id);
    if (from)      query = query.gte('created_at', from);
    if (to)        query = query.lte('created_at', to);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      data,
      total:    count ?? 0,
      page,
      pageSize,
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
