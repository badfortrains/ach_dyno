#include <Arduino.h>
#include <SPI.h>
#include <math.h>
#include <stdlib.h>

namespace {
constexpr uint8_t CS_PIN = D1;    // GPIO5
constexpr uint8_t DRDY_PIN = D2;  // GPIO4, dedicated DRDY
constexpr double ADC_GAIN = 128.0;
constexpr double REFERENCE_VOLTS = 3.3;  // Approximate mV display only.
constexpr uint32_t READY_TIMEOUT_MS = 1000;
constexpr uint8_t AVERAGE_SAMPLES = 20;
// AIN0 - AIN1, gain 128, PGA enabled; 20 SPS normal, continuous;
// external REFP0/REFN0, simultaneous 50/60 Hz rejection; IDACs off.
constexpr uint8_t CONFIG[] = {0x0E, 0x04, 0x50, 0x00};
const SPISettings ADC_SPI(1000000, MSBFIRST, SPI_MODE1);
bool adcReady = false;
bool hasTare = false;
bool calibrated = false;
double tareCounts = 0;
double countsPerKg = 0;
int64_t displaySum = 0;
uint8_t displayCount = 0;
uint32_t lastSampleMs = 0;
char commandBuffer[48];
size_t commandLength = 0;
bool commandOverflow = false;

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
void sendCommand(uint8_t command) {
  selectAdc();
  SPI.transfer(command);
  deselectAdc();
}
bool initializeAdc() {
  sendCommand(0x06);  // RESET
  delay(2);
  selectAdc();
  SPI.transfer(0x43);  // WREG: four registers starting at address 0
  for (uint8_t value : CONFIG) SPI.transfer(value);
  deselectAdc();
  uint8_t actual[4];
  selectAdc();
  SPI.transfer(0x23);  // RREG: four registers starting at address 0
  for (uint8_t &value : actual) value = SPI.transfer(0x00);
  deselectAdc();
  bool matches = true;
  Serial.print(F("ADS1220 registers:"));
  for (size_t i = 0; i < sizeof(CONFIG); ++i) {
    Serial.printf(" %02X", actual[i]);
    matches = matches && actual[i] == CONFIG[i];
  }
  Serial.println();
  if (!matches) {
    Serial.println(F("ERROR: expected 0E 04 50 00. Check power, CS and SPI wiring; send r to retry."));
    return false;
  }
  sendCommand(0x08);  // START/SYNC
  lastSampleMs = millis();
  return true;
}
int32_t readSample() {
  selectAdc();
  SPI.transfer(0x10);  // RDATA
  uint32_t value = static_cast<uint32_t>(SPI.transfer(0x00)) << 16;
  value |= static_cast<uint32_t>(SPI.transfer(0x00)) << 8;
  value |= SPI.transfer(0x00);
  deselectAdc();
  lastSampleMs = millis();
  // Decode signed 24-bit two's complement without relying on signed shifts.
  return (value & 0x800000UL) ? static_cast<int32_t>(value) - 16777216L
                             : static_cast<int32_t>(value);
}
bool isSaturated(int32_t sample) {
  return sample >= 8380000L || sample <= -8380000L;
}
void clearDisplayAverage() {
  displaySum = 0;
  displayCount = 0;
}
bool averageReading(double &result) {
  clearDisplayAverage();
  // Restart to collect fresh samples of the load present at command time.
  sendCommand(0x08);
  int64_t sum = 0;
  for (uint8_t i = 0; i < AVERAGE_SAMPLES; ++i) {
    const uint32_t started = millis();
    while (digitalRead(DRDY_PIN) == HIGH) {
      if (millis() - started >= READY_TIMEOUT_MS) {
        Serial.println(F("ERROR: DRDY timeout. Check D2/DRDY, CLK to GND and ADC power; send r to retry."));
        adcReady = false;
        return false;
      }
      delay(1);  // Feed ESP8266 watchdog.
    }
    const int32_t sample = readSample();
    if (isSaturated(sample)) {
      Serial.println(F("ERROR: ADC near full scale. Check bridge/reference wiring and load; operation cancelled."));
      return false;
    }
    sum += sample;
  }
  result = static_cast<double>(sum) / AVERAGE_SAMPLES;
  return true;
}
void printHelp() {
  Serial.println(F("Commands (press Enter):"));
  Serial.println(F("  t       Tare with cell unloaded; hold still for about 1 second."));
  Serial.println(F("  c 5.0   Calibrate with a known 5.0 kg load (replace with your mass)."));
  Serial.println(F("  r       Reinitialize ADC; retain this session's tare/calibration."));
  Serial.println(F("  h       Show help."));
  Serial.println(F("Tare and calibration are held in RAM; repeat after reset/power-off."));
}
void handleCommand(char *command) {
  while (*command == ' ') ++command;
  if (*command == '\0') return;
  if (strcmp(command, "h") == 0) {
    printHelp();
  } else if (strcmp(command, "r") == 0) {
    clearDisplayAverage();
    adcReady = initializeAdc();
  } else if (!adcReady) {
    Serial.println(F("ADC unavailable. Check wiring and send r to retry."));
  } else if (strcmp(command, "t") == 0) {
    double reading;
    if (averageReading(reading)) {
      tareCounts = reading;
      hasTare = true;
      Serial.printf("Tare set: %.1f counts\n", tareCounts);
    }
  } else if (command[0] == 'c' && command[1] == ' ') {
    char *end;
    const double massKg = strtod(command + 2, &end);
    const bool parsed = end != command + 2;
    while (*end == ' ') ++end;
    if (!parsed || *end != '\0' || !isfinite(massKg) || massKg <= 0) {
      Serial.println(F("Use c followed by a positive mass in kg, e.g. c 5.0"));
      return;
    }
    if (!hasTare) {
      Serial.println(F("First unload and send t, then apply a known load and send c <kg>."));
      return;
    }
    double reading;
    if (averageReading(reading)) {
      const double netCounts = reading - tareCounts;
      if (fabs(netCounts) < 100.0) {
        Serial.println(F("ERROR: calibration signal too small. Apply a larger known load and check wiring."));
        return;
      }
      countsPerKg = netCounts / massKg;  // Signed: either cell polarity works.
      calibrated = true;
      Serial.printf("Calibration set: %.3f counts/kg\n", countsPerKg);
    }
  } else {
    Serial.println(F("Unknown command. Send h for help."));
  }
}
void pollSerial() {
  while (Serial.available()) {
    const char character = static_cast<char>(Serial.read());
    if (character == '\r' || character == '\n') {
      commandBuffer[commandLength] = '\0';
      if (commandOverflow) Serial.println(F("Command too long; ignored."));
      else handleCommand(commandBuffer);
      commandLength = 0;
      commandOverflow = false;
    } else if (commandLength < sizeof(commandBuffer) - 1) {
      commandBuffer[commandLength++] = character;
    } else {
      commandOverflow = true;
    }
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  digitalWrite(CS_PIN, HIGH);
  pinMode(CS_PIN, OUTPUT);
  pinMode(DRDY_PIN, INPUT);
  SPI.begin();  // Hardware SPI: D5 SCLK, D6 MISO, D7 MOSI.
  Serial.println(F("\nADS1220 load cell test: gain 128, 20 SPS, external reference."));
  printHelp();
  adcReady = initializeAdc();
}
void loop() {
  pollSerial();
  if (adcReady && digitalRead(DRDY_PIN) == LOW) {
    const int32_t sample = readSample();
    if (isSaturated(sample)) {
      clearDisplayAverage();
      Serial.println(F("WARNING: ADC near full scale; check load, bridge and reference wiring."));
    } else {
      displaySum += sample;
      if (++displayCount == 5) {  // Display a five-sample mean about four times/s.
        const double raw = static_cast<double>(displaySum) / displayCount;
        const double net = raw - tareCounts;
        const double mV = raw * REFERENCE_VOLTS * 1000.0 / (ADC_GAIN * 8388608.0);
        Serial.printf("raw=%.1f  net=%.1f  input=%.5f mV", raw, net, mV);
        if (calibrated) {
          const double kg = net / countsPerKg;
          Serial.printf("  load=%.3f kg  force=%.2f N", kg, kg * 9.80665);
        } else {
          Serial.print(F("  load=uncalibrated"));
        }
        Serial.println();
        clearDisplayAverage();
      }
    }
  } else if (adcReady && millis() - lastSampleMs >= READY_TIMEOUT_MS) {
    Serial.println(F("ERROR: no conversions. Check D2/DRDY, CLK to GND and power; send r to retry."));
    adcReady = false;
    clearDisplayAverage();
  }
  delay(1);
}
