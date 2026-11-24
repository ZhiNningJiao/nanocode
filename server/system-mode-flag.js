/**
 * The multi-user system-mode switch — one explicit, default-off gate.
 *
 * Single-user mode is what this repo runs by default. Multi-user mode
 * (router + setuid helper + per-user worker + auto-update) is opt-in: an
 * operator who needs to serve many local accounts turns it on, everyone
 * else never loads any of it. See README.md "Deployment" and
 * docs/system-mode-design.md.
 *
 * This is the ONLY place that decides whether system mode is on. It does
 * not touch the multi-user implementation itself (router-mode.js, worker/,
 * helper/, scripts/) — those are untouched; this module only answers the
 * on/off question for the single call site in server/index.js.
 */

export function isSystemModeEnabled(env = process.env) {
  return env.NANOCODE_SYSTEM === '1'
}
