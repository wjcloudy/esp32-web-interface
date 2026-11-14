# Real ECU development with the serial CAN tool

This guide is for coding agents that build ECU firmware and exercise it on a
physical development bench. The ESP32 is a serial-to-CAN maintenance bridge;
the ECU runs the application being developed. Wi-Fi and a browser are optional.
The complete command syntax and result contract are in
[SERIAL_CAN_CLI.md](SERIAL_CAN_CLI.md#detailed-command-contract).

## Capability boundary

Use this tool for OpenInverter-compatible parameter discovery, live reads,
controlled parameter changes, CAN mappings, diagnostics, and application updates
through the OpenInverter CAN bootloader. It does not compile ECU software,
provide a debugger, program a blank chip, install a bootloader, measure physical
outputs, or implement general UDS, XCP, CANopen NMT or arbitrary object transfers.

The named parameter API requires the ECU's OpenInverter JSON object at
`0x5001:0`. Raw expedited SDO does not require that database. A responding SDO
device does not automatically support metadata, save/load, start/stop, or this
bootloader. Use the ECU source and hardware documentation to establish support.

Physical serial access bypasses web users and roles. Keep the bridge on the
development bench. Actions already authorized in the development task can be
performed within that scope; do not ask again for every command. If a requested
test would additionally energize outputs, overwrite another device, erase
configuration, or flash a different image, establish that scope first.

## Bench profile: resolve before sending writes

Keep a per-bench profile outside shared documentation with these fields:

```json
{
  "port": "COM27",
  "baud": 115200,
  "bridge_target": "esp32_weact_cli",
  "can_kbps": 500,
  "can_tx_gpio": 27,
  "can_rx_gpio": 26,
  "node": 33,
  "expected_serial": "record the actual 0x5000:0 value here",
  "ecu_project": "absolute path to ECU source checkout",
  "application_base": "0x08001000",
  "firmware": "absolute path to the approved application binary",
  "firmware_sha256": "record the approved binary SHA-256 here",
  "allowed_operations": ["read", "flash approved application"],
  "allowed_parameter_writes": []
}
```

The GPIOs/node/base above describe the demonstrated Zombie-Slave bench; they are
not defaults for other ECUs. Verify transceiver wiring, common ground, bus
termination, bitrate, supply, and hardware variant for each bench. If outputs can
drive real actuators, use the bench's established isolation and measurement
arrangements. `stop` is a software command, not electrical isolation.

Record bridge and ECU revisions separately. Preserve the previous approved
application binary and its hash before updating. A parameter snapshot is not a
backup of the ECU executable. The CLI cannot read firmware back or restore a
missing bootloader; hardware debug/programming access is the recovery path for
an incompatible application/bootloader combination.

## Provision the bridge once

```sh
python -m pip install -r tools/requirements-cli.txt
pio run -e esp32_weact_cli
pio run -e esp32_weact_cli -t upload --upload-port COM27
```

This flashes the ESP32 bridge, not the ECU. The WeAct target keeps the CH343
console on UART0 and puts the inverter UART on UART1 RX16/TX17. Native USB S3 and
ordinary Wemos builds use the console ports described in the CLI reference.
Do not overwrite the WeAct build with a generic ESP32 OTA image when USB CLI
availability is required. No PC network change is required.

Repeated metadata refreshes on a classic ESP32 also need the streaming cache
memory fix tracked in [Cloudy PR #14](https://github.com/wjcloudy/esp32-web-interface/pull/14),
in addition to the CLI in [PR #15](https://github.com/wjcloudy/esp32-web-interface/pull/15),
until both are present in the chosen upstream revision. Record the exact commits
used in an integration build; do not silently substitute a different firmware.

Only one process may own the serial port. Close the IDE monitor before using the
client, and serialize access across agents/jobs with a bench lock. Do not run
web polling or another CAN controller's SDO client against this target during a
diagnostic/flash session. Shared bootloader IDs require a single intended
bootloader target on the bus.

## Identify the target before a test

All options precede the command:

```sh
python tools/oi_cli.py --port COM27 --json status
python tools/oi_cli.py --port COM27 --json scan 33 33
python tools/oi_cli.py --port COM27 --json node 33
python tools/oi_cli.py --port COM27 --json sdo read 0x5000 0
python tools/oi_cli.py --port COM27 --json db
python tools/oi_cli.py --port COM27 --json get version,canspeed,LVDU_12v_battery_voltage
```

Use narrow scan bounds when the bench profile already gives a node. Check
`status.can_mode`, `running`, `kbps`, `tx`, and `rx`, then compare the SDO serial
number against the bench profile. `status.running:true` only means that the
bridge driver is running. `node` selects a target; it does not renumber the ECU.
Repeat explicit selection after a bridge reboot because a GUI boot-default can
take precedence. After switching ECUs or firmware, refresh the database before
using names: `db refresh`.

If the bus configuration differs from the verified profile, the bridge-only
configuration command for this example is `bus 500 27 26`. It saves settings
and invalidates metadata. Do not cycle bitrates or GPIOs blindly on a live bus.
Use `transceiver PWR INV EN INV` only when the carrier's power/enable wiring is
known; inversion 0 drives HIGH, inversion 1 drives LOW, and -1 leaves a control
unused. Neither command changes the ECU's configured bitrate.

## Make evidence machine-readable

With `--json`, stdout is one envelope, for example:

```json
{"id":42,"ok":true,"result":"{\"version\":4.00000,\"canspeed\":2.00000}"}
```

First check the process exit code and `ok`, then parse `result` as JSON only for
commands that promise JSON. `errors`, upload acceptance, and command errors are
text. Exit 0 means a successful response, 1 a reported device error, and 2 a
local/transport problem. Usage errors also exit 2. `--json` does not convert
stderr errors into JSON. Store stderr and the exit status with stdout.

For subprocess calls use an argument array without a shell, preserve command
ordering, and use an outer timeout longer than the client's per-request timeout.
If an outer timeout kills a write/flash process, its outcome is unknown.

A persistent Python session avoids repeatedly opening the port:

```python
import json
import sys
from pathlib import Path
import serial

# Replace this with the absolute checkout path, not a downloaded script URL.
checkout = Path(r"C:\path\to\esp32-web-interface")
sys.path.insert(0, str(checkout / "tools"))
from oi_cli import Console

with serial.Serial(port=None, baudrate=115200, timeout=0.1,
                   write_timeout=5) as port:
    port.dtr = False
    port.rts = False
    port.port = "COM27"
    port.open()
    cli = Console(port, timeout=60)
    cli.checked("node 33")
    identity = json.loads(cli.checked("sdo read 0x5000 0")["result"])
    # Assert identity["raw"] equals the bench's known serial before any writes.
    metadata = json.loads(cli.checked("db")["result"])
    live = json.loads(cli.checked("get version,canspeed")["result"])
    print(json.dumps({"identity": identity, "live": live}, indent=2))
```

The context manager closes the port even on an exception. Do not share one
`Console` concurrently between threads. The client correlates random request
IDs, filters debug lines and never automatically retries an uncertain mutation.
See the wire contract for implementing a client in another language.

## Snapshot and design assertions

Before changing an application or configuration, collect:

1. Bridge `status`, target serial, ECU source commit/build configuration, image
   size and SHA-256, metadata (`db`), and fresh values for required signals.
2. Every entry with `isparam:true`, using fresh `get` or raw SDO reads rather
   than cached `db.value`. Batch named reads below the 1024-byte framed line
   limit and 128-name maximum. Store UID, raw value and engineering units.
3. `can list`, `errors`, and the test's measured starting state. Do not clear
   existing faults to make a result look clean.

Metadata provides `id`, `isparam`, `unit`, optional bounds/default/category,
and sometimes mapping information. Derive enums from the metadata/source;
version numbers can be enums rather than release strings. Stable assertions
use UIDs/names, not ordering in a JSON object. Virtual entries may lack a UID.
UID addressing is `0x2100 | (id >> 8)` with subindex `id & 255`.

For a read-only smoke test, use strict `get`/`sdo read`, require finite values,
check expected ranges and enum values, and compare error changes. Avoid exact
equality for ADC/physical measurements. Record a host monotonic timestamp for
each response: sequential reads are not synchronized acquisition.

`json` is convenient for a web-compatible whole-device overview, but its shared
backend can substitute zero after a failed read. Likewise, empty `can list` or
`errors` can be a traversal timeout. Pair such results with a successful strict
identity/signal read; use raw objects when strict end-of-table verification is
needed. There is no subscription/streaming command or deterministic sampling
frequency in the serial API.

## Controlled parameter and mapping changes

Make a test plan listing the exact permitted parameter names, values, target,
expected effect and restoration step. A broad read test does not require
`defaults`, `save`, `start`, `stop`, raw frame injection or output changes.

For an authorized parameter experiment:

1. Check identity and current value, validate `isparam:true`, range and unit.
2. Send `set NAME VALUE` once and require its acknowledgement.
3. Read back with `get NAME`; compare to the fixed-point quantized expectation
   (VALUE*32 truncated toward zero, then divided by 32), and observe the actual
   behavior required by the test.
4. Restore the captured value, read back, and use `save` only if persistent
   changes/restoration were intended. `load` discards RAM edits in favor of the
   target's saved settings. `defaults` is not an undo operation.

Use `sdo write` only for objects whose four-byte encoding is known; it accepts
arbitrary raw bits and does not enforce engineering units. A timeout after a
write means read back before deciding whether another write is appropriate.
An SDO acknowledgement alone does not verify an actuator's state.

For mapping tests, snapshot `can list`; use `can tx`/`can rx` with explicit bit
position, signed length, gain and offset. Verify the returned list and the
observed frame/consumer behavior. `can rm` addresses the current `index/subindex`
from that list, so re-list after removals. `can clear` removes every mapping.
Persistence via `save` and behavior after reboot depend on the ECU.

`send` proves queue acceptance, not target reception. `sniff` is a short,
consuming capture (40 frames maximum), without timestamps, filters, periodic TX,
triggering or loss accounting. Use a dedicated CAN interface for timing, load,
long traces and independent verification. `debug reset` actively resets the
ECU; use plain `sniff` when reset is not part of the test. `start [2]` and `stop`
are ECU commands, not standardized CANopen NMT transitions.

## Build, stage and flash an approved application

1. Build in the ECU's own checkout with its toolchain. Record source commit,
   compiler/configuration, hardware variant, application base and binary hash.
2. Check the image against that target's linker map/vector table and bootloader.
   Send raw application BIN only, 1..261120 bytes. Do not rename HEX/ELF to BIN.
   HEX conversion must explicitly validate the application address and fill gaps
   appropriately; an ESP32 firmware image belongs to the bridge, not the ECU.
3. Snapshot configuration and mappings, confirm identity and isolate the intended
   target on the shared bootloader IDs. Keep bench power stable.
4. Stage first; this step does not reset the ECU:

   ```sh
   python tools/oi_cli.py --port COM27 --json upload approved-application.bin
   ```

   The client checks every cumulative chunk position. `file finish` validates
   length and IEEE CRC32 and publishes `/cli-firmware.bin`. Staging is not proof
   of image compatibility. If staging fails, do not call bare `flash`: an older
   completed staged image can still be present.

5. Start and wait for the authorized update:

   ```sh
   python tools/oi_cli.py --port COM27 --json --wait flash
   ```

   Alternatively `--wait flash-local approved-application.bin` combines staging
   and flashing. Do not perform both alternatives for the same intended update.
   While updating, use only `status`, `help` or `flash-status`. Acknowledgement
   of `flash` only means started. Require `flash-status.state==3`,
   `page==pages`, and then verify the application separately.

6. After the target boots, recheck serial, actual version/build signature,
   strict raw/named reads, fresh metadata, configuration, mappings and relevant
   measured behavior. Do not automatically restore all old parameters onto a new
   schema: review renamed UIDs, units, ranges and defaults first.

For Python automation, `cli.upload(path)`, `cli.checked("flash")` and
`cli.wait_flash()` are the equivalent sequence. Hash the local file separately
before upload. The bridge verifies transport CRC and bootloader page acceptance;
it has no cryptographic ECU image readback. If old and new applications expose
the same version, report that limitation and preserve the protocol evidence.

## Failure handling

### Record a CAN test on SD and retrieve the artifact

Use `sd status` to distinguish an unsupported build, disabled boot setting and
an absent/unmounted card. Enable/mount only with verified SD_MMC wiring. Current
S3 builds skip this driver; an SPI-wired socket is not automatically supported.
See the [SD command contract](SERIAL_CAN_CLI.md#sd-card-logging-and-file-retrieval).

After identifying the ECU, a persistent client can record and fetch a test:

```python
# cli is the identified Console instance from the example above.
import time

sd = json.loads(cli.checked("sd status")["result"])
assert sd["mounted"], sd
recording = json.loads(cli.checked(
    "log start 500 version,canspeed,LVDU_12v_battery_voltage")["result"])
try:
    time.sleep(5)
finally:
    stopped = json.loads(cli.checked("log stop")["result"])
assert not stopped["active"] and not stopped["error"], stopped
assert stopped["rows"] > 0 and stopped["read_errors"] == 0, stopped
local = Path.cwd() / f"ecu-recording-{time.time_ns()}.csv"
artifact = cli.download(recording["path"], local)
print(artifact)
```

Select names supported by the actual ECU; these names are from the demonstrated
Zombie-Slave bench. Preserve the CSV and its SHA-256 with test results. Treat
`nan` as a missing measurement, not zero. Check actual `ms` spacing and record
host start/end timestamps; the logger does not guarantee precise sample timing
or a valid real-time clock. It records values, not all CAN frames.

`log stop` disables automatic restart for the current boot; `log auto` restores
the original UART auto-logging behavior. Neither control policy is persisted
across reboot. Inspect status after reconnecting. Reads/downloads require a
stopped recorder; there is no live tail or automatic log rotation for CAN CSV.
Do not start UART binary logging on a CAN-only connection. Never infer an SD
hardware pass solely from simulated filesystem tests or a successful build.

### Communication and recovery

| Symptom | Next action |
|---|---|
| Serial open fails | Resolve the owner/monitor and physical port; do not kill unrelated jobs |
| Serial response timeout | Inspect bridge/flash status; for mutations treat outcome as unknown, never blindly repeat |
| Scan empty / SDO timeout | Check verified wiring, supply, termination, selected bitrate/node and target boot; queue success is insufficient |
| `sdo_abort 0x...` | Record object address/code and consult ECU object implementation; distinguish unsupported object/range/state |
| Database download fails | Check strict identity first, correct firmware object support and memory-fix revision; do not invent parameter IDs |
| Upload length/CRC error | Abort/restart staging from byte zero; no chunk retry/resume is supported |
| No bootloader magic | Check expected bootloader and reset support; manual power-cycle only within the intended update/recovery procedure |
| Flash error / host wait timeout | Query `flash-status`, preserve logs and power; establish whether application or bootloader responds before another operation |
| Application fails after state 3 | Use bench recovery method/known compatible image; completion did not validate MCU/pin compatibility |

`auth reset` recovers bridge web accounts and reboots the ESP32. It neither
recovers an ECU bootloader nor clears ECU faults. Do not use it as a generic
communication retry. Do not reboot or reconfigure the bridge while a flash task
is active.

## Completion report for an agent run

Report the tested image hash/source revision, bridge revision, hardware/profile,
operations actually executed, exit codes/protocol completion, identity/version
before/after, parameter and mapping differences, observed faults and limitations.
Keep raw snapshots/transcripts in local run artifacts; publish only necessary
non-private results. Separate mocked/unit coverage from real hardware evidence.
Never claim output-control, timing, fault-injection or rollback coverage from a
successful read/flash smoke test alone.

An actual staged-serial/CAN update and post-flash read test is documented in
[the Zombie-Slave test report](testing/ZOMBIE_SERIAL_FLASH.md).
