// Phone input board (tools/phone-input): chat group → loopback paste queue.
// The WSL half runs for real here against a fake lark-cli that prints a
// recorded `im +chat-messages-list` output; the Windows half is played by
// plain HTTP calls doing exactly what phone-input-client.ps1 does
// (GET /next long-poll with the key header → POST /ack), and the .ps1 itself
// is checked against the same protocol constants.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULTS, KEY_HEADER, STATE_SCHEMA, toInstruction, rejectReason, planPoll, asciiJson, resolveConfig, startPhoneInput,
} from '../../tools/phone-input/phone-input.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures', 'phone-input')
const FAKE_LARK = path.join(FIXTURES, 'fake-lark-cli.mjs')
const CLIENT_PS1 = path.join(__dirname, '..', '..', 'tools', 'phone-input', 'phone-input-client.ps1')
// Fixture files live in a gitignored dir inside this worktree — never host /tmp.
const TMP = path.join(__dirname, '.fixtures-tmp', 'phone-input')
const KEY = 'k'.repeat(40)
const OWNER = 'ou_ownertest'
const MULTI = '第一行：中文，标点。\n第二行 emoji 🙂👍🏽 和 "引号" \\ 反斜杠\n\n第四行'

// Every env ever made; a failing assertion outside a try/finally must not leave
// a service polling (that would keep the test process alive forever).
const ENVS = []
after(async () => {
  for (const env of ENVS) await env.stop()
  await rm(TMP, { recursive: true, force: true })
})

function msg(id, content, over = {}) {
  return {
    message_id: id, msg_type: 'text', create_time: '2026-11-23 15:00', deleted: false, updated: false, chat_id: 'oc_phonetest',
    sender: { id: OWNER, id_type: 'open_id', sender_type: 'user', name: 'owner' }, content, ...over,
  }
}

