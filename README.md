# Calf Dyno

An ESP8266 D1 Mini + ADS1220 calf dynamometer with a SvelteKit/TypeScript dashboard, local WebSocket acquisition, Google sign-in, and per-user Firestore history. Firebase project: **ach-dyno**.

## What is implemented

- ADS1220 acquisition at 20 SPS, signed force in newtons, nonblocking tare and known-mass calibration, persisted calibration in LittleFS.
- Password-protected WiFiManager provisioning, a three-minute portal timeout, saved-credential reconnection, and deliberate USB provisioning/reset commands.
- `calf-dyno.local`, WebSocket port 81, HTTP `/status` on port 80, mandatory exact WebSocket Origin validation, and authenticated ArduinoOTA.
- Responsive dashboard with live readings and force chart, leg/exercise labels, start/stop, peak, duration, raw CSV, and paginated history with recent left/right peak comparisons.
- Browser-local run journal, interrupted-run recovery, explicit account saves with stable UUID retries, per-account rules, and a demo simulator whose samples cannot be uploaded.
- `/connectivity` diagnostic page for the HTTPS-to-LAN Chrome compatibility test.

## Wiring

| D1 Mini | ADS1220 / bridge |
| --- | --- |
| 3V3 | DVDD, AVDD, REFP0, cell E+ |
| GND | DGND, AGND, CLK, REFN0, cell E− |
| D1 (GPIO5) | CS |
| D2 (GPIO4) | Dedicated DRDY |
| D5 (GPIO14) | SCLK |
| D6 (GPIO12) | DOUT/MISO |
| D7 (GPIO13) | DIN/MOSI |

Cell S+ connects to AIN0, S− to AIN1. AIN2/AIN3 are unused. CLK grounded selects the internal oscillator. Use a shared ground and 3.3 V logic.

