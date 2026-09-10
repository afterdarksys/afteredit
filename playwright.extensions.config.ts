import {defineConfig} from '@playwright/test';
export default defineConfig({
 outputDir:'extension-test-results',
 testDir:'./tests',testMatch:'**/extensions.spec.ts',timeout:180000,expect:{timeout:15000},
 use:{baseURL:'http://127.0.0.1:1422',launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}},
 webServer:{command:'npm run build && npm run preview -- --host 127.0.0.1 --port 1422 --strictPort',url:'http://127.0.0.1:1422',timeout:180000},
});
