/**
 * Project-scoped file API. All paths are sandboxed to a project's cwd.
 *
 * Remote-SSH projects return `{ remote: true }` from listing endpoints; the
 * Explorer UI uses that signal to render a "Remote browsing unsupported" state.
 *
 * Symlink-escape note: the sandbox check is lexical (path.relative). A symlink
 * inside the project pointing outside cwd will not be caught. This is acceptable
 * for a single-user local tool; the user controls their own filesystem.
 *
 * Cross-project / home-root access (read-only routes only):
 *   When an absolute path is supplied, the sandbox check is expanded:
 *   1. If any project's cwd is an ancestor of the path, use that project's sandbox.
 *   2. Otherwise, fall back to HOME_ROOT (this process's home directory) as the sandbox root.
 *   3. Paths outside HOME_ROOT are always rejected (403).
 */

import { Router } from 'express'
import { createReadStream, createWriteStream } from 'node:fs'
import { resolve, relative, isAbsolute, basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import Busboy from 'busboy'
import { timedFs as fs, mapLimit, readHead, statSafe, DEFAULT_SCAN_CONCURRENCY } from './bounded-scan.js'

/**
 * Home-root sandbox for cross-project / home-dir access (single-user dev
 * box). Neutral default is the OS home dir of whichever user runs the
 * process — never a hardcoded path. Override with NANOCODE_HOME_ROOT if a
 * deployment's sandbox root should differ from $HOME.
 */
const HOME_ROOT = resolve(process.env.NANOCODE_HOME_ROOT || homedir())

const TEXT_SIZE_CAP = 256 * 1024 // 256 KB
const UPLOAD_SIZE_CAP = 50 * 1024 * 1024 // 50 MB
const BINARY_PROBE_BYTES = 8 * 1024 // 8 KB

const MIME_MAP = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  js: 'application/javascript', mjs: 'application/javascript',
  ts: 'application/typescript', tsx: 'application/typescript',
  jsx: 'application/javascript',
  html: 'text/html', htm: 'text/html', css: 'text/css',
  py: 'text/x-python', rs: 'text/x-rust', go: 'text/x-go',
  yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/x-toml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ico: 'image/x-icon', bmp: 'image/bmp',
  pdf: 'application/pdf', zip: 'application/zip',
  tar: 'application/x-tar', gz: 'application/gzip',
}

function mimeFor(filename) {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return MIME_MAP[ext] || 'application/octet-stream'
}

/**
 * Resolve a request path against a project's cwd with sandbox + remote checks.
 * Throws an object with { status, error } on rejection.
 */
function resolveSandboxed(project, relPath) {
  if (project.ssh_host) {
    const err = new Error('remote browsing unsupported')
    err.status = 400
    err.code = 'REMOTE'
    throw err
  }
  const root = resolve(project.cwd)
  const cleaned = String(relPath || '').replace(/^\/+/, '')
  const target = resolve(root, cleaned)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    const err = new Error('path outside project')
    err.status = 403
    throw err
  }
  return { root, target, rel }
}

/**
 * Resolve a path that may be absolute, using extended sandbox rules:
 *   1. If the resolved path falls under the current project's cwd → normal sandbox.
 *   2. If it falls under any other project's cwd → use that project's root.
 *   3. Fallback: if it falls under HOME_ROOT → allow, root = HOME_ROOT.
 *   4. Outside HOME_ROOT → 403.
 *
 * Returns { root, target, rel, crossProject: boolean }.
 * Throws { status, error, code? } on rejection.
 *
 * Only intended for read-only routes (list, content, raw).
 */
function resolveWithFallback(project, store, inputPath) {
  if (project.ssh_host) {
    const err = new Error('remote browsing unsupported')
    err.status = 400
    err.code = 'REMOTE'
    throw err
  }

  let input = String(inputPath || '')
  // Expand a leading ~/ (or bare ~) to HOME_ROOT server-side — the client
  // never hardcodes a home path, it just forwards the tilde form.
  if (input === '~' || input.startsWith('~/')) {
    input = join(HOME_ROOT, input.slice(1))
  }

  // ── Case A: not absolute → standard project sandbox ──
  if (!isAbsolute(input)) {
    return { ...resolveSandboxed(project, input), crossProject: false }
  }

  // ── Absolute path: resolve it then sandbox-check ──
  const target = resolve(input)

  // 1. Check if it falls within the current project's cwd
  const projectRoot = resolve(project.cwd)
  const relToProject = relative(projectRoot, target)
  if (!relToProject.startsWith('..') && !isAbsolute(relToProject)) {
    return { root: projectRoot, target, rel: relToProject, crossProject: false }
  }

  // 2. Check all other projects
  if (store) {
    for (const p of store.listProjects()) {
      if (p.id === project.id || p.ssh_host) continue
      const pRoot = resolve(p.cwd)
      const relToP = relative(pRoot, target)
      if (!relToP.startsWith('..') && !isAbsolute(relToP)) {
        return { root: pRoot, target, rel: relToP, crossProject: true, matchedProject: p }
      }
    }
  }

  // 3. Fallback: home-root sandbox
  const relToHome = relative(HOME_ROOT, target)
  if (!relToHome.startsWith('..') && !isAbsolute(relToHome)) {
    return { root: HOME_ROOT, target, rel: relToHome, crossProject: true }
  }

  // 4. Outside home root — reject
  const err = new Error('path outside allowed root')
  err.status = 403
  throw err
}

