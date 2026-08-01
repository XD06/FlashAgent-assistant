/**
 * Content-free request-context measurement shared by renderer, main process,
 * and E2E drivers. It estimates the shape of an actual provider payload but
 * never returns or persists prompt text, tool arguments, or image data.
 */

export interface ContextMeasurement {
  systemTokens: number
  toolSchemaTokens: number
  messageTokens: number
  /** Text and message envelopes that are neither tool calls nor tool results. */
  textMessageTokens: number
  /** Native OpenAI/Anthropic tool-call names, identifiers, arguments, and envelopes. */
  toolCallTokens: number
  /** Native OpenAI/Anthropic tool-result content, identifiers, and envelopes. */
  toolResultTokens: number
  imageTokens: number
  estimatedPromptTokens: number
  messageCount: number
  toolCount: number
  imageCount: number
  /** Aggregate encoded image bytes when the request carries base64 image data. */
  imageBytes: number
  /** Aggregate image pixels when PNG, JPEG, or GIF dimensions are available. */
  imagePixels: number
  imagesWithKnownDimensions: number
  shadow?: ContextBudgetShadowDecision
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
  textMessageTokens: number
  toolCallTokens: number
  toolResultTokens: number
  imageTokens: number
  imageCount: number
  imageBytes: number
  imagePixels: number
  imagesWithKnownDimensions: number
}

type MessageMaterial = 'text' | 'toolCall' | 'toolResult'

function addTokens(acc: MutableMeasurement, material: MessageMaterial, tokens: number): void {
  if (material === 'toolCall') {
    acc.toolCallTokens += tokens
  } else if (material === 'toolResult') {
    acc.toolResultTokens += tokens
  } else {
    acc.textMessageTokens += tokens
  }
}

function addText(acc: MutableMeasurement, value: unknown, material: MessageMaterial): void {
  if (typeof value === 'string') addTokens(acc, material, estimateTokensFromText(value))
}

function addJson(acc: MutableMeasurement, value: unknown, material: MessageMaterial): void {
  try {
    addText(acc, JSON.stringify(value), material)
  } catch {
    // Native request objects are plain JSON. Ignore an unexpected value rather
    // than letting diagnostics affect an otherwise valid provider request.
  }
}

function base64ByteLength(base64: string): number {
  const normalized = base64.replace(/\s/g, '')
  if (!normalized) return 0
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

function decodeBase64(base64: string): string | null {
  try {
    if (typeof globalThis.atob !== 'function') return null
    return globalThis.atob(base64.replace(/\s/g, ''))
  } catch {
    return null
  }
}

function readUint16(binary: string, offset: number, littleEndian = false): number | null {
  if (offset < 0 || offset + 1 >= binary.length) return null
  const first = binary.charCodeAt(offset)
  const second = binary.charCodeAt(offset + 1)
  return littleEndian ? first | (second << 8) : (first << 8) | second
}

function readUint32(binary: string, offset: number): number | null {
  if (offset < 0 || offset + 3 >= binary.length) return null
  return (
    binary.charCodeAt(offset) * 0x1000000 +
    binary.charCodeAt(offset + 1) * 0x10000 +
    binary.charCodeAt(offset + 2) * 0x100 +
    binary.charCodeAt(offset + 3)
  )
}

function readImageDimensions(binary: string): { width: number; height: number } | null {
  if (
    binary.length >= 24 &&
    binary.slice(0, 8) === '\x89PNG\r\n\x1a\n'
  ) {
    const width = readUint32(binary, 16)
    const height = readUint32(binary, 20)
    return width && height ? { width, height } : null
  }
  if (binary.length >= 10 && (binary.slice(0, 6) === 'GIF87a' || binary.slice(0, 6) === 'GIF89a')) {
    const width = readUint16(binary, 6, true)
    const height = readUint16(binary, 8, true)
    return width && height ? { width, height } : null
  }
  if (binary.length < 10 || binary.charCodeAt(0) !== 0xff || binary.charCodeAt(1) !== 0xd8) return null

  let offset = 2
  while (offset + 8 < binary.length) {
    while (offset < binary.length && binary.charCodeAt(offset) === 0xff) offset += 1
    const marker = binary.charCodeAt(offset)
    offset += 1
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const segmentLength = readUint16(binary, offset)
    if (!segmentLength || segmentLength < 2 || offset + segmentLength > binary.length) return null
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)
    if (isStartOfFrame) {
      const height = readUint16(binary, offset + 3)
      const width = readUint16(binary, offset + 5)
      return width && height ? { width, height } : null
    }
    offset += segmentLength
  }
  return null
}

function addBase64ImageMetadata(acc: MutableMeasurement, base64: string): void {
  acc.imageBytes += base64ByteLength(base64)
  const binary = decodeBase64(base64)
  if (!binary) return
  const dimensions = readImageDimensions(binary)
  if (!dimensions) return
  acc.imagesWithKnownDimensions += 1
  acc.imagePixels += dimensions.width * dimensions.height
}

