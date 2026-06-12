# esp32-web-interface

**A modern web interface for [OpenInverter](https://openinverter.org) systems — over UART or CAN bus.**

[![Build combined images](https://github.com/wjcloudy/esp32-web-interface/actions/workflows/build.yml/badge.svg?branch=uart-backend)](https://github.com/wjcloudy/esp32-web-interface/actions/workflows/build.yml)
[![Latest release](https://img.shields.io/github/v/release/wjcloudy/esp32-web-interface)](https://github.com/wjcloudy/esp32-web-interface/releases/latest)

<img width="1325" height="813" alt="Dashboard" src="https://github.com/user-attachments/assets/c89a4b9f-ab54-4fa1-a785-3fb7d5112a4c" />
<img width="1320" height="813" alt="Gauges" src="https://github.com/user-attachments/assets/d164b16f-ed82-48d3-8701-dd83529628c9" />

Works with the OpenInverter family of firmware:
[stm32-sine / FOC](https://github.com/jsphuebner/stm32-sine) ·
[ZombieVerter VCU](https://github.com/damienmaguire/Stm32-vcu) ·
[stm32-charger](https://github.com/jsphuebner/stm32-charger) ·
[stm32-island](https://github.com/jsphuebner/stm32-island) ·
[BMS](https://github.com/jsphuebner/bms-software) · and more.

---

## Highlights

**Modern single-page UI** (Preact + HTM, no build step)
- Dark-first glass design with full light mode and a customisable accent colour
- Dashboard hero card: live state pill, error chips, battery voltage & temperature with sparklines
- Installable to your phone's home screen (PWA manifest, iOS standalone)

**Two inverter transports**
- **UART** — the classic serial connection, with fast-mode streaming and pin-swap setting
- **CAN bus** — full SDO support: device scanning, multi-node management with a boot-default node, parameter database download, live values, error log, and **firmware updates over CAN**

**Telemetry**
- **Gauges** — radial and line gauges in four sizes, per-gauge colours (hue-matched gradients), enum fields show their mode text, drag-to-reorder layout
- **Plot** — multi-chart plotting with left/right axes and burst sampling (UART)
- **Spot Values** — searchable table with favourites, ~10 Hz fast mode, and optional per-row sparklines
- **Data Logger** — log any fields to a downloadable file

**Configuration**
- **Parameters** — searchable, categorised, favourites, inline editing, flash save/restore, file download/upload, and openinverter.org parameter-database submit/subscribe
- **CAN Mapping** — view, add and remove the device's TX/RX CAN mappings (decimal or `0x` hex IDs)
- **Settings export/import** — favourites, gauge & plot layouts and UI preferences as a single JSON file

**Updates**
- OpenInverter board firmware updates over **UART or CAN** with live progress (CAN requires the [CAN bootloader](https://github.com/jsphuebner/stm32-CANBootloader) on the device)
- Web interface OTA updates for the ESP32 firmware and individual files

---

## Getting started

### 1. Get an image
Pre-built **flash-at-`0x0` combined images** for both supported boards:

| Source | What you get |
|---|---|
| [Latest release](https://github.com/wjcloudy/esp32-web-interface/releases/latest) | Version-stamped raw `.bin` files (e.g. `esp32-web-interface_v4.1-0x000.bin`) |
| [CI builds](https://github.com/wjcloudy/esp32-web-interface/actions/workflows/build.yml?query=branch%3Auart-backend) | Every push, as run artifacts (zipped) |
| This repo | Current-build copies: `esp32-web-interface-0x000.bin`, `esp32-web-interface-t2can-0x000.bin` |

### 2. Flash it
Flash the image at offset `0x0` with [ESP Web Tools](https://espressif.github.io/esptool-js/) or `esptool.py`:

```sh
esptool.py --chip esp32   write_flash 0x0 esp32-web-interface-0x000.bin        # classic ESP32
esptool.py --chip esp32s3 write_flash 0x0 esp32-web-interface-t2can-0x000.bin  # LILYGO T-2Can
```

### 3. Connect
- Join the board's WiFi access point (default name `ESP-xxxxx`) and browse to http://192.168.4.1/, **or**
- configure it to join your network (Settings → WiFi) and browse to http://inverter.local/ (mDNS).

### 4. Pick a transport
In **Settings → Interface**: choose **UART** (default) or **CAN Bus** → Save → Scan for devices. The first node found becomes the boot default; mark any other node as default from the device list.

---

## Hardware

| Board | Notes |
|---|---|
| ESP32-WROOM-32E (and most dev boards) | UART to the inverter on pin 16 (RX ← inverter TX) and pin 17 (TX → inverter RX) |
| LILYGO T-2Can (ESP32-S3) | Built-in CAN transceiver — default CAN pins RX 6 / TX 7 (`release-t2can` build target) |

Optional peripherals (classic ESP32):
- **SD card** in SDIO mode for data logging — CLK pin 14, CMD pin 15, D0 pin 2, D1 pin 4, D2 pin 12, D3 pin 13
- **RTC** (PCF8523 as standard, anything RTClib supports with a sketch change) — SCL pin 22, SDA pin 21

CAN speed (125k/250k/500k) and pins are configurable in Settings on any board.

---

## Flashing & upgrading

### Wirelessly (OTA)
Use the **Update** tab in the web interface, or the PlatformIO `upload` / `uploadfs` targets with `upload_protocol = espota` in `platformio-local-override.ini`.

### Wired
For a new or fully-erased board, connect a 3.3V USB/serial adapter:

| Pin# | ESP32 board function | USB/serial adapter |
|---|---|---|
| 1 | +3.3V input | 3.3V output (if available) |
| 2 | GND | GND |
| 3 | RXD input | TXD output |
| 4 | TXD output | RXD input |

Various openinverter boards (SDU, LDU, Leaf) use a different wiring scheme for initial programming. **Flash the ESP32 before the STM32** — otherwise the UART pins collide. If the STM32 is already flashed, erase it or hold it in reset while flashing the ESP32.

| Pin# | ESP32 board function | USB/serial adapter |
|---|---|---|
| 1 | TXD output | RXD input |
| 2 | RXD input | TXD output |
| 3 | +5V input | 5V output (if available) |
| 4 | GND | GND |
| 5 | GND | GND |
| 6 | GPIO0 | Connect to GND (pin 5) for programming mode, then power up |

Flash subsequent updates via OTA.

### Updating the inverter itself
The **Update** tab flashes OpenInverter board firmware (`stm32_*.bin`) through the ESP32:
- **UART mode** — works with the standard OpenInverter bootloader
- **CAN mode** — the transfer runs gap-free in the background with live progress; the device must run the [CAN bootloader](https://github.com/jsphuebner/stm32-CANBootloader). A power-cycle prompt allows recovery of a board whose application no longer boots.

---

## Development

Built with the Arduino framework. Versioning comes from git tags (`git describe`) and is shown in the UI and `/version`.

- **PlatformIO (recommended)** — [setup](doc/PLATFORMIO_setup.md) · [day-to-day usage](doc/PLATFORMIO_usage.md) · [flashing walkthrough (VS Code)](doc/PLATFORMIO_flashing_esp32.md) · [building a combined binary](doc/PLATFORMIO_usage.md#building-a-combined-binary-for-web-flasher)
- **Arduino IDE** — [setup](doc/ARDUINO_IDE_setup.md) · [usage](doc/ARDUINO_IDE_usage.md)
- **CI** — every push builds both targets and publishes combined images ([workflow](.github/workflows/build.yml)); pushing a `v*` tag creates a release with version-stamped binaries

Build targets: `release` / `debug` (classic ESP32), `release-t2can` / `debug-t2can` (LILYGO T-2Can, ESP32-S3).

Web UI sources live in [`data/`](data/) — plain Preact + HTM with no build step; gzip the changed files and upload via `uploadfs` or the Update tab.

---

## Documentation

- [Web interface ↔ inverter protocol](PROTOCOL.md)

## Credits

This is a fork of [jsphuebner/esp32-web-interface](https://github.com/jsphuebner/esp32-web-interface) (itself the ESP32 port of the original esp8266 interface) with a rewritten frontend and a CAN bus backend. Thanks to Johannes Huebner and the [OpenInverter community](https://openinverter.org/forum/).
