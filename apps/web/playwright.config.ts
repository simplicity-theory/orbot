import { defineConfig, devices } from '@playwright/test';

/**
 * UI flows against a real API on throwaway *_test databases, seeded with the demo force.
 * Starts its own API (:3100) and web dev server (:4300); never touches dev data.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:4300',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/commander.json' },
      dependencies: ['setup'],
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], storageState: 'e2e/.auth/commander.json' },
      dependencies: ['setup'],
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'npm run e2e-server -w @orbot/api',
      cwd: '../..',
      url: 'http://localhost:3100/api/health',
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: 'npx ng serve --port 4300 --proxy-config proxy.e2e.conf.json',
      url: 'http://localhost:4300',
      timeout: 180_000,
      reuseExistingServer: false,
    },
  ],
});
