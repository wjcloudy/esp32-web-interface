# Contributing

Thanks for contributing! This repo has an automated test suite that runs on
every pull request — here's how to work with it locally.

## Bring your feature back here

Please open a pull request rather than keeping your changes in a fork. A
handful of forks that each fix one thing and drift apart is how the ESP32 web
interface ended up with several half-compatible versions; every user then has
to pick which bugs they'd rather have. One shared version, tested by everyone's
hardware, is better for all of us.

- **Open the PR against `dev`.** Every PR runs the full suite (lint, E2E,
  firmware unit tests, all four firmware builds) and builds images for both
  boards, so it can be reviewed and tried quickly. Merged work reaches users as
  a dev pre-release on the next push, and in the next stable release after that.
- **Small and focused beats big and complete.** One feature or fix per PR. A
  large change is welcome too: open an issue or a draft PR early so the design
  can be agreed before you've written it all.
- **Unsure it fits?** Ask in an issue or on the
  [openinverter.org forum thread](https://openinverter.org/forum/viewtopic.php?p=95039#p95039).
  Something specific to your setup can usually go in as an option that's off
  by default, rather than a fork.
- **Not a coder?** Bug reports with steps to reproduce, and testing dev builds
  on your hardware, are just as valuable. Switch the Update page to the **Dev**
  channel to get them.

## Keeping features modular

The app is built so most features plug in at one well-defined place without
touching the rest. Following these keeps a PR easy to review and keeps other
people's work merging cleanly.

| You're adding | Put it here | Notes |
|---|---|---|
| Something to show live (a gauge style, a readout, a panel) | **A tile type** in `data/app.js`: a renderer component, an entry in the type list of the tile settings modal and, for panels, in `WIDGET_TYPES` | Tiles work on the Dashboard and every gauge page, are laid out by the grid editor and saved in `gauges.json`. Don't add a new tab for something a tile can do |
| A whole new screen | A tab: a component, an entry in `tabs` and in `TAB_GROUPS` (sidebar section) | Use the existing pieces (`.dash-box` cards, `.seg` switchers, `button.primary`), not new one-off styles |
| A device setting | `saveSettings()` / `loadSettings()` / `handleSettings()` in the firmware, plus the Settings tab | `settings.json` is mirrored into NVS, so it survives updates for free. Keep old settings files loading: absent keys mean "the old default" |
| A UI preference | `uiprefs.json` (see `saveUiPrefsToDevice()`) | Also kept across updates |
| A new HTTP endpoint | A row in `weblogic::ROUTES` (`src/web_logic.h`) with the right role, then the handler | Every request goes through the router; `scripts/test_route_guard.py` fails if a handler isn't in the table. Writes need operator, device/firmware changes need admin |
| Parsing or validating input on the ESP | A function in `src/web_logic.h`, with tests in `test/test_web_logic` | Keep it free of hardware calls and globals so it builds and fuzzes on the host |
| A new inverter/VCU command or value | Nothing: the UI reads parameters and spot values from the device | Use names, not positions, and cope with firmware that lacks a value ("—") |
| Board-specific behaviour | A board preset (`CAN_BOARD_PRESETS`, `UART_BOARD_PRESETS`), a build flag in `platformio.ini`, or a runtime setting | Never a fork for one board. Prefer runtime settings; build flags only when it can't be decided at runtime |
| Colours, spacing, type | The design tokens at the top of `data/style.css` | See [doc/REDESIGN.md](doc/REDESIGN.md). Both themes, and 4.5:1 contrast for small text |

General rules:

- **Off by default, opt in.** A new behaviour that changes what existing users
  see or what the device does should be an option, unless it's clearly a fix.
- **Data formats are versioned and migrate forward.** `gauges.json` has a `v`
  (currently 4) and `migrateGauges()` upgrades older layouts. Bump it and add a
  migration rather than breaking files people already have; the same goes for
  settings.
- **The device is the source of truth for permissions.** Hiding a button is a
  courtesy; the route table is the enforcement.
- **Mind the space.** The classic ESP32 app partition is over 90% full; say in
  the PR what your change adds to firmware and filesystem size.
- **Tests come with the feature.** An E2E test against the mock ESP for UI
  behaviour (keep `tests/mock-esp/server.mjs` faithful to the firmware), a
  native test for firmware logic. Bug fixes get a test that fails without the
  fix.

## Setup

- [Node.js](https://nodejs.org/) 20+ (for lint + E2E tests)
- [PlatformIO](https://platformio.org/) (to build/flash the firmware)
- Python 3 (asset tooling; ships with PlatformIO)

```sh
npm install
npx playwright install chromium
```

## Running the checks

Everything CI runs, in one go:

```sh
npm test
```

Or individually:

| Command | What it does |
|---|---|
| `npm run lint` | ESLint over `data/app.js`, `data/sw.js` and the test suite. Catches typo'd identifiers — the app is a no-build global-scope script, so these otherwise only explode at runtime. |
| `npm run check:gz` | Fails if any `data/*.gz` is stale. If you edit a file in `data/`, regenerate its `.gz` twin with `python gzip_assets.py` (any `pio run` does it too) and commit both. |
| `npm run test:e2e` | Playwright drives the real UI in headless Chromium against a **mock ESP** (`tests/mock-esp/server.mjs`) that implements the firmware's HTTP API and a simulated inverter speaking the protocol in `PROTOCOL.md`. |
| `npm run mock` | Runs the mock ESP at http://127.0.0.1:8765 so you can develop the UI with no hardware. |
| `pio test -e native` | Host unit tests for the firmware's pure logic in `src/web_logic.h` and `src/web_auth.h` (query parsing, input validation, OTA header, UART reply framing, permission tables, password hashing, sessions, fuzz loops). Needs a host gcc/g++ — on Windows use WSL or Docker. `-e native_asan` runs them under AddressSanitizer + UBSan (Linux/macOS). |

`npm test` doesn't include the native tests. CI also runs `npm audit --audit-level=high`, and CodeQL over the C/C++ firmware, the JavaScript and the workflows. Dependabot raises alerts only (no automatic PRs).

**Firmware logic that parses untrusted input** (HTTP query strings, uploads, settings files, UART replies) belongs in `src/web_logic.h`, with tests in `test/test_web_logic`. Keep it free of hardware calls and globals so it builds on the host. Accounts, password hashing, sessions and the sign-in limiter live in `src/web_auth.h` (tests in `test/test_web_auth`).

**New HTTP endpoints** must be registered with `route()` (never `server.on()`) and listed in `weblogic::ROUTES` in `src/web_logic.h` with the permission they need (viewer/operator/admin); a path missing there is admin-only. Mirror the entry in `tests/mock-esp/auth.mjs` — `scripts/test_route_guard.py` and the mock-contract spec fail otherwise. New terminal commands are operator-only unless added to `cmdPerm`'s read-only allowlist.

## Writing E2E tests

Specs live in `tests/e2e/*.spec.mjs`. Use the shared fixtures:

```js
import { test, expect, openApp, gotoTab } from './fixtures.mjs';

test('my feature', async ({ page, mock }) => {
  await openApp(page, mock);      // navigates + waits for first data fetch
  await gotoTab(page, 'Parameters');
  // drive the UI ...
  expect(await mock.commands()).toContain('set fweak 42'); // assert what reached the inverter
});
```

- Each test gets its **own mock ESP** on a random port — no shared state.
- Any uncaught browser error fails the test automatically.
- `mock.commands()` returns every serial command the "inverter" received;
  `mock.state()` dumps parameters, uploaded files and settings — assert
  effects, not just UI appearance.

If you add UI behaviour, add a spec. If you fix a bug, add the spec that
would have caught it.

- The mock must answer like the firmware does: when a handler in
  `esp32-web-interface.ino` changes its reply, update the mock and
  `tests/e2e/mock-contract.spec.mjs` with it. `mock.enableCan()` switches it
  to the CAN backend's reply formats; the SSE stream runs on its own port
  (`mock.ssePort`), like the firmware's :81 listener.
- Wait on state, not time: `expect(...)`/`expect.poll(...)` on the DOM or
  `mock.state()`. Locally tests run with no retries so flakes show up; CI
  retries twice and reports passes-on-retry as flaky.
- A known app bug gets a `test.fixme` with a comment naming the code, so it
  is tracked and flips to a real test once fixed.

## Firmware changes

`tests.yml` compiles all five PlatformIO environments (release and debug for
`esp32_wemos` and `esp32_t2can`, plus `esp32_weact_cli`, the only build with the
serial console) and builds the SPIFFS image on every PR — a change that doesn't
compile for any of them will fail CI. `build.yml` builds
the release images. Test on real
hardware where you can; note in the PR which backend (UART / CAN) you tested.

## Branches and releases

- **`dev`** is the working branch. Open PRs against it (or push to it);
  every PR runs the full suite (lint, E2E, firmware compile matrix). Every
  push to `dev` runs the full suite and, if it's green, publishes a **dev
  pre-release** (see below).
- **`main`** is the release branch. Changes reach it by a PR from `dev`, which
  must pass the required checks. Every push to `main` runs the full suite
  again and, if it's green, automatically tags the next `vX.Y` (minor + 1),
  builds full-flash and OTA images for both boards and publishes them as a
  GitHub release with generated notes (edit the notes afterwards if needed).
- Put `[skip release]` in the head commit message to land on `dev` or `main`
  without releasing. Pushing a `v*` tag by hand still releases that exact tag
  (as a pre-release if it has a suffix, e.g. `v4.24-dev.3`).

### Update channels: stable and dev

Both channels are GitHub releases with the same four images; they differ in
version scheme and flags (`.github/workflows/build.yml`, numbering in
`scripts/release_version.py`):

| Channel | Published by | Version | GitHub flags |
|---|---|---|---|
| Stable | push to `main` | `vX.Y` — minor + 1 of the newest **stable** tag | Latest |
| Dev | push to `dev` | `vX.Y-dev.N` — a preview of the *next* stable `vX.Y`, N = 1, 2, … | pre-release, never Latest |

So versions order as `v4.23 < v4.24-dev.1 < v4.24-dev.2 < v4.24 < v4.25-dev.1`:
dev tags never bump the stable number, and once `v4.24` ships the next dev
push starts `v4.25-dev.1`. A dev push whose commit is already a stable
release (main merged back into dev) publishes nothing. After each dev
release, all but the newest 5 dev pre-release **pages** are deleted; their
tags stay (dev numbering counts them, and any build can still be checked
out). Stable releases are never pruned. Release builds pass the exact
version to `version.py` (`WEB_VERSION_OVERRIDE`) instead of relying on
`git describe`, since one commit can carry both a dev and a stable tag.

In the web UI (Update tab → **Update channel**, stored in the browser and in
the device's `uiprefs.json` like the daily-check toggle):

- **Stable** (default): the daily check asks GitHub for `/releases/latest`
  (never a pre-release); **Get releases** hides pre-releases.
- **Dev**: the check reads the `/releases` list and takes the newest version
  of *all* of them, so a dev device gets each preview and then the stable
  release that follows; **Get releases** lists pre-releases too, newest
  version first.

Only tags shaped `vX.Y`, `vX.Y.Z` or `vX.Y-dev.N` are ever accepted from the
API. The running version may also be a `git describe` form
(`v4.24-dev.3-2-gabc1234`), which sorts after its tag and before the next
release. Version-script tests: `npm run test:scripts`.
