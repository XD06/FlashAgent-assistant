/**
 * Content-free request-context measurement shared by renderer, main process,
 * and E2E drivers. It estimates the shape of an actual provider payload but
 * never returns or persists prompt text, tool arguments, or image data.
 */

export interface ContextMeasurement {
  systemTokens: number
  toolSchemaTokens: number
  messageTokens: number
  imageTokens: number
  estimatedPromptTokens: number
  messageCount: number
  toolCount: number
  imageCount: number
}

export interface ContextMeterInput {
  systemPrompt: string
  tools?: unknown[]
  messages: unknown[]
}

/** English-like text is roughly four characters per token. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4)
}

// CJK text tokenizes far denser than English. Keep this factor aligned with
// the renderer's history sizing until provider/model calibration is added.
export const CJK_TOKENS_PER_CHAR = 0.7
const CJK_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g

export function estimateTokensFromText(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK_RE)?.length ?? 0
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + (text.length - cjk) / 4)
}

// We only receive image data URLs at this layer, not provider-normalized image
// dimensions. Charge a conservative provisional value and calibrate it against
// real provider usage before using the estimate as an admission control.
export const IMAGE_INPUT_TOKEN_ESTIMATE = 2_000
const MESSAGE_ENVELOPE_TOKENS = 6
const TOOL_ENVELOPE_TOKENS = 4

interface MutableMeasurement {
  messageTokens: number
  imageTokens: number
  imageCount: number
}

function addText(acc: MutableMeasurement, value: unknown): void {
  if (typeof value === 'string') acc.messageTokens += estimateTokensFromText(value)
}

function addJson(acc: MutableMeasurement, value: unknown): void {
  try {
    addText(acc, JSON.stringify(value))
  } catch {
    // Native request objects are plain JSON. Ignore an unexpected value rather
    // than letting diagnostics affect an otherwise valid provider request.
  }
}

function addImage(acc: MutableMeasurement): void {
  acc.imageCount += 1
  acc.imageTokens += IMAGE_INPUT_TOKEN_ESTIMATE
}

function addContent(acc: MutableMeasurement, content: unknown): void {
  if (typeof content === 'string') {
    addText(acc, content)
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      addText(acc, block)
      continue
    }
    const value = block as Record<string, unknown>
    const type = typeof value.type === 'string' ? value.type : ''
    if (type === 'image_url' || type === 'image') {
      addImage(acc)
      continue
    }
    if (typeof value.text === 'string') addText(acc, value.text)
    if (typeof value.thinking === 'string') addText(acc, value.thinking)
    if (typeof value.name === 'string') addText(acc, value.name)
    if ('input' in value) addJson(acc, value.input)
    if ('content' in value) addContent(acc, value.content)
  }
}

function measureMessage(acc: MutableMeasurement, message: unknown): void {
  if (!message || typeof message !== 'object') return
  const value = message as Record<string, unknown>
  // System text is counted exactly once from input.systemPrompt. OpenAI keeps
  // it in messages while Anthropic puts it in the top-level system field.
  if (value.role !== 'system') {
    acc.messageTokens += MESSAGE_ENVELOPE_TOKENS
    addContent(acc, value.content)
  }
  if (!Array.isArray(value.tool_calls)) return
  for (const call of value.tool_calls) {
    if (!call || typeof call !== 'object') continue
    const fn = (call as Record<string, unknown>).function
    if (!fn || typeof fn !== 'object') continue
    const functionValue = fn as Record<string, unknown>
    acc.messageTokens += TOOL_ENVELOPE_TOKENS
    addText(acc, functionValue.name)
    addText(acc, functionValue.arguments)
  }
}

/**
 * Measure a fully-expanded native provider payload. Returned values are all
 * numeric, so callers can safely log or persist them without retaining model
 * input content.
 */
export function measureContext(input: ContextMeterInput): ContextMeasurement {
  const acc: MutableMeasurement = { messageTokens: 0, imageTokens: 0, imageCount: 0 }
  for (const message of input.messages) measureMessage(acc, message)
  let toolSchemaTokens = 0
  if (input.tools?.length) {
    try {
      toolSchemaTokens = estimateTokensFromText(JSON.stringify(input.tools))
    } catch {
      // See addJson: metrics must never make requests fail.
    }
  }
  const systemTokens = estimateTokensFromText(input.systemPrompt)
  return {
    systemTokens,
    toolSchemaTokens,
    messageTokens: acc.messageTokens,
    imageTokens: acc.imageTokens,
    estimatedPromptTokens: systemTokens + toolSchemaTokens + acc.messageTokens + acc.imageTokens,
    messageCount: input.messages.length,
    toolCount: input.tools?.length ?? 0,
    imageCount: acc.imageCount
  }
}
