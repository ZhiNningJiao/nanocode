/**
 * Unit tests for the explicit vs implicit sessionId handling in attachClaudeSession.
 *
 * Bug: when tab.claudeSessionId collides with CLAUDE_CODE_SESSION_ID (the running
 * nanocode process session), _activeSessionOverride fired unconditionally and forced
 * turnCount=0 (new-session path), even when the sessionId was explicitly chosen by
 * the user (e.g. via Recent Agents). This caused the spawn to use --session-id
 * (fresh session) instead of --resume (continuing the conversation), so Claude had
 * no prior context even though history showed 900+ events.
 *
 * Fix: _activeSessionOverride only fires when the sessionId is IMPLICIT (no stored
 * claudeSessionId in tab metadata). For EXPLICIT sessionIds, we trust the user's
 * intent and let initialTurnCount=1 (resume path) proceed.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createClaudeSessionController } from '../../terminal/claude-session-controller.js'
import { cwdToClaudeProjectDir } from '../../terminal/claude-history.js'

const { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } = fs

/**
 * Create a minimal mock WebSocket that records sent messages and simulates
 * a single 'message' event for the attach handshake.
 */
function makeMockWs(attachMsg) {
  const listeners = {}
  const sent = []
  const ws = {
    readyState: 1,
    send(msg) { sent.push(JSON.parse(msg)) },
    on(event, fn) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(fn)
    },
    once(event, fn) {
      const wrapper = (...args) => {
        fn(...args)
        ws.off?.(event, wrapper)
      }
      ws.on(event, wrapper)
    },
    off(event, fn) {
      if (!listeners[event]) return
      listeners[event] = listeners[event].filter(l => l !== fn)
    },
    removeListener(event, fn) {
      ws.off(event, fn)
    },
    emit(event, ...args) {
      for (const fn of (listeners[event] || [])) fn(...args)
    },
    _sent: sent,
  }
  // Trigger the initial attach message on the next tick
  setImmediate(() => ws.emit('message', JSON.stringify(attachMsg)))
  return ws
}

function writeJsonlEvents(projectDir, sessionId, events) {
  const sessionsDir = projectDir
  mkdirSync(sessionsDir, { recursive: true })
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const jsonlPath = `${sessionsDir}/${sessionId}.jsonl`
  writeFileSync(jsonlPath, lines)
  // Make the file clearly older than the 30s active-session threshold so
  // auto-recovery tests don't accidentally trip the "recently written" guard.
  const oldTime = new Date(Date.now() - 60_000)
  utimesSync(jsonlPath, oldTime, oldTime)
  return jsonlPath
}

/**
 * Build a minimal session controller with mocked store/recentAgents.
 * Returns { controller, claudeSessions, getCs }.
 */
