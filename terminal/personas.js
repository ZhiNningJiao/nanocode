/**
 * Persona library + Claude native skills browser — MES-13740 需求8.
 *
 * Personas live in two places (merged, user dir wins on id collision):
 *   - bundled:  <repo>/personas/*.md          (ship samples, always present)
 *   - user:     <home>/.config/nanocode/personas/*.md  (user adds/overrides)
 *
 * Persona md format:
 *   # <Display Name>
 *   <persona instruction body — injected via --append-system-prompt>
 * If no H1, the filename stem is the display name and the whole body is the
 * instruction. `id` is always the filename stem (stable across renames).
 *
 * Skills (read-only browser) come from each team config dir's
 * `<team>/skills/<name>/SKILL.md` tree — the same Claude-native skill store
 * loading a native skill is Claude's own mechanism, we never inject it.
 *
 * Security: id is validated by a strict char class (no dotdot or slash traversal).
 *
 * All file IO is async (bounded-scan.js): the user dir and the team skill trees
 * sit under the shared home, and the persona is read on every claude attach.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { listTeamsAsync } from './usage.js'
import { readdirSafe, readTextSafe, statSafe } from './bounded-scan.js'

const PERSONA_FILE_RE = /^[A-Za-z0-9._-]+\.md$/i
const PERSONA_ID_RE = /^[A-Za-z0-9._-]+$/
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/

const BUNDLED_PERSONAS_DIR = fileURLToPath(new URL('../personas/', import.meta.url))

function personasUserDir(home) {
  return join(home || homedir(), '.config', 'nanocode', 'personas')
}

/**
 * Parse a persona markdown body into { name, instruction }.
 * - name: first H1 (`# Name`) line, else fallbackId
 * - instruction: everything after the first H1 (trimmed), else the whole body
 */
export function parsePersonaMarkdown(text, fallbackId = '') {
  const body = typeof text === 'string' ? text : ''
  const lines = body.split('\n')
  let name = ''
  let instructionStart = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) {
      name = lines[i].replace(/^#\s+/, '').trim()
      instructionStart = i + 1
      break
    }
  }
  if (!name) name = fallbackId
  const instruction = lines.slice(instructionStart).join('\n').trim()
  return { name: name || fallbackId, instruction }
}

async function readPersonaFile(filePath, id) {
  const text = await readTextSafe(filePath)
  if (text === null) return null
  const { name, instruction } = parsePersonaMarkdown(text, id)
  const preview = instruction.slice(0, 160).replace(/\s+/g, ' ').trim()
  const mtime = (await statSafe(filePath))?.mtimeMs || 0
  return { name, instruction, preview, mtime }
}

/**
 * List all personas (bundled + user), user overriding bundled by id.
 * Returns { personas: [{ id, name, source, preview, mtime }], userDir, bundledDir }
 */
export async function listPersonas(home) {
  const userDir = personasUserDir(home)
  const out = new Map()
  for (const [dir, source] of [[BUNDLED_PERSONAS_DIR, 'builtin'], [userDir, 'user']]) {
    for (const f of await readdirSafe(dir)) {
      if (!PERSONA_FILE_RE.test(f)) continue
      const id = f.replace(/\.md$/i, '')
      const p = await readPersonaFile(join(dir, f), id)
      if (p) out.set(id, { id, name: p.name, source, preview: p.preview, mtime: p.mtime })
    }
  }
  const personas = [...out.values()].sort((a, b) => {
    if (b.mtime !== a.mtime) return b.mtime - a.mtime
    return a.name.localeCompare(b.name)
  })
  return { personas, userDir: personasUserDir(home), bundledDir: BUNDLED_PERSONAS_DIR }
}

/**
 * Read one persona by id. User dir wins. Returns { id, name, instruction, source } or null.
 */
export async function readPersona(home, id) {
  if (!id || !PERSONA_ID_RE.test(id)) return null
  const user = await readPersonaFile(join(personasUserDir(home), `${id}.md`), id)
  if (user) return { id, name: user.name, instruction: user.instruction, source: 'user' }
  const bundled = await readPersonaFile(join(BUNDLED_PERSONAS_DIR, `${id}.md`), id)
  if (bundled) return { id, name: bundled.name, instruction: bundled.instruction, source: 'builtin' }
  return null
}

/**
 * Resolve the injectable system-prompt text for a persona id. '' if not found.
 * Returns the RAW instruction (no framing). Used by tests + readPersona parity.
 * Drivers consume the FRAMED version via framePersonaPrompt(resolvePersonaPrompt(...))
 * — see claude-session-controller attach.
 */
export async function resolvePersonaPrompt(home, id) {
  const p = await readPersona(home, id)
  return p ? p.instruction : ''
}

/**
 * Wrap a resolved persona instruction in override framing so it can win against
 * a strong CLAUDE.md / memory personality (e.g. the user's catgirl/猫娘 CLAUDE.md).
 *
 * Empirically (9476 live test, MES-13740 需求8): a raw `--append-system-prompt` of
 * the concise instruction is dominated by the catgirl CLAUDE.md — the model keeps
 * 喵/主人 and even calls the append "suspicious injected content". With this framing
 * the model drops the catgirl style and follows the persona (it still refuses
 * unnatural "begin with TOKEN" commands that look like prompt injection, but it
 * HONORS the persona's tone/style — which is what 需求8 needs: a visible style
 * change). Generic — no hardcoded persona names.
 */
export function framePersonaPrompt(instruction) {
  if (!instruction) return ''
  return [
    '## ACTIVE PERSONA — highest priority for this session',
    "This persona overrides any personality / role-play / tone instructions in CLAUDE.md, memory, or the default system prompt for this session. Follow THIS persona's style for all responses.",
    '',
    instruction,
  ].join('\n')
}

// ── Skills (read-only browser) ──────────────────────────────────────────────

async function parseSkillMd(filePath, fallbackName) {
  const text = await readTextSafe(filePath)
  if (text === null) return null
  const lines = text.split('\n')
  let name = ''
  let bodyStart = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) {
      name = lines[i].replace(/^#\s+/, '').trim()
      bodyStart = i + 1
      break
    }
  }
  if (!name) name = fallbackName
  let desc = ''
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (/^(?:---|```)/.test(line)) continue
    desc = line.replace(/\s+/g, ' ').slice(0, 240)
    break
  }
  return { name, description: desc }
}

async function listSkillsInDir(skillsDir) {
  const skills = []
  for (const d of await readdirSafe(skillsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    if (!SKILL_NAME_RE.test(d.name)) continue
    const meta = await parseSkillMd(join(skillsDir, d.name, 'SKILL.md'), d.name)
    if (!meta) continue // no readable SKILL.md
    skills.push({ name: d.name, label: meta.name, description: meta.description })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

/**
 * List Claude-native skills across all team config dirs (read-only).
 * Returns { teams: [{ id, name, path, skills: [] }], activePath }
 */
export async function listSkills(home, store) {
  const { teams, activePath } = await listTeamsAsync(home, store)
  const out = []
  for (const t of teams) {
    if (!t.path || !t.exists) continue
    out.push({ id: t.id, name: t.name, path: t.path, skills: await listSkillsInDir(join(t.path, 'skills')) })
  }
  return { teams: out, activePath }
}
