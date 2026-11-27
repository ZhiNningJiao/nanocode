/**
 * Prompt skills — versioned prompt templates the dispatcher pulls by name
 * (owner 2026-11-27: "skill 提示词模板, 和 langfuse 一样").
 *
 * One JSON file per skill under `dir` (default data/prompt-skills/, gitignored
 * with the rest of data/):
 *
 *   { name, title, description,
 *     production: { version, by, at },          // the "生效版本" label
 *     versions: [{ version, content, author, note, createdAt }] }
 *
 * Rules (same robustness rules as store.js — do not weaken):
 *   - Versions are append-only. Saving never rewrites an old version; rolling
 *     back moves the production label (Langfuse's `production` label), it does
 *     not copy or delete content.
 *   - Every write is tmp+rename atomic, and writes to one skill are serialised
 *     in-process so two saves cannot interleave a read-modify-write.
 *   - A save carries the version the editor started from (baseVersion); if
 *     someone saved in between, the save is refused (conflict) instead of
 *     silently overwriting their edit.
 *   - A corrupt skill file is an error the caller sees, never an empty skill.
 *
 * All disk IO goes through timedFs (home-fs slot budget, bounded-scan.js).
 */

import path from 'node:path'
import { timedFs } from '../terminal/bounded-scan.js'

const { readFile, writeFile, rename, readdir, mkdir } = timedFs

export const DEFAULT_PROMPT_SKILLS_DIR = path.join('data', 'prompt-skills')
// ASCII slug so the name survives env vars, URLs and file names untouched
// (SKILLS=role-worker,cred-push); the human-facing name is `title`.
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const MAX_CONTENT_BYTES = 256 * 1024
const MAX_TITLE = 80
const MAX_DESCRIPTION = 300
const MAX_NOTE = 500
const MAX_AUTHOR = 60

export class SkillError extends Error {
  /** code: invalid | not_found | exists | conflict | unchanged | corrupt */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function cleanText(value, max, field, { required = false } = {}) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (required && !s) throw new SkillError('invalid', `${field} 不能为空`)
  if (s.length > max) throw new SkillError('invalid', `${field} 太长（上限 ${max} 字）`)
  return s
}

function cleanContent(value) {
  if (typeof value !== 'string' || !value.trim()) throw new SkillError('invalid', '正文不能为空')
  if (Buffer.byteLength(value) > MAX_CONTENT_BYTES) {
    throw new SkillError('invalid', `正文太大（上限 ${MAX_CONTENT_BYTES} 字节）`)
  }
  return value
}

function cleanAuthor(value) {
  return cleanText(value, MAX_AUTHOR, '修改人') || '未署名'
}

export function assertSkillName(name) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    throw new SkillError('invalid', `技能名只能用小写字母、数字和连字符（如 role-worker），收到 ${JSON.stringify(name)}`)
  }
  return name
}

function parseVersionNumber(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/^v/i, ''))
  if (!Number.isInteger(n) || n < 1) throw new SkillError('invalid', `版本号不对：${JSON.stringify(value)}`)
  return n
}

function latestOf(rec) {
  return rec.versions[rec.versions.length - 1]
}

function findVersion(rec, version) {
  const v = rec.versions.find((x) => x.version === version)
  if (!v) throw new SkillError('not_found', `技能 ${rec.name} 没有 v${version}`)
  return v
}

/** Summary row for the list page — everything but the version bodies. */
function summarize(rec) {
  const latest = latestOf(rec)
  // "Last change" is whichever happened last: a new version or a label move.
  const labelMovedLater = rec.production.at > latest.createdAt
  return {
    name: rec.name,
    title: rec.title,
    description: rec.description,
    production: rec.production.version,
    latest: latest.version,
    versionCount: rec.versions.length,
    updatedAt: labelMovedLater ? rec.production.at : latest.createdAt,
    updatedBy: labelMovedLater ? rec.production.by : latest.author,
  }
}

function validateRecord(rec, file) {
  const ok = rec && typeof rec === 'object'
    && typeof rec.name === 'string'
    && Array.isArray(rec.versions) && rec.versions.length > 0
    && rec.production && Number.isInteger(rec.production.version)
    && rec.versions.some((v) => v.version === rec.production.version)
  if (!ok) throw new SkillError('corrupt', `技能文件损坏：${file}`)
  return rec
}

