import { chromium } from 'playwright'

const PORT = 9475
const BASE = `http://localhost:${PORT}`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })

const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`))

// 1. Load landing, list projects
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
const projects = await page.evaluate(() => fetch('/api/projects').then(r => r.json()))
console.log('PROJECTS:', JSON.stringify(projects.map(p => ({ name: p.name, cwd: p.cwd, id: p.id })), null, 1))

// pick first project
const proj = projects[0]
if (proj) {
  const host = proj.ssh_host ? proj.ssh_host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'local'
  const baseName = proj.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
  await page.goto(`${BASE}/#/${host}/${baseName}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: '/tmp/dogfood-workspace.png' })
  console.log('SCREENSHOT: workspace saved')

  // dump tab strip
  const tabStrip = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.tab-chip')]
    return chips.map(c => ({
      label: c.querySelector('.tab-chip-label')?.textContent,
      type: [...c.classList].find(c => c.startsWith('tab-chip-'))?.replace('tab-chip-', ''),
      active: c.classList.contains('active'),
    }))
  })
  console.log('TABS:', JSON.stringify(tabStrip))

  // 2. Open agent drawer
  await page.click('#agent-drawer-toggle')
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '/tmp/dogfood-agent-drawer.png' })

  // dump agent drawer content
  const drawerContent = await page.evaluate(() => {
    const list = document.getElementById('agent-list')
    if (!list) return 'NO agent-list element'
    const sections = [...list.children].map(s => ({
      cls: s.className,
      text: s.textContent?.slice(0, 200),
      childCount: s.children.length,
    }))
    return sections
  })
  console.log('DRAWER SECTIONS:', JSON.stringify(drawerContent, null, 1))

  // dump tmux sessions in drawer
  const tmuxItems = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.tmux-session-item')]
    return items.map(it => ({
      name: it.querySelector('.tmux-session-name')?.textContent,
      badge: it.querySelector('.tmux-session-badge')?.textContent,
      preview: it.querySelector('.tmux-session-preview')?.textContent?.slice(0, 100),
      connectBtn: it.querySelector('.tmux-session-connect')?.textContent,
    }))
  })
  console.log('TMUX ITEMS:', JSON.stringify(tmuxItems.slice(0, 8), null, 1))
  console.log('TMUX COUNT:', tmuxItems.length)

  // Close drawer
  await page.click('#agent-drawer-close')
  await page.waitForTimeout(500)

  // 3. Open settings
  const settingsBtn = await page.$('[id*="settings"], .settings-btn, [data-settings]')
  // Try opening via gear icon or keyboard
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  // Find settings button
  const settingsSel = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, [class*="settings"]')]
    return btns.map(b => ({ tag: b.tagName, cls: b.className, id: b.id, text: b.textContent?.slice(0, 30) })).filter(b => b.cls.includes('setting') || b.id.includes('setting') || (b.text && b.text.toLowerCase().includes('setting')))
  })
  console.log('SETTINGS BUTTONS:', JSON.stringify(settingsSel))

  // Try clicking settings gear
  const gear = await page.$('.settings-btn, #settings-toggle, [class*="gear"], button[class*="setting"]')
  if (gear) {
    await gear.click()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: '/tmp/dogfood-settings.png' })

    // dump settings tab-type checkboxes
    const tabTypes = await page.evaluate(() => {
      const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')]
      return checkboxes.map(c => ({
        id: c.id,
        checked: c.checked,
        label: c.closest('label')?.textContent?.slice(0, 50) || c.parentElement?.textContent?.slice(0, 50),
      })).filter(c => c.id?.includes('tab') || c.label?.toLowerCase().includes('tab') || c.id?.includes('type'))
    })
    console.log('TAB TYPE CHECKBOXES:', JSON.stringify(tabTypes))

    // full settings content for analysis
    const settingsHTML = await page.evaluate(() => {
      const panel = document.querySelector('.settings-panel, #settings-panel, [class*="settings-panel"]')
      return panel ? panel.innerHTML.slice(0, 3000) : 'NO settings panel found'
    })
    console.log('SETTINGS HTML (first 3k):', settingsHTML.slice(0, 2000))
  } else {
    console.log('NO settings button found')
  }
}

console.log('\n=== CONSOLE LOGS ===')
logs.forEach(l => console.log(l))
console.log('TOTAL LOGS:', logs.length)

await browser.close()
console.log('\nDONE')
