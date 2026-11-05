#!/usr/bin/env node
/**
 * DrainGuard - Demo Data Seeder
 * Seeds 90 days of realistic demo data into Supabase for device 'drain-demo'.
 *
 * Usage:
 *   node ../scripts/seed-demo.js           # seed data
 *   node ../scripts/seed-demo.js --reset   # delete all drain-demo data and exit
 *
 * Run from: backend/
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../backend/.env') });

const { createClient } = require('@supabase/supabase-js');

// ─── Supabase client ─────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ─── Constants ────────────────────────────────────────────────────────────────
const DEVICE_ID = 'drain-demo';
const BASELINE_ROD = 2.0;       // cm/min
const CLEAR_RATIO = 0.8;
const PRECLOG_RATIO = 0.5;
const DAYS = 90;
const BATCH_SIZE = 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

function jitter(value, pct) {
  // ± pct of value
  return value * (1 + rand(-pct, pct));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Insert rows in batches of BATCH_SIZE */
async function batchInsert(table, rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) {
      console.error(`  ✗ Insert into ${table} failed (batch ${i / BATCH_SIZE + 1}):`, error.message);
      throw error;
    }
    // small pause to avoid rate-limiting
    await sleep(50);
  }
}

// ─── Reset ────────────────────────────────────────────────────────────────────
async function reset() {
  console.log(`\n⚠️  Resetting all data for device '${DEVICE_ID}'...\n`);

  const tables = ['alerts', 'rod_events', 'readings', 'device_config', 'devices'];
  for (const table of tables) {
    if (table === 'devices' || table === 'device_config') {
      const { error } = await supabase.from(table).delete().eq(
        table === 'devices' ? 'id' : 'device_id',
        DEVICE_ID
      );
      if (error) console.warn(`  ⚠ Could not delete from ${table}:`, error.message);
      else console.log(`  ✓ Cleared ${table}`);
    } else {
      const { error } = await supabase.from(table).delete().eq('device_id', DEVICE_ID);
      if (error) console.warn(`  ⚠ Could not delete from ${table}:`, error.message);
      else console.log(`  ✓ Cleared ${table}`);
    }
  }
  console.log('\n✅ Reset complete. Exiting.\n');
}