The existing bench configuration is preserved: SPI mode 1 at 1 MHz, gain 128 with PGA enabled, 20 SPS continuous conversion, external REFP0/REFN0 reference, simultaneous 50/60 Hz rejection. Register readback is `0E 04 50 00`. See the [TI ADS1220 datasheet](https://www.ti.com/lit/ds/symlink/ads1220.pdf).

## Firmware setup

Install PlatformIO. Its VS Code extension includes the `pio` CLI. On this Mac it is available at `/Users/suzanna/.platformio/penv/bin/pio` if not on PATH.

1. Copy `platformio.private.ini.example` to `platformio.private.ini`. Set your own OTA password. Optionally set an 8–63 character setup AP password. The real file and generated headers are git-ignored. You can instead supply `DYNO_OTA_PASSWORD`, `DYNO_SETUP_PASSWORD`, and `DYNO_EXTRA_ORIGINS` environment variables.
2. Build and flash the initial firmware using USB:

   ```sh
   pio run -e d1_mini
   pio run -e d1_mini -t upload
   pio device monitor -e d1_mini
   ```

3. On first boot, connect your phone/computer to **CalfDyno-Setup**. If you did not configure an AP password, firmware generates a random password and prints it over USB. Open the captive portal or `http://192.168.4.1`, select your Wi-Fi network, and enter its password.
4. The portal closes after a successful configuration or three minutes. Send `wifi` over USB to reopen it, including when already connected. Stored Wi-Fi credentials are retained through ordinary outages and timeout. Send `wifi-reset CONFIRM` to deliberately erase them and reopen setup.
5. A brand-new device may report that LittleFS is unavailable. Send `fs-init CONFIRM` once over USB to initialize the calibration filesystem. Firmware does **not** automatically format a filesystem that fails to mount. Until initialized, calibration works in RAM and reports that it could not be saved to flash.
6. Unload the sensor in its fixture and send `t` (or use **Zero sensor** in the dashboard). Hold still for about one second while 20 readings are averaged. Apply a known mass and send `c 5.0`, replacing 5.0 with your mass in kg (or use the dashboard calibration controls). The applied force must follow the sensor axis; account for any lever/pulley ratio.

Calibration accepts either bridge polarity, rejects saturation and tiny signals, and preserves the slope when taring again. Loaded readings are positive in the calibrated direction; opposite loads are negative. Calibration survives resets once the filesystem is initialized. Re-tare with the fixture unloaded before a session.

Serial commands at **115200 baud**, followed by Enter:

| Command | Action |
| --- | --- |
| `h` | Show help |
| `t` | Tare unloaded cell |
| `c 5.0` | Calibrate using a known 5 kg mass |
| `r` | Retry ADC initialization after fixing wiring |
| `wifi` | Temporarily reopen Wi-Fi provisioning |
| `wifi-reset CONFIRM` | Erase saved Wi-Fi credentials and reopen provisioning |
| `fs-init CONFIRM` | Format the calibration filesystem and save current calibration |

### OTA

Both USB and OTA environments build the same firmware. OTA is disabled when no private password is configured. To enable it initially, configure the password and flash over USB. Then:

```sh
pio run -e d1_mini_ota -t upload
# mDNS fallback:
pio run -e d1_mini_ota -t upload --upload-port 192.168.1.42
```

The build script supplies the same password to firmware and espota. The hostname is `calf-dyno`; mDNS is initialized once and shared with OTA. Acquisition stops on update start; a successful update reboots automatically. If the upload fails, acquisition is reinitialized. USB flashing remains the recovery path. Use OTA only on your trusted LAN; do not forward device ports to the internet. Changing the OTA password requires uploading with the **old** password (or flashing once over USB with the new configuration).

## Dashboard development

Use **Node.js 24.12 or later** and npm:

```sh
cd web
npm ci
npm run dev
```

Open `http://localhost:5173`. Click **Try demo** to test charting, recording, history recovery, and CSV without hardware or sign-in. Click **Use device** to return to real acquisition, then **Connect device**. Supply `calf-dyno.local` or a private IPv4 address. Connect is always initiated by the user; dropped connections retry with bounded exponential delays.

Firebase web configuration is exported from `web/config.ts`; it identifies the Firebase project and is not an OTA/Wi-Fi secret. Browser-only Firebase initialization happens after mounting. The app is a client-rendered SvelteKit SPA using the static adapter; production output is `web/build`.

### Run workflow and recovery

1. Connect, calibrate if needed, and zero the unloaded sensor.
2. Select a leg/exercise and start recording.
3. Stop to review the trace, then export CSV or click **Save** after signing in.
4. Select a history row to inspect its raw trace. History loads 50 runs at a time; use **Load earlier runs** for more.

Every completed run is written to IndexedDB **before** any cloud save. Recording checkpoints commit about once per second. A browser crash/power loss recovers the last committed checkpoint; the newest approximately one second may not have committed. Normal stop, connection loss, sample gap, restart, sensor fault, calibration change, account change, or backgrounding the page finalize the samples already received. No missing samples are invented or interpolated in stored data.

Recordings stop at **6,000 samples or five minutes**, whichever comes first. At the default 20 Hz this is about five minutes. This cap, compact cloud maps, and an index exemption keep normal documents comfortably below Firestore's 1 MiB limit. The observed sample rate is computed from device timestamps. Millisecond and sequence wraparound are supported. Chart display decimation preserves peaks and does not reduce stored samples.

Unsaved signed-in runs belong to that account. Anonymous runs can be explicitly saved after signing in; ownership is assigned locally before the cloud attempt. A retry uses the same run UUID and data, preventing duplicate documents. Network/rule failures leave the local run and its CSV available. Demo data remains local. Clearing browser site data removes local backups; successful cloud saves remain in your account. Run recording is disabled if local backup storage is unavailable.

## Firebase setup and deployment

In the [Firebase console for ach-dyno](https://console.firebase.google.com/project/ach-dyno/overview):

1. Enable **Authentication → Google** and choose a support email.
2. Authorize `ach-dyno.web.app`, `ach-dyno.firebaseapp.com`, and `localhost` for local sign-in. New Firebase projects may require adding localhost explicitly. For custom domains, authorize those too.
3. Create a **Cloud Firestore** database on the Spark plan if one does not exist. Deploy the included rules before using cloud saves.
4. Log in to Firebase CLI and deploy from the repository root:

   ```sh
   firebase login
   firebase deploy --only firestore,hosting --project ach-dyno
   ```

The Hosting predeploy hook checks and builds the dashboard. Hosting serves `web/build`, rewrites SPA routes to `index.html`, and caches hashed assets. `/users/{uid}/runs/{runId}` is accessible only to its owner. Completed cloud documents are immutable; identical retries and owner deletes are allowed. Samples are excluded from indexing.

Cloud sample representation differs slightly from the design because [Firestore Standard edition does not support an array containing another array](https://firebase.google.com/docs/firestore/manage-data/data-types):

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-10-08T15:30:00.000Z",
  "leg": "left",
  "exercise": "seated_plantarflexion",
  "durationMs": 50,
  "sampleRateHz": 20,
  "peakForceN": 15,
  "source": "device",
  "stopReason": "Stopped by user",
  "samples": [{ "t": 0, "f": 0 }, { "t": 50, "f": 15 }]
}
```

Local samples and CSV use elapsed milliseconds and newtons, preserving the original `[time, force]` semantics. Rules enforce ownership, field/schema bounds, sample count, and endpoint sample shapes. Firestore Rules cannot loop over every list item; the client validates every sample when saving/loading. The rules do not certify sensor accuracy or clinical validity.

### HTTPS and Chrome connectivity acceptance

Visit `https://ach-dyno.web.app/connectivity` after deployment and test **both desktop Chrome and Android Chrome with the real device**. Verify HTTP status, WebSocket connection, incoming samples, hostname/IP fallback, and reconnect after power interruption.

[Chrome Local Network Access documentation](https://developer.chrome.com/blog/local-network-access) describes permission-gated local HTTP access and mixed-content exemptions, but still lists WebSockets as an integration limitation. Support is browser/version-dependent: a successful HTTP permission probe does **not** prove that an HTTPS page can open `ws://`. The Connect flow probes `/status` to request permission, then attempts the socket and surfaces connection diagnostics. It does not disable browser security or add a separate cloud relay. If your Chrome version blocks the socket, use the local development dashboard for acquisition until a compatible version is available.

Firmware allows exact origins `https://ach-dyno.web.app`, `https://ach-dyno.firebaseapp.com`, and localhost/127.0.0.1 on ports 5173/4173. Missing Origin, `null`, and other sites are rejected at the handshake. Firebase preview-channel/custom-domain origins and local LAN development origins must be added as comma-separated `extra_origins` in `platformio.private.ini`, then firmware must be rebuilt/flashed. This check protects browser access; it is not authentication against native software on your trusted LAN.

## Protocol

Server pushes JSON text frames:

```json
{"type":"sample","bootId":123,"seq":42,"ms":2100,"raw":125000,"forceN":15.25}
```

`ms` is device uptime (uint32), not wall-clock time; `bootId` changes on reboot. `seq` counts ADC samples. `forceN` is `null` before calibration. Status frames arrive on connect and approximately every two seconds and include `protocol: 1`, ADC/calibration/busy/OTA state, IP, and nominal sample rate. Saturation sends an error instead of a valid sample.

Client commands: `{"type":"status"}`, `{"type":"tare","id":"uuid"}`, or `{"type":"calibrate","id":"uuid","massKg":5}`. Calibration/tare responses are `{"type":"ack","id":"uuid","ok":true,"message":"..."}` after averaging. Operations broadcast busy status to all connected dashboards so another browser's calibration cannot silently alter an ongoing run.

## Validation

```sh
pio run -e d1_mini -e d1_mini_ota
cd web
npm run check
npm test
npm run build
npm run test:e2e
cd ..
firebase emulators:exec --project demo-calf-dyno --only firestore 'npm --prefix web run test:rules'
```

The rule tests require Java 21+ and use a `demo-` emulator project, never production. On this Mac, Android Studio's Java runtime is available at `/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin`.

Playwright tests cover desktop/mobile demo recording, CSV, reload recovery, interrupted recording recovery, connection input validation, and simulated device tare/disconnect/reconnection. The config uses installed macOS Google Chrome; on another machine set the executable path or use Playwright's Chromium. Browser layout simulation is not a substitute for physical Android/ESP8266 compatibility testing.

## Hardware troubleshooting

- Wrong register readback: check power, shared ground, CS, SCLK, DIN/MOSI, DOUT/MISO. Expected `0E 04 50 00`.
- DRDY timeout: check dedicated DRDY → D2 and CLK → GND. Fix wiring, then send `r`.
- Saturation: check bridge/reference wiring and applied load. At gain 128 and 3.3 V reference, the differential range is about ±25.8 mV.
- Tiny calibration signal: check bridge leads and mechanical loading; calibration rejects changes below 100 counts.
- Wi-Fi unavailable: firmware retries saved credentials every 15 seconds without erasing them. Send `wifi` to reconfigure deliberately.
- Cloud save denied: check Google authentication and deploy `firestore.rules`. Local run remains available for retry/export.

Physical sensor calibration, real provisioning/reconnection, an authenticated wireless update, production Google sign-in/cloud saves, and HTTPS-to-LAN connectivity on desktop and Android must be verified on the actual hardware/accounts. The implementation and automated checks can be validated locally without flashing or deploying.
