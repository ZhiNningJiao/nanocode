/**
 * Prompt skills (nanoskill_1730): versioned store, line diff, HTTP routes.
 *
 * The contract the dispatcher depends on:
 *   - /prompt returns the production version unless a version is pinned;
 *   - saving appends a version (old ones untouched) and, by default, moves
 *     the production label onto it;
 *   - rolling back moves the label only;
 *   - a save started from a stale version is refused (409), never merged;
 *   - an unknown skill is 404 (the dispatcher treats that as a hard error).
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { createPromptSkillsStore, SkillError } from '../prompt-skills-store.js'
import { createPromptSkillsRoutes } from '../prompt-skills-routes.js'
import { diffLines, diffStats, MAX_CELLS } from '../line-diff.js'
import { BUILTIN_PLUGINS, validateManifest } from '../../public/js/plugins-registry.js'

let dir
let clock
const now = () => clock

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nanocode-pskills-'))
  clock = 1_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const store = () => createPromptSkillsStore({ dir, now })

async function seed(s, name = 'role-worker', content = 'line a\nline b\n') {
  return s.createSkill({ name, title: '武器库段', description: '派车自动前置', content, author: 'importer', note: 'first import' })
}

describe('prompt-skills store', () => {
  it('create → v1 is production and is what /prompt returns', async () => {
    const s = store()
    const sk = await seed(s)
    assert.equal(sk.production, 1)
    assert.equal(sk.latest, 1)
    const p = await s.getPrompt('role-worker')
    assert.deepEqual([p.version, p.isProduction, p.content], [1, true, 'line a\nline b\n'])
  })

  it('save appends a version, keeps the old one byte-identical, moves production by default', async () => {
    const s = store()
    await seed(s)
    clock = 2_000
    const sk = await s.saveVersion('role-worker', { content: 'line a\nline B\n', baseVersion: 1, author: 'owner', note: 'fix b' })
    assert.equal(sk.production, 2)
    assert.equal(sk.versions.length, 2)
    assert.equal(sk.versions[0].content, 'line a\nline b\n')
    assert.equal((await s.getPrompt('role-worker')).content, 'line a\nline B\n')
    assert.equal(sk.updatedBy, 'owner')
    assert.equal(sk.updatedAt, 2_000)
  })

  it('makeProduction:false saves a draft — the dispatcher keeps getting the old production', async () => {
    const s = store()
    await seed(s)
    const sk = await s.saveVersion('role-worker', { content: 'draft\n', baseVersion: 1, makeProduction: false })
    assert.equal(sk.production, 1)
    assert.equal(sk.latest, 2)
    assert.equal((await s.getPrompt('role-worker')).version, 1)
    assert.equal((await s.getPrompt('role-worker', 2)).content, 'draft\n')
    assert.equal((await s.getPrompt('role-worker', 'v2')).isProduction, false)
  })

  it('rollback moves the label only — no version is added or removed', async () => {
    const s = store()
    await seed(s)
    await s.saveVersion('role-worker', { content: 'v2\n', baseVersion: 1 })
    clock = 5_000
    const sk = await s.setProduction('role-worker', { version: 1, author: 'owner' })
    assert.equal(sk.production, 1)
    assert.equal(sk.versions.length, 2)
    assert.equal((await s.getPrompt('role-worker')).content, 'line a\nline b\n')
    // the label move is the last change on the list page
    const [row] = await s.listSkills()
    assert.deepEqual([row.production, row.latest, row.updatedAt, row.updatedBy], [1, 2, 5_000, 'owner'])
  })

  it('refuses a save started from a stale version (conflict), never overwrites', async () => {
    const s = store()
    await seed(s)
    await s.saveVersion('role-worker', { content: 'theirs\n', baseVersion: 1 })
    await assert.rejects(
      s.saveVersion('role-worker', { content: 'mine\n', baseVersion: 1 }),
      (err) => err instanceof SkillError && err.code === 'conflict',
    )
    assert.equal((await s.getPrompt('role-worker')).content, 'theirs\n')
  })

  it('two concurrent saves on the same base: exactly one wins', async () => {
    const s = store()
    await seed(s)
    const results = await Promise.allSettled([
      s.saveVersion('role-worker', { content: 'A\n', baseVersion: 1 }),
      s.saveVersion('role-worker', { content: 'B\n', baseVersion: 1 }),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'conflict')
    assert.equal((await s.getSkill('role-worker')).versions.length, 2)
  })

  it('identical content is refused instead of minting an empty version', async () => {
    const s = store()
    await seed(s)
    await assert.rejects(s.saveVersion('role-worker', { content: 'line a\nline b\n', baseVersion: 1 }), { code: 'unchanged' })
  })

  it('rejects bad names (incl. path traversal), empty bodies, duplicates and unknown versions', async () => {
    const s = store()
    for (const bad of ['../etc/passwd', 'Role', 'a b', '', '凭据推送', '-x']) {
      await assert.rejects(s.createSkill({ name: bad, content: 'x' }), { code: 'invalid' }, bad)
    }
    await assert.rejects(s.createSkill({ name: 'ok', content: '   ' }), { code: 'invalid' })
    await seed(s)
    await assert.rejects(seed(s), { code: 'exists' })
    await assert.rejects(s.getPrompt('role-worker', 9), { code: 'not_found' })
    await assert.rejects(s.getPrompt('nope'), { code: 'not_found' })
    await assert.rejects(s.setProduction('role-worker', { version: 0 }), { code: 'invalid' })
  })

  it('writes atomically (no tmp left) and a corrupt file is an error row, not an empty skill', async () => {
    const s = store()
    await seed(s)
    await seed(s, 'cred-push', 'push rules\n')
    assert.deepEqual(readdirSync(dir).sort(), ['cred-push.json', 'role-worker.json'])
    writeFileSync(path.join(dir, 'cred-push.json'), '{ not json')
    const rows = await s.listSkills()
    assert.equal(rows.length, 2)
    assert.match(rows.find((r) => r.name === 'cred-push').error, /损坏/)
    await assert.rejects(s.getPrompt('cred-push'), { code: 'corrupt' })
  })

  it('a fresh store over the same dir sees the same history (state lives on disk)', async () => {
    await seed(store())
    await store().saveVersion('role-worker', { content: 'v2\n', baseVersion: 1 })
    const rec = JSON.parse(readFileSync(path.join(dir, 'role-worker.json'), 'utf8'))
    assert.deepEqual(rec.versions.map((v) => v.version), [1, 2])
    assert.equal(rec.production.version, 2)
  })

  it('empty or missing dir lists nothing', async () => {
    assert.deepEqual(await createPromptSkillsStore({ dir: path.join(dir, 'missing') }).listSkills(), [])
  })

  it('meta edits change title/description without minting a version', async () => {
    const s = store()
    await seed(s)
    const sk = await s.updateMeta('role-worker', { title: '新标题', description: '新说明' })
    assert.deepEqual([sk.title, sk.description, sk.versions.length], ['新标题', '新说明', 1])
  })
})

describe('line diff', () => {
  it('marks changed lines as del+add and keeps common lines', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n')
    assert.deepEqual(ops, [
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'B' },
      { op: 'same', text: 'c' },
      { op: 'add', text: 'd' },
    ])
    assert.deepEqual(diffStats(ops), { added: 2, deleted: 1 })
  })

  it('identical texts → only same ops; empty ↔ text → all adds / dels', () => {
    assert.deepEqual(diffStats(diffLines('x\ny', 'x\ny\n')), { added: 0, deleted: 0 })
    assert.deepEqual(diffStats(diffLines('', 'p\nq\n')), { added: 2, deleted: 0 })
    assert.deepEqual(diffStats(diffLines('p\nq\n', '')), { added: 0, deleted: 2 })
  })

  it('applying the ops to the old text reproduces the new text', () => {
    const a = 'k1\nk2\nk3\nk4\nk5\n'
    const b = 'k0\nk2\nk3x\nk4\nk6\nk7\n'
    const ops = diffLines(a, b)
    assert.equal(ops.filter((o) => o.op !== 'add').map((o) => o.text).join('\n') + '\n', a)
    assert.equal(ops.filter((o) => o.op !== 'del').map((o) => o.text).join('\n') + '\n', b)
  })

  it('refuses oversize inputs loudly', () => {
    const big = Array.from({ length: Math.ceil(Math.sqrt(MAX_CELLS)) + 1 }, (_, i) => `l${i}`).join('\n')
    assert.throws(() => diffLines(big, big + '\nz'), /diff too large/)
  })
})

describe('prompt-skills HTTP routes', () => {
  let server
  let base

  beforeEach(async () => {
    const app = express()
    app.use(express.json())
    app.use(createPromptSkillsRoutes({ store: createPromptSkillsStore({ dir, now }) }))
    server = http.createServer(app)
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterEach(() => new Promise((r) => server.close(r)))

  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') }
  }

  it('create → list → prompt → save → diff → rollback, end to end', async () => {
    let r = await call('POST', '/api/prompt-skills', { name: 'cred-push', title: '凭据推送', content: 'one\ntwo\n', author: 'importer' })
    assert.equal(r.status, 200)
    r = await call('GET', '/api/prompt-skills')
    assert.deepEqual(r.body.skills.map((s) => [s.name, s.title, s.production]), [['cred-push', '凭据推送', 1]])
    assert.equal(r.body.skills[0].content, undefined, 'list must not ship bodies')

    r = await call('POST', '/api/prompt-skills/cred-push/versions', { content: 'one\nTWO\n', baseVersion: 1, author: 'owner' })
    assert.equal(r.body.production, 2)

    r = await call('GET', '/api/prompt-skills/cred-push/prompt')
    assert.deepEqual([r.status, r.body.version, r.body.content, r.cache], [200, 2, 'one\nTWO\n', 'no-store'])
    r = await call('GET', '/api/prompt-skills/cred-push/prompt?version=1')
    assert.deepEqual([r.body.version, r.body.isProduction], [1, false])

    r = await call('GET', '/api/prompt-skills/cred-push/diff?from=1&to=2')
    assert.deepEqual(r.body.stats, { added: 1, deleted: 1 })

    r = await call('POST', '/api/prompt-skills/cred-push/production', { version: 1, author: 'owner' })
    assert.equal(r.body.production, 1)
    r = await call('GET', '/api/prompt-skills/cred-push/prompt')
    assert.deepEqual([r.body.version, r.body.content], [1, 'one\ntwo\n'])
  })

  it('maps errors to status codes the dispatcher can tell apart', async () => {
    assert.equal((await call('GET', '/api/prompt-skills/nope/prompt')).status, 404)
    assert.equal((await call('GET', '/api/prompt-skills/BAD NAME/prompt')).status, 400)
    await call('POST', '/api/prompt-skills', { name: 'x', content: 'a\n' })
    assert.equal((await call('POST', '/api/prompt-skills', { name: 'x', content: 'a\n' })).status, 409)
    await call('POST', '/api/prompt-skills/x/versions', { content: 'b\n', baseVersion: 1 })
    const stale = await call('POST', '/api/prompt-skills/x/versions', { content: 'c\n', baseVersion: 1 })
    assert.deepEqual([stale.status, stale.body.code], [409, 'conflict'])
    assert.equal((await call('GET', '/api/prompt-skills/x/prompt?version=7')).status, 404)
    assert.equal((await call('GET', '/api/prompt-skills/x/diff?from=1')).status, 400)
    assert.ok(!existsSync(path.join(dir, 'BAD NAME.json')))
  })
})

describe('prompt-skills plugin manifest', () => {
  it('is a valid optional built-in in the monitor group (not in the kernel set)', () => {
    const m = BUILTIN_PLUGINS.find((p) => p.name === 'prompt-skills')
    assert.ok(m)
    assert.deepEqual(validateManifest(m), { ok: true, errors: [] })
    assert.equal(m.group, 'monitor')
    assert.notEqual(m.defaultOn, true)
  })
})
