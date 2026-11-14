# CANopen over the physical serial console

For coding agents developing ECU firmware on a real bench, start with the
[ECU agent workflow](ECU_AGENT_GUIDE.md). It covers target identification,
snapshots, controlled writes, flashing, recovery, evidence, and limitations.

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
| `sd status`, `sd enable 0/1`, `sd mount`, `sd unmount` | Inspect/configure/mount the SD card without formatting |
| `sd list [OFFSET COUNT]`, `sd stat PATH`, `sd read PATH OFFSET COUNT` | List root entries, inspect and read closed files |
| `log status`, `log start INTERVAL_MS NAME[,NAME...]`, `log stop` | Control CAN CSV recording on SD |
| `log binary`, `log auto` | Start supported UART binary recording; restore original automatic policy |

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

## Detailed command contract

Commands are case-sensitive. There is no shell, quoting, expansion, or scripting
on the device. Arguments are separated by whitespace; names and SPIFFS paths
must contain no spaces. The parser accepts at most 12 tokens including the
optional `@oi ID` prefix. The Python client accepts a local upload filename with
spaces as a single quoted operating-system argument.

In the tables, **bridge** means the ESP32 and **target** means the CAN ECU.
Replies below are the string inside `result`; parse that string again for JSON
objects/arrays. All commands can return `ok:false` with an explanatory string.

### Discovery and bridge configuration

| Command | Inputs / result | Side effects |
|---|---|---|
| `help` | No arguments; semicolon-separated syntax summary | None |
| `status` | JSON: `version`, `can_mode`, `running`, `node`, `kbps`, `tx`, `rx`, `wifi_ip`, `cache` | None; running is bridge driver state, not proof of an ECU |
| `bus RATE [TX RX]` | RATE exactly 125, 250, or 500 kbit/s; either both GPIOs or neither; valid, distinct pins | Reinitializes bridge CAN, enables CAN mode, clears metadata cache, saves bridge settings; no ECU bitrate write |
| `transceiver PWR INV EN INV` | Each GPIO `-1` or valid output; inversion `0`/`1`; conflicts rejected | Releases previous control GPIOs, applies new output levels and saves bridge settings; may electrically disconnect the bus |
| `node N` | N=1..127 | Changes active bridge selection, saves settings and invalidates cache; does not change ECU node ID |
| `scan [FIRST LAST]` | Both bounds 1..127, FIRST<=LAST; default entire range; JSON array of `{nodeId,serial}` | Sends reads of `0x5000:0` at each node; nominal 40 ms timeout per probe, plus bus/console overhead |
| `auth reset` | No extra args | Physical recovery: deletes bridge web users and reboots if auth is enabled; does not reset ECU parameters |

CAN configuration changes must use the physical transceiver wiring. GPIO
validation does not guarantee a pin is free on a particular carrier. For the
WeAct UART0 console, GPIO1/3 and ESP32 flash pins GPIO6..11 are rejected.
An existing saved GUI boot-default node can override `node N` after reboot.

### Metadata, values, and raw SDO

| Command | Inputs / result | Contract |
|---|---|---|
| `db` | JSON parameter metadata keyed by name | Uses existing cache or downloads it; cached `value` fields are not fresh telemetry |
| `db refresh` | Same JSON | Discards cache and downloads from selected target; failure leaves cache invalid |
| `json` | Web-compatible JSON including fresh values and `can_cache:true` on a loaded database | Uses shared web backend; see limitations below |
| `get NAME[,NAME...]` | One comma-separated token, 1..128 names; JSON object with numeric values | Fresh, matching SDO reads for physical values; bridge virtual values supported; missing/invalid values fail the request |
| `set NAME VALUE` | Finite numeric VALUE; JSON `{raw,size}` from write acknowledgement | Fixed point: truncates VALUE*32 toward zero to signed int32; the agent must check metadata `isparam`, minimum/maximum and ECU semantics first |
| `sdo read INDEX SUB` | INDEX=0..65535, SUB=0..255; JSON `{raw,size}` | Expedited 1..4-byte reads; matching node/index/sub required; short values zero-extended; four-byte values represented as signed int32 |
| `sdo write INDEX SUB RAW` | Same address; RAW signed int32 or unsigned 32-bit bit pattern | Always four bytes, little-endian; matching SDO acknowledgement required; no fixed-point conversion |
| `errors` | Text lines `[timestamp]: error-name`, or `No errors logged.` | Reads target log; does not clear it |

