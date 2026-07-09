// Lint config for the first-party frontend (data/app.js, data/sw.js) and the
// test suite. The shipped app has no build step: it's plain scripts sharing
// the global scope, with vendored UMD libraries providing globals. That makes
// no-undef the single most valuable rule here — a typo'd identifier otherwise
// only fails at runtime in the browser.
import js from '@eslint/js';

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  location: 'readonly', history: 'readonly', localStorage: 'readonly',
  fetch: 'readonly', FormData: 'readonly', Blob: 'readonly', File: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', AbortController: 'readonly',
  XMLHttpRequest: 'readonly', WebSocket: 'readonly', EventSource: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  console: 'readonly', performance: 'readonly',
  FileReader: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
  ResizeObserver: 'readonly', getComputedStyle: 'readonly',
};

export default [
  {
    // Vendored/generated assets are not ours to lint
    ignores: [
      'data/preact.umd.js', 'data/preact-hooks.umd.js', 'data/htm.umd.js',
      'data/nosleep.js', 'data/docstrings.js',
      'node_modules/**', '.pio/**', 'playwright-report/**', 'test-results/**',
    ],
  },
  {
    files: ['data/app.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...browserGlobals,
        // UMD globals loaded by index.html before app.js
        preact: 'readonly',
        preactHooks: 'readonly',
        htm: 'readonly',
        docstrings: 'readonly',
        Chart: 'readonly',
        NoSleep: 'readonly',
        GridStack: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Existing style in this codebase — not worth failing contributors over
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'off', // defensive regex escapes are pervasive here
      'no-case-declarations': 'off', // reducer switch style
    },
  },
  {
    files: ['data/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { self: 'readonly', caches: 'readonly', fetch: 'readonly', console: 'readonly' },
    },
    rules: { ...js.configs.recommended.rules },
  },
  {
    files: ['tests/**/*.mjs', 'tests/**/*.js', 'playwright.config.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly', fetch: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        // page.evaluate(() => ...) callbacks execute in the browser
        document: 'readonly', window: 'readonly', localStorage: 'readonly', getComputedStyle: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Playwright fixture signature: async ({}, use) => ...
      'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }],
    },
  },
];
