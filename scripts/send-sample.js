#!/usr/bin/env node
/**
 * DrainGuard - ESP32 Payload Simulator
 * Sends a sequence of sample payloads to the DrainGuard backend.
 *
 * Usage:
 *   node send-sample.js
 *   node send-sample.js --url http://localhost:3001
 *   node send-sample.js --url https://drainguard-backend.onrender.com --key your-api-key
 */

'use strict';

const https = require('node:https');
const http  = require('node:http');
const { URL } = require('node:url');

// ─── Parse CLI args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const BASE_URL = getArg('--url') || 'http://localhost:3001';
const API_KEY  = getArg('--key') || 'changeme';

// ─── Sample payloads ──────────────────────────────────────────────────────────
const payloads = [
  {
    label: '1. Heartbeat (IDLE)',
    endpoint: '/api/ingest',
    body: {
      device_id:   'drain-01',
      type:        'heartbeat',
      state:       'IDLE',
      water_cm:    3.5,
      distance_cm: 56.5,
      flood_risk:  false,
      rssi:        -65,
      uptime_s:    3600,
    },
  },
  {
    label: '2. Reading (RAIN)',
    endpoint: '/api/ingest',
    body: {
      device_id:   'drain-01',
      type:        'reading',
      state:       'RAIN',
      water_cm:    15.2,
      distance_cm: 44.8,
      flood_risk:  false,
      rssi:        -65,
      uptime_s:    3660,
    },
  },
  {
    label: '3. Reading (PEAK)',
    endpoint: '/api/ingest',
    body: {
      device_id:   'drain-01',
      type:        'reading',
      state:       'PEAK',
      water_cm:    32.1,
      distance_cm: 27.9,
      flood_risk:  false,
      rssi:        -63,
      uptime_s:    3720,
    },
  },
  {
    label: '4. rod_result → CLEAR',
    endpoint: '/api/ingest',
    body: {
      device_id:   'drain-01',
      type:        'rod_result',
      state:       'DECISION',
      h1_cm:       32.1,
      h2_cm:       5.0,
      duration_s:  820,
      rod_cm_min:  1.98,
      baseline_rod: 2.0,
      ratio:       0.99,
      status:      'CLEAR',
      calibration: false,
      rssi:        -63,
    },
  },
  {
    label: '5. rod_result → PRE_CLOG',
    endpoint: '/api/ingest',
    body: {
      device_id:   'drain-01',
      type:        'rod_result',
      state:       'DECISION',
      h1_cm:       28.5,
      h2_cm:       5.0,
      duration_s:  2100,
      rod_cm_min:  0.67,
      baseline_rod: 2.0,
      ratio:       0.335,
      status:      'PRE_CLOG',
      calibration: false,
      rssi:        -70,
    },
  },
  {
    label: '6. rod_result → CALIBRATION',
    endpoint: '/api/ingest',
    body: {
      device_id:   'drain-01',
      type:        'rod_result',
      state:       'DECISION',
      h1_cm:       30.0,
      h2_cm:       5.0,
      duration_s:  750,
      rod_cm_min:  2.0,
      baseline_rod: 0,
      ratio:       1.0,
      status:      'CALIBRATED',
      calibration: true,
      rssi:        -62,
    },
  },
  {
    label: '7. sensor_fault',
    endpoint: '/api/ingest',
    body: {
      device_id: 'drain-01',
      type:      'sensor_fault',
      state:     'IDLE',
    },
  },
];

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function request(method, urlStr, body, apiKey) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      return reject(new Error('Invalid URL: ' + urlStr));
    }

    const payload = JSON.stringify(body);
    const lib = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key':      apiKey,
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🚰 DrainGuard – ESP32 Payload Simulator');
  console.log('='.repeat(50));
  console.log(`  Target : ${BASE_URL}`);
  console.log(`  API Key: ${API_KEY.slice(0, 4)}${'*'.repeat(Math.max(0, API_KEY.length - 4))}`);
  console.log('='.repeat(50) + '\n');

  for (const { label, endpoint, body } of payloads) {
    const url = BASE_URL.replace(/\/$/, '') + endpoint;
    console.log(`▶ Sending: ${label}`);
    console.log(`  POST ${url}`);
    console.log(`  Payload: ${JSON.stringify(body)}`);

    try {
      const { status, body: respBody } = await request('POST', url, body, API_KEY);

      let pretty;
      try {
        pretty = JSON.stringify(JSON.parse(respBody), null, 2)
          .split('\n').map(l => '  ' + l).join('\n');
      } catch {
        pretty = '  ' + respBody;
      }

      const icon = status >= 200 && status < 300 ? '✅' : '❌';
      console.log(`  ${icon} HTTP ${status}`);
      console.log(pretty);
    } catch (err) {
      console.log(`  ❌ Request failed: ${err.message}`);
    }

    console.log();
    await sleep(1000);
  }

  console.log('✅ All payloads sent.\n');
})();
