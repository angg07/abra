import { defineConfig, devices } from '@playwright/test';
import { blockArgs, productionHostsFromSettings } from './app/guard.cjs';

if (!process.env.E2E_APP) try { process.loadEnvFile(); } catch {} // CLI runs read .env; the app passes only what a project may use

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0, // one retry on CI; a pass on retry is reported as flaky
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL,
    headless: Boolean(process.env.CI), // headed locally so you can watch; headless on CI servers (no screen)
    launchOptions: { slowMo: Number(process.env.SLOWMO ?? (process.env.CI ? 0 : 300)), args: blockArgs(productionHostsFromSettings()) }, // production addresses never resolve (app/guard.cjs) // ponytail: slowMo so you can watch the flow; SLOWMO=0 for speed
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
