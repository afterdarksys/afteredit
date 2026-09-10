import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests',
  testIgnore:['**/extensions.spec.ts','**/release.spec.ts'],
  expect:{timeout:15000},
  timeout:60000,
  use:{launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE},baseURL:'http://127.0.0.1:1420',viewport:{width:1280,height:900}},
  webServer:{command:'npm run dev -- --host 127.0.0.1',url:'http://127.0.0.1:1420',reuseExistingServer:!process.env.CI},
});
