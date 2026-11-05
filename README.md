# 🌧️ DrainGuard — Predictive Stormwater Drain Clog Diagnostic System

> **IoT Smart City Solution for Greater Chennai Corporation (GCC)**  
> An ESP32 microcontroller with a waterproof ultrasonic sensor (JSN-SR04T) monitors water levels inside stormwater drains. After rainfall, it calculates the **Rate of Dissipation (RoD, cm/min)** and compares it to a calibrated baseline to detect hidden sediment and debris clogs weeks before monsoon flooding occurs.

---

## 📋 Table of Contents

1. [Project Context & Scientific Principle](#project-context--scientific-principle)
2. [System Architecture](#system-architecture)
3. [Repository Layout](#repository-layout)
4. [Database Setup (Supabase PostgreSQL)](#database-setup-supabase-postgresql)
5. [Backend Setup (Node.js & Express)](#backend-setup-nodejs--express)
6. [Demo Data Seeder (90 Days)](#demo-data-seeder-90-days)
7. [Simulating ESP32 Telemetry](#simulating-esp32-telemetry)
8. [Deploying Backend to Render](#deploying-backend-to-render)
9. [Deploying Frontend to Netlify](#deploying-frontend-to-netlify)
10. [ESP32 Firmware Configuration](#esp32-firmware-configuration)
11. [Preventing Free-Tier Cold Starts (UptimeRobot)](#preventing-free-tier-cold-starts-uptimerobot)
12. [Environment Variables Reference](#environment-variables-reference)
13. [API Endpoints Reference](#api-endpoints-reference)
14. [Troubleshooting Guide](#troubleshooting-guide)
15. [License](#license)

---

## Project Context & Scientific Principle

Stormwater drains frequently suffer from gradual silt deposition, plastic waste accumulation, and structural collapse. During dry periods or light rains, these blockages remain invisible. When severe monsoon storms hit Chennai, the reduced drainage capacity causes devastating street waterlogging.

### The Diagnostic Algorithm: Rate of Dissipation (RoD)
Instead of merely monitoring instantaneous water depth, DrainGuard monitors the **drainage dissipation curve**:
$$\text{RoD} = \frac{H_1 - H_2}{T_2 - T_1} \quad (\text{cm/min})$$

Where:
- $H_1$ = Peak water depth recorded when rainfall subsides (cm)
- $H_2$ = Settled / normal baseline water level (cm)
- $T_2 - T_1$ = Time taken to drain from $H_1$ to $H_2$ (minutes)

The system compares the measured RoD against the drain's clean baseline ($\text{RoD}_{\text{baseline}}$):
$$\text{Ratio} = \frac{\text{RoD}}{\text{RoD}_{\text{baseline}}}$$

- **CLEAR** ($\ge 80\%$ of baseline): Drain pipe is completely clear.
- **WATCH** ($50\% - 80\%$ of baseline): Minor obstruction; drainage is slowing down.
- **PRE_CLOG** ($< 50\%$ of baseline): **Maintenance Required: Partial Blockage**. Debris accumulation detected weeks before a catastrophic flood.

### Firmware State Machine
The ESP32 firmware operates on a 5-state finite state machine:
`IDLE` $\rightarrow$ `RAIN` $\rightarrow$ `PEAK` $\rightarrow$ `ROD` $\rightarrow$ `DECISION`

---

## System Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                        FIELD HARDWARE LAYER                           │
│                                                                       │
│   ┌────────────────────┐   echo/trig   ┌──────────────────────────┐   │
│   │ JSN-SR04T Sensor   │ ────────────► │  ESP32 Microcontroller   │   │
│   │ (Waterproof Ultra) │               │  (FreeRTOS / Arduino)    │   │
│   └────────────────────┘               └─────────────┬────────────┘   │
│                                                      │ HTTPS POST     │
│                                                      │ x-api-key      │
└──────────────────────────────────────────────────────┼────────────────┘
                                                       ▼
┌───────────────────────────────────────────────────────────────────────┐
│                     BACKEND API (Render.com)                          │
│                     Node.js 20 + Express REST API                     │
│                                                                       │
│   • Ingestion & Rate Limiting: POST /api/ingest                       │
│   • Diagnostic Overview & Analytics: /api/devices, /api/analytics     │
│   • Time-series Downsampling: /api/readings?bucket=15m                │
│   • Background Cron: Node-cron (checks offline drains every minute)   │
│   • Push Alerts: Telegram Bot API integration                         │
│             │                                                         │
│             ▼                                                         │
│   ┌──────────────────────┐             ┌──────────────────────────┐   │
│   │ Supabase JS Client   │ ──────────► │  Supabase PostgreSQL DB  │   │
│   │ (Service Role Key)   │             │  RLS Enabled (Zero Leak) │   │
│   └──────────────────────┘             └──────────────────────────┘   │
└──────────────────────────────────────────────────────┬────────────────┘
                                                       │
                                              JSON API │ (CORS Restricted)
                                                       ▼
┌───────────────────────────────────────────────────────────────────────┐
│                    DASHBOARD FRONTEND (Netlify)                       │
│                    Vanilla HTML5 + CSS3 + ES6 JS                      │
│                                                                       │
│   • Responsive Single Page App with hash-routing (#overview, #trends) │
│   • Cross-section drain tank visual with animated water level         │
│   • Semicircle gauge & State Machine Stepper                          │
│   • Interactive Chart.js charts (live water level, regression trends) │
│   • Leaflet GIS Drain Map & IST Timezone formatting (Asia/Kolkata)    │
│   • Light / Dark theme toggle & Admin authentication modal            │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Repository Layout

```
drainguard/
├── .gitignore                    # Ignores node_modules, .env, OS files
├── README.md                     # Comprehensive documentation & presentation guide
├── netlify.toml                  # Netlify deployment configuration
├── render.yaml                   # Render Blueprint configuration
├── backend/
│   ├── .env.example              # Template for server environment variables
│   ├── package.json              # Node.js dependencies and scripts
│   ├── server.js                 # Express server entry point & middleware chain
│   ├── jobs/
│   │   └── offlineChecker.js     # Node-cron job running every minute for offline alerts
│   ├── lib/
│   │   ├── supabase.js           # Supabase client singleton with service role key
│   │   └── telegram.js           # Telegram Bot notification dispatcher
│   ├── middleware/
│   │   ├── auth.js               # requireDeviceKey & requireAdminKey middleware
│   │   └── rateLimiter.js        # express-rate-limit (100 req/min for ingest)
│   └── routes/
│       ├── admin.js              # Admin verification, calibration trigger, settings
│       ├── alerts.js             # Alert querying, acknowledgement, and resolution
│       ├── analytics.js          # Summary KPIs and linear regression trend projection
│       ├── deviceConfig.js       # Device configuration polling for ESP32
│       ├── devices.js            # Device list and real-time overview telemetry
│       ├── export.js             # CSV streaming for readings and RoD events
│       ├── ingest.js             # Sensor readings & RoD result ingestion
│       ├── readings.js           # Time-series querying & server-side downsampling
│       └── rodEvents.js          # Drainage event history
├── frontend/
│   ├── api.js                    # Vanilla API client module with auto-retry
│   ├── app.js                    # SPA application controller, charts, and renderers
│   ├── config.js                 # Runtime frontend configuration (API_BASE_URL)
│   ├── index.html                # Main dashboard HTML shell
│   └── style.css                 # Custom CSS design system, dark mode, print styles
├── scripts/
│   ├── seed-demo.js              # 90-day realistic demo data seeder
│   └── send-sample.js            # ESP32 telemetry simulator CLI tool
└── supabase/
    └── schema.sql                # Complete, idempotent PostgreSQL database schema
```

---

## Database Setup (Supabase PostgreSQL)

DrainGuard uses **Supabase PostgreSQL** with Row Level Security (RLS) enabled on all tables to ensure zero data leakage. The backend accesses the database exclusively via the **service role key**, which bypasses RLS while keeping public anonymous access disabled.

### 1. Create a Supabase Project
1. Log in to [supabase.com](https://supabase.com).
2. Click **New Project**, choose a project name (e.g., `drainguard-gcc`), set a secure database password, and select a region (e.g., `ap-south-1` Mumbai for India).
3. Wait ~1 minute for provisioning to finish.

### 2. Execute the Schema SQL
1. In the Supabase project dashboard, open the **SQL Editor** from the left sidebar.
2. Click **New query**.
3. Open `supabase/schema.sql` in your local project, copy the entire file content, and paste it into the SQL Editor.
4. Click **Run**.
5. The schema creates:
   - `devices`: Registered drain sensor units (auto-seeds `drain-01` in Chennai).
   - `device_config`: Tuneable thresholds (`baseline_rod`, `clear_ratio`, `preclog_ratio`, `sensor_to_bottom_cm`).
   - `readings`: Raw water levels, distances, RSSI, and battery/uptime telemetry.
   - `rod_events`: Computed Rate of Dissipation calculations.
   - `alerts`: Operational notifications (`PRE_CLOG`, `WATCH`, `FLOOD_RISK`, `SENSOR_FAULT`, `DEVICE_OFFLINE`).
   - Optimized indexes on `(device_id, created_at DESC)`.
   - RLS enabled on all 5 tables with zero public access policies.

### 3. Copy API Credentials
1. Go to **Project Settings** (gear icon) $\rightarrow$ **API**.
2. Copy your **Project URL** (e.g., `https://abcdefgh.supabase.co`).
3. Copy the **`service_role`** key (under Project API keys $\rightarrow$ reveal `service_role`).  
   > ⚠️ **CRITICAL SECURITY NOTE:** Never share the `service_role` key or put it in frontend code. It belongs exclusively in the backend `.env`.

---

## Backend Setup (Node.js & Express)

### 1. Local Environment Configuration
Navigate to the `backend/` directory and create your `.env` file from `.env.example`:

```bash
cd backend
cp .env.example .env
```

Open `.env` in an editor and fill in your values:

```env
PORT=3001
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-supabase-service-role-key
DEVICE_API_KEY=drainguard-secret-device-key-2026
ADMIN_PASSWORD=admin-secret-password-chennai
FRONTEND_ORIGIN=http://localhost:5500
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### 2. Install Dependencies & Start Server
```bash
npm install
npm run dev
```

The server validates that all required environment variables are present and starts:
```
🚀  DrainGuard backend running on port 3001
    Frontend origin: http://localhost:5500
    Health check:    http://localhost:3001/api/health
⏰  offlineChecker: started (runs every minute)
```

Verify backend health:
```bash
curl http://localhost:3001/api/health
# Response: {"ok":true,"timestamp":"2026-11-04T16:30:00.000Z"}
```

---

## Demo Data Seeder (90 Days)

To evaluate the dashboard's analytics, diagnostic charts, and predictive linear regression without waiting months for rain events, use the built-in seeder.

### Seeding `drain-demo`
Run the seeder from the `backend/` directory:

```bash
npm run seed
```

This generates:
- Device `drain-demo` located at Anna Nagar, Chennai ($13.0878^\circ\text{ N}, 80.2101^\circ\text{ E}$).
- Config baseline RoD of $2.0\text{ cm/min}$.
- 90 days of realistic history:
  - Rain events spaced every 2–4 days.
  - High-resolution 1-minute rising (`RAIN`, `PEAK`) and falling (`ROD`) telemetry curves.
  - Hourly `heartbeat` readings during dry weather.
  - Linear degradation in RoD from $100\%$ ($2.0\text{ cm/min}$) down to $\sim 45\%$ ($0.9\text{ cm/min}$) with realistic noise.
  - Generates realistic `WATCH` and `PRE_CLOG` alerts.
  - Does **NOT** alter the physical unit `drain-01`.

### Resetting Demo Data
To wipe all seeded demo records cleanly:
```bash
node ../scripts/seed-demo.js --reset
```

---

## Simulating ESP32 Telemetry

You can simulate field hardware payloads against your local or deployed backend using `scripts/send-sample.js`.

### Run Simulation
```bash
# Against local backend:
node scripts/send-sample.js --url http://localhost:3001 --key drainguard-secret-device-key-2026

# Against deployed cloud backend:
node scripts/send-sample.js --url https://drainguard-backend.onrender.com --key drainguard-secret-device-key-2026
```

The script transmits 7 sequential scenarios spaced 1 second apart:
1. `heartbeat` — Drain is idle, water level 3.5 cm, distance 56.5 cm.
2. `reading` — Rain onset detected, water level rising to 15.2 cm.
3. `reading` — Peak flood level reached at 32.1 cm.
4. `rod_result` (`CLEAR`) — Drainage test completed, RoD = 1.98 cm/min ($99\%$ of baseline). Resolves open clog alerts.
5. `rod_result` (`PRE_CLOG`) — Severe blockage test, RoD = 0.67 cm/min ($33.5\%$ of baseline). Generates critical alert and triggers Telegram notification.
6. `rod_result` (`CALIBRATED`) — Calibration test, updates device baseline in database.
7. `sensor_fault` — Simulates ultrasonic echo hardware fault.

---

## Deploying Backend to Render

The repository contains `render.yaml` for 1-click deployment on Render's free tier.

1. Push your repository to GitHub.
2. Sign in to [Render](https://render.com).
3. Click **New +** $\rightarrow$ **Blueprint**.
4. Select your GitHub repository.
5. Render detects `render.yaml` and sets up the Node.js web service:
   - Root directory: `backend`
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/api/health`
6. In the service's **Environment** tab on Render, fill in the secret variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `DEVICE_API_KEY`
   - `ADMIN_PASSWORD`
   - `FRONTEND_ORIGIN` (set to your Netlify URL, e.g. `https://drainguard.netlify.app`)
7. Click **Deploy**. Note your service URL: `https://your-service.onrender.com`.

---

## Deploying Frontend to Netlify

The frontend is built with pure vanilla web technologies (no build step, no bundlers, no dependencies).

1. Open `frontend/config.js` and set your Render backend URL:
   ```javascript
   window.APP_CONFIG = {
     API_BASE_URL: 'https://your-service.onrender.com', // Your deployed Render backend
     POLL_INTERVAL_MS: 5000,
     IST_TIMEZONE: 'Asia/Kolkata'
   };
   ```
2. Push your changes to GitHub.
3. Sign in to [Netlify](https://netlify.com).
4. Click **Add new site** $\rightarrow$ **Import an existing project**.
5. Select your GitHub repository.
6. Netlify automatically reads `netlify.toml`:
   - Publish directory: `frontend`
   - Build command: *(none needed)*
7. Click **Deploy site**.
8. Go back to Render environment variables and ensure `FRONTEND_ORIGIN` matches your Netlify domain (without trailing slash).

---

## ESP32 Firmware Configuration

When flashing the ESP32 (e.g. using the Arduino IDE with `drain_monitor_v2.ino` or MicroPython), update the connection parameters:

```cpp
// ============================================================
// DrainGuard ESP32 Network & Backend Configuration
// ============================================================
const char* WIFI_SSID     = "Your_WiFi_SSID";
const char* WIFI_PASS     = "Your_WiFi_Password";

// Backend Ingestion Endpoint
const char* SERVER_URL    = "https://your-service.onrender.com/api/ingest";
const char* CONFIG_URL    = "https://your-service.onrender.com/api/device/config?device_id=drain-01";
const char* DEVICE_KEY    = "drainguard-secret-device-key-2026"; // Matches DEVICE_API_KEY
const char* DEVICE_ID     = "drain-01";

// Ultrasonic Hardware Calibration (JSN-SR04T)
const float SENSOR_TO_BOTTOM_CM = 60.0; // Distance from sensor face to dry floor
const float RAIN_START_CM       = 10.0; // Minimum water depth to trigger RAIN state
```

---

## Preventing Free-Tier Cold Starts (UptimeRobot)

Render's free tier spins down web services after 15 minutes of inactivity. When a user opens the dashboard or an ESP32 sends data, cold starting can take up to 60 seconds.

**DrainGuard has two solutions for this:**
1. **Frontend Built-in Graceful Wakeup**: When opening the dashboard during a cold start, an animated alert displays: *"Waking up the server... this can take up to 60 seconds on free cloud hosting"*, automatically retrying with exponential backoff until the server responds.
2. **UptimeRobot Keep-Alive (Recommended)**:
   - Create a free account at [uptimerobot.com](https://uptimerobot.com).
   - Click **Add New Monitor**.
   - Monitor Type: `HTTP(s)`
   - Friendly Name: `DrainGuard Backend Keep-Alive`
   - URL: `https://your-service.onrender.com/api/health`
   - Monitoring Interval: `Every 5 minutes`
   - Click **Create Monitor**.
   This ping keeps the backend active 24/7.

---

## Environment Variables Reference

| Variable | Required | Scope | Description |
|---|---|---|---|
| `PORT` | Optional | Backend | Server port (default: `3001` or provided by Render) |
| `SUPABASE_URL` | **Yes** | Backend | Full Supabase project HTTPS URL |
| `SUPABASE_SERVICE_KEY` | **Yes** | Backend | Supabase **Service Role** key (secret, bypasses RLS) |
| `DEVICE_API_KEY` | **Yes** | Backend & ESP32 | Authentication key required in `x-api-key` header |
| `ADMIN_PASSWORD` | **Yes** | Backend & Dashboard | Admin password required in `x-admin-key` header |
| `FRONTEND_ORIGIN` | **Yes** | Backend | Allowed CORS origin (e.g. `https://drainguard.netlify.app`) |
| `TELEGRAM_BOT_TOKEN` | Optional | Backend | Telegram bot token from @BotFather for push alerts |
| `TELEGRAM_CHAT_ID` | Optional | Backend | Telegram target chat or channel ID |

---

## API Endpoints Reference

### IoT Device Endpoints (`x-api-key: <DEVICE_API_KEY>`)
- `POST /api/ingest`: Ingests `reading`, `heartbeat`, `rod_result`, or `sensor_fault`. Auto-registers new devices, updates `last_seen`, deduplicates alerts, and calculates RoD outcomes.
- `GET /api/device/config?device_id=<id>`: Remote configuration polling for ESP32 (fetches baseline RoD, calibrate flag, and ratios).

### Public Dashboard Endpoints (CORS-restricted)
- `GET /api/health`: Health and server timestamp.
- `GET /api/devices`: List all registered drains with real-time online status and latest RoD status.
- `GET /api/devices/:id/overview`: Full device snapshot (telemetry, drain health score, latest RoD event, active state, today's counters).
- `GET /api/readings`: Raw or downsampled time-series readings (`bucket=raw|1m|5m|15m|1h|1d`).
- `GET /api/rod-events`: Paginated drainage event log with status filtering.
- `GET /api/analytics/summary?device_id=<id>&days=30`: Aggregated KPIs, peak water depth, month-over-month rate change %, and clog risk score.
- `GET /api/analytics/trend?device_id=<id>&days=90`: Least-squares linear regression on RoD degradation, $R^2$ fit, estimated days until `PRE_CLOG` blockage threshold, and human-readable diagnostic insight.
- `GET /api/alerts`: Paginated system alerts with status filtering.
- `GET /api/export/readings.csv`: Stream raw telemetry as CSV.
- `GET /api/export/rod-events.csv`: Stream drainage event calculations as CSV.

### Admin Endpoints (`x-admin-key: <ADMIN_PASSWORD>`)
- `POST /api/admin/verify`: Validates admin credentials from frontend login modal.
- `POST /api/devices/:id/calibrate`: Sets device `calibrate = true` to schedule baseline recalibration on the next rainfall.
- `PUT /api/devices/:id/settings`: Updates drain location, thresholds, physical sensor geometry, and offline timeouts.
- `POST /api/alerts/:id/ack`: Acknowledges an active alert.
- `POST /api/alerts/:id/resolve`: Marks an alert as resolved.

---

## Troubleshooting Guide

### 1. CORS Blocked
- **Symptom:** Browser console outputs: `Access to fetch at ... has been blocked by CORS policy`.
- **Fix:** In your backend environment variables (on Render or local `.env`), verify `FRONTEND_ORIGIN` matches the dashboard URL exactly. Ensure protocol (`https://`) is present and there is **no trailing slash**.

### 2. HTTP 401 Unauthorized
- **Symptom:** Device ingest fails with `{ "error": "Unauthorized: invalid or missing x-api-key header" }`.
- **Fix:** Ensure the ESP32 or curl client sends the `x-api-key` header matching `DEVICE_API_KEY`. For admin actions in the UI, click the lock icon 🔒 and enter the configured `ADMIN_PASSWORD`.

### 3. Database Rows Not Appearing
- **Symptom:** Ingest returns `{ ok: true }`, but no rows appear in Supabase tables.
- **Fix:** Verify you provided the `SUPABASE_SERVICE_KEY` (service role) and not the public `anon` key. Since Row Level Security (RLS) is enabled with zero public policies, the `anon` key is denied read/write access.

### 4. 404 on API Calls
- **Symptom:** Dashboard displays network errors for all queries.
- **Fix:** Open `frontend/config.js` and verify `window.APP_CONFIG.API_BASE_URL` matches your running backend URL (e.g. `http://localhost:3001` locally or `https://drainguard-backend.onrender.com` on Render).

---

## License

This project is open-source under the **MIT License**.  
Developed for municipal stormwater flood prevention under the **Greater Chennai Corporation** smart city use case.