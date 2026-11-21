import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRecentAgentsService } from '../../terminal/recent-agents.js'
import { resetPersonalConfigCache } from '../../terminal/personal-config.js'

let root
function session(projectsDir, slug, id, cwd, prompt) {
  const dir = join(projectsDir, slug)
  mkdirSync(dir, { recursive: true })
  const row = { type: 'user', cwd, message: { role: 'user', content: [{ type: 'text', text: prompt }] } }
  writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify(row) + '\n')
}

before(() => { root = mkdtempSync(join(tmpdir(), 'nanocode-recent-agents-')) })
after(() => { rmSync(root, { recursive: true, force: true }) })
beforeEach(() => { resetPersonalConfigCache() })

describe('recent-agents (async, bounded)', () => {
  it('lists recent sessions with real cwd + summary, shares one scan across callers', async () => {
    const home = join(root, 'a')
    session(join(home, '.claude', 'projects'), '-work-x', 'sid-1', '/work/x', 'do the thing')
    const svc = createRecentAgentsService({ home })
    assert.deepEqual(svc.getCachedEntries(), [])
    svc.primeRecentAgentsCache() // fire-and-forget, must not throw or block
    const [r1, r2] = await Promise.all([svc.getRecentAgents(), svc.getRecentAgents()])
    for (const r of [r1, r2]) {
      assert.equal(r.partial, false)
      assert.equal(r.entries.length, 1)
      assert.equal(r.entries[0].cwd, '/work/x')
      assert.equal(r.entries[0].projectName, 'x')
      assert.equal(r.entries[0].summary, 'do the thing')
    }
    assert.equal(svc.getCachedEntries().length, 1)
  })

  it('autoDiscoverTeams=false: scans only declared pools, never ~/.claude', async () => {
    const home = join(root, 'b')
    const pool = join(root, 'pool1')
    session(join(home, '.claude', 'projects'), '-work-home', 'sid-home', '/work/home', 'home')
    session(join(pool, 'projects'), '-work-pool', 'sid-pool', '/work/pool', 'pool')
    mkdirSync(join(home, '.config', 'nanocode'), { recursive: true })
    writeFileSync(join(home, '.config', 'nanocode', 'personal.json'), JSON.stringify({
      claude: { autoDiscoverTeams: false, teams: [{ name: 'P1', configDir: pool }] },
    }))
    const { entries } = await createRecentAgentsService({ home }).getRecentAgents()
    assert.deepEqual(entries.map((e) => e.sessionId), ['sid-pool'])
  })
})
