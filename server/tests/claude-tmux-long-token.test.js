/**
 * The tmux bridge decides long_token vs interactive itself (claude-env.js,
 * inside the bridge's SDK driver). tmux new-session runs it in the tmux
 * SERVER's frozen env, so launchBridge must pin CLAUDE_OAUTH_TOKEN_DIR to the
 * directory this server uses — otherwise server and bridge can disagree on
 * which credential a pool tab uses.
 *
 * A fake tmux binary records its argv and, for new-session, serves the
 * bridge socket so ensureConnected() completes without a real bridge.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let DIR
let LOG
let driverMod

before(async () => {
  DIR = mkdtempSync(join(tmpdir(), 'nc-tmux-lt-'))
  LOG = join(DIR, 'tmux-argv.jsonl')
  const fake = join(DIR, 'tmux')
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs')
const { spawn } = require('child_process')
const argv = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(argv) + '\\n')
if (argv[0] === 'has-session') process.exit(1)
if (argv[0] === 'new-session') {
  const sock = argv[argv.indexOf('--socket') + 1]
  spawn(process.execPath, ['-e', 'require("net").createServer(() => {}).listen(process.argv[1]); setTimeout(() => process.exit(0), 3000)', sock],
    { detached: true, stdio: 'ignore' }).unref()
}
process.exit(0)
`)
  chmodSync(fake, 0o755)
  process.env.NANOCODE_TMUX_BIN = fake
  process.env.NANOCODE_TMUX_SOCKET_DIR = join(DIR, 'sockets')
  process.env.CLAUDE_OAUTH_TOKEN_DIR = join(DIR, 'oauth-dir')
  driverMod = await import('../../terminal/claude-tmux-driver.js')
})

after(() => {
  delete process.env.NANOCODE_TMUX_BIN
  delete process.env.NANOCODE_TMUX_SOCKET_DIR
  delete process.env.CLAUDE_OAUTH_TOKEN_DIR
  rmSync(DIR, { recursive: true, force: true })
})

describe('claude tmux driver: bridge launch', () => {
  it('pins CLAUDE_OAUTH_TOKEN_DIR (and the team dir) on tmux new-session', async () => {
    const driver = driverMod.createClaudeTmuxDriver({ store: { getSetting: () => null }, claudeBroadcast: () => {}, rerunTurn: () => {} })
    const client = driver._getBridgeClient('pl:claude:tl', { configDir: '/h/.claude-team5', claudeConfigDir: '/h/.claude-team5', cwd: DIR })
    await client.ensureConnected()
    client.close()
    const calls = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const ns = calls.find((a) => a[0] === 'new-session')
    assert.ok(ns, 'new-session was called')
    const pinned = ns.filter((_, i) => ns[i - 1] === '-e')
    assert.ok(pinned.includes(`CLAUDE_OAUTH_TOKEN_DIR=${join(DIR, 'oauth-dir')}`), `pinned: ${pinned.join(' ')}`)
    assert.ok(pinned.includes('CLAUDE_CONFIG_DIR=/h/.claude-team5'))
    assert.ok(!ns.some((a) => /CLAUDE_CODE_OAUTH_TOKEN/.test(a)), 'no token var on the tmux command line')
  })
})