function addImage(acc: MutableMeasurement, source?: unknown): void {
  acc.imageCount += 1
  acc.imageTokens += IMAGE_INPUT_TOKEN_ESTIMATE
  if (typeof source === 'string') {
    const match = /^data:[^,]*;base64,([\s\S]+)$/i.exec(source.trim())
    if (match) addBase64ImageMetadata(acc, match[1])
    return
  }
  if (!source || typeof source !== 'object') return
  const sourceValue = source as Record<string, unknown>
  if (typeof sourceValue.data === 'string' && sourceValue.type === 'base64') {
    addBase64ImageMetadata(acc, sourceValue.data)
  }
}

function contentMaterial(block: Record<string, unknown>, defaultMaterial: MessageMaterial): MessageMaterial {
  if (block.type === 'tool_use') return 'toolCall'
  if (block.type === 'tool_result') return 'toolResult'
  return defaultMaterial
}

function addContent(acc: MutableMeasurement, content: unknown, defaultMaterial: MessageMaterial): void {
  if (typeof content === 'string') {
    addText(acc, content, defaultMaterial)
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      addText(acc, block, defaultMaterial)
      continue
    }
    const value = block as Record<string, unknown>
    const type = typeof value.type === 'string' ? value.type : ''
    if (type === 'image_url' || type === 'image') {
      const imageUrl = value.image_url
      if (typeof imageUrl === 'string') addImage(acc, imageUrl)
      else if (imageUrl && typeof imageUrl === 'object') addImage(acc, (imageUrl as Record<string, unknown>).url)
      else addImage(acc, value.source)
      continue
    }
    const material = contentMaterial(value, defaultMaterial)
    if (typeof value.text === 'string') addText(acc, value.text, material)
    if (typeof value.thinking === 'string') addText(acc, value.thinking, material)
    if (typeof value.signature === 'string') addText(acc, value.signature, material)
    if (typeof value.name === 'string') addText(acc, value.name, material)
    if (typeof value.id === 'string') addText(acc, value.id, material)
    if ('input' in value) addJson(acc, value.input, material)
    if ('content' in value) addContent(acc, value.content, material)
  }
}

function measureMessage(acc: MutableMeasurement, message: unknown): void {
  if (!message || typeof message !== 'object') return
  const value = message as Record<string, unknown>
  // System text is counted exactly once from input.systemPrompt. OpenAI keeps
  // it in messages while Anthropic puts it in the top-level system field.
  if (value.role !== 'system') {
    const contentBlocks = Array.isArray(value.content) ? value.content : []
    const hasToolResult = contentBlocks.some(
      (block) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result'
    )
    const hasToolUse = contentBlocks.some(
      (block) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use'
    )
    const defaultMaterial: MessageMaterial =
      value.role === 'tool' || hasToolResult
        ? 'toolResult'
        : hasToolUse || (Array.isArray(value.tool_calls) && value.tool_calls.length > 0)
          ? 'toolCall'
          : 'text'
    addTokens(acc, defaultMaterial, MESSAGE_ENVELOPE_TOKENS)
    if (typeof value.tool_call_id === 'string') addText(acc, value.tool_call_id, 'toolResult')
    addContent(acc, value.content, defaultMaterial)
  }
  if (!Array.isArray(value.tool_calls)) return
  for (const call of value.tool_calls) {
    if (!call || typeof call !== 'object') continue
    const callValue = call as Record<string, unknown>
    addTokens(acc, 'toolCall', TOOL_ENVELOPE_TOKENS)
    if (typeof callValue.id === 'string') addText(acc, callValue.id, 'toolCall')
    const fn = callValue.function
    if (!fn || typeof fn !== 'object') continue
    const functionValue = fn as Record<string, unknown>
    addText(acc, functionValue.name, 'toolCall')
    addText(acc, functionValue.arguments, 'toolCall')
  }
}

/**
 * Measure a fully-expanded native provider payload. Returned values are all
 * numeric, so callers can safely log or persist them without retaining model
 * input content.
 */
export function measureContext(input: ContextMeterInput): ContextMeasurement {
  const acc: MutableMeasurement = {
    textMessageTokens: 0,
    toolCallTokens: 0,
    toolResultTokens: 0,
    imageTokens: 0,
    imageCount: 0,
    imageBytes: 0,
    imagePixels: 0,
    imagesWithKnownDimensions: 0
  }
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
  const messageTokens = acc.textMessageTokens + acc.toolCallTokens + acc.toolResultTokens
  return {
    systemTokens,
    toolSchemaTokens,
    messageTokens,
    textMessageTokens: acc.textMessageTokens,
    toolCallTokens: acc.toolCallTokens,
    toolResultTokens: acc.toolResultTokens,
    imageTokens: acc.imageTokens,
    estimatedPromptTokens: systemTokens + toolSchemaTokens + messageTokens + acc.imageTokens,
    messageCount: input.messages.length,
    toolCount: input.tools?.length ?? 0,
    imageCount: acc.imageCount,
    imageBytes: acc.imageBytes,
    imagePixels: acc.imagePixels,
    imagesWithKnownDimensions: acc.imagesWithKnownDimensions
  }
}
import type { ContextBudgetShadowDecision } from './contextBudget'
