import type { AiMessageInput, ProviderApiType, ProviderSettings, ReasoningMode } from '@shared/types'

export class AiConfigurationError extends Error {}
const ANTHROPIC_VERSION = '2023-06-01'

export type ProviderFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface ProviderRequestOptions {
  readonly fetcher?: ProviderFetch
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
      rejectPromise(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectPromise(new DOMException('The operation was aborted.', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
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
  for (let attempt = 0; ; attempt++) {
    let failure: string
    let retryAfterMs: number | null = null
    try {
      const response = await fetchProvider(url, init, options)
      if (response.ok || !RETRYABLE_STATUS.has(response.status)) return response
      failure = await readProviderError(response)
      retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    } catch (error) {
      // Abort is the user's call, never retried; anything else at the fetch
      // layer is a network-level transient (ECONNRESET, dead proxy, ...).
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      failure = error instanceof Error ? error.message : String(error)
    }
    if (attempt >= RETRY_BACKOFF_MS.length) throw new Error(failure)
    const waitMs = retryAfterMs ?? RETRY_BACKOFF_MS[attempt]
    onRetryWait?.(waitMs, attempt + 1, RETRY_BACKOFF_MS.length)
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

async function readProviderError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
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
  if (!message.images?.length) return message.text
  const parts: unknown[] = []
  if (message.text) parts.push({ type: 'text', text: message.text })
  for (const image of message.images) {
    parts.push({ type: 'image_url', image_url: { url: image } })
  }
  return parts
}

function buildAnthropicContent(message: AiMessageInput): unknown {
  if (!message.images?.length) return message.text
  const parts: unknown[] = []
  for (const image of message.images) {
    const parsed = parseDataUrl(image)
    if (!parsed) continue
    parts.push({
      type: 'image',
      source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data }
    })
  }
  if (message.text) parts.push({ type: 'text', text: message.text })
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
    if (m.text) out.push({ role: 'assistant', content: m.text })
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

async function readSseStream(body: ReadableStream<Uint8Array>, onEvent: (event: string) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Provider sent no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s — stream aborted.`)),
          STREAM_IDLE_TIMEOUT_MS
        )
      })
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await Promise.race([reader.read(), idle])
      } finally {
        clearTimeout(timer)
      }
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const events = buffer.split(SSE_EVENT_SEPARATOR)
      buffer = events.pop() ?? ''
      for (const event of events) onEvent(event)
    }
    if (buffer.trim()) onEvent(buffer)
  } finally {
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
  id: string
  name: string
  arguments: string
}

interface ToolCallStreamOptions extends ProviderRequestOptions {
  tools?: ToolDefinition[]
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>
  onStatus?: (text: string, toolName?: string) => void
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
}

// In-loop context control, mirroring the renderer's "keep the last ~5 rounds
// verbatim" policy: every result is capped, and results older than the recent
// window get stubbed out (the model can always re-run the tool if needed).
/** Hard cap on a single tool result sent to the model (chars). */
const TOOL_RESULT_MAX_CHARS = 12_000
/** Rounds whose tool results are kept verbatim; older ones become stubs.
 * Too small forgets files the model just read, forcing re-reads that burn
 * extra rounds — the re-read loop costs more than the retained context. */
const TOOL_KEEP_RECENT_ROUNDS = 25
/** Length a stubbed-out old result is trimmed down to. */
const TOOL_STUB_CHARS = 300

/** Cap an oversized result keeping head + tail — command failures usually
 * sit at the end of the output, file reads at the start. */
function capToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_MAX_CHARS) return content
  const head = content.slice(0, Math.floor(TOOL_RESULT_MAX_CHARS * 0.7))
  const tail = content.slice(-Math.floor(TOOL_RESULT_MAX_CHARS * 0.25))
  return `${head}\n\n[... ${content.length - head.length - tail.length} chars truncated ...]\n\n${tail}`
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
function stubToolResult(content: string): string {
  if (content.length <= TOOL_STUB_CHARS) return content
  // Preserve the [tool: ...] prefix line if present.
  const nlIdx = content.indexOf('\n')
  const prefix = nlIdx > 0 && content.startsWith('[tool:') ? content.slice(0, nlIdx + 1) : ''
  const body = prefix ? content.slice(prefix.length) : content
  const budget = Math.max(60, TOOL_STUB_CHARS - prefix.length)
  return `${prefix}${body.slice(0, budget)}\n[... earlier tool output trimmed — call the tool again if needed ...]`
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
        const existing = map.get(idx) ?? { id: '', name: '', arguments: '' }
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
  let wantUsage = !!options.onUsage && provider.apiType !== 'anthropic'
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
    if (!options.onUsage) return
    const usage = parseUsageEvent(provider.apiType, event)
    if (usage) Object.assign(acc, usage)
  }
  const emitUsage = (acc: Partial<TokenUsage>): void => {
    if (options.onUsage && typeof acc.promptTokens === 'number') {
      options.onUsage({ promptTokens: acc.promptTokens, completionTokens: acc.completionTokens ?? 0 })
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

    const response = await postChat(
      buildProviderUrl(provider, provider.apiType === 'anthropic' ? 'messages' : 'chat/completions'),
      body,
      (_waitMs, attempt, max) => notifyRetry(attempt, max)
    )
    if (!response.ok) throw new Error(await readProviderError(response))
    if (!response.body) throw new Error('Provider returned an empty response body.')

    const usageAcc: Partial<TokenUsage> = {}
    await readSseStream(response.body, (event) => {
      const delta = parseProviderStreamEvent(provider.apiType, event)
      if (delta) onDelta(delta)
      collectUsage(event, usageAcc)
    })
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
  // Tool-result messages indexed by the round they were produced in, so
  // rounds that fall out of the recent window can be shrunk in place —
  // long agent sessions otherwise accumulate every file read and command
  // output and eventually overflow the model context.
  const toolResultRefs: Array<{ round: number; shrink: () => void; shrunk?: boolean }> = []
  // Mutating tools that actually ran (and weren't rejected) this turn. The
  // hallucination guard cross-checks against this: a wrap-up summary after
  // real edits is grounded and must not be flagged, while "I created/edited X"
  // with zero mutations backing it is fabrication.
  const executedMutatingTools = new Set<string>()

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
    if (Date.now() - loopStart - toolTimeMs > toolLoopTimeoutMs) {
      throw new Error(`Tool-calling loop timed out (${Math.round(toolLoopTimeoutMs / 1000)}s of model streaming)`)
    }
    // Age out tool results older than the recent-rounds window (mirrors the
    // renderer's "keep the last ~5 rounds verbatim" compression policy).
    for (const ref of toolResultRefs) {
      if (!ref.shrunk && ref.round <= round - TOOL_KEEP_RECENT_ROUNDS) {
        ref.shrink()
        ref.shrunk = true
      }
    }
    // Deliver user notes queued while the previous round was streaming or
    // executing tools — the gap between rounds is the only safe place to
    // add a user message without breaking the tool-call protocol.
    for (const note of options.drainInjected?.() ?? []) {
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
            system: systemPrompt,
            messages: apiMessages,
            tools: buildToolsBody(apiType, tools!)
          }
        : {
            model: provider.model,
            temperature: loopTemp,
            stream: true,
            messages: apiMessages,
            tools: buildToolsBody(apiType, tools!)
          }
    applyReasoning(body, apiType, reasoning)

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
    if (!response.ok) throw new Error(await readProviderError(response))
    if (!response.body) throw new Error('Provider returned an empty response body.')

    // Stream, forward deltas, and accumulate this round's content for the
    // assistant message we may need to send back with the tool results.
    const toolCallMap = new Map<number, AccumulatedToolCall>()
    const anthropicBlocks = new Map<number, AnthropicStreamBlock>()
    const usageAcc: Partial<TokenUsage> = {}
    let roundText = ''

    const handleEvent = (event: string): void => {
      const delta = parseProviderStreamEvent(apiType, event)
      if (delta) {
        if (delta.content) roundText += delta.content
        onDelta(delta)
      }
      collectUsage(event, usageAcc)
      if (apiType === 'anthropic') {
        extractAnthropicBlocks(event, anthropicBlocks)
      } else {
        extractOpenAIToolCalls(event, toolCallMap)
      }
    }

    await readSseStream(response.body, handleEvent)
    emitUsage(usageAcc)

    const toolCalls: AccumulatedToolCall[] =
      apiType === 'anthropic'
        ? Array.from(anthropicBlocks.values())
            .filter((b) => b.type === 'tool_use' && b.id && b.name)
            .map((b) => ({ id: b.id, name: b.name, arguments: b.json }))
        : Array.from(toolCallMap.values()).filter((tc) => tc.id && tc.name)
    if (toolCalls.length === 0) {
      // Hallucination guard: if the model wrote text that looks like it
      // performed tool actions (file edits, command runs, etc.) without
      // actually issuing tool calls, warn the user. This catches the
      // "narrating work as done" anti-pattern. Only fire when tools are
      // available AND the model is in the middle of a multi-round task
      // (round > 0), since round 0 may legitimately be a plan.
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
          /(?:now|let me|I'll|I will)\s+(?:write|edit|create|modify|implement)\s+(?:the|this)?\s*(?:code|file)/i,
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
      roundLimitHit = false
      break // no tool calls — we're done
    }

    // Echo back the full assistant turn (thinking/text/tool_use) so the API
    // accepts the follow-up request — Anthropic rejects turns that drop
    // thinking blocks when extended thinking is enabled.
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

    // Execute each tool call and collect the results
    const toolResults: Array<{ id: string; content: string }> = []
    const execStart = Date.now()
    for (const tc of toolCalls) {
      // Malformed arguments are returned to the model as an actionable tool
      // result instead of silently running the tool with an empty object —
      // the model fixes its own call in the next round.
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
      if (parseError) {
        const raw = (tc.arguments || '').slice(0, 200)
        toolResults.push({
          id: tc.id,
          content: `[tool: ${tc.name}(INVALID_ARGS) → error]\n[Invalid tool call: arguments for ${tc.name} is not a valid JSON object (${parseError}). Raw: ${JSON.stringify(raw)}. Re-issue the tool call with valid JSON arguments.]`
        })
        continue
      }

      try {
        onStatus?.(typeof args.query === 'string' ? args.query : tc.name, tc.name)
        const result = await onToolCall!(tc.name, args)
        // Register real mutations (name-based so MCP write tools count too);
        // a user-rejected call returned as text is not a mutation.
        if (
          /write|edit|create|delet|remove|run|exec|command|save|updat|patch|apply|move|rename|mkdir/i.test(tc.name) &&
          !result.startsWith('[User rejected')
        ) {
          executedMutatingTools.add(tc.name)
        }
        toolResults.push({ id: tc.id, content: toolResultPrefix(tc.name, args, true) + result })
      } catch (error) {
        if (signal.aborted) throw error
        const msg = error instanceof Error ? error.message : String(error)
        onStatus?.(`⚠️ ${msg}`, tc.name)
        // Still send a tool result so the conversation can continue
        toolResults.push({ id: tc.id, content: toolResultPrefix(tc.name, args, false) + `[Tool failed: ${msg}]` })
      }
    }
    toolTimeMs += Date.now() - execStart

    if (apiType === 'anthropic') {
      const resultBlocks = toolResults.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: capToolResult(r.content)
      }))
      apiMessages.push({ role: 'user', content: resultBlocks })
      toolResultRefs.push({
        round,
        shrink: () => {
          for (const block of resultBlocks) block.content = stubToolResult(block.content)
        }
      })
    } else {
      for (const r of toolResults) {
        const msg = { role: 'tool', tool_call_id: r.id, content: capToolResult(r.content) }
        apiMessages.push(msg)
        toolResultRefs.push({
          round,
          shrink: () => {
            msg.content = stubToolResult(msg.content)
          }
        })
      }
    }
    // Loop again — the model will continue with the tool results
  }
  // Surface round exhaustion instead of ending the reply silently — the
  // user can simply ask to continue in the next turn.
  if (roundLimitHit && options.roundLimitNotice) {
    onDelta({ content: `\n\n${options.roundLimitNotice}` })
  }
}

export async function listModels(provider: ProviderSettings, options: ProviderRequestOptions = {}): Promise<string[]> {
  assertProviderReady(provider, false)
  const response = await fetchProvider(
    buildProviderUrl(provider, 'models'),
    {
      method: 'GET',
      headers: buildProviderHeaders(provider)
    },
    options
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

  const response = await fetchProvider(
    buildProviderUrl(provider, provider.apiType === 'anthropic' ? 'messages' : 'chat/completions'),
    {
      method: 'POST',
      headers: buildProviderHeaders(provider),
      body: JSON.stringify(body)
    },
    options
  )

  if (!response.ok) throw new Error(await readProviderError(response))
  await response.json().catch(() => undefined)
}
