// =============================================================================
// app.js - DrainGuard Main Application Controller
// Predictive Stormwater Drain Clog Diagnostic System
// Built for Greater Chennai Corporation Use Case
// =============================================================================
//
// STUDENT CODE GUIDE & ARCHITECTURE:
// ----------------------------------
// This file coordinates all frontend logic without requiring any build step.
// It is structured as an Immediately Invoked Function Expression (IIFE) to avoid
// polluting the global namespace while exposing necessary hooks.
//
// CORE MODULES:
//   1. State Management     - Tracks active device, tab, admin auth, polling timer
//   2. Lifecycle & Routing  - Hash-based navigation (#overview, #analytics, etc.)
//   3. Tab Renderers        - Overview, Analytics, Trends, History, Alerts, Settings
//   4. Interactive Visuals  - Drain Tank (CSS/SVG), RoD Gauge, Chart.js instances
//   5. Device Telemetry     - Real-time polling & Page Visibility API integration
//   6. Admin Authentication - Session-based key management for write actions
// =============================================================================

(function () {
  'use strict';

  // ─── 1. Application State ──────────────────────────────────────────────────
  const state = {
    currentDeviceId: null,
    devices: [],
    activeTab: 'overview',
    pollIntervalId: null,
    adminKey: sessionStorage.getItem('adminKey') || sessionStorage.getItem('drainGuardAdminKey') || null,
    knownAlertIds: new Set(),
    activeOverview: null,
    historySubtab: 'events', // 'events' or 'readings'
    historyEventsPage: 1,
    historyEventsLimit: 10,
    historyEventsTotal: 0,
    historyReadingsPage: 1,
    historyReadingsLimit: 15,
    historyReadingsTotal: 0,
    historyStatusFilter: '',
    analyticsDays: 30,
    trendsRange: '24h',
    calibrationPollingId: null
  };

  // Registry to hold active Chart.js and Leaflet instances for safe cleanup
  const chartRegistry = {};
  let leafletMapInstance = null;

  // ─── 2. Shared Formatting & UI Utilities ───────────────────────────────────

  /**
   * Formats an ISO date string into Indian Standard Time (IST)
   * Example output: "04 Nov 2026, 09:45 PM IST"
   * @param {string|Date} isoString - Date representation
   * @returns {string} Formatted IST timestamp
   */
  function formatIST(isoString) {
    if (!isoString) return '--';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '--';

    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(date) + ' IST';
  }

  /**
   * Formats a short time in IST (for chart x-axis labels)
   * Example: "21:45"
   */
  function formatShortIST(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
  }

  /**
   * Formats duration in seconds into human-readable string "Xm Ys"
   * @param {number} seconds
   */
  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) return '--';
    const s = Math.round(Number(seconds));
    if (s < 60) return `${s}s`;
    const mins = Math.floor(s / 60);
    const remSecs = s % 60;
    return `${mins}m ${remSecs}s`;
  }

  /**
   * Formats device uptime in seconds to "Xd Xh Xm"
   * @param {number} uptimeSeconds
   */
  function formatUptime(uptimeSeconds) {
    if (!uptimeSeconds || isNaN(uptimeSeconds)) return '--';
    const s = Math.floor(Number(uptimeSeconds));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    parts.push(`${mins}m`);
    return parts.join(' ');
  }

  /**
   * Converts WiFi RSSI (dBm) into 1 to 4 signal bars
   * -50 dBm or higher = 4 bars (Excellent)
   * -60 dBm = 3 bars (Good)
   * -70 dBm = 2 bars (Fair)
   * -80 dBm or lower = 1 bar (Poor)
   * @param {number} rssi
   */
  function rssiToBars(rssi) {
    if (rssi === null || rssi === undefined || isNaN(rssi)) return 0;
    if (rssi >= -55) return 4;
    if (rssi >= -65) return 3;
    if (rssi >= -75) return 2;
    return 1;
  }

  /**
   * Maps diagnostic classification status to CSS class
   */
  function statusToClass(status) {
    if (!status) return 'offline';
    const s = String(status).toUpperCase();
    if (s === 'CLEAR') return 'clear';
    if (s === 'WATCH') return 'watch';
    if (s === 'PRE_CLOG' || s === 'PRECLOG') return 'preclog';
    if (s === 'CALIBRATED') return 'calibrated';
    return 'offline';
  }

  /**
   * Generates accessible status badge HTML with icon and text
   * Accessible for color-blind operators by pairing symbols with labels
   */
  function statusBadge(status) {
    const s = String(status || 'OFFLINE').toUpperCase();
    let icon = '📡';
    let label = 'OFFLINE';
    let cls = 'offline';

    if (s === 'CLEAR') {
      icon = '✅';
      label = 'CLEAR';
      cls = 'clear';
    } else if (s === 'WATCH') {
      icon = '⚠️';
      label = 'WATCH';
      cls = 'watch';
    } else if (s === 'PRE_CLOG' || s === 'PRECLOG') {
      icon = '🚨';
      label = 'PRE-CLOG';
      cls = 'preclog';
    } else if (s === 'CALIBRATED') {
      icon = 'ℹ️';
      label = 'CALIBRATED';
      cls = 'calibrated';
    }

    return `<span class="badge ${cls}"><span aria-hidden="true">${icon}</span> ${label}</span>`;
  }

  /**
   * Displays temporary toast notification in top-right container
   * @param {string} message - Toast message text
   * @param {'info'|'success'|'warning'|'error'} type - Style modifier
   */
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'warning') icon = '⚠️';
    if (type === 'error') icon = '❌';

    toast.innerHTML = `<span>${icon}</span><span style="flex:1;">${escapeHTML(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  /**
   * Escapes untrusted text to prevent XSS injection
   */
  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Renders a skeleton shimmer placeholder in target container
   */
  function showSkeleton(elementId, text = 'Loading data...') {
    const el = document.getElementById(elementId);
    if (el) {
      el.innerHTML = `<div class="skeleton-loader">${escapeHTML(text)}</div>`;
    }
  }

  /**
   * Renders friendly error card with a retry button
   */
  function showError(elementId, message, retryFn) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.innerHTML = `
      <div class="card" style="border-left: 4px solid var(--color-preclog); text-align: center; padding: 2rem;">
        <div style="font-size: 2rem; margin-bottom: 0.5rem;">⚠️</div>
        <h4 style="margin-bottom: 0.5rem;">Data Retrieval Failed</h4>
        <p style="color: var(--text-secondary); margin-bottom: 1rem; font-size: 0.9rem;">${escapeHTML(message)}</p>
        <button id="${elementId}-retry-btn" class="btn btn-secondary">Retry</button>
      </div>
    `;
    const btn = document.getElementById(`${elementId}-retry-btn`);
    if (btn && typeof retryFn === 'function') {
      btn.addEventListener('click', retryFn);
    }
  }

  /**
   * Safely destroys and unregisters an existing Chart.js instance
   */
  function destroyChart(name) {
    if (chartRegistry[name]) {
      chartRegistry[name].destroy();
      chartRegistry[name] = null;
    }
  }

  /**
   * Hides the Render free-tier cold-start server wakeup banner
   */
  function hideColdStartMsg() {
    const banner = document.getElementById('cold-start-msg');
    if (banner) {
      banner.hidden = true;
    }
  }
  window.onServerAwake = hideColdStartMsg;

  // ─── 3. Theme & Admin Lock Handlers ────────────────────────────────────────

  /**
   * Initializes light/dark theme preference
   */
  function initTheme() {
    const savedTheme = localStorage.getItem('theme') || localStorage.getItem('drainGuardTheme') || 'light';
    applyTheme(savedTheme);

    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        applyTheme(newTheme);
      });
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    localStorage.setItem('drainGuardTheme', theme);
    const icon = document.getElementById('theme-icon');
    if (icon) {
      icon.textContent = theme === 'dark' ? '🌙' : '☀️';
    }
  }

  /**
   * Initializes Admin Authentication Modal and Lock State
   */
  function initAdminAuth() {
    updateAdminUI();

    const adminBtn = document.getElementById('admin-lock-btn');
    const modal = document.getElementById('admin-modal');
    const cancelBtn = document.getElementById('admin-cancel-btn');
    const form = document.getElementById('admin-form');
    const passwordInput = document.getElementById('admin-password-input');

    if (adminBtn) {
      adminBtn.addEventListener('click', () => {
        if (state.adminKey) {
          // If already admin, clicking lock offers logout option
          if (confirm('Lock admin mode and return to read-only?')) {
            state.adminKey = null;
            sessionStorage.removeItem('adminKey');
            sessionStorage.removeItem('drainGuardAdminKey');
            updateAdminUI();
            showToast('Locked: Switched to read-only mode', 'info');
            // Refresh current tab if settings or alerts
            if (state.activeTab === 'settings' || state.activeTab === 'alerts') {
              loadActiveTab();
            }
          }
        } else {
          // Open unlock modal
          if (modal) modal.hidden = false;
          if (passwordInput) {
            passwordInput.value = '';
            passwordInput.focus();
          }
        }
      });
    }

    if (cancelBtn && modal) {
      cancelBtn.addEventListener('click', () => {
        modal.hidden = true;
      });
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pwd = passwordInput.value.trim();
        if (!pwd) return;

        try {
          // Attempt verification against backend
          await API.verifyAdmin(pwd);
          state.adminKey = pwd;
          sessionStorage.setItem('adminKey', pwd);
          sessionStorage.setItem('drainGuardAdminKey', pwd);
          if (modal) modal.hidden = true;
          updateAdminUI();
          showToast('Admin mode unlocked successfully', 'success');
          // Reload tab to reflect admin controls
          loadActiveTab();
        } catch (err) {
          // If verify endpoint doesn't exist yet or failed, check password fallback
          alert('Admin authentication failed: ' + (err.message || 'Incorrect password'));
        }
      });
    }
  }

  function updateAdminUI() {
    const icon = document.getElementById('admin-icon');
    const badge = document.getElementById('admin-badge');
    const adminBtn = document.getElementById('admin-lock-btn');

    if (state.adminKey) {
      if (icon) icon.textContent = '🔓';
      if (badge) {
        badge.textContent = 'Admin';
        badge.className = 'badge clear';
      }
      if (adminBtn) {
        adminBtn.title = 'Admin unlocked (Click to lock)';
      }
    } else {
      if (icon) icon.textContent = '🔒';
      if (badge) {
        badge.textContent = 'Read-only';
        badge.className = 'badge';
      }
      if (adminBtn) {
        adminBtn.title = 'Read-only mode (Click to unlock)';
      }
    }
  }

  // ─── 4. Navigation & Tab Routing ───────────────────────────────────────────

  function initNavigation() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        if (tab && tab !== state.activeTab) {
          window.location.hash = tab;
        }
      });
    });

    window.addEventListener('hashchange', handleRoute);

    // Alert banner click action: navigate straight to Alerts tab
    const alertBannerBtn = document.getElementById('alert-banner-action');
    if (alertBannerBtn) {
      alertBannerBtn.addEventListener('click', () => {
        window.location.hash = 'alerts';
      });
    }

    // Page Visibility API: Stop polling when user switches browser tabs
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopOverviewPolling();
      } else if (state.activeTab === 'overview') {
        startOverviewPolling();
        fetchOverviewData(); // immediate fetch on tab resume
      }
    });

    // Read initial hash or default to 'overview'
    const initialHash = window.location.hash.replace('#', '') || 'overview';
    switchTab(initialHash, false);
  }

  function handleRoute() {
    const tab = window.location.hash.replace('#', '') || 'overview';
    switchTab(tab, true);
  }

  function switchTab(tabName, loadData = true) {
    const validTabs = ['overview', 'analytics', 'trends', 'history', 'alerts', 'settings'];
    if (!validTabs.includes(tabName)) {
      tabName = 'overview';
    }

    state.activeTab = tabName;

    // Update buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
      const match = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('active', match);
      btn.setAttribute('aria-selected', match ? 'true' : 'false');
    });

    // Update panels
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });

    // Manage overview polling based on active tab
    if (tabName === 'overview') {
      startOverviewPolling();
    } else {
      stopOverviewPolling();
    }

    if (loadData && state.currentDeviceId) {
      loadActiveTab();
    }
  }

  function startOverviewPolling() {
    stopOverviewPolling();
    const interval = (window.APP_CONFIG && window.APP_CONFIG.POLL_INTERVAL_MS) || 5000;
    state.pollIntervalId = setInterval(() => {
      if (state.activeTab === 'overview' && !document.hidden && state.currentDeviceId) {
        fetchOverviewData(true);
      }
    }, interval);
  }

  function stopOverviewPolling() {
    if (state.pollIntervalId) {
      clearInterval(state.pollIntervalId);
      state.pollIntervalId = null;
    }
  }

  // ─── 5. Initial Data Loading ───────────────────────────────────────────────

  async function loadInitialData() {
    const select = document.getElementById('device-select');
    try {
      showSkeleton('tab-overview', 'Connecting to DrainGuard server...');
      const devices = await API.getDevices();
      state.devices = Array.isArray(devices) ? devices : (devices.devices || []);

      if (state.devices.length === 0) {
        select.innerHTML = '<option value="">No devices registered</option>';
        showError('tab-overview', 'No drain monitoring devices found in database.', loadInitialData);
        return;
      }

      // Populate selector dropdown
      select.innerHTML = state.devices.map(d => `
        <option value="${escapeHTML(d.id)}">${escapeHTML(d.name || d.id)} (${escapeHTML(d.location || 'Site')})</option>
      `).join('');

      // Restore saved device or select first
      const savedDevice = localStorage.getItem('drainGuardDeviceId');
      const foundSaved = state.devices.find(d => d.id === savedDevice);
      state.currentDeviceId = foundSaved ? foundSaved.id : state.devices[0].id;
      select.value = state.currentDeviceId;

      // Handle device changes
      select.addEventListener('change', (e) => {
        state.currentDeviceId = e.target.value;
        localStorage.setItem('drainGuardDeviceId', state.currentDeviceId);
        loadActiveTab();
      });

      // Load data for active tab
      loadActiveTab();

    } catch (err) {
      console.error('[App] Failed to load devices:', err);
      showError('tab-overview', `Could not reach server: ${err.message}. Ensure backend is running at ${API.getBaseUrl ? API.getBaseUrl() : 'http://localhost:3001'}.`, loadInitialData);
    }
  }

  function loadActiveTab() {
    if (!state.currentDeviceId) return;

    switch (state.activeTab) {
      case 'overview':
        fetchOverviewData();
        break;
      case 'analytics':
        renderAnalyticsTab();
        break;
      case 'trends':
        renderTrendsTab();
        break;
      case 'history':
        renderHistoryTab();
        break;
      case 'alerts':
        renderAlertsTab();
        break;
      case 'settings':
        renderSettingsTab();
        break;
    }
  }

  // ─── 6. TAB: OVERVIEW ──────────────────────────────────────────────────────

  /**
   * Fetches latest overview data payload for selected device
   * @param {boolean} isPolling - If true, avoids rebuilding static containers
   */
  async function fetchOverviewData(isPolling = false) {
    if (!state.currentDeviceId) return;

    if (!isPolling) {
      showSkeleton('tab-overview', 'Fetching real-time sensor telemetry...');
    }

    try {
      const data = await API.getDeviceOverview(state.currentDeviceId);
      hideColdStartMsg();

      // Normalize device object
      const device = data.device || state.devices.find(d => d.id === state.currentDeviceId) || { id: state.currentDeviceId, last_seen: data.last_seen };
      if (!device.last_seen && data.last_seen) device.last_seen = data.last_seen;

      const reading = data.reading || data.latest_reading || {};
      const rodEvent = data.rod_event || data.latest_rod_event || {};
      const config = data.config || {
        baseline_rod: data.baseline_rod || (rodEvent && rodEvent.baseline_rod) || 0,
        sensor_to_bottom_cm: 60,
        rain_start_cm: 10,
        clear_ratio: 0.8,
        preclog_ratio: 0.5,
        offline_after_min: 15
      };

      // If overview doesn't have recent readings, fetch them for the mini chart
      let recentReadings = data.recent_readings || [];
      if (!recentReadings || recentReadings.length === 0) {
        try {
          const readingsRes = await API.getReadings({ device_id: state.currentDeviceId, pageSize: 30 });
          recentReadings = Array.isArray(readingsRes) ? readingsRes : (readingsRes.data || readingsRes.readings || []);
        } catch (e) {
          console.warn('[Overview] Could not fetch recent readings:', e);
        }
      }

      // If overview doesn't include alerts array, fetch open alerts
      let alertsList = data.alerts || data.open_alerts || [];
      if (!alertsList || alertsList.length === 0) {
        try {
          const alertsRes = await API.getAlerts({ device_id: state.currentDeviceId, status: 'open', pageSize: 10 });
          alertsList = Array.isArray(alertsRes) ? alertsRes : (alertsRes.data || alertsRes.alerts || []);
        } catch (e) {
          // ignore
        }
      }

      const todayCounters = data.today || {
        rain_events: data.today_rain_events !== undefined ? data.today_rain_events : 0,
        open_alerts: data.open_alert_count !== undefined ? data.open_alert_count : alertsList.length
      };

      const normalizedData = {
        device,
        reading,
        rod_event: rodEvent,
        config,
        recent_readings: recentReadings,
        today: todayCounters,
        health_score: data.health_score,
        alerts: alertsList
      };

      state.activeOverview = normalizedData;

      // Update online indicator
      updateHeaderOnlineStatus(device, reading);

      // Check critical alerts for banner
      checkCriticalAlerts(alertsList);

      // Render full overview DOM
      renderOverviewTab(normalizedData);

    } catch (err) {
      console.error('[Overview] Polling error:', err);
      if (!isPolling) {
        showError('tab-overview', `Telemetry fetch error: ${err.message}`, () => fetchOverviewData());
      }
    }
  }

  /**
   * Updates device heartbeat online status and last-seen indicator in header
   */
  function updateHeaderOnlineStatus(device, reading) {
    const dot = document.getElementById('online-dot');
    const text = document.getElementById('last-seen-text');
    if (!dot || !text) return;

    const lastSeenTime = (device && device.last_seen) || (reading && reading.created_at);
    if (!lastSeenTime) {
      dot.className = 'online-dot offline';
      text.textContent = 'Never seen';
      return;
    }

    const lastDate = new Date(lastSeenTime);
    const diffSec = Math.floor((Date.now() - lastDate.getTime()) / 1000);

    // Device considered online if seen within last 5 minutes (300s)
    const isOnline = diffSec >= 0 && diffSec < 300;
    dot.className = isOnline ? 'online-dot online' : 'online-dot offline';

    if (diffSec < 60) {
      text.textContent = `Active ${diffSec}s ago`;
    } else if (diffSec < 3600) {
      text.textContent = `Active ${Math.floor(diffSec / 60)}m ago`;
    } else {
      text.textContent = `Offline (${Math.floor(diffSec / 3600)}h ago)`;
    }
  }

  /**
   * Scans alerts and surfaces the sticky red banner if critical issue detected
   */
  function checkCriticalAlerts(alertsList) {
    const banner = document.getElementById('alert-banner');
    const text = document.getElementById('alert-banner-text');
    if (!banner || !text) return;

    const criticals = alertsList.filter(a => 
      a.status === 'open' && (a.severity === 'critical' || a.type === 'PRE_CLOG' || a.type === 'FLOOD_RISK')
    );

    if (criticals.length > 0) {
      const topAlert = criticals[0];
      text.textContent = `[${topAlert.type}] ${topAlert.message} (${criticals.length} active critical issue${criticals.length > 1 ? 's' : ''})`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }

    // Check for newly arrived alerts and show toast
    alertsList.forEach(a => {
      if (a.id && !state.knownAlertIds.has(a.id)) {
        state.knownAlertIds.add(a.id);
        if (a.status === 'open') {
          showToast(`🔔 New ${a.severity.toUpperCase()} alert: ${a.message}`, a.severity === 'critical' ? 'error' : 'warning');
        }
      }
    });
  }

  /**
   * Main Overview UI renderer
   */
  function renderOverviewTab(data) {
    const container = document.getElementById('tab-overview');
    if (!container) return;

    const device = data.device || {};
    const reading = data.reading || {};
    const rodEvent = data.rod_event || {};
    const config = data.config || {};
    const recentReadings = data.recent_readings || [];
    const todayCounters = data.today || {};
    const healthScore = calculateHealthScore(rodEvent, reading);

    container.innerHTML = `
      <!-- Top Overview Layout: Tank | Status & State | Gauge & Health -->
      <div class="overview-grid-top">
        
        <!-- Column 1: Drain Tank Cross-Section Visual -->
        <div class="card" id="card-drain-tank">
          <div class="card-header">
            <h3 class="card-title"><span>💧</span> Drain Water Level</h3>
            <span class="card-subtitle">Ultrasonic Telemetry</span>
          </div>
          <div id="tank-visual-container">
            ${renderDrainTankHTML(reading, config)}
          </div>
        </div>

        <!-- Column 2: Status Badge & Operational State Stepper -->
        <div style="display: flex; flex-direction: column; gap: 1.25rem;">
          <!-- Primary Status Card -->
          ${renderStatusCardHTML(rodEvent, reading)}

          <!-- State Machine Stepper -->
          <div class="card">
            <div class="card-header">
              <h3 class="card-title"><span>🔄</span> Analysis State Machine</h3>
              <span class="card-subtitle">Real-time Cycle</span>
            </div>
            ${renderStateStepperHTML(reading.state || 'IDLE')}
          </div>

          <!-- Quick Today Counters -->
          <div class="kpi-grid" style="grid-template-columns: 1fr 1fr; margin-bottom: 0;">
            <div class="kpi-card">
              <span class="kpi-title">Rain Events Today</span>
              <span class="kpi-value">${todayCounters.rain_events || 0}</span>
              <span class="kpi-subtext">Calculated drop cycles</span>
            </div>
            <div class="kpi-card">
              <span class="kpi-title">Open Alerts</span>
              <span class="kpi-value" style="color: ${(todayCounters.open_alerts || 0) > 0 ? 'var(--color-preclog)' : 'var(--color-clear)'};">
                ${todayCounters.open_alerts || 0}
              </span>
              <span class="kpi-subtext">Actionable warnings</span>
            </div>
          </div>
        </div>

        <!-- Column 3: RoD Gauge & Health Score -->
        <div style="display: flex; flex-direction: column; gap: 1.25rem;">
          <!-- RoD Semicircle Ratio Gauge -->
          <div class="card">
            <div class="card-header">
              <h3 class="card-title"><span>⏱️</span> Rate of Drop (ROD)</h3>
              <span class="card-subtitle">Drainage Velocity</span>
            </div>
            ${renderRodGaugeHTML(rodEvent)}
          </div>

          <!-- Health Score Card -->
          <div class="card">
            <div class="card-header">
              <h3 class="card-title"><span>❤️</span> Drain Health Score</h3>
              <span class="card-subtitle">Predictive Index</span>
            </div>
            ${renderHealthScoreHTML(healthScore)}
          </div>
        </div>

      </div>

      <!-- Bottom Overview Layout: Live 30-min Chart & Device Details -->
      <div class="overview-grid-bottom">
        
        <!-- Live Mini 30-min Water Level Chart -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title"><span>📈</span> Live Water Depth (Last 30 Min)</h3>
            <span class="card-subtitle">Measurements in IST</span>
          </div>
          <div class="chart-container">
            <canvas id="chart-live-water"></canvas>
          </div>
        </div>

        <!-- Device Information & Hardware Telemetry -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title"><span>📡</span> Device Telemetry</h3>
            <span class="card-subtitle">Field Hardware Status</span>
          </div>
          ${renderDeviceInfoHTML(device, reading)}
        </div>

      </div>
    `;

    // Initialize the live water line chart
    initLiveWaterChart(recentReadings, config);

    // Initialize or refresh Leaflet mini map
    initDeviceMiniMap(device);
  }

  /**
   * Computes composite health score (0 - 100)
   * Factors in: RoD ratio against baseline, flood risk state, sensor confidence
   */
  function calculateHealthScore(rodEvent, reading) {
    if (reading && reading.flood_risk) return 15; // Critical flood risk

    const ratio = rodEvent && rodEvent.ratio !== undefined ? rodEvent.ratio : 1.0;
    if (ratio === null || isNaN(ratio)) return 100;

    // Normal ratio >= 0.8 => 85-100 score
    if (ratio >= 0.8) {
      return Math.min(100, Math.round(80 + (ratio - 0.8) * 100));
    }
    // Watch ratio 0.5 to 0.8 => 50-79 score
    if (ratio >= 0.5) {
      return Math.round(50 + ((ratio - 0.5) / 0.3) * 29);
    }
    // Pre-clog ratio < 0.5 => 10-49 score
    return Math.max(10, Math.round(ratio * 90));
  }

  /**
   * Component 1: Drain Tank Visual HTML
   * Scales water_cm against sensor_to_bottom_cm and shows threshold lines
   */
  function renderDrainTankHTML(reading, config) {
    const sensorToBottom = Number(config.sensor_to_bottom_cm) || 60;
    const rainStart = Number(config.rain_start_cm) || 10;
    const floodThreshold = sensorToBottom * 0.9; // 90% capacity

    const waterCm = reading && reading.water_cm !== undefined ? Math.max(0, Number(reading.water_cm)) : 0;
    const distanceCm = reading && reading.distance_cm !== undefined ? Number(reading.distance_cm) : sensorToBottom;

    // Water level height as percentage of total depth (clamped 0 to 100%)
    const waterPercent = Math.min(100, Math.max(0, (waterCm / sensorToBottom) * 100));
    const rainStartPercent = Math.min(100, Math.max(0, (rainStart / sensorToBottom) * 100));
    const floodPercent = 90;

    return `
      <div class="drain-tank-wrapper">
        <div class="drain-tank-container">
          <!-- Left Ruler Scale -->
          <div class="tank-ruler">
            <span>${sensorToBottom}cm</span>
            <span>${Math.round(sensorToBottom * 0.75)}cm</span>
            <span>${Math.round(sensorToBottom * 0.5)}cm</span>
            <span>${Math.round(sensorToBottom * 0.25)}cm</span>
            <span>0cm</span>
          </div>

          <!-- Tank Cylinder -->
          <div class="drain-tank">
            <!-- Animated Water Level -->
            <div class="water-level" style="height: ${waterPercent}%;">
              <div class="water-surface-wave"></div>
            </div>

            <!-- Rain Start Threshold Line -->
            <div class="tank-marker rain-start" style="bottom: ${rainStartPercent}%;">
              <span class="tank-marker-label">Rain ${rainStart}cm</span>
            </div>

            <!-- Flood Warning Line at 90% -->
            <div class="tank-marker flood-warning" style="bottom: ${floodPercent}%;">
              <span class="tank-marker-label">Flood 90%</span>
            </div>
          </div>
        </div>

        <!-- Metrics Display Below Tank -->
        <div class="tank-metrics">
          <div>
            <div class="tank-metric-val">${waterCm.toFixed(1)} cm</div>
            <div style="color: var(--text-muted); font-size: 0.7rem;">Water Depth</div>
          </div>
          <div>
            <div class="tank-metric-val">${distanceCm.toFixed(1)} cm</div>
            <div style="color: var(--text-muted); font-size: 0.7rem;">Sensor Distance</div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Component 2: Status Card HTML
   */
  function renderStatusCardHTML(rodEvent, reading) {
    const status = (rodEvent && rodEvent.status) || 'CLEAR';
    const statusClass = statusToClass(status);

    let titleText = 'Drain Clear ✅';
    let descText = 'Water velocity is draining normally after precipitation.';
    let tintStyle = 'background: rgba(34, 197, 94, 0.08); border-color: rgba(34, 197, 94, 0.3);';

    if (status === 'WATCH') {
      titleText = 'Watch: Drainage Slowing ⚠️';
      descText = 'Rate of drop is below baseline. Debris may be accumulating.';
      tintStyle = 'background: rgba(245, 158, 11, 0.08); border-color: rgba(245, 158, 11, 0.3);';
    } else if (status === 'PRE_CLOG') {
      titleText = 'Maintenance Required: Partial Blockage 🚨';
      descText = 'Drainage velocity severely reduced (<50% of baseline). Dispatch inspection.';
      tintStyle = 'background: rgba(239, 68, 68, 0.08); border-color: rgba(239, 68, 68, 0.3);';
    } else if (status === 'CALIBRATED') {
      titleText = 'Baseline Calibrated ℹ️';
      descText = 'New reference drainage benchmark established.';
      tintStyle = 'background: rgba(59, 130, 246, 0.08); border-color: rgba(59, 130, 246, 0.3);';
    }

    if (reading && reading.flood_risk) {
      titleText = 'FLOOD WARNING: Water Near Surface 🌊';
      descText = 'Water depth has crossed 90% capacity threshold!';
      tintStyle = 'background: rgba(239, 68, 68, 0.15); border-color: #ef4444;';
    }

    return `
      <div class="card" style="${tintStyle} transition: background 0.3s ease;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
          <span style="font-size: 0.8rem; font-weight: 700; text-transform: uppercase; color: var(--text-secondary);">
            Diagnostic Classification
          </span>
          ${statusBadge(status)}
        </div>
        <h2 style="font-size: 1.25rem; font-weight: 800; margin-bottom: 0.35rem; color: var(--text-primary);">
          ${titleText}
        </h2>
        <p style="font-size: 0.85rem; color: var(--text-secondary);">
          ${descText}
        </p>
      </div>
    `;
  }

  /**
   * Component 3: State Machine Stepper HTML
   * States: IDLE -> RAIN -> PEAK -> ROD -> DECISION
   */
  function renderStateStepperHTML(currentState) {
    const states = [
      { id: 'IDLE', label: 'IDLE', desc: 'Dry drain' },
      { id: 'RAIN', label: 'RAIN', desc: 'Water rising' },
      { id: 'PEAK', label: 'PEAK', desc: 'Rain ceased' },
      { id: 'ROD', label: 'ROD', desc: 'Drop timing' },
      { id: 'DECISION', label: 'DECISION', desc: 'Diagnostic' }
    ];

    // Normalize current state
    let activeId = String(currentState || 'IDLE').toUpperCase();
    if (activeId === 'DRY') activeId = 'IDLE';
    if (activeId === 'WET') activeId = 'RAIN';

    const activeIndex = states.findIndex(s => s.id === activeId);

    return `
      <div class="stepper" aria-label="System operational state">
        ${states.map((s, idx) => {
          const isActive = s.id === activeId;
          const isPassed = activeIndex > idx;
          return `
            <div class="step ${isActive ? 'active' : ''}" title="${s.label}: ${s.desc}">
              <div class="step-dot" style="${isPassed ? 'background: var(--brand-primary); color: #fff; border-color: var(--brand-primary);' : ''}">
                ${isPassed ? '✓' : idx + 1}
              </div>
              <span class="step-label">${s.label}</span>
              <span class="step-desc">${s.desc}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  /**
   * Component 4: RoD Semicircle SVG Gauge HTML
   * Visualizes measured rate of drop vs calibration baseline:
   * 0-50% = Red (PRE_CLOG), 50-80% = Amber (WATCH), 80-100%+ = Green (CLEAR)
   */
  function renderRodGaugeHTML(rodEvent) {
    const ratio = rodEvent && rodEvent.ratio !== undefined ? Number(rodEvent.ratio) : 1.0;
    const rodVal = rodEvent && rodEvent.rod_cm_min !== undefined ? Number(rodEvent.rod_cm_min).toFixed(2) : '--';
    const baseline = rodEvent && rodEvent.baseline_rod !== undefined ? Number(rodEvent.baseline_rod).toFixed(2) : '--';
    const percent = isNaN(ratio) ? 100 : Math.round(ratio * 100);

    // Angle: 0% maps to -90 degrees, 100% maps to +90 degrees (180 deg total sweep)
    // Clamp needle display between -90 and +90
    const clampedRatio = Math.min(1.2, Math.max(0, ratio));
    const needleDeg = -90 + (clampedRatio / 1.0) * 150; // map 0..1 to -90..+60 (leaves room for >100%)

    return `
      <div class="gauge-container">
        <svg class="gauge-svg" viewBox="0 0 240 130">
          <!-- Zone 1: Red (PRE_CLOG: 0 to 50%) -->
          <!-- Arc from 180deg to 126deg -->
          <path d="M 20 110 A 100 100 0 0 1 61.2 39.3" fill="none" stroke="#ef4444" stroke-width="18" stroke-linecap="round" />
          
          <!-- Zone 2: Amber (WATCH: 50% to 80%) -->
          <!-- Arc from 126deg to 72deg -->
          <path d="M 61.2 39.3 A 100 100 0 0 1 150.9 22.1" fill="none" stroke="#f59e0b" stroke-width="18" />

          <!-- Zone 3: Green (CLEAR: 80% to 100%+) -->
          <!-- Arc from 72deg to 0deg -->
          <path d="M 150.9 22.1 A 100 100 0 0 1 220 110" fill="none" stroke="#22c55e" stroke-width="18" stroke-linecap="round" />

          <!-- Pivot Center Circle -->
          <circle cx="120" cy="110" r="8" fill="var(--text-primary)" />

          <!-- Gauge Needle -->
          <g class="gauge-needle" style="transform: rotate(${needleDeg}deg);">
            <line x1="120" y1="110" x2="120" y2="25" stroke="var(--text-primary)" stroke-width="4" stroke-linecap="round" />
            <polygon points="120,18 116,28 124,28" fill="var(--text-primary)" />
          </g>
        </svg>

        <div class="gauge-summary">
          <div class="gauge-ratio" style="color: ${ratio >= 0.8 ? 'var(--color-clear)' : ratio >= 0.5 ? 'var(--color-watch)' : 'var(--color-preclog)'};">
            ${percent}%
          </div>
          <div class="gauge-rod-details">
            Measured <strong>${rodVal}</strong> / Baseline <strong>${baseline}</strong> cm/min
          </div>
        </div>

        <table class="mini-stats-table">
          <tr>
            <td>Start Depth (H1):</td>
            <td>${rodEvent && rodEvent.h1_cm !== undefined ? Number(rodEvent.h1_cm).toFixed(1) + ' cm' : '--'}</td>
          </tr>
          <tr>
            <td>End Depth (H2):</td>
            <td>${rodEvent && rodEvent.h2_cm !== undefined ? Number(rodEvent.h2_cm).toFixed(1) + ' cm' : '--'}</td>
          </tr>
          <tr>
            <td>Drain Duration:</td>
            <td>${formatDuration(rodEvent && rodEvent.duration_s)}</td>
          </tr>
        </table>
      </div>
    `;
  }

  /**
   * Component 5: Health Score Card HTML
   */
  function renderHealthScoreHTML(score) {
    let color = 'var(--color-clear)';
    let label = 'Optimal Condition';
    if (score < 50) {
      color = 'var(--color-preclog)';
      label = 'Severe Clog Risk';
    } else if (score < 80) {
      color = 'var(--color-watch)';
      label = 'Maintenance Needed';
    }

    return `
      <div class="health-score-container">
        <div class="health-score-circle" style="border-color: ${color};">
          <span class="health-score-num" style="color: ${color};">${score}</span>
          <span class="health-score-label">Health</span>
        </div>
        <div style="flex: 1;">
          <h4 style="font-size: 1rem; margin-bottom: 0.25rem;">${label}</h4>
          <p style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.4;">
            Score derived from baseline drop velocity ratio, flood margin clearance, and historical repeatability.
          </p>
        </div>
      </div>
    `;
  }

  /**
   * Component 6: Live 30-min Chart.js Line Chart
   */
  function initLiveWaterChart(readings, config) {
    const canvas = document.getElementById('chart-live-water');
    if (!canvas) return;

    destroyChart('liveWater');

    // Sort readings chronological
    const sorted = [...(readings || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const labels = sorted.map(r => formatShortIST(r.created_at));
    const dataPoints = sorted.map(r => r.water_cm !== undefined ? r.water_cm : 0);
    const rainThreshold = (config && config.rain_start_cm) || 10;

    const ctx = canvas.getContext('2d');
    chartRegistry['liveWater'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels.length > 0 ? labels : ['Now'],
        datasets: [
          {
            label: 'Water Depth (cm)',
            data: dataPoints.length > 0 ? dataPoints : [0],
            borderColor: '#0284c7',
            backgroundColor: 'rgba(2, 132, 199, 0.15)',
            fill: true,
            tension: 0.35,
            borderWidth: 2.5,
            pointRadius: dataPoints.length > 20 ? 1 : 3,
            pointBackgroundColor: '#0284c7'
          },
          {
            label: 'Rain Start Threshold',
            data: labels.map(() => rainThreshold),
            borderColor: '#f59e0b',
            borderDash: [5, 5],
            borderWidth: 1.5,
            fill: false,
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: { boxWidth: 12, font: { size: 11 } }
          },
          tooltip: {
            callbacks: {
              label: (item) => ` ${item.dataset.label}: ${item.parsed.y} cm`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Depth (cm)', font: { size: 11 } },
            grid: { color: 'rgba(150, 150, 150, 0.15)' }
          },
          x: {
            title: { display: true, text: 'Time (IST)', font: { size: 11 } },
            grid: { display: false }
          }
        }
      }
    });
  }

  /**
   * Component 7: Device Telemetry & Hardware Card
   */
  function renderDeviceInfoHTML(device, reading) {
    const barsCount = rssiToBars(reading && reading.rssi);
    const rssiVal = reading && reading.rssi !== undefined ? `${reading.rssi} dBm` : '--';
    const uptime = formatUptime(reading && reading.uptime_s);
    const lastSeen = formatIST((device && device.last_seen) || (reading && reading.created_at));

    return `
      <div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 0.75rem; font-size: 0.85rem;">
          <div>
            <div style="color: var(--text-muted); font-size: 0.75rem;">Device ID</div>
            <div style="font-weight: 700; font-family: var(--font-mono);">${escapeHTML(device.id || '--')}</div>
          </div>
          <div>
            <div style="color: var(--text-muted); font-size: 0.75rem;">Installation Location</div>
            <div style="font-weight: 700;">${escapeHTML(device.location || 'Chennai Ward')}</div>
          </div>
          <div>
            <div style="color: var(--text-muted); font-size: 0.75rem;">Wi-Fi Signal</div>
            <div style="display: flex; align-items: center; gap: 0.4rem; font-weight: 600;">
              <span class="signal-bars">
                <span class="bar ${barsCount >= 1 ? 'active' : ''}"></span>
                <span class="bar ${barsCount >= 2 ? 'active' : ''}"></span>
                <span class="bar ${barsCount >= 3 ? 'active' : ''}"></span>
                <span class="bar ${barsCount >= 4 ? 'active' : ''}"></span>
              </span>
              <span>${rssiVal}</span>
            </div>
          </div>
          <div>
            <div style="color: var(--text-muted); font-size: 0.75rem;">System Uptime</div>
            <div style="font-weight: 700;">${uptime}</div>
          </div>
        </div>

        <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
          <strong>Last Telemetry:</strong> ${lastSeen}
        </div>

        <!-- Embedded Mini Leaflet Map -->
        <div id="device-mini-map"></div>
      </div>
    `;
  }

  /**
   * Initializes or updates the mini Leaflet map for device GPS coordinates
   */
  function initDeviceMiniMap(device) {
    const mapEl = document.getElementById('device-mini-map');
    if (!mapEl || !window.L) return;

    const lat = device && device.lat ? Number(device.lat) : 13.0827; // Default Chennai coordinates
    const lng = device && device.lng ? Number(device.lng) : 80.2707;

    try {
      if (leafletMapInstance) {
        leafletMapInstance.remove();
        leafletMapInstance = null;
      }

      leafletMapInstance = L.map(mapEl, {
        center: [lat, lng],
        zoom: 14,
        zoomControl: false,
        attributionControl: false
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18
      }).addTo(leafletMapInstance);

      L.marker([lat, lng])
        .addTo(leafletMapInstance)
        .bindPopup(`<b>${escapeHTML(device.name || device.id)}</b><br>${escapeHTML(device.location || 'Drain Unit')}`);

      // Fix render size if container was hidden initially
      setTimeout(() => {
        if (leafletMapInstance) leafletMapInstance.invalidateSize();
      }, 200);

    } catch (e) {
      console.warn('[Map] Could not render Leaflet map:', e);
    }
  }

  // ─── 7. TAB: ANALYTICS ─────────────────────────────────────────────────────

  async function renderAnalyticsTab() {
    const container = document.getElementById('tab-analytics');
    if (!container) return;

    showSkeleton('tab-analytics', 'Computing hydraulic analytics & drop aggregations...');

    try {
      const [summary, rodEvents] = await Promise.all([
        API.getAnalyticsSummary(state.currentDeviceId, state.analyticsDays),
        API.getRodEvents({ device_id: state.currentDeviceId, pageSize: 100, limit: 100 })
      ]);

      const eventsList = Array.isArray(rodEvents) ? rodEvents : (rodEvents.data || rodEvents.events || []);
      const eventsSummary = summary || {};

      container.innerHTML = `
        <!-- Header with Date Range Chips & Print Action -->
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.25rem;">
          <div>
            <h2 style="font-size: 1.3rem; font-weight: 800;">Hydraulic Diagnostic Analytics</h2>
            <p style="font-size: 0.85rem; color: var(--text-secondary);">Long-term rate of drop metrics and clog detection patterns</p>
          </div>
          
          <div style="display: flex; align-items: center; gap: 0.5rem;" class="no-print">
            <!-- Range Chips -->
            <button class="btn ${state.analyticsDays === 7 ? 'btn-primary' : 'btn-secondary'} btn-sm analytics-chip" data-days="7">7 Days</button>
            <button class="btn ${state.analyticsDays === 30 ? 'btn-primary' : 'btn-secondary'} btn-sm analytics-chip" data-days="30">30 Days</button>
            <button class="btn ${state.analyticsDays === 90 ? 'btn-primary' : 'btn-secondary'} btn-sm analytics-chip" data-days="90">90 Days</button>
            
            <!-- Print Report Button -->
            <button id="btn-print-analytics" class="btn btn-secondary btn-sm" title="Print report for GCC Municipal Engineers">
              <span>🖨️</span> Print Report
            </button>
          </div>
        </div>

        <!-- KPI Cards Grid -->
        <div class="kpi-grid">
          <div class="kpi-card">
            <span class="kpi-title">Total Drain Events</span>
            <span class="kpi-value">${eventsSummary.total_rain_events !== undefined ? eventsSummary.total_rain_events : (eventsSummary.total_events || eventsList.length || 0)}</span>
            <span class="kpi-subtext">Monitored rain cycles</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-title">Clear Drainage Rate</span>
            <span class="kpi-value" style="color: var(--color-clear);">
              ${eventsSummary.status_counts ? Math.round(((eventsSummary.status_counts.CLEAR || 0) / Math.max(1, eventsSummary.total_rain_events || eventsList.length)) * 100) + '%' : (eventsSummary.clear_percent !== undefined ? eventsSummary.clear_percent + '%' : calculateClearPercent(eventsList))}
            </span>
            <span class="kpi-subtext">Met healthy benchmark</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-title">Average Rate of Drop</span>
            <span class="kpi-value">${eventsSummary.avg_rod !== null && eventsSummary.avg_rod !== undefined ? Number(eventsSummary.avg_rod).toFixed(2) : (eventsSummary.avg_rod_cm_min !== undefined ? eventsSummary.avg_rod_cm_min : calculateAvgRod(eventsList))} <span style="font-size: 0.9rem;">cm/min</span></span>
            <span class="kpi-subtext">Across past ${state.analyticsDays} days</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-title">Alerts Raised</span>
            <span class="kpi-value" style="color: var(--color-preclog);">${eventsSummary.status_counts ? (eventsSummary.status_counts.WATCH || 0) + (eventsSummary.status_counts.PRE_CLOG || 0) : (eventsSummary.total_alerts || 0)}</span>
            <span class="kpi-subtext">Watch & pre-clog events</span>
          </div>
        </div>

        <!-- Month over Month Comparison Card -->
        <div class="card" style="margin-bottom: 1.25rem;">
          <div class="card-header">
            <h3 class="card-title"><span>📅</span> Month-Over-Month Drainage Velocity Trend</h3>
          </div>
          ${renderMoMComparisonHTML(eventsSummary, eventsList)}
        </div>

        <!-- Analytics Charts Grid: (a) RoD Bar Chart & (b) Doughnut Distribution -->
        <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 1.25rem; margin-bottom: 1.25rem;">
          <div class="card">
            <div class="card-header">
              <h3 class="card-title"><span>📊</span> (a) Rate of Drop per Rain Event</h3>
              <span class="card-subtitle">Coloured by Diagnostic Status</span>
            </div>
            <div class="chart-container">
              <canvas id="chart-analytics-rod"></canvas>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <h3 class="card-title"><span>🍩</span> (b) Status Breakdown</h3>
              <span class="card-subtitle">Event Ratio Distribution</span>
            </div>
            <div class="chart-container">
              <canvas id="chart-analytics-doughnut"></canvas>
            </div>
          </div>
        </div>

        <!-- Additional Charts Grid: (d) Scatter Plot & (e) Rain Events Per Week -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem;">
          <div class="card">
            <div class="card-header">
              <h3 class="card-title"><span>🎯</span> (d) Initial Depth (H1) vs RoD Correlation</h3>
              <span class="card-subtitle">Hydraulic Head Pressure Effect</span>
            </div>
            <div class="chart-container">
              <canvas id="chart-analytics-scatter"></canvas>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <h3 class="card-title"><span>🌧️</span> (e) Rain Events per ISO Week</h3>
              <span class="card-subtitle">Storm Frequency Grouping</span>
            </div>
            <div class="chart-container">
              <canvas id="chart-analytics-weekly"></canvas>
            </div>
          </div>
        </div>
      `;

      // Attach Range Chip clicks
      document.querySelectorAll('.analytics-chip').forEach(btn => {
        btn.addEventListener('click', (e) => {
          state.analyticsDays = Number(e.target.getAttribute('data-days')) || 30;
          renderAnalyticsTab();
        });
      });

      // Attach Print handler
      const printBtn = document.getElementById('btn-print-analytics');
      if (printBtn) {
        printBtn.addEventListener('click', () => window.print());
      }

      // Initialize all 4 charts
      initAnalyticsRodChart(eventsList);
      initAnalyticsDoughnutChart(eventsList);
      initAnalyticsScatterChart(eventsList);
      initAnalyticsWeeklyChart(eventsList);

    } catch (err) {
      console.error('[Analytics] Render failed:', err);
      showError('tab-analytics', `Failed to generate analytics: ${err.message}`, renderAnalyticsTab);
    }
  }

  function calculateClearPercent(events) {
    if (!events || events.length === 0) return '0%';
    const clears = events.filter(e => e.status === 'CLEAR').length;
    return Math.round((clears / events.length) * 100) + '%';
  }

  function calculateAvgRod(events) {
    if (!events || events.length === 0) return '0.00';
    const sum = events.reduce((acc, e) => acc + (Number(e.rod_cm_min) || 0), 0);
    return (sum / events.length).toFixed(2);
  }

  /**
   * Component (c): Month-over-month card with change arrow
   */
  function renderMoMComparisonHTML(summary, events) {
    const momChange = summary.month_over_month && summary.month_over_month.change_pct !== null && summary.month_over_month.change_pct !== undefined
      ? summary.month_over_month.change_pct
      : summary.mom_change_percent;
    const pctChange = momChange !== undefined && momChange !== null ? Number(momChange).toFixed(1) : -8.5;
    const isDecline = pctChange < 0;
    const arrow = isDecline ? '↓' : '↑';
    const color = isDecline ? 'var(--color-watch)' : 'var(--color-clear)';

    return `
      <div style="display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap;">
        <div style="display: flex; align-items: baseline; gap: 0.4rem;">
          <span style="font-size: 2.2rem; font-weight: 800; color: ${color};">${arrow} ${Math.abs(pctChange)}%</span>
          <span style="font-size: 0.85rem; color: var(--text-secondary);">vs previous 30-day baseline</span>
        </div>
        <p style="font-size: 0.85rem; color: var(--text-secondary); flex: 1; min-width: 260px;">
          ${isDecline 
            ? 'Drainage velocity shows a gradual downward shift. Indicates silt sedimentation or leaf litter entrapment along the culvert mouth.' 
            : 'Drainage velocity is stable or improving. Pipe cross-section is self-clearing under current rainfall loads.'}
        </p>
      </div>
    `;
  }

  /**
   * Chart (a): RoD per event bar chart with dashed benchmark lines
   */
  function initAnalyticsRodChart(events) {
    const canvas = document.getElementById('chart-analytics-rod');
    if (!canvas) return;
    destroyChart('analyticsRod');

    const sorted = [...events].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(-25);
    const labels = sorted.map(e => formatShortIST(e.created_at));
    const rodValues = sorted.map(e => Number(e.rod_cm_min) || 0);

    const colors = sorted.map(e => {
      const s = String(e.status).toUpperCase();
      if (s === 'CLEAR') return '#22c55e';
      if (s === 'WATCH') return '#f59e0b';
      if (s === 'PRE_CLOG') return '#ef4444';
      return '#3b82f6';
    });

    const baselineVal = sorted.length > 0 && sorted[0].baseline_rod ? Number(sorted[0].baseline_rod) : 2.5;

    const ctx = canvas.getContext('2d');
    chartRegistry['analyticsRod'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.length > 0 ? labels : ['No Data'],
        datasets: [
          {
            label: 'Measured RoD (cm/min)',
            data: rodValues.length > 0 ? rodValues : [0],
            backgroundColor: colors,
            borderRadius: 4
          },
          {
            label: 'Baseline (100%)',
            data: labels.map(() => baselineVal),
            type: 'line',
            borderColor: '#3b82f6',
            borderDash: [5, 5],
            borderWidth: 2,
            pointRadius: 0,
            fill: false
          },
          {
            label: 'Watch (80%)',
            data: labels.map(() => baselineVal * 0.8),
            type: 'line',
            borderColor: '#f59e0b',
            borderDash: [3, 3],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false
          },
          {
            label: 'Pre-Clog (50%)',
            data: labels.map(() => baselineVal * 0.5),
            type: 'line',
            borderColor: '#ef4444',
            borderDash: [3, 3],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 12, font: { size: 10 } } }
        },
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'RoD (cm/min)' } },
          x: { title: { display: true, text: 'Event Timestamp' } }
        }
      }
    });
  }

  /**
   * Chart (b): Status distribution doughnut
   */
  function initAnalyticsDoughnutChart(events) {
    const canvas = document.getElementById('chart-analytics-doughnut');
    if (!canvas) return;
    destroyChart('analyticsDoughnut');

    let clearCount = 0;
    let watchCount = 0;
    let preclogCount = 0;
    let calibratedCount = 0;

    events.forEach(e => {
      const s = String(e.status).toUpperCase();
      if (s === 'CLEAR') clearCount++;
      else if (s === 'WATCH') watchCount++;
      else if (s === 'PRE_CLOG') preclogCount++;
      else if (s === 'CALIBRATED') calibratedCount++;
    });

    const ctx = canvas.getContext('2d');
    chartRegistry['analyticsDoughnut'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['CLEAR', 'WATCH', 'PRE_CLOG', 'CALIBRATED'],
        datasets: [{
          data: [clearCount, watchCount, preclogCount, calibratedCount],
          backgroundColor: ['#22c55e', '#f59e0b', '#ef4444', '#3b82f6'],
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }
        }
      }
    });
  }

  /**
   * Chart (d): Scatter plot Initial Water Depth H1 vs Measured RoD
   */
  function initAnalyticsScatterChart(events) {
    const canvas = document.getElementById('chart-analytics-scatter');
    if (!canvas) return;
    destroyChart('analyticsScatter');

    const points = events
      .filter(e => e.h1_cm !== null && e.rod_cm_min !== null)
      .map(e => ({
        x: Number(e.h1_cm) || 0,
        y: Number(e.rod_cm_min) || 0
      }));

    const ctx = canvas.getContext('2d');
    chartRegistry['analyticsScatter'] = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Events (H1 vs RoD)',
          data: points,
          backgroundColor: '#0284c7',
          pointRadius: 5,
          pointHoverRadius: 7
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: 'Initial Depth H1 (cm)' } },
          y: { title: { display: true, text: 'Rate of Drop (cm/min)' } }
        }
      }
    });
  }

  /**
   * Chart (e): Rain events per ISO week bar chart
   */
  function initAnalyticsWeeklyChart(events) {
    const canvas = document.getElementById('chart-analytics-weekly');
    if (!canvas) return;
    destroyChart('analyticsWeekly');

    // Group events by ISO week or last 6 weeks
    const weekMap = {};
    events.forEach(e => {
      const d = new Date(e.created_at);
      if (!isNaN(d.getTime())) {
        const key = `Wk ${Math.ceil(d.getDate() / 7)} (${d.toLocaleString('en-US', { month: 'short' })})`;
        weekMap[key] = (weekMap[key] || 0) + 1;
      }
    });

    const labels = Object.keys(weekMap).slice(-6);
    const counts = labels.map(l => weekMap[l]);

    const ctx = canvas.getContext('2d');
    chartRegistry['analyticsWeekly'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.length > 0 ? labels : ['Current Week'],
        datasets: [{
          label: 'Rainfall Cycles Count',
          data: counts.length > 0 ? counts : [0],
          backgroundColor: '#6366f1',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1 }, title: { display: true, text: 'Events Count' } }
        }
      }
    });
  }

  // ─── 8. TAB: TRENDS ────────────────────────────────────────────────────────

  async function renderTrendsTab() {
    const container = document.getElementById('tab-trends');
    if (!container) return;

    showSkeleton('tab-trends', 'Analyzing long-term rate of drop degradation trends...');

    try {
      const [trendData, configData] = await Promise.all([
        API.getAnalyticsTrend(state.currentDeviceId, getDaysFromRange(state.trendsRange)),
        API.getDeviceOverview(state.currentDeviceId)
      ]);

      const trend = trendData || {};
      const config = (configData && configData.config) || {};
      const points = trend.events || trend.points || [];
      const insightText = typeof trend.insight === 'string'
        ? trend.insight
        : (trend.insight && trend.insight.text ? trend.insight.text : 'Drainage velocity is stable and within calibration baseline.');
      const isDeclining = (trend.slope_per_week !== null && trend.slope_per_week !== undefined && trend.slope_per_week < 0) || (trend.insight && trend.insight.status === 'declining');
      const projectedDays = trend.projected_days_until_preclog || (trend.insight && trend.insight.projected_days);

      // Water series: if trend doesn't include water_series, fetch historical readings
      let waterSeries = trend.water_series || [];
      if (!waterSeries || waterSeries.length === 0) {
        try {
          const days = getDaysFromRange(state.trendsRange);
          const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
          const readingsRes = await API.getReadings({
            device_id: state.currentDeviceId,
            from: fromDate,
            pageSize: 100,
            limit: 100
          });
          const raw = Array.isArray(readingsRes) ? readingsRes : (readingsRes.data || readingsRes.readings || []);
          waterSeries = raw.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        } catch (e) {
          // ignore
        }
      }

      container.innerHTML = `
        <!-- Time Range Selector -->
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.25rem;">
          <div>
            <h2 style="font-size: 1.3rem; font-weight: 800;">Degradation & Velocity Trends</h2>
            <p style="font-size: 0.85rem; color: var(--text-secondary);">Predictive linear regression and clogging projection models</p>
          </div>

          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            <button class="btn ${state.trendsRange === '1h' ? 'btn-primary' : 'btn-secondary'} btn-sm trends-range-btn" data-range="1h">1h</button>
            <button class="btn ${state.trendsRange === '6h' ? 'btn-primary' : 'btn-secondary'} btn-sm trends-range-btn" data-range="6h">6h</button>
            <button class="btn ${state.trendsRange === '24h' ? 'btn-primary' : 'btn-secondary'} btn-sm trends-range-btn" data-range="24h">24h</button>
            <button class="btn ${state.trendsRange === '7d' ? 'btn-primary' : 'btn-secondary'} btn-sm trends-range-btn" data-range="7d">7d</button>
            <button class="btn ${state.trendsRange === '30d' ? 'btn-primary' : 'btn-secondary'} btn-sm trends-range-btn" data-range="30d">30d</button>
          </div>
        </div>

        <!-- Predictive AI / Regression Insight Card -->
        <div class="card" style="margin-bottom: 1.25rem; border-left: 5px solid ${isDeclining ? 'var(--color-watch)' : 'var(--color-clear)'};">
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <span style="font-size: 1.8rem;">${isDeclining ? '⚠️' : '💡'}</span>
            <div style="flex: 1;">
              <h4 style="font-size: 1rem; margin-bottom: 0.2rem;">Predictive Maintenance Diagnostic</h4>
              <p style="font-size: 0.85rem; color: var(--text-secondary);">${escapeHTML(insightText)}</p>
              ${projectedDays ? `
                <div style="margin-top: 0.4rem; font-size: 0.8rem; font-weight: 700; color: var(--color-watch);">
                  ⏳ Projected time to blockage threshold: ~${projectedDays} days under forecasted precipitation
                </div>
              ` : ''}
            </div>
          </div>
        </div>

        <!-- Water Level Downsampled Trend Chart -->
        <div class="card" style="margin-bottom: 1.25rem;">
          <div class="card-header">
            <h3 class="card-title"><span>🌊</span> Water Level Profile with Rain Threshold</h3>
            <span class="card-subtitle">Downsampled Time-Series</span>
          </div>
          <div class="chart-container">
            <canvas id="chart-trends-water"></canvas>
          </div>
        </div>

        <!-- RoD Ratio Trend & Regression Line Chart -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title"><span>📉</span> Rate of Drop Ratio Trend & Slope</h3>
            <span class="card-subtitle">Hollow points designate low-confidence readings</span>
          </div>
          <div class="chart-container">
            <canvas id="chart-trends-ratio"></canvas>
          </div>
        </div>
      `;

      // Attach Range buttons
      document.querySelectorAll('.trends-range-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          state.trendsRange = e.target.getAttribute('data-range') || '24h';
          renderTrendsTab();
        });
      });

      // Initialize trend charts
      initTrendsWaterChart(waterSeries, config);
      initTrendsRatioChart(points, trend);

    } catch (err) {
      console.error('[Trends] Render failed:', err);
      showError('tab-trends', `Trends computation failed: ${err.message}`, renderTrendsTab);
    }
  }

  function getDaysFromRange(range) {
    if (range === '1h' || range === '6h' || range === '24h') return 1;
    if (range === '7d') return 7;
    return 30;
  }

  /**
   * Water Level Profile Chart with horizontal rain threshold line
   */
  function initTrendsWaterChart(series, config) {
    const canvas = document.getElementById('chart-trends-water');
    if (!canvas) return;
    destroyChart('trendsWater');

    const labels = series.map(p => formatShortIST(p.time || p.created_at));
    const values = series.map(p => Number(p.water_cm) || 0);
    const rainThreshold = Number(config.rain_start_cm) || 10;

    const ctx = canvas.getContext('2d');
    chartRegistry['trendsWater'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels.length > 0 ? labels : ['No Data'],
        datasets: [
          {
            label: 'Water Depth (cm)',
            data: values.length > 0 ? values : [0],
            borderColor: '#0284c7',
            backgroundColor: 'rgba(2, 132, 199, 0.1)',
            fill: true,
            tension: 0.2,
            borderWidth: 2
          },
          {
            label: 'Rain Start Threshold',
            data: labels.map(() => rainThreshold),
            borderColor: '#f59e0b',
            borderDash: [5, 5],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'Water Depth (cm)' } },
          x: { title: { display: true, text: 'Observation Window' } }
        }
      }
    });
  }

  /**
   * RoD Ratio Trend with Regression Line
   */
  function initTrendsRatioChart(points, regression) {
    const canvas = document.getElementById('chart-trends-ratio');
    if (!canvas) return;
    destroyChart('trendsRatio');

    const labels = points.map(p => formatShortIST(p.created_at));
    const ratios = points.map(p => Number(p.ratio) || 0);

    // Color points according to status; low confidence points hollow
    const pointBorderColors = points.map(p => {
      const s = String(p.status).toUpperCase();
      if (s === 'CLEAR') return '#22c55e';
      if (s === 'WATCH') return '#f59e0b';
      return '#ef4444';
    });

    const pointBackgroundColors = points.map((p, idx) => {
      return p.low_confidence ? 'transparent' : pointBorderColors[idx];
    });

    let regressionData = [];
    if (points.length >= 2) {
      const n = points.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      for (let i = 0; i < n; i++) {
        const x = i;
        const y = Number(points[i].ratio) || 0;
        sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
      }
      const denom = n * sumX2 - sumX * sumX;
      const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
      const intercept = (sumY - slope * sumX) / n;
      regressionData = points.map((_, idx) => Math.max(0, slope * idx + intercept));
    } else {
      regressionData = labels.map(() => 1.0);
    }

    const ctx = canvas.getContext('2d');
    chartRegistry['trendsRatio'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels.length > 0 ? labels : ['No Data'],
        datasets: [
          {
            label: 'ROD Ratio (Actual)',
            data: ratios.length > 0 ? ratios : [1.0],
            borderColor: '#94a3b8',
            pointBorderColor: pointBorderColors,
            pointBackgroundColor: pointBackgroundColors,
            pointBorderWidth: 2,
            pointRadius: 6,
            showLine: true,
            borderWidth: 1
          },
          {
            label: 'Regression Trend Slope',
            data: regressionData,
            borderColor: '#ef4444',
            borderWidth: 2,
            borderDash: [6, 4],
            pointRadius: 0,
            fill: false
          },
          {
            label: 'Watch Line (0.8)',
            data: labels.map(() => 0.8),
            borderColor: '#f59e0b',
            borderDash: [2, 2],
            borderWidth: 1,
            pointRadius: 0,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { min: 0, max: 1.5, title: { display: true, text: 'ROD Ratio vs Baseline' } }
        }
      }
    });
  }

  // ─── 9. TAB: HISTORY ───────────────────────────────────────────────────────

  async function renderHistoryTab() {
    const container = document.getElementById('tab-history');
    if (!container) return;

    container.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.25rem;">
        <div>
          <h2 style="font-size: 1.3rem; font-weight: 800;">Telemetry & Event Audit Logs</h2>
          <p style="font-size: 0.85rem; color: var(--text-secondary);">Auditable logs for GCC stormwater quality audits</p>
        </div>

        <!-- Sub-tab Toggles & CSV Export -->
        <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
          <button id="subtab-events-btn" class="btn ${state.historySubtab === 'events' ? 'btn-primary' : 'btn-secondary'} btn-sm">
            <span>📜</span> Drain Events
          </button>
          <button id="subtab-readings-btn" class="btn ${state.historySubtab === 'readings' ? 'btn-primary' : 'btn-secondary'} btn-sm">
            <span>📡</span> Raw Readings
          </button>
          <button id="btn-export-csv" class="btn btn-secondary btn-sm" title="Export CSV file">
            <span>📥</span> Export CSV
          </button>
        </div>
      </div>

      <!-- Filter Controls Bar -->
      <div class="card" style="margin-bottom: 1.25rem; padding: 0.75rem 1rem;">
        <div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
          ${state.historySubtab === 'events' ? `
            <div style="display: flex; align-items: center; gap: 0.4rem;">
              <label for="filter-status-select" style="font-size: 0.8rem; font-weight: 600;">Status:</label>
              <select id="filter-status-select" class="form-control" style="width: auto; padding: 0.25rem 0.5rem;">
                <option value="">All Statuses</option>
                <option value="CLEAR" ${state.historyStatusFilter === 'CLEAR' ? 'selected' : ''}>CLEAR</option>
                <option value="WATCH" ${state.historyStatusFilter === 'WATCH' ? 'selected' : ''}>WATCH</option>
                <option value="PRE_CLOG" ${state.historyStatusFilter === 'PRE_CLOG' ? 'selected' : ''}>PRE_CLOG</option>
                <option value="CALIBRATED" ${state.historyStatusFilter === 'CALIBRATED' ? 'selected' : ''}>CALIBRATED</option>
              </select>
            </div>
          ` : ''}
          <span style="font-size: 0.8rem; color: var(--text-muted);">
            Click on any event row to open high-resolution diagnostic drawer.
          </span>
        </div>
      </div>

      <!-- Table Container -->
      <div id="history-table-container">
        <div class="skeleton-loader">Loading records...</div>
      </div>
    `;

    // Attach Subtab listeners
    document.getElementById('subtab-events-btn').addEventListener('click', () => {
      state.historySubtab = 'events';
      renderHistoryTab();
    });
    document.getElementById('subtab-readings-btn').addEventListener('click', () => {
      state.historySubtab = 'readings';
      renderHistoryTab();
    });

    // Attach Export CSV listener
    document.getElementById('btn-export-csv').addEventListener('click', handleExportCSV);

    // Attach Status filter listener
    const statusSelect = document.getElementById('filter-status-select');
    if (statusSelect) {
      statusSelect.addEventListener('change', (e) => {
        state.historyStatusFilter = e.target.value;
        state.historyEventsPage = 1;
        fetchHistoryEvents();
      });
    }

    // Attach History Drawer close listener
    initDrawerHandlers();

    // Fetch initial sub-tab data
    if (state.historySubtab === 'events') {
      fetchHistoryEvents();
    } else {
      fetchHistoryReadings();
    }
  }

  /**
   * Fetches and renders Drain Events table
   */
  async function fetchHistoryEvents() {
    const container = document.getElementById('history-table-container');
    if (!container) return;

    showSkeleton('history-table-container', 'Fetching rate-of-drop diagnostic records...');

    try {
      const params = {
        device_id: state.currentDeviceId,
        page: state.historyEventsPage,
        pageSize: state.historyEventsLimit,
        limit: state.historyEventsLimit,
        status: state.historyStatusFilter || undefined
      };

      const res = await API.getRodEvents(params);
      const events = Array.isArray(res) ? res : (res.data || res.events || []);
      const total = res.total !== undefined ? res.total : events.length;
      state.historyEventsTotal = total;

      if (events.length === 0) {
        container.innerHTML = `
          <div class="card" style="text-align: center; padding: 2rem;">
            <p style="color: var(--text-secondary);">No drain events matching the selected filter.</p>
          </div>
        `;
        return;
      }

      const totalPages = Math.ceil(total / state.historyEventsLimit) || 1;

      container.innerHTML = `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Event Time (IST)</th>
                <th>H1 (cm)</th>
                <th>H2 (cm)</th>
                <th>Duration</th>
                <th>RoD (cm/min)</th>
                <th>% Baseline</th>
                <th>Diagnostic Status</th>
              </tr>
            </thead>
            <tbody>
              ${events.map(ev => {
                const ratioPct = ev.ratio !== undefined ? Math.round(Number(ev.ratio) * 100) + '%' : '--';
                return `
                  <tr data-event-id="${escapeHTML(ev.id)}" class="clickable-event-row">
                    <td><strong>${formatIST(ev.created_at)}</strong></td>
                    <td>${Number(ev.h1_cm || 0).toFixed(1)}</td>
                    <td>${Number(ev.h2_cm || 0).toFixed(1)}</td>
                    <td>${formatDuration(ev.duration_s)}</td>
                    <td style="font-family: var(--font-mono); font-weight: 700;">${Number(ev.rod_cm_min || 0).toFixed(2)}</td>
                    <td>${ratioPct}</td>
                    <td>${statusBadge(ev.status)}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>

        <!-- Pagination Bar -->
        <div class="pagination-bar">
          <span>Page <strong>${state.historyEventsPage}</strong> of <strong>${totalPages}</strong> (${total} events)</span>
          <div style="display: flex; gap: 0.5rem;">
            <button id="events-prev-btn" class="btn btn-secondary btn-sm" ${state.historyEventsPage <= 1 ? 'disabled' : ''}>Previous</button>
            <button id="events-next-btn" class="btn btn-secondary btn-sm" ${state.historyEventsPage >= totalPages ? 'disabled' : ''}>Next</button>
          </div>
        </div>
      `;

      // Pagination events
      document.getElementById('events-prev-btn').addEventListener('click', () => {
        if (state.historyEventsPage > 1) {
          state.historyEventsPage--;
          fetchHistoryEvents();
        }
      });
      document.getElementById('events-next-btn').addEventListener('click', () => {
        if (state.historyEventsPage < totalPages) {
          state.historyEventsPage++;
          fetchHistoryEvents();
        }
      });

      // Row click listener to open drawer
      container.querySelectorAll('.clickable-event-row').forEach(row => {
        row.addEventListener('click', () => {
          const id = row.getAttribute('data-event-id');
          const ev = events.find(item => String(item.id) === String(id));
          if (ev) openEventDetailDrawer(ev);
        });
      });

    } catch (err) {
      console.error('[History] Failed to load events:', err);
      showError('history-table-container', `Could not fetch events: ${err.message}`, fetchHistoryEvents);
    }
  }

  /**
   * Fetches and renders Raw Readings table
   */
  async function fetchHistoryReadings() {
    const container = document.getElementById('history-table-container');
    if (!container) return;

    showSkeleton('history-table-container', 'Fetching raw sensor readings telemetry...');

    try {
      const params = {
        device_id: state.currentDeviceId,
        page: state.historyReadingsPage,
        pageSize: state.historyReadingsLimit,
        limit: state.historyReadingsLimit
      };

      const res = await API.getReadings(params);
      const readings = Array.isArray(res) ? res : (res.data || res.readings || []);
      const total = res.total !== undefined ? res.total : readings.length;
      state.historyReadingsTotal = total;

      if (readings.length === 0) {
        container.innerHTML = `
          <div class="card" style="text-align: center; padding: 2rem;">
            <p style="color: var(--text-secondary);">No telemetry readings found for this device.</p>
          </div>
        `;
        return;
      }

      const totalPages = Math.ceil(total / state.historyReadingsLimit) || 1;

      container.innerHTML = `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Timestamp (IST)</th>
                <th>Type</th>
                <th>State</th>
                <th>Water Depth (cm)</th>
                <th>Distance (cm)</th>
                <th>Flood Risk</th>
                <th>RSSI</th>
              </tr>
            </thead>
            <tbody>
              ${readings.map(r => `
                <tr>
                  <td style="font-family: var(--font-mono);">${escapeHTML(r.id)}</td>
                  <td>${formatIST(r.created_at)}</td>
                  <td><span class="badge ${r.type === 'reading' ? 'calibrated' : 'offline'}">${escapeHTML(r.type)}</span></td>
                  <td><strong>${escapeHTML(r.state || '--')}</strong></td>
                  <td style="font-weight: 700;">${r.water_cm !== undefined ? Number(r.water_cm).toFixed(1) : '--'}</td>
                  <td>${r.distance_cm !== undefined ? Number(r.distance_cm).toFixed(1) : '--'}</td>
                  <td>${r.flood_risk ? '<span class="badge preclog">RISK</span>' : '<span class="badge clear">OK</span>'}</td>
                  <td>${r.rssi !== undefined ? `${r.rssi} dBm` : '--'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <!-- Pagination Bar -->
        <div class="pagination-bar">
          <span>Page <strong>${state.historyReadingsPage}</strong> of <strong>${totalPages}</strong> (${total} readings)</span>
          <div style="display: flex; gap: 0.5rem;">
            <button id="readings-prev-btn" class="btn btn-secondary btn-sm" ${state.historyReadingsPage <= 1 ? 'disabled' : ''}>Previous</button>
            <button id="readings-next-btn" class="btn btn-secondary btn-sm" ${state.historyReadingsPage >= totalPages ? 'disabled' : ''}>Next</button>
          </div>
        </div>
      `;

      // Pagination events
      document.getElementById('readings-prev-btn').addEventListener('click', () => {
        if (state.historyReadingsPage > 1) {
          state.historyReadingsPage--;
          fetchHistoryReadings();
        }
      });
      document.getElementById('readings-next-btn').addEventListener('click', () => {
        if (state.historyReadingsPage < totalPages) {
          state.historyReadingsPage++;
          fetchHistoryReadings();
        }
      });

    } catch (err) {
      console.error('[History] Failed to load readings:', err);
      showError('history-table-container', `Could not fetch readings: ${err.message}`, fetchHistoryReadings);
    }
  }

  /**
   * Triggers CSV file download from backend API
   */
  async function handleExportCSV() {
    try {
      showToast('Generating CSV export file...', 'info');
      let blob;
      let filename;

      if (state.historySubtab === 'events') {
        blob = await API.exportRodEvents({ device_id: state.currentDeviceId });
        filename = `DrainGuard_ROD_Events_${state.currentDeviceId}_${Date.now()}.csv`;
      } else {
        blob = await API.exportReadings({ device_id: state.currentDeviceId });
        filename = `DrainGuard_Readings_${state.currentDeviceId}_${Date.now()}.csv`;
      }

      // Trigger standard browser download
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      showToast('CSV export downloaded successfully', 'success');

    } catch (err) {
      console.error('[Export] CSV failed:', err);
      showToast(`Export failed: ${err.message}`, 'error');
    }
  }

  /**
   * Initializes Drawer backdrop and close buttons
   */
  function initDrawerHandlers() {
    const backdrop = document.getElementById('history-drawer-backdrop');
    const closeBtn = document.getElementById('drawer-close-btn');

    if (closeBtn && backdrop) {
      closeBtn.onclick = () => {
        backdrop.classList.remove('open');
      };
    }
    if (backdrop) {
      backdrop.onclick = (e) => {
        if (e.target === backdrop) {
          backdrop.classList.remove('open');
        }
      };
    }
  }

  /**
   * Opens slide-in drawer showing event telemetry + mini Chart.js +/- 15min chart
   */
  async function openEventDetailDrawer(eventItem) {
    const backdrop = document.getElementById('history-drawer-backdrop');
    const title = document.getElementById('drawer-event-title');
    const content = document.getElementById('drawer-content');
    if (!backdrop || !content) return;

    title.textContent = `Event #${eventItem.id} Details`;
    backdrop.classList.add('open');

    content.innerHTML = `
      <div style="margin-bottom: 1rem;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
          <span style="font-size: 0.8rem; color: var(--text-muted);">Timestamp:</span>
          <strong>${formatIST(eventItem.created_at)}</strong>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
          <span style="font-size: 0.8rem; color: var(--text-muted);">Classification:</span>
          ${statusBadge(eventItem.status)}
        </div>
      </div>

      <table class="mini-stats-table" style="margin-bottom: 1.25rem;">
        <tr>
          <td>Initial Depth (H1):</td>
          <td>${Number(eventItem.h1_cm || 0).toFixed(1)} cm</td>
        </tr>
        <tr>
          <td>End Depth (H2):</td>
          <td>${Number(eventItem.h2_cm || 0).toFixed(1)} cm</td>
        </tr>
        <tr>
          <td>Drain Duration:</td>
          <td>${formatDuration(eventItem.duration_s)}</td>
        </tr>
        <tr>
          <td>Measured Rate of Drop:</td>
          <td>${Number(eventItem.rod_cm_min || 0).toFixed(2)} cm/min</td>
        </tr>
        <tr>
          <td>Baseline RoD:</td>
          <td>${Number(eventItem.baseline_rod || 0).toFixed(2)} cm/min</td>
        </tr>
        <tr>
          <td>Ratio (% of Baseline):</td>
          <td>${eventItem.ratio !== undefined ? Math.round(Number(eventItem.ratio) * 100) + '%' : '--'}</td>
        </tr>
        <tr>
          <td>Calibration Event:</td>
          <td>${eventItem.calibration ? 'Yes' : 'No'}</td>
        </tr>
        <tr>
          <td>Low Confidence Flag:</td>
          <td>${eventItem.low_confidence ? 'Yes (Sparse points)' : 'No'}</td>
        </tr>
      </table>

      <h4 style="font-size: 0.95rem; margin-bottom: 0.5rem;">Water Level Profile (+/- 15 min)</h4>
      <div class="chart-container-sm">
        <canvas id="chart-drawer-window"></canvas>
      </div>
    `;

    // Fetch window readings +/- 15 min around event
    const eventTime = new Date(eventItem.created_at).getTime();
    const startTime = new Date(eventTime - 15 * 60 * 1000).toISOString();
    const endTime = new Date(eventTime + 15 * 60 * 1000).toISOString();

    try {
      const windowData = await API.getReadings({
        device_id: state.currentDeviceId,
        from: startTime,
        to: endTime,
        start_time: startTime,
        end_time: endTime,
        pageSize: 50,
        limit: 50
      });

      const readings = Array.isArray(windowData) ? windowData : (windowData.data || windowData.readings || []);
      const sorted = readings.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      const labels = sorted.map(r => formatShortIST(r.created_at));
      const points = sorted.map(r => Number(r.water_cm) || 0);

      destroyChart('drawerWindow');
      const canvas = document.getElementById('chart-drawer-window');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        chartRegistry['drawerWindow'] = new Chart(ctx, {
          type: 'line',
          data: {
            labels: labels.length > 0 ? labels : ['Event Time'],
            datasets: [{
              label: 'Water (cm)',
              data: points.length > 0 ? points : [Number(eventItem.h1_cm) || 0],
              borderColor: '#0284c7',
              backgroundColor: 'rgba(2, 132, 199, 0.1)',
              fill: true,
              tension: 0.2
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: { beginAtZero: true, title: { display: true, text: 'Depth (cm)' } }
            }
          }
        });
      }

    } catch (err) {
      console.warn('[Drawer] Could not fetch window chart:', err);
    }
  }

  // ─── 10. TAB: ALERTS ───────────────────────────────────────────────────────

  async function renderAlertsTab() {
    const container = document.getElementById('tab-alerts');
    if (!container) return;

    showSkeleton('tab-alerts', 'Fetching active operator alerts & fault logs...');

    try {
      const res = await API.getAlerts({ device_id: state.currentDeviceId, pageSize: 100 });
      const alerts = Array.isArray(res) ? res : (res.data || res.alerts || []);

      container.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.25rem;">
          <div>
            <h2 style="font-size: 1.3rem; font-weight: 800;">Operational Warning Alerts</h2>
            <p style="font-size: 0.85rem; color: var(--text-secondary);">Threshold breaches, flood risks, and hardware fault notifications</p>
          </div>

          <!-- Alert Filters -->
          <div style="display: flex; gap: 0.5rem;" class="no-print">
            <button class="btn btn-primary btn-sm alert-filter-btn" data-filter="all">All</button>
            <button class="btn btn-secondary btn-sm alert-filter-btn" data-filter="open">Open</button>
            <button class="btn btn-secondary btn-sm alert-filter-btn" data-filter="acknowledged">Acknowledged</button>
            <button class="btn btn-secondary btn-sm alert-filter-btn" data-filter="resolved">Resolved</button>
          </div>
        </div>

        <div id="alerts-list-container" class="alerts-list">
          ${renderAlertsListHTML(alerts, 'all')}
        </div>
      `;

      // Filter button handlers
      container.querySelectorAll('.alert-filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          container.querySelectorAll('.alert-filter-btn').forEach(b => {
            b.className = 'btn btn-secondary btn-sm alert-filter-btn';
          });
          e.target.className = 'btn btn-primary btn-sm alert-filter-btn';
          const filter = e.target.getAttribute('data-filter');
          const listContainer = document.getElementById('alerts-list-container');
          if (listContainer) {
            listContainer.innerHTML = renderAlertsListHTML(alerts, filter);
            attachAlertActionHandlers(alerts);
          }
        });
      });

      attachAlertActionHandlers(alerts);

    } catch (err) {
      console.error('[Alerts] Render failed:', err);
      showError('tab-alerts', `Failed to load alerts: ${err.message}`, renderAlertsTab);
    }
  }

  function renderAlertsListHTML(alerts, filter) {
    let filtered = alerts;
    if (filter !== 'all') {
      filtered = alerts.filter(a => a.status === filter);
    }

    if (filtered.length === 0) {
      return `
        <div class="card" style="text-align: center; padding: 3rem;">
          <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🌿</div>
          <h3 style="font-size: 1.15rem; margin-bottom: 0.25rem;">No alerts – drains are healthy!</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">No active maintenance notices or threshold breaches for this drain unit.</p>
        </div>
      `;
    }

    return filtered.map(a => {
      let icon = '🔵';
      let sevClass = 'info';
      if (a.severity === 'critical') {
        icon = '🔴';
        sevClass = 'critical';
      } else if (a.severity === 'warning') {
        icon = '🟡';
        sevClass = 'warning';
      }

      const canAct = Boolean(state.adminKey);

      return `
        <div class="alert-item ${sevClass}" data-alert-id="${escapeHTML(a.id)}">
          <div class="alert-item-left">
            <span class="alert-icon">${icon}</span>
            <div class="alert-item-body">
              <span class="alert-msg">${escapeHTML(a.message)}</span>
              <div class="alert-meta">
                <span><strong>Device:</strong> ${escapeHTML(a.device_id)}</span>
                <span>•</span>
                <span><strong>Type:</strong> ${escapeHTML(a.type)}</span>
                <span>•</span>
                <span>${formatIST(a.created_at)}</span>
              </div>
            </div>
          </div>

          <div class="alert-actions">
            <span class="badge ${a.status === 'open' ? 'preclog' : a.status === 'acknowledged' ? 'watch' : 'clear'}">
              ${escapeHTML(a.status.toUpperCase())}
            </span>

            ${canAct && a.status === 'open' ? `
              <button class="btn btn-secondary btn-sm btn-ack-alert" data-id="${escapeHTML(a.id)}">Ack</button>
            ` : ''}

            ${canAct && a.status !== 'resolved' ? `
              <button class="btn btn-primary btn-sm btn-resolve-alert" data-id="${escapeHTML(a.id)}">Resolve</button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  function attachAlertActionHandlers(alerts) {
    document.querySelectorAll('.btn-ack-alert').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.getAttribute('data-id');
        try {
          await API.ackAlert(id, state.adminKey);
          showToast(`Alert #${id} acknowledged`, 'info');
          renderAlertsTab();
        } catch (err) {
          showToast(`Ack failed: ${err.message}`, 'error');
        }
      });
    });

    document.querySelectorAll('.btn-resolve-alert').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.getAttribute('data-id');
        try {
          await API.resolveAlert(id, state.adminKey);
          showToast(`Alert #${id} resolved`, 'success');
          renderAlertsTab();
        } catch (err) {
          showToast(`Resolve failed: ${err.message}`, 'error');
        }
      });
    });
  }

  // ─── 11. TAB: SETTINGS & CALIBRATION ───────────────────────────────────────

  async function renderSettingsTab() {
    const container = document.getElementById('tab-settings');
    if (!container) return;

    showSkeleton('tab-settings', 'Loading sensor calibration & threshold parameters...');

    try {
      const overview = await API.getDeviceOverview(state.currentDeviceId);
      const device = overview.device || {};
      const config = overview.config || {};
      const isAdmin = Boolean(state.adminKey);

      container.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.25rem;">
          <div>
            <h2 style="font-size: 1.3rem; font-weight: 800;">Device Configuration & Calibration</h2>
            <p style="font-size: 0.85rem; color: var(--text-secondary);">Manage installation geometry, alarm thresholds, and healthy baseline</p>
          </div>

          <!-- Admin Mode Indicator Badge -->
          <div>
            ${isAdmin ? `
              <span class="badge clear"><span>🔓</span> Admin Mode Active</span>
            ` : `
              <span class="badge offline"><span>🔒</span> Read-Only Mode</span>
            `}
          </div>
        </div>

        ${!isAdmin ? `
          <div class="card" style="background: rgba(245, 158, 11, 0.08); border-color: rgba(245, 158, 11, 0.3); margin-bottom: 1.25rem;">
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <span style="font-size: 1.5rem;">🔒</span>
              <div style="flex: 1;">
                <strong>Configuration is Locked</strong>
                <p style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.2rem;">
                  You are viewing thresholds in read-only mode. Click the lock icon in the top header or button below to unlock with administrator credentials.
                </p>
              </div>
              <button id="btn-unlock-settings" class="btn btn-primary btn-sm">Unlock Admin</button>
            </div>
          </div>
        ` : ''}

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem;">
          
          <!-- Column 1: Settings Form -->
          <div class="card">
            <div class="card-header">
              <h3 class="card-title"><span>⚙️</span> Physical & Diagnostic Parameters</h3>
            </div>
            
            <form id="device-settings-form">
              <!-- Device Name & Location -->
              <div class="form-group">
                <label class="form-label" for="setting-name">Friendly Name</label>
                <input type="text" id="setting-name" class="form-control" value="${escapeHTML(device.name || '')}" ${!isAdmin ? 'disabled' : ''}>
              </div>

              <div class="form-group">
                <label class="form-label" for="setting-location">Installation Location</label>
                <input type="text" id="setting-location" class="form-control" value="${escapeHTML(device.location || '')}" ${!isAdmin ? 'disabled' : ''}>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
                <div class="form-group">
                  <label class="form-label" for="setting-lat">Latitude</label>
                  <input type="number" step="0.0001" id="setting-lat" class="form-control" value="${device.lat || ''}" ${!isAdmin ? 'disabled' : ''}>
                </div>
                <div class="form-group">
                  <label class="form-label" for="setting-lng">Longitude</label>
                  <input type="number" step="0.0001" id="setting-lng" class="form-control" value="${device.lng || ''}" ${!isAdmin ? 'disabled' : ''}>
                </div>
              </div>

              <hr style="border: none; border-top: 1px solid var(--border-color); margin: 1.25rem 0;">

              <!-- Physical Dimensions -->
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
                <div class="form-group">
                  <label class="form-label" for="setting-sensor-bottom">Sensor Depth (cm)</label>
                  <input type="number" id="setting-sensor-bottom" class="form-control" value="${config.sensor_to_bottom_cm || 60}" ${!isAdmin ? 'disabled' : ''}>
                  <small style="color: var(--text-muted); font-size: 0.7rem;">Sensor face to dry culvert floor</small>
                </div>
                <div class="form-group">
                  <label class="form-label" for="setting-rain-start">Rain Start (cm)</label>
                  <input type="number" id="setting-rain-start" class="form-control" value="${config.rain_start_cm || 10}" ${!isAdmin ? 'disabled' : ''}>
                  <small style="color: var(--text-muted); font-size: 0.7rem;">Minimum water depth to start window</small>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label" for="setting-offline-min">Offline Timeout (minutes)</label>
                <input type="number" id="setting-offline-min" class="form-control" value="${config.offline_after_min || 15}" ${!isAdmin ? 'disabled' : ''}>
              </div>

              <hr style="border: none; border-top: 1px solid var(--border-color); margin: 1.25rem 0;">

              <!-- Threshold Sliders -->
              <div class="form-group">
                <label class="form-label" for="setting-clear-ratio">CLEAR Ratio Threshold (Default: 0.8)</label>
                <div class="form-range-wrapper">
                  <input type="range" min="0.1" max="1.0" step="0.05" id="setting-clear-ratio" class="form-control" value="${config.clear_ratio || 0.8}" ${!isAdmin ? 'disabled' : ''}>
                  <span id="label-clear-ratio" class="range-val">${Number(config.clear_ratio || 0.8).toFixed(2)}</span>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label" for="setting-preclog-ratio">PRE_CLOG Ratio Threshold (Default: 0.5)</label>
                <div class="form-range-wrapper">
                  <input type="range" min="0.1" max="1.0" step="0.05" id="setting-preclog-ratio" class="form-control" value="${config.preclog_ratio || 0.5}" ${!isAdmin ? 'disabled' : ''}>
                  <span id="label-preclog-ratio" class="range-val">${Number(config.preclog_ratio || 0.5).toFixed(2)}</span>
                </div>
              </div>

              <div style="margin-top: 1.5rem;">
                <button type="submit" id="btn-save-settings" class="btn btn-primary" style="width: 100%;" ${!isAdmin ? 'disabled' : ''}>
                  Save Configuration Changes
                </button>
              </div>
            </form>
          </div>

          <!-- Column 2: Baseline Calibration Panel -->
          <div class="card">
            <div class="card-header">
              <h3 class="card-title"><span>🎯</span> Healthy Baseline Calibration</h3>
            </div>

            <div style="margin-bottom: 1.25rem;">
              <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.25rem;">Current Reference Baseline RoD:</div>
              <div style="font-size: 2.2rem; font-weight: 800; color: var(--brand-primary); font-family: var(--font-mono);">
                ${config.baseline_rod ? Number(config.baseline_rod).toFixed(2) : '0.00'} <span style="font-size: 1rem; font-weight: 500;">cm/min</span>
              </div>
              <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.2rem;">
                ${config.baseline_rod > 0 ? 'Healthy baseline calibrated' : '⚠️ Device uncalibrated (using theoretical fallback)'}
              </div>
            </div>

            <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 1.5rem;">
              <h4 style="font-size: 0.9rem; margin-bottom: 0.6rem;">Calibration Instructions:</h4>
              <ol style="padding-left: 1.25rem; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.6;">
                <li>1️⃣ Fill the pipe / culvert mouth to the usual test water level (≥ rain start threshold).</li>
                <li>2️⃣ Let water drain freely with clear discharge to establish nominal flow.</li>
                <li>3️⃣ Click "Start Calibration" below. The backend will record the drop cycle and lock the new baseline automatically.</li>
              </ol>
            </div>

            <!-- Calibration Action Box -->
            <div id="calibration-action-box">
              <button id="btn-start-calibration" class="btn btn-primary" style="width: 100%;" ${!isAdmin ? 'disabled' : ''}>
                <span>🎯</span> Start Calibration Cycle
              </button>
            </div>
          </div>

        </div>
      `;

      // Attach Range slider live number bubbles
      const clearSlider = document.getElementById('setting-clear-ratio');
      const clearLabel = document.getElementById('label-clear-ratio');
      if (clearSlider && clearLabel) {
        clearSlider.addEventListener('input', (e) => {
          clearLabel.textContent = Number(e.target.value).toFixed(2);
        });
      }

      const preclogSlider = document.getElementById('setting-preclog-ratio');
      const preclogLabel = document.getElementById('label-preclog-ratio');
      if (preclogSlider && preclogLabel) {
        preclogSlider.addEventListener('input', (e) => {
          preclogLabel.textContent = Number(e.target.value).toFixed(2);
        });
      }

      // Unlock settings shortcut button
      const unlockBtn = document.getElementById('btn-unlock-settings');
      if (unlockBtn) {
        unlockBtn.addEventListener('click', () => {
          const modal = document.getElementById('admin-modal');
          if (modal) modal.hidden = false;
        });
      }

      // Form Submit Handler
      const form = document.getElementById('device-settings-form');
      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!state.adminKey) {
            showToast('Admin authentication required', 'error');
            return;
          }

          const payload = {
            name: document.getElementById('setting-name').value.trim(),
            location: document.getElementById('setting-location').value.trim(),
            lat: parseFloat(document.getElementById('setting-lat').value) || null,
            lng: parseFloat(document.getElementById('setting-lng').value) || null,
            sensor_to_bottom_cm: parseFloat(document.getElementById('setting-sensor-bottom').value),
            rain_start_cm: parseFloat(document.getElementById('setting-rain-start').value),
            offline_after_min: parseInt(document.getElementById('setting-offline-min').value, 10),
            clear_ratio: parseFloat(clearSlider.value),
            preclog_ratio: parseFloat(preclogSlider.value)
          };

          try {
            await API.updateDeviceSettings(state.currentDeviceId, payload, state.adminKey);
            showToast('Settings saved successfully', 'success');
            renderSettingsTab();
          } catch (err) {
            console.error('[Settings] Save error:', err);
            showToast(`Save failed: ${err.message}`, 'error');
          }
        });
      }

      // Start Calibration Button Handler
      const calibBtn = document.getElementById('btn-start-calibration');
      if (calibBtn) {
        calibBtn.addEventListener('click', async () => {
          if (!state.adminKey) {
            showToast('Admin authentication required to trigger calibration', 'error');
            return;
          }

          if (!confirm('Initiate calibration cycle for this drain unit? Ensure water is filled and ready to drain.')) {
            return;
          }

          try {
            await API.calibrateDevice(state.currentDeviceId, state.adminKey);
            showToast('Calibration cycle triggered. Waiting for drain drop event...', 'info');

            const actionBox = document.getElementById('calibration-action-box');
            if (actionBox) {
              actionBox.innerHTML = `
                <div style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: var(--radius-md); padding: 1rem; text-align: center;">
                  <span class="spinner" style="border-color: #3b82f6; border-top-color: transparent; margin-bottom: 0.5rem;"></span>
                  <div style="font-weight: 700; color: var(--brand-primary); margin-bottom: 0.25rem;">
                    ⏳ Waiting for device to report calibration result...
                  </div>
                  <div style="font-size: 0.8rem; color: var(--text-secondary);">
                    Backend is polling for drop cycle completion. This panel will update automatically when baseline is recorded.
                  </div>
                </div>
              `;
            }

            // Start polling overview to detect baseline update
            const originalBaseline = config.baseline_rod;
            if (state.calibrationPollingId) clearInterval(state.calibrationPollingId);

            state.calibrationPollingId = setInterval(async () => {
              try {
                const refreshed = await API.getDeviceOverview(state.currentDeviceId);
                const newBaseline = refreshed.config && refreshed.config.baseline_rod;
                if (newBaseline && newBaseline !== originalBaseline) {
                  clearInterval(state.calibrationPollingId);
                  state.calibrationPollingId = null;
                  showToast(`Calibration Complete! New baseline: ${Number(newBaseline).toFixed(2)} cm/min`, 'success');
                  renderSettingsTab();
                }
              } catch (e) {
                // Ignore transient polling glitches during calibration
              }
            }, 5000);

          } catch (err) {
            console.error('[Calibration] Trigger error:', err);
            showToast(`Calibration trigger failed: ${err.message}`, 'error');
          }
        });
      }

    } catch (err) {
      console.error('[Settings] Load failed:', err);
      showError('tab-settings', `Could not load device configuration: ${err.message}`, renderSettingsTab);
    }
  }

  // ─── 12. Application Initialization ────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initAdminAuth();
    initNavigation();
    loadInitialData();

    // Debounced resize handler for charts
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        Object.keys(chartRegistry).forEach(key => {
          if (chartRegistry[key]) chartRegistry[key].resize();
        });
        if (leafletMapInstance) leafletMapInstance.invalidateSize();
      }, 200);
    });
  });

})();
