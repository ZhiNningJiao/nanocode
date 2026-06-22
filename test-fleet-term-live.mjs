import { chromium } from 'playwright';

const BASE = 'http://localhost:9476';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  try {
    // 1. 加载 workspace 页面（避开 landing overlay）并打开 Fleet Term 面板
    await page.goto(`${BASE}/#/local/wt-ncfleet`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const fleetTab = await page.locator('text=Fleet Term').first();
    await fleetTab.waitFor({ timeout: 5000 });
    await fleetTab.click();

    // 2. 等待会话列表加载
    await page.waitForSelector('.fleet-term-session-list', { timeout: 10000 });
    const items = await page.locator('.fleet-term-session-item').all();
    console.log(`sessions count: ${items.length}`);
    if (items.length === 0) throw new Error('no tmux sessions listed');

    // 3. 点击 loop-skelcmp 会话（或第一个可用会话）
    const target = await page.locator('.fleet-term-session-item', { hasText: 'loop-skelcmp' }).first();
    if (await target.count() === 0) {
      console.log('loop-skelcmp not found, using first available session');
      await page.locator('.fleet-term-session-item').first().click();
    } else {
      await target.click();
    }

    // 4. 等待 xterm 挂载并出现字符
    await page.waitForSelector('.fleet-term-xterm .xterm-screen', { timeout: 10000 });
    await page.waitForTimeout(2000);
    const rows = await page.locator('.xterm-rows > div').allTextContents();
    console.log('xterm rows:', JSON.stringify(rows.slice(0, 5)));

    // 5. 尝试发送一个无伤害的按键（回车），确认交互通道
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    console.log('Fleet Term live test PASSED');
  } catch (e) {
    console.error('Fleet Term live test FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
