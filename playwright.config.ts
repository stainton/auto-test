import { defineConfig } from '@playwright/test';

/**
 * Generated specs live under `specs/<plan-dir>/` (one file per scenario) plus the repo-root
 * `seed.spec.ts`. They may share server-side state (same account, same fixture folder on the
 * SUT), so they run **serially** — parallel workers would corrupt each other's scenario data.
 *
 * `retries: 0` locally on purpose: a retry re-runs the whole test, re-doing login and
 * precondition construction — pure wasted time during generation/healing. The agents re-run a
 * single test explicitly instead. CI can opt into a retry for a stable suite.
 *
 * `baseURL` is taken from `BASE_URL` when set; specs that target a fixed remote host define
 * their own URL constant and do not depend on it.
 */
export default defineConfig({
  testDir: '.',
  testIgnore: ['node_modules/**', 'review/**', 'test-site/**', 'playwright-report/**'],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  // `list` for fast inline progress during a run; `html` written but never auto-opened.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL,
    trace: 'on-first-retry',
    // Steps attach their own screenshots; skip Playwright's implicit end-of-test capture.
    screenshot: 'off',
    video: 'off',
  },
});
