import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatSearchContext, searchWithFallback } from './WebSearch'

afterEach(() => {
  vi.restoreAllMocks()
})

function mcpResponse(body: Record<string, unknown>, sessionId?: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: sessionId ? { 'mcp-session-id': sessionId } : {}
  })
}

const DDG_HTML = `
<div class="result results_links results_links_deep web-result ">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews">Fallback Title</a>
  <a class="result__snippet" href="#">Fallback snippet text</a>
</div>
</div>
`

describe('searchWithFallback', () => {
  it('uses the injected fetcher for the Exa MCP flow and never touches global fetch', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('global fetch used'))
    const toolResult = {
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ results: [{ title: 'Exa Hit', url: 'https://exa.example', text: 'snippet' }] })
          }
        ]
      }
    }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mcpResponse({ result: {} }, 'session-1')) // initialize
      .mockResolvedValueOnce(new Response('', { status: 200 })) // notifications/initialized
      .mockResolvedValueOnce(mcpResponse(toolResult, 'session-1')) // tools/call

    const results = await searchWithFallback('latest news', new AbortController().signal, 5, fetcher)

    expect(results).toEqual([
      { title: 'Exa Hit', url: 'https://exa.example', text: 'snippet', publishedDate: undefined, author: undefined }
    ])
    expect(globalFetch).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.every(([url]) => url === 'https://mcp.exa.ai/mcp')).toBe(true)
    // Session id from initialize must be forwarded to subsequent calls
    const thirdCallHeaders = (fetcher.mock.calls[2]?.[1] as RequestInit).headers as Record<string, string>
    expect(thirdCallHeaders['mcp-session-id']).toBe('session-1')
  })

  it('falls back to DuckDuckGo with the same fetcher when Exa fails', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('exa down')) // initialize fails
      .mockResolvedValueOnce(new Response(DDG_HTML, { status: 200 })) // DDG HTML

    const results = await searchWithFallback('latest news', new AbortController().signal, 5, fetcher)

    expect(results).toEqual([
      { title: 'Fallback Title', url: 'https://example.com/news', text: 'Fallback snippet text' }
    ])
    const ddgUrl = fetcher.mock.calls[1]?.[0] as string
    expect(ddgUrl).toContain('https://html.duckduckgo.com/html/')
    expect(ddgUrl).toContain(encodeURIComponent('latest news'))
  })

  it('rethrows instead of falling back when the signal was aborted', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(new DOMException('Aborted', 'AbortError'))
    })

    await expect(searchWithFallback('query', controller.signal, 5, fetcher)).rejects.toThrow('Aborted')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('formatSearchContext', () => {
  it('returns empty string for no results', () => {
    expect(formatSearchContext('q', [], 'en')).toBe('')
  })

  it('numbers results and sorts newest first', () => {
    const text = formatSearchContext(
      'q',
      [
        { title: 'Old', url: 'https://old.example', text: 'old text', publishedDate: '2023-01-01' },
        { title: 'New', url: 'https://new.example', text: 'new text', publishedDate: '2026-01-01' }
      ],
      'en'
    )
    expect(text.indexOf('[1] New')).toBeGreaterThan(-1)
    expect(text.indexOf('[1] New')).toBeLessThan(text.indexOf('[2] Old'))
    expect(text).toContain('https://new.example')
  })
})
