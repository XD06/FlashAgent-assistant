import { describe, expect, it } from 'vitest'
import { computeDiffStats } from './diffStats'

describe('computeDiffStats', () => {
  it('returns null when both inputs are undefined', () => {
    expect(computeDiffStats(undefined, undefined)).toBeNull()
  })

  it('counts all new lines as added for new files (write_file)', () => {
    expect(computeDiffStats(undefined, 'line 1\nline 2\nline 3')).toEqual({ added: 3, removed: 0 })
    expect(computeDiffStats('', 'only one')).toEqual({ added: 1, removed: 0 })
  })

  it('computes exact added and removed lines via LCS with prefix/suffix trimming', () => {
    const oldText = ['alpha', 'beta', 'gamma', 'delta'].join('\n')
    const newText = ['alpha', 'BETA', 'gamma', 'epsilon', 'delta'].join('\n')
    expect(computeDiffStats(oldText, newText)).toEqual({ added: 2, removed: 1 })
  })

  it('normalizes CRLF line endings cleanly', () => {
    expect(computeDiffStats('a\r\nb', 'a\nb\nc')).toEqual({ added: 1, removed: 0 })
  })

  it('handles large diffs safely above DP budget without throwing', () => {
    const oldLines = Array.from({ length: 260 }, (_, i) => `old-${i}`)
    const newLines = Array.from({ length: 260 }, (_, i) => (i < 200 ? `old-${i}` : `new-${i}`))
    expect(computeDiffStats(oldLines.join('\n'), newLines.join('\n'))).toEqual({ added: 60, removed: 60 })
  })
})
