#include <Arduino.h>
#include <ArduinoJson.h>
#include <ArduinoOTA.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <LittleFS.h>
#include <SPI.h>
#include <WebSocketsServer.h>
#include <WiFiManager.h>
#include <math.h>
#include "dyno_secrets.h"

namespace {
constexpr uint8_t CS_PIN = D1, DRDY_PIN = D2;
constexpr uint32_t ADC_TIMEOUT_MS = 1000, PORTAL_TIMEOUT_MS = 180000;
constexpr uint8_t AVERAGE_SAMPLES = 20;
// 20 SPS, gain 128, continuous, external REFP0/REFN0, 50/60 Hz rejection.
constexpr uint8_t CONFIG[] = {0x0E, 0x04, 0x50, 0x00};
const SPISettings ADC_SPI(1000000, MSBFIRST, SPI_MODE1);
ESP8266WebServer http(80);
WebSocketsServer socket(81);
WiFiManager wifiManager;
bool adcReady = false, calibrated = false, hasTare = false;
bool fsReady = false, networkReady = false, otaActive = false, portalActive = false;
double tareCounts = 0, countsPerKg = 0;
uint32_t lastSampleMs = 0, sequence = 0, lastStatusMs = 0;
uint32_t portalStartedMs = 0, lastReconnectMs = 0, bootId = 0;
String setupPassword;
char serialBuffer[96];
size_t serialLength = 0;
bool serialOverflow = false;
// Calibration is asynchronous: network and OTA handlers keep running.
enum class Operation { None, Tare, Calibrate };
Operation operation = Operation::None;
int64_t operationSum = 0;
uint8_t operationCount = 0;
double calibrationMass = 0;
int operationClient = -1;
String operationId;

void selectAdc() {
  SPI.beginTransaction(ADC_SPI);
  digitalWrite(CS_PIN, LOW);
  delayMicroseconds(2);
}
void deselectAdc() {
  delayMicroseconds(2);
  digitalWrite(CS_PIN, HIGH);
  SPI.endTransaction();
}
void adcCommand(uint8_t command) {
  selectAdc(); SPI.transfer(command); deselectAdc();
}
bool initializeAdc() {
  adcCommand(0x06); delay(2);
  selectAdc(); SPI.transfer(0x43);
  for (uint8_t value : CONFIG) SPI.transfer(value);
  deselectAdc();
  selectAdc(); SPI.transfer(0x23);
  bool matches = true;
  Serial.print(F("ADS1220 registers:"));
  for (uint8_t expected : CONFIG) {
    uint8_t actual = SPI.transfer(0);
    Serial.printf(" %02X", actual);
    matches &= actual == expected;
  }
  deselectAdc(); Serial.println();
  if (!matches) {
    Serial.println(F("ADC register mismatch: expected 0E 04 50 00. Check wiring; send r."));
    return false;
  }
  adcCommand(0x08); lastSampleMs = millis();
  return true;
}
int32_t readSample() {
  selectAdc(); SPI.transfer(0x10);
  uint32_t value = static_cast<uint32_t>(SPI.transfer(0)) << 16;
  value |= static_cast<uint32_t>(SPI.transfer(0)) << 8;
  value |= SPI.transfer(0);
  deselectAdc(); lastSampleMs = millis();
  return (value & 0x800000UL) ? static_cast<int32_t>(value) - 16777216L : static_cast<int32_t>(value);
}
bool originAllowed(const String &origin) {
  if (origin == "https://ach-dyno.web.app" || origin == "https://ach-dyno.firebaseapp.com" ||
      origin == "http://localhost:5173" || origin == "http://127.0.0.1:5173" ||
      origin == "http://localhost:4173" || origin == "http://127.0.0.1:4173") return true;
  String extra(DYNO_EXTRA_ORIGINS);
  int start = 0;
  while (start < static_cast<int>(extra.length())) {
    int end = extra.indexOf(',', start);
    if (end < 0) end = extra.length();
    String candidate = extra.substring(start, end); candidate.trim();
    if (candidate.length() && origin == candidate) return true;
    start = end + 1;
  }
  return false;
}
String statusJson() {
  JsonDocument doc;
  doc["type"] = "status"; doc["protocol"] = 1;
  doc["bootId"] = bootId; doc["hostname"] = "calf-dyno";
  doc["ip"] = WiFi.localIP().toString(); doc["uptimeMs"] = millis();
  doc["adcReady"] = adcReady; doc["calibrated"] = calibrated;
  doc["hasTare"] = hasTare; doc["busy"] = operation != Operation::None;
  doc["otaActive"] = otaActive; doc["otaEnabled"] = strlen(DYNO_OTA_PASSWORD) > 0;
  doc["sampleRateHz"] = 20; doc["freeHeap"] = ESP.getFreeHeap();
  String output; serializeJson(doc, output); return output;
}
void broadcastStatus() {
  if (networkReady) { String output = statusJson(); socket.broadcastTXT(output); }
}
void reply(int client, const String &id, bool ok, const char *message) {
  Serial.println(message);
  if (client < 0 || !networkReady || !socket.clientIsConnected(client)) return;
  JsonDocument doc; doc["type"] = "ack"; doc["id"] = id;
  doc["ok"] = ok; doc["message"] = message;
  String output; serializeJson(doc, output); socket.sendTXT(client, output);
}
bool saveCalibration() {
  if (!fsReady) return false;
  JsonDocument doc; doc["version"] = 1; doc["tareCounts"] = tareCounts;
  doc["countsPerKg"] = countsPerKg; doc["hasTare"] = hasTare;
  doc["calibrated"] = calibrated;
  File file = LittleFS.open("/calibration.tmp", "w");
  if (!file) return false;
  bool ok = serializeJson(doc, file) > 0; file.close();
  return ok && LittleFS.rename("/calibration.tmp", "/calibration.json");
}
void loadCalibration() {
  if (!fsReady) return;
  File file = LittleFS.open("/calibration.json", "r");
  if (!file) return;
  JsonDocument doc; auto error = deserializeJson(doc, file); file.close();
  if (error || doc["version"] != 1 || !doc["tareCounts"].is<double>() ||
      !doc["countsPerKg"].is<double>()) return;
  double tare = doc["tareCounts"], slope = doc["countsPerKg"];
  if (!isfinite(tare) || fabs(tare) > 8388608 || !isfinite(slope)) return;
  if (doc["calibrated"] == true && fabs(slope) < 0.000001) return;
  tareCounts = tare; countsPerKg = slope;
  hasTare = doc["hasTare"] == true; calibrated = doc["calibrated"] == true && hasTare;
}
void finishOperation(bool ok, const char *message) {
  reply(operationClient, operationId, ok, message);
  operation = Operation::None; operationClient = -1; operationId = "";
  broadcastStatus();
}
void startOperation(Operation next, double mass, int client = -1, String id = "") {
  if (!adcReady || otaActive || operation != Operation::None) {
    reply(client, id, false, "Sensor unavailable or busy."); return;
  }
  if (next == Operation::Calibrate && (!hasTare || !isfinite(mass) || mass <= 0 || mass > 10000)) {
    reply(client, id, false, "Tare first, then specify a positive known mass in kg (up to 10000)."); return;
  }
  operation = next; operationSum = 0; operationCount = 0;
  operationClient = client; operationId = id; calibrationMass = mass;
  adcCommand(0x08); lastSampleMs = millis(); broadcastStatus();
}
void processSample(int32_t sample) {
  ++sequence;
  if (sample >= 8380000L || sample <= -8380000L) {
    if (operation != Operation::None) finishOperation(false, "ADC saturated; calibration cancelled.");
    // Send an explicit fault: never publish a saturated reading as valid force.
    if (networkReady) socket.broadcastTXT("{\"type\":\"error\",\"message\":\"ADC saturated. Check load and bridge wiring.\"}");
    return;
  }
  if (operation != Operation::None) {
    operationSum += sample;
    if (++operationCount == AVERAGE_SAMPLES) {
      double average = static_cast<double>(operationSum) / operationCount;
      if (operation == Operation::Tare) { tareCounts = average; hasTare = true; }
      else {
        double net = average - tareCounts;
        if (fabs(net) < 100) { finishOperation(false, "Calibration signal too small; apply a larger known load."); return; }
        countsPerKg = net / calibrationMass; calibrated = true;
      }
      bool stored = saveCalibration();
      finishOperation(true, stored ? "Sensor updated and saved to flash." : "Sensor updated in RAM only; flash save failed.");
    }
    return;
  }
  double force = calibrated ? (sample - tareCounts) / countsPerKg * 9.80665 : 0;
  if (networkReady && socket.connectedClients() > 0) {
    JsonDocument doc; doc["type"] = "sample"; doc["bootId"] = bootId;
    doc["seq"] = sequence; doc["ms"] = lastSampleMs; doc["raw"] = sample;
    if (calibrated) doc["forceN"] = force; else doc["forceN"] = nullptr;
    String output; serializeJson(doc, output); socket.broadcastTXT(output);
  }
  if (sequence % 5 == 0) {
    Serial.printf("raw=%ld  net=%.1f", static_cast<long>(sample), sample - tareCounts);
    if (calibrated) Serial.printf("  force=%.2f N", force);
    else Serial.print(F("  uncalibrated"));
    Serial.println();
  }
}
void socketEvent(uint8_t client, WStype_t type, uint8_t *payload, size_t length) {
  if (type == WStype_CONNECTED) { String status = statusJson(); socket.sendTXT(client, status); return; }
  if (type == WStype_DISCONNECTED) {
    // Prevent an asynchronous ACK from reaching a different client reusing this slot.
    if (operationClient == client) operationClient = -1;
    return;
  }
  if (type != WStype_TEXT) return;
  JsonDocument doc;
  if (length > 256 || deserializeJson(doc, payload, length)) { reply(client, "", false, "Invalid JSON command."); return; }
  String command = doc["type"] | ""; String id = doc["id"] | "";
  if (id.length() > 48) { reply(client, "", false, "Command ID too long."); return; }
  if (command == "status") { String status = statusJson(); socket.sendTXT(client, status); }
  else if (command == "tare") startOperation(Operation::Tare, 0, client, id);
  else if (command == "calibrate" && doc["massKg"].is<double>()) startOperation(Operation::Calibrate, doc["massKg"], client, id);
  else reply(client, id, false, "Unknown command; use status, tare, or calibrate with massKg.");
}
void stopNetwork() {
  if (!networkReady) return;
  socket.close(); http.stop(); ArduinoOTA.end(); MDNS.close(); networkReady = false;
}
void startPortal() {
  if (otaActive) return;
  if (operation != Operation::None) finishOperation(false, "Operation cancelled for Wi-Fi provisioning.");
  stopNetwork();
  portalActive = true; portalStartedMs = millis();
  Serial.printf("Connect to CalfDyno-Setup, password: %s (3 minute timeout).\n", setupPassword.c_str());
  wifiManager.startConfigPortal("CalfDyno-Setup", setupPassword.c_str());
}
void startNetwork() {
  if (portalActive) { wifiManager.stopConfigPortal(); portalActive = false; }
  // One mDNS initialization; OTA adds its service to the existing responder.
  MDNS.begin("calf-dyno"); MDNS.addService("http", "tcp", 80); MDNS.addService("ws", "tcp", 81);
  socket.begin(); socket.enableHeartbeat(15000, 3000, 2); http.begin();
  networkReady = true;
  if (strlen(DYNO_OTA_PASSWORD)) {
    ArduinoOTA.setHostname("calf-dyno"); ArduinoOTA.setPassword(DYNO_OTA_PASSWORD);
    ArduinoOTA.begin(false);
    // begin(false) doesn't register the service, so add it ourselves.
    MDNS.enableArduino(8266, true);
  } else Serial.println(F("OTA disabled: configure private ota_password and flash over USB to enable."));
  Serial.printf("Ready: http://%s/status | ws://calf-dyno.local:81\n", WiFi.localIP().toString().c_str());
}
void printHelp() {
  Serial.println(F("Commands: t (tare), c 5.0 (known kg), r (retry ADC), h (help), wifi (open setup), wifi-reset CONFIRM (erase credentials), fs-init CONFIRM (format calibration filesystem)."));
}
void serialCommand(char *command) {
  if (!strcmp(command, "h")) printHelp();
  else if (!strcmp(command, "wifi")) startPortal();
  else if (!strcmp(command, "wifi-reset CONFIRM")) { stopNetwork(); wifiManager.resetSettings(); startPortal(); }
  else if (!strcmp(command, "fs-init CONFIRM")) {
    if (otaActive || operation != Operation::None) { Serial.println(F("Sensor busy; try again later.")); return; }
    LittleFS.end();
    fsReady = LittleFS.format() && LittleFS.begin();
    Serial.println(fsReady && saveCalibration() ? F("Calibration filesystem initialized and current calibration saved.") : F("Filesystem initialization failed."));
  }
  else if (!strcmp(command, "t")) startOperation(Operation::Tare, 0);
  else if (!strcmp(command, "r")) {
    if (operation != Operation::None) finishOperation(false, "Operation cancelled for ADC reset.");
    if (!otaActive) { adcReady = initializeAdc(); broadcastStatus(); }
  } else if (command[0] == 'c' && command[1] == ' ') {
    char *end; double mass = strtod(command + 2, &end);
    while (*end == ' ') ++end;
    if (end == command + 2 || *end || !isfinite(mass) || mass <= 0) Serial.println(F("Use c <positive kg>."));
    else startOperation(Operation::Calibrate, mass);
  } else if (*command) Serial.println(F("Unknown command. Send h."));
}
void pollSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r' || c == '\n') {
      serialBuffer[serialLength] = 0;
      if (!serialOverflow) serialCommand(serialBuffer); else Serial.println(F("Command too long."));
      serialLength = 0; serialOverflow = false;
    } else if (serialLength < sizeof(serialBuffer) - 1) serialBuffer[serialLength++] = c;
    else serialOverflow = true;
  }
}
}  // namespace

