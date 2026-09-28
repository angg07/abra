// Config used when the app replays saved tests: headless, with a debugging port so the app can
// stream and record the browser. Everything else (baseURL, timeouts, .env) comes from the main config.
import { defineConfig, devices } from '@playwright/test';
import base from '../playwright.config';
import { blockArgs, productionHostsFromSettings } from './guard.cjs';

const width = Number(process.env.REPLAY_W ?? 1280);
const height = Number(process.env.REPLAY_H ?? 800);

export default defineConfig({
  ...base,
  testDir: process.env.REPLAY_TESTDIR || '../tests', // the app verifies AI fixes from another folder
  outputDir: './data/replay-results',
  retries: 0,
  workers: 1, // one browser, so the live view follows the tests in order
  fullyParallel: false,
  reporter: [['list'], ['./steps-reporter.cjs'], ['json', { outputFile: process.env.REPLAY_REPORT ?? './data/replay-report.json' }]],
  use: {
    ...base.use,
    headless: true,
    video: 'off', // the app records the live view instead
    storageState: process.env.REPLAY_STORAGE || undefined,
    launchOptions: {
      slowMo: Number(process.env.REPLAY_SLOWMO ?? 0),
      args: [`--remote-debugging-port=${process.env.REPLAY_CDP_PORT ?? 9334}`, ...blockArgs(productionHostsFromSettings())],
    },
  },
  // REPLAY_DEVICE: a mobile profile (user agent, pixel ratio, touch), still run in Chromium like the live view
  projects: [{ name: 'chromium', use: { ...devices[process.env.REPLAY_DEVICE || 'Desktop Chrome'], browserName: 'chromium', viewport: { width, height } } }],
});
