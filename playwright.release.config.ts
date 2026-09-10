import {defineConfig} from '@playwright/test';
export default defineConfig({
 outputDir:'release-test-results',testDir:'./tests',
 testMatch:['**/release.spec.ts','**/files-ai.spec.ts'],
 timeout:60000,expect:{timeout:15000},
 use:{baseURL:'http://127.0.0.1:1423',launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}},
 webServer:{command:'npm run build && npm run preview -- --host 127.0.0.1 --port 1423 --strictPort',url:'http://127.0.0.1:1423',timeout:180000},
});
