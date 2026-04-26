import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  // E2E test files location
  testDir: './tests/e2e',

  // Run tests in files in parallel
  fullyParallel: true,

  // Retry once on CI to reduce flakiness
  retries: process.env.CI ? 1 : 0,

  // Fail the build early on CI if any test fails
  forbidOnly: !!process.env.CI,

  // Workers: single worker locally to avoid port conflicts, all on CI
  workers: process.env.CI ? '50%' : 1,

  // Output: record video on first retry only (keeps disk usage low)
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    video: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  // Single Chromium project — add firefox/webkit in projects array when needed
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Automatically start the Vite dev server before tests
  webServer: {
    command: 'npm --prefix frontend run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
