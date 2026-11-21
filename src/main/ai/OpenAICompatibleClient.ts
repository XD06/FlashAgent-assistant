import { resolve } from 'node:path'
import type { AiMessageInput, ProviderApiType, ProviderSettings, ReasoningMode } from '@shared/types'
import { measureContext, type ContextMeasurement } from '@shared/contextMeter'
import { CONTEXT_SHADOW_COMPACT_RATIO, evaluateContextBudget } from '@shared/contextBudget'
import { mergeRecapDoc } from '@shared/recapDoc'

export class AiConfigurationError extends Error {}
const ANTHROPIC_VERSION = '2023-06-01'

export type ProviderFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface ProviderRequestOptions {
  readonly fetcher?: ProviderFetch
  /** Override HTTP/network retry count (clamped to [0, RETRY_BACKOFF_MS.length]). */
  readonly maxRetries?: number
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|models)$/i, '')
    .replace(/\/+$/, '')
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v1(?:\/messages|\/models)?$/i, '')
}

function buildProviderUrl(provider: ProviderSettings, path: 'chat/completions' | 'models' | 'messages'): string {
  if (provider.apiType === 'anthropic') {
    const base = normalizeAnthropicBaseUrl(provider.baseUrl)
    if (path === 'messages') return `${base}/v1/messages`
    if (path === 'models') return `${base}/v1/models`
    return `${base}/v1/messages`
  }
  return `${normalizeBaseUrl(provider.baseUrl)}/${path}`
}

function buildProviderHeaders(provider: ProviderSettings): Record<string, string> {
  if (provider.apiType === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    }
  }

  return {
    'content-type': 'application/json',
    authorization: `Bearer ${provider.apiKey}`
  }
}

function fetchProvider(url: string, init: RequestInit, options: ProviderRequestOptions = {}): Promise<Response> {
  return (options.fetcher ?? fetch)(url, init)
}

// Transient provider failures (rate limits, gateway hiccups, dropped
// connections) used to kill the whole conversation mid-task. Retry them with
// exponential backoff — but only before the first streamed byte: once deltas
// have reached the UI a replay could duplicate content, so mid-stream stalls
// still fail fast.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000]
const RETRY_AFTER_CAP_MS = 30_000

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS)
  const at = Date.parse(header)
  if (!Number.isNaN(at)) return Math.min(Math.max(0, at - Date.now()), RETRY_AFTER_CAP_MS)
  return null
}

function sleepUnlessAborted(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectPromise(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const REQUEST_HEADERS_TIMEOUT_MS = 30_000

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

async function fetchWithAttemptTimeout(
  url: string,
  init: RequestInit,
  options: ProviderRequestOptions,
  outerSignal: AbortSignal | null | undefined
): Promise<Response> {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => {
    timeoutController.abort(
      new Error(`Provider request timed out after ${REQUEST_HEADERS_TIMEOUT_MS / 1000}s waiting for response headers.`)
    )
  }, REQUEST_HEADERS_TIMEOUT_MS)

  if (outerSignal?.aborted) {
    clearTimeout(timer)
    throw abortError(outerSignal)
  }
  // Tie the request to the caller's signal for the whole response lifetime,
  // not just until the headers arrive: an abort after this point must also
  // cancel the SSE body. The old manual forwarding listener was removed in
  // this function's finally, which is exactly when the body starts.
  const signal = outerSignal ? AbortSignal.any([timeoutController.signal, outerSignal]) : timeoutController.signal

  try {
    return await fetchProvider(url, { ...init, signal }, options)
  } finally {
    clearTimeout(timer)
  }
}

/** fetchProvider with backoff on transient failures. Non-retryable responses
 * (401, 400, ...) are returned as-is for the caller's !ok check; retryable
 * ones are retried and, once attempts run out, thrown as a readable error. */
async function fetchProviderWithRetry(
  url: string,
  init: RequestInit,
  options: ProviderRequestOptions,
  onRetryWait?: (waitMs: number, attempt: number, maxAttempts: number) => void
): Promise<Response> {
  const signal = init.signal as AbortSignal | null | undefined
  const maxRetries = Math.max(0, Math.min(options.maxRetries ?? RETRY_BACKOFF_MS.length, RETRY_BACKOFF_MS.length))
  for (let attempt = 0; ; attempt++) {
    let failure: string
    let retryAfterMs: number | null = null
    try {
      const response = await fetchWithAttemptTimeout(url, init, options, signal)
      if (response.ok || !RETRYABLE_STATUS.has(response.status)) return response
      failure = await readProviderError(response, signal ?? undefined)
      retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    } catch (error) {
      // Abort is the user's call, never retried; anything else at the fetch
      // layer is a network-level transient (ECONNRESET, dead proxy, timeout, ...).
      const isUserAbort = signal?.aborted || (error instanceof Error && error.name === 'AbortError' && !error.message.includes('timed out'))
      if (isUserAbort) throw error
      failure = error instanceof Error ? error.message : String(error)
    }
    if (attempt >= maxRetries) throw new Error(failure)
    const waitMs = retryAfterMs ?? RETRY_BACKOFF_MS[attempt]
    onRetryWait?.(waitMs, attempt + 1, maxRetries)
    await sleepUnlessAborted(waitMs, signal)
  }
}

function assertProviderReady(provider: ProviderSettings, requireModel = true): void {
  if (!provider.apiKey.trim()) {
    throw new AiConfigurationError('Missing API key. Open Settings and configure your API provider.')
  }
  if (requireModel && !provider.model.trim()) {
    throw new AiConfigurationError('Missing model. Open Settings and set a model name.')
  }
}

async function readProviderError(response: Response, signal?: AbortSignal): Promise<string> {
  const body = await response.text().catch(() => '')
  // A stop while the error body is being drained is still a user abort, not a
  // provider failure that should be retried or surfaced as a 4xx/5xx.
  if (signal) throwIfAborted(signal)
  return `Provider request failed (${response.status}): ${body || response.statusText}`
}

export interface StreamDelta {
  content?: string
  reasoning?: string
}

export function parseOpenAIStreamEvent(raw: string): StreamDelta | null {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))

  for (const line of lines) {
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return null
    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{
          delta?: {
            content?: string
            reasoning_content?: string
            reasoning?: string
            thinking?: string
          }
          message?: { content?: string }
        }>
      }
      const delta = parsed.choices?.[0]?.delta
      if (!delta) continue
      const content = delta.content ?? parsed.choices?.[0]?.message?.content
      const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking
      if (typeof content === 'string' || typeof reasoning === 'string') {
        const result: StreamDelta = {}
        if (typeof content === 'string') result.content = content
        if (typeof reasoning === 'string') result.reasoning = reasoning
        return result
      }
    } catch {
      // Incomplete or malformed JSON chunk — skip silently
      continue
    }
  }
  return null
}

export function parseAnthropicStreamEvent(raw: string): StreamDelta | null {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))

  for (const line of lines) {
    const payload = line.slice(5).trim()
    if (!payload) continue

    try {
      const parsed = JSON.parse(payload) as {
        type?: string
        delta?: { type?: string; text?: string; thinking?: string }
      }

      if (parsed.type === 'content_block_delta' && parsed.delta) {
        if (parsed.delta.type === 'text_delta' && parsed.delta.text) {
          return { content: parsed.delta.text }
        }
        if (parsed.delta.type === 'thinking_delta' && parsed.delta.thinking) {
          return { reasoning: parsed.delta.thinking }
        }
      }
    } catch {
      // Incomplete or malformed JSON chunk — skip silently
      continue
    }
  }
  return null
}

function parseProviderStreamEvent(apiType: ProviderApiType, raw: string): StreamDelta | null {
  return apiType === 'anthropic' ? parseAnthropicStreamEvent(raw) : parseOpenAIStreamEvent(raw)
}

/** Real token usage reported by the provider for one model request. The
 * newest promptTokens value is the actual size of the sent context — the
 * ground truth token-driven compression will be built on (P1-A). */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
}

/** Pull token usage out of a stream event. OpenAI-compatible servers append
 * a final chunk carrying `usage` when stream_options.include_usage was
 * requested; Anthropic always reports input_tokens in message_start and
 * output_tokens in message_delta. Returns partials — callers merge. */
export function parseUsageEvent(apiType: ProviderApiType, raw: string): Partial<TokenUsage> | null {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))

  for (const line of lines) {
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      if (apiType === 'anthropic') {
        const parsed = JSON.parse(payload) as {
          type?: string
          message?: { usage?: { input_tokens?: number; output_tokens?: number } }
          usage?: { input_tokens?: number; output_tokens?: number }
        }
        const usage =
          parsed.type === 'message_start' ? parsed.message?.usage : parsed.type === 'message_delta' ? parsed.usage : undefined
        if (!usage) continue
        const result: Partial<TokenUsage> = {}
        if (typeof usage.input_tokens === 'number') result.promptTokens = usage.input_tokens
        if (typeof usage.output_tokens === 'number') result.completionTokens = usage.output_tokens
        if (Object.keys(result).length) return result
      } else {
        const parsed = JSON.parse(payload) as {
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null
        }
        if (!parsed.usage) continue
        const result: Partial<TokenUsage> = {}
        if (typeof parsed.usage.prompt_tokens === 'number') result.promptTokens = parsed.usage.prompt_tokens
        if (typeof parsed.usage.completion_tokens === 'number') result.completionTokens = parsed.usage.completion_tokens
        if (Object.keys(result).length) return result
      }
    } catch {
      // Incomplete or malformed JSON chunk — skip silently
      continue
    }
  }
  return null
}

