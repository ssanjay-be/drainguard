// ============================================================
// api.js - DrainGuard Frontend API Client
// ============================================================
// Handles all HTTP communication with the DrainGuard backend.
// Configured via window.APP_CONFIG.API_BASE_URL.
// Includes automatic retry logic for free-tier cloud cold starts.
// ============================================================

window.API = (function() {
  'use strict';

  /**
   * Helper: Get active API Base URL from config
   */
  function getBaseUrl() {
    return (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || 'http://localhost:3001';
  }

  /**
   * Helper: Build URL query string from an object.
   * Strips undefined, null, and empty string properties.
   *
   * @param {Object} params - Query parameters object
   * @returns {string} Formatted query string (without leading ?)
   */
  function buildQuery(params) {
    if (!params || typeof params !== 'object') return '';
    const searchParams = new URLSearchParams();
    Object.keys(params).forEach(key => {
      const val = params[key];
      if (val !== undefined && val !== null && val !== '') {
        searchParams.append(key, val);
      }
    });
    return searchParams.toString();
  }

  /**
   * Helper: Delay promise for retry backoff
   * @param {number} ms - Milliseconds to sleep
   */
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Cold-start retry mechanism:
   * Retries on network disconnection / fetch failure (common during Render server spin-up).
   *
   * @param {string} url - Target URL
   * @param {Object} options - Fetch options (method, headers, body)
   * @param {number} retries - Maximum retry count (default 3)
   * @param {number} delayMs - Delay between attempts (default 5000ms)
   * @returns {Promise<Response>} Fetch Response object
   */
  async function fetchWithRetry(url, options = {}, retries = 3, delayMs = 5000) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, options);

        // If the server responded with 502/503/504 while waking up, treat as retryable
        if ([502, 503, 504].includes(response.status) && attempt < retries) {
          console.warn(`[API] Server waking up (${response.status}). Retrying in ${delayMs / 1000}s... (attempt ${attempt + 1}/${retries})`);
          await delay(delayMs);
          continue;
        }

        // On any successful response (or standard HTTP error), server is awake
        if (window.onServerAwake && typeof window.onServerAwake === 'function') {
          window.onServerAwake();
        }

        return response;
      } catch (err) {
        lastError = err;
        console.warn(`[API] Network error calling ${url}: ${err.message}. (attempt ${attempt + 1}/${retries})`);
        if (attempt < retries) {
          await delay(delayMs);
        }
      }
    }

    throw lastError || new Error(`Network request failed after ${retries} attempts`);
  }

  /**
   * Helper: Send JSON request and parse result
   */
  async function jsonRequest(endpoint, options = {}) {
    const url = `${getBaseUrl()}${endpoint}`;
    const defaultHeaders = {
      'Accept': 'application/json'
    };

    if (options.body && typeof options.body === 'string') {
      defaultHeaders['Content-Type'] = 'application/json';
    }

    const finalOptions = {
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {})
      }
    };

    const response = await fetchWithRetry(url, finalOptions);

    // Read response body as JSON (or handle non-JSON error gracefully)
    let body;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      const text = await response.text();
      body = { error: text || `HTTP ${response.status} ${response.statusText}` };
    }

    if (!response.ok) {
      const errorMsg = (body && body.error) || `Request failed with status ${response.status}`;
      const error = new Error(errorMsg);
      error.status = response.status;
      error.details = body && body.details;
      throw error;
    }

    return body;
  }

  // ─── Public API Client Methods ──────────────────────────────

  /**
   * 1. GET /api/health
   * Verifies backend connectivity and DB health
   */
  async function getHealth() {
    return jsonRequest('/api/health');
  }

  /**
   * 2. GET /api/devices
   * Retrieves list of registered drain monitoring devices
   */
  async function getDevices() {
    return jsonRequest('/api/devices');
  }

  /**
   * 3. GET /api/devices/:id/overview
   * Fetches full dashboard overview payload for a single device:
   * current reading, latest rod_event, config thresholds, today counters
   */
  async function getDeviceOverview(deviceId) {
    if (!deviceId) throw new Error('deviceId is required');
    return jsonRequest(`/api/devices/${encodeURIComponent(deviceId)}/overview`);
  }

  /**
   * 4. GET /api/readings
   * Fetches raw sensor telemetry readings
   * @param {Object} params - { device_id, limit, start_time, end_time, type }
   */
  async function getReadings(params = {}) {
    const qs = buildQuery(params);
    return jsonRequest(`/api/readings${qs ? '?' + qs : ''}`);
  }

  /**
   * 5. GET /api/rod-events
   * Fetches computed rate-of-drop (ROD) events
   * @param {Object} params - { device_id, limit, status, start_time, end_time }
   */
  async function getRodEvents(params = {}) {
    const qs = buildQuery(params);
    return jsonRequest(`/api/rod-events${qs ? '?' + qs : ''}`);
  }

  /**
   * 6. GET /api/analytics/summary
   * Fetches aggregated metrics (Total events, Clear %, avg RoD, alerts count)
   * @param {string} deviceId - Target device ID
   * @param {number} days - Time window in days (7, 30, 90)
   */
  async function getAnalyticsSummary(deviceId, days = 30) {
    const qs = buildQuery({ device_id: deviceId, days: days });
    return jsonRequest(`/api/analytics/summary?${qs}`);
  }

  /**
   * 7. GET /api/analytics/trend
   * Fetches time-bucketed trend series and projection insights
   * @param {string} deviceId - Target device ID
   * @param {number} days - Time window in days
   */
  async function getAnalyticsTrend(deviceId, days = 30) {
    const qs = buildQuery({ device_id: deviceId, days: days });
    return jsonRequest(`/api/analytics/trend?${qs}`);
  }

  /**
   * 8. GET /api/alerts
   * Retrieves operator alert records
   * @param {Object} params - { device_id, status, severity, limit }
   */
  async function getAlerts(params = {}) {
    const qs = buildQuery(params);
    return jsonRequest(`/api/alerts${qs ? '?' + qs : ''}`);
  }

  /**
   * 9. POST /api/alerts/:id/ack
   * Acknowledges an alert (marks status as 'acknowledged')
   * Requires x-admin-key header
   */
  async function ackAlert(id, adminKey) {
    if (!id) throw new Error('Alert id is required');
    return jsonRequest(`/api/alerts/${encodeURIComponent(id)}/ack`, {
      method: 'POST',
      headers: {
        'x-admin-key': adminKey || ''
      }
    });
  }

  /**
   * 10. POST /api/alerts/:id/resolve
   * Resolves an alert (marks status as 'resolved')
   * Requires x-admin-key header
   */
  async function resolveAlert(id, adminKey) {
    if (!id) throw new Error('Alert id is required');
    return jsonRequest(`/api/alerts/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: {
        'x-admin-key': adminKey || ''
      }
    });
  }

  /**
   * 11. POST /api/admin/verify
   * Verifies admin password
   * @param {string} password - Master admin password
   */
  async function verifyAdmin(password) {
    try {
      return await jsonRequest('/api/admin/verify', {
        method: 'POST',
        body: JSON.stringify({ password: password })
      });
    } catch (err) {
      if (err.status === 404) {
        return await jsonRequest('/api/admin/login', {
          method: 'POST',
          body: JSON.stringify({ password: password })
        });
      }
      throw err;
    }
  }

  /**
   * 12. POST /api/devices/:id/calibrate
   * Triggers a calibration cycle for a drain device
   * Requires x-admin-key header
   */
  async function calibrateDevice(deviceId, adminKey) {
    if (!deviceId) throw new Error('deviceId is required');
    try {
      return await jsonRequest(`/api/devices/${encodeURIComponent(deviceId)}/calibrate`, {
        method: 'POST',
        headers: {
          'x-admin-key': adminKey || ''
        }
      });
    } catch (err) {
      if (err.status === 404) {
        // Fallback to /api/admin/devices/:id/calibrate if mounted under admin router
        return await jsonRequest(`/api/admin/devices/${encodeURIComponent(deviceId)}/calibrate`, {
          method: 'POST',
          headers: {
            'x-admin-key': adminKey || ''
          }
        });
      }
      throw err;
    }
  }

  /**
   * 13. PUT /api/devices/:id/settings
   * Updates device configuration thresholds and physical depth parameters
   * Requires x-admin-key header
   */
  async function updateDeviceSettings(deviceId, settings, adminKey) {
    if (!deviceId) throw new Error('deviceId is required');
    try {
      return await jsonRequest(`/api/devices/${encodeURIComponent(deviceId)}/settings`, {
        method: 'PUT',
        headers: {
          'x-admin-key': adminKey || ''
        },
        body: JSON.stringify(settings)
      });
    } catch (err) {
      if (err.status === 404) {
        // Fallback to /api/admin/devices/:id/settings if mounted under admin router
        return await jsonRequest(`/api/admin/devices/${encodeURIComponent(deviceId)}/settings`, {
          method: 'PUT',
          headers: {
            'x-admin-key': adminKey || ''
          },
          body: JSON.stringify(settings)
        });
      }
      throw err;
    }
  }

  /**
   * 14. GET /api/export/readings.csv
   * Downloads raw readings as a CSV Blob
   */
  async function exportReadings(params = {}) {
    const qs = buildQuery(params);
    const url = `${getBaseUrl()}/api/export/readings.csv${qs ? '?' + qs : ''}`;
    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw new Error(`Export readings failed: ${response.statusText}`);
    }
    return response.blob();
  }

  /**
   * 15. GET /api/export/rod-events.csv
   * Downloads rate of drop events as a CSV Blob
   */
  async function exportRodEvents(params = {}) {
    const qs = buildQuery(params);
    const url = `${getBaseUrl()}/api/export/rod-events.csv${qs ? '?' + qs : ''}`;
    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw new Error(`Export rod events failed: ${response.statusText}`);
    }
    return response.blob();
  }

  // Export public interface
  return {
    getBaseUrl: getBaseUrl,
    buildQuery: buildQuery,
    fetchWithRetry: fetchWithRetry,
    getHealth: getHealth,
    getDevices: getDevices,
    getDeviceOverview: getDeviceOverview,
    getReadings: getReadings,
    getRodEvents: getRodEvents,
    getAnalyticsSummary: getAnalyticsSummary,
    getAnalyticsTrend: getAnalyticsTrend,
    getAlerts: getAlerts,
    ackAlert: ackAlert,
    resolveAlert: resolveAlert,
    verifyAdmin: verifyAdmin,
    calibrateDevice: calibrateDevice,
    updateDeviceSettings: updateDeviceSettings,
    exportReadings: exportReadings,
    exportRodEvents: exportRodEvents
  };
})();
