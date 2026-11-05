// ============================================================
// server.js - DrainGuard Backend Entry Point
// This is the first file Node.js runs. It sets up all the
// middleware, mounts all the routes, and starts the server.
// ============================================================

// Load environment variables from .env file FIRST before anything else
require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const cron    = require('node-cron');

// Import our route handlers
const ingestRouter      = require('./routes/ingest');
const devicesRouter     = require('./routes/devices');
const deviceConfigRouter= require('./routes/deviceConfig');
const readingsRouter    = require('./routes/readings');
const rodEventsRouter   = require('./routes/rodEvents');
const analyticsRouter   = require('./routes/analytics');
const alertsRouter      = require('./routes/alerts');
const exportRouter      = require('./routes/export');
const adminRouter       = require('./routes/admin');

// Import the offline checker job
const { startOfflineChecker } = require('./jobs/offlineChecker');

// ─── 1. Environment Variable Validation ─────────────────────
// Make sure all required env vars are present before starting.
// If any are missing, log a helpful error and exit immediately
// (better to crash early than fail silently later).
const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'DEVICE_API_KEY',
  'ADMIN_PASSWORD',
  'FRONTEND_ORIGIN',
];

const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('❌  Missing required environment variables:');
  missingVars.forEach(v => console.error(`    - ${v}`));
  console.error('👉  Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

// ─── 2. Create Express App ───────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3001;

// ─── 3. Security Middleware: Helmet ─────────────────────────
// Helmet sets various HTTP response headers that protect against
// common web vulnerabilities (XSS, clickjacking, etc.)
app.use(helmet());

// ─── 4. CORS Middleware ──────────────────────────────────────
// Cross-Origin Resource Sharing: only allow requests from our
// frontend's origin, so random websites can't call our API.
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-admin-key'],
}));

// ─── 5. JSON Body Parsing ────────────────────────────────────
// Parse incoming request bodies as JSON so we can read req.body
app.use(express.json());

// ─── 6. Health Check Endpoint ────────────────────────────────
// Simple endpoint to verify the server is running (no auth needed)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ─── 7. Mount Route Modules ──────────────────────────────────
// Each router handles a specific set of related endpoints.
// All are prefixed with /api.
app.use('/api',           ingestRouter);       // POST /api/ingest
app.use('/api',           deviceConfigRouter); // GET  /api/device/config
app.use('/api/devices',   devicesRouter);      // GET  /api/devices, /api/devices/:id/...
app.use('/api/readings',  readingsRouter);     // GET  /api/readings
app.use('/api/rod-events',rodEventsRouter);    // GET  /api/rod-events
app.use('/api/analytics', analyticsRouter);    // GET  /api/analytics/...
app.use('/api/alerts',    alertsRouter);       // GET/POST /api/alerts/...
app.use('/api/export',    exportRouter);       // GET  /api/export/...
// adminRouter handles:
//   POST /api/admin/verify                    — password check
//   POST /api/devices/:id/calibrate           — trigger calibration
//   PUT  /api/devices/:id/settings            — update settings
app.use('/api',           adminRouter);
// ─── 8. 404 Handler ─────────────────────────────────────────
// If no route matched, send a friendly 404 JSON response
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ─── 9. Central Error Handler ────────────────────────────────
// All routes call next(err) when something goes wrong.
// This single handler catches all errors and formats them as JSON.
// Express identifies error handlers by their 4-argument signature.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('❌  Unhandled error:', err.message || err);

  // Zod validation errors have a special shape
  if (err.name === 'ZodError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.errors, // array of field-level errors
    });
  }

  // Generic server error
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    error: err.message || 'Internal server error',
  });
});

// ─── 10. Background Jobs ─────────────────────────────────────
// Start the cron job that checks for offline devices every minute.
startOfflineChecker();

// ─── 11. Start Listening ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀  DrainGuard backend running on port ${PORT}`);
  console.log(`    Frontend origin: ${process.env.FRONTEND_ORIGIN}`);
  console.log(`    Health check:    http://localhost:${PORT}/api/health`);
});
