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
  let savedLiveGeo = null;
  try {
    const rawGeo = localStorage.getItem('drainGuardLiveLocation');
    if (rawGeo) savedLiveGeo = JSON.parse(rawGeo);
  } catch (_) {}

  const state = {
    currentDeviceId: null,
    devices: [],
    activeTab: 'overview',
    pollIntervalId: null,
    adminKey: sessionStorage.getItem('adminKey') || sessionStorage.getItem('drainGuardAdminKey') || null,
    knownAlertIds: new Set(),
    activeOverview: null,
    liveLocation: savedLiveGeo, // { lat, lng, label, source, updatedAt }
    locationDetecting: false,
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
    trendsUserPicked: false,
    calibrationPollingId: null,
    soundAlertsEnabled: localStorage.getItem('drainGuard_sound_alerts') !== 'false', // Default enabled (audible alarms)
    activeSirenAudio: null,
    acknowledgedAlertMap: (() => {
      try {
        return JSON.parse(localStorage.getItem('drainGuard_acked_alerts') || '{}');
      } catch (_) {
        return {};
      }
    })(),
    currentActiveCriticalAlert: null
  };

  // Registry to hold active Chart.js and Leaflet instances for safe cleanup
  const chartRegistry = {};
  let leafletMapInstance = null;
  let leafletMarkerInstance = null;
  let renderedOverviewDeviceId = null;

  // In-memory stale-while-revalidate cache so revisiting tabs renders in 0ms
  const tabCache = {
    analytics: {},
    trends: {},
    alerts: {}
  };

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
   * Renders an engaging ultrasonic sonar & hydraulic waveform loader with shimmer skeleton tiles
   */
  function showSkeleton(elementId, text = 'Syncing live telemetry...') {
    const el = document.getElementById(elementId);
    if (el) {
      el.innerHTML = `
        <div class="skeleton-loader" role="status" aria-live="polite">
          <div class="dg-sonar-orb" aria-hidden="true">
            <span class="dg-sonar-ring"></span>
            <span class="dg-sonar-ring ring-2"></span>
            <span class="dg-sonar-ring ring-3"></span>
            <span class="dg-sonar-core">⚡</span>
          </div>
          <div class="dg-loader-wave" aria-hidden="true">
            <span></span><span></span><span></span><span></span><span></span>
          </div>
          <div class="dg-loader-caption">${escapeHTML(text)}</div>
          <div class="dg-loader-subcards" aria-hidden="true">
            <div class="dg-shimmer-tile"></div>
            <div class="dg-shimmer-tile"></div>
            <div class="dg-shimmer-tile"></div>
          </div>
        </div>
      `;
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

  /**
   * Normalizes legacy seed/placeholder names so project UI never shows "Demo Drain"
   */
  function sanitizeDeviceName(name, id) {
    if (!name || /demo drain|mock pvc/i.test(name)) {
      return id === 'drain-01' ? 'DrainGuard Unit 01' : `DrainGuard Unit (${id || '01'})`;
    }
    return name;
  }

  /**
   * Resolves effective device location: adaptive live GPS/device location if available,
   * otherwise falls back to saved device metadata.
   */
  function getEffectiveLocation(device) {
    if (state.liveLocation && typeof state.liveLocation.lat === 'number' && typeof state.liveLocation.lng === 'number') {
      return {
        lat: state.liveLocation.lat,
        lng: state.liveLocation.lng,
        label: state.liveLocation.label || `${state.liveLocation.lat.toFixed(4)}°, ${state.liveLocation.lng.toFixed(4)}°`,
        isLive: true,
        source: state.liveLocation.source || 'gps'
      };
    }
    const rawLoc = device && device.location;
    const label = (!rawLoc || rawLoc === 'Chennai') ? 'Active Field Site' : rawLoc;
    return {
      lat: device && device.lat ? Number(device.lat) : 13.0827,
      lng: device && device.lng ? Number(device.lng) : 80.2707,
      label,
      isLive: false,
      source: 'stored'
    };
  }

  /**
   * Reverse-geocodes coordinates using OpenStreetMap Nominatim (with coordinate fallback)
   */
  async function reverseGeocode(lat, lng) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=14`,
        { headers: { 'Accept': 'application/json' }, signal: controller.signal }
      );
      clearTimeout(t);
      if (res.ok) {
        const geo = await res.json();
        const addr = geo.address || {};
        const area = addr.suburb || addr.neighbourhood || addr.city_district || addr.town || addr.village;
        const city = addr.city || addr.state_district || addr.state;
        if (area && city && area !== city) return `${area}, ${city}`;
        if (city || area) return city || area;
      }
    } catch (_) {
      // Fallback to crisp coordinates
    }
    return `${lat.toFixed(4)}° N, ${lng.toFixed(4)}° E`;
  }

  /**
   * Detects the current physical location of the device viewing/hosting the dashboard
   * Uses Browser Geolocation first, then falls back to lightweight IP geolocation if needed.
   */
  async function detectCurrentLocation(silent = true) {
    if (state.locationDetecting) return state.liveLocation;
    state.locationDetecting = true;

    const applyCoords = async (lat, lng, source) => {
      const label = await reverseGeocode(lat, lng);
      state.liveLocation = {
        lat: Number(lat),
        lng: Number(lng),
        label,
        source,
        updatedAt: Date.now()
      };
      try {
        localStorage.setItem('drainGuardLiveLocation', JSON.stringify(state.liveLocation));
      } catch (_) {}

      // Smoothly update selector dropdown & active overview map/labels without full reload
      populateDeviceSelector();
      updateAdaptiveLocationUI();
      if (!silent) {
        showToast(`Location synced: ${label}`, 'success');
      }
      return state.liveLocation;
    };

    try {
      if (navigator.geolocation) {
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 7000,
            maximumAge: 60000
          });
        });
        return await applyCoords(pos.coords.latitude, pos.coords.longitude, 'gps');
      }
    } catch (geoErr) {
      if (!silent) {
        console.warn('[Location] GPS unavailable/denied, trying network lookup:', geoErr.message);
      }
    }

    // Fallback: IP-based approximate location (only if no GPS fix yet)
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('https://ipwho.is/', { signal: controller.signal });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        if (data && data.success !== false && data.latitude && data.longitude) {
          const label = [data.city, data.region].filter(Boolean).join(', ') || `${Number(data.latitude).toFixed(4)}°, ${Number(data.longitude).toFixed(4)}°`;
          state.liveLocation = {
            lat: Number(data.latitude),
            lng: Number(data.longitude),
            label,
            source: 'network',
            updatedAt: Date.now()
          };
          try {
            localStorage.setItem('drainGuardLiveLocation', JSON.stringify(state.liveLocation));
          } catch (_) {}
          populateDeviceSelector();
          updateAdaptiveLocationUI();
          if (!silent) {
            showToast(`Approximate location detected: ${label}`, 'info');
          }
          return state.liveLocation;
        }
      }
    } catch (_) {
      if (!silent) {
        showToast('Enable browser location permission to pin exact GPS coordinates', 'warning');
      }
    } finally {
      state.locationDetecting = false;
    }
    return state.liveLocation;
  }

  /**
   * Updates Leaflet mini-map & telemetry location text in place when location resolves
   */
  function updateAdaptiveLocationUI() {
    const device = (state.activeOverview && state.activeOverview.device) || {};
    const eff = getEffectiveLocation(device);

    const locTextEl = document.getElementById('telemetry-location-label');
    if (locTextEl) {
      locTextEl.textContent = eff.label;
    }
    const coordsEl = document.getElementById('telemetry-coords-pill');
    if (coordsEl) {
      coordsEl.textContent = `${eff.isLive ? (eff.source === 'gps' ? '📍 Live GPS' : '🌐 Network') : '📌 Saved'} · ${eff.lat.toFixed(4)}, ${eff.lng.toFixed(4)}`;
    }

    if (leafletMapInstance && leafletMarkerInstance) {
      leafletMapInstance.setView([eff.lat, eff.lng], 14, { animate: true });
      leafletMarkerInstance.setLatLng([eff.lat, eff.lng]);
      leafletMarkerInstance.setPopupContent(`<b>${escapeHTML(sanitizeDeviceName(device.name, device.id))}</b><br>${escapeHTML(eff.label)}`);
    }
  }

  /**
   * Applies Apple-inspired Black & Yellow chart palette defaults based on current theme
   */
  function applyChartDefaults(theme) {
    if (!window.Chart) return;
    const isDark = theme === 'dark';
    Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Plus Jakarta Sans", "Inter", sans-serif';
    Chart.defaults.color = isDark ? '#b4b4bd' : '#3f3d36';
    Chart.defaults.borderColor = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(17, 17, 19, 0.09)';
  }

  // ─── 3. Theme & Admin Lock Handlers ────────────────────────────────────────

  /**
   * Initializes light/dark theme preference (Defaults to flagship Obsidian Black & Yellow)
   */
  function initTheme() {
    const hasExplicitV3 = localStorage.getItem('drainGuardThemeV3');
    const savedTheme = hasExplicitV3
      ? (localStorage.getItem('theme') || localStorage.getItem('drainGuardTheme') || 'dark')
      : 'dark';
    applyTheme(savedTheme);

    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        localStorage.setItem('drainGuardThemeV3', '1');
        applyTheme(newTheme);
        // Refresh active charts to adopt new theme tick/grid colors
        loadActiveTab();
      });
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    localStorage.setItem('drainGuardTheme', theme);
    applyChartDefaults(theme);
    const icon = document.getElementById('theme-icon');
    if (icon) {
      icon.textContent = theme === 'dark' ? '🌙' : '☀️';
    }
  }

  // ─── Sound Alarm Engine (Web Audio API Synthesizer) ────────────────────────
  let audioCtxInstance = null;
  let activeSirenInterval = null;

  function getAudioContext() {
    if (!audioCtxInstance) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        audioCtxInstance = new AudioCtx();
      }
    }
    if (audioCtxInstance && audioCtxInstance.state === 'suspended') {
      audioCtxInstance.resume().catch(() => {});
    }
    return audioCtxInstance;
  }

  /**
   * Calculates the current water level severity ratio (0.0 to 1.0+) based on physical sensor geometry:
   * 0.0 = completely dry / safe baseline
   * 0.5 = reaching rain/watch threshold
   * 1.0 = at or exceeding flood warning / sensor brim capacity (Emergency)
   */
  function getCurrentWaterSeverityRatio() {
    try {
      const overview = state.activeOverview;
      const reading = (overview && overview.reading) || {};
      const config = (overview && overview.config) || {};

      const currentWater = Number(reading.water_cm || 0);
      const sensorToBottom = Number(config.sensor_to_bottom_cm || 60);
      const rainStart = Number(config.rain_start_cm || 10);
      const floodThreshold = sensorToBottom * 0.75; // 75% depth = flood warning level

      if (currentWater <= 0) return 0.0;
      if (currentWater <= rainStart) {
        return Math.max(0.05, (currentWater / rainStart) * 0.35);
      }
      // Between rain start and flood warning
      if (currentWater < floodThreshold) {
        const range = floodThreshold - rainStart;
        const norm = (currentWater - rainStart) / (range || 1);
        return 0.35 + norm * 0.45; // 0.35 to 0.80
      }
      // At or above flood warning (Emergency)
      const excess = (currentWater - floodThreshold) / ((sensorToBottom - floodThreshold) || 1);
      return Math.min(1.0, 0.80 + Math.max(0, excess) * 0.20);
    } catch (_) {
      return 0.5;
    }
  }

  /**
   * Generates a dynamic ECG-style acoustic alert beep whose:
   * 1. Frequency (Pitch): scales from 580Hz (low water/safe) up to 1100Hz (emergency high water).
   * 2. Intensity (Volume & Filter): scales from gentle warm ping to razor-sharp urgent acoustic pulse.
   * 3. Pulse Cadence: ECG monitor style blip with instant acoustic attack and smooth natural body.
   */
  function playIndustrialAlarmBeep(urgency = 'critical') {
    if (!state.soundAlertsEnabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const waterRatio = getCurrentWaterSeverityRatio(); // 0.0 (low) to 1.0 (emergency)

      if (urgency === 'critical') {
        // Dynamic ECG-style monitor pulse:
        // Low water / minor issue: 640Hz, soft volume (0.16)
        // High water / Emergency: 1100Hz, high volume (0.32), brighter acoustic filter
        const baseFreq = 640 + waterRatio * 460; // 640Hz to 1100Hz
        const volume = 0.16 + waterRatio * 0.16;  // 0.16 to 0.32
        const filterCutoff = 2200 + waterRatio * 2000; // 2200Hz to 4200Hz
        const pulseLen = Math.max(0.08, 0.15 - waterRatio * 0.05); // shorter, sharper blips as it gets critical

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(filterCutoff, now);

        osc.type = 'sine';
        osc.frequency.setValueAtTime(baseFreq, now);
        // Slight downward pitch inflection (classic medical ECG monitor characteristic)
        osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.94, now + pulseLen);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(volume, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + pulseLen);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + pulseLen + 0.03);

      } else if (urgency === 'warning') {
        // Dual-tone harmonic chime (C5 to E5, 523Hz -> 659Hz)
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523, now);
        osc.frequency.exponentialRampToValueAtTime(659, now + 0.35);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(0.18, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.48);

      } else {
        // Gentle affirmative ping
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(784, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.28);
      }

    } catch (e) {
      console.warn('[Audio] Could not play alert chime:', e);
    }
  }

  /**
   * Starts repeating beep alarm when a critical alert arrives or persists.
   * ECG Monitor behavior:
   * - Frequency of beeps (Rate / Tempo): scales directly with water level.
   *   Low/moderate water = relaxed 1200ms interval (50 BPM)
   *   Emergency flood level = rapid 320ms interval (188 BPM tachycardia alarm)
   * - Intensity & Pitch: automatically driven by getCurrentWaterSeverityRatio()
   * Runs for 10 SECONDS per alarm cycle.
   */
  let sirenCycleTimeoutId = null;

  function startSirenLoop(urgency = 'critical') {
    if (!state.soundAlertsEnabled) return;
    if (activeSirenInterval) return; // already in active 10s cycle

    // Play first blip immediately
    playIndustrialAlarmBeep(urgency);

    // Compute ECG interval based on current water level severity:
    // 0.0 (low water) = 1200ms between beeps
    // 1.0 (emergency flood) = 320ms between beeps
    const waterRatio = getCurrentWaterSeverityRatio();
    const ecgIntervalMs = Math.round(1200 - waterRatio * 880); // 1200ms down to 320ms

    activeSirenInterval = setInterval(() => {
      if (!state.soundAlertsEnabled || !state.currentActiveCriticalAlert) {
        stopSirenLoop();
        return;
      }
      playIndustrialAlarmBeep(urgency);
    }, ecgIntervalMs);

    // Hard stop this alarm burst after exactly 10 SECONDS (10000ms)
    sirenCycleTimeoutId = setTimeout(() => {
      stopSirenLoop();
    }, 10000);
  }

  function stopSirenLoop() {
    if (activeSirenInterval) {
      clearInterval(activeSirenInterval);
      activeSirenInterval = null;
    }
    if (sirenCycleTimeoutId) {
      clearTimeout(sirenCycleTimeoutId);
      sirenCycleTimeoutId = null;
    }
  }

  /**
   * Handles user acknowledgement for persisting alerts:
   * Sets local acknowledged persistence timer (or marks on backend if admin)
   */
  async function acknowledgePersistingAlert(alertObj) {
    if (!alertObj || !alertObj.id) return;
    const alertId = String(alertObj.id);

    // Save locally so even read-only operators can silence on their terminal
    state.acknowledgedAlertMap[alertId] = {
      ackedAt: Date.now(),
      persistsUntilTime: Date.now() + 15 * 60 * 1000 // Silenced for 15 min; re-sounds only if still persisting afterwards
    };
    try {
      localStorage.setItem('drainGuard_acked_alerts', JSON.stringify(state.acknowledgedAlertMap));
    } catch (_) {}

    // Silence active siren loop immediately
    stopSirenLoop();

    // If operator has admin key, also mark on backend
    if (state.adminKey && alertObj.status === 'open') {
      try {
        await API.ackAlert(alertId, state.adminKey);
      } catch (err) {
        console.warn('[Alerts] Remote ack sync failed:', err);
      }
    }

    showToast(`Alert #${alertId} acknowledged & silenced (will re-alert only if persistent after 15m)`, 'info', 4500);

    // Refresh banner UI state
    if (state.activeOverview && state.activeOverview.device) {
      API.getAlerts({ device_id: state.currentDeviceId, pageSize: 50 }).then(res => {
        const list = Array.isArray(res) ? res : (res.data || res.alerts || []);
        checkCriticalAlerts(list);
      }).catch(() => {});
    }
  }

  function initSoundAlertControls() {
    const soundBtn = document.getElementById('sound-alerts-btn');
    const soundIcon = document.getElementById('sound-alerts-icon');
    const soundBadge = document.getElementById('sound-alerts-badge');

    const updateSoundUI = () => {
      if (soundIcon && soundBadge && soundBtn) {
        if (state.soundAlertsEnabled) {
          soundIcon.textContent = '🔊';
          soundBadge.textContent = 'Active';
          soundBadge.className = 'badge clear';
          soundBtn.title = 'Sound Alerts: Active (Click to mute)';
        } else {
          soundIcon.textContent = '🔇';
          soundBadge.textContent = 'Muted';
          soundBadge.className = 'badge';
          soundBtn.title = 'Sound Alerts: Muted (Click to enable audio siren)';
        }
      }
    };

    updateSoundUI();

    if (soundBtn) {
      soundBtn.addEventListener('click', () => {
        state.soundAlertsEnabled = !state.soundAlertsEnabled;
        localStorage.setItem('drainGuard_sound_alerts', state.soundAlertsEnabled ? 'true' : 'false');
        updateSoundUI();

        if (state.soundAlertsEnabled) {
          getAudioContext(); // prime audio context on user gesture
          playIndustrialAlarmBeep(350, 'info'); // feedback beep
          showToast('Audible sound alerts enabled', 'success');
          // If critical alert is currently active and unacknowledged, start siren
          if (state.currentActiveCriticalAlert) {
            startSirenLoop('critical');
          }
        } else {
          stopSirenLoop();
          showToast('Sound alerts muted', 'info');
        }
      });
    }

    // Attach Acknowledgement button handler on the critical banner
    const ackBtn = document.getElementById('alert-banner-ack');
    if (ackBtn) {
      ackBtn.addEventListener('click', () => {
        if (state.currentActiveCriticalAlert) {
          acknowledgePersistingAlert(state.currentActiveCriticalAlert);
        } else {
          stopSirenLoop();
        }
      });
    }

    // Unlock Web Audio context on the first click anywhere in the dashboard
    const unlockAudio = () => {
      getAudioContext();
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
    window.addEventListener('click', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
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
    const toggleBtn = document.getElementById('admin-password-toggle');
    const errorEl = document.getElementById('admin-auth-error');
    const submitBtn = document.getElementById('admin-submit-btn');

    const clearAuthError = () => {
      if (errorEl) {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
      }
      if (passwordInput) {
        passwordInput.style.borderColor = '';
      }
    };

    if (toggleBtn && passwordInput) {
      toggleBtn.addEventListener('click', () => {
        const isMasked = passwordInput.type === 'password';
        passwordInput.type = isMasked ? 'text' : 'password';
        toggleBtn.textContent = isMasked ? '🙈' : '👁️';
        toggleBtn.title = isMasked ? 'Hide password' : 'Show password';
      });
    }

    if (passwordInput) {
      passwordInput.addEventListener('input', clearAuthError);
    }

    if (adminBtn) {
      adminBtn.addEventListener('click', () => {
        if (state.adminKey) {
          state.adminKey = null;
          sessionStorage.removeItem('adminKey');
          sessionStorage.removeItem('drainGuardAdminKey');
          updateAdminUI();
          showToast('Admin locked — switched to read-only mode', 'info');
          if (state.activeTab === 'settings' || state.activeTab === 'alerts') {
            loadActiveTab();
          }
        } else {
          // Open unlock modal
          clearAuthError();
          if (modal) modal.hidden = false;
          if (passwordInput) {
            passwordInput.type = 'password';
            if (toggleBtn) toggleBtn.textContent = '👁️';
            passwordInput.value = '';
            passwordInput.focus();
          }
        }
      });
    }

    if (cancelBtn && modal) {
      cancelBtn.addEventListener('click', () => {
        modal.hidden = true;
        clearAuthError();
      });
    }

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.hidden = true;
          clearAuthError();
        }
      });
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pwd = passwordInput.value.trim();
        if (!pwd) return;

        clearAuthError();
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Verifying...';
        }

        try {
          await API.verifyAdmin(pwd);
          state.adminKey = pwd;
          sessionStorage.setItem('adminKey', pwd);
          sessionStorage.setItem('drainGuardAdminKey', pwd);
          if (modal) modal.hidden = true;
          updateAdminUI();
          showToast('Admin mode unlocked successfully', 'success');
          loadActiveTab();
        } catch (err) {
          const msg = (err && err.message) ? err.message : 'Incorrect admin password';
          if (errorEl) {
            errorEl.textContent = `Authentication failed: ${msg}`;
            errorEl.style.display = 'block';
          }
          if (passwordInput) {
            passwordInput.style.borderColor = 'var(--color-preclog)';
            passwordInput.focus();
            passwordInput.select();
          }
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Unlock';
          }
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

    // Manage live polling based on active tab (Overview 5s, Trends 10s silent)
    if (tabName === 'overview' || tabName === 'trends') {
      startOverviewPolling(tabName);
    } else {
      stopOverviewPolling();
    }

    if (loadData && state.currentDeviceId) {
      loadActiveTab();
    }
  }

  function startOverviewPolling(mode = 'overview') {
    stopOverviewPolling();
    const baseInterval = (window.APP_CONFIG && window.APP_CONFIG.POLL_INTERVAL_MS) || 5000;
    const interval = mode === 'trends' ? Math.max(baseInterval * 2, 10000) : baseInterval;
    state.pollIntervalId = setInterval(() => {
      if (document.hidden || !state.currentDeviceId) return;
      if (state.activeTab === 'overview') {
        fetchOverviewData(true);
      } else if (state.activeTab === 'trends') {
        renderTrendsTab(true);
      }
    }, interval);
  }

  function stopOverviewPolling() {
    if (state.pollIntervalId) {
      clearInterval(state.pollIntervalId);
      state.pollIntervalId = null;
    }
  }

  // ─── 5. Initial Data Loading (Instant Cache + Parallel Fetch) ───────────────

  function populateDeviceSelector() {
    const select = document.getElementById('device-select');
    if (!select || !state.devices || state.devices.length === 0) return;

    const effGlobal = state.liveLocation;
    select.innerHTML = state.devices.map(d => {
      const cleanName = sanitizeDeviceName(d.name, d.id);
      const locLabel = (effGlobal && effGlobal.label) ? effGlobal.label : ((!d.location || d.location === 'Chennai') ? 'Field Unit' : d.location);
      return `<option value="${escapeHTML(d.id)}">${escapeHTML(cleanName)} · ${escapeHTML(locLabel)}</option>`;
    }).join('');

    if (state.currentDeviceId) {
      select.value = state.currentDeviceId;
    }
  }

  async function loadInitialData() {
    const select = document.getElementById('device-select');
    const savedDeviceId = localStorage.getItem('drainGuardDeviceId') || 'drain-01';

    // 1. Instant Paint from localStorage cache (eliminates startup blank/skeleton delay)
    let renderedFromCache = false;
    try {
      const cachedDevicesRaw = localStorage.getItem('drainGuard_devices_v3');
      const cachedOverviewRaw = localStorage.getItem(`drainGuard_overview_${savedDeviceId}_v3`);
      if (cachedDevicesRaw) {
        const cachedDevices = JSON.parse(cachedDevicesRaw);
        if (Array.isArray(cachedDevices) && cachedDevices.length > 0) {
          state.devices = cachedDevices;
          const found = cachedDevices.find(d => d.id === savedDeviceId);
          state.currentDeviceId = found ? found.id : cachedDevices[0].id;
          populateDeviceSelector();
        }
      }
      if (cachedOverviewRaw && state.activeTab === 'overview') {
        const cachedOverview = JSON.parse(cachedOverviewRaw);
        if (cachedOverview && cachedOverview.device) {
          state.activeOverview = cachedOverview;
          updateHeaderOnlineStatus(cachedOverview.device, cachedOverview.reading);
          renderOverviewTab(cachedOverview);
          renderedFromCache = true;
        }
      }
    } catch (_) {}

    if (!renderedFromCache && state.activeTab === 'overview') {
      showSkeleton('tab-overview', 'Connecting to DrainGuard telemetry...');
    }

    // Attach device selector change handler once
    if (select && !select.dataset.bound) {
      select.dataset.bound = '1';
      select.addEventListener('change', (e) => {
        state.currentDeviceId = e.target.value;
        renderedOverviewDeviceId = null;
        localStorage.setItem('drainGuardDeviceId', state.currentDeviceId);
        loadActiveTab();
      });
    }

    // Start adaptive device geolocation quietly in background (never blocks telemetry)
    detectCurrentLocation(true);

    try {
      // 2. Parallel Startup Fetch: request device list AND target overview simultaneously!
      const [devicesRes, overviewRes] = await Promise.allSettled([
        API.getDevices(),
        state.activeTab === 'overview' ? fetchOverviewData(renderedFromCache, savedDeviceId) : Promise.resolve(null)
      ]);

      if (devicesRes.status === 'rejected') {
        throw devicesRes.reason;
      }

      const rawDevices = devicesRes.value;
      state.devices = (Array.isArray(rawDevices) ? rawDevices : (rawDevices.devices || [])).map(d => ({
        ...d,
        name: sanitizeDeviceName(d.name, d.id)
      }));

      if (state.devices.length === 0) {
        select.innerHTML = '<option value="">No devices registered</option>';
        showError('tab-overview', 'No drain monitoring devices found in database.', loadInitialData);
        return;
      }

      try {
        localStorage.setItem('drainGuard_devices_v3', JSON.stringify(state.devices));
      } catch (_) {}

      const foundSaved = state.devices.find(d => d.id === savedDeviceId);
      const targetId = foundSaved ? foundSaved.id : state.devices[0].id;
      const switchedId = targetId !== savedDeviceId;
      state.currentDeviceId = targetId;

      populateDeviceSelector();

      // If non-overview tab is active OR initial guess ID differed from resolved ID, load now
      if (state.activeTab !== 'overview' || switchedId || (overviewRes && overviewRes.status === 'rejected')) {
        loadActiveTab();
      }
    } catch (err) {
      console.error('[App] Failed to load devices:', err);
      if (!renderedFromCache) {
        showError('tab-overview', `Could not reach server: ${err.message}. Ensure backend is running at ${API.getBaseUrl ? API.getBaseUrl() : 'http://localhost:3001'}.`, loadInitialData);
      }
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
   * @param {boolean} isPolling - If true, updates DOM in-place without rebuilding static containers
   * @param {string} [overrideDeviceId] - Optional explicit deviceId (used during parallel startup)
   */
  async function fetchOverviewData(isPolling = false, overrideDeviceId = null) {
    const deviceId = overrideDeviceId || state.currentDeviceId;
    if (!deviceId) return;

    const alreadyRendered = renderedOverviewDeviceId === deviceId && Boolean(document.getElementById('tank-visual-container'));
    if (!isPolling && !alreadyRendered) {
      showSkeleton('tab-overview', 'Fetching real-time sensor telemetry...');
    }

    try {
      const data = await API.getDeviceOverview(deviceId);
      hideColdStartMsg();

      // Normalize device object
      const baseDevice = data.device || state.devices.find(d => d.id === deviceId) || { id: deviceId, last_seen: data.last_seen };
      const device = {
        ...baseDevice,
        name: sanitizeDeviceName(baseDevice.name, baseDevice.id || deviceId)
      };
      if (!device.last_seen && data.last_seen) device.last_seen = data.last_seen;

      const reading = data.reading || data.latest_reading || {};
      const rodEvent = data.rod_event || data.latest_rod_event || {};
      const config = (data.config && Object.keys(data.config).length > 0) ? data.config : {
        baseline_rod: data.baseline_rod || (rodEvent && rodEvent.baseline_rod) || 0,
        sensor_to_bottom_cm: 60,
        rain_start_cm: 10,
        clear_ratio: 0.8,
        preclog_ratio: 0.5,
        offline_after_min: 15
      };

      // Fetch readings & alerts in PARALLEL only if backend didn't already bundle them
      let recentReadings = Array.isArray(data.recent_readings) ? data.recent_readings : null;
      let alertsList = Array.isArray(data.alerts) ? data.alerts : (Array.isArray(data.open_alerts) ? data.open_alerts : null);

      if (recentReadings === null || alertsList === null) {
        const [readingsRes, alertsRes] = await Promise.allSettled([
          recentReadings === null ? API.getReadings({ device_id: deviceId, pageSize: 30 }) : Promise.resolve(recentReadings),
          alertsList === null ? API.getAlerts({ device_id: deviceId, status: 'open', pageSize: 10 }) : Promise.resolve(alertsList)
        ]);
        if (recentReadings === null) {
          const rVal = readingsRes.status === 'fulfilled' ? readingsRes.value : [];
          recentReadings = Array.isArray(rVal) ? rVal : (rVal.data || rVal.readings || []);
        }
        if (alertsList === null) {
          const aVal = alertsRes.status === 'fulfilled' ? alertsRes.value : [];
          alertsList = Array.isArray(aVal) ? aVal : (aVal.data || aVal.alerts || []);
        }
      }

      const todayCounters = data.today || {
        rain_events: data.today_rain_events !== undefined ? data.today_rain_events : 0,
        open_alerts: data.open_alert_count !== undefined ? data.open_alert_count : alertsList.length
      };

      const isDeviceOnline = data.online !== undefined
        ? Boolean(data.online)
        : (device.last_seen ? ((Date.now() - new Date(device.last_seen).getTime()) < ((config.offline_after_min || 15) * 60 * 1000)) : false);

      const normalizedData = {
        device,
        reading,
        rod_event: rodEvent,
        derived_rod_event: data.derived_rod_event || null,
        live_slope_cm_min: data.live_slope_cm_min,
        online: isDeviceOnline,
        config,
        recent_readings: recentReadings,
        today: todayCounters,
        health_score: data.health_score,
        alerts: alertsList
      };

      state.activeOverview = normalizedData;

      // Cache for instant startup next time
      try {
        localStorage.setItem(`drainGuard_overview_${deviceId}_v3`, JSON.stringify(normalizedData));
      } catch (_) {}

      // Update online indicator & critical alerts banner
      updateHeaderOnlineStatus(device, reading);
      checkCriticalAlerts(alertsList);

      // Update in place during polling if already rendered for this device (zero flicker!)
      if (isPolling && renderedOverviewDeviceId === deviceId && document.getElementById('tank-visual-container')) {
        updateOverviewInPlace(normalizedData);
      } else {
        renderOverviewTab(normalizedData);
      }

    } catch (err) {
      console.error('[Overview] Polling error:', err);
      if (!isPolling && !alreadyRendered) {
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
    } else if (diffSec < 172800) {
      text.textContent = `Offline (${Math.floor(diffSec / 3600)}h ago)`;
    } else {
      text.textContent = `Offline (${Math.floor(diffSec / 86400)}d ago)`;
    }
  }

  /**
   * Scans alerts and surfaces the sticky red banner + tab counter if critical/open issues exist.
   * Plays audible sound alerts if unacknowledged, and silences once acknowledged unless persisting past duration.
   */
  function checkCriticalAlerts(alertsList) {
    const banner = document.getElementById('alert-banner');
    const text = document.getElementById('alert-banner-text');
    const navBadge = document.getElementById('nav-alerts-badge');
    const ackBtn = document.getElementById('alert-banner-ack');

    const openAlerts = alertsList.filter(a => a.status === 'open');
    if (navBadge) {
      if (openAlerts.length > 0) {
        navBadge.textContent = openAlerts.length > 99 ? '99+' : String(openAlerts.length);
        navBadge.hidden = false;
      } else {
        navBadge.hidden = true;
      }
    }

    const criticals = alertsList.filter(a => 
      a.status === 'open' && (a.severity === 'critical' || a.type === 'PRE_CLOG' || a.type === 'FLOOD_RISK')
    );

    if (criticals.length > 0) {
      const topAlert = criticals[0];
      state.currentActiveCriticalAlert = topAlert;
      const alertId = String(topAlert.id);
      const ackRecord = state.acknowledgedAlertMap[alertId];

      const now = Date.now();
      const isAckedAndActive = ackRecord && now < ackRecord.persistsUntilTime;
      const isPersistingPastAck = ackRecord && now >= ackRecord.persistsUntilTime;

      if (banner && text) {
        if (isAckedAndActive) {
          text.textContent = `[${topAlert.type}] ${topAlert.message} · Acknowledged (Persisting)`;
          if (ackBtn) {
            ackBtn.textContent = 'Acked (Silenced)';
            ackBtn.disabled = true;
            ackBtn.style.opacity = '0.7';
          }
        } else {
          text.textContent = isPersistingPastAck
            ? `⚠️ PERSISTENT: [${topAlert.type}] ${topAlert.message} (Still unresolved!)`
            : `[${topAlert.type}] ${topAlert.message} (${criticals.length} active critical issue${criticals.length > 1 ? 's' : ''})`;
          if (ackBtn) {
            ackBtn.textContent = 'Silence / Ack';
            ackBtn.disabled = false;
            ackBtn.style.opacity = '1';
          }
        }
        banner.hidden = false;
      }

      // Audio alarm logic:
      // If NOT acknowledged OR acknowledged previously but persisting past 15 min, trigger sound siren!
      if (!isAckedAndActive) {
        startSirenLoop('critical');
      } else {
        stopSirenLoop();
      }

    } else {
      state.currentActiveCriticalAlert = null;
      stopSirenLoop();
      if (banner) banner.hidden = true;
    }

    // Check for newly arrived alerts and show toast + optional prompt beep
    alertsList.forEach(a => {
      if (a.id && !state.knownAlertIds.has(a.id)) {
        state.knownAlertIds.add(a.id);
        if (a.status === 'open') {
          showToast(`🔔 New ${a.severity.toUpperCase()} alert: ${a.message}`, a.severity === 'critical' ? 'error' : 'warning');
          if (a.severity === 'critical') {
            startSirenLoop('critical');
          } else if (a.severity === 'warning') {
            playIndustrialAlarmBeep('warning');
          }
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
    const dynamics = analyzeLiveDrainDynamics(data);
    const health = calculateHealthScore(dynamics);

    renderedOverviewDeviceId = device.id || state.currentDeviceId;

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
          <div id="overview-status-slot">
            ${renderStatusCardHTML(rodEvent, reading, dynamics)}
          </div>

          <!-- State Machine Stepper -->
          <div class="card">
            <div class="card-header">
              <h3 class="card-title"><span>🔄</span> Analysis State Machine</h3>
              <span class="card-subtitle">Real-time Cycle</span>
            </div>
            <div id="overview-stepper-slot">
              ${renderStateStepperHTML(dynamics.effectiveState || reading.state || 'IDLE')}
            </div>
          </div>

          <!-- Quick Today Counters -->
          <div class="kpi-grid" style="grid-template-columns: 1fr 1fr; margin-bottom: 0;">
            <div class="kpi-card">
              <span class="kpi-title">Rain Events Today</span>
              <span class="kpi-value" id="kpi-rain-today">${todayCounters.rain_events || 0}</span>
              <span class="kpi-subtext">Calculated drop cycles</span>
            </div>
            <div class="kpi-card">
              <span class="kpi-title">Open Alerts</span>
              <span class="kpi-value" id="kpi-open-alerts" style="color: ${(todayCounters.open_alerts || 0) > 0 ? 'var(--color-preclog)' : 'var(--color-clear)'};">
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
              <span class="card-subtitle" id="overview-gauge-subtitle">${escapeHTML(dynamics.gaugeSubtitle)}</span>
            </div>
            <div id="overview-gauge-slot">
              ${renderRodGaugeHTML(rodEvent, dynamics)}
            </div>
          </div>

          <!-- Health Score Card -->
          <div class="card">
            <div class="card-header">
              <h3 class="card-title"><span>❤️</span> Drain Health Score</h3>
              <span class="card-subtitle">Live Composite Index</span>
            </div>
            <div id="overview-health-slot">
              ${renderHealthScoreHTML(health)}
            </div>
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
            <button id="btn-sync-live-location" class="btn btn-secondary btn-sm" title="Detect current GPS location of this unit">
              📍 Detect GPS
            </button>
          </div>
          <div id="overview-device-slot">
            ${renderDeviceInfoHTML(device, reading)}
          </div>
        </div>

      </div>
    `;

    // Bind live GPS sync button
    const syncLocBtn = document.getElementById('btn-sync-live-location');
    if (syncLocBtn) {
      syncLocBtn.addEventListener('click', () => detectCurrentLocation(false));
    }

    // Initialize the live water line chart
    initLiveWaterChart(recentReadings, config);

    // Initialize or refresh Leaflet mini map
    initDeviceMiniMap(device);
  }

  /**
   * Updates Overview cards & Chart.js in-place during 5s polling (zero flicker, preserves map)
   */
  function updateOverviewInPlace(data) {
    const device = data.device || {};
    const reading = data.reading || {};
    const rodEvent = data.rod_event || {};
    const config = data.config || {};
    const recentReadings = data.recent_readings || [];
    const todayCounters = data.today || {};
    const dynamics = analyzeLiveDrainDynamics(data);
    const health = calculateHealthScore(dynamics);

    const tankEl = document.getElementById('tank-visual-container');
    if (tankEl) tankEl.innerHTML = renderDrainTankHTML(reading, config);

    const statusEl = document.getElementById('overview-status-slot');
    if (statusEl) statusEl.innerHTML = renderStatusCardHTML(rodEvent, reading, dynamics);

    const stepperEl = document.getElementById('overview-stepper-slot');
    if (stepperEl) stepperEl.innerHTML = renderStateStepperHTML(dynamics.effectiveState || reading.state || 'IDLE');

    const rainEl = document.getElementById('kpi-rain-today');
    if (rainEl) rainEl.textContent = todayCounters.rain_events || 0;

    const alertEl = document.getElementById('kpi-open-alerts');
    if (alertEl) {
      const count = todayCounters.open_alerts || 0;
      alertEl.textContent = count;
      alertEl.style.color = count > 0 ? 'var(--color-preclog)' : 'var(--color-clear)';
    }

    const gaugeSubEl = document.getElementById('overview-gauge-subtitle');
    if (gaugeSubEl) gaugeSubEl.textContent = dynamics.gaugeSubtitle;

    const gaugeEl = document.getElementById('overview-gauge-slot');
    if (gaugeEl) gaugeEl.innerHTML = renderRodGaugeHTML(rodEvent, dynamics);

    const healthEl = document.getElementById('overview-health-slot');
    if (healthEl) healthEl.innerHTML = renderHealthScoreHTML(health);

    // Update Device Telemetry text values WITHOUT destroying #device-mini-map
    const barsCount = rssiToBars(reading && reading.rssi);
    const rssiTextEl = document.getElementById('telemetry-rssi-val');
    if (rssiTextEl) rssiTextEl.textContent = reading && reading.rssi !== undefined ? `${reading.rssi} dBm` : '--';
    const barsEl = document.getElementById('telemetry-signal-bars');
    if (barsEl) {
      barsEl.querySelectorAll('.bar').forEach((bar, i) => {
        bar.classList.toggle('active', barsCount >= i + 1);
      });
    }
    const uptimeEl = document.getElementById('telemetry-uptime-val');
    if (uptimeEl) uptimeEl.textContent = formatUptime(reading && reading.uptime_s);
    const lastSeenEl = document.getElementById('telemetry-lastseen-val');
    if (lastSeenEl) lastSeenEl.textContent = formatIST((device && device.last_seen) || (reading && reading.created_at));

    // Update live water chart smoothly without destroying canvas
    if (chartRegistry['liveWater']) {
      const sorted = [...(recentReadings || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const labels = sorted.map(r => formatShortIST(r.created_at));
      const dataPoints = sorted.map(r => r.water_cm !== undefined ? r.water_cm : 0);
      const rainThreshold = (config && config.rain_start_cm) || 10;

      const chart = chartRegistry['liveWater'];
      chart.data.labels = labels.length > 0 ? labels : ['Now'];
      chart.data.datasets[0].data = dataPoints.length > 0 ? dataPoints : [0];
      chart.data.datasets[0].pointRadius = dataPoints.length > 20 ? 1 : 3;
      chart.data.datasets[1].data = chart.data.labels.map(() => rainThreshold);
      chart.update('none');
    } else {
      initLiveWaterChart(recentReadings, config);
    }
  }

  /**
   * Analyzes live recent_readings alongside hardware rod_events so RoD Gauge,
   * Drain Health Score, and Status react immediately to every 5s sensor update.
   */
  function analyzeLiveDrainDynamics(data) {
    const reading = (data && data.reading) || {};
    const rodEvent = (data && data.rod_event) || {};
    const derivedBackend = (data && data.derived_rod_event) || null;
    const config = (data && data.config) || {};
    const recentReadings = Array.isArray(data && data.recent_readings) ? data.recent_readings : [];
    const online = data && data.online !== undefined ? Boolean(data.online) : true;

    const sensorToBottom = Number(config.sensor_to_bottom_cm) || 60;
    const rainStart = Number(config.rain_start_cm) || 10;
    const baselineRod = Number(config.baseline_rod) > 0
      ? Number(config.baseline_rod)
      : (rodEvent && Number(rodEvent.baseline_rod) > 0 ? Number(rodEvent.baseline_rod) : 2.5);
    const clearRatio = Number(config.clear_ratio) || 0.8;
    const preclogRatio = Number(config.preclog_ratio) || 0.5;

    const stream = recentReadings.filter(r => r && r.water_cm != null && r.created_at);
    if (reading && reading.water_cm != null && reading.created_at) {
      const exists = stream.some(r => r.created_at === reading.created_at);
      if (!exists) stream.push(reading);
    }
    stream.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const currentWater = reading && reading.water_cm != null
      ? Math.max(0, Number(reading.water_cm))
      : (stream.length > 0 ? Math.max(0, Number(stream[stream.length - 1].water_cm)) : 0);
    const fillRatio = Math.min(1, Math.max(0, currentWater / sensorToBottom));
    const clearancePct = Math.round((1 - fillRatio) * 100);

    let liveSlopeCmMin = 0;
    let windowStartWater = currentWater;
    let windowMaxWater = currentWater;
    let windowDurationS = 0;

    if (stream.length >= 2) {
      const tail = stream.slice(-8);
      windowStartWater = Number(tail[0].water_cm);
      windowMaxWater = Math.max(...tail.map(r => Number(r.water_cm)));
      const t0 = new Date(tail[0].created_at).getTime();
      windowDurationS = Math.max(0, Math.round((new Date(tail[tail.length - 1].created_at).getTime() - t0) / 1000));

      if (windowDurationS >= 4) {
        let sumT = 0, sumW = 0, sumTW = 0, sumT2 = 0;
        for (let i = 0; i < tail.length; i++) {
          const tMin = (new Date(tail[i].created_at).getTime() - t0) / 60000;
          const w = Number(tail[i].water_cm);
          sumT += tMin; sumW += w; sumTW += tMin * w; sumT2 += tMin * tMin;
        }
        const denom = tail.length * sumT2 - sumT * sumT;
        if (denom > 1e-6) {
          liveSlopeCmMin = (tail.length * sumTW - sumT * sumW) / denom;
        }
      }
    }

    let telemetryDrop = derivedBackend;
    if (!telemetryDrop && stream.length >= 3) {
      let segStart = null, segEnd = null, steady = 0;
      let latest = null;
      const checkSeg = (s, e) => {
        if (!s || !e) return;
        const drop = Number(s.water_cm) - Number(e.water_cm);
        const durS = (new Date(e.created_at) - new Date(s.created_at)) / 1000;
        if (drop >= 0.35 && durS >= 4) {
          const rod = drop / (durS / 60);
          const ratio = baselineRod > 0 ? rod / baselineRod : 1.0;
          let status = 'CLEAR';
          if (ratio < preclogRatio) status = 'PRE_CLOG';
          else if (ratio < clearRatio) status = 'WATCH';
          latest = {
            created_at: e.created_at,
            h1_cm: Number(s.water_cm),
            h2_cm: Number(e.water_cm),
            duration_s: Math.round(durS),
            rod_cm_min: Number(rod.toFixed(2)),
            baseline_rod: baselineRod,
            ratio: Number(ratio.toFixed(3)),
            status,
            derived: true
          };
        }
      };
      for (let i = 1; i < stream.length; i++) {
        const dw = Number(stream[i - 1].water_cm) - Number(stream[i].water_cm);
        if (dw > 0.15) {
          if (!segStart) segStart = stream[i - 1];
          segEnd = stream[i];
          steady = 0;
        } else if (segStart) {
          if (dw >= -0.25 && ++steady < 2) {
            segEnd = stream[i];
          } else {
            checkSeg(segStart, segEnd);
            segStart = null; segEnd = null; steady = 0;
          }
        }
      }
      if (segStart && segEnd) checkSeg(segStart, segEnd);
      telemetryDrop = latest;
    }

    const hasHwRod = Boolean(rodEvent && rodEvent.rod_cm_min !== undefined && rodEvent.rod_cm_min !== null);

    let mode = 'STEADY';
    let gaugeRatio = clearancePct / 100;
    let gaugePercent = clearancePct;
    let measuredRodCmMin = 0;
    let h1Cm = windowStartWater;
    let h2Cm = currentWater;
    let durationS = windowDurationS;
    let gaugeSubtitle = 'Steady Dry Clearance';
    let effectiveStatus = (rodEvent && rodEvent.status) || 'CLEAR';
    let rodRatioForHealth = null;

    if (liveSlopeCmMin <= -0.25) {
      mode = 'ACTIVE_DROP';
      measuredRodCmMin = Math.abs(liveSlopeCmMin);
      gaugeRatio = baselineRod > 0 ? measuredRodCmMin / baselineRod : 1.0;
      gaugePercent = Math.round(gaugeRatio * 100);
      h1Cm = windowMaxWater;
      h2Cm = currentWater;
      durationS = windowDurationS;
      gaugeSubtitle = 'Live Active Draining';
      rodRatioForHealth = gaugeRatio;
      if (gaugeRatio < preclogRatio) effectiveStatus = 'PRE_CLOG';
      else if (gaugeRatio < clearRatio) effectiveStatus = 'WATCH';
      else effectiveStatus = 'CLEAR';
    } else if (liveSlopeCmMin >= 0.25) {
      mode = 'RISING';
      measuredRodCmMin = liveSlopeCmMin;
      gaugeRatio = Math.max(0.05, clearancePct / 100);
      gaugePercent = clearancePct;
      h1Cm = windowStartWater;
      h2Cm = currentWater;
      durationS = windowDurationS;
      gaugeSubtitle = 'Water Rising (Inflow)';
      if (currentWater >= sensorToBottom * 0.85) effectiveStatus = 'WATCH';
    } else if (hasHwRod) {
      mode = 'HARDWARE_EVENT';
      measuredRodCmMin = Number(rodEvent.rod_cm_min);
      gaugeRatio = Number(rodEvent.ratio ?? 1.0);
      gaugePercent = Math.round(gaugeRatio * 100);
      h1Cm = Number(rodEvent.h1_cm ?? currentWater);
      h2Cm = Number(rodEvent.h2_cm ?? currentWater);
      durationS = Number(rodEvent.duration_s ?? 0);
      gaugeSubtitle = 'Verified Hardware Cycle';
      effectiveStatus = rodEvent.status || 'CLEAR';
      rodRatioForHealth = gaugeRatio;
    } else if (telemetryDrop) {
      mode = 'DERIVED_DROP';
      measuredRodCmMin = Number(telemetryDrop.rod_cm_min);
      gaugeRatio = Number(telemetryDrop.ratio);
      gaugePercent = Math.round(gaugeRatio * 100);
      h1Cm = telemetryDrop.h1_cm;
      h2Cm = telemetryDrop.h2_cm;
      durationS = telemetryDrop.duration_s;
      gaugeSubtitle = 'Telemetry Drop Cycle';
      effectiveStatus = telemetryDrop.status;
      rodRatioForHealth = gaugeRatio;
    } else {
      gaugeSubtitle = currentWater > rainStart ? 'Standing Water · 0.00 cm/min' : 'Steady Clearance';
      if (currentWater >= sensorToBottom * 0.75) effectiveStatus = 'WATCH';
    }

    let effectiveState = String((reading && reading.state) || 'IDLE').toUpperCase();
    if ((effectiveState === 'IDLE' || effectiveState === 'DRY') && currentWater >= rainStart) {
      if (mode === 'RISING') effectiveState = 'RAIN';
      else if (mode === 'ACTIVE_DROP') effectiveState = 'ROD';
      else effectiveState = 'PEAK';
    }

    return {
      mode,
      online,
      reading,
      currentWater,
      sensorToBottom,
      rainStart,
      fillRatio,
      clearancePct,
      liveSlopeCmMin,
      baselineRod,
      measuredRodCmMin,
      gaugeRatio,
      gaugePercent,
      h1Cm,
      h2Cm,
      durationS,
      gaugeSubtitle,
      effectiveStatus,
      effectiveState,
      rodRatioForHealth,
      floodRisk: Boolean(reading && reading.flood_risk) || fillRatio >= 0.9,
      hasTelemetry: stream.length > 0
    };
  }

  /**
   * Computes dynamic composite Drain Health Score (0 - 100) from real sensor readings & RoD
   */
  function calculateHealthScore(dynamics) {
    if (!dynamics) {
      return { score: 0, label: 'No Telemetry', color: 'var(--text-muted)', summary: 'Awaiting telemetry.', chips: [] };
    }

    const {
      online,
      currentWater,
      sensorToBottom,
      rainStart,
      fillRatio,
      clearancePct,
      liveSlopeCmMin,
      mode,
      measuredRodCmMin,
      rodRatioForHealth,
      floodRisk
    } = dynamics;

    const velPts = rodRatioForHealth !== null
      ? Math.min(45, Math.max(5, Math.round(rodRatioForHealth * 45)))
      : (currentWater <= rainStart ? 42 : 34);

    const clearPts = floodRisk ? 0 : Math.round((1 - fillRatio) * 35);

    let flowPts = 20;
    if (currentWater > rainStart && liveSlopeCmMin > -0.15) {
      flowPts -= Math.min(14, Math.round(((currentWater - rainStart) / Math.max(1, sensorToBottom - rainStart)) * 14));
    } else if (liveSlopeCmMin >= 0.25) {
      flowPts -= Math.min(8, Math.round(liveSlopeCmMin * 2));
    }
    if (!online) flowPts -= 10;

    let score = Math.min(100, Math.max(0, velPts + clearPts + Math.max(0, flowPts)));
    if (floodRisk) score = Math.min(score, 20);

    let color = 'var(--color-clear)';
    let label = 'Optimal Condition';
    let summary = 'Clearance and hydraulic capacity are healthy with zero restriction.';

    if (floodRisk || score < 50) {
      color = 'var(--color-preclog)';
      label = floodRisk ? 'Critical Flood Risk' : 'Severe Clog / Load Risk';
      summary = floodRisk
        ? 'Water depth exceeds 90% capacity — immediate surcharge inspection required.'
        : 'High water load or slowed drainage velocity detected from live telemetry.';
    } else if (score < 80) {
      color = 'var(--color-watch)';
      label = mode === 'RISING' ? 'Active Inflow Load' : 'Watch: Reduced Margin';
      summary = mode === 'RISING'
        ? `Water rising (+${liveSlopeCmMin.toFixed(1)} cm/min) — health reflects reduced capacity margin.`
        : 'Moderate water level or slowed drainage ratio; monitor recovery.';
    } else if (mode === 'ACTIVE_DROP') {
      summary = `Water actively draining at ${measuredRodCmMin.toFixed(2)} cm/min with strong clearance.`;
    }

    const velChip = mode === 'RISING'
      ? `Inflow: +${liveSlopeCmMin.toFixed(2)} cm/min`
      : (mode === 'ACTIVE_DROP' || mode === 'HARDWARE_EVENT' || mode === 'DERIVED_DROP')
        ? `RoD: ${measuredRodCmMin.toFixed(2)} cm/min`
        : 'Rate: 0.00 cm/min';

    return {
      score,
      label,
      color,
      summary,
      chips: [
        `Clearance: ${clearancePct}%`,
        `Depth: ${currentWater.toFixed(1)} cm`,
        velChip
      ]
    };
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
   * Component 2: Status Card HTML (responsive to live inflow, active drops, standing water, and RoD events)
   */
  function renderStatusCardHTML(rodEvent, reading, dynamics) {
    const status = (dynamics && dynamics.effectiveStatus) || (rodEvent && rodEvent.status) || 'CLEAR';
    const mode = dynamics ? dynamics.mode : 'STEADY';
    const currentWater = dynamics ? dynamics.currentWater : Number((reading && reading.water_cm) || 0);
    const rainStart = dynamics ? dynamics.rainStart : 10;

    let titleText = 'Drain Clear ✅';
    let descText = `Water depth is ${currentWater.toFixed(1)} cm with unobstructed culvert clearance.`;
    let tintStyle = 'background: rgba(34, 197, 94, 0.08); border-color: rgba(34, 197, 94, 0.3);';

    if (status === 'WATCH') {
      titleText = 'Watch: Drainage Slowing ⚠️';
      descText = 'Rate of drop or capacity margin is reduced. Debris may be accumulating.';
      tintStyle = 'background: rgba(245, 158, 11, 0.08); border-color: rgba(245, 158, 11, 0.3);';
    } else if (status === 'PRE_CLOG') {
      titleText = 'Maintenance Required: Partial Blockage 🚨';
      descText = 'Drainage velocity severely reduced (<50% of baseline). Dispatch inspection.';
      tintStyle = 'background: rgba(239, 68, 68, 0.08); border-color: rgba(239, 68, 68, 0.3);';
    } else if (status === 'CALIBRATED') {
      titleText = 'Baseline Calibrated ℹ️';
      descText = 'New reference drainage benchmark established.';
      tintStyle = 'background: rgba(59, 130, 246, 0.08); border-color: rgba(59, 130, 246, 0.3);';
    } else if (mode === 'ACTIVE_DROP') {
      titleText = 'Active Drainage in Progress 💧';
      descText = `Water level receding at ${dynamics.measuredRodCmMin.toFixed(2)} cm/min (${dynamics.h1Cm.toFixed(1)} → ${dynamics.h2Cm.toFixed(1)} cm).`;
    } else if (mode === 'RISING') {
      titleText = currentWater >= rainStart ? 'Rain / Inflow Accumulation Detected 🌧️' : 'Water Level Rising ↑';
      descText = `Inflow rate +${dynamics.liveSlopeCmMin.toFixed(2)} cm/min (current depth ${currentWater.toFixed(1)} cm).`;
      tintStyle = 'background: rgba(245, 158, 11, 0.08); border-color: rgba(245, 158, 11, 0.3);';
    } else if (currentWater > rainStart) {
      titleText = 'Standing Water Above Rain Threshold ⚠️';
      descText = `Water is steady at ${currentWater.toFixed(1)} cm above ${rainStart} cm threshold; monitoring for drop.`;
      tintStyle = 'background: rgba(245, 158, 11, 0.08); border-color: rgba(245, 158, 11, 0.3);';
    }

    if ((reading && reading.flood_risk) || (dynamics && dynamics.floodRisk)) {
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
            <div class="step ${isActive ? 'active' : (isPassed ? 'passed' : '')}" title="${s.label}: ${s.desc}">
              <div class="step-dot">
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
  function renderRodGaugeHTML(rodEvent, dynamics) {
    const dyn = dynamics || {};
    const mode = dyn.mode || (rodEvent && rodEvent.rod_cm_min !== undefined ? 'HARDWARE_EVENT' : 'STEADY');
    const ratio = dyn.gaugeRatio !== undefined
      ? Number(dyn.gaugeRatio)
      : (rodEvent && rodEvent.ratio !== undefined ? Number(rodEvent.ratio) : 1.0);
    const percent = dyn.gaugePercent !== undefined ? dyn.gaugePercent : (isNaN(ratio) ? 100 : Math.round(ratio * 100));

    const rodVal = mode === 'RISING'
      ? `+${Number(dyn.measuredRodCmMin || 0).toFixed(2)}`
      : (dyn.measuredRodCmMin !== undefined
        ? Number(dyn.measuredRodCmMin).toFixed(2)
        : (rodEvent && rodEvent.rod_cm_min !== undefined ? Number(rodEvent.rod_cm_min).toFixed(2) : '0.00'));

    const baseline = dyn.baselineRod !== undefined
      ? Number(dyn.baselineRod).toFixed(2)
      : (rodEvent && rodEvent.baseline_rod !== undefined ? Number(rodEvent.baseline_rod).toFixed(2) : '--');

    const h1Display = dyn.h1Cm !== undefined
      ? Number(dyn.h1Cm).toFixed(1) + ' cm'
      : (rodEvent && rodEvent.h1_cm !== undefined ? Number(rodEvent.h1_cm).toFixed(1) + ' cm' : '--');
    const h2Display = dyn.h2Cm !== undefined
      ? Number(dyn.h2Cm).toFixed(1) + ' cm'
      : (rodEvent && rodEvent.h2_cm !== undefined ? Number(rodEvent.h2_cm).toFixed(1) + ' cm' : '--');
    const durDisplay = dyn.durationS !== undefined
      ? formatDuration(dyn.durationS)
      : formatDuration(rodEvent && rodEvent.duration_s);

    const isCapacityMode = mode === 'STEADY' || mode === 'RISING';
    const clampedRatio = Math.min(1.2, Math.max(0, ratio));
    const needleDeg = -90 + (clampedRatio / 1.0) * 150;
    const valColor = ratio >= 0.8 ? 'var(--color-clear)' : ratio >= 0.5 ? 'var(--color-watch)' : 'var(--color-preclog)';

    const primaryLabel = mode === 'RISING'
      ? `${percent}% Clearance`
      : (mode === 'STEADY' ? `${percent}% Clear` : `${percent}%`);
    const rateLine = mode === 'RISING'
      ? `Inflow <strong>${rodVal}</strong> cm/min · Cap Reserve <strong>${percent}%</strong>`
      : (mode === 'STEADY'
        ? `Live Flow <strong>${rodVal}</strong> / Baseline <strong>${baseline}</strong> cm/min`
        : `Measured <strong>${rodVal}</strong> / Baseline <strong>${baseline}</strong> cm/min`);

    return `
      <div class="gauge-container">
        <svg class="gauge-svg" viewBox="0 0 240 130">
          <!-- Zone 1: Red (PRE_CLOG: 0 to 50%) -->
          <path d="M 20 110 A 100 100 0 0 1 61.2 39.3" fill="none" stroke="#ef4444" stroke-width="18" stroke-linecap="round" />
          
          <!-- Zone 2: Amber (WATCH: 50% to 80%) -->
          <path d="M 61.2 39.3 A 100 100 0 0 1 150.9 22.1" fill="none" stroke="#f59e0b" stroke-width="18" />

          <!-- Zone 3: Green (CLEAR: 80% to 100%+) -->
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
          <div class="gauge-ratio" style="color: ${valColor}; font-size: ${isCapacityMode ? '1.35rem' : '1.75rem'};">
            ${primaryLabel}
          </div>
          <div class="gauge-rod-details">
            ${rateLine}
          </div>
        </div>

        <table class="mini-stats-table">
          <tr>
            <td>${isCapacityMode ? 'Window Start Depth:' : 'Start Depth (H1):'}</td>
            <td>${h1Display}</td>
          </tr>
          <tr>
            <td>${isCapacityMode ? 'Current Depth:' : 'End Depth (H2):'}</td>
            <td>${h2Display}</td>
          </tr>
          <tr>
            <td>${isCapacityMode ? 'Window Span:' : 'Drain Duration:'}</td>
            <td>${durDisplay}</td>
          </tr>
        </table>
      </div>
    `;
  }

  /**
   * Component 5: Health Score Card HTML
   */
  function renderHealthScoreHTML(health) {
    const score = typeof health === 'object' && health !== null ? health.score : Number(health || 0);
    let color = (typeof health === 'object' && health.color) || 'var(--color-clear)';
    let label = (typeof health === 'object' && health.label) || 'Optimal Condition';
    const summary = (typeof health === 'object' && health.summary) ||
      'Score derived from live depth clearance margin, drainage velocity, and flood risk.';
    const chips = (typeof health === 'object' && Array.isArray(health.chips)) ? health.chips : [];

    if (!health || typeof health !== 'object') {
      if (score < 50) {
        color = 'var(--color-preclog)';
        label = 'Severe Clog Risk';
      } else if (score < 80) {
        color = 'var(--color-watch)';
        label = 'Maintenance Needed';
      }
    }

    return `
      <div class="health-score-container">
        <div class="health-score-circle" style="border-color: ${color};">
          <span class="health-score-num" style="color: ${color};">${score}</span>
          <span class="health-score-label">Health</span>
        </div>
        <div style="flex: 1;">
          <h4 style="font-size: 1rem; margin-bottom: 0.25rem; color: ${color};">${escapeHTML(label)}</h4>
          <p style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.4;">
            ${escapeHTML(summary)}
          </p>
          ${chips.length > 0 ? `
            <div style="display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.45rem;">
              ${chips.map(c => `<span class="badge calibrated" style="font-size: 0.68rem;">${escapeHTML(c)}</span>`).join('')}
            </div>
          ` : ''}
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
    const gradient = ctx.createLinearGradient(0, 0, 0, 260);
    gradient.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
    gradient.addColorStop(1, 'rgba(56, 189, 248, 0.02)');

    chartRegistry['liveWater'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels.length > 0 ? labels : ['Now'],
        datasets: [
          {
            label: 'Water Depth (cm)',
            data: dataPoints.length > 0 ? dataPoints : [0],
            borderColor: '#38bdf8',
            backgroundColor: gradient,
            fill: true,
            tension: 0.38,
            borderWidth: 2.5,
            pointRadius: dataPoints.length > 20 ? 1.5 : 3.5,
            pointBackgroundColor: '#38bdf8'
          },
          {
            label: 'Rain Start Threshold',
            data: labels.map(() => rainThreshold),
            borderColor: '#ffd60a',
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
            grid: { color: 'rgba(150, 150, 160, 0.12)' }
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
    const effLoc = getEffectiveLocation(device);

    return `
      <div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 0.75rem; font-size: 0.85rem;">
          <div>
            <div style="color: var(--text-muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;">Unit ID</div>
            <div style="font-weight: 700; font-family: var(--font-mono);">${escapeHTML(device.id || '--')}</div>
          </div>
          <div>
            <div style="color: var(--text-muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;">Current Location</div>
            <div id="telemetry-location-label" style="font-weight: 700;">${escapeHTML(effLoc.label)}</div>
          </div>
          <div>
            <div style="color: var(--text-muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;">Wi-Fi Signal</div>
            <div style="display: flex; align-items: center; gap: 0.4rem; font-weight: 600;">
              <span id="telemetry-signal-bars" class="signal-bars">
                <span class="bar ${barsCount >= 1 ? 'active' : ''}"></span>
                <span class="bar ${barsCount >= 2 ? 'active' : ''}"></span>
                <span class="bar ${barsCount >= 3 ? 'active' : ''}"></span>
                <span class="bar ${barsCount >= 4 ? 'active' : ''}"></span>
              </span>
              <span id="telemetry-rssi-val">${rssiVal}</span>
            </div>
          </div>
          <div>
            <div style="color: var(--text-muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;">System Uptime</div>
            <div id="telemetry-uptime-val" style="font-weight: 700;">${uptime}</div>
          </div>
        </div>

        <div class="location-badge-row">
          <div style="font-size: 0.78rem; color: var(--text-secondary);">
            <strong>Last Telemetry:</strong> <span id="telemetry-lastseen-val">${lastSeen}</span>
          </div>
          <span id="telemetry-coords-pill" class="gps-pill">
            ${effLoc.isLive ? (effLoc.source === 'gps' ? '📍 Live GPS' : '🌐 Network') : '📌 Saved'} · ${effLoc.lat.toFixed(4)}, ${effLoc.lng.toFixed(4)}
          </span>
        </div>

        <!-- Embedded Mini Leaflet Map -->
        <div id="device-mini-map"></div>
      </div>
    `;
  }

  /**
   * Initializes or updates the mini Leaflet map for adaptive device GPS coordinates
   */
  function initDeviceMiniMap(device) {
    const mapEl = document.getElementById('device-mini-map');
    if (!mapEl || !window.L) return;

    const eff = getEffectiveLocation(device);

    try {
      if (leafletMapInstance) {
        leafletMapInstance.remove();
        leafletMapInstance = null;
        leafletMarkerInstance = null;
      }

      leafletMapInstance = L.map(mapEl, {
        center: [eff.lat, eff.lng],
        zoom: 14,
        zoomControl: false,
        attributionControl: false
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18
      }).addTo(leafletMapInstance);

      leafletMarkerInstance = L.marker([eff.lat, eff.lng])
        .addTo(leafletMapInstance)
        .bindPopup(`<b>${escapeHTML(sanitizeDeviceName(device.name, device.id))}</b><br>${escapeHTML(eff.label)}`);

      // Fix render size if container was hidden initially
      setTimeout(() => {
        if (leafletMapInstance) leafletMapInstance.invalidateSize();
      }, 200);

    } catch (e) {
      console.warn('[Map] Could not render Leaflet map:', e);
    }
  }

  // ─── 7. TAB: ANALYTICS ─────────────────────────────────────────────────────

  async function renderAnalyticsTab(forceFresh = false) {
    const container = document.getElementById('tab-analytics');
    if (!container) return;

    const deviceId = state.currentDeviceId;
    const days = state.analyticsDays;
    const cacheKey = `${deviceId}_${days}`;
    const cached = tabCache.analytics[cacheKey];

    if (cached && !forceFresh) {
      paintAnalyticsTab(container, cached.payload, days);
      // Silently refresh if older than 8s and user is still on Analytics
      if (Date.now() - cached.ts > 8000) {
        fetchAnalyticsPayload(deviceId, days)
          .then(fresh => {
            tabCache.analytics[cacheKey] = { payload: fresh, ts: Date.now() };
            if (state.activeTab === 'analytics' && state.currentDeviceId === deviceId && state.analyticsDays === days) {
              paintAnalyticsTab(container, fresh, days);
            }
          })
          .catch(() => {});
      }
      return;
    }

    showSkeleton('tab-analytics', 'Synchronizing hydraulic analytics & drop metrics...');

    try {
      const payload = await fetchAnalyticsPayload(deviceId, days);
      tabCache.analytics[cacheKey] = { payload, ts: Date.now() };
      if (state.activeTab !== 'analytics' || state.currentDeviceId !== deviceId || state.analyticsDays !== days) return;
      paintAnalyticsTab(container, payload, days);
    } catch (err) {
      console.error('[Analytics] Render failed:', err);
      showError('tab-analytics', `Failed to generate analytics: ${err.message}`, () => renderAnalyticsTab(true));
    }
  }

  async function fetchAnalyticsPayload(deviceId, days) {
    const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const [summary, rodEvents, readingsRes] = await Promise.all([
      API.getAnalyticsSummary(deviceId, days),
      API.getRodEvents({ device_id: deviceId, from: periodStart, pageSize: 100, limit: 100 }).catch(() => ({ data: [] })),
      API.getReadings({ device_id: deviceId, from: periodStart, pageSize: 300, limit: 300 }).catch(() => ({ data: [] }))
    ]);
    return { summary, rodEvents, readingsRes };
  }

  function paintAnalyticsTab(container, payload, days) {
    const { summary, rodEvents, readingsRes } = payload;
    const eventsList = Array.isArray(rodEvents) ? rodEvents : (rodEvents.data || rodEvents.events || []);
    const eventsSummary = summary || {};
    const derivedEvents = Array.isArray(eventsSummary.derived_events) ? eventsSummary.derived_events : [];
    const effectiveEvents = eventsList.length > 0 ? eventsList : derivedEvents;

    const rawList = Array.isArray(readingsRes) ? readingsRes : (readingsRes.data || readingsRes.readings || []);
    const rawReadings = [...rawList].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const hasEvents = effectiveEvents.length > 0;
    const totalReadings = eventsSummary.total_readings !== undefined ? eventsSummary.total_readings : rawReadings.length;
    const avgWater = eventsSummary.avg_water_cm !== null && eventsSummary.avg_water_cm !== undefined
      ? Number(eventsSummary.avg_water_cm)
      : (rawReadings.length > 0 ? rawReadings.reduce((s, r) => s + (Number(r.water_cm) || 0), 0) / rawReadings.length : 0);
    const peakWater = eventsSummary.peak_water_cm !== null && eventsSummary.peak_water_cm !== undefined
      ? Number(eventsSummary.peak_water_cm)
      : (rawReadings.length > 0 ? Math.max(...rawReadings.map(r => Number(r.water_cm) || 0)) : 0);
    const floodRiskCount = eventsSummary.flood_risk_count !== undefined
      ? Number(eventsSummary.flood_risk_count)
      : rawReadings.filter(r => r.flood_risk).length;

    const statusCounts = eventsSummary.status_counts || {};
    const clearCount = statusCounts.CLEAR !== undefined
      ? statusCounts.CLEAR
      : effectiveEvents.filter(e => String(e.status).toUpperCase() === 'CLEAR').length;
    const alertEventCount = (statusCounts.WATCH || 0) + (statusCounts.PRE_CLOG || 0) ||
      effectiveEvents.filter(e => ['WATCH', 'PRE_CLOG'].includes(String(e.status).toUpperCase())).length;
    const avgRodVal = eventsSummary.avg_rod !== null && eventsSummary.avg_rod !== undefined
      ? Number(eventsSummary.avg_rod).toFixed(2)
      : calculateAvgRod(effectiveEvents);

    const sourceBadgeText = eventsList.length > 0
      ? `${eventsList.length} Hardware Events + ${totalReadings} Readings`
      : (derivedEvents.length > 0
        ? `${derivedEvents.length} Derived Drain Cycles + ${totalReadings} Readings`
        : `${totalReadings} Sensor Readings Active`);

    const chartATitle = hasEvents ? '(a) Rate of Drop per Drain Cycle' : '(a) Water Depth Profile Over Time';
    const chartASubtitle = hasEvents
      ? (eventsList.length > 0 ? 'Coloured by Diagnostic Status' : 'Derived from Sensor Drop Sequences')
      : 'Bucketed Mean & Peak Water Depth (cm)';

    const chartBTitle = hasEvents ? '(b) Status Breakdown' : '(b) Telemetry State Breakdown';
    const chartBSubtitle = hasEvents ? 'Event Ratio Distribution' : 'Sensor FSM State Distribution';

    const chartDTitle = hasEvents ? '(d) Initial Depth (H1) vs RoD Correlation' : '(d) Water Depth vs Sensor Distance';
    const chartDSubtitle = hasEvents ? 'Hydraulic Head Pressure Effect' : 'Live Ultrasonic Calibration Scatter';

    const chartETitle = hasEvents ? '(e) Rain Events Timeline' : '(e) Telemetry Volume Timeline';
    const chartESubtitle = hasEvents ? 'Storm Cycle Frequency' : 'Captured Sensor Readings per Day';

    const clearPctStr = Math.round((clearCount / Math.max(1, eventsSummary.total_rain_events || effectiveEvents.length)) * 100) + '%';

    container.innerHTML = `
      <!-- Header with Date Range Chips & Download Report Action -->
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.25rem;">
        <div>
          <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
            <h2 style="font-size: 1.3rem; font-weight: 800;">Hydraulic Diagnostic Analytics</h2>
            <span class="badge badge-info" style="font-size: 0.72rem;">📡 ${escapeHTML(sourceBadgeText)}</span>
          </div>
          <p style="font-size: 0.85rem; color: var(--text-secondary);">Long-term rate of drop metrics, telemetry hydrology &amp; clog detection patterns</p>
        </div>
        
        <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;" class="no-print">
          <!-- Range Chips -->
          <button class="btn ${days === 7 ? 'btn-primary' : 'btn-secondary'} btn-sm analytics-chip" data-days="7">7 Days</button>
          <button class="btn ${days === 30 ? 'btn-primary' : 'btn-secondary'} btn-sm analytics-chip" data-days="30">30 Days</button>
          <button class="btn ${days === 90 ? 'btn-primary' : 'btn-secondary'} btn-sm analytics-chip" data-days="90">90 Days</button>
          
          <!-- Download PDF Report Button -->
          <button id="btn-print-analytics" class="btn btn-primary btn-sm" title="Download PDF Hydraulic Diagnostic Report">
            <span>📄</span> Print / Download PDF
          </button>
        </div>
      </div>

      <!-- KPI Cards Grid -->
      <div class="kpi-grid">
        <div class="kpi-card">
          <span class="kpi-title">${hasEvents ? 'Total Drain Events' : 'Telemetry Samples'}</span>
          <span class="kpi-value">${hasEvents ? (eventsSummary.total_rain_events || effectiveEvents.length) : totalReadings}</span>
          <span class="kpi-subtext">${hasEvents ? (eventsList.length > 0 ? `Hardware cycles (${totalReadings} pts)` : `Derived from ${totalReadings} readings`) : `Captured packets (${days}d)`}</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-title">${hasEvents ? 'Clear Drainage Rate' : 'Peak Water Depth'}</span>
          <span class="kpi-value" style="color: ${hasEvents ? 'var(--color-clear)' : 'var(--accent-primary)'};">
            ${hasEvents
              ? clearPctStr
              : `${peakWater.toFixed(1)} <span style="font-size: 0.9rem;">cm</span>`}
          </span>
          <span class="kpi-subtext">${hasEvents ? `Peak depth ${peakWater.toFixed(1)} cm` : `Max recorded depth (${days}d)`}</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-title">${hasEvents ? 'Average Rate of Drop' : 'Mean Water Depth'}</span>
          <span class="kpi-value">
            ${hasEvents
              ? `${avgRodVal} <span style="font-size: 0.9rem;">cm/min</span>`
              : `${avgWater.toFixed(1)} <span style="font-size: 0.9rem;">cm</span>`}
          </span>
          <span class="kpi-subtext">${hasEvents ? `Mean depth ${avgWater.toFixed(1)} cm` : `Baseline sensor level (${days}d)`}</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-title">Alerts &amp; Flood Flags</span>
          <span class="kpi-value" style="color: ${(alertEventCount + floodRiskCount) > 0 ? 'var(--color-preclog)' : 'var(--color-clear)'};">${hasEvents ? alertEventCount : floodRiskCount}</span>
          <span class="kpi-subtext">${hasEvents ? `Watch/pre-clog + ${floodRiskCount} flood flags` : 'High-water flood risk readings'}</span>
        </div>
      </div>

      <!-- Month over Month Comparison Card -->
      <div class="card" style="margin-bottom: 1.25rem;">
        <div class="card-header">
          <h3 class="card-title"><span>📅</span> ${hasEvents ? 'Period-Over-Period Drainage Velocity Trend' : 'Period-Over-Period Water Depth Comparison'}</h3>
        </div>
        ${renderMoMComparisonHTML(eventsSummary, effectiveEvents, rawReadings)}
      </div>

      <!-- Analytics Charts Grid: (a) RoD / Water Depth Bar Chart & (b) Doughnut Distribution -->
      <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 1.25rem; margin-bottom: 1.25rem;">
        <div class="card">
          <div class="card-header">
            <h3 class="card-title"><span>📊</span> ${chartATitle}</h3>
            <span class="card-subtitle">${chartASubtitle}</span>
          </div>
          <div class="chart-container">
            <canvas id="chart-analytics-rod"></canvas>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h3 class="card-title"><span>🍩</span> ${chartBTitle}</h3>
            <span class="card-subtitle">${chartBSubtitle}</span>
          </div>
          <div class="chart-container">
            <canvas id="chart-analytics-doughnut"></canvas>
          </div>
        </div>
      </div>

      <!-- Additional Charts Grid: (d) Scatter Plot & (e) Timeline Grouping -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem;">
        <div class="card">
          <div class="card-header">
            <h3 class="card-title"><span>🎯</span> ${chartDTitle}</h3>
            <span class="card-subtitle">${chartDSubtitle}</span>
          </div>
          <div class="chart-container">
            <canvas id="chart-analytics-scatter"></canvas>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h3 class="card-title"><span>🌧️</span> ${chartETitle}</h3>
            <span class="card-subtitle">${chartESubtitle}</span>
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

    // Attach Print / PDF Download handler
    const printBtn = document.getElementById('btn-print-analytics');
    if (printBtn) {
      printBtn.addEventListener('click', () => {
        downloadAnalyticsReport({
          deviceId: state.currentDeviceId,
          days,
          hasEvents,
          eventsList,
          effectiveEvents,
          rawReadings,
          totalReadings,
          avgWater,
          peakWater,
          avgRodVal,
          clearPctStr,
          alertEventCount,
          floodRiskCount,
          eventsSummary,
          sourceBadgeText,
          chartTitles: [chartATitle, chartBTitle, chartDTitle, chartETitle]
        });
      });
    }

    // Initialize all 4 charts (with full readings fallback + live event support)
    initAnalyticsRodChart(effectiveEvents, rawReadings);
    initAnalyticsDoughnutChart(effectiveEvents, eventsSummary, rawReadings);
    initAnalyticsScatterChart(effectiveEvents, rawReadings);
    initAnalyticsWeeklyChart(effectiveEvents, rawReadings);
  }

  /**
   * Captures a Chart.js canvas onto an opaque dark background for clean PDF/HTML export
   */
  function captureChartImage(canvasId) {
    const src = document.getElementById(canvasId);
    if (!src || src.width === 0 || src.height === 0) return null;
    try {
      const tmp = document.createElement('canvas');
      tmp.width = src.width;
      tmp.height = src.height;
      const tctx = tmp.getContext('2d');
      tctx.fillStyle = '#111318';
      tctx.fillRect(0, 0, tmp.width, tmp.height);
      tctx.drawImage(src, 0, 0);
      return tmp.toDataURL('image/png', 0.95);
    } catch (_) {
      return null;
    }
  }

  /**
   * Generates & directly downloads a formatted PDF Diagnostic Report (with HTML document fallback)
   */
  function downloadAnalyticsReport(ctx) {
    const btn = document.getElementById('btn-print-analytics');
    const prevBtnHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Generating PDF...';
    }

    try {
      const deviceObj = (state.devices || []).find(d => d.id === ctx.deviceId) || {};
      const deviceName = sanitizeDeviceName(deviceObj.name, ctx.deviceId);
      const locLabel = (state.liveLocation && state.liveLocation.label)
        ? state.liveLocation.label
        : (deviceObj.location || 'Field Deployment');
      const nowIST = formatIST(new Date().toISOString());
      const dateSlug = new Date().toISOString().slice(0, 10);
      const chartIds = [
        'chart-analytics-rod',
        'chart-analytics-doughnut',
        'chart-analytics-scatter',
        'chart-analytics-weekly'
      ];
      const chartImages = chartIds.map((id, i) => ({
        title: ctx.chartTitles[i] || `Chart ${i + 1}`,
        img: captureChartImage(id)
      }));

      if (window.jspdf && typeof window.jspdf.jsPDF === 'function') {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

        // Top Obsidian & Precision Yellow Header
        doc.setFillColor(10, 10, 14);
        doc.rect(0, 0, 210, 32, 'F');
        doc.setFillColor(255, 214, 10);
        doc.rect(0, 32, 210, 1.8, 'F');

        doc.setTextColor(255, 214, 10);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(17);
        doc.text('DrainGuard Hydraulic Diagnostic Report', 14, 14);

        doc.setTextColor(220, 225, 232);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9.5);
        doc.text(`Unit: ${deviceName} (${ctx.deviceId})  |  Location: ${locLabel}`, 14, 21.5);
        doc.text(`Window: Past ${ctx.days} Days  |  Generated: ${nowIST}  |  ${ctx.sourceBadgeText}`, 14, 27);

        // KPI Summary Row
        let y = 41;
        doc.setTextColor(20, 22, 28);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Executive Telemetry Summary', 14, y);
        y += 4;

        const kpis = [
          {
            label: ctx.hasEvents ? 'Total Drain Events' : 'Telemetry Samples',
            val: String(ctx.hasEvents ? (ctx.eventsSummary.total_rain_events || ctx.effectiveEvents.length) : ctx.totalReadings)
          },
          {
            label: ctx.hasEvents ? 'Clear Drainage Rate' : 'Peak Water Depth',
            val: ctx.hasEvents ? ctx.clearPctStr : `${ctx.peakWater.toFixed(1)} cm`
          },
          {
            label: ctx.hasEvents ? 'Avg Rate of Drop' : 'Mean Water Depth',
            val: ctx.hasEvents ? `${ctx.avgRodVal} cm/min` : `${ctx.avgWater.toFixed(1)} cm`
          },
          {
            label: 'Alerts / Flood Flags',
            val: String(ctx.hasEvents ? ctx.alertEventCount : ctx.floodRiskCount)
          }
        ];

        const boxW = 43.5;
        kpis.forEach((k, idx) => {
          const x = 14 + idx * (boxW + 2.5);
          doc.setFillColor(246, 247, 250);
          doc.setDrawColor(215, 220, 228);
          doc.roundedRect(x, y, boxW, 18, 2, 2, 'FD');
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7.5);
          doc.setTextColor(95, 102, 115);
          doc.text(k.label, x + 3, y + 6);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(12);
          doc.setTextColor(15, 17, 21);
          doc.text(k.val, x + 3, y + 14);
        });

        y += 25;
        const uptimeStr = ctx.eventsSummary.uptime_pct !== undefined ? `${ctx.eventsSummary.uptime_pct}%` : '--';
        const rssiStr = ctx.eventsSummary.avg_rssi !== null && ctx.eventsSummary.avg_rssi !== undefined ? `${ctx.eventsSummary.avg_rssi} dBm` : '--';
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(70, 75, 86);
        doc.text(`Mean Depth: ${ctx.avgWater.toFixed(1)} cm   |   Peak Depth: ${ctx.peakWater.toFixed(1)} cm   |   Avg Signal: ${rssiStr}   |   Estimated Uptime: ${uptimeStr}`, 14, y);

        // Embed up to 4 rendered Chart canvases (2x2 grid)
        y += 7;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(20, 22, 28);
        doc.text('Diagnostic Charts & Telemetry Distributions', 14, y);
        y += 4;

        const cw = 88;
        const ch = 56;
        chartImages.forEach((c, idx) => {
          const col = idx % 2;
          const row = Math.floor(idx / 2);
          const cx = 14 + col * (cw + 6);
          const cy = y + row * (ch + 12);

          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8);
          doc.setTextColor(50, 55, 65);
          doc.text(c.title, cx, cy + 4);

          if (c.img) {
            doc.addImage(c.img, 'PNG', cx, cy + 6, cw, ch);
          } else {
            doc.setDrawColor(210, 215, 224);
            doc.rect(cx, cy + 6, cw, ch);
            doc.setFont('helvetica', 'normal');
            doc.text('Chart snapshot unavailable', cx + 18, cy + 34);
          }
        });

        // Page 2: Recent Drain Events or Telemetry Log Table
        doc.addPage();
        doc.setFillColor(10, 10, 14);
        doc.rect(0, 0, 210, 16, 'F');
        doc.setFillColor(255, 214, 10);
        doc.rect(0, 16, 210, 1.2, 'F');
        doc.setTextColor(255, 214, 10);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text(
          ctx.effectiveEvents.length > 0 ? 'Drainage Rate-of-Drop Event Log' : 'Recent Raw Telemetry Readings',
          14,
          10.5
        );

        let ty = 26;
        doc.setTextColor(20, 22, 28);
        doc.setFontSize(8);
        if (ctx.effectiveEvents.length > 0) {
          const rows = [...ctx.effectiveEvents]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 22);
          doc.text('Timestamp (IST)', 14, ty);
          doc.text('H1 (cm)', 78, ty);
          doc.text('H2 (cm)', 98, ty);
          doc.text('Dur (s)', 118, ty);
          doc.text('RoD (cm/min)', 138, ty);
          doc.text('Status', 174, ty);
          ty += 2;
          doc.setDrawColor(190, 195, 205);
          doc.line(14, ty, 196, ty);
          ty += 5;

          doc.setFont('helvetica', 'normal');
          rows.forEach(ev => {
            doc.text(formatIST(ev.created_at).slice(0, 24), 14, ty);
            doc.text(Number(ev.h1_cm || 0).toFixed(1), 78, ty);
            doc.text(Number(ev.h2_cm || 0).toFixed(1), 98, ty);
            doc.text(String(ev.duration_s || 0), 118, ty);
            doc.text(Number(ev.rod_cm_min || 0).toFixed(2), 138, ty);
            doc.text(String(ev.status || '--'), 174, ty);
            ty += 6.5;
          });
        } else {
          const rows = [...ctx.rawReadings].reverse().slice(0, 22);
          doc.text('Timestamp (IST)', 14, ty);
          doc.text('State', 78, ty);
          doc.text('Water (cm)', 106, ty);
          doc.text('Dist (cm)', 134, ty);
          doc.text('Flood Risk', 162, ty);
          doc.text('RSSI', 184, ty);
          ty += 2;
          doc.setDrawColor(190, 195, 205);
          doc.line(14, ty, 196, ty);
          ty += 5;

          doc.setFont('helvetica', 'normal');
          rows.forEach(r => {
            doc.text(formatIST(r.created_at).slice(0, 24), 14, ty);
            doc.text(String(r.state || '--'), 78, ty);
            doc.text(r.water_cm != null ? Number(r.water_cm).toFixed(1) : '--', 106, ty);
            doc.text(r.distance_cm != null ? Number(r.distance_cm).toFixed(1) : '--', 134, ty);
            doc.text(r.flood_risk ? 'RISK' : 'OK', 162, ty);
            doc.text(r.rssi != null ? `${r.rssi}` : '--', 184, ty);
            ty += 6.5;
          });
        }

        const filename = `DrainGuard_Report_${ctx.deviceId}_${ctx.days}d_${dateSlug}.pdf`;
        doc.save(filename);
        showToast(`PDF Report downloaded: ${filename}`, 'success');
      } else {
        // Offline / blocked-CDN fallback: download clean self-contained HTML report + open print
        const htmlDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>DrainGuard Report - ${escapeHTML(ctx.deviceId)}</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#111;background:#fff}h1{border-bottom:3px solid #ffd60a;padding-bottom:8px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:16px 0}.kpi{border:1px solid #ddd;border-radius:8px;padding:12px}img{width:100%;border-radius:8px;border:1px solid #ccc}</style></head><body><h1>DrainGuard Hydraulic Diagnostic Report</h1><p><strong>Unit:</strong> ${escapeHTML(deviceName)} (${escapeHTML(ctx.deviceId)}) | <strong>Location:</strong> ${escapeHTML(locLabel)} | <strong>Window:</strong> ${ctx.days} Days | <strong>Generated:</strong> ${escapeHTML(nowIST)}</p><div class="grid"><div class="kpi"><strong>${ctx.hasEvents ? 'Drain Events' : 'Telemetry Samples'}:</strong> ${ctx.hasEvents ? ctx.effectiveEvents.length : ctx.totalReadings}</div><div class="kpi"><strong>Peak Water Depth:</strong> ${ctx.peakWater.toFixed(1)} cm</div><div class="kpi"><strong>Mean Water Depth:</strong> ${ctx.avgWater.toFixed(1)} cm</div><div class="kpi"><strong>Flood Risk Flags:</strong> ${ctx.floodRiskCount}</div></div><div class="grid">${chartImages.filter(c => c.img).map(c => `<div><h3>${escapeHTML(c.title)}</h3><img src="${c.img}" alt="${escapeHTML(c.title)}"></div>`).join('')}</div></body></html>`;
        const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `DrainGuard_Report_${ctx.deviceId}_${ctx.days}d_${dateSlug}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast('Report document downloaded (HTML)', 'success');
        window.print();
      }
    } catch (err) {
      console.error('[Report] Export failed:', err);
      showToast(`Report download error: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = prevBtnHtml;
      }
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
   * Component (c): Period-over-period comparison card driven by real events or readings
   */
  function renderMoMComparisonHTML(summary, events, rawReadings) {
    const mom = summary.month_over_month || {};
    const hasRodChange = mom.change_pct !== null && mom.change_pct !== undefined;
    const hasWaterChange = mom.water_change_pct !== null && mom.water_change_pct !== undefined;

    if (hasRodChange) {
      const pctChange = Number(mom.change_pct).toFixed(1);
      const isDecline = Number(pctChange) < 0;
      const arrow = isDecline ? '↓' : (Number(pctChange) > 0 ? '↑' : '→');
      const color = isDecline ? 'var(--color-watch)' : 'var(--color-clear)';
      return `
        <div style="display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap;">
          <div style="display: flex; align-items: baseline; gap: 0.4rem;">
            <span style="font-size: 2.2rem; font-weight: 800; color: ${color};">${arrow} ${Math.abs(pctChange)}%</span>
            <span style="font-size: 0.85rem; color: var(--text-secondary);">RoD vs previous window</span>
          </div>
          <p style="font-size: 0.85rem; color: var(--text-secondary); flex: 1; min-width: 260px;">
            ${isDecline
              ? 'Drainage velocity shows a downward shift vs the prior interval. Monitor for silt sedimentation or inlet obstruction.'
              : 'Drainage velocity is stable or improving vs the prior interval under observed rainfall loads.'}
          </p>
        </div>
      `;
    }

    if (hasWaterChange) {
      const pctChange = Number(mom.water_change_pct).toFixed(1);
      const isRising = Number(pctChange) > 5;
      const arrow = Number(pctChange) > 0 ? '↑' : (Number(pctChange) < 0 ? '↓' : '→');
      const color = isRising ? 'var(--color-watch)' : 'var(--color-clear)';
      return `
        <div style="display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap;">
          <div style="display: flex; align-items: baseline; gap: 0.4rem;">
            <span style="font-size: 2.2rem; font-weight: 800; color: ${color};">${arrow} ${Math.abs(pctChange)}%</span>
            <span style="font-size: 0.85rem; color: var(--text-secondary);">mean water depth vs previous 30d</span>
          </div>
          <p style="font-size: 0.85rem; color: var(--text-secondary); flex: 1; min-width: 260px;">
            ${isRising
              ? 'Average water depth increased relative to the previous 30-day window. Continue monitoring drainage recovery.'
              : 'Water depth remains controlled compared to the previous 30-day baseline. Telemetry is ready to log RoD when rainfall cycles occur.'}
          </p>
        </div>
      `;
    }

    // Single-window fallback computed from current telemetry readings/events
    const avgWater = summary.avg_water_cm !== null && summary.avg_water_cm !== undefined
      ? Number(summary.avg_water_cm).toFixed(1)
      : (rawReadings && rawReadings.length > 0
        ? (rawReadings.reduce((s, r) => s + (Number(r.water_cm) || 0), 0) / rawReadings.length).toFixed(1)
        : '0.0');
    const count = summary.total_readings !== undefined ? summary.total_readings : (rawReadings ? rawReadings.length : 0);

    return `
      <div style="display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap;">
        <div style="display: flex; align-items: baseline; gap: 0.4rem;">
          <span style="font-size: 2.0rem; font-weight: 800; color: var(--accent-primary);">${avgWater} cm</span>
          <span style="font-size: 0.85rem; color: var(--text-secondary);">current window baseline (${count} samples)</span>
        </div>
        <p style="font-size: 0.85rem; color: var(--text-secondary); flex: 1; min-width: 260px;">
          ${events && events.length > 0
            ? 'Initial drain cycle baseline captured. Period-over-period % comparison will activate once a second multi-week comparison window exists.'
            : 'Collecting continuous telemetry in current window. Period-over-period RoD delta will unlock automatically as rain/drop cycles accumulate across periods.'}
        </p>
      </div>
    `;
  }

  /**
   * Chart (a): RoD per event bar chart (or bucketed water depth bar chart when no drain cycles exist yet)
   */
  function initAnalyticsRodChart(events, rawReadings) {
    const canvas = document.getElementById('chart-analytics-rod');
    if (!canvas) return;
    destroyChart('analyticsRod');

    const ctx = canvas.getContext('2d');

    if (events && events.length > 0) {
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

      const validBaselines = sorted.map(e => Number(e.baseline_rod) || 0).filter(v => v > 0);
      const baselineVal = validBaselines.length > 0 ? validBaselines[0] : (Math.max(...rodValues, 1) * 1.1);

      chartRegistry['analyticsRod'] = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Measured RoD (cm/min)',
              data: rodValues,
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
            x: { title: { display: true, text: 'Event Timestamp (IST)' } }
          }
        }
      });
      return;
    }

    // Fallback: bucket raw readings into ~16 chronological intervals showing Mean & Peak Water Depth
    const readings = rawReadings || [];
    const buckets = [];
    if (readings.length > 0) {
      const targetBuckets = Math.min(16, readings.length);
      const chunkSize = Math.ceil(readings.length / targetBuckets);
      for (let i = 0; i < readings.length; i += chunkSize) {
        const slice = readings.slice(i, i + chunkSize);
        const avg = slice.reduce((s, r) => s + (Number(r.water_cm) || 0), 0) / slice.length;
        const max = Math.max(...slice.map(r => Number(r.water_cm) || 0));
        buckets.push({
          label: formatShortIST(slice[slice.length - 1].created_at),
          avg: Number(avg.toFixed(2)),
          max: Number(max.toFixed(2)),
          floodRisk: slice.some(r => r.flood_risk)
        });
      }
    }

    chartRegistry['analyticsRod'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: buckets.length > 0 ? buckets.map(b => b.label) : ['No Telemetry'],
        datasets: [
          {
            label: 'Mean Water Depth (cm)',
            data: buckets.length > 0 ? buckets.map(b => b.avg) : [0],
            backgroundColor: buckets.map(b => b.floodRisk ? '#ef4444' : '#ffd60a'),
            borderRadius: 4
          },
          {
            label: 'Peak Depth (cm)',
            data: buckets.length > 0 ? buckets.map(b => b.max) : [0],
            type: 'line',
            borderColor: '#38bdf8',
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.3,
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
          y: { beginAtZero: true, title: { display: true, text: 'Water Depth (cm)' } },
          x: { title: { display: true, text: 'Telemetry Window (IST)' } }
        }
      }
    });
  }

  /**
   * Chart (b): Status distribution doughnut (events) OR Sensor FSM State doughnut (readings)
   */
  function initAnalyticsDoughnutChart(events, summary, rawReadings) {
    const canvas = document.getElementById('chart-analytics-doughnut');
    if (!canvas) return;
    destroyChart('analyticsDoughnut');

    const ctx = canvas.getContext('2d');

    if (events && events.length > 0) {
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
      return;
    }

    // Fallback: Sensor FSM state counts from summary or rawReadings
    const sc = (summary && summary.state_counts) ? { ...summary.state_counts } : {};
    if (Object.keys(sc).length === 0 && rawReadings && rawReadings.length > 0) {
      rawReadings.forEach(r => {
        const key = String(r.state || 'IDLE').toUpperCase();
        sc[key] = (sc[key] || 0) + 1;
      });
    }
    const stateLabels = Object.keys(sc).length > 0 ? Object.keys(sc) : ['IDLE'];
    const stateValues = Object.keys(sc).length > 0 ? stateLabels.map(k => sc[k]) : [0];
    const palette = {
      IDLE: '#22c55e',
      RAIN: '#38bdf8',
      PEAK: '#f59e0b',
      ROD: '#ffd60a',
      ALERT: '#ef4444'
    };

    chartRegistry['analyticsDoughnut'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: stateLabels,
        datasets: [{
          data: stateValues,
          backgroundColor: stateLabels.map(k => palette[k] || '#94a3b8'),
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
   * Chart (d): Scatter plot (H1 vs RoD) OR (Water Depth vs Ultrasonic Distance)
   */
  function initAnalyticsScatterChart(events, rawReadings) {
    const canvas = document.getElementById('chart-analytics-scatter');
    if (!canvas) return;
    destroyChart('analyticsScatter');

    const ctx = canvas.getContext('2d');

    if (events && events.length > 0) {
      const points = events
        .filter(e => e.h1_cm !== null && e.rod_cm_min !== null)
        .map(e => ({
          x: Number(e.h1_cm) || 0,
          y: Number(e.rod_cm_min) || 0
        }));

      chartRegistry['analyticsScatter'] = new Chart(ctx, {
        type: 'scatter',
        data: {
          datasets: [{
            label: 'Events (H1 vs RoD)',
            data: points,
            backgroundColor: '#ffd60a',
            borderColor: '#050507',
            borderWidth: 1,
            pointRadius: 6,
            pointHoverRadius: 8
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
      return;
    }

    const readingPoints = (rawReadings || [])
      .slice(-150)
      .filter(r => r.water_cm !== null && r.water_cm !== undefined)
      .map(r => ({
        x: Number(r.distance_cm) || 0,
        y: Number(r.water_cm) || 0
      }));

    chartRegistry['analyticsScatter'] = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Readings (Sensor Dist vs Water Depth)',
          data: readingPoints,
          backgroundColor: '#ffd60a',
          borderColor: '#050507',
          borderWidth: 1,
          pointRadius: 4,
          pointHoverRadius: 7
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: 'Ultrasonic Air Gap (cm)' } },
          y: { beginAtZero: true, title: { display: true, text: 'Water Depth (cm)' } }
        }
      }
    });
  }

  /**
   * Chart (e): Rain events per week OR Daily telemetry readings volume
   */
  function initAnalyticsWeeklyChart(events, rawReadings) {
    const canvas = document.getElementById('chart-analytics-weekly');
    if (!canvas) return;
    destroyChart('analyticsWeekly');

    const ctx = canvas.getContext('2d');
    const sourceItems = (events && events.length > 0) ? events : (rawReadings || []);
    const isEventMode = events && events.length > 0;

    const bucketMap = {};
    sourceItems.forEach(item => {
      const d = new Date(item.created_at);
      if (!isNaN(d.getTime())) {
        const key = isEventMode
          ? `Wk ${Math.ceil(d.getDate() / 7)} (${d.toLocaleString('en-US', { month: 'short' })})`
          : d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
        bucketMap[key] = (bucketMap[key] || 0) + 1;
      }
    });

    const labels = Object.keys(bucketMap).slice(-7);
    const counts = labels.map(l => bucketMap[l]);

    chartRegistry['analyticsWeekly'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.length > 0 ? labels : ['Current Day'],
        datasets: [{
          label: isEventMode ? 'Rainfall Cycles Count' : 'Telemetry Readings Count',
          data: counts.length > 0 ? counts : [0],
          backgroundColor: '#ffd60a',
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, title: { display: true, text: isEventMode ? 'Events Count' : 'Readings Count' } }
        }
      }
    });
  }

  // ─── 8. TAB: TRENDS ────────────────────────────────────────────────────────

  async function renderTrendsTab(silent = false) {
    const container = document.getElementById('tab-trends');
    if (!container) return;

    const deviceId = state.currentDeviceId;

    // Auto-select a range that covers the device's latest telemetry on initial visit
    if (!state.trendsUserPicked && state.activeOverview && state.activeOverview.device && state.activeOverview.device.id === deviceId) {
      const latestIso = (state.activeOverview.reading && state.activeOverview.reading.created_at) || state.activeOverview.device.last_seen;
      if (latestIso) {
        const ageMs = Date.now() - new Date(latestIso).getTime();
        if (ageMs > 30 * 24 * 60 * 60 * 1000) state.trendsRange = '90d';
        else if (ageMs > 6.5 * 24 * 60 * 60 * 1000) state.trendsRange = '30d';
        else if (ageMs > 23 * 60 * 60 * 1000) state.trendsRange = '7d';
      }
    }

    let range = state.trendsRange;
    let cacheKey = `${deviceId}_${range}`;
    const cached = tabCache.trends[cacheKey];

    const paintTrends = ({ trend, configData, readingsRes, fromDate, rangeCfg, activeRange }) => {
      const config = (configData && configData.config) || {};
      const fromMs = new Date(fromDate).getTime();

      const fetchedSeries = Array.isArray(readingsRes) ? readingsRes : (readingsRes.data || readingsRes.readings || []);
      const normalizedFetched = fetchedSeries
        .map(p => ({
          ...p,
          time: p.time || p.created_at,
          water_cm: Number(p.water_cm_avg !== undefined ? p.water_cm_avg : p.water_cm) || 0,
          water_cm_max: p.water_cm_max !== undefined ? Number(p.water_cm_max) : undefined
        }))
        .sort((a, b) => new Date(a.time) - new Date(b.time));

      const backendSeries = Array.isArray(trend.water_series)
        ? trend.water_series
          .filter(p => new Date(p.time || p.created_at).getTime() >= fromMs)
          .map(p => ({
            ...p,
            time: p.time || p.created_at,
            water_cm: Number(p.water_cm_avg !== undefined ? p.water_cm_avg : p.water_cm) || 0
          }))
          .sort((a, b) => new Date(a.time) - new Date(b.time))
        : [];

      // Prefer full-resolution 120-pt backendSeries when coarse daily/hourly bucketing collapses bursts into < 5 points
      const waterSeries = normalizedFetched.length >= 5
        ? normalizedFetched
        : (backendSeries.length > normalizedFetched.length ? backendSeries : normalizedFetched);

      const allTrendPoints = trend.events || trend.points || [];
      const points = allTrendPoints.filter(p => !p.created_at || new Date(p.created_at).getTime() >= fromMs);

      const velocitySeries = [];
      for (let i = 1; i < waterSeries.length; i++) {
        const prev = waterSeries[i - 1];
        const curr = waterSeries[i];
        const dtMin = (new Date(curr.time) - new Date(prev.time)) / 60000;
        if (dtMin > 0.02) {
          const rawRate = (curr.water_cm - prev.water_cm) / dtMin;
          velocitySeries.push({
            time: curr.time,
            rate: Number(Math.max(-50, Math.min(50, rawRate)).toFixed(3))
          });
        }
      }

      const readingCount = waterSeries.length;
      const avgWater = waterSeries.length > 0
        ? waterSeries.reduce((s, p) => s + (Number(p.water_cm) || 0), 0) / waterSeries.length
        : (trend.avg_water_cm || 0);
      const peakWater = waterSeries.length > 0
        ? Math.max(...waterSeries.map(p => Number(p.water_cm_max !== undefined ? p.water_cm_max : p.water_cm) || 0))
        : (trend.peak_water_cm || 0);
      const latestWater = waterSeries.length > 0 ? waterSeries[waterSeries.length - 1].water_cm : 0;
      const latestRate = velocitySeries.length > 0 ? velocitySeries[velocitySeries.length - 1].rate : 0;
      const netShift = waterSeries.length >= 2 ? (waterSeries[waterSeries.length - 1].water_cm - waterSeries[0].water_cm) : 0;

      let insightText = typeof trend.insight === 'string'
        ? trend.insight
        : (trend.insight && trend.insight.text ? trend.insight.text : '');
      if (points.length < 2) {
        if (waterSeries.length >= 2) {
          const directionStr = latestRate >= 0.25
            ? `actively rising (+${latestRate.toFixed(2)} cm/min)`
            : (latestRate <= -0.25
              ? `actively draining (${latestRate.toFixed(2)} cm/min)`
              : 'currently steady');
          insightText = `Analyzed ${waterSeries.length} points in the ${activeRange} window: depth is ${latestWater.toFixed(1)} cm (${directionStr}; mean ${avgWater.toFixed(1)} cm, peak ${peakWater.toFixed(1)} cm, net shift ${netShift >= 0 ? '+' : ''}${netShift.toFixed(1)} cm). Linear RoD degradation regression unlocks after 2+ full drain drop cycles.`;
        } else {
          const lastSeenHint = state.activeOverview && state.activeOverview.device && state.activeOverview.device.last_seen
            ? ` (latest packet was ${formatShortIST(state.activeOverview.device.last_seen)})`
            : '';
          insightText = `No telemetry packets recorded inside the ${activeRange} window${lastSeenHint}. Switch to 30d or 90d to inspect historical cycles.`;
        }
      }

      const isDeclining = (trend.slope_per_week !== null && trend.slope_per_week !== undefined && trend.slope_per_week < 0) || (trend.insight && trend.insight.status === 'declining') || (latestRate >= 0.5 && latestWater >= (Number(config.rain_start_cm) || 10));
      const projectedDays = trend.projected_days_until_preclog || (trend.insight && trend.insight.projected_days);
      const hasRegressionPoints = points && points.length >= 2;
      const showEmptyCta = waterSeries.length === 0 && activeRange !== '30d' && activeRange !== '90d';

      container.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.25rem;">
          <div>
            <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
              <h2 style="font-size: 1.3rem; font-weight: 800;">Degradation &amp; Velocity Trends</h2>
              <span class="badge badge-info" style="font-size: 0.72rem;">📡 Live 10s Sync (${escapeHTML(activeRange)})</span>
            </div>
            <p style="font-size: 0.85rem; color: var(--text-secondary);">Predictive linear regression, live dH/dt flow velocity &amp; clogging projection models</p>
          </div>

          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            <button class="btn ${activeRange === '1h' ? 'btn-primary' : 'btn-secondary'} btn-sm trends-range-btn" data-range="1h">1h</button>
            <button class="btn ${activeRange === '6h' ? 'btn-primary' : 'btn-secondary'} btn-sm trends-range-btn" data-range="6h">6h</button>
            <button class="btn ${activeRange === '24h' ? 'btn-primary' : 'btn-secondary'} btn-sm trends-range-btn" data-range="24h">24h</button>
            <button class="btn ${activeRange === '7d' ? 'btn-primary' : 'btn-secondary'} btn-sm trends-range-btn" data-range="7d">7d</button>
            <button class="btn ${activeRange === '30d' ? 'btn-primary' : 'btn-secondary'} btn-sm trends-range-btn" data-range="30d">30d</button>
            <button class="btn ${activeRange === '90d' ? 'btn-primary' : 'btn-secondary'} btn-sm trends-range-btn" data-range="90d">90d</button>
          </div>
        </div>

        <div class="card" style="margin-bottom: 1.25rem; border-left: 5px solid ${isDeclining ? 'var(--color-watch)' : 'var(--color-clear)'};">
          <div style="display: flex; align-items: flex-start; gap: 0.85rem; flex-wrap: wrap;">
            <span style="font-size: 1.8rem;">${isDeclining ? '⚠️' : '💡'}</span>
            <div style="flex: 1; min-width: 240px;">
              <h4 style="font-size: 1rem; margin-bottom: 0.25rem;">Predictive Maintenance Diagnostic</h4>
              <p style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.45;">${escapeHTML(insightText)}</p>
              ${showEmptyCta ? `
                <div style="margin-top: 0.65rem;">
                  <button id="btn-trends-jump-30d" class="btn btn-primary btn-sm">📅 Jump to Latest Telemetry (30d)</button>
                </div>
              ` : `
                <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.65rem;">
                  <span class="badge badge-info">📡 ${readingCount} Points (${escapeHTML(activeRange)})</span>
                  <span class="badge clear">Latest: ${latestWater.toFixed(1)} cm</span>
                  <span class="badge clear">Mean: ${avgWater.toFixed(1)} cm</span>
                  <span class="badge ${peakWater >= (Number(config.rain_start_cm) || 10) ? 'watch' : 'clear'}">Peak: ${peakWater.toFixed(1)} cm</span>
                  <span class="badge ${latestRate > 0.25 ? 'watch' : (latestRate < -0.25 ? 'clear' : 'calibrated')}">Flow dH/dt: ${latestRate >= 0 ? '+' : ''}${latestRate.toFixed(2)} cm/min</span>
                  ${hasRegressionPoints && trend.slope_per_week !== null && trend.slope_per_week !== undefined ? `<span class="badge ${trend.slope_per_week < 0 ? 'watch' : 'clear'}">Slope: ${trend.slope_per_week > 0 ? '+' : ''}${Number(trend.slope_per_week).toFixed(3)}/wk</span>` : ''}
                  ${hasRegressionPoints && trend.r_squared !== null && trend.r_squared !== undefined ? `<span class="badge calibrated">R²: ${Number(trend.r_squared).toFixed(2)}</span>` : ''}
                </div>
              `}
              ${projectedDays ? `
                <div style="margin-top: 0.5rem; font-size: 0.8rem; font-weight: 700; color: var(--color-watch);">
                  ⏳ Projected time to blockage threshold: ~${projectedDays} days under forecasted precipitation
                </div>
              ` : ''}
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom: 1.25rem;">
          <div class="card-header">
            <h3 class="card-title"><span>🌊</span> Water Level Profile with Rain Threshold (${escapeHTML(activeRange)})</h3>
            <span class="card-subtitle">${rangeCfg.bucket === 'raw' ? 'Full-Resolution Telemetry' : `Bucketed (${rangeCfg.bucket}) Time-Series`}</span>
          </div>
          <div class="chart-container">
            <canvas id="chart-trends-water"></canvas>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h3 class="card-title"><span>📉</span> ${hasRegressionPoints ? 'Rate of Drop Ratio Trend &amp; Slope' : 'Live Inflow &amp; Drainage Velocity (dH/dt)'}</h3>
            <span class="card-subtitle">${hasRegressionPoints ? 'Hollow points designate low-confidence readings' : '+Rising (Inflow) vs -Falling (Draining RoD) in cm/min'}</span>
          </div>
          <div class="chart-container">
            <canvas id="chart-trends-ratio"></canvas>
          </div>
        </div>
      `;

      document.querySelectorAll('.trends-range-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          state.trendsUserPicked = true;
          state.trendsRange = e.target.getAttribute('data-range') || '24h';
          renderTrendsTab(false);
        });
      });

      const jumpBtn = document.getElementById('btn-trends-jump-30d');
      if (jumpBtn) {
        jumpBtn.addEventListener('click', () => {
          state.trendsUserPicked = true;
          state.trendsRange = '30d';
          renderTrendsTab(false);
        });
      }

      initTrendsWaterChart(waterSeries, config);
      initTrendsRatioChart(points, trend, waterSeries, config, velocitySeries);
    };

    const alreadyHasTrendsDOM = Boolean(document.getElementById('chart-trends-water') && document.getElementById('chart-trends-ratio'));
    if (!silent && cached) {
      paintTrends(cached.payload);
      if (Date.now() - cached.ts <= 8000) return;
      silent = true;
    } else if (!silent || !alreadyHasTrendsDOM) {
      showSkeleton('tab-trends', 'Streaming velocity regression & hydrological profiles...');
    }

    try {
      const fetchForRange = async (targetRange) => {
        const rangeCfg = getTrendRangeConfig(targetRange);
        const fromDate = new Date(Date.now() - rangeCfg.ms).toISOString();
        const hasWarmConfig = state.activeOverview && state.activeOverview.device && state.activeOverview.device.id === deviceId && state.activeOverview.config;

        const [trendData, configData, readingsRes] = await Promise.all([
          API.getAnalyticsTrend(deviceId, rangeCfg.days),
          hasWarmConfig ? Promise.resolve(state.activeOverview) : API.getDeviceOverview(deviceId),
          API.getReadings({
            device_id: deviceId,
            from: fromDate,
            bucket: rangeCfg.bucket,
            pageSize: 300,
            limit: 300
          }).catch(() => ({ data: [] }))
        ]);
        return { trend: trendData || {}, configData, readingsRes, fromDate, rangeCfg, activeRange: targetRange };
      };

      let payload = await fetchForRange(range);

      // If auto-selected initial range had zero readings, smoothly escalate to 30d/90d
      if (!state.trendsUserPicked && (!payload.trend.reading_count || payload.trend.reading_count === 0) && range !== '30d' && range !== '90d') {
        range = '30d';
        state.trendsRange = '30d';
        cacheKey = `${deviceId}_30d`;
        payload = await fetchForRange('30d');
        if (!payload.trend.reading_count || payload.trend.reading_count === 0) {
          range = '90d';
          state.trendsRange = '90d';
          cacheKey = `${deviceId}_90d`;
          payload = await fetchForRange('90d');
        }
      }

      tabCache.trends[cacheKey] = { payload, ts: Date.now() };
      if (state.activeTab === 'trends' && state.currentDeviceId === deviceId && state.trendsRange === range) {
        paintTrends(payload);
      }
    } catch (err) {
      console.error('[Trends] Render failed:', err);
      if (!silent) {
        showError('tab-trends', `Trends computation failed: ${err.message}`, () => renderTrendsTab(false));
      }
    }
  }

  function getTrendRangeConfig(range) {
    if (range === '1h') return { days: 1, ms: 60 * 60 * 1000, bucket: 'raw' };
    if (range === '6h') return { days: 1, ms: 6 * 60 * 60 * 1000, bucket: '5m' };
    if (range === '24h') return { days: 1, ms: 24 * 60 * 60 * 1000, bucket: '15m' };
    if (range === '7d') return { days: 7, ms: 7 * 24 * 60 * 60 * 1000, bucket: '1h' };
    if (range === '90d') return { days: 90, ms: 90 * 24 * 60 * 60 * 1000, bucket: '1d' };
    return { days: 30, ms: 30 * 24 * 60 * 60 * 1000, bucket: '1d' };
  }

  function getDaysFromRange(range) {
    return getTrendRangeConfig(range).days;
  }

  /**
   * Water Level Profile Chart with horizontal rain threshold line
   */
  function initTrendsWaterChart(series, config) {
    const canvas = document.getElementById('chart-trends-water');
    if (!canvas) return;
    destroyChart('trendsWater');

    const labels = series.map(p => formatShortIST(p.time || p.created_at));
    const values = series.map(p => Number(p.water_cm_avg !== undefined ? p.water_cm_avg : p.water_cm) || 0);
    const hasMaxSeries = series.some(p => p.water_cm_max !== undefined);
    const rainThreshold = Number(config.rain_start_cm) || 10;

    const datasets = [
      {
        label: 'Water Depth (cm)',
        data: values.length > 0 ? values : [0],
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56, 189, 248, 0.14)',
        fill: true,
        tension: 0.3,
        borderWidth: 2.2,
        pointRadius: values.length > 60 ? 0 : 2.5
      }
    ];

    if (hasMaxSeries && series.length > 0) {
      datasets.push({
        label: 'Bucket Peak (cm)',
        data: series.map(p => Number(p.water_cm_max !== undefined ? p.water_cm_max : p.water_cm) || 0),
        borderColor: 'rgba(255, 214, 10, 0.65)',
        borderDash: [3, 3],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.25,
        fill: false
      });
    }

    datasets.push({
      label: 'Rain Start Threshold',
      data: (labels.length > 0 ? labels : ['No Data']).map(() => rainThreshold),
      borderColor: '#ffd60a',
      borderDash: [5, 5],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    });

    const ctx = canvas.getContext('2d');
    chartRegistry['trendsWater'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels.length > 0 ? labels : ['No Data'],
        datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'Water Depth (cm)' } },
          x: { title: { display: true, text: 'Observation Window (IST)' } }
        }
      }
    });
  }

  /**
   * RoD Ratio Trend with Regression Line (falls back to live dH/dt flow velocity when <2 RoD events exist)
   */
  function initTrendsRatioChart(points, regression, waterSeries, config, velocitySeries) {
    const canvas = document.getElementById('chart-trends-ratio');
    if (!canvas) return;
    destroyChart('trendsRatio');

    const ctx = canvas.getContext('2d');

    if (points && points.length >= 2) {
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
      const regressionData = points.map((_, idx) => Math.max(0, slope * idx + intercept));

      chartRegistry['trendsRatio'] = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'ROD Ratio (Actual)',
              data: ratios,
              borderColor: '#94a3b8',
              pointBorderColor: pointBorderColors,
              pointBackgroundColor: pointBackgroundColors,
              pointBorderWidth: 2,
              pointRadius: 6,
              showLine: true,
              borderWidth: 1.5
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
            y: { min: 0, suggestedMax: 1.5, title: { display: true, text: 'ROD Ratio vs Baseline' } }
          }
        }
      });
      return;
    }

    // Fallback when <2 RoD cycles exist in window: plot instantaneous dH/dt flow velocity (cm/min)
    let velPoints = Array.isArray(velocitySeries) && velocitySeries.length > 0 ? velocitySeries : [];
    if (velPoints.length === 0 && Array.isArray(waterSeries) && waterSeries.length >= 2) {
      for (let i = 1; i < waterSeries.length; i++) {
        const prev = waterSeries[i - 1];
        const curr = waterSeries[i];
        const dtMin = (new Date(curr.time || curr.created_at) - new Date(prev.time || prev.created_at)) / 60000;
        if (dtMin > 0.02) {
          const w1 = Number(prev.water_cm_avg !== undefined ? prev.water_cm_avg : prev.water_cm) || 0;
          const w2 = Number(curr.water_cm_avg !== undefined ? curr.water_cm_avg : curr.water_cm) || 0;
          velPoints.push({
            time: curr.time || curr.created_at,
            rate: Number(Math.max(-50, Math.min(50, (w2 - w1) / dtMin)).toFixed(3))
          });
        }
      }
    }

    const labels = velPoints.map(v => formatShortIST(v.time || v.created_at));
    const rawRates = velPoints.map(v => Number(v.rate) || 0);
    const smoothRates = rawRates.map((_, idx) => {
      const start = Math.max(0, idx - 2);
      const slice = rawRates.slice(start, idx + 1);
      return Number((slice.reduce((s, x) => s + x, 0) / slice.length).toFixed(3));
    });
    const barColors = rawRates.map(r => (r > 0.15 ? 'rgba(245, 158, 11, 0.72)' : (r < -0.15 ? 'rgba(34, 197, 94, 0.72)' : 'rgba(148, 163, 184, 0.45)')));

    chartRegistry['trendsRatio'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.length > 0 ? labels : ['Awaiting Telemetry'],
        datasets: [
          {
            label: 'Instantaneous dH/dt (cm/min)',
            data: rawRates.length > 0 ? rawRates : [0],
            backgroundColor: barColors,
            borderRadius: 4
          },
          {
            label: '3-Pt Smoothed Flow Trend',
            data: smoothRates.length > 0 ? smoothRates : [0],
            type: 'line',
            borderColor: '#ffd60a',
            borderWidth: 2.2,
            tension: 0.35,
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
          y: { title: { display: true, text: 'Depth Change Rate (+Rise / -Drain cm/min)' } },
          x: { title: { display: true, text: 'Observation Window (IST)' } }
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
          <h2 style="font-size: 1.3rem; font-weight: 800;">Telemetry &amp; Event Audit Logs</h2>
          <p style="font-size: 0.85rem; color: var(--text-secondary);">Auditable logs for GCC stormwater quality &amp; hydraulic audits</p>
        </div>

        <!-- Sub-tab Toggles & CSV Export -->
        <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
          <button id="subtab-events-btn" class="btn ${state.historySubtab === 'events' ? 'btn-primary' : 'btn-secondary'} btn-sm">
            <span>📜</span> Drain Events <span id="history-events-count-pill"></span>
          </button>
          <button id="subtab-readings-btn" class="btn ${state.historySubtab === 'readings' ? 'btn-primary' : 'btn-secondary'} btn-sm">
            <span>📡</span> Raw Readings <span id="history-readings-count-pill"></span>
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
            ${state.historySubtab === 'events'
              ? 'Click any event row to open the +/- 15 min water level profile drawer.'
              : 'Live ultrasonic sensor telemetry captured every 5 seconds.'}
          </span>
        </div>
      </div>

      <!-- Table Container -->
      <div id="history-table-container"></div>
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

  function updateHistoryCountPills(eventsCount, readingsCount) {
    const evPill = document.getElementById('history-events-count-pill');
    const rdPill = document.getElementById('history-readings-count-pill');
    if (evPill && eventsCount !== undefined && eventsCount !== null) {
      evPill.textContent = `(${eventsCount})`;
    }
    if (rdPill && readingsCount !== undefined && readingsCount !== null) {
      rdPill.textContent = `(${readingsCount})`;
    }
  }

  /**
   * Fetches and renders Drain Events table (falls back to telemetry-derived drop cycles or prompts raw readings)
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

      const [res, summaryRes, rawCountRes] = await Promise.all([
        API.getRodEvents(params),
        API.getAnalyticsSummary(state.currentDeviceId, 30).catch(() => ({})),
        API.getReadings({ device_id: state.currentDeviceId, page: 1, pageSize: 1, limit: 1 }).catch(() => ({ total: 0 }))
      ]);

      const hwEvents = Array.isArray(res) ? res : (res.data || res.events || []);
      const hwTotal = res.total !== undefined ? res.total : hwEvents.length;
      const readingsTotal = (rawCountRes && rawCountRes.total !== undefined)
        ? rawCountRes.total
        : (summaryRes && summaryRes.total_readings !== undefined ? summaryRes.total_readings : null);

      let events = hwEvents;
      let total = hwTotal;
      let isDerivedFallback = false;

      if (events.length === 0 && state.historyEventsPage === 1 && summaryRes && Array.isArray(summaryRes.derived_events)) {
        const filteredDerived = summaryRes.derived_events
          .filter(ev => !state.historyStatusFilter || String(ev.status).toUpperCase() === state.historyStatusFilter)
          .map((ev, idx) => ({
            ...ev,
            id: ev.id !== undefined ? ev.id : `derived-${idx + 1}`,
            derived: true
          }));

        if (filteredDerived.length > 0) {
          events = filteredDerived;
          total = filteredDerived.length;
          isDerivedFallback = true;
        }
      }

      state.historyEventsTotal = total;
      updateHistoryCountPills(total, readingsTotal);

      if (events.length === 0) {
        const avgStr = summaryRes && summaryRes.avg_water_cm !== null && summaryRes.avg_water_cm !== undefined
          ? `${Number(summaryRes.avg_water_cm).toFixed(1)} cm`
          : '--';
        const peakStr = summaryRes && summaryRes.peak_water_cm !== null && summaryRes.peak_water_cm !== undefined
          ? `${Number(summaryRes.peak_water_cm).toFixed(1)} cm`
          : '--';

        container.innerHTML = `
          <div class="card" style="text-align: center; padding: 2rem;">
            <p style="font-size: 1rem; font-weight: 700; margin-bottom: 0.4rem;">No Drain Drop Cycles Recorded Yet</p>
            <p style="color: var(--text-secondary); font-size: 0.85rem; max-width: 560px; margin: 0 auto 1rem auto;">
              ${state.historyStatusFilter
                ? `No events match status "${escapeHTML(state.historyStatusFilter)}".`
                : 'Rate-of-Drop events are created automatically after water rises above the rain threshold and recedes.'}
              ${readingsTotal ? ` However, <strong>${readingsTotal} live sensor readings</strong> are already logged (Mean depth: ${avgStr}, Peak: ${peakStr}).` : ''}
            </p>
            ${readingsTotal ? `
              <button id="btn-switch-to-raw-readings" class="btn btn-primary btn-sm">
                <span>📡</span> View Raw Readings (${readingsTotal} records)
              </button>
            ` : ''}
          </div>
        `;

        const switchBtn = document.getElementById('btn-switch-to-raw-readings');
        if (switchBtn) {
          switchBtn.addEventListener('click', () => {
            state.historySubtab = 'readings';
            renderHistoryTab();
          });
        }
        return;
      }

      const totalPages = Math.ceil(total / state.historyEventsLimit) || 1;

      container.innerHTML = `
        ${isDerivedFallback ? `
          <div class="card" style="margin-bottom: 1rem; padding: 0.75rem 1rem; border-left: 4px solid var(--accent-primary);">
            <span style="font-size: 0.82rem; color: var(--text-secondary);">
              ℹ️ Showing <strong>${events.length} telemetry-derived drain cycle(s)</strong> computed from raw sensor drop sequences. Hardware <code>rod_result</code> events will appear alongside these automatically.
            </span>
          </div>
        ` : ''}

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
                const ratioPct = ev.ratio !== undefined && ev.ratio !== null ? Math.round(Number(ev.ratio) * 100) + '%' : '--';
                return `
                  <tr data-event-id="${escapeHTML(ev.id)}" class="clickable-event-row">
                    <td>
                      <strong>${formatIST(ev.created_at)}</strong>
                      ${ev.derived ? '<span class="badge calibrated" style="margin-left: 0.4rem; font-size: 0.68rem;">Telemetry</span>' : ''}
                    </td>
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
      updateHistoryCountPills(state.historyEventsTotal || null, total);

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
                  <td style="font-weight: 700;">${r.water_cm !== undefined && r.water_cm !== null ? Number(r.water_cm).toFixed(1) : '--'}</td>
                  <td>${r.distance_cm !== undefined && r.distance_cm !== null ? Number(r.distance_cm).toFixed(1) : '--'}</td>
                  <td>${r.flood_risk ? '<span class="badge preclog">RISK</span>' : '<span class="badge clear">OK</span>'}</td>
                  <td>${r.rssi !== undefined && r.rssi !== null ? `${r.rssi} dBm` : '--'}</td>
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
        backdrop.setAttribute('aria-hidden', 'true');
      };
    }
    if (backdrop) {
      backdrop.onclick = (e) => {
        if (e.target === backdrop) {
          backdrop.classList.remove('open');
          backdrop.setAttribute('aria-hidden', 'true');
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
    backdrop.setAttribute('aria-hidden', 'false');

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
              borderColor: '#ffd60a',
              backgroundColor: 'rgba(255, 214, 10, 0.12)',
              fill: true,
              tension: 0.25
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

    const deviceId = state.currentDeviceId;
    const cached = tabCache.alerts[deviceId];

    const paintAlerts = (alerts) => {
      container.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.25rem;">
          <div>
            <h2 style="font-size: 1.3rem; font-weight: 800;">Operational Warning Alerts</h2>
            <p style="font-size: 0.85rem; color: var(--text-secondary);">Threshold breaches, flood risks, and hardware fault notifications</p>
          </div>

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
    };

    if (cached) {
      paintAlerts(cached.alerts);
      if (Date.now() - cached.ts <= 8000) return;
      API.getAlerts({ device_id: deviceId, pageSize: 100 })
        .then(res => {
          const alerts = Array.isArray(res) ? res : (res.data || res.alerts || []);
          tabCache.alerts[deviceId] = { alerts, ts: Date.now() };
          if (state.activeTab === 'alerts' && state.currentDeviceId === deviceId) {
            paintAlerts(alerts);
          }
        })
        .catch(() => {});
      return;
    }

    showSkeleton('tab-alerts', 'Scanning active fault & threshold alerts...');

    try {
      const res = await API.getAlerts({ device_id: deviceId, pageSize: 100 });
      const alerts = Array.isArray(res) ? res : (res.data || res.alerts || []);
      tabCache.alerts[deviceId] = { alerts, ts: Date.now() };
      paintAlerts(alerts);
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
        const alertObj = alerts.find(a => String(a.id) === String(id)) || { id };
        try {
          await acknowledgePersistingAlert(alertObj);
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
          // If this resolved alert was the current active critical one, silence siren
          if (state.currentActiveCriticalAlert && String(state.currentActiveCriticalAlert.id) === String(id)) {
            state.currentActiveCriticalAlert = null;
            stopSirenLoop();
          }
          delete state.acknowledgedAlertMap[String(id)];
          try {
            localStorage.setItem('drainGuard_acked_alerts', JSON.stringify(state.acknowledgedAlertMap));
          } catch (_) {}

          await API.resolveAlert(id, state.adminKey);
          showToast(`Alert #${id} resolved & cleared`, 'success');
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

    const deviceId = state.currentDeviceId;
    const warmOverview = state.activeOverview && state.activeOverview.device && state.activeOverview.device.id === deviceId
      ? state.activeOverview
      : null;

    if (!warmOverview) {
      showSkeleton('tab-settings', 'Syncing sensor calibration & threshold parameters...');
    }

    try {
      const overview = warmOverview || await API.getDeviceOverview(deviceId);
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
                <input type="text" id="setting-name" class="form-control" value="${escapeHTML(sanitizeDeviceName(device.name, device.id || state.currentDeviceId))}" ${!isAdmin ? 'disabled' : ''}>
              </div>

              <div class="form-group">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.35rem;">
                  <label class="form-label" for="setting-location" style="margin-bottom: 0;">Installation Location</label>
                  <button type="button" id="btn-fill-current-location" class="btn btn-secondary btn-sm" ${!isAdmin ? 'disabled' : ''}>
                    📍 Use Current GPS
                  </button>
                </div>
                <input type="text" id="setting-location" class="form-control" value="${escapeHTML(getEffectiveLocation(device).label)}" ${!isAdmin ? 'disabled' : ''}>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
                <div class="form-group">
                  <label class="form-label" for="setting-lat">Latitude</label>
                  <input type="number" step="0.0001" id="setting-lat" class="form-control" value="${getEffectiveLocation(device).lat.toFixed(4)}" ${!isAdmin ? 'disabled' : ''}>
                </div>
                <div class="form-group">
                  <label class="form-label" for="setting-lng">Longitude</label>
                  <input type="number" step="0.0001" id="setting-lng" class="form-control" value="${getEffectiveLocation(device).lng.toFixed(4)}" ${!isAdmin ? 'disabled' : ''}>
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

      // Fill Current GPS Location button
      const fillLocBtn = document.getElementById('btn-fill-current-location');
      if (fillLocBtn) {
        fillLocBtn.addEventListener('click', async () => {
          fillLocBtn.disabled = true;
          fillLocBtn.textContent = 'Detecting...';
          const loc = await detectCurrentLocation(false);
          if (loc) {
            const locInput = document.getElementById('setting-location');
            const latInput = document.getElementById('setting-lat');
            const lngInput = document.getElementById('setting-lng');
            if (locInput) locInput.value = loc.label;
            if (latInput) latInput.value = loc.lat.toFixed(4);
            if (lngInput) lngInput.value = loc.lng.toFixed(4);
          }
          fillLocBtn.disabled = false;
          fillLocBtn.textContent = '📍 Use Current GPS';
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
    initSoundAlertControls();
    initAdminAuth();
    initNavigation();
    loadInitialData();

    // Manual Sync / Refresh Button in Header
    const refreshBtn = document.getElementById('header-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        if (!state.currentDeviceId) {
          loadInitialData();
          return;
        }
        const icon = document.getElementById('refresh-icon');
        if (icon) icon.classList.add('spin-once');
        // Bust cache for current tab so operator gets guaranteed fresh backend state
        if (state.activeTab === 'analytics') delete tabCache.analytics[`${state.currentDeviceId}_${state.analyticsDays}`];
        if (state.activeTab === 'trends') {
          Object.keys(tabCache.trends).forEach(k => {
            if (k.startsWith(`${state.currentDeviceId}_`)) delete tabCache.trends[k];
          });
        }
        if (state.activeTab === 'history') delete tabCache.history[`${state.currentDeviceId}_${state.historyMode}_${state.historyStatusFilter}_${state.historyPage}`];
        if (state.activeTab === 'alerts') delete tabCache.alerts[state.currentDeviceId];

        await loadActiveTab();
        showToast('Telemetry synced from server', 'info', 2200);
        setTimeout(() => { if (icon) icon.classList.remove('spin-once'); }, 650);
      });
    }

    // Global Escape key dismissal for Admin Modal & History Detail Drawer
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const modal = document.getElementById('admin-modal');
      if (modal && !modal.hidden) {
        modal.hidden = true;
      }
      const drawer = document.getElementById('history-drawer-backdrop');
      if (drawer && drawer.classList.contains('open')) {
        drawer.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
      }
    });

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
