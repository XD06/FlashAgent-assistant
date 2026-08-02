// Rolling-compression policy (pure logic, no React/DOM) — shared between
// ChatMode and unit tests.
//
import type { AiMessageInput } from '@shared/types'
import { CJK_TOKENS_PER_CHAR, estimateTokensFromChars, estimateTokensFromText } from '@shared/contextMeter'

export { CJK_TOKENS_PER_CHAR, estimateTokensFromChars, estimateTokensFromText } from '@shared/contextMeter'
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
/** Fallback gate when usage is unavailable: character pressure in the stale
 * task-round zone. There is deliberately no fixed recent-turn count. */
export const COMPACT_TRIGGER_CHARS = 12_000

export interface CompactSignal {
  /** promptTokens from the latest provider usage report, or null when the
   * provider never reported usage (fallback char gates apply instead). */
  promptTokens: number | null
  /** Number of transcript entries in the stale zone [covered, keepStart). */
  staleEntries: number
  /** Sum of turn.text lengths across the stale zone. */
  staleChars: number
  /** Messages the request would contain if sent right now (recap + history
   * entries + injected-note replays + the new message), counted before
   * consecutive-user merging — a conservative overcount. Optional: callers
   * without a payload preview omit it and rely on the other gates. */
  sendMessages?: number
  /** Characters the request body would contain if sent right now (recap +
   * replayed turn texts with tool records + the new message). Optional —
   * retained only for diagnostics and older callers; it does not decide
   * compaction. */
  sendChars?: number
  /** Estimated token count of the full replay payload, used when real usage
   * is unavailable or one request behind. */
  sendTokens?: number
}

/** Pre-send trigger: token-driven when usage is available (95% of the
 * attention budget — the global default or a user-configured window),
 * otherwise from stale-zone character pressure. */
export function shouldCompact(signal: CompactSignal, windowTokens?: number): boolean {
  // Nothing to compress — the latest complete task round must remain whole.
  if (signal.staleEntries <= 0) return false
  // Provider usage is authoritative when available. If a provider omits it,
  // use the pre-send replay estimate instead. Fixed transport caps never
  // decide compaction: a larger user-selected attention budget must keep
  // working after a long Agent/tool round.
  const tokenEstimate = Math.max(signal.promptTokens ?? 0, signal.sendTokens ?? 0)
  if (signal.promptTokens !== null || signal.sendTokens !== undefined) {
    return tokenEstimate >= compactTriggerTokens(windowTokens)
  }
  return signal.staleChars >= COMPACT_TRIGGER_CHARS
}

// ---- Payload safety net ----
// These are fallback limits for callers that have no configured attention
// budget. Chat passes the selected budget, so this guard grows with it.
export const MAX_SEND_MESSAGES = 48
// Generous budget: the last ~2 rounds replay tool outputs at up to 12k per
// call (toolRecap), and starving that replay costs more than it saves — the
// model just re-reads everything.
export const MAX_SEND_CHARS = 120_000

/** A configured attention budget must not be silently narrowed by the
 * fallback transport cap. */
export function sendMessageCapForWindow(windowTokens?: number): number {
  if (!windowTokens || windowTokens <= 0) return MAX_SEND_MESSAGES
  return Math.max(MAX_SEND_MESSAGES, Math.ceil(windowTokens / 256))
}

/** English-like payloads average four characters per token. CJK-heavy text
 * reaches the token trigger sooner, so token pressure remains the main guard. */
export function sendCharCapForWindow(windowTokens?: number): number {
  if (!windowTokens || windowTokens <= 0) return MAX_SEND_CHARS
  return Math.max(MAX_SEND_CHARS, Math.ceil(windowTokens * 4))
}

/** Chars a message contributes to the wire payload. An embedded tool trace
 * expands into real tool-call/tool-result messages at the protocol layer,
 * so its args and results count like text (+~24 chars/entry envelope).
 * Keeping the trace inside its message makes truncation atomic — a call can
 * never be dropped separately from its result. */
export function messagePayloadChars(m: AiMessageInput): number {
  let total = m.text.length
  for (const t of m.toolTrace ?? []) total += t.name.length + t.argsJson.length + t.result.length + 24
  return total
}

/** Approximate the replay payload in tokens without retaining prompt text. */
export function messagePayloadTokens(m: AiMessageInput): number {
  let total = estimateTokensFromText(m.text)
  for (const t of m.toolTrace ?? []) {
    total += estimateTokensFromText(t.name) + estimateTokensFromText(t.argsJson) + estimateTokensFromText(t.result) + 6
  }
  return total
}