// Exported for unit tests only — not part of the public API.
export { resolveWithFallback as _resolveWithFallback }

/** Read the first 8KB of a file and look for a NUL byte (binary heuristic). */
async function isLikelyBinary(filePath) {
  return (await readHead(filePath, BINARY_PROBE_BYTES)).includes('\0')
}

/**
 * Create the file-API router for a given store. Every route is async
 * (bounded-scan.js timedFs): project trees usually sit under the shared /jfs
 * home and the explorer polls the listing route.
 */
export function createFileRoutes(store) {
  const router = Router()

  function getProject(req, res) {
    const project = store.getProject(req.params.id)
    if (!project) {
      res.status(404).json({ error: 'project not found' })
      return null
    }
    return project
  }

  /** GET /api/projects/:id/files?path= — list entries (files + dirs). */
  router.get('/api/projects/:id/files', async (req, res) => {
    const project = getProject(req, res)
    if (!project) return

    if (project.ssh_host) return res.json({ entries: [], remote: true, path: '' })

    let target, root
    try {
      ;({ target, root } = resolveWithFallback(project, store, req.query.path))
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message })
    }

    try {
      const dirents = await fs.readdir(target, { withFileTypes: true })
      const entries = []
      await mapLimit(dirents, DEFAULT_SCAN_CONCURRENCY, async (d) => {
        const childAbs = join(target, d.name)
        const isDir = d.isDirectory()
        const size = isDir ? 0 : ((await statSafe(childAbs))?.size || 0)
        entries.push({
          name: d.name,
          path: relative(root, childAbs).replace(/\\/g, '/'),
          type: isDir ? 'dir' : 'file',
          size,
        })
      })
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        // Within a type group, sort dot-entries together at the bottom,
        // then case-insensitive alphabetical.
        const aHidden = a.name.startsWith('.')
        const bHidden = b.name.startsWith('.')
        if (aHidden !== bHidden) return aHidden ? 1 : -1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      res.json({
        entries,
        path: relative(root, target).replace(/\\/g, '/'),
      })
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' })
      if (err.code === 'ENOTDIR')
        return res.status(400).json({ error: 'not a directory' })
      res.status(500).json({ error: err.message })
    }
  })

  /** GET /api/projects/:id/files/content?path= — read text content. */
  router.get('/api/projects/:id/files/content', async (req, res) => {
    const project = getProject(req, res)
    if (!project) return

    let target
    try {
      ;({ target } = resolveWithFallback(project, store, req.query.path))
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message })
    }

    let stat
    try { stat = await fs.stat(target) }
    catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' })
      return res.status(500).json({ error: err.message })
    }
    if (stat.isDirectory()) return res.status(400).json({ error: 'is a directory' })

    if (stat.size > TEXT_SIZE_CAP) {
      return res.json({ content: null, size: stat.size, error: 'too large' })
    }
    if (await isLikelyBinary(target)) {
      return res.json({ content: null, size: stat.size, error: 'binary' })
    }

    try {
      const content = await fs.readFile(target, 'utf-8')
      res.json({ content, size: stat.size })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  /** GET /api/projects/:id/files/raw?path= — stream raw bytes. */
  router.get('/api/projects/:id/files/raw', async (req, res) => {
    const project = getProject(req, res)
    if (!project) return

    let target
    try {
      ;({ target } = resolveWithFallback(project, store, req.query.path))
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message })
    }

    let stat
    try { stat = await fs.stat(target) }
    catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' })
      return res.status(500).json({ error: err.message })
    }
    if (stat.isDirectory()) return res.status(400).json({ error: 'is a directory' })

    const name = basename(target)
    const inline = req.query.inline === '1' || (req.query.disposition === 'inline')
    res.setHeader('Content-Type', mimeFor(name))
    res.setHeader('Content-Length', String(stat.size))
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"`
    )

    const stream = createReadStream(target)
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500).end()
      else res.destroy(err)
    })
    stream.pipe(res)
  })

  /** PUT /api/projects/:id/files/content — save text content. */
  router.put('/api/projects/:id/files/content', async (req, res) => {
    const project = getProject(req, res)
    if (!project) return

    const { path: relPath, content } = req.body || {}
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' })
    }
    if (Buffer.byteLength(content, 'utf-8') > TEXT_SIZE_CAP) {
      return res.status(413).json({ error: 'too large' })
    }

    let target
    try {
      ;({ target } = resolveSandboxed(project, relPath))
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message })
    }

    try {
      const tmp = target + '.tmp'
      await fs.writeFile(tmp, content, 'utf-8')
      await fs.rename(tmp, target)
      const stat = await fs.stat(target)
      res.json({ path: relPath, size: stat.size })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  /** POST /api/projects/:id/files/upload — multipart upload via busboy. */
  router.post('/api/projects/:id/files/upload', async (req, res) => {
    const project = getProject(req, res)
    if (!project) return

    let destRel
    try {
      ;({ target: destRel } = resolveSandboxed(project, req.query.dest_path || ''))
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message })
    }

    let destStat
    try { destStat = await fs.stat(destRel) }
    catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'destination not found' })
      return res.status(500).json({ error: err.message })
    }
    if (!destStat.isDirectory()) {
      return res.status(400).json({ error: 'destination must be a directory' })
    }

    let bb
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: UPLOAD_SIZE_CAP, files: 1 } })
    } catch (err) {
      return res.status(400).json({ error: 'invalid multipart' })
    }

    const uploaded = []
    const pending = [] // Promises that resolve when each file fully writes + renames
    let aborted = false
    let tooLarge = false

    bb.on('file', (_field, file, info) => {
      if (aborted) { file.resume(); return }
      const safeName = basename(info.filename || 'upload')
      const fullPath = join(destRel, safeName)
      const tmpPath = fullPath + '.uploading'
      const out = createWriteStream(tmpPath)
      let received = 0

      const done = new Promise((resolveP) => {
        file.on('data', (chunk) => { received += chunk.length })
        file.on('limit', () => {
          tooLarge = true
          aborted = true
          out.destroy()
          fs.unlink(tmpPath).catch(() => {})
        })
        out.on('close', async () => {
          if (aborted) return resolveP()
          try {
            await fs.rename(tmpPath, fullPath)
            const root = resolve(project.cwd)
            uploaded.push({
              path: relative(root, fullPath).replace(/\\/g, '/'),
              filename: safeName,
              size: received,
            })
          } catch {
            aborted = true
            fs.unlink(tmpPath).catch(() => {})
          }
          resolveP()
        })
        out.on('error', () => {
          aborted = true
          fs.unlink(tmpPath).catch(() => {})
          resolveP()
        })
      })
      pending.push(done)
      file.pipe(out)
    })

    bb.on('error', (err) => {
      aborted = true
      if (!res.headersSent) res.status(400).json({ error: err.message })
    })

    bb.on('close', async () => {
      await Promise.all(pending)
      if (res.headersSent) return
      if (tooLarge) return res.status(413).json({ error: 'file too large' })
      if (aborted) return res.status(500).json({ error: 'upload failed' })
      res.json({ uploaded })
    })

    req.pipe(bb)
  })

  /** POST /api/projects/:id/files/mkdir — create a directory. */
  router.post('/api/projects/:id/files/mkdir', async (req, res) => {
    const project = getProject(req, res)
    if (!project) return

    let target
    try {
      ;({ target } = resolveSandboxed(project, req.body?.path))
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message })
    }

    try {
      await fs.mkdir(target, { recursive: true })
      res.json({ path: req.body?.path })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  /**
   * GET /api/projects/:id/serve/* — serve project files under their actual
   * filesystem path so HTML previews can resolve sibling resources naturally.
   * An iframe loaded from `…/serve/foo.html` resolves a relative
   * `<link href="styles.css">` to `…/serve/styles.css` against this same
   * endpoint. Inline only (no attachment disposition).
   */
  router.get('/api/projects/:id/serve/*', async (req, res) => {
    const project = getProject(req, res)
    if (!project) return

    const relPath = req.params[0] || ''
    let target
    try {
      ;({ target } = resolveSandboxed(project, relPath))
    } catch (err) {
      return res.status(err.status || 500).send(err.message)
    }

    let stat
    try { stat = await fs.stat(target) }
    catch (err) {
      if (err.code === 'ENOENT') return res.status(404).send('not found')
      return res.status(500).send(err.message)
    }
    if (stat.isDirectory()) return res.status(403).send('directory listing disabled')

    res.setHeader('Content-Type', mimeFor(basename(target)))
    res.setHeader('Content-Length', String(stat.size))
    const stream = createReadStream(target)
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500).end()
      else res.destroy(err)
    })
    stream.pipe(res)
  })

  /** POST /api/projects/:id/files/rename — rename or move a file or directory. */
  router.post('/api/projects/:id/files/rename', async (req, res) => {
    const project = getProject(req, res)
    if (!project) return

    const { from, to } = req.body || {}
    if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) {
      return res.status(400).json({ error: 'from and to are required' })
    }

    let fromTarget, toTarget
    try {
      ;({ target: fromTarget } = resolveSandboxed(project, from))
      ;({ target: toTarget } = resolveSandboxed(project, to))
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message })
    }

    try {
      await fs.stat(fromTarget) // 404 if source missing
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'source not found' })
      return res.status(500).json({ error: err.message })
    }

    // Refuse to overwrite an existing destination
    try {
      await fs.stat(toTarget)
      return res.status(409).json({ error: 'destination already exists' })
    } catch (err) {
      if (err.code !== 'ENOENT') return res.status(500).json({ error: err.message })
    }

    try {
      await fs.rename(fromTarget, toTarget)
      res.json({ from, to })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
