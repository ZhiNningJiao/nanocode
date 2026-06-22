import { chromium } from 'playwright';

const page = await (await chromium.launch({ headless: true })).newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://localhost:9476/#/local/wt-ncfleet', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('text=Fleet Term').first().click();
await page.waitForSelector('.fleet-term-session-list', { timeout: 10000 });
await page.locator('.fleet-term-session-item', { hasText: 'loop-skelcmp' }).first().click();
await page.waitForSelector('.fleet-term-xterm .xterm-screen', { timeout: 10000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/fleet-term-9476.png', fullPage: false });
console.log('screenshot saved');
await page.context().browser().close();
