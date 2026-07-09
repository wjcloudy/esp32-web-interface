import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  timeout: 30000,
  use: {
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
});
