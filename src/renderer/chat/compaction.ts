// Rolling-compression policy (pure logic, no React/DOM) — shared between
// ChatMode and unit tests.
//
import type { AiMessageInput } from '@shared/types'
//
// The context window is a deliberately narrowed "attention budget", NOT the
// model's physical limit (the models we target mostly support 500k+).
// Keeping the working context small forces the model to stay focused on the
// current task. Users can override it per install via the
// `contextWindowTokens` setting; this constant is the default.
export const CONTEXT_WINDOW_TOKENS = 128_000

/** Inter-turn trigger line: once the latest request's prompt reached this
 * share of the attention budget, compress before the next send. */
export const COMPACT_TRIGGER_RATIO = 0.95
export const COMPACT_TRIGGER_TOKENS = Math.round(CONTEXT_WINDOW_TOKENS * COMPACT_TRIGGER_RATIO)

/** Trigger line for a (possibly user-configured) attention budget. */
export function compactTriggerTokens(windowTokens?: number): number {
  const window = windowTokens && windowTokens > 0 ? windowTokens : CONTEXT_WINDOW_TOKENS
  return Math.round(window * COMPACT_TRIGGER_RATIO)
}

// Send-window layout (see ChatMode for how the zones are built):
//
//   [==== covered by recap ====][==== stale / compressible ====][==== recent keep ====]
//   0 ........ compact.covered .. keepStart (= len-KEEP) ........ len-1
//
// After a successful compress, compact.covered advances to keepStart. The
// next compress waits until enough *new* turns have slid out of the recent
// window, which prevents thrashing (re-summarizing 1–2 turns per message).
//
// Product window (~15 rounds total feel): keep the last ~5 rounds (10 turns)
// verbatim; older turns become the recap.
/** @deprecated Legacy fixed-count keep window — the send path now sizes the
 * keep window by token budget (see computeKeepStart). Kept for reference. */
export const COMPACT_KEEP_RECENT = 10
/** Fallback gate (no usage data): minimum stale turns before re-running. */
export const COMPACT_MIN_STALE_TURNS = 6
/** Fallback gate (no usage data): char budget on stale turn.text. */
export const COMPACT_TRIGGER_CHARS = 12_000

export interface CompactSignal {
  /** promptTokens from the latest provider usage report, or null when the
   * provider never reported usage (fallback char gates apply instead). */
  promptTokens: number | null
  /** Number of turns in the stale zone [covered, keepStart). */
  staleTurns: number
  /** Sum of turn.text lengths across the stale zone. */
  staleChars: number
  /** Messages the request would contain if sent right now (recap + history
   * entries + injected-note replays + the new message), counted before
   * consecutive-user merging — a conservative overcount. Optional: callers
   * without a payload preview omit it and rely on the other gates. */
  sendMessages?: number
}

/** Pre-send trigger: token-driven when usage is available (95% of the
 * attention budget — the global default or a user-configured window),
 * otherwise the legacy stale-zone char gates — so every provider gets
 * compression, usage or not. */
export function shouldCompact(signal: CompactSignal, windowTokens?: number): boolean {
  // Nothing to compress — even a hot token count can't help here (the
  // recent-keep window is fixed in the core loop; shrinking it is P1-B2).
  if (signal.staleTurns <= 0) return false
  // Send-cap pressure: without compression truncateForSend would silently
  // drop the oldest messages with no recap — an unrecoverable accuracy hole
  // for chatty (low-token, many-turn) conversations. Compress them instead,
  // regardless of how far the token count is from the trigger line.
  if ((signal.sendMessages ?? 0) > MAX_SEND_MESSAGES) return true
  if (signal.promptTokens !== null) return signal.promptTokens >= compactTriggerTokens(windowTokens)
  return signal.staleTurns >= COMPACT_MIN_STALE_TURNS && signal.staleChars >= COMPACT_TRIGGER_CHARS
}