OpenInverter metadata IDs are UIDs, addressed as
`index = 0x2100 | (id >> 8)`, `subindex = id & 0xff`.
Only OpenInverter parameter values use raw/32; identity, command, mapping and
vendor-specific objects have their own encoding. Example: metadata id 2001
maps to `sdo read 0x2107 209`. Never infer an address from a parameter's array
position. Cache and `json` may contain virtual entries without a target UID.

`get` returns five decimal places but values are generally quantized in steps
of 1/32. It is not a simultaneous multi-signal sample. A failure partway through
a list returns an error, not a partially successful result object.

The shared `json`, `errors`, and `can list` backend uses abort/timeout as an
end-of-list convention. `json` can substitute zero for a failed physical read;
an empty error/mapping list alone does not prove communication succeeded.
Use `sdo read` and `get` for assertions where a timeout must fail the test.

### Target control

| Command | Target operation at `0x5002` | Verification |
|---|---|---|
| `save` | sub 0, raw 0: persist parameters/mappings as supported by ECU | Readback, then verify after an authorized reset if persistence matters |
| `load` | sub 1, raw 0: load saved settings | Refresh metadata if needed and read affected values |
| `reset` | sub 2, raw 1: reboot ECU | Rediscover the same device and verify application; an acknowledgement may be lost during reboot |
| `defaults` | sub 3, raw 0: restore defaults | Destructive configuration operation; behavior/persistence is ECU-specific |
| `start`, `start 2` | sub 4, raw 0: start target | May energize hardware; `2` is an alias, not a selectable operating mode |
| `stop` | sub 5, raw 0: stop target | Observe actual ECU state; an SDO acknowledgement is not proof of physical shutdown |

These commands return the confirmed raw SDO result. Support is determined by
the ECU firmware; the bridge does not implement a generic ECU state machine.

### CAN mappings and raw frames

| Command | Constraints / result | Effect |
|---|---|---|
| `can list` | JSON array: `isrx,id,paramid,position,length,gain,offset,index,subindex` | Reads target mappings; `index/subindex` identify entries for removal |
| `can clear` | `cleared`, or failure | Removes all target mappings via command 6 |
| `can rm INDEX SUB` | INDEX=0x3100..0x31ff; odd SUB=1..99; `ok`, or failure | Removes one target entry; refresh list afterwards because positions can change |
| `can tx NAME ID BIT LENGTH [GAIN [OFFSET]]` | ID=0..0x7ff; BIT=0..63; LENGTH=-32..-1 or 1..32; BIT+abs(LENGTH)<=64; default GAIN=1/OFFSET=0 | Configures ECU transmission, not bridge transmission |
| `can rx NAME ID BIT LENGTH [GAIN [OFFSET]]` | Same bounds | Configures ECU reception; can alter control behavior |
| `send ID [HEXBYTES]` | ID=0..0x1fffffff; contiguous even-length hex, 0..8 bytes | Queues one standard frame for ID<=0x7ff, extended otherwise; no RTR option; success proves queueing only |
| `sniff MS` | MS=1..8000; JSON array `{id,ext,rtr,data}` | Consumes at most 40 queued frames, stops early at limit; timestamps and completeness are not provided |
| `debug reset` | No additional args; same frame array | Sends ECU reset without waiting for SDO acknowledgement, then captures up to 8 s / 40 frames; this is not a read-only diagnostic |

Mapping GAIN is finite and encoded as signed 24-bit fixed point *1000
(-8388.608..8388.607); OFFSET is signed integer -128..127. Negative LENGTH
means a signed signal. The target validates supported parameters/mapping
capacity. Read `can list` back and compare the actual mapping before `save`.
Do not run `sniff` concurrently with SDO traffic; it can consume replies.

### Firmware staging and flashing