void setup() {
  Serial.begin(115200); delay(300); bootId = ESP.random();
  digitalWrite(CS_PIN, HIGH); pinMode(CS_PIN, OUTPUT); pinMode(DRDY_PIN, INPUT); SPI.begin();
  // Do not format on mount failure: preserve previously saved calibration.
  LittleFSConfig fsConfig; fsConfig.setAutoFormat(false); LittleFS.setConfig(fsConfig);
  fsReady = LittleFS.begin();
  if (!fsReady) {
    // A brand new filesystem can be initialized deliberately via USB, see README.
    Serial.println(F("LittleFS unavailable; calibration will be RAM-only. See README for initialization."));
  }
  loadCalibration(); adcReady = initializeAdc(); printHelp();
  setupPassword = DYNO_SETUP_PASSWORD;
  if (setupPassword.isEmpty()) {
    char randomPassword[17]; snprintf(randomPassword, sizeof(randomPassword), "%08lx%08lx", static_cast<unsigned long>(ESP.random()), static_cast<unsigned long>(ESP.random()));
    setupPassword = randomPassword;
  }
  http.collectHeaders("Origin", "Access-Control-Request-Headers");
  http.on("/status", []() {
    String origin = http.header("Origin");
    if (origin.length() && !originAllowed(origin)) { http.send(403, "text/plain", "Origin denied"); return; }
    if (origin.length()) { http.sendHeader("Access-Control-Allow-Origin", origin); http.sendHeader("Vary", "Origin"); }
    http.sendHeader("Cache-Control", "no-store");
    if (http.method() == HTTP_OPTIONS) {
      http.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      http.sendHeader("Access-Control-Allow-Private-Network", "true");
      http.send(204); return;
    }
    if (http.method() != HTTP_GET) { http.send(405); return; }
    http.send(200, "application/json", statusJson());
  });
  http.onNotFound([]() { http.send(404, "text/plain", "Use /status"); });
  static const char *mandatory[] = {"Origin"};
  socket.onValidateHttpHeader([](String name, String value) { return !name.equalsIgnoreCase("Origin") || originAllowed(value); }, mandatory, 1);
  socket.onEvent(socketEvent);
  ArduinoOTA.onStart([]() {
    otaActive = true;
    if (operation != Operation::None) finishOperation(false, "Operation cancelled for firmware update.");
    adcCommand(0x02); broadcastStatus(); socket.disconnect(); LittleFS.end();
    Serial.println(F("OTA update started; measurements stopped."));
  });
  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("OTA error %u; restoring acquisition.\n", error);
    otaActive = false; fsReady = LittleFS.begin(); adcReady = initializeAdc(); broadcastStatus();
  });
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true);
  wifiManager.setDebugOutput(false); wifiManager.setConfigPortalBlocking(false);
  wifiManager.setConnectTimeout(15); wifiManager.setBreakAfterConfig(true);
  // Nonblocking WiFiManager ignores its own timeout; loop enforces ours.
  if (WiFi.SSID().length()) { WiFi.begin(); lastReconnectMs = millis(); }
  else startPortal();
}
void loop() {
  pollSerial();
  if (portalActive) {
    wifiManager.process();
    if (!wifiManager.getConfigPortalActive()) {
      portalActive = false; WiFi.mode(WIFI_STA);
    } else if (millis() - portalStartedMs >= PORTAL_TIMEOUT_MS) {
      wifiManager.stopConfigPortal(); portalActive = false; WiFi.mode(WIFI_STA);
      Serial.println(F("Setup timed out; send wifi over USB to reopen. Saved credentials retained."));
    }
  }
  if (!portalActive && WiFi.status() == WL_CONNECTED) {
    if (!networkReady) startNetwork();
    http.handleClient(); socket.loop(); MDNS.update();
    if (strlen(DYNO_OTA_PASSWORD)) ArduinoOTA.handle();
    if (millis() - lastStatusMs >= 2000) { lastStatusMs = millis(); broadcastStatus(); }
  } else {
    stopNetwork();
    if (!portalActive && WiFi.SSID().length() && millis() - lastReconnectMs >= 15000) {
      lastReconnectMs = millis(); WiFi.reconnect();
    }
  }
  if (!otaActive && adcReady) {
    if (digitalRead(DRDY_PIN) == LOW) processSample(readSample());
    else if (millis() - lastSampleMs >= ADC_TIMEOUT_MS) {
      adcReady = false;
      if (operation != Operation::None) finishOperation(false, "DRDY timeout. Check wiring and send r over USB.");
      Serial.println(F("ADC timeout. Check D2/DRDY, CLK to GND, and power; send r.")); broadcastStatus();
    }
  }
  delay(1);
}