function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl.trim())
  if (!match) return null
  return { mediaType: match[1], data: match[2] }
}

function buildOpenAIContent(message: AiMessageInput): unknown {
  const text = message.text ?? (message as any).content ?? ''
  if (!message.images?.length) return text
  const parts: unknown[] = []
  if (text) parts.push({ type: 'text', text })
  for (const image of message.images) {
    parts.push({ type: 'image_url', image_url: { url: image } })
  }
  return parts
}

function buildAnthropicContent(message: AiMessageInput): unknown {
  const text = message.text ?? (message as any).content ?? ''
  if (!message.images?.length) return text
  const parts: unknown[] = []
  for (const image of message.images) {
    const parsed = parseDataUrl(image)
    if (!parsed) continue
    parts.push({
      type: 'image',
      source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data }
    })
  }
  if (text) parts.push({ type: 'text', text })
  return parts
}

// ---- Cross-turn tool-trace replay ----
//
// History assistant turns can carry a toolTrace: the calls that actually
// executed in that turn. Replaying them as native tool-call/tool-result
// messages keeps the model's view of history structurally identical to a
// live tool session — text-narrated tool records taught models to imitate
// narration instead of issuing real calls (the hallucination anti-pattern).

/** Requests without a tools param cannot carry native tool messages (strict
 * providers reject them) — fold the trace into the assistant text instead. */
export function flattenToolTrace(message: AiMessageInput): AiMessageInput {
  if (!message.toolTrace?.length) return message
  const lines = message.toolTrace.map((t) => t.result).join('\n')
  const { toolTrace: _omit, ...rest } = message
  return { ...rest, text: [message.text, lines].filter(Boolean).join('\n\n') }
}

/** OpenAI shape: assistant(tool_calls) → tool results → assistant(text).
 * Mirrors the real round order (calls ran, results returned, model wrote
 * its reply), and every tool message stays paired with its call id. */
export function expandOpenAIHistory(messages: AiMessageInput[]): unknown[] {
  const out: unknown[] = []
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolTrace?.length) {
      out.push({ role: m.role, content: buildOpenAIContent(m) })
      continue
    }
    out.push({
      role: 'assistant',
      content: null,
      tool_calls: m.toolTrace.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: t.argsJson }
      }))
    })
    for (const t of m.toolTrace) out.push({ role: 'tool', tool_call_id: t.id, content: t.result })
    const trailingText = m.text ?? (m as any).content ?? ''
    if (trailingText) out.push({ role: 'assistant', content: trailingText })
  }
  return out
}

/** Anthropic shape: assistant [tool_use…] → user [tool_result…] → assistant
 * [text]. Anthropic requires strictly alternating roles, so consecutive
 * same-role messages produced by the expansion (e.g. a result block followed
 * by the next real user turn) are merged into one block-array message. */
export function expandAnthropicHistory(messages: AiMessageInput[]): unknown[] {
  const toBlocks = (content: unknown): unknown[] =>
    typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : (content as unknown[])
  const out: Array<{ role: string; content: unknown }> = []
  const push = (role: string, content: unknown): void => {
    const prev = out[out.length - 1]
    if (prev && prev.role === role) {
      prev.content = [...toBlocks(prev.content), ...toBlocks(content)]
      return
    }
    out.push({ role, content })
  }
  const parseInput = (argsJson: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(argsJson)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolTrace?.length) {
      push(m.role, buildAnthropicContent(m))
      continue
    }
    push(
      'assistant',
      m.toolTrace.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: parseInput(t.argsJson) }))
    )
    push(
      'user',
      m.toolTrace.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: t.result }))
    )
    if (m.text) push('assistant', [{ type: 'text', text: m.text }])
  }
  return out
}

// SSE events are separated by a blank line; some providers emit CRLF line endings.
const SSE_EVENT_SEPARATOR = /\r?\n\r?\n/

// Providers occasionally stall mid-stream (dead proxy, hung server): without
// an idle timeout such a request never settles until the user aborts. Reading
// through this helper also guarantees the body is cancelled on every exit
// path, so the underlying connection is released even when a handler throws.
const STREAM_IDLE_TIMEOUT_MS = 90_000

