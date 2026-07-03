/**
 * Tests for MES-13740 需求5 — cross-team / cross-cwd session continuation.
 *
 * Covers:
 *   - claude-env.js: resolveClaudeConfigDir (per-tab > store > default) +
 *     buildClaudeSpawnEnv (strips nanocode-self keys, sets CLAUDE_CONFIG_DIR)
 *   - usage.js: resolveClaudeConfigDirForTab / resolveClaudeCwdForTab
 *   - store.js: createTab + updateTabMetadata persist claudeConfigDir /
 *     claudeSessionCwd
 *   - claude-history.js: scanRecentConversationsMulti aggregates across all
 *     known teams AND the home cwd, labelling each entry with team / isCrossTeam
 *     / isHome so the picker can resume a team2 session while team1 is active.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../store.js'
import {
  resolveClaudeConfigDir,
  buildClaudeSpawnEnv,
} from '../../terminal/claude-env.js'
import {
  resolveClaudeConfigDirForTab,
  resolveClaudeCwdForTab,
  claudeProjectsDir,
} from '../../terminal/usage.js'
import { scanRecentConversationsMulti } from '../../terminal/claude-history.js'

// Build a jsonl fixture with a user row (for summary + count) and a cwd field.
// Files must be >= 200 bytes or _scanProjectDirEntries skips them.
function makeJsonl(cwd, text) {
  const userRow = JSON.stringify({
    type: 'user',
    uuid: 'u-' + Math.random().toString(36).slice(2),
    cwd,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
  const assistantRow = JSON.stringify({
    type: 'assistant',
    uuid: 'a-' + Math.random().toString(36).slice(2),
    cwd,
    message: { role: 'assistant', content: [{ type: 'text', text: 'reply'.repeat(60) }] },
  })
  return userRow + '\n' + assistantRow + '\n'
}

describe('claude-env: resolveClaudeConfigDir', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-env-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('per-tab override (cs.claudeConfigDir) wins over store setting', () => {
    const store = createStore(':memory:')
    store.setSetting('claude_config_dir', join(tmp, '.claude-team2'))
    const dir = resolveClaudeConfigDir({
      cs: { claudeConfigDir: join(tmp, '.claude-team3') },
      store,
      home: tmp,
    })
    assert.equal(dir, join(tmp, '.claude-team3'))
  })

  it('falls back to store setting when no per-tab override', () => {
    const store = createStore(':memory:')
    store.setSetting('claude_config_dir', join(tmp, '.claude-team2'))
    const dir = resolveClaudeConfigDir({ cs: {}, store, home: tmp })
    assert.equal(dir, join(tmp, '.claude-team2'))
  })

  it('falls back to default ~/.claude when nothing is set', () => {
    const store = createStore(':memory:')
    const dir = resolveClaudeConfigDir({ cs: {}, store, home: tmp })
    assert.equal(dir, join(tmp, '.claude'))
  })

  it('tab.claudeConfigDir also honoured (store metadata path)', () => {
    const store = createStore(':memory:')
    store.setSetting('claude_config_dir', join(tmp, '.claude-team2'))
    const dir = resolveClaudeConfigDir({
      tab: { claudeConfigDir: join(tmp, '.claude-team3') },
      store,
      home: tmp,
    })
    assert.equal(dir, join(tmp, '.claude-team3'))
  })
})

describe('claude-env: buildClaudeSpawnEnv', () => {
  it('sets CLAUDE_CONFIG_DIR when configDir is given', () => {
    const env = buildClaudeSpawnEnv({ PATH: '/usr/bin', CLAUDECODE: '1' }, { configDir: '/team2' })
    assert.equal(env.CLAUDE_CONFIG_DIR, '/team2')
    // strips nanocode-self identifiers
    assert.equal(env.CLAUDECODE, undefined)
    assert.equal(env.PATH, '/usr/bin')
  })

  it('removes inherited CLAUDE_CONFIG_DIR when configDir is falsy', () => {
    const env = buildClaudeSpawnEnv({ CLAUDE_CONFIG_DIR: '/stale' }, {})
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined)
  })

  it('strips all nanocode-self keys but keeps the rest', () => {
    const base = {
      PATH: '/bin',
      CLAUDE_CODE_SESSION_ID: 's1',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'e',
      CLAUDE_CODE_EXECPATH: 'p',
      CLAUDE_CODE_TMPDIR: 't',
      AI_AGENT: '1',
      HOME: '/h',
    }
    const env = buildClaudeSpawnEnv(base, { configDir: '/team' })
    for (const k of Object.keys(base)) {
      if (k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE' || k === 'AI_AGENT') {
        assert.equal(env[k], undefined, `${k} should be stripped`)
      } else {
        assert.equal(env[k], base[k])
      }
    }
    assert.equal(env.CLAUDE_CONFIG_DIR, '/team')
  })
})

describe('usage: resolveClaudeConfigDirForTab / resolveClaudeCwdForTab', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-tab-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('tab.claudeConfigDir overrides store global setting', () => {
    const store = createStore(':memory:')
    store.setSetting('claude_config_dir', join(tmp, '.claude-team2'))
    const tab = { claudeConfigDir: join(tmp, '.claude-team3') }
    assert.equal(resolveClaudeConfigDirForTab(tab, store, tmp), join(tmp, '.claude-team3'))
  })

  it('falls back to store global setting when tab has no override', () => {
    const store = createStore(':memory:')
    store.setSetting('claude_config_dir', join(tmp, '.claude-team2'))
    assert.equal(resolveClaudeConfigDirForTab({}, store, tmp), join(tmp, '.claude-team2'))
  })

  it('falls back to default ~/.claude when nothing is set', () => {
    const store = createStore(':memory:')
    assert.equal(resolveClaudeConfigDirForTab({}, store, tmp), join(tmp, '.claude'))
  })

  it('resolveClaudeCwdForTab uses tab.claudeSessionCwd over project.cwd', () => {
    const project = { cwd: '/proj/current' }
    const tab = { claudeSessionCwd: '/proj/original' }
    assert.equal(resolveClaudeCwdForTab(tab, project), '/proj/original')
  })

  it('resolveClaudeCwdForTab falls back to project.cwd', () => {
    const project = { cwd: '/proj/current' }
    assert.equal(resolveClaudeCwdForTab({}, project), '/proj/current')
  })
})

describe('store: cross-team tab metadata (claudeConfigDir / claudeSessionCwd)', () => {
  it('createTab persists claudeConfigDir and claudeSessionCwd for claude tabs', () => {
    const store = createStore(':memory:')
    const project = store.createProject('Proj', '/tmp/proj')
    const tab = store.createTab(project.id, {
      type: 'claude',
      label: 'resume',
      claudeSessionId: 'sess-123',
      claudeConfigDir: '/home/me/.claude-team2',
      claudeSessionCwd: '/home/me',
    })
    assert.equal(tab.type, 'claude')
    assert.equal(tab.claudeSessionId, 'sess-123')
    assert.equal(tab.claudeConfigDir, '/home/me/.claude-team2')
    assert.equal(tab.claudeSessionCwd, '/home/me')
    // persisted
    const fetched = store.getTab(project.id, tab.id)
    assert.equal(fetched.claudeConfigDir, '/home/me/.claude-team2')
    assert.equal(fetched.claudeSessionCwd, '/home/me')
  })

  it('updateTabMetadata accepts claudeConfigDir / claudeSessionCwd in the whitelist', () => {
    const store = createStore(':memory:')
    const project = store.createProject('Proj', '/tmp/proj')
    const tab = store.createTab(project.id, { type: 'claude', label: 'c' })
    store.updateTabMetadata(project.id, tab.id, {
      claudeConfigDir: '/home/me/.claude-team3',
      claudeSessionCwd: '/other/cwd',
    })
    const fetched = store.getTab(project.id, tab.id)
    assert.equal(fetched.claudeConfigDir, '/home/me/.claude-team3')
    assert.equal(fetched.claudeSessionCwd, '/other/cwd')
  })

  it('createTab omits claudeConfigDir when not provided', () => {
    const store = createStore(':memory:')
    const project = store.createProject('Proj', '/tmp/proj')
    const tab = store.createTab(project.id, { type: 'claude', label: 'c' })
    assert.equal(tab.claudeConfigDir, undefined)
    assert.equal(tab.claudeSessionCwd, undefined)
  })

  // 需求8: persona id chosen at new-session creation is persisted on the tab
  // so every turn re-injects it via --append-system-prompt (survives reconnects).
  it('createTab persists persona for a claude tab (需求8)', () => {
    const store = createStore(':memory:')
    const project = store.createProject('Proj', '/tmp/proj')
    const tab = store.createTab(project.id, { type: 'claude', label: 'new', persona: 'catgirl' })
    assert.equal(tab.persona, 'catgirl')
    const fetched = store.getTab(project.id, tab.id)
    assert.equal(fetched.persona, 'catgirl')
  })

  it('createTab trims and ignores empty/whitespace persona', () => {
    const store = createStore(':memory:')
    const project = store.createProject('Proj', '/tmp/proj')
    const tab = store.createTab(project.id, { type: 'claude', label: 'new', persona: '  ' })
    assert.equal(tab.persona, undefined)
    const tab2 = store.createTab(project.id, { type: 'claude', label: 'new2', persona: ' catgirl ' })
    assert.equal(tab2.persona, 'catgirl')
  })

  it('updateTabMetadata accepts persona in the whitelist', () => {
    const store = createStore(':memory:')
    const project = store.createProject('Proj', '/tmp/proj')
    const tab = store.createTab(project.id, { type: 'claude', label: 'c' })
    store.updateTabMetadata(project.id, tab.id, { persona: 'concise' })
    const fetched = store.getTab(project.id, tab.id)
    assert.equal(fetched.persona, 'concise')
  })
})

describe('claude-history: scanRecentConversationsMulti (cross-team aggregation)', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-xteam-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  function setupTeams() {
    // Two team config dirs under the fake home
    const team1Dir = join(tmp, '.claude')
    const team2Dir = join(tmp, '.claude-team2')
    mkdirSync(join(team1Dir, 'projects'), { recursive: true })
    mkdirSync(join(team2Dir, 'projects'), { recursive: true })
    return { team1Dir, team2Dir }
  }

  function writeSession(teamDir, cwd, sessionId, text) {
    const slug = claudeProjectsDir(teamDir, cwd).split('/').pop()
    const projectDir = join(teamDir, 'projects', slug)
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), makeJsonl(cwd, text))
  }

  it('aggregates conversations across team1 and team2', () => {
    const { team1Dir, team2Dir } = setupTeams()
    const projCwd = '/tmp/myproj'
    writeSession(team1Dir, projCwd, 't1-sess', 'team1 work')
    writeSession(team2Dir, projCwd, 't2-sess', 'team2 work')

    const store = createStore(':memory:')
    // active team defaults to ~/.claude (team1)
    const result = scanRecentConversationsMulti(tmp, projCwd, store, 5)

    assert.equal(result.length, 2)
    const t1 = result.find((r) => r.sessionId === 't1-sess')
    const t2 = result.find((r) => r.sessionId === 't2-sess')
    assert.ok(t1, 'team1 session present')
    assert.ok(t2, 'team2 session present')
    assert.equal(t1.teamId, 'team1')
    assert.equal(t2.teamId, 'team2')
    assert.equal(t1.configDir, team1Dir)
    assert.equal(t2.configDir, team2Dir)
    // team2 is cross-team relative to the active team1
    assert.equal(t1.isCrossTeam, false)
    assert.equal(t2.isCrossTeam, true)
    // cwd read from jsonl
    assert.equal(t1.cwd, projCwd)
    assert.equal(t2.cwd, projCwd)
  })

  it('includes home (~) conversations from any project tab (cwd dimension)', () => {
    const { team1Dir } = setupTeams()
    const projCwd = '/tmp/myproj'
    const homeCwd = tmp // home is the fake tmp dir
    writeSession(team1Dir, homeCwd, 'home-sess', 'secretary home session')

    const store = createStore(':memory:')
    const result = scanRecentConversationsMulti(tmp, projCwd, store, 5)

    const home = result.find((r) => r.sessionId === 'home-sess')
    assert.ok(home, 'home session is visible from a project tab')
    assert.equal(home.isHome, true)
    assert.equal(home.cwd, homeCwd)
    assert.equal(home.isCrossTeam, false)
  })

  it('does not duplicate when project cwd === home', () => {
    const { team1Dir } = setupTeams()
    const homeCwd = tmp
    writeSession(team1Dir, homeCwd, 'home-sess', 'home only')
    const store = createStore(':memory:')
    const result = scanRecentConversationsMulti(tmp, homeCwd, store, 5)
    const home = result.filter((r) => r.sessionId === 'home-sess')
    assert.equal(home.length, 1, 'no duplicate when cwd === home')
  })

  it('respects the limit and sorts by byte size desc', () => {
    const { team1Dir, team2Dir } = setupTeams()
    const projCwd = '/tmp/myproj'
    writeSession(team1Dir, projCwd, 'small', 'tiny')
    writeSession(team2Dir, projCwd, 'big', 'a much longer summary that produces a bigger file'.repeat(3))
    const store = createStore(':memory:')
    const result = scanRecentConversationsMulti(tmp, projCwd, store, 1)
    assert.equal(result.length, 1)
    // the bigger file wins
    assert.equal(result[0].sessionId, 'big')
  })

  it('labels isCrossTeam based on the active store team setting', () => {
    const { team1Dir, team2Dir } = setupTeams()
    const projCwd = '/tmp/myproj'
    writeSession(team1Dir, projCwd, 't1-sess', 'team1 work')
    writeSession(team2Dir, projCwd, 't2-sess', 'team2 work')

    // Now the active team is team2
    const store = createStore(':memory:')
    store.setSetting('claude_config_dir', team2Dir)
    const result = scanRecentConversationsMulti(tmp, projCwd, store, 5)
    const t1 = result.find((r) => r.sessionId === 't1-sess')
    const t2 = result.find((r) => r.sessionId === 't2-sess')
    assert.equal(t1.isCrossTeam, true, 'team1 is cross-team when team2 is active')
    assert.equal(t2.isCrossTeam, false, 'team2 is same-team when team2 is active')
  })

  it('returns empty array when no jsonl exists', () => {
    setupTeams()
    const store = createStore(':memory:')
    const result = scanRecentConversationsMulti(tmp, '/tmp/noproj', store, 5)
    assert.deepEqual(result, [])
  })

  // 需求5.3: source switch (project/home/all) so cross-team PROJECT sessions
  // surface without home secretary sessions drowning the size-sorted list.
  it('source=project scans only the project slug across all teams', () => {
    const { team1Dir, team2Dir } = setupTeams()
    const projCwd = '/tmp/myproj'
    const homeCwd = tmp
    writeSession(team1Dir, projCwd, 't1-proj', 'team1 project')
    writeSession(team2Dir, projCwd, 't2-proj', 'team2 project')
    writeSession(team1Dir, homeCwd, 't1-home', 'team1 home secretary')

    const store = createStore(':memory:')
    const result = scanRecentConversationsMulti(tmp, projCwd, store, 50, Date.now(), 'project')

    const ids = result.map((r) => r.sessionId)
    assert.ok(ids.includes('t1-proj'), 'team1 project session present')
    assert.ok(ids.includes('t2-proj'), 'team2 project session present (cross-team)')
    assert.ok(!ids.includes('t1-home'), 'home session excluded in project mode')
    const t2 = result.find((r) => r.sessionId === 't2-proj')
    assert.equal(t2.isCrossTeam, true, 'team2 is cross-team while team1 active')
  })

  it('source=home scans only the home slug across all teams', () => {
    const { team1Dir, team2Dir } = setupTeams()
    const projCwd = '/tmp/myproj'
    const homeCwd = tmp
    writeSession(team1Dir, projCwd, 't1-proj', 'team1 project')
    writeSession(team1Dir, homeCwd, 't1-home', 'team1 home')
    writeSession(team2Dir, homeCwd, 't2-home', 'team2 home')

    const store = createStore(':memory:')
    const result = scanRecentConversationsMulti(tmp, projCwd, store, 50, Date.now(), 'home')

    const ids = result.map((r) => r.sessionId)
    assert.ok(ids.includes('t1-home'), 'team1 home present')
    assert.ok(ids.includes('t2-home'), 'team2 home present (cross-team)')
    assert.ok(!ids.includes('t1-proj'), 'project session excluded in home mode')
  })

  it('source=all (default) scans both project and home', () => {
    const { team1Dir } = setupTeams()
    const projCwd = '/tmp/myproj'
    const homeCwd = tmp
    writeSession(team1Dir, projCwd, 't1-proj', 'team1 project')
    writeSession(team1Dir, homeCwd, 't1-home', 'team1 home')

    const store = createStore(':memory:')
    const all = scanRecentConversationsMulti(tmp, projCwd, store, 50, Date.now(), 'all')
    const def = scanRecentConversationsMulti(tmp, projCwd, store, 50)
    const allIds = all.map((r) => r.sessionId)
    const defIds = def.map((r) => r.sessionId)
    assert.ok(allIds.includes('t1-proj') && allIds.includes('t1-home'), 'all includes both')
    assert.deepEqual(defIds, allIds, 'default equals all')
  })
})
