import { describe, expect, it } from 'vitest'
import type { AiMessageInput } from '@shared/types'
import {
  CJK_TOKENS_PER_CHAR,
  COMPACT_KEEP_TAIL_RATIO,
  COMPACT_TRIGGER_TOKENS,
  CONTEXT_WINDOW_TOKENS,
  INITIAL_TASK_ANCHOR_MAX_CHARS,
  KEEP_RECENT_TOKEN_RATIO,
  MAX_SEND_CHARS,
  MAX_SEND_MESSAGES,
  SOFT_COMPACT_TRIGGER_RATIO,
  buildRecapHeadMessage,
  computeTaskRoundKeepStart,
  estimateEffectiveTokens,
  estimateTokensFromChars,
  estimateTokensFromText,
  evaluatePreSendCompaction,
  groupTaskRounds,
  messagePayloadChars,
  messagePayloadTokens,
  sendCharCapForWindow,
  sendMessageCapForWindow,
  shouldCompact,
  softCompactTriggerTokens,
  truncateForSend
} from './compaction'

describe('compaction constants', () => {
  it('hard trigger line is 85% and soft trigger line is 65% of the 200k attention budget', () => {
    expect(CONTEXT_WINDOW_TOKENS).toBe(200_000)
    expect(COMPACT_TRIGGER_TOKENS).toBe(170_000)
    expect(softCompactTriggerTokens(200_000)).toBe(Math.round(200_000 * SOFT_COMPACT_TRIGGER_RATIO))
    expect(COMPACT_KEEP_TAIL_RATIO).toBe(0.35)
  })
})