| Command | Result / limits | Effect |
|---|---|---|
| `file begin SIZE CRC32` | SIZE=1..261120 bytes; CRC32 unsigned uint32; `ready` | Replaces any incomplete staging upload; requires SIZE+8192 bytes free |
| `file chunk HEX` | 1..256 bytes; result is cumulative accepted byte count in decimal | Appends in order; no offset, deduplication or resume support |
| `file finish` | `/cli-firmware.bin` | Checks exact length and IEEE CRC32, closes and renames staging file; replaces previous completed CLI image |
| `file abort` | `aborted` | Removes incomplete `.part` only; previous completed image can still exist |
| `flash [PATH]` | Default `/cli-firmware.bin`; explicit absolute SPIFFS path, not `.part`; acceptance text | Starts asynchronous CAN bootloader operation; acceptance is not completion |
| `flash-status` | JSON `{state,page,pages,message}` | States 0=idle, 1=waiting for bootloader, 2=flashing, 3=done, 4=error; progress is accepted pages, not a percentage |

The 60-second staging timeout is measured since begin/last successful chunk.
CRC32 is the standard `binascii.crc32(binary)` value, not the STM32 page CRC.
The updater handles its own STM32 word/page CRC, 1 KiB pages, and `0xff` final
padding. A new flash resets the selected node and waits up to 30 s for bootloader
magic. Bootloader traffic uses shared IDs `0x7dd/0x7de`, not per-node SDO IDs:
isolate one intended bootloader target on the bench.

Only `help`, `status`, and `flash-status` work while waiting/flashing. Bridge
flash completion means protocol acceptance; verify target boot, identity,
version, parameters, mappings and behavior separately. There is no firmware
readback, image-signature check, MCU/hardware compatibility check, parameter
backup, or automatic rollback in this interface. A raw application `.bin` is
required; Intel HEX, ELF, ESP32 images and combined bootloader images must not
be sent as application data.

### Host-only commands and options

`upload LOCAL.bin` runs begin/chunk/finish without resetting/flashing the ECU.
`flash-local LOCAL.bin` stages then calls `flash`. `--wait` on `flash` or
`flash-local` polls every 0.5 s for up to 600 s, returns state 3, and fails on
state 0/4. A wait timeout does not cancel the device's flash operation.

Options must appear before the command: `--port` (required), `--baud` (115200),
`--timeout` (60 s per request), `--json`, and `--wait`. There is no separate
command-line option for the 600 s total flash wait; Python callers can use
`Console.wait_flash(timeout=...)`. `--timeout` is not a CAN bus timeout.

Python API: `Console(serial_port, timeout=60)`, `request(command)` (returns an
envelope even on device failure), `checked(command)` (raises `DeviceError` on
`ok:false`), `upload(path)`, and `wait_flash(timeout=600)`. The caller owns and
closes the serial port. `CliError` represents local/protocol timeouts; do not
interpret it as proof that a mutating command did not execute. On upload failure
the client attempts `file abort`, without retrying the failed chunk.

## SD card, logging and file retrieval

SD commands are independent of CAN mode. They use the existing **SD_MMC 1-bit**
driver, not an SPI card interface. On classic ESP32 this uses CLK14, CMD15 and
DAT0 GPIO2; check board wiring. `SD_AVAILABLE=0` builds, including the current
S3 targets with `S3_SKIP_SD_MMC`, report `supported:false` and cannot mount a card.
No command formats the card. `sd enable 1` saves the boot preference; `sd mount`
applies it asynchronously now. Poll `sd status` for `mounted:true`, or
`init_done:true` with `mounted:false` on failure. `sd unmount` refuses while
initialization or logging is active. Disabling the boot preference does not
unmount an already mounted card.

| Command | Inputs / result | Contract |
|---|---|---|
| `sd status` | JSON `supported,enabled,mounted,init_done,total,used` | Byte counts are 64-bit; does not probe/reinitialize hardware |
| `sd enable 0/1` | Acceptance text | Saves bridge preference; refuses while recording |
| `sd mount` | Acceptance text | Starts background mount if enabled/supported; acceptance is not a mounted card |
| `sd unmount` | Acceptance text | Releases SD filesystem; no formatting/deletion |
| `sd list [OFFSET COUNT]` | Default 0/16; OFFSET=0..100000, COUNT=1..32; JSON `files,next,more` | Root directory pagination; each entry has `path,size,directory`; no sorting/snapshot guarantee if another client changes directory |
| `sd stat PATH` | JSON `size,modified` | Closed regular file only; last-write timestamp is a filesystem value, not guaranteed correct wall time |
| `sd read PATH OFFSET COUNT` | OFFSET=0..file size; COUNT=1..1024 | JSON `offset,size,eof,crc32,hex`; IEEE CRC32 covers decoded bytes; final chunk can be shorter, EOF offset returns empty bytes |
| `log status` | JSON `active,mode,auto,path,rows,read_errors,interval_ms,error` | Mode `idle`, `can_csv` or `uart_binary`; rows/errors/interval describe the CSV recorder, not binary sample counts; last path/error retained after stop |
| `log start INTERVAL_MS NAME[,NAME...]` | 100..60000 ms, 1..16 known names in one token | Starts new CAN CSV file; CAN driver and mounted SD required; names restricted to alphanumeric/underscore |
| `log stop` | Updated status or failure | Stops CAN CSV immediately and flushes/closes it; UART stop must be confirmed; suppresses automatic restart for this bridge boot |
| `log binary` | Updated status or failure | Uses existing ECU UART `binarylogging` protocol at 2.25 Mbaud; requires UART mode and no Wi-Fi clients, exactly as the original logger policy |
| `log auto` | Updated status | Requires stopped logger; restores existing automatic disconnected-Wi-Fi UART logger policy |

