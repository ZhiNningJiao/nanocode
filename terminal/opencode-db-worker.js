/**
 * opencode-db-worker.js — reads the opencode SQLite session table in a worker
 * thread. node:sqlite only has a synchronous API and the DB normally sits under
 * the shared home (~/.local/share/opencode/opencode.db on /jfs), so running it
 * on the main thread froze the whole server while /jfs stalled
 * (REPORT_nanolock_0730.md). usage.js queryOpencodeSessionRows() is the only
 * caller. Posts { rows, dbPath } or { error, dbPath, rows: [] }.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

// node:sqlite is experimental (Node 22+). Guarded require so an older runtime
// degrades to an honest "source unavailable" error shape.
let DatabaseSync = null
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')) } catch { /* unavailable */ }

function querySessionRows(dbPath) {
  if (!DatabaseSync) return { error: 'node:sqlite unavailable (Node 22+ required)', dbPath, rows: [] }
  if (!dbPath || !existsSync(dbPath)) return { error: 'opencode DB not found', dbPath, rows: [] }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare(
      'SELECT model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, directory FROM session'
    ).all()
    return { rows, dbPath }
  } catch (err) {
    return { error: String(err.message || err), dbPath, rows: [] }
  } finally {
    try { db && db.close() } catch {}
  }
}

parentPort.postMessage(querySessionRows(workerData.dbPath))
