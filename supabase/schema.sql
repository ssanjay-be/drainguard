-- =============================================================================
-- DrainGuard: Predictive Stormwater Drain Clog Diagnostic System
-- =============================================================================
--
-- SCHEMA OVERVIEW (for students)
-- --------------------------------
-- This file defines the entire database structure for DrainGuard, a system
-- that uses ultrasonic sensors mounted above storm drains to detect water
-- levels, predict clogging, and alert operators before floods occur.
--
-- HOW IT WORKS (data flow):
--   1. Physical sensors ("devices") measure water depth every few seconds.
--   2. Each measurement is stored as a "reading" (raw telemetry).
--   3. The backend analyses readings and computes a "Rate of Drop" (ROD)
--      metric — when water drains SLOWLY, it may indicate a clog forming.
--      These computed results are stored as "rod_events".
--   4. If ROD (or water level) crosses a threshold, an "alert" is raised
--      so operators can inspect the drain before it overflows.
--   5. Per-device tuneable parameters live in "device_config".
--
-- TABLE SUMMARY:
--   devices       — registered sensors (one row per physical device)
--   readings      — raw telemetry: distance, water depth, flood flag, etc.
--   rod_events    — computed rate-of-drop events derived from readings
--   alerts        — actionable notifications sent to operators
--   device_config — per-device thresholds and calibration settings
--
-- NOTES FOR STUDENTS:
--   • All timestamps use timestamptz (timezone-aware) so data is unambiguous
--     when devices are deployed across multiple timezones.
--   • Row Level Security (RLS) is ENABLED on every table but NO public
--     policies are defined. The backend server uses the Supabase "service
--     role" key, which bypasses RLS entirely — so the app still works while
--     direct browser/anon access is locked down by default.
--   • The schema is idempotent: running it twice will not raise errors
--     because every DDL statement uses IF NOT EXISTS.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- TABLE: devices
-- Represents a physical ultrasonic sensor unit installed over a storm drain.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
    id          text        PRIMARY KEY,               -- human-readable device ID, e.g. "drain-01"
    name        text,                                  -- friendly display name
    location    text,                                  -- city / neighbourhood label
    lat         double precision,                      -- GPS latitude  (decimal degrees)
    lng         double precision,                      -- GPS longitude (decimal degrees)
    created_at  timestamptz DEFAULT now(),             -- when this device was first registered
    last_seen   timestamptz                            -- updated whenever the device sends any data
);

-- Enable RLS — no anon/public access; service role key bypasses this.
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- TABLE: readings
-- Raw telemetry pushed by each sensor on every measurement cycle.
-- A "reading" contains the actual sensor values; a "heartbeat" is a
-- keep-alive ping that only carries uptime and signal strength.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS readings (
    id          bigserial   PRIMARY KEY,
    device_id   text        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    created_at  timestamptz DEFAULT now(),

    -- Message type: a full sensor reading or a lightweight heartbeat
    type        text        NOT NULL CHECK (type IN ('reading', 'heartbeat')),

    -- Current operational state reported by the firmware (e.g. "DRY", "WET")
    state       text,

    -- Raw distance from sensor face to whatever is below (water surface / drain floor)
    distance_cm real,

    -- Calculated water depth = (sensor_to_bottom_cm - distance_cm)
    water_cm    real,

    -- True when the backend determines the water level exceeds the flood threshold
    flood_risk  boolean,

    -- WiFi received signal strength indicator (dBm); lower = weaker signal
    rssi        int,

    -- Seconds the device has been running since last power-on
    uptime_s    bigint
);

-- Index for fast time-series queries per device (most recent first)
CREATE INDEX IF NOT EXISTS readings_device_created
    ON readings (device_id, created_at DESC);

ALTER TABLE readings ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- TABLE: rod_events
-- "Rate of Drop" events computed by the backend analysis engine.
-- After rain stops, water in an unblocked drain drains quickly (high ROD).
-- A partially clogged drain drains slowly (low ROD), triggering a warning.
--
-- Key columns:
--   h1_cm / h2_cm    — water level at start and end of the drain window
--   duration_s       — elapsed time between h1 and h2 observations
--   rod_cm_min       — rate of drop in cm per minute  (h1-h2) / (duration_s/60)
--   baseline_rod     — the "healthy" ROD for this drain (set during calibration)
--   ratio            — rod_cm_min / baseline_rod  (1.0 = normal, <0.5 = pre-clog)
--   status           — classification result for this event
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rod_events (
    id              bigserial   PRIMARY KEY,
    device_id       text        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    created_at      timestamptz DEFAULT now(),

    h1_cm           real,                   -- water depth at window start (cm)
    h2_cm           real,                   -- water depth at window end   (cm)
    duration_s      real,                   -- drain window duration (seconds)
    rod_cm_min      real,                   -- measured rate of drop (cm/min)
    baseline_rod    real,                   -- reference ROD from calibration (cm/min)
    ratio           real,                   -- rod_cm_min / baseline_rod

    -- Classification based on the ratio vs configured thresholds
    status          text        CHECK (status IN ('CLEAR', 'WATCH', 'PRE_CLOG', 'CALIBRATED')),

    -- True when this event was used to set/update the baseline (calibration run)
    calibration     boolean     DEFAULT false,

    -- True when insufficient data points make the ROD estimate unreliable
    low_confidence  boolean     DEFAULT false
);

