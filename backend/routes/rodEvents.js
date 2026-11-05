// ============================================================
// routes/rodEvents.js - Rate-of-Drainage Event History
// GET /api/rod-events?device_id&from&to&status&page&pageSize
//
// Returns a paginated list of rod_event records.
// Rod events represent the results of automatic drainage tests
// that the IoT device runs during rainfall.
// ============================================================

const express  = require('express');
const { z }    = require('zod');
const supabase = require('../lib/supabase');

const router = express.Router();

// Zod schema for query parameter validation
const querySchema = z.object({
  device_id: z.string().optional(),
  from:      z.string().optional(), // ISO timestamp — filter by created_at >=
  to:        z.string().optional(), // ISO timestamp — filter by created_at <=
  status:    z.enum(['CLEAR', 'WATCH', 'PRE_CLOG', 'CALIBRATED']).optional(),
  page:      z.coerce.number().int().min(1).optional().default(1),
  pageSize:  z.coerce.number().int().min(1).max(500).optional().default(50),
});

// GET /api/rod-events
router.get('/', async (req, res, next) => {
  try {
    // Validate query params
    const params = querySchema.parse(req.query);
    const { device_id, from, to, status, page, pageSize } = params;

    // Calculate the pagination range (0-based row indices)
    const offset   = (page - 1) * pageSize;
    const rangeEnd = offset + pageSize - 1;

    // Build the Supabase query with optional filters
    let query = supabase
      .from('rod_events')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, rangeEnd);

    if (device_id) query = query.eq('device_id', device_id);
    if (from)      query = query.gte('created_at', from);
    if (to)        query = query.lte('created_at', to);
    if (status)    query = query.eq('status', status);

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
