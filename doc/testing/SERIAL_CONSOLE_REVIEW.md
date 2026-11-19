# Serial maintenance console review verification

Date: 2026-11-16 (Europe/Berlin). PR #15 review follow-up, rebased onto
Cloudy dev `8c6187c` (which includes the merged memory fix from PR #14).

## Review changes

- Maintenance implementation requires `OI_SERIAL_CONSOLE`; only the WeAct CLI
  environment enables it. The persisted `serial_console` setting defaults off.
  Settings > Device & Connection provides an administrator toggle explicitly
  warning that physical serial access bypasses users and roles.
- Default builds and runtime-disabled consoles accept only bounded physical
  `auth reset` recovery. Recovery runs before firmware-update/logger gates.
- Each framed response uses one port write. JSON escaping expands backwards in
  the command result buffer instead of retaining a third large response copy.
- CSV resolves physical IDs once; reads use a 10 ms timeout and a 20 ms row
  budget. The first read failure discards the incomplete row and stops logging.
  Long synchronous maintenance commands remain bench-only and documented.
- Reserved flash/PSRAM, console UART, inverter UART and enabled SD pins are
  rejected. Switching to CAN releases the inverter UART peripheral first.
- CAN flashing accepts only the validated staged `/cli-firmware.bin` path.
  Binary SD write faults close the file and latch a fault even if the target's
  stop acknowledgement is missing; automatic restart stays blocked.
- The agent guide leaves authorization policy to the operator.

## Automated verification

99 native C++ tests, 36 Python tests, frontend lint and 38 focused browser tests
pass locally. Framing tests include empty, escaped and 60,000-byte inputs,
capacity failure and guard bytes. Browser tests cover availability, default-off,
persistence, rejected saves and admin/operator/viewer permissions. The preceding
review source `ab1cd34` passed all GitHub workflows, including the full browser
suite, host sanitizers and release images. See PR checks for the latest revision.

Stock Wemos, WeAct CLI and an additional ESP32-S3 build with the console flag
were compiled locally using PlatformIO espressif32 6.13.0 / Arduino 2.0.17.
The S3 console build checks code compilation; no physical S3 board was tested.

## Image size

Matched `WEB_VERSION_OVERRIDE=review-size`, same toolchain and build options:

| Image | Program bytes | Delta from upstream stock |
|---|---:|---:|
| Upstream dev Wemos, `8c6187c` | 1,171,637 | - |
| PR stock Wemos, console compiled out | 1,173,497 | +1,860 |

The default image excludes maintenance command and CSV code (verified in link
symbols). Remaining changes include minimal recovery, settings and logger/shared
SDO corrections. The compressed frontend grows from 120,738 to 121,212 bytes
(+474 bytes). Final WeAct CLI program size: 1,192,581 bytes (91.0%). This is
a different target configuration and should not be treated as a flag-only delta.

## Physical bench

WeAct classic ESP32, COM27/115200, 8 MB flash; real Zombie-Slave at node33,
500 kbit/s, CAN TX27/RX26. SD_MMC 1-bit: CLK14/CMD15/DAT0 GPIO2; existing
64 GB card mounted. ESP bridge application and compressed frontend were updated
while preserving settings and filesystem contents. ECU firmware was not flashed.
PC Wi-Fi/network was not changed; bridge remained at `192.168.0.179`.

- Migration from settings without `serial_console`: maintenance `status` ignored,
  physical framed `auth reset` succeeds. No accounts were configured, so recovery
  returned ?no users? without erasing accounts or rebooting.
- Real browser UI: toggle available, initially off, warning displayed; enabling
  persists across reload. Existing CAN/node/SD settings remain unchanged.
- Final buffer optimization re-flashed and verified: `db refresh` and `db` each
  returned 20,420 characters of valid metadata JSON; strict named/raw reads
  still succeed. The runtime enable setting survives the bridge reboot.
- Enabled console: UART pin16 and SD pin14 CAN assignments rejected; arbitrary
  `/settings.json` firmware path rejected. Target identity remains `98238256`;
  named version/bitrate values remain 4 and 2.
- `log start 100 version,canspeed`: recovery still responds while recording and
  recording remains active. After stopping: 23 rows, zero read errors, 494 bytes.
  Serial download verifies CRC/offset/length/metadata and every row's contents.
  SHA-256: `06be9e7efc636be9882b55fb693952c2d6b65ca2bb97b84a7062afea329a7b7e`.

Hardware did not exercise SD removal/short writes, UART stop failure or recovery
interrupting an active ECU firmware flash. Those failure paths are covered by
host checks/source control flow, not claimed as physical fault-injection tests.
All recording is stopped; SD remains mounted and console enabled for this bench.
