# Testing the "Download & install" update path

The Update page's **Download & install** has the ESP fetch a combined OTA
image itself (`POST /espupdate-url`) and flash it as it arrives. It's the path
most users update by, and a broken one can only be recovered with a file
upload or USB, so test it on real boards before any change to it reaches the
Stable channel. The mock ESP and the E2E suite don't cover it: they never run
the firmware's downloader.

The downloader is `espOtaGet()` / `espOtaDownloadTask()` in
`esp32-web-interface.ino`; its URL, redirect and header parsing are in
`src/web_logic.h` with native tests (`test/test_web_logic`).

## Setup

- A classic ESP32 (UART backend) and an ESP32-S3 (T-2CAN, CAN backend) on the
  bench network. Sign-in off, or run the requests from a signed-in admin
  session (the endpoint is admin-only).
- Before each board: note `/version`, save `/settings` and `/wifi-status`, and
  export a settings backup from the Update page.
- For the local cases: `python scripts/ota_test_server.py <combined -ota.bin> 8099`
  on a PC on the same network (allow it through the PC's firewall).

Requests below are `curl -X POST http://BOARD/espupdate-url --data-urlencode url=...`,
then poll `GET /espupdate-status` (`state` 1 = downloading, 2 = done, 3 = error;
`pct`; `message`).

## 1. Get the build under test onto the board

Publish it as a dev release (push to `dev` without `[skip release]`), then on
the board: Update tab → channel **Dev** → **Get releases** → pick it →
**Download & install**. This uses the board's *current* downloader.

## 2. Error cases (on the build under test)

Each must end in state 3 with the message shown, flash nothing, and leave the
board running and serving pages.

| # | URL | Expected message |
|---|---|---|
| E1 | a release download URL for a file that doesn't exist | `Download HTTP 404` |
| E2 | a release's full-flash `…-0x000.bin` (not a combined OTA image) | `Not a combined OTA image` |
| E3 | `https://192.168.1.250/x.bin` (no such host) | `Could not connect to 192.168.1.250` |
| E4 | `ftp://example.com/x.bin` | `Unsupported download URL` |
| E5 | `http://PC:8099/loop` (redirects to itself) | `Too many redirects` |
| E6 | `http://PC:8099/stall` (4 KiB, then silence) | `Download stalled (no data for 30s)` after ~30 s |
| E7 | a second request while one is downloading | HTTP 409, the first carries on |

## 3. Local happy path (plain HTTP, a port, redirects)

`http://PC:8099/r` (relative redirect) and `http://PC:8099/abs` (absolute,
with the port): the server log shows `GET /fw.bin HTTP/1.0` with
`Host: PC:8099`, `pct` climbs to 100, the board reboots on that image.

## 4. GitHub happy path (the real one)

From the build under test, install the *next* dev release through the Update
page as in step 1. Expect: `pct` climbs steadily (the CDN's Content-Length was
read after GitHub's 302), the board reboots, `/version` shows the new release,
and `/settings` matches what was saved before (CAN/UART mode, pins, node),
with users and layouts still there.

Repeat on the other board: the classic ESP32 matters most, since its app
partition is the tightest.