// ─── Main seeder ─────────────────────────────────────────────────────────────
async function seed() {
  const stats = {
    readings: 0,
    rod_events: 0,
    alerts: 0,
    rainDays: 0,
  };

  const now = Date.now();
  const startMs = now - DAYS * 24 * 60 * 60 * 1000;

  // ── 1. Upsert device ──────────────────────────────────────────────────────
  console.log('\n📡 Upserting device...');
  {
    const { error } = await supabase.from('devices').upsert({
      id: DEVICE_ID,
      name: 'Demo Drain - Anna Nagar',
      location: 'Anna Nagar, Chennai',
      lat: 13.0878,
      lng: 80.2101,
    }, { onConflict: 'id' });
    if (error) throw new Error('Device upsert failed: ' + error.message);
    console.log('  ✓ Device upserted');
  }

  // ── 2. Upsert device_config ───────────────────────────────────────────────
  console.log('⚙️  Upserting device_config...');
  {
    const { error } = await supabase.from('device_config').upsert({
      device_id: DEVICE_ID,
      baseline_rod: BASELINE_ROD,
      calibrate: false,
      clear_ratio: CLEAR_RATIO,
      preclog_ratio: PRECLOG_RATIO,
      sensor_to_bottom_cm: 60,
      rain_start_cm: 10,
      offline_after_min: 15,
    }, { onConflict: 'device_id' });
    if (error) throw new Error('device_config upsert failed: ' + error.message);
    console.log('  ✓ device_config upserted');
  }

  // ── 3. Plan rain events ───────────────────────────────────────────────────
  console.log('\n🌧️  Planning rain events...');

  // Build a set of "rain days" — roughly every 2–4 days
  const rainDaySet = new Set();
  for (let d = 0; d < DAYS; ) {
    rainDaySet.add(d);
    d += randInt(2, 4);
  }
  const rainDays = [...rainDaySet].sort((a, b) => a - b);
  console.log(`  ✓ ${rainDays.length} rain events planned across ${DAYS} days`);
  stats.rainDays = rainDays.length;

  // ── 4. Generate all data ──────────────────────────────────────────────────
  console.log('\n📊 Generating readings, rod_events, and alerts...\n');

  const allReadings = [];
  const allRodEvents = [];
  const allAlerts = [];

  // Track which minute offsets have readings to avoid duplicates
  const coveredMinutes = new Set(); // ms timestamps (minute-level)

  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const dayStart = startMs + dayIdx * 24 * 60 * 60 * 1000;
    const dayEnd   = dayStart + 24 * 60 * 60 * 1000;
    const isRainDay = rainDaySet.has(dayIdx);

    // ── 4a. Degradation factor (day 0 → 100%, day 89 → 45%) ───────────────
    // Linear interpolation with ±10% noise
    const baseDegradation = 1.0 - (dayIdx / (DAYS - 1)) * (1.0 - 0.45);
    const degradation = Math.max(0.1, jitter(baseDegradation, 0.10));
    const rod_cm_min = +(BASELINE_ROD * degradation).toFixed(3);

    if (isRainDay) {
      // ── 4b. Pick a random time for rain onset ─────────────────────────
      const rainOnsetOffset = randInt(0, 20 * 60) * 60 * 1000; // random in first 20h
      const rainOnsetMs = dayStart + rainOnsetOffset;

      // Peak water level increases then decreases slightly (some variance)
      const H1 = rand(20, 45);   // peak water level
      const H2 = rand(3, 7);     // settled water level
      const risingMinutes = randInt(20, 30);

      // Duration of falling phase: (H1-H2)/rod_cm_min minutes
      const fallingMinutes = Math.round((H1 - H2) / rod_cm_min);

      // ── 4c. Rising phase readings ──────────────────────────────────────
      for (let m = 0; m < risingMinutes; m++) {
        const ts = new Date(rainOnsetMs + m * 60 * 1000);
        const frac = m / risingMinutes;
        const water_cm = +(jitter(5 + (H1 - 5) * frac, 0.05)).toFixed(2);
        const state = water_cm >= H1 * 0.85 ? 'PEAK' : 'RAIN';
        coveredMinutes.add(Math.floor(ts.getTime() / 60000));
        allReadings.push({
          device_id: DEVICE_ID,
          created_at: ts.toISOString(),
          type: 'reading',
          state,
          distance_cm: +(60 - water_cm).toFixed(2),
          water_cm,
          flood_risk: water_cm > 50,
          rssi: randInt(-75, -55),
          uptime_s: randInt(1000, 100000),
        });
      }

      // ── 4d. Falling phase readings ─────────────────────────────────────
      for (let m = 0; m < fallingMinutes; m++) {
        const ts = new Date(rainOnsetMs + (risingMinutes + m) * 60 * 1000);
        const frac = m / fallingMinutes;
        const water_cm = +(H1 - (H1 - H2) * frac + jitter(0, 0.03)).toFixed(2);
        coveredMinutes.add(Math.floor(ts.getTime() / 60000));
        allReadings.push({
          device_id: DEVICE_ID,
          created_at: ts.toISOString(),
          type: 'reading',
          state: 'ROD',
          distance_cm: +(60 - Math.max(H2, water_cm)).toFixed(2),
          water_cm: Math.max(H2, water_cm),
          flood_risk: false,
          rssi: randInt(-75, -55),
          uptime_s: randInt(1000, 100000),
        });
      }

      // ── 4e. Determine status ───────────────────────────────────────────
      const ratio = +(rod_cm_min / BASELINE_ROD).toFixed(3);
      let status;
      if (ratio >= CLEAR_RATIO)        status = 'CLEAR';
      else if (ratio >= PRECLOG_RATIO) status = 'WATCH';
      else                             status = 'PRE_CLOG';

      // ── 4f. rod_event ──────────────────────────────────────────────────
      const eventTs = new Date(rainOnsetMs + (risingMinutes + fallingMinutes) * 60 * 1000);
      const duration_s = Math.round(fallingMinutes * 60);
      allRodEvents.push({
        device_id: DEVICE_ID,
        created_at: eventTs.toISOString(),
        h1_cm: +H1.toFixed(2),
        h2_cm: +H2.toFixed(2),
        duration_s,
        rod_cm_min,
        baseline_rod: BASELINE_ROD,
        ratio,
        status,
        calibration: false,
        low_confidence: false,
      });
      stats.rod_events++;

      // ── 4g. Alerts ─────────────────────────────────────────────────────
      if (status === 'WATCH' || status === 'PRE_CLOG') {
        const pct = Math.round(ratio * 100);
        allAlerts.push({
          device_id: DEVICE_ID,
          created_at: eventTs.toISOString(),
          type: status === 'PRE_CLOG' ? 'PRE_CLOG' : 'WATCH',
          severity: status === 'PRE_CLOG' ? 'critical' : 'warning',
          message: status === 'PRE_CLOG'
            ? `Maintenance Required: Partial Blockage detected (RoD ${rod_cm_min.toFixed(2)} cm/min = ${pct}% of baseline).`
            : `Drainage rate reduced to ${pct}% of baseline (${rod_cm_min.toFixed(2)} cm/min). Monitor closely.`,
          status: 'open',
        });
        stats.alerts++;
      }

      // ── 4h. Heartbeats for the rest of the day (non-rain minutes) ──────
      const eventEndMs = rainOnsetMs + (risingMinutes + fallingMinutes) * 60 * 1000;
      // Hourly heartbeats for hours before and after the event
      for (let hourMs = dayStart; hourMs < dayEnd; hourMs += 60 * 60 * 1000) {
        const minKey = Math.floor(hourMs / 60000);
        if (!coveredMinutes.has(minKey)) {
          coveredMinutes.add(minKey);
          const water = +rand(2, 4).toFixed(2);
          allReadings.push({
            device_id: DEVICE_ID,
            created_at: new Date(hourMs).toISOString(),
            type: 'heartbeat',
            state: 'IDLE',
            distance_cm: +(60 - water).toFixed(2),
            water_cm: water,
            flood_risk: false,
            rssi: randInt(-75, -55),
            uptime_s: randInt(1000, 100000),
          });
        }
      }
    } else {
      // ── 4i. Non-rain day: hourly heartbeats ────────────────────────────
      for (let hourMs = dayStart; hourMs < dayEnd; hourMs += 60 * 60 * 1000) {
        const minKey = Math.floor(hourMs / 60000);
        coveredMinutes.add(minKey);
        const water = +rand(2, 4).toFixed(2);
        allReadings.push({
          device_id: DEVICE_ID,
          created_at: new Date(hourMs).toISOString(),
          type: 'heartbeat',
          state: 'IDLE',
          distance_cm: +(60 - water).toFixed(2),
          water_cm: water,
          flood_risk: false,
          rssi: randInt(-75, -55),
          uptime_s: randInt(1000, 100000),
        });
      }
    }

    // Progress
    if ((dayIdx + 1) % 10 === 0 || dayIdx === DAYS - 1) {
      process.stdout.write(`  Day ${dayIdx + 1}/${DAYS} | readings buffered: ${allReadings.length}\r`);
    }
  }

  console.log('\n');

  // ── 5. Insert in batches ───────────────────────────────────────────────────
  stats.readings = allReadings.length;

  console.log(`📥 Inserting ${allReadings.length} readings...`);
  await batchInsert('readings', allReadings);
  console.log(`  ✓ ${allReadings.length} readings inserted`);

  console.log(`📥 Inserting ${allRodEvents.length} rod_events...`);
  await batchInsert('rod_events', allRodEvents);
  console.log(`  ✓ ${allRodEvents.length} rod_events inserted`);

  if (allAlerts.length > 0) {
    console.log(`📥 Inserting ${allAlerts.length} alerts...`);
    await batchInsert('alerts', allAlerts);
    console.log(`  ✓ ${allAlerts.length} alerts inserted`);
  }

  // Update last_seen so the demo device appears online in the dashboard
  await supabase
    .from('devices')
    .update({ last_seen: new Date().toISOString() })
    .eq('id', DEVICE_ID);
  console.log(`  ✓ Device last_seen updated to now`);

  // ── 6. Summary ─────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║          Seed Summary - DrainGuard       ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Device        : ${DEVICE_ID.padEnd(24)}║`);
  console.log(`║  Period        : ${DAYS} days${' '.repeat(19)}║`);
  console.log(`║  Rain events   : ${String(stats.rainDays).padEnd(24)}║`);
  console.log(`║  Readings      : ${String(stats.readings).padEnd(24)}║`);
  console.log(`║  Rod events    : ${String(stats.rod_events).padEnd(24)}║`);
  console.log(`║  Alerts        : ${String(stats.alerts).padEnd(24)}║`);
  console.log('╚══════════════════════════════════════════╝\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────
(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\n✗ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in backend/.env\n');
    process.exit(1);
  }

  const doReset = process.argv.includes('--reset');

  if (doReset) {
    await reset();
    process.exit(0);
  }

  console.log('🚀 DrainGuard Demo Seeder\n' + '='.repeat(42));
  try {
    await seed();
    console.log('✅ Seeding complete!\n');
  } catch (err) {
    console.error('\n✗ Seeding failed:', err.message);
    process.exit(1);
  }
})();
