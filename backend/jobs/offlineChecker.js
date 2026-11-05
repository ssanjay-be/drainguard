// ============================================================
// jobs/offlineChecker.js - Offline Device Monitor (Cron Job)
//
// This module exports startOfflineChecker(), which sets up a
// cron job that runs every minute to check whether any devices
// have stopped sending data.
//
// If a device hasn't sent any data for longer than its configured
// offline_after_min threshold, a DEVICE_OFFLINE warning alert is
// created (with deduplication so we don't spam alerts).
//
// When a device comes back online, any open DEVICE_OFFLINE alerts
// for it are automatically resolved.
// ============================================================

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { sendTelegramAlert } = require('../lib/telegram');

/**
 * Starts the background cron job that monitors device connectivity.
 * Call this once at server startup.
 */
function startOfflineChecker() {
  // Schedule: run every minute ('* * * * *' = "at every minute")
  cron.schedule('* * * * *', async () => {
    try {
      // ── Fetch all devices ───────────────────────────────
      const { data: devices, error: devicesError } = await supabase
        .from('devices')
        .select('id, name, last_seen');

      if (devicesError) {
        console.error('⚠️  offlineChecker: failed to fetch devices:', devicesError.message);
        return;
      }

      const now = Date.now();

      // ── Check each device ───────────────────────────────
      for (const device of devices) {
        // Get this device's offline threshold from device_config
        const { data: config } = await supabase
          .from('device_config')
          .select('offline_after_min')
          .eq('device_id', device.id)
          .single();

        const offlineAfterMin = config?.offline_after_min ?? 10;
        const thresholdMs     = offlineAfterMin * 60 * 1000;

        const lastSeen    = device.last_seen ? new Date(device.last_seen).getTime() : 0;
        const msSinceSeen = now - lastSeen;
        const isOffline   = msSinceSeen > thresholdMs;

        if (isOffline) {
          // ── Device is offline ─────────────────────────
          // Check if there's already an open DEVICE_OFFLINE alert for this device
          const { data: existingAlerts } = await supabase
            .from('alerts')
            .select('id')
            .eq('device_id', device.id)
            .eq('type', 'DEVICE_OFFLINE')
            .eq('status', 'open')
            .limit(1);

          // Only create a new alert if one doesn't already exist
          if (!existingAlerts || existingAlerts.length === 0) {
            const minutesOffline = Math.round(msSinceSeen / 60000);

            const { error: insertError } = await supabase
              .from('alerts')
              .insert({
                device_id: device.id,
                type:      'DEVICE_OFFLINE',
                severity:  'warning',
                message:   `Device ${device.name || device.id} has been offline for ~${minutesOffline} minutes (threshold: ${offlineAfterMin} min).`,
                status:    'open',
              });

            if (insertError) {
              console.error(`⚠️  offlineChecker: failed to create alert for ${device.id}:`, insertError.message);
            } else {
              console.log(`📴  offlineChecker: DEVICE_OFFLINE alert created for ${device.id}`);
              // Send Telegram notification
              await sendTelegramAlert(
                `📴 *DEVICE OFFLINE* — \`${device.id}\`\n` +
                `No data received for ~${minutesOffline} minutes.`
              );
            }
          }

        } else {
          // ── Device is online ──────────────────────────
          // If there are any open DEVICE_OFFLINE alerts, resolve them
          // because the device has come back online.
          const { data: openOfflineAlerts } = await supabase
            .from('alerts')
            .select('id')
            .eq('device_id', device.id)
            .eq('type', 'DEVICE_OFFLINE')
            .eq('status', 'open');

          if (openOfflineAlerts && openOfflineAlerts.length > 0) {
            await supabase
              .from('alerts')
              .update({
                status:      'resolved',
                resolved_at: new Date().toISOString(),
              })
              .eq('device_id', device.id)
              .eq('type', 'DEVICE_OFFLINE')
              .eq('status', 'open');

            console.log(`✅  offlineChecker: Device ${device.id} came back online — DEVICE_OFFLINE alert resolved.`);
          }
        }
      }

    } catch (err) {
      // Don't let cron job errors crash the server
      console.error('❌  offlineChecker: unexpected error:', err.message);
    }
  });

  console.log('⏰  offlineChecker: started (runs every minute)');
}

module.exports = { startOfflineChecker };
