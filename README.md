<p align="center">
  <img src="data/icon-512.png" width="96" alt="">
</p>

<h1 align="center">OpenInverter ESP32 web interface</h1>

<h3 align="center">Your inverter or VCU, in a browser - over Wi-Fi, by UART or CAN bus.</h3>

<p align="center">
  A small ESP32 board that plugs into an <a href="https://openinverter.org">OpenInverter</a> system and serves a modern web app:<br>
  live gauges and plots, every parameter, CAN mappings and firmware updates, from a laptop or a phone in the car.
</p>

<p align="center">
  <a href="https://github.com/wjcloudy/esp32-web-interface/releases/latest"><img src="https://img.shields.io/github/v/release/wjcloudy/esp32-web-interface?label=release&color=5b9dff" alt="Latest release"></a>
  <a href="https://github.com/wjcloudy/esp32-web-interface/actions/workflows/tests.yml"><img src="https://github.com/wjcloudy/esp32-web-interface/actions/workflows/tests.yml/badge.svg?branch=main" alt="Tests"></a>
  <a href="https://github.com/wjcloudy/esp32-web-interface/actions/workflows/build.yml"><img src="https://github.com/wjcloudy/esp32-web-interface/actions/workflows/build.yml/badge.svg?branch=main" alt="Build combined images"></a>
  <a href="https://wjcloudy.github.io/esp32-web-interface/"><img src="https://img.shields.io/badge/live_demo-try_it-ffcf54" alt="Live demo"></a>
  <img src="https://img.shields.io/badge/ESP32_%7C_ESP32--S3-supported-30ba78" alt="ESP32 and ESP32-S3">
  <a href="#licence"><img src="https://img.shields.io/badge/licence-GPL--3.0-30ba78" alt="GPL-3.0 licence"></a>
</p>

<p align="center">
  <a href="https://wjcloudy.github.io/esp32-web-interface/"><b>Live demo</b></a> &nbsp;·&nbsp;
  <a href="#quick-start"><b>Quick start</b></a> &nbsp;·&nbsp;
  <a href="#features"><b>Features</b></a> &nbsp;·&nbsp;
  <a href="#hardware"><b>Hardware</b></a> &nbsp;·&nbsp;
  <a href="PROTOCOL.md"><b>Protocol</b></a> &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md"><b>Contributing</b></a>
</p>

<p align="center">
  <a href="https://wjcloudy.github.io/esp32-web-interface/"><img src="doc/screenshots/hero.jpg" alt="The Gauges page on a desktop browser beside the Dashboard on a phone"></a>
</p>

<p align="center">
  <b>Try it before you flash it:</b> the <a href="https://wjcloudy.github.io/esp32-web-interface/">live demo</a> is the real interface
  on a simulated vehicle, in your browser. Click through every page; nothing you do there is saved.
</p>

