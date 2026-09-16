import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    channel: process.env.CI ? undefined : 'chrome',
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
  webServer: {
    command: 'npm run dev -- --port 4178',
    url: 'http://127.0.0.1:4178/ui/client/',
    reuseExistingServer: !process.env.CI,
  },
});
