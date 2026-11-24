import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listSessions, previewSession, resetSessionsCache } from '../../terminal/sessions-browser.js'
import { sessionSourceRoots, listTeams } from '../../terminal/usage.js'
import { resetPersonalConfigCache } from '../../terminal/personal-config.js'

// Fixture homes live under the OS temp dir (TMPDIR) and are removed afterwards;
// nothing here reads the real home of the machine running the tests.
let root
const CLAUDE_ID = '11111111-2222-3333-4444-555555555555'
const POOL_ID = '66666666-7777-8888-9999-000000000000'

function claudeSession(dir, id, cwd, prompt, ts, extraTurns = 0) {
  mkdirSync(dir, { recursive: true })
  const rows = [
    { type: 'user', sessionId: id, cwd, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
    { type: 'assistant', sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: `answer to ${prompt}` }] } },
  ]
  for (let i = 0; i < extraTurns; i++) {
    rows.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `turn ${i}` }] } })
  }
  writeFileSync(join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function codexSession(home, id, ts) {
  const dir = join(home, '.codex', 'sessions', '2026', '11', '21')
  mkdirSync(dir, { recursive: true })
  const rows = [
    { type: 'session_meta', payload: { id, timestamp: ts, cwd: '/work/codex', cli_version: '0.1', model: 'm' } },
    { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'codex prompt' }] } },
    { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'codex answer' }] } },
  ]
  writeFileSync(join(dir, `rollout-2026-11-21-${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

let homeA // auto-discovery on (default behaviour)
let homeB // auto-discovery off, one declared pool outside home
let pool

before(() => {
  root = mkdtempSync(join(tmpdir(), 'nanocode-sessions-browser-'))
  homeA = join(root, 'homeA')
  claudeSession(join(homeA, '.claude', 'projects', '-work-a'), CLAUDE_ID, '/work/a', 'hello claude', '2026-11-20T10:00:00.000Z', 20)
  codexSession(homeA, 'codex-aaa', '2026-11-21T10:00:00.000Z')

  homeB = join(root, 'homeB')
  pool = join(root, 'pools', 'claude-team1')
  claudeSession(join(homeB, '.claude', 'projects', '-work-home'), CLAUDE_ID, '/work/home', 'home session', '2026-11-20T10:00:00.000Z')
  codexSession(homeB, 'codex-home', '2026-11-21T10:00:00.000Z')
  claudeSession(join(pool, 'projects', '-work-pool'), POOL_ID, '/work/pool', 'pool session', '2026-11-21T09:00:00.000Z')
  mkdirSync(join(homeB, '.config', 'nanocode'), { recursive: true })
  writeFileSync(join(homeB, '.config', 'nanocode', 'personal.json'), JSON.stringify({
    claude: { autoDiscoverTeams: false, teams: [{ name: 'Pool 1', configDir: pool }] },
  }))
})

after(() => { rmSync(root, { recursive: true, force: true }) })

beforeEach(() => { resetSessionsCache(); resetPersonalConfigCache() })

describe('sessions-browser (codex resume/fork picker)', () => {
  it('listSessions returns newest-first sessions from ~/.claude + ~/.codex by default', async () => {
    const data = await listSessions({ limit: 10, home: homeA })
    assert.equal(data.total, 2)
    assert.equal(data.partial, false)
    assert.deepEqual(data.sessions.map((s) => s.source), ['codex', 'claude'])
    const c = data.sessions[1]
    assert.equal(c.id, CLAUDE_ID)
    assert.equal(c.firstMessage, 'hello claude')
    // Regression: the slug round-trips to an absolute cwd.
    assert.equal(c.cwd, '/work/a')
  })

  it('listSessions respects the source filter and clamps the limit', async () => {
    const codex = await listSessions({ source: 'codex', limit: 50, home: homeA })
    assert.deepEqual(codex.sessions.map((s) => s.source), ['codex'])
    const claude = await listSessions({ source: 'claude', limit: 1, home: homeA })
    assert.equal(claude.sessions.length, 1)
    assert.equal(claude.sessions[0].source, 'claude')
  })

  it('previewSession returns the tail turns by file and by id', async () => {
    const list = await listSessions({ source: 'claude', home: homeA })
    const byFile = await previewSession({ source: 'claude', id: CLAUDE_ID, file: list.sessions[0].file, home: homeA })
    assert.ok(!byFile.error, byFile.error)
    assert.equal(byFile.turns.length, 6)
    assert.equal(byFile.turns.at(-1).text, 'turn 19')
    assert.equal(byFile.totalTurns, 22)
    const byId = await previewSession({ source: 'codex', id: 'codex-aaa', home: homeA })
    assert.ok(!byId.error, byId.error)
    assert.equal(byId.cwd, '/work/codex')
    assert.deepEqual(byId.turns.map((t) => t.role), ['user', 'assistant'])
  })

  it('previewSession refuses files outside the configured roots and unknown ids/sources', async () => {
    const outside = await previewSession({ source: 'claude', file: join(homeB, '.config', 'nanocode', 'personal.json'), home: homeA })
    assert.match(outside.error, /outside the configured session roots/)
    const traversal = await previewSession({ source: 'claude', file: join(homeA, '.claude', 'projects', '..', '..', 'x.jsonl'), home: homeA })
    assert.match(traversal.error, /outside/)
    assert.ok((await previewSession({ source: 'codex', id: 'nonexistent-id-xyz', home: homeA })).error)
    assert.ok((await previewSession({ source: 'unknown', id: 'x', home: homeA })).error)
  })

  it('autoDiscoverTeams=false: only declared pools, nothing under HOME is scanned', async () => {
    const roots = await sessionSourceRoots(homeB)
    assert.deepEqual(roots, { claudeProjectRoots: [join(pool, 'projects')], codexSessionsDir: null })
    const teams = listTeams(homeB, null).teams
    assert.deepEqual(teams.map((t) => t.path), [pool])
    const data = await listSessions({ limit: 50, home: homeB })
    assert.deepEqual(data.sessions.map((s) => s.id), [POOL_ID])
    for (const s of data.sessions) assert.ok(!s.file.startsWith(homeB), `scanned home: ${s.file}`)
    // A home file is not previewable either (outside the configured roots).
    const homeFile = join(homeB, '.claude', 'projects', '-work-home', `${CLAUDE_ID}.jsonl`)
    assert.match((await previewSession({ source: 'claude', file: homeFile, home: homeB })).error, /outside/)
  })

  it('NANOCODE_PERSONAL_CONFIG points at a host-local file (shared home keeps its own personal.json)', async () => {
    const local = join(root, 'host-local-personal.json')
    writeFileSync(local, JSON.stringify({ claude: { autoDiscoverTeams: false, teams: [{ name: 'Pool 1', configDir: pool }] } }))
    const prev = process.env.NANOCODE_PERSONAL_CONFIG
    process.env.NANOCODE_PERSONAL_CONFIG = local
    try {
      // homeA has no switch in its own personal.json; the host-local file wins.
      assert.deepEqual(await sessionSourceRoots(homeA), { claudeProjectRoots: [join(pool, 'projects')], codexSessionsDir: null })
    } finally {
      if (prev === undefined) delete process.env.NANOCODE_PERSONAL_CONFIG
      else process.env.NANOCODE_PERSONAL_CONFIG = prev
      resetPersonalConfigCache()
    }
    assert.equal((await sessionSourceRoots(homeA)).claudeProjectRoots[0], join(homeA, '.claude', 'projects'))
  })

  it('default (switch absent): the session roots are the listTeams pools — Team2 sessions are listed too', async () => {
    const T2_ID = '22222222-2222-4222-8222-222222222222'
    claudeSession(join(homeA, '.claude-team2', 'projects', '-work-t2'), T2_ID, '/work/t2', 'team2 session', '2026-11-21T11:00:00.000Z')
    const paths = listTeams(homeA, null).teams.map((t) => t.path)
    assert.deepEqual(paths, [join(homeA, '.claude'), join(homeA, '.claude-team2')])
    assert.deepEqual(await sessionSourceRoots(homeA), {
      claudeProjectRoots: [join(homeA, '.claude', 'projects'), join(homeA, '.claude-team2', 'projects')],
      codexSessionsDir: join(homeA, '.codex', 'sessions'),
    })
    // one pool answer everywhere: the sessions plugin now sees the Team2 session
    // (the resume picker always did — scanRecentConversationsMulti uses listTeams)
    const data = await listSessions({ source: 'claude', limit: 50, home: homeA, deadlineMs: 5000 })
    assert.ok(data.sessions.some((x) => x.id === T2_ID), 'Team2 session listed')
  })
})
