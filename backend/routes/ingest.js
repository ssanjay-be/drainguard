// ============================================================
// routes/ingest.js - IoT Device Data Ingestion Endpoint
// POST /api/ingest
//
// This is the main endpoint that physical IoT drain sensors
// call to submit their readings and results. It handles three
// message types:
//   "reading"    - water level / heartbeat from the sensor
//   "rod_result" - result of a Rate-of-Drainage (RoD) test
//   "sensor_fault" - device reporting a hardware problem
// ============================================================

const express  = require('express');
const { z }    = require('zod');
const supabase = require('../lib/supabase');
const { requireDeviceKey } = require('../middleware/auth');
const deviceIngestLimiter  = require('../middleware/rateLimiter');
const { sendTelegramAlert } = require('../lib/telegram');

const router = express.Router();

// ─── Zod Validation Schemas ─────────────────────────────────
// Zod is a TypeScript-first schema validation library.
// We use it to validate the JSON body sent by IoT devices.
// If the body doesn't match, zod throws a ZodError which our
// central error handler catches and returns as a 400 response.

// Schema for "reading" and "heartbeat" messages
const readingSchema = z.object({
  device_id:   z.string().min(1),
  type:        z.enum(['reading', 'heartbeat']),
  state:       z.string().min(1),
  distance_cm: z.number().optional(),
  water_cm:    z.number().optional(),
  flood_risk:  z.boolean().optional(),
  rssi:        z.number().int().optional(),
  uptime_s:    z.number().optional(),
});

// Schema for "rod_result" (Rate-of-Drainage test result)
const rodResultSchema = z.object({
  device_id:    z.string().min(1),
  type:         z.literal('rod_result'),
  state:        z.string().min(1),
  h1_cm:        z.number(),            // initial water level
  h2_cm:        z.number(),            // final water level
  duration_s:   z.number(),            // test duration in seconds
  rod_cm_min:   z.number(),            // drainage rate cm per minute
  baseline_rod: z.number(),            // device's current baseline
  ratio:        z.number(),            // rod_cm_min / baseline_rod
  status:       z.enum(['CLEAR', 'WATCH', 'PRE_CLOG', 'CALIBRATED']),
  calibration:  z.boolean(),           // was this a calibration run?
  rssi:         z.number().int().optional(),
});

// Schema for "sensor_fault" messages
const sensorFaultSchema = z.object({
  device_id: z.string().min(1),
  type:      z.literal('sensor_fault'),
  state:     z.string().optional(),
});

// ─── Helper: Create Alert with Deduplication ─────────────────
/**
 * Creates an alert in the database, but only if a matching open
 * alert for this device doesn't already exist within the given
 * time window (deduplication to avoid alert spam).
 *
 * @param {string} deviceId    - the device ID
 * @param {string} alertType   - e.g. 'FLOOD_RISK', 'PRE_CLOG'
 * @param {string} severity    - 'critical', 'warning', or 'info'
 * @param {string} message     - human-readable alert message
 * @param {number} dedupeMinutes - skip if same alert within this many minutes (0 = no dedupe)
 * @returns {object|null} the created alert row, or null if deduped
 */
