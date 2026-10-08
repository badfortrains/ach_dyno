# ADS1220 load cell bench test

Firmware for an ESP8266 D1 Mini and an ADS1220 with a four-wire bridge load cell.
No extra Arduino libraries are required.

## Wiring

| D1 Mini | ADS1220 |
| --- | --- |
| 3V3 | DVDD, AVDD, REFP0, load cell E+ |
| GND | DGND, AGND, CLK, REFN0, load cell E- |
| D1 (GPIO5) | CS |
| D2 (GPIO4) | DRDY (dedicated pin) |
| D5 (GPIO14) | SCLK |
| D6 (GPIO12) | DOUT/MISO |
| D7 (GPIO13) | DIN/MOSI |

Connect cell S+ to AIN0 and S- to AIN1. AIN2 and AIN3 are unused.
CLK grounded selects the internal oscillator.

The firmware uses SPI mode 1 at 1 MHz, gain 128 with the PGA enabled,
20 samples/second in continuous mode, and the external REFP0/REFN0 reference.
It enables simultaneous 50/60 Hz rejection. Register readback should be
`0E 04 50 00`. See the [TI ADS1220 datasheet](https://www.ti.com/lit/ds/symlink/ads1220.pdf).

## Build and run

Use PlatformIO's Build, Upload, and Serial Monitor buttons, or:

```sh
pio run
pio run --target upload
pio device monitor
```

The monitor runs at **115200 baud**. Commands are sent when you press Enter.
If the startup message has already passed, send `h` for help or `r` to check
the registers again.

1. Unload the cell in its measurement fixture. Send `t` and hold it still
   while 20 readings are averaged (about one second).
2. Apply a known mass in the direction you intend to measure. Once it is
   stable, send `c 5.0` for a 5 kg mass, substituting your actual mass.
   The mass must produce a force directly along the cell's measurement axis;
   account for any lever or pulley ratio in the fixture.
3. Remove or vary the load. Read `load` in kg equivalent and `force` in newtons.
   Positive readings follow the direction used for calibration; the opposite
   direction produces negative readings.

Example output format (illustrative):

```text
raw=130000.0  net=120000.0  input=0.39954 mV  load=5.000 kg  force=49.03 N
```

Readings appear about four times/second, averaging five ADC samples each.
Before calibration, raw counts and approximate differential input mV still
show whether the cell responds. The mV display assumes a 3.3 V reference;
weight calibration uses counts and does not depend on that assumption.

Send `t` again to zero the cell; the calibration slope is retained. Send `r`
to reset/configure the ADC after correcting wiring. Tare and calibration are
stored only in RAM and must be repeated after power-off or ESP8266 reset.

## Troubleshooting

- Wrong register readback: check ADC power, shared ground, CS, SCLK, DIN/MOSI,
  and DOUT/MISO. Expected values are `0E 04 50 00`.
- DRDY timeout: check the dedicated DRDY-to-D2 connection and CLK-to-ground.
  After fixing wiring, send `r`.
- Full-scale warning: check the signal and reference wiring. The ADC input
  range at gain 128 with a 3.3 V reference is approximately +/-25.8 mV.
- Tiny/no load response: check the bridge leads and mechanical loading.
  Calibration rejects changes smaller than 100 ADC counts.

This is a static load-cell test. It does not yet measure speed, torque, or
power for a complete dynamometer.
