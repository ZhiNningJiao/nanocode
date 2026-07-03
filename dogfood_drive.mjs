import { chromium } from 'playwright'

const PORT = 9475
const BASE = `http://localhost:${PORT}`

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  
  const errors = []
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', err => errors.push(err.message))

  // 1. Load the app, navigate directly to a project
  // First get the list of projects
  await page.goto(BASE)
  await page.waitForTimeout(2000)
  
  // Navigate to local host
  await page.evaluate(() => { location.hash = '#/local' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: '/tmp/opencode/dog-01-projects.png' })
  
  // Get project list from API
  const projects = await page.evaluate(async () => {
    const r = await fetch('/api/projects')
    return r.json()
  })
  console.log('Projects:', projects.length)
  // Find nanocode project
  const ncProj = projects.find(p => p.cwd?.includes('nanocode')) || projects[0]
  console.log('Target project:', ncProj?.name, ncProj?.cwd)
  
  if (ncProj) {
    // Navigate to project workspace using hash routing
    const host = ncProj.ssh_host ? ncProj.ssh_host.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') : 'local'
    const base = ncProj.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'unnamed'
    await page.evaluate(({ h, b }) => { location.hash = `#/${h}/${b}` }, { h: host, b: base })
    await page.waitForTimeout(3000)
    await page.screenshot({ path: '/tmp/opencode/dog-02-workspace.png' })
    console.log('Entered workspace')
  }

  // 2. Open agent drawer
  await page.click('#agent-drawer-toggle')
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '/tmp/opencode/dog-03-agent-drawer.png', fullPage: false })
  
  // Count tmux session items
  const sessionItems = await page.$$('.tmux-session-item')
  console.log('Tmux session items visible:', sessionItems.length)
  
  // Check for filter buttons/chips
  const filterChips = await page.$$('.tmux-filter-chip, .tmux-type-filter, .tmux-filter-btn')
  console.log('Type filter buttons:', filterChips.length)
  
  // Check for kill buttons
  const killBtns = await page.$$('.tmux-session-kill, .tmux-session-delete')
  console.log('Kill session buttons:', killBtns.length)
  
  // Check what sections exist
  const tmuxSection = await page.$('.tmux-session-section')
  const subagentSection = await page.$('.subagent-section')
  const recentSection = await page.$('.recent-agent-section')
  console.log('Sections — tmux:', !!tmuxSection, 'subagent:', !!subagentSection, 'recent:', !!recentSection)
  
  // Check search input
  const searchInput = await page.$('.tmux-search-input')
  console.log('Search input present:', !!searchInput)
  
  // Count total sessions from API
  const sessions = await page.evaluate(async () => {
    const r = await fetch('/api/tmux/list')
    return r.json()
  })
  console.log('Total tmux sessions from API:', sessions.length)
  
  // Count by type
  const byType = {}
  for (const s of sessions) {
    const cmd = (s.paneCommand || '').toLowerCase()
    let type = 'other'
    if (cmd.includes('claude')) type = 'claude'
    else if (cmd.includes('codex')) type = 'codex'
    else if (cmd === 'bash' || cmd === 'sh') type = 'bash'
    else if (cmd === 'node') type = 'node'
    byType[type] = (byType[type] || 0) + 1
  }
  console.log('Sessions by type:', JSON.stringify(byType))

  // 3. Close drawer, open new tab menu
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await page.click('.tab-chip-add')
  await page.waitForTimeout(500)
  await page.screenshot({ path: '/tmp/opencode/dog-04-newtab-menu.png' })
  const menuItems = await page.$$('.tab-new-menu-item')
  console.log('New tab menu items:', menuItems.length)
  const manageLink = await page.$('.tab-new-menu-manage')
  console.log('Manage tab types link in menu:', !!manageLink)

  // 4. Open settings panel
  await page.keyboard.press('Escape')
  await page.click('#settings-toggle-btn')
  await page.waitForTimeout(1000)
  await page.screenshot({ path: '/tmp/opencode/dog-05-settings.png' })
  const tabTypeCheckboxes = await page.$$('.tab-type-checkbox')
  console.log('Tab type checkboxes in settings:', tabTypeCheckboxes.length)

  console.log('\nConsole errors:', errors.length)
  errors.slice(0, 5).forEach(e => console.log('  ERROR:', e))

  await browser.close()
  console.log('\nDone.')
}

main().catch(e => { console.error(e); process.exit(1) })
