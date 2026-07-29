import { describe, expect, it } from 'vitest'
import {
  COMPACT_MIN_STALE_TURNS,
  COMPACT_TRIGGER_CHARS,
  COMPACT_TRIGGER_TOKENS,
  CONTEXT_WINDOW_TOKENS,
  shouldCompact
} from './compaction'

describe('compaction constants', () => {
  it('trigger line is 95% of the 128k attention budget', () => {
    expect(CONTEXT_WINDOW_TOKENS).toBe(128_000)
    expect(COMPACT_TRIGGER_TOKENS).toBe(121_600)
  })
})

describe('shouldCompact', () => {
  it('never compacts with an empty stale zone, even at high token counts', () => {
    expect(shouldCompact({ promptTokens: CONTEXT_WINDOW_TOKENS, staleTurns: 0, staleChars: 0 })).toBe(false)
  })

  it('token-driven: fires at exactly the trigger line', () => {
    expect(shouldCompact({ promptTokens: COMPACT_TRIGGER_TOKENS, staleTurns: 2, staleChars: 100 })).toBe(true)
  })

  it('token-driven: stays quiet below the trigger line', () => {
    expect(shouldCompact({ promptTokens: COMPACT_TRIGGER_TOKENS - 1, staleTurns: 20, staleChars: 999_999 })).toBe(
      false
    )
  })

  it('token-driven: bypasses the min-stale-turns fallback gate', () => {
    // Usage says the context is hot — compress whatever stale exists, even a
    // zone smaller than the char-fallback minimum.
    expect(
      shouldCompact({ promptTokens: COMPACT_TRIGGER_TOKENS + 1, staleTurns: COMPACT_MIN_STALE_TURNS - 1, staleChars: 10 })
    ).toBe(true)
  })

  it('fallback: fires when both char gates are met', () => {
    expect(
      shouldCompact({ promptTokens: null, staleTurns: COMPACT_MIN_STALE_TURNS, staleChars: COMPACT_TRIGGER_CHARS })
    ).toBe(true)
  })

  it('fallback: too few stale turns', () => {
    expect(
      shouldCompact({ promptTokens: null, staleTurns: COMPACT_MIN_STALE_TURNS - 1, staleChars: COMPACT_TRIGGER_CHARS * 2 })
    ).toBe(false)
  })

  it('fallback: not enough stale chars', () => {
    expect(
      shouldCompact({ promptTokens: null, staleTurns: COMPACT_MIN_STALE_TURNS * 2, staleChars: COMPACT_TRIGGER_CHARS - 1 })
    ).toBe(false)
  })
})