-- Index for fast time-series queries per device
CREATE INDEX IF NOT EXISTS rod_events_device_created
    ON rod_events (device_id, created_at DESC);

ALTER TABLE rod_events ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- TABLE: alerts
-- Actionable notifications raised when sensor data crosses a threshold.
-- Operators review and acknowledge alerts via the dashboard.
--
-- Alert lifecycle:  open  →  acknowledged  →  resolved
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
    id              bigserial   PRIMARY KEY,
    device_id       text        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    created_at      timestamptz DEFAULT now(),

    -- What triggered this alert
    type            text        NOT NULL CHECK (type IN (
                                    'PRE_CLOG',      -- drain draining too slowly
                                    'WATCH',         -- drain draining below normal
                                    'FLOOD_RISK',    -- water level above flood threshold
                                    'SENSOR_FAULT',  -- sensor readings are invalid/erratic
                                    'DEVICE_OFFLINE' -- device stopped sending data
                                )),

    -- How serious is this alert?
    severity        text        NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),

    -- Human-readable explanation shown in the dashboard
    message         text,

    -- Current state of the alert
    status          text        DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),

    -- When an operator acknowledged the alert (NULL until acknowledged)
    acknowledged_at timestamptz,

    -- When the alert was resolved (NULL until resolved)
    resolved_at     timestamptz,

    -- Optional link back to the rod_event that caused this alert (nullable)
    rod_event_id    bigint      NULL
);

-- Index for fast queries of alerts per device
CREATE INDEX IF NOT EXISTS alerts_device_created
    ON alerts (device_id, created_at DESC);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- TABLE: device_config
-- Per-device configuration parameters that control analysis thresholds.
-- Operators can tune these from the dashboard without redeploying firmware.
--
-- Column meanings:
--   baseline_rod        — healthy drain ROD reference (cm/min); 0 = uncalibrated
--   calibrate           — set to true to trigger a calibration run on next event
--   clear_ratio         — ratio above which the drain is considered CLEAR
--   preclog_ratio       — ratio below which the drain is classified PRE_CLOG
--   sensor_to_bottom_cm — physical distance from sensor face to dry drain floor
--   rain_start_cm       — minimum water depth (cm) to consider a rain event started
--   offline_after_min   — minutes of silence before DEVICE_OFFLINE alert fires
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_config (
    device_id               text    PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,

    baseline_rod            real    DEFAULT 0,      -- cm/min; 0 means "not yet calibrated"
    calibrate               boolean DEFAULT false,  -- flag for the backend to run calibration
    clear_ratio             real    DEFAULT 0.8,    -- ROD ratio >= this → CLEAR
    preclog_ratio           real    DEFAULT 0.5,    -- ROD ratio <= this → PRE_CLOG
    sensor_to_bottom_cm     real    DEFAULT 60,     -- physical installation depth (cm)
    rain_start_cm           real    DEFAULT 10,     -- minimum water depth to begin ROD window
    offline_after_min       int     DEFAULT 15,     -- minutes before offline alert

    updated_at              timestamptz DEFAULT now() -- last time config was changed
);

ALTER TABLE device_config ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- SEED DATA
-- Insert a demo device and its default configuration so the system works
-- out-of-the-box after a fresh deployment.
-- ON CONFLICT DO NOTHING makes this re-runnable without errors.
-- =============================================================================

-- Demo device: a mock PVC-pipe drain unit in Chennai, India
INSERT INTO devices (id, name, location, lat, lng)
VALUES (
    'drain-01',
    'Demo Drain - Mock PVC',
    'Chennai',
    13.0827,
    80.2707
)
ON CONFLICT (id) DO NOTHING;

-- Default configuration for the demo device
INSERT INTO device_config (device_id)
VALUES ('drain-01')
ON CONFLICT (device_id) DO NOTHING;
