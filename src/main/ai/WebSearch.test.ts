import { afterEach, describe, expect, it, vi } from 'vitest'
import { decideSearch } from './WebSearch'
import type { ProviderSettings } from '@shared/types'

const provider: ProviderSettings = {
  apiType: 'openai',
  baseUrl: 'https://api.example.com/v1/chat/completions',
  apiKey: 'test-key',
  model: 'gpt-test',
  temperature: 1
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('web search decision', () => {
  it('uses an injected fetcher and normalized provider URL for the decision call', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('global fetch failed'))
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"needs_search":false,"query":""}' } }]
        }),
        { status: 200 }
      )
    )

    await expect(
      decideSearch(provider, 'translate this', 'en', new AbortController().signal, { fetcher: providerFetch })
    ).resolves.toEqual({ needsSearch: false, query: '' })
    expect(globalFetch).not.toHaveBeenCalled()
    expect(providerFetch.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/chat/completions')
  })
})
