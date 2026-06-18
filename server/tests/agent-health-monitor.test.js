import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentHealthMonitor } from '../../terminal/agent-health-monitor.js'

function makeStore(settings = {}) {
  return {
    getSetting(key) {
      return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : null
    },
  }
}

describe('agent health monitor', () => {
  it('emits idle and active recovery events with snapshot state', () => {
    let current = 1_700_000_000_000
    const emitted = []
    const monitor = createAgentHealthMonitor({
      store: makeStore({ agent_health_idle_threshold_sec: '20' }),
      now: () => current,
      autoStart: false,
    })
    monitor.setNotifier((msg) => emitted.push(msg))

    const meta = {
      sessionKey: 'project-1:claude:tab-1',
      projectId: 'project-1',
      tabId: 'tab-1',
      tabType: 'claude',
      provider: 'claude',
      source: 'claude-sdk',
      sessionId: 'sess-1',
    }

    monitor.startTracking(meta)
    monitor.recordOutput(meta, 'Thinking...')

    current += 21_000
    const idleEvents = monitor.scanNow()
    assert.equal(idleEvents.length, 1)
    assert.equal(idleEvents[0].state, 'idle')
    assert.equal(idleEvents[0].reason, 'idle_timeout')
    assert.equal(idleEvents[0].idle_seconds, 21)

    const snapshot = monitor.listSnapshot()
    assert.equal(snapshot.agents.length, 1)
    assert.equal(snapshot.agents[0].state, 'idle')
    assert.equal(snapshot.agents[0].session_id, 'sess-1')

    current += 1_000
    monitor.recordOutput(meta, 'Resumed output')
    assert.equal(emitted.at(-1).state, 'active')
    assert.equal(emitted.at(-1).reason, 'recent_output')
  })

  it('emits approval_needed and stuck for configured terminal patterns', () => {
    let current = 1_700_000_100_000
    const emitted = []
    const monitor = createAgentHealthMonitor({
      store: makeStore({
        agent_health_idle_threshold_sec: '20',
        agent_health_background_wait_threshold_sec: '240',
      }),
      now: () => current,
      autoStart: false,
    })
    monitor.setNotifier((msg) => emitted.push(msg))

    const approvalMeta = {
      sessionKey: 'project-1:claude:tab-approval',
      projectId: 'project-1',
      tabId: 'tab-approval',
      tabType: 'claude',
      provider: 'claude',
      source: 'claude-sdk',
      sessionId: 'sess-approval',
    }
    monitor.startTracking(approvalMeta)
    monitor.recordOutput(approvalMeta, 'Press enter to confirm or esc to cancel')
    assert.equal(emitted.at(-1).state, 'approval_needed')
    assert.equal(emitted.at(-1).reason, 'approval_prompt')

    const stuckMeta = {
      sessionKey: 'project-1:codex:tab-stuck',
      projectId: 'project-1',
      tabId: 'tab-stuck',
      tabType: 'codex',
      provider: 'codex',
      source: 'codex-sdk',
      threadId: 'thread-stuck',
    }
    monitor.startTracking(stuckMeta)
    monitor.recordOutput(stuckMeta, 'Waiting for background terminal (4m 12s)')
    assert.equal(emitted.at(-1).state, 'stuck')
    assert.equal(emitted.at(-1).reason, 'background_terminal_wait')
    assert.equal(emitted.at(-1).wait_seconds, 252)
  })

  it('finishes Claude sessions on result events and removes them from snapshot', () => {
    let current = 1_700_000_200_000
    const emitted = []
    const monitor = createAgentHealthMonitor({
      store: makeStore(),
      now: () => current,
      autoStart: false,
    })
    monitor.setNotifier((msg) => emitted.push(msg))

    const meta = {
      sessionKey: 'project-2:claude:tab-2',
      projectId: 'project-2',
      tabId: 'tab-2',
      tabType: 'claude',
      provider: 'claude',
      source: 'claude-cli',
      sessionId: 'sess-2',
    }

    monitor.startTracking(meta)
    monitor.recordClaudeEvent(meta, {
      type: 'assistant',
      session_id: 'sess-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] },
    })
    monitor.recordClaudeEvent(meta, {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-2',
      result: 'done',
    })

    assert.equal(emitted.at(-1).state, 'completed')
    assert.equal(emitted.at(-1).reason, 'success')
    assert.equal(monitor.listSnapshot().agents.length, 0)
  })

  it('detects idle and shell-prompt stop for PTY agent tabs', () => {
    let current = 1_700_000_300_000
    const emitted = []
    const monitor = createAgentHealthMonitor({
      store: makeStore({ agent_health_idle_threshold_sec: '10' }),
      now: () => current,
      autoStart: false,
    })
    monitor.setNotifier((msg) => emitted.push(msg))

    const meta = {
      sessionKey: 'project-3:meshy-aigw:tab-3',
      projectId: 'project-3',
      tabId: 'tab-3',
      tabType: 'meshy-aigw',
      provider: 'meshy-aigw',
      source: 'pty',
    }

    monitor.startTracking(meta)
    monitor.recordOutput(meta, 'Running opencode...\r\n')
    // Plain active output does not emit an event until state changes.
    assert.equal(emitted.length, 0)

    current += 11_000
    const idleEvents = monitor.scanNow()
    assert.equal(idleEvents.length, 1)
    assert.equal(idleEvents[0].state, 'idle')
    assert.equal(idleEvents[0].reason, 'idle_timeout')
    assert.equal(idleEvents[0].tab_type, 'meshy-aigw')
    assert.equal(idleEvents[0].source, 'pty')

    monitor.recordOutput(meta, '\r\nuser@host:~/project$ ')
    assert.equal(emitted.at(-1).state, 'stopped')
    assert.equal(emitted.at(-1).reason, 'shell_prompt')
    assert.equal(monitor.listSnapshot().agents.length, 0)
  })

  it('detects stuck PTY agent from multi-chunk background wait output', () => {
    let current = 1_700_000_400_000
    const emitted = []
    const monitor = createAgentHealthMonitor({
      store: makeStore({
        agent_health_idle_threshold_sec: '20',
        agent_health_background_wait_threshold_sec: '120',
      }),
      now: () => current,
      autoStart: false,
    })
    monitor.setNotifier((msg) => emitted.push(msg))

    const meta = {
      sessionKey: 'project-4:claude:tab-4',
      projectId: 'project-4',
      tabId: 'tab-4',
      tabType: 'claude',
      provider: 'claude',
      source: 'pty',
    }

    monitor.startTracking(meta)
    monitor.recordOutput(meta, 'Thinking...\r\n')
    monitor.recordOutput(meta, 'Waiting for background terminal (2m 5s)\r\n')
    assert.equal(emitted.at(-1).state, 'stuck')
    assert.equal(emitted.at(-1).reason, 'background_terminal_wait')
    assert.equal(emitted.at(-1).wait_seconds, 125)
  })

  it('registers main process pid and exposes subagents in snapshot', () => {
    const monitor = createAgentHealthMonitor({
      store: makeStore(),
      now: () => Date.now(),
      autoStart: false,
      subAgentScanner: {
        findSubagents: (pid) => pid === 4242
          ? [
              { pid: 1111, name: 'sub-one', cmd: '/usr/bin/node sub-one.js' },
              { pid: 2222, name: 'sub-two', cmd: '/usr/bin/node sub-two.js' },
            ]
          : [],
        signalProcess: (pid) => ({ ok: true, pid }),
      },
    })

    const meta = {
      sessionKey: 'project-3:claude:tab-3',
      projectId: 'project-3',
      tabId: 'tab-3',
      tabType: 'claude',
      provider: 'claude',
      source: 'claude-sdk',
      sessionId: 'sess-3',
    }
    monitor.startTracking(meta)
    monitor.registerMainProcess(meta.sessionKey, 4242)

    const subs = monitor.listSubagents(meta.sessionKey)
    assert.equal(subs.length, 2)
    assert.equal(subs[0].pid, 1111)

    const snapshot = monitor.listSnapshot()
    assert.equal(snapshot.agents.length, 1)
    assert.equal(snapshot.agents[0].main_pid, 4242)
    assert.equal(snapshot.agents[0].subagents.length, 2)
  })

  it('stopSubagent only signals known subagents and guards main pid', () => {
    const monitor = createAgentHealthMonitor({
      store: makeStore(),
      now: () => Date.now(),
      autoStart: false,
      subAgentScanner: {
        findSubagents: (pid) => pid === 9999
          ? [
              { pid: 1234, name: 'sub-one', cmd: '/usr/bin/node sub-one.js' },
              { pid: 5678, name: 'sub-two', cmd: '/usr/bin/node sub-two.js' },
            ]
          : [],
        signalProcess: (pid, signal) => ({ ok: true, pid, signal }),
      },
    })

    monitor.startTracking({
      sessionKey: 's:claude:t',
      projectId: 'p',
      tabId: 't',
      tabType: 'claude',
      provider: 'claude',
      source: 'claude-sdk',
      sessionId: 's',
    })
    monitor.registerMainProcess('s:claude:t', 9999)

    // cannot stop main pid
    const mainGuard = monitor.stopSubagent('s:claude:t', 9999)
    assert.equal(mainGuard.ok, false)
    assert.equal(mainGuard.error, 'cannot stop main process via sub-agent stop')

    // cannot stop a pid that is not a known subagent of the session
    const unknown = monitor.stopSubagent('s:claude:t', 1111)
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error, 'pid is not a known subagent of this session')

    // cannot target a pid without a valid registered session
    const badSession = monitor.stopSubagent('nope', 1234)
    assert.equal(badSession.ok, false)
    assert.equal(badSession.error, 'session not found')

    // signal whitelist
    const badSignal = monitor.stopSubagent('s:claude:t', 1234, 'SIGUSR1')
    assert.equal(badSignal.ok, false)
    assert.equal(badSignal.error, 'signal not allowed')

    // valid stop works for known subagents
    const good = monitor.stopSubagent('s:claude:t', 1234)
    assert.equal(good.ok, true)
    assert.equal(good.pid, 1234)
    assert.equal(good.signal, 'SIGTERM')

    const sigint = monitor.stopSubagent('s:claude:t', 5678, 'SIGINT')
    assert.equal(sigint.ok, true)
    assert.equal(sigint.signal, 'SIGINT')
  })
})