async function createAlert(deviceId, alertType, severity, message, dedupeMinutes = 0) {
  // Check for a recent open alert of the same type for this device
  if (dedupeMinutes > 0) {
    const cutoff = new Date(Date.now() - dedupeMinutes * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from('alerts')
      .select('id')
      .eq('device_id', deviceId)
      .eq('type', alertType)
      .eq('status', 'open')
      .gte('created_at', cutoff)
      .limit(1);

    if (existing && existing.length > 0) {
      // A recent alert already exists — don't create a duplicate
      return null;
    }
  }

  // Insert the new alert
  const { data, error } = await supabase
    .from('alerts')
    .insert({
      device_id: deviceId,
      type:      alertType,
      severity,
      message,
      status:    'open',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ─── Helper: Ensure Device Exists ────────────────────────────
/**
 * Updates the device's last_seen timestamp.
 * If the device doesn't exist yet, creates it automatically
 * (auto-registration for new hardware).
 *
 * @param {string} deviceId
 */
async function upsertDevice(deviceId) {
  const now = new Date().toISOString();

  // Try to update an existing device first
  const { data: existing } = await supabase
    .from('devices')
    .select('id')
    .eq('id', deviceId)
    .single();

  if (existing) {
    // Device exists — just update last_seen
    await supabase
      .from('devices')
      .update({ last_seen: now })
      .eq('id', deviceId);
  } else {
    // New device — create it with defaults
    await supabase.from('devices').insert({
      id:        deviceId,
      name:      `Device ${deviceId}`,
      last_seen: now,
    });

    // Also create default device_config row for it
    await supabase.from('device_config').insert({
      device_id:          deviceId,
      baseline_rod:       null,
      calibrate:          false,
      clear_ratio:        0.75,
      preclog_ratio:      0.50,
      offline_after_min:  10,
    });
  }
}

// ─── Helper: Resolve Alerts ───────────────────────────────────
/**
 * Sets all open alerts of specified types for a device to 'resolved'.
 *
 * @param {string} deviceId
 * @param {string[]} alertTypes - array of alert_type strings to resolve
 */
async function resolveAlerts(deviceId, alertTypes) {
  await supabase
    .from('alerts')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .eq('device_id', deviceId)
    .in('type', alertTypes)
    .eq('status', 'open');
}

// ─── POST /api/ingest ────────────────────────────────────────
router.post('/ingest', requireDeviceKey, deviceIngestLimiter, async (req, res, next) => {
  try {
    const body = req.body;

    // Determine message type to pick the right validation schema
    const { type } = body;

    // ── Handle "reading" or "heartbeat" ──────────────────────
    if (type === 'reading' || type === 'heartbeat') {
      // Validate the request body against the schema
      const data = readingSchema.parse(body);

      // Insert the sensor reading into the readings table
      const { error: insertError } = await supabase
        .from('readings')
        .insert({
          device_id:   data.device_id,
          type:        data.type,
          state:       data.state,
          distance_cm: data.distance_cm ?? null,
          water_cm:    data.water_cm    ?? null,
          flood_risk:  data.flood_risk  ?? false,
          rssi:        data.rssi        ?? null,
          uptime_s:    data.uptime_s    ?? null,
        });

      if (insertError) throw insertError;

      // Update or auto-create the device record
      await upsertDevice(data.device_id);

      // ── Flood Risk Alert ──────────────────────────────────
      // If the sensor reports active flooding, create a critical alert.
      // Deduplication: skip if we already have an open FLOOD_RISK alert
      // for this device within the last 30 minutes (avoid spam).
      if (data.flood_risk === true) {
        const alert = await createAlert(
          data.device_id,
          'FLOOD_RISK',
          'critical',
          `Flood risk detected by device ${data.device_id} — immediate inspection recommended.`,
          30 // dedupe window: 30 minutes
        );

        if (alert) {
          await sendTelegramAlert(
            `🚨 *FLOOD RISK* — Device \`${data.device_id}\`\n` +
            `Water level: ${data.water_cm ?? 'N/A'} cm\n` +
            `State: ${data.state}`
          );
        }
      }

      return res.json({ ok: true });
    }

    // ── Handle "rod_result" ───────────────────────────────────
    if (type === 'rod_result') {
      const data = rodResultSchema.parse(body);

      // low_confidence = true if the test conditions were unreliable
      // (too little water to start, or test ended too quickly)
      const lowConfidence = (data.h1_cm < 10 || data.duration_s < 30);

      // Insert the rod_event record
      const { error: insertError } = await supabase
        .from('rod_events')
        .insert({
          device_id:    data.device_id,
          state:        data.state,
          h1_cm:        data.h1_cm,
          h2_cm:        data.h2_cm,
          duration_s:   data.duration_s,
          rod_cm_min:   data.rod_cm_min,
          baseline_rod: data.baseline_rod,
          ratio:        data.ratio,
          status:       data.status,
          calibration:  data.calibration,
          rssi:         data.rssi ?? null,
          low_confidence: lowConfidence,
        });

      if (insertError) throw insertError;

      // Update device last_seen
      await upsertDevice(data.device_id);

      // ── Calibration Handling ────────────────────────────
      // If this was a calibration run, update the baseline in device_config
      // and clear the calibration flag so the device doesn't repeat it.
      if (data.calibration === true) {
        await supabase
          .from('device_config')
          .update({
            baseline_rod: data.rod_cm_min,
            calibrate:    false,
          })
          .eq('device_id', data.device_id);

        // Log calibration success — no alert row needed because
        // the dashboard detects the baseline change via polling.
        console.log(`📐  Calibration complete for ${data.device_id}: baseline set to ${data.rod_cm_min.toFixed(2)} cm/min.`);
      }

      // ── Status-Based Alerts ─────────────────────────────
      if (data.status === 'PRE_CLOG') {
        // Critical: drain is significantly blocked — maintenance required
        const pct = ((data.ratio) * 100).toFixed(0);
        const alert = await createAlert(
          data.device_id,
          'PRE_CLOG',
          'critical',
          `Maintenance Required: Partial Blockage detected (RoD ${data.rod_cm_min.toFixed(2)} cm/min = ${pct}% of baseline).`,
          60 // dedupe: don't re-alert within 60 minutes
        );

        if (alert) {
          await sendTelegramAlert(
            `🔴 *PRE-CLOG* — Device \`${data.device_id}\`\n` +
            `RoD: ${data.rod_cm_min.toFixed(2)} cm/min (${pct}% of baseline)\n` +
            `Maintenance required.`
          );
        }

      } else if (data.status === 'WATCH') {
        // Warning: drain is draining slower than normal, keep an eye on it
        const pct = ((data.ratio) * 100).toFixed(0);
        const alert = await createAlert(
          data.device_id,
          'WATCH',
          'warning',
          `Drainage rate reduced to ${pct}% of baseline (${data.rod_cm_min.toFixed(2)} cm/min). Monitor closely.`,
          60 // dedupe: 60 minutes
        );

        if (alert) {
          await sendTelegramAlert(
            `🟡 *WATCH* — Device \`${data.device_id}\`\n` +
            `RoD: ${data.rod_cm_min.toFixed(2)} cm/min (${pct}% of baseline)\n` +
            `Drain is slowing — monitor closely.`
          );
        }

      } else if (data.status === 'CLEAR') {
        // Good news: drain is clear — resolve any open blockage alerts
        await resolveAlerts(data.device_id, ['PRE_CLOG', 'WATCH']);
      }

      return res.json({ ok: true });
    }

    // ── Handle "sensor_fault" ─────────────────────────────────
    if (type === 'sensor_fault') {
      const data = sensorFaultSchema.parse(body);

      const alert = await createAlert(
        data.device_id,
        'SENSOR_FAULT',
        'warning',
        `Sensor fault reported by device ${data.device_id}.`,
        60 // dedupe: 60 minutes
      );

      if (alert) {
        await sendTelegramAlert(
          `⚠️ *SENSOR FAULT* — Device \`${data.device_id}\`\n` +
          `The sensor has reported a hardware fault.`
        );
      }

      return res.json({ ok: true });
    }

    // Unknown message type
    return res.status(400).json({
      error: `Unknown message type: "${type}". Expected reading, heartbeat, rod_result, or sensor_fault.`,
    });

  } catch (err) {
    // Pass any error (including ZodError) to the central error handler
    next(err);
  }
});

module.exports = router;
