/*
 * Predictive Stormwater Drain Clog Diagnostic System  -  ESP32 firmware
 * Board  : ESP32 Dev Module (ESP32 DevKit v1)
 * Sensor : JSN-SR04T  (TRIG -> GPIO5, ECHO -> GPIO18 through 1k/2k divider)
 * Libs   : ArduinoJson v7.x  (Library Manager). Everything else ships with the ESP32 core.
 *
 * State machine (matches the project brief):
 *   0 IDLE      dry drain, wake periodically (deep sleep in production)
 *   1 RAIN      level >= RAIN_START_CM, active mode, waiting for rain to stop
 *   2 PEAK      level fell for N consecutive samples (or plateaued) -> rain stopped
 *   3 ROD       record H1/T1, wait window, record H2/T2
 *   4 DECISION  RoD vs baseline -> CLEAR / WATCH / PRE_CLOG, push to cloud
 *
 * Serial monitor (115200) commands in DEMO_MODE:  c = calibrate on next event, r = reset baseline, s = status
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include "esp_sleep.h"

// ======================= USER CONFIG =======================
const char* WIFI_SSID  = "Suresh 5g";
const char* WIFI_PASS  = "12345679";
const char* SERVER_URL = "https://your-backend.onrender.com";   // no trailing slash, must be https
const char* API_KEY    = "change-this-secret-key";              // same value as backend env var
const char* DEVICE_ID  = "drain-01";

#define DEMO_MODE 1   // 1 = bench demo (short timings, no deep sleep) | 0 = field deployment

// ======================= HARDWARE / GEOMETRY =======================
const uint8_t TRIG_PIN = 5;
const uint8_t ECHO_PIN = 18;

const float SENSOR_TO_BOTTOM_CM = 60.0;   // MEASURE THIS: sensor face to bottom of EMPTY pipe
const float MIN_VALID_CM        = 25.0;   // JSN-SR04T blind spot
const float MAX_VALID_CM        = SENSOR_TO_BOTTOM_CM + 10.0;
const float FLOOD_WARN_CM       = SENSOR_TO_BOTTOM_CM - MIN_VALID_CM - 3.0;  // water this high = near blind spot

// ======================= ALGORITHM THRESHOLDS =======================
const float RAIN_START_CM  = 10.0;  // water depth that starts a rain event
const float RAIN_END_CM    = 5.0;   // hysteresis: below this the event is over / false alarm
const float EMPTY_CM       = 1.5;   // treat as empty
const float DEADBAND_CM    = 0.3;   // changes smaller than this are "steady"
const float RESTART_RISE_CM = 2.0;  // level rising this much above H1 during RoD = rain resumed
const uint8_t DROPS_TO_CONFIRM = 3; // consecutive falling samples = rain stopped
const float CLEAR_RATIO    = 0.80;  // RoD >= 80% of baseline  -> CLEAR  (tolerance below "baseline")
const float PRECLOG_RATIO  = 0.50;  // RoD <  50% of baseline  -> PRE_CLOG, in between -> WATCH
const uint8_t NUM_SAMPLES  = 11;    // median filter size

// ======================= TIMING =======================
#if DEMO_MODE
  const uint32_t IDLE_CHECK_S     = 10;
  const uint32_t SAMPLE_S         = 20;
  const uint32_t WINDOW_SAMPLE_S  = 15;
  const uint32_t ROD_WINDOW_S     = 90;
  const uint16_t STEADY_LIMIT     = 6;     // samples with no change before we call it a plateau
  const uint32_t COOLDOWN_MAX_S   = 600;
#else
  const uint32_t IDLE_SLEEP_S     = 600;   // 10 minutes
  const uint32_t SAMPLE_S         = 60;
  const uint32_t WINDOW_SAMPLE_S  = 60;
  const uint32_t ROD_WINDOW_S     = 300;   // 5 minutes
  const uint16_t STEADY_LIMIT     = 10;
  const uint32_t COOLDOWN_MAX_S   = 3600;
#endif
const uint8_t  HEARTBEAT_EVERY = 6;        // idle wakes between heartbeats
const uint32_t HTTP_TIMEOUT_MS = 65000;    // Render free tier can take ~50 s to wake up

// ======================= TYPES / GLOBALS =======================
enum State { ST_IDLE, ST_RAIN, ST_PEAK, ST_ROD, ST_DECISION };
const char* STATE_NAMES[] = {"IDLE", "RAIN", "PEAK", "ROD", "DECISION"};

struct Reading {
  bool  valid;
  bool  tooClose;   // water inside the blind spot -> flood
  float distance;   // cm, sensor -> surface
  float water;      // cm, water depth
};

State state = ST_IDLE;
Preferences prefs;

RTC_DATA_ATTR uint32_t wakeCount  = 0;
RTC_DATA_ATTR uint8_t  faultCount = 0;

float baselineRod  = 0;      // cm/min, 0 = not calibrated yet
bool  calibrateMode = false;

float    prevLevel = 0, peakLevel = 0;
uint8_t  dropCount = 0;
uint16_t steadyCount = 0;
float    h1 = 0, h2 = 0;
uint32_t t1 = 0;
float    rodElapsedS = 0;

// ======================= SENSOR =======================
float pingCm() {
  digitalWrite(TRIG_PIN, LOW);  delayMicroseconds(5);
  digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(15);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (us == 0) return -1;
  return us * 0.0343f / 2.0f;
}

// 11 rapid readings -> discard invalid -> median
Reading takeReading() {
  float v[16]; uint8_t n = 0, close = 0;
  for (uint8_t i = 0; i < NUM_SAMPLES; i++) {
    float d = pingCm();
    if (d > 0 && d < MIN_VALID_CM) close++;
    else if (d >= MIN_VALID_CM && d <= MAX_VALID_CM) v[n++] = d;
    delay(70);
  }
  Reading r = {false, false, 0, 0};
  const uint8_t majority = NUM_SAMPLES / 2 + 1;
  if (close >= majority) {                       // water in blind spot
    r.valid = true; r.tooClose = true;
    r.distance = MIN_VALID_CM;
    r.water = SENSOR_TO_BOTTOM_CM - MIN_VALID_CM;
    return r;
  }
  if (n < majority) return r;                    // too few good echoes
  for (uint8_t i = 1; i < n; i++) {              // insertion sort
    float k = v[i]; int j = i - 1;
    while (j >= 0 && v[j] > k) { v[j + 1] = v[j]; j--; }
    v[j + 1] = k;
  }
  r.valid = true;
  r.distance = v[n / 2];
  r.water = SENSOR_TO_BOTTOM_CM - r.distance;
  if (r.water < 0) r.water = 0;
  return r;
}

// ======================= NETWORK =======================
bool ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("WiFi connecting");
  uint32_t t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 15000) { delay(300); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " OK" : " FAILED");
  return WiFi.status() == WL_CONNECTED;
}

bool postJson(const char* path, const String& body) {
  if (!ensureWiFi()) return false;
  WiFiClientSecure client;
  client.setInsecure();   // OK for a prototype; pin the Render root CA for production
  HTTPClient http;
  http.begin(client, String(SERVER_URL) + path);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);
  int code = http.POST(body);
  http.end();
  Serial.printf("POST %s -> %d\n", path, code);
  return code >= 200 && code < 300;
}

void fetchConfig() {
  if (!ensureWiFi()) return;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, String(SERVER_URL) + "/api/device/config?device_id=" + DEVICE_ID);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("x-api-key", API_KEY);
  int code = http.GET();
  if (code == 200) {
    JsonDocument doc;
    if (!deserializeJson(doc, http.getString())) {
      float b = doc["baseline_rod"] | 0.0f;
      if (b > 0) { baselineRod = b; prefs.putFloat("baseRod", b); }
      calibrateMode = doc["calibrate"] | false;
      Serial.printf("Config: baseline=%.2f cm/min calibrate=%d\n", baselineRod, calibrateMode);
    }
  } else {
    Serial.printf("Config fetch failed (%d) - using stored baseline %.2f\n", code, baselineRod);
  }
  http.end();
}

void sendReading(const Reading& r, const char* type = "reading") {
  JsonDocument doc;
  doc["device_id"]  = DEVICE_ID;
  doc["type"]       = type;
  doc["state"]      = STATE_NAMES[state];
  doc["distance_cm"] = round(r.distance * 10) / 10.0;
  doc["water_cm"]   = round(r.water * 10) / 10.0;
  doc["flood_risk"] = r.tooClose || r.water >= FLOOD_WARN_CM;
  doc["rssi"]       = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  doc["uptime_s"]   = millis() / 1000;
  String body; serializeJson(doc, body);
  postJson("/api/ingest", body);
}

void sendFault() {
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["type"] = "sensor_fault";
  doc["state"] = STATE_NAMES[state];
  String body; serializeJson(doc, body);
  postJson("/api/ingest", body);
}

void sendRodResult(float rod, float ratio, const char* status, bool calibration) {
  JsonDocument doc;
  doc["device_id"]   = DEVICE_ID;
  doc["type"]        = "rod_result";
  doc["state"]       = STATE_NAMES[state];
  doc["h1_cm"]       = round(h1 * 10) / 10.0;
  doc["h2_cm"]       = round(h2 * 10) / 10.0;
  doc["duration_s"]  = round(rodElapsedS);
  doc["rod_cm_min"]  = round(rod * 100) / 100.0;
  doc["baseline_rod"] = round(baselineRod * 100) / 100.0;
  doc["ratio"]       = round(ratio * 100) / 100.0;
  doc["status"]      = status;
  doc["calibration"] = calibration;
  doc["rssi"]        = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  String body; serializeJson(doc, body);
  postJson("/api/ingest", body);
}

// ======================= HELPERS =======================
void waitSec(uint32_t s) { for (uint32_t i = 0; i < s; i++) delay(1000); }

void goToSleepOrWait() {
#if DEMO_MODE
  waitSec(IDLE_CHECK_S);
#else
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  esp_sleep_enable_timer_wakeup((uint64_t)IDLE_SLEEP_S * 1000000ULL);
  Serial.println("Deep sleep...");
  Serial.flush();
  esp_deep_sleep_start();
#endif
}

// ======================= STATES =======================
// STATE 0
void stateIdle() {
  Reading r = takeReading();
  if (!r.valid) {
    Serial.println("Invalid reading (check wiring / divider)");
    if (++faultCount == 3) { sendFault(); }
  } else {
    faultCount = 0;
    Serial.printf("[IDLE] dist=%.1f cm  water=%.1f cm\n", r.distance, r.water);
    if (r.water >= RAIN_START_CM) {
      Serial.println(">>> Rain event detected");
      fetchConfig();
      sendReading(r);
      prevLevel = peakLevel = r.water;
      dropCount = 0; steadyCount = 0;
      state = ST_RAIN;
      return;
    }
    if (wakeCount % HEARTBEAT_EVERY == 0) sendReading(r, "heartbeat");
  }
  wakeCount++;
  goToSleepOrWait();
}

// STATE 1 + 2 (peak detection: falling for N consecutive samples)
void stateRain() {
  waitSec(SAMPLE_S);
  Reading r = takeReading();
  if (!r.valid) return;
  sendReading(r);
  float lvl = r.water;
  Serial.printf("[RAIN] water=%.1f prev=%.1f drops=%u steady=%u\n", lvl, prevLevel, dropCount, steadyCount);

  if (lvl < RAIN_END_CM) { Serial.println("Level back to dry - event cancelled"); state = ST_IDLE; return; }

  if (lvl > prevLevel + DEADBAND_CM)       { dropCount = 0; steadyCount = 0; }   // still rising
  else if (lvl < prevLevel - DEADBAND_CM)  { dropCount++;  steadyCount = 0; }    // falling
  else                                     { steadyCount++; }                    // flat
  if (lvl > peakLevel) peakLevel = lvl;
  prevLevel = lvl;

  if (dropCount >= DROPS_TO_CONFIRM) {
    Serial.println(">>> Rain stopped, drain emptying");
    state = ST_PEAK;
  } else if (steadyCount >= STEADY_LIMIT) {
    // Water is not falling at all: fully blocked drain. Still run RoD so it gets flagged.
    Serial.println(">>> Plateau: water not draining");
    state = ST_PEAK;
  }
}

// STATE 2 -> 3 handover: capture H1 / T1
void statePeak() {
  Reading r = takeReading();
  h1 = r.valid ? r.water : prevLevel;
  t1 = millis();
  Serial.printf(">>> H1=%.1f cm, timer started\n", h1);
  state = ST_ROD;
}

// STATE 3
void stateRod() {
  waitSec(WINDOW_SAMPLE_S);
  Reading r = takeReading();
  if (!r.valid) return;
  sendReading(r);
  uint32_t elapsed = millis() - t1;
  Serial.printf("[ROD] water=%.1f elapsed=%lus\n", r.water, elapsed / 1000);

  if (r.water > h1 + RESTART_RISE_CM) {          // more rain arrived, restart cycle
    Serial.println("Rain resumed - back to RAIN state");
    prevLevel = peakLevel = r.water; dropCount = 0; steadyCount = 0;
    state = ST_RAIN; return;
  }
  h2 = r.water;
  if (elapsed >= ROD_WINDOW_S * 1000UL || r.water <= EMPTY_CM) {
    rodElapsedS = elapsed / 1000.0f;
    state = ST_DECISION;
  }
}

// STATE 4
void stateDecision() {
  float minutes = rodElapsedS / 60.0f;
  float rod = minutes > 0 ? (h1 - h2) / minutes : 0;
  if (rod < 0) rod = 0;

  bool calibrating = calibrateMode || baselineRod <= 0;
  const char* status; float ratio = 0;

  if (calibrating) {
    status = "CALIBRATED";
    baselineRod = rod;
    prefs.putFloat("baseRod", rod);
  } else {
    ratio = rod / baselineRod;
    if (ratio >= CLEAR_RATIO)        status = "CLEAR";
    else if (ratio >= PRECLOG_RATIO) status = "WATCH";
    else                             status = "PRE_CLOG";
  }
  Serial.printf("\n=== RoD = (%.1f - %.1f) / %.2f min = %.2f cm/min | baseline %.2f | %s ===\n\n",
                h1, h2, minutes, rod, baselineRod, status);
  sendRodResult(rod, ratio, status, calibrating);
  calibrateMode = false;

  // Stay in active mode (sending readings) until drain is empty, so we don't re-trigger instantly
  uint32_t start = millis();
  while (millis() - start < COOLDOWN_MAX_S * 1000UL) {
    waitSec(SAMPLE_S);
    Reading r = takeReading();
    if (r.valid) { sendReading(r); if (r.water < RAIN_END_CM) break; }
  }
  state = ST_IDLE;
}

// ======================= ARDUINO =======================
void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);
  prefs.begin("drain", false);
  baselineRod = prefs.getFloat("baseRod", 0);
  delay(500);
  Serial.println("\n== Stormwater Drain Clog Monitor ==");
  Serial.printf("Mode: %s | stored baseline: %.2f cm/min\n", DEMO_MODE ? "DEMO" : "FIELD", baselineRod);
}

void loop() {
#if DEMO_MODE
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'c') { calibrateMode = true; Serial.println("Calibration armed for next event"); }
    if (c == 'r') { baselineRod = 0; prefs.putFloat("baseRod", 0); Serial.println("Baseline cleared - next RoD run will calibrate"); }
    if (c == 's') Serial.printf("State=%s baseline=%.2f calibrate=%d\n", STATE_NAMES[state], baselineRod, calibrateMode);
  }
#endif
  switch (state) {
    case ST_IDLE:     stateIdle();     break;
    case ST_RAIN:     stateRain();     break;
    case ST_PEAK:     statePeak();     break;
    case ST_ROD:      stateRod();      break;
    case ST_DECISION: stateDecision(); break;
  }
}
