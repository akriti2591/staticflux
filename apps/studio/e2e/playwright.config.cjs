// Playwright config for the Studio smoke test (CommonJS so the globally installed
// `playwright` resolves via NODE_PATH; no project dependency needed).
// Run: NODE_PATH=$(npm root -g) npx playwright test -c e2e/playwright.config.cjs
const { defineConfig, devices } = require('playwright/test');

const port = Number(process.env.STUDIO_PORT ?? 5199);

module.exports = defineConfig({
  testDir: __dirname,
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    cwd: require('node:path').resolve(__dirname, '..'),
    url: `http://localhost:${port}/`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
