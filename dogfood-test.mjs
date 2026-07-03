import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })

const errors = []
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

await page.goto('http://localhost:9475/#/local/nanocode', { waitUntil: 'networkidle' })
await page.waitForTimeout(3000)
await page.screenshot({ path: '/tmp/dog-02-workspace.png', fullPage: false })

const agentToggle = await page.$('#agent-drawer-toggle')
if (agentToggle) {
  await agentToggle.click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '/tmp/dog-03-agent-drawer.png', fullPage: false })
  const drawerText = await page.$eval('#agent-drawer', el => el.innerText)
  console.log('=== AGENT DRAWER TEXT ===')
  console.log(drawerText.substring(0, 4000))
}

const stopBtns = await page.$$('.subagent-stop-btn')
for (const btn of stopBtns) {
  const text = await btn.textContent()
  console.log('STOP BTN TEXT:', JSON.stringify(text))
}

await page.keyboard.press('Escape')
await page.waitForTimeout(500)
const settingsBtn = await page.$('#settings-btn')
if (settingsBtn) {
  await settingsBtn.click()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: '/tmp/dog-04-settings.png', fullPage: false })
  const settingsText = await page.$eval('#settings-panel', el => el.innerText)
  console.log('\n=== SETTINGS TEXT ===')
  console.log(settingsText.substring(0, 3000))
}

console.log('\n=== CONSOLE ERRORS ===')
for (const e of errors) console.log(e)

await browser.close()
