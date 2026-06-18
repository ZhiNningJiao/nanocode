import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSubAgentScanner } from '../../terminal/sub-agent-scanner.js'

describe('sub-agent-scanner', () => {
  it('finds subagent descendants of a main process', () => {
    const scanner = createSubAgentScanner({
      reader: {
        readdir: () => ['1', '2', '3', '4', 'self'],
        readLink: (pid) => ({
          '1': '/opt/claude/claude',
          '2': '/usr/bin/node /home/user/.claude/claude-agent-runner.js',
          '3': '/usr/bin/node /home/user/.claude/claude-sub-agent.js',
          '4': '/usr/bin/bash',
        }[pid]),
        readStat: (pid) => ({
          '1': { ppid: 0, pid: 1 },
          '2': { ppid: 1, pid: 2 },
          '3': { ppid: 2, pid: 3 },
          '4': { ppid: 0, pid: 4 },
          self: { ppid: 4, pid: 999 },
        }[pid]),
      },
    })

    const found = scanner.findSubagents(1)
    assert.equal(found.length, 2)
    assert.equal(found[0].pid, 2)
    assert.equal(found[0].name, 'claude-agent-runner')
    assert.equal(found[1].pid, 3)
    assert.equal(found[1].name, 'claude-sub-agent')
  })

  it('ignores non-claude/codex/opencode processes', () => {
    const scanner = createSubAgentScanner({
      reader: {
        readdir: () => ['1', '2'],
        readLink: () => '/usr/bin/python3 some-script.py',
        readStat: (pid) => ({ 1: { ppid: 0, pid: 1 }, 2: { ppid: 1, pid: 2 } }[pid]),
      },
    })
    assert.deepEqual(scanner.findSubagents(1), [])
  })

  it('returns empty when main pid has no children', () => {
    const scanner = createSubAgentScanner({
      reader: {
        readdir: () => ['1', '2'],
        readLink: () => '/opt/claude/claude',
        readStat: () => ({ ppid: 0, pid: 1 }),
      },
    })
    assert.deepEqual(scanner.findSubagents(1), [])
  })

  it('signalProcess reports ok when kill succeeds', () => {
    let killed = []
    const scanner = createSubAgentScanner({
      processKill: (pid, signal) => {
        killed.push([pid, signal])
        return true
      },
    })
    const res = scanner.signalProcess(1234, 'SIGTERM')
    assert.equal(res.ok, true)
    assert.deepEqual(killed, [[1234, 'SIGTERM']])
  })

  it('signalProcess returns error when kill throws', () => {
    const scanner = createSubAgentScanner({
      processKill: () => { throw new Error('no such process') },
    })
    const res = scanner.signalProcess(1234, 'SIGTERM')
    assert.equal(res.ok, false)
    assert.equal(res.error.includes('no such process'), true)
  })

  it('signalProcess refuses main pid', () => {
    const scanner = createSubAgentScanner({
      processKill: () => true,
    })
    const res = scanner.signalProcess(process.pid, 'SIGTERM')
    assert.equal(res.ok, false)
    assert.equal(res.error, 'refusing to signal own process')
  })
})
