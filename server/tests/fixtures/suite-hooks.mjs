// node 18's runner skips a describe's after() when its before() throws, so
// whatever before() had set up by then (a spawned server, a listening socket,
// a temp dir, a changed process.env) would never be torn down. A suite that
// sets up resources registers both halves here instead of before()/after():
// the teardown steps run from after() normally, and from before() itself when
// setup fails part-way. Every step runs even if an earlier one throws (the
// first error is rethrown at the end), so steps must tolerate state that was
// never set up (`server?.close()`, `if (dir) rmSync(...)`).
import { before, after } from 'node:test'

export function setupSuite(setUp, ...tearDownSteps) {
  async function tearDown() {
    let failure = null
    for (const step of tearDownSteps) {
      try { await step() } catch (err) { failure ??= err }
    }
    if (failure) throw failure
  }
  before(async () => {
    try {
      await setUp()
    } catch (err) {
      await tearDown().catch(() => {})
      throw err
    }
  })
  after(tearDown)
}
