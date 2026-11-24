#!/usr/bin/env node
/**
 * Phone input board — WSL half. The owner dictates on the phone into a chat
 * group that only they and the bot are in; this process polls that group and
 * hands each new owner text message, as one paste instruction, to the Windows
 * half (phone-input-client.ps1) over a loopback long-poll API. The Windows
 * half pastes it at the cursor and acks; the ack becomes a reaction on the
 * chat message (pasted / not pasted), so the phone shows what happened.
 *
 *   node tools/phone-input/phone-input.mjs --config config/phone-input.local.json [--dry-run]
 *   node tools/phone-input/phone-input.mjs --config ... --self-check     (one read-only list, then exit)
 *
 * Why polling and not the chat event stream: the event stream delivers each
 * event to ONE of the app's connections, so a second subscriber would steal
 * messages from any other process that already subscribes with the same bot.
 *
 * Loopback API (bound to 127.0.0.1 only; every request carries the shared key
 * in KEY_HEADER, the key lives in a local file, never in the repo):
 *   GET  /next?wait=<ms>  long-poll; 200 {id,text,enter} hands out (and
 *                         dequeues) the oldest instruction, 204 = nothing yet
 *   GET  /next?probe=1    200 {probe,queued,dryRun} — dequeues nothing
 *   POST /ack {id,result} result "pasted" → pasted reaction, anything else →
 *                         not-pasted reaction
 * Response bodies are ASCII-only JSON (non-ASCII as \uXXXX escapes), so the
 * Windows side never depends on a code page: the text arrives as the exact
 * UTF-16 the chat sent (CJK, emoji and line breaks included).
 *
 * Delivery is at-most-once: a message id is recorded as seen when it is
 * handed out (or deliberately dropped), never pasted twice across restarts.
 * Undelivered queue entries are not seen yet, so a quick restart re-queues
 * them. After a gap longer than maxGapMs without a successful poll (process
 * down, network down) the messages sent meanwhile are NOT pasted late into
 * whatever window is focused now: they get the not-pasted reaction instead.
 *
 * Privacy: message text lives only in memory (queue) and in the /next reply.
 * Logs carry message id, length, timings and results; the state file carries
 * ids and one timestamp.
 */

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeAtomic } from '../command-center/export-cars.mjs'

export const KEY_HEADER = 'x-phone-input-key'
export const STATE_SCHEMA = 'phone-input-state/v1'
export const RESULT_PASTED = 'pasted'

// The one place every default lives (the Windows client's -Port default is
// checked against DEFAULTS.port by the test suite).
export const DEFAULTS = Object.freeze({
  larkCli: 'lark-cli',
  keyFile: '~/.config/phone-input/key',
  stateFile: '~/.local/state/phone-input/state.json',
  port: 9497,
  pollMs: 800,
  pageSize: 20,
  larkTimeoutMs: 8000,
  backoffMaxMs: 30000,
  maxGapMs: 120000,
  queueMaxAgeMs: 60000,
  ackTimeoutMs: 60000,
  longPollMaxMs: 25000,
  stateFlushMs: 10000,
  seenMax: 500,
  reactions: { pasted: 'CheckMark', notPasted: 'CrossMark' },
})
const MIN_KEY_CHARS = 32
const ACK_BODY_MAX_BYTES = 4096

// ─── pure: message → instruction ────────────────────────────────────────────

// A message that ends in 回车 (optionally followed by whitespace or the
// sentence-final punctuation a dictation app appends) means "paste, then press
// Enter". The word and the whitespace around it are removed.
const ENTER_SUFFIX_RE = /^([\s\S]*?)\s*回车[\s。．.!！]*$/

/** Chat text → {text, enter}. Line breaks become CRLF (Windows clipboard text). */
export function toInstruction(content) {
  const m = ENTER_SUFFIX_RE.exec(content)
  const body = m ? m[1].replace(/\s+$/, '') : content
  return { text: body.replace(/\r?\n/g, '\r\n'), enter: Boolean(m) }
}

/** Why a listed message is not a paste candidate, or '' when it is one. */
export function rejectReason(msg, ownerOpenId) {
  if (msg.deleted) return 'deleted'
  if (msg.sender?.sender_type !== 'user') return 'not_user'
  if (msg.sender?.id !== ownerOpenId) return 'not_owner'
  if (msg.msg_type !== 'text') return 'not_text'
  if (typeof msg.content !== 'string' || msg.content === '') return 'empty'
  return ''
}

/**
 * One successful poll → what to do. `messages` is the list as returned
 * (newest first). lastPollOkAt null = first start ever: everything already in
 * the chat is history (baseline, never pasted).
 * → { enqueue: [{id, text, enter}], drop: [{id, reason, react}] }
 *   every id in enqueue/drop is new (not seen, not queued).
 */
