// ============================================================
// middleware/auth.js - Authentication Middleware
// Provides two middleware functions:
//   1. requireDeviceKey  - for IoT device endpoints
//   2. requireAdminKey   - for admin dashboard endpoints
//
// Middleware functions run BEFORE the route handler.
// If authentication fails they send a 401 and stop the chain.
// If authentication passes they call next() to continue.
// ============================================================

/**
 * requireDeviceKey
 * IoT devices must include their API key in the x-api-key header.
 * This prevents unauthorized devices from pushing fake data.
 */
function requireDeviceKey(req, res, next) {
  const providedKey = req.headers['x-api-key'];

  // Compare against the secret key stored in our environment variables
  if (providedKey !== process.env.DEVICE_API_KEY) {
    return res.status(401).json({
      error: 'Unauthorized: invalid or missing x-api-key header',
    });
  }

  // Key is valid — pass control to the next middleware or route handler
  next();
}

/**
 * requireAdminKey
 * Admin actions (acknowledging alerts, changing settings) require
 * the admin password sent as the x-admin-key header.
 */
function requireAdminKey(req, res, next) {
  const providedKey = req.headers['x-admin-key'];

  if (providedKey !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      error: 'Unauthorized: invalid or missing x-admin-key header',
    });
  }

  next();
}

module.exports = { requireDeviceKey, requireAdminKey };
