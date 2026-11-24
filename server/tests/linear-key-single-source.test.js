/**
 * One Linear key resolver: both Linear readers (command-center big events and
 * the Linear → ntfy notifier) go through server/linear-key.js — no second
 * place reads a key file / setting of its own.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (f) => readFileSync(join(serverDir, f), 'utf8')

describe('Linear key single source', () => {
  for (const f of ['command-center.js', 'linear-notif.js']) {
    it(`${f} imports resolveLinearApiKey and reads no key of its own`, () => {
      const s = src(f)
      assert.match(s, /import \{ resolveLinearApiKey \} from '\.\/linear-key\.js'/)
      assert.doesNotMatch(s, /linear_api_key|linearApiKey|linear-api\.key|resolvePluginSecrets/)
    })
  }
})
