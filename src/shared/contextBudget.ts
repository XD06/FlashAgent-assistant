/** Shadow-only context budget decisions. These values are diagnostic until a
 * provider/model calibration supplies a non-zero safety margin. */

export const CONTEXT_SHADOW_COMPACT_RATIO = 0.95

export interface ContextBudgetShadowInput {
  contextWindowTokens: number
  outputReserveTokens: number
  estimatedPromptTokens: number
  modelRequestIndex: number
  safetyMarginTokens?: number
  fixedToolKeepRecentRounds?: number
}

export interface ContextBudgetShadowDecision {
  contextWindowTokens: number
  outputReserveTokens: number
  safetyMarginTokens: number
  inputBudgetTokens: number
  compactTriggerTokens: number
  estimatedWouldTriggerCompaction: boolean
  estimatedWouldHitInputBoundary: boolean
  fixedWindowWouldStubToolResults: boolean
}

/**
 * Compare the current payload estimate with both the existing fixed-window
 * policy and the proposed token budget. This function never changes payloads
 * or asks the model to stop; it only returns numeric/boolean diagnostics.
 */
export function evaluateContextBudget(input: ContextBudgetShadowInput): ContextBudgetShadowDecision {
  const contextWindowTokens = Math.max(1, Math.floor(input.contextWindowTokens))
  const outputReserveTokens = Math.max(0, Math.floor(input.outputReserveTokens))
  const safetyMarginTokens = Math.max(0, Math.floor(input.safetyMarginTokens ?? 0))
  const estimatedPromptTokens = Math.max(0, Math.floor(input.estimatedPromptTokens))
  const compactTriggerTokens = Math.round(contextWindowTokens * CONTEXT_SHADOW_COMPACT_RATIO)
  const inputBudgetTokens = Math.max(0, contextWindowTokens - outputReserveTokens - safetyMarginTokens)
  const fixedToolKeepRecentRounds = Math.max(1, Math.floor(input.fixedToolKeepRecentRounds ?? 25))

  return {
    contextWindowTokens,
    outputReserveTokens,
    safetyMarginTokens,
    inputBudgetTokens,
    compactTriggerTokens,
    estimatedWouldTriggerCompaction: estimatedPromptTokens >= compactTriggerTokens,
    estimatedWouldHitInputBoundary: estimatedPromptTokens > inputBudgetTokens,
    fixedWindowWouldStubToolResults: input.modelRequestIndex >= fixedToolKeepRecentRounds
  }
}
