/**
 * Line diff — the one diff implementation behind the prompt-skills page
 * ("看两版的差异"). Pure function, no IO: the server computes, the page only
 * renders the ops it is handed.
 *
 * Classic LCS table over lines (O(n·m) memory). Prompt skills are a few
 * hundred lines at most; inputs past MAX_CELLS are refused loudly rather than
 * diffed slowly or approximately.
 */

export const MAX_CELLS = 4_000_000

function splitLines(text) {
  const s = String(text ?? '')
  if (s === '') return []
  const lines = s.split('\n')
  // A trailing newline ends the last line; it does not start an empty one.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * diffLines(oldText, newText) → [{ op: 'same' | 'del' | 'add', text }]
 * Deletions come before additions inside a changed run (unified-diff order).
 */
export function diffLines(oldText, newText) {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const n = a.length
  const m = b.length
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    throw new Error(`diff too large: ${n} x ${m} lines`)
  }
  // lcs[i][j] = LCS length of a[i:] and b[j:]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'same', text: a[i] }); i++; j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ op: 'del', text: a[i] }); i++
    } else {
      ops.push({ op: 'add', text: b[j] }); j++
    }
  }
  while (i < n) ops.push({ op: 'del', text: a[i++] })
  while (j < m) ops.push({ op: 'add', text: b[j++] })
  return ops
}

/** Count of added / deleted lines in a diffLines() result. */
export function diffStats(ops) {
  let added = 0
  let deleted = 0
  for (const o of ops) {
    if (o.op === 'add') added++
    else if (o.op === 'del') deleted++
  }
  return { added, deleted }
}
