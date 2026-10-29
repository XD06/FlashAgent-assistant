import { describe, expect, it } from 'vitest'
import { beginStream, endStream, hasActiveStream } from './activeStreams'

describe('activeStreams', () => {
  it('tracks concurrent streams per window', () => {
    expect(hasActiveStream(1)).toBe(false)
    beginStream(1)
    beginStream(1)
    expect(hasActiveStream(1)).toBe(true)
    endStream(1)
    expect(hasActiveStream(1)).toBe(true)
    endStream(1)
    expect(hasActiveStream(1)).toBe(false)
    // A stray end must not leave the window marked as busy.
    endStream(1)
    expect(hasActiveStream(1)).toBe(false)
  })

  it('keeps windows independent', () => {
    beginStream(2)
    expect(hasActiveStream(2)).toBe(true)
    expect(hasActiveStream(3)).toBe(false)
    endStream(2)
  })
})