function makeController({ tabClaudeSessionId, mainSessionId, hasSeedHistory = false, withDiskHistory = null }) {
  const projectId = 'proj-1'
  const tabId = 'tab-1'
  const projectCwd = mkdtempSync('/tmp/nanocode-resume-')
  const home = mkdtempSync('/tmp/nanocode-home-')

  let diskSessionId = null
  if (withDiskHistory) {
    const projectDir = cwdToClaudeProjectDir(home, projectCwd)
    diskSessionId = withDiskHistory.sessionId
    writeJsonlEvents(projectDir, diskSessionId, withDiskHistory.events)
  }

  const metadataUpdates = []
  const store = {
    getSetting(key) {
      if (key === 'renderMode') return 'block'
      if (key === 'claude_autoresume') return '1'
      if (key === 'claude_driver') return 'cli' // use CLI path so we don't need SDK
      return null
    },
    getProject(id) {
      if (id !== projectId) return null
      return { id: projectId, cwd: projectCwd, ssh_host: null }
    },
    getTab(pid, tid) {
      if (pid !== projectId || tid !== tabId) return null
      return { id: tabId, type: 'claude', claudeSessionId: tabClaudeSessionId || null, label: 'Test' }
    },
    updateTabMetadata(pid, tid, meta) {
      metadataUpdates.push({ pid, tid, meta })
    },
    listTabs() { return [] },
    _metadataUpdates: metadataUpdates,
  }

  const recentAgents = {
    getRecentAgentsCached() { return [] },
    primeRecentAgentsCache() {},
  }

  // Temporarily set CLAUDE_CODE_SESSION_ID env var if needed
  const origEnv = process.env.CLAUDE_CODE_SESSION_ID
  if (mainSessionId) {
    process.env.CLAUDE_CODE_SESSION_ID = mainSessionId
  } else {
    delete process.env.CLAUDE_CODE_SESSION_ID
  }

  const controller = createClaudeSessionController({ store, home, recentAgents })

  // If a seed history should exist, prime it before attach
  if (hasSeedHistory) {
    controller.primeReplayHistory(projectId, tabId, [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    ])
  }

  function getCs() {
    return controller.claudeSessions.get(`${projectId}:claude:${tabId}`)
  }

  function triggerAttach() {
    return new Promise((resolve) => {
      const ws = makeMockWs({ type: 'attach', projectId, tabId, sessionType: 'bash' })
      controller.handleTerminalWs(ws)
      // Wait for attach to process (setImmediate fires the 'message' event)
      setImmediate(() => resolve(getCs()))
    })
  }

  function cleanup() {
    try { rmSync(projectCwd, { recursive: true, force: true }) } catch {}
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }

  return { controller, triggerAttach, getCs, projectId, tabId, store, cleanup, restoreEnv: () => {
    if (origEnv !== undefined) {
      process.env.CLAUDE_CODE_SESSION_ID = origEnv
    } else {
      delete process.env.CLAUDE_CODE_SESSION_ID
    }
  }}
}

