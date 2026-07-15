// Smoke-test screenshot helper for the akari inspector plugin (MES-14049).
// Loads /akari_harness.html which mounts the REAL akari-panel.js against the
// same-origin proxy, screenshots it, and dumps the rendered text for evidence.
// Run: SMOKE_URL=http://127.0.0.1:9479 SMOKE_TAG=good node scripts/shot_akari_panel.mjs
import { chromium } from 'playwright'

const outDir = process.env.OUT_DIR || '/jfs/home/zhiningjiao/codex_work/nano_akari'
const base = process.env.SMOKE_URL || 'http://127.0.0.1:9479'
const tag = process.env.SMOKE_TAG || 'good'

const { mkdirSync } = await import('node:fs')
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 460, height: 1000 } })
  const errs = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
  page.on('pageerror', (e) => errs.push(String(e)))

  await page.goto(`${base}/akari_harness.html`, { waitUntil: 'domcontentloaded', timeout: 15000 })
  // Wait for the akari shell + first poll to render.
  await page.waitForSelector('#akari-pane', { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(4000) // give the 10s-limited poll + render time

  await page.screenshot({ path: `${outDir}/akari_panel_${tag}.png`, fullPage: true })

  const text = await page.locator('#pane').innerText().catch(() => '')
  const html = await page.locator('#akari-pane').innerHTML().catch(() => '<no pane>')
  console.log(`[${tag}] akari pane text:\n${text || '(empty)'}\n`)
  console.log(`[${tag}] #akari-pane children: ${html ? html.length + ' chars' : 'MISSING'}`)
  console.log(`[${tag}] console errors: ${errs.length ? errs.join(' | ') : '(none)'}`)
  await page.close()
} finally {
  await browser.close()
}
