/**
 * Tests for the Linear → ntfy notification bridge.
 *
 * These tests mock global.fetch so no real ntfy/Linear traffic is emitted,
 * and clean up the on-disk state file so they do not pollute the repo.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { createStore } from '../store.js'
import {
  setNtfyStore,
  pushNtfy,
  classifyLinearImportance,
  pushNtfyLinearImportant,
  isRecentImportantPush,
} from '../qa-watcher.js'
import {
  startLinearNotifier,
  stopLinearNotifier,
  runLinearPoll,
  pushNtfyTest,
} from '../linear-notif.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_PATH = join(__dirname, '..', '..', 'data', 'linear-notif-state.json')

function createMockStore(settings = {}) {
  const store = createStore(':memory:')
  for (const [k, v] of Object.entries(settings)) store.setSetting(k, v)
  return store
}

describe('ntfy push', () => {
  let store
  let originalFetch
  let fetches

  beforeEach(() => {
    store = createMockStore({
      ntfy_url: 'http://10.18.8.55:80',
      ntfy_topic: 'zhiningwork',
    })
    setNtfyStore(store)
    originalFetch = global.fetch
    fetches = []
    global.fetch = async (url, opts) => {
      fetches.push({ url, opts })
      return { ok: true, status: 200, text: async () => '' }
    }
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('returns ok when ntfy responds', async () => {
    const result = await pushNtfy({ title: 't', message: 'm' })
    assert.equal(result.ok, true)
    assert.equal(fetches.length, 1)
    assert.equal(fetches[0].url, 'http://10.18.8.55:80/zhiningwork')
    assert.equal(fetches[0].opts.method, 'POST')
    assert.equal(fetches[0].opts.headers.Title, 't')
    // URL/topic must not appear in the logged or returned data
    assert.equal(fetches[0].opts.body, 'm')
  })

  it('fails gracefully when ntfy is unreachable', async () => {
    global.fetch = async () => { throw new Error('connect ECONNREFUSED') }
    const result = await pushNtfy({ title: 't', message: 'm' })
    assert.equal(result.ok, false)
    assert.match(result.error, /ECONNREFUSED/)
  })

  it('fails gracefully when ntfy is not configured', async () => {
    setNtfyStore(createMockStore({}))
    const result = await pushNtfy({ title: 't', message: 'm' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'ntfy not configured')
    assert.equal(fetches.length, 0)
  })

  it('pushes important Linear posts and suppresses routine ones', async () => {
    const routine = await pushNtfyLinearImportant({ identifier: 'MES-1', summary: 'made some progress' })
    assert.equal(routine.pushed, false)
    assert.equal(routine.reason, 'not important')
    assert.equal(fetches.length, 0)

    const important = await pushNtfyLinearImportant({ identifier: 'MES-2', summary: 'blocked by 卡点' })
    assert.equal(important.pushed, true)
    assert.equal(important.reason, 'blocked')
    assert.equal(fetches.length, 1)
    assert.equal(fetches[0].opts.headers.Title, 'Linear MES-2')
  })

  it('records recent important pushes for C-path deduplication', async () => {
    await pushNtfyLinearImportant({ identifier: 'MES-3', summary: 'needs owner approval' })
    assert.equal(isRecentImportantPush('MES-3', 'This needs owner approval ASAP'), true)
    assert.equal(isRecentImportantPush('MES-3', 'unrelated follow-up'), false)
    assert.equal(isRecentImportantPush('MES-99', 'needs owner approval'), false)
  })
})

describe('Linear important classification', () => {
  it('classifies keywords correctly', () => {
    assert.ok(classifyLinearImportance('验收通过，可以合并').important)
    assert.ok(classifyLinearImportance('blocked by env').important)
    assert.ok(classifyLinearImportance('需要主人拍板').important)
    assert.ok(!classifyLinearImportance('routine update').important)
    assert.ok(!classifyLinearImportance('').important)
    assert.ok(!classifyLinearImportance(null).important)
  })
})

describe('Linear background poller', () => {
  let store
  let originalFetch
  let originalState
  let pushed
  let linearResponses

  beforeEach(() => {
    store = createMockStore({
      linear_api_key: 'lin_api_test',
      linear_poll_minutes: 2,
      ntfy_url: 'http://10.18.8.55:80',
      ntfy_topic: 'zhiningwork',
    })
    setNtfyStore(store)

    // Back up existing state file and remove it so each test starts fresh.
    if (existsSync(STATE_PATH)) {
      originalState = STATE_PATH + '.bak-test'
      copyFileSync(STATE_PATH, originalState)
      unlinkSync(STATE_PATH)
    }

    pushed = []
    linearResponses = []

    originalFetch = global.fetch
    global.fetch = async (url, opts) => {
      if (url.includes('api.linear.app')) {
        const body = JSON.parse(opts.body || '{}')
        linearResponses.push(body)
        const variables = body.variables || {}
        const issueNumber = variables.number ?? 1
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              issues: {
                nodes: [{
                  id: `issue-${issueNumber}`,
                  identifier: `${variables.team || 'MES'}-${issueNumber}`,
                  title: 'Test issue',
                  url: 'https://linear.app/test/issue/TEST-1',
                  state: { name: 'In Progress', color: '#fff' },
                  comments: {
                    nodes: [
                      { id: `c-${issueNumber}-1`, body: 'first', createdAt: '2024-01-01T00:00:00Z', user: { displayName: 'A' } },
                    ],
                  },
                }],
              },
            },
          }),
        }
      }
      // ntfy path
      pushed.push({ url, opts })
      return { ok: true, status: 200, text: async () => '' }
    }
  })

  afterEach(() => {
    global.fetch = originalFetch
    stopLinearNotifier()
    if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH)
    if (originalState && existsSync(originalState)) {
      copyFileSync(originalState, STATE_PATH)
      unlinkSync(originalState)
      originalState = null
    }
  })

  it('records state on first poll without spamming historical comments', async () => {
    startLinearNotifier({ store })
    stopLinearNotifier()
    // Allow the immediate async poll to finish.
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(existsSync(STATE_PATH), 'state file should be created')
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    assert.ok(Object.keys(state.issues).length > 0)
    for (const id of Object.keys(state.issues)) {
      assert.equal(state.issues[id].firstSeen, false)
    }
    assert.equal(pushed.length, 0, 'first poll should not push anything')
  })

  it('pushes once for a new comment and deduplicates subsequent polls', async () => {
    startLinearNotifier({ store })
    stopLinearNotifier()
    await new Promise((r) => setTimeout(r, 100))

    // Now simulate a new comment appearing on the next poll.
    let call = 0
    global.fetch = async (url, opts) => {
      if (url.includes('api.linear.app')) {
        const body = JSON.parse(opts.body || '{}')
        const variables = body.variables || {}
        const issueNumber = variables.number ?? 1
        call++
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              issues: {
                nodes: [{
                  id: `issue-${issueNumber}`,
                  identifier: `${variables.team || 'MES'}-${issueNumber}`,
                  title: 'Test issue',
                  url: 'https://linear.app/test/issue/TEST-1',
                  state: { name: 'In Progress', color: '#fff' },
                  comments: {
                    nodes: [
                      { id: `c-${issueNumber}-1`, body: 'first', createdAt: '2024-01-01T00:00:00Z', user: { displayName: 'A' } },
                      { id: `c-${issueNumber}-2`, body: 'new comment', createdAt: '2024-01-02T00:00:00Z', user: { displayName: 'B' } },
                    ],
                  },
                }],
              },
            },
          }),
        }
      }
      pushed.push({ url, opts })
      return { ok: true, status: 200, text: async () => '' }
    }

    await runLinearPoll()
    assert.ok(pushed.length > 0, 'new comment should trigger a push')
    const firstPushCount = pushed.length

    await runLinearPoll()
    assert.equal(pushed.length, firstPushCount, 'second poll should not push duplicates')
  })

  it('skips polling when no Linear API key is configured', async () => {
    const noKeyStore = createMockStore({
      linear_poll_minutes: 2,
      ntfy_url: 'http://10.18.8.55:80',
      ntfy_topic: 'zhiningwork',
    })
    // Ensure _store inside linear-notif.js points to the no-key store.
    startLinearNotifier({ store: noKeyStore })
    stopLinearNotifier()
    const result = await runLinearPoll()
    assert.equal(result.polled, false)
    assert.equal(result.reason, 'no linear api key')
  })

  it('exposes a server-side ntfy test helper', async () => {
    const result = await pushNtfyTest()
    assert.equal(result.pushed, true)
    assert.equal(pushed.length, 1)
    assert.equal(pushed[0].opts.headers.Title, 'nanocode')
  })
})
