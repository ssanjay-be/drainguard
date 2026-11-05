// ============================================================
// routes/alerts.js - Alert Management Endpoints
//
// GET  /api/alerts?device_id&status&page&pageSize
//   Returns a paginated list of alerts.
//
// POST /api/alerts/:id/ack
//   Admin-only. Marks an alert as acknowledged (seen but not resolved).
//
// POST /api/alerts/:id/resolve
//   Admin-only. Marks an alert as fully resolved.
// ============================================================

const express  = require('express');
const { z }    = require('zod');
const supabase = require('../lib/supabase');
const { requireAdminKey } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/alerts ─────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    // Validate query parameters
    const schema = z.object({
      device_id: z.string().optional(),
      status:    z.enum(['open', 'acknowledged', 'resolved']).optional(),
      page:      z.coerce.number().int().min(1).optional().default(1),
      pageSize:  z.coerce.number().int().min(1).max(200).optional().default(50),
    });
    const { device_id, status, page, pageSize } = schema.parse(req.query);

    const offset   = (page - 1) * pageSize;
    const rangeEnd = offset + pageSize - 1;

    // Build query with optional filters
    let query = supabase
      .from('alerts')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, rangeEnd);

    if (device_id) query = query.eq('device_id', device_id);
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

// ─── POST /api/alerts/:id/ack ─────────────────────────────────
// Acknowledge an alert — means "I've seen this, I'm on it"
// but it's not fully resolved yet.
router.post('/:id/ack', requireAdminKey, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('alerts')
      .update({
        status:          'acknowledged',
        acknowledged_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: `Alert not found: ${id}` });

    res.json({ ok: true, alert: data });

  } catch (err) {
    next(err);
  }
});

// ─── POST /api/alerts/:id/resolve ────────────────────────────
// Resolve an alert — means "the problem is fixed."
router.post('/:id/resolve', requireAdminKey, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('alerts')
      .update({
        status:      'resolved',
        resolved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: `Alert not found: ${id}` });

    res.json({ ok: true, alert: data });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
