/**
 * Unit tests for terminal/fsbrowse.js — the cross-platform path primitives
 * behind GET /api/fs (MES-13804 nanocode Windows directory picker).
 *
 * The win32 branches are exercised here on a Linux host by injecting
 * `platform: 'win32'`; the server process itself only runs the posix branch
 * on Linux, so route behaviour is unchanged there. The end-to-end posix flow
 * is covered by the 9477 curl check + terminal/tests/e2e.test.js.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  parentOf,
  normalizePath,
  listDrives,
  isHidden,
  listDirectory,
  pathModuleFor,
} from '../../terminal/fsbrowse.js'

describe('fsbrowse pathModuleFor', () => {
  it('returns path.win32 for win32 and path.posix otherwise', () => {
    assert.equal(pathModuleFor('win32'), path.win32)
    assert.equal(pathModuleFor('posix'), path.posix)
    assert.equal(pathModuleFor('other'), path.posix)
  })
})

describe('fsbrowse parentOf (win32)', () => {
  it('returns the parent directory one level up', () => {
    assert.equal(parentOf('C:\\foo\\bar', 'win32'), 'C:\\foo')
    assert.equal(parentOf('C:\\Users\\me\\proj', 'win32'), 'C:\\Users\\me')
  })

  it('returns null at a drive root', () => {
    assert.equal(parentOf('C:\\foo', 'win32'), null)
    assert.equal(parentOf('C:\\', 'win32'), null)
    assert.equal(parentOf('C:', 'win32'), null)
  })

  it('normalises forward-slash input to backslash', () => {
    assert.equal(parentOf('C:/foo/bar', 'win32'), 'C:\\foo')
    assert.equal(parentOf('C:/foo', 'win32'), null)
  })

  it('handles D: drive the same as C:', () => {
    assert.equal(parentOf('D:\\projects\\x', 'win32'), 'D:\\projects')
    assert.equal(parentOf('D:\\projects', 'win32'), null)
  })
})

describe('fsbrowse parentOf (posix)', () => {
  it('returns the parent one level up', () => {
    assert.equal(parentOf('/foo/bar', 'posix'), '/foo')
    assert.equal(parentOf('/home/me/proj', 'posix'), '/home/me')
  })

  it('returns "/" for a top-level dir and null for root', () => {
    assert.equal(parentOf('/foo', 'posix'), '/')
    assert.equal(parentOf('/', 'posix'), null)
  })

  it('returns null for empty input', () => {
    assert.equal(parentOf('', 'posix'), null)
    assert.equal(parentOf(null, 'posix'), null)
  })

  it('does not over-traverse: /a/b/c → /a/b', () => {
    assert.equal(parentOf('/a/b/c', 'posix'), '/a/b')
  })
})

describe('fsbrowse normalizePath', () => {
  it('win32 collapses forward slashes and dot segments', () => {
    assert.equal(normalizePath('C:/foo/./bar', 'win32'), 'C:\\foo\\bar')
    assert.equal(normalizePath('C:\\foo\\..\\bar', 'win32'), 'C:\\bar')
  })

  it('posix keeps single slashes and collapses dot segments', () => {
    assert.equal(normalizePath('/foo/./bar', 'posix'), '/foo/bar')
    assert.equal(normalizePath('/foo/bar/', 'posix'), '/foo/bar')
  })

  it('returns null for empty input', () => {
    assert.equal(normalizePath('', 'win32'), null)
    assert.equal(normalizePath('', 'posix'), null)
  })
})

describe('fsbrowse listDrives', () => {
  it('win32 returns one entry per existing drive, with isDir:true', () => {
    const exists = (p) => p === 'C:\\' || p === 'D:\\'
    const drives = listDrives('win32', exists)
    assert.deepEqual(drives, [
      { name: 'C:\\', isDir: true },
      { name: 'D:\\', isDir: true },
    ])
  })

  it('win32 returns empty list when no drives exist', () => {
    const drives = listDrives('win32', () => false)
    assert.deepEqual(drives, [])
  })

  it('posix returns a single root entry regardless of existsFn', () => {
    const drives = listDrives('posix', () => false)
    assert.deepEqual(drives, [{ name: '/', isDir: true }])
  })

  it('win32 skips drives whose probe throws', () => {
    const exists = (p) => {
      if (p === 'A:\\') throw new Error('not ready')
      return p === 'C:\\'
    }
    const drives = listDrives('win32', exists)
    assert.deepEqual(drives, [{ name: 'C:\\', isDir: true }])
  })
})

describe('fsbrowse isHidden', () => {
  it('treats a leading dot as hidden cross-platform', () => {
    assert.equal(isHidden('.git'), true)
    assert.equal(isHidden('.hidden'), true)
    assert.equal(isHidden('git'), false)
    assert.equal(isHidden('..git'), true)
  })

  it('returns false for non-string input', () => {
    assert.equal(isHidden(null), false)
    assert.equal(isHidden(undefined), false)
  })
})

describe('fsbrowse listDirectory', () => {
  // Mock Dirent — only `name` and `isDirectory()` are used by listDirectory.
  function dirent(name, isDir) {
    return {
      name,
      isDirectory: () => isDir,
    }
  }

  it('filters to non-hidden directories, sorted case-insensitively, with parent', () => {
    const readdir = () => [
      dirent('Zeta', true),
      dirent('.hidden', true),
      dirent('apple', true),
      dirent('Banana', true),
      dirent('readme.txt', false),
      dirent('..keep', true),
    ]
    const result = listDirectory('/home/me', 'posix', { readdir })
    assert.equal(result.path, '/home/me')
    assert.equal(result.parent, '/home')
    assert.deepEqual(
      result.entries,
      [
        { name: 'apple', isDir: true },
        { name: 'Banana', isDir: true },
        { name: 'Zeta', isDir: true },
      ],
    )
  })

  it('win32 sets parent to null at a drive root', () => {
    const readdir = () => [dirent('Users', true), dirent('Windows', true)]
    const result = listDirectory('C:\\', 'win32', { readdir })
    assert.equal(result.path, 'C:\\')
    assert.equal(result.parent, null)
    assert.deepEqual(result.entries, [
      { name: 'Users', isDir: true },
      { name: 'Windows', isDir: true },
    ])
  })

  it('posix sets parent to null at /', () => {
    const readdir = () => [dirent('home', true), dirent('opt', true)]
    const result = listDirectory('/', 'posix', { readdir })
    assert.equal(result.path, '/')
    assert.equal(result.parent, null)
    assert.equal(result.entries.length, 2)
  })

  it('returns an empty entries array for an empty dir', () => {
    const readdir = () => []
    const result = listDirectory('/home/me/empty', 'posix', { readdir })
    assert.equal(result.parent, '/home/me')
    assert.deepEqual(result.entries, [])
  })
})
