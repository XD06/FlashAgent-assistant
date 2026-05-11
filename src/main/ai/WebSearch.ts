import type { AppLanguage, ProviderSettings } from '@shared/types'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface ExaResult {
  title?: string
  url?: string
  text?: string
  publishedDate?: string
  author?: string
}

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
const EXA_TOOL_NAME = 'web_search_exa'
const ANTHROPIC_VERSION = '2023-06-01'

interface McpToolContent {
  type?: string
  text?: string
}

interface McpToolResultRaw {
  content?: McpToolContent[]
  isError?: boolean
  structuredContent?: unknown
}

function parseExaToolText(text: string): ExaResult[] {
  if (!text) return []
  const trimmed = text.trim()
  if (!trimmed) return []
  // The Exa MCP returns either a JSON object/array or pre-formatted markdown.
  // We try JSON first, then fall back to a single text blob.
  try {
    const parsed = JSON.parse(trimmed)
    const results: unknown =
      Array.isArray(parsed)
        ? parsed
        : (parsed as { results?: unknown }).results ??
          (parsed as { items?: unknown }).items ??
          parsed
    if (!Array.isArray(results)) return []
    return results
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => ({
        title: typeof entry.title === 'string' ? entry.title : undefined,
        url: typeof entry.url === 'string' ? entry.url : undefined,
        text:
          typeof entry.text === 'string'
            ? entry.text
            : typeof entry.snippet === 'string'
              ? (entry.snippet as string)
              : typeof entry.content === 'string'
                ? (entry.content as string)
                : undefined,
        publishedDate: typeof entry.publishedDate === 'string' ? entry.publishedDate : undefined,
        author: typeof entry.author === 'string' ? entry.author : undefined
      }))
  } catch {
    return [{ text: trimmed }]
  }
}

export async function searchExa(query: string, signal: AbortSignal, numResults = 10): Promise<ExaResult[]> {
  const transport = new StreamableHTTPClientTransport(new URL(EXA_MCP_URL))
  const client = new Client(
    { name: 'aia-selection-assistant', version: '0.2.0' },
    { capabilities: {} }
  )
  try {
    await client.connect(transport)
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

    const result = (await client.callTool({
      name: EXA_TOOL_NAME,
      arguments: { query, numResults }
    })) as McpToolResultRaw
    if (result.isError) throw new Error('Exa MCP returned an error result')

    // Prefer structuredContent if provided, else collect all text blocks.
    if (
      result.structuredContent &&
      typeof result.structuredContent === 'object' &&
      result.structuredContent !== null
    ) {
      const sc = result.structuredContent as { results?: unknown }
      if (Array.isArray(sc.results)) {
        return parseExaToolText(JSON.stringify(sc.results))
      }
    }
    const textBlocks = (result.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
    return parseExaToolText(textBlocks)
  } finally {
    try {
      await client.close()
    } catch {
      // ignore
    }
  }
}

export function formatSearchContext(query: string, results: ExaResult[], language: AppLanguage): string {
  if (!results.length) return ''
  const isZh = language === 'zh-CN'
  const today = new Date().toISOString().slice(0, 10)

  // Sort by recency when publishedDate is available so newer items render first.
  const sorted = [...results].sort((a, b) => {
    const ta = a.publishedDate ? Date.parse(a.publishedDate) : 0
    const tb = b.publishedDate ? Date.parse(b.publishedDate) : 0
    return tb - ta
  })

  const header = isZh
    ? `[联网搜索结果 — 查询: "${query}" · 今日: ${today}]\n以下片段来自联网搜索，已按发布日期从新到旧排序。请基于这些信息回答用户问题，优先引用最近发布的内容；明显过时的条目请忽略。引用时使用编号 [1]/[2]/...，并在末尾用「来源：」列出对应链接。如果搜索结果与问题无关，请直接基于已有知识回答。`
    : `[Web search results — query: "${query}" · today: ${today}]\nThe snippets below come from web search, sorted by published date (newest first). Prefer recent items, ignore clearly outdated ones. Cite inline as [1]/[2]/... and list the matching URLs under "Sources:" at the end. If results are irrelevant, answer from prior knowledge.`

  const items = sorted
    .map((result, index) => {
      const title = (result.title ?? `Result ${index + 1}`).trim()
      const url = (result.url ?? '').trim()
      const date = result.publishedDate ? ` · ${result.publishedDate.slice(0, 10)}` : ''
      const snippet = (result.text ?? '').replace(/\s+/g, ' ').slice(0, 1500)
      const urlLine = url ? `${url}\n` : ''
      return `[${index + 1}] ${title}${date}\n${urlLine}${snippet}`
    })
    .join('\n\n')

  return `${header}\n\n${items}\n`
}

interface DecisionResult {
  needsSearch: boolean
  query: string
}

const DECISION_SYSTEM = (language: AppLanguage) => {
  const lang = language === 'zh-CN' ? 'Simplified Chinese' : 'English'
  const today = new Date().toISOString().slice(0, 10)
  return `Today's date is ${today}. You decide whether the user's request requires fresh, up-to-date, or external information that should be retrieved via web search BEFORE answering.

Answer YES (needs_search=true) only when the request clearly depends on:
- Current events, news, prices, weather, sports, or anything that changes over time
- Specific facts that the user wants verified or sourced
- Niche or recent topics where outdated info would be wrong

Answer NO (needs_search=false) for:
- Pure translation, rewriting, summarization, or explanation of provided text
- General knowledge or reasoning that does not depend on recent data
- Coding, math, or creative writing tasks

Search query rules:
- Do NOT bake any specific year (e.g. "2023", "2024") into the query unless the user explicitly asked about that year. Use words like "今日"/"最新"/"latest"/"current" to mean "today".
- Keep the query concise (under ~12 words) and in ${lang}.

Respond with ONLY a single JSON object on one line, no prose, no markdown, no code fences:
{"needs_search": true | false, "query": "<concise search query in ${lang}, empty string if no search>"}`
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    const end = trimmed.lastIndexOf('}')
    if (end > 0) return trimmed.slice(0, end + 1)
  }
  const match = trimmed.match(/\{[\s\S]*\}/)
  return match ? match[0] : null
}

