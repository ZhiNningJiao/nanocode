/**
 * Tests for the MES-13740 需求8 persona library + skills browser.
 *
 * Covers:
 *   - parsePersonaMarkdown (H1 name extraction, no-H1 fallback, instruction body)
 *   - listPersonas (bundled always present, user overrides bundled on id collision)
 *   - readPersona (user wins, path-traversal rejected, missing returns null)
 *   - resolvePersonaPrompt (instruction text, '' for missing — the single source
 *     of truth consumed by all three claude drivers)
 *   - listSkills (team-grouped read-only list, active team flagged)
 *
 * The injection wiring (CLI --append-system-prompt / SDK appendSystemPrompt /
 * tmux bridge arg) is verified by the 9476 hand-test; here we lock the data API.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePersonaMarkdown,
  listPersonas,
  readPersona,
  resolvePersonaPrompt,
  framePersonaPrompt,
  listSkills,
} from '../../terminal/personas.js'
import { createStore } from '../store.js'

describe('persona: parsePersonaMarkdown', () => {
  it('extracts the first H1 as name and the rest as instruction', () => {
    const r = parsePersonaMarkdown('# 猫娘\n你是一只猫娘。\n句尾加喵。', 'stem')
    assert.equal(r.name, '猫娘')
    assert.equal(r.instruction, '你是一只猫娘。\n句尾加喵。')
  })

  it('falls back to the filename stem when there is no H1', () => {
    const r = parsePersonaMarkdown('just a body\nno heading', 'myid')
    assert.equal(r.name, 'myid')
    assert.equal(r.instruction, 'just a body\nno heading')
  })

  it('treats only the FIRST H1 as the name (later H1s stay in the body)', () => {
    const r = parsePersonaMarkdown('# A\nbody1\n# B\nbody2', 'stem')
    assert.equal(r.name, 'A')
    assert.ok(r.instruction.startsWith('body1'))
    assert.ok(r.instruction.includes('# B'))
  })

  it('returns empty instruction for a heading-only file', () => {
    const r = parsePersonaMarkdown('# Only', 'stem')
    assert.equal(r.name, 'Only')
    assert.equal(r.instruction, '')
  })

  it('coerces non-string input to an empty parse', () => {
    const r = parsePersonaMarkdown(null, 'stem')
    assert.equal(r.name, 'stem')
    assert.equal(r.instruction, '')
  })
})

describe('persona: listPersonas (bundled + user merge)', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-persona-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('always includes the bundled catgirl + concise personas', () => {
    const { personas } = listPersonas(tmp)
    const ids = personas.map((p) => p.id)
    assert.ok(ids.includes('catgirl'), 'bundled catgirl must be listed')
    assert.ok(ids.includes('concise'), 'bundled concise must be listed')
    for (const p of personas) {
      if (p.id === 'catgirl' || p.id === 'concise') assert.equal(p.source, 'builtin')
    }
  })

  it('merges a user persona alongside the bundled ones', () => {
    const userDir = join(tmp, '.config', 'nanocode', 'personas')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'robot.md'), '# Robot\nBeep boop.\n', 'utf8')
    const { personas } = listPersonas(tmp)
    const robot = personas.find((p) => p.id === 'robot')
    assert.ok(robot, 'user persona robot must be listed')
    assert.equal(robot.source, 'user')
    assert.equal(robot.name, 'Robot')
  })

  it('user overrides bundled on id collision (user wins)', () => {
    const userDir = join(tmp, '.config', 'nanocode', 'personas')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'catgirl.md'), '# My Catgirl\nCustom.\n', 'utf8')
    const { personas } = listPersonas(tmp)
    const cg = personas.find((p) => p.id === 'catgirl')
    assert.ok(cg, 'catgirl still present')
    assert.equal(cg.source, 'user', 'user catgirl must override the bundled one')
    assert.equal(cg.name, 'My Catgirl')
  })
})

describe('persona: readPersona + resolvePersonaPrompt', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-persona-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('reads a bundled persona and returns its instruction', () => {
    const p = readPersona(tmp, 'catgirl')
    assert.ok(p, 'catgirl must resolve')
    assert.equal(p.source, 'builtin')
    assert.ok(p.instruction.length > 0, 'instruction must be non-empty')
  })

  it('user persona wins over the bundled one with the same id', () => {
    const userDir = join(tmp, '.config', 'nanocode', 'personas')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'catgirl.md'), '# Override\nCustom body.\n', 'utf8')
    const p = readPersona(tmp, 'catgirl')
    assert.equal(p.source, 'user')
    assert.equal(p.name, 'Override')
    assert.equal(p.instruction, 'Custom body.')
  })

  it('rejects path-traversal ids', () => {
    assert.equal(readPersona(tmp, '../../etc/passwd'), null)
    assert.equal(readPersona(tmp, '..'), null)
    assert.equal(readPersona(tmp, 'a/b'), null)
    assert.equal(readPersona(tmp, ''), null)
  })

  it('returns null for a missing persona', () => {
    assert.equal(readPersona(tmp, 'does-not-exist'), null)
  })

  it('resolvePersonaPrompt returns the instruction text (the driver input)', () => {
    const prompt = resolvePersonaPrompt(tmp, 'catgirl')
    assert.ok(prompt.length > 0)
    assert.equal(prompt, readPersona(tmp, 'catgirl').instruction)
  })

  it('resolvePersonaPrompt returns empty string for a missing persona', () => {
    assert.equal(resolvePersonaPrompt(tmp, 'nope'), '')
    assert.equal(resolvePersonaPrompt(tmp, '../../x'), '')
  })
})

describe('persona: framePersonaPrompt (override framing)', () => {
  it('wraps the instruction in override framing so it can win vs CLAUDE.md', () => {
    const raw = 'Be terse. No role-play.'
    const framed = framePersonaPrompt(raw)
    assert.ok(framed.includes(raw), 'must contain the raw instruction verbatim')
    assert.ok(/highest priority/i.test(framed), 'must declare highest priority')
    assert.ok(/overrides any personality/i.test(framed), 'must claim to override personality')
    assert.ok(framed.startsWith('## ACTIVE PERSONA'), 'must start with the active-persona heading')
  })

  it('returns empty string for empty input (no framing spam)', () => {
    assert.equal(framePersonaPrompt(''), '')
    assert.equal(framePersonaPrompt(undefined), '')
    assert.equal(framePersonaPrompt(null), '')
  })

  it('keeps the catgirl instruction readable through framing (catgirl persona still works)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'nano-frame-'))
    try {
      const raw = resolvePersonaPrompt(tmp, 'catgirl')
      assert.ok(/猫娘|主人/.test(raw), 'sanity: catgirl raw instruction has catgirl markers')
      const framed = framePersonaPrompt(raw)
      assert.ok(/猫娘|主人/.test(framed), 'framed catgirl still carries catgirl markers')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('persona: listSkills (read-only team browser)', () => {
  let tmp, claudeDir, team2Dir
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nano-skill-'))
    claudeDir = join(tmp, '.claude')
    team2Dir = join(tmp, '.claude-team2')
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(team2Dir, { recursive: true })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('lists skills grouped by team and flags the active team', () => {
    mkdirSync(join(claudeDir, 'skills', 'browse'), { recursive: true })
    writeFileSync(join(claudeDir, 'skills', 'browse', 'SKILL.md'), '# Browse\nOpen pages and verify.\n', 'utf8')
    mkdirSync(join(team2Dir, 'skills', 'qa'), { recursive: true })
    writeFileSync(join(team2Dir, 'skills', 'qa', 'SKILL.md'), '# QA\nTest things.\n', 'utf8')

    const store = createStore(':memory:')
    const { teams, activePath } = listSkills(tmp, store)
    const ids = teams.map((t) => t.id).sort()
    assert.deepEqual(ids, ['team1', 'team2'])
    const t1 = teams.find((t) => t.id === 'team1')
    assert.ok(t1.skills.some((s) => s.name === 'browse'))
    assert.ok(t1.skills.find((s) => s.name === 'browse').label === 'Browse')
    const t2 = teams.find((t) => t.id === 'team2')
    assert.ok(t2.skills.some((s) => s.name === 'qa'))
    // activePath defaults to team1's dir (no CLAUDE_CONFIG_DIR setting)
    assert.equal(activePath, claudeDir)
  })

  it('skips teams with no skills dir (read-only, never creates)', () => {
    mkdirSync(join(claudeDir, 'skills', 'only'), { recursive: true })
    writeFileSync(join(claudeDir, 'skills', 'only', 'SKILL.md'), '# Only\nx\n', 'utf8')
    const store = createStore(':memory:')
    const { teams } = listSkills(tmp, store)
    const t2 = teams.find((t) => t.id === 'team2')
    assert.ok(t2)
    assert.equal(t2.skills.length, 0)
  })

  it('ignores skill dirs without a SKILL.md', () => {
    mkdirSync(join(claudeDir, 'skills', 'no-md'), { recursive: true })
    const store = createStore(':memory:')
    const { teams } = listSkills(tmp, store)
    const t1 = teams.find((t) => t.id === 'team1')
    assert.ok(!t1.skills.some((s) => s.name === 'no-md'))
  })
})