export function isStreamDoneEvent(event: string): boolean {
  // OpenAI: data: [DONE]
  if (/(?:^|\n)\s*data:\s*\[DONE\](?:\s*|$)/.test(event)) return true
  // Anthropic: event: message_stop or payload containing "type":"message_stop"
  if (/(?:^|\n)\s*event:\s*message_stop(?:\s*|$)/.test(event)) return true
  if (event.includes('"type":"message_stop"') || event.includes('"type": "message_stop"')) return true
  return false
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: string) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let streamCompleted = false
  let onAbort: (() => void) | null = null
  // Resolve (never reject) on abort so losing the race cannot leave an
  // unhandled rejection behind. The null chunk below is the abort marker.
  const aborted = new Promise<null>((resolve) => {
    onAbort = (): void => resolve(null)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    while (!streamCompleted) {
      throwIfAborted(signal)
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Provider sent no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s — stream aborted.`)),
          STREAM_IDLE_TIMEOUT_MS
        )
      })
      let chunk: Awaited<ReturnType<typeof reader.read>> | null
      try {
        chunk = await Promise.race([reader.read(), idle, aborted])
      } finally {
        clearTimeout(timer)
      }
      if (chunk === null) throw abortError(signal)
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const events = buffer.split(SSE_EVENT_SEPARATOR)
      buffer = events.pop() ?? ''
      for (const event of events) {
        throwIfAborted(signal)
        onEvent(event)
        if (isStreamDoneEvent(event)) {
          streamCompleted = true
          break
        }
      }
    }
    if (!streamCompleted && buffer.trim()) {
      throwIfAborted(signal)
      onEvent(buffer)
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => undefined)
  }
}

// Anthropic requires max_tokens; give reasoning modes extra room so long
// answers are not silently truncated.
function defaultMaxTokens(reasoning: ReasoningMode): number {
  return reasoning === 'high' ? 8192 : reasoning === 'off' ? 4096 : 6144
}

const anthropicThinkingBudget: Record<Extract<ReasoningMode, 'low' | 'medium' | 'high'>, number> = {
  low: 1024,
  medium: 2048,
  high: 4096
}

// Reasoning control. 'on' means "model default" — we send nothing extra, so it
// works with every provider. 'off' explicitly suppresses thinking: Anthropic has
// no thinking unless enabled (so nothing to do), while OpenAI-compatible thinking
// models (Qwen/DeepSeek/GLM, vLLM, ...) disable it via enable_thinking:false.
// low/medium/high use the OpenAI-compatible reasoning_effort field; Anthropic
// gets its native thinking budget when the user explicitly asks for intensity.
function applyReasoning(body: Record<string, unknown>, apiType: ProviderApiType, reasoning: ReasoningMode): void {
  if (reasoning === 'on') return
  if (reasoning === 'off') {
    if (apiType === 'anthropic') return
    body.enable_thinking = false
    body.chat_template_kwargs = { enable_thinking: false }
    return
  }

  if (apiType === 'anthropic') {
    const budget = anthropicThinkingBudget[reasoning]
    body.thinking = { type: 'enabled', budget_tokens: budget }
    // Keep enough room for the visible answer on top of the thinking budget.
    body.max_tokens = Math.max(typeof body.max_tokens === 'number' ? body.max_tokens : 0, budget + 4096)
    return
  }

  body.reasoning_effort = reasoning
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

interface AccumulatedToolCall {
  index?: number
  id: string
  name: string
  arguments: string
}

export type ToolConcurrency = 'read' | 'command' | 'serial'

export interface ToolCallMeta {
  id?: string
  index?: number
  round?: number
}

export interface ToolCallStreamOptions extends ProviderRequestOptions {
  tools?: ToolDefinition[]
  onToolCall?: (name: string, args: Record<string, unknown>, meta?: ToolCallMeta) => Promise<string>
  onStatus?: (text: string, toolName?: string) => void
  /** Fired periodically as arguments are being streamed from the model before the tool call completes. */
  onToolStreaming?: (tool: { round: number; index: number; id: string; name: string; rawArguments: string }) => void
  /** Fired once SSE streaming ends for calls queued behind an earlier sequential barrier batch. */
  onToolsQueued?: (calls: Array<{ round: number; index: number; id: string; name: string; args: Record<string, unknown> }>) => void
  /** Identify whether a tool is read-only so consecutive read-only calls can be parallelized. */
  isReadOnlyTool?: (name: string) => boolean
  /** Fine-grained concurrency lane classifier overriding `isReadOnlyTool` when supplied. */
  getToolConcurrency?: (name: string, args: Record<string, unknown>) => ToolConcurrency
  /** Active edits ledger (paths modified/created in current task) to maintain memory. */
  getActiveEdits?: () => string[]
  /** Returns the active task checklist state to anchor progress across tool rounds. */
  getLatestChecklist?: () => string | null
  /** Max tool-calling rounds before giving up. Defaults to 5 (web-search style). */
  maxToolRounds?: number
  /** Wall-clock budget for model streaming across the tool loop. Time spent
   * inside onToolCall (tool execution and user-approval waits) is excluded,
   * so a pending approval can never time the stream out. */
  toolLoopTimeoutMs?: number
  /** Streamed to the user as content when the loop stops because
   * maxToolRounds was exhausted while the model still wanted more calls. */
  roundLimitNotice?: string
  /** Drained between tool rounds — returns user notes queued while the loop
   * was running so mid-task guidance reaches the model at the next gap. */
  drainInjected?: () => string[]
  /** Override temperature for the tool-calling loop (agent mode uses a low
   * value to reduce hallucinated tool calls). */
  agentTemperature?: number
  /** Localized status-line template shown while a transient provider failure
   * is being retried; "{attempt}" and "{max}" are substituted. */
  retryNotice?: string
  /** Real token usage per model request (OpenAI-compatible needs
   * stream_options.include_usage — added automatically; Anthropic always
   * reports). Fired once per request; in the tool loop that means once per
   * round, each newer promptTokens superseding the last. */
  onUsage?: (usage: TokenUsage) => void
  /** Content-free payload estimate emitted before each model request. */
  onContextMeasured?: (measurement: ContextMeasurement & { modelRequestIndex: number }) => void
  /** Optional shadow-only budget configuration. It never blocks or edits a request. */
  shadowBudget?: { contextWindowTokens: number; safetyMarginTokens?: number }
  /** Working directory used to normalize file paths for Closed-Window Masking. */
  workingDir?: string
  /** Optional lookup returning the persisted call_id for an executed tool output so truncated/masked in-loop hints point to read_tool_output. */
  resolveToolOutputId?: (meta: { id?: string; index?: number; round?: number }) => string | undefined
  /** Optional in-loop compaction hook triggered when a long multi-round run hits 85% of shadowBudget. */
  onInLoopCompact?: (input: {
    previousSummary: string | null
    conversationText: string
    signal: AbortSignal
  }) => Promise<{ doc: string; usedModel?: string; fellBack?: boolean }>
  /** Notified after an in-loop compaction succeeds or degrades gracefully. */
  onInLoopCompacted?: (info: { count: number; usedModel?: string; fellBack?: boolean; degraded?: boolean }) => void
}

// In-loop context control: every result is capped, stale reads of the same
// file/range are superseded immediately (Closed-Window Masking), and older
// results fade out in cache-friendly polling batches rather than mutating the
// prefix on every single round.
/** Hard cap on a single tool result sent to the model (chars). */
const TOOL_RESULT_MAX_CHARS = 12_000
/** Recent rounds whose tool outputs stay verbatim (unless superseded by Closed-Window Masking). */
export const TOOL_KEEP_RECENT_ROUNDS = 12
/** Batch cadence for aging out older rounds so the prompt prefix stays cache-stable between polls. */
export const TOOL_MASK_POLLING_INTERVAL = 4
/** Tool outputs that carry authoritative progress/user decisions and are never masked. */
const NEVER_MASK_TOOLS = new Set(['todo_list', 'ask_user'])
/** Length a stubbed-out old result is trimmed down to. */
const TOOL_STUB_CHARS = 300

export const IN_LOOP_COMPACT_MIN_ROUND = 4
export const IN_LOOP_COMPACT_KEEP_ROUNDS = 3
export const IN_LOOP_COMPACT_MIN_INTERVAL = 6
export const IN_LOOP_COMPACT_MAX_COUNT = 3
const IN_LOOP_COMPACT_ENTRY_CAP = 2_500
const IN_LOOP_COMPACT_PAYLOAD_CAP = 48_000

function clipForInLoopCompact(text: string, max = IN_LOOP_COMPACT_ENTRY_CAP): string {
  if (text.length <= max) return text
  const head = text.slice(0, Math.floor(max * 0.7))
  const tail = text.slice(-Math.floor(max * 0.25))
  return `${head}\n[... truncated ...]\n${tail}`
}

function serializeSliceForInLoopCompact(slice: unknown[]): string {
  const parts: string[] = []
  let total = 0
  const pushPart = (line: string): boolean => {
    if (!line.trim()) return true
    if (total + line.length > IN_LOOP_COMPACT_PAYLOAD_CAP) return false
    parts.push(line)
    total += line.length + 2
    return true
  }

  for (const msg of slice) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as Record<string, unknown>
    if (m.role === 'system') continue

    if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? clipForInLoopCompact(m.content) : ''
      if (!pushPart(`Tool result: ${content}`)) break
      continue
    }

    if (Array.isArray(m.content)) {
      const textParts: string[] = []
      for (const block of m.content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(clipForInLoopCompact(b.text, 4_000))
        } else if (b.type === 'tool_use') {
          textParts.push(`[call ${String(b.name ?? 'tool')}: ${JSON.stringify(b.input ?? {}).slice(0, 300)}]`)
        } else if (b.type === 'tool_result') {
          const content = typeof b.content === 'string' ? clipForInLoopCompact(b.content) : ''
          textParts.push(`Tool result: ${content}`)
        }
      }
      const label = m.role === 'assistant' ? 'Assistant' : 'User'
      if (!pushPart(`${label}: ${textParts.join('\n')}`)) break
      continue
    }

    const text = typeof m.content === 'string' ? clipForInLoopCompact(m.content, 4_000) : ''
    const toolCalls = Array.isArray(m.tool_calls)
      ? m.tool_calls
          .map((tc) => {
            const fn = (tc as { function?: { name?: string; arguments?: string } })?.function
            return fn?.name ? `[call ${fn.name}: ${(fn.arguments ?? '').slice(0, 300)}]` : ''
          })
          .filter(Boolean)
          .join(' ')
      : ''
    const combined = [text, toolCalls].filter(Boolean).join('\n')
    const label = m.role === 'assistant' ? 'Assistant' : 'User'
    if (!pushPart(`${label}: ${combined}`)) break
  }

  return parts.join('\n\n')
}

function extractInitialUserText(messages: AiMessageInput[]): string | null {
  const firstUser = messages.find((m) => m.role === 'user' && m.text.trim().length > 0)
  if (!firstUser) return null
  const text = firstUser.text.trim()
  // If the caller already passed a compacted recap head as messages[0], keep any
  // embedded anchor or first chunk bounded instead of nesting anchors.
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text
}

function formatInLoopCheckpointText(initialTask: string | null, summary: string): string {
  const parts: string[] = []
  if (initialTask && !initialTask.includes('[原始任务锚点') && !initialTask.includes('[Initial Task Anchor')) {
    parts.push(`[Initial Task Anchor (immutable)]\n${initialTask}`)
  }
  parts.push(`(In-loop checkpoint compressed from earlier rounds)\n${summary}`)
  parts.push(
    '[SYSTEM RESUME GATE] Earlier rounds in this task were compacted. Continue directly from "## 5. 当前任务与下一步". Do not repeat completed exploration or retry failed approaches in "## 4. 失败路径台账".'
  )
  return parts.join('\n\n')
}

interface LineRange {
  start: number
  end: number
}

function normalizeMaskPathKey(pathValue: unknown, workingDir?: string): string | null {
  if (typeof pathValue !== 'string') return null
  const trimmed = pathValue.trim()
  if (!trimmed) return null
  const normalized = workingDir ? resolve(workingDir, trimmed) : trimmed.replace(/\\/g, '/').replace(/^\.\//, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function getReadLineRange(args: Record<string, unknown>): LineRange {
  const start = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(1, Math.floor(args.offset)) : 1
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.min(2000, Math.max(1, Math.floor(args.limit)))
      : 2000
  return { start, end: start + limit - 1 }
}

function readRangesOverlap(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end
}

/** Extract the canonical `[tool: ...]` first line when present. */
function extractToolPrefix(content: string): { prefix: string; body: string } {
  const nlIdx = content.indexOf('\n')
  const prefix = nlIdx > 0 && content.startsWith('[tool:') ? content.slice(0, nlIdx + 1) : ''
  return { prefix, body: prefix ? content.slice(prefix.length) : content }
}

/** Replace an outdated file-read observation while keeping the `[tool: ...]` header. */
function closedWindowStub(content: string, pathLabel: string): string {
  const { prefix } = extractToolPrefix(content)
  const linesCount = Math.max(1, content.split(/\r?\n/).length - (prefix ? 1 : 0))
  return `${prefix}[Outdated file read (${linesCount} lines) for ${pathLabel} — superseded by a newer read/edit]`
}

/** Cap an oversized result keeping head + tail — command failures usually
 * sit at the end of the output, file reads at the start. */
function capToolResult(content: string, outputId?: string): string {
  if (content.length <= TOOL_RESULT_MAX_CHARS) return content
  const head = content.slice(0, Math.floor(TOOL_RESULT_MAX_CHARS * 0.7))
  const tail = content.slice(-Math.floor(TOOL_RESULT_MAX_CHARS * 0.25))
  const { prefix } = extractToolPrefix(content)
  const rawHeadLen = Math.max(0, head.length - prefix.length)
  const readHint = outputId
    ? ` — use read_tool_output with call_id=${JSON.stringify(outputId)} offset=${rawHeadLen} to read more`
    : ''
  return `${head}\n\n[... ${content.length - head.length - tail.length} chars truncated${readHint} ...]\n\n${tail}`
}

/** Identity prefix prepended to every tool result inside the loop so the
 * model always knows which tool produced which output — even after stubbing. */
function toolResultPrefix(name: string, args: Record<string, unknown>, ok: boolean): string {
  // Compact arg summary: keep first 120 chars of the most informative keys.
  // Deliberately excludes bulk-payload keys like `content` — a truncated file
  // opening says nothing about identity and just wastes prefix budget.
  const keys = ['path', 'command', 'query', 'glob', 'pattern']
  const parts = keys
    .filter((k) => typeof args[k] === 'string' && (args[k] as string).length > 0)
    .map((k) => `${k}=${JSON.stringify((args[k] as string).slice(0, 80))}`)
  const argSummary = parts.length ? parts.join(', ').slice(0, 120) : '…'
  return `[tool: ${name}(${argSummary}) → ${ok ? 'ok' : 'error'}]\n`
}

/** Replace an aged-out result with a short stub. The identity prefix (first
 * line, `[tool: ...]`) is always preserved so the model still knows which
 * tool produced this result and whether it succeeded or failed. */
function stubToolResult(content: string, outputId?: string): string {
  if (content.length <= TOOL_STUB_CHARS) return content
  // Preserve the [tool: ...] prefix line if present.
  const { prefix, body } = extractToolPrefix(content)
  const budget = Math.max(60, TOOL_STUB_CHARS - prefix.length)
  const recovery = outputId
    ? `use read_tool_output with call_id=${JSON.stringify(outputId)} if needed`
    : 'call the tool again if needed'
  return `${prefix}${body.slice(0, budget)}\n[... earlier tool output trimmed — ${recovery} ...]`
}

/** Parse OpenAI streaming event for tool-call fragments. */
function extractOpenAIToolCalls(
  raw: string,
  map: Map<number, AccumulatedToolCall>
): void {
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:'))
  for (const line of lines) {
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{
          delta?: {
            tool_calls?: Array<{
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
          }
        }>
      }
      const toolCalls = parsed.choices?.[0]?.delta?.tool_calls
      if (!Array.isArray(toolCalls)) continue
      for (const tc of toolCalls) {
        const idx = tc.index ?? 0
        const existing = map.get(idx) ?? { index: idx, id: '', name: '', arguments: '' }
        existing.index = idx
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.name = tc.function.name
        if (tc.function?.arguments) existing.arguments += tc.function.arguments
        map.set(idx, existing)
      }
    } catch {
      // skip
    }
  }
}

/** One streamed Anthropic content block (text / thinking / tool_use). */
export interface AnthropicStreamBlock {
  type: 'text' | 'thinking' | 'tool_use'
  text: string
  thinking: string
  signature: string
  id: string
  name: string
  json: string
}

/** Parse Anthropic streaming events and accumulate every content block by index. */
export function extractAnthropicBlocks(raw: string, map: Map<number, AnthropicStreamBlock>): void {
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:'))
  for (const line of lines) {
    const payload = line.slice(5).trim()
    if (!payload) continue
    try {
      const parsed = JSON.parse(payload) as {
        type?: string
        index?: number
        content_block?: { type?: string; id?: string; name?: string; text?: string }
        delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string }
      }
      const idx = parsed.index ?? 0
      if (parsed.type === 'content_block_start' && parsed.content_block?.type) {
        const blockType = parsed.content_block.type
        if (blockType === 'text' || blockType === 'thinking' || blockType === 'tool_use') {
          map.set(idx, {
            type: blockType,
            text: parsed.content_block.text ?? '',
            thinking: '',
            signature: '',
            id: parsed.content_block.id ?? '',
            name: parsed.content_block.name ?? '',
            json: ''
          })
        }
      }
      if (parsed.type === 'content_block_delta' && parsed.delta) {
        const block = map.get(idx)
        if (!block) continue
        if (parsed.delta.type === 'text_delta' && parsed.delta.text) block.text += parsed.delta.text
        if (parsed.delta.type === 'thinking_delta' && parsed.delta.thinking) block.thinking += parsed.delta.thinking
        if (parsed.delta.type === 'signature_delta' && parsed.delta.signature) block.signature += parsed.delta.signature
        // Anthropic streams tool arguments as input_json_delta fragments
        if (parsed.delta.type === 'input_json_delta' && parsed.delta.partial_json) block.json += parsed.delta.partial_json
      }
    } catch {
      // skip
    }
  }
}

function buildToolsBody(apiType: ProviderApiType, tools: ToolDefinition[]): unknown[] {
  if (apiType === 'anthropic') {
    return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  }
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
}

export async function streamChatMessages(
  provider: ProviderSettings,
  messages: AiMessageInput[],
  systemPrompt: string,
  signal: AbortSignal,
  onDelta: (delta: StreamDelta) => void,
  reasoning: ReasoningMode = 'on',
  options: ToolCallStreamOptions = {}
): Promise<void> {
  assertProviderReady(provider)
  const { tools, onToolCall, onStatus } = options
  const useToolCalling = !!(tools?.length && onToolCall)

  const notifyRetry = (attempt: number, max: number): void => {
    const template = options.retryNotice ?? '⚠️ Connection hiccup — retrying ({attempt}/{max})…'
    onStatus?.(template.replace('{attempt}', String(attempt)).replace('{max}', String(max)))
  }

  // ---- Usage capture (P1-A) ----
  // Ask OpenAI-compatible servers for a trailing usage chunk. Some reject
  // unknown stream_options with a 400 — postChat drops the field, retries
  // once, and stops asking for the rest of this request.
  let wantUsage = (!!options.onUsage || !!options.onInLoopCompact) && provider.apiType !== 'anthropic'
  const postChat = async (
    url: string,
    body: Record<string, unknown>,
    onRetryWait: (waitMs: number, attempt: number, maxAttempts: number) => void
  ): Promise<Response> => {
    if (wantUsage) body.stream_options = { include_usage: true }
    const makeInit = (): RequestInit => ({
      method: 'POST',
      signal,
      headers: buildProviderHeaders(provider),
      body: JSON.stringify(body)
    })
    let response = await fetchProviderWithRetry(url, makeInit(), options, onRetryWait)
    if (!response.ok && response.status === 400 && 'stream_options' in body) {
      void response.body?.cancel().catch(() => undefined)
      delete body.stream_options
      wantUsage = false
      response = await fetchProviderWithRetry(url, makeInit(), options, onRetryWait)
    }
    return response
  }
  const collectUsage = (event: string, acc: Partial<TokenUsage>): void => {
    if (!options.onUsage && !options.onInLoopCompact) return
    const usage = parseUsageEvent(provider.apiType, event)
    if (usage) Object.assign(acc, usage)
  }
  const emitUsage = (acc: Partial<TokenUsage>): void => {
    if (options.onUsage && typeof acc.promptTokens === 'number') {
      options.onUsage({ promptTokens: acc.promptTokens, completionTokens: acc.completionTokens ?? 0 })
    }
  }
  const emitContext = (nativeMessages: unknown[], nativeTools: unknown[], modelRequestIndex: number): void => {
    try {
      const measurement = measureContext({ systemPrompt, tools: nativeTools, messages: nativeMessages })
      const shadow = options.shadowBudget
        ? evaluateContextBudget({
            ...options.shadowBudget,
            outputReserveTokens: defaultMaxTokens(reasoning),
            estimatedPromptTokens: measurement.estimatedPromptTokens,
            modelRequestIndex,
            fixedToolKeepRecentRounds: TOOL_KEEP_RECENT_ROUNDS
          })
        : undefined
      options.onContextMeasured?.({
        ...measurement,
        ...(shadow ? { shadow } : {}),
        modelRequestIndex
      })
    } catch {
      // Diagnostics must never interrupt a provider request.
    }
  }

  // ---- Simple flow (no tools) — existing behaviour ----
  if (!useToolCalling) {
    // Native tool messages need a tools param to be accepted — degrade any
    // replayed traces to text for tool-less requests.
    const flat = messages.map(flattenToolTrace)
    const body: Record<string, unknown> =
      provider.apiType === 'anthropic'
        ? {
            model: provider.model,
            temperature: provider.temperature,
            max_tokens: defaultMaxTokens(reasoning),
            stream: true,
            system: systemPrompt,
            messages: flat.map((message) => ({
              role: message.role,
              content: buildAnthropicContent(message)
            }))
          }
        : {
            model: provider.model,
            temperature: provider.temperature,
            stream: true,
            messages: [
              { role: 'system', content: systemPrompt },
              ...flat.map((message) => ({
                role: message.role,
                content: buildOpenAIContent(message)
              }))
            ]
          }
    applyReasoning(body, provider.apiType, reasoning)
    emitContext((body.messages as unknown[]) ?? [], [], 0)

    const response = await postChat(
      buildProviderUrl(provider, provider.apiType === 'anthropic' ? 'messages' : 'chat/completions'),
      body,
      (_waitMs, attempt, max) => notifyRetry(attempt, max)
    )
    if (!response.ok) throw new Error(await readProviderError(response, signal))
    if (!response.body) throw new Error('Provider returned an empty response body.')

    const usageAcc: Partial<TokenUsage> = {}
    await readSseStream(response.body, signal, (event) => {
      const delta = parseProviderStreamEvent(provider.apiType, event)
      if (delta) onDelta(delta)
      collectUsage(event, usageAcc)
    })
    throwIfAborted(signal)
    emitUsage(usageAcc)
    return
  }

  // ---- Tool-calling flow ----
  const apiType = provider.apiType
  const maxRounds = options.maxToolRounds ?? 5
  const toolLoopTimeoutMs = options.toolLoopTimeoutMs ?? 60_000
  const loopStart = Date.now()
  // Time spent inside onToolCall — excluded from the loop budget so slow
  // commands and approval pauses do not abort the conversation.
  let toolTimeMs = 0
  // Tool-result messages indexed by round + file identity so superseded reads
  // (Closed-Window Masking) and aged-out rounds (polling batches) can be
  // shrunk in place while keeping todo_list / ask_user intact.
  interface ToolResultRef {
    round: number
    toolName: string
    fileKey: string | null
    readRange: LineRange | null
    getContent: () => string
    shrink: (replacement?: string) => void
    shrunk?: boolean
  }
  const toolResultRefs: ToolResultRef[] = []
  // Mutating tools that actually ran (and weren't rejected) this turn. The
  // hallucination guard cross-checks against this: a wrap-up summary after
  // real edits is grounded and must not be flagged, while "I created/edited X"
  // with zero mutations backing it is fabrication.
  const executedMutatingTools = new Set<string>()
  // Command execution tools (run_command, MCP shell commands). The verification
  // loop uses this to ensure that code changes are verified with actual commands.
  const executedCommandTools = new Set<string>()
  let verificationNudged = false

  // Loop Breaker: detect consecutive rounds with identical tool calls to prevent ping-pong loops (e.g. repeated todo_list)
  let consecutiveDuplicateRounds = 0
  let lastRoundSignatures: string[] = []

  // In-loop compaction tracking for long multi-round tool loops.
  const initialUserAnchor = extractInitialUserText(messages)
  let roundStartMessageIndexes: Array<{ round: number; msgIndex: number }> = []
  let inLoopSummary: string | null = null
  let inLoopCompactCount = 0
  let lastInLoopCompactRound = -IN_LOOP_COMPACT_MIN_INTERVAL
  let lastReportedPromptTokens: number | null = null
  let lastEstimatedPromptTokens: number | null = null

  // Build initial API messages array — replayed tool traces from earlier
  // turns expand into native tool-call/tool-result messages here.
  let apiMessages: unknown[]
  if (apiType === 'anthropic') {
    apiMessages = expandAnthropicHistory(messages)
  } else {
    apiMessages = [{ role: 'system', content: systemPrompt }, ...expandOpenAIHistory(messages)]
  }

  // True when the loop ends with the model still asking for tool calls.
  let roundLimitHit = true
  for (let round = 0; round < maxRounds; round++) {
    throwIfAborted(signal)
    if (Date.now() - loopStart - toolTimeMs > toolLoopTimeoutMs) {
      throw new Error(`Tool-calling loop timed out (${Math.round(toolLoopTimeoutMs / 1000)}s of model streaming)`)
    }
    // Age out tool results in polling batches of TOOL_MASK_POLLING_INTERVAL so
    // the prompt prefix stays cache-stable between polls instead of changing
    // on every single round.
    const maskCutoff =
      round >= TOOL_KEEP_RECENT_ROUNDS + TOOL_MASK_POLLING_INTERVAL
        ? Math.floor((round - TOOL_KEEP_RECENT_ROUNDS) / TOOL_MASK_POLLING_INTERVAL) * TOOL_MASK_POLLING_INTERVAL
        : 0
    if (maskCutoff > 0) {
      for (const ref of toolResultRefs) {
        if (!ref.shrunk && ref.round < maskCutoff) {
          ref.shrink()
          ref.shrunk = true
        }
      }
    }
    // Deliver user notes queued while the previous round was streaming or
    // executing tools — the gap between rounds is the only safe place to
    // add a user message without breaking the tool-call protocol.
    const injectedNotes = options.drainInjected?.() ?? []
    for (const note of injectedNotes) {
      if (apiType === 'anthropic') {
        // Anthropic requires alternating roles; tool results already sit in a
        // trailing user message, so append a text block to it when present
        // (tool_result blocks must come first, text after them is valid).
        const last = apiMessages[apiMessages.length - 1] as { role?: string; content?: unknown }
        if (last?.role === 'user' && Array.isArray(last.content)) {
          last.content.push({ type: 'text', text: note })
        } else {
          apiMessages.push({ role: 'user', content: [{ type: 'text', text: note }] })
        }
      } else {
        apiMessages.push({ role: 'user', content: note })
      }
    }

    // Active edits ledger: inject the list of modified/created files into system prompt
    // so long multi-round sessions retain memory of touched files.
    const activeEdits = options.getActiveEdits?.() ?? []
    const editsSuffix =
      activeEdits.length > 0 ? `\n\n[Active Edits in this Task]:\n${activeEdits.map((e) => `- ${e}`).join('\n')}` : ''
    const latestChecklist = options.getLatestChecklist?.()
    const checklistSuffix =
      latestChecklist
        ? `\n\n[Active Task Checklist Anchor]:\nThis task is already in progress. The authoritative checklist state is:\n${latestChecklist}\nRule: Do NOT reset or repeat completed steps ([x]). Directly resume and execute the active ([>]) or pending ([ ]) step.`
        : ''
    const injectedSuffix =
      injectedNotes.length > 0
        ? `\n\n[Active Mid-Task User Guidance]:\n${injectedNotes.join('\n\n')}\nRule: Follow this user guidance immediately in your next action.`
        : ''
    const roundSystemPrompt = systemPrompt + editsSuffix + checklistSuffix + injectedSuffix
    if (apiType !== 'anthropic' && apiMessages.length > 0 && (apiMessages[0] as { role?: string }).role === 'system') {
      ;(apiMessages[0] as { role: string; content: string }).content = roundSystemPrompt
    }

    const nativeTools = buildToolsBody(apiType, tools!)

    // L3 In-Loop Mid-Task Hard-Watermark Compaction:
    // If a long multi-round session reaches 85% of the attention budget,
    // compress older rounds into a rolling recap while preserving the latest
    // IN_LOOP_COMPACT_KEEP_ROUNDS tool rounds verbatim and intact.
    if (
      options.onInLoopCompact &&
      options.shadowBudget?.contextWindowTokens &&
      round >= IN_LOOP_COMPACT_MIN_ROUND &&
      inLoopCompactCount < IN_LOOP_COMPACT_MAX_COUNT &&
      round - lastInLoopCompactRound >= IN_LOOP_COMPACT_MIN_INTERVAL &&
      roundStartMessageIndexes.length > IN_LOOP_COMPACT_KEEP_ROUNDS
    ) {
      const preMeasure = measureContext({ systemPrompt: roundSystemPrompt, tools: nativeTools, messages: apiMessages })
      const deltaSinceEstimate =
        lastEstimatedPromptTokens !== null ? Math.max(0, preMeasure.estimatedPromptTokens - lastEstimatedPromptTokens) : 0
      const effectiveTokens =
        lastReportedPromptTokens !== null
          ? Math.max(preMeasure.estimatedPromptTokens, lastReportedPromptTokens + deltaSinceEstimate)
          : preMeasure.estimatedPromptTokens
      const hardTrigger = Math.round(options.shadowBudget.contextWindowTokens * CONTEXT_SHADOW_COMPACT_RATIO)

      if (effectiveTokens >= hardTrigger) {
        const splitEntry = roundStartMessageIndexes[roundStartMessageIndexes.length - IN_LOOP_COMPACT_KEEP_ROUNDS]
        const splitMsgIndex = splitEntry.msgIndex
        const historyStartIndex = apiType === 'anthropic' ? 0 : 1
        if (splitMsgIndex > historyStartIndex) {
          const staleSlice = apiMessages.slice(historyStartIndex, splitMsgIndex)
          const tailSlice = apiMessages.slice(splitMsgIndex)
          const conversationText = serializeSliceForInLoopCompact(staleSlice)
          if (conversationText.trim()) {
            const payloadText = [
              ...(inLoopSummary ? [`<previous-summary>\n${inLoopSummary}\n</previous-summary>`] : []),
              `<conversation>\n${conversationText}\n</conversation>`
            ].join('\n\n')
            const compactStart = Date.now()
            try {
              const compactRes = await options.onInLoopCompact({
                previousSummary: inLoopSummary,
                conversationText: payloadText,
                signal
              })
              throwIfAborted(signal)
              inLoopSummary = inLoopSummary ? mergeRecapDoc(inLoopSummary, compactRes.doc) : compactRes.doc
              inLoopCompactCount += 1
              lastInLoopCompactRound = round
              lastReportedPromptTokens = null
              lastEstimatedPromptTokens = null

              const checkpointText = formatInLoopCheckpointText(initialUserAnchor, inLoopSummary)
              let newTailStart: number
              if (apiType === 'anthropic') {
                const firstTail = tailSlice[0] as { role?: string; content?: unknown } | undefined
                if (firstTail?.role === 'user' && Array.isArray(firstTail.content)) {
                  firstTail.content = [{ type: 'text', text: checkpointText }, ...firstTail.content]
                  apiMessages = tailSlice
                  newTailStart = 0
                } else {
                  apiMessages = [{ role: 'user', content: [{ type: 'text', text: checkpointText }] }, ...tailSlice]
                  newTailStart = 1
                }
              } else {
                apiMessages = [
                  { role: 'system', content: roundSystemPrompt },
                  { role: 'user', content: checkpointText },
                  ...tailSlice
                ]
                newTailStart = 2
              }

              const indexShift = newTailStart - splitMsgIndex
              roundStartMessageIndexes = roundStartMessageIndexes
                .filter((entry) => entry.msgIndex >= splitMsgIndex)
                .map((entry) => ({ round: entry.round, msgIndex: entry.msgIndex + indexShift }))

              for (let i = toolResultRefs.length - 1; i >= 0; i--) {
                if (toolResultRefs[i].round < splitEntry.round) {
                  toolResultRefs.splice(i, 1)
                }
              }
              options.onInLoopCompacted?.({
                count: inLoopCompactCount,
                usedModel: compactRes.usedModel,
                fellBack: compactRes.fellBack
              })
            } catch (error) {
              if (signal.aborted) throw error
              // Graceful degradation: never interrupt a live agent run because auxiliary
              // summarization failed — aggressively mask older tool outputs instead.
              for (const ref of toolResultRefs) {
                if (!ref.shrunk && ref.round < splitEntry.round) {
                  ref.shrink()
                  ref.shrunk = true
                }
              }
              lastInLoopCompactRound = round
              options.onInLoopCompacted?.({ count: inLoopCompactCount, degraded: true })
            } finally {
              toolTimeMs += Date.now() - compactStart
            }
          }
        }
      }
    }

    // Dynamically set max_tokens: reasoning modes need more room
    const dynMaxTokens = defaultMaxTokens(reasoning)
    const loopTemp = options.agentTemperature ?? provider.temperature
    const body: Record<string, unknown> =
      apiType === 'anthropic'
        ? {
            model: provider.model,
            temperature: loopTemp,
            max_tokens: dynMaxTokens,
            stream: true,
            system: roundSystemPrompt,
            messages: apiMessages,
            tools: nativeTools
          }
        : {
            model: provider.model,
            temperature: loopTemp,
            stream: true,
            messages: apiMessages,
            tools: nativeTools
          }
    applyReasoning(body, apiType, reasoning)
    emitContext(apiMessages, nativeTools, round)
    lastEstimatedPromptTokens = measureContext({ systemPrompt: roundSystemPrompt, tools: nativeTools, messages: apiMessages }).estimatedPromptTokens

    const response = await postChat(
      buildProviderUrl(provider, apiType === 'anthropic' ? 'messages' : 'chat/completions'),
      body,
      (waitMs, attempt, max) => {
        // Backoff waits are provider downtime, not model streaming — exempt
        // them from the loop budget like tool-execution time.
        toolTimeMs += waitMs
        notifyRetry(attempt, max)
      }
    )
    if (!response.ok) throw new Error(await readProviderError(response, signal))
    if (!response.body) throw new Error('Provider returned an empty response body.')

    // Stream, forward deltas, and accumulate this round's content for the
    // assistant message we may need to send back with the tool results.
    const toolCallMap = new Map<number, AccumulatedToolCall>()
    const anthropicBlocks = new Map<number, AnthropicStreamBlock>()
    const usageAcc: Partial<TokenUsage> = {}
    let roundText = ''

    const lastStreamingEmitMap = new Map<number, number>()
    const emitToolStreaming = (tc: { index: number; id: string; name: string; rawArguments: string }, force = false) => {
      if (!options.onToolStreaming || !tc.name) return
      const now = Date.now()
      const last = lastStreamingEmitMap.get(tc.index) ?? 0
      // The emit handler re-parses the whole accumulated arguments every time,
      // so a fixed 50ms cadence makes large write_file streams quadratic. Widen
      // the interval as the payload grows; if this ever matters again, the
      // upgrade is an incremental parser, not tighter throttling.
      const argsLength = tc.rawArguments.length
      const interval = argsLength > 524_288 ? 400 : argsLength > 65_536 ? 150 : 50
      if (force || now - last >= interval) {
        lastStreamingEmitMap.set(tc.index, now)
        try {
          options.onToolStreaming({ ...tc, round })
        } catch (err) {
          console.error('[onToolStreaming] Callback error:', err)
        }
      }
    }

    const handleEvent = (event: string): void => {
      try {
        const delta = parseProviderStreamEvent(apiType, event)
        if (delta) {
          if (delta.content) roundText += delta.content
          onDelta(delta)
        }
        collectUsage(event, usageAcc)
        if (apiType === 'anthropic') {
          const prevLengths = new Map<number, number>()
          for (const [idx, b] of anthropicBlocks.entries()) prevLengths.set(idx, b.json.length)
          extractAnthropicBlocks(event, anthropicBlocks)
          if (options.onToolStreaming) {
            for (const [idx, b] of anthropicBlocks.entries()) {
              if (b.type === 'tool_use' && b.name) {
                const prev = prevLengths.get(idx) ?? -1
                if (b.json.length !== prev) {
                  emitToolStreaming({ index: idx, id: b.id, name: b.name, rawArguments: b.json })
                }
              }
            }
          }
        } else {
          const prevLengths = new Map<number, number>()
          for (const [idx, tc] of toolCallMap.entries()) prevLengths.set(idx, tc.arguments.length)
          extractOpenAIToolCalls(event, toolCallMap)
          if (options.onToolStreaming) {
            for (const [idx, tc] of toolCallMap.entries()) {
              if (tc.name) {
                const prev = prevLengths.get(idx) ?? -1
                if (tc.arguments.length !== prev) {
                  emitToolStreaming({ index: idx, id: tc.id, name: tc.name, rawArguments: tc.arguments })
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('[handleEvent] SSE parse error:', err)
      }
    }

    await readSseStream(response.body, signal, handleEvent)
    throwIfAborted(signal)
    if (typeof usageAcc.promptTokens === 'number') {
      lastReportedPromptTokens = usageAcc.promptTokens
    }
    emitUsage(usageAcc)

    if (options.onToolStreaming) {
      if (apiType === 'anthropic') {
        for (const [idx, b] of anthropicBlocks.entries()) {
          if (b.type === 'tool_use' && b.name) {
            emitToolStreaming({ index: idx, id: b.id, name: b.name, rawArguments: b.json }, true)
          }
        }
      } else {
        for (const [idx, tc] of toolCallMap.entries()) {
          if (tc.name) {
            emitToolStreaming({ index: idx, id: tc.id, name: tc.name, rawArguments: tc.arguments }, true)
          }
        }
      }
    }

    const toolCalls: AccumulatedToolCall[] =
      apiType === 'anthropic'
        ? Array.from(anthropicBlocks.entries())
            .filter(([, b]) => b.type === 'tool_use' && b.name)
            .map(([idx, b]) => ({ index: idx, id: b.id || `call_${round}_${idx}`, name: b.name, arguments: b.json }))
        : Array.from(toolCallMap.values())
            .filter((tc) => tc.name)
            .map((tc, idx) => ({ ...tc, index: tc.index ?? idx, id: tc.id || `call_${round}_${tc.index ?? idx}` }))
    if (toolCalls.length > 0) {
      const currentSignatures = toolCalls.map((tc) => `${tc.name}:${(tc.arguments || '').replace(/\s+/g, '')}`)
      const isIdenticalToLastRound =
        lastRoundSignatures.length > 0 &&
        lastRoundSignatures.length === currentSignatures.length &&
        lastRoundSignatures.every((sig, idx) => sig === currentSignatures[idx])

      if (isIdenticalToLastRound) {
        consecutiveDuplicateRounds++
      } else {
        consecutiveDuplicateRounds = 0
      }
      lastRoundSignatures = currentSignatures

      if (consecutiveDuplicateRounds >= 3) {
        const isZh = options.roundLimitNotice?.includes('继续') || /[\u4e00-\u9fa5]/.test(roundText)
        const loopMsg = isZh
          ? '\n\n⚠️ 检测到模型连续多次重复调用相同参数的工具陷入死循环，已自动熔断终止。请检查当前任务或给予具体指令。'
          : '\n\n⚠️ Detected repeated identical tool calls. Loop breaker halted the execution to prevent timeout.'
        options.onStatus?.(isZh ? '⚠️ 触发工具死循环熔断保护' : '⚠️ Tool loop breaker triggered')
        onDelta({ content: loopMsg })
        roundLimitHit = false
        break
      }
    } else {
      consecutiveDuplicateRounds = 0
      lastRoundSignatures = []
    }

    if (toolCalls.length === 0) {
      // 1. Verification Loop Check:
      // If mutating tools ran in this turn, but no command tool ran, give the model one verification chance.
      if (
        executedMutatingTools.size > 0 &&
        executedCommandTools.size === 0 &&
        !verificationNudged &&
        round < maxRounds - 1
      ) {
        verificationNudged = true
        const isZh = options.roundLimitNotice?.includes('继续') || /[\u4e00-\u9fa5]/.test(roundText)
        const nudgeText = isZh
          ? '[系统自检提示] 检测到代码已被修改，但尚未运行任何验证命令（如单元测试、类型检查或构建命令）。请使用 run_command 运行相关测试或验证命令核验改动的正确性。如果当前项目无需测试或已确认无须验证，请简要说明理由后结束。'
          : '[System Verification Nudge] You modified code files, but have not run any verification commands (e.g. tests, typecheck, or build). Please use run_command to run relevant tests/checks to verify your changes. If no verification is needed, briefly explain why and conclude.'

        if (apiType === 'anthropic') {
          apiMessages.push({ role: 'assistant', content: [{ type: 'text', text: roundText || 'Code modified.' }] })
          apiMessages.push({ role: 'user', content: [{ type: 'text', text: nudgeText }] })
        } else {
          apiMessages.push({ role: 'assistant', content: roundText || 'Code modified.' })
          apiMessages.push({ role: 'user', content: nudgeText })
        }
        continue
      }

      // 2. Hallucination guard:
      // Case A: Round 0 pseudo-completion
      // The user asked to create/edit files, and model text claims files have been created/written/saved on disk,
      // but issued 0 tool calls.
      if (round === 0 && roundText.length > 0 && executedMutatingTools.size === 0) {
        const lastUserMsg = messages[messages.length - 1]?.text || ''
        const userWantedAction =
          /(?:创建|新建|写入|修改|更新|保存|编辑|修复|实现|编写|写一个|做个|create|write|edit|modify|save|implement|fix)/i.test(
            lastUserMsg
          )
        const claimsFileSaved =
          /(?:(?:文件|代码|项目|file)\s*(?:已|已为您|has been)\s*(?:保存|更新|创建|写入|saved|updated|created|written)|(?:已[经]?为您|已[经]?成功).*(?:创建|写入|保存|修改|更新|created|written|saved|modified).*(?:文件|代码|脚本|file))/i.test(
            roundText
          )
        if (userWantedAction && claimsFileSaved && roundText.includes('```')) {
          const isZh = options.roundLimitNotice?.includes('继续') || /[\u4e00-\u9fa5]/.test(roundText)
          const warn = isZh
            ? '\n\n⚠️ 上述代码为方案展示，尚未调用工具实际写入文件。如需写入项目，请回复“执行”。'
            : '\n\n⚠️ The code above is a preview and has not been written to disk yet. Reply "go ahead" to apply.'
          onDelta({ content: warn })
        }
      }

      // Case B: Round > 0 claimed work without mutating backing
      if (round > 0 && roundText.length > 0) {
        const hallucinationPatterns = [
          /(?:已[经成]?|successfully)\s*(?:创建|修改|编辑|写入|删除|执行|运行|部署|create|edit|modif|writ|delet|execut|ran|deploy|built|install)/i,
          /(?:文件|file)\s*(?:已|has been)\s*(?:保存|更新|创建|saved|updated|created)/i,
          /```(?:diff|patch)\n[+-]/,
          /(?:Step|步骤)\s*\d+[.：:]\s*(?:✓|✅|Done|完成|已完成)/i,
          // Model pasted file content with line-number arrows (read_file output
          // format) into its text and pretended to be "writing code".
          /\d+→.+\n\d+→/,
          // Model says "I'm now writing/editing code" without a tool call.
          /(?:我现在|开始|动手).*(?:编写|修改|创建|写入).*(?:代码|文件|code|file)/i,
          /(?:now|let me|I'll|I will)\s+(?:write|edit|create|modify|implement)\s+(?:the|this)?\s*(?:code|file)/i
        ]
        const looksHallucinated = hallucinationPatterns.some((p) => p.test(roundText))
        // Cross-check against real executions: if a mutating tool actually ran
        // this turn, the text is almost certainly a grounded wrap-up summary —
        // warning there is a false positive that teaches users to ignore the
        // guard. Fire only when the claimed work has no mutation backing it.
        if (looksHallucinated && executedMutatingTools.size === 0) {
          const warn =
            options.roundLimitNotice?.includes('继续')
              ? '\n\n⚠️ 上述内容可能是计划描述而非实际执行结果。如需执行，请回复"执行"，我会用工具实际完成操作。'
              : '\n\n⚠️ The above may describe planned actions rather than actual results. Reply "go ahead" and I\'ll execute them with real tool calls.'
          onDelta({ content: warn })
        }
      }

      // Case C: Fake test report detection
      // Model asserts test results (e.g. PASS ... or "XX tests passed") when no command tool ever ran.
      if (executedCommandTools.size === 0 && roundText.length > 0) {
        const fakeTestPattern =
          /(?:(?:PASS|FAIL)\s+\S+\.(?:test|spec)\.[a-z]+|\b(?:\d+\s+tests?\s+passed|\d+\s+failing|tests passed|test suites?:?\s*\d+\s*passed)\b|✓\s*\d+\s*tests? passed)/i
        if (fakeTestPattern.test(roundText)) {
          const isZh = options.roundLimitNotice?.includes('继续') || /[\u4e00-\u9fa5]/.test(roundText)
          const warn = isZh
            ? '\n\n⚠️ 注意：上述测试结果为推断生成，本次对话尚未实际调用命令运行测试。'
            : '\n\n⚠️ Note: The test results above are model-generated assumptions; no test commands were actually executed in this session.'
          onDelta({ content: warn })
        }
      }

      roundLimitHit = false
      break // no tool calls — we're done
    }

    // Echo back the full assistant turn (thinking/text/tool_use) so the API
    // accepts the follow-up request — Anthropic rejects turns that drop
    // thinking blocks when extended thinking is enabled.
    roundStartMessageIndexes.push({ round, msgIndex: apiMessages.length })
    if (apiType === 'anthropic') {
      const contentBlocks: unknown[] = []
      for (const [, block] of [...anthropicBlocks.entries()].sort((a, b) => a[0] - b[0])) {
        if (block.type === 'thinking' && block.thinking) {
          contentBlocks.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
        } else if (block.type === 'text' && block.text) {
          contentBlocks.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(block.json || '{}')
          } catch {
            // leave empty input
          }
          contentBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input })
        }
      }
      apiMessages.push({ role: 'assistant', content: contentBlocks })
    } else {
      apiMessages.push({
        role: 'assistant',
        content: roundText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments }
        }))
      })
    }

    // Parse arguments up front so batching can inspect command/tool safety and
    // run compatible calls concurrently without losing strict result order.
    const MAX_PARALLEL_TOOL_CALLS = 8
    type PreparedCall = {
      tc: AccumulatedToolCall
      args: Record<string, unknown>
      parseError: string | null
      concurrency: ToolConcurrency
    }
    const preparedCalls: PreparedCall[] = toolCalls.map((tc) => {
      let args: Record<string, unknown> = {}
      let parseError: string | null = null
      try {
        const parsed: unknown = JSON.parse(tc.arguments || '{}')
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        } else {
          parseError = `arguments must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
        }
      } catch (e) {
        parseError = e instanceof Error ? e.message : String(e)
      }
      const concurrency: ToolConcurrency = parseError
        ? 'serial'
        : options.getToolConcurrency
          ? options.getToolConcurrency(tc.name, args)
          : options.isReadOnlyTool?.(tc.name)
            ? 'read'
            : 'serial'
      return { tc, args, parseError, concurrency }
    })

    // Execute each tool call and collect the results
    interface ToolExecOutcome {
      id: string
      content: string
      toolName: string
      args: Record<string, unknown>
      ok: boolean
      outputId?: string
    }
    const toolResults: ToolExecOutcome[] = []
    const execStart = Date.now()

    const executeOneCall = async ({
      tc,
      args,
      parseError
    }: PreparedCall): Promise<ToolExecOutcome> => {
      throwIfAborted(signal)
      if (parseError) {
        const raw = (tc.arguments || '').slice(0, 200)
        return {
          id: tc.id,
          content: `[tool: ${tc.name}(INVALID_ARGS) → error]\n[Invalid tool call: arguments for ${tc.name} is not a valid JSON object (${parseError}). Raw: ${JSON.stringify(raw)}. Re-issue the tool call with valid JSON arguments.]`,
          toolName: tc.name,
          args,
          ok: false
        }
      }

      try {
        onStatus?.(typeof args.query === 'string' ? args.query : tc.name, tc.name)
        let result: string
        if (consecutiveDuplicateRounds >= 2) {
          result = `[System notice: Duplicate tool call skipped. This exact ${tc.name} call was already executed in previous rounds with identical arguments. Stop repeating it and immediately proceed with actual file/command actions.]`
        } else {
          result = await onToolCall!(tc.name, args, { id: tc.id, index: tc.index, round })
          // The callback may return normally after an abort (e.g. approval
          // resolves to "rejected" instead of throwing) — never treat that as
          // a real tool result and continue the loop.
          throwIfAborted(signal)
          if (consecutiveDuplicateRounds === 1) {
            result += `\n\n[System note: This tool call is identical to the previous round. If this was a checklist update, it is already current. Proceed to execute concrete tools (such as read_file, edit_file, or run_command) for the active step.]`
          }
        }
        const rejectedOrBlocked =
          result.startsWith('[User rejected') ||
          result.startsWith('[Blocked:') ||
          result.startsWith('[Invalid tool call:') ||
          result.startsWith('[Tool failed:')
        // Register real mutations (name-based so MCP write tools count too);
        // a user-rejected call returned as text is not a mutation.
        if (
          /write|edit|create|delet|remove|save|updat|patch|apply|move|rename|mkdir/i.test(tc.name) &&
          !rejectedOrBlocked
        ) {
          executedMutatingTools.add(tc.name)
        }
        if (
          /command|bash|shell|terminal|run|exec/i.test(tc.name) &&
          !rejectedOrBlocked
        ) {
          executedCommandTools.add(tc.name)
        }
        const outputId =
          consecutiveDuplicateRounds < 2 && !rejectedOrBlocked
            ? options.resolveToolOutputId?.({ id: tc.id, index: tc.index, round })
            : undefined
        return {
          id: tc.id,
          content: toolResultPrefix(tc.name, args, true) + result,
          toolName: tc.name,
          args,
          ok: !rejectedOrBlocked,
          outputId
        }
      } catch (error) {
        if (signal.aborted) throw error
        const msg = error instanceof Error ? error.message : String(error)
        onStatus?.(`⚠️ ${msg}`, tc.name)
        return {
          id: tc.id,
          content: toolResultPrefix(tc.name, args, false) + `[Tool failed: ${msg}]`,
          toolName: tc.name,
          args,
          ok: false
        }
      }
    }

    // Batch contiguous parallel-safe calls ('read' and non-mutating 'command')
    // together so read_file never queues behind a non-mutating command; keep
    // 'serial' tools (edits, writes, prompts, mutating commands) as strict barriers.
    type ToolBatch = { isParallel: boolean; calls: PreparedCall[] }
    const batches: ToolBatch[] = []
    for (const item of preparedCalls) {
      const parallel = item.concurrency !== 'serial'
      const lastBatch = batches[batches.length - 1]
      if (parallel && lastBatch && lastBatch.isParallel) {
        lastBatch.calls.push(item)
      } else {
        batches.push({ isParallel: parallel, calls: [item] })
      }
    }

    if (options.onToolsQueued && batches.length > 1) {
      const deferred = batches
        .slice(1)
        .flatMap((batch) => batch.calls)
        .filter((item) => !item.parseError)
        .map((item) => ({
          round,
          index: item.tc.index ?? 0,
          id: item.tc.id,
          name: item.tc.name,
          args: item.args
        }))
      if (deferred.length > 0) options.onToolsQueued(deferred)
    }

    const runBatchParallel = async (calls: PreparedCall[]): Promise<ToolExecOutcome[]> => {
      const results = new Array<ToolExecOutcome>(calls.length)
      let cursor = 0
      const workers = Array.from({ length: Math.min(MAX_PARALLEL_TOOL_CALLS, calls.length) }, async () => {
        while (cursor < calls.length) {
          throwIfAborted(signal)
          const idx = cursor++
          results[idx] = await executeOneCall(calls[idx])
        }
      })
      await Promise.all(workers)
      return results
    }

    for (const batch of batches) {
      throwIfAborted(signal)
      if (batch.isParallel && batch.calls.length > 1) {
        const batchResults = await runBatchParallel(batch.calls)
        throwIfAborted(signal)
        toolResults.push(...batchResults)
      } else {
        for (const item of batch.calls) {
          throwIfAborted(signal)
          toolResults.push(await executeOneCall(item))
        }
      }
    }
    toolTimeMs += Date.now() - execStart

    // Closed-Window Masking: when a file is re-read (overlapping range) or mutated
    // in a later round, immediately replace stale earlier reads of that file.
    for (const r of toolResults) {
      if (!r.ok || (r.toolName !== 'read_file' && r.toolName !== 'write_file' && r.toolName !== 'edit_file')) continue
      const fileKey = normalizeMaskPathKey(r.args.path, options.workingDir)
      if (!fileKey) continue
      const newRange = r.toolName === 'read_file' ? getReadLineRange(r.args) : null
      for (const ref of toolResultRefs) {
        if (ref.shrunk || ref.round >= round || ref.toolName !== 'read_file' || ref.fileKey !== fileKey) continue
        if (r.toolName !== 'read_file' || !ref.readRange || !newRange || readRangesOverlap(ref.readRange, newRange)) {
          ref.shrink(closedWindowStub(ref.getContent(), String(r.args.path ?? fileKey)))
          ref.shrunk = true
        }
      }
    }

    const recordToolRef = (r: ToolExecOutcome, getContent: () => string, setContent: (v: string) => void): void => {
      if (NEVER_MASK_TOOLS.has(r.toolName)) return
      const isFileOp = r.toolName === 'read_file' || r.toolName === 'write_file' || r.toolName === 'edit_file'
      const fileKey = isFileOp && r.ok ? normalizeMaskPathKey(r.args.path, options.workingDir) : null
      const readRange = r.toolName === 'read_file' && r.ok ? getReadLineRange(r.args) : null
      toolResultRefs.push({
        round,
        toolName: r.toolName,
        fileKey,
        readRange,
        getContent,
        shrink: (replacement?: string) => {
          setContent(replacement ?? stubToolResult(getContent(), r.outputId))
        }
      })
    }

    if (apiType === 'anthropic') {
      const resultBlocks = toolResults.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: capToolResult(r.content, r.outputId)
      }))
      apiMessages.push({ role: 'user', content: resultBlocks })
      toolResults.forEach((r, idx) => {
        const block = resultBlocks[idx]
        recordToolRef(
          r,
          () => block.content,
          (v) => {
            block.content = v
          }
        )
      })
    } else {
      for (const r of toolResults) {
        const msg = { role: 'tool', tool_call_id: r.id, content: capToolResult(r.content, r.outputId) }
        apiMessages.push(msg)
        recordToolRef(
          r,
          () => msg.content,
          (v) => {
            msg.content = v
          }
        )
      }
    }
    // Loop again — the model will continue with the tool results
  }
  // Surface round exhaustion instead of ending the reply silently — the
  // user can simply ask to continue in the next turn.
  if (roundLimitHit && options.roundLimitNotice) {
    throwIfAborted(signal)
    onDelta({ content: `\n\n${options.roundLimitNotice}` })
  }
}

