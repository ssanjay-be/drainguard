/*
 * =============================================================================
 * Predictive Stormwater Drain Clog Diagnostic System - ESP32 Firmware (v2.0)
 * Greater Chennai Corporation (GCC) IoT Smart City Deployment
 * =============================================================================
 *
 * HARDWARE CONFIGURATION:
 *   Board  : ESP32 Dev Module (ESP32-WROOM-32 / DevKit v1)
 *   Sensor : JSN-SR04T Waterproof Ultrasonic Sensor
 *            - TRIG -> GPIO 5
 *            - ECHO -> GPIO 18 (through 1k / 2k resistor divider: 5V -> 3.3V safe)
 *            - VCC  -> 5V (from VIN or external 5V supply)
 *            - GND  -> GND
 *
 * REQUIRED ARDUINO LIBRARIES (install via Arduino IDE Library Manager):
 *   - ArduinoJson (v7.x)
 *
 * 5-STAGE FINITE STATE MACHINE:
 *   0. ST_IDLE     : Live real-time water depth telemetry pushed every 5s to cloud.
 *   1. ST_RAIN     : Water level >= RAIN_START_CM, tracking rising surge curve.
 *   2. ST_PEAK     : Water stops rising / plateau detected -> captures peak H1.
 *   3. ST_ROD      : Drainage phase -> measures dissipation rate (H1 -> H2 over time).
 *   4. ST_DECISION : Computes RoD = (H1 - H2) / delta_T, compares against calibrated
 *                    baseline RoD -> sends CLEAR / WATCH / PRE_CLOG to cloud.
 * =============================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

// =============================================================================
// 1. NETWORK & DEPLOYED CLOUD CONFIGURATION
// =============================================================================
// WiFi Network Credentials (Change if using a mobile hotspot or college WiFi)
const char* WIFI_SSID  = "Suresh 5g";
const char* WIFI_PASS  = "12345679";

// Deployed Render Backend URL (no trailing slash, HTTPS)
const char* SERVER_URL = "https://drainguard-by4m.onrender.com";

// Device Security Key (must match DEVICE_API_KEY in backend environment)
const char* API_KEY    = "drainguard-device-key-2026";

// Hardware Device Identifier (registered in Supabase database)
const char* DEVICE_ID  = "drain-01";

// =============================================================================
// 2. HARDWARE PINS & PHYSICAL GEOMETRY (JSN-SR04T)
// =============================================================================
const uint8_t TRIG_PIN = 5;
const uint8_t ECHO_PIN = 18;

// Physical drain geometry (can be customized via web dashboard settings)
float sensorToBottomCm = 60.0;   // Height of sensor face above dry drain floor (cm)
const float MIN_VALID_CM        = 20.0;   // JSN-SR04T minimum blind zone (cm)
float floodWarnCm               = 35.0;   // Depth where water is dangerously close to top

// =============================================================================
// 3. DIAGNOSTIC ALGORITHM THRESHOLDS
// =============================================================================
float rainStartCm          = 10.0;  // Water depth that triggers RAIN event (cm)
const float RAIN_END_CM    = 5.0;   // Water below this = rain event subsided (cm)
const float EMPTY_CM       = 2.0;   // Water depth considered completely empty
const float DEADBAND_CM    = 0.3;   // Fluctuation deadband (cm)
const float RESTART_RISE_CM = 2.0;  // Water rising this much during RoD = rain resumed
const uint8_t DROPS_TO_CONFIRM = 3; // Consecutive falling samples to confirm peak

// RoD Ratio Thresholds (compared against calibrated baseline)
float clearRatio   = 0.80;  // RoD >= 80% baseline -> CLEAR
float preclogRatio = 0.50;  // RoD < 50% baseline  -> PRE_CLOG (50-80% -> WATCH)
const uint8_t NUM_SAMPLES  = 11;    // Median filter sample count

// =============================================================================
// 4. REAL-TIME TELEMETRY TRANSMISSION TIMING (Continuous Live Streaming)
// =============================================================================
const uint32_t IDLE_INTERVAL_S     = 5;    // Push live telemetry every 5s in dry/idle state
const uint32_t RAIN_SAMPLE_S       = 3;    // High-frequency sampling every 3s during rain
const uint32_t ROD_SAMPLE_S        = 3;    // Sampling interval during RoD drainage phase
const uint32_t ROD_MAX_WINDOW_S    = 180;  // Maximum wait for RoD drainage window (3 mins)
const uint16_t STEADY_LIMIT        = 8;    // Plateau sample count (completely blocked drain)
const uint32_t CONFIG_POLL_CYCLE   = 12;   // Sync remote cloud config every 12 idle cycles (~60s)
const uint32_t HTTP_TIMEOUT_MS     = 10000;// 10s network timeout for live Render backend

// =============================================================================
// 5. DATA TYPES & SYSTEM STATE
// =============================================================================
enum State { ST_IDLE, ST_RAIN, ST_PEAK, ST_ROD, ST_DECISION };
const char* STATE_NAMES[] = {"IDLE", "RAIN", "PEAK", "ROD", "DECISION"};

struct Reading {
  bool  valid;
  bool  tooClose;   // Water inside blind spot (severe flood risk)
  float distance;   // Distance in cm from sensor to water surface
  float water;      // Calculated water depth in cm
};

State state = ST_IDLE;
Preferences prefs;

uint32_t telemetryCount = 0;
uint8_t  faultCount     = 0;

float baselineRod   = 0.0;    // Calibrated baseline RoD in cm/min
bool  calibrateMode = false;  // Flag to mark upcoming drainage run as calibration

float    prevLevel   = 0.0;
float    peakLevel   = 0.0;
uint8_t  dropCount   = 0;
uint16_t steadyCount = 0;

float    h1 = 0.0;
float    h2 = 0.0;
uint32_t t1 = 0;
float    rodElapsedS = 0.0;

// =============================================================================
// 6. ULTRASONIC SENSOR DRIVER (JSN-SR04T with Median Filter)
// =============================================================================
float pingCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(4);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(15);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long durationUs = pulseIn(ECHO_PIN, HIGH, 35000UL); // Timeout at ~6m distance
  if (durationUs == 0) return -1.0;

  // Speed of sound: 343 m/s = 0.0343 cm/us (divided by 2 for round-trip)
  return (durationUs * 0.0343f) / 2.0f;
}

Reading takeReading() {
  float samples[16];
  uint8_t validCount = 0;
  uint8_t closeCount = 0;

  for (uint8_t i = 0; i < NUM_SAMPLES; i++) {
    float dist = pingCm();
    if (dist > 0 && dist < MIN_VALID_CM) {
      closeCount++;
    } else if (dist >= MIN_VALID_CM && dist <= (sensorToBottomCm + 15.0)) {
      samples[validCount++] = dist;
    }
    delay(40);
  }

  Reading r = {false, false, 0.0, 0.0};
  const uint8_t majority = (NUM_SAMPLES / 2) + 1;

  // Blind spot detection -> water has reached sensor head
  if (closeCount >= majority) {
    r.valid    = true;
    r.tooClose = true;
    r.distance = MIN_VALID_CM;
    r.water    = sensorToBottomCm - MIN_VALID_CM;
    return r;
  }

  // Not enough valid ultrasonic echoes
  if (validCount < 4) return r;

  // Simple insertion sort to find median value
  for (uint8_t i = 1; i < validCount; i++) {
    float key = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > key) {
      samples[j + 1] = samples[j];
      j--;
    }
    samples[j + 1] = key;
  }

  r.valid    = true;
  r.distance = samples[validCount / 2]; // Median
  r.water    = sensorToBottomCm - r.distance;
  if (r.water < 0.0) r.water = 0.0;     // Clamp negative depth

  return r;
}

// =============================================================================
// 7. NETWORK & CLOUD INGESTION CLIENT
// =============================================================================
bool ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[WiFi] Connecting to: ");
  Serial.println(WIFI_SSID);

  uint32_t startMs = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - startMs < 12000)) {
    delay(400);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP: %s | RSSI: %d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return true;
  } else {
    Serial.println("\n[WiFi] Connection Failed! Retrying next cycle.");
    return false;
  }
}

bool postJson(const char* path, const String& body) {
  if (!ensureWiFi()) return false;

  WiFiClientSecure client;
  client.setInsecure(); // SSL certificate verification bypass for prototype cloud endpoint

  HTTPClient http;
  String fullUrl = String(SERVER_URL) + path;

  http.begin(client, fullUrl);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);

  int httpCode = http.POST(body);
  http.end();

  if (httpCode >= 200 && httpCode < 300) {
    Serial.printf("[HTTP POST %s] -> %d (Success)\n", path, httpCode);
    return true;
  } else {
    Serial.printf("[HTTP POST %s] -> %d (Failed)\n", path, httpCode);
    return false;
  }
}

// Polls remote threshold config and calibration arming from web dashboard
void fetchConfig() {
  if (!ensureWiFi()) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = String(SERVER_URL) + "/api/device/config?device_id=" + String(DEVICE_ID);

  http.begin(client, url);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("x-api-key", API_KEY);

  int httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload);

    if (!err) {
      float remoteBaseline = doc["baseline_rod"] | 0.0f;
      if (remoteBaseline > 0.0f) {
        baselineRod = remoteBaseline;
        prefs.putFloat("baseRod", baselineRod);
      }

      calibrateMode = doc["calibrate"] | false;

      float remoteS2B = doc["sensor_to_bottom_cm"] | 0.0f;
      if (remoteS2B > 20.0f) {
        sensorToBottomCm = remoteS2B;
        floodWarnCm = sensorToBottomCm - MIN_VALID_CM - 3.0;
      }

      float remoteRainStart = doc["rain_start_cm"] | 0.0f;
      if (remoteRainStart > 2.0f) rainStartCm = remoteRainStart;

      float remoteClearRatio = doc["clear_ratio"] | 0.0f;
      if (remoteClearRatio > 0.0f) clearRatio = remoteClearRatio;

      float remotePreclogRatio = doc["preclog_ratio"] | 0.0f;
      if (remotePreclogRatio > 0.0f) preclogRatio = remotePreclogRatio;

      Serial.printf("[Config Synced] Baseline=%.2f cm/min | Calib=%d | Depth=%.1f cm | RainStart=%.1f cm\n",
                    baselineRod, calibrateMode, sensorToBottomCm, rainStartCm);
    }
  }
  http.end();
}

// Transmits continuous live reading to dashboard
void sendReading(const Reading& r, const char* type = "reading") {
  JsonDocument doc;
  doc["device_id"]   = DEVICE_ID;
  doc["type"]        = type;
  doc["state"]       = STATE_NAMES[state];
  doc["distance_cm"] = round(r.distance * 10.0f) / 10.0f;
  doc["water_cm"]    = round(r.water * 10.0f) / 10.0f;
  doc["flood_risk"]  = r.tooClose || (r.water >= floodWarnCm);
  doc["rssi"]        = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  doc["uptime_s"]    = millis() / 1000;

  String body;
  serializeJson(doc, body);
  postJson("/api/ingest", body);
}

// Reports ultrasonic transducer hardware fault
void sendFault() {
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["type"]      = "sensor_fault";
  doc["state"]     = STATE_NAMES[state];

  String body;
  serializeJson(doc, body);
  postJson("/api/ingest", body);
}

// Transmits finished RoD calculation event to dashboard
void sendRodResult(float rod, float ratio, const char* status, bool calibration) {
  JsonDocument doc;
  doc["device_id"]    = DEVICE_ID;
  doc["type"]         = "rod_result";
  doc["state"]        = STATE_NAMES[state];
  doc["h1_cm"]        = round(h1 * 10.0f) / 10.0f;
  doc["h2_cm"]        = round(h2 * 10.0f) / 10.0f;
  doc["duration_s"]   = round(rodElapsedS);
  doc["rod_cm_min"]   = round(rod * 100.0f) / 100.0f;
  doc["baseline_rod"] = round(baselineRod * 100.0f) / 100.0f;
  doc["ratio"]        = round(ratio * 100.0f) / 100.0f;
  doc["status"]       = status;
  doc["calibration"]  = calibration;
  doc["rssi"]         = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;

  String body;
  serializeJson(doc, body);
  postJson("/api/ingest", body);
}

// =============================================================================
// 8. FINITE STATE MACHINE IMPLEMENTATION
// =============================================================================

// STATE 0: IDLE (Dry drain / normal condition - Real-time stream every 5s)
void stateIdle() {
  Reading r = takeReading();

  if (!r.valid) {
    Serial.println("[IDLE] Ultrasonic echo invalid (check sensor alignment/wiring)");
    if (++faultCount >= 3) {
      sendFault();
      faultCount = 0;
    }
  } else {
    faultCount = 0;
    Serial.printf("[REALTIME IDLE] Dist: %.1f cm | Water Depth: %.1f cm | FloodRisk: %s\n",
                  r.distance, r.water, (r.water >= floodWarnCm || r.tooClose) ? "YES" : "NO");

    // Send real-time reading so live drain visual tank updates on dashboard
    sendReading(r, "reading");

    // Check if rain surge has started
    if (r.water >= rainStartCm) {
      Serial.println("\n>>> [EVENT] Water level exceeded Rain Threshold! Transitioning to RAIN State >>>");
      fetchConfig(); // Refresh baseline & calibration flag before event
      prevLevel = peakLevel = r.water;
      dropCount = 0;
      steadyCount = 0;
      state = ST_RAIN;
      return;
    }
  }

  // Periodic remote config check from cloud
  telemetryCount++;
  if (telemetryCount % CONFIG_POLL_CYCLE == 0) {
    fetchConfig();
  }

  // Wait 5 seconds before next live reading
  for (uint8_t i = 0; i < IDLE_INTERVAL_S; i++) delay(1000);
}

// STATE 1: RAIN (Water level rising, waiting for rainfall to subside)
void stateRain() {
  for (uint8_t i = 0; i < RAIN_SAMPLE_S; i++) delay(1000);

  Reading r = takeReading();
  if (!r.valid) return;

  sendReading(r, "reading");
  float lvl = r.water;
  Serial.printf("[RAIN SURGE] Water: %.1f cm (Peak: %.1f cm) | Drops: %u/%u | Steady: %u\n",
                lvl, peakLevel, dropCount, DROPS_TO_CONFIRM, steadyCount);

  // False alarm or instantaneous drain
  if (lvl < RAIN_END_CM) {
    Serial.println(">>> Water returned to dry level. Event concluded.");
    state = ST_IDLE;
    return;
  }

  // Trend detection: rising, falling, or plateauing
  if (lvl > prevLevel + DEADBAND_CM) {
    dropCount = 0;
    steadyCount = 0;
  } else if (lvl < prevLevel - DEADBAND_CM) {
    dropCount++;
    steadyCount = 0;
  } else {
    steadyCount++;
  }

  if (lvl > peakLevel) peakLevel = lvl;
  prevLevel = lvl;

  // Transition when water consistently drops OR plateaus (fully clogged pipe)
  if (dropCount >= DROPS_TO_CONFIRM) {
    Serial.println("\n>>> [PEAK DETECTED] Water level started falling. Transitioning to PEAK State >>>");
    state = ST_PEAK;
  } else if (steadyCount >= STEADY_LIMIT) {
    Serial.println("\n>>> [PLATEAU DETECTED] Water is stagnant/blocked! Transitioning to PEAK State >>>");
    state = ST_PEAK;
  }
}

// STATE 2: PEAK (Latching start height H1 and starting dissipation timer T1)
void statePeak() {
  Reading r = takeReading();
  h1 = r.valid ? r.water : prevLevel;
  t1 = millis();

  Serial.printf("\n========================================\n");
  Serial.printf("[PEAK LATCHED] H1 = %.1f cm | RoD Timer Started\n", h1);
  Serial.printf("========================================\n");

  state = ST_ROD;
}

// STATE 3: ROD (Rate of Dissipation measurement window)
void stateRod() {
  for (uint8_t i = 0; i < ROD_SAMPLE_S; i++) delay(1000);

  Reading r = takeReading();
  if (!r.valid) return;

  sendReading(r, "reading");
  uint32_t elapsedMs = millis() - t1;
  uint32_t elapsedSec = elapsedMs / 1000;
  Serial.printf("[ROD DRAINING] Water: %.1f cm | Start H1: %.1f cm | Elapsed: %lu s\n",
                r.water, h1, elapsedSec);

  // Rain resumed mid-drainage -> return to RAIN state
  if (r.water > (h1 + RESTART_RISE_CM)) {
    Serial.println(">>> Rain resumed mid-event! Returning to RAIN tracking state.");
    prevLevel = peakLevel = r.water;
    dropCount = 0;
    steadyCount = 0;
    state = ST_RAIN;
    return;
  }

  h2 = r.water;

  // Window completed or drain fully emptied
  if (elapsedSec >= ROD_MAX_WINDOW_S || r.water <= EMPTY_CM) {
    rodElapsedS = (float)elapsedMs / 1000.0f;
    state = ST_DECISION;
  }
}

// STATE 4: DECISION (Diagnostic RoD computation & cloud alert dispatch)
void stateDecision() {
  float durationMinutes = rodElapsedS / 60.0f;
  float rod = 0.0f;

  if (durationMinutes > 0.0f) {
    rod = (h1 - h2) / durationMinutes; // cm/min
  }
  if (rod < 0.0f) rod = 0.0f;

  bool isCalibrating = calibrateMode || (baselineRod <= 0.0f);
  const char* statusStr;
  float ratio = 0.0f;

  if (isCalibrating) {
    statusStr = "CALIBRATED";
    baselineRod = rod > 0.1f ? rod : 2.0f; // Set baseline
    prefs.putFloat("baseRod", baselineRod);
    ratio = 1.0f;
  } else {
    ratio = rod / baselineRod;
    if (ratio >= clearRatio) {
      statusStr = "CLEAR";
    } else if (ratio >= preclogRatio) {
      statusStr = "WATCH";
    } else {
      statusStr = "PRE_CLOG"; // Maintenance required!
    }
  }

  Serial.println("\n========================================================");
  Serial.printf(">>> DRAINAGE DIAGNOSTIC RESULT <<<\n");
  Serial.printf("H1: %.1f cm  ->  H2: %.1f cm  |  Duration: %.1f sec (%.2f min)\n",
                h1, h2, rodElapsedS, durationMinutes);
  Serial.printf("Measured RoD : %.2f cm/min\n", rod);
  Serial.printf("Baseline RoD : %.2f cm/min\n", baselineRod);
  Serial.printf("Drain Ratio  : %.1f%%\n", ratio * 100.0f);
  Serial.printf("STATUS       : %s\n", statusStr);
  Serial.println("========================================================\n");

  // Push outcome to cloud backend -> updates dashboard and triggers alerts
  sendRodResult(rod, ratio, statusStr, isCalibrating);

  // Reset calibration flag
  calibrateMode = false;

  // Drain cooldown: wait until water subsides below rain end threshold
  uint32_t cooldownStart = millis();
  while (millis() - cooldownStart < 30000UL) { // 30s cooldown
    Reading r = takeReading();
    if (r.valid) {
      sendReading(r, "reading");
      if (r.water < RAIN_END_CM) break;
    }
    delay(3000);
  }

  Serial.println(">>> Drainage cycle finished. Returning to IDLE real-time monitoring.");
  state = ST_IDLE;
}

// =============================================================================
// 9. SETUP & MAIN LOOP
// =============================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n============================================================");
  Serial.println("   DrainGuard - IoT Real-Time Stormwater Drain Monitor      ");
  Serial.println("   Greater Chennai Corporation (GCC) Diagnostic System      ");
  Serial.println("============================================================");

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  // Load non-volatile stored baseline from Flash NVS
  prefs.begin("drainguard", false);
  baselineRod = prefs.getFloat("baseRod", 0.0f);
  Serial.printf("[NVS] Stored Baseline RoD: %.2f cm/min\n", baselineRod);

  // Initialize WiFi connection
  ensureWiFi();

  // Fetch initial remote cloud configuration
  fetchConfig();

  Serial.println("[System Ready] Commencing live real-time sensor loop...\n");
}

void loop() {
  // Serial console commands for live lab testing
  if (Serial.available()) {
    char cmd = Serial.read();
    if (cmd == 'c') {
      calibrateMode = true;
      Serial.println("\n[Command] Calibration armed! Next drainage run will save new baseline.");
    } else if (cmd == 'r') {
      baselineRod = 0.0f;
      prefs.putFloat("baseRod", 0.0f);
      Serial.println("\n[Command] Baseline cleared from memory. Next event will auto-calibrate.");
    } else if (cmd == 's') {
      Serial.printf("\n[Status] State: %s | Baseline: %.2f cm/min | CalibrateFlag: %d\n",
                    STATE_NAMES[state], baselineRod, calibrateMode);
    }
  }

  // Execute active state machine step
  switch (state) {
    case ST_IDLE:     stateIdle();     break;
    case ST_RAIN:     stateRain();     break;
    case ST_PEAK:     statePeak();     break;
    case ST_ROD:      stateRod();      break;
    case ST_DECISION: stateDecision(); break;
  }
}