describe('shouldCompact', () => {
  it('never compacts with an empty stale zone, even at high token counts', () => {
    expect(shouldCompact({ promptTokens: CONTEXT_WINDOW_TOKENS, staleEntries: 0 })).toBe(false)
  })

  it('token-driven: fires at exactly the trigger line', () => {
    expect(shouldCompact({ promptTokens: COMPACT_TRIGGER_TOKENS, staleEntries: 2 })).toBe(true)
  })

  it('token-driven: stays quiet below the trigger line', () => {
    expect(shouldCompact({ promptTokens: COMPACT_TRIGGER_TOKENS - 1, staleEntries: 20 })).toBe(
      false
    )
  })

  it('token-driven: compacts a hot context as soon as a complete stale round exists', () => {
    // Usage says the context is hot — compress whatever complete stale round
    // exists; no fixed character or entry threshold delays it.
    expect(
      shouldCompact({ promptTokens: COMPACT_TRIGGER_TOKENS + 1, staleEntries: 1 })
    ).toBe(true)
  })

  it('does not compact without a context token measurement, regardless of transcript size', () => {
    expect(shouldCompact({ promptTokens: null, staleEntries: 20 })).toBe(false)
  })

  it('does not compact solely because an old fixed send cap is exceeded', () => {
    expect(
      shouldCompact({
        promptTokens: 1_000,
        staleEntries: 2,
        sendMessages: MAX_SEND_MESSAGES + 1,
        sendChars: MAX_SEND_CHARS * 4
      })
    ).toBe(false)
  })

  it('uses the configured attention budget for a replay-token estimate', () => {
    expect(shouldCompact({ promptTokens: null, staleEntries: 2, sendTokens: 108_799 }, 128_000)).toBe(false)
    expect(shouldCompact({ promptTokens: null, staleEntries: 2, sendTokens: 108_800 }, 128_000)).toBe(true)
    expect(shouldCompact({ promptTokens: null, staleEntries: 2, sendTokens: 120_000 }, 1_000_000)).toBe(false)
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

  it('scales send caps when the caller supplies a larger attention window', () => {
    const input = many(MAX_SEND_MESSAGES + 6)
    expect(sendMessageCapForWindow(128_000)).toBeGreaterThan(input.length)
    expect(sendCharCapForWindow(128_000)).toBeGreaterThan(MAX_SEND_CHARS)
    expect(truncateForSend(input, false, false, 128_000)).toEqual(input)
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

  it('embedded tool traces count toward the char budget: slims immediate preceding assistant and drops older ones whole', () => {
    const trace = {
      id: 'c1',
      name: 'read_file',
      argsJson: '{"path":"a.ts"}',
      result: 'y'.repeat(MAX_SEND_CHARS)
    }
    const input: AiMessageInput[] = [
      { role: 'user', text: 'q0' },
      { role: 'assistant', text: 'older_done_' + 'y'.repeat(MAX_SEND_CHARS) },
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'recent_done', toolTrace: [trace] },
      { role: 'user', text: 'q2' }
    ]
    const out = truncateForSend(input, false)
    // The older trace-bearing message busts the budget and is dropped whole
    expect(out.some((m) => m.text === 'older_done')).toBe(false)
    // But the immediate preceding assistant survives slimmed without losing memory
    const immediate = out.find((m) => m.text === 'recent_done')
    expect(immediate).toBeDefined()
    expect(immediate?.toolTrace?.[0].result).toContain('trimmed for context window')
    expect(immediate?.toolTrace?.[0].result).toContain('call_id="c1"')
    expect(out[out.length - 1].text).toBe('q2')
  })

  it('estimates tool replay tokens with the same atomic trace shape', () => {
    const m: AiMessageInput = {
      role: 'assistant',
      text: 'done',
      toolTrace: [{ id: 'c1', name: 'read_file', argsJson: '{"path":"a.ts"}', result: 'hello world' }]
    }
    expect(messagePayloadTokens(m)).toBeGreaterThan(estimateTokensFromText(m.text))
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
      { role: 'user' as const, taskRoundId: 'a', tokens: 4000 },
      { role: 'assistant' as const, taskRoundId: 'a', tokens: 4000 },
      { role: 'user' as const, taskRoundId: 'b', tokens: 200 },
      { role: 'assistant' as const, taskRoundId: 'b', tokens: 200 },
      { role: 'user' as const, taskRoundId: 'c', tokens: 600 },
      { role: 'assistant' as const, taskRoundId: 'c', tokens: 600 }
    ]

    // 10k attention budget -> 8.5k recent window. Rounds B+C fit (1.6k),
    // while adding A (8.0k -> 9.6k total) overflows. The cut is the start of B (index 2).
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

describe('buildRecapHeadMessage', () => {
  it('prepends immutable initial task anchor when provided and appends resume gate', () => {
    const out = buildRecapHeadMessage({
      summary: '# 复工文档\n## 5. 当前任务与下一步\n继续修改测试',
      initialTaskText: '修复登录 500 异常并补回归单测',
      isZh: true
    })
    expect(out).toContain('[原始任务锚点（请勿偏离）]')
    expect(out).toContain('修复登录 500 异常并补回归单测')
    expect(out).toContain('# 复工文档')
    expect(out).toContain('[SYSTEM RESUME GATE]')
  })

  it('caps oversized initial task anchors and omits the anchor block when null', () => {
    const huge = 'a'.repeat(INITIAL_TASK_ANCHOR_MAX_CHARS + 500)
    const withHuge = buildRecapHeadMessage({ summary: 'SUMMARY', initialTaskText: huge, isZh: false })
    expect(withHuge).toContain('[Initial Task Anchor (immutable)]')
    expect(withHuge).toContain(`${'a'.repeat(INITIAL_TASK_ANCHOR_MAX_CHARS)}…`)

    const withoutAnchor = buildRecapHeadMessage({ summary: 'SUMMARY', initialTaskText: null, isZh: false })
    expect(withoutAnchor).not.toContain('Initial Task Anchor')
    expect(withoutAnchor).toContain('[SYSTEM RESUME GATE]')
  })
})

describe('evaluatePreSendCompaction', () => {
  it('fires hard compaction at 85% regardless of smartAutoCompact or defer cooldown', () => {
    const res = evaluatePreSendCompaction({
      promptTokens: 85_000,
      sendTokens: 80_000,
      toolOutputTokens: 0,
      staleEntries: 4,
      windowTokens: 100_000,
      smartAutoCompact: false,
      hasTodoMilestone: false,
      deferState: { deferredAtTokens: 84_000, deferredAtTurns: 10 },
      currentTurnsCount: 10
    })
    expect(res).toEqual({ action: 'hard', effectiveTokens: 85_000 })
  })

  it('requests smart judgment at >=65% soft watermark, >=40% todo milestone, or >=40% tool bloat', () => {
    expect(
      evaluatePreSendCompaction({
        promptTokens: 65_000,
        sendTokens: 60_000,
        toolOutputTokens: 1_000,
        staleEntries: 4,
        windowTokens: 100_000,
        smartAutoCompact: true,
        hasTodoMilestone: false,
        deferState: null,
        currentTurnsCount: 8
      })
    ).toEqual({ action: 'judge', effectiveTokens: 65_000, phaseHint: 'soft-budget' })

    expect(
      evaluatePreSendCompaction({
        promptTokens: 42_000,
        sendTokens: 42_000,
        toolOutputTokens: 1_000,
        staleEntries: 4,
        windowTokens: 100_000,
        smartAutoCompact: true,
        hasTodoMilestone: true,
        deferState: null,
        currentTurnsCount: 8
      })
    ).toEqual({ action: 'judge', effectiveTokens: 42_000, phaseHint: 'todo-milestone' })

    expect(
      evaluatePreSendCompaction({
        promptTokens: 42_000,
        sendTokens: 42_000,
        toolOutputTokens: 25_000,
        staleEntries: 4,
        windowTokens: 100_000,
        smartAutoCompact: true,
        hasTodoMilestone: false,
        deferState: null,
        currentTurnsCount: 8
      })
    ).toEqual({ action: 'judge', effectiveTokens: 42_000, phaseHint: 'tool-bloat' })
  })

  it('enforces defer cooldown until +10% context growth or +4 turns, and skips soft checks when disabled', () => {
    const cooled = evaluatePreSendCompaction({
      promptTokens: 70_000,
      sendTokens: 70_000,
      toolOutputTokens: 0,
      staleEntries: 4,
      windowTokens: 100_000,
      smartAutoCompact: true,
      hasTodoMilestone: false,
      deferState: { deferredAtTokens: 65_000, deferredAtTurns: 8 },
      currentTurnsCount: 10
    })
    expect(cooled).toEqual({ action: 'none', effectiveTokens: 70_000 })

    const afterGrowth = evaluatePreSendCompaction({
      promptTokens: 76_000,
      sendTokens: 76_000,
      toolOutputTokens: 0,
      staleEntries: 4,
      windowTokens: 100_000,
      smartAutoCompact: true,
      hasTodoMilestone: false,
      deferState: { deferredAtTokens: 65_000, deferredAtTurns: 8 },
      currentTurnsCount: 10
    })
    expect(afterGrowth).toEqual({ action: 'judge', effectiveTokens: 76_000, phaseHint: 'soft-budget' })

    const disabled = evaluatePreSendCompaction({
      promptTokens: 76_000,
      sendTokens: 76_000,
      toolOutputTokens: 50_000,
      staleEntries: 4,
      windowTokens: 100_000,
      smartAutoCompact: false,
      hasTodoMilestone: true,
      deferState: null,
      currentTurnsCount: 12
    })
    expect(disabled).toEqual({ action: 'none', effectiveTokens: 76_000 })
  })
})
