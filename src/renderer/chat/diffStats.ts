export interface DiffStats {
  added: number
  removed: number
}

function splitLines(text: string): string[] {
  if (!text) return []
  return text.replace(/\r\n/g, '\n').split('\n')
}

/**
 * Compute added/removed line counts between oldText and newText using trimmed LCS.
 * Falls back cleanly for very large inputs so streaming diff headers stay instant.
 */
export function computeDiffStats(oldText?: string, newText?: string): DiffStats | null {
  if (oldText === undefined && newText === undefined) return null
  const oldLines = splitLines(oldText ?? '')
  const newLines = splitLines(newText ?? '')

  // Trim identical prefix and suffix first to shrink DP work on real edits.
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--
    newEnd--
  }

  const m = oldEnd - prefix
  const n = newEnd - prefix
  if (m === 0 && n === 0) return { added: 0, removed: 0 }
  if (m === 0) return { added: n, removed: 0 }
  if (n === 0) return { added: 0, removed: m }

  // ponytail: 40k DP cells upper bound; larger diffs use unordered line multiset intersection
  if (m * n > 40_000) {
    const newCounts = new Map<string, number>()
    for (let j = prefix; j < newEnd; j++) {
      const line = newLines[j]
      newCounts.set(line, (newCounts.get(line) ?? 0) + 1)
    }
    let matched = 0
    for (let i = prefix; i < oldEnd; i++) {
      const line = oldLines[i]
      const count = newCounts.get(line) ?? 0
      if (count > 0) {
        matched++
        newCounts.set(line, count - 1)
      }
    }
    return { added: n - matched, removed: m - matched }
  }

  // Rolling 1D LCS DP (exact line alignment)
  let prev = new Uint32Array(n + 1)
  let curr = new Uint32Array(n + 1)
  for (let i = 1; i <= m; i++) {
    const a = oldLines[prefix + i - 1]
    for (let j = 1; j <= n; j++) {
      curr[j] = a === newLines[prefix + j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1])
    }
    const tmp = prev
    prev = curr
    curr = tmp
    curr.fill(0)
  }

  const lcs = prev[n]
  return { added: n - lcs, removed: m - lcs }
}