describe('claude session resume — explicit vs implicit sessionId', () => {
  it('explicit sessionId + active-guard trigger: turnCount=1 (resume path)', async () => {
    // Scenario: user explicitly chose session ABC via Recent Agents.
    // Tab metadata has claudeSessionId=ABC. The running nanocode process also uses ABC.
    // With the fix: active-guard does NOT fire → initialTurnCount=1 → resume path.
    const { triggerAttach, restoreEnv, cleanup } = makeController({
      tabClaudeSessionId: 'explicit-abc',
      mainSessionId: 'explicit-abc', // same as tab → would previously trigger override
      hasSeedHistory: true,
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.equal(cs.turnCount, 1, 'explicit sessionId with history should use resume path (turnCount=1)')
      // The claudeSessionId should remain the explicit one (not replaced by fresh UUID)
      assert.equal(cs.claudeSessionId, 'explicit-abc', 'explicit sessionId should not be replaced')
    } finally {
      restoreEnv()
      cleanup()
    }
  })

  it('implicit sessionId + active jsonl: turnCount=0 (new session, guard active)', async () => {
    // Scenario: tab has no stored claudeSessionId (new/implicit tab).
    // The running nanocode process uses XYZ.
    // The active-guard should fire → fresh UUID → turnCount=0 (new session).
    // (In practice the history endpoint would detect the collision and assign a fresh
    // UUID before primeReplayHistory is called, but we test the controller path here.)
    const { triggerAttach, getCs, restoreEnv, cleanup } = makeController({
      tabClaudeSessionId: null,  // implicit — no stored session
      mainSessionId: 'implicit-xyz',
      hasSeedHistory: false, // guard fires → no seed → turnCount=0
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.equal(cs.turnCount, 0, 'implicit sessionId with active guard should use new-session path (turnCount=0)')
    } finally {
      restoreEnv()
      cleanup()
    }
  })

  it('explicit sessionId, no active-guard collision: turnCount=1 when history present', async () => {
    // Normal resume case: explicit sessionId, different from main session (no collision).
    const { triggerAttach, restoreEnv, cleanup } = makeController({
      tabClaudeSessionId: 'some-other-session',
      mainSessionId: 'main-session-different',
      hasSeedHistory: true,
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.equal(cs.turnCount, 1, 'explicit sessionId with history and no collision: resume path (turnCount=1)')
      assert.equal(cs.claudeSessionId, 'some-other-session')
    } finally {
      restoreEnv()
      cleanup()
    }
  })

  it('no history seed: turnCount=0 even with explicit sessionId (no history to resume)', async () => {
    // Explicit sessionId but no jsonl history primed → no seed → turnCount=0.
    const { triggerAttach, restoreEnv, cleanup } = makeController({
      tabClaudeSessionId: 'fresh-explicit',
      mainSessionId: 'unrelated-main',
      hasSeedHistory: false,
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.equal(cs.turnCount, 0, 'no history seed: new-session path (turnCount=0)')
    } finally {
      restoreEnv()
      cleanup()
    }
  })
})

describe('claude session auto-recovery from jsonl', () => {
  const diskEvents = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello from disk' }] }, uuid: 'u-disk' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi from disk' }] }, requestId: 'r-disk', uuid: 'a-disk' },
  ]

  it('explicit sessionId with jsonl on disk hydrates cs.history and turnCount=1', async () => {
    const { triggerAttach, restoreEnv, cleanup } = makeController({
      tabClaudeSessionId: 'disk-session-abc',
      mainSessionId: 'other-main',
      hasSeedHistory: false,
      withDiskHistory: { sessionId: 'disk-session-abc', events: diskEvents },
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.equal(cs.claudeSessionId, 'disk-session-abc', 'should keep explicit disk sessionId')
      assert.equal(cs.turnCount, 1, 'disk history should put turnCount=1 (resume path)')
      assert.equal(cs.explicitSessionId, true, 'explicit disk session should use --resume on first turn')
      assert.equal(cs.history.length, 2, 'should load both events from disk')
      assert.equal(cs.history[0].type, 'user', 'first event should be user')
      assert.equal(cs.history[1].type, 'assistant', 'second event should be assistant')
    } finally {
      restoreEnv()
      cleanup()
    }
  })

  it('missing stored sessionId falls back to newest jsonl and updates tab metadata', async () => {
    const { triggerAttach, getCs, restoreEnv, cleanup, store, projectId, tabId } = makeController({
      tabClaudeSessionId: 'missing-session-id',
      mainSessionId: 'other-main',
      hasSeedHistory: false,
      withDiskHistory: { sessionId: 'fallback-session-xyz', events: diskEvents },
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.equal(cs.claudeSessionId, 'fallback-session-xyz', 'should resolve to fallback jsonl sessionId')
      assert.equal(cs.turnCount, 1, 'fallback history should put turnCount=1')
      assert.equal(cs.explicitSessionId, true, 'disk-recovered fallback should use --resume on first turn')
      assert.equal(cs.history.length, 2, 'should load fallback events from disk')

      const metaUpdate = store._metadataUpdates.find(
        (u) => u.pid === projectId && u.tid === tabId && u.meta.claudeSessionId === 'fallback-session-xyz'
      )
      assert.ok(metaUpdate, 'tab metadata should be updated to fallback sessionId')
    } finally {
      restoreEnv()
      cleanup()
    }
  })

  it('active-session guard on newest jsonl assigns fresh UUID and keeps turnCount=0', async () => {
    // The newest jsonl belongs to the currently active main session, so
    // resolveSessionJsonl must skip auto-recovery. The tab starts fresh.
    const { triggerAttach, restoreEnv, cleanup, store, projectId, tabId } = makeController({
      tabClaudeSessionId: null,
      mainSessionId: 'active-main-session',
      hasSeedHistory: false,
      withDiskHistory: { sessionId: 'active-main-session', events: diskEvents },
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.notEqual(cs.claudeSessionId, 'active-main-session', 'should not resume active main session')
      assert.equal(cs.turnCount, 0, 'skipped recovery should start new-session path')
      assert.equal(cs.history.length, 0, 'should not load history when guard skips')

      const skipUpdate = store._metadataUpdates.find(
        (u) => u.pid === projectId && u.tid === tabId && u.meta.claudeSessionId && u.meta.claudeSessionId !== 'active-main-session'
      )
      assert.ok(skipUpdate, 'tab metadata should be updated to fresh sessionId after skip')
    } finally {
      restoreEnv()
      cleanup()
    }
  })

  it('explicit sessionId with no jsonl at all keeps sessionId and turnCount=0', async () => {
    // No jsonl exists in the project dir. The explicit sessionId should be
    // preserved but cs.history stays empty and the first turn starts a new
    // session via --session-id.
    const { triggerAttach, restoreEnv, cleanup } = makeController({
      tabClaudeSessionId: 'no-jsonl-session',
      mainSessionId: 'other-main',
      hasSeedHistory: false,
      withDiskHistory: null,
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.equal(cs.claudeSessionId, 'no-jsonl-session', 'should keep explicit sessionId when no jsonl exists')
      assert.equal(cs.turnCount, 0, 'no jsonl should start new-session path')
      assert.equal(cs.history.length, 0, 'cs.history should be empty')
    } finally {
      restoreEnv()
      cleanup()
    }
  })

  it('disk recovery works without replaySeeds (history fetch not required)', async () => {
    // This is the core cross-instance guarantee: even if the front-end has not
    // yet called the history endpoint (so replaySeeds is empty), a WS attach
    // must still recover sessionId + history from the directory jsonl.
    const { triggerAttach, restoreEnv, cleanup } = makeController({
      tabClaudeSessionId: 'disk-session-abc',
      mainSessionId: 'other-main',
      hasSeedHistory: false,
      withDiskHistory: { sessionId: 'disk-session-abc', events: diskEvents },
    })
    try {
      const cs = await triggerAttach()
      assert.equal(cs.claudeSessionId, 'disk-session-abc')
      assert.equal(cs.turnCount, 1, 'should resume even with no in-memory seed')
      assert.equal(cs.explicitSessionId, true)
      assert.equal(cs.history.length, 2)
    } finally {
      restoreEnv()
      cleanup()
    }
  })
})

describe('claude session auto-recovery — cross-instance', () => {
  const diskEvents = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello from disk' }] }, uuid: 'u-disk' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi from disk' }] }, requestId: 'r-disk', uuid: 'a-disk' },
  ]

  function makeSharedResources({ tabClaudeSessionId, mainSessionId, withDiskHistory }) {
    const projectId = 'proj-shared'
    const tabId = 'tab-shared'
    const projectCwd = mkdtempSync('/tmp/nanocode-resume-')
    const home = mkdtempSync('/tmp/nanocode-home-')

    if (withDiskHistory) {
      const projectDir = cwdToClaudeProjectDir(home, projectCwd)
      writeJsonlEvents(projectDir, withDiskHistory.sessionId, withDiskHistory.events)
    }

    const metadataUpdates = []
    const store = {
      getSetting(key) {
        if (key === 'renderMode') return 'block'
        if (key === 'claude_autoresume') return '1'
        if (key === 'claude_driver') return 'cli'
        return null
      },
      getProject(id) {
        if (id !== projectId) return null
        return { id: projectId, cwd: projectCwd, ssh_host: null }
      },
      getTab(pid, tid) {
        if (pid !== projectId || tid !== tabId) return null
        return { id: tabId, type: 'claude', claudeSessionId: tabClaudeSessionId || null, label: 'Test' }
      },
      updateTabMetadata(pid, tid, meta) {
        metadataUpdates.push({ pid, tid, meta })
      },
      listTabs() { return [] },
      _metadataUpdates: metadataUpdates,
    }

    const recentAgents = {
      getRecentAgentsCached() { return [] },
      primeRecentAgentsCache() {},
    }

    const origEnv = process.env.CLAUDE_CODE_SESSION_ID
    if (mainSessionId) {
      process.env.CLAUDE_CODE_SESSION_ID = mainSessionId
    } else {
      delete process.env.CLAUDE_CODE_SESSION_ID
    }

    function createController() {
      return createClaudeSessionController({ store, home, recentAgents })
    }

    function attach(controller) {
      return new Promise((resolve) => {
        const ws = makeMockWs({ type: 'attach', projectId, tabId, sessionType: 'bash' })
        controller.handleTerminalWs(ws)
        setImmediate(() => resolve(controller.claudeSessions.get(`${projectId}:claude:${tabId}`)))
      })
    }

    function cleanup() {
      try { rmSync(projectCwd, { recursive: true, force: true }) } catch {}
      try { rmSync(home, { recursive: true, force: true }) } catch {}
    }

    function restoreEnv() {
      if (origEnv !== undefined) {
        process.env.CLAUDE_CODE_SESSION_ID = origEnv
      } else {
        delete process.env.CLAUDE_CODE_SESSION_ID
      }
    }

    return { createController, attach, store, projectId, tabId, cleanup, restoreEnv }
  }

  it('a fresh controller instance recovers the same sessionId + history from disk', async () => {
    // Simulates a nanocode server restart: controller A is discarded, controller B
    // starts with no in-memory state but the same persistent store + jsonl files.
    // Session recovery must come from disk, not from controller A's claudeSessions Map.
    const resources = makeSharedResources({
      tabClaudeSessionId: 'cross-session-abc',
      mainSessionId: 'other-main',
      withDiskHistory: { sessionId: 'cross-session-abc', events: diskEvents },
    })
    try {
      let controllerA = resources.createController()
      const csA = await resources.attach(controllerA)
      assert.ok(csA, 'first instance should create cs')
      assert.equal(csA.claudeSessionId, 'cross-session-abc', 'first instance should use explicit sessionId')
      assert.equal(csA.history.length, 2, 'first instance should load history')

      // Drop controller A entirely. The only state that survives is on disk / in store.
      controllerA = null

      const controllerB = resources.createController()
      const csB = await resources.attach(controllerB)
      assert.ok(csB, 'second instance should create cs')
      assert.equal(
        csB.claudeSessionId,
        'cross-session-abc',
        'second instance must recover the same sessionId from disk, not from memory'
      )
      assert.equal(csB.turnCount, 1, 'second instance should be on resume path')
      assert.equal(csB.explicitSessionId, true, 'second instance should use --resume on first turn')
      assert.equal(csB.history.length, 2, 'second instance must recover history from disk')
      assert.equal(csB.history[0].type, 'user')
      assert.equal(csB.history[1].type, 'assistant')
    } finally {
      resources.restoreEnv()
      resources.cleanup()
    }
  })

  it('new tab with no stored sessionId auto-recovers newest jsonl across instances', async () => {
    // A brand new tab has no claudeSessionId. After server restart, a fresh controller
    // must still locate the newest jsonl in the project directory and resume it.
    const resources = makeSharedResources({
      tabClaudeSessionId: null,
      mainSessionId: 'other-main',
      withDiskHistory: { sessionId: 'fallback-cross-xyz', events: diskEvents },
    })
    try {
      let controllerA = resources.createController()
      const csA = await resources.attach(controllerA)
      assert.equal(csA.claudeSessionId, 'fallback-cross-xyz', 'first instance should fallback to newest jsonl')
      assert.equal(csA.turnCount, 1)

      controllerA = null

      const controllerB = resources.createController()
      // Tab metadata was updated by controller A to the fallback sessionId, so controller B
      // now sees an explicit sessionId and should still resume it.
      const csB = await resources.attach(controllerB)
      assert.equal(csB.claudeSessionId, 'fallback-cross-xyz', 'second instance should keep fallback sessionId')
      assert.equal(csB.turnCount, 1, 'second instance should remain on resume path')
      assert.equal(csB.history.length, 2)
    } finally {
      resources.restoreEnv()
      resources.cleanup()
    }
  })
})