export async function listModels(provider: ProviderSettings, options: ProviderRequestOptions = {}): Promise<string[]> {
  assertProviderReady(provider, false)
  // Bound like the streaming path: a provider that accepts the connection and
  // never answers would otherwise leave the settings page spinning forever —
  // the renderer has no timeout of its own for this call.
  const response = await fetchWithAttemptTimeout(
    buildProviderUrl(provider, 'models'),
    {
      method: 'GET',
      headers: buildProviderHeaders(provider)
    },
    options,
    undefined
  )

  if (!response.ok) throw new Error(await readProviderError(response))

  const body = (await response.json()) as { data?: Array<{ id?: unknown }> }
  return (body.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .sort((a, b) => a.localeCompare(b))
}

export async function testModel(provider: ProviderSettings, options: ProviderRequestOptions = {}): Promise<void> {
  assertProviderReady(provider)
  const body =
    provider.apiType === 'anthropic'
      ? {
          model: provider.model,
          temperature: provider.temperature,
          stream: false,
          max_tokens: 8,
          system: 'Reply with OK only.',
          messages: [{ role: 'user', content: 'ping' }]
        }
      : {
          model: provider.model,
          temperature: 0,
          stream: false,
          max_completion_tokens: 8,
          messages: [
            { role: 'system', content: 'Reply with OK only.' },
            { role: 'user', content: 'ping' }
          ]
        }

  const response = await fetchWithAttemptTimeout(
    buildProviderUrl(provider, provider.apiType === 'anthropic' ? 'messages' : 'chat/completions'),
    {
      method: 'POST',
      headers: buildProviderHeaders(provider),
      body: JSON.stringify(body)
    },
    options,
    undefined
  )

  if (!response.ok) throw new Error(await readProviderError(response))
  await response.json().catch(() => undefined)
}