// ---- Hard payload safety net (runaway guard, not a diet) ----
//
// Cap what gets sent to the model on long conversations: latest turns within
// a message/char budget. Sits *under* rolling compression — the cap-pressure
// gate above fires first, so by the time this trims anything the stale zone
// is already folded into the recap. The full history stays visible locally.
export const MAX_SEND_MESSAGES = 24
// Generous budget: the last ~2 rounds replay tool outputs at up to 12k per
// call (toolRecap), and starving that replay costs more than it saves — the
// model just re-reads everything.
export const MAX_SEND_CHARS = 120_000

export function truncateForSend(messages: AiMessageInput[], isZh: boolean, pinFirst = false): AiMessageInput[] {
  // pinFirst: the leading message is the recap — it must survive truncation
  // (dropping it would erase the compressed history), so it is kept outside
  // the sliding window while still counting toward the char budget.
  const head = pinFirst && messages.length > 0 ? messages[0] : null
  const rest = head ? messages.slice(1) : messages
  const recent = rest.slice(-(MAX_SEND_MESSAGES - (head ? 1 : 0)))
  const kept: AiMessageInput[] = []
  let total = head ? head.text.length : 0
  for (let i = recent.length - 1; i >= 0; i--) {
    total += recent[i].text.length
    // Always keep at least the latest message, however large it is.
    if (kept.length > 0 && total > MAX_SEND_CHARS) break
    kept.unshift(recent[i])
  }
  const omitted = rest.length - kept.length
  if (omitted > 0) {
    kept.unshift({
      role: 'user',
      text: isZh
        ? `（提示：这是一段较长的对话，此前 ${omitted} 条消息已省略）`
        : `(Note: long conversation — ${omitted} earlier messages omitted)`
    })
  }
  if (head) kept.unshift(head)
  return kept
}

// ---- Recent-keep window: token-budget sized (accuracy over counting) ----
//
// A fixed turn count makes the keep window wildly variable in tokens: ten
// chatty turns are ~2k tokens while ten file-heavy agent turns can be 90k —
// the latter leaves compression no room to actually shrink the context.
// Budget the window in tokens instead; turn counts are only guardrails.

/** Share of the attention budget reserved for verbatim recent turns. */
export const KEEP_RECENT_TOKEN_RATIO = 0.2
/** Never keep fewer verbatim turns than this (protects tiny-budget cases). */
export const KEEP_MIN_TURNS = 4
/** Never keep more verbatim turns than this (bounds per-send scan work). */
export const KEEP_MAX_TURNS = 20

/** The provider-agnostic rough estimate: ~4 chars per token. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4)
}

/** First index of the "always send full text" window. Walks from the newest
 * turn backwards accumulating per-turn token estimates until the keep budget
 * (window × KEEP_RECENT_TOKEN_RATIO) is spent, then clamps to the turn-count
 * guardrails. */
export function computeKeepStart(turnTokenEstimates: number[], windowTokens?: number): number {
  const len = turnTokenEstimates.length
  const window = windowTokens && windowTokens > 0 ? windowTokens : CONTEXT_WINDOW_TOKENS
  const budget = Math.round(window * KEEP_RECENT_TOKEN_RATIO)
  let keepStart = 0
  let accumulated = 0
  for (let i = len - 1; i >= 0; i--) {
    accumulated += turnTokenEstimates[i]
    if (accumulated > budget) {
      keepStart = i + 1
      break
    }
  }
  // Guardrails: keep at least KEEP_MIN_TURNS and at most KEEP_MAX_TURNS.
  keepStart = Math.min(keepStart, Math.max(0, len - KEEP_MIN_TURNS))
  keepStart = Math.max(keepStart, len - KEEP_MAX_TURNS, 0)
  return keepStart
}

/** Hybrid context size: the provider's last real usage report plus a rough
 * estimate of everything it has not seen yet (turns appended after the
 * report and the message about to be sent). Fixes the one-round lag where a
 * huge paste slipped past the trigger because usage was a request behind.
 * Null usage stays null — the char-gate fallback applies instead. */
export function estimateEffectiveTokens(usageTokens: number | null, trailingChars: number): number | null {
  if (usageTokens === null) return null
  return usageTokens + estimateTokensFromChars(trailingChars)
}
