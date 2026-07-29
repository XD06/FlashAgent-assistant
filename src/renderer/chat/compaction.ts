// Rolling-compression policy (pure logic, no React/DOM) — shared between
// ChatMode and unit tests.
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
}

/** Pre-send trigger: token-driven when usage is available (95% of the
 * attention budget — the global default or a user-configured window),
 * otherwise the legacy stale-zone char gates — so every provider gets
 * compression, usage or not. */
export function shouldCompact(signal: CompactSignal, windowTokens?: number): boolean {
  // Nothing to compress — even a hot token count can't help here (the
  // recent-keep window is fixed in the core loop; shrinking it is P1-B2).
  if (signal.staleTurns <= 0) return false
  if (signal.promptTokens !== null) return signal.promptTokens >= compactTriggerTokens(windowTokens)
  return signal.staleTurns >= COMPACT_MIN_STALE_TURNS && signal.staleChars >= COMPACT_TRIGGER_CHARS
}