function parseDecision(text: string): DecisionResult {
  const fallback: DecisionResult = { needsSearch: false, query: '' }
  const json = extractJsonObject(text)
  if (!json) return fallback
  try {
    const parsed = JSON.parse(json) as { needs_search?: unknown; query?: unknown }
    const needsSearch = parsed.needs_search === true
    const query = typeof parsed.query === 'string' ? parsed.query.trim() : ''
    if (!needsSearch || !query) return { needsSearch: false, query: '' }
    return { needsSearch: true, query }
  } catch {
    return fallback
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v1(?:\/messages|\/models)?$/i, '')
}

async function callProviderForDecision(
  provider: ProviderSettings,
  systemPrompt: string,
  userText: string,
  signal: AbortSignal
): Promise<string> {
  if (provider.apiType === 'anthropic') {
    const base = normalizeAnthropicBaseUrl(provider.baseUrl)
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0,
        max_tokens: 120,
        system: systemPrompt,
        messages: [{ role: 'user', content: userText }]
      })
    })
    if (!response.ok) throw new Error(`Provider decision failed (${response.status})`)
    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> }
    const text = data.content?.find((block) => block.type === 'text')?.text ?? ''
    return text
  }
  const url = `${normalizeBaseUrl(provider.baseUrl)}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0,
      max_completion_tokens: 120,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ]
    })
  })
  if (!response.ok) throw new Error(`Provider decision failed (${response.status})`)
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content ?? ''
}

export async function decideSearch(
  provider: ProviderSettings,
  userText: string,
  language: AppLanguage,
  signal: AbortSignal
): Promise<DecisionResult> {
  if (!userText.trim() || !provider.apiKey.trim() || !provider.model.trim()) {
    return { needsSearch: false, query: '' }
  }
  const systemPrompt = DECISION_SYSTEM(language)
  const raw = await callProviderForDecision(provider, systemPrompt, userText, signal)
  return parseDecision(raw)
}