export function truncateForSend(
  messages: AiMessageInput[],
  isZh: boolean,
  pinFirst = false,
  windowTokens?: number
): AiMessageInput[] {
  // pinFirst: the leading message is the recap — it must survive truncation
  // (dropping it would erase the compressed history), so it is kept outside
  // the sliding window while still counting toward the char budget.
  const head = pinFirst && messages.length > 0 ? messages[0] : null
  const rest = head ? messages.slice(1) : messages
  const maxMessages = sendMessageCapForWindow(windowTokens)
  const maxChars = sendCharCapForWindow(windowTokens)
  const recent = rest.slice(-(maxMessages - (head ? 1 : 0)))
  const kept: AiMessageInput[] = []
  let total = head ? messagePayloadChars(head) : 0
  for (let i = recent.length - 1; i >= 0; i--) {
    total += messagePayloadChars(recent[i])
    // Always keep at least the latest message, however large it is.
    if (kept.length > 0 && total > maxChars) break
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

// ---- Recent task-round window: token-budget sized (accuracy over counting) ----

/** Share of the attention budget reserved for verbatim recent turns. */
export const KEEP_RECENT_TOKEN_RATIO = 0.2
/** One transcript entry as seen by the task-round retention policy. New
 * conversations carry a stable taskRoundId. Persisted conversations from
 * before that field existed fall back to a user message starting a round. */
export interface TaskRoundTokenInput {
  role: 'user' | 'assistant'
  taskRoundId?: string
  tokens: number
}

export interface TaskRoundRange {
  start: number
  end: number
  tokens: number
}

/** Group transcript entries into atomic user task rounds. A retained range
 * never starts halfway through a round, so a task's request, tool evidence,
 * and answer remain available together. */
export function groupTaskRounds(entries: TaskRoundTokenInput[]): TaskRoundRange[] {
  if (!entries.length) return []
  const ranges: TaskRoundRange[] = []
  let start = 0
  let activeId = entries[0].taskRoundId

  const finish = (end: number): void => {
    let tokens = 0
    for (let i = start; i < end; i++) {
      const value = entries[i].tokens
      tokens += Number.isFinite(value) ? Math.max(0, value) : 0
    }
    ranges.push({ start, end, tokens })
  }

  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i]
    // Known ids are authoritative. Legacy entries use the old transcript
    // convention: every user message begins a new user task round.
    const startsRound = entry.taskRoundId ? entry.taskRoundId !== activeId : entry.role === 'user'
    if (!startsRound) continue
    finish(i)
    start = i
    activeId = entry.taskRoundId
  }
  finish(entries.length)
  return ranges
}

/** First entry of the verbatim recent-task window. This policy walks complete
 * user task rounds from newest to oldest until either the token budget or a
 * transport message cap is reached. The newest complete task round is always
 * retained, even when it alone exceeds the target budget. */
export function computeTaskRoundKeepStart(
  entries: TaskRoundTokenInput[],
  windowTokens?: number,
  maxKeptTurnEntries?: number
): number {
  if (!entries.length) return 0
  const window = windowTokens && windowTokens > 0 ? windowTokens : CONTEXT_WINDOW_TOKENS
  const budget = Math.round(window * KEEP_RECENT_TOKEN_RATIO)
  const maxEntries =
    maxKeptTurnEntries === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(maxKeptTurnEntries))
  const rounds = groupTaskRounds(entries)
  let keepStart = entries.length
  let keptTokens = 0
  let keptEntries = 0

  for (let i = rounds.length - 1; i >= 0; i--) {
    const round = rounds[i]
    const roundEntries = round.end - round.start
    const isNewest = keepStart === entries.length
    if (!isNewest && (keptTokens + round.tokens > budget || keptEntries + roundEntries > maxEntries)) break
    keepStart = round.start
    keptTokens += round.tokens
    keptEntries += roundEntries
  }
  return keepStart
}

/** Hybrid context size: the provider's last real usage report plus a rough
 * estimate of everything it has not seen yet (turns appended after the
 * report and the message about to be sent, pre-estimated by the caller —
 * script-aware, see estimateTokensFromText). Fixes the one-round lag where
 * a huge paste slipped past the trigger because usage was a request behind.
 * Null usage stays null — the char-gate fallback applies instead. */
export function estimateEffectiveTokens(usageTokens: number | null, trailingTokens: number): number | null {
  if (usageTokens === null) return null
  return usageTokens + Math.max(0, trailingTokens)
}
