import type { AppLanguage } from '@shared/types'
import type { ProviderFetch } from './OpenAICompatibleClient'

export interface ExaResult {
  title?: string
  url?: string
  text?: string
  publishedDate?: string
  author?: string
}

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
const EXA_TOOL_NAME = 'web_search_exa'

// ---- Minimal MCP JSON-RPC client (replaces @modelcontextprotocol/sdk) ----

interface McpResponse {
  result?: unknown
  error?: { message?: string }
}

async function mcpJsonRpc(
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  fetcher: ProviderFetch,
  sessionId?: string
): Promise<{ data: McpResponse; sessionId?: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  }
  if (sessionId) headers['mcp-session-id'] = sessionId

  const response = await fetcher(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  })
  if (!response.ok) throw new Error(`MCP request failed (${response.status})`)

  const newSessionId = response.headers.get('mcp-session-id') ?? sessionId
  const contentType = response.headers.get('content-type') ?? ''

  let data: McpResponse
  if (contentType.includes('text/event-stream')) {
    // Parse SSE: extract first `data:` JSON payload
    const text = await response.text()
    let parsed: McpResponse | undefined
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          parsed = JSON.parse(line.slice(6))
          break
        } catch {
          // skip malformed line
        }
      }
    }
    data = parsed ?? {}
  } else {
    const text = await response.text()
    if (!text.trim()) {
      data = {}
    } else {
      try {
        data = JSON.parse(text) as McpResponse
      } catch {
        data = {}
      }
    }
  }

  return { data, sessionId: newSessionId }
}

// ---- Exa search result parsing (unchanged) ----

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

// ---- Public API (signature unchanged) ----

export async function searchExa(
  query: string,
  signal: AbortSignal,
  numResults = 10,
  fetcher: ProviderFetch = fetch
): Promise<ExaResult[]> {
  // Step 1: Initialize MCP session
  const { sessionId } = await mcpJsonRpc(
    EXA_MCP_URL,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'flashagent-assistant', version: '0.2.0' }
      }
    },
    signal,
    fetcher
  )
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  // Step 2: Send initialized notification (fire-and-forget, no response expected)
  await mcpJsonRpc(
    EXA_MCP_URL,
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    },
    signal,
    fetcher,
    sessionId
  )
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  // Step 3: Call the web_search_exa tool
  const { data } = await mcpJsonRpc(
    EXA_MCP_URL,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: EXA_TOOL_NAME,
        arguments: { query, numResults }
      }
    },
    signal,
    fetcher,
    sessionId
  )

  if (data.error) throw new Error(data.error.message ?? 'Exa MCP returned an error')
  const result = data.result as McpToolResultRaw | undefined
  if (!result) throw new Error('Exa MCP returned no result')
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
}

// ---- DuckDuckGo HTML fallback (no API key required) ----

async function searchDuckDuckGo(
  query: string,
  signal: AbortSignal,
  numResults = 8,
  fetcher: ProviderFetch = fetch
): Promise<ExaResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetcher(url, {
    method: 'GET',
    signal,
    headers: { 'accept': 'text/html' }
  })
  if (!response.ok) throw new Error(`DuckDuckGo request failed (${response.status})`)
  const html = await response.text()

  const results: ExaResult[] = []
  // Parse result blocks from DDG HTML
  const blockRegex = /<div class="result[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g
  let match: RegExpExecArray | null
  while ((match = blockRegex.exec(html)) !== null && results.length < numResults) {
    const block = match[1]
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/)
    const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"/)
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/)

    const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : undefined
    // DDG wraps URLs in a redirect; extract the actual URL
    let href = urlMatch ? urlMatch[1] : ''
    const uddgMatch = href.match(/uddg=([^&]+)/)
    if (uddgMatch) {
      try { href = decodeURIComponent(uddgMatch[1]) } catch { /* keep original */ }
    }
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : undefined

    if (title || snippet) {
      results.push({ title, url: href || undefined, text: snippet })
    }
  }
  return results
}

/** Try Exa MCP first; fall back to DuckDuckGo HTML on failure. The fetcher
 * should be Electron's net.fetch so requests honour the system proxy, exactly
 * like provider requests do. */
export async function searchWithFallback(
  query: string,
  signal: AbortSignal,
  numResults = 10,
  fetcher: ProviderFetch = fetch
): Promise<ExaResult[]> {
  try {
    const results = await searchExa(query, signal, numResults, fetcher)
    if (results.length > 0) return results
    // Exa returned empty — try DDG
    return await searchDuckDuckGo(query, signal, numResults, fetcher)
  } catch (err) {
    if (signal.aborted) throw err
    console.warn('[web-search] Exa failed, falling back to DuckDuckGo:', err instanceof Error ? err.message : err)
    return await searchDuckDuckGo(query, signal, numResults, fetcher)
  }
}

export function formatSearchContext(query: string, results: ExaResult[], language: AppLanguage): string {
  if (!results.length) return ''
  const isZh = language === 'zh-CN'
  const today = new Date().toISOString().slice(0, 10)

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

// ---- Tool definition for MCP-style tool calling ----

export interface WebSearchToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const webSearchTool: WebSearchToolDefinition = {
  name: 'web_search',
  description:
    'Search the web for current, up-to-date information. Use this when the user asks about recent events, news, prices, weather, sports, or any topic that requires fresh data. Do not use for translation, summarization, or general knowledge.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query. Keep it concise (under ~12 words).'
      }
    },
    required: ['query']
  }
}
