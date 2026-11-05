// ============================================================
// routes/deviceConfig.js - Device Configuration Endpoint
// GET /api/device/config?device_id=...
//
// IoT devices call this on startup (or periodically) to fetch
// their current configuration from the server. This allows
// remote configuration of thresholds without reflashing firmware.
//
// Requires: x-api-key header (device authentication)
// ============================================================

const express  = require('express');
const supabase = require('../lib/supabase');
const { requireDeviceKey } = require('../middleware/auth');

const router = express.Router();

// GET /api/device/config?device_id=abc123
router.get('/device/config', requireDeviceKey, async (req, res, next) => {
  try {
    const { device_id } = req.query;

    // device_id is required
    if (!device_id) {
      return res.status(400).json({ error: 'Missing required query parameter: device_id' });
    }

    // Fetch the device's configuration from device_config table
    const { data, error } = await supabase
      .from('device_config')
      .select('baseline_rod, calibrate, clear_ratio, preclog_ratio, sensor_to_bottom_cm, rain_start_cm, offline_after_min')
      .eq('device_id', device_id)
      .single();

    if (error) {
      // 'PGRST116' is the Supabase "row not found" code
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: `No config found for device_id: ${device_id}` });
      }
      throw error;
    }

    // Return the configuration values to the device
    res.json(data);

  } catch (err) {
    next(err);
  }
});

module.exports = router;
