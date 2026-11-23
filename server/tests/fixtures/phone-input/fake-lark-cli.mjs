#!/usr/bin/env node
// Stand-in for lark-cli in server/tests/phone-input.test.js. State lives in
// $FAKE_LARK_DIR (a per-test dir under server/tests/.fixtures-tmp):
//   list.json   the recorded `im +chat-messages-list --format json` output to print
//   fail_next   optional count: that many list calls fail (exit 1) first
//   calls.jsonl every call's argv is appended here (one JSON array per line)
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.FAKE_LARK_DIR
const argv = process.argv.slice(2)
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ t: Date.now(), argv }) + '\n')

if (argv[0] === 'im' && argv[1] === 'reactions' && argv[2] === 'create') {
  process.stdout.write('{"ok":true,"data":{"reaction_id":"r_fake"}}\n')
  process.exit(0)
}
if (argv[0] === 'im' && argv[1] === '+chat-messages-list') {
  const failFile = join(dir, 'fail_next')
  const left = existsSync(failFile) ? Number(readFileSync(failFile, 'utf8')) : 0
  if (left > 0) {
    writeFileSync(failFile, String(left - 1))
    process.stderr.write('Error: request failed: connect ECONNREFUSED (fake)\n')
    process.exit(1)
  }
  process.stdout.write(readFileSync(join(dir, 'list.json'), 'utf8'))
  process.exit(0)
}
process.stderr.write(`fake-lark-cli: unexpected argv ${JSON.stringify(argv)}\n`)
process.exit(64)
