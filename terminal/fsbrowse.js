/**
 * Cross-platform folder browsing primitives for the Add-project directory
 * picker (see MES-13804).
 *
 * The pure path logic (parent / normalize / drives shape) is split out so the
 * Windows branches can be unit-tested on a Linux host by injecting
 * `platform: 'win32'` — the server process itself only ever runs the
 * `posix` branch on Linux, so the route behaviour is unchanged there.
 *
 * Design rules (per task spec):
 *   - Use `node:path`'s `path.win32` / `path.posix` explicitly; never hand-join
 *     separators.
 *   - `parent` is null at a drive root (`C:\`) on Windows and at `/` on POSIX,
 *     so the frontend can disable the "up one level" button.
 *   - Hidden detection stays the `.`-prefix heuristic cross-platform (good
 *     enough; we deliberately do NOT special-case Windows file attributes).
 */

import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

/** Return the path module for the given platform string. */
export function pathModuleFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Normalise the running server's platform to 'win32' or 'posix'. */
export function currentPlatform() {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

/** Drive-root regex: `C:\` or `C:` (case-insensitive). */
const WIN_DRIVE_ROOT = /^[A-Za-z]:\\?$/

/** Drive-letter prefix regex: `C:\` (with trailing slash). */
const WIN_DRIVE_PREFIX = /^([A-Za-z]:)[\\/]/

/**
 * Normalise an absolute path for the platform (collapse `.`/`..` and slash
 * variants, strip trailing separators). Returns null for empty input.
 *
 * `C:\` and `/` are returned untouched (they are their own canonical form);
 * any other path loses a trailing separator so the picker shows a clean path
 * and `parentOf` can compare against drive-root / `/` reliably.
 */
export function normalizePath(input, platform) {
  if (!input) return null
  const p = pathModuleFor(platform)
  const sep = platform === 'win32' ? '\\' : '/'
  const slashed = platform === 'win32' ? input.replace(/\//g, '\\') : input.replace(/\\/g, '/')
  let norm = p.normalize(slashed.split(sep).join(sep))
  if (platform === 'win32') {
    if (!WIN_DRIVE_ROOT.test(norm) && norm.length > 1 && norm.endsWith('\\')) {
      norm = norm.replace(/\\+$/, '')
    }
  } else {
    if (norm.length > 1 && norm.endsWith('/')) {
      norm = norm.replace(/\/+$/, '')
    }
  }
  return norm
}

/**
 * Return the parent of an absolute path, or null when already at the root.
 *
 * Windows:
 *   'C:\\foo\\bar' → 'C:\\foo'
 *   'C:\\foo'      → null   (dirname is the drive root 'C:\\')
 *   'C:\\'         → null
 * POSIX:
 *   '/foo/bar' → '/foo'
 *   '/foo'     → '/'
 *   '/'        → null
 */
export function parentOf(input, platform) {
  if (!input) return null
  const p = pathModuleFor(platform)
  const norm = normalizePath(input, platform)
  if (!norm) return null
  if (platform === 'win32') {
    if (WIN_DRIVE_ROOT.test(norm)) return null
    const dir = p.dirname(norm)
    if (dir === norm || WIN_DRIVE_ROOT.test(dir)) return null
    return dir
  }
  if (norm === '/') return null
  const dir = p.dirname(norm)
  if (dir === norm) return null
  return dir
}

/**
 * Enumerate selectable top-level roots.
 *
 * Windows: probe `A:`..`Z:` for existence (sync existsSync); returns one entry
 * per available drive as `[{name:'C:\\', isDir:true}]`. `existsFn` is injectable
 * for unit tests.
 *
 * POSIX / mac: a single root entry `{name:'/', isDir:true}`.
 */
export function listDrives(platform, existsFn = (p) => existsSync(p)) {
  if (platform === 'win32') {
    const drives = []
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code)
      const root = `${letter}:\\`
      try {
        if (existsFn(root)) drives.push({ name: root, isDir: true })
      } catch {
        // Drive exists check failed (e.g. removable media polling error) — skip.
      }
    }
    return drives
  }
  return [{ name: '/', isDir: true }]
}

/** Hidden-file heuristic: leading dot. Cross-platform good-enough. */
export function isHidden(name) {
  return typeof name === 'string' && name.startsWith('.')
}

/**
 * Read a directory and shape the response for the picker.
 *
 * Returns `{path, parent, entries}` where `entries` is a sorted list of
 * `{name, isDir:true}` non-hidden directories. `readdir` is injectable for
 * unit tests; defaults to the real `readdirSync` with Dirent objects.
 */
export function listDirectory(base, platform, { readdir } = {}) {
  const read = readdir || ((dir) => readdirSync(dir, { withFileTypes: true }))
  const entries = read(base)
    .filter((dirent) => dirent.isDirectory() && !isHidden(dirent.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((dirent) => ({ name: dirent.name, isDir: true }))
  return { path: base, parent: parentOf(base, platform), entries }
}