Works with the OpenInverter family of firmware:
[stm32-sine / FOC](https://github.com/jsphuebner/stm32-sine) ·
[ZombieVerter VCU](https://github.com/damienmaguire/Stm32-vcu) ·
[stm32-charger](https://github.com/jsphuebner/stm32-charger) ·
[stm32-island](https://github.com/jsphuebner/stm32-island) ·
[BMS](https://github.com/jsphuebner/bms-software) · and more.

## Why this interface

<table>
<tr>
<td width="33%" valign="top">

**Watch**

A dashboard with the inverter's state, errors and sparkline metrics; drag-and-drop
gauge pages that switch themselves (charging, driving); multi-axis plots; and a
data logger - all streaming live from the board.

</td>
<td width="33%" valign="top">

**Tune**

Every parameter, searchable and grouped, with favourites, presets you apply in
one tap, a change log, compare-to-file and flash save/restore. CAN mappings are
listed and edited on the device itself.

</td>
<td width="33%" valign="top">

**Update**

Flash the inverter or VCU firmware over UART or CAN, and update this module
itself over Wi-Fi from a GitHub release - firmware and web pages together, so
they never drift apart.

</td>
</tr>
</table>

It is one board, no app to install and no cloud: the ESP32 joins your Wi-Fi (or
makes its own access point) and serves the interface from its own flash. On a
phone it installs to the home screen like an app.

## Quick start

1. **Get an image** from the [latest release](https://github.com/wjcloudy/esp32-web-interface/releases/latest).
   There are two per chip, named after the chip and the version:

   | File | Use it for |
   |---|---|
   | `esp32_vX.Y-0x000.bin` / `esp32s3_vX.Y-0x000.bin` | **First install** on a new or erased board, over USB. Bootloader, partitions, firmware and web pages in one image, flashed at offset `0x0`. |
   | `esp32_vX.Y-ota.bin` / `esp32s3_vX.Y-ota.bin` | **Updates** over Wi-Fi from the Update page. Firmware and web pages together; the bootloader is left alone. |

   `esp32` is the classic ESP32 (e.g. Wemos D1 Mini ESP32), `esp32s3` the ESP32-S3 (LilyGO T-2CAN). Every
   push to `dev` also builds images as [workflow artifacts](https://github.com/wjcloudy/esp32-web-interface/actions/workflows/build.yml).

2. **Flash it from your browser** with the **[installer](https://wjcloudy.github.io/esp32-web-interface/flash/)**:
   plug the board in by USB, pick Stable or Dev and press Install (Chrome or Edge on a computer). It picks the right
   image for your chip and needs no download. It's built on [ESP Web Tools](https://github.com/esphome/esp-web-tools)
   and hosted with the [live demo](https://wjcloudy.github.io/esp32-web-interface/).

   Or flash the image yourself at offset `0x0` with `esptool.py`:

   ```sh
   esptool.py --chip esp32   write_flash 0x0 esp32_vX.Y-0x000.bin     # classic ESP32
   esptool.py --chip esp32s3 write_flash 0x0 esp32s3_vX.Y-0x000.bin   # ESP32-S3
   ```

3. **Connect.** Join the board's Wi-Fi access point and browse to http://192.168.4.1/ - or, once
   it is on your network (Settings → Wi-Fi), to http://inverter.local/ (or `<device name>.local`).

4. **Pick a transport** in **Settings → Device & Connection**: **UART** (the default) or **CAN bus**,
   then Save. In CAN mode, scan for devices: the first node found becomes the boot default.

## Features

<table>
<tr>
<td width="50%" valign="top">

**Dashboard** - the inverter's mode and status at a glance, error chips, up to
five metrics with sparklines (chosen in Settings), inverter messages, a command
terminal and, in CAN mode, a raw CAN frame sender.

**Gauges** - pages of radial, bar, line, text and indicator tiles, plus action,
toggle and slider tiles that set parameters or send CAN frames. Four sizes,
per-tile colours and warnings, peak hold, drag-to-arrange layouts, full screen,
pages that switch on a condition (e.g. when charging starts), and a session
recorder that exports CSV. A sample layout set is one click away.

**Plot** - several charts at once on left and right axes, with burst sampling
over UART.

**Spot values** - every live value, searchable, with favourites, ~10 Hz
streaming of favourites and optional per-row sparklines.

**Data logger** - log chosen values to a downloadable file.

</td>
<td width="50%" valign="top">

**Parameters** - search, categories, favourites, inline editing (rejected
values are reported), flash save/restore, download/upload and compare-to-file, a change log
of every set, named presets, and openinverter.org parameter-database submit and
subscribe.

**CAN mapping** - the device's TX/RX mappings, added and removed in place
(decimal or `0x` IDs), plus ESP-side *virtual* spot values decoded straight
from CAN frames.

**Updates** - inverter/VCU firmware over UART, or over CAN with the
[CAN bootloader](https://github.com/jsphuebner/stm32-CANBootloader); this
module from a GitHub release, an OTA file, or one file at a time; a daily
new-release check.

**Settings** - UART pins or CAN pins/speed with board presets, Wi-Fi station and
access point, device name (also the hostname), dark/light/system theme and accent
colour, keep-screen-awake, and export/import of every layout and preference as
one JSON file.

**Users & access** - optional sign-in with viewer (read-only), operator and admin
accounts, enforced by the module itself ([details](#users-and-access)).

</td>
</tr>
</table>

## On your phone

The interface adapts to a phone and can be added to the home screen (PWA manifest, iOS standalone mode).
The manifest asks for standalone display (full screen, no browser bars). Browsers that only
install apps from https may still open a home-screen shortcut in a normal tab, since the ESP is
served over plain http.

<p align="center">
  <img src="doc/screenshots/mobile.jpg" alt="On a phone: dashboard, gauges, spot values and parameters">
</p>

## On the desktop

<table>
<tr>
<td width="50%"><img src="doc/screenshots/dashboard.png" alt="Dashboard"><p align="center"><b>Dashboard</b></p></td>
<td width="50%"><img src="doc/screenshots/plot.png" alt="Plot"><p align="center"><b>Plot</b></p></td>
</tr>
<tr>
<td width="50%"><img src="doc/screenshots/parameters.png" alt="Parameters"><p align="center"><b>Parameters</b></p></td>
<td width="50%"><img src="doc/screenshots/spotvalues.png" alt="Spot values with sparklines"><p align="center"><b>Spot values</b></p></td>
</tr>
<tr>
<td width="50%"><img src="doc/screenshots/canmapping.png" alt="CAN mapping"><p align="center"><b>CAN mapping</b></p></td>
<td width="50%"><img src="doc/screenshots/settings.png" alt="Settings"><p align="center"><b>Settings</b></p></td>
</tr>
<tr>
<td width="50%"><img src="doc/screenshots/update.png" alt="Update from a GitHub release"><p align="center"><b>Update</b></p></td>
<td width="50%"><img src="doc/screenshots/gauges-light.png" alt="Gauges in the light theme"><p align="center"><b>Light theme</b></p></td>
</tr>
</table>

Every screenshot is drawn from the live demo's simulated vehicle by
`npm run screenshots` (see [How the pictures are made](#live-demo-and-screenshots)),
so they show the current interface, not a mock-up.

## Hardware

Two images cover the supported boards; pins are set at runtime in **Settings**, where
board presets fill them in one tap (only the presets for the running chip are offered).

| Board | Chip / image | Interface | Preset |
|---|---|---|---|
| Wemos D1 Mini ESP32 and most ESP32 dev boards | ESP32 · `esp32_*` | UART to the inverter: RX GPIO1, TX GPIO3 by default (the Wemos-on-OpenInverter/ZombieVerter wiring); any pins can be set | *Wemos + OpenInverter (TX3 / RX1)*, *ESP32 default UART0* |
| Generic ESP32 + CAN transceiver | ESP32 · `esp32_*` | CAN RX GPIO4, TX GPIO5 | *Generic ESP32 (GPIO4/5)* |
| LilyGO T-CAN485 | ESP32 · `esp32_*` | CAN RX 26, TX 27, with the transceiver power (16) and standby (23, active low) pins driven | *LilyGO T-CAN485* |
| LilyGO T-2CAN | ESP32-S3 · `esp32s3_*` | Built-in CAN: RX 6, TX 7 | *LilyGO T-2CAN* |
| Waveshare ESP32-S3-RS485-CAN | ESP32-S3 | Built-in CAN: RX 16, TX 15 | *Waveshare ESP32-S3-RS485-CAN* |

The `esp32s3` release image is built for the T-2CAN (16 MB flash, octal PSRAM, no SD card); check that
another ESP32-S3 board matches before flashing it, or build your own environment.
CAN runs at 125k, 250k or 500k bit/s.

Optional on the classic ESP32:
- **SD card** (SDIO) for data logging - CLK 14, CMD 15, D0 2, D1 4, D2 12, D3 13
- **RTC** (PCF8523 as standard, anything RTClib supports with a sketch change) - SCL 22, SDA 21

### UART or CAN?

| | UART | CAN bus |
|---|---|---|
| Wiring | The inverter's serial port (the classic OpenInverter connection) | The vehicle or inverter CAN bus, via a transceiver |
| Devices | One | Several nodes; pick one in the sidebar, mark a boot default |
| Values | `json`/`get` over the terminal, fast-mode streaming | SDO reads from a cached parameter database |
| Extras | Burst sampling in plots, TX/RX pin swap | Device scan, error log, CAN frame sender, virtual spot values, firmware updates over CAN |

Both transports feed the same pages. Gauges stream their values over a
server-sent-events channel from the board on either transport, falling back to
polling ([protocol](PROTOCOL.md)).

## Users and access

Out of the box there are no accounts and no sign-in: anyone who can reach the module can see and
change everything, exactly as before. To share a car or a test bench safely, open
**Settings → Users & Access** and create an admin account. From then on every page and every
request needs a signed-in user, and you can add up to eight accounts with one of three roles:

| Role | Can |
|---|---|
| **Viewer** | Read only: dashboard, spot values, parameters, plots, gauges, logger, file list. |
| **Operator** | Viewer + change and save parameters, start/stop, reset the inverter, presets, CAN mapping and CAN messages, layout and data files. |
| **Admin** | Operator + user management, Wi-Fi and device settings, firmware updates (inverter and this module), ESP32 reboot, replacing the web interface's own files. |

The module enforces this itself; the interface only greys out what your role can't use. A viewer
can still type read-only terminal commands (`get`, `json`, `errors`, `stream`, `can list`), but every
other command is refused. Scripts sign in with
`curl -H 'X-OI-Auth: 1' -d user=NAME -d password=PASS -d token=1 -D - http://inverter.local/auth/login`
and send the `X-OI-Token` reply header back as `Authorization: Bearer <token>`. (Requests that use
the session cookie instead must carry `X-OI-Auth: 1` when they change something - the browser
interface does, a page on another site can't.)

- **Sessions** last 12 hours of inactivity ("keep me signed in": 30 days), never more than 30
  days, and end on sign-out, on a reboot, and when an admin changes that user's role or password
  or removes them. Sign-in attempts are rate-limited.
- **Passwords** are stored only as PBKDF2-SHA256 hashes with a per-user salt, in the module's NVS
  flash - not in the filesystem, so they are never served, listed, exported or erased by an OTA update.
- **While sign-in is on**, the network-flashing port (ArduinoOTA, `espota`) is switched off; update
  through the **Update** page as an admin instead.
- **Plain HTTP**: the module has no TLS, so passwords and session cookies cross the network
  unencrypted. Use sign-in on a network you trust (the module's own access point with a strong
  passphrase, or your own Wi-Fi), not on a public one.

### Locked out?

Recovery needs the hardware in your hands - it is deliberately not possible over the network:

1. **BOOT button**: hold the board's BOOT button for 10 seconds while it is running. All users
   are deleted, sign-in turns off and the module restarts; settings, layouts and Wi-Fi are kept.
   (Skipped if that pin is wired to the UART/CAN link; builds can move or disable it with
   `-D AUTH_RESET_PIN=<gpio>` / `-1`.)
2. **Serial**: on the debug serial port (115200 baud; USB on the T-2Can), type `auth reset` and Enter.
3. **USB reflash**: erasing the flash and flashing the `*-0x000.bin` image as in
   [Over USB](#over-usb) also removes every account.

## Flashing and updating

### Over Wi-Fi (OTA)

Once a board is running, update it from the **Update** page - no cables or toolchain:

- **Get releases** lists this repository's releases (the field takes any fork); the image for
  your board is pre-selected and marked *(this board)*. **Download & install** has the board fetch
  and flash it itself.
- **Install OTA image from file** flashes an `*-ota.bin` you already have.
- **Upload single file** replaces one file of the web interface.

> **Your settings survive updates.** An OTA update replaces the whole filesystem, but the device
> keeps its settings (UART/CAN pins, CAN node and speed, device name, UI preferences), user
> accounts and Wi-Fi outside it, and puts them back after the reboot. Your layouts (gauges, plots,
> presets, favourites, virtual values) are backed up in the browser you update from and restored
> automatically. Flashing over USB, or updating from a different browser, doesn't do that: use
> **Update → Export settings (backup)** first and import it again from **Settings → Configuration**.
> To go back to default settings on purpose, use **Settings → Configuration → Reset device settings**.

The bootloader and partition table are never touched, so a bad image is still
recoverable over USB. The board reboots and the page reloads when the flash completes.

For development, PlatformIO can flash over the network too (`upload_protocol = espota`
in `platformio-local-override.ini`; only while no users are set up - see
[Users and access](#users-and-access)):

```sh
pio run -e esp32_wemos -t upload     # firmware (esp32_t2can for the ESP32-S3)
pio run -e esp32_wemos -t uploadfs   # web interface filesystem
```

### Over USB

For a new or erased board, flash the `*-0x000.bin` image as in [Quick start](#quick-start) through a
3.3 V USB/serial adapter:

| Pin# | ESP32 board function | USB/serial adapter |
|---|---|---|
| 1 | +3.3V input | 3.3V output (if available) |
| 2 | GND | GND |
| 3 | RXD input | TXD output |
| 4 | TXD output | RXD input |

Some OpenInverter boards (SDU, LDU, Leaf) use a different scheme for initial programming.
**Flash the ESP32 before the STM32** - otherwise the UART pins collide. If the STM32 is
already flashed, erase it or hold it in reset while flashing the ESP32.

| Pin# | ESP32 board function | USB/serial adapter |
|---|---|---|
| 1 | TXD output | RXD input |
| 2 | RXD input | TXD output |
| 3 | +5V input | 5V output (if available) |
| 4 | GND | GND |
| 5 | GND | GND |
| 6 | GPIO0 | Connect to GND (pin 5) for programming mode, then power up |

After that, update over Wi-Fi.

### Updating the inverter or VCU

**Update → Inverter/VCU Firmware** flashes OpenInverter board firmware (`stm32_*.bin`) through the ESP32:

- **UART mode** - with the standard OpenInverter bootloader.
- **CAN mode** - the transfer runs gap-free in the background with live progress; the device must
  run the [CAN bootloader](https://github.com/jsphuebner/stm32-CANBootloader). A power-cycle prompt
  recovers a board whose application no longer boots.

## Live demo and screenshots

The [live demo](https://wjcloudy.github.io/esp32-web-interface/) is the unmodified interface from
[`data/`](data/), built into a static site by [`demo/build.mjs`](demo/build.mjs). A small script,
[`demo/demo-esp.js`](demo/demo-esp.js), answers the board's HTTP API and value stream inside the
browser from the simulated vehicle in [`demo/demo-data.js`](demo/demo-data.js); changes live in
memory and a reload starts afresh. Flashing, rebooting and downloads do nothing and say so.
Add `?can=1` to the address to see CAN mode.

The README screenshots come from that same demo: `npm run screenshots` builds it, drives it in
headless Chromium with the clock frozen at a fixed moment of the drive, and writes
[`doc/screenshots/`](doc/screenshots/) - desktop pages at 1440×900 in dark and light, phone screens
at 393×852, and the framed images above.

| Workflow | When | What |
|---|---|---|
| [Live demo](.github/workflows/demo.yml) | push to `main` (a release) or run by hand; PRs build and smoke-test only | Builds the demo and publishes it to GitHub Pages |
| [Screenshots](.github/workflows/screenshots.yml) | PRs touching the UI; run by hand on `dev` | Renders the screenshots as a run artifact; when run by hand with *commit*, commits them to `dev` |

## Development

The firmware is an Arduino sketch built with PlatformIO; the web interface in
[`data/`](data/) is plain Preact + HTM with **no build step**, served gzipped from SPIFFS.
Versions come from git tags (`git describe`) and show in the UI and at `/version`.

- **Contribute back, don't fork off** - features and fixes are very welcome as pull requests against
  `dev`, so everyone gets them in one tested version. [CONTRIBUTING.md](CONTRIBUTING.md) shows where a
  new tile, tab, setting or endpoint plugs in so it stays modular.
- **Branches** - work lands on `dev`; `dev` → `main` by pull request. Every push to `main` runs the
  tests and then publishes the next `vX.Y` release automatically.
- **Tests** - `npm test` runs ESLint, checks `data/*.gz` are in sync, and runs the Playwright
  suite against a mock ESP (`npm run mock` serves it at http://127.0.0.1:8765 for UI work without
  hardware). `pio test -e native` runs the firmware's host unit tests. See
  [CONTRIBUTING.md](CONTRIBUTING.md).
- **Demo** - `npm run demo` builds and serves the live demo at http://127.0.0.1:8766/esp32-web-interface/;
  `npm run screenshots` regenerates the README pictures.
- **Build targets** - `esp32_wemos` / `esp32_wemos_debug` (classic ESP32) and
  `esp32_t2can` / `esp32_t2can_debug` (ESP32-S3).
- **Guides** - PlatformIO [setup](doc/PLATFORMIO_setup.md) · [usage](doc/PLATFORMIO_usage.md) ·
  [flashing walkthrough](doc/PLATFORMIO_flashing_esp32.md) ·
  [combined binary](doc/PLATFORMIO_usage.md#building-a-combined-binary-for-web-flasher);
  Arduino IDE [setup](doc/ARDUINO_IDE_setup.md) · [usage](doc/ARDUINO_IDE_usage.md);
  the [web interface ↔ inverter protocol](PROTOCOL.md).

After editing a file in `data/`, regenerate its `.gz` twin with `python gzip_assets.py` (any
`pio run` does it too) and upload with `uploadfs` or the Update page. The SPIFFS image only
carries the `.gz` of files that have one (`fs_stage.py` stages it in `.pio/fsdata`): the ESP
always serves the gzip, so the raw sources stay in `data/` for the demo and tests.

## Credits

A fork of [jsphuebner/esp32-web-interface](https://github.com/jsphuebner/esp32-web-interface) with a
rewritten frontend and a CAN bus backend. Thanks to Johannes Huebner and the
[OpenInverter community](https://openinverter.org/forum/).

## Licence

The firmware is free software under the **GNU General Public License v3 or later**, as stated in
its source files; the web server code derived from the FSWebServer example is under the GNU LGPL 2.1
or later. Bundled third-party libraries (Preact, htm, Chart.js, GridStack and others) keep their own
licences, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
