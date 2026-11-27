/**
 * HTTP layer for prompt skills — parse → call → respond only. Versioning,
 * conflict and label rules live in server/prompt-skills-store.js; the diff in
 * server/line-diff.js.
 *
 *   GET  /api/prompt-skills                      list (no bodies)
 *   GET  /api/prompt-skills/:name                one skill, every version
 *   GET  /api/prompt-skills/:name/prompt[?version=N]
 *        read-only text a dispatcher pulls: production unless pinned
 *   GET  /api/prompt-skills/:name/diff?from=A&to=B
 *   POST /api/prompt-skills                      create { name, title, description, content, author, note }
 *   POST /api/prompt-skills/:name/versions       save { content, baseVersion, author, note, makeProduction }
 *   POST /api/prompt-skills/:name/production     set label / roll back { version, author }
 *   PUT  /api/prompt-skills/:name/meta           { title, description }
 *
 * (/api/skills is the unrelated read-only Claude-native skills browser.)
 */
import express from 'express'
import { createPromptSkillsStore, parseVersionNumber, SkillError } from './prompt-skills-store.js'
import { diffLines, diffStats } from './line-diff.js'

const STATUS_BY_CODE = { invalid: 400, unchanged: 400, not_found: 404, exists: 409, conflict: 409, corrupt: 500 }

export function createPromptSkillsRoutes({ store = createPromptSkillsStore() } = {}) {
  const router = express.Router()

  const handle = (fn) => async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json(await fn(req))
    } catch (err) {
      if (err instanceof SkillError) return res.status(STATUS_BY_CODE[err.code] || 400).json({ error: err.message, code: err.code })
      next(err)
    }
  }

  router.get('/api/prompt-skills', handle(async () => ({ skills: await store.listSkills() })))

  router.get('/api/prompt-skills/:name', handle((req) => store.getSkill(req.params.name)))

  router.get('/api/prompt-skills/:name/prompt', handle((req) => store.getPrompt(req.params.name, req.query.version ?? null)))

  router.get('/api/prompt-skills/:name/diff', handle(async (req) => {
    const from = await store.getPrompt(req.params.name, parseVersionNumber(req.query.from))
    const to = await store.getPrompt(req.params.name, parseVersionNumber(req.query.to))
    const ops = diffLines(from.content, to.content)
    return { name: req.params.name, from: from.version, to: to.version, stats: diffStats(ops), ops }
  }))

  router.post('/api/prompt-skills', handle((req) => store.createSkill(req.body || {})))

  router.post('/api/prompt-skills/:name/versions', handle((req) => store.saveVersion(req.params.name, req.body || {})))

  router.post('/api/prompt-skills/:name/production', handle((req) => store.setProduction(req.params.name, req.body || {})))

  router.put('/api/prompt-skills/:name/meta', handle((req) => store.updateMeta(req.params.name, req.body || {})))

  return router
}
