# Contributing

Thanks for contributing! This repo has an automated test suite that runs on
every pull request — here's how to work with it locally.

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

## Firmware changes

`build.yml` compiles both targets (`esp32_wemos`, `esp32_t2can`) on every PR
— a change that doesn't compile for either board will fail CI. Test on real
hardware where you can; note in the PR which backend (UART / CAN) you tested.

## Releases

Tag `vX.Y` on `main` and CI attaches full-flash and OTA images for both
boards to a GitHub release.
