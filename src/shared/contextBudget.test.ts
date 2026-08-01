import { describe, expect, it } from 'vitest'
import { CONTEXT_SHADOW_COMPACT_RATIO, evaluateContextBudget } from './contextBudget'

describe('evaluateContextBudget', () => {
  it('keeps the proposed decision diagnostic and compares it with the fixed window', () => {
    const result = evaluateContextBudget({
      contextWindowTokens: 10_000,
      outputReserveTokens: 1_000,
      estimatedPromptTokens: 9_500,
      modelRequestIndex: 25,
      safetyMarginTokens: 200,
      fixedToolKeepRecentRounds: 25
    })

    expect(result.compactTriggerTokens).toBe(Math.round(10_000 * CONTEXT_SHADOW_COMPACT_RATIO))
    expect(result.inputBudgetTokens).toBe(8_800)
    expect(result.estimatedWouldTriggerCompaction).toBe(true)
    expect(result.estimatedWouldHitInputBoundary).toBe(true)
    expect(result.fixedWindowWouldStubToolResults).toBe(true)
  })

  it('clamps invalid values without throwing or producing negative budgets', () => {
    const result = evaluateContextBudget({
      contextWindowTokens: 0,
      outputReserveTokens: -1,
      estimatedPromptTokens: -2,
      modelRequestIndex: 0,
      safetyMarginTokens: -3
    })

    expect(result.contextWindowTokens).toBe(1)
    expect(result.outputReserveTokens).toBe(0)
    expect(result.safetyMarginTokens).toBe(0)
    expect(result.inputBudgetTokens).toBe(1)
    expect(result.estimatedWouldHitInputBoundary).toBe(false)
  })
})
