// Removing a test's HOME while a claude session controller still has lock IO
// in flight is not final: a lock-watch tick that already started when the
// controller was disposed (disposeClaudeSessions stops the timer, not the
// tick) finds the lock file gone and re-acquires it, and that mkdir -p
// recreates <home>/.nanocode/session-locks/<sid>.lock inside the deleted
// temp dir. session-lock.js serializes every op on one lock file, and such a
// tick issues at most two more ops (read the holder, then re-acquire or
// touch), so queueing behind each session's lock file twice lets all of it
// land. Call after disposing the controller(s), before removing `home`.
import { getLockHolder } from '../../../terminal/session-lock.js'

export async function settleSessionLocks(home, sessionIds) {
  for (let round = 0; round < 2; round++) {
    await Promise.all([...new Set(sessionIds)].filter(Boolean).map((sid) => getLockHolder(sid, home).catch(() => {})))
  }
}

/** Shut claude session controllers down the way the server does, then settle their lock IO. */
export async function disposeClaudeControllers(controllers, home) {
  const sids = controllers.flatMap((c) => [...c.claudeSessions.values()].flatMap((cs) => [cs._lockSessionId, cs.claudeSessionId]))
  for (const c of controllers) c.disposeClaudeSessions()
  await settleSessionLocks(home, sids)
}
