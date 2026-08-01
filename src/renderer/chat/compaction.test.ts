import { describe, expect, it } from 'vitest'
import type { AiMessageInput } from '@shared/types'
import {
  CJK_TOKENS_PER_CHAR,
  COMPACT_TRIGGER_CHARS,
  COMPACT_TRIGGER_TOKENS,
  CONTEXT_WINDOW_TOKENS,
  KEEP_RECENT_TOKEN_RATIO,
  MAX_SEND_CHARS,
  MAX_SEND_MESSAGES,
  computeTaskRoundKeepStart,
  estimateEffectiveTokens,
  estimateTokensFromChars,
  estimateTokensFromText,
  groupTaskRounds,
  messagePayloadChars,
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
    expect(shouldCompact({ promptTokens: CONTEXT_WINDOW_TOKENS, staleEntries: 0, staleChars: 0 })).toBe(false)
  })

  it('token-driven: fires at exactly the trigger line', () => {
    expect(shouldCompact({ promptTokens: COMPACT_TRIGGER_TOKENS, staleEntries: 2, staleChars: 100 })).toBe(true)
  })

  it('token-driven: stays quiet below the trigger line', () => {
    expect(shouldCompact({ promptTokens: COMPACT_TRIGGER_TOKENS - 1, staleEntries: 20, staleChars: 999_999 })).toBe(
      false
    )
  })

  it('token-driven: bypasses the min-stale-turns fallback gate', () => {
    // Usage says the context is hot — compress whatever stale exists, even a
    // zone smaller than the char fallback pressure line.
    expect(
      shouldCompact({ promptTokens: COMPACT_TRIGGER_TOKENS + 1, staleEntries: 1, staleChars: 10 })
    ).toBe(true)
  })

  it('fallback: fires on stale character pressure without a fixed entry count', () => {
    expect(
      shouldCompact({ promptTokens: null, staleEntries: 1, staleChars: COMPACT_TRIGGER_CHARS })
    ).toBe(true)
  })

  it('fallback: stays quiet below the stale character pressure line', () => {
    expect(
      shouldCompact({ promptTokens: null, staleEntries: 20, staleChars: COMPACT_TRIGGER_CHARS - 1 })
    ).toBe(false)
  })

  it('fallback: never compacts an empty stale zone', () => {
    expect(
      shouldCompact({ promptTokens: null, staleEntries: 0, staleChars: COMPACT_TRIGGER_CHARS * 2 })
    ).toBe(false)
  })

  it('cap pressure: fires when the payload would exceed the send cap, tokens cold', () => {
    expect(
      shouldCompact({ promptTokens: 1_000, staleEntries: 2, staleChars: 100, sendMessages: MAX_SEND_MESSAGES + 1 })
    ).toBe(true)
  })

  it('cap pressure: quiet at exactly the send cap', () => {
    expect(
      shouldCompact({ promptTokens: 1_000, staleEntries: 2, staleChars: 100, sendMessages: MAX_SEND_MESSAGES })
    ).toBe(false)
  })

  it('cap pressure: still requires a non-empty stale zone', () => {
    expect(
      shouldCompact({ promptTokens: 1_000, staleEntries: 0, staleChars: 0, sendMessages: MAX_SEND_MESSAGES * 2 })
    ).toBe(false)
  })

  it('char-cap pressure: fires when the body would exceed the char cap, tokens cold', () => {
    expect(
      shouldCompact({ promptTokens: 1_000, staleEntries: 2, staleChars: 100, sendMessages: 10, sendChars: MAX_SEND_CHARS + 1 })
    ).toBe(true)
  })

  it('char-cap pressure: quiet at exactly the char cap', () => {
    expect(
      shouldCompact({ promptTokens: 1_000, staleEntries: 2, staleChars: 100, sendMessages: 10, sendChars: MAX_SEND_CHARS })
    ).toBe(false)
  })

  it('char-cap pressure: still requires a non-empty stale zone', () => {
    expect(
      shouldCompact({ promptTokens: 1_000, staleEntries: 0, staleChars: 0, sendChars: MAX_SEND_CHARS * 2 })
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
    const out = truncateForSend(many(MAX_SEND_MESSAGES + 6), false)
    expect(out).toHaveLength(MAX_SEND_MESSAGES + 1)
    expect(out[0].text).toContain('6 earlier messages omitted')
    expect(out[1].text).toBe('m6')
    expect(out[out.length - 1].text).toBe(`m${MAX_SEND_MESSAGES + 5}`)
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
    const out = truncateForSend([recap, ...many(MAX_SEND_MESSAGES + 16)], false, true)
    expect(out[0].text).toBe('RECAP')
    // Head takes one slot: recap + note + (cap - 1) kept messages.
    expect(out.filter((m) => m.text.startsWith('m'))).toHaveLength(MAX_SEND_MESSAGES - 1)
    expect(out[1].text).toContain('omitted')
    expect(out[out.length - 1].text).toBe(`m${MAX_SEND_MESSAGES + 15}`)
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

  it('embedded tool traces count toward the char budget and never split', () => {
    const trace = {
      id: 'c1',
      name: 'read_file',
      argsJson: '{"path":"a.ts"}',
      result: 'y'.repeat(MAX_SEND_CHARS)
    }
    const input: AiMessageInput[] = [
      { role: 'user', text: 'q0' },
      { role: 'assistant', text: 'done', toolTrace: [trace] },
      { role: 'user', text: 'q1' }
    ]
    const out = truncateForSend(input, false)
    // The trace-bearing message busts the budget — dropped whole (call and
    // result together), never shipped partially.
    expect(out.some((m) => m.toolTrace)).toBe(false)
    expect(out[out.length - 1].text).toBe('q1')
  })
})

describe('messagePayloadChars', () => {
  it('counts text only when no trace is attached', () => {
    expect(messagePayloadChars({ role: 'user', text: 'abcd' })).toBe(4)
  })

  it('adds trace name/args/result plus per-entry envelope', () => {
    const m: AiMessageInput = {
      role: 'assistant',
      text: 'ok',
      toolTrace: [{ id: 'c1', name: 'run', argsJson: '{}', result: 'out' }]
    }
    expect(messagePayloadChars(m)).toBe(2 + 3 + 2 + 3 + 24)
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

describe('estimateTokensFromText', () => {
  it('matches the chars/4 rule for pure ASCII', () => {
    expect(estimateTokensFromText('a'.repeat(400))).toBe(100)
    expect(estimateTokensFromText('')).toBe(0)
  })

  it('counts CJK chars at the dense per-char rate', () => {
    expect(estimateTokensFromText('中'.repeat(100))).toBe(Math.ceil(100 * CJK_TOKENS_PER_CHAR))
  })

  it('CJK punctuation and fullwidth forms count as CJK', () => {
    // 。 (U+3002) and ， (U+FF0C) tokenize like han chars, not ASCII.
    expect(estimateTokensFromText('。，')).toBe(Math.ceil(2 * CJK_TOKENS_PER_CHAR))
  })

  it('mixed text sums both rates', () => {
    const text = '汉'.repeat(100) + 'a'.repeat(400)
    expect(estimateTokensFromText(text)).toBe(Math.ceil(100 * CJK_TOKENS_PER_CHAR + 100))
  })

  it('is dramatically higher than the flat rule on Chinese text', () => {
    const zh = '上下文压缩机制'.repeat(50)
    // The old chars/4 rule under-counted Chinese ~3× — guard the ratio.
    expect(estimateTokensFromText(zh)).toBeGreaterThan(estimateTokensFromChars(zh.length) * 2)
  })
})

describe('task-round retention', () => {
  it('groups modern task ids atomically and falls back to user-started legacy rounds', () => {
    const modern = groupTaskRounds([
      { role: 'user', taskRoundId: 'a', tokens: 10 },
      { role: 'assistant', taskRoundId: 'a', tokens: 20 },
      { role: 'user', taskRoundId: 'b', tokens: 30 },
      { role: 'assistant', taskRoundId: 'b', tokens: 40 }
    ])
    const legacy = groupTaskRounds([
      { role: 'user', tokens: 10 },
      { role: 'assistant', tokens: 20 },
      { role: 'user', tokens: 30 },
      { role: 'assistant', tokens: 40 }
    ])

    expect(modern).toEqual([
      { start: 0, end: 2, tokens: 30 },
      { start: 2, end: 4, tokens: 70 }
    ])
    expect(legacy).toEqual(modern)
  })

  it('keeps whole newest task rounds rather than splitting a user and assistant pair', () => {
    const entries = [
      { role: 'user' as const, taskRoundId: 'a', tokens: 900 },
      { role: 'assistant' as const, taskRoundId: 'a', tokens: 900 },
      { role: 'user' as const, taskRoundId: 'b', tokens: 200 },
      { role: 'assistant' as const, taskRoundId: 'b', tokens: 200 },
      { role: 'user' as const, taskRoundId: 'c', tokens: 600 },
      { role: 'assistant' as const, taskRoundId: 'c', tokens: 600 }
    ]

    // 10k attention budget -> 2k recent window. Rounds B+C fit (1.6k),
    // while adding A would overflow. The cut is the start of B, never 3.
    expect(computeTaskRoundKeepStart(entries, 10_000)).toBe(2)
  })

  it('keeps every complete round when all fit the token budget', () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      taskRoundId: `round-${Math.floor(index / 2)}`,
      tokens: 10
    }))

    expect(computeTaskRoundKeepStart(entries, 10_000)).toBe(0)
  })

  it('uses the transport cap only as a hard limit while retaining whole rounds', () => {
    const entries = [
      { role: 'user' as const, taskRoundId: 'a', tokens: 10 },
      { role: 'assistant' as const, taskRoundId: 'a', tokens: 10 },
      { role: 'user' as const, taskRoundId: 'b', tokens: 10 },
      { role: 'assistant' as const, taskRoundId: 'b', tokens: 10 },
      { role: 'user' as const, taskRoundId: 'c', tokens: 10 },
      { role: 'assistant' as const, taskRoundId: 'c', tokens: 10 }
    ]

    expect(computeTaskRoundKeepStart(entries, 1_000_000, 4)).toBe(2)
  })
})

describe('estimateEffectiveTokens', () => {
  it('passes null usage through (char-gate fallback applies)', () => {
    expect(estimateEffectiveTokens(null, 999_999)).toBe(null)
  })

  it('adds the trailing token estimate on top of real usage', () => {
    expect(estimateEffectiveTokens(100_000, 8_000)).toBe(108_000)
  })

  it('zero trailing tokens leaves usage untouched', () => {
    expect(estimateEffectiveTokens(42, 0)).toBe(42)
  })
})