Paths are absolute ASCII tokens, at most 240 bytes; no spaces, control
characters, backslashes, empty components, `.` or `..` components. Files in
subdirectories can be read by known path; `sd list` enumerates the root only.
File reads/stat/download require stopped logging. `sd list` and status are
available during recording. Other serial ECU commands are blocked during
recording, including flash and node/bus changes. Stop recording before changing
the target or using another HTTP/CAN client. A CAN flash blocks SD/logger
commands as well as other bus operations.

### CAN CSV recording

```sh
python tools/oi_cli.py --port COM27 --json sd enable 1
python tools/oi_cli.py --port COM27 --json sd mount
python tools/oi_cli.py --port COM27 --json sd status
# Continue only when mounted is true and the intended target is identified.
python tools/oi_cli.py --port COM27 --json log start 500 version,canspeed,LVDU_12v_battery_voltage
python tools/oi_cli.py --port COM27 --json log status
python tools/oi_cli.py --port COM27 --json log stop
python tools/oi_cli.py --port COM27 --json sd list 0 16
python tools/oi_cli.py --port COM27 download /can-EXAMPLE-0.csv recording.csv
```

Use the actual path returned by `log start`/`log status`, not the example name.
CAN recording works with Wi-Fi connected; no PC network change is needed.
CSV files contain a header `ms,NAME,...` and engineering-unit numeric values:
`ms` is elapsed bridge uptime since recording started (uint32 wrap applies).
Strict SDO failures/nonfinite values become `nan`, incrementing `read_errors`.
Physical signals are read sequentially; virtual signals use bridge state.
The requested interval is a best-effort minimum between sample starts; slow
SDO replies and other main-loop work can delay it. This is not synchronized
sampling or high-speed raw CAN capture. Flushing occurs approximately every
second and at stop; sudden power loss can lose the unflushed tail.

The CSV recorder creates a new `/can-MILLIS-INDEX.csv` file, never overwrites
existing names, and stops with an error on a short write or less than 64 KiB
free. It does not prune existing files. In contrast, the **existing UART binary
logger** retains its original cleanup policy: starting a binary recording can
delete oldest root files to maintain 2 GB free / fewer than 200 files. Keep
unrelated files off that logger card. Binary mode also needs a supported ECU
UART connection; it is not high-speed CAN recording. Pending buffered binary
bytes are flushed on a confirmed stop, including a partial final block.

### Downloading exact file bytes

`download SD_PATH LOCAL_PATH` is a host-only command, also available as
`Console.download(remote, local)`. It does not decode binary logs. CSV is UTF-8
text; UART `.bin` files need a decoder for that ECU's binary logging format.

The client reads in 1024-byte chunks, checks byte counts, offsets, EOF, size and
each chunk's CRC32, then checks file size/mtime again. It reports local byte
count and SHA-256 in a synthetic success envelope (ID 0). Existing local files
are never overwritten, and failed downloads remove their private temporary
file. Publishing the completed file uses an atomic hard link on the local
filesystem (e.g. NTFS/ext4); unsupported destinations fail rather than silently
overwriting. A local pathname may contain spaces when quoted to the shell.

Do not edit/delete/replace a remote file during a download. There is no remote
snapshot lock against other HTTP clients, and size/mtime checks cannot detect
every same-size same-timestamp replacement. The returned SHA-256 hashes the
downloaded bytes; it is not a separately computed whole-file hash on the card.
