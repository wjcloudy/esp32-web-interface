# Real SD recording and serial download smoke test

Date: 2026-11-14 (Europe/Berlin).

## Bench

- WeAct classic ESP32 / CH343, serial 115200 baud.
- SD_MMC 1-bit default wiring: CLK14, CMD15, DAT0 GPIO2.
- Existing nominal 64 GB card mounted successfully; reported filesystem capacity
  64,005,144,576 bytes. No card formatting was performed.
- CAN target node 33, 500 kbit/s, TX27/RX26, Zombie-Slave version `4 = 2.20.R`.
- Installed local integration: CLI/SD `ae8d3cc` plus heap fix `721408d`, version
  `v4.28-cli-sd-ae8d3cc-mem721408d`.

## Procedure and observations

1. `sd status` initially reported supported, disabled and unmounted. Used
   `sd enable 1`, `sd mount` and polled status until mounted/init_done were true.
2. `sd list 0 16` successfully listed the root without changing existing files.
3. `log start 500 version,canspeed`, followed by `log stop`, produced eight rows
   with no read/write errors. The CSV header was `ms,version,canspeed` and rows
   contained expected engineering values 4 and 2 at elapsed times 500..4000 ms.
4. Downloaded that closed file through `Console.download()`: 187 bytes, checked
   chunk CRC, exact size and final metadata; parsed all CSV rows successfully.
5. Ran a second recording at 100 ms to exercise a file larger than one serial
   read chunk: 71 rows / 1,502 bytes. Download used two bounded reads (1,024 and
   478 bytes), passed CRC/offset/length/EOF checks and size/mtime consistency,
   and every downloaded row contained the expected version/bitrate values.
6. Target identity and strict named reads continued to work after recording.
   Wi-Fi stayed connected; the PC network was not switched.

| Remote file | Rows | Bytes | Download SHA-256 |
|---|---:|---:|---|
| `/can-33695-0.csv` | 8 | 187 | `4cf74ad4053f907dd5634483373f5c1e6f103692145422409d598734e365dc93` |
| `/can-106829-0.csv` | 71 | 1502 | `62913e49b3864e09facd30a6f863ed570f35af1dafb950e00205e5024a869f5c` |

The logger is stopped. SD remains enabled and mounted for development; both
recordings remain on the card. Existing card contents were not deleted. The
local raw transcripts/downloads are run artifacts, not committed private data.

## Automated coverage and limits

82 native C++ tests pass, including the actual SD command/CSV implementation
against a simulated filesystem. Tests cover bounds, path traversal, CRC output,
pagination, 64-bit capacity, strict value reads, `nan` on CAN failure, low space,
short writes and recording stop behavior. 36 Python tests pass, including binary
download bytes/SHA-256, multiple chunks, empty files, corruption, truncation,
wrong offsets, changed metadata, no overwrite and temporary-file cleanup.
GitHub also passes the native tests under ASan/UBSan, all four existing firmware
targets and the full browser suite for this source revision.

The real test proves CAN CSV recording and stopped-file download on this card
and board. It does not prove synchronized sampling, a throughput guarantee,
long-term endurance, power-loss recovery, large-file limits, card removal during
writing, or high-speed UART binary logging on a UART-connected target. Current
S3 builds still deliberately disable SD_MMC. Download CRC validates transferred
chunks; local SHA-256 is not an independent whole-file hash calculated on the SD.