async function waitFor(pred, what, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** One isolated fake environment: its own fake-lark dir, state file and logs. */
async function makeEnv(name, over = {}) {
  const dir = path.join(TMP, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const recorded = JSON.parse(await readFile(path.join(FIXTURES, 'messages.json'), 'utf8'))
  const env = {
    dir,
    recorded,
    logs: [],
    config: resolveConfig({
      chatId: 'oc_phonetest', ownerOpenId: OWNER, larkCli: FAKE_LARK,
      keyFile: path.join(dir, 'key'), stateFile: path.join(dir, 'state.json'),
      port: 0, pollMs: 20, backoffMaxMs: 400, maxGapMs: 5000, queueMaxAgeMs: 3000, ackTimeoutMs: 3000,
      longPollMaxMs: 3000, stateFlushMs: 50, ...over,
    }),
    svc: null,
    async setMessages(newestFirst) {
      const out = structuredClone(this.recorded)
      out.data.messages = [...newestFirst, ...this.recorded.data.messages]
      await writeFile(path.join(dir, 'list.json'), JSON.stringify(out))
    },
    async start(opts = {}) {
      process.env.FAKE_LARK_DIR = dir
      this.svc = await startPhoneInput({
        config: this.config, key: KEY, log: (event, fields = {}) => this.logs.push({ event, ...fields }), ...opts,
      })
      return this.svc
    },
    events(name) { return this.logs.filter((l) => l.event === name) },
    async calls() {
      const text = await readFile(path.join(dir, 'calls.jsonl'), 'utf8').catch(() => '')
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    },
    async reactions() {
      return (await this.calls()).filter((c) => c.argv[1] === 'reactions')
        .map((c) => ({ id: JSON.parse(c.argv[c.argv.indexOf('--params') + 1]).message_id, emoji: JSON.parse(c.argv[c.argv.indexOf('--data') + 1]).reaction_type.emoji_type }))
    },
    async next({ wait = 0, probe = false, key = KEY, signal } = {}) {
      const q = probe ? 'probe=1' : `wait=${wait}`
      const headers = key == null ? {} : { [KEY_HEADER]: key }
      const res = await fetch(`http://127.0.0.1:${this.svc.port}/next?${q}`, { headers, signal })
      const raw = await res.text()
      return { status: res.status, raw, body: raw ? JSON.parse(raw) : null }
    },
    async ack(id, result) {
      const res = await fetch(`http://127.0.0.1:${this.svc.port}/ack`, {
        method: 'POST', headers: { [KEY_HEADER]: KEY, 'content-type': 'application/json' }, body: JSON.stringify({ id, result, ms: 42 }),
      })
      return res.status
    },
    async stop() { if (this.svc) await this.svc.stop(); this.svc = null },
  }
  await writeFile(path.join(dir, 'list.json'), JSON.stringify(recorded))
  ENVS.push(env)
  return env
}

// ─── pure logic ─────────────────────────────────────────────────────────────

describe('toInstruction (message → paste instruction)', () => {
  it('pastes plain text as-is, no Enter', () => {
    assert.deepEqual(toInstruction('你好世界'), { text: '你好世界', enter: false })
  })
  it('a trailing 回车 is removed with the whitespace around it and means Enter', () => {
    assert.deepEqual(toInstruction('帮我看一下这个  回车  '), { text: '帮我看一下这个', enter: true })
    assert.deepEqual(toInstruction('ls -la回车'), { text: 'ls -la', enter: true })
    assert.deepEqual(toInstruction('提交吧\n回车'), { text: '提交吧', enter: true })
  })
  it('tolerates the sentence-final punctuation a dictation app appends after 回车', () => {
    assert.deepEqual(toInstruction('好的回车。'), { text: '好的', enter: true })
    assert.deepEqual(toInstruction('ok 回车!'), { text: 'ok', enter: true })
  })
  it('just 回车 = press Enter only', () => {
    assert.deepEqual(toInstruction('回车'), { text: '', enter: true })
  })
  it('回车 not at the end is ordinary text', () => {
    assert.deepEqual(toInstruction('回车键坏了'), { text: '回车键坏了', enter: false })
    assert.deepEqual(toInstruction('按回车了'), { text: '按回车了', enter: false })
  })
  it('line breaks become CRLF, everything else (CJK, emoji, quotes, backslash) byte-exact', () => {
    const { text, enter } = toInstruction(MULTI)
    assert.equal(enter, false)
    assert.equal(text, MULTI.replace(/\n/g, '\r\n'))
    assert.equal(text.replace(/\r\n/g, '\n'), MULTI)
  })
})

describe('rejectReason / planPoll', () => {
  it('only the owner\'s live text messages are candidates', () => {
    assert.equal(rejectReason(msg('om_a', 'x'), OWNER), '')
    assert.equal(rejectReason(msg('om_a', 'x', { sender: { id: 'cli_botapp', sender_type: 'app' } }), OWNER), 'not_user')
    assert.equal(rejectReason(msg('om_a', 'x', { sender: { id: 'ou_someoneelse', sender_type: 'user' } }), OWNER), 'not_owner')
    assert.equal(rejectReason(msg('om_a', '![Image](img_x)', { msg_type: 'image' }), OWNER), 'not_text')
    assert.equal(rejectReason(msg('om_a', 'x', { msg_type: 'post' }), OWNER), 'not_text')
    assert.equal(rejectReason(msg('om_a', 'x', { deleted: true }), OWNER), 'deleted')
    assert.equal(rejectReason(msg('om_a', ''), OWNER), 'empty')
  })
  it('first start ever: everything already listed is baseline, nothing queued', () => {
    const p = planPoll({ messages: [msg('om_2', 'b'), msg('om_1', 'a')], seen: new Set(), queued: new Set(), lastPollOkAt: null, now: 1e6, ownerOpenId: OWNER, maxGapMs: 1000 })
    assert.deepEqual(p.enqueue, [])
    assert.deepEqual(p.drop.map((d) => [d.id, d.reason, d.react]), [['om_1', 'baseline', false], ['om_2', 'baseline', false]])
  })
  it('running: new owner texts are queued oldest first; seen and queued ids are skipped', () => {
    const p = planPoll({
      messages: [msg('om_4', 'd'), msg('om_3', 'c'), msg('om_2', 'b'), msg('om_1', 'a')],
      seen: new Set(['om_1']), queued: new Set(['om_2']), lastPollOkAt: 1e6 - 500, now: 1e6, ownerOpenId: OWNER, maxGapMs: 1000,
    })
    assert.deepEqual(p.enqueue.map((e) => e.id), ['om_3', 'om_4'])
    assert.deepEqual(p.drop, [])
  })
  it('after a gap longer than maxGapMs: unseen owner texts are dropped with a visible reaction, not pasted late', () => {
    const p = planPoll({ messages: [msg('om_9', 'late')], seen: new Set(), queued: new Set(), lastPollOkAt: 1e6 - 5000, now: 1e6, ownerOpenId: OWNER, maxGapMs: 1000 })
    assert.deepEqual(p.enqueue, [])
    assert.deepEqual(p.drop, [{ id: 'om_9', reason: 'gap', react: true }])
  })
})

describe('asciiJson', () => {
  it('is pure ASCII and round-trips CJK, emoji (surrogate pairs) and control chars exactly', () => {
    const obj = { text: MULTI.replace(/\n/g, '\r\n') + ' \t' }
    const s = asciiJson(obj)
    assert.match(s, /^[\x20-\x7e]*$/)
    assert.deepEqual(JSON.parse(s), obj)
    assert.ok(s.includes('\\ud83d\\ude42'), 'emoji travels as an escaped surrogate pair')
  })
})

describe('resolveConfig', () => {
  it('fails loudly without the chat id or owner id', () => {
    assert.throws(() => resolveConfig({ ownerOpenId: OWNER }), /chatId/)
    assert.throws(() => resolveConfig({ chatId: 'oc_x' }), /ownerOpenId/)
  })
  it('keeps the defaults, merges reactions', () => {
    const c = resolveConfig({ chatId: 'oc_x', ownerOpenId: OWNER, reactions: { pasted: 'DONE' } })
    assert.equal(c.port, DEFAULTS.port)
    assert.deepEqual(c.reactions, { pasted: 'DONE', notPasted: 'CrossMark' })
  })
})

// ─── the WSL half end to end (fake lark-cli, real HTTP) ─────────────────────

describe('phone-input service (fake lark-cli + loopback protocol)', () => {
  it('new owner message → one instruction, exact text, ack → pasted reaction; history/bot/image/system never queued', async () => {
    const env = await makeEnv('flow')
    await env.start()
    try {
      await waitFor(() => env.events('skipped').length === 4, 'baseline of the 4 recorded messages')
      assert.deepEqual(env.events('skipped').map((s) => [s.id, s.reason]).sort(),
        [['om_hist1', 'not_user'], ['om_hist2', 'baseline'], ['om_hist3', 'not_text'], ['om_hist4', 'not_user']])
      assert.equal((await env.next()).status, 204, 'nothing from history')

      await env.setMessages([
        msg('om_new2', '第二条 回车'),
        msg('om_other', 'not mine', { sender: { id: 'ou_someoneelse', id_type: 'open_id', sender_type: 'user' } }),
        msg('om_botecho', 'echo', { sender: { id: 'cli_botapp', id_type: 'app_id', sender_type: 'app' } }),
        msg('om_new1', MULTI),
      ])
      const r1 = await env.next({ wait: 3000 })
      assert.equal(r1.status, 200)
      assert.match(r1.raw, /^[\x20-\x7e]*$/, '/next body is ASCII-only')
      assert.deepEqual(r1.body, { id: 'om_new1', text: MULTI.replace(/\n/g, '\r\n'), enter: false })
      const r2 = await env.next({ wait: 3000 })
      assert.deepEqual(r2.body, { id: 'om_new2', text: '第二条', enter: true })
      assert.equal((await env.next({ wait: 200 })).status, 204, 'each message handed out exactly once')

      assert.equal(await env.ack('om_new1', 'pasted'), 200)
      assert.equal(await env.ack('om_new2', 'not_interactive'), 200)
      assert.equal(await env.ack('om_new2', 'pasted'), 404, 'second ack for the same id is refused')
      await waitFor(async () => (await env.reactions()).length === 2, 'two reactions')
      assert.deepEqual(await env.reactions(), [{ id: 'om_new1', emoji: 'CheckMark' }, { id: 'om_new2', emoji: 'CrossMark' }])
      assert.ok(env.events('skipped').some((s) => s.id === 'om_other' && s.reason === 'not_owner'))
      assert.ok(env.events('skipped').some((s) => s.id === 'om_botecho' && s.reason === 'not_user'))
    } finally { await env.stop() }
  })

  it('a long-poll waiting before the message arrives gets it as soon as it is polled', async () => {
    const env = await makeEnv('longpoll')
    await env.start()
    try {
      await waitFor(() => env.events('skipped').length === 4, 'baseline')
      const pending = env.next({ wait: 3000 })
      await new Promise((r) => setTimeout(r, 100))
      const t0 = Date.now()
      await env.setMessages([msg('om_lp', 'hello')])
      const r = await pending
      assert.equal(r.status, 200)
      assert.equal(r.body.id, 'om_lp')
      assert.ok(Date.now() - t0 < 1500, `handed over within one poll (${Date.now() - t0} ms)`)
    } finally { await env.stop() }
  })

  it('a client that drops its long-poll does not swallow the next message', async () => {
    const env = await makeEnv('disconnect')
    await env.start()
    try {
      await waitFor(() => env.events('skipped').length === 4, 'baseline')
      const ac = new AbortController()
      const dead = env.next({ wait: 3000, signal: ac.signal }).catch((e) => e.name)
      await new Promise((r) => setTimeout(r, 100))
      ac.abort()
      assert.equal(await dead, 'AbortError')
      await new Promise((r) => setTimeout(r, 50))
      await env.setMessages([msg('om_after', 'still here')])
      const r = await env.next({ wait: 3000 })
      assert.equal(r.body?.id, 'om_after')
    } finally { await env.stop() }
  })

  it('auth: no key / wrong key = 401 and nothing is handed out; probe dequeues nothing', async () => {
    const env = await makeEnv('auth')
    await env.start()
    try {
      await waitFor(() => env.events('skipped').length === 4, 'baseline')
      await env.setMessages([msg('om_auth', 'secret words')])
      await waitFor(() => env.events('queued').length === 1, 'queued')
      const noKey = await env.next({ key: null })
      const wrong = await env.next({ key: 'x'.repeat(40) })
      assert.equal(noKey.status, 401)
      assert.equal(wrong.status, 401)
      assert.ok(!noKey.raw.includes('secret') && !wrong.raw.includes('secret'))
      const probe = await env.next({ probe: true })
      assert.deepEqual(probe.body, { probe: true, queued: 1, dryRun: false })
      assert.equal((await env.next()).body.id, 'om_auth', 'probe left it in the queue')
    } finally { await env.stop() }
  })

  it('restart: delivered messages are never handed out again, an undelivered one is (no double paste, no loss)', async () => {
    const env = await makeEnv('restart')
    await env.start()
    await waitFor(() => env.events('skipped').length === 4, 'baseline')
    await env.setMessages([msg('om_r2', 'not fetched yet'), msg('om_r1', 'fetched')])
    assert.equal((await env.next({ wait: 3000 })).body.id, 'om_r1')
    await waitFor(() => env.events('queued').length === 2, 'om_r2 queued')
    await env.stop()

    const st = JSON.parse(await readFile(env.config.stateFile, 'utf8'))
    assert.equal(st.schema, STATE_SCHEMA)
    assert.ok(st.seen.includes('om_r1') && !st.seen.includes('om_r2'))

    env.logs.length = 0
    await env.setMessages([msg('om_r3', 'new after restart'), msg('om_r2', 'not fetched yet'), msg('om_r1', 'fetched')])
    await env.start()
    try {
      assert.equal(env.events('started')[0].cold, false)
      assert.equal((await env.next({ wait: 3000 })).body.id, 'om_r2')
      assert.equal((await env.next({ wait: 3000 })).body.id, 'om_r3')
      assert.equal((await env.next({ wait: 300 })).status, 204, 'om_r1 not handed out again')
    } finally { await env.stop() }
  })

  it('restart after a long gap: what was sent meanwhile is not pasted late, it gets the not-pasted reaction', async () => {
    const env = await makeEnv('gap')
    await writeFile(env.config.stateFile, JSON.stringify({ schema: STATE_SCHEMA, seen: ['om_hist1', 'om_hist2', 'om_hist3', 'om_hist4'], lastPollOkAt: Date.now() - 60_000 }))
    await env.setMessages([msg('om_old', 'sent while down')])
    await env.start()
    try {
      await waitFor(() => env.events('skipped').some((s) => s.id === 'om_old'), 'om_old handled')
      assert.equal(env.events('skipped').find((s) => s.id === 'om_old').reason, 'gap')
      assert.equal((await env.next({ wait: 200 })).status, 204)
      await waitFor(async () => (await env.reactions()).length === 1, 'reaction')
      assert.deepEqual(await env.reactions(), [{ id: 'om_old', emoji: 'CrossMark' }])
      await env.setMessages([msg('om_fresh', 'now'), msg('om_old', 'sent while down')])
      assert.equal((await env.next({ wait: 3000 })).body.id, 'om_fresh', 'normal service right after')
    } finally { await env.stop() }
  })

  it('list failures back off exponentially, log only at 1/2/4/8… failures, then recover', async () => {
    const env = await makeEnv('backoff', { pollMs: 20, backoffMaxMs: 300 })
    await writeFile(path.join(env.dir, 'fail_next'), '6')
    await env.start()
    try {
      await waitFor(() => env.events('poll_recovered').length === 1, 'recovery', 6000)
      const lists = (await env.calls()).filter((c) => c.argv[1] === '+chat-messages-list')
      const gaps = lists.slice(1, 7).map((c, i) => c.t - lists[i].t)
      // 20ms·2^n capped at 300: 40, 80, 160, 300, 300, 300 (+ spawn time)
      assert.ok(gaps[0] >= 35 && gaps[1] >= 75 && gaps[2] >= 150 && gaps[3] >= 290 && gaps[5] >= 290, `gaps ${gaps}`)
      assert.deepEqual(env.events('poll_fail').map((f) => f.failures), [1, 2, 4])
      assert.equal(env.events('poll_fail')[0].reason, 'exit_1')
      assert.deepEqual(env.events('poll_recovered').map((f) => f.failures), [6])
      assert.equal(env.events('skipped').length, 4, 'baseline taken on the first good poll')
    } finally { await env.stop() }
  })

  it('an instruction nobody fetches expires and gets the not-pasted reaction (never pasted minutes late)', async () => {
    const env = await makeEnv('expire', { queueMaxAgeMs: 150 })
    await env.start()
    try {
      await waitFor(() => env.events('skipped').length === 4, 'baseline')
      await env.setMessages([msg('om_exp', 'too late')])
      await waitFor(() => env.events('dropped').length === 1, 'expiry')
      assert.equal(env.events('dropped')[0].reason, 'not_fetched')
      assert.equal((await env.next({ wait: 200 })).status, 204)
      await waitFor(async () => (await env.reactions()).length === 1, 'reaction')
      assert.deepEqual(await env.reactions(), [{ id: 'om_exp', emoji: 'CrossMark' }])
    } finally { await env.stop() }
  })

  it('--dry-run: logs what it would paste, hands out nothing, reacts to nothing', async () => {
    const env = await makeEnv('dryrun')
    await env.start({ dryRun: true })
    try {
      await waitFor(() => env.events('skipped').length === 4, 'baseline')
      await env.setMessages([msg('om_dry', '试一下回车')])
      await waitFor(() => env.events('dry_run').length === 1, 'dry_run line')
      assert.deepEqual(env.events('dry_run')[0], { event: 'dry_run', id: 'om_dry', len: 3, enter: true })
      assert.equal((await env.next({ wait: 200 })).status, 204)
      assert.deepEqual((await env.next({ probe: true })).body, { probe: true, queued: 0, dryRun: true })
      assert.deepEqual(await env.reactions(), [])
    } finally { await env.stop() }
  })

  it('privacy: message text never reaches the logs or the state file', async () => {
    const env = await makeEnv('privacy')
    await env.start()
    try {
      await waitFor(() => env.events('skipped').length === 4, 'baseline')
      await env.setMessages([msg('om_p', MULTI)])
      const r = await env.next({ wait: 3000 })
      await env.ack(r.body.id, 'pasted')
      await waitFor(async () => (await env.reactions()).length === 1, 'reaction')
    } finally { await env.stop() }
    const logText = JSON.stringify(env.logs)
    const state = await readFile(env.config.stateFile, 'utf8')
    for (const needle of ['第一行', '🙂', '反斜杠', 'history text never pasted', 'bot says hi']) {
      assert.ok(!logText.includes(needle) && !logText.includes(JSON.stringify(needle).slice(1, -1)), `log leaks ${needle}`)
      assert.ok(!state.includes(needle), `state leaks ${needle}`)
    }
    assert.deepEqual(Object.keys(JSON.parse(state)).sort(), ['lastPollOkAt', 'schema', 'seen', 'updatedAt'])
  })
})

// ─── the Windows half speaks the same protocol ──────────────────────────────

describe('phone-input-client.ps1 protocol contract', () => {
  let ps1
  before(async () => { ps1 = await readFile(CLIENT_PS1, 'utf8') })

  it('is ASCII-only (Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page)', () => {
    assert.match(ps1, /^[\x09\x0a\x0d\x20-\x7e]*$/)
  })
  it('uses the same port default, key header and endpoints as the WSL half', () => {
    assert.equal(Number(/\[int\]\$Port = (\d+)/.exec(ps1)?.[1]), DEFAULTS.port)
    assert.equal(/\$HeaderName = '([^']+)'/.exec(ps1)?.[1].toLowerCase(), KEY_HEADER)
    assert.match(ps1, /'\/next\?wait=' \+ \$LongPollMs/)
    assert.match(ps1, /'\/next\?probe=1'/)
    assert.match(ps1, /'POST' '\/ack'/)
    assert.ok(Number(/\$LongPollMs = (\d+)/.exec(ps1)[1]) <= DEFAULTS.longPollMaxMs)
    assert.ok(Number(/\$LongPollTimeoutMs = (\d+)/.exec(ps1)[1]) > DEFAULTS.longPollMaxMs, 'socket timeout outlives the server-side wait')
    assert.match(ps1, /http:\/\/127\.0\.0\.1:\$Port/)
  })
  it('acks with the result word the WSL half turns into the pasted reaction', () => {
    assert.match(ps1, /\$result = 'pasted'/)
  })
  it('pastes with Ctrl+V, presses Enter only when told, checks the desktop before taking and before pasting', () => {
    assert.match(ps1, /SendWait\('\^v'\)/)
    assert.match(ps1, /if \(\$item\.enter\)[\s\S]*SendWait\('\{ENTER\}'\)/)
    assert.equal(ps1.match(/\[PhoneInputDesk\]::Blocker\(\)/g).length, 3, 'self-check + before /next + before paste')
    assert.match(ps1, /OpenInputDesktop/)
  })
  it('never writes the text anywhere but the clipboard, never talks to the chat service', () => {
    for (const bad of ['Out-File', 'Set-Content', 'Add-Content', 'Export-', 'Write-Host', 'lark', 'feishu', 'Start-Transcript']) {
      assert.ok(!ps1.includes(bad), `client must not use ${bad}`)
    }
  })
})
