// ============================================================
// routes/admin.js - Admin-Only Management Endpoints
//
// POST /api/admin/verify              - verify admin password
// POST /api/devices/:id/calibrate    - trigger device calibration
// PUT  /api/devices/:id/settings     - update device settings
//
// All write operations require the x-admin-key header.
// ============================================================

const express  = require('express');
const { z }    = require('zod');
const supabase = require('../lib/supabase');
const { requireAdminKey } = require('../middleware/auth');

const router = express.Router();

// ─── POST /api/admin/verify ───────────────────────────────────
// The dashboard calls this to verify the admin password before
// showing admin controls. Returns {ok:true} or 401.
const handleVerify = async (req, res, next) => {
  try {
    const { password } = req.body;

    if (!password || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid admin password.' });
    }

    res.json({ ok: true });

  } catch (err) {
    next(err);
  }
};
router.post('/admin/verify', handleVerify);
router.post('/verify', handleVerify);

// ─── POST /api/devices/:id/calibrate ─────────────────────────
// Sets the device's calibrate flag to true.
// The IoT device will read this flag on its next config poll
// and run a fresh calibration drainage test.
const handleCalibrate = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Set calibrate = true in device_config
    const { error } = await supabase
      .from('device_config')
      .update({ calibrate: true })
      .eq('device_id', id);

    if (error) throw error;

    res.json({ ok: true, message: `Calibration scheduled for device ${id}.` });

  } catch (err) {
    next(err);
  }
};
router.post('/devices/:id/calibrate', requireAdminKey, handleCalibrate);
router.post('/admin/devices/:id/calibrate', requireAdminKey, handleCalibrate);

// ─── PUT /api/devices/:id/settings ───────────────────────────
// Update device metadata (name, location, coordinates) and/or
// configuration thresholds (ratios, sensor geometry, etc.)
// All fields are optional — only provided fields are updated.
const handleSettings = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Zod schema — all fields optional since this is a partial update
    const schema = z.object({
      // Device table fields
      name:                z.string().min(1).optional(),
      location:            z.string().optional(),
      lat:                 z.number().optional(),
      lng:                 z.number().optional(),
      // Device config fields
      clear_ratio:         z.number().min(0).max(1).optional(),
      preclog_ratio:       z.number().min(0).max(1).optional(),
      sensor_to_bottom_cm: z.number().optional(),
      rain_start_cm:       z.number().optional(),
      offline_after_min:   z.number().int().min(1).optional(),
      baseline_rod:        z.number().optional(),
    });

    const body = schema.parse(req.body);

    // Split the update across two tables

    // ── Update devices table ──────────────────────────────
    const deviceFields = {};
    if (body.name     != null) deviceFields.name     = body.name;
    if (body.location != null) deviceFields.location = body.location;
    if (body.lat      != null) deviceFields.lat      = body.lat;
    if (body.lng      != null) deviceFields.lng      = body.lng;

    if (Object.keys(deviceFields).length > 0) {
      const { error } = await supabase
        .from('devices')
        .update(deviceFields)
        .eq('id', id);
      if (error) throw error;
    }

    // ── Update device_config table ────────────────────────
    const configFields = {};
    if (body.clear_ratio         != null) configFields.clear_ratio         = body.clear_ratio;
    if (body.preclog_ratio       != null) configFields.preclog_ratio       = body.preclog_ratio;
    if (body.sensor_to_bottom_cm != null) configFields.sensor_to_bottom_cm = body.sensor_to_bottom_cm;
    if (body.rain_start_cm       != null) configFields.rain_start_cm       = body.rain_start_cm;
    if (body.offline_after_min   != null) configFields.offline_after_min   = body.offline_after_min;
    if (body.baseline_rod        != null) configFields.baseline_rod        = body.baseline_rod;

    if (Object.keys(configFields).length > 0) {
      const { error } = await supabase
        .from('device_config')
        .update(configFields)
        .eq('device_id', id);
      if (error) throw error;
    }

    // ── Return the updated records ────────────────────────
    const { data: updatedDevice } = await supabase
      .from('devices')
      .select('*')
      .eq('id', id)
      .single();

    const { data: updatedConfig } = await supabase
      .from('device_config')
      .select('*')
      .eq('device_id', id)
      .single();

    res.json({
      device: updatedDevice,
      config: updatedConfig,
    });

  } catch (err) {
    next(err);
  }
};
router.put('/devices/:id/settings', requireAdminKey, handleSettings);
router.put('/admin/devices/:id/settings', requireAdminKey, handleSettings);

module.exports = router;