export function planPoll({ messages, seen, queued, lastPollOkAt, now, ownerOpenId, maxGapMs }) {
  const cold = lastPollOkAt == null
  const gap = !cold && now - lastPollOkAt > maxGapMs
  const enqueue = []
  const drop = []
  for (const msg of [...messages].reverse()) {
    const id = msg?.message_id
    if (typeof id !== 'string' || !id || seen.has(id) || queued.has(id)) continue
    const why = rejectReason(msg, ownerOpenId)
    if (why) drop.push({ id, reason: why, react: false })
    else if (cold) drop.push({ id, reason: 'baseline', react: false })
    else if (gap) drop.push({ id, reason: 'gap', react: true })
    else enqueue.push({ id, ...toInstruction(msg.content) })
  }
  return { enqueue, drop }
}

/** JSON with every non-ASCII UTF-16 unit escaped — safe through any code page. */
export function asciiJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

// ─── config ─────────────────────────────────────────────────────────────────

function expandHome(p) {
  return typeof p === 'string' && p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p
}

/** Local config JSON → full config. Fails loudly on anything missing. */
export function resolveConfig(raw) {
  const cfg = { ...DEFAULTS, ...raw, reactions: { ...DEFAULTS.reactions, ...(raw?.reactions || {}) } }
  if (!/^oc_\w+$/.test(cfg.chatId || '')) throw new Error('config.chatId must be the group chat id (oc_...)')
  if (!/^ou_\w+$/.test(cfg.ownerOpenId || '')) throw new Error('config.ownerOpenId must be the owner open_id (ou_...)')
  cfg.keyFile = expandHome(cfg.keyFile)
  cfg.stateFile = expandHome(cfg.stateFile)
  return cfg
}

export async function readKey(keyFile) {
  const key = (await readFile(keyFile, 'utf8')).trim()
  if (key.length < MIN_KEY_CHARS) throw new Error(`key file ${keyFile} must hold at least ${MIN_KEY_CHARS} characters`)
  return key
}

async function readState(stateFile) {
  let text
  try { text = await readFile(stateFile, 'utf8') } catch (err) {
    if (err.code === 'ENOENT') return { seen: [], lastPollOkAt: null }
    throw err
  }
  const st = JSON.parse(text)
  if (st?.schema !== STATE_SCHEMA || !Array.isArray(st.seen)) throw new Error(`state file ${stateFile} is not ${STATE_SCHEMA}`)
  return { seen: st.seen.filter((x) => typeof x === 'string'), lastPollOkAt: Number.isFinite(st.lastPollOkAt) ? st.lastPollOkAt : null }
}

// ─── chat CLI ───────────────────────────────────────────────────────────────

function runLark(cfg, args) {
  return new Promise((done) => {
    execFile(cfg.larkCli, args, { timeout: cfg.larkTimeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      done({ err, stdout, stderr: String(stderr || '').replace(/\s+/g, ' ').slice(0, 160) })
    })
  })
}

/** → {ok:true, messages} | {ok:false, reason}. Never logs or returns stdout on failure (it may hold text). */
export async function listMessages(cfg) {
  const { err, stdout, stderr } = await runLark(cfg, [
    'im', '+chat-messages-list', '--chat-id', cfg.chatId, '--as', 'bot',
    '--order', 'desc', '--page-size', String(cfg.pageSize), '--no-reactions', '--format', 'json',
  ])
  if (err) return { ok: false, reason: err.killed ? 'timeout' : `exit_${err.code ?? 'spawn'}`, stderr }
  let out
  try { out = JSON.parse(stdout) } catch { return { ok: false, reason: 'bad_json' } }
  if (out?.ok !== true || !Array.isArray(out?.data?.messages)) return { ok: false, reason: 'bad_shape' }
  return { ok: true, messages: out.data.messages }
}

async function addReaction(cfg, messageId, emojiType) {
  const { err, stderr } = await runLark(cfg, [
    'im', 'reactions', 'create', '--as', 'bot',
    '--params', JSON.stringify({ message_id: messageId }),
    '--data', JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
  ])
  return err ? { ok: false, reason: err.killed ? 'timeout' : `exit_${err.code ?? 'spawn'}`, stderr } : { ok: true }
}

// ─── service ────────────────────────────────────────────────────────────────

