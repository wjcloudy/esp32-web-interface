PlatformIO usage
================

All commands below are run from the project root (the directory containing `platformio.ini`).

# Environments

| Environment | Board | Notes |
|---|---|---|
| `esp32_wemos` | classic ESP32 (Wemos / WROOM dev boards) | **default** |
| `esp32_wemos_debug` | classic ESP32 | debug build with serial debug output |
| `esp32_t2can` | LILYGO T-2Can (ESP32-S3) | 16MB flash, PSRAM, built-in CAN |
| `esp32_t2can_debug` | LILYGO T-2Can (ESP32-S3) | debug build |

Select an environment with `-e` / `--environment` (default is `esp32_wemos`), and a target with `-t` / `--target` (no target = build the firmware). List everything with `pio run --list-targets`.

Two pre-scripts run automatically on every build, so there are **no manual steps** to remember:
- `version.py` injects `WEB_VERSION` (from `git describe`), `WEB_REPO` (the repo's origin URL), and `WEB_OTA_TARGET` (the env name, e.g. `esp32_wemos`).
- `gzip_assets.py` regenerates the `data/*.gz` files the device serves whenever a source changes — you never gzip by hand.

# Building the firmware

```sh
pio run -e esp32_wemos      # classic ESP32
pio run -e esp32_t2can      # LILYGO T-2Can
```

# Flashing the firmware

```sh
pio run -e esp32_wemos -t upload
```

By default this uploads over USB serial. For wireless (OTA) uploads, set the board's address in `platformio-local-override.ini` (git-ignored) — the upload then goes over WiFi with no cable:

```ini
[env:esp32_wemos]
upload_protocol = espota
upload_port = 192.168.1.89

[env:esp32_t2can]
upload_protocol = espota
upload_port = 192.168.1.92
```

# Flashing the web interface (filesystem)

The web UI lives in a SPIFFS image built from the `data/` directory.

```sh
pio run -e esp32_wemos -t uploadfs   # build + flash the filesystem
pio run -e esp32_wemos -t buildfs    # build only (-> .pio/build/<env>/spiffs.bin)
```

Individual files can also be replaced live via the web interface (Update → Upload single file), which posts to the `/edit` endpoint; `upload.sh` does the same from the command line.

# Combined images

CI ([.github/workflows/build.yml](../.github/workflows/build.yml)) publishes two images per board on every `v*` tag:

- **`<target>_<ver>-0x000.bin`** — a full-flash image (bootloader + partition table + firmware + filesystem) for flashing a blank board at offset `0x0` with `esptool.py` or [ESP Web Tools](https://espressif.github.io/esptool-js/).
- **`<target>_<ver>-ota.bin`** — a combined OTA image (firmware + filesystem only, no bootloader/partition table) for in-browser updates from the Update tab. The two halves are always flashed together so they can't drift out of sync.

To build the full-flash image locally for the classic ESP32:

```sh
pio run -e esp32_wemos
pio run -e esp32_wemos -t buildfs
esptool.py --chip esp32 merge_bin -o esp32_wemos-0x000.bin \
  0x1000   .pio/build/esp32_wemos/bootloader.bin \
  0x8000   .pio/build/esp32_wemos/partitions.bin \
  0x10000  .pio/build/esp32_wemos/firmware.bin \
  0x290000 .pio/build/esp32_wemos/spiffs.bin
```

The LILYGO T-2Can (ESP32-S3, 16MB) uses a different bootloader offset (`0x0`) and SPIFFS offset (`0xc90000`) — see the `Merge combined images` step in the workflow for the exact offsets.

# Serial monitor

```sh
pio device monitor -e esp32_wemos
```

In normal operation the serial port is connected to the inverter, so leave debug output disabled (use an `*_debug` environment only while developing).

# Clean build files

```sh
pio run -t clean
```