export function createPromptSkillsStore({ dir = DEFAULT_PROMPT_SKILLS_DIR, now = Date.now } = {}) {
  const locks = new Map() // name -> tail promise of that skill's write chain

  const fileOf = (name) => path.join(dir, `${assertSkillName(name)}.json`)

  async function load(name) {
    const file = fileOf(name)
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') throw new SkillError('not_found', `没有叫 ${name} 的技能`)
      throw err
    }
    let rec
    try { rec = JSON.parse(raw) } catch { throw new SkillError('corrupt', `技能文件损坏：${file}`) }
    return validateRecord(rec, file)
  }

  async function persist(rec) {
    await mkdir(dir, { recursive: true })
    const file = fileOf(rec.name)
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(rec, null, 2) + '\n')
    await rename(tmp, file)
  }

  function withLock(name, fn) {
    const prev = locks.get(name) || Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => {})
    locks.set(name, tail)
    tail.then(() => { if (locks.get(name) === tail) locks.delete(name) })
    return run
  }

  async function listSkills() {
    let entries
    try {
      entries = await readdir(dir)
    } catch (err) {
      if (err?.code === 'ENOENT') return []
      throw err
    }
    const names = entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .filter((n) => SKILL_NAME_RE.test(n))
      .sort()
    const out = []
    for (const name of names) {
      try {
        out.push(summarize(await load(name)))
      } catch (err) {
        // A broken file shows up as a broken row, never silently disappears.
        if (!(err instanceof SkillError)) throw err
        out.push({ name, error: err.message })
      }
    }
    return out
  }

  async function getSkill(name) {
    const rec = await load(name)
    return { ...summarize(rec), versions: rec.versions.map((v) => ({ ...v, isProduction: v.version === rec.production.version })) }
  }

  /** The text a dispatcher gets: production by default, or one pinned version. */
  async function getPrompt(name, version = null) {
    const rec = await load(name)
    const v = findVersion(rec, version == null ? rec.production.version : parseVersionNumber(version))
    return {
      name: rec.name,
      title: rec.title,
      version: v.version,
      isProduction: v.version === rec.production.version,
      content: v.content,
      createdAt: v.createdAt,
      author: v.author,
    }
  }

  async function createSkill({ name, title, description, content, author, note } = {}) {
    assertSkillName(name)
    return withLock(name, async () => {
      try {
        await load(name)
        throw new SkillError('exists', `技能 ${name} 已经有了`)
      } catch (err) {
        if (err?.code !== 'not_found') throw err
      }
      const at = now()
      const by = cleanAuthor(author)
      const rec = {
        name,
        title: cleanText(title, MAX_TITLE, '标题') || name,
        description: cleanText(description, MAX_DESCRIPTION, '说明'),
        production: { version: 1, by, at },
        versions: [{ version: 1, content: cleanContent(content), author: by, note: cleanText(note, MAX_NOTE, '修改说明'), createdAt: at }],
      }
      await persist(rec)
      return getSkill(name)
    })
  }

  /**
   * Append a new version. `baseVersion` = the version the editor started
   * from; it must still be the latest. makeProduction (default true) moves the
   * production label onto the new version in the same write.
   */
  async function saveVersion(name, { content, author, note, baseVersion, makeProduction = true } = {}) {
    assertSkillName(name)
    return withLock(name, async () => {
      const rec = await load(name)
      const latest = latestOf(rec)
      const base = parseVersionNumber(baseVersion)
      if (base !== latest.version) {
        throw new SkillError('conflict', `你是在 v${base} 上改的，但期间已经有人存了 v${latest.version}，请刷新后再改`)
      }
      const body = cleanContent(content)
      if (body === latest.content) throw new SkillError('unchanged', '正文和最新版一字不差，没有生成新版本')
      const at = now()
      const by = cleanAuthor(author)
      const version = latest.version + 1
      rec.versions.push({ version, content: body, author: by, note: cleanText(note, MAX_NOTE, '修改说明'), createdAt: at })
      if (makeProduction) rec.production = { version, by, at }
      await persist(rec)
      return getSkill(name)
    })
  }

  /** Move the production label — this is both "设为生效" and "一键回滚". */
  async function setProduction(name, { version, author } = {}) {
    assertSkillName(name)
    return withLock(name, async () => {
      const rec = await load(name)
      const v = findVersion(rec, parseVersionNumber(version))
      if (rec.production.version !== v.version) {
        rec.production = { version: v.version, by: cleanAuthor(author), at: now() }
        await persist(rec)
      }
      return getSkill(name)
    })
  }

  /** Title / one-line description; not versioned (they never reach a car). */
  async function updateMeta(name, { title, description } = {}) {
    assertSkillName(name)
    return withLock(name, async () => {
      const rec = await load(name)
      if (title !== undefined) rec.title = cleanText(title, MAX_TITLE, '标题') || rec.name
      if (description !== undefined) rec.description = cleanText(description, MAX_DESCRIPTION, '说明')
      await persist(rec)
      return getSkill(name)
    })
  }

  return { dir, listSkills, getSkill, getPrompt, createSkill, saveVersion, setProduction, updateMeta }
}

export { parseVersionNumber }