function defaultLog(event, fields = {}) {
  const kv = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`).join(' ')
  console.log(`${new Date().toISOString()} phone-input ${event}${kv ? ` ${kv}` : ''}`)
}

const isPowerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0

/**
 * Start the poller + loopback API. Resolves once the port is listening.
 * → { port, stop() }
 */
export async function startPhoneInput({ config, key, dryRun = false, log = defaultLog, now = Date.now }) {
  const cfg = config
  const state = await readState(cfg.stateFile)
  const seen = new Set(state.seen)
  let lastPollOkAt = state.lastPollOkAt
  const queue = []          // [{id, text, enter, queuedAt}]
  const waiters = []        // [{res, timer}]
  const pending = new Map() // id → timer (handed out, waiting for /ack)
  let stopped = false
  let pollTimer = null
  let failures = 0
  let lastFlushAt = 0
  let writeChain = Promise.resolve()
  let reactChain = Promise.resolve()

  const flushState = () => {
    lastFlushAt = now()
    const snap = { schema: STATE_SCHEMA, seen: [...seen].slice(-cfg.seenMax), lastPollOkAt, updatedAt: lastFlushAt }
    writeChain = writeChain.then(() => writeAtomic(cfg.stateFile, snap)).catch((err) => log('state_write_fail', { error: err.code || err.message }))
    return writeChain
  }
  const markSeen = (id) => {
    seen.add(id)
    if (seen.size > cfg.seenMax) seen.delete(seen.values().next().value)
  }
  const react = (id, kind) => {
    const emoji = cfg.reactions[kind]
    if (dryRun || !emoji) return
    reactChain = reactChain.then(async () => {
      const r = await addReaction(cfg, id, emoji)
      log(r.ok ? 'reaction_ok' : 'reaction_fail', { id, kind, ...(r.ok ? {} : { reason: r.reason, stderr: r.stderr }) })
    })
  }

  // ── queue / delivery
  const expireQueue = () => {
    const t = now()
    while (queue.length && t - queue[0].queuedAt > cfg.queueMaxAgeMs) {
      const item = queue.shift()
      markSeen(item.id)
      log('dropped', { id: item.id, reason: 'not_fetched', age_ms: t - item.queuedAt })
      react(item.id, 'notPasted')
      flushState()
    }
  }
  const deliver = (item, res) => {
    markSeen(item.id)
    flushState()
    pending.set(item.id, setTimeout(() => {
      pending.delete(item.id)
      log('ack_missing', { id: item.id })
    }, cfg.ackTimeoutMs))
    log('delivered', { id: item.id, len: item.text.length, enter: item.enter, wait_ms: now() - item.queuedAt })
    sendJson(res, 200, { id: item.id, text: item.text, enter: item.enter })
  }
  const pump = () => {
    expireQueue()
    while (queue.length && waiters.length) {
      const w = waiters.shift()
      clearTimeout(w.timer)
      if (w.res.destroyed || w.res.writableEnded) continue // the client went away mid long-poll
      deliver(queue.shift(), w.res)
    }
  }

  // ── poll loop
  const schedule = (ms) => { if (!stopped) pollTimer = setTimeout(pollGuarded, ms) }
  // A bug in one pass must not end polling for good: log it loudly, back off, go on.
  const pollGuarded = () => pollOnce().catch((err) => {
    log('poll_crash', { error: err.message })
    schedule(cfg.backoffMaxMs)
  })
  async function pollOnce() {
    const r = await listMessages(cfg)
    if (stopped) return
    if (!r.ok) {
      failures += 1
      const backoff = Math.min(cfg.pollMs * 2 ** failures, cfg.backoffMaxMs)
      if (isPowerOfTwo(failures)) log('poll_fail', { failures, reason: r.reason, next_ms: backoff, ...(r.stderr ? { stderr: r.stderr } : {}) })
      schedule(backoff)
      return
    }
    if (failures) log('poll_recovered', { failures })
    failures = 0
    const t = now()
    const plan = planPoll({
      messages: r.messages, seen, queued: new Set(queue.map((q) => q.id)), lastPollOkAt, now: t,
      ownerOpenId: cfg.ownerOpenId, maxGapMs: cfg.maxGapMs,
    })
    lastPollOkAt = t
    for (const d of plan.drop) {
      markSeen(d.id)
      log('skipped', { id: d.id, reason: d.reason })
      if (d.react) react(d.id, 'notPasted')
    }
    for (const it of plan.enqueue) {
      if (dryRun) {
        markSeen(it.id)
        log('dry_run', { id: it.id, len: it.text.length, enter: it.enter })
        continue
      }
      queue.push({ ...it, queuedAt: t })
      log('queued', { id: it.id, len: it.text.length, enter: it.enter })
    }
    const seenChanged = plan.drop.length > 0 || (dryRun && plan.enqueue.length > 0)
    if (seenChanged || t - lastFlushAt >= cfg.stateFlushMs) flushState()
    pump()
    schedule(cfg.pollMs)
  }

  // ── loopback API
  const keyDigest = createHash('sha256').update(key).digest()
  const authed = (req) => {
    const got = req.headers[KEY_HEADER]
    return typeof got === 'string' && timingSafeEqual(createHash('sha256').update(got).digest(), keyDigest)
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback')
    if (!authed(req)) return sendJson(res, 401, { error: 'unauthorized' })
    if (req.method === 'GET' && url.pathname === '/next') {
      if (url.searchParams.get('probe') === '1') {
        return sendJson(res, 200, { probe: true, queued: queue.length, dryRun })
      }
      const wait = Math.max(0, Math.min(Number(url.searchParams.get('wait')) || 0, cfg.longPollMaxMs))
      expireQueue()
      if (queue.length) return deliver(queue.shift(), res)
      if (!wait) return sendEmpty(res, 204)
      const w = { res, timer: null }
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
        sendEmpty(res, 204)
      }, wait)
      res.on('close', () => {
        const i = waiters.indexOf(w)
        if (i >= 0) { waiters.splice(i, 1); clearTimeout(w.timer) }
      })
      waiters.push(w)
      return
    }
    if (req.method === 'POST' && url.pathname === '/ack') {
      return readBody(req, ACK_BODY_MAX_BYTES).then((body) => {
        let ack
        try { ack = JSON.parse(body) } catch { return sendJson(res, 400, { error: 'bad_json' }) }
        const id = typeof ack?.id === 'string' ? ack.id : ''
        if (!pending.has(id)) return sendJson(res, 404, { error: 'unknown_id' })
        clearTimeout(pending.get(id))
        pending.delete(id)
        const result = typeof ack.result === 'string' ? ack.result.slice(0, 40) : 'unknown'
        log('acked', { id, result, ms: Number.isFinite(ack.ms) ? ack.ms : -1 })
        react(id, result === RESULT_PASTED ? 'pasted' : 'notPasted')
        sendJson(res, 200, { ok: true })
      }, () => sendJson(res, 413, { error: 'too_large' }))
    }
    sendJson(res, 404, { error: 'not_found' })
  })
  await new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(cfg.port, '127.0.0.1', () => { server.off('error', fail); ok() })
  })
  const port = server.address().port
  log('started', { port, dry_run: dryRun, seen: seen.size, cold: lastPollOkAt == null })
  schedule(0)

  return {
    port,
    async stop() {
      stopped = true
      clearTimeout(pollTimer)
      for (const w of waiters.splice(0)) { clearTimeout(w.timer); sendEmpty(w.res, 204) }
      for (const t of pending.values()) clearTimeout(t)
      server.closeAllConnections?.()
      await new Promise((ok) => server.close(() => ok()))
      await flushState()
      await reactChain
    },
  }
}

function sendJson(res, status, obj) {
  const body = asciiJson(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}
function sendEmpty(res, status) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'cache-control': 'no-store' })
  res.end()
}
function readBody(req, maxBytes) {
  return new Promise((ok, fail) => {
    const chunks = []
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > maxBytes) { fail(new Error('too_large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { config: 'config/phone-input.local.json', dryRun: false, selfCheck: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') args.config = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--self-check') args.selfCheck = true
    else throw new Error(`unknown argument ${a}`)
  }
  return args
}

/** Read-only: config, key file, one list call. Prints counts, never text. */
async function selfCheck(cfg) {
  await readKey(cfg.keyFile)
  console.log(`config ok: port=${cfg.port} poll_ms=${cfg.pollMs} state=${cfg.stateFile}`)
  console.log('key file ok')
  const r = await listMessages(cfg)
  if (!r.ok) throw new Error(`list failed: ${r.reason} ${r.stderr || ''}`)
  const owner = r.messages.filter((m) => !rejectReason(m, cfg.ownerOpenId)).length
  console.log(`list ok: ${r.messages.length} messages, ${owner} owner text messages`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cfg = resolveConfig(JSON.parse(await readFile(args.config, 'utf8')))
  if (args.selfCheck) return selfCheck(cfg)
  const svc = await startPhoneInput({ config: cfg, key: await readKey(cfg.keyFile), dryRun: args.dryRun })
  const quit = (sig) => {
    defaultLog('stopping', { signal: sig })
    svc.stop().then(() => process.exit(0), () => process.exit(1))
  }
  process.on('SIGTERM', quit)
  process.on('SIGINT', quit)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => { console.error(`[phone-input] ${err.message}`); process.exit(2) })
}
