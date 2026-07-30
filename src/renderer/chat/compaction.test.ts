import { describe, expect, it } from 'vitest'
import type { AiMessageInput } from '@shared/types'
import {
  COMPACT_MIN_STALE_TURNS,
  COMPACT_TRIGGER_CHARS,
  COMPACT_TRIGGER_TOKENS,
  CONTEXT_WINDOW_TOKENS,
  KEEP_MAX_TURNS,
  KEEP_MIN_TURNS,
  KEEP_RECENT_TOKEN_RATIO,
  MAX_SEND_CHARS,
  MAX_SEND_MESSAGES,
  computeKeepStart,
  estimateEffectiveTokens,
  estimateTokensFromChars,
  shouldCompact,
  truncateForSend
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

  it('cap pressure: fires when the payload would exceed the send cap, tokens cold', () => {
    expect(
      shouldCompact({ promptTokens: 1_000, staleTurns: 2, staleChars: 100, sendMessages: MAX_SEND_MESSAGES + 1 })
    ).toBe(true)
  })

  it('cap pressure: quiet at exactly the send cap', () => {
    expect(
      shouldCompact({ promptTokens: 1_000, staleTurns: 2, staleChars: 100, sendMessages: MAX_SEND_MESSAGES })
    ).toBe(false)
  })

  it('cap pressure: still requires a non-empty stale zone', () => {
    expect(
      shouldCompact({ promptTokens: 1_000, staleTurns: 0, staleChars: 0, sendMessages: MAX_SEND_MESSAGES * 2 })
    ).toBe(false)
  })
})

describe('truncateForSend', () => {
  const msg = (i: number, role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant'): AiMessageInput => ({
    role,
    text: `m${i}`
  })
  const many = (n: number): AiMessageInput[] => Array.from({ length: n }, (_, i) => msg(i))

  it('passes short conversations through untouched', () => {
    const input = many(5)
    expect(truncateForSend(input, false)).toEqual(input)
  })

  it('drops the oldest beyond the message cap and prepends the omitted note', () => {
    const out = truncateForSend(many(30), false)
    expect(out).toHaveLength(MAX_SEND_MESSAGES + 1)
    expect(out[0].text).toContain('6 earlier messages omitted')
    expect(out[1].text).toBe('m6')
    expect(out[out.length - 1].text).toBe('m29')
  })

  it('char budget: trims older messages but always keeps the latest', () => {
    const big = 'x'.repeat(MAX_SEND_CHARS)
    const input: AiMessageInput[] = [
      { role: 'user', text: big },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: big }
    ]
    const out = truncateForSend(input, false)
    // The giant latest message alone busts the budget — still kept.
    expect(out[out.length - 1].text).toBe(big)
    expect(out[0].text).toContain('omitted')
  })

  it('pinFirst: the recap head survives even when the cap trims history', () => {
    const recap: AiMessageInput = { role: 'user', text: 'RECAP' }
    const out = truncateForSend([recap, ...many(40)], false, true)
    expect(out[0].text).toBe('RECAP')
    // Head takes one slot: recap + note + (cap - 1) kept messages.
    expect(out.filter((m) => m.text.startsWith('m'))).toHaveLength(MAX_SEND_MESSAGES - 1)
    expect(out[1].text).toContain('omitted')
    expect(out[out.length - 1].text).toBe('m39')
  })

  it('pinFirst: recap chars count toward the char budget', () => {
    const recap: AiMessageInput = { role: 'user', text: 'r'.repeat(MAX_SEND_CHARS) }
    const input: AiMessageInput[] = [recap, msg(0), msg(1)]
    const out = truncateForSend(input, false, true)
    expect(out[0].text).toBe(recap.text)
    // Budget already spent by the recap — only the latest message survives.
    expect(out[out.length - 1].text).toBe('m1')
    expect(out.filter((m) => m.text.startsWith('m'))).toHaveLength(1)
  })
})

describe('estimateTokensFromChars', () => {
  it('rounds up at ~4 chars per token and clamps negatives', () => {
    expect(estimateTokensFromChars(0)).toBe(0)
    expect(estimateTokensFromChars(1)).toBe(1)
    expect(estimateTokensFromChars(4)).toBe(1)
    expect(estimateTokensFromChars(5)).toBe(2)
    expect(estimateTokensFromChars(-10)).toBe(0)
  })
})

describe('computeKeepStart', () => {
  const budget = Math.round(CONTEXT_WINDOW_TOKENS * KEEP_RECENT_TOKEN_RATIO)

  it('keeps everything for an empty transcript', () => {
    expect(computeKeepStart([])).toBe(0)
  })

  it('keeps the whole transcript while it fits the budget', () => {
    // 8 small turns — far under the keep budget, but the min guardrail
    // (not the budget) is what bounds keepStart from above here.
    expect(computeKeepStart([10, 10, 10, 10, 10, 10, 10, 10])).toBe(0)
  })

  it('budget exceeded: cuts where the backward walk overflows', () => {
    // Six turns of budget/4 each: walking backwards, the 5th accumulated
    // turn overflows → keepStart lands after the overflowing index.
    const per = Math.ceil(budget / 4)
    const estimates = [per, per, per, per, per, per]
    expect(computeKeepStart(estimates)).toBe(2)
  })

  it('min guardrail: always keeps at least KEEP_MIN_TURNS verbatim', () => {
    // Every turn is huge — the raw walk would keep only the newest one.
    const estimates = Array(10).fill(budget * 2)
    expect(computeKeepStart(estimates)).toBe(10 - KEEP_MIN_TURNS)
  })

  it('max guardrail: never keeps more than KEEP_MAX_TURNS verbatim', () => {
    // Every turn is tiny — the raw walk would keep all 50.
    const estimates = Array(50).fill(1)
    expect(computeKeepStart(estimates)).toBe(50 - KEEP_MAX_TURNS)
  })

  it('honours a user-configured window', () => {
    // Tiny window → tiny keep budget → the min guardrail takes over.
    const estimates = Array(10).fill(1_000)
    expect(computeKeepStart(estimates, 4_000)).toBe(10 - KEEP_MIN_TURNS)
  })
})

describe('estimateEffectiveTokens', () => {
  it('passes null usage through (char-gate fallback applies)', () => {
    expect(estimateEffectiveTokens(null, 999_999)).toBe(null)
  })

  it('adds the trailing rough estimate on top of real usage', () => {
    expect(estimateEffectiveTokens(100_000, 8_000)).toBe(102_000)
  })

  it('zero trailing chars leaves usage untouched', () => {
    expect(estimateEffectiveTokens(42, 0)).toBe(42)
  })
})
