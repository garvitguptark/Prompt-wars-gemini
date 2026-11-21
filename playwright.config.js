// Browser tests: the real page in Chromium, desktop and phone, against the real server with the API stubbed.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8099', trace: 'off' },
  webServer: { command: 'node server.js', env: { PORT: '8099' }, url: 'http://127.0.0.1:8099/health', reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
