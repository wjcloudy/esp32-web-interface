# CANopen over the physical serial console

The debug console accepts CAN commands at **115200 baud**, newline terminated.
It works without a browser, Wi-Fi connection, or HTTP server. The existing
`auth reset` recovery command remains available. This is a **trusted physical
maintenance interface**: web users, roles and sign-in do not restrict it.

## Build and connection

For a classic ESP32 WeAct connected through its CH343 USB adapter:

```sh
pio run -e esp32_weact_cli
pio run -e esp32_weact_cli -t upload --upload-port COM27
pio device monitor --port COM27 --baud 115200
```

This target puts the console on `Serial`/UART0 (GPIO1/3) and moves the inverter
UART to **UART1, RX16/TX17**. Saved Wemos UART assignments on GPIO1/3 are replaced
at UART initialization so they cannot take the console away. Check the wiring
before using an inverter's UART with this target. The regular Wemos target
continues to use `DBG_OUTPUT_PORT` (normally Serial2) for the console; the S3
T-2CAN target uses native USB CDC. No CAN transceiver is added by software.
For later updates, keep using firmware built with `esp32_weact_cli`; a generic
ESP32 release/OTA image does not preserve this target's UART assignment.

Close the IDE serial monitor before running the Python client; only one process
can own a COM port. The client does not intentionally pulse DTR/RTS or reboot the
module on connection. Some USB adapters/drivers can nevertheless reset on open.

## Python client

```sh
python -m pip install -r tools/requirements-cli.txt
python tools/oi_cli.py --port COM27 help
python tools/oi_cli.py --port COM27 status
python tools/oi_cli.py --port COM27 bus 500 5 4
python tools/oi_cli.py --port COM27 scan
python tools/oi_cli.py --port COM27 node 1
python tools/oi_cli.py --port COM27 db
python tools/oi_cli.py --port COM27 get udc,tmphs
python tools/oi_cli.py --port COM27 set udcmin 120
python tools/oi_cli.py --port COM27 save
```

The pin numbers above are the classic ESP32 defaults (**TX5/RX4**), not a
confirmation of a particular carrier board's wiring. `bus` enables CAN and saves
bitrate/pins. Only 125, 250 and 500 kbit/s are supported. `node` selects the active
node and invalidates the metadata cache; an existing GUI-selected boot-default
node still takes precedence at the next reboot. Run `node N` in each automation
session to select its target explicitly. `scan` does not change the selection.

Options precede the command. Use `--json` for a JSON response containing `id`,
`ok`, and `result`. Exit status: **0** success, **1** device-reported failure,
**2** local/transport failure. Results which are themselves JSON (e.g. `get`,
`db`, `status`) are strings inside this envelope. Plain output prints only the
result. Numeric writes accept only valid, finite numbers within their ranges.

An SDO abort includes its hexadecimal code; missing responses produce a timeout,
not a fabricated zero or successful write. Confirmed SDO operations require the
matching node/index/subindex. A timeout after a write/reset means the outcome is
unknown: the command is **never automatically retried**. Devices that reboot
before confirming reset may therefore report a timeout even though they reset.

## Commands

| Command | Action |
|---|---|
| `help`, `status` | Command list; version, active bus/node/pins, cache and IP |
| `bus RATE [TX RX]` | Start/reconfigure CAN, persist settings |
| `transceiver PWR INV EN INV` | Optional power/enable GPIOs; `-1` unused, polarity `0`/`1` |
| `node N` | Select node 1–127 and clear cached database |
| `scan [FIRST LAST]` | Discover OpenInverter serial-number objects; all nodes by default |
| `db [refresh]` | Download/cache parameter metadata via segmented SDO |
| `json` | Web-compatible metadata and live-value dump |
| `get NAME[,NAME...]` | Named live values; JSON object, up to 128 names |
| `set NAME VALUE` | Named write, OpenInverter fixed point ×32 |
| `sdo read INDEX SUB` | Raw expedited object read; `raw` and byte `size` |
| `sdo write INDEX SUB RAW` | Raw **four-byte** expedited object write |
| `save`, `load`, `defaults` | Device parameter commands, confirmed by SDO |
| `start [2]`, `stop`, `reset` | Device control; `start 2` is an alias for `start` |
| `errors` | OpenInverter error log |
| `can list`, `can clear` | Read/remove device CAN mappings |
| `can rm INDEX SUB` | Remove a mapping entry (odd subindex 1–99) |
| `can tx/rx NAME ID BIT LENGTH [GAIN [OFFSET]]` | Add device mapping; negative length means signed |
| `send ID [HEXBYTES]` | Queue a raw CAN frame, up to eight bytes; extended IDs supported |
| `sniff MS` | Capture at most 40 frames for 1–8000 ms |
| `debug reset` | Request reset and capture boot traffic for up to eight seconds |
| `flash [PATH]`, `flash-status` | Start existing CAN bootloader updater; read progress |
| `file begin SIZE CRC32`, `file chunk HEX`, `file finish`, `file abort` | Stage firmware on SPIFFS over serial |
| `auth reset` | Existing physical user recovery; deletes users and reboots |

Integers accept decimal or explicit `0x` hexadecimal; leading zeroes remain
decimal. Raw SDO writes accept signed int32 or unsigned 32-bit bit patterns.
Short expedited reads are zero-extended; named OpenInverter values are 32-bit
fixed point. Generic CANopen NMT/PDO configuration, arbitrary-width/segmented
SDO writes and third-party bootloaders are not implemented by the existing CAN
backend. `scan` probes the OpenInverter serial object, not every CANopen device.

`json`, error-log and mapping-list replies use the existing web command backend
and its end-of-table conventions. For diagnosing individual objects or strict
per-object error handling, use `sdo read`/`sdo write` and `get`/`set`.

## Firmware update entirely over serial

```sh
# Transfer only; checks length and CRC32, does not reset/flash the inverter.
python tools/oi_cli.py --port COM27 upload stm32_firmware.bin
# Flash the verified staged image; optionally wait for completion.
python tools/oi_cli.py --port COM27 --wait flash
# Or explicitly upload and flash in one invocation:
python tools/oi_cli.py --port COM27 --wait flash-local stm32_firmware.bin
```

The target needs the OpenInverter CAN bootloader. Firmware is limited to 255 KiB.
Chunks are limited to 256 bytes; staging uses `/cli-firmware.part`, which is
renamed to `/cli-firmware.bin` only after size and CRC32 match. An idle staging
upload is abandoned after 60 seconds. Interrupted uploads never become flashable
completed files. During a CAN firmware update, only `help`, `status` and
`flash-status` are accepted; other serial commands cannot steal bus frames or
reconfigure the driver. A reset/power-cycle of the target may be needed during
the bootloader's 30-second discovery window.

## Wire protocol for other clients

Plain console input: `get udc` followed by CR, LF or CRLF. Scripted input adds a
request ID:

```text
@oi 42 sdo read 0x5000 0
@oi {"id":42,"ok":true,"result":"{\"raw\":12345,\"size\":4}"}
```

Each result is a single JSON line prefixed with `@oi `; embedded newlines, quotes
and control characters are escaped. Plain commands use ID 0. Ignore unprefixed
debug messages and replies with another ID. Requests are at most 1024 ASCII
bytes excluding the terminator; overlong/invalid lines are discarded **in full**
and return an ID-0 error. One command runs per main-loop iteration, sharing the
existing bus services with HTTP/SSE. Long scans, dumps and sniff operations can
delay web requests; clients should serialize commands and allow enough timeout
(Python default 60 seconds).
