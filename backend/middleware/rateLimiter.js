// ============================================================
// middleware/rateLimiter.js - Rate Limiting for Device Ingestion
// Prevents a single IP address from flooding the ingestion
// endpoint with too many requests (DoS protection, and also
// protects against runaway firmware loops).
//
// Limit: 100 requests per minute per IP address.
// ============================================================

const rateLimit = require('express-rate-limit');

// rateLimit() returns a middleware function.
// windowMs: the time window in milliseconds (1 minute here)
// max:       maximum number of requests allowed in that window
const deviceIngestLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute in milliseconds
  max: 100,            // allow up to 100 requests per minute per IP

  // Human-friendly error message returned when limit is exceeded
  message: {
    error: 'Too many requests from this IP. Please slow down.',
  },

  // Use standard rate-limit headers (RateLimit-Limit, RateLimit-Remaining, etc.)
  standardHeaders: true,

  // Disable the older X-RateLimit-* headers to avoid duplication
  legacyHeaders: false,
});

module.exports = deviceIngestLimiter;
