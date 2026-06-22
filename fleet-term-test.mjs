import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

page.on('console', msg => console.log('[console]', msg.type(), msg.text()));
page.on('pageerror', err => console.log('[pageerror]', err.message));

await page.goto('http://localhost:9476/#/localhost/wt-ncfleet', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

await page.evaluate(() => {
  const el = document.getElementById('landing-overlay');
  if (el) el.hidden = true;
});

// Disable fleet-term via API then reload
await fetch('http://localhost:9476/api/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'plugin_fleet-term_enabled', value: false })
});

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const el = document.getElementById('landing-overlay');
  if (el) el.hidden = true;
});

let tabs = await page.locator('.panel-tab').allInnerTexts();
console.log('Tabs after disable:', tabs);

// Open settings and enable fleet-term by clicking the label
await page.click('#settings-toggle-btn');
await page.waitForTimeout(500);
await page.click('[data-target="plugins"]');
await page.waitForTimeout(500);

await page.evaluate(() => {
  const cb = document.querySelector('input[type="checkbox"][data-plugin="fleet-term"]');
  if (cb) {
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await page.waitForTimeout(1500);

// Close settings properly
await page.evaluate(() => {
  const panel = document.getElementById('settings-panel');
  const backdrop = document.getElementById('settings-panel-backdrop');
  if (panel) panel.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
});
await page.waitForTimeout(500);

tabs = await page.locator('.panel-tab').allInnerTexts();
console.log('Tabs after enable:', tabs);

const fleetTab = page.locator('.panel-tab[data-panel="fleet-term"]');
if (await fleetTab.count() > 0) {
  await fleetTab.click();
  await page.waitForTimeout(1000);
  
  const sessions = await page.locator('.fleet-term-session-item').allInnerTexts();
  console.log('Sessions count:', sessions.length);
  
  const loopSession = page.locator('.fleet-term-session-item[data-session="loop-skelcmp"]');
  if (await loopSession.count() > 0) {
    await loopSession.click();
    await page.waitForTimeout(2000);
    
    const xtermText = await page.evaluate(() => {
      const term = document.querySelector('.fleet-term-xterm .xterm-screen');
      return term ? term.textContent.slice(-300) : 'NO XTERM SCREEN';
    });
    console.log('XTERM TEXT:', xtermText);
  }
}

await browser.close();
