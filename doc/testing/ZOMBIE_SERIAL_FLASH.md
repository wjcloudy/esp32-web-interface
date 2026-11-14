# Zombie-Slave serial/CAN flash smoke test

Date: 2026-11-14 (Europe/Berlin).

## Setup and image

- WeAct classic ESP32, CH343 serial console, 115200 baud.
- CLI implementation `b2aadaa` (same CLI patch rebased as `e53fbce` in PR #15).
- CAN: 500 kbit/s, bridge TX27/RX26, selected target node 33.
- Target project: Zombie-Slave STM32 application, version enum `4 = 2.20.R`.
- Approved desktop application: `stm32_zombieslave.bin`, 57,808 bytes.
- SHA-256: `30cf2365f3a184294426091324e4d533f490462d4ed2b0386305f210766e424f`.
- IEEE CRC32: `f69e658e`.
- Companion Intel HEX checksums verified; address range
  `0x08001000..0x0800f1cf`; flattened data matches BIN exactly.
- Application start agrees with the local project's linker script
  (`0x08001000`). Initial stack pointer `0x20005000` and reset vector
  `0x08009d95` are consistent with that image.

## Executed procedure

1. Installed the previously tested CLI build on the ESP32 bridge, preserving
   bridge settings/filesystem. Verified node identity and project-specific
   metadata before touching target flash.
2. Captured metadata, all 148 physical UID objects, 37 configuration parameters,
   target identity, CAN mappings and fault log locally. This is a configuration
   snapshot, not an executable backup read from the ECU.
3. Used the Python `Console.upload()` implementation over serial: 256-byte
   chunks, cumulative position checks, exact final byte count and CRC32.
   Received completed staging path `/cli-firmware.bin`.
4. Sent `flash` once; the bridge reset the selected target and ran the existing
   OpenInverter CAN bootloader update. Polled `flash-status` to completion.
5. After boot, re-read the identity and all 148 objects, compared all 37
   configuration values and CAN mappings, and made strict named reads.

## Observed result

```json
{
  "state": 3,
  "page": 57,
  "pages": 57,
  "message": "Update complete"
}
```

- Same target identity responds after flash.
- 148/148 physical parameter objects readable after flash.
- 37/37 configuration values unchanged; no automatic restoration needed.
- CAN mappings unchanged: one TX mapping, COB-ID 1000, parameter UID 1,
  position 0, length 8, gain 1, offset 0.
- Strict named reads: version 4, canspeed 2 (500 kbit/s), battery approximately
  12.5 V at the time of observation.
- `BMS_TIMEOUT` and `DCDC_TIMEOUT` were present before and after the test.
  This bench smoke test does not resolve or qualify those system faults.
- No PC Wi-Fi/network switch was needed.

The serial staging and CAN bootloader flash path passed on real hardware.
The target continued to execute an application with the expected metadata and
values. This was a same-version application update, so version alone does not
distinguish old/new bytes. There is no target image SHA-256 readback in the CLI;
evidence consists of source-file validation, staging CRC, bootloader acceptance,
and application responses. No start/stop, actuator-control, parameter-write,
firmware rollback or power-loss tests were performed. Do not infer such coverage.

## Bridge left available for further development

After the target flash test, the WeAct received a local integration build of
CLI `e53fbce` plus memory fix `721408d`, identified by
`v4.28-cli-e53fbce-mem-721408d`. The target application was not flashed again.
Three consecutive `db refresh` operations each returned all 149 metadata entries;
each was followed by successful strict version/bitrate/battery reads. This
integration build avoids leaving the earlier cache-allocation defect on the
development bridge. The source changes remain in separate upstream PRs #14/#15.
